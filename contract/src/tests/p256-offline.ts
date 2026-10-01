import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import { pureCircuits as probe } from '../../contracts/managed/probe-p256/contract/index.js';
import { pureCircuits as c } from '../wallet/contract.js';
import { assertionMaterial, parseES256Signature, webauthnPolicy } from '../wallet/webauthn.js';
import { p256Challenges, p256GrantChallenges } from '../wallet/signer-p256.js';
import { AccountSim } from './sim.js';
import { withCoin } from '../wallet/witnesses.js';
import {
  JubjubDevice, K256Device, jubjubChallenges, authArgs, grantAuthArgs,
  originHash, scopeArgs, scopeDigest, spendScope, openingOf,
} from '../wallet/signer.js';
import { softwarePasskey, sha256, TEST_ORIGIN } from './p256-fixtures.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const fixture = JSON.parse(readFileSync(new URL('../../../experiments/p256-in-circuit/webauthn/vector.json', import.meta.url), 'utf8'));
const challenge = hex(fixture.challenge_hex);
const data = hex(fixture.authenticator_data_hex);
const sig = parseES256Signature(hex(fixture.signature_der_hex));
const pk = { x: BigInt('0x' + fixture.pk_x_hex), y: BigInt('0x' + fixture.pk_y_hex), identity: false };
const clientJSON = new Uint8Array(Buffer.from(fixture.client_data_json_b64url, 'base64url'));
const policy = webauthnPolicy('localhost', TEST_ORIGIN);
assert.ok(sig.s > p256.Point.Fn.ORDER / 2n, 'real assertion exercises high-S');
assert.equal(probe.webauthn_verify(challenge, policy, data, sig, pk), true);
assert.equal(probe.webauthn_verify(challenge, policy, data, { ...sig, s: p256.Point.Fn.ORDER - sig.s }, pk), true);
assert.deepEqual(probe.webauthn_client_data_hash(challenge, policy.origin), sha256(clientJSON));
assertionMaterial(challenge, policy, pk, { authenticatorData: data, clientDataJSON: clientJSON, signature: hex(fixture.signature_der_hex) });
// Exercise every byte value and all base64url positions, including final pad bits.
for (let i = 0; i < 256; i++) {
  const bytes = Uint8Array.from({ length: 32 }, (_, j) => (i + j) % 256);
  assert.equal(Buffer.from(probe.webauthn_challenge_base64(bytes)).toString(), Buffer.from(bytes).toString('base64url'));
}
assert.throws(() => webauthnPolicy('localhost', 'http://localhost:18973'), /21-byte/);
assert.throws(() => webauthnPolicy('elsewhere', TEST_ORIGIN), /RP ID/);
for (const der of ['3006020100020101', '3006020180020101', '300702020001020101', '308106020101020101', '300602010102010100']) {
  assert.throws(() => parseES256Signature(hex(der)), /ES256/);
}
for (const badSig of [{ r: 0n, s: 1n }, { r: 1n, s: 0n }, { r: p256.Point.Fn.ORDER, s: 1n }]) {
  assert.throws(() => probe.p256_verify_digest(sha256(clientJSON), badSig, pk));
}
for (const badPk of [{ x: 0n, y: 0n, identity: true }, { x: 0n, y: 0n, identity: false }, { ...pk, x: p256.Point.Fp.ORDER }]) {
  assert.throws(() => probe.webauthn_verify(challenge, policy, data, sig, badPk));
}
assert.equal(probe.webauthn_verify(rnd(), policy, data, sig, pk), false);

const f = softwarePasskey();
const fresh = rnd();
const valid = await f.assertion(fresh);
assert.ok(probe.webauthn_verify(fresh, f.policy, valid.authenticatorData, parseES256Signature(valid.signature), f.pk));
// Re-sign mutations with the genuine key. These fail the envelope/policy,
// rather than merely testing that a damaged signature cannot verify.
for (const flags of [0, 1, 4, 21, 37, 69, 133]) {
  const badData = new Uint8Array(valid.authenticatorData); badData[32] = flags;
  const a = await f.assertion(fresh, { authenticatorData: badData });
  assert.throws(() => probe.webauthn_verify(fresh, f.policy, badData, parseES256Signature(a.signature), f.pk), /flags/);
}
for (const flags of [5, 13, 29]) {
  const goodData = new Uint8Array(valid.authenticatorData); goodData[32] = flags;
  const a = await f.assertion(fresh, { authenticatorData: goodData });
  assert.ok(probe.webauthn_verify(fresh, f.policy, goodData, parseES256Signature(a.signature), f.pk));
}
const originalJSON = Buffer.from(valid.clientDataJSON).toString();
for (const badJSON of [
  originalJSON.replace('webauthn.get', 'webauthn.create'),
  originalJSON.replace('8973', '8974'), originalJSON.replace('false', 'true'),
  originalJSON.replace('"type":', '"type":"evil","type":'),
  originalJSON.replace('}', ',"extra":1}'), originalJSON.replace('{', '{ '),
  originalJSON.replace(Buffer.from(fresh).toString('base64url'), Buffer.from(rnd()).toString('base64url')),
]) {
  const a = await f.assertion(fresh, { clientDataJSON: new Uint8Array(Buffer.from(badJSON)) });
  assert.throws(() => assertionMaterial(fresh, f.policy, f.pk, a), /clientDataJSON/);
  assert.equal(probe.webauthn_verify(fresh, f.policy, a.authenticatorData, parseES256Signature(a.signature), f.pk), false);
}
const wrongRP = new Uint8Array(valid.authenticatorData); wrongRP[0] ^= 1;
const rpAssertion = await f.assertion(fresh, { authenticatorData: wrongRP });
assert.throws(() => probe.webauthn_verify(fresh, f.policy, wrongRP, parseES256Signature(rpAssertion.signature), f.pk), /RP/);

