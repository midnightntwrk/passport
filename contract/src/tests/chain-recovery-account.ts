// Account-store integration with real inbox encryption and controlled chain
// observations. This fixture never supplies node or cryptographic proof evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CustodyAccount } from '../wallet/account.js';
import type { ChainCoinInspection, ChainRecoveryAdapter } from '../wallet/chain-recovery.js';
import { journalCoin, type ChangeJournal, type ChangeJournalEntry } from '../wallet/change-journal.js';
import { generateEncKeyPair, sealInboxEntry } from '../wallet/inbox.js';
import { coinId, emptyCoinStore, withCoin, withoutCoin } from '../wallet/witnesses.js';

const bytes = (n: number) => new Uint8Array(32).fill(n);
const colour = bytes(5), address = 'a1'.repeat(32), networkId = 'account-fixture';
const a = { nonce: bytes(1), color: colour, value: 100n, mt_index: 3n };
const b = { nonce: bytes(2), color: colour, value: 70n, mt_index: 4n };
const c = { nonce: bytes(3), color: colour, value: 10n, mt_index: 5n };
const copy = <T>(value: T): T => structuredClone(value);

function fixture() {
  const keys = generateEncKeyPair();
  let state = emptyCoinStore(keys.secretKey);
  let journal: ChangeJournal | undefined;
  let writes = 0, journalWrites = 0, transactionCalls = 0;
  const entries = [a, b, c].map(coin => sealInboxEntry(keys.publicKey, coin));
  const observations = new Map<string, ChainCoinInspection>([
    [coinId(a), { status: 'spent', coin: a }],
    [coinId(b), { status: 'live', coin: b }],
    [coinId(c), { status: 'unknown', reason: 'fixture unavailable' }],
  ]);
  const provider = { get: async () => copy(state), set: async (_id: string, value: typeof state) => { writes++; state = copy(value); } };
  const forbidden = async (): Promise<never> => { transactionCalls++; throw new Error('recovery must not transact'); };
  const account = () => Reflect.construct(CustodyAccount, [address, bytes(0xa1),
    { privateStateProvider: provider }, 'chain-account', { callTx: new Proxy({}, { get: () => forbidden }) },
    undefined, { networkId, journalStore: {
      get: async () => copy(journal),
      set: async (_scope: string, value: ChangeJournal) => { journalWrites++; journal = copy(value); },
    }, adapter: { prepare: forbidden, observe: forbidden, qualify: forbidden } },
  ]) as CustodyAccount;
  const snapshot = {
    scope: { networkId, address, blockHash: 'b2'.repeat(32), blockHeight: '42' },
    encKey: keys.publicKey, inboxCount: BigInt(entries.length),
    readInbox: async (index: bigint) => entries[Number(index)] ?? null,
    inspect: async (coin: typeof a) => observations.get(coinId(coin)) ?? { status: 'unknown' as const, reason: 'not indexed' },
  };
  const adapter: ChainRecoveryAdapter = { openSnapshot: async () => snapshot };
  return { keys, adapter, snapshot, observations, account, state: () => copy(state),
    setState: (value: typeof state) => { state = copy(value); },
    setJournal: (entries: ChangeJournalEntry[]) => { journal = { version: 1, scope: JSON.stringify([networkId, address, 'chain-account']), entries }; },
    journal: () => copy(journal), counts: () => ({ writes, journalWrites, transactionCalls }) };
}

test('account recovery is read-only by default and needs no signing or transaction adapter', async () => {
  const f = fixture(), before = f.state();
  const report = await f.account().recoverHoldings(f.adapter, { networkId });
  assert.deepEqual(f.state(), before);
  assert.deepEqual(report.holdings.map(x => x.status), ['spent', 'live', 'unknown']);
  assert.deepEqual(report.verifiedSubtotal.map(x => x.value), [70n]);
  assert.equal(report.application, undefined);
  assert.deepEqual(f.counts(), { writes: 0, journalWrites: 0, transactionCalls: 0 });
});

test('apply imports verified live siblings, tombstones spent coins absent locally, and retains unknown inventory', async () => {
  const f = fixture();
  f.setState(withCoin(f.state(), { ...c, mtIndex: c.mt_index }));
  const report = await f.account().recoverHoldings(f.adapter, { networkId, apply: true });
  assert.deepEqual(Object.keys(f.state().coins).sort(), [coinId(b), coinId(c)].sort());
  assert.equal(f.state().spentCoins?.[coinId(a)], true);
  assert.deepEqual(report.verifiedSubtotal.map(x => x.value), [70n], 'retained unknown inventory is not verified live');
  assert.deepEqual(report.application, { importedLive: 1, recordedSpent: 1, localSpentConflicts: [] });
  assert.equal(f.counts().transactionCalls, 0);
});

