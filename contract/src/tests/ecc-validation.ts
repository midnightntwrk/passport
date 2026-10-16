// Adversarial inputs to the CURRENT compiled account, not a copied verifier.
// Executes generated circuits locally; acceptance here is NOT proof acceptance.
// Run after compiling account.compact with Compact 0.35.0 --feature-zkir-v3.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { ed25519, ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519.js';
import { EncryptionSecretKey, ZswapOutput, ZswapOffer, sampleCoinPublicKey, sampleEncryptionPublicKey } from '@midnightntwrk/ledger-v9';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
  proofDataIntoSerializedPreimage,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits as c, type JubjubPoint } from '../wallet/contract.js';
import { emptyCoinStore, makeWitnesses } from '../wallet/witnesses.js';
import {
  JubjubDevice, K256Device, JUBJUB_R, bytesToBigIntLE, authArgs, k256Challenges,
  p256Challenges, p256GrantChallenges, k256GrantChallenges, originHash,
  jubjubChallenges, jubjubGrantChallenges, scopeArgs, scopeDigest, spendScope,
} from '../wallet/signer.js';
import { FQ } from '../wallet/recovery.js';
import { recoverSubmitChallenge } from '../wallet/recovery-gate.js';
import { softwarePasskey } from './p256-fixtures.js';
import { generateEncKeyPair, sealInboxEntry, openInboxEntry } from '../wallet/inbox.js';

const zero = (n = 32) => new Uint8Array(n);
const salt = new Uint8Array(32).fill(7);
const identity: JubjubPoint = { x: 0n, y: 1n };
const owner = new JubjubDevice(5n);
const successor = new JubjubDevice(11n);
const freshRecovery = new JubjubDevice(13n).pk;
const mod = (x: bigint) => ((x % FQ) + FQ) % FQ;
const altered = { ...owner.pk, x: mod(owner.pk.x + 2n) };
const mixed = { x: mod(-owner.pk.x), y: mod(-owner.pk.y) }; // P + (0,-1).
const kpk = { ...secp256k1.Point.BASE.toAffine(), identity: false };
const ppk = { ...p256.Point.BASE.toAffine(), identity: false };
const policy = softwarePasskey().policy;
type Row = { boundary: string; input: string; accepted: boolean; error?: string; circuit?: string; preimage?: string };
const rows: Row[] = [];
const evidence = new URL('../../evidence/ecc-validation/', import.meta.url);

// Fixed nonces are intentional test fixtures, never production signing code.
function schnorr(sk: bigint, build: (r: JubjubPoint, grind: bigint) => Uint8Array,
  r = c.compute_public_point_with_jubjub(7n), nonce = 7n) {
  for (let grind = 0n; grind < 10000n; grind++) {
    const challenge = bytesToBigIntLE(build(r, grind));
    if (challenge < JUBJUB_R) return {
      sig_r: r, sig_s: (nonce + challenge * sk) % JUBJUB_R, grind_nonce: grind,
    };
  }
  throw new Error('test challenge grinding exhausted');
}

