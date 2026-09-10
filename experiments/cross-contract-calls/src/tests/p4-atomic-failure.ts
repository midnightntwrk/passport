// P4 — atomic failure of a stale composed transaction, ON-NODE.
//
// Upstream demonstrates cross-contract atomicity only on branch stacks;
// this probe demonstrates it on the pinned released localnet by injecting a
// staleness fault between composition and submission:
//
//   CONTROL  Build AND PROVE (but do not submit) compose_guarded(T, T+50),
//            hold it back for the same delay the stale arm will experience,
//            then submit against UNCHANGED state — it must land. This pins
//            the attribution: whatever refuses the stale arm is not the
//            hold-back delay, the TTL, or compose_guarded itself.
//
//   STALE    Build and prove compose_guarded(T', T'+100) — the callee's
//            set_guarded asserts total == T' before writing, so the
//            composed transcript records ledger reads of total = T'. Land a
//            DIRECT tally.set(T'+7) that invalidates the recorded
//            expectation, then balance and submit the held-back
//            transaction.
//
// Expectation: the node refuses to apply the stale arm — rejected outright
// at submission (guaranteed-section transcript mismatch) or landed as a
// failed transaction — and NEITHER contract's state changes from it:
// tally.total stays at the interleaved value, tally.writes advanced only by
// the interleave, caller.calls and caller.last_observed are untouched. A
// stale composed transaction that half-applies (the caller's counter
// advancing without the callee's write, or vice versa) would falsify the
// atomicity claim; one that fully applies would falsify staleness
// protection.

import { performance } from 'node:perf_hooks';

import { createUnprovenCallTx } from '@midnight-ntwrk/midnight-js-contracts';

import * as TallyModule from '../../contracts/managed/Tally/contract/index.js';
import * as CallerModule from '../../contracts/managed/Caller/contract/index.js';

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, serialiseError, classifyCallError } from './evidence.js';
import {
  setupWallet,
  connectWitnessFree,
  compiledWitnessFree,
  type ContractHandle,
} from '../node/setup.js';
import { tallyZkConfigPath, callerZkConfigPath } from '../node/wallet.js';

const WATCH_TIMEOUT_MS = 120_000;
/** Both arms hold their proven tx back this long before balancing. */
const HOLD_BACK_MS = 20_000;

const DESCRIPTION =
  'A composed call transaction made stale between proving and submission must fail atomically on-node (with a matched-delay control that lands)';

