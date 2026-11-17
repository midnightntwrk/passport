// Verify the published Ledger grant experiment with Node/OpenSSL, independently
// of the browser adapter's signature verifier. Ledger acceptance and state are
// recorded observations: this offline check does not verify a ledger proof.
import { strict as assert } from 'node:assert';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { p256GrantChallenges } from '../wallet/signer-p256.js';
import { WEBAUTHN_PROFILE } from '../wallet/webauthn.js';

const args = process.argv.slice(2);
assert.ok(args.length <= 2,
  'usage: ledger-flex-evidence.ts [grant-flow.json [post-run-state.json]]');
const evidence = JSON.parse(readFileSync(args[0] ??
  new URL('../../evidence/ledger-flex-account/grant-flow.json', import.meta.url), 'utf8'));
const state = JSON.parse(readFileSync(args[1] ??
  new URL('../../evidence/ledger-flex-account/post-run-state.json', import.meta.url), 'utf8'));

const bytes = (value: unknown, length?: number): Buffer => {
  assert.ok(typeof value === 'string');
  assert.match(value, /^(?:[0-9a-f]{2})+$/i);
  const result = Buffer.from(value, 'hex');
  if (length !== undefined) assert.equal(result.length, length);
  return result;
};
const integer = (value: unknown): bigint => {
  assert.ok(typeof value === 'string');
  assert.match(value, /^(?:0|[1-9][0-9]*)$/);
  return BigInt(value);
};
const timestamp = (value: unknown): number => {
  assert.ok(typeof value === 'string');
  const result = Date.parse(value); assert.ok(Number.isFinite(result)); return result;
};
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest();
const nodeHash = (value: unknown): Buffer => {
  assert.ok(typeof value === 'string'); return bytes(value.replace(/^0x/, ''), 32);
};
function checkChain(chain: any) {
  assert.ok(Number.isSafeInteger(chain.block.height) && chain.block.height > 0);
  assert.deepEqual(bytes(chain.block.hash, 32), nodeHash(chain.nodeBlockHash));
}

assert.equal(evidence.testId, 'ledger-flex-grant');
assert.equal(evidence.verdict, 'PASS');
assert.equal(evidence.profile, WEBAUTHN_PROFILE);
assert.equal(evidence.origin, 'http://localhost:8973');
assert.equal(evidence.rpId, 'localhost');
assert.equal(evidence.operation, 'withdraw_unshielded_with_grant_p256');
assert.equal(evidence.credential.rpId, evidence.rpId);
assert.equal(evidence.credential.origin, evidence.origin);
assert.equal(evidence.credential.pk.identity, false);
assert.equal(evidence.assertions.length, 2);
assert.equal(evidence.grant.cap, '12');
assert.equal(evidence.grant.perCallCap, '10');

const pk = {
  x: integer(evidence.credential.pk.x), y: integer(evidence.credential.pk.y), identity: false,
};
const coordinate = (n: bigint) => bytes(n.toString(16).padStart(64, '0'), 32).toString('base64url');
const key = createPublicKey({ format: 'jwk', key: {
  kty: 'EC', crv: 'P-256', x: coordinate(pk.x), y: coordinate(pk.y),
} });
const account = bytes(evidence.account, 32), grantId = bytes(evidence.grant.id, 32);
const color = bytes(evidence.grant.color, 32), recipient = bytes(evidence.grant.recipient, 32);
assert.equal(state.account, evidence.account);
assert.equal(state.grantId, evidence.grant.id);
assert.equal(state.issuedAt, '1');
const issuedAt = integer(state.issuedAt);
checkChain(evidence.chain); checkChain(state.chain);

// The issuance generation was queried after the experiment, as stated in the
// supplemental record. Grant revocation leaves this challenge field unchanged.
let previousTime = timestamp(evidence.startedAt);
for (const [index, a] of evidence.assertions.entries()) {
  assert.equal(a.error, undefined);
  assert.equal(a.adapterVerified, true);
  const challenge = p256GrantChallenges.withdrawUnshielded({
    contractAddress: account, grantId, issuedAt, grantNonce: BigInt(index),
  }, pk, color, index === 0 ? 5n : 1n, recipient);
  assert.deepEqual(bytes(a.challenge, 32), Buffer.from(challenge),
    `assertion ${index + 1}: account, grant, issuance generation, amount, recipient and nonce binding`);
  const client = bytes(a.clientDataJSON), auth = bytes(a.authenticatorData, 37);
  const fields = { type: 'webauthn.get', challenge: Buffer.from(challenge).toString('base64url'),
    origin: evidence.origin, crossOrigin: false };
  const normal = Buffer.from(JSON.stringify(fields));
  const grease = Buffer.from(JSON.stringify({ ...fields,
    other_keys_can_be_added_here: 'do not compare clientDataJSON against a template. See https://goo.gl/yabPex',
  }));
  assert.ok(client.equals(normal) || client.equals(grease), 'supported exact signed JSON shape');
  assert.equal(a.chromeGrease, client.equals(grease), 'selector agrees with signed bytes');
  assert.deepEqual(auth.subarray(0, 32), sha256(Buffer.from(evidence.rpId)));
  assert.ok([5, 13, 29].includes(auth[32]), 'UP+UV with supported backup/extension flags');
  // Hash the received bytes, never a parsed or normalised JSON replacement.
  const message = Buffer.concat([auth, sha256(client)]), signature = bytes(a.signature);
  assert.ok(verify('sha256', message, key, signature), 'Node/OpenSSL ES256 verification');
  const changed = Buffer.from(message); changed[changed.length - 1] ^= 1;
  assert.equal(verify('sha256', changed, key, signature), false, 'changed signed envelope');
  const requested = timestamp(a.requestedAt), received = timestamp(a.receivedAt);
  assert.ok(requested >= previousTime && received >= requested, 'assertion ceremony order');
  previousTime = received;
}
assert.ok(timestamp(evidence.completedAt) >= previousTime);
assert.ok(timestamp(state.observedAt) >= timestamp(evidence.completedAt));

