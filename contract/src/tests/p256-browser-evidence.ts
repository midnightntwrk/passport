// Verify the published browser experiment's signed bytes and operation binding
// with Node/OpenSSL, independently of the browser adapter's noble verifier.
// This is an evidence check, not a substitute for live browser/node execution.
import { strict as assert } from 'node:assert';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { p256Challenges } from '../wallet/signer-p256.js';

const target = new URL('../../evidence/p256-webauthn/browser-flow.json', import.meta.url);
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--export'),
  'usage: npm run verify:p256-browser [-- --export path/to/raw-run.json]');
const raw = readFileSync(args[0] === '--export' ? args[1] : target);
const evidence = JSON.parse(raw.toString('utf8'));
const bytes = (s: string) => {
  assert.match(s, /^(?:[0-9a-f]{2})+$/i);
  return Buffer.from(s, 'hex');
};
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();
assert.equal(evidence.verdict, 'PASS');
assert.equal(evidence.profile, 'wa-json134');
assert.equal(evidence.rpId, 'localhost');
assert.equal(evidence.origin, 'http://localhost:8973');
assert.equal(evidence.operation, 'rotate_enc_key_with_p256');
const pk = { x: BigInt(evidence.credential.pk.x), y: BigInt(evidence.credential.pk.y), identity: false };
const coordinate = (n: bigint) => bytes(n.toString(16).padStart(64, '0')).toString('base64url');
const key = createPublicKey({ format: 'jwk', key: {
  kty: 'EC', crv: 'P-256', x: coordinate(pk.x), y: coordinate(pk.y),
} });
const approved = evidence.assertions.filter((a: any) => a.purpose === 'approve' && !a.error);
assert.equal(approved.length, 1);
const challenge = p256Challenges.rotateEncKey({
  contractAddress: bytes(evidence.account), authNonce: BigInt(evidence.before.authNonce),
}, pk, bytes(evidence.after.encKey));
assert.equal(Buffer.from(challenge).toString('hex'), approved[0].challenge);

let verified = 0;
for (const a of evidence.assertions) {
  if (a.error) {
    assert.ok(['NotAllowedError', 'AbortError'].includes(a.error.name));
    assert.equal(a.signature, undefined);
    continue;
  }
  const client = bytes(a.clientDataJSON), auth = bytes(a.authenticatorData);
  assert.equal(client.length, 134); assert.equal(auth.length, 37);
  assert.deepEqual(client, Buffer.from(JSON.stringify({
    type: 'webauthn.get', challenge: bytes(a.challenge).toString('base64url'),
    origin: evidence.origin, crossOrigin: false,
  })));
  assert.deepEqual(auth.subarray(0, 32), sha256(Buffer.from(evidence.rpId)));
  assert.ok([5, 13, 29].includes(auth[32]), 'UP+UV and supported backup/extension flags');
  const message = Buffer.concat([auth, sha256(client)]);
  assert.ok(verify('sha256', message, key, bytes(a.signature)), 'Node/OpenSSL signature verification');
  // A captured signature must not verify a changed signed envelope.
  const changed = Buffer.from(message); changed[changed.length - 1] ^= 1;
  assert.equal(verify('sha256', changed, key, bytes(a.signature)), false);
  if (a.purpose === 'cancel') {
    const cancel = evidence.progress.operation;
    const expected = p256Challenges.rotateEncKey({
      contractAddress: bytes(evidence.account), authNonce: BigInt(cancel.authNonce),
    }, pk, bytes(cancel.newKey));
    assert.equal(Buffer.from(expected).toString('hex'), a.challenge);
  }
  verified++;
}
assert.equal(evidence.after.authNonce, (BigInt(evidence.before.authNonce) + 1n).toString());
assert.equal(evidence.after.deviceCounter, (BigInt(evidence.before.deviceCounter) + 1n).toString());
const rotation = evidence.transactions.filter((t: any) => t.name === evidence.operation);
assert.equal(rotation.length, 1);
assert.equal(rotation[0].status, 'SUCCESS');
assert.equal(rotation[0].raw.transactionResult.status, 'SUCCESS');
assert.equal(rotation[0].blockHeight, rotation[0].raw.block.height);
assert.equal(evidence.progress.result.txId, rotation[0].txId);
assert.deepEqual(evidence.progress.result.before, evidence.before);
assert.deepEqual(evidence.progress.result.after, evidence.after);
for (const name of ['changed operation argument', 'replay consumed authorisation', 'browser cancellation/denial']) {
  const n = evidence.negatives.find((n: any) => n.name === name);
  assert.ok(n); assert.equal(n.stateUnchanged, true);
  assert.equal(n.proofCalls, 0); assert.equal(n.submissions, 0);
}
assert.equal(evidence.chain.indexedBlock.hash, evidence.chain.nodeBlockHash.replace(/^0x/, ''));

if (args[0] === '--export') {
  // Credential lookup IDs and workstation paths are unnecessary for checking
  // signatures. Keep public keys, signed bytes and all recorded outcomes.
  const published = JSON.parse(JSON.stringify(evidence, (key, value) =>
    ['credentialId', 'stack', 'inspected'].includes(key) ? undefined : value));
  published.publication = {
    sourceRunSha256: sha256(raw).toString('hex'),
    omittedFields: ['credentialId', 'stack', 'inspected'],
    note: 'Published projection of the recorded live run. Signature checks need neither credential lookup IDs nor workstation stack traces.',
  };
  writeFileSync(target, JSON.stringify(published, null, 2) + '\n');
}
console.log(`PASS: ${verified} captured signatures verified with Node/OpenSSL; fresh account-operation binding, envelope and recorded state/outcome consistency checked.`);
console.log('Node acceptance is the recorded live result; this offline check does not re-run a passkey ceremony or verify a ledger proof.');
