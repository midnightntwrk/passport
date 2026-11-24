// B01–B10/B12: execute the actual generated account runtime, with independently
// encoded hashes and OpenSSL assertions. These are host/runtime tests, NOT ZK
// proof acceptance or evidence that malicious witnesses satisfy constraints.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { p256 } from '@noble/curves/nist.js';
import { pureCircuits as c, type JubjubPoint } from '../wallet/contract.js';
import { JubjubDevice, K256Device, JUBJUB_R, bytesToBigIntLE, authArgs } from '../wallet/signer.js';
import { p256Challenges } from '../wallet/signer-p256.js';
import { assertionMaterial, parseES256Signature, webauthnPolicy, type WebAuthnPolicy } from '../wallet/webauthn.js';
import { AccountSim } from './sim.js';
import { softwarePasskey, sha256, TEST_ORIGIN } from './p256-fixtures.js';

// Tests do not refresh committed captures. Native witness work can opt in with
// WRITE_EVIDENCE=1 and choose a separate EVIDENCE_DIR (relative to contract/).
const contractRoot = fileURLToPath(new URL('../../', import.meta.url));
const evidenceDirectory = process.env.WRITE_EVIDENCE === '1'
  ? resolve(contractRoot, process.env.EVIDENCE_DIR ?? 'evidence/signed-bootstrap') : undefined;
const sourceRevision = (): string | null => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: contractRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; } // Source archives still have the recorded content hashes.
};

const bytes = (n = 32) => new Uint8Array(randomBytes(n));
const zero = new Uint8Array(32);
const ascii = (s: string) => new Uint8Array(Buffer.from(s, 'ascii'));
const le = (n: bigint, length: number) => Uint8Array.from({ length }, (_, i) => Number(n >> BigInt(i * 8) & 255n));
const point = (p: JubjubPoint) => [le(p.x, 32), le(p.y, 32)];
const hash = (...parts: Uint8Array[]) => sha256(Buffer.concat(parts));
const policy = webauthnPolicy('localhost', TEST_ORIGIN);
const id = 'midnight:undeployed';
const id41 = new Uint8Array(41); id41.set(ascii(id));
const genesis = new Uint8Array(32).fill(17), anchor = new Uint8Array(32).fill(19);
const network = hash(ascii('mip-0013:boot:net[v1]'), le(BigInt(id.length), 1), id41, genesis, le(123n, 8), anchor);
const bootHash = (N: Uint8Array, Q: JubjubPoint, p = policy, version = 1n, scheme = 2n, profile = 1n) =>
  hash(ascii('mip-0013:boot:key[v1]'), le(version, 2), N, ...point(Q), le(scheme, 1), le(profile, 2), p.rp_id_hash, p.origin);
const intentHash = (N: Uint8Array, address: Uint8Array, boot: Uint8Array, pk: { x: bigint; y: bigint },
  p = policy, epoch = 0n, nonce = 0n, version = 1n, scheme = 2n, profile = 1n) =>
  hash(ascii('mip-0013:boot:activate[v1]'), le(version, 2), N, address, boot, le(scheme, 1), le(profile, 2),
    le(pk.x, 32), le(pk.y, 32), p.rp_id_hash, p.origin, le(epoch, 4), le(nonce, 8));
const popHash = (intent: Uint8Array) => hash(ascii('mip-0013:boot:pop[v1]'), intent);
const signatureHash = (R: JubjubPoint, Q: JubjubPoint, intent: Uint8Array, grind: bigint) =>
  hash(ascii('mip-0013:boot:sig[v1]'), ...point(R), ...point(Q), intent, le(grind, 8));

