// Offline self-test of the constraint-level negative helper
// (src/tests/constraint-negative.ts), on the base probe contract. No proof
// server, node, or network: it checks the mechanics the prover-level suites
// rely on. A fake proof server on the loopback interface (an ephemeral port
// inside this process) stands in for the HTTP answers.
//
//   - The patched copy behaves exactly like the original on honest inputs
//     (pure and impure circuits, ledger state); a copy with runtime overrides
//     does not, by construction.
//   - A bypassed assert is recorded instead of thrown, so the bad call
//     completes local execution and writes its (bad) result; the original
//     refuses the same call in the generated JavaScript.
//   - An assert that is not bypassed still throws in the copy.
//   - A bypass message that is not an assert of the module is refused.
//   - The copy counts the calls that run through it (uses()).
//   - classifyRefusal: a proof-server refusal is `prover` (a constraint) or
//     `decoding` (input decoding, not a constraint) only with a recorded
//     request carrying a recognised payload; every other HTTP answer (401,
//     404, 429, 5xx, an unrecognised body), an unrecorded or mismatched
//     refusal, and a transport failure is `infrastructure` (an ERROR). The
//     payloads are exact bodies the proof server returned.
//   - End to end through the real proving path (the ledger's proving loop and
//     the recording provider) against the fake server: 404, 401 and 429 are
//     ERROR; a decoding payload is `decoding`; "Failed direct assertion" is
//     `prover`; and every request arrives on its own connection (no reused
//     keep-alive connection, which can break a large prover-key upload).
//   - expectRefusal is fail-closed: a call that goes through is a FAIL, a
//     refusal at another layer is a FAIL, a bypassed assert that never fired
//     is a FAIL, a call that misses the patched copy is a FAIL, and an
//     infrastructure failure is an ERROR.
//   - Positive controls per patched copy: a copy with runtime overrides
//     needs a positive control proved through it; one that did not prove,
//     did not run through the copy, or fired a bypassed assert makes the
//     negative an ERROR. (The proof server's answer to a positive
//     control is simulated here by a recorded /prove 200; the prover-level
//     suites prove it for real.)
//
// Writes $EVIDENCE_DIR/constraint-negative-offline.json when EVIDENCE_DIR is
// set; never writes into the repository.

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import {
  createUnprovenCallTxFromInitialStates,
  createUnprovenDeployTxFromVerifierKeys,
} from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { LedgerParameters, ZswapChainState, sampleSigningKey } from '@midnightntwrk/ledger-v9';
import * as Original from '../../contracts/managed/probe-wallet-arms-base/contract/index.js';
import {
  loadBypassedContract, classifyRefusal, expectRefusal, expectSuccess, recogniseRejection, recordingProofProvider,
  ProofServerRefusal, PROOF_SERVER_REJECTIONS, type ProofServerRequest,
} from './constraint-negative.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE_JS = path.resolve(here, '..', '..', 'contracts', 'managed', 'probe-wallet-arms-base', 'contract', 'index.js');
const W64 = 'descriptor: not a 64-byte device tag';
const pad = (s: string) => { const o = new Uint8Array(32); o.set(Buffer.from(s, 'ascii')); return o; };
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const A = { bytes: new Uint8Array(32).fill(7) };
const k = new Uint8Array(32).fill(1), b = new Uint8Array(32).fill(2);
const GOOD_TAG = pad('midnight:account:device:v1'), BAD_TAG = pad('midnight:account:device:k1:v2');

const patched = await loadBypassedContract(PROBE_JS, [W64]);
assert.ok(!patched.file.startsWith(path.resolve(here, '..', '..')), 'the copy is written outside the repository');

// Pure circuits: identical on honest inputs; the bypassed assert is recorded.
assert.ok(eq(patched.pureCircuits.derive_descriptor_entry_w64(GOOD_TAG, A, k, b, 0n, 0n), Original.pureCircuits.derive_descriptor_entry_w64(GOOD_TAG, A, k, b, 0n, 0n)));
assert.deepEqual(patched.fired(), []);
assert.throws(() => Original.pureCircuits.derive_descriptor_entry_w64(BAD_TAG, A, k, b, 0n, 0n), /failed assert: descriptor: not a 64-byte device tag/);
const bad = patched.pureCircuits.derive_descriptor_entry_w64(BAD_TAG, A, k, b, 0n, 0n);
assert.equal(bad.length, 32);
assert.deepEqual(patched.fired(), [{ message: W64, count: 1 }]);
// Other asserts still throw in the copy.
assert.throws(() => patched.pureCircuits.derive_descriptor_entry_w65(GOOD_TAG, A, k, b, 0n, 0n, 0n), /not a 65-byte device tag/);
assert.throws(() => patched.pureCircuits.label_text_32(new Uint8Array(32)), /not a zero-padded label/);
patched.resetFired();
assert.deepEqual(patched.fired(), []);
console.log('  ✓ pure circuits: identical on honest inputs; the bypassed assert recorded, every other assert still thrown');

