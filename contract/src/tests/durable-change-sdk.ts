// SDK receipt boundaries over controlled HTTP replies. These tests do not
// substitute mocked receipts for a localnet acceptance or qualification proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ContractState as RuntimeContractState } from '@midnight-ntwrk/compact-runtime';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  ChargedState, StateValue, ContractState, ContractOperation, LedgerParameters,
  ZswapChainState, ZswapOffer, ZswapOutput, sampleEncryptionPublicKey,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { createSdkChangeAdapter } from '../wallet/sdk-change-adapter.js';
import { Contract } from '../wallet/contract.js';
import { bytesToHex } from '../wallet/hex.js';
import { JubjubDevice, authArgs, jubjubChallenges } from '../wallet/signer.js';
import { emptyCoinStore, makeWitnesses, withCoin, withSelectedCoin } from '../wallet/witnesses.js';
import { AccountSim } from './sim.js';

const id = '12'.repeat(32), otherId = '34'.repeat(32), address = '56'.repeat(32);
const change = { nonce: new Uint8Array(32).fill(1), color: new Uint8Array(32).fill(2), value: 70n };
const record = (status = 'SUCCESS') => ({
  protocolVersion: 2_000_000, hash: '78'.repeat(32), block: { hash: '9a'.repeat(32) },
  identifiers: [id], zswapStartIndex: '3', zswapEndIndex: '4',
  transactionResult: { status, segments: [{ id: 0, success: status === 'SUCCESS' }] },
});
function adapter(onSnapshot?: () => void) {
  return createSdkChangeAdapter({
    providers: { zkConfigProvider: {}, publicDataProvider: {
      queryZSwapAndContractState: async () => { onSnapshot?.(); return null; },
    } }, compiledContract: {}, address, privateStateId: 'sdk-test',
    indexerUrl: 'http://localhost:1/graphql', proofServerUrl: 'http://localhost:1',
    observationTimeoutMs: 0, requestTimeoutMs: 25,
  });
}

for (const [wire, expected] of [
  ['SUCCESS', 'succeeded'], ['PARTIAL_SUCCESS', 'partial'], ['FAILURE', 'rejected'], ['PENDING', 'unknown'],
] as const) test(`SDK maps authoritative ${wire} without treating inclusion as complete success`, async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { transactions: [record(wire)] } }));
  assert.deepEqual(await adapter().observe([id]), { status: expected, transactionIds: [id] });
});

test('SDK selects the matching identifier from offset results and normalises hexadecimal identity', async t => {
  const offsets: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    offsets.push(JSON.parse(init!.body as string).variables.offset.identifier);
    return Response.json({ data: { transactions: [
      { ...record(), identifiers: [otherId] }, { ...record(), identifiers: [`0x${id.toUpperCase()}`] },
    ] } });
  });
  assert.deepEqual(await adapter().observe([`0x${id.toUpperCase()}`]), { status: 'succeeded', transactionIds: [id] });
  assert.deepEqual(offsets, [id]);
});

test('SDK contradictory segment outcome prevents successful adoption', async t => {
  const contradictory = record(); contradictory.transactionResult.segments[0].success = false;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { transactions: [contradictory] } }));
  assert.equal((await adapter().observe([id])).status, 'unknown');
  await assert.rejects(() => adapter().qualify(change, [id]), /not succeeded entirely/);
});

test('SDK contradictory rejection and malformed segment evidence remain unknown', async t => {
  const cases: Array<[string, unknown, string]> = [
    ['failure includes a successful segment', [{ id: 0, success: true }], 'FAILURE'],
    ['failure includes mixed segments', [{ id: 0, success: false }, { id: 1, success: true }], 'FAILURE'],
    ['segments is an object', { id: 0, success: true }, 'SUCCESS'],
    ['segment is null', [null], 'SUCCESS'],
    ['segment success is a string', [{ id: 0, success: 'true' }], 'SUCCESS'],
    ['segment success is missing', [{ id: 0 }], 'FAILURE'],
  ];
  for (const [name, segments, status] of cases) await t.test(name, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { transactions: [
      { ...record(status), transactionResult: { status, segments } },
    ] } }));
    assert.equal((await adapter().observe([id])).status, 'unknown');
    await assert.rejects(() => adapter().qualify(change, [id]), /not succeeded entirely/);
  });
});

