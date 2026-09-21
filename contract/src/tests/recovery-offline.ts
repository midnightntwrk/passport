// Offline recovery checks — no localnet, no simulator.
//
// Exercises the client-side halves of the recovery MIP: the BUSS split and
// reconstruction over the field (§5, §6), the share derivation in its
// tagged, length-prefixed form (§4), the trial-assignment fallback (§6
// step 1), the wrap container v1 (§8), and the challenge domain
// separation of the two new seam operations. The circuit behaviour matrix
// runs in the simulator (recovery-sim.ts); the end-to-end flow runs on a
// node (recovery-conformance.ts).

import { randomBytes } from 'node:crypto';

import { runScenario, step } from './runner.js';
import { pureCircuits } from '../wallet/contract.js';
import { JubjubDevice, jubjubChallenges, JUBJUB_R, type CallContext } from '../wallet/signer.js';
import {
  recoveryKey,
  recoveryScalar,
  matchesRecoveryPk,
  eqPoint,
  recoverSubmitChallenge,
  signRecoverSubmit,
  recoverSubmitArgs,
  readArtefactSet,
} from '../wallet/recovery-gate.js';
import {
  FQ,
  fieldToBytes,
  fieldFromBytes,
  wideReduce,
  guardianSecretFromPrf,
  newPaperKey,
  deriveShare,
  split,
  reconstruct,
  reconstructByTrial,
  sealWrap,
  openWrap,
  newRecoverySecret,
  newSessionNonce,
  WRAP_SIZE,
  type IndexedShare,
} from '../wallet/recovery.js';

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

const eqBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

