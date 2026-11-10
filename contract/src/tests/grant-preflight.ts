// Pre-sign client policy: real challenge/signature adapters with controlled
// ledger/clock/transport fixtures, plus an actual generated-runtime journey.
// This suite does not establish browser, proof, or node admission behaviour.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CustodyAccount, GrantPreflightError, type GrantPreflightOptions } from '../wallet/account.js';
import { checkGrantExpiry } from '../wallet/grant-preflight.js';
import { JubjubDevice, JubjubGrantee, K256Grantee, spendScope, readOnlyScope, openingOf,
  type AnyGrantee } from '../wallet/signer.js';
import { bytesToHex } from '../wallet/hex.js';
import { softwarePasskey } from './p256-fixtures.js';
import { AccountSim } from './sim.js';

const b = (n: number) => new Uint8Array(32).fill(n);
const MAX = (1n << 64n) - 1n;
const arms = ['jubjub', 'k256', 'p256'] as const;
const twins = ['unshielded', 'shielded', 'contract'] as const;
type Twin = typeof twins[number];

function expectCode(code: string) {
  return (error: unknown) => error instanceof GrantPreflightError && error.code === code;
}

function fixture(arm: typeof arms[number] = 'jubjub') {
  const grantee: AnyGrantee = arm === 'jubjub' ? new JubjubGrantee(21n)
    : arm === 'k256' ? new K256Grantee(22n) : softwarePasskey().grantee;
  const state = {
    present: true, now: 1000n, head: 1000n, headReads: 0, ledgerReads: 0,
    signs: 0, submissions: 0, onSign: undefined as undefined | (() => void),
    onCoin: undefined as undefined | (() => void), failSubmission: false,
    epoch: 2n, generation: 3n, encKey: b(8),
    record: { active: true, epoch: 2n, gen: 3n, issued_at: 4n, nonce: 5n, scope: { expires_at: 2000n } },
  };
  const coin = { nonce: b(4), color: b(5), value: 10n, mt_index: 1n };
  const callTx = new Proxy({}, { get: (_, name: string) => async () => {
    state.submissions++;
    if (state.failSubmission) throw new Error('SubmissionError: Invalid Transaction');
    return { public: { txId: name }, private: { result: name.includes('_to_contract_')
      ? [coin, { is_some: false, value: coin }] : { is_some: false, value: coin } } };
  } });
  const account = Reflect.construct(CustodyAccount, [bytesToHex(b(7)), b(7), {}, 'test', { callTx }]) as CustodyAccount;
  account.ledgerState = async () => {
    state.ledgerReads++;
    const record = { ...state.record, scope: { ...state.record.scope } };
    return { spec_version: 3n, auth_nonce: 0n, device_epoch: state.epoch,
      grant_generation: state.generation, enc_key: new Uint8Array(state.encKey),
      grants: { member: () => state.present, lookup: () => record } } as any;
  };
  account.heldCoin = async () => { state.onCoin?.(); return coin; };
  const sign = grantee.sign.bind(grantee);
  (grantee as any).sign = (challenge: any) => { state.signs++; const result = sign(challenge); state.onSign?.(); return result; };
  const scope = spendScope({ withdrawUnshielded: true, color: b(5), cap: 20n, expiresAt: 2000n });
  const opening = openingOf(scope, b(9), b(10), 0n);
  const options: GrantPreflightOptions = {
    nowSeconds: () => state.now,
    readNodeHeadTimeSeconds: async () => { state.headReads++; return state.head; },
    admissionMarginSeconds: 10n, proveAndBalanceSeconds: 15n,
  };
  const invoke = (twin: Twin, timing: GrantPreflightOptions | undefined = options) => {
    if (twin === 'unshielded') return account.withdrawUnshieldedWithGrant(grantee, opening, b(5), 1n, b(6), timing);
    if (twin === 'shielded') return account.withdrawShieldedWithGrant(grantee, opening, b(6), b(5), 1n, new Uint8Array(192), undefined, timing);
    return account.withdrawShieldedToContractWithGrant(grantee, opening, b(6), b(5), 1n, new Uint8Array(192), undefined, timing);
  };
  return { account, grantee, opening, state, options, invoke };
}

