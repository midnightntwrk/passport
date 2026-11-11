// Real BUSS interpolation, recovery-key checks, AEAD opening, and X25519
// derivation. Snapshot fixtures are controlled data, not node observations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { JUBJUB_R } from '../wallet/signer.js';
import { recoveryKey } from '../wallet/recovery-gate.js';
import { deriveShare, fieldToBytes, FQ, sealWrap, split } from '../wallet/recovery.js';
import {
  ViewingRecoveryError, openCurrentViewingKey, reconstructCurrentViewingKey, reconstructRecoverySecret,
  prepareViewingRecoverySession, viewingRecoveryStatus, viewingSnapshot, viewingWrapVerification,
  sameViewingSnapshot, assertViewingSnapshot, persistedViewingKey, validatePersistedViewingKey,
  validateViewingKeyScope, type ViewingRecoverySnapshot,
} from '../wallet/viewing-recovery.js';

const bytes = (n: number) => new Uint8Array(32).fill(n);
const address = 'a1'.repeat(32), networkId = 'fixture-network';
const copy = <T>(value: T): T => structuredClone(value);
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof ViewingRecoveryError); assert.equal(error.code, expected); return true;
};
function fixture() {
  const keys = generateEncKeyPair(), secret = fieldToBytes(11n), session = bytes(9);
  const shares = [17n, 19n, 23n].map((guardian, i) => ({ index: i + 1, sigma: deriveShare(session, bytes(0xa1), guardian) }));
  const snapshot: ViewingRecoverySnapshot = {
    address, encKey: keys.publicKey, recoveryPk: recoveryKey(secret).pk, recoverySession: session,
    recoveryWrap: sealWrap(secret, bytes(0xa1), keys.secretKey), recoveryVersion: 1n,
    phi: split(11n, shares, 1), deviceEpoch: 2n, pendingRecovery: false,
    pendingEntry: bytes(0), pendingRecoveryPk: { x: 0n, y: 1n }, pendingNotBefore: 0n,
  };
  return { keys, secret, shares, snapshot, input: { n: 3, t: 1, shares: [shares[0], shares[2]] } };
}

test('current wrap restores the exact viewing key without mutating caller material', () => {
  const f = fixture(), before = copy(f);
  const key = openCurrentViewingKey(f.secret, f.snapshot);
  assert.deepEqual(key, f.keys.secretKey);
  assert.deepEqual(f, before);
  key.fill(0); assert.deepEqual(f.keys.secretKey, before.keys.secretKey);
});

test('an authentic old wrap after encryption rotation is stale rather than recovered', () => {
  const f = fixture(); f.snapshot.encKey = generateEncKeyPair().publicKey;
  assert.throws(() => openCurrentViewingKey(f.secret, f.snapshot), code('stale-wrap'));
});

test('a signing-public-key alias cannot bypass exact-secret wrap authentication', () => {
  const f = fixture(), alias = fieldToBytes(11n + JUBJUB_R);
  assert.deepEqual(recoveryKey(alias).pk, f.snapshot.recoveryPk);
  assert.throws(() => openCurrentViewingKey(alias, f.snapshot), code('invalid-wrap'));
});

test('wrong recovery authority and foreign account context cannot open a current wrap', () => {
  const f = fixture();
  assert.throws(() => openCurrentViewingKey(fieldToBytes(12n), f.snapshot), code('recovery-key-mismatch'));
  assert.throws(() => openCurrentViewingKey(f.secret, { ...f.snapshot, address: 'a2'.repeat(32) }), code('invalid-wrap'));
});

test('malformed, future-version, padded, and altered wrap containers are refused', async t => {
  for (const [name, mutate] of [
    ['short', (w: Uint8Array) => w.slice(0, 63)],
    ['long', (w: Uint8Array) => new Uint8Array([...w, 0])],
    ['version', (w: Uint8Array) => { w[0] = 2; return w; }],
    ['suite', (w: Uint8Array) => { w[1] = 2; return w; }],
    ['reserved first', (w: Uint8Array) => { w[62] = 1; return w; }],
    ['reserved last', (w: Uint8Array) => { w[63] = 1; return w; }],
    ['ciphertext', (w: Uint8Array) => { w[20] ^= 1; return w; }],
    ['tag', (w: Uint8Array) => { w[50] ^= 1; return w; }],
  ] as const) await t.test(name, () => {
    const f = fixture(); f.snapshot.recoveryWrap = mutate(f.snapshot.recoveryWrap.slice());
    assert.throws(() => openCurrentViewingKey(f.secret, f.snapshot), code('invalid-wrap'));
  });
});

for (const [name, key] of [['short', bytes(1).slice(1)], ['long', new Uint8Array(33)],
  ['noncanonical', new Uint8Array(32).fill(255)]] as const) test(`malformed recovery secret ${name} is refused`, () => {
  assert.throws(() => openCurrentViewingKey(key, fixture().snapshot), code('invalid-input'));
});

