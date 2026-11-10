// Client regressions over real generated entry derivations. Most discovery
// cases use a snapshot membership provider; the final cases execute actual
// generated account circuits. No proof server, browser, or node is exercised.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CustodyAccount, DeviceCounterCursorError, DeviceCounterSearchExhaustedError,
  type DeviceCounterCursor, type DeviceCounterHint, type DeviceCounterSearchResult,
} from '../wallet/account.js';
import { JubjubDevice, K256Device, P256Device, authArgs, jubjubChallenges, type AnyDevice } from '../wallet/signer.js';
import { bytesToHex } from '../wallet/hex.js';
import { AccountSim } from './sim.js';
import { emptyCoinStore } from '../wallet/witnesses.js';
import { softwarePasskey, TEST_ORIGIN, TEST_RP } from './p256-fixtures.js';

const MAX = (1n << 64n) - 1n;
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Exercise the real constructor and its initial empty roster. The private
// constructor is reached reflectively only to replace network transport.
function client(address: Uint8Array, ledgerState: () => unknown, callTx: object = {}): CustodyAccount {
  let privateState = emptyCoinStore();
  const providers = { privateStateProvider: { get: async () => privateState, set: async (_id: string, state: typeof privateState) => { privateState = state; } } };
  const account = Reflect.construct(CustodyAccount, [bytesToHex(address), address, providers, 'test', { callTx }]) as CustodyAccount;
  account.ledgerState = async () => ledgerState() as any;
  return account;
}

function membership() {
  const address = new Uint8Array(32).fill(7);
  let epoch = 0n, authNonce = 0n, probes = 0;
  const entries = new Set<string>();
  const state = () => {
    const snapshot = new Set(entries);
    return { device_epoch: epoch, auth_nonce: authNonce, devices: {
      member: (entry: Uint8Array) => { probes++; return snapshot.has(bytesToHex(entry)); },
    } };
  };
  return {
    address, account: client(address, state), fresh: () => client(address, state),
    put: (device: AnyDevice, counter: bigint) => entries.add(bytesToHex(device.entryAt(address, epoch, counter))),
    clear: () => entries.clear(),
    changeEpoch: () => { epoch++; authNonce++; entries.clear(); },
    changeNonce: () => { authNonce++; },
    probes: () => probes,
  };
}

function exhausted(result: DeviceCounterSearchResult): DeviceCounterCursor {
  assert.equal(result.status, 'exhausted');
  if (result.status !== 'exhausted') throw new Error('expected exhausted page');
  assert.ok(result.cursor);
  return jsonCopy(result.cursor);
}

test('fresh pages cover 4095, 4096, and 20000, and survive a client restart', async () => {
  const device = new JubjubDevice(11n);
  for (const counter of [4095n, 4096n, 20000n]) {
    const h = membership(); h.put(device, counter);
    let account = h.account;
    let result = await account.discoverUseCounter(device);
    let pages = 1;
    while (result.status === 'exhausted') {
      assert.equal(result.probes, 4096);
      const cursor = exhausted(result);
      account = h.fresh();
      result = await account.discoverUseCounter(device, { cursor });
      pages++;
    }
    assert.equal(result.counter, counter);
    assert.equal(h.probes(), Number(counter) + 1);
    assert.equal(pages, Number(counter / 4096n) + 1);
    const restored = await h.fresh().discoverUseCounter(device, { hint: jsonCopy(result.hint), maxProbes: 1 });
    assert.equal(restored.status, 'found');
    assert.equal(restored.probes, 1);
  }
});

test('missing entries report bounded exhaustion, not non-registration', async () => {
  const h = membership(), device = new JubjubDevice(12n);
  await assert.rejects(() => h.account.resolveUseCounter(device, { maxProbes: 3 }), (error: unknown) => {
    assert.ok(error instanceof DeviceCounterSearchExhaustedError);
    assert.equal(error.result.probes, 3);
    assert.equal(error.result.cursor?.nextCounter, '3');
    assert.match(error.message, /registration is undetermined/);
    return true;
  });
  assert.equal(h.probes(), 3);
  for (const maxProbes of [0, -1, 1.5, 4097, NaN, Infinity]) {
    await assert.rejects(() => h.account.discoverUseCounter(device, { maxProbes }), RangeError);
  }
  assert.equal(h.probes(), 3);
});

test('full K256 envelopes and both P256 policy fields isolate cached counters', async () => {
  const passkey = softwarePasskey();
  const originVariant = new P256Device(passkey.pk, TEST_RP, 'http://localhost:8974', passkey.assertion);
  const rpVariant = new P256Device(passkey.pk, TEST_RP, TEST_ORIGIN, passkey.assertion);
  rpVariant.policy.rp_id_hash[0] ^= 1; // Entry derivation binds the complete opaque policy.
  const groups: AnyDevice[][] = [
    [new K256Device(13n, 0n), new K256Device(13n, 1n)],
    [passkey.device, originVariant, rpVariant],
  ];
  for (const devices of groups) {
    const h = membership();
    devices.forEach((device, index) => h.put(device, BigInt(9 - index * 4)));
    for (let turn = 0; turn < 2; turn++) {
      for (const [index, device] of devices.entries()) {
        const result = await h.account.discoverUseCounter(device);
        assert.equal(result.status, 'found');
        if (result.status === 'found') assert.equal(result.counter, BigInt(9 - index * 4));
        if (turn) assert.equal(result.probes, 1);
      }
    }
    const hint = h.account.deviceCounterHint(devices[0])!;
    await assert.rejects(() => h.account.discoverUseCounter(devices[1], { hint }), DeviceCounterCursorError);
  }
});