for (const arm of arms) for (const twin of twins) {
  test(`${arm} ${twin}: unusable grants never request a signature or submit`, async () => {
    const faults: [string, (f: ReturnType<typeof fixture>) => void][] = [
      ['missing', f => { f.state.present = false; }],
      ['inactive', f => { f.state.record.active = false; }],
      ['stale_epoch', f => { f.state.record.epoch--; }],
      ['stale_generation', f => { f.state.record.gen--; }],
      ['expired', f => { f.state.now = 2000n; }],
      ['expired', f => { f.state.head = 2000n; }],
      ['insufficient_horizon', f => { f.state.head = 1975n; }],
      ['insufficient_horizon', f => { f.state.now = 1975n; }],
    ];
    for (const [code, fault] of faults) {
      const f = fixture(arm); fault(f);
      await assert.rejects(() => f.invoke(twin), expectCode(code));
      assert.equal(f.state.signs, 0, code);
      assert.equal(f.state.submissions, 0, code);
    }
  });
  test(`${arm} ${twin}: valid finite grants sign and dispatch once`, async () => {
    const f = fixture(arm);
    await f.invoke(twin);
    assert.equal(f.state.signs, 1); assert.equal(f.state.submissions, 1);
    assert.equal(f.state.ledgerReads, 2); assert.equal(f.state.headReads, 2);
  });
}

test('explicit never-expiring grants still check liveness, but never read clocks', async () => {
  for (const twin of twins) {
    const f = fixture(); f.state.record.scope.expires_at = 0n;
    f.options.nowSeconds = () => { throw Error('unexpected wall clock read'); };
    f.options.readNodeHeadTimeSeconds = async () => { throw Error('unexpected head read'); };
    await f.invoke(twin);
    assert.equal(f.state.signs, 1); assert.equal(f.state.submissions, 1);
    f.state.record.active = false;
    await assert.rejects(() => f.invoke(twin), expectCode('inactive'));
    assert.equal(f.state.signs, 1);
  }
});

test('finite expiry requires explicit timing and rejects invalid units or bounds', async () => {
  const f = fixture();
  await assert.rejects(() => f.account.withdrawUnshieldedWithGrant(f.grantee, f.opening, b(5), 1n, b(6)), expectCode('timing_required'));
  for (const invalid of [undefined, -1n, MAX + 1n, 2000, NaN, '2000']) {
    await assert.rejects(() => checkGrantExpiry(invalid as any, f.options), expectCode('invalid_time'));
  }
  for (const field of ['admissionMarginSeconds', 'proveAndBalanceSeconds'] as const) {
    for (const invalid of [undefined, -1n, MAX + 1n, 15]) {
      await assert.rejects(() => checkGrantExpiry(2000n, { ...f.options, [field]: invalid } as any), expectCode('invalid_time'));
    }
  }
  await assert.rejects(() => checkGrantExpiry(2000n, { ...f.options, readNodeHeadTimeSeconds: async () => 1000 as any }), expectCode('invalid_time'));
  await assert.rejects(() => checkGrantExpiry(2000n, { ...f.options, nowSeconds: () => -1n }), expectCode('invalid_time'));
  assert.equal(f.state.signs, 0); assert.equal(f.state.submissions, 0);
});

test('wall clock skew and the separate timing budgets constrain the horizon', async () => {
  const f = fixture();
  f.state.now = 1000n; f.state.head = 1020n;
  await assert.rejects(() => checkGrantExpiry(1045n, f.options), expectCode('insufficient_horizon'));
  await checkGrantExpiry(1046n, f.options);
  f.state.now = 1020n; f.state.head = 1000n;
  await assert.rejects(() => checkGrantExpiry(1045n, f.options), expectCode('insufficient_horizon'));
  await checkGrantExpiry(1046n, f.options);
  await checkGrantExpiry(1040n, { ...f.options, proveAndBalanceSeconds: 0n });
  await assert.rejects(() => checkGrantExpiry(1040n, f.options), expectCode('insufficient_horizon'));
  f.state.now = MAX - 1n; f.state.head = MAX - 1n;
  await assert.rejects(() => checkGrantExpiry(MAX, f.options), expectCode('insufficient_horizon'));
  await checkGrantExpiry(MAX, { ...f.options, admissionMarginSeconds: 0n, proveAndBalanceSeconds: 0n });
});

