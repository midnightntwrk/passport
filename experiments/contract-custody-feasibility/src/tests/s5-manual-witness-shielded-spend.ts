// S5 — manual-witness shielded spend.
//
// S3 already documents that no public midnight-js 4.0.4 surface enumerates
// contract-owned shielded notes (see evidence/s3-cross-tx-custody.json: the
// runner probed `wallet.state.shielded.availableCoins`, several speculative
// `contract.*` methods, and several speculative `publicDataProvider.*`
// methods — none returned the contract's QualifiedShieldedCoinInfo). That
// finding answers half the question: the client-side discovery API is
// missing.
//
// What S3 leaves unanswered: would the runtime *accept* a contract-as-
// shielded-spender if the client could supply a correctly-constructed
// `QualifiedShieldedCoinInfo`? OpenZeppelin's archived ShieldedToken.compact
// listed *"Enable the Shielded contract itself to transfer"* as a future
// idea — signal that the on-chain primitive may also be missing.
//
// S5 disambiguates by bypassing the missing client API:
//
//   1. Mint a fresh contract-owned note via `mint_shielded_to_self` and
//      capture the (nonce, color, value, depositTxHash) of the deposit.
//   2. Reconstruct `QualifiedShieldedCoinInfo` manually:
//        - nonce, color, value: known from the deposit;
//        - mt_index: queried from the indexer's GraphQL surface
//          (`transactions(offset:{hash}).startIndex`). For a
//          `mint_shielded_to_self` transaction the contract emits exactly
//          one shielded output, so its commitment lands at the
//          transaction's `startIndex` in the Zswap commitment tree.
//   3. Submit `send_held_shielded_manual(coin, recipient, amount)` and
//      capture the response verbatim — tx hash on success, full error
//      envelope on failure.
//
// Outcome classification (see FINDINGS.md / EXPERIMENT_GUIDELINE.md):
//   - `gap1-only`: the runtime accepts the manually-constructed witness.
//     The only thing standing between v1 and contract-held shielded
//     custody is a public client surface (e.g.
//     `getContractShieldedCoins(address) → QualifiedShieldedCoinInfo[]`).
//   - `gap2`: the runtime rejects with a proof / nullifier / owner-check
//     error. Contract-as-spender for shielded notes is also unsupported
//     on-chain on `midnight-node:0.22.5`. The same wall OZ documented;
//     a new client API would be necessary but not sufficient.
//   - `gap0`: the Compact compiler rejected the new circuit (caught at
//     `npm run compile`, not here — but recorded for completeness).
//   - `bug`: the runtime accepts but produces semantically wrong state.
//     Worth flagging upstream.

import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { firstValueFrom } from 'rxjs';
import {
  rawTokenType,
  encodeRawTokenType,
} from '@midnight-ntwrk/ledger-v8';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'S5';
const SHIELDED_COLOR_HEX = process.env.S5_COLOR ?? '00'.repeat(31) + '05';
const INDEXER_URL = process.env.MIDNIGHT_INDEXER_URL
  ?? 'http://localhost:8088/api/v4/graphql';