test('stale high hints support both forward advancement and lower-counter resumption', async () => {
  const h = membership(), device = new JubjubDevice(14n);
  h.put(device, 9000n);
  let result = await h.account.discoverUseCounter(device);
  while (result.status === 'exhausted') result = await h.account.discoverUseCounter(device, { cursor: exhausted(result) });
  const highHint = h.account.deviceCounterHint(device)!;
  h.clear(); h.put(device, 9001n);
  result = await h.account.discoverUseCounter(device);
  assert.equal(result.status, 'found'); assert.equal(result.probes, 3);
  h.clear(); h.put(device, 0n);
  result = await h.account.discoverUseCounter(device);
  assert.equal(result.status, 'found'); assert.equal(result.probes, 2);
  h.clear(); h.put(device, 13n);
  result = await h.account.discoverUseCounter(device, { hint: highHint, maxProbes: 4 });
  let previousEnd = 0n;
  while (result.status === 'exhausted') {
    assert.ok(result.probes <= 4);
    assert.ok(result.toCounter > previousEnd);
    previousEnd = result.toCounter;
    result = await h.fresh().discoverUseCounter(device, { cursor: exhausted(result), maxProbes: 4 });
  }
  assert.equal(result.counter, 13n);
});

test('cursor and hint scope, epoch, and numeric bounds are checked', async () => {
  const h = membership(), device = new JubjubDevice(15n), other = new JubjubDevice(16n);
  const cursor = exhausted(await h.account.discoverUseCounter(device, { maxProbes: 1 }));
  const malformed = [
    { ...cursor, version: 2 }, { ...cursor, account: '00' }, { ...cursor, epoch: '-1' },
    { ...cursor, epoch: '01' }, { ...cursor, nextCounter: (MAX + 1n).toString() },
    { ...cursor, nextCounter: '1e3' }, { ...cursor, nextCounter: 1 },
  ];
  for (const value of malformed) await assert.rejects(
    () => h.account.discoverUseCounter(device, { cursor: value as DeviceCounterCursor }), DeviceCounterCursorError,
  );
  await assert.rejects(() => h.account.discoverUseCounter(other, { cursor }), DeviceCounterCursorError);
  h.changeNonce();
  const resumed = await h.account.discoverUseCounter(device, { cursor, maxProbes: 1 });
  assert.equal(resumed.status, 'exhausted');
  if (resumed.status === 'exhausted') assert.equal(resumed.fromCounter, 1n);
  const current = exhausted(await h.account.discoverUseCounter(device, { maxProbes: 1 }));
  h.changeEpoch(); h.put(device, 0n);
  await assert.rejects(() => h.account.discoverUseCounter(device, { cursor: current }), /epoch changed/);
  const oldHint: DeviceCounterHint = { version: 1, account: cursor.account, credential: cursor.credential, epoch: '0', counter: '9000' };
  const result = await h.account.discoverUseCounter(device, { hint: oldHint, maxProbes: 1 });
  assert.equal(result.status, 'found'); assert.equal(result.probes, 1);
  await assert.rejects(() => h.account.discoverUseCounter(device, { cursor, hint: oldHint }), /not both/);
  await assert.rejects(() => h.account.discoverUseCounter(device, { hint: { ...oldHint, account: '00' } }), DeviceCounterCursorError);
  await assert.rejects(() => h.account.discoverUseCounter(device, { hint: { ...oldHint, counter: '-1' } }), DeviceCounterCursorError);
});

test('Uint64 end is bounded and never produces an overflowing cursor', async () => {
  const h = membership(), device = new JubjubDevice(17n);
  const cursor = exhausted(await h.account.discoverUseCounter(device, { maxProbes: 1 }));
  cursor.nextCounter = MAX.toString();
  let result = await h.account.discoverUseCounter(device, { cursor });
  assert.equal(result.status, 'exhausted'); assert.equal(result.probes, 1);
  if (result.status === 'exhausted') { assert.equal(result.cursor, null); assert.equal(result.toCounter, MAX + 1n); }
  h.put(device, MAX);
  result = await h.account.discoverUseCounter(device, { cursor });
  assert.equal(result.status, 'found'); assert.equal(result.probes, 1);
});

test('legacy registration resets hints without assigning a signing profile', async () => {
  const h = membership(), device = new K256Device(18n, 1n);
  const unrelated = new JubjubDevice(25n);
  h.put(unrelated, 5000n);
  let found = await h.account.discoverUseCounter(unrelated);
  while (found.status === 'exhausted') found = await h.account.discoverUseCounter(unrelated, { cursor: exhausted(found) });
  h.put(device, 9n); await h.account.resolveUseCounter(device);
  h.clear(); h.put(device, 0n); h.put(unrelated, 5000n);
  h.account.registerDevice(device.pk);
  assert.equal(await h.account.resolveUseCounter(device, { maxProbes: 1 }), 0n);
  assert.equal(await h.account.resolveUseCounter(unrelated, { maxProbes: 1 }), 5000n);
});