test('a stale live observation never resurrects a local spent tombstone', async () => {
  const f = fixture();
  f.setState(withoutCoin(withCoin(f.state(), { ...b, mtIndex: b.mt_index }), b));
  const report = await f.account().recoverHoldings(f.adapter, { networkId, apply: true });
  assert.equal(f.state().coins[coinId(b)], undefined);
  assert.equal(f.state().spentCoins?.[coinId(b)], true);
  assert.deepEqual(report.application?.localSpentConflicts, [coinId(b)]);
  assert.deepEqual(report.verifiedSubtotal, []);
  assert.equal(report.coverage.complete, false);
  assert.equal(report.holdings.find(x => x.id === coinId(b))?.status, 'live', 'as-of observation remains auditable');
});

test('restart and repeated application preserve exact state without duplication', async () => {
  const f = fixture();
  await f.account().recoverHoldings(f.adapter, { networkId, apply: true });
  const after = f.state();
  await f.account().recoverHoldings(f.adapter, { networkId, apply: true });
  assert.deepEqual(f.state(), after);
  assert.equal(f.counts().transactionCalls, 0);
});

test('application merges provider updates made during inspection instead of restoring a stale snapshot', async () => {
  const f = fixture(), added = { nonce: bytes(9), color: colour, value: 9n, mtIndex: 9n };
  const inspect = f.snapshot.inspect;
  f.snapshot.inspect = async coin => {
    f.setState(withCoin(f.state(), added));
    return inspect(coin);
  };
  await f.account().recoverHoldings(f.adapter, { networkId, apply: true });
  assert.ok(f.state().coins[coinId(added)]);
  assert.ok(f.state().coins[coinId(b)]);
});

test('shared-provider recovery refuses overlapping account mutation and releases its guard after failure', async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.adapter.openSnapshot = async () => { entered(); await gate; throw new Error('fixture snapshot failed'); };
  const recovery = f.account().recoverHoldings(f.adapter, { networkId, apply: true });
  await started;
  await assert.rejects(() => f.account().putCoin({ ...b, mtIndex: b.mt_index }), /in progress|concurrent|busy/i);
  release();
  await assert.rejects(recovery, /fixture snapshot failed/);
  await f.account().putCoin({ ...b, mtIndex: b.mt_index });
  assert.ok(f.state().coins[coinId(b)]);
});

for (const stage of ['submitting', 'partial'] as const) test(`holdings evidence cannot resolve a ${stage} intended payment`, async () => {
  const f = fixture();
  f.setJournal([{ id: 'uncertain-payment', circuitId: 'withdraw_shielded_with_jubjub', input: journalCoin(a),
    recipientHex: '99'.repeat(32), amount: '30', stage, transactionIds: ['transaction-fixture'],
    change: journalCoin(b), adopted: false, recovery: { mode: 'owner', status: 'pending' } }]);
  const before = f.journal();
  const account = f.account();
  const report = await account.recoverHoldings(f.adapter, { networkId, apply: true });
  assert.ok(report.holdings.find(x => x.id === coinId(a))?.sources.includes('journal'));
  assert.ok(report.holdings.find(x => x.id === coinId(b))?.sources.includes('journal'));
  assert.deepEqual(f.journal(), before, 'spent input plus live change is not proof of intended recipient payment');
  assert.equal((await account.changeJournal())[0].stage, stage);
  assert.deepEqual(f.counts(), { writes: 1, journalWrites: 0, transactionCalls: 0 });
});

test('recovery then completed-journal replay cannot resurrect externally spent change', async () => {
  const f = fixture();
  f.observations.set(coinId(b), { status: 'spent', coin: b });
  f.setJournal([{ id: 'completed-payment', circuitId: 'withdraw_shielded_with_jubjub', input: journalCoin(a),
    recipientHex: '99'.repeat(32), amount: '30', stage: 'complete', transactionIds: ['transaction-fixture'],
    change: journalCoin(b), qualifiedChange: journalCoin(b), adopted: true,
    recovery: { mode: 'owner', status: 'complete' } }]);
  const account = f.account();
  await account.recoverHoldings(f.adapter, { networkId, apply: true });
  await account.reconcileChanges();
  assert.equal(f.state().coins[coinId(b)], undefined);
  assert.equal(f.state().spentCoins?.[coinId(b)], true);
  assert.equal(f.counts().transactionCalls, 0);
});