await runTest({
  testId: TEST_ID,
  name: 'manual-witness-shielded-spend',
  description: 'manual-witness QualifiedShieldedCoinInfo → send_held_shielded_manual',
  action: async () => {
    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const amount = BigInt(process.env.S5_AMOUNT ?? '500');
    const mintNonce = new Uint8Array(randomBytes(32));
    const SHIELDED_COLOR = hexToBytes32(SHIELDED_COLOR_HEX);

    // ── Hop 1: contract mints a fresh note to itself ──────────────────────
    //
    // Fresh deposit per S5 run: neither S1's nor S4's evidence files capture
    // the per-note nonce, and the nonce is required to reconstruct the
    // QualifiedShieldedCoinInfo. Recording the (nonce, txHash) pair here
    // makes S5 self-contained.
    console.log(`Hop 1: mint ${amount} shielded to contract (nonce ${shortHex(mintNonce)})`);
    const mintResult = await contract.found.callTx.mint_shielded_to_self(
      SHIELDED_COLOR,
      amount,
      mintNonce,
    );
    const mintTx: string | undefined =
      mintResult?.public?.txId ?? mintResult?.public?.transactionHash;
    if (!mintTx) {
      await walletCtx.wallet.stop();
      return {
        verdict: 'FAIL',
        errorCode: 'mint-step-no-tx',
        note: 'mint_shielded_to_self did not surface a tx hash; S5 cannot proceed.',
        details: { outcome: 'inconclusive' },
      };
    }
    console.log(`  mintTx = ${mintTx}`);

    console.log('Waiting 15s for the indexer to settle the mint block...');
    await new Promise((r) => setTimeout(r, 15_000));

    // ── On-chain colour derivation — same recipe as S3 / S4 ───────────────
    const derivedRawHex = rawTokenType(SHIELDED_COLOR, contract.address);
    const derivedColor = encodeRawTokenType(derivedRawHex);
    console.log(`Derived on-chain colour: 0x${derivedRawHex.replace(/^0x/, '')}`);

    // ── Manual mt_index recovery via the indexer GraphQL ──────────────────
    //
    // The Midnight indexer exposes per-transaction Zswap commitment-tree
    // bookkeeping. For a `RegularTransaction`, `startIndex` is the position
    // in the Zswap commitment tree at which this transaction's outputs
    // begin to be inserted, and `endIndex` is the position immediately
    // after the last one. So `endIndex - startIndex` is the number of
    // shielded commitments produced by the transaction.
    //
    // For `mint_shielded_to_self` the contract emits exactly one shielded
    // output (one `mintShieldedToken` call to `kernel.self()`). The
    // user's transaction wrapping doesn't add Zswap inputs/outputs:
    // contract calls are paid in Dust, not shielded balance. Therefore
    // the deposit's commitment lands at `mt_index = startIndex`.
    //
    // The runner enforces `endIndex - startIndex === 1` and aborts as
    // 'inconclusive' if it sees more, so the assumption is verified
    // before being relied on.
    const indexerInfo = await queryDepositPosition(mintTx);
    const probeTrace: Array<{ surface: string; result: string }> = [
      {
        surface: 'indexer.transactions(offset:{hash})',
        result: JSON.stringify(indexerInfo),
      },
    ];

    if (indexerInfo.error) {
      await walletCtx.wallet.stop();
      return {
        verdict: 'FAIL',
        errorCode: 'indexer-query-failed',
        note: `Indexer GraphQL query for the deposit transaction failed: ${indexerInfo.error}.`,
        details: {
          outcome: 'inconclusive',
          mintTx,
          mintNonce: Buffer.from(mintNonce).toString('hex'),
          contractScopedColor: SHIELDED_COLOR_HEX,
          derivedOnChainColor: derivedRawHex,
          amount: amount.toString(),
          indexerUrl: INDEXER_URL,
          indexerInfo,
          probes: probeTrace,
        },
      };
    }

    const startIndex = BigInt(indexerInfo.startIndex ?? 0);
    const endIndex = BigInt(indexerInfo.endIndex ?? 0);
    const commitmentCount = endIndex - startIndex;
    console.log(
      `  indexer: startIndex=${startIndex} endIndex=${endIndex} (${commitmentCount} commitment(s))`,
    );

    if (commitmentCount !== 1n) {
      await walletCtx.wallet.stop();
      return {
        verdict: 'FAIL',
        errorCode: 'unexpected-commitment-count',
        note:
          `Deposit tx produced ${commitmentCount} shielded commitment(s); expected 1. ` +
          'mt_index inference (mt_index = startIndex) only holds for single-output deposits. ' +
          'S5 declines to guess and reports inconclusive.',
        details: {
          outcome: 'inconclusive',
          mintTx,
          mintNonce: Buffer.from(mintNonce).toString('hex'),
          contractScopedColor: SHIELDED_COLOR_HEX,
          derivedOnChainColor: derivedRawHex,
          amount: amount.toString(),
          startIndex: startIndex.toString(),
          endIndex: endIndex.toString(),
          probes: probeTrace,
        },
      };
    }

    const mtIndex = startIndex;
    const mtIndexSource = 'indexer.transactions.startIndex';
    console.log(`  mt_index = ${mtIndex} (via ${mtIndexSource})`);

    // ── Hop 2: send_held_shielded_manual — the actual disambiguator ───────
    const walletState: any = await firstValueFrom(walletCtx.wallet.state());
    const recipientShieldedKey = walletState.shielded.coinPublicKey;
    const coin = {
      nonce:    mintNonce,
      color:    derivedColor,
      value:    amount,
      mt_index: mtIndex,
    };

    console.log(
      `Hop 2: send_held_shielded_manual(coin{mt_index=${mtIndex}}, user, ${amount})`,
    );
    let sendTx: string | undefined;
    let sendError: any;
    try {
      const sendResult = await contract.found.callTx.send_held_shielded_manual(
        coin,
        recipientShieldedKey,
        amount,
      );
      sendTx = sendResult?.public?.txId ?? sendResult?.public?.transactionHash;
    } catch (e: any) {
      sendError = serialiseSendError(e);
    }

    await walletCtx.wallet.stop();

    if (sendTx) {
      // Gap-1-only: runtime accepted the manually-constructed witness. The
      // only thing standing between v1 and contract-held shielded custody
      // is a public client surface that returns
      // `QualifiedShieldedCoinInfo[]` for a contract address.
      return {
        verdict: 'PASS',
        txHash: sendTx,
        note:
          'Manually-constructed contract-held QualifiedShieldedCoinInfo accepted by ' +
          'the runtime. Contract-held shielded spending is blocked solely on the ' +
          'client-side discovery API (Gap 1); the on-chain primitive works.',
        details: {
          outcome: 'gap1-only',
          mintTx,
          mintNonce: Buffer.from(mintNonce).toString('hex'),
          sendTx,
          contractScopedColor: SHIELDED_COLOR_HEX,
          derivedOnChainColor: derivedRawHex,
          amount: amount.toString(),
          mtIndex: mtIndex.toString(),
          mtIndexSource,
          startIndex: startIndex.toString(),
          endIndex: endIndex.toString(),
          probes: probeTrace,
        },
      };
    }

    // Failure: classify as Gap 2 (runtime rejection) by default. The
    // captured envelope determines whether it's actually a node-side
    // ledger error or some upstream JS failure.
    const classification = classifyOutcome(sendError);
    return {
      verdict: 'FAIL',
      errorCode: classification.errorCode,
      note: classification.note,
      details: {
        outcome: classification.outcome,
        mintTx,
        mintNonce: Buffer.from(mintNonce).toString('hex'),
        contractScopedColor: SHIELDED_COLOR_HEX,
        derivedOnChainColor: derivedRawHex,
        amount: amount.toString(),
        mtIndex: mtIndex.toString(),
        mtIndexSource,
        startIndex: startIndex.toString(),
        endIndex: endIndex.toString(),
        sendError,
        probes: probeTrace,
      },
    };
  },
});

