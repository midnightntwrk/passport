// S6 — contract-held shielded spend, OpenZeppelin pattern.
//
// S5 documented that taking a `QualifiedShieldedCoinInfo` as a witness
// parameter and feeding it directly into `sendShielded` crashes the
// off-chain compact-runtime during proof construction
// (`ContractRuntimeError → TypeError: Cannot read properties of undefined
// (reading 'buffer')`). At the time we framed that as a runtime gap.
// Then we found OpenZeppelin's `add-multisig` branch
// (`contracts/src/multisig/ShieldedTreasury.compact`) doing exactly the
// thing we'd assumed was impossible — and using a different pattern:
//
//   ledger _coins: Map<Bytes<32>, QualifiedShieldedCoinInfo>;
//
//   _deposit(coin):
//     receiveShielded(coin);                        // allocates Merkle tree position in this tx
//     _coins.insertCoin(coin.color, coin, selfAsRecipient());
//     // insertCoin is a specialised Map method (data-types/ledger-adt#insertcoin-1):
//     //   input:  ShieldedCoinInfo  (no mt_index)
//     //   stored: QualifiedShieldedCoinInfo (mt_index added by the runtime,
//     //           sourced from the same-transaction Merkle allocation above).
//     //   The docs are explicit: "This index must have been allocated within
//     //   the current transaction or this insertion fails."
//
//   _send(recipient, color, amount):
//     const coin = _coins.lookup(color);   // ← QSCI pulled from contract state
//     const result = sendShielded(coin, recipient, amount);
//     if (result.change.is_some) {
//       sendImmediateShielded(result.change.value, selfAsRecipient(), …);
//       _coins.insertCoin(color, result.change.value, selfAsRecipient());
//     } else {
//       _coins.remove(color);
//     }
//
// The key primitives — `Map.insertCoin`, `Map.lookup` returning a QSCI,
// `mergeCoinImmediate`, `sendImmediateShielded` — all compile against
// the same `compact 0.30.0` toolchain we use for S1–S5. S6 ports the
// pattern into our `custody.compact` (as `oz_deposit` and
// `oz_send_to_user`) and runs the full deposit → cross-block spend
// cycle on the same `midnight-node:0.22.5` devnet.
//
// Outcome interpretation:
//   - PASS (oz-pattern-works): contract-held shielded spend is fully
//     feasible on Midnight v1 today, just with a contract-side
//     pattern (Map<color,QSCI> + insertCoin) the existing developer
//     guides don't yet document. S5's "Gap 2" diagnosis was an artefact
//     of using the wrong contract pattern; S3's "missing client API"
//     framing is also wrong because OZ's design needs no SDK-level
//     enumeration — discovery lives in the contract's ledger map.
//   - FAIL (oz-pattern-fails-at-deposit): `oz_deposit` itself crashes,
//     so the runtime / proof-builder really does lack support for
//     `Map.insertCoin` of a freshly-received shielded coin. OZ's
//     simulator-only tests would not have caught this.
//   - FAIL (oz-pattern-fails-at-spend): deposit lands but
//     `oz_send_to_user` rejects. The contract pattern compiles but the
//     runtime does not fully implement `Map.lookup → sendShielded`
//     against contract-owned notes.

import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { firstValueFrom } from 'rxjs';
import {
  rawTokenType,
  encodeRawTokenType,
} from '@midnight-ntwrk/ledger-v8';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'S6';
const SHIELDED_COLOR_HEX = process.env.S6_COLOR ?? '00'.repeat(31) + '06';