class Sim {
  contract = new (Contract as any)(makeWitnesses());
  addressHex = sampleContractAddress();
  address = new Uint8Array(Buffer.from(this.addressHex, 'hex'));
  coinPk = { bytes: zero() };
  state: any;
  privateState = emptyCoinStore();
  counter = 0n;
  now = 1_800_000_000;
  lastProof?: { circuit: string; bytes: Uint8Array };
  static async create(boot = owner.bootCommitment(salt), recovery = owner.pk, enc = generateEncKeyPair().publicKey) {
    const s = new Sim();
    const init = await s.contract.initialState(createConstructorContext(s.privateState, s.coinPk),
      boot, enc, recovery, zero(64), 60n);
    s.state = init.currentContractState.data;
    return s;
  }
  async call(name: string, ...args: unknown[]) {
    const ctx = createCircuitContext({ circuitId: name, contractAddress: this.addressHex,
      coinPublicKeyOrZswapState: this.coinPk, contractState: this.state,
      privateState: this.privateState, time: this.now });
    const result = await this.contract.impureCircuits[name](ctx, ...args);
    const proof = result.context.callProofDataTrace.at(-1);
    assert.ok(proof, 'successful call did not produce proof data');
    this.lastProof = { circuit: name, bytes: proofDataIntoSerializedPreimage(
      proof.input, proof.output, proof.publicTranscript, proof.privateTranscriptOutputs, name) };
    this.state = result.context.callContext.currentQueryContext.state;
    this.privateState = result.context.callContext.currentPrivateState ?? this.privateState;
    return result.result;
  }
  L() { return ledger(this.state); }
  context() { return { contractAddress: this.address, authNonce: this.L().auth_nonce }; }
  snapshot() {
    const l = this.L();
    return { round: l.round, nonce: l.auth_nonce, count: l.device_count,
      epoch: l.device_epoch, pending: l.pending_recovery, enc: [...l.enc_key],
      fullState: this.state.toString(false) };
  }
  async activate() { await this.call('activate_initial_device_with_jubjub', owner.pk, salt); }
  async authorised(operation: string, args: unknown[], build: ReturnType<typeof jubjubChallenges.addDevice>) {
    const sig = schnorr(owner.sk, build);
    await this.call(`${operation}_with_jubjub`, ...args, owner.pk, this.counter,
      sig.sig_r, sig.sig_s, sig.grind_nonce);
    this.counter++;
  }
  async enrol(pk: JubjubPoint) {
    const entry = c.derive_device_entry_with_jubjub({ bytes: this.address }, pk, this.L().device_epoch, 0n);
    await this.authorised('add_device', [entry], jubjubChallenges.addDevice(this.context(), owner.pk, entry));
    assert.ok(this.L().devices.member(entry));
  }
}

async function check(boundary: string, input: string, action: () => unknown | Promise<unknown>,
  expected: boolean, sim?: Sim) {
  const before = sim?.snapshot();
  let accepted = false, error: string | undefined;
  try { await action(); accepted = true; } catch (e) { error = String(e); }
  const row: Row = { boundary, input, accepted, ...(error ? { error } : {}) };
  if (accepted && sim?.lastProof) {
    const { circuit, bytes } = sim.lastProof;
    row.circuit = circuit;
    row.preimage = `preimages/${rows.length}.bin`;
    mkdirSync(new URL('preimages/', evidence), { recursive: true });
    writeFileSync(new URL(row.preimage, evidence), bytes);
  }
  rows.push(row);
  console.log(`${accepted ? 'ACCEPT' : 'REJECT'} ${boundary}: ${input}${error ? ` — ${error.slice(0, 160)}` : ''}`);
  if (!accepted && sim) assert.deepEqual(sim.snapshot(), before, 'rejected call changed committed state');
  assert.equal(accepted, expected, `${boundary}: ${input}: ${error ?? 'accepted'}`);
  return accepted;
}

// Invalid-curve twin with the same field and a different curve constant.
function pow(base: bigint, exponent: bigint, modulus: bigint) {
  let result = 1n;
  for (; exponent; exponent >>= 1n, base = base * base % modulus) {
    if (exponent & 1n) result = result * base % modulus;
  }
  return result;
}
const kp = secp256k1.Point.Fp.ORDER;
let twin: { x: bigint; y: bigint; identity: boolean };
for (let x = 1n; !twin; x++) {
  const rhs = (x ** 3n + 2n) % kp, y = pow(rhs, (kp + 1n) / 4n, kp);
  if (y * y % kp === rhs) twin = { x, y, identity: false };
}
assert.notEqual((twin.y * twin.y - twin.x ** 3n - 7n) % kp, 0n);

