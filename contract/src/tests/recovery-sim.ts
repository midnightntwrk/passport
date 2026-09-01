// Recovery circuit behaviour matrix, in the simulator with explicit
// wall-clock control. Covers the recovery MIP's Testing section minus the
// on-node items: session freshness and slot gating (§5), the two-phase
// gate with pending exclusivity (§6), successor-key validation, the veto
// window and cancel (REC-9), the epoch bump (AUTH-6), and the wrap
// round-trip through the ledger (REC-7).

import { randomBytes } from 'node:crypto';

import { runScenario, step } from './runner.js';
import { AccountSim } from './sim.js';
import { pureCircuits } from '../wallet/contract.js';
import { JubjubDevice, jubjubChallenges } from '../wallet/signer.js';
import { armRecoverySecret, disarmRecoverySecret } from '../wallet/witnesses.js';
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

async function rejects(f: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  try {
    await f();
  } catch (e) {
    const msg = String(e);
    if (!msg.includes(needle)) {
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
  const commitment = pureCircuits.derive_recovery_commitment(s.bytes);
  const wrap = sealWrap(s.bytes, sim.address, encSecret);
  const phiTuple = [phi[0], phi[1], 0n, 0n] as const;
  await sim.authorised(
    'publish_recovery_session',
    (ctx, d) => jubjubChallenges.publishRecoverySession(ctx, d.pk, commitment, sid, phiTuple, 2n, wrap),
    [commitment, sid, phi[0], phi[1], 0n, 0n, 2n, wrap],
    device,
  );
  return { secretBytes: s.bytes, sid, phi, shares, t };
}

/** Reconstruct s from the on-chain phi and a quorum, then submit. */
async function submitRecovery(
  sim: AccountSim,
  session: SessionArtefacts,
  successor: JubjubDevice,
  successorCommitment: Uint8Array,
): Promise<void> {
  const l = sim.ledger();
  const phiOnChain: bigint[] = [];
  for (let k = 1n; k <= l.recovery_phi_len; k++) phiOnChain.push(l.recovery_phi.lookup(k));
  const s = reconstruct(phiOnChain, session.shares.slice(0, session.t + 1), session.t);
  armRecoverySecret(fieldToBytes(s));
  try {
    await sim.call(
      'recover_submit',
      successor.sk,
      successorCommitment,
      l.device_epoch,
      l.auth_nonce,
      BigInt(sim.now),
    );
  } finally {
    disarmRecoverySecret();
  }
}

await runScenario('recovery-sim', async () => {
  const encSecret = new Uint8Array(randomBytes(32));
  const birth = newRecoverySecret();
  const mkSim = () =>
    AccountSim.create({
      vetoWindowSeconds: WINDOW,
      initialRecoveryCommitment: pureCircuits.derive_recovery_commitment(birth.bytes),
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
    const commitment2 = pureCircuits.derive_recovery_commitment(s2.bytes);
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
    const storedCommitment = sim.ledger().recovery;
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
  }

  step('slot gating: unused slots must be zero (§8)');
  {
    const s3 = newRecoverySecret();
    const c3 = pureCircuits.derive_recovery_commitment(s3.bytes);
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
  }

  step('unauthorised publish: no valid device, no state change (Testing)');
  {
    const stranger = JubjubDevice.generate();
    const s4 = newRecoverySecret();
    const c4 = pureCircuits.derive_recovery_commitment(s4.bytes);
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

  step('successor-key validation by possession (§6 step 4, Testing)');
  {
    // The circuit takes the successor private scalar and derives the key
    // in-circuit: a generator multiple of a non-zero scalar is a valid
    // non-identity subgroup element by construction, and a key nobody
    // can sign for cannot be enrolled at all.
    const l5 = sim.ledger();
    armRecoverySecret(session.secretBytes);
    try {
      await rejects(
        () => sim.call('recover_submit', 0n, new Uint8Array(randomBytes(32)), l5.device_epoch, l5.auth_nonce, BigInt(sim.now)),
        'successor scalar is zero',
        'the zero scalar (the identity element) is rejected',
      );
    } finally {
      disarmRecoverySecret();
    }
    assert(sim.ledger().pending_recovery === false, 'the rejected submission wrote no pending state');
  }

  step('the gate: wrong secret refused, right secret records the pending recovery (§6)');
  {
    const successor = JubjubDevice.generate();
    const successorSecret = newRecoverySecret();
    const successorCommitment = pureCircuits.derive_recovery_commitment(successorSecret.bytes);
    const l6 = sim.ledger();
    armRecoverySecret(newRecoverySecret().bytes);
    try {
      await rejects(
        () => sim.call('recover_submit', successor.sk, successorCommitment, l6.device_epoch, l6.auth_nonce, BigInt(sim.now)),
        'invalid recovery secret',
        'a wrong secret fails the gate (REC-1)',
      );
    } finally {
      disarmRecoverySecret();
    }
    await submitRecovery(sim, session, successor, successorCommitment);
    l = sim.ledger();
    assert(l.pending_recovery === true, 'pending record present');
    assert(l.device_epoch === l6.device_epoch, 'submission does not bump the epoch');

    step('pending exclusivity: no displacement, no session (§5, §6 step 4)');
    armRecoverySecret(session.secretBytes);
    try {
      await rejects(
        () => sim.call('recover_submit', JubjubDevice.generate().sk, new Uint8Array(randomBytes(32)), l.device_epoch, l.auth_nonce, BigInt(sim.now)),
        'recovery already pending',
        'a second submission is rejected while one is pending',
      );
    } finally {
      disarmRecoverySecret();
    }
    const s7 = newRecoverySecret();
    const c7 = pureCircuits.derive_recovery_commitment(s7.bytes);
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
    armRecoverySecret(session.secretBytes);
    try {
      await rejects(
        () => sim.call('recover_submit', successor.sk, successorCommitment, l.device_epoch, nonceBeforeCancel, BigInt(sim.now)),
        'stale authorisation nonce',
        'a cancelled submission cannot be replayed (the nonce advanced)',
      );
    } finally {
      disarmRecoverySecret();
    }
    await rejects(() => sim.call('recover_finalise'), 'no recovery pending', 'nothing to finalise after a cancel');
  }

  step('total loss end to end: submit, wait out the window, finalise (§6, REC-8)');
  {
    const successor = JubjubDevice.generate();
    const successorSecret = newRecoverySecret();
    const successorCommitment = pureCircuits.derive_recovery_commitment(successorSecret.bytes);
    const epochBefore = sim.ledger().device_epoch;

    // The recovering wallet reconstructs, opens the wrap (REC-7), and only
    // then submits — s is discarded before the window opens (REC-6).
    const lNow = sim.ledger();
    const phiOnChain: bigint[] = [];
    for (let k = 1n; k <= lNow.recovery_phi_len; k++) phiOnChain.push(lNow.recovery_phi.lookup(k));
    const sRec = reconstruct(phiOnChain, session.shares.slice(0, 2), session.t);
    assert(
      eqBytes(pureCircuits.derive_recovery_commitment(fieldToBytes(sRec)), lNow.recovery),
      'reconstructed secret matches the stored commitment',
    );
    const recoveredVk = openWrap(fieldToBytes(sRec), sim.address, lNow.recovery_wrap);
    assert(recoveredVk !== null && eqBytes(recoveredVk, encSecret), 'the wrap restores the encryption secret (REC-7)');
    assert(fieldFromBytes(fieldToBytes(sRec)) === sRec, 'witness form is canonical');
    await submitRecovery(sim, session, successor, successorCommitment);

    sim.advanceTime(Number(WINDOW) + 60);
    await sim.call('recover_finalise');
    l = sim.ledger();
    assert(l.device_epoch === epochBefore + 1n, 'finalisation bumps the device epoch');
    assert(l.device_count === 1n, 'exactly one device at the new epoch (MIP-0013 §8c)');
    assert(l.pending_recovery === false, 'pending record cleared');
    assert(l.recovery_phi_len === 0n, 'the published vector is retired with its secret');
    assert(eqBytes(l.recovery, successorCommitment), 'the gate commitment rotated to the successor');

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
