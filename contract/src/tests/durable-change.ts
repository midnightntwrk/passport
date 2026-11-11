// Durable recovery fault injection. These fixtures model authoritative chain
// observations and persistence failures, not proofs or node acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DurableChangeCoordinator,
  type ChangeCoordinatorHooks, type ChangeIntent, type ChangeJournal,
  type ChangeJournalStore, type PreparedChangeTransaction,
  type TransactionObservation,
} from '../wallet/change-journal.js';
import type { QualifiedCoin, ShieldedCoin } from '../wallet/contract.js';
import { bytesToHex } from '../wallet/hex.js';
import { generateEncKeyPair, openInboxEntry, sealInboxEntry } from '../wallet/inbox.js';
import {
  coinId, coinsForColour, emptyCoinStore, withCoin, withoutCoin,
  type CoinStorePrivateState,
} from '../wallet/witnesses.js';

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (n: number) => bytesToHex(bytes(n));
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const colour = bytes(4), recipient = bytes(8);
const input: QualifiedCoin = { nonce: bytes(1), color: colour, value: 100n, mt_index: 3n };
const sibling: QualifiedCoin = { nonce: bytes(2), color: colour, value: 100n, mt_index: 4n };
const change: ShieldedCoin = { nonce: bytes(3), color: colour, value: 70n };
const qualifiedChange: QualifiedCoin = { ...change, mt_index: 17n };
const spendIds = [hex(21), hex(22)], backfillIds = [hex(31), hex(32)];
const scope = `${hex(7)}:durable-test`;
const interrupted = () => new Error('simulated process interruption');
const ids = (state: CoinStorePrivateState) => coinsForColour(state, colour).map(coinId).sort();
const ignoreFailure = async (action: () => Promise<unknown>) => {
  try { await action(); } catch { /* Restart must use only persisted evidence. */ }
};

class FaultStore implements ChangeJournalStore {
  snapshot: ChangeJournal | undefined;
  writes: ChangeJournal[] = [];
  fault?: { write: number; phase: 'before' | 'after' };
  async get(_scope: string) { return this.snapshot ? jsonCopy(this.snapshot) : undefined; }
  async set(_scope: string, value: ChangeJournal) {
    const index = this.writes.length + 1;
    this.writes.push(jsonCopy(value));
    const fault = this.fault?.write === index ? this.fault : undefined;
    if (fault) this.fault = undefined;
    if (fault?.phase === 'before') throw interrupted();
    this.snapshot = jsonCopy(value);
    if (fault?.phase === 'after') throw interrupted();
  }
}