const jubjub = [
  { name: 'valid subgroup key', pk: owner.pk, expected: true },
  { name: 'identity (0,1)', pk: identity, expected: false },
  { name: 'order two (0,-1)', pk: { x: 0n, y: FQ - 1n }, expected: false },
  { name: 'mixed torsion P+(0,-1)', pk: mixed, expected: false },
  { name: 'off curve (1,1)', pk: { x: 1n, y: 1n }, expected: false },
  { name: 'P-256 generator as Jubjub', pk: { x: ppk.x, y: ppk.y }, expected: false },
  // Regression characterization: evaluator accepts this noncanonical pair.
  { name: 'altered x+2, same y', pk: altered, expected: true },
  { name: 'noncanonical x=FQ', pk: { x: FQ, y: 1n }, expected: false },
];
const foreign = (arm: 'k256' | 'p256') => [
  { name: 'valid subgroup key', pk: arm === 'k256' ? kpk : ppk, expected: true },
  { name: 'flagged identity', pk: { x: 0n, y: 0n, identity: true }, expected: false },
  { name: 'unflagged zero coordinates', pk: { x: 0n, y: 0n, identity: false }, expected: false },
  { name: 'identity flag with generator coordinates', pk: { ...(arm === 'k256' ? kpk : ppk), identity: true }, expected: false },
  { name: 'off curve (1,1)', pk: { x: 1n, y: 1n, identity: false }, expected: false },
  { name: 'other curve generator', pk: arm === 'k256' ? ppk : kpk, expected: false },
  ...(arm === 'k256' ? [{ name: 'invalid-curve twin y²=x³+2', pk: twin, expected: false }] : []),
  { name: 'noncanonical x=p', pk: { ...(arm === 'k256' ? kpk : ppk), x: arm === 'k256' ? kp : p256.Point.Fp.ORDER }, expected: false },
];

