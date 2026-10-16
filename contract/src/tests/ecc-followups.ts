// Targeted follow-ups. Run each stage separately: nonces, encodings, recovery.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { ecMul } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits as c } from '../wallet/contract.js';
import { JubjubDevice, JubjubGrantee, K256Device, JUBJUB_R, bytesToBigIntLE,
  jubjubChallenges, jubjubGrantChallenges } from '../wallet/signer.js';
import { signRecoverSubmit, recoverSubmitChallenge } from '../wallet/recovery-gate.js';
import { AccountSim } from './sim.js';
import { FQ, fieldToBytes, sealWrap, openWrap } from '../wallet/recovery.js';
import { generateEncKeyPair, sealInboxEntry, openInboxEntry } from '../wallet/inbox.js';

const stage = process.argv[2];
const rows: { test: string; result: string }[] = [];
async function test(name: string, action: () => unknown | Promise<unknown>, result = 'passed') {
  await action(); rows.push({ test: name, result }); console.log(`PASS ${name}: ${result}`);
}
const bytes = (n = 32, v = 0) => new Uint8Array(n).fill(v);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const addr = bytes(32, 31), otherAddr = bytes(32, 32);
const owner = new JubjubDevice(5n), grantee = new JubjubGrantee(5n), successor = new JubjubDevice(11n);
const nextRecovery = new JubjubDevice(13n).pk;
const ctx = { contractAddress: addr, authNonce: 0n };
const pk = owner.pk, R = c.compute_public_point_with_jubjub(7n);
const mod = (n: bigint) => (n % JUBJUB_R + JUBJUB_R) % JUBJUB_R;
function inverse(n: bigint) {
  let a = mod(n), e = JUBJUB_R - 2n, r = 1n;
  assert(a !== 0n);
  while (e) { if (e & 1n) r = mod(r * a); a = mod(a * a); e >>= 1n; }
  return r;
}
const pointId = (p: typeof pk) => `${p.x}:${p.y}`;
const recoveryBuild = recoverSubmitChallenge(ctx, pk, successor.pk, nextRecovery, 1n, 1800000000n);
const recoveryFields = { successorRecoveryPk: nextRecovery, expectedEpoch: 0n,
  expectedNonce: 0n, nowUpper: 1800000000n };

