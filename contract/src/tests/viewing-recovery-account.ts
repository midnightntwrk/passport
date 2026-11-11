// Account integration with real wrap cryptography and controlled ledger/store
// observations. Node acceptance and filesystem durability are separate layers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CustodyAccount } from '../wallet/account.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { deriveShare, fieldToBytes, sealWrap, split } from '../wallet/recovery.js';
import { recoveryKey } from '../wallet/recovery-gate.js';
import { coinId, emptyCoinStore, withCoin, withoutCoin, type MultiCoinStore } from '../wallet/witnesses.js';
import { ViewingRecoveryError, type PersistedViewingKey, type ViewingKeyStore } from '../wallet/viewing-recovery.js';

const bytes = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const address = 'a1'.repeat(32), networkId = 'viewing-account-fixture';
const copy = <T>(value: T): T => structuredClone(value);
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof ViewingRecoveryError); assert.equal(error.code, expected); return true;
};
function fixture() {
  const keys = generateEncKeyPair(), secret = fieldToBytes(41n), session = bytes(8);
  const shares = [17n, 19n, 23n].map((guardian, i) => ({ index: i + 1, sigma: deriveShare(session, bytes(0xa1), guardian) }));
  let state: MultiCoinStore = emptyCoinStore(), vault: PersistedViewingKey | null = null;
  const phi = split(41n, shares, 1);
  const chain = { enc_key: keys.publicKey.slice() as Uint8Array, recovery_pk: recoveryKey(secret).pk, recovery_session: session,
    recovery_wrap: sealWrap(secret, bytes(0xa1), keys.secretKey), recovery_version: 1n, phi,
    device_epoch: 2n, pending_recovery: false, pending_entry: bytes(0), pending_recovery_pk: { x: 0n, y: 1n }, pending_not_before: 0n };
  const counts = { privateWrites: 0, privateReads: 0, vaultWrites: 0, vaultReads: 0, ledgerReads: 0, transactionCalls: 0 };
  const hooks: {
    beforePrivateSet?: () => void | Promise<void>; afterPrivateSet?: () => void | Promise<void>;
    beforePrivateGet?: () => void | Promise<void>; beforeVaultSet?: () => void | Promise<void>;
    afterVaultSet?: () => void | Promise<void>; beforeVaultGet?: () => void | Promise<void>;
    beforeLedgerRead?: (count: number) => void | Promise<void>;
  } = {};
  const provider = {
    async get() { counts.privateReads++; await hooks.beforePrivateGet?.(); return copy(state); },
    async set(_id: string, value: MultiCoinStore) {
      counts.privateWrites++; await hooks.beforePrivateSet?.(); state = copy(value); await hooks.afterPrivateSet?.();
    },
  };
  const store: ViewingKeyStore = {
    async get(scope) {
      counts.vaultReads++; assert.deepEqual(scope, { networkId, address }); await hooks.beforeVaultGet?.(); return copy(vault);
    },
    async set(record) {
      counts.vaultWrites++; await hooks.beforeVaultSet?.(); vault = copy(record); await hooks.afterVaultSet?.();
    },
  };
  const account = () => {
    const forbidden = async () => { counts.transactionCalls++; throw new Error('viewing restoration must not transact'); };
    const a = Reflect.construct(CustodyAccount, [address, bytes(0xa1), { privateStateProvider: provider },
      'viewing-account', { callTx: new Proxy({}, { get: () => forbidden }) }]) as CustodyAccount;
    a.ledgerState = async () => {
      counts.ledgerReads++; await hooks.beforeLedgerRead?.(counts.ledgerReads);
      const s = copy(chain);
      return { ...s, recovery_phi_len: BigInt(s.phi.length), recovery_phi: { lookup: (k: bigint) => s.phi[Number(k) - 1] } } as any;
    };
    return a;
  };
  return { keys, secret, shares, chain, counts, hooks, store, account,
    options: { networkId, store }, input: { n: 3, t: 1, shares: [shares[0], shares[2]] },
    state: () => copy(state), setState: (value: MultiCoinStore) => { state = copy(value); },
    vault: () => copy(vault), setVault: (value: PersistedViewingKey | null) => { vault = copy(value); } };
}