test('head-read latency and awaited coin selection cannot age the pre-sign check', async () => {
  const f = fixture();
  f.options.readNodeHeadTimeSeconds = async () => { f.state.now = 2000n; return 1000n; };
  await assert.rejects(() => f.invoke('unshielded'), expectCode('expired'));
  assert.equal(f.state.signs, 0);
  for (const twin of ['shielded', 'contract'] as const) {
    const g = fixture(); g.state.onCoin = () => { g.state.now = 2000n; };
    await assert.rejects(() => g.invoke(twin), expectCode('expired'));
    assert.equal(g.state.signs, 0); assert.equal(g.state.submissions, 0);
  }
});

test('slow signing or changed grant state refuses dispatch without silently re-signing', async () => {
  for (const twin of twins) {
    for (const change of ['expiry', 'nonce', 'revocation', 'epoch', 'generation', 'incarnation']) {
      const f = fixture('p256');
      f.state.onSign = () => {
        if (change === 'expiry') f.state.now = 2000n;
        if (change === 'nonce') f.state.record.nonce++;
        if (change === 'revocation') f.state.record.active = false;
        if (change === 'epoch') f.state.epoch++;
        if (change === 'generation') f.state.generation++;
        if (change === 'incarnation') f.state.record.issued_at++;
      };
      await assert.rejects(() => f.invoke(twin), GrantPreflightError);
      assert.equal(f.state.signs, 1); assert.equal(f.state.submissions, 0);
    }
  }
});

test('shielded twins use snapshot encryption key and refuse key changes', async () => {
  for (const twin of ['shielded', 'contract'] as const) {
    const f = fixture();
    f.account.encKey = async () => { throw Error('separate enc_key read would mix snapshots'); };
    await f.invoke(twin);
    f.state.onSign = () => { f.state.encKey = b(99); };
    await assert.rejects(() => f.invoke(twin), expectCode('encryption_key_changed'));
    assert.equal(f.state.submissions, 1);
  }
});

test('admission refusal dispatches once; a caller retry rereads current state and head', async () => {
  for (const twin of twins) {
    const f = fixture(); f.state.failSubmission = true;
    await assert.rejects(() => f.invoke(twin), /SubmissionError/);
    assert.equal(f.state.signs, 1); assert.equal(f.state.submissions, 1);
    f.state.failSubmission = false; f.state.head = 2000n;
    await assert.rejects(() => f.invoke(twin), expectCode('expired'));
    assert.equal(f.state.signs, 1); assert.equal(f.state.submissions, 1);
    f.state.head = 1000n; f.state.record.nonce++;
    await f.invoke(twin);
    assert.equal(f.state.signs, 2); assert.equal(f.state.submissions, 2);
    assert.equal(f.state.headReads, 5);
  }
});

test('scope constructors require an explicit expiry decision, including explicit zero', () => {
  const read = { readPkHash: b(1) }, spend = { withdrawUnshielded: true, color: b(2), cap: 5n };
  for (const value of [undefined, null, -1n, MAX + 1n, 0, '0']) {
    assert.throws(() => readOnlyScope({ ...read, expiresAt: value } as any), expectCode('invalid_time'));
    assert.throws(() => spendScope({ ...spend, expiresAt: value } as any), expectCode('invalid_time'));
  }
  assert.equal(readOnlyScope({ ...read, expiresAt: 0n }).expiresAt, 0n);
  assert.equal(spendScope({ ...spend, expiresAt: 0n }).expiresAt, 0n);
  assert.equal(spendScope({ ...spend, expiresAt: MAX }).expiresAt, MAX);
});

test('missing node data fails closed without a wall-clock or indexer fallback', async () => {
  const f = fixture();
  f.options.readNodeHeadTimeSeconds = async () => { throw Error('node unavailable'); };
  await assert.rejects(() => f.invoke('unshielded'), /node unavailable/);
  assert.equal(f.state.signs, 0); assert.equal(f.state.submissions, 0);
});

