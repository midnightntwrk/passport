// Recovery circuit behaviour matrix, in the simulator with explicit
// wall-clock control. Covers the recovery MIP's Testing section minus the
// on-node items: session freshness and slot gating (§5), the two-phase
// gate with pending exclusivity (§6), successor-key validation, the veto
// window and cancel (REC-9), the epoch bump (AUTH-6), and the wrap
// round-trip through the ledger (REC-7). Scoped-grant controls cover both
// grantee arms: epoch and incarnation invalidation, slot isolation, expiry,
// cumulative arithmetic and the shielded witness-color boundary.

import { randomBytes } from 'node:crypto';

import { runScenario, step } from './runner.js';
import { AccountSim } from './sim.js';
import { pureCircuits, type JubjubPoint } from '../wallet/contract.js';
import {
  JubjubDevice, jubjubChallenges, JUBJUB_R,
  JubjubGrantee, K256Grantee, jubjubGrantChallenges, k256GrantChallenges,
  grantAuthArgs, openingOf, originHash, scopeArgs, scopeDigest, spendScope,
  bytesToBigIntLE,
} from '../wallet/signer.js';
import {
  recoveryKey,
  matchesRecoveryPk,
  eqPoint,
  readArtefactSet,
  JUBJUB_IDENTITY,
  JUBJUB_ORDER_TWO,
  recoverSubmitChallenge,
} from '../wallet/recovery-gate.js';
import {
  deriveShare,
  split,
  reconstruct,
  fieldToBytes,
  fieldFromBytes,
  guardianSecretFromPrf,
  sealWrap,
  openWrap,
  newRecoverySecret,
  newSessionNonce,
  type IndexedShare,
} from '../wallet/recovery.js';

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function rejects(f: () => Promise<unknown>, needle: string | RegExp, label: string): Promise<void> {
  try {
    await f();
  } catch (e) {
    const msg = String(e);
    if (typeof needle === 'string' ? !msg.includes(needle) : !needle.test(msg)) {
      throw new Error(`assertion failed: ${label} — threw, but with: ${msg}`);
    }
    console.log(`  ✓ ${label}`);
    return;
  }
  throw new Error(`assertion failed: ${label} — did not throw`);
}

const eqBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

const WINDOW = 3n * 24n * 3600n; // three days, in seconds

interface SessionArtefacts {
  secretField: bigint;
  secretBytes: Uint8Array;
  sid: Uint8Array;
  phi: bigint[];
  shares: IndexedShare[];
  t: number;
}

/** Build and publish a three-guardian, threshold-two session. */
async function publishSession(sim: AccountSim, encSecret: Uint8Array, device?: JubjubDevice): Promise<SessionArtefacts> {
  const t = 1;
  const guardians = [0, 1, 2].map(() => guardianSecretFromPrf(new Uint8Array(randomBytes(32))));
  const s = newRecoverySecret();
  const sid = newSessionNonce();
  const shares: IndexedShare[] = guardians.map((g, i) => ({
    index: i + 1,
    sigma: deriveShare(sid, sim.address, g),
  }));
  const phi = split(s.field, shares, t);
  const commitment = recoveryKey(s.field).pk;
  const wrap = sealWrap(s.bytes, sim.address, encSecret);
  const phiTuple = [phi[0], phi[1], 0n, 0n] as const;
  await sim.authorised(
    'publish_recovery_session',
    (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, commitment, sid, phiTuple, 2n, wrap),
    [commitment, sid, phi[0], phi[1], 0n, 0n, 2n, wrap],
    device,
  );
  return { secretField: s.field, secretBytes: s.bytes, sid, phi, shares, t };
}

/** Reconstruct s from the on-chain phi and a quorum, sign, submit. Returns
 *  the submitted arguments so a drill can replay them verbatim. */
async function submitRecovery(
  sim: AccountSim,
  session: SessionArtefacts,
  successor: JubjubDevice,
  successorRecoveryPk: JubjubPoint,
): Promise<unknown[]> {
  const set = readArtefactSet(sim.ledger());
  const s = reconstruct(set.phi, session.shares.slice(0, session.t + 1), session.t);
  const args = sim.recoverSubmitArgs(s, successor, successorRecoveryPk, BigInt(sim.now));
  await sim.call('recover_submit', ...args);
  return args;
}