interface IndexerDepositInfo {
  startIndex?: number;
  endIndex?: number;
  blockHeight?: number;
  blockHash?: string;
  status?: string;
  raw?: unknown;
  error?: string;
}

async function queryDepositPosition(txId: string): Promise<IndexerDepositInfo> {
  // Verbatim GraphQL — kept readable so the captured probe trace shows the
  // exact query used. The indexer's `startIndex` / `endIndex` fields are
  // documented at docs.midnight.network/api-reference/midnight-indexer.
  //
  // We pass the SDK's public `txId` as the indexer's `identifier` (not
  // `hash`). midnight-js calls this value "txId" everywhere but it is the
  // 33-byte transaction *identifier*, not the 32-byte block-included hash;
  // `midnight-js-indexer-public-data-provider` itself uses
  // `offset: { identifier: txId }` for the same lookup
  // (see node_modules/.../index.mjs `watchForTxData`).
  const query = `
    query S5_DepositPosition($offset: TransactionOffset!) {
      transactions(offset: $offset) {
        id
        hash
        block { height hash }
        ... on RegularTransaction {
          startIndex
          endIndex
          transactionResult { status }
        }
      }
    }
  `.trim();
  try {
    const res = await fetch(INDEXER_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query,
        variables: { offset: { identifier: txId.replace(/^0x/, '') } },
      }),
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status} ${res.statusText}` };
    }
    const body: any = await res.json();
    if (body?.errors?.length) {
      return { error: `GraphQL errors: ${JSON.stringify(body.errors)}` };
    }
    const txs: any[] = body?.data?.transactions ?? [];
    if (txs.length === 0) {
      return { error: `Indexer returned no transactions for identifier ${txId}` };
    }
    const t = txs[0];
    return {
      startIndex:  Number(t?.startIndex ?? 0),
      endIndex:    Number(t?.endIndex ?? 0),
      blockHeight: Number(t?.block?.height ?? 0),
      blockHash:   String(t?.block?.hash ?? ''),
      status:      String(t?.transactionResult?.status ?? ''),
      raw:         t,
    };
  } catch (e: any) {
    return { error: `fetch failed: ${e?.message ?? String(e)}` };
  }
}

interface OutcomeClassification {
  outcome: 'gap2' | 'inconclusive';
  errorCode: string;
  note: string;
}

function classifyOutcome(err: any): OutcomeClassification {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  // The two flavours of failure we expect on a Gap-2 outcome:
  //   - Substrate/RPC: `1010: Invalid Transaction: Custom error: <N>`
  //   - Ledger:        `MalformedError::<Variant>` (proof, owner, nullifier)
  const substrate = msg.match(/custom error:\s*(\d+)/);
  if (substrate) {
    return {
      outcome: 'gap2',
      errorCode: `ledger-${substrate[1]}`,
      note:
        `Runtime rejected the contract-held shielded spend with ledger error ${substrate[1]}. ` +
        'Even with a manually-constructed QualifiedShieldedCoinInfo carrying the correct ' +
        'mt_index from the indexer, the on-chain primitive does not accept the spend. ' +
        'Contract-as-shielded-spender is unsupported on this node tag (Gap 2 — same wall ' +
        "OpenZeppelin's archived ShieldedToken flagged as future work).",
    };
  }
  const malformed = msg.match(/malformederror::?(\w+)/);
  if (malformed) {
    return {
      outcome: 'gap2',
      errorCode: `malformed-${malformed[1].toLowerCase()}`,
      note:
        `Runtime rejected with MalformedError::${malformed[1]}. The on-chain proof / ` +
        'owner / nullifier check failed for a manually-constructed contract-held witness. ' +
        'Contract-as-shielded-spender is unsupported on this node tag (Gap 2).',
    };
  }
  if (msg.includes('contractruntimeerror') || msg.includes('error executing circuit')) {
    return {
      outcome: 'gap2',
      errorCode: 'contract-runtime-error',
      note:
        'Off-chain compact-runtime crashed during proof construction for ' +
        '`sendShielded` against a contract-held coin (ContractRuntimeError). ' +
        'The captured causeChain shows the underlying TypeError. The transaction ' +
        'never reached the node — the SDK runtime itself has no working ' +
        'contract-as-shielded-spender path on this version. Practically ' +
        'equivalent to Gap 2: a client-side `getContractShieldedCoins` API ' +
        'alone would not unblock contract-held shielded custody; the SDK / ' +
        "runtime support is also absent (matching OZ's archived ShieldedToken " +
        'future-work note).',
    };
  }
  return {
    outcome: 'inconclusive',
    errorCode: 'js-error',
    note:
      'send_held_shielded_manual failed before producing a tx hash, but the failure ' +
      'envelope does not match a known runtime-rejection signature. See details.sendError.',
  };
}

function serialiseSendError(e: any): Record<string, unknown> {
  // The midnight-js scoped-transaction wrapper layers errors three deep:
  //   outer Error (`Unexpected error executing scoped transaction…`)
  //     → cause: ContractRuntimeError (with `_tag` and a CompactError cause)
  //       → cause: CompactError (the actual circuit-execution failure;
  //         this is where the runtime's specific reason lives)
  // Capture the full chain so FINDINGS.md / the upstream issue we file
  // sees the exact CompactError message rather than the generic wrapper.
  const causeChain: Array<Record<string, unknown>> = [];
  let cur: any = e;
  let guard = 0;
  while (cur && guard++ < 6) {
    causeChain.push({
      name:        cur?.name ?? typeof cur,
      tag:         cur?._tag ?? null,
      message:     cur?.message ?? String(cur),
      data:        cur?.data ?? null,
      ownProps:    pickOwnProps(cur),
    });
    cur = cur?.cause;
  }
  return {
    name:       e?.name ?? typeof e,
    message:    e?.message ?? String(e),
    stack:      e?.stack?.split('\n').slice(0, 16).join('\n') ?? null,
    causeChain,
  };
}

function pickOwnProps(e: any): Record<string, unknown> {
  // Capture non-standard error properties the SDK attaches (like `_tag`,
  // `code`, etc.) without including the full prototype chain.
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
    } catch { /* ignore unreadable prop */ }
  }
  return out;
}

function shortHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex').slice(0, 12) + '…';
}
