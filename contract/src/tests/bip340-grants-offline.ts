// Generated Compact execution in AccountSim. This suite exercises the ACC
// grant seam; it does not generate proofs or execute shielded custody sends.
import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createCallContext, createCircuitContext, type PublicAddress } from '@midnight-ntwrk/compact-runtime';
import { AccountSim } from './sim.js';
import { pureCircuits, type QualifiedCoin } from '../wallet/contract.js';
import {
  Bip340Grantee, JubjubDevice, K256Device, K256Grantee,
  authArgs, bip340GrantChallenges, grantAuthArgs, jubjubChallenges,
  k256Challenges, k256GrantChallenges, openingOf, originHash, readOnlyScope,
  RECIPIENT_USER_ADDRESS, RECIPIENT_ZSWAP_COIN_PUBLIC_KEY, RECIPIENT_CONTRACT_ADDRESS,
  SECP256K1_N, scopeArgs, scopeDigest, spendScope,
  type GrantContext, type GrantOpening, type PlainScope,
} from '../wallet/signer.js';
import { withCoin } from '../wallet/witnesses.js';

const rnd = (length = 32) => new Uint8Array(randomBytes(length));
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const scalarBytes = (value: bigint) => new Uint8Array(Buffer.from(value.toString(16).padStart(64, '0'), 'hex'));
const circuit = 'withdraw_unshielded_with_grant_bip340';
let passed = 0;
async function test(name: string, run: () => Promise<void> | void) {
  await run();
  passed++;
  console.log('PASS', name);
}

async function newAccount() {
  const recovery = JubjubDevice.generate();
  const sim = await AccountSim.create({ initialRecoveryPk: recovery.pk,
    initialWrap: rnd(64), vetoWindowSeconds: 60n });
  return { sim, recovery };
}

function privileges(sim: AccountSim) {
  const l = sim.ledger();
  return {
    authNonce: l.auth_nonce, deviceEpoch: l.device_epoch, deviceCount: l.device_count,
    devices: [...l.devices].map(hex).sort(), encKey: l.enc_key,
    boot: l.boot, booted: l.booted, grantGeneration: l.grant_generation,
    recoveryPk: l.recovery_pk, recoverySession: l.recovery_session,
    recoveryWrap: l.recovery_wrap, recoveryVersion: l.recovery_version,
    recoveryPhiLen: l.recovery_phi_len, recoveryPhi: [...l.recovery_phi],
    pendingRecovery: l.pending_recovery, pendingEntry: l.pending_entry,
    pendingRecoveryPk: l.pending_recovery_pk, pendingNotBefore: l.pending_not_before,
    vetoWindow: l.veto_window,
  };
}

async function rejectsUnchanged(sim: AccountSim, run: () => Promise<unknown>, expected: RegExp) {
  const before = sim.state;
  const beforeValue = before.toString(false);
  await assert.rejects(run, expected);
  // ChargedState is immutable; AccountSim must not replace it on failure.
  assert.equal(sim.state, before, 'a rejected call must not commit a replacement ledger state');
  assert.equal(sim.state.toString(false), beforeValue, 'a rejected call must leave all ledger state unchanged');
}

async function issue(sim: AccountSim, id: Uint8Array, scope: PlainScope, salt: Uint8Array,
  owner: JubjubDevice = sim.device) {
  await sim.authorised('issue_grant',
    (context, device) => jubjubChallenges.issueGrant(context, device.pk, id, scopeDigest(salt, scope)),
    [id, ...scopeArgs(scope), salt], owner);
}

async function revoke(sim: AccountSim, id: Uint8Array) {
  await sim.authorised('revoke_grant',
    (context, device) => jubjubChallenges.revokeGrant(context, device.pk, id), [id]);
}

function contextFor(sim: AccountSim, id: Uint8Array): GrantContext {
  const record = sim.ledger().grants.lookup(id);
  return { contractAddress: sim.address, grantId: id,
    issuedAt: record.issued_at, grantNonce: record.nonce };
}