await runScenario('recovery-sim', async () => {
  const encSecret = new Uint8Array(randomBytes(32));
  const birth = newRecoverySecret();
  const mkSim = () =>
    AccountSim.create({
      vetoWindowSeconds: WINDOW,
      initialRecoveryPk: recoveryKey(birth.field).pk,
      initialWrap: sealWrap(birth.bytes, new Uint8Array(32), encSecret),
    });

  step('recovery at birth: commitment and wrap present, no vector (§ Backwards Compatibility)');
  const sim = await mkSim();
  let l = sim.ledger();
  assert(l.recovery_phi_len === 0n, 'no phi at deploy');
  assert(l.recovery_version === 1n, 'artefact set version tag present (§10)');
  assert(l.pending_recovery === false, 'no pending record at deploy');

  step('session publish: seam-gated, atomic, fresh (§5)');
  const session = await publishSession(sim, encSecret);
  l = sim.ledger();
  assert(l.recovery_phi_len === 2n, 'three guardians at threshold two publish two (|phi| = n - t)');
  assert(eqBytes(l.recovery_session, session.sid), 'session identifier stored');
  const storedWrap = l.recovery_wrap;
  assert(openWrap(session.secretBytes, sim.address, storedWrap) !== null, 'ledger wrap opens under the session secret');

  step('freshness backstop: stored-value reuse rejected (§5, REC-4)');
  {
    const s2 = newRecoverySecret();
    const commitment2 = recoveryKey(s2.field).pk;
    const wrap2 = sealWrap(s2.bytes, sim.address, encSecret);
    const reusedSid = session.sid;
    await rejects(
      () =>
        sim.authorised(
          'publish_recovery_session',
          (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, commitment2, reusedSid, [1n, 2n, 0n, 0n], 2n, wrap2),
          [commitment2, reusedSid, 1n, 2n, 0n, 0n, 2n, wrap2],
        ),
      'session nonce reused',
      'reused session identifier rejected',
    );
    const storedCommitment = sim.ledger().recovery_pk;
    const freshSid = newSessionNonce();
    await rejects(
      () =>
        sim.authorised(
          'publish_recovery_session',
          (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, storedCommitment, freshSid, [1n, 2n, 0n, 0n], 2n, wrap2),
          [storedCommitment, freshSid, 1n, 2n, 0n, 0n, 2n, wrap2],
        ),
      'recovery commitment reused',
      'reused recovery commitment rejected',
    );
    const sZ = newRecoverySecret();
    const cZ = recoveryKey(sZ.field).pk;
    const wZ = sealWrap(sZ.bytes, sim.address, encSecret);
    await rejects(
      () =>
        sim.authorised(
          'publish_recovery_session',
          (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, cZ, new Uint8Array(32), [1n, 2n, 0n, 0n], 2n, wZ),
          [cZ, new Uint8Array(32), 1n, 2n, 0n, 0n, 2n, wZ],
        ),
      'session nonce is zero',
      'an all-zero identifier from a broken generator is rejected even after a real session',
    );
  }

  step('slot gating: unused slots must be zero (§8)');
  {
    const s3 = newRecoverySecret();
    const c3 = recoveryKey(s3.field).pk;
    const w3 = sealWrap(s3.bytes, sim.address, encSecret);
    const sid3 = newSessionNonce();
    await rejects(
      () =>
        sim.authorised(
          'publish_recovery_session',
          (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, c3, sid3, [1n, 2n, 3n, 0n], 2n, w3),
          [c3, sid3, 1n, 2n, 3n, 0n, 2n, w3],
        ),
      'unused phi slot 3 not zero',
      'a non-zero slot beyond the length field is rejected',
    );
    await rejects(
      () =>
        sim.authorised(
          'publish_recovery_session',
          (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, c3, sid3, [0n, 0n, 0n, 0n], 0n, w3),
          [c3, sid3, 0n, 0n, 0n, 0n, 0n, w3],
        ),
      'phi must not be empty',
      'an empty vector is rejected',
    );
    await rejects(
      () =>
        sim.authorised(
          'publish_recovery_session',
          (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, c3, sid3, [1n, 2n, 3n, 4n], 5n, w3),
          [c3, sid3, 1n, 2n, 3n, 4n, 5n, w3],
        ),
      'phi length out of range',
      'a length field beyond the slot bound is rejected',
    );
  }

  step('unauthorised publish: no valid device, no state change (Testing)');
  {
    const stranger = JubjubDevice.generate();
    const s4 = newRecoverySecret();
    const c4 = recoveryKey(s4.field).pk;
    const w4 = sealWrap(s4.bytes, sim.address, encSecret);
    const sid4 = newSessionNonce();
    const before = sim.ledger().round;
    await rejects(
      () =>
        sim.authorised(
          'publish_recovery_session',
          (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, c4, sid4, [1n, 2n, 0n, 0n], 2n, w4),
          [c4, sid4, 1n, 2n, 0n, 0n, 2n, w4],
          stranger,
        ),
      'unknown device entry',
      'a non-enrolled device cannot publish',
    );
    assert(sim.ledger().round === before, 'failed publish leaves no state change');
  }

  step('successor validation and the two signatures (§6 step 4, Testing)');
  {
    // The gate takes the successor key Q and the successor recovery key P'
    // as public inputs and two signatures as its only private inputs. Each
    // refusal below leaves no pending state.
    const good = JubjubDevice.generate();
    const goodNext = recoveryKey(newRecoverySecret().field).pk;
    const now = BigInt(sim.now);
    const sField = session.secretField;
    await rejects(
      () => sim.recoverSubmit(sField, good, goodNext, now, (a) => { a[0] = JUBJUB_IDENTITY; return a; }),
      'recovery key is the identity',
      'an identity successor key is rejected',
    );
    // Neither the JS runtime nor the proof system admits a JubJub point
    // outside the prime-order subgroup: the runtime refuses to construct one
    // (a torsion point traps before the circuit body runs), and the proving
    // toolchain constrains every assigned point into the subgroup. So on this
    // toolchain the in-circuit cofactor check is reachable only through the
    // identity, which both admit and which the identity assert catches. The
    // cofactor check stays as defence in depth for a backend that assigns
    // points as bare coordinates; the drill accepts either refusal.
    const TORSION_REFUSED = /small order|unreachable/;
    await rejects(
      () => sim.recoverSubmit(sField, good, goodNext, now, (a) => { a[0] = JUBJUB_ORDER_TWO; return a; }),
      TORSION_REFUSED,
      'a small-order successor key is refused (by the runtime at the boundary, or by the cofactor check)',
    );
    await rejects(
      () => sim.recoverSubmit(sField, good, goodNext, now, (a) => { a[1] = JUBJUB_ORDER_TWO; return a; }),
      TORSION_REFUSED,
      "a small-order successor recovery key P' is refused (the next gate would be forgeable)",
    );
    await rejects(
      () => sim.recoverSubmit(sField, good, goodNext, now, (a) => { a[8] = ((a[8] as bigint) + 1n) % JUBJUB_R; return a; }),
      'invalid successor co-signature',
      'a valid successor key without a valid co-signature is rejected (possession is tested)',
    );
    // Tampering with a signed binding after signing recomputes a challenge
    // nobody ground: it fails either the canonical cast into the scalar
    // field (a range error, as on the device seam) or, when the hash happens
    // to read below the order, the verification itself. Both are refusals
    // with no state change, which is the property under test.
    const BINDING_REFUSED = /invalid recovery signature|invalid successor co-signature|range error/;
    await rejects(
      () => sim.recoverSubmit(sField, good, goodNext, now, (a) => { a[4] = (a[4] as bigint) - 1n; return a; }),
      BINDING_REFUSED,
      'the wall-clock bound is signed: altering it after signing fails the gate',
    );
    await rejects(
      () => sim.recoverSubmit(sField, good, goodNext, now, (a) => { a[0] = JubjubDevice.generate().pk; return a; }),
      BINDING_REFUSED,
      'the successor key is signed: swapping it after signing fails the gate',
    );
    await rejects(
      () => sim.recoverSubmit(sField, good, goodNext, now, (a) => { a[1] = recoveryKey(newRecoverySecret().field).pk; return a; }),
      BINDING_REFUSED,
      "the successor recovery key P' is signed: swapping it after signing fails the gate",
    );
    await rejects(
      () => sim.recoverSubmit(sField, good, sim.ledger().recovery_pk, now),
      'recovery commitment reused',
      "a successor recovery key equal to the key being consumed is rejected (§5 defence in depth on the submit path)",
    );
    assert(sim.ledger().pending_recovery === false, 'no rejected submission wrote pending state');

    step('a weak birth key never opens the gate (§6 step 4, Backwards Compatibility)');
    {
      const weak = await AccountSim.create({
        vetoWindowSeconds: WINDOW,
        initialRecoveryPk: JUBJUB_IDENTITY,
        initialWrap: new Uint8Array(64),
      });
      // The forgery against P = O: pick k, present R = k·G and s = k; the
      // verification s·G == R + c·O holds for every challenge. Build raw
      // arguments so the client constructor's zero-secret check cannot
      // prevent this test from reaching the contract's recovery-key guard.
      const successor = JubjubDevice.generate();
      const nextRecoveryPk = recoveryKey(newRecoverySecret().field).pk;
      const state = weak.ledger();
      const now = BigInt(weak.now);
      const rRecovery = 7n, rSuccessor = 11n;
      const sigRRecovery = pureCircuits.compute_public_point_with_jubjub(rRecovery);
      const sigRSuccessor = pureCircuits.compute_public_point_with_jubjub(rSuccessor);
      const build = recoverSubmitChallenge(
        weak.callContext(), JUBJUB_IDENTITY, successor.pk, nextRecoveryPk, state.device_epoch + 1n, now,
      );
      let grind = 0n;
      let challenge: bigint;
      while ((challenge = bytesToBigIntLE(build(sigRRecovery, sigRSuccessor, grind))) >= JUBJUB_R) grind++;
      const sigSSuccessor = (rSuccessor + challenge * successor.sk) % JUBJUB_R;
      await rejects(
        () => weak.call('recover_submit', successor.pk, nextRecoveryPk, state.device_epoch, state.auth_nonce, now,
          sigRRecovery, rRecovery, sigRSuccessor, sigSSuccessor, grind),
        'recovery key is the identity',
        'the forgery is refused at the gate: the stored key is checked before any signature is examined',
      );
      assert(weak.ledger().pending_recovery === false, 'the weak-key account wrote no pending state');
    }

    step('delegation safety: the submission carries signatures, not secrets (REC-11)');
    const args = sim.recoverSubmitArgs(sField, good, goodNext, now);
    assert(!args.includes(sField) && !args.includes(good.sk), 'neither the recovery secret nor the successor scalar is an argument');
    assert(args.length === 10, 'ten arguments: two keys, three bindings, two signatures, one grind nonce');
  }

  step('the gate: wrong secret refused, right secret records the pending recovery (§6)');
  {
    const successor = JubjubDevice.generate();
    const successorSecret = newRecoverySecret();
    const successorRecoveryPk = recoveryKey(successorSecret.field).pk;
    const l6 = sim.ledger();
    await rejects(
      () => sim.recoverSubmit(newRecoverySecret().field, successor, successorRecoveryPk, BigInt(sim.now)),
      'invalid recovery signature',
      'a wrong secret fails the gate (REC-1)',
    );
    const firstArgs = await submitRecovery(sim, session, successor, successorRecoveryPk);
    l = sim.ledger();
    assert(l.pending_recovery === true, 'pending record present');
    assert(eqPoint(l.pending_recovery_pk, successorRecoveryPk), "the pending record carries P'");
    assert(l.device_epoch === l6.device_epoch, 'submission does not bump the epoch');

    step('pending exclusivity: no displacement, no session (§5, §6 step 4)');
    await rejects(
      () => sim.recoverSubmit(session.secretField, JubjubDevice.generate(), recoveryKey(newRecoverySecret().field).pk, BigInt(sim.now)),
      'recovery already pending',
      'a second submission is rejected while one is pending',
    );
    const s7 = newRecoverySecret();
    const c7 = recoveryKey(s7.field).pk;
    const w7 = sealWrap(s7.bytes, sim.address, encSecret);
    const sid7 = newSessionNonce();
    await rejects(
      () =>
        sim.authorised(
          'publish_recovery_session',
          (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, c7, sid7, [1n, 2n, 0n, 0n], 2n, w7),
          [c7, sid7, 1n, 2n, 0n, 0n, 2n, w7],
        ),
      'recovery pending',
      'a session is rejected while a recovery is pending (cancel first)',
    );

    step('veto window: finalisation blocked, cancel immediate (§6 step 5, REC-9)');
    await rejects(() => sim.call('recover_finalise'), 'veto window still open', 'finalisation blocked before the window elapses');
    sim.advanceTime(3600);
    await rejects(() => sim.call('recover_finalise'), 'veto window still open', 'still blocked an hour in');
    const nonceBeforeCancel = sim.ledger().auth_nonce;
    await sim.authorised('recover_cancel', (ctx, d) => jubjubChallenges.recoverCancel(ctx, d.pk), []);
    l = sim.ledger();
    assert(l.pending_recovery === false, 'cancel clears the pending record');
    assert(l.device_epoch === l6.device_epoch, 'a cancelled attempt leaves the epoch unchanged');
    assert(l.auth_nonce === nonceBeforeCancel + 1n, 'cancel advances the authorisation nonce through the seam');
    await rejects(
      () => sim.call('recover_submit', ...firstArgs),
      'stale authorisation nonce',
      'the cancelled submission replayed verbatim is rejected (the nonce advanced)',
    );
    const stale = sim.recoverSubmitArgs(session.secretField, successor, successorRecoveryPk, BigInt(sim.now), { nonce: nonceBeforeCancel });
    await rejects(
      () => sim.call('recover_submit', ...stale),
      'stale authorisation nonce',
      'a fresh signature over the pre-cancel nonce is rejected too',
    );
    await rejects(() => sim.call('recover_finalise'), 'no recovery pending', 'nothing to finalise after a cancel');
  }

  step('total loss end to end: submit, wait out the window, finalise (§6, REC-8)');
  {
    const successor = JubjubDevice.generate();
    const successorSecret = newRecoverySecret();
    const successorRecoveryPk = recoveryKey(successorSecret.field).pk;
    const epochBefore = sim.ledger().device_epoch;

    // The recovering wallet reconstructs, opens the wrap (REC-7), and only
    // then submits — s is discarded before the window opens (REC-6).
    const lNow = sim.ledger();
    const set = readArtefactSet(lNow);
    assert(set.version === 1n && set.phi.length === 2, 'the reader accepts the v1 artefact set and returns its two shares');
    const sRec = reconstruct(set.phi, session.shares.slice(0, 2), session.t);
    assert(matchesRecoveryPk(sRec, set.recoveryPk), 'reconstructed secret opens the stored recovery key');
    const recoveredVk = openWrap(fieldToBytes(sRec), sim.address, set.wrap);
    assert(recoveredVk !== null && eqBytes(recoveredVk, encSecret), 'the wrap restores the encryption secret (REC-7)');
    assert(fieldFromBytes(fieldToBytes(sRec)) === sRec, 'witness form is canonical');
    await submitRecovery(sim, session, successor, successorRecoveryPk);

    sim.advanceTime(Number(WINDOW) + 60);
    const nonceBeforeFinalise = sim.ledger().auth_nonce;
    const roundBeforeFinalise = sim.ledger().round;
    const successorEntry = sim.ledger().pending_entry;
    assert(sim.ledger().devices.size() > 0n, 'recovery starts with a nonempty device set');
    await sim.call('recover_finalise');
    l = sim.ledger();
    assert(l.device_epoch === epochBefore + 1n, 'finalisation bumps the device epoch');
    assert(l.auth_nonce === nonceBeforeFinalise + 1n, 'finalisation advances the authorisation nonce (MIP-0013 §8 d)');
    assert(l.round === roundBeforeFinalise + 1n, 'finalisation advances the round counter');
    assert(l.device_count === 1n, 'exactly one device at the new epoch (MIP-0013 §8c)');
    assert(l.devices.size() === 1n, 'finalisation replaces the whole device set (AUTH-6)');
    assert(l.devices.member(successorEntry), 'the sole retained entry is the authorised successor');
    assert(l.pending_recovery === false, 'pending record cleared');
    assert(l.recovery_phi_len === 0n, 'the published vector is retired with its secret');
    assert(eqPoint(l.recovery_pk, successorRecoveryPk), 'the recovery key rotated to the successor');

    step('the epoch bump revokes every prior device (AUTH-6)');
    sim.adoptRecoveredDevice(successor);
    await rejects(
      () => sim.enrolDevice(),
      'unknown device entry',
      'the pre-recovery device is dead at the new epoch',
    );
    const freshEntry = sim.entryFor(JubjubDevice.generate());
    await sim.authorised(
      'add_device',
      (ctx, d) => jubjubChallenges.addDevice(ctx, d.pk, freshEntry),
      [freshEntry],
      successor,
    );
    assert(sim.ledger().device_count === 2n, 'the successor device authorises at the new epoch (REC-8)');

    step('post-recovery: a fresh session closes the exposure (§6 step 7)');
    await publishSession(sim, encSecret, successor);
    assert(sim.ledger().recovery_phi_len === 2n, 'a single recovered device can run a session (1-of-n)');
  }

  step('grant recovery: grants from before and during the window stay dead across epochs');
  {
    const initialSecret = newRecoverySecret();
    const gs = await AccountSim.create({
      vetoWindowSeconds: WINDOW,
      initialRecoveryPk: recoveryKey(initialSecret.field).pk,
      initialWrap: new Uint8Array(64),
    });
    const color = new Uint8Array(randomBytes(32));
    const recipient = new Uint8Array(randomBytes(32));
    const origin = originHash('https://recovery-grants.example');
    const scope = spendScope({ expiresAt: 0n, withdrawUnshielded: true, color, cap: 100n, perCallCap: 10n });
    const delegates = [JubjubGrantee.generate(), K256Grantee.generate()];
    const grants = delegates.map((grantee, i) => ({
      grantee,
      id: grantee.grantId(gs.address, origin, BigInt(i)),
      salt: new Uint8Array(randomBytes(32)),
      slot: BigInt(i),
    }));
    await gs.call('deposit_unshielded', color, 100n);

    const snapshot = () => {
      const state = gs.ledger();
      return JSON.stringify({
        round: state.round, authNonce: state.auth_nonce, epoch: state.device_epoch,
        count: state.device_count, devices: [...state.devices],
        grants: [...state.grants], generation: state.grant_generation,
        balances: [...state.unshielded_balances], inboxCount: state.inbox_count,
        pending: state.pending_recovery, encKey: state.enc_key,
      }, (_, value) => typeof value === 'bigint' ? value.toString() : value);
    };
    const issue = async (index: number, owner: JubjubDevice) => {
      const grant = grants[index];
      await gs.authorised('issue_grant',
        (ctx, d) => jubjubChallenges.issueGrant(ctx, d.pk, grant.id, scopeDigest(grant.salt, scope)),
        [grant.id, ...scopeArgs(scope), grant.salt], owner);
      assert(gs.ledger().grants.lookup(grant.id).epoch === gs.ledger().device_epoch,
        `grant ${index} receives the contract's current epoch`);
    };
    const signedSpend = (index: number) => {
      const grant = grants[index], record = gs.ledger().grants.lookup(grant.id);
      const ctx = { contractAddress: gs.address, grantId: grant.id, issuedAt: record.issued_at, grantNonce: record.nonce };
      const auth = grant.grantee.arm === 'jubjub'
        ? grant.grantee.sign(jubjubGrantChallenges.withdrawUnshielded(ctx, grant.grantee.pk, color, 5n, recipient))
        : grant.grantee.sign(k256GrantChallenges.withdrawUnshielded(ctx, grant.grantee.pk, color, 5n, recipient));
      const opening = openingOf(scope, grant.salt, origin, grant.slot);
      return (currentOpening = opening) => gs.call(`withdraw_unshielded_with_grant_${auth.arm}`, color, 5n, { bytes: recipient }, ...grantAuthArgs(currentOpening, auth));
    };
    const refuse = async (index: number, label: string) => {
      const before = snapshot();
      await rejects(signedSpend(index), 'grant epoch stale', label);
      assert(snapshot() === before, `${label}: all tracked state unchanged`);
    };

    step('grant slot isolation: revoking one slot leaves the same key’s other slot usable');
    for (const grantee of delegates) {
      const entries = [64n, 65n].map(slot => ({
        slot, salt: new Uint8Array(randomBytes(32)),
        id: grantee.grantId(gs.address, origin, slot),
      }));
      for (const entry of entries) {
        await gs.authorised('issue_grant',
          (ctx, d) => jubjubChallenges.issueGrant(ctx, d.pk, entry.id, scopeDigest(entry.salt, scope)),
          [entry.id, ...scopeArgs(scope), entry.salt]);
      }
      const spendSlot = async (entry: typeof entries[number]) => {
        const record = gs.ledger().grants.lookup(entry.id);
        const ctx = { contractAddress: gs.address, grantId: entry.id, issuedAt: record.issued_at, grantNonce: record.nonce };
        const auth = grantee.arm === 'jubjub'
          ? grantee.sign(jubjubGrantChallenges.withdrawUnshielded(ctx, grantee.pk, color, 5n, recipient))
          : grantee.sign(k256GrantChallenges.withdrawUnshielded(ctx, grantee.pk, color, 5n, recipient));
        return gs.call(`withdraw_unshielded_with_grant_${auth.arm}`, color, 5n, { bytes: recipient },
          ...grantAuthArgs(openingOf(scope, entry.salt, origin, entry.slot), auth));
      };
      await gs.authorised('revoke_grant',
        (ctx, d) => jubjubChallenges.revokeGrant(ctx, d.pk, entries[0].id), [entries[0].id]);
      const beforeRefusal = snapshot();
      await rejects(() => spendSlot(entries[0]), 'grant revoked', `${grantee.arm}: revoked slot refuses`);
      assert(snapshot() === beforeRefusal, `${grantee.arm}: revoked slot changes no state`);
      const beforeSpend = gs.ledger();
      const deviceEntries = [...beforeSpend.devices];
      await spendSlot(entries[1]);
      const afterSpend = gs.ledger();
      assert(!afterSpend.grants.lookup(entries[0].id).active && afterSpend.grants.lookup(entries[0].id).nonce === 0n,
        `${grantee.arm}: sibling spend does not revive or advance the revoked slot`);
      assert(afterSpend.grants.lookup(entries[1].id).nonce === 1n,
        `${grantee.arm}: same key's other slot still spends`);
      assert(afterSpend.auth_nonce === beforeSpend.auth_nonce && afterSpend.device_count === beforeSpend.device_count &&
        afterSpend.devices.size() === BigInt(deviceEntries.length) && deviceEntries.every(entry => afterSpend.devices.member(entry)),
        `${grantee.arm}: slot-isolated spend preserves device authority`);
    }

    step('expiry alone does not permit overwriting an unrevoked record');
    const expiredSalt = new Uint8Array(randomBytes(32));
    const expiredId = delegates[0].grantId(gs.address, origin, 250n);
    const expiredScope = { ...scope, expiresAt: BigInt(gs.now - 60) };
    await gs.authorised('issue_grant',
      (ctx, d) => jubjubChallenges.issueGrant(ctx, d.pk, expiredId, scopeDigest(expiredSalt, expiredScope)),
      [expiredId, ...scopeArgs(expiredScope), expiredSalt]);
    const beforeExpiredReissue = snapshot();
    const renewalSalt = new Uint8Array(randomBytes(32));
    await rejects(() => gs.authorised('issue_grant',
      (ctx, d) => jubjubChallenges.issueGrant(ctx, d.pk, expiredId, scopeDigest(renewalSalt, scope)),
      [expiredId, ...scopeArgs(scope), renewalSalt]), 'grant already active',
      'expired but unrevoked record cannot be reissued');
    assert(snapshot() === beforeExpiredReissue, 'expired-record reissue refusal changes no state');

    step('cumulative spend arithmetic rejects a Uint<128> wrap with a valid spent opening');
    const maxU128 = (1n << 128n) - 1n;
    for (const grantee of delegates) {
      const wrapColor = new Uint8Array(randomBytes(32));
      const wrapScope = spendScope({ expiresAt: 0n, withdrawUnshielded: true, color: wrapColor, cap: maxU128 });
      const wrapSalt = new Uint8Array(randomBytes(32));
      const wrapSlot = 245n;
      const wrapId = grantee.grantId(gs.address, origin, wrapSlot);
      await gs.call('deposit_unshielded', wrapColor, maxU128);
      await gs.authorised('issue_grant',
        (ctx, d) => jubjubChallenges.issueGrant(ctx, d.pk, wrapId, scopeDigest(wrapSalt, wrapScope)),
        [wrapId, ...scopeArgs(wrapScope), wrapSalt]);
      const spend = async (amount: bigint, spentPrev: bigint) => {
        const record = gs.ledger().grants.lookup(wrapId);
        const ctx = { contractAddress: gs.address, grantId: wrapId, issuedAt: record.issued_at, grantNonce: record.nonce };
        const auth = grantee.arm === 'jubjub'
          ? grantee.sign(jubjubGrantChallenges.withdrawUnshielded(ctx, grantee.pk, wrapColor, amount, recipient))
          : grantee.sign(k256GrantChallenges.withdrawUnshielded(ctx, grantee.pk, wrapColor, amount, recipient));
        return gs.call(`withdraw_unshielded_with_grant_${auth.arm}`, wrapColor, amount, { bytes: recipient },
          ...grantAuthArgs({ ...openingOf(wrapScope, wrapSalt, origin, wrapSlot), spentPrev }, auth));
      };
      // Establish the near-boundary commitment through a successful spend,
      // so the next refusal cannot be attributed to a forged spent opening.
      await spend(maxU128 - 1n, 0n);
      assert(gs.ledger().grants.lookup(wrapId).nonce === 1n && gs.ledger().unshielded_balances.lookup(wrapColor) === 1n,
        `${grantee.arm}: legitimate near-maximum spend establishes the committed total`);
      const beforeWrap = snapshot();
      await rejects(() => spend(2n, maxU128 - 1n), 'cumulative cap exceeded',
        `${grantee.arm}: cumulative arithmetic rejects overflow before narrowing`);
      assert(snapshot() === beforeWrap, `${grantee.arm}: cumulative wrap refusal changes no state`);
    }

    step('shielded grant scope checks the witness coin color, not just its lookup selector');
    for (const grantee of delegates) {
      const admittedColor = new Uint8Array(randomBytes(32));
      const foreignCoin = {
        nonce: new Uint8Array(randomBytes(32)), color: new Uint8Array(randomBytes(32)),
        value: 10n, mt_index: 0n,
      };
      const foreignScope = spendScope({
        expiresAt: 0n,
        withdrawShielded: true, withdrawShieldedToContract: true,
        color: admittedColor, cap: 100n, readPkHash: new Uint8Array(randomBytes(32)),
      });
      const foreignSalt = new Uint8Array(randomBytes(32));
      const foreignSlot = 244n;
      const foreignId = grantee.grantId(gs.address, origin, foreignSlot);
      await gs.authorised('issue_grant',
        (ctx, d) => jubjubChallenges.issueGrant(ctx, d.pk, foreignId, scopeDigest(foreignSalt, foreignScope)),
        [foreignId, ...scopeArgs(foreignScope), foreignSalt]);
      // Deliberately supply an adversarial wallet-local witness. This tests
      // the circuit's object guard, before any shielded custody operation.
      const previousWitness = gs.contract.witnesses.held_coin;
      // Bypass the honest wallet's colour guard deliberately: this is a
      // circuit-negative fixture, not a valid version-2 private store.
      gs.contract.witnesses.held_coin = (ctx: any) => [ctx.privateState, foreignCoin];
      try {
        for (const toContract of [false, true]) {
          const record = gs.ledger().grants.lookup(foreignId);
          const ctx = { contractAddress: gs.address, grantId: foreignId, issuedAt: record.issued_at, grantNonce: record.nonce };
          const changeEntry = new Uint8Array(randomBytes(192));
          const encPk = gs.ledger().enc_key;
          const auth = grantee.arm === 'jubjub'
            ? grantee.sign((toContract ? jubjubGrantChallenges.withdrawShieldedToContract : jubjubGrantChallenges.withdrawShielded)(
              ctx, grantee.pk, recipient, admittedColor, 5n, changeEntry, encPk, foreignCoin))
            : grantee.sign((toContract ? k256GrantChallenges.withdrawShieldedToContract : k256GrantChallenges.withdrawShielded)(
              ctx, grantee.pk, recipient, admittedColor, 5n, changeEntry, encPk, foreignCoin));
          const circuit = `withdraw_shielded${toContract ? '_to_contract' : ''}_with_grant_${auth.arm}`;
          const beforeForeign = snapshot();
          await rejects(() => gs.call(circuit, { bytes: recipient }, admittedColor, 5n, changeEntry, encPk,
            ...grantAuthArgs(openingOf(foreignScope, foreignSalt, origin, foreignSlot), auth)),
          'scope object mismatch', `${circuit}: foreign witness color refuses`);
          assert(snapshot() === beforeForeign, `${circuit}: foreign witness refusal changes no state`);
        }
      } finally {
        gs.contract.witnesses.held_coin = previousWitness;
      }
    }

    await issue(0, gs.device);
    const successor = JubjubDevice.generate();
    const nextSecret = newRecoverySecret();
    await gs.recoverSubmit(initialSecret.field, successor, recoveryKey(nextSecret.field).pk, BigInt(gs.now));
    await issue(1, gs.device);
    assert(gs.ledger().pending_recovery, 'second grant was issued while recovery was pending');
    const originalGrantEpoch = gs.ledger().device_epoch;
    const preFinalise = gs.ledger();
    const originalDeviceEntries = [...preFinalise.devices];
    gs.advanceTime(Number(WINDOW) + 60);
    await gs.call('recover_finalise');
    gs.adoptRecoveredDevice(successor);
    assert(gs.ledger().auth_nonce === preFinalise.auth_nonce + 1n, 'recovery advances the device nonce once');
    assert(gs.ledger().device_epoch === originalGrantEpoch + 1n, 'recovery advances the grant-invalidating epoch');
    assert(originalDeviceEntries.every(entry => !gs.ledger().devices.member(entry)), 'recovery retires every previous device entry');
    for (let i = 0; i < grants.length; i++) await refuse(i, `grant ${i} cannot spend after recovery`);

    // A second recovery must not make an un-reissued old record eligible.
    const finalDevice = JubjubDevice.generate();
    await gs.recoverSubmit(nextSecret.field, finalDevice, recoveryKey(newRecoverySecret().field).pk, BigInt(gs.now));
    gs.advanceTime(Number(WINDOW) + 60);
    await gs.call('recover_finalise');
    gs.adoptRecoveredDevice(finalDevice);
    assert(gs.ledger().devices.size() === 1n && gs.ledger().device_count === 1n &&
      gs.ledger().devices.member(finalDevice.entryAt(gs.address, gs.ledger().device_epoch, 0n)),
      'second recovery retains exactly its authorised successor');
    for (let i = 0; i < grants.length; i++) {
      await refuse(i, `grant ${i} cannot revive at a later epoch`);
      assert(gs.ledger().grants.lookup(grants[i].id).epoch === originalGrantEpoch,
        `grant ${i} retains its contract-assigned issuance epoch`);
    }

    for (let i = 0; i < grants.length; i++) {
      const grant = grants[i];
      const oldCall = signedSpend(i);
      const oldIssuedAt = gs.ledger().grants.lookup(grant.id).issued_at;
      await gs.authorised('revoke_grant', (ctx, d) => jubjubChallenges.revokeGrant(ctx, d.pk, grant.id), [grant.id], finalDevice);
      grant.salt = new Uint8Array(randomBytes(32));
      await issue(i, finalDevice);
      assert(gs.ledger().grants.lookup(grant.id).issued_at > oldIssuedAt, 'successor re-issuance is a new incarnation');
      const beforeOld = snapshot();
      await rejects(() => oldCall(openingOf(scope, grant.salt, origin, grant.slot)), /invalid grant signature|range error/,
        'pre-recovery signature cannot spend a new incarnation even with its fresh opening');
      assert(snapshot() === beforeOld, 'old-incarnation refusal changes no tracked state');
      const before = gs.ledger();
      const deviceEntries = [...before.devices];
      await signedSpend(i)();
      const after = gs.ledger();
      assert(after.grants.lookup(grant.id).nonce === 1n, 'fresh successor-issued grant spends once');
      assert(after.auth_nonce === before.auth_nonce && after.device_count === before.device_count,
        'grant spend preserves the device nonce and count');
      assert(deviceEntries.length === Number(after.devices.size()) && deviceEntries.every(entry => after.devices.member(entry)),
        'grant spend preserves every device entry');
      assert(after.round === before.round + 1n && after.unshielded_balances.lookup(color) === before.unshielded_balances.lookup(color) - 5n,
        'fresh grant advances only its spend state and account round');
    }
  }

});