test('current wrap restoration acknowledges vault and private state before returning readiness', async () => {
  const f = fixture(), account = f.account(), secret = f.secret.slice();
  const result = await account.restoreViewingKey(secret, f.options);
  assert.equal(result.persisted, true); assert.equal(result.networkId, networkId);
  assert.equal(result.localKey, 'current'); assert.equal(result.wrap, 'verified-current');
  assert.equal(f.state().encSecretKeyHex, Buffer.from(f.keys.secretKey).toString('hex'));
  assert.equal(f.vault()?.encSecretKeyHex, f.state().encSecretKeyHex);
  assert.deepEqual(secret, f.secret, 'caller material remains under caller control');
  assert.equal(f.counts.transactionCalls, 0);
  assert.equal((await account.viewingRecoveryStatus()).wrap, 'verified-current');
});

test('guardian restoration requires a valid quorum and persists only viewing material', async () => {
  const f = fixture();
  await assert.rejects(f.account().restoreViewingKeyFromGuardians({ ...f.input, shares: [] }, f.options), code('guardians-unavailable'));
  assert.equal(f.counts.vaultWrites, 0); assert.equal(f.counts.privateWrites, 0);
  const result = await f.account().restoreViewingKeyFromGuardians(f.input, f.options);
  assert.equal(result.localKey, 'current'); assert.equal(result.wrap, 'verified-current');
  assert.deepEqual(Object.keys(f.vault()!).sort(), ['address', 'encPublicKeyHex', 'encSecretKeyHex', 'networkId', 'version']);
  assert.equal(JSON.stringify(f.vault()).includes(Buffer.from(f.secret).toString('hex')), false);
});

test('authentic stale and incorrect wraps cannot replace the local key or vault', async () => {
  const f = fixture(), before = f.state();
  f.chain.enc_key = generateEncKeyPair().publicKey;
  await assert.rejects(f.account().restoreViewingKey(f.secret, f.options), code('stale-wrap'));
  assert.deepEqual(f.state(), before); assert.equal(f.vault(), null);
  assert.equal(f.counts.vaultWrites, 0); assert.equal(f.counts.privateWrites, 0);
  f.chain.enc_key = f.keys.publicKey; f.chain.recovery_wrap[20] ^= 1;
  await assert.rejects(f.account().restoreViewingKey(f.secret, f.options), code('invalid-wrap'));
  assert.equal(f.counts.vaultWrites, 0);
});

test('restoration retains same-colour siblings and spent tombstones', async () => {
  const f = fixture(), colour = bytes(2);
  const a = { nonce: bytes(3), color: colour, value: 10n, mtIndex: 4n };
  const b = { nonce: bytes(4), color: colour, value: 20n, mtIndex: 5n };
  const spent = { nonce: bytes(5), color: colour, value: 30n, mtIndex: 6n };
  const original = withoutCoin(withCoin(withCoin(withCoin(f.state(), a), b), spent), spent);
  f.setState(original);
  await f.account().restoreViewingKey(f.secret, f.options);
  assert.deepEqual(f.state().coins, original.coins);
  assert.deepEqual(f.state().coinsByColour, original.coinsByColour);
  assert.deepEqual(f.state().spentCoins, { [coinId(spent)]: true });
});

test('a fresh client can load the vault without retaining the ephemeral recovery secret', async () => {
  const f = fixture(); await f.account().restoreViewingKey(f.secret, f.options);
  f.setState(emptyCoinStore()); f.secret.fill(0);
  const result = await f.account().loadViewingKey(f.options);
  assert.equal(result.persisted, true); assert.equal(result.localKey, 'current');
  assert.equal(result.wrap, 'unknown', 'a persisted viewing key is not persisted proof of wrap freshness');
  assert.equal(f.state().encSecretKeyHex, Buffer.from(f.keys.secretKey).toString('hex'));
  assert.equal(f.counts.transactionCalls, 0);
});

test('direct current-key import does not assert that an opaque recovery wrap is current', async () => {
  const f = fixture();
  const result = await f.account().persistViewingKey(f.keys.secretKey, f.options);
  assert.equal(result.persisted, true); assert.equal(result.localKey, 'current'); assert.equal(result.wrap, 'unknown');
  await assert.rejects(f.account().persistViewingKey(generateEncKeyPair().secretKey, f.options), code('viewing-key-mismatch'));
});

