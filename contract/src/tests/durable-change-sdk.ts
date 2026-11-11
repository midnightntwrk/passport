// SDK receipt boundaries over controlled HTTP replies. These tests do not
// substitute mocked receipts for a localnet acceptance or qualification proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSdkChangeAdapter } from '../wallet/sdk-change-adapter.js';

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