function fixture(options: { mode?: 'owner' | 'grant'; exact?: boolean } = {}) {
  const mode = options.mode ?? 'owner', expectedChange = options.exact ? null : change;
  const keyPair = generateEncKeyPair();
  const grantEntry = sealInboxEntry(keyPair.publicKey, change);
  const store = new FaultStore();
  let state = withCoin(withCoin(emptyCoinStore(keyPair.secretKey),
    { ...input, mtIndex: input.mt_index }), { ...sibling, mtIndex: sibling.mt_index });
  const inbox: Uint8Array[] = [];
  const observations = {
    prepare: 0, submit: 0, qualify: 0, adopt: 0, seal: 0, backfillPrepare: 0, backfillSubmit: 0,
    spendStatus: 'unknown' as TransactionObservation['status'],
    nextSpendStatus: 'succeeded' as TransactionObservation['status'],
    backfillStatus: 'unknown' as TransactionObservation['status'],
    nextBackfillStatus: 'succeeded' as TransactionObservation['status'],
    wrongObservationIds: false, wrongQualifiedCoin: false, viewingKeyAvailable: true,
    submitResponseLost: false, backfillResponseLost: false,
    adoptionFailure: undefined as undefined | 'before' | 'after',
    onPrepare: undefined as undefined | (() => Promise<void>),
    onSubmit: undefined as undefined | (() => void),
    onBackfillSubmit: undefined as undefined | (() => void),
  };
  const hooks: ChangeCoordinatorHooks = {
    observe: async transactionIds => ({
      status: transactionIds.some(id => spendIds.includes(id))
        ? observations.spendStatus : observations.backfillStatus,
      transactionIds: observations.wrongObservationIds ? [hex(99)] : [...transactionIds],
    }),
    qualify: async (coin, transactionIds) => {
      observations.qualify++;
      assert.deepEqual(transactionIds, spendIds);
      assert.equal(coinId(coin), coinId(change));
      return structuredClone(observations.wrongQualifiedCoin
        ? { ...qualifiedChange, nonce: bytes(99) } : qualifiedChange);
    },
    adopt: async (selected, qualified) => {
      observations.adopt++;
      assert.deepEqual(selected, input, 'adoption retains the exact qualified input');
      const failure = observations.adoptionFailure;
      observations.adoptionFailure = undefined;
      if (failure === 'before') throw interrupted();
      let next = withoutCoin(jsonCopy(state), selected);
      if (qualified) next = withCoin(next, { ...qualified, mtIndex: qualified.mt_index });
      state = jsonCopy(next);
      if (failure === 'after') throw interrupted();
    },
    seal: async coin => {
      observations.seal++;
      assert.equal(coinId(coin), coinId(change));
      return sealInboxEntry(keyPair.publicKey, coin);
    },
    findInboxEntry: async entry => inbox.some(candidate => bytesToHex(candidate) === bytesToHex(entry)),
    verifyInboxEntry: async (entry, coin) => {
      if (!observations.viewingKeyAvailable) return false;
      const opened = openInboxEntry(keyPair.secretKey, entry);
      if (!opened || coinId(opened) !== coinId(coin)) throw new Error('inbox plaintext does not match actual change');
      return true;
    },
  };
  const intent: ChangeIntent = {
    circuitId: mode === 'owner' ? 'withdraw_shielded_with_jubjub' : 'withdraw_shielded_with_grant_jubjub',
    input: structuredClone(input), recipient: structuredClone(recipient),
    amount: options.exact ? input.value : 30n,
    recovery: mode === 'owner' ? { mode } : { mode, entry: grantEntry },
  };
  const prepare = async (): Promise<PreparedChangeTransaction> => {
    observations.prepare++;
    await observations.onPrepare?.();
    return {
      transactionIds: [...spendIds], change: expectedChange && structuredClone(expectedChange),
      result: { public: { txId: spendIds[0] }, private: { result: expectedChange } },
      submit: async () => {
        observations.submit++;
        const checkpoint = store.snapshot?.entries.at(-1);
        assert.equal(checkpoint?.stage, 'submitting', 'submission marker must already be durable');
        assert.deepEqual(checkpoint?.transactionIds, spendIds, 'all final identities precede network submission');
        assert.equal(checkpoint?.input.nonceHex, hex(1));
        assert.equal(checkpoint?.input.mtIndex, '3');
        assert.equal(checkpoint?.change?.value ?? null, expectedChange?.value.toString() ?? null);
        observations.onSubmit?.();
        observations.spendStatus = observations.nextSpendStatus;
        if (mode === 'grant' && expectedChange && observations.spendStatus === 'succeeded') {
          inbox.push(structuredClone(grantEntry));
        }
        if (observations.submitResponseLost) throw new Error('submission response lost');
      },
    };
  };
  const backfill = async (entry: Uint8Array): Promise<PreparedChangeTransaction> => {
    observations.backfillPrepare++;
    const retained = structuredClone(entry);
    return {
      transactionIds: [...backfillIds], change: null, result: {},
      submit: async () => {
        observations.backfillSubmit++;
        const checkpoint = store.snapshot?.entries.at(-1)?.recovery;
        assert.equal(checkpoint?.backfill?.stage, 'submitting');
        assert.deepEqual(checkpoint?.backfill?.transactionIds, backfillIds);
        assert.equal(checkpoint?.entryHex, bytesToHex(retained), 'exact ciphertext is durable before append');
        observations.backfillStatus = observations.nextBackfillStatus;
        if (observations.backfillStatus === 'succeeded') inbox.push(retained);
        observations.onBackfillSubmit?.();
        if (observations.backfillResponseLost) throw new Error('backfill response lost');
      },
    };
  };
  const client = () => new DurableChangeCoordinator(scope, store, hooks);
  return { store, observations, hooks, intent, prepare, backfill, client, inbox,
    state: () => jsonCopy(state),
    deposit: () => { state = withCoin(state, { nonce: bytes(5), color: colour, value: 11n, mtIndex: 19n }); },
    run: () => client().execute(intent, prepare, backfill),
  };
}