for (const boundary of ['beforeVaultSet', 'afterVaultSet', 'beforeVaultGet', 'beforePrivateSet', 'afterPrivateSet', 'beforePrivateGet'] as const) {
  test(`persistence failure at ${boundary} cannot produce a ready result`, async () => {
    const f = fixture(); let armed = true;
    f.hooks[boundary] = () => { if (armed) throw new Error(`injected ${boundary}`); };
    await assert.rejects(f.account().restoreViewingKey(f.secret, f.options));
    armed = false;
    // A write that committed before its acknowledgement failed remains usable
    // on an explicit retry. A failed initial write creates no false readiness.
    const result = f.vault() ? await f.account().loadViewingKey(f.options) : await f.account().restoreViewingKey(f.secret, f.options);
    assert.equal(result.localKey, 'current'); assert.equal(result.persisted, true);
    assert.equal(f.counts.transactionCalls, 0);
  });
}

test('a store that acknowledges but cannot read back the key is not durable recovery', async () => {
  const f = fixture();
  const store: ViewingKeyStore = { set: async () => {}, get: async () => null };
  await assert.rejects(f.account().restoreViewingKey(f.secret, { networkId, store }), code('persistence-unconfirmed'));
  assert.equal(f.state().encSecretKeyHex, null);
});

test('vault readback must retain the exact scope and key that was acknowledged', async () => {
  const f = fixture();
  f.hooks.beforeVaultGet = () => { const saved = f.vault(); if (saved) f.setVault({ ...saved, networkId: 'foreign' }); };
  await assert.rejects(f.account().restoreViewingKey(f.secret, f.options));
  assert.equal(f.state().encSecretKeyHex, null);
});

for (const boundary of ['beforeVaultSet', 'afterVaultSet', 'beforePrivateSet', 'afterPrivateSet'] as const) {
  test(`encryption rotation at ${boundary} prevents a successful restoration result`, async () => {
    const f = fixture(); f.hooks[boundary] = () => { f.chain.enc_key = generateEncKeyPair().publicKey; };
    await assert.rejects(f.account().restoreViewingKey(f.secret, f.options), code('chain-changed'));
    const status = await f.account().viewingRecoveryStatus();
    assert.notEqual(status.localKey, 'current'); assert.notEqual(status.wrap, 'verified-current');
    assert.equal(f.counts.transactionCalls, 0);
  });
}

test('pending-recovery changes during persistence prevent a successful snapshot result', async () => {
  const f = fixture();
  f.hooks.afterVaultSet = () => { f.chain.pending_recovery = true; f.chain.pending_entry = bytes(7); f.chain.pending_not_before = 500n; };
  await assert.rejects(f.account().restoreViewingKey(f.secret, f.options), code('chain-changed'));
});

test('a pending recovery does not hide stale viewing material or erase pending status', async () => {
  const f = fixture(); f.chain.pending_recovery = true; f.chain.pending_not_before = 500n;
  const result = await f.account().restoreViewingKey(f.secret, f.options);
  assert.equal(result.pendingRecovery, true); assert.equal(result.localKey, 'current');
  f.chain.enc_key = generateEncKeyPair().publicKey;
  assert.equal((await f.account().viewingRecoveryStatus()).wrap, 'known-stale');
  await assert.rejects(f.account().restoreViewingKey(f.secret, f.options), code('stale-wrap'));
});

test('raw publication and cleared public vector cannot reuse an earlier freshness marker', async () => {
  const f = fixture(); const account = f.account(); await account.restoreViewingKey(f.secret, f.options);
  f.chain.recovery_wrap = sealWrap(f.secret, bytes(0xa1), f.keys.secretKey);
  assert.equal((await account.viewingRecoveryStatus()).wrap, 'unknown');
  f.chain.phi = [];
  assert.equal((await account.viewingRecoveryStatus()).wrap, 'absent');
});