test('finite grant issuance checks expiry before and after an owner signature', async () => {
  const f = fixture();
  (f.account as any).requireUseCounter = async () => ({ counter: 0n, epoch: 2n });
  const device = new JubjubDevice(31n), original = device.sign.bind(device);
  let signs = 0;
  device.sign = (...args) => { signs++; return original(...args); };
  const scope = readOnlyScope({ readPkHash: b(1), expiresAt: 1000n });
  await assert.rejects(() => f.account.issueGrant(device, b(2), scope, b(3), f.options), expectCode('expired'));
  assert.equal(signs, 0);
  scope.expiresAt = 2000n;
  await assert.rejects(() => f.account.issueGrant(device, b(2), scope, b(3)), expectCode('timing_required'));
  assert.equal(signs, 0);
  device.sign = (...args) => { signs++; const auth = original(...args); f.state.now = 2000n; return auth; };
  await assert.rejects(() => f.account.issueGrant(device, b(2), scope, b(3), f.options), expectCode('expired'));
  assert.equal(signs, 1); assert.equal(f.state.submissions, 0);
});

test('high-level issuance makes one dispatch and reevaluates expiry on caller retry', async () => {
  const f = fixture();
  (f.account as any).requireUseCounter = async () => ({ counter: 0n, epoch: 2n });
  const device = new JubjubDevice(32n), original = device.sign.bind(device);
  let signs = 0;
  device.sign = (...args) => { signs++; return original(...args); };
  const scope = readOnlyScope({ readPkHash: b(1), expiresAt: 2000n });
  f.state.failSubmission = true;
  await assert.rejects(() => f.account.issueGrant(device, b(2), scope, b(3), f.options), /SubmissionError/);
  assert.equal(signs, 1); assert.equal(f.state.submissions, 1);
  f.state.head = 2000n;
  await assert.rejects(() => f.account.issueGrant(device, b(2), scope, b(3), f.options), expectCode('expired'));
  assert.equal(signs, 1); assert.equal(f.state.submissions, 1);
});

test('finite grant issue, spend, and revocation exercise generated account circuits', async () => {
  const sim = await AccountSim.create({ initialRecoveryPk: new JubjubDevice(41n).pk, initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
  let submissions = 0, signs = 0;
  const callTx = new Proxy({}, { get: (_, name: string) => async (...args: unknown[]) => {
    submissions++; const result = await sim.call(name, ...args);
    return { public: { txId: `simulated-${submissions}` }, private: { result } };
  } });
  const account = Reflect.construct(CustodyAccount, [bytesToHex(sim.address), sim.address, {}, 'test', { callTx }]) as CustodyAccount;
  account.ledgerState = async () => sim.ledger();
  const grantee = new JubjubGrantee(42n), sign = grantee.sign.bind(grantee);
  grantee.sign = challenge => { signs++; return sign(challenge); };
  const scope = spendScope({ withdrawUnshielded: true, color: b(5), cap: 10n, expiresAt: BigInt(sim.now + 60) });
  const opening = openingOf(scope, b(6), b(7), 0n);
  const id = account.grantIdOf(grantee, opening.originHash, opening.slot);
  const options: GrantPreflightOptions = { readNodeHeadTimeSeconds: async () => BigInt(sim.now),
    nowSeconds: () => BigInt(sim.now), admissionMarginSeconds: 10n, proveAndBalanceSeconds: 15n };
  await sim.call('deposit_unshielded', b(5), 10n);
  await account.issueGrant(sim.device, id, scope, opening.scopeSalt, options);
  await account.withdrawUnshieldedWithGrant(grantee, opening, b(5), 2n, b(8), options);
  assert.equal(sim.ledger().grants.lookup(id).nonce, 1n);
  assert.equal(sim.ledger().unshielded_balances.lookup(b(5)), 8n);
  await account.revokeGrant(sim.device, id);
  const before = submissions;
  await assert.rejects(() => account.withdrawUnshieldedWithGrant(grantee, { ...opening, spentPrev: 2n }, b(5), 1n, b(8), options), expectCode('inactive'));
  assert.equal(signs, 1); assert.equal(submissions, before);
});
