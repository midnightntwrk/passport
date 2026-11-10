// Dormant-account recovery regressions against the generated Compact runtime.
// These exercise the constructor, all bootstrap arms, recovery signatures,
// device membership, and explicit block time. They do not generate ZK proofs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { AccountSim } from './sim.js';
import { softwarePasskey } from './p256-fixtures.js';
import {
  authArgs, JubjubDevice, K256Device, jubjubChallenges, k256Challenges,
  type AnyDevice,
} from '../wallet/signer.js';
import { p256Challenges } from '../wallet/signer-p256.js';

const bytes = (length = 32) => new Uint8Array(randomBytes(length));
const zero32 = new Uint8Array(32);
const WINDOW = 10n;
const profiles: { name: string; device: () => AnyDevice }[] = [
  { name: 'JubJub', device: () => JubjubDevice.generate() },
  { name: 'K256, raw envelope', device: () => K256Device.generate() },
  { name: 'K256, connector envelope', device: () => K256Device.generateConnector() },
  { name: 'P256', device: () => softwarePasskey().device },
];

async function dormant(original: AnyDevice) {
  const salt = bytes();
  const recovery = JubjubDevice.generate();
  const nextRecovery = JubjubDevice.generate();
  const successor = JubjubDevice.generate();
  const sim = await AccountSim.createDormant({
    initialRecoveryPk: recovery.pk,
    initialWrap: bytes(64),
    vetoWindowSeconds: WINDOW,
  }, original.bootCommitment(salt));
  assert.equal(sim.ledger().booted, false);
  assert.deepEqual(sim.ledger().boot, original.bootCommitment(salt));
  assertDevices(sim, []);
  return { sim, original, salt, recovery, nextRecovery, successor };
}

async function activate(sim: AccountSim, device: AnyDevice, salt: Uint8Array) {
  const extra = device.arm === 'k256' ? [device.envelope]
    : device.arm === 'p256' ? [device.policy] : [];
  return sim.call(`activate_initial_device_with_${device.arm}`, device.pk, salt, ...extra);
}

async function rotate(sim: AccountSim, device: AnyDevice, counter: bigint, key = bytes()) {
  const ctx = sim.callContext();
  const auth = device.arm === 'jubjub'
    ? device.sign(jubjubChallenges.rotateEncKey(ctx, device.pk, key), counter)
    : device.arm === 'k256'
      ? device.sign(k256Challenges.rotateEncKey(ctx, device.pk, key), counter)
      : await device.sign(p256Challenges.rotateEncKey(ctx, device.pk, key), counter);
  await sim.call(`rotate_enc_key_with_${device.arm}`, key, ...authArgs(auth));
  assert.deepEqual(sim.ledger().enc_key, key);
}

async function cancel(sim: AccountSim, device: AnyDevice, counter: bigint) {
  const ctx = sim.callContext();
  const auth = device.arm === 'jubjub'
    ? device.sign(jubjubChallenges.recoverCancel(ctx, device.pk), counter)
    : device.arm === 'k256'
      ? device.sign(k256Challenges.recoverCancel(ctx, device.pk), counter)
      : await device.sign(p256Challenges.recoverCancel(ctx, device.pk), counter);
  await sim.call(`recover_cancel_with_${device.arm}`, ...authArgs(auth));
}

async function submit(f: Awaited<ReturnType<typeof dormant>>) {
  await f.sim.recoverSubmit(f.recovery, f.successor, f.nextRecovery.pk, BigInt(f.sim.now));
  assert.equal(f.sim.ledger().pending_recovery, true);
}

function assertDevices(sim: AccountSim, expected: Uint8Array[]) {
  const l = sim.ledger();
  assert.equal(l.device_count, BigInt(expected.length), 'device_count matches the expected membership');
  assert.equal(l.devices.size(), BigInt(expected.length), 'actual set size matches device_count');
  const hex = (entry: Uint8Array) => Buffer.from(entry).toString('hex');
  assert.deepEqual([...l.devices].map(hex).sort(), expected.map(hex).sort(), 'exact live device set');
  for (const entry of expected) assert.ok(l.devices.member(entry));
}

