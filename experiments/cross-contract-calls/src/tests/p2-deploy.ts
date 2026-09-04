// P2 — deploy the pair, then probe the indexer's block-pinned state query.
//
//   (a) Deploy Tally (no constructor args), then deploy Caller with the
//       contract reference as its constructor argument — the bare 32-byte
//       address struct { bytes: encodeContractAddress(tallyAddress) }. This
//       is the first execution of a contract-typed constructor argument
//       through the published deployContract path on this stack.
//
//   (b) Read the caller's ledger back and check the stored reference decodes
//       to the tally address.
//
//   (c) Probe the query the cross-contract machinery lives on: midnight-js's
//       CalleeStateResolver resolves callee state with
//       queryContractState(address, { type: 'blockHash', blockHash }) — the
//       indexer's `contract(address:, offset:)` "as of" query. Upstream
//       flags MAINLINE indexer builds failing this with "No public state
//       found at contract address" (their QA pins a branch indexer), so P2
//       asks indexer-standalone:4.4.0-rc.2 explicitly, through the provider
//       AND as a raw GraphQL request, and records the answer either way.
//
// Verdict: PASS = both deploys landed, the reference round-trips, and the
// block-pinned query returns the contract state. PARTIAL = deploys landed
// but the pinned query failed (the P3 live call is then expected to fail in
// callee resolution — the recorded GraphQL response is the evidence).

import * as TallyModule from '../../contracts/managed/Tally/contract/index.js';
import * as CallerModule from '../../contracts/managed/Caller/contract/index.js';

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import {
  setupWallet,
  deployWitnessFree,
  contractRefArg,
  type ContractHandle,
} from '../node/setup.js';
import { CONFIG, tallyZkConfigPath, callerZkConfigPath } from '../node/wallet.js';
import { bytesToHex } from '../wallet/hex.js';

await runScenario('p2-deploy', async () => {
  const details: Record<string, unknown> = {};

  step('wallet: sync the genesis-funded wallet');
  const walletCtx = await setupWallet();

  step('deploy Tally (the callee)');
  const tally: ContractHandle = await deployWitnessFree(walletCtx, {
    name: 'tally',
    module: TallyModule,
    zkPath: tallyZkConfigPath,
  });
  details.tallyAddress = tally.address;
  console.log(`  tally @ ${tally.address}`);
  const tally0 = await waitForLedger(() => tally.ledgerState(), 'tally indexed', (l: any) => l.total === 0n);
  details.tallyInitial = { total: tally0.total, writes: tally0.writes };

  step('deploy Caller with the contract reference as constructor argument');
  const refArg = contractRefArg(tally.address);
  details.constructorArg = `{ bytes: Uint8Array(${refArg.bytes.length}) }`;
  const caller: ContractHandle = await deployWitnessFree(walletCtx, {
    name: 'caller',
    module: CallerModule,
    zkPath: callerZkConfigPath,
    args: [refArg],
  });
  details.callerAddress = caller.address;
  console.log(`  caller @ ${caller.address}`);

  step('read back the stored contract reference from the caller ledger');
  const callerLedger = await waitForLedger(
    () => caller.ledgerState(),
    'caller indexed',
    (l: any) => l?.tally?.bytes instanceof Uint8Array,
  );
  const storedRef = bytesToHex(callerLedger.tally.bytes);
  details.storedReference = storedRef;
  const tallyHex = tally.address.replace(/^0x/, '').toLowerCase();
  if (!storedRef.toLowerCase().includes(tallyHex) && tallyHex !== storedRef.toLowerCase()) {
    throw new Error(`stored reference ${storedRef} does not match the tally address ${tally.address}`);
  }
  console.log(`  ledger.tally = ${storedRef.slice(0, 16)}… (matches the deployed callee)`);

  step('block-pinned contract-state query (the CalleeStateResolver read)');
  const pdp: any = tally.providers.publicDataProvider;
  const latest = await pdp.queryBlock();
  if (!latest?.hash) throw new Error('indexer returned no latest block');
  details.pinnedBlock = { hash: latest.hash, height: latest.height };

  let pinnedOk = false;
  try {
    const pinnedState = await pdp.queryContractState(tally.address, {
      type: 'blockHash',
      blockHash: latest.hash,
    });
    pinnedOk = pinnedState != null;
    details.providerPinnedQuery = pinnedOk
      ? 'returned contract state (decoded)'
      : 'returned null — the indexer answered but found no state at that block';
  } catch (e: any) {
    details.providerPinnedQuery = serialiseError(e);
  }

  // The same query, raw, recorded verbatim — the exact request the resolver
  // issues (midnight-js-indexer-public-data-provider CONTRACT_STATE_QUERY).
  const rawQuery = `query CONTRACT_STATE_QUERY($address: HexEncoded!, $offset: BlockOffset) {
    contract(address: $address, offset: $offset) { state }
  }`;
  const rawRes = await fetch(CONFIG.indexer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: rawQuery,
      variables: { address: tally.address.replace(/^0x/, ''), offset: { hash: latest.hash } },
    }),
  });
  const rawBody: any = await rawRes.json();
  const rawState: string | null = rawBody?.data?.contract?.state ?? null;
  details.rawPinnedQuery = {
    httpStatus: rawRes.status,
    errors: rawBody?.errors ?? null,
    state: rawState ? `${rawState.slice(0, 64)}… (${rawState.length} hex chars)` : null,
  };
  console.log(
    `  provider pinned query: ${pinnedOk ? 'STATE RETURNED' : 'NO STATE'} · ` +
    `raw GraphQL: ${rawState ? 'state present' : JSON.stringify(rawBody?.errors ?? null)}`,
  );

  const verdictPinned = pinnedOk && rawState !== null;
  writeEvidence({
    testId: 'P2',
    name: 'deploy',
    description:
      'Deploy Tally, deploy Caller with a contract-typed constructor argument, and probe the block-pinned indexer state query cross-contract resolution depends on',
    verdict: verdictPinned ? 'PASS' : 'PARTIAL',
    note: verdictPinned
      ? `Both contracts deployed (tally ${tally.address.slice(0, 12)}…, caller ${caller.address.slice(0, 12)}…); the ` +
        `contract reference round-trips through the constructor and ledger; indexer-standalone 4.4.0-rc.2 ANSWERS the ` +
        `block-pinned contract(address:, offset:) query — the upstream mainline-indexer weak link is not present here.`
      : `Both contracts deployed and the reference round-trips, but the BLOCK-PINNED state query failed — the exact ` +
        `upstream weak link. P3's callee resolution is expected to fail; see details.rawPinnedQuery for the verbatim answer.`,
    details,
  });
});
