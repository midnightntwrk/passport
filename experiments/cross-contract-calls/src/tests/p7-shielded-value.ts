// P7 — does SHIELDED VALUE move across the call boundary? (the issue #658
// verdict on the published 0.19.0 runtime)
//
// Issue #658 blanked the callee's Zswap local state on the whole 0.33 rc
// line; upstream fixed it in 0.34.0 but every demonstration since runs on
// branch stacks. This probe is the released-pin-set verdict: a CALLEE
// executes receiveShielded (Zswap output + claim) inside a cross-contract
// call. It simultaneously closes an open question from the earlier probes:
// whether a WITNESS-CONSUMING ROOT circuit may contain a call site (the
// Payer's coin enters through the payer_coin witness; only callees must be
// witness-free).
//
// Sequence:
//   1. deploy Till (callee) and Payer (root, coin-store witness);
//   2. FUND: payer.fund_shielded(domain, 1000, nonce) — mintShieldedToken
//      to kernel.self() (auto-received per the stdlib; the coin's nonce IS
//      the argument, its color tokenType(domain, self)); the client
//      captures mt_index from the indexer's commitment-tree window
//      (MIP-0012 §6.5) and stores the qualified description in the
//      private-state coin store;
//   3. PAY (the headline): payer.pay_shielded(color, 100) — the coin
//      enters via witness, sendShielded targets the Till's
//      ContractAddress, and till.take_shielded(result.sent) claims the
//      sent coin across the call boundary in the SAME transaction;
//   4. verify: the callee's claim worked on the released runtime (that IS
//      the #658 verdict); the sent coin's deterministic nonce evolution
//      survived the boundary (the Till's public read-back of the claimed
//      coin carries the evolved nonce); the Till's receipt counters
//      advanced; the payer's change follows the surviving-coin rule
//      (change.value = funded - paid, already live and self-owned).
//
// If the in-circuit mint funding fails at run time there is no viable
// shielded fallback on a fresh localnet: deposit_shielded exists on the
// contract, but the genesis wallet holds no shielded coin to deposit, and
// minting one to the user first would fail for the same reason as the
// primary path. The exact failure is then the evidence (BLOCKED).

import { performance } from 'node:perf_hooks';

import * as TillModule from '../../contracts/managed/Till/contract/index.js';
import * as PayerModule from '../../contracts/managed/Payer/contract/index.js';

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence, serialiseError, classifyCallError, type Verdict } from './evidence.js';
import {
  setupWallet,
  deployWitnessFree,
  deployWithWitnesses,
  contractRefArg,
  type ContractHandle,
} from '../node/setup.js';
import { CONFIG, tillZkConfigPath, payerZkConfigPath } from '../node/wallet.js';
import {
  makeCoinStoreWitnesses,
  emptyCoinStore,
  withCoin,
  type CoinStorePrivateState,
} from './value-client/witnesses.js';
import { mtIndexForSingleOutput, candidateIndices } from './value-client/capture.js';
import { circuitResult } from './value-client/result.js';
import { bytesToHex, randomBytes32 } from '../wallet/hex.js';

const FUND = 1000n;
const PAY = 100n;

const DESCRIPTION =
  'Shielded value across the call boundary: a callee executing receiveShielded on the published ' +
  '0.19.0 runtime (the issue #658 verdict), driven by a witness-consuming root circuit';

/** 32-byte domain from an ASCII tag (the Compact pad(32, …) shape). */
function domainBytes(tag: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < Math.min(tag.length, 32); i++) out[i] = tag.charCodeAt(i);
  return out;
}

/** Wrap the proof provider so the probe can time proving and size the tx. */
function instrumentProving(providers: any): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  const pp = providers.proofProvider;
  const origProve = pp.proveTx.bind(pp);
  pp.proveTx = async (tx: any, cfg?: any) => {
    try {
      metrics.unprovenTxBytes = tx.serialize().length;
    } catch { /* serialisation surface varies; size is best-effort */ }
    const t0 = performance.now();
    const proven = await origProve(tx, cfg);
    metrics.proveWallMs = Math.round(performance.now() - t0);
    try {
      metrics.provenTxBytes = proven.serialize().length;
    } catch { /* best-effort */ }
    return proven;
  };
  return metrics;
}

