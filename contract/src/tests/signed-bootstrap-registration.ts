import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
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