async function dormant(options: { mode?: bigint; network?: Uint8Array; boot?: Uint8Array; key?: JubjubDevice } = {}) {
  const temporary = options.key ?? JubjubDevice.generate();
  const recovery = JubjubDevice.generate(), nextRecovery = JubjubDevice.generate(), successor = JubjubDevice.generate();
  const N = options.network ?? network;
  const boot = options.boot ?? bootHash(N, temporary.pk);
  // No target key or target assertion exists when the constructor executes.
  const sim = await AccountSim.createDormant({ initialRecoveryPk: recovery.pk, initialWrap: bytes(64),
    vetoWindowSeconds: 10n, bootstrapMode: options.mode ?? 1n, bootstrapNetwork: N }, boot);
  return { sim, temporary, recovery, nextRecovery, successor, boot, network: N };
}
type Fixture = Awaited<ReturnType<typeof dormant>>;
type Passkey = ReturnType<typeof softwarePasskey>;
type Approval = Awaited<ReturnType<typeof approve>>;

async function approve(f: Fixture, passkey = softwarePasskey(), I?: Uint8Array, grease = false) {
  const intent = I ?? intentHash(f.network, f.sim.address, f.boot, passkey.pk, passkey.policy);
  const challenge = popHash(intent);
  const clientDataJSON = grease ? ascii(`{"type":"webauthn.get","challenge":"${Buffer.from(challenge).toString('base64url')}","origin":"${TEST_ORIGIN}","crossOrigin":false,"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"}`) : undefined;
  const assertion = await passkey.assertion(challenge, { ...(clientDataJSON ? { clientDataJSON } : {}) });
  // Independently validate assertion before authorising the temporary key.
  const material = assertionMaterial(challenge, passkey.policy, passkey.pk, assertion);
  const sig = f.temporary.sign((R, g) => signatureHash(R, f.temporary.pk, intent, g), 0n);
  const args: unknown[] = [f.temporary.pk, passkey.pk, passkey.policy, sig.sig_r, sig.sig_s, sig.grind_nonce,
    material.authenticator_data, material.sig, material.chrome_grease];
  return { args, passkey, intent, challenge, sig, assertion };
}
const activate = (f: Fixture, a: Approval, args = a.args) => f.sim.call('activate_initial_passkey', ...args);
async function refuses(f: Fixture, args: unknown[], reason?: RegExp) {
  const before = f.sim.state.toString(false);
  await assert.rejects(() => f.sim.call('activate_initial_passkey', ...args), reason);
  assert.equal(f.sim.state.toString(false), before, 'rejection preserves the entire committed state');
}
const replace = (args: unknown[], index: number, value: unknown) => args.map((x, i) => i === index ? value : x);
const snapshotPreserved = (sim: AccountSim) => {
  const l = sim.ledger();
  return { mode: l.bootstrap_mode, network: l.bootstrap_network, enc: l.enc_key, recovery: l.recovery_pk,
    wrap: l.recovery_wrap, version: l.recovery_version, session: l.recovery_session, phi: [...l.recovery_phi],
    phiLength: l.recovery_phi_len, veto: l.veto_window, pending: l.pending_recovery, pendingEntry: l.pending_entry,
    pendingKey: l.pending_recovery_pk, pendingTime: l.pending_not_before, balances: [...l.unshielded_balances],
    inbox: [...l.inbox], inboxCount: l.inbox_count, grants: [...l.grants], grantGeneration: l.grant_generation };
};