/** The observer's view: the transaction as the indexer serves it. */
async function fetchObserverView(txId: string): Promise<any> {
  const query = `query Tx($offset: TransactionOffset!) {
    transactions(offset: $offset) {
      hash
      ... on RegularTransaction {
        identifiers
        contractActions { __typename address ... on ContractCall { entryPoint } }
        transactionResult { status }
      }
    }
  }`;
  const attempt = async (offset: Record<string, string>) => {
    const res = await fetch(CONFIG.indexer, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { offset } }),
    });
    return res.json() as Promise<any>;
  };
  const clean = txId.replace(/^0x/, '');
  let body = await attempt({ identifier: clean });
  if (body?.errors?.length || !(body?.data?.transactions ?? []).length) {
    const retry = await attempt({ hash: clean });
    if (!retry?.errors?.length && (retry?.data?.transactions ?? []).length) body = retry;
  }
  if (body?.errors?.length) return { schemaErrors: body.errors };
  return (body?.data?.transactions ?? [])[0] ?? null;
}

function fail(details: Record<string, unknown>, verdict: Verdict, errorCode: string, note: string): never {
  writeEvidence({
    testId: 'P7',
    name: 'shielded-value',
    description: DESCRIPTION,
    verdict,
    errorCode,
    note,
    details,
  });
  throw new Error(note);
}