test('owner partial spend captures exact change, survives JSON restart, and backfills once', async () => {
  const f = fixture();
  const originalSibling = f.state().coins[coinId(sibling)];
  const result = await f.run();
  assert.equal(result.entry.stage, 'complete');
  assert.equal(result.entry.recovery.status, 'complete');
  assert.equal(result.entry.adopted, true);
  assert.deepEqual(ids(f.state()), [coinId(sibling), coinId(change)].sort());
  assert.deepEqual(f.state().coins[coinId(sibling)], originalSibling);
  assert.equal(f.state().spentCoins?.[coinId(input)], true);
  assert.equal(f.state().coins[coinId(change)].mtIndex, '17');
  const before = f.state();
  await f.client().reconcile(f.backfill);
  await f.client().reconcile(f.backfill);
  assert.deepEqual(f.state(), before);
  assert.equal(f.observations.submit, 1);
  assert.equal(f.observations.backfillSubmit, 1);
  assert.equal(f.inbox.length, 1);
  assert.equal(coinId(openInboxEntry(Buffer.from(before.encSecretKeyHex!, 'hex'), f.inbox[0])!), coinId(change));
});

test('an exact spend retires only its input and never seals, qualifies, or appends change', async () => {
  const f = fixture({ exact: true });
  const result = await f.run();
  assert.equal(result.entry.stage, 'complete');
  assert.deepEqual(ids(f.state()), [coinId(sibling)]);
  assert.equal(f.observations.qualify, 0);
  assert.equal(f.observations.seal, 0);
  assert.equal(f.observations.backfillSubmit, 0);
});

for (const status of ['partial', 'rejected', 'unknown'] as const) {
  test(`${status} spend evidence never creates speculative change or loses a sibling`, async () => {
    const f = fixture(); f.observations.nextSpendStatus = status;
    const before = f.state();
    await ignoreFailure(f.run);
    await ignoreFailure(() => f.client().reconcile(f.backfill));
    assert.deepEqual(f.state(), before);
    assert.equal(f.observations.adopt, 0);
    assert.equal(f.observations.qualify, 0);
    assert.equal(f.observations.backfillSubmit, 0);
    assert.equal(f.observations.submit, 1);
    if (status !== 'rejected') await assert.rejects(() => f.client().assertAvailable());
  });
}

test('lost spend response is reconciled by retained transaction identity without resubmission', async () => {
  const f = fixture(); f.observations.submitResponseLost = true;
  await ignoreFailure(f.run);
  await f.client().reconcile(f.backfill);
  assert.equal((await f.client().list())[0].stage, 'complete');
  assert.deepEqual(ids(f.state()), [coinId(sibling), coinId(change)].sort());
  assert.equal(f.observations.submit, 1);
  assert.equal(f.observations.backfillSubmit, 1);
});

test('a delayed unknown outcome stays quarantined until exact successful evidence arrives', async () => {
  const f = fixture(); f.observations.nextSpendStatus = 'unknown';
  await ignoreFailure(f.run);
  for (let i = 0; i < 3; i++) await ignoreFailure(() => f.client().reconcile(f.backfill));
  assert.equal(f.observations.submit, 1);
  assert.equal(f.observations.adopt, 0);
  await assert.rejects(() => f.client().assertAvailable());
  f.observations.spendStatus = 'succeeded';
  await f.client().reconcile(f.backfill);
  assert.equal((await f.client().list())[0].stage, 'complete');
  assert.equal(f.observations.submit, 1);
});

for (const failure of ['before', 'after'] as const) {
  test(`private-state adoption failure ${failure} commit recovers by idempotent merge`, async () => {
    const f = fixture(); f.observations.adoptionFailure = failure;
    await ignoreFailure(f.run);
    f.deposit();
    await f.client().reconcile(f.backfill);
    assert.equal((await f.client().list())[0].stage, 'complete');
    assert.deepEqual(ids(f.state()), [coinId(sibling), coinId(change),
      coinId({ nonce: bytes(5), color: colour, value: 11n })].sort());
    assert.equal(f.observations.submit, 1);
    assert.equal(f.observations.backfillSubmit, 1);
  });
}

test('lost owner append acknowledgement finds the exact existing entry without duplicate append', async () => {
  const f = fixture(); f.observations.backfillResponseLost = true;
  await ignoreFailure(f.run);
  await f.client().reconcile(f.backfill);
  await f.client().reconcile(f.backfill);
  assert.equal((await f.client().list())[0].stage, 'complete');
  assert.equal(f.observations.backfillSubmit, 1);
  assert.equal(f.inbox.length, 1);
});