async function main() {
  // Bypass production signer constructors/adapters: feed raw objects directly
  // into exported circuits, and commit the exact supplied key when possible.
  for (const arm of ['jubjub', 'k256', 'p256'] as const) {
    const variants: { name: string; pk: any; expected: boolean }[] =
      arm === 'jubjub' ? jubjub : foreign(arm);
    for (const v of variants) {
      let boot: Uint8Array = zero();
      try {
        boot = arm === 'jubjub' ? c.derive_boot_commitment_with_jubjub(salt, v.pk)
          : arm === 'k256' ? c.derive_boot_commitment_with_k256(salt, v.pk, 0n)
          : c.derive_boot_commitment_with_p256(salt, v.pk, policy);
      } catch { /* Still test the actual activation with this raw key. */ }
      const s = await Sim.create(boot);
      await check(`bootstrap/${arm}`, v.name,
        () => s.call(`activate_initial_device_with_${arm}`, v.pk, salt,
          ...(arm === 'k256' ? [0n] : arm === 'p256' ? [policy] : [])), v.expected, s);
    }
  }

  // The pure commitment helpers accept some invalid Jubjub points. Enrol the
  // exact commitment first so a later rejection is not just unknown membership.
  for (const v of jubjub.filter(v => v.name !== 'noncanonical x=FQ')) {
    const s = await Sim.create(); await s.activate();
    await check('device/enrol commitment', v.name, () => s.enrol(v.pk), true, s);
    const sig = schnorr(v.name === 'identity (0,1)' ? 0n : owner.sk,
      jubjubChallenges.rotateEncKey(s.context(), v.pk, salt));
    await check('device/authorise jubjub', v.name,
      () => s.call('rotate_enc_key_with_jubjub', salt, v.pk, 0n,
        sig.sig_r, sig.sig_s, sig.grind_nonce), v.expected, s);
  }

  for (const arm of ['k256', 'p256'] as const) {
    const device = arm === 'k256' ? new K256Device(1n) : softwarePasskey().device;
    for (const v of foreign(arm)) {
      const s = await Sim.create(); await s.activate();
      const entry = device.entryAt(s.address, 0n, 0n);
      await s.authorised('add_device', [entry], jubjubChallenges.addDevice(s.context(), owner.pk, entry));
      const auth = v.expected
        ? await device.sign((arm === 'k256' ? k256Challenges : p256Challenges)
          .rotateEncKey(s.context(), device.pk, salt), 0n)
        : arm === 'k256'
          ? { arm: 'k256' as const, pk: v.pk, use_counter: 0n, sig: { r: 1n, s: 1n }, envelope: 0n }
          : { arm: 'p256' as const, pk: v.pk, use_counter: 0n, policy,
            authenticator_data: zero(37), sig: { r: 1n, s: 1n } };
      await check(`device/authorise ${arm}`, v.name,
        () => s.call(`rotate_enc_key_with_${arm}`, salt, ...authArgs(auth as any)), v.expected, s);
      if (!v.expected) assert.match(rows.at(-1)!.error!, /type error|cannot extract/, 'must reject the key before membership/signature checks');
    }
  }

  for (const v of jubjub.filter(v => v.name !== 'noncanonical x=FQ')) {
    const s = await Sim.create(); await s.activate();
    const origin = new Uint8Array(32).fill(3);
    const scope = spendScope({ withdrawUnshielded: true, color: zero(), cap: 10n });
    const id = c.derive_grant_id_with_jubjub({ bytes: s.address }, v.pk, origin, 0n);
    await check('grant/issue committed jubjub key', v.name, async () => {
      await s.authorised('issue_grant', [id, ...scopeArgs(scope), salt],
        jubjubChallenges.issueGrant(s.context(), owner.pk, id, scopeDigest(salt, scope)));
      assert.ok(s.L().grants.member(id));
    }, true, s);
    await s.call('deposit_unshielded', zero(), 10n);
    const record = s.L().grants.lookup(id);
    const sig = schnorr(v.name === 'identity (0,1)' ? 0n : owner.sk,
      jubjubGrantChallenges.withdrawUnshielded({ contractAddress: s.address,
        grantId: id, issuedAt: record.issued_at, grantNonce: record.nonce }, v.pk, zero(), 1n, salt));
    await check('grant/spend jubjub', v.name,
      () => s.call('withdraw_unshielded_with_grant_jubjub', zero(), 1n, { bytes: salt },
        v.pk, origin, 0n, salt, 0n, zero(), scope.maxCoinValue, 0n,
        sig.sig_r, sig.sig_s, sig.grind_nonce), v.expected, s);
    if (rows.at(-1)!.accepted) assert.equal(s.L().unshielded_balances.lookup(zero()), 9n);
  }

  // Storage alone need not invoke a curve operation: measure birth acceptance
  // separately from whether the stored key can subsequently open recovery.
  for (const v of jubjub.filter(v => v.name !== 'noncanonical x=FQ')) {
    let s: Sim;
    const stored = await check('recovery/birth storage', v.name,
      async () => { s = await Sim.create(undefined, v.pk); assert.deepEqual(s.L().recovery_pk, v.pk); }, true);
    if (!stored) continue;
    await s.activate();
    const challenge = recoverSubmitChallenge(s.context(), v.pk, successor.pk, freshRecovery, 1n, BigInt(s.now));
    const a = schnorr(v.name === 'identity (0,1)' ? 0n : owner.sk,
      (r, g) => challenge(r, c.compute_public_point_with_jubjub(7n), g));
    const b = schnorr(successor.sk, (r, g) => challenge(a.sig_r, r, g));
    assert.equal(a.grind_nonce, b.grind_nonce);
    await check('recovery/submit stored key', v.name,
      () => s.call('recover_submit', successor.pk, freshRecovery, 0n, 0n, BigInt(s.now),
        a.sig_r, a.sig_s, b.sig_r, b.sig_s, a.grind_nonce), v.expected, s);
  }

  // Bind each raw R into the challenge and compute the response deliberately;
  // merely corrupting a signature would not test announcement policy.
  const noncePoint = c.compute_public_point_with_jubjub(7n);
  for (const v of [
    { name: 'valid announcement', pk: noncePoint, nonce: 7n, expected: true },
    { name: 'identity R, valid owner key', pk: identity, nonce: 0n, expected: true },
    { name: 'altered x+2, same y', pk: { ...noncePoint, x: mod(noncePoint.x + 2n) }, nonce: 7n, expected: true },
    ...jubjub.filter(v => !v.expected && !['identity (0,1)', 'noncanonical x=FQ'].includes(v.name)).map(v => ({ ...v, nonce: 7n })),
  ]) {
    const s = await Sim.create(); await s.activate();
    const z = schnorr(owner.sk, jubjubChallenges.rotateEncKey(s.context(), owner.pk, salt), v.pk, v.nonce);
    await check('signature/announcement', v.name,
      () => s.call('rotate_enc_key_with_jubjub', salt, owner.pk, 0n,
        z.sig_r, z.sig_s, z.grind_nonce), v.expected, s);
  }

  // Successor keys are a different trust boundary from the stored recovery key.
  for (const field of ['successor device', 'successor recovery'] as const) {
    for (const v of jubjub.filter(v => v.name !== 'noncanonical x=FQ')) {
      const s = await Sim.create(); await s.activate();
      const nextDevice = field === 'successor device' ? v.pk : successor.pk;
      const nextRecovery = field === 'successor recovery' ? v.pk : freshRecovery;
      // A fresh valid key must differ from the stored recovery key; otherwise
      // this would test the key-reuse guard rather than point validation.
      if (field === 'successor recovery' && v.name === 'valid subgroup key') continue;
      const challenge = recoverSubmitChallenge(s.context(), owner.pk, nextDevice, nextRecovery, 1n, BigInt(s.now));
      const a = schnorr(owner.sk, (r, g) => challenge(r, noncePoint, g));
      const b = schnorr(field === 'successor device' ? (v.name === 'identity (0,1)' ? 0n : owner.sk) : successor.sk,
        (r, g) => challenge(a.sig_r, r, g));
      assert.equal(a.grind_nonce, b.grind_nonce);
      await check(`recovery/${field}`, v.name,
        () => s.call('recover_submit', nextDevice, nextRecovery, 0n, 0n, BigInt(s.now),
          a.sig_r, a.sig_s, b.sig_r, b.sig_s, a.grind_nonce), v.expected, s);
    }
  }

  const enc = await Sim.create(); await enc.activate();
  for (const [name, key] of [['zero', zero()], ['one', new Uint8Array([1, ...zero(31)])],
    ['valid X25519', generateEncKeyPair().publicKey]] as const) {
    await check('encryption/rotate key', name, async () => {
      await enc.authorised('rotate_enc_key', [key], jubjubChallenges.rotateEncKey(enc.context(), owner.pk, key));
      assert.deepEqual(enc.L().enc_key, key);
    }, true, enc);
    await check('encryption/seal inbox', name,
      () => sealInboxEntry(key, { nonce: zero(), color: zero(), value: 42n }), name === 'valid X25519');
  }
  const pair = generateEncKeyPair();
  const entry = sealInboxEntry(pair.publicKey, { nonce: zero(), color: zero(), value: 42n });
  assert.equal(openInboxEntry(pair.secretKey, entry)?.value, 42n);
  entry.set(zero(), 2);
  assert.equal(openInboxEntry(pair.secretKey, entry), null);
  await extendedChecks();
}