test('B12: independent unpadded typed-hash recipes match every generated helper and r1:v2 entry', async () => {
  const Q = new JubjubDevice(5n).pk, R = new JubjubDevice(7n).pk;
  const pk = { ...p256.Point.BASE.toAffine(), identity: false }, A = new Uint8Array(32).fill(23);
  const B = bootHash(network, Q), I = intentHash(network, A, B, pk, policy, 3n, 9n);
  assert.deepEqual(c.derive_bootstrap_network(BigInt(id.length), id41, genesis, 123n, anchor), network);
  assert.deepEqual(c.derive_signed_boot_commitment(network, Q, policy), B);
  assert.deepEqual(c.derive_signed_boot_intent(network, { bytes: A }, B, pk, policy, 3n, 9n), I);
  assert.deepEqual(c.challenge_signed_boot_passkey(I), popHash(I));
  assert.deepEqual(c.challenge_signed_boot_jubjub(R, Q, I, 11n), signatureHash(R, Q, I, 11n));
  const padded = new Uint8Array(32); padded.set(ascii('midnight:account:device:r1:v2'));
  assert.deepEqual(c.derive_device_entry_with_p256({ bytes: A }, pk, policy, 0n, 0n),
    hash(padded, A, le(pk.x, 32), le(pk.y, 32), policy.rp_id_hash, policy.origin, le(0n, 4), le(0n, 8)));
  // Fixed r=7, b=5 are PUBLIC test fixtures only. Independently construct the
  // canonical Schnorr response, rather than copying the production signer.
  let g = 0n, challenge = bytesToBigIntLE(signatureHash(R, Q, I, g));
  while (challenge >= JUBJUB_R) challenge = bytesToBigIntLE(signatureHash(R, Q, I, ++g));
  const s = (7n + challenge * 5n) % JUBJUB_R;
  if (!evidenceDirectory) return;
  mkdirSync(evidenceDirectory, { recursive: true });
  const sourceHashes = Object.fromEntries(['account.compact', 'account-bootstrap.compact', 'account-p256.compact'].map(file =>
    [file, Buffer.from(sha256(readFileSync(new URL(`../../contracts/${file}`, import.meta.url)))).toString('hex')]));
  writeFileSync(resolve(evidenceDirectory, 'independent-vectors.json'), JSON.stringify({
    description: 'Public deterministic test scalars only; generated helpers checked against independent SHA-256 byte encodings',
    sourceRevision: sourceRevision(), sourceHashes,
    compiler: '0.35.0 --feature-zkir-v3', runtime: '0.20.0',
    inputs: { caip2Id: id, id41, genesis, anchorHeight: 123n, anchorHash: anchor, address: A, Q, R, pk, policy, epoch: 3n, nonce: 9n },
    outputs: { network, boot: B, intent: I, passkeyChallenge: popHash(I),
      challengeAt11: signatureHash(R, Q, I, 11n), canonicalSignature: { R, s, grindNonce: g, challenge },
      noncanonicalResponseAlias: s + JUBJUB_R,
      installedEntry: c.derive_device_entry_with_p256({ bytes: A }, pk, policy, 0n, 0n) },
  }, (_key, value) => typeof value === 'bigint' ? value.toString() :
    value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value, 2));
});

test('B01/B07/B08: deploy first, deposit before activation, install exactly one target and preserve unrelated state', async () => {
  const f = await dormant();
  assert.equal(f.sim.ledger().spec_version, 4n);
  assert.equal(f.sim.ledger().booted, false);
  assert.equal(f.sim.ledger().devices.size(), 0n);
  const a = await approve(f), competing = await approve(f);
  const color = bytes(), inboxEntry = bytes(192);
  await f.sim.call('deposit_unshielded', color, 17n);
  await f.sim.call('deposit_shielded', { nonce: bytes(), color: bytes(), value: 3n }, inboxEntry);
  const before = snapshotPreserved(f.sim), round = f.sim.ledger().round;
  await activate(f, a);
  const l = f.sim.ledger();
  assert.equal(l.booted, true); assert.deepEqual(l.boot, zero);
  assert.equal(l.round, round + 1n); assert.equal(l.device_count, 1n);
  assert.equal(l.device_epoch, 0n); assert.equal(l.auth_nonce, 0n);
  assert.deepEqual([...l.devices], [a.passkey.device.entryAt(f.sim.address, 0n, 0n)]);
  assert.deepEqual(snapshotPreserved(f.sim), before);
  await refuses(f, a.args, /activated/);
  await refuses(f, competing.args, /activated/);
  const key = bytes(), auth = await a.passkey.device.sign(p256Challenges.rotateEncKey(f.sim.callContext(), a.passkey.pk, key), 0n);
  await f.sim.call('rotate_enc_key_with_p256', key, ...authArgs(auth));
  assert.deepEqual(f.sim.ledger().enc_key, key, 'installed entry is usable by the approved passkey');
  assert.equal(f.sim.ledger().auth_nonce, 1n);
});