test('supported guardian quorums recover current viewing capability and retain caller shares', () => {
  const f = fixture(), before = copy(f);
  assert.deepEqual(reconstructRecoverySecret(f.snapshot, f.input), f.secret);
  assert.deepEqual(reconstructCurrentViewingKey(f.snapshot, f.input), f.keys.secretKey);
  assert.deepEqual(reconstructCurrentViewingKey(f.snapshot, { ...f.input, shares: [f.shares[1], f.shares[0]] }), f.keys.secretKey);
  assert.deepEqual(f, before);
});

test('unavailable guardians and incorrect shares cannot return a viewing key', () => {
  const f = fixture();
  assert.throws(() => reconstructCurrentViewingKey(f.snapshot, { ...f.input, shares: [f.shares[0]] }), code('guardians-unavailable'));
  const wrong = { ...f.input, shares: [f.shares[0], { ...f.shares[2], sigma: (f.shares[2].sigma + 1n) % FQ }] };
  assert.throws(() => reconstructCurrentViewingKey(f.snapshot, wrong), code('recovery-key-mismatch'));
  const oldSession = f.shares.map((s, i) => ({ index: s.index, sigma: deriveShare(bytes(10), bytes(0xa1), BigInt(40 + i)) }));
  assert.throws(() => reconstructCurrentViewingKey(f.snapshot, { ...f.input, shares: oldSession.slice(0, 2) }), code('recovery-key-mismatch'));
});

test('guardian geometry and canonical fields are validated before interpolation', async t => {
  const f = fixture();
  const cases = [
    ['fractional roster', { ...f.input, n: 3.5 }], ['oversized roster', { ...f.input, n: 33 }],
    ['zero roster', { ...f.input, n: 0 }], ['negative threshold', { ...f.input, t: -1 }],
    ['fractional threshold', { ...f.input, t: 1.5 }], ['threshold above roster', { ...f.input, t: 3 }],
    ['public vector overflow', { ...f.input, n: 6, t: 1 }], ['too many shares', { ...f.input, shares: [...f.shares, f.shares[0]] }],
    ['duplicate indices', { ...f.input, shares: [f.shares[0], f.shares[0]] }],
    ['zero index', { ...f.input, shares: [{ ...f.shares[0], index: 0 }, f.shares[2]] }],
    ['out of roster', { ...f.input, shares: [{ ...f.shares[0], index: 4 }, f.shares[2]] }],
    ['fractional index', { ...f.input, shares: [{ ...f.shares[0], index: 1.5 }, f.shares[2]] }],
    ['negative share', { ...f.input, shares: [{ ...f.shares[0], sigma: -1n }, f.shares[2]] }],
    ['noncanonical share', { ...f.input, shares: [{ ...f.shares[0], sigma: FQ }, f.shares[2]] }],
  ] as const;
  for (const [name, input] of cases) await t.test(name, () => {
    assert.throws(() => reconstructCurrentViewingKey(f.snapshot, input), code('invalid-input'));
  });
  assert.throws(() => reconstructCurrentViewingKey({ ...f.snapshot, phi: [0n] }, f.input), code('invalid-input'));
  assert.throws(() => reconstructCurrentViewingKey({ ...f.snapshot, phi: [FQ, f.snapshot.phi[1]] }, f.input), code('invalid-input'));
});

test('guardian success does not conceal a stale recovered viewing key', () => {
  const f = fixture(); f.snapshot.encKey = generateEncKeyPair().publicKey;
  assert.throws(() => reconstructCurrentViewingKey(f.snapshot, f.input), code('stale-wrap'));
});

test('status distinguishes possession, verified wrapping, stale wrapping, and absent backup', () => {
  const f = fixture(), hex = Buffer.from(f.keys.secretKey).toString('hex');
  const marker = viewingWrapVerification(f.snapshot);
  assert.deepEqual(viewingRecoveryStatus(f.snapshot, hex, marker), { version: 1, address,
    encPublicKeyHex: Buffer.from(f.keys.publicKey).toString('hex'), localKey: 'current', wrap: 'verified-current', pendingRecovery: false });
  assert.equal(viewingRecoveryStatus(f.snapshot, null).localKey, 'missing');
  assert.equal(viewingRecoveryStatus(f.snapshot, 'malformed').localKey, 'stale');
  assert.equal(viewingRecoveryStatus(f.snapshot, hex).wrap, 'unknown');
  const rotated = { ...f.snapshot, encKey: generateEncKeyPair().publicKey };
  assert.equal(viewingRecoveryStatus(rotated, hex, marker).localKey, 'stale');
  assert.equal(viewingRecoveryStatus(rotated, hex, marker).wrap, 'known-stale');
  assert.equal(viewingRecoveryStatus(f.snapshot, hex, viewingWrapVerification(f.snapshot, 'invalidated')).wrap, 'known-stale');
  assert.equal(viewingRecoveryStatus({ ...f.snapshot, phi: [] }, hex, marker).wrap, 'absent');
  assert.equal(viewingRecoveryStatus({ ...f.snapshot, recoveryWrap: new Uint8Array(64) }, hex, marker).wrap, 'absent');
});