// Impure circuits against a local state: the bad call completes and writes
// its result; the original refuses it in the generated JavaScript.
const coinPk = { bytes: new Uint8Array(32).fill(9) };
const run = async (C: any, tag: Uint8Array) => {
  const c = new C({});
  const init = await c.initialState(createConstructorContext({}, coinPk));
  const ctx = createCircuitContext({
    circuitId: 'probe_entry_w64', contractAddress: sampleContractAddress(), coinPublicKeyOrZswapState: coinPk,
    contractState: init.currentContractState, privateState: {},
  });
  const r = await c.impureCircuits.probe_entry_w64(ctx, tag, A, k, b, 0n, 0n);
  return { derived: Original.ledger(r.context.callContext.currentQueryContext.state).derived, trace: r.context.callProofDataTrace };
};
const honest = await run(Original.Contract, GOOD_TAG);
const honestCopy = await run(patched.Contract, GOOD_TAG);
assert.ok(eq(honest.derived, honestCopy.derived), 'same ledger write');
assert.ok(eq(honest.derived, Original.pureCircuits.derive_descriptor_entry_w64(GOOD_TAG, A, k, b, 0n, 0n)));
await assert.rejects(() => run(Original.Contract, BAD_TAG), /failed assert: descriptor: not a 64-byte device tag/);
const forced = await run(patched.Contract, BAD_TAG);
assert.ok(eq(forced.derived, bad), 'the bad call writes the hash the circuit would have refused');
assert.equal(forced.trace.length, 1, 'one call proof data record, ready for the proof server');
assert.deepEqual(patched.fired(), [{ message: W64, count: 1 }]);
console.log('  ✓ impure circuit: the bad call completes local execution with a proof data record; the original refuses it');

await assert.rejects(() => loadBypassedContract(PROBE_JS, ['descriptor: not a 64-byte device tg']), /no assert message/);
console.log('  ✓ a bypass message that is not an assert of the module is refused');

// The copy counts the calls that run through it.
{
  const before = patched.uses();
  Original.pureCircuits.derive_descriptor_entry_w64(GOOD_TAG, A, k, b, 0n, 0n);
  assert.equal(patched.uses(), before, 'a call through the original leaves the copy untouched');
  patched.pureCircuits.derive_descriptor_entry_w64(GOOD_TAG, A, k, b, 0n, 0n);
  assert.ok(patched.uses() > before, 'a call through the copy is counted');
  await run(patched.Contract, GOOD_TAG);
  assert.equal(patched.overrides, '');
}
// A copy with runtime overrides: here persistentHash is replaced, so the
// honest result differs from the original's (which is why such a copy needs
// its own positive control).
const OVERRIDES = `
  persistentHash(t, v) { const h = __compactRuntimeOriginal.persistentHash(t, v); h[0] ^= 0xff; return h; },`;
const overridden = await loadBypassedContract(PROBE_JS, [W64], { overrides: OVERRIDES });
assert.equal(overridden.overrides, OVERRIDES);
{
  const o = overridden.pureCircuits.derive_descriptor_entry_w64(GOOD_TAG, A, k, b, 0n, 0n);
  const h = Original.pureCircuits.derive_descriptor_entry_w64(GOOD_TAG, A, k, b, 0n, 0n);
  assert.ok(!eq(o, h) && o[0] === (h[0] ^ 0xff) && eq(o.subarray(1), h.subarray(1)), 'the override is in force');
  overridden.pureCircuits.derive_descriptor_entry_w64(BAD_TAG, A, k, b, 0n, 0n);
  assert.deepEqual(overridden.fired(), [{ message: W64, count: 1 }], 'the bypass still records');
  assert.throws(() => overridden.pureCircuits.derive_descriptor_entry_w65(GOOD_TAG, A, k, b, 0n, 0n, 0n), /not a 65-byte device tag/, 'an override cannot replace assert');
  overridden.resetFired();
}
console.log('  ✓ uses(): calls through the copy counted, calls through the original not; overrides in force, the bypass and other asserts unchanged');

// ── classifyRefusal ──────────────────────────────────────────────────────────