test('a stale vault after external encryption rotation is refused on restart', async () => {
  const f = fixture(); await f.account().restoreViewingKey(f.secret, f.options);
  f.chain.enc_key = generateEncKeyPair().publicKey; f.setState(emptyCoinStore());
  await assert.rejects(f.account().loadViewingKey(f.options), code('viewing-key-mismatch'));
  assert.equal(f.state().encSecretKeyHex, null);
});

test('the shared provider guard rejects concurrent mutations and releases after failure', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.hooks.beforeVaultSet = async () => { entered(); await gate; throw new Error('injected store failure'); };
  const pending = f.account().restoreViewingKey(f.secret, f.options); await started;
  await assert.rejects(f.account().putCoin({ nonce: bytes(3), color: bytes(2), value: 10n, mtIndex: 4n }), /in progress|concurrent|busy/i);
  release(); await assert.rejects(pending);
  delete f.hooks.beforeVaultSet;
  assert.equal((await f.account().restoreViewingKey(f.secret, f.options)).localKey, 'current');
});

// These controls also execute the actual generated Compact account circuits.
// The transport envelope is synthetic, so this is not node admission evidence.
async function generatedFixture() {
  const { AccountSim } = await import('./sim.js');
  const { jubjubChallenges } = await import('../wallet/signer.js');
  const sim = await AccountSim.create({ vetoWindowSeconds: 10n, initialRecoveryPk: recoveryKey(41n).pk, initialWrap: new Uint8Array(64) });
  const keys = generateEncKeyPair();
  await sim.authorised('rotate_enc_key', (ctx, device) => jubjubChallenges.rotateEncKey(ctx, device.pk, keys.publicKey), [keys.publicKey]);
  sim.privateState = emptyCoinStore(keys.secretKey);
  const counts = { submits: 0, writes: 0 };
  let lostAcknowledgement = false;
  const providers = { privateStateProvider: {
    async get() { return copy(sim.privateState); },
    async set(_id: string, value: MultiCoinStore) { counts.writes++; sim.privateState = copy(value); },
  } };
  const account = Reflect.construct(CustodyAccount, [sim.addressHex, sim.address, providers, 'generated-viewing', { callTx: new Proxy({}, {
    get: (_target, name: string) => async (...args: unknown[]) => {
      counts.submits++; await sim.call(name, ...args);
      if (lostAcknowledgement) throw new Error('lost fixture acknowledgement');
      return { public: { txId: `generated-${counts.submits}` } };
    },
  }) }]) as CustodyAccount;
  account.ledgerState = async () => sim.ledger();
  const sessionNonce = bytes(15), recoverySecret = fieldToBytes(53n);
  const shares = [101n, 103n, 107n].map((g, i) => ({ index: i + 1, sigma: deriveShare(sessionNonce, sim.address, g) }));
  const options = { n: 3, t: 1, shares, recoverySecret, sessionNonce };
  return { sim, keys, account, counts, options, loseAcknowledgement: () => { lostAcknowledgement = true; } };
}

test('safe session publication seals the current key and marks only its confirmed generated state current', async () => {
  const f = await generatedFixture();
  const result = await f.account.publishViewingRecoverySession(f.sim.device, f.options);
  assert.equal(result.viewingRecovery.localKey, 'current'); assert.equal(result.viewingRecovery.wrap, 'verified-current');
  assert.equal(f.counts.submits, 1);
  const { viewingSnapshot, reconstructCurrentViewingKey } = await import('../wallet/viewing-recovery.js');
  const snapshot = viewingSnapshot(f.sim.addressHex, f.sim.ledger());
  assert.deepEqual(reconstructCurrentViewingKey(snapshot, { n: 3, t: 1, shares: f.options.shares.slice(0, 2) }), f.keys.secretKey);
  assert.deepEqual(f.options.recoverySecret, fieldToBytes(53n));
});

test('typed rotation marks the unchanged wrap stale, and same-key rotation preserves valid history', async () => {
  const f = await generatedFixture(); await f.account.publishViewingRecoverySession(f.sim.device, f.options);
  await f.account.rotateEncKey(f.sim.device, f.keys.publicKey);
  assert.equal((await f.account.viewingRecoveryStatus()).wrap, 'verified-current');
  await f.account.rotateEncKey(f.sim.device, generateEncKeyPair().publicKey);
  const status = await f.account.viewingRecoveryStatus();
  assert.equal(status.wrap, 'known-stale'); assert.equal(status.localKey, 'stale');
});