test('B02/B03: modified public keys, policies, nonce points and signatures fail without state changes', async () => {
  const f = await dormant(), a = await approve(f);
  for (const [index, value] of [
    [0, JubjubDevice.generate().pk], [1, softwarePasskey().pk],
    [2, { ...policy, rp_id_hash: bytes() }], [2, { ...policy, origin: ascii('http://localhost:8974') }],
    [3, JubjubDevice.generate().pk], [4, (a.sig.sig_s + 1n) % JUBJUB_R],
    [4, a.sig.sig_s + JUBJUB_R], [5, a.sig.grind_nonce + 1n],
  ] as [number, unknown][]) await refuses(f, replace(a.args, index, value));
  // A valid equation modulo r_J with a deliberately oversized hash must fail
  // the explicit canonical challenge check, not merely honest signer grinding.
  const r = 11n, R = c.compute_public_point_with_jubjub(r);
  let g = 0n, h = bytesToBigIntLE(signatureHash(R, f.temporary.pk, a.intent, g));
  while (h < JUBJUB_R) h = bytesToBigIntLE(signatureHash(R, f.temporary.pk, a.intent, ++g));
  const bad = [...a.args]; bad[3] = R; bad[4] = (r + h * f.temporary.sk) % JUBJUB_R; bad[5] = g;
  await refuses(f, bad, /challenge|canonical|range/);
});

test('B02: invalid native points are refused at the generated host/runtime boundary', async () => {
  const f = await dormant(), a = await approve(f);
  const field = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
  const invalid = [{ x: 0n, y: 1n }, { x: 0n, y: 0n }, { x: 0n, y: field - 1n },
    { x: field - f.temporary.pk.x, y: field - f.temporary.pk.y }, { ...f.temporary.pk, x: field }];
  for (const p of invalid) {
    await refuses(f, replace(a.args, 0, p));
    await refuses(f, replace(a.args, 3, p));
  }
  for (const pk of [{ x: 0n, y: 0n, identity: true }, { x: 0n, y: 0n, identity: false },
    { ...a.passkey.pk, x: p256.Point.Fp.ORDER }]) await refuses(f, replace(a.args, 1, pk));
});

test('B03/B05/B06: account/network/epoch/nonce/format/scheme/profile and operation are signed', async () => {
  const f = await dormant(), passkey = softwarePasskey();
  const wrongIntents = [
    intentHash(f.network, bytes(), f.boot, passkey.pk), intentHash(bytes(), f.sim.address, f.boot, passkey.pk),
    intentHash(f.network, f.sim.address, bytes(), passkey.pk),
    intentHash(f.network, f.sim.address, f.boot, passkey.pk, policy, 1n),
    intentHash(f.network, f.sim.address, f.boot, passkey.pk, policy, 0n, 1n),
    intentHash(f.network, f.sim.address, f.boot, passkey.pk, policy, 0n, 0n, 2n),
    intentHash(f.network, f.sim.address, f.boot, passkey.pk, policy, 0n, 0n, 1n, 1n),
    intentHash(f.network, f.sim.address, f.boot, passkey.pk, policy, 0n, 0n, 1n, 2n, 2n),
    hash(ascii('another-operation'), f.sim.address),
  ];
  for (const intent of wrongIntents) await refuses(f, (await approve(f, passkey, intent)).args);
  const a = await approve(f, passkey);
  const otherAccount = await dormant({ key: f.temporary });
  await refuses(otherAccount, a.args);
  const changedAnchor = new Uint8Array(anchor); changedAnchor[0] ^= 1;
  const otherNetwork = hash(ascii('mip-0013:boot:net[v1]'), le(BigInt(id.length), 1), id41, genesis, le(123n, 8), changedAnchor);
  await refuses(await dormant({ key: f.temporary, network: otherNetwork }), a.args);
  for (const [version, scheme, profile] of [[2n, 2n, 1n], [1n, 1n, 1n], [1n, 2n, 2n]]) {
    const unsupported = await dormant({ key: f.temporary, boot: bootHash(network, f.temporary.pk, policy, version, scheme, profile) });
    await refuses(unsupported, (await approve(unsupported)).args);
  }
});

