// Encryption and coin identities are real. Chain observations are controlled
// fixtures here; native-ledger and live-node evidence are separate suites.
import assert from 'node:assert/strict';
import test from 'node:test';
import { scanHoldings, type ChainRecoveryAdapter, type ChainRecoverySnapshot,
  type ChainCoinInspection, type ChainRecoveryScope, type ScanHoldingsOptions } from '../wallet/chain-recovery.js';
import { generateEncKeyPair, sealInboxEntry } from '../wallet/inbox.js';
import { coinId } from '../wallet/witnesses.js';
import type { ShieldedCoin } from '../wallet/contract.js';

const bytes = (value: number) => new Uint8Array(32).fill(value);
const colour = bytes(8);
const coin = (nonce: number, value = 100n): ShieldedCoin => ({ nonce: bytes(nonce), color: colour, value });
const a = coin(1), b = coin(2, 70n), c = coin(3, 10n);
const scope: ChainRecoveryScope = { networkId: 'fixture-network', address: '11'.repeat(32), blockHash: '22'.repeat(32), blockHeight: '42' };

function fixture(coins: ShieldedCoin[] = [a]) {
  const keys = generateEncKeyPair();
  const entries: (Uint8Array | null)[] = coins.map(value => sealInboxEntry(keys.publicKey, value));
  const observed = { opens: [] as { address: string; blockHash?: string }[], reads: [] as bigint[],
    inspections: [] as { id: string; hints: bigint[]; nextIndex?: bigint; eventOffset?: number; mode?: 'events' | 'tree'; maxIndices: number }[] };
  const states = new Map<string, ChainCoinInspection>();
  for (const [i, value] of coins.entries()) states.set(coinId(value), { status: 'live', coin: { ...value, mt_index: BigInt(i) } });
  const snapshot: ChainRecoverySnapshot = {
    scope: { ...scope }, encKey: keys.publicKey, inboxCount: BigInt(entries.length),
    async readInbox(index) { observed.reads.push(index); return entries[Number(index)] ?? null; },
    async inspect(value, options) {
      observed.inspections.push({ id: coinId(value), ...options });
      return states.get(coinId(value)) ?? { status: 'unknown', reason: 'no authenticated chain commitment' };
    },
  };
  const adapter: ChainRecoveryAdapter = { async openSnapshot(request) { observed.opens.push(request); return snapshot; } };
  const options: ScanHoldingsOptions = { networkId: scope.networkId, address: scope.address, viewingKeys: [keys.secretKey] };
  return { keys, entries, observed, states, snapshot, adapter, options,
    scan: (extra: Partial<ScanHoldingsOptions> = {}) => scanHoldings(adapter, { ...options, ...extra }) };
}

test('one full pass distinguishes live, spent elsewhere, and unknown without trial submission', async () => {
  const f = fixture([a, b, c]);
  f.states.set(coinId(b), { status: 'spent', coin: { ...b, mt_index: 1n } });
  f.states.set(coinId(c), { status: 'unknown', reason: 'nullifier snapshot unavailable' });
  const report = await f.scan();
  assert.deepEqual(report.holdings.map(row => [row.id, row.status]), [[coinId(a), 'live'], [coinId(b), 'spent'], [coinId(c), 'unknown']]);
  assert.deepEqual(report.verifiedSubtotal, [{ colorHex: Buffer.from(colour).toString('hex'), value: 100n }]);
  assert.equal(report.coverage.reachedInboxEnd, true);
  assert.equal(report.coverage.unknownCandidates, 1);
  assert.equal(report.coverage.complete, false);
  assert.equal(report.cursor, null);
  assert.equal(report.application, undefined);
});

test('separately encrypted duplicates are deduplicated without losing same-colour siblings', async () => {
  const f = fixture([a, a, b, a]);
  const report = await f.scan();
  assert.equal(report.holdings.length, 2);
  assert.deepEqual(report.holdings[0].inboxIndices, ['0', '1', '3']);
  assert.equal(report.coverage.duplicateDescriptions, 2);
  assert.equal(f.observed.inspections.length, 2);
  assert.equal(report.verifiedSubtotal[0].value, 170n);
  assert.equal(report.coverage.complete, true);
});