test('opaque raw publication cannot claim its new recovery wrap has been verified', async () => {
  const f = await generatedFixture(); await f.account.publishViewingRecoverySession(f.sim.device, f.options);
  const sid = bytes(16), secret = fieldToBytes(59n);
  const shares = f.options.shares.map(s => ({ ...s, sigma: s.sigma + 1n }));
  await f.account.publishRecoverySession(f.sim.device, { recoveryPk: recoveryKey(secret).pk,
    sessionNonce: sid, phi: split(59n, shares, 1), wrap: sealWrap(secret, f.sim.address, f.keys.secretKey) });
  assert.equal((await f.account.viewingRecoveryStatus()).wrap, 'unknown');
});

test('lost publication acknowledgement preserves uncertainty even when generated state changed', async () => {
  const f = await generatedFixture(); f.loseAcknowledgement();
  await assert.rejects(f.account.publishViewingRecoverySession(f.sim.device, f.options), /lost fixture acknowledgement/);
  assert.equal(f.counts.submits, 1, 'an uncertain publication is not blindly resent');
  assert.deepEqual(f.sim.ledger().recovery_pk, recoveryKey(f.options.recoverySecret).pk);
  assert.equal((await f.account.viewingRecoveryStatus()).wrap, 'unknown');
});

test('publication refuses pending recovery or missing current viewing material before submitting', async () => {
  const f = await generatedFixture(), current = f.account.ledgerState.bind(f.account);
  f.account.ledgerState = async () => ({ ...await current(), pending_recovery: true });
  await assert.rejects(f.account.publishViewingRecoverySession(f.sim.device, f.options), code('pending-recovery'));
  assert.equal(f.counts.submits, 0);
  f.account.ledgerState = current; f.sim.privateState = emptyCoinStore();
  await assert.rejects(f.account.publishViewingRecoverySession(f.sim.device, f.options), code('viewing-key-mismatch'));
  assert.equal(f.counts.submits, 0);
});

test('publication refuses a changed encryption key observed after signing and before submission', async () => {
  const f = await generatedFixture(), current = f.account.ledgerState.bind(f.account);
  let signed = false;
  const sign = f.sim.device.sign.bind(f.sim.device);
  f.sim.device.sign = (...args) => { const auth = sign(...args); signed = true; return auth; };
  f.account.ledgerState = async () => {
    const state = await current();
    return signed ? { ...state, enc_key: generateEncKeyPair().publicKey } : state;
  };
  await assert.rejects(f.account.publishViewingRecoverySession(f.sim.device, f.options), code('chain-changed'));
  assert.equal(f.counts.submits, 0);
});

test('loading an acknowledged vault never rewrites its durable record', async () => {
  const f = fixture(); await f.account().restoreViewingKey(f.secret, f.options);
  const writes = f.counts.vaultWrites; f.setState(emptyCoinStore());
  f.hooks.beforeVaultSet = () => { throw new Error('read-only reopen must not call set'); };
  assert.equal((await f.account().loadViewingKey(f.options)).localKey, 'current');
  assert.equal(f.counts.vaultWrites, writes);
});

test('a private provider that acknowledges and discards the key cannot return success', async () => {
  const f = fixture(); f.hooks.afterPrivateSet = () => { f.setState(emptyCoinStore()); };
  await assert.rejects(f.account().restoreViewingKey(f.secret, f.options), code('persistence-unconfirmed'));
  assert.ok(f.vault(), 'the acknowledged durable copy remains available for retry');
  delete f.hooks.afterPrivateSet;
  assert.equal((await f.account().loadViewingKey(f.options)).localKey, 'current');
});

test('restoration merges provider inventory changes observed before its private write', async () => {
  const f = fixture(), coin = { nonce: bytes(21), color: bytes(22), value: 21n, mtIndex: 20n };
  f.hooks.afterVaultSet = () => { f.setState(withCoin(f.state(), coin)); };
  await f.account().restoreViewingKey(f.secret, f.options);
  assert.ok(f.state().coins[coinId(coin)]);
});

