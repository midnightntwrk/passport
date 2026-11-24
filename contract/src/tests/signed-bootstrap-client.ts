// Pure client lifecycle checks. Browser creation below is a transport mock,
// not a claim that a physical/synced authenticator enforced exclusions.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { pureCircuits as c } from '../wallet/contract.js';
import { JUBJUB_R } from '../wallet/signer.js';
import {
  TemporaryBootstrapKey, deriveBootstrapNetwork, assertBootstrapNetwork,
  createSignedBootstrapRecord, retainBootstrapCredential, assertBootstrapRegistrationAllowed,
  discardUnapprovedBootstrapCredential, prepareSignedBootstrapActivation, signedBootstrapActivationArgs,
  serializeSignedBootstrapRecord, deserializeSignedBootstrapRecord, validateRetainedApproval,
} from '../wallet/signed-bootstrap.js';
import { createBrowserCredential } from '../wallet/webauthn.js';
import { softwarePasskey, TEST_ORIGIN } from './p256-fixtures.js';

const bytes = (n = 32) => new Uint8Array(randomBytes(n));
const config = { caip2Id: 'midnight:undeployed', genesisHash: bytes(), anchorHeight: 17n, anchorHash: bytes() };
function fixture() {
  const key = TemporaryBootstrapKey.generate(), passkey = softwarePasskey(), N = deriveBootstrapNetwork(config);
  const boot = c.derive_signed_boot_commitment(N, key.Q, passkey.policy);
  const record = createSignedBootstrapRecord(N, bytes(), boot, key.Q, passkey.policy);
  return { key, passkey, record };
}
const retain = (f: ReturnType<typeof fixture>) => retainBootstrapCredential(f.record, { credentialId: bytes(41), pk: f.passkey.pk });

test('B05: client validates canonical network and independently observed genesis/checkpoint before approval', () => {
  assert.deepEqual(assertBootstrapNetwork(config, structuredClone(config)), deriveBootstrapNetwork(config));
  for (const changed of [{ ...config, caip2Id: 'midnight:other' }, { ...config, genesisHash: bytes() },
    { ...config, anchorHeight: 18n }, { ...config, anchorHash: bytes() }]) {
    assert.throws(() => assertBootstrapNetwork(config, changed), /mismatch/);
  }
  for (const caip2Id of ['midnight:', 'Midnight:test', 'midnight:UPPER', 'midnight:é', `midnight:${'a'.repeat(33)}`]) {
    assert.throws(() => deriveBootstrapNetwork({ ...config, caip2Id }), /canonical/);
  }
  for (const anchorHeight of [-1n, 1n << 64n]) assert.throws(() => deriveBootstrapNetwork({ ...config, anchorHeight }), /Uint64/);
  assert.throws(() => deriveBootstrapNetwork({ ...config, genesisHash: bytes(31) }), /32/);
  assert.throws(() => deriveBootstrapNetwork({ ...config, anchorHeight: 0n }), /genesis/);
  const genesisOnly = { ...config, anchorHeight: 0n, anchorHash: config.genesisHash };
  assert.equal(deriveBootstrapNetwork(genesisOnly).length, 32);
  // Equal complete configurations on an identical-state clone cannot be
  // distinguished by this hash; physical chain identity is a client assumption.
});

test('B11: resume each persisted stage and reuse the exact approval after temporary-key loss', async () => {
  const f = fixture();
  let record = deserializeSignedBootstrapRecord(serializeSignedBootstrapRecord(f.record));
  assertBootstrapRegistrationAllowed(record);
  retainBootstrapCredential(record, { credentialId: bytes(48), pk: f.passkey.pk });
  record = deserializeSignedBootstrapRecord(serializeSignedBootstrapRecord(record));
  assert.throws(() => assertBootstrapRegistrationAllowed(record), /already retained/);
  const approval = await prepareSignedBootstrapActivation(record, f.key, f.passkey.assertion);
  record.transactionId = 'pending-transaction';
  const serialized = serializeSignedBootstrapRecord(record);
  assert.equal(serialized.includes(f.key.exportSecret().toString()), false, 'temporary private scalar never enters the record');
  assert.equal(serialized.includes(Buffer.from(f.passkey.privateKeyBytes).toString('hex')), false);
  record = deserializeSignedBootstrapRecord(serialized);
  f.key.erase();
  let assertionRequests = 0;
  const resumed = await prepareSignedBootstrapActivation(record, f.key, async () => { assertionRequests++; throw new Error('must reuse saved assertion'); });
  assert.equal(assertionRequests, 0);
  assert.deepEqual(signedBootstrapActivationArgs(resumed), signedBootstrapActivationArgs(approval));
  assert.equal(record.transactionId, 'pending-transaction');
  assert.throws(() => assertBootstrapRegistrationAllowed(record), /already retained/);
  assert.throws(() => discardUnapprovedBootstrapCredential(record), /approved/);
  record.retired = true;
  await assert.rejects(() => prepareSignedBootstrapActivation(record, f.key, f.passkey.assertion), /retired/);
});

