// S3 — cross-transaction shielded custody: a contract holds shielded
// tokens for one or more blocks, then sends them in a later transaction.
//
// Procedure:
//   1. mint_shielded_to_self → contract holds a fresh shielded note.
//   2. Wait for the indexer to settle the mint block.
//   3. Build the QualifiedShieldedCoinInfo for the contract-held note —
//      this is the half of the recipe that's harder than S4. The user
//      wallet's `state.shielded.availableCoins` only contains user-owned
//      notes; contract-owned notes need a different surface.
//   4. Call send_held_shielded with that coin.
//   5. PASS iff the send tx lands.
//
// The on-chain color is straightforward — same `rawTokenType` derivation
// as S4. The mt_index is what was previously missing; we probe several
// candidate provider methods at runtime to find one that returns it.

import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { firstValueFrom } from 'rxjs';
import {
  rawTokenType,
  encodeRawTokenType,
} from '@midnight-ntwrk/ledger-v8';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'S3';
const SHIELDED_COLOR_HEX = process.env.S3_COLOR ?? '00'.repeat(31) + '03';

await runTest({
  testId: TEST_ID,
  name: 'cross-tx-custody',
  description: 'mint shielded to contract, then send from held in a later block',
  action: async () => {
    const { walletCtx, contract, providers } = await setupContract({ slot: 'primary' });
    const amount = BigInt(process.env.S3_AMOUNT ?? '500');
    const mintNonce = new Uint8Array(randomBytes(32));
    const SHIELDED_COLOR = hexToBytes32(SHIELDED_COLOR_HEX);

    // ── Hop 1: contract mints to itself ────────────────────────────────────
    console.log(`Hop 1: mint ${amount} shielded to contract (nonce ${shortHex(mintNonce)})`);
    const mintResult = await contract.found.callTx.mint_shielded_to_self(
      SHIELDED_COLOR,
      amount,
      mintNonce,
    );
    const mintTx = mintResult?.public?.txId ?? mintResult?.public?.transactionHash;
    if (!mintTx) {
      await walletCtx.wallet.stop();
      return {
        verdict: 'FAIL',
        errorCode: 'mint-step-no-tx',
        note: 'mint_shielded_to_self did not surface a tx hash.',
        details: {},
      };
    }

    console.log('Waiting 15s for the indexer to settle the mint block...');
    await new Promise((r) => setTimeout(r, 15_000));

    // ── Color derivation — same recipe as S4 ───────────────────────────────
    const derivedRawHex = rawTokenType(SHIELDED_COLOR, contract.address);
    const derivedColor = encodeRawTokenType(derivedRawHex);
    console.log(`Derived on-chain color: 0x${derivedRawHex.replace(/^0x/, '')}`);

    // ── Probe for the contract-held note's mt_index ────────────────────────
    //
    // For S4 (user-owned note), the wallet's `state.shielded.availableCoins`
    // exposes a QualifiedShieldedCoinInfo carrying the mt_index. For S3 the
    // note is contract-owned, so the user wallet doesn't surface it. Try
    // several candidate APIs in order; whichever returns first is used.
    let mtIndex: bigint | null = null;
    let mtIndexSource = 'not-found';
    const probeReports: Array<{ surface: string; result: string }> = [];

    type AvailableCoin = { coin?: any; commitment?: any };
    const walletState: any = await firstValueFrom(walletCtx.wallet.state());

    // Probe 1: maybe the wallet's availableCoins also exposes contract-owned
    // notes (we don't expect this, but it's cheap to check).
    try {
      const all: AvailableCoin[] = walletState?.shielded?.availableCoins ?? [];
      const matches = all.filter(
        (c) =>
          (c?.coin as any)?.type === derivedRawHex.replace(/^0x/, '') ||
          (c?.coin as any)?.type === '0x' + derivedRawHex.replace(/^0x/, ''),
      );
      probeReports.push({
        surface: 'wallet.state.shielded.availableCoins',
        result: `total=${all.length} matching-derived-color=${matches.length}`,
      });
      if (matches.length > 0) {
        const q = (matches[0] as any).coin;
        mtIndex = BigInt(q.mt_index ?? q.mtIndex);
        mtIndexSource = 'availableCoins';
      }
    } catch (e: any) {
      probeReports.push({
        surface: 'wallet.state.shielded.availableCoins',
        result: `error: ${e?.message ?? e}`,
      });
    }

    // Probe 2: the contract handle's `currentShieldedCoinState` / similar.
    if (mtIndex === null) {
      const contractAny: any = contract.found;
      const candidates = [
        'shieldedCoins',
        'getShieldedCoins',
        'currentShieldedCoinState',
        'queryShieldedNotes',
      ];
      for (const c of candidates) {
        if (typeof contractAny?.[c] === 'function') {
          try {
            const got = await contractAny[c](derivedColor);
            probeReports.push({
              surface: `contract.${c}(derivedColor)`,
              result: `returned ${typeof got} (${Array.isArray(got) ? 'len=' + got.length : 'value'})`,
            });
            const hit = Array.isArray(got) ? got.find((g: any) => BigInt(g?.value ?? 0) === amount) : null;
            if (hit) {
              mtIndex = BigInt(hit.mt_index ?? hit.mtIndex);
              mtIndexSource = `contract.${c}`;
              break;
            }
          } catch (e: any) {
            probeReports.push({
              surface: `contract.${c}`,
              result: `threw: ${e?.message ?? e}`,
            });
          }
        }
      }
      if (probeReports.filter((p) => p.surface.startsWith('contract.')).length === 0) {
        probeReports.push({
          surface: 'contract.<probe-set>',
          result: 'none of {shieldedCoins, getShieldedCoins, currentShieldedCoinState, queryShieldedNotes} present',
        });
      }
    }

    // Probe 3: publicDataProvider candidates.
    if (mtIndex === null) {
      const dp: any = providers.publicDataProvider;
      const candidates = [
        'queryContractShieldedNotes',
        'getContractShieldedCoins',
        'contractShieldedCoins',
        'shieldedCoinsForContract',
      ];
      for (const c of candidates) {
        if (typeof dp?.[c] === 'function') {
          try {
            const got = await dp[c](contract.address, derivedColor);
            probeReports.push({
              surface: `publicDataProvider.${c}(...)`,
              result: `returned ${typeof got} (${Array.isArray(got) ? 'len=' + got.length : 'value'})`,
            });
            const hit = Array.isArray(got) ? got.find((g: any) => BigInt(g?.value ?? 0) === amount) : null;
            if (hit) {
              mtIndex = BigInt(hit.mt_index ?? hit.mtIndex);
              mtIndexSource = `publicDataProvider.${c}`;
              break;
            }
          } catch (e: any) {
            probeReports.push({
              surface: `publicDataProvider.${c}`,
              result: `threw: ${e?.message ?? e}`,
            });
          }
        }
      }
    }

    // Probe 4: env override (S3_MT_INDEX=<n>) for hand-driven probes.
    if (mtIndex === null && process.env.S3_MT_INDEX) {
      mtIndex = BigInt(process.env.S3_MT_INDEX);
      mtIndexSource = 'env-S3_MT_INDEX';
    }

    if (mtIndex === null) {
      // Surface the probe trace so a follow-up run can tell us which
      // surface actually exists. Fall through with mt_index=0 to capture
      // the runtime error.
      console.log('  no contract-held-note lookup surface found; probes:');
      for (const p of probeReports) console.log(`    - ${p.surface}: ${p.result}`);
      mtIndex = 0n;
      mtIndexSource = 'fallback-0';
    } else {
      console.log(`  mt_index = ${mtIndex} (via ${mtIndexSource})`);
    }

    // ── Hop 2: send_held_shielded ──────────────────────────────────────────
    const recipientShieldedKey = walletState.shielded.coinPublicKey;
    const coin = {
      nonce:    mintNonce,
      color:    derivedColor,
      value:    amount,
      mt_index: mtIndex,
    };

    console.log(`Hop 2: send_held_shielded (mt_index=${mtIndex} via ${mtIndexSource})`);
    let sendTx: string | undefined;
    let sendError: string | undefined;
    try {
      const sendResult = await contract.found.callTx.send_held_shielded(
        coin,
        recipientShieldedKey,
        amount,
      );
      sendTx = sendResult?.public?.txId ?? sendResult?.public?.transactionHash;
    } catch (e: any) {
      sendError = e?.message ?? String(e);
    }

    await walletCtx.wallet.stop();

    if (sendTx) {
      return {
        verdict: 'PASS',
        txHash: sendTx,
        note: `Cross-tx shielded custody confirmed: contract held shielded notes across blocks and spent them later (mt_index source: ${mtIndexSource}).`,
        details: {
          mintTx,
          mintNonce: Buffer.from(mintNonce).toString('hex'),
          sendTx,
          contractScopedColor: SHIELDED_COLOR_HEX,
          derivedOnChainColor: derivedRawHex,
          amount: amount.toString(),
          mtIndex: mtIndex.toString(),
          mtIndexSource,
          probes: probeReports,
        },
      };
    }

    return {
      verdict: 'FAIL',
      errorCode: mtIndexSource === 'fallback-0' ? 'no-mt-index-surface' : 'send-failed',
      note:
        mtIndexSource === 'fallback-0'
          ? 'No contract-held-note lookup surface found in the SDK. The mt_index for the contract-owned note could not be recovered, so send_held_shielded was called with mt_index=0 and (correctly) rejected. The probe trace in `details.probes` records every surface that was checked.'
          : `send_held_shielded failed even with mt_index=${mtIndex} from ${mtIndexSource}. See details.sendError for the exact failure.`,
      details: {
        mintTx,
        mintNonce: Buffer.from(mintNonce).toString('hex'),
        contractScopedColor: SHIELDED_COLOR_HEX,
        derivedOnChainColor: derivedRawHex,
        amount: amount.toString(),
        mtIndex: mtIndex.toString(),
        mtIndexSource,
        sendError,
        probes: probeReports,
      },
    };
  },
});

function shortHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex').slice(0, 12) + '…';
}