test('candidate sources and index hints merge into one exact identity inspection', async () => {
  const f = fixture([a]);
  const report = await f.scan({ candidates: [
    { coin: a, hints: [7n], source: 'local' },
    { coin: a, hints: [7n, 9n], source: 'journal' },
    { coin: a, hints: [9n], source: 'caller' },
  ] });
  assert.equal(report.holdings.length, 1);
  assert.deepEqual(new Set(report.holdings[0].sources), new Set(['inbox', 'local', 'journal', 'caller']));
  assert.deepEqual(new Set(f.observed.inspections[0].hints), new Set([7n, 9n]));
  assert.equal(f.observed.inspections.length, 1);
});

test('authenticated bogus inbox plaintext remains unknown and is excluded from subtotal', async () => {
  const f = fixture([a]);
  f.states.clear();
  const report = await f.scan();
  assert.equal(report.coverage.openedEntries, 1);
  assert.equal(report.holdings[0].status, 'unknown');
  assert.equal(report.holdings[0].qualifiedCoin, undefined);
  assert.deepEqual(report.verifiedSubtotal, []);
  assert.equal(report.coverage.complete, false);
});

test('missing current viewing capability is explicit even when historical entries decrypt', async () => {
  const f = fixture([a]);
  f.snapshot.encKey = generateEncKeyPair().publicKey;
  const report = await f.scan();
  assert.equal(report.coverage.openedEntries, 1);
  assert.equal(report.coverage.currentViewingKeyAvailable, false);
  assert.equal(report.coverage.complete, false);
});

test('several viewing keys open historical and current entries without duplicate classification', async () => {
  const f = fixture([a, b]), older = generateEncKeyPair();
  f.entries[0] = sealInboxEntry(older.publicKey, a);
  const report = await f.scan({ viewingKeys: [older.secretKey, f.keys.secretKey, older.secretKey] });
  assert.equal(report.coverage.openedEntries, 2);
  assert.equal(report.coverage.unreadableEntries, 0);
  assert.equal(report.coverage.currentViewingKeyAvailable, true);
  assert.equal(report.coverage.complete, true);
});

test('wrong viewing keys and invalid encrypted entries cannot become holdings', async () => {
  const f = fixture([a, b]);
  f.entries[1] = new Uint8Array(192);
  const report = await f.scan({ viewingKeys: [generateEncKeyPair().secretKey] });
  assert.equal(report.coverage.unreadableEntries, 2);
  assert.equal(report.coverage.currentViewingKeyAvailable, false);
  assert.equal(report.coverage.complete, false);
  assert.deepEqual(report.holdings, []);
});

test('a missing inbox member stops the page at a resumable gap', async () => {
  const f = fixture([a, b, c]);
  f.entries[1] = null;
  const report = await f.scan();
  assert.equal(report.coverage.missingEntries, 1);
  assert.equal(report.coverage.complete, false);
  assert.deepEqual(report.holdings.map(row => row.id), [coinId(a)]);
  assert.equal(report.cursor?.nextInboxIndex, '1');
  f.entries[1] = sealInboxEntry(f.keys.publicKey, b);
  const resumed = await f.scan({ cursor: report.cursor! });
  assert.deepEqual(resumed.holdings.map(row => row.id), [coinId(b), coinId(c)]);
  assert.equal(resumed.coverage.complete, false);
});

test('inspection transport failure leaves a candidate unknown', async () => {
  const f = fixture([a]);
  f.snapshot.inspect = async () => { throw new Error('snapshot connection lost'); };
  const report = await f.scan();
  assert.equal(report.holdings[0].status, 'unknown');
  assert.equal(report.coverage.complete, false);
  assert.deepEqual(report.verifiedSubtotal, []);
});

