// Recovery circuit behaviour matrix, in the simulator with explicit
// wall-clock control. Covers the recovery MIP's Testing section minus the
// on-node items: session freshness and slot gating (§5), the two-phase
// gate with pending exclusivity (§6), successor-key validation, the veto
// window and cancel (REC-9), the epoch bump (AUTH-6), and the wrap
// round-trip through the ledger (REC-7).

import { randomBytes } from 'node:crypto';

import { runScenario, step } from './runner.js';
import { AccountSim } from './sim.js';
import type { JubjubPoint } from '../wallet/contract.js';
import { JubjubDevice, jubjubChallenges, JUBJUB_R } from '../wallet/signer.js';
import {
  recoveryKey,
  matchesRecoveryPk,
  eqPoint,
  readArtefactSet,
  JUBJUB_IDENTITY,
  JUBJUB_ORDER_TWO,
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
      // verification s·G == R + c·O holds for every challenge. A "device"
      // whose scalar is zero produces exactly that pair, with a genuine
      // co-signature from the successor.
      const forger = new JubjubDevice(0n);
      assert(eqPoint(forger.pk, JUBJUB_IDENTITY), 'the forger presents the identity as its key');
      await rejects(
        () => weak.recoverSubmit(forger, JubjubDevice.generate(), recoveryKey(newRecoverySecret().field).pk, BigInt(weak.now)),
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
    await sim.call('recover_finalise');
    l = sim.ledger();
    assert(l.device_epoch === epochBefore + 1n, 'finalisation bumps the device epoch');
    assert(l.auth_nonce === nonceBeforeFinalise + 1n, 'finalisation advances the authorisation nonce (MIP-0013 §8 d)');
    assert(l.round === roundBeforeFinalise + 1n, 'finalisation advances the round counter');
    assert(l.device_count === 1n, 'exactly one device at the new epoch (MIP-0013 §8c)');
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
});