async function invokeAs(sim: AccountSim, caller: PublicAddress | undefined, name: string, args: unknown[]) {
  const context = createCircuitContext({ circuitId: name, contractAddress: sim.addressHex,
    coinPublicKeyOrZswapState: sim.coinPk, contractState: sim.state,
    privateState: sim.privateState, time: sim.now });
  context.callContext = createCallContext(name, sim.addressHex, sim.coinPk, sim.state,
    sim.privateState, sim.now, undefined, caller);
  context.queryContexts[sim.addressHex] = context.callContext.currentQueryContext;
  const result = await sim.contract.provableCircuits[name](context, ...args);
  sim.state = result.context.callContext.currentQueryContext.state;
  sim.privateState = result.context.callContext.currentPrivateState;
}

const { sim, recovery } = await newAccount();
const grantee = new Bip340Grantee(0x123456789abcdefn);
const ecdsa = new K256Grantee(grantee.sk);
const origin = originHash('https://bip340-grantee.example');
const color = rnd(), recipient = rnd(), salt = rnd();
const id = grantee.grantId(sim.address, origin, 0n);
const scope = spendScope({ withdrawUnshielded: true, color, cap: 15n, perCallCap: 10n,
  recipientKind: RECIPIENT_USER_ADDRESS, recipient });
let opening = openingOf(scope, salt, origin, 0n);
const signSpend = (amount: bigint, context = contextFor(sim, id), destination = recipient, token = color) =>
  grantee.sign(bip340GrantChallenges.withdrawUnshielded(context, grantee.pk, token, amount, destination));
const spend = (amount: bigint, auth = signSpend(amount), o = opening, destination = recipient, token = color) =>
  sim.call(circuit, token, amount, { bytes: destination }, ...grantAuthArgs(o, auth));

await test('grantee secret scalars are canonical before conversion to 32 bytes', () => {
  for (const secret of [0n, -1n, SECP256K1_N, SECP256K1_N + 1n, (1n << 256n) + 1n]) {
    assert.throws(() => new Bip340Grantee(secret), /BIP-340 secret scalar must be in \[1, n\)/);
  }
  const challenge = new Uint8Array(32);
  for (const secret of [1n, SECP256K1_N - 1n]) {
    const boundary = new Bip340Grantee(secret);
    assert.equal(schnorr.verify(boundary.sign(challenge).sig, challenge, boundary.pk), true);
  }
});

await test('BIP340 exports exactly three scoped withdrawal circuits and no owner, lifecycle or recovery arm', () => {
  assert.deepEqual(Object.keys(sim.impure).filter(name => name.includes('bip340')).sort(), [
    'withdraw_shielded_to_contract_with_grant_bip340',
    'withdraw_shielded_with_grant_bip340',
    'withdraw_unshielded_with_grant_bip340',
  ]);
});

await test('grant identity separates account, key, origin, slot and ECDSA on the same curve', () => {
  assert.notDeepEqual(id, grantee.grantId(rnd(), origin, 0n));
  assert.notDeepEqual(id, Bip340Grantee.generate().grantId(sim.address, origin, 0n));
  assert.notDeepEqual(id, grantee.grantId(sim.address, rnd(), 0n));
  assert.notDeepEqual(id, grantee.grantId(sim.address, origin, 1n));
  assert.notDeepEqual(id, ecdsa.grantId(sim.address, origin, 0n));
  assert.deepEqual(id, pureCircuits.derive_grant_id_with_bip340({ bytes: sim.address }, grantee.pk, origin, 0n));
});

await test('existing JubJub owner issues a scoped BIP340 grant without enrolling its key', async () => {
  await sim.call('deposit_unshielded', color, 100n);
  const before = sim.ledger().device_count;
  await issue(sim, id, scope, salt);
  const record = sim.ledger().grants.lookup(id);
  assert.equal(record.active, true);
  assert.equal(record.epoch, 0n);
  assert.equal(record.gen, 0n);
  assert.equal(record.nonce, 0n);
  assert.equal(record.issued_at, sim.ledger().auth_nonce);
  assert.equal(sim.ledger().device_count, before);
  await rejectsUnchanged(sim, () => issue(sim, id, scope, salt), /grant already active/);
});