test('B11: invalid assertion fails before temporary signing and permits explicit unapproved replacement', async () => {
  const f = fixture(); retain(f);
  let signed = 0;
  const original = f.key.approve.bind(f.key);
  f.key.approve = (...args) => {
    const result = original(...args); signed++; return result;
  };
  await assert.rejects(() => prepareSignedBootstrapActivation(f.record, f.key, async challenge => {
    const valid = await f.passkey.assertion(challenge);
    const data = new Uint8Array(valid.authenticatorData); data[32] = 1;
    return f.passkey.assertion(challenge, { authenticatorData: data });
  }), /UP\+UV/);
  assert.equal(signed, 0); assert.equal(f.record.approval, undefined);
  assert.throws(() => retainBootstrapCredential(f.record, { credentialId: bytes(), pk: softwarePasskey().pk }), /retained/);
  discardUnapprovedBootstrapCredential(f.record);
  assertBootstrapRegistrationAllowed(f.record);
  const replacement = softwarePasskey();
  retainBootstrapCredential(f.record, { credentialId: bytes(), pk: replacement.pk });
  await prepareSignedBootstrapActivation(f.record, f.key, replacement.assertion);
  assert.equal(signed, 1);
  assert.throws(() => discardUnapprovedBootstrapCredential(f.record), /approved/);
});

test('B11: losing both approval and temporary key prevents completion; unrelated key cannot replace it', async () => {
  const f = fixture(); retain(f);
  await assert.rejects(() => prepareSignedBootstrapActivation(f.record, TemporaryBootstrapKey.generate(), f.passkey.assertion), /does not match/);
  f.key.erase();
  await assert.rejects(() => prepareSignedBootstrapActivation(f.record, f.key, f.passkey.assertion), /erased/);
  assert.equal(f.record.approval, undefined);
  // A boot commitment or birth recovery *public* key does not reconstruct the
  // lost authority. Usable separately retained recovery is an external option.
});

test('B11: concurrent approval and target changes during the assertion cannot produce a second approval', async () => {
  const f = fixture(); retain(f);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const first = prepareSignedBootstrapActivation(f.record, f.key, async challenge => {
    entered(); await pending; return f.passkey.assertion(challenge);
  });
  await requested;
  await assert.rejects(() => prepareSignedBootstrapActivation(f.record, f.key, f.passkey.assertion), /progress|concurrent/);
  release(); await first;
  const changed = fixture(); retain(changed);
  let approvals = 0;
  const original = changed.key.approve.bind(changed.key);
  changed.key.approve = (...args) => { approvals++; return original(...args); };
  await assert.rejects(() => prepareSignedBootstrapActivation(changed.record, changed.key, async challenge => {
    changed.record.credential!.pk = softwarePasskey().pk;
    return changed.passkey.assertion(challenge);
  }), /changed|context|target/);
  assert.equal(approvals, 0, 'changed target rejected before temporary signer invocation');
  assert.equal(changed.record.approval, undefined);
});

test('B10: serializer whitelists public metadata and drops injected secret properties', async () => {
  const f = fixture(); retain(f);
  await prepareSignedBootstrapActivation(f.record, f.key, f.passkey.assertion);
  const marker = 'secret-value-must-not-be-persisted';
  Object.assign(f.record, { secret: marker });
  Object.assign(f.record.credential!, { privateKey: marker });
  Object.assign(f.record.approval!, { privateKey: marker });
  Object.assign(f.record.approval!.assertion, { privateKey: marker });
  const serialized = serializeSignedBootstrapRecord(f.record);
  assert.equal(serialized.includes(marker), false);
  validateRetainedApproval(deserializeSignedBootstrapRecord(serialized));
});

test('B03/B06/B10: imported records reject altered context, target and noncanonical approvals', async () => {
  const f = fixture(); retain(f);
  await prepareSignedBootstrapActivation(f.record, f.key, f.passkey.assertion);
  const valid = serializeSignedBootstrapRecord(f.record);
  for (const mutate of [
    (r: typeof f.record) => { r.address[0] ^= 1; },
    (r: typeof f.record) => { r.network[0] ^= 1; },
    (r: typeof f.record) => { r.credential!.pk = softwarePasskey().pk; },
    (r: typeof f.record) => { r.approval!.pk = softwarePasskey().pk; },
    (r: typeof f.record) => { r.approval!.s += JUBJUB_R; },
    (r: typeof f.record) => { r.approval!.grind_nonce += 1n; },
    (r: typeof f.record) => { r.approval!.assertion.signature[10] ^= 1; },
  ]) {
    const changed = deserializeSignedBootstrapRecord(valid); mutate(changed);
    assert.throws(() => validateRetainedApproval(changed));
    assert.throws(() => serializeSignedBootstrapRecord(changed));
  }
  assert.throws(() => deserializeSignedBootstrapRecord(valid.replace('"version":1', '"version":2')), /version/);
});

test('B01/B11: browser transport uses raw address user.id and passes known IDs as exclusions', async () => {
  const address = bytes(), known = bytes(43), sentinel = new Error('transport inspected');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let calls = 0;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: TEST_ORIGIN } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
    create: async (options: CredentialCreationOptions) => {
      calls++;
      const pk = options.publicKey!;
      assert.deepEqual(new Uint8Array(pk.user.id as ArrayBuffer), address);
      assert.equal(pk.user.id.byteLength, 32);
      assert.deepEqual(new Uint8Array(pk.excludeCredentials![0].id as ArrayBuffer), known);
      assert.equal(pk.authenticatorSelection!.userVerification, 'required');
      throw sentinel;
    },
  } } });
  try {
    await assert.rejects(() => createBrowserCredential('localhost', TEST_ORIGIN, 'test', { userId: address, excludeCredentials: [known] }), sentinel);
    assert.equal(calls, 1);
    await assert.rejects(() => createBrowserCredential('localhost', TEST_ORIGIN, 'test', { userId: bytes(65) }), /1–64/);
    assert.equal(calls, 1, 'invalid handle never reaches an authenticator');
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else delete (globalThis as any).location;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete (globalThis as any).navigator;
  }
});