// Exact proof-server bodies, each from a real refused request.
const BODY = {
  // a bypassed module or seam assert
  assertion: 'bad input: `Failed direct assertion`',
  // a secp256k1 key given as the point at infinity, flagged as the identity
  identity: 'bad input: `Cannot extract coordinates of the Secp256k1 identity`',
  // a transcript that declares an Ethereum address other than the one the circuit computes
  transcript: 'bad input: `Public transcript input mismatch for input 34; expected: Some(b7), computed: Some(25)`',
  // a secp256k1 point (0, 0) not flagged as the identity
  decodeK1: 'bad input: `Failed to decode [Fq(0x0000000000000000fffffffffffffffffffffffffffffffffffffffefffffc2e), Fq(0x000000000000000000000000000000000000000000000000ffffffffffffffff), Fq(0x0000000000000000fffffffffffffffffffffffffffffffffffffffefffffc2e), Fq(0x000000000000000000000000000000000000000000000000ffffffffffffffff), Fq(0x0000000000000000000000000000000000000000000000000000000000000000)] as Secp256k1Point`',
  // an unreduced secp256k1 coordinate
  canonicalK1: 'bad input: `The encoded value of type Secp256k1Point is not in canonical form: [Fq(0x0000000000000000fffffffffffffffffffffffffffffffffffffffefffffc2f), Fq(0x000000000000000000000000000000000000000000000000ffffffffffffffff), Fq(0x000000000000000063db68605822fb14264ca8d2587fdd6fbc750d587e76a7ed), Fq(0x0000000000000000000000000000000000000000000000004218f20ae6c646b3), Fq(0x0000000000000000000000000000000000000000000000000000000000000000)]`',
  // Curve25519: a point that does not decode, an unreduced point, an unreduced scalar
  decodeEd: 'bad input: `Failed to decode [Fq(0x0000000000000000022fd858e4944b9f8a5abbfb1e1a894347292feff73655a0), Fq(0x000000000000000000000000000000000000000000000000249af20300a81d18), Fq(0x00000000000000009dc4a26bf8f1c952534eb1ea056f5e50478cdb95f3fb0df8), Fq(0x0000000000000000000000000000000000000000000000004345e2daf969b0b4)] as Curve25519Point`',
  canonicalEdPoint: 'bad input: `The encoded value of type Curve25519Point is not in canonical form: [Fq(0x00000000000000008330ac242ccf4e4d105d51edeee0a89141d63e49662b11dc), Fq(0x0000000000000000000000000000000000000000000000006249e0b645545542), Fq(0x0000000000000000e429ee7f3374bc9331f8286ccf5b4da6206a2fc85fcbb09c), Fq(0x000000000000000000000000000000000000000000000000d555c9c01c62f88b)]`',
  canonicalEdScalar: 'bad input: `The encoded value of type Curve25519Scalar is not in canonical form: [Fq(0x000000000000060f89d74eb077bd193282d55d9ea9f9af9c2e123d72d6e58a4d), Fq(0x0000000000000000000000000000000000000000000000000001d1bebac16774)]`',
  // a byte input of 256 or more, refused by its 8-bit range check
  bitBound: 'bad input: `Bit bound failed: 8a01 is not 8-bit`',
} as const;
const KIND: Record<keyof typeof BODY, ['constraint' | 'decoding', string]> = {
  assertion: ['constraint', 'direct-assertion'], identity: ['constraint', 'weierstrass-identity-coordinates'],
  transcript: ['constraint', 'public-transcript-binding'],
  decodeK1: ['decoding', 'input-decoding'], canonicalK1: ['decoding', 'non-canonical-encoding'],
  decodeEd: ['decoding', 'input-decoding'], canonicalEdPoint: ['decoding', 'non-canonical-encoding'],
  canonicalEdScalar: ['decoding', 'non-canonical-encoding'], bitBound: ['constraint', 'bit-bound'],
};
for (const [key, body] of Object.entries(BODY) as [keyof typeof BODY, string][]) {
  const r = recogniseRejection({ status: 400, body });
  assert.deepEqual(r && [r.kind, r.rule], KIND[key], key);
  assert.equal(recogniseRejection({ status: 400, body, bodyTruncated: true }), null, `${key}: a truncated body is never recognised`);
  for (const status of [200, 401, 404, 429, 500]) assert.equal(recogniseRejection({ status, body }), null, `${key}: HTTP ${status}`);
}
for (const body of [
  'bad input: `Failed direct assertion; and more`', 'bad input: `failed direct assertion`', 'Failed direct assertion',
  'bad input: `Failed direct assertion`\n', "bad input: `couldn't find built-in key 0x00`", 'bad input: `Transcripts not fully consumed`',
  'bad input: `Cannot extract coordinates of the Secp256r1 identity`', 'bad input: `Public transcript input mismatch`',
  'Job Queue full', 'internal error', '', 'bad input: `Bit bound failed: 8a01 is not 8-bit; and more`', 'bad input: `Excessive bit bound`',
]) assert.equal(recogniseRejection({ status: 400, body }), null, `unrecognised: ${JSON.stringify(body)}`);
assert.equal(PROOF_SERVER_REJECTIONS.length, 6);
console.log(`  ✓ recogniseRejection: ${Object.keys(BODY).length} recorded bodies recognised with their kind (constraint or decoding); other statuses, truncated and 13 other bodies refused`);