if (stage === 'nonces') {
  await test('healthy RNG: 64 device + 64 grant + 128 recovery announcements', () => {
    const seen = new Set<string>();
    const remember = (p: typeof pk) => {
      assert.notDeepEqual(p, { x: 0n, y: 1n });
      assert(!seen.has(pointId(p)), 'repeated nonce announcement'); seen.add(pointId(p));
    };
    const build = jubjubChallenges.rotateEncKey(ctx, pk, bytes());
    for (let i = 0; i < 64; i++) {
      remember(owner.sign(build, 0n).sig_r);
      remember(grantee.sign(build).sig_r);
      const a = signRecoverSubmit(owner, successor, recoveryBuild, recoveryFields);
      remember(a.sig_r_recovery); remember(a.sig_r_successor);
    }
    assert.equal(seen.size, 256);
  });
  const grantCtx = { contractAddress: addr, grantId: bytes(), issuedAt: 0n, grantNonce: 0n };
  const builders = [
    jubjubChallenges.withdrawUnshielded(ctx, pk, bytes(), 1n, bytes()),
    jubjubChallenges.rotateEncKey(ctx, pk, bytes()),
    jubjubChallenges.addDevice(ctx, pk, bytes()),
    jubjubChallenges.removeDevice(ctx, pk, bytes()),
    jubjubChallenges.issueGrant(ctx, pk, bytes(), bytes()),
    jubjubChallenges.revokeGrant(ctx, pk, bytes()),
    jubjubChallenges.revokeAllGrants(ctx, pk),
    jubjubChallenges.recoverCancel(ctx, pk),
    jubjubChallenges.appendInbox(ctx, pk, bytes(192)),
    jubjubChallenges.publishRecoverySession(ctx, pk, nextRecovery, bytes(), [1n, 2n, 0n, 0n], 2n, bytes(64)),
    jubjubGrantChallenges.withdrawUnshielded(grantCtx, pk, bytes(), 1n, bytes()),
    (r: typeof R, g: bigint) => recoveryBuild(r, R, g),
  ];
  await test('12 operation/device/grant/recovery challenge domains are distinct', () => {
    assert.equal(new Set(builders.map(b => hex(b(R, 0n)))).size, builders.length);
  });
  await test('device challenges bind account, nonce, key, announcement, arguments and grind', () => {
    const base = jubjubChallenges.rotateEncKey(ctx, pk, bytes());
    const variants = [
      jubjubChallenges.rotateEncKey({ ...ctx, contractAddress: otherAddr }, pk, bytes())(R, 0n),
      jubjubChallenges.rotateEncKey({ ...ctx, authNonce: 1n }, pk, bytes())(R, 0n),
      jubjubChallenges.rotateEncKey(ctx, successor.pk, bytes())(R, 0n),
      base(successor.pk, 0n), base(R, 1n),
      jubjubChallenges.rotateEncKey(ctx, pk, bytes(32, 1))(R, 0n),
    ];
    for (const changed of variants) assert.notEqual(hex(changed), hex(base(R, 0n)));
  });
  await test('grant challenges bind grant ID, issuance counter and use nonce', () => {
    const build = (g: typeof grantCtx) => jubjubGrantChallenges.withdrawUnshielded(g, pk, bytes(), 1n, bytes());
    const base = hex(build(grantCtx)(R, 0n));
    for (const changed of [{ ...grantCtx, grantId: bytes(32, 1) }, { ...grantCtx, issuedAt: 1n },
      { ...grantCtx, grantNonce: 1n }, { ...grantCtx, contractAddress: otherAddr }])
      assert.notEqual(hex(build(changed)(R, 0n)), base);
  });
  await test('recovery challenge binds both roles, announcements, successor gate, epoch and time', () => {
    const build = (old = pk, next = successor.pk, gate = nextRecovery, epoch = 1n, time = 1800000000n) =>
      recoverSubmitChallenge(ctx, old, next, gate, epoch, time);
    const base = hex(build()(R, R, 0n));
    const variants = [build(successor.pk), build(pk, pk), build(pk, successor.pk, pk),
      build(pk, successor.pk, nextRecovery, 2n), build(pk, successor.pk, nextRecovery, 1n, 1800000001n)];
    for (const changed of variants) assert.notEqual(hex(changed(R, R, 0n)), base);
    for (const changed of [build()(pk, R, 0n), build()(R, pk, 0n), build()(R, R, 1n)]) assert.notEqual(hex(changed), base);
  });
  await test('forced nonce reuse across device/grant domains recovers the signing secret', () => {
    const crypto = createRequire(import.meta.url)('node:crypto');
    const original = crypto.randomBytes;
    try {
      crypto.randomBytes = (size: number) => { assert.equal(size, 32); const b = Buffer.alloc(32); b[31] = 7; return b; };
      syncBuiltinESMExports();
      const b1 = builders[1], b2 = builders[10];
      const a = owner.sign(b1, 0n), b = grantee.sign(b2);
      assert.deepEqual(a.sig_r, b.sig_r);
      const ca = bytesToBigIntLE(b1(a.sig_r, a.grind_nonce));
      const cb = bytesToBigIntLE(b2(b.sig_r, b.grind_nonce));
      assert.equal(mod((a.sig_s - b.sig_s) * inverse(ca - cb)), owner.sk);
    } finally { crypto.randomBytes = original; syncBuiltinESMExports(); }
  }, 'fault injection demonstrates key disclosure; no healthy-RNG reuse observed');
  await test('forced equal recovery/successor nonces reveal recovery key to successor', () => {
    const crypto = createRequire(import.meta.url)('node:crypto');
    const original = crypto.randomBytes;
    try {
      crypto.randomBytes = () => { const b = Buffer.alloc(32); b[31] = 7; return b; };
      syncBuiltinESMExports();
      const a = signRecoverSubmit(owner, successor, recoveryBuild, recoveryFields);
      assert.deepEqual(a.sig_r_recovery, a.sig_r_successor);
      const challenge = bytesToBigIntLE(recoveryBuild(a.sig_r_recovery, a.sig_r_successor, a.grind_nonce));
      assert.equal(mod(successor.sk + (a.sig_s_recovery - a.sig_s_successor) * inverse(challenge)), owner.sk);
    } finally { crypto.randomBytes = original; syncBuiltinESMExports(); }
  }, 'fault injection only; independent recovery nonces remain essential');
}