test('bounded inbox continuation reopens the same snapshot and does not claim a complete balance', async () => {
  const f = fixture([a, b, c]);
  const first = await f.scan({ maxEntries: 2 });
  assert.deepEqual(f.observed.reads, [0n, 1n]);
  assert.equal(first.coverage.complete, false);
  assert.equal(first.cursor?.nextInboxIndex, '2');
  const restored = JSON.parse(JSON.stringify(first.cursor));
  const second = await f.scan({ maxEntries: 2, cursor: restored });
  assert.equal(f.observed.opens[1].blockHash, scope.blockHash);
  assert.deepEqual(second.holdings.map(row => row.id), [coinId(c)]);
  assert.equal(second.coverage.reachedInboxEnd, true);
  assert.equal(second.coverage.complete, false, 'a resumed page does not attest the earlier pages');
  assert.equal(second.cursor, null);
});

test('candidate budget retains each uninspected description with its own continuation', async () => {
  const f = fixture([a, b, c]);
  const first = await f.scan({ maxCandidates: 1 });
  assert.equal(first.coverage.inspectedCandidates, 1);
  assert.equal(first.cursor, null);
  assert.deepEqual(first.holdings.map(row => row.status), ['live', 'unknown', 'unknown']);
  for (const row of first.holdings.slice(1)) assert.equal(row.searchCursor?.nextIndex, '0');
  const second = await f.scan({ maxCandidates: 1,
    cursor: { version: 1, scope, nextInboxIndex: '3' },
    candidates: first.holdings.slice(1).map(row => ({ coin: row.coin, searchCursor: row.searchCursor })) });
  assert.equal(second.holdings[0].id, coinId(b));
  assert.equal(second.holdings[0].status, 'live');
  assert.equal(second.holdings[1].status, 'unknown');
  assert.equal(second.holdings[1].searchCursor?.nextIndex, '0');
});

test('a bounded coin search emits a scope-bound cursor and resumes only that coin', async () => {
  const f = fixture([a]);
  f.states.set(coinId(a), { status: 'unknown', reason: 'position search budget exhausted', nextIndex: '19' });
  const first = await f.scan({ maxCoinIndices: 17 });
  const cursor = first.holdings[0].searchCursor;
  assert.deepEqual(cursor, { version: 1, scope, coinId: coinId(a), nextIndex: '19', eventOffset: 0 });
  f.states.set(coinId(a), { status: 'live', coin: { ...a, mt_index: 21n } });
  const second = await f.scan({ candidates: [{ coin: a, searchCursor: JSON.parse(JSON.stringify(cursor)), source: 'caller' }],
    cursor: { version: 1, scope, nextInboxIndex: '0' }, maxCoinIndices: 7 });
  assert.equal(f.observed.inspections[1].nextIndex, 19n);
  assert.equal(f.observed.inspections[1].maxIndices, 7);
  assert.equal(second.holdings[0].qualifiedCoin?.mt_index, 21n);
});

test('snapshot scope cannot be silently replaced while continuing', async t => {
  for (const [field, value] of Object.entries({ networkId: 'other-network', address: '33'.repeat(32), blockHash: '44'.repeat(32), blockHeight: '43' })) {
    await t.test(field, async () => {
      const f = fixture([a]);
      (f.snapshot.scope as any)[field] = value;
      await assert.rejects(f.scan({ cursor: { version: 1, scope, nextInboxIndex: '0' } }));
      assert.equal(f.observed.inspections.length, 0);
    });
  }
});

test('malformed budgets fail before opening a snapshot', async t => {
  for (const name of ['maxEntries', 'maxCandidates', 'maxCoinIndices'] as const) {
    for (const value of [0, -1, 4097, 1.5, NaN, '3']) await t.test(`${name}=${String(value)}`, async () => {
      const f = fixture();
      await assert.rejects(f.scan({ [name]: value as any }));
      assert.equal(f.observed.opens.length, 0);
    });
  }
});

