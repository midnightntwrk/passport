import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicKey, randomBytes } from 'node:crypto';
import { CustodyAccount, type SignedBootstrapClientOptions } from '../wallet/account.js';
import { pureCircuits } from '../wallet/contract.js';
import {
  TemporaryBootstrapKey, createSignedBootstrapRecord, deriveBootstrapNetwork, retainBootstrapCredential, signedBootstrapPolicy,
} from '../wallet/signed-bootstrap.js';
import { softwarePasskey, TEST_ORIGIN, TEST_RP } from './p256-fixtures.js';

test('B01: signed bootstrap preflights exact-host RP and secure origins before deploying', async () => {
  assert.equal(signedBootstrapPolicy('passport.test', 'https://passport.test').origin.length, 21);
  assert.equal(signedBootstrapPolicy(TEST_RP, TEST_ORIGIN).origin.length, 21);
  assert.throws(() => signedBootstrapPolicy('co.uk', 'https://example.co.uk'), /exact origin hostname/);
  assert.throws(() => signedBootstrapPolicy('example.test', 'http://example.test:1'), /HTTPS/);
  assert.throws(() => signedBootstrapPolicy('elsewhere.test', 'https://passport.test'), /RP ID/);
  let observed = false;
  await assert.rejects(() => CustodyAccount.deployPasskeyDormant(undefined, undefined, undefined as any, undefined as any, {
    rpId: 'co.uk', origin: 'https://example.co.uk', network: undefined as any,
    observeNetwork: async () => { observed = true; throw new Error('must reject before chain access'); },
    verifyDeployment: async () => {}, persist: async () => {},
  }), /exact origin hostname/);
  assert.equal(observed, false);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
  try { assert.throws(() => signedBootstrapPolicy(TEST_RP, TEST_ORIGIN), /secure browser context/); }
  finally { if (previous) Object.defineProperty(globalThis, 'isSecureContext', previous); else delete (globalThis as any).isSecureContext; }
});

test('B11: sessions share a registration reservation and recheck metadata after asynchronous chain checks', async () => {
  const passkey = softwarePasskey(), key = TemporaryBootstrapKey.generate();
  const networkConfig = { caip2Id: 'midnight:undeployed', genesisHash: new Uint8Array(randomBytes(32)),
    anchorHeight: 1n, anchorHash: new Uint8Array(randomBytes(32)) };
  const network = deriveBootstrapNetwork(networkConfig), address = new Uint8Array(randomBytes(32));
  const boot = pureCircuits.derive_signed_boot_commitment(network, key.Q, passkey.policy);
  const record = createSignedBootstrapRecord(network, address, boot, key.Q, passkey.policy);
  const credential = { credentialId: new Uint8Array(randomBytes(32)), pk: passkey.pk };
  let resumeObservation!: () => void, observationStarted!: () => void;
  const observation = new Promise<void>(resolve => { resumeObservation = resolve; });
  const entered = new Promise<void>(resolve => { observationStarted = resolve; });
  const options: SignedBootstrapClientOptions = { network: networkConfig, rpId: TEST_RP, origin: TEST_ORIGIN,
    observeNetwork: async () => { observationStarted(); await observation; return networkConfig; },
    verifyDeployment: async () => {}, persist: async () => {} };
  const account = { address: Buffer.from(address).toString('hex'), addressBytes: address,
    ledgerState: async () => ({ bootstrap_mode: 1n, bootstrap_network: network, boot, booted: false,
      device_count: 0n, device_epoch: 0n, auth_nonce: 0n, devices: { size: () => 0n } }) } as unknown as CustodyAccount;
  const first = CustodyAccount.prototype.signedBootstrapSession.call(account, record, options, key);
  const second = CustodyAccount.prototype.signedBootstrapSession.call(account, record, options, key);
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let registrations = 0;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: TEST_ORIGIN } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
    create: async () => { registrations++; throw new Error('authenticator must not be reached'); },
  } } });
  try {
    const pending = first.registerBrowserCredential('first session');
    const refused = assert.rejects(pending, /already retained/);
    await entered;
    // This used to succeed because registering was local to each session.
    await assert.rejects(() => second.retainCredential(credential), /registration already in progress/);
    await assert.rejects(() => second.registerBrowserCredential('second session'), /registration already in progress/);
    // A direct metadata writer (or a refreshed persisted record) still must
    // cause the first session's post-await guard to refuse navigator.create.
    retainBootstrapCredential(record, credential);
    resumeObservation();
    await refused;
    assert.equal(registrations, 0);
    // The reservation is released on failure, so metadata determines refusal.
    await assert.rejects(() => second.registerBrowserCredential('retry'), /already retained/);
  } finally {
    resumeObservation();
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else delete (globalThis as any).location;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete (globalThis as any).navigator;
  }
});