if (stage === 'encodings') {
  const altered = { ...pk, x: (pk.x + 2n) % FQ };
  await test('altered-x alias: same effective arithmetic point, distinct commitments', () => {
    assert.deepEqual(ecMul(altered, 1n), pk);
    assert.notEqual(hex(c.derive_boot_commitment_with_jubjub(bytes(), altered)), hex(owner.bootCommitment(bytes())));
    assert.notEqual(hex(c.derive_device_entry_with_jubjub({ bytes: addr }, altered, 0n, 0n)), hex(owner.entryAt(addr, 0n, 0n)));
    assert.notEqual(hex(c.derive_grant_id_with_jubjub({ bytes: addr }, altered, bytes(), 0n)), hex(grantee.grantId(addr, bytes(), 0n)));
  }, 'JavaScript discrepancy; existing native tests reject noncanonical coordinates');
  await test('device IDs bind account, epoch and counter', () => {
    const base = owner.entryAt(addr, 0n, 0n);
    for (const id of [owner.entryAt(otherAddr, 0n, 0n), owner.entryAt(addr, 1n, 0n), owner.entryAt(addr, 0n, 1n)])
      assert.notEqual(hex(id), hex(base));
  });
  await test('grant IDs bind account, origin and slot', () => {
    const base = grantee.grantId(addr, bytes(), 0n);
    for (const id of [grantee.grantId(otherAddr, bytes(), 0n), grantee.grantId(addr, bytes(32, 1), 0n), grantee.grantId(addr, bytes(), 1n)])
      assert.notEqual(hex(id), hex(base));
  });
  await test('ECDSA envelope IDs remain distinct for one public key', () => {
    const k0 = new K256Device(5n, 0n), k1 = new K256Device(5n, 1n);
    assert.deepEqual(k0.pk, k1.pk);
    assert.notEqual(hex(k0.entryAt(addr, 0n, 0n)), hex(k1.entryAt(addr, 0n, 0n)));
    assert.notEqual(hex(k0.bootCommitment(bytes())), hex(k1.bootCommitment(bytes())));
  });
  await test('device and grant commitments differ for the same signer', () => {
    assert.notEqual(hex(owner.entryAt(addr, 0n, 0n)), hex(grantee.grantId(addr, bytes(), 0n)));
  });
}