// Independent challenge recipe: endian conversion, domain, account and nonce.
const pad = (s: string, n: number) => { const b = Buffer.alloc(n); b.write(s); return b; };
const le = (n: bigint, bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
const ctx = { contractAddress: rnd(), authNonce: 19n }, entry = rnd();
const bootSalt = rnd();
assert.deepEqual(f.device.bootCommitment(bootSalt), sha256(Buffer.concat([
  pad('midnight:account:boot:r1:v2', 32), bootSalt, le(f.pk.x, 32), le(f.pk.y, 32),
  f.policy.rp_id_hash, f.policy.origin,
])));
assert.deepEqual(f.device.entryAt(ctx.contractAddress, 7n, 11n), sha256(Buffer.concat([
  pad('midnight:account:device:r1:v2', 32), ctx.contractAddress, le(f.pk.x, 32), le(f.pk.y, 32),
  f.policy.rp_id_hash, f.policy.origin, le(7n, 4), le(11n, 8),
])));
assert.deepEqual(p256Challenges.addDevice(ctx, f.pk, entry), sha256(Buffer.concat([
  sha256(pad('midnight:account:auth:r1:v1:add_device', 64)), ctx.contractAddress,
  le(f.pk.x, 32), le(f.pk.y, 32), entry, le(ctx.authNonce, 8),
])));

const birth = JubjubDevice.generate();
const sim = await AccountSim.create({ initialRecoveryPk: birth.pk, initialWrap: rnd(64), vetoWindowSeconds: 60n });
const passkeyEntry = f.device.entryAt(sim.address, 0n, 0n);
await sim.authorised('add_device', (ctx, d) => jubjubChallenges.addDevice(ctx, d.pk, passkeyEntry), [passkeyEntry]);
let counter = 0n;
const sign = (challenge: Uint8Array) => f.device.sign(challenge, counter);
const call = async (name: string, challenge: Uint8Array, args: unknown[] = []) => {
  const a = await sign(challenge);
  const result = await sim.call(`${name}_with_p256`, ...args, ...authArgs(a));
  counter++; return result;
};
const added = K256Device.generate().entryAt(sim.address, 0n, 0n);
const addChallenge = p256Challenges.addDevice(sim.callContext(), f.pk, added);
const addAuth = await sign(addChallenge);
for (const bad of [
  { ...addAuth, use_counter: 10n },
  { ...addAuth, policy: { ...f.policy, rp_id_hash: rnd() } },
  { ...addAuth, policy: { ...f.policy, origin: new Uint8Array(Buffer.from('http://localhost:8974')) } },
  { ...addAuth, sig: { ...addAuth.sig, s: 1n } },
]) {
  await assert.rejects(() => sim.call('add_device_with_p256', added, ...authArgs(bad)));
  assert.equal(sim.ledger().auth_nonce, 1n);
}
await assert.rejects(() => sim.call('add_device_with_p256', rnd(), ...authArgs(addAuth)), /signature/);
await assert.rejects(() => sim.call('remove_device_with_p256', added, ...authArgs(addAuth)), /signature/);
const wrongAccount = await sign(p256Challenges.addDevice({ ...sim.callContext(), contractAddress: rnd() }, f.pk, added));
await assert.rejects(() => sim.call('add_device_with_p256', added, ...authArgs(wrongAccount)), /signature/);
await sim.call('add_device_with_p256', added, ...authArgs(addAuth)); counter++;
await assert.rejects(() => sim.call('add_device_with_p256', added, ...authArgs(addAuth)), /unknown device/);
assert.ok(sim.ledger().devices.member(f.device.entryAt(sim.address, 0n, counter)));
await call('remove_device', p256Challenges.removeDevice(sim.callContext(), f.pk, added), [added]);
const newKey = rnd();
await call('rotate_enc_key', p256Challenges.rotateEncKey(sim.callContext(), f.pk, newKey), [newKey]);
assert.deepEqual(sim.ledger().enc_key, newKey);
const inbox = rnd(192);
await call('append_inbox', p256Challenges.appendInbox(sim.callContext(), f.pk, inbox), [inbox]);
const ownSuccessor = f.device.entryAt(sim.address, sim.ledger().device_epoch, counter + 1n);
const selfRemoval = await sign(p256Challenges.removeDevice(sim.callContext(), f.pk, ownSuccessor));
await assert.rejects(() => sim.call('remove_device_with_p256', ownSuccessor, ...authArgs(selfRemoval)), /authorising device/);

// P-256 owner issues to a separate P-256 grantee. RP commitment and signed
// origin are checked by the circuit, even when the client adapter is bypassed.
const delegate = softwarePasskey();
const origin = originHash(TEST_ORIGIN), salt = rnd(), color = rnd(), recipient = rnd();
await sim.call('deposit_unshielded', color, 100n);
await call('withdraw_unshielded', p256Challenges.withdrawUnshielded(sim.callContext(), f.pk, color, 3n, recipient),
  [color, 3n, { bytes: recipient }]);

// Both shielded wrappers must authenticate the *actual* witness coin before
// entering the custody chip. These attacks abort before any coin send.
const coin = { nonce: rnd(), color: rnd(), value: 10n, mt_index: 0n };
sim.privateState = withCoin(sim.privateState, { ...coin, mtIndex: coin.mt_index });
for (const [base, build] of [
  ['withdraw_shielded', p256Challenges.withdrawShielded],
  ['withdraw_shielded_to_contract', p256Challenges.withdrawShieldedToContract],
] as const) {
  const a = await sign(build(sim.callContext(), f.pk, recipient, coin.color, 5n, coin));
  sim.privateState = withCoin(sim.privateState, { ...coin, nonce: rnd(), mtIndex: coin.mt_index });
  await assert.rejects(() => sim.call(`${base}_with_p256`, { bytes: recipient }, coin.color, 5n, ...authArgs(a)), /signature/);
  sim.privateState = withCoin(sim.privateState, { ...coin, mtIndex: coin.mt_index });
  await assert.rejects(() => sim.call(`${base}_with_p256`, { bytes: rnd() }, coin.color, 5n, ...authArgs(a)), /signature/);
}
const id = delegate.grantee.grantId(sim.address, origin, 0n);
const scope = spendScope({ withdrawUnshielded: true, color, cap: 20n, perCallCap: 10n, rpIdHash: delegate.policy.rp_id_hash });
await call('issue_grant', p256Challenges.issueGrant(sim.callContext(), f.pk, id, scopeDigest(salt, scope)), [id, ...scopeArgs(scope), salt]);
const opening = openingOf(scope, salt, origin, 0n);
const record = sim.ledger().grants.lookup(id);
const grantCtx = { contractAddress: sim.address, grantId: id, issuedAt: record.issued_at, grantNonce: record.nonce };
const grantChallenge = p256GrantChallenges.withdrawUnshielded(grantCtx, delegate.pk, color, 5n, recipient);
const grantAuth = await delegate.grantee.sign(grantChallenge);
const spend = (o = opening, a = grantAuth, amount = 5n) => sim.call('withdraw_unshielded_with_grant_p256', color, amount, { bytes: recipient }, ...grantAuthArgs(o, a));
await assert.rejects(() => spend({ ...opening, originHash: rnd() }), /origin/);
await assert.rejects(() => spend(opening, { ...grantAuth, policy: { ...delegate.policy, rp_id_hash: rnd() } }), /RP/);
await assert.rejects(() => spend(opening, grantAuth, 11n), /per.call/);
await assert.rejects(() => spend(opening, grantAuth, 6n), /signature/);
await spend();
assert.equal(sim.ledger().grants.lookup(id).nonce, 1n);
await assert.rejects(() => spend({ ...opening, spentPrev: 5n }), /signature/);
await call('revoke_grant', p256Challenges.revokeGrant(sim.callContext(), f.pk, id), [id]);
await assert.rejects(() => spend(), /revoked/);
await call('revoke_all_grants', p256Challenges.revokeAllGrants(sim.callContext(), f.pk));

const recovery = JubjubDevice.generate(), session = rnd(), phi = [1n, 0n, 0n, 0n] as const, wrap = rnd(64);
await call('publish_recovery_session', p256Challenges.publishRecoverySession(sim.callContext(), f.pk, recovery.pk, session, phi, 1n, wrap),
  [recovery.pk, session, ...phi, 1n, wrap]);
const successor = JubjubDevice.generate();
await sim.recoverSubmit(recovery, successor, birth.pk, BigInt(sim.now + 1));
assert.equal(sim.ledger().pending_recovery, true);
await call('recover_cancel', p256Challenges.recoverCancel(sim.callContext(), f.pk));
assert.equal(sim.ledger().pending_recovery, false);
console.log('PASS P-256/WebAuthn: real high-S assertion, OpenSSL cross-implementation, binding negatives, device/grant/recovery simulation');