await runTest({
  testId: TEST_ID,
  name: 'oz-pattern-shielded-spend',
  description: "OZ pattern: Map<color,QSCI> + insertCoin → contract-held shielded spend",
  action: async () => {
    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const state: any = await firstValueFrom(walletCtx.wallet.state());

    const coinPubKey = state.shielded.coinPublicKey;
    const coinHex =
      typeof coinPubKey?.toHexString === 'function'
        ? coinPubKey.toHexString()
        : String(coinPubKey?.bytes ?? coinPubKey);
    const userShieldedKey = { bytes: hexToBytes32(coinHex) };

    const amount = BigInt(process.env.S6_AMOUNT ?? '500');
    const setupNonce = new Uint8Array(randomBytes(32));
    const SHIELDED_COLOR = hexToBytes32(SHIELDED_COLOR_HEX);

    // ── Setup: mint a fresh shielded note to the user ──────────────────────
    //
    // S6's deposit step needs the user wallet to hold a shielded note under
    // the contract-derived colour, exactly like S4. Re-use the
    // `mint_and_send_shielded` recipe: contract issues a note directly to
    // the user; the wallet indexes it under `rawTokenType(colour, contract)`.
    console.log(`Setup: minting ${amount} shielded to user (nonce ${shortHex(setupNonce)})`);
    const setupResult = await contract.found.callTx.mint_and_send_shielded(
      SHIELDED_COLOR,
      amount,
      setupNonce,
      userShieldedKey,
    );
    const setupTx: string | undefined =
      setupResult?.public?.txId ?? setupResult?.public?.transactionHash;
    if (!setupTx) {
      await walletCtx.wallet.stop();
      return {
        verdict: 'FAIL',
        errorCode: 'setup-failed',
        note: 'mint_and_send_shielded did not surface a tx hash; cannot set up an S6 deposit.',
        details: { outcome: 'inconclusive' },
      };
    }
    console.log(`  setupTx = ${setupTx}`);

    console.log('Waiting 15s for the wallet to index the new note...');
    await new Promise((r) => setTimeout(r, 15_000));

    // ── On-chain colour derivation — same recipe as S4 / S5 ───────────────
    const derivedRawHex = rawTokenType(SHIELDED_COLOR, contract.address);
    const derivedColor = encodeRawTokenType(derivedRawHex);
    console.log(`Derived on-chain colour: 0x${derivedRawHex.replace(/^0x/, '')}`);

    // ── Hop 1: user → contract via oz_deposit ─────────────────────────────
    //
    // `oz_deposit` performs `receiveShielded(coin)` and then
    // `oz_coins.insertCoin(color, coin, selfAsRecipient())`. The runtime
    // assigns `mt_index` when the deposit tx lands and persists the QSCI
    // in the contract's ledger map for later `sendShielded` to retrieve.
    const depositCoin = {
      nonce: setupNonce,
      color: derivedColor,
      value: amount,
    };
    console.log(`Hop 1: oz_deposit (receiveShielded + Map.insertCoin)`);
    let depositTx: string | undefined;
    let depositError: any;
    try {
      const r = await contract.found.callTx.oz_deposit(depositCoin);
      depositTx = r?.public?.txId ?? r?.public?.transactionHash;
    } catch (e: any) {
      depositError = serialiseError(e);
    }

    if (!depositTx) {
      await walletCtx.wallet.stop();
      return {
        verdict: 'FAIL',
        errorCode: 'oz-deposit-failed',
        note:
          '`oz_deposit` (receiveShielded + Map.insertCoin) failed before the ' +
          "spend step. The contract's ledger never registered the held coin, " +
          'so the OZ pattern is not viable on this stack. See ' +
          'details.depositError.causeChain for the runtime envelope.',
        details: {
          outcome: 'oz-pattern-fails-at-deposit',
          setupTx,
          setupNonce: Buffer.from(setupNonce).toString('hex'),
          contractScopedColor: SHIELDED_COLOR_HEX,
          derivedOnChainColor: derivedRawHex,
          amount: amount.toString(),
          depositError,
        },
      };
    }
    console.log(`  depositTx = ${depositTx}`);

    console.log('Waiting 15s for the indexer to settle the deposit block...');
    await new Promise((r) => setTimeout(r, 15_000));

    // ── Hop 2: contract → user via oz_send_to_user ────────────────────────
    //
    // `oz_send_to_user` reads the held QSCI back from `oz_coins.lookup(color)`
    // and feeds it to `sendShielded`. If the runtime supports the OZ
    // pattern, this is where the proof construction succeeds — there is no
    // witness-vs-state mismatch because the QSCI is contract-state-bound.
    console.log(`Hop 2: oz_send_to_user (Map.lookup + sendShielded)`);
    let sendTx: string | undefined;
    let sendError: any;
    try {
      const r = await contract.found.callTx.oz_send_to_user(
        userShieldedKey,
        derivedColor,
        amount,
      );
      sendTx = r?.public?.txId ?? r?.public?.transactionHash;
    } catch (e: any) {
      sendError = serialiseError(e);
    }

    await walletCtx.wallet.stop();

    if (sendTx) {
      return {
        verdict: 'PASS',
        txHash: sendTx,
        note:
          'OZ pattern works on Midnight v1 today: contract-held shielded ' +
          'spend via `Map<Bytes<32>,QualifiedShieldedCoinInfo>` + ' +
          '`Map.insertCoin` after `receiveShielded`, and `Map.lookup` + ' +
          '`sendShielded` (with `sendImmediateShielded` for change) at ' +
          'spend time. S5\'s Gap 2 diagnosis was an artefact of using the ' +
          'wrong contract pattern; S3\'s "missing client API" framing is ' +
          'also wrong since discovery lives in contract ledger state, not ' +
          'in the SDK.',
        details: {
          outcome: 'oz-pattern-works',
          setupTx,
          setupNonce: Buffer.from(setupNonce).toString('hex'),
          depositTx,
          sendTx,
          contractScopedColor: SHIELDED_COLOR_HEX,
          derivedOnChainColor: derivedRawHex,
          amount: amount.toString(),
          pattern: [
            'ledger Map<Bytes<32>,QualifiedShieldedCoinInfo>',
            'after receiveShielded → Map.insertCoin(color, coin, selfAsRecipient())',
            'at spend → Map.lookup(color) → sendShielded',
            'change → sendImmediateShielded + Map.insertCoin (else Map.remove)',
          ],
          referenceContract:
            'https://github.com/OpenZeppelin/compact-contracts/blob/add-multisig/contracts/src/multisig/ShieldedTreasury.compact',
        },
      };
    }

    return {
      verdict: 'FAIL',
      errorCode: 'oz-send-failed',
      note:
        'oz_deposit landed but oz_send_to_user (Map.lookup + sendShielded) ' +
        'rejected. The OZ pattern compiles and deposits but the runtime / ' +
        'proof-builder does not fully implement contract-as-shielded-' +
        'spender on this node tag. Review details.sendError.causeChain.',
      details: {
        outcome: 'oz-pattern-fails-at-spend',
        setupTx,
        setupNonce: Buffer.from(setupNonce).toString('hex'),
        depositTx,
        contractScopedColor: SHIELDED_COLOR_HEX,
        derivedOnChainColor: derivedRawHex,
        amount: amount.toString(),
        sendError,
      },
    };
  },
});

