// Real HTTP/WebSocket protocol, generated contract state, native commitment tree,
// and native check-result parsing. The fixture explicitly controls /check and
// chain replies: it does not prove witness correctness or localnet acceptance.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ChargedState, ContractState, StateValue, ZswapChainState, ZswapInput,
  ZswapOffer, ZswapOutput,
} from '@midnightntwrk/ledger-v9';
import { createSdkChainRecoveryAdapter } from '../wallet/sdk-chain-recovery.js';
import { generateEncKeyPair, sealInboxEntry } from '../wallet/inbox.js';
import { JubjubDevice, jubjubChallenges } from '../wallet/signer.js';
import { AccountSim } from './sim.js';

const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const genesis = hex(1), anchor = hex(2), outputBlock = hex(3), spentBlock = hex(4), txHash = hex(5);
const colour = new Uint8Array(32).fill(9);
const coin = { nonce: new Uint8Array(32).fill(6), color: colour, value: 100n };
const raw = { nonce: hex(6), type: hex(9), value: 100n };

async function fixture(t: TestContext) {
  const keys = generateEncKeyPair();
  const sim = await AccountSim.create({ initialRecoveryPk: new JubjubDevice(50n).pk,
    initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
  await sim.authorised('rotate_enc_key', (ctx, device) => jubjubChallenges.rotateEncKey(ctx, device.pk, keys.publicKey), [keys.publicKey]);
  const entry = sealInboxEntry(keys.publicKey, coin);
  await sim.call('deposit_shielded', coin, entry);
  const contract = new ContractState();
  contract.data = new ChargedState(StateValue.decode(sim.state.state.encode()));
  const other = ZswapOutput.newContractOwned({ ...raw, nonce: hex(7), value: 70n }, undefined, sim.addressHex);
  const output = ZswapOutput.newContractOwned(raw, undefined, sim.addressHex);
  const [withNeighbour] = new ZswapChainState().tryApply(ZswapOffer.fromOutput(other));
  const [unclosed, positions] = withNeighbour.tryApply(ZswapOffer.fromOutput(output));
  const commitments = unclosed.postBlockUpdate(new Date('2026-11-11T00:00:00Z'), 600n).filter(sim.addressHex);
  const index = positions.get(output.commitment)!;
  const input = ZswapInput.newContractOwned({ ...raw, mt_index: index }, undefined, sim.addressHex, commitments);
  const block = { hash: anchor, height: 42, protocolVersion: 2_000_000, zswapEndIndex: '2',
    contractZswapState: Buffer.from(commitments.serialize()).toString('hex') };
  const event = { id: 1, version: 1, protocolVersion: 2_000_000, contractAddress: sim.addressHex,
    commitment: output.commitment, transaction: { hash: txHash, block: { hash: outputBlock, height: 40 },
      zswapStartIndex: index.toString(), zswapEndIndex: (index + 1n).toString() } };
  const spentRow = { nullifier: input.nullifier, transactionHash: txHash, blockHash: spentBlock, blockHeight: 41,
    transaction: { hash: txHash, block: { hash: spentBlock, height: 41 } } };
  const observed = { requests: [] as any[], checks: [] as Buffer[], subscriptions: [] as any[] };
  const replies = {
    genesis, finalisedHash: anchor, finalisedHeight: 42,
    tip: { hash: anchor, height: 42, protocolVersion: 2_000_000 } as any,
    block: block as any,
    contractState: Buffer.from(contract.serialize()).toString('hex'),
    canonical: new Map([[0, genesis], [40, outputBlock], [41, spentBlock], [42, anchor]]),
    events: (_offset: number): any[] => [structuredClone(event)],
    // Success is controlled transport evidence. Native preimages contain fresh
    // randomness, and this fixture does not claim to execute the constraints.
    check: (_body: Buffer): number => 200,
    acknowledge: (socket: WebSocket) => { socket.send(JSON.stringify({ type: 'connection_ack' })); },
    stream: (socket: WebSocket, id: string) => { socket.send(JSON.stringify({ id, type: 'complete' })); },
    beforeAnchor: () => {},
    status: 200,
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (request.url === '/check') {
        observed.checks.push(body);
        const status = replies.check(body);
        response.writeHead(status, { 'Content-Type': 'application/octet-stream' });
        response.end(status === 200 ? Buffer.concat([Buffer.from('midnight:vec(option(u64)):'), Buffer.from([0])]) : 'fixture check rejection');
        return;
      }
      const payload = JSON.parse(body.toString()); observed.requests.push(payload);
      let result: any;
      if (payload.method) {
        switch (payload.method) {
          case 'chain_getBlockHash': result = payload.params[0] === 0 ? replies.genesis : replies.canonical.get(payload.params[0]); break;
          case 'chain_getFinalizedHead': result = replies.finalisedHash; break;
          case 'chain_getHeader': result = { number: `0x${(payload.params[0] === `0x${anchor}` ? replies.finalisedHeight : 41).toString(16)}` }; break;
          default: throw new Error(`unexpected RPC ${payload.method}`);
        }
        result = { jsonrpc: '2.0', id: payload.id, result };
      } else if (payload.query.includes('RecoverySnapshot')) {
        result = { data: { block: replies.block, contract: { state: replies.contractState } } };
      } else if (payload.query.includes('RecoveryTip')) {
        result = { data: { block: replies.tip } };
      } else if (payload.query.includes('RecoveryAnchor')) {
        replies.beforeAnchor(); result = { data: { block: replies.block } };
      } else if (payload.query.includes('RecoveryOutputs')) {
        result = { data: { contractEvents: replies.events(payload.variables.offset) } };
      } else throw new Error('unexpected fixture query');
      response.writeHead(replies.status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400); response.end(String(error));
    }
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => ws.handleUpgrade(request, socket, head, socket => ws.emit('connection', socket, request)));
  ws.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(String(data));
    if (message.type === 'connection_init') replies.acknowledge(socket);
    else if (message.type === 'subscribe') {
      observed.subscriptions.push(message);
      replies.stream(socket, message.id);
    }
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const options = { networkId: genesis, nodeUrl: `${base}/rpc`, indexerUrl: `${base}/graphql`,
    indexerWsUrl: `ws://127.0.0.1:${port}/ws`, proofServerUrl: base,
    zkConfigProvider: { get: async () => { throw new Error('builtin'); } },
    requestTimeoutMs: 1_000, subscriptionTimeoutMs: 250, maxEventPages: 2 };
  const adapter = () => createSdkChainRecoveryAdapter(options);
  const open = () => adapter().openSnapshot({ address: sim.addressHex });
  const inspect = async (hints: bigint[] = [], nextIndex?: bigint, maxIndices = 10, eventOffset?: number, mode?: 'events' | 'tree') =>
    (await open()).inspect(coin, { hints, nextIndex, maxIndices, eventOffset, mode });
  return { replies, observed, options, adapter, open, inspect, event, spentRow, index, input, sim, keys, entry };
}

test('SDK uses an indexed finalised snapshot, real inbox bytes, checked membership, and completed nullifier absence', async t => {
  const f = await fixture(t), snapshot = await f.open();
  assert.equal(snapshot.scope.blockHash, anchor);
  assert.equal(snapshot.scope.networkId, genesis);
  assert.equal(snapshot.scope.blockHeight, '42');
  assert.equal(snapshot.inboxCount, 1n);
  assert.deepEqual(snapshot.encKey, f.keys.publicKey);
  assert.deepEqual(await snapshot.readInbox(0n), f.entry);
  assert.equal(await snapshot.readInbox(1n), null);
  const result = await snapshot.inspect(coin, { hints: [], maxIndices: 10 });
  assert.equal(result.status, 'live', result.status === 'unknown' ? result.reason : undefined);
  assert.equal(result.coin.mt_index, f.index);
  assert.ok(f.observed.checks.length > 0);
  assert.deepEqual(f.observed.subscriptions[0].payload.variables, { prefixes: [f.input.nullifier], to: 42 });
  assert.ok(f.observed.subscriptions[0].payload.query.includes('fromBlock: 0'));
  assert.equal(f.observed.requests.some(value => /submit|author_|sign/.test(value.method ?? '')), false);
});

test('SDK excludes externally spent coins even though the filtered tree still contains their commitments', async t => {
  const f = await fixture(t);
  f.replies.stream = (socket, id) => {
    for (let i = 0; i < 2; i++) socket.send(JSON.stringify({ id, type: 'next', payload: { data: { shieldedNullifierTransactions: f.spentRow } } }));
    socket.send(JSON.stringify({ id, type: 'complete' }));
  };
  assert.equal((await f.inspect()).status, 'spent');
});

test('SDK rejects incomplete, unrelated, and errored nullifier streams', async t => {
  const f = await fixture(t);
  const cases: Array<[string, typeof f.replies.stream]> = [
    ['normal close is not complete', socket => socket.close()],
    ['timeout is not empty history', () => {}],
    ['unrelated operation completion', (socket, id) => socket.send(JSON.stringify({ id: `${id}-other`, type: 'complete' }))],
    ['completion carrying payload errors', (socket, id) => socket.send(JSON.stringify({ id, type: 'complete', payload: { errors: [{ message: 'fixture error' }] } }))],
    ['GraphQL error', (socket, id) => socket.send(JSON.stringify({ id, type: 'error', payload: [{ message: 'fixture error' }] }))],
    ['next with errors', (socket, id) => socket.send(JSON.stringify({ id, type: 'next', payload: { errors: [{ message: 'fixture error' }] } }))],
    ['malformed JSON', socket => socket.send('{broken')],
    ['missing nullifier row', (socket, id) => socket.send(JSON.stringify({ id, type: 'next', payload: { data: {} } }))],
  ];
  for (const [name, stream] of cases) await t.test(name, async () => {
    f.replies.stream = stream;
    assert.equal((await f.inspect([f.index])).status, 'unknown');
  });
});

test('SDK completion before connection acknowledgement cannot establish empty history', async t => {
  const f = await fixture(t);
  f.replies.acknowledge = socket => { socket.send(JSON.stringify({ id: '1', type: 'complete' })); };
  const result = await f.inspect([f.index]);
  assert.equal(result.status, 'unknown');
  if (result.status === 'unknown') assert.match(result.reason, /unexpected nullifier stream message/);
  assert.equal(f.observed.subscriptions.length, 0, 'an unsubscribed stream has no bounded history to complete');
});

test('SDK rejects nullifier scope, exact identity, and receipt inconsistencies', async t => {
  const f = await fixture(t);
  const cases: Array<[string, (row: any) => void]> = [
    ['same prefix wrong full nullifier', row => { row.nullifier = `${f.input.nullifier.slice(0, 60)}ffff`; }],
    ['future block', row => { row.blockHeight = 43; row.transaction.block.height = 43; }],
    ['transaction mismatch', row => { row.transaction.hash = hex(20); }],
    ['block hash mismatch', row => { row.transaction.block.hash = hex(20); }],
    ['block height mismatch', row => { row.transaction.block.height = 40; }],
    ['noncanonical block', row => { row.blockHash = hex(20); row.transaction.block.hash = hex(20); }],
    ['unsafe height', row => { row.blockHeight = Number.MAX_SAFE_INTEGER + 1; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const row = structuredClone(f.spentRow); mutate(row);
    f.replies.stream = (socket, id) => {
      socket.send(JSON.stringify({ id, type: 'next', payload: { data: { shieldedNullifierTransactions: row } } }));
      socket.send(JSON.stringify({ id, type: 'complete' }));
    };
    assert.equal((await f.inspect([f.index])).status, 'unknown');
  });
});

test('SDK refuses wrong genesis, stale snapshots, missing indexer anchors, and unknown protocol eras', async t => {
  const f = await fixture(t);
  const block = structuredClone(f.replies.block);
  const cases: Array<[string, () => void]> = [
    ['wrong genesis', () => { f.replies.genesis = hex(30); }],
    ['reorganised finalised hash', () => { f.replies.canonical.set(42, hex(30)); }],
    ['indexer behind upper bound', () => { f.replies.block = null; }],
    ['wrong indexed hash', () => { f.replies.block.hash = hex(30); }],
    ['wrong indexed height', () => { f.replies.block.height = 41; }],
    ['future protocol era', () => { f.replies.block.protocolVersion = 3_000_000; }],
    ['malformed contract state', () => { f.replies.contractState = '00'; }],
    ['missing commitment frontier', () => { delete f.replies.block.zswapEndIndex; }],
    ['negative commitment frontier', () => { f.replies.block.zswapEndIndex = '-1'; }],
    ['out-of-range commitment frontier', () => { f.replies.block.zswapEndIndex = (1n << 64n).toString(); }],
  ];
  const state = f.replies.contractState;
  for (const [name, mutate] of cases) await t.test(name, async () => {
    f.replies.genesis = genesis; f.replies.canonical.set(42, anchor); f.replies.block = structuredClone(block); f.replies.contractState = state;
    mutate(); await assert.rejects(f.open);
  });
  assert.equal(f.observed.subscriptions.length, 0, 'an unindexed upper bound never qualifies nullifier absence');
});

test('SDK keeps evidence unknown if its snapshot becomes stale during a finite stream', async t => {
  const f = await fixture(t);
  f.replies.stream = (socket, id) => {
    f.replies.canonical.set(42, hex(30));
    socket.send(JSON.stringify({ id, type: 'complete' }));
  };
  assert.equal((await f.inspect([f.index])).status, 'unknown');
});

test('SDK never turns check rejection or check transport failure into a live coin', async t => {
  const f = await fixture(t);
  for (const status of [400, 404]) await t.test(`HTTP ${status}`, async () => {
    f.replies.check = () => status;
    assert.equal((await f.inspect()).status, 'unknown');
  });
  assert.equal(f.observed.subscriptions.length, 0);
});

test('SDK refuses unrelated, malformed, stale, and noncanonical output event evidence', async t => {
  const f = await fixture(t);
  const cases: Array<[string, (event: any) => void]> = [
    ['wrong commitment', event => { event.commitment = hex(20); }],
    ['wrong owner contract', event => { event.contractAddress = hex(20); }],
    ['wrong event version', event => { event.version = 2; }],
    ['wrong protocol era', event => { event.protocolVersion = 3_000_000; }],
    ['future event', event => { event.transaction.block.height = 43; }],
    ['noncanonical event', event => { event.transaction.block.hash = hex(20); }],
    ['empty range', event => { event.transaction.zswapEndIndex = '0'; }],
    ['negative range', event => { event.transaction.zswapStartIndex = '-1'; }],
    ['missing transaction identity', event => { delete event.transaction.hash; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const event = structuredClone(f.event); mutate(event);
    f.replies.events = () => [event];
    assert.equal((await f.inspect()).status, 'unknown');
  });
  assert.equal(f.observed.checks.length, 0, 'bad event metadata is rejected before trusting its positions');
});

test('SDK bounded commitment search resumes without skipping a lower position behind a bogus hint', async t => {
  const f = await fixture(t);
  const first = await f.inspect([999n], undefined, 1);
  assert.equal(first.status, 'unknown');
  if (first.status !== 'unknown') return;
  assert.ok(first.nextIndex !== undefined, 'bounded work must return its first unchecked ordered position');
  assert.ok(BigInt(first.nextIndex) <= f.index, 'a high hint must not move the cursor past the real low commitment');
  let result = await f.inspect([999n], BigInt(first.nextIndex), 1);
  if (result.status === 'unknown' && result.nextIndex !== undefined) {
    assert.ok(BigInt(result.nextIndex) > BigInt(first.nextIndex), 'continuation must stop retrying the bad hint');
    result = await f.inspect([999n], BigInt(result.nextIndex), 1);
  }
  assert.equal(result.status, 'live');
});

test('SDK sorts nonmonotonic output ranges before issuing a resumable cursor', async t => {
  const f = await fixture(t);
  const high = structuredClone(f.event); high.transaction.zswapStartIndex = '999'; high.transaction.zswapEndIndex = '1000';
  const low = structuredClone(f.event); low.id = 2;
  low.transaction.zswapStartIndex = '0';
  f.replies.events = () => [high, low];
  let checks = 0; f.replies.check = () => ++checks === 1 ? 400 : 200;
  const first = await f.inspect([], undefined, 1);
  assert.equal(first.status, 'unknown');
  if (first.status !== 'unknown') return;
  assert.ok(first.nextIndex !== undefined);
  assert.ok(BigInt(first.nextIndex) <= f.index);
  assert.equal((await f.inspect([], BigInt(first.nextIndex), 1)).status, 'live');
});

test('SDK bounds event history and refuses to infer absence from a truncated full page', async t => {
  const f = await fixture(t);
  f.options.maxEventPages = 1;
  f.replies.events = () => Array.from({ length: 100 }, (_, id) => ({ ...structuredClone(f.event), id }));
  f.replies.check = () => 400;
  assert.equal((await f.inspect()).status, 'unknown');
  assert.equal(f.observed.subscriptions.length, 0);
  assert.equal(f.observed.requests.filter(value => value.query?.includes('RecoveryOutputs')).length, 1);
});

test('SDK can qualify within a bounded event window and resume its unfinished range', async t => {
  const f = await fixture(t);
  f.options.maxEventPages = 1;
  f.replies.events = () => Array.from({ length: 100 }, (_, id) => ({ ...structuredClone(f.event), id,
    transaction: { ...structuredClone(f.event.transaction), zswapStartIndex: '0', zswapEndIndex: '2' } }));
  let checks = 0; f.replies.check = () => ++checks === 1 ? 400 : 200;
  const first = await f.inspect([], undefined, 1);
  assert.equal(first.status, 'unknown');
  if (first.status !== 'unknown') return;
  assert.equal(first.nextIndex, '1');
  assert.equal(first.nextEventOffset, 0);
  const second = await f.inspect([], BigInt(first.nextIndex!), 1, first.nextEventOffset);
  assert.equal(second.status, 'live');
  assert.deepEqual(f.observed.requests.filter(value => value.query?.includes('RecoveryOutputs')).map(value => value.variables.offset), [0, 0]);
});

test('SDK later event windows can contain lower tree indices without being skipped by an old cursor', async t => {
  const f = await fixture(t);
  f.options.maxEventPages = 1;
  f.replies.events = offset => offset === 0
    ? Array.from({ length: 100 }, (_, id) => ({ ...structuredClone(f.event), id,
      transaction: { ...structuredClone(f.event.transaction), zswapStartIndex: '999', zswapEndIndex: '1000' } }))
    : [{ ...structuredClone(f.event), id: 100 }];
  const first = await f.inspect([], undefined, 2);
  assert.equal(first.status, 'unknown');
  if (first.status !== 'unknown') return;
  assert.equal(first.nextIndex, '0');
  assert.equal(first.nextEventOffset, 100);
  const second = await f.inspect([999n], BigInt(first.nextIndex!), 1, first.nextEventOffset);
  assert.equal(second.status, 'live', 'a continuation must ignore stale hints and search the new window from zero');
  assert.deepEqual(f.observed.requests.filter(value => value.query?.includes('RecoveryOutputs')).map(value => value.variables.offset), [0, 100]);
});

test('SDK starts at an indexed finalised anchor when the indexer lags the node', async t => {
  const f = await fixture(t);
  f.replies.tip = { hash: spentBlock, height: 41, protocolVersion: 2_000_000 };
  f.replies.block = { ...f.replies.block, hash: spentBlock, height: 41 };
  const snapshot = await f.open();
  assert.equal(snapshot.scope.blockHash, spentBlock);
  assert.equal(snapshot.scope.blockHeight, '41');
  assert.equal((await snapshot.inspect(coin, { hints: [f.index], maxIndices: 1 })).status, 'live');
  assert.equal(f.observed.subscriptions[0].payload.variables.to, 41);
});

test('SDK honours a pinned older snapshot and rejects a cursor beyond node finality', async t => {
  const f = await fixture(t);
  f.replies.block = { ...f.replies.block, hash: spentBlock, height: 41 };
  const snapshot = await f.adapter().openSnapshot({ address: f.sim.addressHex, blockHash: spentBlock });
  assert.equal(snapshot.scope.blockHash, spentBlock);
  assert.equal(snapshot.scope.blockHeight, '41');
  assert.equal(f.observed.requests.some(value => value.query?.includes('RecoveryTip')), false);
  f.replies.finalisedHeight = 40;
  await assert.rejects(() => f.adapter().openSnapshot({ address: f.sim.addressHex, blockHash: spentBlock }), /not finalised/);
});

test('SDK output page transport failure remains unknown rather than an empty history', async t => {
  const f = await fixture(t);
  f.replies.events = () => { throw new Error('fixture page transport failed'); };
  assert.equal((await f.inspect()).status, 'unknown');
  assert.equal(f.observed.subscriptions.length, 0);
  assert.equal(f.observed.checks.length, 0, 'a failed event query is not an empty completed history');
});

test('SDK changing the event-page budget on continuation cannot skip lower positions in a later page', async t => {
  const f = await fixture(t);
  f.options.maxEventPages = 1;
  f.replies.events = offset => offset === 0
    ? Array.from({ length: 100 }, (_, id) => ({ ...structuredClone(f.event), id,
      transaction: { ...structuredClone(f.event.transaction), zswapStartIndex: '9', zswapEndIndex: '11' } }))
    : [{ ...structuredClone(f.event), id: 100 }];
  const first = await f.inspect([], undefined, 1);
  assert.equal(first.status, 'unknown');
  if (first.status !== 'unknown') return;
  assert.equal(first.nextIndex, '10');
  assert.equal(first.nextEventOffset, 0);
  f.options.maxEventPages = 2;
  const second = await f.inspect([], BigInt(first.nextIndex!), 1, first.nextEventOffset);
  assert.equal(second.status, 'unknown');
  if (second.status !== 'unknown') return;
  assert.equal(second.nextIndex, '0');
  assert.equal(second.nextEventOffset, 100);
  assert.equal((await f.inspect([], BigInt(second.nextIndex!), 1, second.nextEventOffset)).status, 'live');
});

test('SDK empty event history falls back to the bounded complete commitment tree', async t => {
  const f = await fixture(t);
  f.replies.events = () => [];
  let checks = 0; f.replies.check = () => ++checks === 1 ? 400 : 200;
  const result = await f.inspect();
  assert.equal(result.status, 'live', result.status === 'unknown' ? result.reason : undefined);
  assert.equal(result.coin.mt_index, f.index);
  assert.equal(f.observed.checks.length, 2);
  assert.equal(f.observed.subscriptions.length, 1, 'membership checking still requires separate nullifier evidence');
});

test('SDK tree fallback resumes its own cursor without repeating the event query', async t => {
  const f = await fixture(t);
  f.replies.events = () => [];
  let checks = 0; f.replies.check = () => ++checks === 1 ? 400 : 200;
  const first = await f.inspect([], undefined, 1);
  assert.equal(first.status, 'unknown');
  if (first.status !== 'unknown') return;
  assert.equal(first.nextMode, 'tree');
  assert.equal(first.nextIndex, '1');
  assert.equal(first.nextEventOffset, 0);
  const second = await f.inspect([999n], BigInt(first.nextIndex!), 1, first.nextEventOffset, first.nextMode);
  assert.equal(second.status, 'live');
  assert.equal(second.coin.mt_index, f.index);
  assert.equal(f.observed.requests.filter(value => value.query?.includes('RecoveryOutputs')).length, 1);
  assert.equal(f.observed.checks.length, 2, 'resumption must not repeat index zero or stale hints');
});

test('SDK completed tree search never imports an authenticated but unqualified description', async t => {
  const f = await fixture(t);
  f.replies.events = () => [];
  f.replies.check = () => 400;
  const result = await f.inspect();
  assert.equal(result.status, 'unknown');
  if (result.status === 'unknown') {
    assert.match(result.reason, /no verified commitment|no valid commitment/i);
    assert.equal(result.nextIndex, undefined, 'the finite tree was completely checked');
  }
  assert.equal(f.observed.checks.length, 2);
  assert.equal(f.observed.subscriptions.length, 0);
});

test('SDK tree fallback verifier failure remains unknown without a false live subtotal', async t => {
  const f = await fixture(t);
  f.replies.events = () => [];
  f.replies.check = () => 404;
  const result = await f.inspect();
  assert.equal(result.status, 'unknown');
  if (result.status === 'unknown') assert.match(result.reason, /verifier unavailable/);
  assert.equal(f.observed.checks.length, 1, 'unavailable verification stops rather than treating the failed position as absent');
  assert.equal(f.observed.subscriptions.length, 0);
});

test('SDK an empty complete commitment tree cannot establish a live coin', async t => {
  const f = await fixture(t);
  f.replies.events = () => [];
  f.replies.block.zswapEndIndex = '0';
  assert.equal((await f.inspect()).status, 'unknown');
  assert.equal(f.observed.checks.length, 0);
  assert.equal(f.observed.subscriptions.length, 0);
});

test('SDK changing the commitment frontier during a nullifier scan invalidates its snapshot', async t => {
  const f = await fixture(t);
  f.replies.stream = (socket, id) => {
    f.replies.block.zswapEndIndex = '3';
    socket.send(JSON.stringify({ id, type: 'complete' }));
  };
  const result = await f.inspect([f.index]);
  assert.equal(result.status, 'unknown');
  if (result.status === 'unknown') assert.match(result.reason, /snapshot is not indexed consistently/);
});
