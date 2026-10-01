import { strict as assert } from 'node:assert';
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createHash, createDecipheriv } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AccountSim } from '../sim.js';
import { softwarePasskey } from '../p256-fixtures.js';
import { JubjubDevice, jubjubChallenges, authArgs } from '../../wallet/signer.js';
import { p256Challenges } from '../../wallet/signer-p256.js';
import { assertionMaterial } from '../../wallet/webauthn.js';
import { generateEncKeyPair, sealInboxEntry, openInboxEntry } from '../../wallet/inbox.js';
import { ENVELOPE_SIZE, LAYOUT, contextBytes, concat, random, hex, readerFromPrf,
  sealViewEnvelope, openViewEnvelope, findCurrentEnvelope } from './codec.js';

const a = softwarePasskey(), b = softwarePasskey();
const recovery = JubjubDevice.generate();
const sim = await AccountSim.create({ initialRecoveryPk: recovery.pk, initialWrap: new Uint8Array(64), vetoWindowSeconds: 60n });
const context = { network: 'undeployed', account: sim.address, rpId: 'localhost', origin: 'http://localhost:8973' };
// Stand-ins for separate authenticators' secret PRF outputs, NOT measured PRF
// evaluations and never derived from an ES256 signature or its private key.
const prfA = random(), prfB = random();
const readerA = readerFromPrf(prfA, context), readerB = readerFromPrf(prfB, context);
assert.notDeepEqual(readerA.publicKey, readerB.publicKey);
assert.deepEqual(readerFromPrf(prfB, context).publicKey, readerB.publicKey);
assert.notDeepEqual(readerFromPrf(prfB, { ...context, account: random() }).publicKey, readerB.publicKey);
assert.throws(() => readerFromPrf(new Uint8Array(), context), /32 bytes/);
const view = generateEncKeyPair();
await sim.authorised('rotate_enc_key', (c, d) => jubjubChallenges.rotateEncKey(c, d.pk, view.publicKey), [view.publicKey]);
const aEntry = a.device.entryAt(sim.address, 0n, 0n);
await sim.authorised('add_device', (c, d) => jubjubChallenges.addDevice(c, d.pk, aEntry), [aEntry]);
let aCounter = 0n;
async function append(entry: Uint8Array) {
  const auth = await a.device.sign(p256Challenges.appendInbox(sim.callContext(), a.pk, entry), aCounter);
  await sim.call('append_inbox_with_p256', entry, ...authArgs(auth)); aCounter++;
}
const bEntry = b.device.entryAt(sim.address, 0n, 0n);
await sim.call('add_device_with_p256', bEntry, ...authArgs(await a.device.sign(
  p256Challenges.addDevice(sim.callContext(), a.pk, bEntry), aCounter++)));
const envelope = await sealViewEnvelope(context, readerB.publicKey, view.secretKey, b.pk);
assert.equal(envelope.length, ENVELOPE_SIZE);
assert.equal(openInboxEntry(view.secretKey, envelope), null, 'legacy reader skips experimental record');
await append(envelope);
assert.deepEqual(sim.ledger().inbox.lookup(0n), envelope);

// Independent Node/OpenSSL opening of the browser-compatible noble/WebCrypto
// envelope, including independently implemented key derivation and AEAD.
const derSecret = createPrivateKey({ key: Buffer.concat([
  Buffer.from('302e020100300506032b656e04220420', 'hex'), readerB.secretKey]), format: 'der', type: 'pkcs8' });
const derPublic = createPublicKey({ key: Buffer.concat([
  Buffer.from('302a300506032b656e032100', 'hex'), envelope.slice(34, 66)]), format: 'der', type: 'spki' });
const key = hkdfSync('sha256', diffieHellman({ privateKey: derSecret, publicKey: derPublic }),
  createHash('sha256').update(contextBytes(context)).digest(), Buffer.from('passport:experimental:view-wrap:v1'), 32);
const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), envelope.slice(66, 78), { authTagLength: 16 });
decipher.setAAD(concat(contextBytes(context), envelope.slice(0, 78), envelope.slice(190)));
decipher.setAuthTag(envelope.slice(78, 94));
const openedByOpenSSL = Buffer.concat([decipher.update(envelope.slice(94, 190)), decipher.final()]);
assert.deepEqual(openedByOpenSSL.subarray(0, 32), Buffer.from(view.secretKey));

