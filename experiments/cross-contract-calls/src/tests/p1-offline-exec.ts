// P1 — offline cross-contract execution at the compact-runtime level.
//
// Formalises the pre-flight smoke test: execute Caller.write_then_read
// through the PUBLISHED compact-runtime 0.19.0 crossContractCall path with
// a local state provider standing in for the indexer (the same interface
// midnight-js's CalleeStateResolver implements). No network, no proving —
// this isolates the execution layer so P2/P3 failures can be attributed to
// the network legs.
//
// Asserts, against the keyed 0.34.0 artefacts:
//   - the call-proof-data trace ends with the ROOT call (write_then_read at
//     the caller's address) with NO communication-commitment data;
//   - every callee entry (tally.set, tally.get) sits at the callee's
//     address WITH commCommData (commitment + randomness) present;
//   - the callee's ledger advanced in the caller's execution context
//     (total = x, writes = 1);
//   - read-your-writes held in-circuit (the circuit's assert passed and it
//     returned the observed value = x).
//
// The trace length also answers a design question the dossier left open:
// does each callee CALL get its own trace entry (and hence its own
// ContractCallPrototype and proof), or one per callee contract?

import * as rt from '@midnight-ntwrk/compact-runtime';

import * as TallyModule from '../../contracts/managed/Tally/contract/index.js';
import * as CallerModule from '../../contracts/managed/Caller/contract/index.js';

import { runScenario, step } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';

const COIN_PK = '0'.repeat(64);
const X = 42n;

await runScenario('p1-offline-exec', async () => {
  const details: Record<string, unknown> = {};

  step('construct both contracts locally (initial deployed states)');
  const tallyContract = new (TallyModule as any).Contract({});
  const tallyInit = await tallyContract.initialState(rt.createConstructorContext(undefined, COIN_PK));
  const tallyAddress = rt.sampleContractAddress();
  const tallyState = tallyInit.currentContractState;

  const callerContract = new (CallerModule as any).Contract({});
  const tallyAddrBytes = rt.encodeContractAddress(tallyAddress);
  details.contractRefEncoding = `{ bytes: Uint8Array(${tallyAddrBytes.length}) } via encodeContractAddress`;
  if (tallyAddrBytes.length !== 32) throw new Error('encodeContractAddress did not produce 32 bytes');
  const callerInit = await callerContract.initialState(
    rt.createConstructorContext(undefined, COIN_PK),
    { bytes: tallyAddrBytes },
  );
  const callerAddress = rt.sampleContractAddress();
  console.log(`  tally @ ${String(tallyAddress).slice(0, 16)}… · caller @ ${String(callerAddress).slice(0, 16)}…`);

  step('execute write_then_read(42) with a local callee-state provider');
  // The interface midnight-js's CalleeStateResolver implements over the
  // indexer: getContractState(blockHash, address). Locally resolved here.
  const stateProvider = {
    getContractState: async (_blockHash: unknown, address: unknown) =>
      address === tallyAddress ? tallyState : undefined,
  };
  const ctx = rt.createCircuitContext(
    'write_then_read',
    callerAddress,
    COIN_PK,
    callerInit.currentContractState,
    undefined, // private state
    stateProvider,
    undefined, // gas limit
    undefined, // cost model
    Date.now(),
    'de'.repeat(32), // parentBlockHash: any 32-byte block hash locally
  );
  const res = await (callerContract as any).circuits.write_then_read(ctx, X);

  step('inspect the call-proof-data trace');
  const trace: any[] = res.context.callProofDataTrace;
  const entries = trace.map((c: any) => ({
    circuitId: c.circuitId,
    at: String(c.contractAddress) === String(tallyAddress) ? 'tally' :
        String(c.contractAddress) === String(callerAddress) ? 'caller' : 'unknown',
    commCommData: c.commCommData ? 'present' : 'absent',
    publicTranscriptOps: c.publicTranscript?.length ?? null,
  }));
  details.trace = entries;
  for (const e of entries) {
    console.log(`  - ${e.circuitId} @ ${e.at} · commCommData ${e.commCommData} · ${e.publicTranscriptOps} transcript ops`);
  }

  const root = entries[entries.length - 1];
  if (root.circuitId !== 'write_then_read' || root.at !== 'caller') {
    throw new Error('the trace does not end with the root call');
  }
  if (root.commCommData !== 'absent') {
    throw new Error('the ROOT call carries commCommData — only sub-calls should');
  }
  const calleeEntries = entries.slice(0, -1);
  if (calleeEntries.length === 0) throw new Error('no callee entries in the trace — the call did not cross contracts');
  for (const e of calleeEntries) {
    if (e.at !== 'tally') throw new Error(`callee entry ${e.circuitId} not at the tally address`);
    if (e.commCommData !== 'present') {
      throw new Error(`callee entry ${e.circuitId} has no communication commitment — the ledger cannot pair it`);
    }
  }
  details.perCallEntries = `${calleeEntries.length} callee entr${calleeEntries.length === 1 ? 'y' : 'ies'} for 2 source-level calls (set, get) — ` +
    (calleeEntries.length === 2 ? 'one trace entry (and hence one proof) PER CALL, not per callee contract' : 'see trace');

  step('callee ledger advanced + read-your-writes');
  const tallyAfter = (TallyModule as any).ledger(res.context.queryContexts[tallyAddress].state);
  details.tallyAfter = { total: tallyAfter.total, writes: tallyAfter.writes };
  if (tallyAfter.total !== X) throw new Error(`tally.total = ${tallyAfter.total}, expected ${X}`);
  if (tallyAfter.writes !== 1n) throw new Error(`tally.writes = ${tallyAfter.writes}, expected 1`);

  const callerAfter = (CallerModule as any).ledger(res.context.queryContexts[callerAddress].state);
  details.callerAfter = { last_observed: callerAfter.last_observed, calls: callerAfter.calls };
  if (callerAfter.last_observed !== X) throw new Error('caller.last_observed did not record the read-back value');

  details.circuitResult = res.result;
  if (res.result !== X) throw new Error(`circuit returned ${res.result}, expected ${X}`);
  console.log(`  tally.total = ${tallyAfter.total} · caller.last_observed = ${callerAfter.last_observed} · returned ${res.result}`);

  writeEvidence({
    testId: 'P1',
    name: 'offline-exec',
    description:
      'compact-runtime 0.19.0 executes Caller.write_then_read cross-contract against a local state provider (no network, no proving)',
    verdict: 'PASS',
    note:
      `Trace: [${entries.map((e) => `${e.circuitId}@${e.at}(${e.commCommData})`).join(', ')}] — sub-calls carry the ` +
      `communication commitment, the root does not; ${calleeEntries.length} callee entries for the 2 source-level calls; ` +
      `callee ledger advanced (total=${tallyAfter.total}, writes=${tallyAfter.writes}) and read-your-writes held in-circuit (returned ${res.result}).`,
    details,
  });
});