const KEY = 'contract:00/probe_entry_w64';
const req = (status: number | null, body?: string, endpoint: '/check' | '/prove' = '/check'): ProofServerRequest =>
  ({ endpoint, keyLocation: KEY, startedAt: '2026-10-15T00:00:00.000Z', ms: 1, status, ok: status !== null && status >= 200 && status < 300, ...(body !== undefined ? { body } : {}) });
const refusalObj = (status: number, body: string, endpoint = '/check') => new Error('call failed', { cause: new ProofServerRefusal(endpoint, KEY, status, body) });
const relayed = (status: number, body: string, endpoint = '/check') =>
  new Error(`'${endpoint.slice(1)}' returned an error: ProofServerRefusal: proof server ${endpoint} refused (${status}): ${body.slice(0, 300)}`);
const ok200 = req(200, undefined);

const cases: [string, unknown, ProofServerRequest[] | undefined, string][] = [
  // Recognised payloads with their recorded request: prover (constraint) or decoding.
  ['assertion, error object', refusalObj(400, BODY.assertion), [req(400, BODY.assertion)], 'prover'],
  ['assertion, relayed across WASM', relayed(400, BODY.assertion), [ok200, req(400, BODY.assertion)], 'prover'],
  ['flagged identity', relayed(400, BODY.identity), [req(400, BODY.identity)], 'prover'],
  ['public transcript mismatch', relayed(400, BODY.transcript), [req(400, BODY.transcript)], 'prover'],
  ['unflagged (0, 0): decoding', relayed(400, BODY.decodeK1), [req(400, BODY.decodeK1)], 'decoding'],
  ['unreduced coordinate: decoding', relayed(400, BODY.canonicalK1), [req(400, BODY.canonicalK1)], 'decoding'],
  ['Curve25519 point: decoding', relayed(400, BODY.decodeEd), [req(400, BODY.decodeEd)], 'decoding'],
  ['Curve25519 scalar: decoding', refusalObj(400, BODY.canonicalEdScalar), [req(400, BODY.canonicalEdScalar)], 'decoding'],
  ['byte input beyond its bit bound', relayed(400, BODY.bitBound), [req(400, BODY.bitBound)], 'prover'],
  // Any other HTTP answer is infrastructure, whatever its body says.
  ['404 with an assertion body', relayed(404, BODY.assertion), [req(404, BODY.assertion)], 'infrastructure'],
  ['404 Not Found', refusalObj(404, 'Not Found'), [req(404, 'Not Found')], 'infrastructure'],
  ['401 Unauthorized', relayed(401, 'Unauthorized'), [req(401, 'Unauthorized')], 'infrastructure'],
  ['429 Job Queue full', relayed(429, 'Job Queue full'), [req(429, 'Job Queue full')], 'infrastructure'],
  ['500 internal error', refusalObj(500, 'internal error', '/prove'), [req(500, 'internal error', '/prove')], 'infrastructure'],
  ['503 relayed', relayed(503, 'unavailable', '/prove'), [req(503, 'unavailable', '/prove')], 'infrastructure'],
  ['400, unrecognised payload', relayed(400, "bad input: `couldn't find built-in key 0x00`"), [req(400, "bad input: `couldn't find built-in key 0x00`")], 'infrastructure'],
  ['400, not a bad-input body', relayed(400, 'failed to deserialize'), [req(400, 'failed to deserialize')], 'infrastructure'],
  // A recognised payload without its recorded request is no verdict.
  ['assertion, no request log', relayed(400, BODY.assertion), undefined, 'infrastructure'],
  ['assertion, nothing recorded', refusalObj(400, BODY.assertion), [], 'infrastructure'],
  ['assertion, last recorded request answered 200', relayed(400, BODY.assertion), [req(400, BODY.assertion), ok200], 'infrastructure'],
  ['assertion, recorded on the other endpoint', relayed(400, BODY.assertion), [req(400, BODY.assertion, '/prove')], 'infrastructure'],
  ['assertion, recorded body differs', relayed(400, BODY.assertion), [req(400, BODY.canonicalK1)], 'infrastructure'],
  ['assertion, recorded with another status', relayed(400, BODY.assertion), [req(404, BODY.assertion)], 'infrastructure'],
  ['assertion, recorded body truncated', relayed(400, BODY.assertion), [{ ...req(400, BODY.assertion), bodyTruncated: true }], 'infrastructure'],
  ['midnight-js provider (records nothing)', new Error('Failed Proof Server response: url="http://127.0.0.1:6300/check", code="400", status="Bad Request"'), [req(400, BODY.assertion)], 'infrastructure'],
  // The other layers.
  ['client decoder', new Error('descriptor: not a canonical Ed25519 point'), [], 'client'],
  ['runtime assert', Object.assign(new Error('failed assert: invalid signature'), { isCompactError: true }), [], 'runtime'],
  ['runtime type check (cause)', new Error('wrapper', { cause: Object.assign(new Error('type error: x'), { isCompactError: true }) }), undefined, 'runtime'],
  ['node', new Error('1010: Invalid Transaction: Custom error: 134'), [ok200, req(200, undefined, '/prove')], 'node'],
  ['transport', new Error('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6300'), { code: 'ECONNREFUSED' }) }), [{ ...req(null), error: 'ECONNREFUSED' }], 'infrastructure'],
  ['transport, relayed', new Error("'check' returned an error: TypeError: fetch failed"), [{ ...req(null), error: 'ECONNREFUSED' }], 'infrastructure'],
  ['something else', new Error('something else'), [], 'unknown'],
  ['runtime error, but a refusal was recorded', Object.assign(new Error('failed assert: x'), { isCompactError: true }), [req(400, BODY.assertion)], 'unknown'],
];
for (const [name, e, requests, layer] of cases) {
  const c = classifyRefusal(e, requests);
  assert.equal(c.layer, layer, `${name}: ${c.detail}`);
  if (layer === 'prover' || layer === 'decoding') {
    assert.equal(c.rejection?.kind, layer === 'prover' ? 'constraint' : 'decoding', name);
    assert.equal(c.rejection?.status, 400);
  } else assert.equal(c.rejection, undefined, name);
}
console.log(`  ✓ classifyRefusal: ${cases.length} cases (prover and decoding only from a recorded HTTP 400 with a recognised payload; 404, 401, 429, 5xx, unrecognised, unrecorded and mismatched refusals are infrastructure)`);