test('changed session, public vector, or wrap bytes invalidate old freshness observations', async t => {
  const f = fixture(), marker = viewingWrapVerification(f.snapshot);
  for (const [name, changed] of [
    ['session', { ...f.snapshot, recoverySession: bytes(8) }],
    ['phi', { ...f.snapshot, phi: [f.snapshot.phi[0] + 1n, f.snapshot.phi[1]] }],
    ['wrap padding', { ...f.snapshot, recoveryWrap: new Uint8Array([...f.snapshot.recoveryWrap.slice(0, 63), 1]) }],
    ['authority', { ...f.snapshot, recoveryPk: recoveryKey(12n).pk }],
  ] as const) await t.test(name, () => {
    assert.equal(viewingRecoveryStatus(changed, null, marker).wrap, 'unknown');
    assert.equal(sameViewingSnapshot(f.snapshot, changed), false);
    assert.throws(() => assertViewingSnapshot(f.snapshot, changed), code('chain-changed'));
  });
});

test('pending recovery fields and device epoch are part of snapshot stability', async t => {
  const f = fixture();
  for (const [name, changed] of [
    ['epoch', { ...f.snapshot, deviceEpoch: 3n }], ['pending flag', { ...f.snapshot, pendingRecovery: true }],
    ['pending entry', { ...f.snapshot, pendingEntry: bytes(1) }],
    ['pending authority', { ...f.snapshot, pendingRecoveryPk: recoveryKey(13n).pk }],
    ['deadline', { ...f.snapshot, pendingNotBefore: 100n }],
  ] as const) await t.test(name, () => assert.throws(() => assertViewingSnapshot(f.snapshot, changed), code('chain-changed')));
});

test('preparing a fresh viewing recovery session needs the complete supported roster and no pending recovery', () => {
  const f = fixture(), nextSecret = fieldToBytes(31n), sessionNonce = bytes(7);
  const options = { n: 3, t: 1, shares: f.shares, recoverySecret: nextSecret, sessionNonce };
  const prepared = prepareViewingRecoverySession(f.snapshot, options);
  assert.deepEqual(prepared.recoveryPk, recoveryKey(nextSecret).pk);
  assert.deepEqual(prepared.phi, split(31n, f.shares, 1));
  assert.deepEqual(prepared.sessionNonce, sessionNonce);
  assert.throws(() => prepareViewingRecoverySession(f.snapshot, { ...options, shares: f.input.shares }), code('guardians-unavailable'));
  assert.throws(() => prepareViewingRecoverySession({ ...f.snapshot, pendingRecovery: true }, options), code('pending-recovery'));
  assert.throws(() => prepareViewingRecoverySession(f.snapshot, { ...options, sessionNonce: f.snapshot.recoverySession }), code('invalid-input'));
  assert.throws(() => prepareViewingRecoverySession(f.snapshot, { ...options, sessionNonce: bytes(0) }), code('invalid-input'));
  assert.throws(() => prepareViewingRecoverySession(f.snapshot, { ...options, recoverySecret: f.secret }), code('invalid-input'));
});

test('vault records enforce exact scope, canonical encodings, and key-pair correspondence', () => {
  const f = fixture(), record = persistedViewingKey({ networkId, address }, f.keys.secretKey);
  assert.deepEqual(validatePersistedViewingKey(record, { networkId, address }), record);
  assert.throws(() => validatePersistedViewingKey(record, { networkId: 'elsewhere', address }), code('invalid-input'));
  assert.throws(() => validatePersistedViewingKey({ ...record, encPublicKeyHex: '00'.repeat(32) }), code('invalid-input'));
  assert.throws(() => validateViewingKeyScope({ networkId: ' whitespace ', address }), code('invalid-input'));
  assert.throws(() => validateViewingKeyScope({ networkId, address: address.toUpperCase() }), code('invalid-input'));
});

test('ledger snapshot copies caller arrays and refuses unsupported or malformed ledger fields', () => {
  const f = fixture();
  const ledger: any = { enc_key: f.snapshot.encKey, recovery_pk: f.snapshot.recoveryPk, recovery_session: f.snapshot.recoverySession,
    recovery_wrap: f.snapshot.recoveryWrap, recovery_version: 1n, recovery_phi_len: 2n,
    recovery_phi: { lookup: (i: bigint) => f.snapshot.phi[Number(i) - 1] }, device_epoch: 2n,
    pending_recovery: false, pending_entry: bytes(0), pending_recovery_pk: { x: 0n, y: 1n }, pending_not_before: 0n };
  const actual = viewingSnapshot(address, ledger); assert.deepEqual(actual, f.snapshot);
  ledger.enc_key[0] ^= 1; assert.notDeepEqual(actual.encKey, ledger.enc_key);
  assert.throws(() => viewingSnapshot(address, { ...ledger, recovery_version: 2n }), code('unsupported-version'));
  assert.throws(() => viewingSnapshot(address, { ...ledger, recovery_phi_len: 5n }), code('invalid-input'));
  assert.throws(() => viewingSnapshot(address, { ...ledger, pending_recovery: 'false' }), code('invalid-input'));
  assert.throws(() => viewingSnapshot(address, { ...ledger, device_epoch: -1n }), code('invalid-input'));
});