test('an unknown owner append outcome is never rebuilt or blindly retried', async () => {
  const f = fixture(); f.observations.nextBackfillStatus = 'unknown';
  await ignoreFailure(f.run);
  for (let i = 0; i < 3; i++) await ignoreFailure(() => f.client().reconcile(f.backfill));
  assert.equal(f.observations.backfillPrepare, 1);
  assert.equal(f.observations.backfillSubmit, 1);
  assert.equal(f.inbox.length, 0);
  assert.notEqual((await f.client().list())[0].stage, 'complete');
});

for (const viewingKeyAvailable of [true, false]) {
  test(`grant atomic entry is never duplicated (${viewingKeyAvailable ? 'verified' : 'unavailable'} viewing key)`, async () => {
    const f = fixture({ mode: 'grant' }); f.observations.viewingKeyAvailable = viewingKeyAvailable;
    await ignoreFailure(f.run);
    await f.client().reconcile(f.backfill);
    await f.client().reconcile(f.backfill);
    assert.equal(f.observations.backfillPrepare, 0);
    assert.equal(f.observations.backfillSubmit, 0);
    assert.equal(f.observations.seal, 0);
    assert.equal(f.inbox.length, 1);
    const retained = (await f.client().list())[0];
    assert.equal(retained.recovery.status, viewingKeyAvailable ? 'complete' : 'unverified');
    assert.equal(retained.stage, 'complete');
    assert.equal(retained.recovery.recorded, true);
    await f.client().assertAvailable();
  });
}

test('recovery verification lost during append cannot reuse a stale verified result', async () => {
  const f = fixture();
  f.observations.onBackfillSubmit = () => { f.observations.viewingKeyAvailable = false; };
  await f.run();
  const retained = (await f.client().list())[0];
  assert.equal(retained.recovery.recorded, true);
  assert.equal(retained.recovery.status, 'unverified');
  assert.equal(retained.stage, 'succeeded');
  assert.equal(f.observations.backfillSubmit, 1);
  f.observations.viewingKeyAvailable = true;
  await f.client().reconcile(f.backfill);
  assert.equal((await f.client().list())[0].stage, 'complete');
  assert.equal(f.observations.backfillSubmit, 1);
});

test('successful evidence for another transaction cannot authorise local adoption', async () => {
  const f = fixture(); f.observations.wrongObservationIds = true;
  await ignoreFailure(f.run);
  await ignoreFailure(() => f.client().reconcile(f.backfill));
  assert.equal(f.observations.submit, 1, 'the negative control reaches authoritative observation');
  assert.equal(f.observations.adopt, 0);
  assert.equal(f.observations.qualify, 0);
  assert.deepEqual(ids(f.state()), [coinId(input), coinId(sibling)].sort());
});

test('qualification for a different coin cannot authorise adoption or recovery completion', async () => {
  const f = fixture(); f.observations.wrongQualifiedCoin = true;
  await ignoreFailure(f.run);
  await ignoreFailure(() => f.client().reconcile(f.backfill));
  assert.equal(f.observations.submit, 1);
  assert.ok(f.observations.qualify >= 1, 'the negative control reaches qualification');
  assert.equal(f.observations.adopt, 0);
  assert.equal(f.observations.backfillSubmit, 0);
  assert.deepEqual(ids(f.state()), [coinId(input), coinId(sibling)].sort());
});

test('an available viewing key refuses a poisoned grant entry before submission', async () => {
  const f = fixture({ mode: 'grant' });
  assert.equal(f.intent.recovery.mode, 'grant');
  if (f.intent.recovery.mode === 'grant') f.intent.recovery.entry.fill(0);
  await assert.rejects(f.run, /plaintext.*change/);
  assert.equal(f.observations.prepare, 1);
  assert.equal(f.observations.submit, 0);
  assert.equal(f.observations.adopt, 0);
  assert.equal((await f.client().list())[0].stage, 'cancelled');
});

test('preparation failure cancels an intent without sending or consuming an input', async () => {
  const f = fixture(); f.observations.onPrepare = async () => { throw new Error('proof refused'); };
  await assert.rejects(f.run, /proof refused/);
  assert.equal(f.observations.submit, 0);
  assert.deepEqual(ids(f.state()), [coinId(input), coinId(sibling)].sort());
  assert.equal((await f.client().list())[0].stage, 'cancelled');
  await f.client().assertAvailable();
});