// ── End to end: the real proving path against a fake proof server ───────────

const PROBE = path.dirname(path.dirname(PROBE_JS));
setNetworkId('undeployed' as any); // as upstream's CONFIG (src/node/wallet.ts)
const zk = new NodeZkConfigProvider(PROBE);
const coinPublicKey = '00'.repeat(32), encryptionPublicKey = '00'.repeat(32);
const compiled = (C: any) => (CompiledContract.make('probe-wallet-arms-base', C) as any).pipe(
  (CompiledContract as any).withVacantWitnesses,
  (CompiledContract as any).withCompiledFileAssets(PROBE),
);
const deploy: any = await createUnprovenDeployTxFromVerifierKeys(zk as any, coinPublicKey, {
  compiledContract: compiled(Original.Contract), signingKey: sampleSigningKey(), initialPrivateState: {},
} as any, encryptionPublicKey);

let answer = { status: 404, body: '' };
const hits: string[] = [];
// Requests per TCP connection: the recording provider must open a new
// connection for every request (a reused keep-alive connection can break a
// large prover-key upload with EPIPE).
const requestsPerConnection = new Map<object, number>();
const server = createServer((rq, rs) => {
  requestsPerConnection.set(rq.socket, (requestsPerConnection.get(rq.socket) ?? 0) + 1);
  rq.resume();
  rq.on('end', () => { hits.push(`${rq.method} ${rq.url}`); rs.writeHead(answer.status, { 'content-type': 'text/plain' }); rs.end(answer.body); });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const fakeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const log: ProofServerRequest[] = [];
const fakeProver = recordingProofProvider(fakeUrl, zk, log);
const prove = async (C: any, tag: Uint8Array) => {
  const call: any = await createUnprovenCallTxFromInitialStates(zk as any, {
    compiledContract: compiled(C), circuitId: 'probe_entry_w64', contractAddress: deploy.public.contractAddress, coinPublicKey,
    initialContractState: deploy.public.initialContractState, initialZswapChainState: new ZswapChainState(),
    ledgerParameters: LedgerParameters.initialParameters(), args: [tag, A, k, b, 0n, 0n], initialPrivateState: {},
  } as any, encryptionPublicKey);
  return fakeProver.proveTx({ version: 'v9', tx: call.private.unprovenTx } as any);
};
const e2e: Record<string, { verdict: string; layer: string; reason: string; status?: number | null; rule?: string }> = {};
let transport: { requests: number; connections: number; maxRequestsPerConnection: number } | undefined;
const negativeVia = async (name: string, status: number, body: string, expectedLayer: 'prover' | 'decoding', withLog = true) => {
  answer = { status, body };
  const r = await expectRefusal({
    name, expectedLayer, bypassed: patched, ...(withLog ? { proofLog: log } : {}),
    attempt: () => prove(patched.Contract, BAD_TAG),
  });
  e2e[name] = { verdict: r.verdict, layer: r.layer, reason: r.reason, status: r.proofServer.at(-1)?.status, rule: r.rejection?.rule };
  return r;
};
try {
  for (const [status, body] of [[404, 'Not Found'], [401, 'Unauthorized'], [429, 'Job Queue full']] as const) {
    const hitsBefore = hits.length;
    const r = await negativeVia(`fake ${status}`, status, body, 'prover');
    assert.equal(r.verdict, 'ERROR', `HTTP ${status}: ${r.reason} ${r.detail}`);
    assert.equal(r.layer, 'infrastructure');
    assert.equal(hits.length, hitsBefore + 1, 'the request reached the fake server');
    assert.equal(r.proofServer.length, 1);
    assert.equal(r.proofServer[0].status, status, 'and was recorded with its status');
    assert.deepEqual(r.fired, [{ message: W64, count: 1 }], 'the bypass fired: only the HTTP answer makes it an ERROR');
  }
  const forged = await negativeVia('fake 404 carrying an assertion body', 404, BODY.assertion, 'prover');
  assert.equal(forged.verdict, 'ERROR');
  const decoding = await negativeVia('fake 400 decoding payload, expected prover', 400, BODY.canonicalK1, 'prover');
  assert.equal(decoding.verdict, 'FAIL', 'a decoding refusal is not a constraint');
  assert.equal(decoding.layer, 'decoding');
  const decodingOk = await negativeVia('fake 400 decoding payload, expected decoding', 400, BODY.canonicalK1, 'decoding');
  assert.equal(decodingOk.verdict, 'PASS');
  assert.equal(decodingOk.rejection?.rule, 'non-canonical-encoding');
  const constraint = await negativeVia('fake 400 Failed direct assertion', 400, BODY.assertion, 'prover');
  assert.equal(constraint.verdict, 'PASS', `${constraint.reason} ${constraint.detail}`);
  assert.equal(constraint.layer, 'prover');
  assert.equal(constraint.rejection?.rule, 'direct-assertion');
  const noLog = await negativeVia('fake 400 Failed direct assertion, no request log', 400, BODY.assertion, 'prover', false);
  assert.equal(noLog.verdict, 'ERROR', 'without the recorded request it is no verdict');
  const unrecognised = await negativeVia('fake 400 unrecognised payload', 400, "bad input: `couldn't find built-in key 0x00`", 'prover');
  assert.equal(unrecognised.verdict, 'ERROR');
  console.log('  ✓ end to end (ledger proving loop, recording provider, fake proof server): 404, 401 and 429 ERROR; a 404 with an assertion body ERROR; a decoding payload is `decoding` (FAIL when a constraint was expected); "Failed direct assertion" PASS at the prover; no request log ERROR; an unrecognised 400 ERROR');

  // ── Positive controls per patched copy ────────────────────────────────────
  // The proof server's answer to the honest call is simulated by a recorded
  // /prove 200 after a local execution through the copy.
  const provedLocally = (C: any) => async () => { await run(C, GOOD_TAG); log.push(req(200, undefined, '/prove')); };
  answer = { status: 400, body: BODY.assertion };
  const fresh = await loadBypassedContract(PROBE_JS, [W64], { overrides: OVERRIDES });
  const hitsBefore = hits.length;
  const noControl = await expectRefusal({ name: 'overridden copy, no positive control', expectedLayer: 'prover', bypassed: fresh, proofLog: log, attempt: () => prove(fresh.Contract, BAD_TAG) });
  assert.equal(noControl.verdict, 'ERROR');
  assert.match(noControl.reason, /no positive control proved through this patched copy/);
  assert.equal(hits.length, hitsBefore, 'the negative did not run');
  const missesCopy = await expectRefusal({ name: 'control through the original', expectedLayer: 'prover', bypassed: fresh, proofLog: log, positiveControl: provedLocally(Original.Contract), attempt: () => prove(fresh.Contract, BAD_TAG) });
  assert.equal(missesCopy.verdict, 'ERROR');
  assert.match(missesCopy.positiveControl!.reason, /did not run through the patched copy/);
  const dishonest = await expectRefusal({ name: 'control fires the bypass', expectedLayer: 'prover', bypassed: fresh, proofLog: log, positiveControl: async () => { await run(fresh.Contract, BAD_TAG); log.push(req(200, undefined, '/prove')); }, attempt: () => prove(fresh.Contract, BAD_TAG) });
  assert.equal(dishonest.verdict, 'ERROR');
  assert.equal(dishonest.positiveControl!.verdict, 'FAIL');
  assert.match(dishonest.positiveControl!.reason, /not honest/);
  const unproved = await expectRefusal({ name: 'control not proved', expectedLayer: 'prover', bypassed: fresh, proofLog: log, positiveControl: async () => { await run(fresh.Contract, GOOD_TAG); }, attempt: () => prove(fresh.Contract, BAD_TAG) });
  assert.equal(unproved.verdict, 'ERROR');
  assert.equal(unproved.positiveControl!.through?.proved, false);
  const refusedControl = await expectRefusal({ name: 'control refused by the prover', expectedLayer: 'prover', bypassed: fresh, proofLog: log, positiveControl: () => prove(fresh.Contract, GOOD_TAG), attempt: () => prove(fresh.Contract, BAD_TAG) });
  assert.equal(refusedControl.verdict, 'ERROR');
  assert.equal(refusedControl.positiveControl!.verdict, 'FAIL', 'the honest call refused at the prover: the copy is broken');
  assert.equal(fresh.positiveControls().length, 0, 'no failed control was recorded');
  const withControl = await expectRefusal({ name: 'overridden copy, control proved through it', expectedLayer: 'prover', bypassed: fresh, proofLog: log, positiveControl: provedLocally(fresh.Contract), attempt: () => prove(fresh.Contract, BAD_TAG) });
  assert.equal(withControl.verdict, 'PASS', `${withControl.reason} ${withControl.detail}`);
  assert.equal(withControl.positiveControl?.verdict, 'PASS');
  assert.equal(withControl.positiveControl?.through?.proved, true);
  assert.ok(withControl.positiveControl!.through!.usesDelta > 0);
  assert.equal(withControl.proofServer.length, 1, 'the negative records its own request only');
  assert.equal(fresh.positiveControls().length, 1);
  const later = await expectRefusal({ name: 'overridden copy, control recorded earlier', expectedLayer: 'prover', bypassed: fresh, proofLog: log, attempt: () => prove(fresh.Contract, BAD_TAG) });
  assert.equal(later.verdict, 'PASS', 'a control recorded on the copy counts for later negatives');
  // expectSuccess with `through` records a control.
  const other = await loadBypassedContract(PROBE_JS, [W64], { overrides: OVERRIDES });
  const pos = await expectSuccess({ name: 'honest call through the copy', proofLog: log, through: other, attempt: provedLocally(other.Contract) });
  assert.equal(pos.verdict, 'PASS');
  assert.equal(other.positiveControls().length, 1);
  assert.equal((await expectRefusal({ name: 'after expectSuccess', expectedLayer: 'prover', bypassed: other, proofLog: log, attempt: () => prove(other.Contract, BAD_TAG) })).verdict, 'PASS');
  // A plain copy (assert bypass only): a control is optional unless required.
  const plain = await loadBypassedContract(PROBE_JS, [W64]);
  assert.equal((await expectRefusal({ name: 'plain copy, no control', expectedLayer: 'prover', bypassed: plain, proofLog: log, attempt: () => prove(plain.Contract, BAD_TAG) })).verdict, 'PASS');
  const required = await expectRefusal({ name: 'plain copy, control required', expectedLayer: 'prover', bypassed: plain, proofLog: log, requirePositiveControl: true, attempt: () => prove(plain.Contract, BAD_TAG) });
  assert.equal(required.verdict, 'ERROR');
  // A negative whose call does not run through its copy is a FAIL (an
  // override-only copy has no bypass that could miss).
  const noBypass = await loadBypassedContract(PROBE_JS, [], { overrides: OVERRIDES });
  await expectSuccess({ name: 'control', proofLog: log, through: noBypass, attempt: provedLocally(noBypass.Contract) });
  const elsewhereCopy = await expectRefusal({ name: 'call misses the copy', expectedLayer: 'prover', bypassed: noBypass, proofLog: log, attempt: () => prove(patched.Contract, BAD_TAG) });
  assert.equal(elsewhereCopy.verdict, 'FAIL');
  assert.match(elsewhereCopy.reason, /did not run through the patched copy/);
  // A copy made elsewhere (no use counter, no control record) is no verdict.
  const { uses: _u, positiveControls: _p, recordPositiveControl: _r, ...foreign } = plain;
  assert.equal((await expectRefusal({ name: 'foreign copy', expectedLayer: 'prover', bypassed: foreign as any, proofLog: log, attempt: () => prove(plain.Contract, BAD_TAG) })).verdict, 'ERROR');
  assert.equal((await expectSuccess({ name: 'foreign copy', proofLog: log, through: foreign as any, attempt: provedLocally(plain.Contract) })).verdict, 'ERROR');
  // Missing pieces are ERROR, never a pass.
  assert.equal((await expectRefusal({ name: 'control without log', expectedLayer: 'prover', bypassed: fresh, positiveControl: provedLocally(fresh.Contract), attempt: () => prove(fresh.Contract, BAD_TAG) })).verdict, 'ERROR');
  assert.equal((await expectRefusal({ name: 'control without copy', expectedLayer: 'prover', proofLog: log, positiveControl: provedLocally(fresh.Contract), attempt: () => prove(fresh.Contract, BAD_TAG) })).verdict, 'ERROR');
  console.log('  ✓ positive controls: an overridden copy without a control is ERROR before its negative runs; a control through another module, a dishonest one, an unproved one, or one refused by the prover is ERROR; a control proved through the copy (by positiveControl or expectSuccess with through) lets the negative PASS; a plain copy needs one only when required; a call that misses its copy FAILs; a copy made elsewhere is ERROR');

  // ── Transport: one connection per request ─────────────────────────────────
  const perConnection = [...requestsPerConnection.values()];
  transport = { requests: hits.length, connections: perConnection.length, maxRequestsPerConnection: Math.max(0, ...perConnection) };
  assert.ok(hits.length >= 10, 'the fake server answered the requests above');
  assert.equal(perConnection.reduce((a, b) => a + b, 0), hits.length);
  assert.equal(perConnection.length, hits.length, `every request opened its own connection (${hits.length} requests on ${perConnection.length} connections)`);
  console.log(`  ✓ transport: ${hits.length} proof-server requests on ${perConnection.length} connections (none reused)`);
} finally {
  server.close();
}

// ── expectRefusal / expectSuccess: fail-closed verdicts ─────────────────────

const notRefused = await expectRefusal({ name: 'goes through', expectedLayer: 'prover', attempt: async () => 1 });
assert.equal(notRefused.verdict, 'FAIL');
const elsewhere = await expectRefusal({ name: 'runtime, not prover', expectedLayer: 'prover', attempt: async () => { throw Object.assign(new Error('failed assert: x'), { isCompactError: true }); } });
assert.equal(elsewhere.verdict, 'FAIL');
const missedLog: ProofServerRequest[] = [];
const missed = await expectRefusal({
  name: 'bypass never fired', expectedLayer: 'prover', bypassed: patched, proofLog: missedLog,
  attempt: async () => { patched.pureCircuits.derive_descriptor_entry_w64(GOOD_TAG, A, k, b, 0n, 0n); missedLog.push(req(400, BODY.assertion)); throw new ProofServerRefusal('/check', KEY, 400, BODY.assertion); },
});
assert.equal(missed.verdict, 'FAIL');
assert.match(missed.reason, /never fired/);
const infra = await expectRefusal({ name: 'no proof server', expectedLayer: 'prover', attempt: async () => { throw new Error('fetch failed', { cause: new Error('ECONNREFUSED') }); } });
assert.equal(infra.verdict, 'ERROR');
const goodLog: ProofServerRequest[] = [];
const good = await expectRefusal({
  name: 'refused at the prover after the bypass fired', expectedLayer: 'prover', bypassed: patched, proofLog: goodLog,
  attempt: async () => { patched.pureCircuits.derive_descriptor_entry_w64(BAD_TAG, A, k, b, 0n, 0n); goodLog.push(req(400, BODY.assertion)); throw new ProofServerRefusal('/check', KEY, 400, BODY.assertion); },
});
assert.equal(good.verdict, 'PASS');
const unrecorded = await expectRefusal({
  name: 'the same refusal, not recorded', expectedLayer: 'prover', bypassed: patched,
  attempt: async () => { patched.pureCircuits.derive_descriptor_entry_w64(BAD_TAG, A, k, b, 0n, 0n); throw new ProofServerRefusal('/check', KEY, 400, BODY.assertion); },
});
assert.equal(unrecorded.verdict, 'ERROR');
assert.equal((await expectSuccess({ name: 'ok', attempt: async () => 1 })).verdict, 'PASS');
assert.equal((await expectSuccess({ name: 'infra', attempt: async () => { throw new Error('ECONNREFUSED'); } })).verdict, 'ERROR');
console.log('  ✓ expectRefusal / expectSuccess: fail-closed verdicts');

if (process.env.EVIDENCE_DIR) {
  const file = path.join(process.env.EVIDENCE_DIR, 'constraint-negative-offline.json');
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    suite: 'constraint-negative-offline', ranAt: new Date().toISOString(),
    rejections: PROOF_SERVER_REJECTIONS.map((r) => ({ ...r, pattern: String(r.pattern) })),
    recordedBodies: Object.fromEntries(Object.entries(BODY).map(([key, body]) => [key, { body, recognised: recogniseRejection({ status: 400, body }) }])),
    classifyCases: cases.map(([name, , requests, layer]) => ({ name, requests: requests?.map((r) => `${r.endpoint} ${r.status ?? r.error}`) ?? null, layer })),
    endToEnd: e2e, transport, verdict: 'PASS',
  }, null, 2) + '\n');
  console.log(`\n■ evidence → ${file}`);
}
console.log('\n◆ constraint-negative-offline: PASS');