const firstAuth = signSpend(6n);
await test('allowed spend debits balance and advances only grant nonce, spent commitment and round', async () => {
  const before = privileges(sim), round = sim.ledger().round;
  const challenge = bip340GrantChallenges.withdrawUnshielded(contextFor(sim, id), grantee.pk, color, 6n, recipient);
  assert.equal(schnorr.verify(firstAuth.sig, challenge, grantee.pk), true,
    'grant signing must use the exact raw 32-byte challenge');
  await spend(6n, firstAuth);
  opening = { ...opening, spentPrev: 6n };
  assert.deepEqual(privileges(sim), before);
  assert.equal(sim.ledger().round, round + 1n);
  assert.equal(sim.ledger().unshielded_balances.lookup(color), 94n);
  assert.equal(sim.ledger().grants.lookup(id).nonce, 1n);
  assert.deepEqual(sim.ledger().grants.lookup(id).spent_commit, pureCircuits.derive_grant_spent_commit(salt, 6n));
});

for (const [name, run, error] of [
  ['grant nonce replay', () => spend(6n, firstAuth), /invalid grant signature/],
  ['per-call cap', () => spend(11n), /amount above per-call cap/],
  ['cumulative cap', () => spend(10n), /cumulative cap exceeded/],
  ['spent opening', () => spend(1n, signSpend(1n), { ...opening, spentPrev: 0n }), /spent opening mismatch/],
  ['recipient pin', () => spend(1n, signSpend(1n), opening, rnd()), /recipient not admitted by pin/],
  ['token colour', () => spend(1n, signSpend(1n), opening, recipient, rnd()), /scope object mismatch/],
  ['scope salt', () => spend(1n, signSpend(1n), { ...opening, scopeSalt: rnd() }), /scope object mismatch/],
  ['origin', () => spend(1n, signSpend(1n), { ...opening, originHash: rnd() }), /unknown grant/],
  ['slot', () => spend(1n, signSpend(1n), { ...opening, slot: 99n }), /unknown grant/],
] as const) {
  await test(`reject ${name} without changing state`, () => rejectsUnchanged(sim, run, error));
}

await test('signature binds amount, account, operation, public key and signature scheme', async () => {
  await rejectsUnchanged(sim, () => spend(2n, signSpend(1n)), /invalid grant signature/);
  await rejectsUnchanged(sim, () => spend(1n, signSpend(1n, { ...contextFor(sim, id), contractAddress: rnd() })), /invalid grant signature/);
  const other = Bip340Grantee.generate();
  const challenge = bip340GrantChallenges.withdrawUnshielded(contextFor(sim, id), grantee.pk, color, 1n, recipient);
  const prehashed = new Uint8Array(createHash('sha256').update(challenge).digest());
  await rejectsUnchanged(sim, () => spend(1n, grantee.sign(prehashed)), /invalid grant signature/);
  await rejectsUnchanged(sim, () => spend(1n, { ...signSpend(1n), sig: other.sign(challenge).sig }), /invalid grant signature/);
  await rejectsUnchanged(sim, () => spend(1n, other.sign(challenge)), /unknown grant/);
  const operationChallenge = bip340GrantChallenges.withdrawShielded(contextFor(sim, id), grantee.pk,
    recipient, color, 1n, rnd(192), sim.ledger().enc_key, { nonce: rnd(), color, value: 10n, mt_index: 0n });
  await rejectsUnchanged(sim, () => spend(1n, grantee.sign(operationChallenge)), /invalid grant signature/);
  const kChallenge = k256GrantChallenges.withdrawUnshielded(contextFor(sim, id), ecdsa.pk, color, 1n, recipient);
  await rejectsUnchanged(sim, () => spend(1n, grantee.sign(kChallenge)), /invalid grant signature/);
  const ecdsaSignature = ecdsa.sign(kChallenge).sig;
  const encoded = new Uint8Array([...scalarBytes(ecdsaSignature.r), ...scalarBytes(ecdsaSignature.s)]);
  await rejectsUnchanged(sim, () => spend(1n, { ...signSpend(1n), sig: encoded }), /invalid grant signature/);
  await rejectsUnchanged(sim, () => sim.call('withdraw_unshielded_with_grant_k256', color, 1n,
    { bytes: recipient }, ...grantAuthArgs(opening, ecdsa.sign(kChallenge))), /unknown grant/);
});