test('the raw call surface also records stale wrapping before a lost rotation acknowledgement', async () => {
  const f = await generatedFixture(); await f.account.publishViewingRecoverySession(f.sim.device, f.options);
  const { jubjubChallenges, authArgs } = await import('../wallet/signer.js');
  const next = generateEncKeyPair();
  const auth = f.sim.device.sign(jubjubChallenges.rotateEncKey(await f.account.callContext(), f.sim.device.pk, next.publicKey),
    await f.account.resolveUseCounter(f.sim.device));
  f.loseAcknowledgement();
  await assert.rejects(f.account.callTx.rotate_enc_key_with_jubjub(next.publicKey, ...authArgs(auth)), /lost fixture acknowledgement/);
  assert.deepEqual(f.sim.ledger().enc_key, next.publicKey);
  assert.equal((await f.account.viewingRecoveryStatus()).wrap, 'known-stale');
});

test('status refuses a rotation observed while the private key read was in flight', async () => {
  const f = fixture(); f.setState(emptyCoinStore(f.keys.secretKey));
  f.hooks.beforePrivateGet = () => { f.chain.enc_key = generateEncKeyPair().publicKey; };
  await assert.rejects(f.account().viewingRecoveryStatus(), code('chain-changed'));
  delete f.hooks.beforePrivateGet;
  assert.equal((await f.account().viewingRecoveryStatus()).localKey, 'stale');
});

test('real pending recovery can rotate encryption and finalise authority without restoring current viewing capability', async () => {
  const f = await generatedFixture();
  await f.account.publishViewingRecoverySession(f.sim.device, f.options);
  let saved: PersistedViewingKey | null = null;
  const store: ViewingKeyStore = { get: async () => copy(saved), set: async record => { saved = copy(record); } };
  const options = { networkId, store };
  assert.equal((await f.account.restoreViewingKey(f.options.recoverySecret, options)).wrap, 'verified-current');
  const { JubjubDevice } = await import('../wallet/signer.js');
  const successor = new JubjubDevice(79n), nextRecoveryPk = recoveryKey(83n).pk;
  const epochBefore = f.sim.ledger().device_epoch;
  await f.account.recoverSubmit(f.options.recoverySecret, successor, nextRecoveryPk, BigInt(f.sim.now));
  assert.equal(f.sim.ledger().pending_recovery, true);
  const nextViewing = generateEncKeyPair();
  await f.account.rotateEncKey(f.sim.device, nextViewing.publicKey);
  assert.deepEqual(f.sim.ledger().enc_key, nextViewing.publicKey);
  const pendingStatus = await f.account.viewingRecoveryStatus();
  assert.equal(pendingStatus.pendingRecovery, true);
  assert.equal(pendingStatus.localKey, 'stale'); assert.equal(pendingStatus.wrap, 'known-stale');
  await assert.rejects(f.account.restoreViewingKey(f.options.recoverySecret, options), code('stale-wrap'));
  const oldEntries = [...f.sim.ledger().devices];
  const notBefore = f.sim.ledger().pending_not_before;
  f.sim.advanceTime(Number(notBefore) - f.sim.now + 1);
  await f.account.recoverFinalise();
  const final = f.sim.ledger();
  assert.equal(final.device_epoch, epochBefore + 1n);
  assert.equal(final.pending_recovery, false); assert.equal(final.recovery_phi_len, 0n);
  assert.deepEqual(final.recovery_pk, nextRecoveryPk);
  assert.equal(final.devices.size(), 1n);
  assert.ok(final.devices.member(successor.entryAt(f.sim.address, final.device_epoch, 0n)));
  assert.ok(oldEntries.every(entry => !final.devices.member(entry)));
  const result = await f.account.viewingRecoveryStatus();
  assert.equal(result.localKey, 'stale'); assert.equal(result.wrap, 'absent');
  assert.equal(result.pendingRecovery, false);
  await assert.rejects(f.account.loadViewingKey(options), code('viewing-key-mismatch'));
  assert.equal(await f.account.resolveUseCounter(successor), 0n, 'signing authority is recovered despite missing current viewing material');
});