test('forged coin-search cursors are rejected instead of skipping arbitrary positions', async t => {
  for (const modified of [
    { coinId: coinId(b) }, { nextIndex: '-1' }, { nextIndex: '1e3' }, { version: 2 },
    { scope: { ...scope, blockHash: '55'.repeat(32) } },
  ]) await t.test(JSON.stringify(modified), async () => {
    const f = fixture();
    await assert.rejects(f.scan({ candidates: [{ coin: a, searchCursor: {
      version: 1, scope, coinId: coinId(a), nextIndex: '0', ...modified,
    } as any }] }));
  });
});

test('malformed caller coin descriptions cannot become candidates', async t => {
  for (const value of [{ ...a, nonce: bytes(1).slice(1) }, { ...a, color: bytes(8).slice(1) },
    { ...a, value: -1n }, { ...a, value: 1n << 128n }]) await t.test(String(value.value), async () => {
    const f = fixture([]);
    await assert.rejects(f.scan({ candidates: [{ coin: value }] }));
    assert.equal(f.observed.inspections.length, 0);
  });
});

test('invalid positive observations remain unknown instead of changing coin identity or position', async t => {
  for (const result of [
    { status: 'live', coin: { ...b, mt_index: 1n } },
    { status: 'spent', coin: { ...a, mt_index: -1n } },
    { status: 'live', coin: { ...a, mt_index: 1n << 64n } },
    { status: 'live', coin: { ...a, mt_index: '1' } },
    { status: 'confirmed', coin: { ...a, mt_index: 1n } },
    { status: 'unknown', reason: '' },
  ]) await t.test(String(result.status), async () => {
    const f = fixture();
    f.snapshot.inspect = async () => result as any;
    const report = await f.scan();
    assert.equal(report.holdings[0].status, 'unknown');
    assert.equal(report.holdings[0].qualifiedCoin, undefined);
    assert.equal(report.coverage.complete, false);
    assert.deepEqual(report.verifiedSubtotal, []);
  });
});

test('an inspection continuation cannot move backwards or make no progress', async t => {
  for (const nextIndex of ['8', '9', '-1', '1e3']) await t.test(nextIndex, async () => {
    const f = fixture();
    f.snapshot.inspect = async () => ({ status: 'unknown', reason: 'search', nextIndex });
    const report = await f.scan({ candidates: [{ coin: a,
      searchCursor: { version: 1, scope, coinId: coinId(a), nextIndex: '9' } }] });
    assert.equal(report.holdings[0].status, 'unknown');
    assert.equal(report.holdings[0].reason, 'inspection-failed');
    assert.equal(report.holdings[0].searchCursor?.nextIndex, '9');
  });
});

test('snapshot changes during asynchronous reads or inspection abort the scan', async t => {
  for (const phase of ['read', 'inspect']) await t.test(phase, async () => {
    const f = fixture();
    if (phase === 'read') f.snapshot.readInbox = async () => {
      f.snapshot.scope.blockHash = '55'.repeat(32); return f.entries[0];
    };
    else f.snapshot.inspect = async () => {
      f.snapshot.inboxCount++; return { status: 'live', coin: { ...a, mt_index: 0n } };
    };
    await assert.rejects(f.scan(), /snapshot changed/);
  });
});

test('inbox transport failure retains the exact unread cursor', async () => {
  const f = fixture([a, b]);
  f.snapshot.readInbox = async index => {
    if (index === 1n) throw new Error('connection lost');
    return f.entries[0];
  };
  const report = await f.scan();
  assert.equal(report.cursor?.nextInboxIndex, '1');
  assert.equal(report.coverage.missingEntries, 1);
  assert.equal(report.coverage.complete, false);
  assert.equal(report.holdings[0].status, 'live');
});

test('caller candidates can be checked without a viewing key but cannot imply full recovery', async () => {
  const f = fixture([]);
  f.states.set(coinId(a), { status: 'live', coin: { ...a, mt_index: 3n } });
  const report = await f.scan({ viewingKeys: [], candidates: [{ coin: a }] });
  assert.equal(report.holdings[0].status, 'live');
  assert.equal(report.coverage.currentViewingKeyAvailable, false);
  assert.equal(report.coverage.complete, false);
  assert.equal(report.verifiedSubtotal[0].value, 100n);
});