async function issue(s: Sim, id: Uint8Array, scope: ReturnType<typeof spendScope>) {
  await s.authorised('issue_grant', [id, ...scopeArgs(scope), salt],
    jubjubChallenges.issueGrant(s.context(), owner.pk, id, scopeDigest(salt, scope)));
  await s.call('deposit_unshielded', zero(), 10n);
  const g = s.L().grants.lookup(id);
  return { contractAddress: s.address, grantId: id, issuedAt: g.issued_at, grantNonce: g.nonce };
}

async function extendedChecks() {
  // Check announcement policy at the distinct grant and two-signature recovery
  // gates, with correctly formed responses and explicit damaged controls.
  for (const nonce of [7n, 0n]) {
    const s = await Sim.create(); await s.activate();
    const origin = zero(), scope = spendScope({ withdrawUnshielded: true, color: zero(), cap: 10n });
    const id = c.derive_grant_id_with_jubjub({ bytes: s.address }, owner.pk, origin, 0n);
    const g = await issue(s, id, scope);
    const build = jubjubGrantChallenges.withdrawUnshielded(g, owner.pk, zero(), 1n, salt);
    const sig = schnorr(owner.sk, build, c.compute_public_point_with_jubjub(nonce), nonce);
    const args = [zero(), 1n, { bytes: salt }, owner.pk, origin, 0n, salt, 0n, zero(), scope.maxCoinValue, 0n,
      sig.sig_r, sig.sig_s, sig.grind_nonce];
    await check('signature/grant announcement', nonce ? 'valid announcement' : 'identity R',
      () => s.call('withdraw_unshielded_with_grant_jubjub', ...args), true, s);
    assert.equal(s.L().unshielded_balances.lookup(zero()), 9n);
    if (!nonce) await check('signature/zero-nonce disclosure', 'grant key recoverable from response/challenge', () => {
      const challenge = bytesToBigIntLE(build(sig.sig_r, sig.grind_nonce));
      assert.notEqual(challenge, 0n);
      assert.equal(sig.sig_s * pow(challenge, JUBJUB_R - 2n, JUBJUB_R) % JUBJUB_R, owner.sk);
    }, true);
  }
  for (const [nr, ns] of [[7n, 7n], [0n, 7n], [7n, 0n], [0n, 0n]]) {
    const s = await Sim.create(); await s.activate();
    const rr = c.compute_public_point_with_jubjub(nr), rs = c.compute_public_point_with_jubjub(ns);
    const build = recoverSubmitChallenge(s.context(), owner.pk, successor.pk, freshRecovery, 1n, BigInt(s.now));
    const a = schnorr(owner.sk, (r, g) => build(r, rs, g), rr, nr);
    const b = schnorr(successor.sk, (r, g) => build(rr, r, g), rs, ns);
    assert.equal(a.grind_nonce, b.grind_nonce);
    const args = [successor.pk, freshRecovery, 0n, 0n, BigInt(s.now), rr, a.sig_s, rs, b.sig_s, a.grind_nonce];
    await check('signature/recovery announcement', `recovery nonce=${nr}, successor nonce=${ns}`,
      () => s.call('recover_submit', ...args.slice(0, 6), (a.sig_s + 1n) % JUBJUB_R, ...args.slice(7)), false, s);
    await check('signature/recovery announcement', `recovery nonce=${nr}, successor nonce=${ns}`,
      () => s.call('recover_submit', ...args), true, s);
  }

  for (const v of jubjub.filter(v => v.name !== 'noncanonical x=FQ')) {
    const s = await Sim.create(); await s.activate();
    const pk = v.name === 'valid subgroup key' ? freshRecovery : v.pk;
    const session = new Uint8Array(32).fill(9), phi = [1n, 0n, 0n, 0n] as const;
    await check('recovery/publish key', v.name, () => s.authorised('publish_recovery_session',
      [pk, session, ...phi, 1n, zero(64)],
      jubjubChallenges.publishRecoverySession(s.context(), owner.pk, pk, session, phi, 1n, zero(64))), v.expected, s);
  }

  // Foreign grant seams were not included in the original matrix.
  for (const arm of ['k256', 'p256'] as const) {
    const f = softwarePasskey(), k = new K256Device(1n);
    for (const v of foreign(arm)) {
      const s = await Sim.create(); await s.activate();
      const origin = originHash('http://localhost:8973');
      const scope = spendScope({ withdrawUnshielded: true, color: zero(), cap: 10n,
        ...(arm === 'p256' ? { rpIdHash: f.policy.rp_id_hash } : {}) });
      const id = arm === 'k256'
        ? c.derive_grant_id_with_k256({ bytes: s.address }, k.pk, 0n, origin, 0n)
        : f.grantee.grantId(s.address, origin, 0n);
      const g = await issue(s, id, scope);
      const challenge = (arm === 'k256' ? k256GrantChallenges : p256GrantChallenges)
        .withdrawUnshielded(g, arm === 'k256' ? k.pk : f.pk, zero(), 1n, salt);
      const auth: any = arm === 'k256' ? k.sign(challenge, 0n) : await f.grantee.sign(challenge);
      if (!v.expected) auth.pk = v.pk;
      const prefix = [zero(), 1n, { bytes: salt }];
      const opening = [origin, 0n, salt, 0n, zero(), scope.maxCoinValue, 0n];
      await check(`grant/spend ${arm}`, v.name, () => s.call(`withdraw_unshielded_with_grant_${arm}`,
        ...prefix, ...(arm === 'k256' ? [auth.pk, 0n, ...opening, auth.sig] : [...opening, {
          pk: auth.pk, policy: auth.policy, authenticator_data: auth.authenticator_data, sig: auth.sig }])), v.expected, s);
      if (!v.expected) assert.match(rows.at(-1)!.error!, /type error|cannot extract/);
    }
  }

  for (const arm of ['k256', 'p256'] as const) {
    const device = arm === 'k256' ? new K256Device(1n) : softwarePasskey().device;
    const order = arm === 'k256' ? secp256k1.Point.Fn.ORDER : p256.Point.Fn.ORDER;
    for (const variant of ['low s', 'high s', 'zero r', 'zero s', 'r=n', 's=n']) {
      const s = await Sim.create(); await s.activate();
      const entry = device.entryAt(s.address, 0n, 0n);
      await s.authorised('add_device', [entry], jubjubChallenges.addDevice(s.context(), owner.pk, entry));
      const a = await device.sign((arm === 'k256' ? k256Challenges : p256Challenges).rotateEncKey(s.context(), device.pk, salt), 0n);
      const low = a.sig.s < order - a.sig.s ? a.sig.s : order - a.sig.s;
      a.sig = { r: a.sig.r, s: variant === 'high s' ? order - low : low };
      if (variant === 'zero r') a.sig.r = 0n;
      if (variant === 'zero s') a.sig.s = 0n;
      if (variant === 'r=n') a.sig.r = order;
      if (variant === 's=n') a.sig.s = order;
      await check(`signature/ECDSA ${arm}`, variant,
        () => s.call(`rotate_enc_key_with_${arm}`, salt, ...authArgs(a)), ['low s', 'high s'].includes(variant), s);
    }
  }

  // Derive the low-order Montgomery u values from noble's complete Edwards
  // torsion fixtures, then add the twist value p-1 and RFC7748 aliases.
  const p = (1n << 255n) - 19n;
  const us = new Set<bigint>([0n, 1n, p - 1n, p, p + 1n]);
  for (const bytes of ED25519_TORSION_SUBGROUP) {
    const { y } = ed25519.Point.fromHex(bytes).toAffine();
    if (y !== 1n) us.add((1n + y) * pow((1n - y + p) % p, p - 2n, p) % p);
  }
  assert.equal(us.size, 7);
  const enc = await Sim.create(); await enc.activate();
  for (const u of us) for (const highBit of [0n, 1n << 255n]) {
    const key = Uint8Array.from({ length: 32 }, (_, i) => Number(((u | highBit) >> BigInt(8 * i)) & 255n));
    const name = Buffer.from(key).toString('hex');
    await check('encryption/constructor low-order key', name, async () => {
      const s = await Sim.create(undefined, owner.pk, key); assert.deepEqual(s.L().enc_key, key);
    }, true);
    await check('encryption/rotate low-order key', name,
      () => enc.authorised('rotate_enc_key', [key], jubjubChallenges.rotateEncKey(enc.context(), owner.pk, key)), true, enc);
    await check('encryption/seal low-order key', name,
      () => sealInboxEntry(key, { nonce: zero(), color: zero(), value: 42n }), false);
  }
  const pair = generateEncKeyPair();
  await check('encryption/keypair mismatch', 'unrelated secret cannot read valid entry', () => {
    const sealed = sealInboxEntry(pair.publicKey, { nonce: zero(), color: zero(), value: 42n });
    assert.equal(openInboxEntry(generateEncKeyPair().secretKey, sealed), null);
    assert.equal(openInboxEntry(pair.secretKey, sealed)?.value, 42n);
  }, true);

  // Exercise the actual pinned JS/WASM transaction-construction API, closing
  // the gap between native encryption tests and a consumer entry point.
  const zeroSecret = EncryptionSecretKey.deserialize(new Uint8Array([0]));
  const identityEpk = (zeroSecret as any).public_key();
  assert.equal(identityEpk, '01' + '00'.repeat(31));
  const coin = { nonce: '00'.repeat(32), type: '00'.repeat(32), value: 42n };
  await check('ledger-WASM/encryption', 'zero secret and identity recipient output', () => {
    const out = ZswapOutput.new(coin, undefined, sampleCoinPublicKey(), identityEpk);
    assert.ok(zeroSecret.test(ZswapOffer.fromOutput(out)));
  }, true);
  await check('ledger-WASM/encryption', 'normal recipient not detected by zero secret', () => {
    const out = ZswapOutput.new(coin, undefined, sampleCoinPublicKey(), sampleEncryptionPublicKey());
    assert.equal(zeroSecret.test(ZswapOffer.fromOutput(out)), false);
  }, true);
  await check('ledger-WASM/encryption', 'invalid compressed subgroup point', () =>
    ZswapOutput.new(coin, undefined, sampleCoinPublicKey(), '00'.repeat(32)), false);
  zeroSecret.clear();
}