let rejected = 0;
for (let i = 0; i < envelope.length; i++) {
  const damaged = new Uint8Array(envelope); damaged[i] ^= 1;
  assert.equal(await openViewEnvelope(context, readerB.secretKey, damaged, view.publicKey), null); rejected++;
}
assert.equal(await openViewEnvelope(context, readerA.secretKey, envelope, view.publicKey), null);
for (const wrong of [{ ...context, account: random() }, { ...context, network: 'other' },
  { ...context, rpId: 'elsewhere' }, { ...context, origin: 'http://localhost:8974' }]) {
  assert.equal(await openViewEnvelope(wrong, readerB.secretKey, envelope, view.publicKey), null);
}
await assert.rejects(() => sealViewEnvelope(context, new Uint8Array(32), view.secretKey, b.pk));
await assert.rejects(() => sealViewEnvelope(context, new Uint8Array(32).fill(255), view.secretKey, b.pk));
const poison = await sealViewEnvelope(context, readerB.publicKey, random(), b.pk);
assert.equal(await openViewEnvelope(context, readerB.secretKey, poison, view.publicKey), null, 'decryptable wrong key rejected');
const coin = { nonce: random(), color: random(), value: 17n };
const coinRecord = sealInboxEntry(view.publicKey, coin);
const restored = await findCurrentEnvelope(context, readerFromPrf(prfB, context).secretKey,
  [poison, coinRecord, sim.ledger().inbox.lookup(0n)], sim.ledger().enc_key);
assert.deepEqual(restored.signingKey, b.pk);
assert.deepEqual(openInboxEntry(restored.viewSecret, coinRecord), coin);
const challenge = random();
assertionMaterial(challenge, b.policy, restored.signingKey, await b.assertion(challenge));
// The original signing credential still approves account calls after opening
// its separately encrypted secret; the account and enrolled P-256 key persist.
await sim.call('append_inbox_with_p256', coinRecord, ...authArgs(await b.device.sign(
  p256Challenges.appendInbox(sim.callContext(), restored.signingKey, coinRecord), 0n)));
const wrongMetadata = await sealViewEnvelope(context, readerB.publicKey, view.secretKey, a.pk);
const untrusted = await openViewEnvelope(context, readerB.secretKey, wrongMetadata, view.publicKey);
assert.ok(untrusted);
const authenticAssertion = await b.assertion(challenge);
assert.throws(() => assertionMaterial(challenge, b.policy, untrusted.signingKey, authenticAssertion), /signature/);

// Stage the next viewing secret using B's PUBLIC reader key only. B performs
// no PRF or signing operation while the owner stages and activates rotation.
const next = generateEncKeyPair();
const nextEnvelope = await sealViewEnvelope(context, readerB.publicKey, next.secretKey, b.pk);
await append(nextEnvelope);
assert.equal(await openViewEnvelope(context, readerB.secretKey, nextEnvelope, view.publicKey), null, 'staged is not current');
await sim.call('rotate_enc_key_with_p256', next.publicKey, ...authArgs(await a.device.sign(
  p256Challenges.rotateEncKey(sim.callContext(), a.pk, next.publicKey), aCounter++)));
assert.equal(await openViewEnvelope(context, readerB.secretKey, envelope, next.publicKey), null, 'old key is stale');
const afterRotation = await findCurrentEnvelope(context, readerFromPrf(prfB, context).secretKey,
  [envelope, nextEnvelope], sim.ledger().enc_key);
assert.deepEqual(afterRotation.viewSecret, next.secretKey);
assert.equal(await openViewEnvelope(context, readerA.secretKey, nextEnvelope, next.publicKey), null);

const report = {
  verdict: 'PASS', test: 'inbox-view-envelope-offline', at: new Date().toISOString(),
  profile: 'experimental-e1', payloadBytes: ENVELOPE_SIZE, meaningfulBytes: 190, zeroPaddingBytes: 2,
  encryptedBytes: { viewingSecret: 32, publicP256Coordinates: 64 }, layout: LAYOUT,
  readerCounts: [1, 2, 5, 10, 100].map(readers => ({ readers, bytesPerGeneration: readers * ENVELOPE_SIZE })),
  controls: { everyByteTamperRejected: rejected, wrongReader: true, wrongContext: true,
    invalidX25519: true, poisonKey: true, substitutedSigningMetadata: true, staleAndStagedKeys: true,
    independentOpenSSL: true, actualP256CompiledCircuitCalls: true, legacyReaderSkips: true, offlineRecipientReseal: true },
  limits: 'Software ES256 authenticator and random synthetic PRF outputs. Compiled-circuit simulation, not a node proof or browser/PRF-sync test.',
};
mkdirSync('evidence/inbox-view-envelope', { recursive: true });
writeFileSync('evidence/inbox-view-envelope/offline.json', JSON.stringify(report, null, 2) + '\n');
console.log('PASS: 192-byte envelope, restored public P-256 metadata, OpenSSL cross-check, 192 tamper cases, actual circuit append and rotation.');