test('scan copies caller coin descriptions and viewing keys before awaiting the adapter', async () => {
  const f = fixture([]), supplied = coin(9);
  f.states.set(coinId(supplied), { status: 'live', coin: { ...supplied, nonce: supplied.nonce.slice(), mt_index: 5n } });
  const open = f.adapter.openSnapshot;
  f.adapter.openSnapshot = async request => {
    supplied.nonce[0] = 255;
    f.options.viewingKeys[0].fill(0);
    return open(request);
  };
  const report = await f.scan({ candidates: [{ coin: supplied }] });
  assert.equal(report.holdings[0].coin.nonce[0], 9);
  assert.equal(report.holdings[0].status, 'live');
  assert.equal(report.coverage.currentViewingKeyAvailable, true);
});

test('event-window continuation permits a lower tree index only when its event offset advances', async () => {
  const f = fixture();
  f.states.set(coinId(a), { status: 'unknown', reason: 'event window exhausted', nextIndex: '0', nextEventOffset: 200 });
  const report = await f.scan({ candidates: [{ coin: a, searchCursor: {
    version: 1, scope, coinId: coinId(a), nextIndex: '999', eventOffset: 100,
  } }] });
  assert.equal(report.holdings[0].reason, 'event window exhausted');
  assert.equal(report.holdings[0].searchCursor?.nextIndex, '0');
  assert.equal(report.holdings[0].searchCursor?.eventOffset, 200);
  assert.equal(f.observed.inspections[0].nextIndex, 999n);
  assert.equal(f.observed.inspections[0].eventOffset, 100);
});

test('invalid event-window progress stays unknown with the original usable cursor', async t => {
  for (const [nextIndex, nextEventOffset] of [
    ['0', 99], ['0', 100], ['1000', 99], ['0', -1], ['0', 1.5], ['0', 1 << 31], ['0', '200'],
  ] as const) await t.test(`${nextIndex}/${nextEventOffset}`, async () => {
    const f = fixture();
    f.snapshot.inspect = async () => ({ status: 'unknown', reason: 'bad continuation', nextIndex, nextEventOffset } as any);
    const report = await f.scan({ candidates: [{ coin: a, searchCursor: {
      version: 1, scope, coinId: coinId(a), nextIndex: '999', eventOffset: 100,
    } }] });
    assert.equal(report.holdings[0].reason, 'inspection-failed');
    assert.equal(report.holdings[0].searchCursor?.nextIndex, '999');
    assert.equal(report.holdings[0].searchCursor?.eventOffset, 100);
  });
});

test('malformed event offsets are rejected before reading a snapshot', async t => {
  for (const eventOffset of [-1, 1.5, 2 ** 31, NaN, '100']) await t.test(String(eventOffset), async () => {
    const f = fixture();
    await assert.rejects(f.scan({ candidates: [{ coin: a, searchCursor: {
      version: 1, scope, coinId: coinId(a), nextIndex: '0', eventOffset,
    } as any }] }));
    assert.equal(f.observed.opens.length, 0);
  });
});

test('candidate overflow preserves both dimensions of its prior continuation', async () => {
  const f = fixture([a, b]);
  const report = await f.scan({ maxCandidates: 1, candidates: [{ coin: a }, { coin: b, searchCursor: {
    version: 1, scope, coinId: coinId(b), nextIndex: '9', eventOffset: 100,
  } }] });
  assert.equal(report.holdings[1].reason, 'candidate-budget');
  assert.equal(report.holdings[1].searchCursor?.nextIndex, '9');
  assert.equal(report.holdings[1].searchCursor?.eventOffset, 100);
});

test('an undefined inbox record is a retriable gap rather than an unreadable ciphertext', async () => {
  const f = fixture();
  f.snapshot.readInbox = async () => undefined as any;
  const report = await f.scan();
  assert.equal(report.cursor?.nextInboxIndex, '0');
  assert.equal(report.coverage.missingEntries, 1);
  assert.equal(report.coverage.unreadableEntries, 0);
});