function serialiseError(e: any): Record<string, unknown> {
  // Same chain-walking shape as S5: midnight-js wraps scoped-tx errors
  // three deep (outer Error → ContractRuntimeError → underlying TypeError /
  // CompactError / etc.). The deepest entry is the one that names the
  // actual runtime failure.
  const causeChain: Array<Record<string, unknown>> = [];
  let cur: any = e;
  let guard = 0;
  while (cur && guard++ < 6) {
    causeChain.push({
      name:     cur?.name ?? typeof cur,
      tag:      cur?._tag ?? null,
      message:  cur?.message ?? String(cur),
      ownProps: pickOwnProps(cur),
    });
    cur = cur?.cause;
  }
  return {
    name:    e?.name ?? typeof e,
    message: e?.message ?? String(e),
    stack:   e?.stack?.split('\n').slice(0, 16).join('\n') ?? null,
    causeChain,
  };
}

function pickOwnProps(e: any): Record<string, unknown> {
  if (!e || typeof e !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(e)) {
    if (['name', 'message', 'stack', 'cause'].includes(k)) continue;
    try {
      const v = (e as any)[k];
      if (v == null || typeof v === 'function') continue;
      if (typeof v === 'object') {
        try { out[k] = JSON.parse(JSON.stringify(v)); } catch { out[k] = String(v); }
      } else {
        out[k] = v;
      }
    } catch { /* ignore */ }
  }
  return out;
}

function shortHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex').slice(0, 12) + '…';
}
