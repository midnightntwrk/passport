// P3 — the headline: a real cross-contract call transaction, end to end.
//
// caller.callTx.write_then_read(42) through the ordinary midnight-js call
// path — nothing cross-contract-specific passed by the client: the stack
// pins the latest block, resolves the callee's state through the indexer,
// executes both contracts locally, assembles ONE intent with one
// ContractCallPrototype per call, proves every call in the tree via the
// ZK-config registry, and submits. P1 proved everything above the network
// boundary; P3 is the two legs no one has executed on published packages:
// the proof server proving a multi-call tree and the node accepting a
// multi-call intent.
//
// Records: proving wall time and transaction sizes (a proveTx wrapper on
// the proof provider), the finalized status, both contracts' ledger
// transitions, and the observer's view of the transaction from the indexer
// (which addresses and entry points are visible).

import { performance } from 'node:perf_hooks';

import * as TallyModule from '../../contracts/managed/Tally/contract/index.js';
import * as CallerModule from '../../contracts/managed/Caller/contract/index.js';

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence, serialiseError, classifyCallError } from './evidence.js';
import { setupWallet, connectWitnessFree, type ContractHandle } from '../node/setup.js';
import { CONFIG, tallyZkConfigPath, callerZkConfigPath } from '../node/wallet.js';

const X = 42n;

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

await runScenario('p3-live-call', async () => {
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

  const tallyBefore = await tally.ledgerState();
  const callerBefore = await caller.ledgerState();
  details.before = {
    tally: { total: tallyBefore.total, writes: tallyBefore.writes },
    caller: { calls: callerBefore.calls, last_observed: callerBefore.last_observed },
  };

  const metrics = instrumentProving(caller.providers);

  step(`live call: caller.callTx.write_then_read(${X})`);
  const t0 = performance.now();
  let outcome;
  try {
    outcome = await caller.call('write_then_read', X);
  } catch (e: any) {
    const cls = classifyCallError(e);
    details.error = serialiseError(e);
    details.provingMetrics = metrics;
    writeEvidence({
      testId: 'P3',
      name: 'live-call',
      description: 'The two-contract call transaction proven and submitted for real (proof server + node)',
      verdict: 'FAIL',
      errorCode: cls.errorCode,
      note: `${cls.note} (stage: ${cls.outcome})`,
      details,
    });
    throw e;
  }
  const endToEndMs = Math.round(performance.now() - t0);
  details.txId = outcome.txId;
  details.endToEndMs = endToEndMs;
  details.provingMetrics = metrics;
  details.finalized = {
    status: outcome.result?.public?.status ?? null,
    blockHeight: outcome.result?.public?.blockHeight ?? null,
  };
  console.log(
    `  tx ${outcome.txId} · ${endToEndMs} ms end to end · proving ${metrics.proveWallMs} ms · ` +
    `tx ${metrics.unprovenTxBytes ?? '?'} B unproven → ${metrics.provenTxBytes ?? '?'} B proven`,
  );

  step('both ledgers advanced in one transaction');
  const tallyAfter = await waitForLedger(
    () => tally.ledgerState(),
    `tally.total = ${X}`,
    (l: any) => l.total === X && l.writes === tallyBefore.writes + 1n,
  );
  const callerAfter = await waitForLedger(
    () => caller.ledgerState(),
    `caller.last_observed = ${X}`,
    (l: any) => l.last_observed === X && l.calls === callerBefore.calls + 1n,
  );
  details.after = {
    tally: { total: tallyAfter.total, writes: tallyAfter.writes },
    caller: { calls: callerAfter.calls, last_observed: callerAfter.last_observed },
  };

  step('observer evidence: the transaction as the indexer serves it');
  const observed = await fetchObserverView(outcome.txId);
  details.observer = observed;
  const actions: any[] = observed?.contractActions ?? [];
  const calls = actions.filter((a) => a.__typename === 'ContractCall');
  const addressesSeen = new Set(actions.map((a) => String(a.address).replace(/^0x/, '').toLowerCase()));
  const tallyVisible = addressesSeen.has(tally.address.replace(/^0x/, '').toLowerCase());
  const callerVisible = addressesSeen.has(caller.address.replace(/^0x/, '').toLowerCase());
  details.observerSummary = {
    contractCalls: calls.length,
    entryPoints: calls.map((c) => c.entryPoint ?? null),
    bothAddressesVisible: tallyVisible && callerVisible,
  };
  console.log(
    `  ${calls.length} contract call(s) visible · entry points: ${calls.map((c) => c.entryPoint).join(', ')} · ` +
    `both addresses visible: ${tallyVisible && callerVisible}`,
  );

  writeEvidence({
    testId: 'P3',
    name: 'live-call',
    description: 'The two-contract call transaction proven and submitted for real (proof server + node)',
    verdict: 'PASS',
    txHash: outcome.txId,
    note:
      `write_then_read(${X}) landed: tally.total ${tallyBefore.total} → ${tallyAfter.total} and ` +
      `caller.last_observed → ${callerAfter.last_observed} in ONE transaction. Proving ${metrics.proveWallMs} ms for the ` +
      `call tree (P1 measured one proof per source-level call: set, get, root); tx ${metrics.provenTxBytes ?? '?'} bytes proven. ` +
      `Observer sees ${calls.length} contract calls with entry points [${calls.map((c) => c.entryPoint).join(', ')}] — ` +
      `${tallyVisible && callerVisible ? 'both contract addresses visible, paired' : 'address visibility partial — inspect details.observer'}.`,
    details,
  });
});