test('SDK absent, unrelated, wrong-era, malformed, and unavailable receipts remain unknown', async t => {
  const cases = [
    ['absent', () => Response.json({ data: { transactions: [] } })],
    ['unrelated', () => Response.json({ data: { transactions: [{ ...record(), identifiers: [otherId] }] } })],
    ['wrong era', () => Response.json({ data: { transactions: [{ ...record(), protocolVersion: 1_000_000 }] } })],
    ['unknown era', () => Response.json({ data: { transactions: [{ ...record(), protocolVersion: 3_000_000 }] } })],
    ['malformed body', () => Response.json({ data: {} })],
    ['GraphQL error', () => Response.json({ errors: [{ message: 'indexer unavailable' }] })],
    ['HTTP error', () => new Response('', { status: 503 })],
    ['transport failure', () => { throw new Error('connection lost'); }],
  ] as const;
  for (const [name, response] of cases) await t.test(name, async t => {
    t.mock.method(globalThis, 'fetch', async () => response());
    assert.equal((await adapter().observe([id])).status, 'unknown');
  });
});

test('SDK refuses malformed or excessive qualification windows before querying private state', async t => {
  const cases = [
    ['no outputs', '3', '3'], ['reversed', '4', '3'], ['negative', '-1', '2'],
    ['unsafe number', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
    ['excessive', '0', '257'], ['missing start', undefined, '2'],
  ] as const;
  for (const [name, start, end] of cases) await t.test(name, async t => {
    let snapshots = 0;
    t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { transactions: [
      { ...record(), zswapStartIndex: start, zswapEndIndex: end },
    ] } }));
    await assert.rejects(() => adapter(() => { snapshots++; }).qualify(change, [id]), /position|range/);
    assert.equal(snapshots, 0);
  });
});

test('SDK missing historical commitment snapshot cannot qualify returned change', async t => {
  let snapshots = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { transactions: [record()] } }));
  await assert.rejects(() => adapter(() => { snapshots++; }).qualify(change, [id]), /snapshot is unavailable/);
  assert.equal(snapshots, 1);
});