test('B04: genuine signatures over unsupported assertion envelopes are rejected by activation', async () => {
  const f = await dormant(), a = await approve(f);
  const replaceAssertion = async (authenticatorData: Uint8Array, clientDataJSON = a.assertion.clientDataJSON) => {
    const signed = await a.passkey.assertion(a.challenge, { authenticatorData, clientDataJSON });
    const args = [...a.args]; args[6] = signed.authenticatorData; args[7] = parseES256Signature(signed.signature);
    await refuses(f, args);
  };
  for (const flags of [0, 1, 4, 21, 37, 69, 133]) {
    const data = new Uint8Array(a.assertion.authenticatorData); data[32] = flags;
    await replaceAssertion(data);
  }
  const wrongRP = new Uint8Array(a.assertion.authenticatorData); wrongRP[0] ^= 1;
  await replaceAssertion(wrongRP);
  await replaceAssertion(a.assertion.authenticatorData.slice(0, 36));
  await replaceAssertion(new Uint8Array([...a.assertion.authenticatorData, 0]));
  const original = Buffer.from(a.assertion.clientDataJSON).toString();
  for (const json of [original.replace('webauthn.get', 'webauthn.create'), original.replace('false', 'true'),
    original.replace('8973', '8974'), original.replace('"type":', '"type":"evil","type":'),
    original.replace(Buffer.from(a.challenge).toString('base64url'), Buffer.from(bytes()).toString('base64url')),
    `{ ${original.slice(1)}`, original.slice(0, -1) + ',"extra":1}']) {
    await replaceAssertion(a.assertion.authenticatorData, ascii(json));
  }
  await refuses(f, replace(a.args, 7, { r: 0n, s: 1n }));
  await refuses(f, replace(a.args, 7, { r: 1n, s: p256.Point.Fn.ORDER }));
  await refuses(f, replace(a.args, 8, true));
});

for (const grease of [false, true]) for (const highS of [false, true]) {
  test(`B04: ${grease ? 'Chrome 243' : 'canonical 134'} assertion accepts ${highS ? 'high' : 'low'}-S`, async () => {
    const f = await dormant(), a = await approve(f, softwarePasskey(), undefined, grease);
    const signature = a.args[7] as { r: bigint; s: bigint }, order = p256.Point.Fn.ORDER;
    const low = signature.s <= order / 2n ? signature.s : order - signature.s;
    a.args[7] = { r: signature.r, s: highS ? order - low : low };
    await refuses(f, replace(a.args, 8, !grease));
    await activate(f, a);
  });
}

for (const flags of [13, 29]) test(`B04: activation accepts UP+UV with valid backup flags ${flags}`, async () => {
  const f = await dormant(), a = await approve(f);
  const data = new Uint8Array(a.assertion.authenticatorData); data[32] = flags;
  const signed = await a.passkey.assertion(a.challenge, { authenticatorData: data });
  a.args[6] = data; a.args[7] = parseES256Signature(signed.signature);
  await activate(f, a);
});

test('B06: constructor rejects unknown modes and incompatible network/boot configuration', async () => {
  await assert.rejects(() => dormant({ mode: 2n }));
  await assert.rejects(() => dormant({ mode: 0n }));
  await assert.rejects(() => dormant({ network: zero }));
  await assert.rejects(() => dormant({ boot: zero }));
  const f = await dormant(), a = await approve(f);
  const legacy = await dormant({ mode: 0n, network: zero });
  await refuses(legacy, a.args, /mode/);
  const salt = bytes(), pk = a.passkey.pk;
  await assert.rejects(() => f.sim.call('activate_initial_device_with_jubjub', f.temporary.pk, salt), /mode/);
  await assert.rejects(() => f.sim.call('activate_initial_device_with_k256', K256Device.generate().pk, salt, 0n), /mode/);
  await assert.rejects(() => f.sim.call('activate_initial_device_with_p256', pk, salt, policy), /mode/);
});