let completed = false;
try { await main(); completed = true; } finally {
  const path = new URL('runtime.json', evidence);
  mkdirSync(new URL('.', path), { recursive: true });
  const hash = (path: string) => createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex');
  const info = JSON.parse(readFileSync(new URL('../../contracts/managed/account/compiler/contract-info.json', import.meta.url), 'utf8'));
  assert.equal(info['compiler-version'], '0.35.0');
  writeFileSync(path, JSON.stringify({
    scope: 'Generated Compact JavaScript execution only; no proof generation, verification or node submission',
    completed,
    node: process.version, compiler: info['compiler-version'], compilerCommit: info['compiler-commit'],
    runtime: info['runtime-version'],
    sourceSha256: Object.fromEntries(['account.compact', 'account-p256.compact', 'webauthn.compact']
      .map(file => [file, hash(`../../contracts/${file}`)])),
    generatedSha256: hash('../../contracts/managed/account/contract/index.js'),
    zkirSha256: Object.fromEntries([...new Set(rows.flatMap(row => row.circuit ? [row.circuit] : []))]
      .sort().map(name => [name, hash(`../../contracts/managed/account/zkir/${name}.zkir`)])),
    clientSourceSha256: Object.fromEntries([
      'wallet/signer.ts', 'wallet/signer-p256.ts', 'wallet/recovery-gate.ts',
      'wallet/recovery.ts', 'wallet/inbox.ts', 'wallet/contract.ts', 'wallet/witnesses.ts', 'tests/p256-fixtures.ts',
    ].map(file => [file, hash(`../${file}`)])),
    rawBootstrapVectors: Object.fromEntries((['jubjub', 'k256', 'p256'] as const).map(arm => [arm,
      (() => {
      const vectors = (arm === 'jubjub' ? jubjub.filter(v => v.name !== 'noncanonical x=FQ') : foreign(arm)).map(v => {
        const pk = v.pk as { x: bigint; y: bigint; identity?: boolean };
        const modulus = arm === 'k256' ? kp : p256.Point.Fp.ORDER;
        const pack = (x: bigint) => [x & ((1n << 192n) - 1n), x >> 192n];
        // Foreign fields use the unique-zero representation x-1 mod p.
        const limb = (x: bigint) => pack(x === 0n ? modulus - 1n : x - 1n);
        const fields = arm === 'jubjub' ? [pk.x, pk.y] : [...limb(pk.x), ...limb(pk.y), pk.identity ? 1n : 0n];
        if (v.name === 'noncanonical x=p') fields.splice(0, 2, ...pack(modulus));
        return { input: v.name === 'noncanonical x=p' ? 'noncanonical shifted x=p' : v.name, encoded: fields.map(String) };
      });
      if (arm !== 'jubjub') for (const [name, index, value] of [
        ['identity flag=2', 4, 2n], ['oversized low coordinate limb', 0, 1n << 192n],
      ] as const) {
        const encoded = [...vectors[0].encoded]; encoded[index] = String(value);
        vectors.push({ input: name, encoded });
      }
      return vectors;
      })()])),
    testSourceSha256: hash('./ecc-validation.ts'),
    lockfileSha256: hash('../../package-lock.json'), rows,
  }, null, 2) + '\n');
  console.log(`\nRecorded ${rows.length} rows in ${fileURLToPath(path)}`);
}
