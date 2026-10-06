// Test the actual ZKIR evaluator with forged raw witness data, bypassing all
// generated JavaScript assertions. Check failures must be constraint failures,
// not merely HTTP errors, type errors or malformed serialized payloads.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import { createCheckPayload, proofDataIntoSerializedPreimage } from '@midnightntwrk/ledger-v9';
import { Contract, pureCircuits } from '../../../contracts/managed/probe-webauthn-variable/contract/index.js';
import { parseES256Signature } from '../../wallet/webauthn.js';
import { padded, witnesses } from './witnesses.js';

const root = new URL('../../../', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('../experiments/p256-in-circuit/webauthn/vector.json', root), 'utf8'));
const fromHex = (x: string) => new Uint8Array(Buffer.from(x, 'hex'));
const bytes = new Uint8Array(Buffer.from(fixture.client_data_json_b64url, 'base64url'));
const origin = new TextEncoder().encode(JSON.parse(Buffer.from(bytes).toString()).origin);
const auth = fromHex(fixture.authenticator_data_hex), rp = auth.slice(0, 32);
const pk = { x: BigInt('0x' + fixture.pk_x_hex), y: BigInt('0x' + fixture.pk_y_hex), identity: false };
const contract = new Contract(witnesses), coinPk = { bytes: new Uint8Array(32) };
const initial = await contract.initialState(createConstructorContext({}, coinPk), fromHex(fixture.challenge_hex),
  pureCircuits.policy_commitment(rp, padded(origin, 96), BigInt(origin.length), pk), false);
const result = await contract.impureCircuits.verify_webauthn(createCircuitContext({ circuitId: 'verify_webauthn',
  contractAddress: sampleContractAddress(), contractState: initial.currentContractState, privateState: {},
  coinPublicKeyOrZswapState: coinPk }), padded(bytes, 256), BigInt(bytes.length), rp, auth,
  parseES256Signature(fromHex(fixture.signature_der_hex)), pk);
const trace = result.context.callProofDataTrace.at(-1)!;
const ir = readFileSync(new URL('contracts/managed/probe-webauthn-variable/zkir/verify_webauthn.bzkir', root));
const tests: unknown[] = [];
const startedAt = new Date().toISOString();
for (const name of ['valid', 'sha-bit', 'sha-carry', 'origin', 'prefix-length', 'input-length']) {
  const input = structuredClone(trace.input);
  const outputs = structuredClone(trace.privateTranscriptOutputs);
  // Aligned values trim trailing zero bytes; the alignment retains capacity.
  assert.equal(outputs[0].value[0].length, origin.length);
  assert.equal(outputs[1].value.length, 33);
  if (name === 'sha-bit') outputs[1].value[0] = Uint8Array.of(outputs[1].value[0][0] === 1 ? 0 : 1);
  if (name === 'sha-carry') outputs[1].value[32] = Uint8Array.of(1);
  if (name === 'origin') outputs[0].value[0][8] ^= 1;
  if (name === 'prefix-length') outputs[0].value[2][0] ^= 1;
  if (name === 'input-length') input.value[1][0] ^= 1;
  const preimage = proofDataIntoSerializedPreimage(input, trace.output, trace.publicTranscript, outputs, 'verify_webauthn');
  const response = await fetch('http://127.0.0.1:6300/check', { method: 'POST',
    body: createCheckPayload(preimage, ir) as BodyInit, signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/octet-stream' } });
  if (name === 'valid') { assert.equal(response.status, 200, await response.text()); }
  else {
    const reason = await response.text();
    assert.equal(response.status, 400, reason);
    assert.match(reason, /assert|constraint/i, 'must fail circuit constraints, not encoding');
    tests.push({ name, result: 'REJECTED', status: response.status, reason });
  }
  console.log('PASS raw ZKIR transcript:', name);
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
writeFileSync(new URL('evidence/webauthn-variable-json/transcript-checks.json', root), JSON.stringify({
  result: 'PASS', startedAt, completedAt: new Date().toISOString(),
  evidenceLayer: 'proof-server ZKIR evaluator checks; not negative proof generation',
  positive: 'Existing captured Safari assertion accepted by ZKIR check', tests,
  irSha256: sha(ir), sourceSha256: sha(readFileSync(new URL(import.meta.url))),
}, null, 2) + '\n');