test('B09: recovery finalised first consumes cached approvals permanently', async () => {
  const f = await dormant(), a = await approve(f);
  await f.sim.recoverSubmit(f.recovery, f.successor, f.nextRecovery.pk, BigInt(f.sim.now));
  f.sim.advanceTime(10); await f.sim.call('recover_finalise');
  await refuses(f, a.args, /activated/);
  assert.deepEqual([...f.sim.ledger().devices], [f.successor.entryAt(f.sim.address, 1n, 0n)]);
  assert.deepEqual(f.sim.ledger().boot, zero);
});

for (const veto of [false, true]) test(`B09: activation preserves pending recovery; ${veto ? 'passkey vetoes' : 'recovery retires passkey'}`, async () => {
  const f = await dormant(), a = await approve(f);
  await f.sim.recoverSubmit(f.recovery, f.successor, f.nextRecovery.pk, BigInt(f.sim.now));
  const before = snapshotPreserved(f.sim);
  await activate(f, a);
  assert.deepEqual(snapshotPreserved(f.sim), before);
  if (veto) {
    const auth = await a.passkey.device.sign(p256Challenges.recoverCancel(f.sim.callContext(), a.passkey.pk), 0n);
    await f.sim.call('recover_cancel_with_p256', ...authArgs(auth));
    assert.equal(f.sim.ledger().pending_recovery, false);
    f.sim.advanceTime(10); await assert.rejects(() => f.sim.call('recover_finalise'), /pending/);
  } else {
    f.sim.advanceTime(10); await f.sim.call('recover_finalise');
    assert.deepEqual([...f.sim.ledger().devices], [f.successor.entryAt(f.sim.address, 1n, 0n)]);
    const key = bytes(), auth = await a.passkey.device.sign(p256Challenges.rotateEncKey(f.sim.callContext(), a.passkey.pk, key), 0n);
    await assert.rejects(() => f.sim.call('rotate_enc_key_with_p256', key, ...authArgs(auth)), /unknown device/);
  }
  await refuses(f, a.args, /activated/);
});

test('B10: prover inputs contain signatures and public keys, with neither signing secret', async () => {
  const f = await dormant(), a = await approve(f);
  await activate(f, a);
  assert.ok(f.sim.lastProofPreimage?.length);
  const preimage = Buffer.from(f.sim.lastProofPreimage!);
  assert.equal(preimage.includes(Buffer.from(le(f.temporary.sk, 32))), false, 'temporary scalar absent from proof preimage');
  assert.equal(preimage.includes(Buffer.from(a.passkey.privateKeyBytes)), false, 'P-256 private scalar absent from proof preimage');
  assert.equal(preimage.includes(Buffer.from(a.passkey.privateKeyBytes).reverse()), false);
  assert.equal(a.args.length, 9, 'proof request has only the specified public-key/signature ABI');
  if (!evidenceDirectory) return;
  mkdirSync(resolve(evidenceDirectory, 'preimages'), { recursive: true });
  writeFileSync(resolve(evidenceDirectory, 'preimages/activate_initial_passkey.bin'), preimage);
  const sources = ['contracts/account.compact', 'contracts/account-p256.compact', 'contracts/account-bootstrap.compact',
    'contracts/managed/account/contract/index.js', 'contracts/managed/account/zkir/activate_initial_passkey.zkir'];
  const fingerprints = Object.fromEntries(sources.map(file => {
    try { return [file, Buffer.from(sha256(readFileSync(new URL(`../../${file}`, import.meta.url)))).toString('hex')]; }
    catch { return [file, 'not available']; }
  }));
  writeFileSync(resolve(evidenceDirectory, 'runtime-preimage.json'), JSON.stringify({
    enforcingLayer: 'generated Compact host/runtime; no ZK proof generated by this test',
    compiler: '0.35.0 --feature-zkir-v3', runtime: '0.20.0', sha256: fingerprints,
    preimageSha256: Buffer.from(sha256(preimage)).toString('hex'),
    responseScalar: a.sig.sig_s.toString(),
  }, null, 2));
});