test('transient unknown evidence preserves both dimensions of an existing candidate cursor', async () => {
  const f = fixture();
  f.states.set(coinId(a), { status: 'unknown', reason: 'temporary verifier outage' });
  const searchCursor = { version: 1 as const, scope, coinId: coinId(a), nextIndex: '91', eventOffset: 200 };
  const report = await f.scan({ candidates: [{ coin: a, searchCursor }] });
  assert.equal(report.holdings[0].reason, 'temporary verifier outage');
  assert.deepEqual(report.holdings[0].searchCursor, searchCursor);
});

test('event search can transition to a complete-tree search from index zero', async () => {
  const f = fixture();
  f.states.set(coinId(a), { status: 'unknown', reason: 'tree fallback', nextIndex: '0', nextEventOffset: 0, nextMode: 'tree' });
  const report = await f.scan({ candidates: [{ coin: a, searchCursor: {
    version: 1, scope, coinId: coinId(a), nextIndex: '999', eventOffset: 200, mode: 'events',
  } }] });
  assert.equal(report.holdings[0].reason, 'tree fallback');
  assert.equal(report.holdings[0].searchCursor?.mode, 'tree');
  assert.equal(report.holdings[0].searchCursor?.nextIndex, '0');
  assert.equal(report.holdings[0].searchCursor?.eventOffset, 0);
});

test('tree continuations reject backwards modes, indices, and event offsets', async t => {
  for (const [nextIndex, nextEventOffset, nextMode] of [
    ['0', 0, 'events'], ['8', 0, 'tree'], ['9', 0, 'tree'], ['10', 100, 'tree'], ['10', 0, 'invalid'],
  ] as const) await t.test(`${nextMode}/${nextIndex}/${nextEventOffset}`, async () => {
    const f = fixture();
    f.snapshot.inspect = async () => ({ status: 'unknown', reason: 'bad continuation', nextIndex, nextEventOffset, nextMode } as any);
    const searchCursor = { version: 1 as const, scope, coinId: coinId(a), nextIndex: '9', eventOffset: 0, mode: 'tree' as const };
    const report = await f.scan({ candidates: [{ coin: a, searchCursor }] });
    assert.equal(report.holdings[0].reason, 'inspection-failed');
    assert.deepEqual(report.holdings[0].searchCursor, searchCursor);
  });
});

test('tree mode and retry position survive a transient unknown response', async () => {
  const f = fixture();
  f.states.set(coinId(a), { status: 'unknown', reason: 'temporary verifier outage' });
  const searchCursor = { version: 1 as const, scope, coinId: coinId(a), nextIndex: '91', eventOffset: 0, mode: 'tree' as const };
  const report = await f.scan({ candidates: [{ coin: a, searchCursor }] });
  assert.deepEqual(report.holdings[0].searchCursor, searchCursor);
  assert.equal(f.observed.inspections[0].mode, 'tree');
  assert.equal(f.observed.inspections[0].nextIndex, 91n);
});

test('malformed search modes and nonzero tree event offsets reject before snapshot reads', async t => {
  for (const [mode, eventOffset] of [['invalid', 0], ['tree', 100], [1, 0]] as const) await t.test(`${mode}/${eventOffset}`, async () => {
    const f = fixture();
    await assert.rejects(f.scan({ candidates: [{ coin: a, searchCursor: {
      version: 1, scope, coinId: coinId(a), nextIndex: '0', eventOffset, mode,
    } as any }] }));
    assert.equal(f.observed.opens.length, 0);
  });
});

test('candidate overflow preserves the tree search mode', async () => {
  const f = fixture([a, b]);
  const searchCursor = { version: 1 as const, scope, coinId: coinId(b), nextIndex: '9', eventOffset: 0, mode: 'tree' as const };
  const report = await f.scan({ maxCandidates: 1, candidates: [{ coin: a }, { coin: b, searchCursor }] });
  assert.equal(report.holdings[1].reason, 'candidate-budget');
  assert.deepEqual(report.holdings[1].searchCursor, searchCursor);
});