await test('the same underlying secp256k1 key gains no owner privileges through a grant', async () => {
  const device = new K256Device(grantee.sk);
  const key = rnd();
  const auth = device.sign(k256Challenges.rotateEncKey(sim.callContext(), device.pk, key), 0n);
  await rejectsUnchanged(sim, () => sim.call('rotate_enc_key_with_k256', key, ...authArgs(auth)), /unknown device entry/);
});

await test('read-only and shielded-only grants cannot spend through the unshielded circuit', async () => {
  for (const [slot, selectedScope] of [
    [2n, readOnlyScope({ readPkHash: rnd() })],
    [3n, spendScope({ withdrawShielded: true, color, cap: 10n, readPkHash: rnd() })],
  ] as const) {
    const selectedId = grantee.grantId(sim.address, origin, slot), selectedSalt = rnd();
    await issue(sim, selectedId, selectedScope, selectedSalt);
    const auth = signSpend(1n, contextFor(sim, selectedId));
    await rejectsUnchanged(sim, () => spend(1n, auth, openingOf(selectedScope, selectedSalt, origin, slot)), /operation not in scope/);
  }
});

await test('expiry is enforced at the boundary, while zero expiry remains open-ended', async () => {
  const slot = 4n, selectedId = grantee.grantId(sim.address, origin, slot), selectedSalt = rnd();
  const selectedScope = spendScope({ withdrawUnshielded: true, color, cap: 10n, expiresAt: BigInt(sim.now + 10) });
  await issue(sim, selectedId, selectedScope, selectedSalt);
  const selectedOpening = openingOf(selectedScope, selectedSalt, origin, slot);
  await spend(1n, signSpend(1n, contextFor(sim, selectedId)), selectedOpening);
  sim.advanceTime(10);
  await rejectsUnchanged(sim, () => spend(1n, signSpend(1n, contextFor(sim, selectedId)),
    { ...selectedOpening, spentPrev: 1n }), /grant expired/);
  await spend(1n);
  opening = { ...opening, spentPrev: 7n };
});

await test('owner revocation, same-salt reissue and revoke-all cannot revive cached signatures', async () => {
  await revoke(sim, id);
  await rejectsUnchanged(sim, () => spend(1n), /grant revoked/);
  const firstIncarnation = sim.ledger().grants.lookup(id).issued_at;
  await issue(sim, id, scope, salt);
  opening = openingOf(scope, salt, origin, 0n);
  assert.ok(sim.ledger().grants.lookup(id).issued_at > firstIncarnation);
  assert.equal(sim.ledger().grants.lookup(id).nonce, 0n);
  // Same scope, salt, key, nonce and amount isolate the changed issued_at.
  await rejectsUnchanged(sim, () => spend(6n, firstAuth), /invalid grant signature/);
  const beforeReset = signSpend(1n);
  const generation = sim.ledger().grant_generation;
  await sim.authorised('revoke_all_grants', (ctx, owner) => jubjubChallenges.revokeAllGrants(ctx, owner.pk), []);
  assert.equal(sim.ledger().grant_generation, generation + 1n);
  assert.equal(sim.ledger().grants.isEmpty(), true);
  await rejectsUnchanged(sim, () => spend(1n, beforeReset), /unknown grant/);
  await issue(sim, id, scope, salt);
  assert.equal(sim.ledger().grants.lookup(id).gen, generation + 1n);
  await rejectsUnchanged(sim, () => spend(1n, beforeReset), /invalid grant signature/);
  await spend(1n);
  opening = { ...opening, spentPrev: 1n };
});