if (stage === 'recovery') {
  const make = () => AccountSim.create({ vetoWindowSeconds: 10n, initialRecoveryPk: pk, initialWrap: bytes(64) });
  await test('invalid successor submission is atomic; original device still works', async () => {
    const sim = await make();
    const args = sim.recoverSubmitArgs(owner, successor, { x: 0n, y: 1n }, BigInt(sim.now));
    const before = sim.state.toString(false);
    assert.notEqual(before, '[object Object]');
    await assert.rejects(() => sim.call('recover_submit', ...args), /identity/);
    assert.equal(sim.state.toString(false), before);
    await sim.authorised('rotate_enc_key', (ctx, d) => jubjubChallenges.rotateEncKey(ctx, d.pk, bytes()), [bytes()]);
  });
  await test('dead enrolled entry cannot let authoriser remove itself', async () => {
    const sim = await make();
    const dead = c.derive_device_entry_with_jubjub({ bytes: sim.address }, { x: 0n, y: 1n }, 0n, 0n);
    await sim.authorised('add_device', (ctx, d) => jubjubChallenges.addDevice(ctx, d.pk, dead), [dead]);
    // Enrolment rolled counter 0 -> 1; removal would roll 1 -> 2 first.
    const callerAfterRoll = sim.device.entryAt(sim.address, 0n, 2n);
    await assert.rejects(() => sim.authorised('remove_device',
      (ctx, d) => jubjubChallenges.removeDevice(ctx, d.pk, callerAfterRoll), [callerAfterRoll]), /authorising device/);
    assert.equal(sim.ledger().device_count, 2n);
    await sim.authorised('remove_device', (ctx, d) => jubjubChallenges.removeDevice(ctx, d.pk, dead), [dead]);
    assert.equal(sim.ledger().device_count, 1n);
  });
  await test('pending recovery permits encryption rotation and device veto', async () => {
    const sim = await make();
    await sim.recoverSubmit(owner, successor, nextRecovery, BigInt(sim.now));
    const key = generateEncKeyPair().publicKey;
    await sim.authorised('rotate_enc_key', (ctx, d) => jubjubChallenges.rotateEncKey(ctx, d.pk, key), [key]);
    assert(sim.ledger().pending_recovery);
    await sim.authorised('recover_cancel', (ctx, d) => jubjubChallenges.recoverCancel(ctx, d.pk), []);
    assert.equal(sim.ledger().pending_recovery, false);
    sim.advanceTime(11);
    await assert.rejects(() => sim.call('recover_finalise'), /no recovery pending/);
  });
  await test('finalisation retires old device and successor repairs an unusable inbox key', async () => {
    const sim = await make();
    await sim.authorised('rotate_enc_key', (ctx, d) => jubjubChallenges.rotateEncKey(ctx, d.pk, bytes()), [bytes()]);
    await sim.recoverSubmit(owner, successor, nextRecovery, BigInt(sim.now));
    await assert.rejects(() => sim.call('recover_finalise'), /veto window/);
    sim.advanceTime(10);
    await sim.call('recover_finalise');
    assert.equal(sim.ledger().device_epoch, 1n);
    assert.equal(sim.ledger().device_count, 1n);
    await assert.rejects(() => sim.authorised('rotate_enc_key', (ctx, d) => jubjubChallenges.rotateEncKey(ctx, d.pk, bytes()), [bytes()]), /unknown device/);
    sim.adoptRecoveredDevice(successor);
    const pair = generateEncKeyPair();
    await sim.authorised('rotate_enc_key', (ctx, d) => jubjubChallenges.rotateEncKey(ctx, d.pk, pair.publicKey), [pair.publicKey], successor);
    const entry = sealInboxEntry(sim.ledger().enc_key, { nonce: bytes(), color: bytes(), value: 42n });
    assert.equal(openInboxEntry(pair.secretKey, entry)?.value, 42n);
  });
  await test('mismatched recovery wrap/key is accepted but fails subsequent inbox decryption', async () => {
    const sim = await make();
    const a = generateEncKeyPair(), b = generateEncKeyPair();
    await sim.authorised('rotate_enc_key', (ctx, d) => jubjubChallenges.rotateEncKey(ctx, d.pk, a.publicKey), [a.publicKey]);
    const secret = fieldToBytes(13n), wrap = sealWrap(secret, sim.address, b.secretKey), sid = bytes(32, 1);
    await sim.authorised('publish_recovery_session',
      (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, nextRecovery, sid, [1n, 2n, 0n, 0n], 2n, wrap),
      [nextRecovery, sid, 1n, 2n, 0n, 0n, 2n, wrap]);
    const unwrapped = openWrap(secret, sim.address, sim.ledger().recovery_wrap);
    assert.deepEqual(unwrapped, b.secretKey);
    const entry = sealInboxEntry(sim.ledger().enc_key, { nonce: bytes(), color: bytes(), value: 42n });
    assert.equal(openInboxEntry(unwrapped!, entry), null);
  }, 'authorised inconsistent setup; no proof of wrap/key correspondence');
  await test('valid key rotation leaves a previously matching recovery wrap stale', async () => {
    const sim = await make();
    const a = generateEncKeyPair(), b = generateEncKeyPair();
    await sim.authorised('rotate_enc_key', (ctx, d) => jubjubChallenges.rotateEncKey(ctx, d.pk, a.publicKey), [a.publicKey]);
    const secret = fieldToBytes(13n), wrap = sealWrap(secret, sim.address, a.secretKey), sid = bytes(32, 2);
    await sim.authorised('publish_recovery_session',
      (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, nextRecovery, sid, [1n, 2n, 0n, 0n], 2n, wrap),
      [nextRecovery, sid, 1n, 2n, 0n, 0n, 2n, wrap]);
    const coin = { nonce: bytes(), color: bytes(), value: 42n };
    const oldEntry = sealInboxEntry(sim.ledger().enc_key, coin);
    assert.equal(openInboxEntry(openWrap(secret, sim.address, wrap)!, oldEntry)?.value, 42n);
    await sim.authorised('rotate_enc_key', (ctx, d) => jubjubChallenges.rotateEncKey(ctx, d.pk, b.publicKey), [b.publicKey]);
    assert.deepEqual(sim.ledger().recovery_wrap, wrap);
    const recovered = openWrap(secret, sim.address, sim.ledger().recovery_wrap)!;
    assert.deepEqual(recovered, a.secretKey);
    const newEntry = sealInboxEntry(sim.ledger().enc_key, coin);
    assert.equal(openInboxEntry(recovered, oldEntry)?.value, 42n);
    assert.equal(openInboxEntry(recovered, newEntry), null);
    assert.equal(openInboxEntry(b.secretKey, newEntry)?.value, 42n);
  }, 'authorised lifecycle inconsistency: old entries readable, new entries require the rotated secret');
}
assert(rows.length > 0, 'choose nonces, encodings or recovery');
const sha = (path: URL) => createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync(new URL(`../../evidence/ecc-validation/${stage}.json`, import.meta.url), JSON.stringify({
  completed: true, runAt: new Date().toISOString(), node: process.version,
  scope: 'Generated JavaScript and real client signers; no new proof or live-node claims; RNG faults explicitly injected only in named tests',
  sourceSha256: sha(new URL(import.meta.url)),
  clientSourceSha256: Object.fromEntries([
    'wallet/signer.ts', 'wallet/signer-p256.ts', 'wallet/recovery-gate.ts',
    'wallet/recovery.ts', 'wallet/inbox.ts', 'wallet/contract.ts', 'wallet/witnesses.ts', 'tests/sim.ts',
  ].map(path => [path, sha(new URL(`../${path}`, import.meta.url))])),
  generatedSha256: sha(new URL('../../contracts/managed/account/contract/index.js', import.meta.url)),
  lockfileSha256: sha(new URL('../../package-lock.json', import.meta.url)), rows,
}, null, 2) + '\n');
console.log(`${stage}: ${rows.length}/${rows.length} checks passed`);