function registrationFixture() {
  const passkey = softwarePasskey(), key = TemporaryBootstrapKey.generate();
  const networkConfig = { caip2Id: 'midnight:undeployed', genesisHash: new Uint8Array(randomBytes(32)),
    anchorHeight: 1n, anchorHash: new Uint8Array(randomBytes(32)) };
  const network = deriveBootstrapNetwork(networkConfig), address = new Uint8Array(randomBytes(32));
  const boot = pureCircuits.derive_signed_boot_commitment(network, key.Q, passkey.policy);
  const record = createSignedBootstrapRecord(network, address, boot, key.Q, passkey.policy);
  const credential = { credentialId: new Uint8Array(randomBytes(32)), pk: passkey.pk };
  const options: SignedBootstrapClientOptions = { network: networkConfig, rpId: TEST_RP, origin: TEST_ORIGIN,
    observeNetwork: async () => networkConfig, verifyDeployment: async () => {}, persist: async () => {} };
  const account = { address: Buffer.from(address).toString('hex'), addressBytes: address,
    ledgerState: async () => ({ bootstrap_mode: 1n, bootstrap_network: network, boot, booted: false,
      device_count: 0n, device_epoch: 0n, auth_nonce: 0n, devices: { size: () => 0n } }) } as unknown as CustodyAccount;
  const session = () => CustodyAccount.prototype.signedBootstrapSession.call(account, record, options, key);
  return { passkey, key, networkConfig, record, credential, options, session };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

async function withPendingBrowserTrial(f: ReturnType<typeof registrationFixture>,
  run: (trialStarted: Promise<void>, releaseTrial: () => void) => Promise<void>) {
  const entered = deferred(), gate = deferred();
  const x = Buffer.from(f.passkey.pk.x.toString(16).padStart(64, '0'), 'hex').toString('base64url');
  const y = Buffer.from(f.passkey.pk.y.toString(16).padStart(64, '0'), 'hex').toString('base64url');
  const spki = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: TEST_ORIGIN } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
    create: async () => ({ rawId: f.credential.credentialId, response: {
      getPublicKey: () => spki, getPublicKeyAlgorithm: () => -7,
    } }),
    get: async ({ publicKey }: any) => {
      entered.resolve(); await gate.promise;
      return { rawId: f.credential.credentialId, response: await f.passkey.assertion(new Uint8Array(publicKey.challenge)) };
    },
  } } });
  try { await run(entered.promise, gate.resolve); }
  finally {
    gate.resolve();
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else delete (globalThis as any).location;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete (globalThis as any).navigator;
  }
}

test("B11: approval cannot overlap another session's pending registration trial", async () => {
  const f = registrationFixture(), first = f.session(), second = f.session();
  await withPendingBrowserTrial(f, async (trialStarted, releaseTrial) => {
    const registration = first.registerBrowserCredential('first session');
    await trialStarted;
    assert.ok(f.record.credential, 'registration persists the key before its trial assertion');
    let assertions = 0;
    const provider = async (challenge: Uint8Array) => { assertions++; return f.passkey.assertion(challenge); };
    await assert.rejects(() => second.approve(provider), /registration already in progress/);
    assert.equal(assertions, 0);
    releaseTrial(); await registration;
    await second.approve(provider);
    assert.equal(assertions, 1, 'the reservation is released after the trial completes');
  });
});

test('B11: approval reserves the shared ceremony before its asynchronous preflight', async () => {
  const f = registrationFixture(), entered = deferred(), gate = deferred();
  retainBootstrapCredential(f.record, f.credential);
  f.options.observeNetwork = async () => { entered.resolve(); await gate.promise; return f.networkConfig; };
  const first = f.session(), second = f.session();
  let assertions = 0;
  const provider = async (challenge: Uint8Array) => { assertions++; return f.passkey.assertion(challenge); };
  const approval = first.approve(provider);
  try {
    await entered.promise;
    await assert.rejects(() => second.approve(provider), /registration already in progress/);
    await assert.rejects(() => second.registerBrowserCredential('overlap'), /registration already in progress/);
    assert.equal(assertions, 0);
    gate.resolve(); await approval;
    await second.approve(provider);
    assert.equal(assertions, 1, 'reusing the saved approval needs no further prompt');
  } finally { gate.resolve(); }
});

test('B11: external retention rechecks a registration reservation acquired during preflight', async () => {
  const f = registrationFixture(), entered = deferred(), gate = deferred();
  let reads = 0;
  f.options.observeNetwork = async () => {
    if (++reads === 1) { entered.resolve(); await gate.promise; }
    return f.networkConfig;
  };
  const first = f.session(), second = f.session();
  await withPendingBrowserTrial(f, async (trialStarted, releaseTrial) => {
    const retention = first.retainCredential(f.credential);
    const refused = assert.rejects(retention, /registration already in progress/);
    await entered.promise;
    const registration = second.registerBrowserCredential('other session');
    try {
      await trialStarted;
      gate.resolve(); await refused;
      releaseTrial(); await registration;
    } finally { gate.resolve(); releaseTrial(); }
  });
});