function simulationClient(sim: AccountSim): CustodyAccount {
  let calls = 0;
  const callTx = new Proxy({}, { get: (_, name: string) => async (...args: unknown[]) => {
    const result = await sim.call(name, ...args);
    return { public: { txId: `simulated-${++calls}` }, private: { result } };
  } });
  return client(sim.address, () => sim.ledger(), callTx);
}

test('fresh discovery authorises real simulated calls and resynchronises after another client acts', async () => {
  const sim = await AccountSim.create({ initialRecoveryPk: new JubjubDevice(19n).pk, initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
  const device = new JubjubDevice(20n), entry = device.entryAt(sim.address, 0n, 8193n);
  await sim.authorised('add_device', (ctx, owner) => jubjubChallenges.addDevice(ctx, owner.pk, entry), [entry]);
  const account = simulationClient(sim);
  let result = await account.discoverUseCounter(device);
  while (result.status === 'exhausted') {
    const key = new Uint8Array(32).fill(8);
    await sim.authorised('rotate_enc_key', (ctx, owner) => jubjubChallenges.rotateEncKey(ctx, owner.pk, key), [key]);
    result = await account.discoverUseCounter(device, { cursor: exhausted(result) });
  }
  assert.equal(result.counter, 8193n);
  await account.rotateEncKey(device, new Uint8Array(32).fill(1));
  assert.equal(account.deviceCounterHint(device)?.counter, '8194');
  const key = new Uint8Array(32).fill(2);
  const auth = device.sign(jubjubChallenges.rotateEncKey(sim.callContext(), device.pk, key), 8194n);
  await sim.call('rotate_enc_key_with_jubjub', key, ...authArgs(auth));
  await account.rotateEncKey(device, new Uint8Array(32).fill(3));
  assert.equal(account.deviceCounterHint(device)?.counter, '8196');
  assert.ok(sim.ledger().devices.member(device.entryAt(sim.address, 0n, 8196n)));
  const restarted = simulationClient(sim);
  await restarted.resolveUseCounter(device, { hint: jsonCopy(account.deviceCounterHint(device)!), maxProbes: 1 });
  await restarted.rotateEncKey(device, new Uint8Array(32).fill(4));
  assert.ok(sim.ledger().devices.member(device.entryAt(sim.address, 0n, 8197n)));
});

test('lost-device removal works with independently restored high-counter owner and target', async () => {
  const sim = await AccountSim.create({ initialRecoveryPk: new JubjubDevice(21n).pk, initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
  const target = new JubjubDevice(22n), entry = target.entryAt(sim.address, 0n, 4096n);
  await sim.authorised('add_device', (ctx, owner) => jubjubChallenges.addDevice(ctx, owner.pk, entry), [entry]);
  const owner = new JubjubDevice(26n), ownerEntry = owner.entryAt(sim.address, 0n, 8192n);
  await sim.authorised('add_device', (ctx, initial) => jubjubChallenges.addDevice(ctx, initial.pk, ownerEntry), [ownerEntry]);
  const account = simulationClient(sim);
  let ownerPosition = await account.discoverUseCounter(owner);
  while (ownerPosition.status === 'exhausted') {
    ownerPosition = await account.discoverUseCounter(owner, { cursor: exhausted(ownerPosition) });
  }
  let cursor: DeviceCounterCursor;
  await assert.rejects(() => account.removeDevice(owner, target), (error: unknown) => {
    assert.ok(error instanceof DeviceCounterSearchExhaustedError);
    cursor = exhausted(error.result); return true;
  });
  await account.removeDevice(owner, target, { cursor: cursor! });
  assert.equal(sim.ledger().devices.member(entry), false);
  await account.rotateEncKey(owner, new Uint8Array(32).fill(5));
});

test('local and external recovery reset a reused successor in the existing client', async () => {
  for (const local of [true, false]) {
    const recovery = new JubjubDevice(23n);
    const sim = await AccountSim.create({ initialRecoveryPk: recovery.pk, initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
    const account = simulationClient(sim);
    await account.rotateEncKey(sim.device, new Uint8Array(32).fill(6));
    assert.equal(account.deviceCounterHint(sim.device)?.counter, '1');
    await sim.recoverSubmit(recovery, sim.device, new JubjubDevice(24n).pk, BigInt(sim.now + 1));
    sim.advanceTime(3);
    if (local) await account.recoverFinalise();
    else await sim.call('recover_finalise');
    await account.rotateEncKey(sim.device, new Uint8Array(32).fill(7));
    assert.equal(sim.ledger().device_epoch, 1n);
    assert.ok(sim.ledger().devices.member(sim.device.entryAt(sim.address, 1n, 1n)));
    assert.equal(account.deviceCounterHint(sim.device)?.epoch, '1');
  }
});