await runScenario('recovery-offline', async () => {
  step('field encoding and the wide reduction (§2)');
  const s = newRecoverySecret();
  assert(s.field < FQ, 'secret is a field element');
  assert(fieldFromBytes(s.bytes) === s.field, 'canonical repr round-trips');
  assert(fieldToBytes(s.field).length === 32, 'repr is 32 bytes');
  let threw = false;
  try {
    fieldFromBytes(new Uint8Array(32).fill(0xff));
  } catch {
    threw = true;
  }
  assert(threw, 'non-canonical encoding rejected');
  const u = new Uint8Array(64).fill(0xff);
  assert(wideReduce(u) < FQ, 'wide reduction lands in the field');

  step('guardian secrets: three profiles, one share type (§3)');
  const addr = new Uint8Array(randomBytes(32));
  const sid = newSessionNonce();
  const prfA = guardianSecretFromPrf(new Uint8Array(randomBytes(32)));
  const prfB = guardianSecretFromPrf(new Uint8Array(randomBytes(32)));
  const paper = newPaperKey();
  assert(prfA !== prfB, 'distinct PRF outputs give distinct guardian secrets');
  assert(paper < FQ, 'a paper key is a field element');

  step('share derivation is tagged and input-separated (§4)');
  const sigma = deriveShare(sid, addr, prfA);
  assert(sigma === deriveShare(sid, addr, prfA), 'derivation deterministic');
  assert(sigma !== deriveShare(newSessionNonce(), addr, prfA), 'a fresh session moves every share');
  assert(sigma !== deriveShare(sid, new Uint8Array(randomBytes(32)), prfA), 'the account separates shares');
  assert(sigma !== deriveShare(sid, addr, prfB), 'the guardian secret separates shares');

  step('split and reconstruct: |phi| = n - t (§5, §8)');
  // Five guardians at threshold three (t = 2): phi has three entries.
  const guardians = [prfA, prfB, paper, newPaperKey(), guardianSecretFromPrf(new Uint8Array(randomBytes(32)))];
  const t = 2;
  const shares: IndexedShare[] = guardians.map((g, i) => ({
    index: i + 1,
    sigma: deriveShare(sid, addr, g),
  }));
  const phi = split(s.field, shares, t);
  assert(phi.length === guardians.length - t, '|phi| = n - t (five at threshold three publish three)');
  const quorum = [shares[0], shares[2], shares[4]];
  assert(reconstruct(phi, quorum, t) === s.field, 't+1 shares reconstruct the secret');
  assert(reconstruct(phi, [shares[1], shares[3], shares[0]], t) === s.field, 'any t+1 subset works');

  step('threshold behaviour (§9 REC-5, Testing)');
  let below = false;
  try {
    reconstruct(phi, [shares[0], shares[1]], t);
  } catch {
    below = true;
  }
  assert(below, 't shares refuse to reconstruct');
  const wrong: IndexedShare = { index: 3, sigma: (shares[2].sigma + 1n) % FQ };
  assert(
    reconstruct(phi, [shares[0], wrong, shares[4]], t) !== s.field,
    'one wrong share yields a wrong candidate (no identifiable abort)',
  );
  assert(
    reconstruct(phi, [shares[0], shares[2], shares[4]], t) === s.field,
    'substituting the correct share recovers',
  );
  // Removal effectiveness: a fresh session with the guardian excluded.
  const sid2 = newSessionNonce();
  const s2 = newRecoverySecret();
  const roster2 = guardians.slice(0, 4); // guardian 5 removed
  const shares2: IndexedShare[] = roster2.map((g, i) => ({
    index: i + 1,
    sigma: deriveShare(sid2, addr, g),
  }));
  const phi2 = split(s2.field, shares2, t);
  const staleShare: IndexedShare = { index: 4, sigma: deriveShare(sid, addr, guardians[4]) };
  assert(
    reconstruct(phi2, [shares2[0], shares2[1], staleShare], t) !== s2.field,
    'an excluded guardian share from a prior session contributes nothing (REC-5)',
  );

  step('trial assignment when the roster record is lost (§6 step 1)');
  const commitment = recoveryKey(s.field).pk;
  const bare = [shares[4].sigma, shares[0].sigma, shares[2].sigma]; // shuffled, unindexed
  const hit = reconstructByTrial(phi, bare, t, guardians.length, (candidate) =>
    matchesRecoveryPk(candidate, commitment),
  );
  assert(hit !== null && hit.secret === s.field, 'indices recovered by trial against the recovery key');
  const junk = [1n, 2n, 3n];
  assert(
    reconstructByTrial(phi, junk, t, guardians.length, (candidate) => matchesRecoveryPk(candidate, commitment)) === null,
    'trial assignment fails cleanly on garbage shares',
  );

  step('gate key (§2): P = s·G, deterministic, binding, reduced into r_J');
  assert(eqPoint(commitment, recoveryKey(s.bytes).pk), 'the key is the same from the field element and its canonical bytes');
  assert(!eqPoint(commitment, recoveryKey(newRecoverySecret().field).pk), 'distinct secrets give distinct keys');
  assert(recoveryScalar(FQ - 1n) < JUBJUB_R, 'a secret above r_J is reduced into the scalar field');
  assert(eqPoint(recoveryKey(FQ - 1n).pk, recoveryKey(recoveryScalar(FQ - 1n)).pk), 'the reduction is what the key is computed over');
  let zero = false;
  try {
    recoveryScalar(JUBJUB_R);
  } catch {
    zero = true;
  }
  assert(zero, 'a secret reducing to zero is refused (its key would be the identity)');

  step('artefact-set reader refuses an unknown version (§10)');
  {
    const fakeLedger = {
      recovery_version: 2n,
      recovery_pk: commitment,
      recovery_session: sid,
      recovery_phi_len: 3n,
      recovery_phi: { lookup: (k: bigint) => phi[Number(k) - 1] },
      recovery_wrap: new Uint8Array(64),
    };
    let refused = '';
    try {
      readArtefactSet(fakeLedger);
    } catch (e) {
      refused = String(e);
    }
    assert(refused.includes('not implemented'), 'a v2 artefact set is refused rather than best-effort parsed');
    const v1 = readArtefactSet({ ...fakeLedger, recovery_version: 1n });
    assert(v1.phi.length === 3 && v1.phi[0] === phi[0] && v1.phi[2] === phi[2], 'the v1 reader returns the shares in slot order');
  }

  step('wrap container v1 (§8)');
  const encSecret = new Uint8Array(randomBytes(32));
  const wrap = sealWrap(s.bytes, addr, encSecret);
  assert(wrap.length === WRAP_SIZE, 'container is 64 bytes');
  assert(wrap[0] === 0x01 && wrap[1] === 0x01, 'version and suite bytes');
  assert(wrap[62] === 0 && wrap[63] === 0, 'padding zeroed');
  const opened = openWrap(s.bytes, addr, wrap);
  assert(opened !== null && eqBytes(opened, encSecret), 'wrap opens under the recovery secret (REC-7)');
  assert(openWrap(newRecoverySecret().bytes, addr, wrap) === null, 'wrong secret is refused');
  assert(openWrap(s.bytes, new Uint8Array(randomBytes(32)), wrap) === null, 'wrap is bound to the account');
  const tampered = new Uint8Array(wrap);
  tampered[20] ^= 0x01;
  assert(openWrap(s.bytes, addr, tampered) === null, 'tampered ciphertext is refused');
  const badVersion = new Uint8Array(wrap);
  badVersion[0] = 0x02;
  assert(openWrap(s.bytes, addr, badVersion) === null, 'unknown version is refused, not best-effort parsed (§10)');

  step('cross-implementation vectors (buss-rs pins the same bytes)');
  {
    // Constants shared with buss-rs/tests/v1_vectors.rs: both
    // implementations must derive these exact bytes for these inputs.
    const vecGs = guardianSecretFromPrf(new Uint8Array(32).fill(0x11));
    assert(
      Buffer.from(fieldToBytes(vecGs)).toString('hex') ===
        '3ca3592cdd6ab2c6e2d451cbd96fedaf2ed95c58f1ad60e56bb6876ea4ebb617',
      'Profile A guardian secret matches the Rust fork',
    );
    const vecSigma = deriveShare(
      new Uint8Array(32).fill(0x33),
      new Uint8Array(32).fill(0x22),
      vecGs,
    );
    assert(
      Buffer.from(fieldToBytes(vecSigma)).toString('hex') ===
        '3ca7810ce096e24ff66e0e0bdd1389a8a9a837b4fa0a21f3720e4eb71e366c07',
      'v1 share derivation matches the Rust fork',
    );

    // The recover-gate challenge over fixed fixtures: the vector the MIP
    // quotes (section 6 step 4), so an independent contract or signer can
    // check its preimage layout without a node. Points are small multiples
    // of the generator; the address is 0x22 repeated.
    const G = (k: bigint) => pureCircuits.compute_public_point_with_jubjub(k);
    const vecAddr = { bytes: new Uint8Array(32).fill(0x22) };
    const vecChallenge = pureCircuits.challenge_recover_submit(
      vecAddr, G(1n), G(2n), G(3n), G(4n), G(5n), 1n, 7n, 1_800_000_000n, 0n,
    );
    assert(
      Buffer.from(vecChallenge).toString('hex') ===
        '16ebd49d1f2b69139f06c46587eacd4f0bbdb7fb203113503143f624b65afae2',
      'recover-gate challenge vector (P=1G, R_P=2G, Q=3G, R_Q=4G, P\'=5G, epoch 1, nonce 7, bound 1800000000, grind 0)',
    );
    assert(
      Buffer.from(pureCircuits.challenge_recover_cancel_with_jubjub(vecAddr, G(2n), G(1n), 7n, 0n)).toString('hex') ===
        'b44a176275e796dc11313d2d6c7ce80859e5cda5f5e37c738ae97b46745be14b',
      'recover_cancel jubjub challenge vector (R=2G, pk=1G, nonce 7, grind 0)',
    );
  }

  step('challenge domain separation for the new operations (AUTH-3)');
  const device = JubjubDevice.generate();
  const ctx: CallContext = { contractAddress: addr, authNonce: 0n };
  const phiTuple = [phi[0], phi[1], phi[2], 0n] as const;
  const publishBuilder = jubjubChallenges.publishRecoverySession(
    ctx, device.pk, commitment, sid, phiTuple, 3n, wrap,
  );
  const cancelBuilder = jubjubChallenges.recoverCancel(ctx, device.pk);
  const auth = device.sign(publishBuilder, 0n);
  assert(
    !eqBytes(publishBuilder(auth.sig_r, auth.grind_nonce), cancelBuilder(auth.sig_r, auth.grind_nonce)),
    'publish and cancel tags separate',
  );
  const otherWrap = sealWrap(s.bytes, addr, new Uint8Array(randomBytes(32)));
  assert(
    !eqBytes(
      publishBuilder(auth.sig_r, auth.grind_nonce),
      jubjubChallenges.publishRecoverySession(ctx, device.pk, commitment, sid, phiTuple, 3n, otherWrap)(
        auth.sig_r, auth.grind_nonce,
      ),
    ),
    'the wrap is bound into the session challenge',
  );
  assert(
    !eqBytes(
      publishBuilder(auth.sig_r, auth.grind_nonce),
      jubjubChallenges.publishRecoverySession(ctx, device.pk, commitment, sid, [phiTuple[0], phiTuple[1], phiTuple[2], 1n], 3n, wrap)(
        auth.sig_r, auth.grind_nonce,
      ),
    ),
    'every phi slot is bound into the session challenge',
  );

  step('the recover-gate challenge (§6 step 4): its own tag, every binding live');
  {
    const successor = JubjubDevice.generate();
    const nextPk = recoveryKey(newRecoverySecret().field).pk;
    const build = recoverSubmitChallenge(ctx, commitment, successor.pk, nextPk, 1n, 1_800_000_000n);
    const r1 = JubjubDevice.generate().pk;
    const r2 = JubjubDevice.generate().pk;
    const base = build(r1, r2, 0n);
    assert(!eqBytes(base, publishBuilder(r1, 0n)) && !eqBytes(base, cancelBuilder(r1, 0n)), 'submit tag separates from publish and cancel');
    assert(!eqBytes(base, build(r2, r1, 0n)), 'the two nonce points are bound in order');
    assert(!eqBytes(base, recoverSubmitChallenge(ctx, commitment, successor.pk, nextPk, 1n, 1_800_000_001n)(r1, r2, 0n)), 'the wall-clock bound is bound');
    assert(!eqBytes(base, recoverSubmitChallenge(ctx, commitment, successor.pk, nextPk, 2n, 1_800_000_000n)(r1, r2, 0n)), 'the post-bump epoch is bound');
    assert(!eqBytes(base, recoverSubmitChallenge({ ...ctx, authNonce: 1n }, commitment, successor.pk, nextPk, 1n, 1_800_000_000n)(r1, r2, 0n)), 'the authorisation nonce is bound');
    assert(!eqBytes(base, recoverSubmitChallenge(ctx, commitment, JubjubDevice.generate().pk, nextPk, 1n, 1_800_000_000n)(r1, r2, 0n)), 'the successor key is bound');
    assert(!eqBytes(base, recoverSubmitChallenge(ctx, commitment, successor.pk, recoveryKey(newRecoverySecret().field).pk, 1n, 1_800_000_000n)(r1, r2, 0n)), "the successor recovery key P' is bound");
    assert(!eqBytes(base, recoverSubmitChallenge(ctx, nextPk, successor.pk, nextPk, 1n, 1_800_000_000n)(r1, r2, 0n)), 'the stored recovery key is bound');

    step('signing a submission discloses signatures only (REC-6, REC-11)');
    const auth2 = signRecoverSubmit(recoveryKey(s.field), successor, build, {
      successorRecoveryPk: nextPk, expectedEpoch: 0n, expectedNonce: 0n, nowUpper: 1_800_000_000n,
    });
    const args = recoverSubmitArgs(auth2);
    assert(args.length === 10, 'ten circuit arguments');
    assert(!args.includes(s.field) && !args.includes(recoveryScalar(s.field)) && !args.includes(successor.sk), 'no scalar secret among the arguments');
    assert(auth2.sig_s_recovery < JUBJUB_R && auth2.sig_s_successor < JUBJUB_R, 'both response scalars are canonical');
    assert(bytesBelowOrder(build(auth2.sig_r_recovery, auth2.sig_r_successor, auth2.grind_nonce)), 'the ground challenge reads below r_J');
  }
});

function bytesBelowOrder(h: Uint8Array): boolean {
  let v = 0n;
  for (let i = h.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(h[i]);
  return v < JUBJUB_R;
}