await test('owner recovery retires the grant epoch and only the new owner can reissue it', async () => {
  const cached = signSpend(1n), oldEpoch = sim.ledger().device_epoch;
  const successor = JubjubDevice.generate(), nextRecovery = JubjubDevice.generate();
  await sim.recoverSubmit(recovery, successor, nextRecovery.pk, BigInt(sim.now));
  sim.advanceTime(60);
  await sim.call('recover_finalise');
  assert.equal(sim.ledger().device_epoch, oldEpoch + 1n);
  await rejectsUnchanged(sim, () => spend(1n, cached), /grant epoch stale/);
  await rejectsUnchanged(sim, () => issue(sim, id, scope, salt), /unknown device entry/);
  sim.adoptRecoveredDevice(successor);
  await issue(sim, id, scope, salt, successor);
  assert.equal(sim.ledger().grants.lookup(id).epoch, oldEpoch + 1n);
  opening = openingOf(scope, salt, origin, 0n);
  await rejectsUnchanged(sim, () => spend(1n, cached), /invalid grant signature/);
  await spend(1n);
});

const { sim: pinnedSim } = await newAccount();
const caller = rnd(), pinnedId = grantee.grantId(pinnedSim.address, origin, 0n), pinnedSalt = rnd();
const pinnedScope = spendScope({ withdrawUnshielded: true, withdrawShielded: true,
  withdrawShieldedToContract: true, color, cap: 20n, perCallCap: 10n,
  maxCoinValue: 10n, readPkHash: rnd(), caller });
await issue(pinnedSim, pinnedId, pinnedScope, pinnedSalt);
await pinnedSim.call('deposit_unshielded', color, 50n);
const pinnedOpening = openingOf(pinnedScope, pinnedSalt, origin, 0n);
const pinnedAuth = grantee.sign(bip340GrantChallenges.withdrawUnshielded(contextFor(pinnedSim, pinnedId), grantee.pk, color, 1n, recipient));
const pinnedArgs = [color, 1n, { bytes: recipient }, ...grantAuthArgs(pinnedOpening, pinnedAuth)];
const contractCaller = (address: Uint8Array): PublicAddress => ({ tag: 'contract', address: hex(address) });

await test('caller pin rejects absent, user and wrong contract callers and admits the pinned contract', async () => {
  for (const badCaller of [undefined, { tag: 'user', address: hex(caller) } as PublicAddress, contractCaller(rnd())]) {
    await rejectsUnchanged(pinnedSim, () => invokeAs(pinnedSim, badCaller, circuit, pinnedArgs),
      /grant (requires a contract caller|caller mismatch)/);
  }
  const before = privileges(pinnedSim);
  await invokeAs(pinnedSim, contractCaller(caller), circuit, pinnedArgs);
  assert.deepEqual(privileges(pinnedSim), before);
  assert.equal(pinnedSim.ledger().grants.lookup(pinnedId).nonce, 1n);
});