test('caller and inspection mutations cannot rewrite the retained input or transaction identity', async () => {
  const f = fixture();
  f.observations.onPrepare = async () => { f.intent.input.nonce.fill(99); f.intent.input.mt_index = 99n; };
  await f.run();
  const view = await f.client().list();
  view[0].input.nonceHex = hex(99); view[0].transactionIds.length = 0;
  assert.equal((await f.client().list())[0].input.nonceHex, hex(1));
  assert.equal((await f.client().list())[0].input.mtIndex, '3');
  assert.deepEqual((await f.client().list())[0].transactionIds, spendIds);
});

test('malformed persisted journals fail closed before exposing availability', async t => {
  const baseline = fixture(); await baseline.run();
  const corruptions: Array<[string, (journal: ChangeJournal) => void]> = [
    ['version', journal => { (journal as any).version = 2; }],
    ['scope', journal => { journal.scope = 'another account'; }],
    ['negative value', journal => { journal.entries[0].input.value = '-1'; }],
    ['non-canonical value', journal => { journal.entries[0].input.value = '0100'; }],
    ['missing qualification', journal => { delete journal.entries[0].input.mtIndex; }],
    ['out-of-range index', journal => { journal.entries[0].input.mtIndex = (1n << 64n).toString(); }],
    ['duplicate identity', journal => { journal.entries.push(jsonCopy(journal.entries[0])); }],
    ['missing transaction identity', journal => { journal.entries[0].transactionIds = []; }],
  ];
  for (const [name, mutate] of corruptions) await t.test(name, async () => {
    const f = fixture(); f.store.snapshot = jsonCopy(baseline.store.snapshot!);
    mutate(f.store.snapshot);
    await assert.rejects(() => f.client().assertAvailable(), /invalid|incomplete/);
    assert.equal(f.observations.submit, 0);
    assert.equal(f.observations.adopt, 0);
  });
});

test('overlapping coordinators sharing one store refuse a second spend before preparation', async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.observations.onPrepare = async () => { entered(); await gate; };
  const pending = f.run();
  await Promise.race([ready, pending]);
  try {
    await assert.rejects(() => f.client().execute(f.intent, f.prepare, f.backfill));
    assert.equal(f.observations.prepare, 1);
    assert.equal(f.observations.submit, 0);
  } finally { release(); }
  await pending;
  assert.equal(f.observations.submit, 1);
});

test('every durable journal write tolerates interruption before or after persistence', async t => {
  const complete = fixture(); await complete.run();
  assert.ok(complete.store.writes.length >= 5, 'fixture must exercise separate durable boundaries');
  for (let write = 1; write <= complete.store.writes.length; write++) {
    for (const phase of ['before', 'after'] as const) await t.test(`${phase} write ${write}`, async () => {
      const f = fixture(); f.store.fault = { write, phase };
      await ignoreFailure(f.run);
      assert.ok(f.store.writes.length >= write, 'the requested persistence boundary was reached');
      await ignoreFailure(() => f.client().reconcile(f.backfill));
      await ignoreFailure(() => f.client().reconcile(f.backfill));
      assert.ok(f.observations.submit <= 1, 'restart never resubmits a spend');
      assert.ok(f.observations.backfillSubmit <= 1, 'restart never duplicates an append');
      assert.deepEqual(f.state().coins[coinId(sibling)], complete.state().coins[coinId(sibling)]);
      if (f.observations.submit === 1) {
        const retained = (await f.client().list())[0];
        if (retained.recovery.backfill?.stage === 'submitting' && f.observations.backfillSubmit === 0) {
          // A committed send marker followed by a crash before the actual send
          // is indistinguishable from response loss. Absence is not rejection.
          assert.equal(retained.stage, 'succeeded');
          await assert.rejects(() => f.client().assertAvailable());
        } else assert.equal(retained.stage, 'complete');
        assert.deepEqual(ids(f.state()), [coinId(sibling), coinId(change)].sort());
      } else {
        assert.equal(f.observations.adopt, 0);
        assert.equal(f.observations.backfillSubmit, 0);
        assert.deepEqual(ids(f.state()), [coinId(input), coinId(sibling)].sort());
      }
    });
  }
});