test('SDK prepares the generated spend without private-state writes, captures final IDs, and submits at most once', async t => {
  setNetworkId('undeployed');
  const sim = await AccountSim.create({ initialRecoveryPk: new JubjubDevice(50n).pk,
    initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
  const managed = new URL('../../contracts/managed/account/', import.meta.url);
  const circuit = 'withdraw_shielded_with_jubjub';
  const compiled = CompiledContract.make('account', Contract).pipe(
    CompiledContract.withWitnesses(makeWitnesses()), CompiledContract.withCompiledFileAssets(fileURLToPath(managed)));
  const contractState = new ContractState();
  contractState.data = new ChargedState(StateValue.decode(sim.state.state.encode()));
  const operation = new ContractOperation();
  operation.verifierKey = readFileSync(new URL(`keys/${circuit}.verifier`, managed));
  contractState.setOperation(circuit, operation);
  // The pinned indexer provider exposes Compact runtime contract state.
  const providerContractState = RuntimeContractState.deserialize(contractState.serialize());
  const ledgerCoin = { nonce: '01'.repeat(32), type: '02'.repeat(32), value: 100n };
  const output = ZswapOutput.newContractOwned(ledgerCoin, 0, sim.addressHex);
  const [unclosed, positions] = new ZswapChainState().tryApply(ZswapOffer.fromOutput(output));
  const chain = unclosed.postBlockUpdate(new Date(), 600n);
  const input = { nonce: new Uint8Array(Buffer.from(ledgerCoin.nonce, 'hex')),
    color: new Uint8Array(Buffer.from(ledgerCoin.type, 'hex')), value: ledgerCoin.value,
    mt_index: positions.get(output.commitment)! };
  const privateState = withSelectedCoin(withCoin(emptyCoinStore(), { ...input, mtIndex: input.mt_index }), input);
  const recipient = new Uint8Array(32).fill(8);
  const encryptionPublicKey = sampleEncryptionPublicKey();
  const auth = sim.device.sign(jubjubChallenges.withdrawShielded(sim.callContext(), sim.device.pk,
    recipient, input.color, 30n, input), 0n);
  let writes = 0, submits = 0, proofCalls = 0, balanceCalls = 0, loseAcknowledgement = true;
  const balanced = { version: 'v9', tx: { identifiers: () => [`0x${id.toUpperCase()}`, otherId, otherId] } };
  const providers = {
    zkConfigProvider: new NodeZkConfigProvider(fileURLToPath(managed)),
    privateStateProvider: { setContractAddress: () => {}, get: async () => structuredClone(privateState),
      set: async () => { writes++; } },
    publicDataProvider: { queryBlock: async () => ({ hash: '00'.repeat(32) }),
      queryZSwapAndContractState: async () => [chain, providerContractState, LedgerParameters.initialParameters()] },
    walletProvider: { getCoinPublicKey: () => bytesToHex(recipient), getEncryptionPublicKey: () => encryptionPublicKey,
      balanceTx: async (proven: any) => { balanceCalls++; assert.equal(proven.version, 'v9'); return balanced; } },
    proofProvider: { proveTx: async (unproven: any) => {
      proofCalls++; assert.equal(unproven.version, 'v9'); assert.ok(unproven.tx);
      // Assembly is real. Cryptographic proving and balancing are this fixture's boundary.
      return { version: 'v9', tx: unproven.tx };
    } },
    midnightProvider: { submitTx: async (tx: any) => {
      submits++; assert.equal(tx, balanced);
      if (loseAcknowledgement) throw new Error('submission acknowledgement lost');
      return id;
    } },
  };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('preparation must not query recovery HTTP'); });
  const sdk = createSdkChangeAdapter({ providers, compiledContract: compiled, address: sim.addressHex,
    privateStateId: 'prepared-sdk-test', indexerUrl: 'http://localhost:1/graphql', proofServerUrl: 'http://localhost:1',
    observationTimeoutMs: 0 });
  const prepared = await sdk.prepare(circuit, [{ bytes: recipient }, input.color, 30n, ...authArgs(auth)]);
  assert.equal(proofCalls, 1); assert.equal(balanceCalls, 1);
  assert.equal(writes, 0); assert.equal(submits, 0);
  assert.deepEqual(prepared.transactionIds, [id, otherId]);
  assert.equal(prepared.change?.value, 70n);
  assert.equal(prepared.result.private.result.is_some, true);
  await assert.rejects(() => prepared.submit(), /acknowledgement lost/);
  await assert.rejects(() => prepared.submit(), /already been submitted/);
  assert.equal(submits, 1); assert.equal(writes, 0);

  loseAcknowledgement = false;
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async () => { polls++; return Response.json({ data: { transactions: [] } }); });
  const noPoll = await sdk.prepare(circuit, [{ bytes: recipient }, input.color, 30n, ...authArgs(auth)]);
  await noPoll.submit();
  assert.equal(polls, 0, 'a zero observation budget performs no post-ack polling');

  const bounded = createSdkChangeAdapter({ providers, compiledContract: compiled, address: sim.addressHex,
    privateStateId: 'prepared-sdk-test', indexerUrl: 'http://localhost:1/graphql', proofServerUrl: 'http://localhost:1',
    observationTimeoutMs: 25, requestTimeoutMs: 500 });
  const finite = await bounded.prepare(circuit, [{ bytes: recipient }, input.color, 30n, ...authArgs(auth)]);
  let now = Date.now();
  const budgets: number[] = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    budgets.push(milliseconds); return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    polls++; now += 30;
    return Response.json({ data: { transactions: [] } });
  });
  await finite.submit();
  assert.deepEqual(budgets, [25], 'each request is bounded by the remaining observation budget');
  assert.equal(polls, 1, 'deadline exhaustion prevents checking a second identifier');
  assert.equal(writes, 0);
});