const coin: QualifiedCoin = { nonce: rnd(), color, value: 10n, mt_index: 0n };
const changeEntry = rnd(192);
pinnedSim.privateState = withCoin(pinnedSim.privateState, { ...coin, mtIndex: coin.mt_index });
for (const [name, build, kind] of [
  ['withdraw_shielded', bip340GrantChallenges.withdrawShielded, RECIPIENT_ZSWAP_COIN_PUBLIC_KEY],
  ['withdraw_shielded_to_contract', bip340GrantChallenges.withdrawShieldedToContract, RECIPIENT_CONTRACT_ADDRESS],
] as const) {
  await test(`${name}: caller restriction precedes custody`, async () => {
    const auth = grantee.sign(build(contextFor(pinnedSim, pinnedId), grantee.pk, recipient, color, 1n,
      changeEntry, pinnedSim.ledger().enc_key, coin));
    const args = [{ bytes: recipient }, color, 1n, changeEntry, pinnedSim.ledger().enc_key,
      ...grantAuthArgs({ ...pinnedOpening, spentPrev: 1n }, auth)];
    await rejectsUnchanged(pinnedSim, () => invokeAs(pinnedSim, contractCaller(rnd()), `${name}_with_grant_bip340`, args), /grant caller mismatch/);
  });

  await test(`${name}: scope and actual coin are checked before a shielded send`, async () => {
    const { sim: shieldSim } = await newAccount();
    const selectedScope = spendScope({ withdrawShielded: true, withdrawShieldedToContract: true,
      color, cap: 20n, perCallCap: 10n, maxCoinValue: 10n, readPkHash: rnd(),
      recipientKind: kind, recipient });
    const selectedId = grantee.grantId(shieldSim.address, origin, 0n), selectedSalt = rnd();
    await issue(shieldSim, selectedId, selectedScope, selectedSalt);
    const selectedOpening = openingOf(selectedScope, selectedSalt, origin, 0n);
    shieldSim.privateState = withCoin(shieldSim.privateState, { ...coin, mtIndex: coin.mt_index });
    const encKey = shieldSim.ledger().enc_key;
    const challenge = build(contextFor(shieldSim, selectedId), grantee.pk, recipient, color, 1n, changeEntry, encKey, coin);
    const auth = grantee.sign(challenge);
    const invoke = (entry = changeEntry, enc = encKey, destination = recipient, amount = 1n,
      o: GrantOpening = selectedOpening, a = auth) => shieldSim.call(`${name}_with_grant_bip340`,
      { bytes: destination }, color, amount, entry, enc, ...grantAuthArgs(o, a));
    await rejectsUnchanged(shieldSim, () => invoke(changeEntry, encKey, recipient, 11n), /amount above per-call cap/);
    await rejectsUnchanged(shieldSim, () => invoke(changeEntry, rnd()), /stale encryption key/);
    await rejectsUnchanged(shieldSim, () => invoke(changeEntry, encKey, rnd()), /recipient not admitted by pin/);
    await rejectsUnchanged(shieldSim, () => invoke(rnd(192)), /invalid grant signature/);
    shieldSim.privateState = withCoin(shieldSim.privateState, { ...coin, value: 11n, mtIndex: coin.mt_index });
    await rejectsUnchanged(shieldSim, () => invoke(), /coin above max_coin_value/);
    for (const alteredCoin of [{ ...coin, nonce: rnd() }, { ...coin, value: 9n }, { ...coin, mt_index: 1n }]) {
      shieldSim.privateState = withCoin(shieldSim.privateState, { ...alteredCoin, mtIndex: alteredCoin.mt_index });
      await rejectsUnchanged(shieldSim, () => invoke(), /invalid grant signature/);
    }
    shieldSim.privateState = withCoin(shieldSim.privateState, { ...coin, mtIndex: coin.mt_index });
    // The store lookup uses the requested colour, but the returned witness
    // can lie about its colour. Scope must constrain the consumed coin itself.
    shieldSim.privateState = { ...shieldSim.privateState, coins: { ...shieldSim.privateState.coins,
      [hex(color)]: { ...shieldSim.privateState.coins[hex(color)], colorHex: hex(rnd()) } } };
    await rejectsUnchanged(shieldSim, () => invoke(), /scope object mismatch/);
    shieldSim.privateState = withCoin(shieldSim.privateState, { ...coin, mtIndex: coin.mt_index });
    const otherBuild = name === 'withdraw_shielded'
      ? bip340GrantChallenges.withdrawShieldedToContract : bip340GrantChallenges.withdrawShielded;
    const otherChallenge = otherBuild(contextFor(shieldSim, selectedId), grantee.pk,
      recipient, color, 1n, changeEntry, encKey, coin);
    assert.notDeepEqual(challenge, otherChallenge, 'shielded operation domains must differ');
    await rejectsUnchanged(shieldSim, () => invoke(changeEntry, encKey, recipient, 1n,
      selectedOpening, grantee.sign(otherChallenge)), /invalid grant signature/);
    // Finally remove this operation's flag through an owner-issued scope.
    await revoke(shieldSim, selectedId);
    await issue(shieldSim, selectedId, spendScope({ withdrawUnshielded: true, color, cap: 20n,
      perCallCap: 10n, maxCoinValue: 10n, recipientKind: kind, recipient }), selectedSalt);
    await rejectsUnchanged(shieldSim, () => invoke(), /operation not in scope/);
  });
}

console.log(`PASS BIP340 scoped grants: ${passed} scenarios; generated Compact execution only, no proofs or shielded sends`);