assert.deepEqual(evidence.transactions.map((t: any) => t.name), [
  'mint 100 test units', 'deposit_unshielded', 'issue_grant_with_jubjub',
  evidence.operation, 'revoke_grant_with_jubjub',
]);
assert.equal(new Set(evidence.transactions.map((t: any) => t.txId)).size, 5);
let previousBlock = evidence.chain.block.height;
for (const t of evidence.transactions) {
  bytes(t.txId, 33); // Identifier length in this recorded ledger9 run.
  assert.equal(t.status, 'SUCCESS');
  assert.equal(t.raw.transactionResult.status, 'SUCCESS');
  assert.equal(t.blockHeight, t.raw.block.height);
  assert.ok(Number.isSafeInteger(t.blockHeight) && t.blockHeight > previousBlock, 'transaction order');
  assert.equal(t.startIndex, t.raw.startIndex); assert.equal(t.endIndex, t.raw.endIndex);
  assert.deepEqual(bytes(t.raw.block.hash, 32), nodeHash(t.nodeBlockHash));
  previousBlock = t.blockHeight;
}
assert.ok(state.chain.block.height >= previousBlock, 'supplemental state follows revocation');

assert.equal(evidence.progress.phase, 'complete');
assert.equal(evidence.progress.account, evidence.account);
const result = evidence.progress.result;
assert.equal(result.acceptedSpendTxId, evidence.transactions[3].txId);
assert.equal(result.remainingAccountBalance, '95'); assert.equal(result.finalAccountBalance, '95');
assert.equal(result.grantNonce, '1'); assert.equal(result.grantRevoked, true);
for (const name of ['scopeRejection', 'replayRejection', 'revokedGrantRejection']) assert.equal(result[name], true);
assert.equal(state.accountBalance, '95'); assert.equal(state.grantNonce, '1'); assert.equal(state.grantActive, false);
const operation = evidence.progress.operation;
assert.equal(operation.account, evidence.account); assert.equal(operation.grantId, evidence.grant.id);
assert.equal(operation.tokenColor, evidence.grant.color); assert.equal(operation.recipient, evidence.grant.recipient);
assert.equal(operation.amount, '1'); assert.equal(operation.grantNonce, '1');
assert.equal(operation.totalCap, '12'); assert.equal(operation.perCallCap, '10');

const controls = [
  ['amount above per-call cap', 'amount above per-call cap'],
  ['recipient outside pin', 'recipient not admitted by pin'],
  ['changed signed amount within scope', 'invalid grant signature'],
  ['replay with current spent opening', 'invalid grant signature'],
  ['revoked grant with valid pre-revocation signature', 'grant revoked'],
];
assert.deepEqual(evidence.negatives.map((n: any) => n.name), controls.map(([name]) => name));
for (const [index, n] of evidence.negatives.entries()) {
  assert.equal(n.stage, 'local circuit execution'); assert.equal(n.stateUnchanged, true);
  assert.equal(n.proofCalls, 0); assert.equal(n.submissions, 0); bytes(n.stateSha256, 32);
  assert.ok(n.error.causeChain.some((e: any) => e.message === `failed assert: ${controls[index][1]}`),
    'expected circuit refusal');
  assert.ok(n.error.causeChain.some((e: any) => e.tag === 'ContractRuntimeError' &&
    e.message === `Error executing circuit '${evidence.operation}'`));
}
assert.equal(evidence.negatives.at(-1).stateSha256, state.stateSha256, 'post-revocation state observation');

console.log('PASS Ledger evidence: 2 signatures verified with Node/OpenSSL; both grant challenges reconstructed; 5 recorded refusals and localnet outcome consistency checked.');
console.log('This offline check verifies cryptographic binding and recorded consistency, not a ledger proof or independent on-chain acceptance.');