function snapshot(sim: AccountSim): string {
  const l = sim.ledger();
  return JSON.stringify({
    boot: l.boot, booted: l.booted, epoch: l.device_epoch,
    count: l.device_count, devices: [...l.devices], nonce: l.auth_nonce, round: l.round,
    pending: l.pending_recovery, pendingEntry: l.pending_entry,
    pendingKey: l.pending_recovery_pk, pendingTime: l.pending_not_before,
    recoveryKey: l.recovery_pk, phi: [...l.recovery_phi], phiLength: l.recovery_phi_len,
    session: l.recovery_session, wrap: l.recovery_wrap, version: l.recovery_version,
    vetoWindow: l.veto_window, encKey: l.enc_key,
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value);
}

async function rejectsUnchanged(sim: AccountSim, call: () => Promise<unknown>, error: RegExp) {
  const before = snapshot(sim);
  await assert.rejects(call, error);
  assert.equal(snapshot(sim), before, 'a rejected call preserves all bootstrap, device, and recovery state');
}

function assertConsumed(sim: AccountSim) {
  assert.equal(sim.ledger().booted, true, 'bootstrap authority is permanently consumed');
  assert.deepEqual(sim.ledger().boot, zero32, 'the initial boot commitment is erased');
}

for (const profile of profiles) {
  test(`${profile.name}: dormant recovery admits only the successor across later operations and recovery`, async () => {
    const f = await dormant(profile.device());
    const { sim, original, salt, successor, nextRecovery } = f;
    await submit(f);
    sim.advanceTime(Number(WINDOW));
    await sim.call('recover_finalise');

    // Try the original attack before inspecting the new fields: the old
    // runtime accepts this activation and fails this negative control.
    await rejectsUnchanged(sim, () => activate(sim, original, salt), /already activated/);
    assertConsumed(sim);
    assert.equal(sim.ledger().device_epoch, 1n);
    assert.equal(sim.ledger().auth_nonce, 1n);
    assert.deepEqual(sim.ledger().recovery_pk, nextRecovery.pk);
    assert.equal(sim.ledger().pending_recovery, false);
    assertDevices(sim, [successor.entryAt(sim.address, 1n, 0n)]);
    await rejectsUnchanged(sim, () => rotate(sim, original, 0n), /unknown device entry/);

    await rotate(sim, successor, 0n);
    assertDevices(sim, [successor.entryAt(sim.address, 1n, 1n)]);
    await rejectsUnchanged(sim, () => activate(sim, original, salt), /already activated/);
    assertConsumed(sim);

    const enrolled = JubjubDevice.generate();
    const enrolledEntry = enrolled.entryAt(sim.address, 1n, 0n);
    const add = successor.sign(jubjubChallenges.addDevice(sim.callContext(), successor.pk, enrolledEntry), 1n);
    await sim.call('add_device_with_jubjub', enrolledEntry, ...authArgs(add));
    assertDevices(sim, [successor.entryAt(sim.address, 1n, 2n), enrolledEntry]);
    await rotate(sim, enrolled, 0n);
    assertDevices(sim, [successor.entryAt(sim.address, 1n, 2n), enrolled.entryAt(sim.address, 1n, 1n)]);
    await rejectsUnchanged(sim, () => activate(sim, original, salt), /already activated/);

    // A second legitimate recovery must retain the consumed bootstrap and
    // retire every previously live entry, including a successor-enrolled key.
    const laterSuccessor = JubjubDevice.generate();
    const laterRecovery = JubjubDevice.generate();
    await sim.recoverSubmit(nextRecovery, laterSuccessor, laterRecovery.pk, BigInt(sim.now));
    const beforeFinalise = sim.ledger();
    const previousEntries = [...beforeFinalise.devices];
    sim.advanceTime(Number(WINDOW));
    await sim.call('recover_finalise');
    assert.equal(sim.ledger().device_epoch, 2n);
    assert.equal(sim.ledger().auth_nonce, beforeFinalise.auth_nonce + 1n);
    assert.deepEqual(sim.ledger().recovery_pk, laterRecovery.pk);
    assertConsumed(sim);
    assertDevices(sim, [laterSuccessor.entryAt(sim.address, 2n, 0n)]);
    for (const entry of previousEntries) assert.equal(sim.ledger().devices.member(entry), false);
    await rejectsUnchanged(sim, () => activate(sim, original, salt), /already activated/);
    await rejectsUnchanged(sim, () => rotate(sim, successor, 2n), /unknown device entry/);
    await rejectsUnchanged(sim, () => rotate(sim, enrolled, 1n), /unknown device entry/);
    await rotate(sim, laterSuccessor, 0n);
    assertDevices(sim, [laterSuccessor.entryAt(sim.address, 2n, 1n)]);
  });

  test(`${profile.name}: only the committed key and salt can perform normal activation`, async () => {
    const f = await dormant(profile.device());
    const { sim, original, salt } = f;
    await rejectsUnchanged(sim, () => activate(sim, profile.device(), salt), /boot commitment mismatch/);
    const wrongSalt = Uint8Array.from(salt);
    wrongSalt[0] ^= 1;
    await rejectsUnchanged(sim, () => activate(sim, original, wrongSalt), /boot commitment mismatch/);
    for (const other of profiles.filter(p => p.name !== profile.name)) {
      await rejectsUnchanged(sim, () => activate(sim, other.device(), salt), /boot commitment mismatch/);
    }
    await activate(sim, original, salt);
    assertConsumed(sim);
    assert.equal(sim.ledger().device_epoch, 0n);
    assert.equal(sim.ledger().auth_nonce, 0n, 'normal activation does not touch auth_nonce');
    assert.equal(sim.ledger().round, 1n);
    assertDevices(sim, [original.entryAt(sim.address, 0n, 0n)]);
    await rotate(sim, original, 0n);
    assertDevices(sim, [original.entryAt(sim.address, 0n, 1n)]);
    await rejectsUnchanged(sim, () => activate(sim, original, salt), /already activated/);
  });

  test(`${profile.name}: premature finalisation preserves dormant bootstrap and the complete pending record`, async () => {
    const f = await dormant(profile.device());
    await rejectsUnchanged(f.sim, () => f.sim.call('recover_finalise'), /no recovery pending/);
    await submit(f);
    f.sim.advanceTime(Number(WINDOW) - 1);
    await rejectsUnchanged(f.sim, () => f.sim.call('recover_finalise'), /veto window still open/);
    assert.equal(f.sim.ledger().booted, false);
    assert.deepEqual(f.sim.ledger().boot, f.original.bootCommitment(f.salt));
    assertDevices(f.sim, []);
    // The failed finalisation must not prevent the committed device from
    // activating while it still has time to veto the pending recovery.
    await activate(f.sim, f.original, f.salt);
    assert.equal(f.sim.ledger().pending_recovery, true);
    assertDevices(f.sim, [f.original.entryAt(f.sim.address, 0n, 0n)]);
    await cancel(f.sim, f.original, 0n);
    assert.equal(f.sim.ledger().pending_recovery, false);
    assertDevices(f.sim, [f.original.entryAt(f.sim.address, 0n, 1n)]);
  });

  test(`${profile.name}: activation during pending recovery permits cancellation and normal operation`, async () => {
    const f = await dormant(profile.device());
    const { sim, original, salt, recovery } = f;
    await submit(f);
    await activate(sim, original, salt);
    assert.equal(sim.ledger().pending_recovery, true);
    assert.equal(sim.ledger().auth_nonce, 0n);
    await cancel(sim, original, 0n);
    assertConsumed(sim);
    assert.equal(sim.ledger().pending_recovery, false);
    assert.deepEqual(sim.ledger().pending_entry, zero32);
    assert.equal(sim.ledger().pending_not_before, 0n);
    assert.deepEqual(sim.ledger().recovery_pk, recovery.pk, 'cancellation preserves the recovery key');
    assert.equal(sim.ledger().device_epoch, 0n);
    assertDevices(sim, [original.entryAt(sim.address, 0n, 1n)]);
    sim.advanceTime(Number(WINDOW));
    await rejectsUnchanged(sim, () => sim.call('recover_finalise'), /no recovery pending/);
    await rotate(sim, original, 1n);
    assertDevices(sim, [original.entryAt(sim.address, 0n, 2n)]);
  });

  test(`${profile.name}: finalisation retires a device activated while recovery was pending`, async () => {
    const f = await dormant(profile.device());
    const { sim, original, salt, successor } = f;
    await submit(f);
    await activate(sim, original, salt);
    await rotate(sim, original, 0n);
    const retiredEntry = original.entryAt(sim.address, 0n, 1n);
    assertDevices(sim, [retiredEntry]);
    sim.advanceTime(Number(WINDOW));
    await sim.call('recover_finalise');
    assertConsumed(sim);
    assert.equal(sim.ledger().device_epoch, 1n);
    assert.equal(sim.ledger().devices.member(retiredEntry), false);
    assertDevices(sim, [successor.entryAt(sim.address, 1n, 0n)]);
    await rejectsUnchanged(sim, () => activate(sim, original, salt), /already activated/);
    await rejectsUnchanged(sim, () => rotate(sim, original, 1n), /unknown device entry/);
    await rotate(sim, successor, 0n);
    assertDevices(sim, [successor.entryAt(sim.address, 1n, 1n)]);
  });
}