await runScenario('p7-shielded-value', async () => {
  const details: Record<string, unknown> = {};
  const domain = domainBytes('cross-contract-calls:p7');

  step('deploy the Till (callee) and the Payer (root, coin-store witness)');
  const walletCtx = await setupWallet();
  const till: ContractHandle = await deployWitnessFree(walletCtx, {
    name: 'till-p7',
    module: TillModule,
    zkPath: tillZkConfigPath,
  });
  const payer: ContractHandle = await deployWithWitnesses(walletCtx, {
    name: 'payer-p7',
    module: PayerModule,
    zkPath: payerZkConfigPath,
    witnesses: makeCoinStoreWitnesses(),
    initialPrivateState: emptyCoinStore(),
    args: [contractRefArg(till.address), contractRefArg(till.address)],
  });
  details.tillAddress = till.address;
  details.payerAddress = payer.address;
  console.log(`  till  ${till.address}`);
  console.log(`  payer ${payer.address}`);

  step(`fund the payer: in-circuit shielded mint to itself (${FUND})`);
  const mintNonce = randomBytes32();
  let coin: { nonce: Uint8Array; color: Uint8Array; value: bigint };
  let fundTxId: string;
  try {
    const fund = await payer.call('fund_shielded', domain, FUND, mintNonce);
    fundTxId = fund.txId;
    details.fundTxId = fundTxId;
    const minted = circuitResult(fund.result);
    if (!minted?.nonce || !minted?.color || minted?.value === undefined) {
      throw new Error(`fund_shielded returned no coin description: ${JSON.stringify(minted)}`);
    }
    coin = minted;
  } catch (e: any) {
    const cls = classifyCallError(e);
    details.mintError = serialiseError(e);
    details.mintErrorClass = cls;
    fail(
      details,
      'BLOCKED',
      cls.errorCode,
      `The in-circuit shielded mint funding did not land, and a fresh localnet offers no user-held ` +
      `shielded coin for the deposit_shielded fallback: ${cls.note} (stage: ${cls.outcome})`,
    );
  }
  details.mintedCoin = {
    nonceHex: bytesToHex(coin.nonce),
    colorHex: bytesToHex(coin.color),
    value: coin.value,
    nonceMatchesArgument: bytesToHex(coin.nonce) === bytesToHex(mintNonce),
  };

  await waitForLedger(
    () => payer.ledgerState(),
    `payer.shielded_funded = ${FUND}`,
    (l: any) => l.shielded_funded === FUND,
  );

  step('capture the qualified coin description (mt_index from the commitment-tree window)');
  let candidates: bigint[];
  try {
    const { mtIndex, position } = await mtIndexForSingleOutput(fundTxId!);
    candidates = [mtIndex];
    details.mtIndexCapture = { mtIndex, window: [position.startIndex, position.endIndex] };
  } catch (e: any) {
    // Multi-output funding transaction: resolve by retry across the window
    // (INV-5 — a wrong index is unsatisfiable at proving time, nothing is
    // submitted, so retry cannot mis-spend).
    const { candidates: all, position } = await candidateIndices(fundTxId!);
    candidates = all;
    details.mtIndexCapture = {
      note: String(e?.message ?? e),
      candidates: all,
      window: [position.startIndex, position.endIndex],
    };
  }
  if (candidates.length === 0) {
    fail(
      details,
      'FAIL',
      'mt-index-capture-empty',
      'The funding transaction exposed no commitment-tree window (no mt_index candidates) — ' +
      'the qualified coin description cannot be built; see details.mtIndexCapture.',
    );
  }
  console.log(`  mt_index candidate(s): ${candidates.join(', ')}`);

  const tillBefore = await till.ledgerState();

  step(`pay: payer.pay_shielded(color, ${PAY}) — witness coin, sendShielded, cross-contract claim`);
  const metrics = instrumentProving(payer.providers);
  let outcome: any;
  let usedMtIndex: bigint | undefined;
  const t0 = performance.now();
  for (let i = 0; i < candidates.length; i++) {
    const mtIndex = candidates[i];
    const store: CoinStorePrivateState = withCoin(emptyCoinStore(), {
      nonce: coin.nonce,
      color: coin.color,
      value: coin.value,
      mtIndex,
    });
    await payer.providers.privateStateProvider.set('payer-p7', store);
    try {
      outcome = await payer.call('pay_shielded', coin.color, PAY);
      usedMtIndex = mtIndex;
      break;
    } catch (e: any) {
      const cls = classifyCallError(e);
      const retryable =
        candidates.length > 1 &&
        i < candidates.length - 1 &&
        (cls.outcome === 'prover-rejected' || cls.outcome === 'construction-rejected');
      if (retryable) {
        console.log(`  mt_index ${mtIndex} unsatisfiable (${cls.errorCode}) — trying the next candidate`);
        continue;
      }
      details.error = serialiseError(e);
      details.errorClass = cls;
      details.provingMetrics = metrics;
      const blocked = cls.errorCode === 'fee-wall-outside-time-to-dismiss';
      fail(
        details,
        blocked ? 'BLOCKED' : 'FAIL',
        cls.errorCode,
        `The payer holds the minted shielded coin (funded ${FUND}) but the value-moving call ` +
        `transaction did not land: ${cls.note} (stage: ${cls.outcome})`,
      );
    }
  }
  const endToEndMs = Math.round(performance.now() - t0);
  details.payTxId = outcome.txId;
  details.usedMtIndex = usedMtIndex;
  details.endToEndMs = endToEndMs;
  details.provingMetrics = metrics;
  console.log(
    `  tx ${outcome.txId} · ${endToEndMs} ms end to end · proving ${metrics.proveWallMs} ms · ` +
    `tx ${metrics.unprovenTxBytes ?? '?'} B unproven → ${metrics.provenTxBytes ?? '?'} B proven`,
  );

  step('the circuit returned [sent, change] — the surviving-coin rule client-side');
  const tuple = circuitResult(outcome.result);
  const sent = tuple?.[0];
  const change = tuple?.[1];
  if (!sent?.nonce) throw new Error(`pay_shielded returned no sent coin: ${JSON.stringify(tuple)}`);
  const changeCoin = change?.is_some ? change.value : null;
  details.sent = { nonceHex: bytesToHex(sent.nonce), colorHex: bytesToHex(sent.color), value: sent.value };
  details.change = changeCoin
    ? { nonceHex: bytesToHex(changeCoin.nonce), colorHex: bytesToHex(changeCoin.color), value: changeCoin.value }
    : null;
  const nonceEvolved = bytesToHex(sent.nonce) !== bytesToHex(coin.nonce);
  const changeCorrect = changeCoin !== null && changeCoin.value === FUND - PAY;
  console.log(
    `  sent ${sent.value} (nonce evolved: ${nonceEvolved}) · change ${changeCoin?.value ?? 'none'} ` +
    `(expected ${FUND - PAY})`,
  );

  // Surviving-coin rule: sendShielded already routed the change back to the
  // payer as a live, self-owned output; the client only re-captures its
  // description for future spends. The pay transaction is multi-output, so
  // the change's exact mt_index resolves by retry on the next spend (INV-5).
  if (changeCoin) {
    const { candidates: changeCandidates } = await candidateIndices(outcome.txId).catch(() => ({ candidates: [] as bigint[] }));
    details.changeCandidates = changeCandidates;
    if (changeCandidates.length > 0) {
      await payer.providers.privateStateProvider.set(
        'payer-p7',
        withCoin(emptyCoinStore(), {
          nonce: changeCoin.nonce,
          color: changeCoin.color,
          value: changeCoin.value,
          mtIndex: changeCandidates[0],
        }),
      );
      console.log(`  change re-captured into the coin store (${changeCandidates.length} mt_index candidate(s))`);
    }
  }

  step('both ledgers advanced in one transaction; the callee holds the evolved coin');
  const payerAfter = await waitForLedger(
    () => payer.ledgerState(),
    `payer.shielded_spent = ${PAY}`,
    (l: any) => l.shielded_spent === PAY && l.shielded_funded === FUND,
  );
  const tillAfter = await waitForLedger(
    () => till.ledgerState(),
    `till.shielded_received = ${PAY}`,
    (l: any) =>
      l.shielded_received === tillBefore.shielded_received + PAY &&
      l.shielded_claims === tillBefore.shielded_claims + 1n &&
      l.held_has_coin === true,
  );
  const heldNonceMatches = bytesToHex(tillAfter.held.nonce) === bytesToHex(sent.nonce);
  const heldValueMatches = tillAfter.held.value === PAY;
  const heldColorMatches = bytesToHex(tillAfter.held.color) === bytesToHex(coin.color);
  details.afterPay = {
    payer: { shielded_funded: payerAfter.shielded_funded, shielded_spent: payerAfter.shielded_spent },
    till: {
      shielded_received: tillAfter.shielded_received,
      shielded_claims: tillAfter.shielded_claims,
      held: {
        nonceHex: bytesToHex(tillAfter.held.nonce),
        colorHex: bytesToHex(tillAfter.held.color),
        value: tillAfter.held.value,
        mt_index: tillAfter.held.mt_index,
      },
    },
    heldNonceMatchesSent: heldNonceMatches,
    heldValueMatchesPay: heldValueMatches,
    heldColorMatchesMint: heldColorMatches,
  };
  console.log(
    `  till.held nonce == sent.nonce: ${heldNonceMatches} · value ${tillAfter.held.value} · ` +
    `claims ${tillAfter.shielded_claims}`,
  );

  step('observer evidence: one transaction, both contracts');
  const observed = await fetchObserverView(outcome.txId);
  details.observer = observed;
  const actions: any[] = observed?.contractActions ?? [];
  const calls = actions.filter((a) => a.__typename === 'ContractCall');
  details.observerSummary = {
    contractCalls: calls.length,
    entryPoints: calls.map((c) => c.entryPoint ?? null),
  };
  console.log(
    `  ${calls.length} contract call(s) visible · entry points: ${calls.map((c) => c.entryPoint).join(', ')}`,
  );

  const clean = nonceEvolved && changeCorrect && heldNonceMatches && heldValueMatches && heldColorMatches;
  writeEvidence({
    testId: 'P7',
    name: 'shielded-value',
    description: DESCRIPTION,
    verdict: clean ? 'PASS' : 'PARTIAL',
    txHash: outcome.txId,
    note:
      `Shielded value MOVED across the call boundary on the published 0.19.0 runtime — the issue #658 ` +
      `verdict: till.take_shielded (a CALLEE) executed receiveShielded and claimed the sent coin in the ` +
      `SAME transaction as the payer's witness-driven sendShielded (a witness-consuming ROOT circuit ` +
      `holds a call site — question closed). Deterministic nonce evolution survived the boundary ` +
      `(till.held.nonce == result.sent.nonce: ${heldNonceMatches}); the till claimed ${PAY} ` +
      `(claims → ${tillAfter.shielded_claims}); change followed the surviving-coin rule ` +
      `(${changeCoin?.value ?? 'none'} = ${FUND} - ${PAY}: ${changeCorrect}). ` +
      `Proving ${metrics.proveWallMs} ms, tx ${metrics.provenTxBytes ?? '?'} bytes proven.` +
      (clean ? '' : ' One or more secondary checks failed — see details.'),
    details,
  });
});