await runScenario('p4-atomic-failure', async () => {
  const details: Record<string, unknown> = {};

  step('reconnect to the pair P2 deployed');
  const walletCtx = await setupWallet();
  const tally: ContractHandle = await connectWitnessFree(walletCtx, {
    name: 'tally',
    module: TallyModule,
    zkPath: tallyZkConfigPath,
  });
  const caller: ContractHandle = await connectWitnessFree(walletCtx, {
    name: 'caller',
    module: CallerModule,
    zkPath: callerZkConfigPath,
  });
  details.tallyAddress = tally.address;
  details.callerAddress = caller.address;
  const providers: any = caller.providers;

  /** Build and prove a compose_guarded(expected, x) WITHOUT submitting. */
  const buildAndProve = async (expected: bigint, x: bigint) => {
    const unproven: any = await createUnprovenCallTx(providers, {
      compiledContract: compiledWitnessFree('caller', CallerModule, callerZkConfigPath),
      circuitId: 'compose_guarded',
      contractAddress: caller.address,
      args: [expected, x],
    } as any);
    const t0 = performance.now();
    const proven = await providers.proofProvider.proveTx(unproven.private.unprovenTx);
    return { proven, proveMs: Math.round(performance.now() - t0) };
  };

  /** Balance and submit a held-back proven tx; classify the outcome. */
  const submitHeldBack = async (proven: any): Promise<Record<string, unknown>> => {
    try {
      const balanced = await providers.walletProvider.balanceTx(proven);
      const txId: string = await providers.midnightProvider.submitTx(balanced);
      const finalized: any = await Promise.race([
        providers.publicDataProvider.watchForTxData(txId),
        sleep(WATCH_TIMEOUT_MS).then(() => ({ status: 'watch-timeout' })),
      ]);
      return { accepted: true, txId, status: finalized?.status ?? null, blockHeight: finalized?.blockHeight ?? null };
    } catch (e: any) {
      // The wallet SDK wraps the node's refusal as a bare SubmissionError
      // (no node reason attached); distinguish it from pre-submission
      // failures so the evidence names the refusing layer.
      const cls = /SubmissionError|Transaction submission error/i.test(String(e?.message ?? e) + (e?.name ?? ''))
        ? { outcome: 'node-rejected', errorCode: 'submission-refused', note: 'the node refused the transaction at the submission RPC' }
        : classifyCallError(e);
      return { accepted: false, stage: cls.outcome, errorCode: cls.errorCode, error: serialiseError(e) };
    }
  };

  // ── CONTROL: same hold-back, no interleave — must land ─────────────────────

  const before0 = await tally.ledgerState();
  const caller0 = await caller.ledgerState();
  const T0: bigint = before0.total;
  details.control = { expected: T0, target: T0 + 50n };

  step(`CONTROL: compose_guarded(${T0}, ${T0 + 50n}) proven, held ${HOLD_BACK_MS / 1000}s, submitted against unchanged state`);
  const control = await buildAndProve(T0, T0 + 50n);
  (details.control as any).proveMs = control.proveMs;
  await sleep(HOLD_BACK_MS);
  const controlOutcome = await submitHeldBack(control.proven);
  (details.control as any).outcome = controlOutcome;
  const controlLanded =
    controlOutcome.accepted === true && !String(controlOutcome.status ?? '').toLowerCase().includes('fail');
  if (!controlLanded) {
    writeEvidence({
      testId: 'P4',
      name: 'atomic-failure',
      description: DESCRIPTION,
      verdict: 'PARTIAL',
      errorCode: String((controlOutcome as any).errorCode ?? 'control-failed'),
      note:
        'The CONTROL (held back, no interleave) did not land, so a stale-arm refusal cannot be attributed to ' +
        'staleness — see details.control.outcome for what refused it (TTL and hold-back delay are suspects).',
      details,
    });
    throw new Error('control transaction did not land — cannot attribute the stale-arm outcome');
  }
  await waitForLedger(() => tally.ledgerState(), `control landed (total = ${T0 + 50n})`, (l: any) => l.total === T0 + 50n);
  console.log(`  control landed after the hold-back (tx ${(controlOutcome as any).txId}) — delay and TTL exonerated`);

  // ── STALE: same shape, with the interleaving write ─────────────────────────

  const before = await tally.ledgerState();
  const callerBefore = await caller.ledgerState();
  const T: bigint = before.total;
  const STALE_TARGET = T + 100n;
  const INTERLEAVED = T + 7n;
  details.before = {
    tally: { total: T, writes: before.writes },
    caller: { calls: callerBefore.calls, last_observed: callerBefore.last_observed },
  };

  step(`STALE: compose_guarded(${T}, ${STALE_TARGET}) proven and held back`);
  const stale = await buildAndProve(T, STALE_TARGET);
  details.staleProveMs = stale.proveMs;
  console.log(`  proven in ${stale.proveMs} ms — held back from submission`);

  step(`interleave: direct tally.set(${INTERLEAVED}) invalidates the composed expectation`);
  const interleave = await tally.call('set', INTERLEAVED);
  details.interleaveTx = interleave.txId;
  await waitForLedger(() => tally.ledgerState(), `tally.total = ${INTERLEAVED}`, (l: any) => l.total === INTERLEAVED);
  // Let the wallet's dust view catch up before balancing the held-back tx
  // (and match the control's hold-back window).
  await sleep(HOLD_BACK_MS - 10_000 > 0 ? 10_000 : HOLD_BACK_MS);

  step('submit the stale composed transaction');
  const submission = await submitHeldBack(stale.proven);
  details.staleSubmission = submission;
  let staleApplied = false;
  if ((submission as any).accepted) {
    const status = String((submission as any).status ?? '').toLowerCase();
    staleApplied = status.includes('succe') && !status.includes('partial');
    console.log(`  node accepted the submission — finalisation status: ${(submission as any).status}`);
  } else {
    console.log(
      `  submission REFUSED (${(submission as any).stage}: ${(submission as any).errorCode}) — ` +
      'the identically-delayed control landed, so the staleness is what refused it',
    );
  }

  step('neither contract changed from the stale transaction');
  await sleep(5_000);
  const after = await tally.ledgerState();
  const callerAfter = await caller.ledgerState();
  details.after = {
    tally: { total: after.total, writes: after.writes },
    caller: { calls: callerAfter.calls, last_observed: callerAfter.last_observed },
  };

  const tallyClean = after.total === INTERLEAVED && after.writes === before.writes + 1n;
  const callerClean =
    callerAfter.calls === callerBefore.calls && callerAfter.last_observed === callerBefore.last_observed;
  details.stateCheck = { tallyClean, callerClean, staleApplied };
  console.log(
    `  tally.total = ${after.total} (interleaved value ${tallyClean ? 'intact' : 'VIOLATED'}) · ` +
    `caller.calls = ${callerAfter.calls} (${callerClean ? 'untouched' : 'CHANGED'})`,
  );

  if (staleApplied || after.total === STALE_TARGET) {
    writeEvidence({
      testId: 'P4',
      name: 'atomic-failure',
      description: DESCRIPTION,
      verdict: 'FAIL',
      errorCode: 'stale-tx-applied',
      note: 'The STALE composed transaction took effect — staleness protection did not hold. Inspect details.',
      details,
    });
    throw new Error('the stale composed transaction was applied');
  }
  if (!tallyClean || !callerClean) {
    writeEvidence({
      testId: 'P4',
      name: 'atomic-failure',
      description: DESCRIPTION,
      verdict: 'FAIL',
      errorCode: 'partial-application',
      note: 'The stale transaction did not apply, but one side\'s state moved — atomicity across the pair did not hold. Inspect details.',
      details,
    });
    throw new Error('state changed asymmetrically after the stale submission');
  }

  const how = (submission as any).accepted
    ? `the node accepted the submission but finalised it as '${(submission as any).status}' with no state effect`
    : `the node refused it at submission (${(submission as any).stage}: ${(submission as any).errorCode})`;
  writeEvidence({
    testId: 'P4',
    name: 'atomic-failure',
    description: DESCRIPTION,
    verdict: 'PASS',
    txHash: (submission as any).txId,
    errorCode: (submission as any).errorCode,
    note:
      `Atomic failure held on-node: the composed compose_guarded(${T}, ${STALE_TARGET}) transaction, proven before a ` +
      `direct set(${INTERLEAVED}) interleaved, did not take effect — ${how}. The matched-delay CONTROL landed, so the ` +
      `refusal is the staleness, not TTL or delay. tally.total stayed at the interleaved ${after.total}; caller.calls ` +
      `and last_observed untouched: neither half of the composed pair applied.`,
    details,
  });
});
