// Real proof-server generation plus ledger-v9 cryptographic verification in an
// isolated in-memory ledger. No wallet, fees, indexer or node submission.
import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import {
  ContractDeploy, ContractOperation, ContractState, CostModel, Intent, LedgerParameters,
  LedgerState, PrePartitionContractCall, PreTranscript, QueryContext, communicationCommitmentRandomness,
  Transaction, TransactionContext, WellFormedStrictness, createCheckPayload,
  parseCheckResult, proofDataIntoSerializedPreimage, type ProvingProvider,
} from '@midnightntwrk/ledger-v9';
import { Contract, pureCircuits } from '../../../contracts/managed/probe-webauthn-variable/contract/index.js';
import { parseES256Signature } from '../../wallet/webauthn.js';
import { padded, witnesses } from './witnesses.js';
import { checkStreamingEncoding, proveStream } from './proof-provider.js';

const root = new URL('../../../', import.meta.url);
const output = new URL('evidence/webauthn-variable-json/', root);
mkdirSync(output, { recursive: true });
const managed = new URL('contracts/managed/probe-webauthn-variable/', root);
const files = ['keys/verify_webauthn.prover', 'keys/verify_webauthn.verifier', 'zkir/verify_webauthn.bzkir']
  .map(p => fileURLToPath(new URL(p, managed)));
const vk = readFileSync(files[1]), ir = readFileSync(files[2]);
const endpoint = 'http://127.0.0.1:6300';
const network = 'undeployed';
const params = LedgerParameters.initialParameters();
const cost = CostModel.initialCostModel();
const sha = (x: Uint8Array | string) => new Uint8Array(createHash('sha256').update(x).digest());
const hex = (x: Uint8Array) => Buffer.from(x).toString('hex');
const utf8 = (x: string) => new TextEncoder().encode(x);
const samples: unknown[] = [];
const checks: unknown[] = [];
const startedAt = new Date().toISOString();
let failure: string | undefined;

const strictness = new WellFormedStrictness();
// Fee-less laboratory ledger; signature and contract/native-proof verification
// stay enabled. This is cryptographic proof verification, not node acceptance.
strictness.enforceBalancing = false;
assert.equal(strictness.verifyContractProofs, true);
assert.equal(strictness.verifyNativeProofs, true);
assert.equal(strictness.verifySignatures, true);
const provider: ProvingProvider = {
  lookupKey: async () => ({ proverKey: new Uint8Array(), verifierKey: vk, ir }),
  check: async preimage => {
    const response = await fetch(new URL('/check', endpoint), {
      method: 'POST', body: createCheckPayload(preimage, ir) as BodyInit,
      headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`check ${response.status}: ${await response.text()}`);
    return parseCheckResult(new Uint8Array(await response.arrayBuffer()));
  },
  prove: async (preimage, _location, binding) => {
    checkStreamingEncoding(preimage);
    const result = await proveStream(endpoint, preimage, binding, files);
    samples.push({ proofBytes: result.proof.length, proveRequestMilliseconds: result.milliseconds,
      requestBytes: result.requestBytes, proofSha256: hex(sha(result.proof)) });
    return result.proof;
  },
};

async function run(length: number, limited: boolean) {
  console.log(`Preparing ${length}-byte ${limited ? 'limited' : 'strict'} WebAuthn proof`);
  const now = new Date(), ttl = new Date(now.getTime() + 60 * 60_000);
  const block = { secondsSinceEpoch: BigInt(Math.floor(now.getTime() / 1000)), secondsSinceEpochErr: 0,
    parentBlockHash: '00'.repeat(32), lastBlockTime: BigInt(Math.floor(now.getTime() / 1000)) };
  const challenge = sha(`real-proof-${length}`), rpHash = sha('example.test');
  const origin = length === 140 ? 'https://wallet.example.test' : 'https://example.test';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pk = { x: BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex')),
    y: BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex')), identity: false };
  const clientObject = { type: 'webauthn.get', challenge: Buffer.from(challenge).toString('base64url'), origin, crossOrigin: false };
  let bytes = utf8(JSON.stringify(clientObject));
  if (limited) {
    const empty = JSON.stringify({ ...clientObject, extra: '' });
    bytes = utf8(JSON.stringify({ ...clientObject, extra: 'x'.repeat(length - utf8(empty).length) }));
  }
  assert.equal(bytes.length, length);
  const auth = new Uint8Array([...rpHash, 5, 0, 0, 0, 0]);
  const signature = parseES256Signature(new Uint8Array(sign('sha256', Buffer.concat([auth, sha(bytes)]), privateKey)));
  const policy = pureCircuits.policy_commitment(rpHash, padded(utf8(origin), 96), BigInt(origin.length), pk);
  const contract = new Contract(witnesses), coinPk = { bytes: new Uint8Array(32) };
  const initial = await contract.initialState(createConstructorContext({}, coinPk), challenge, policy, limited);
  const state = ContractState.deserialize(initial.currentContractState.serialize());
  const op = new ContractOperation(); op.verifierKey = vk; state.setOperation('verify_webauthn', op);
  const hashOp = new ContractOperation();
  hashOp.verifierKey = readFileSync(new URL('keys/hash_bytes.verifier', managed));
  state.setOperation('hash_bytes', hashOp);
  const deploy = new ContractDeploy(state);
  let ledgerState = LedgerState.blank(network);
  const deployTx = await Transaction.fromParts(network, undefined, undefined, Intent.new(ttl).addDeploy(deploy))
    .prove(provider, cost);
  const [next, deploymentResult] = ledgerState.apply(deployTx.bind().wellFormed(ledgerState, strictness, now),
    new TransactionContext(ledgerState, block));
  assert.equal(deploymentResult.type, 'success', deploymentResult.toString());
  ledgerState = next;
  const context = createCircuitContext({ circuitId: 'verify_webauthn', contractAddress: deploy.address,
    coinPublicKeyOrZswapState: coinPk, contractState: initial.currentContractState, privateState: {} });
  const result = await contract.impureCircuits.verify_webauthn(context, padded(bytes, 256), BigInt(length), rpHash, auth, signature, pk);
  const trace = result.context.callProofDataTrace.at(-1)!;
  const preimage = () => proofDataIntoSerializedPreimage(trace.input, trace.output, trace.publicTranscript,
    trace.privateTranscriptOutputs, 'verify_webauthn');
  await provider.check(preimage(), 'verify_webauthn');
  console.log(`PASS ZKIR check for ${length} bytes`);
  // Bypass the generated JS assertions and forge the raw witness transcript.
  // /check must reject the assignment in the constraint system itself.
  if (length === 140) {
    const word = trace.privateTranscriptOutputs[1];
    const original = word.value[0];
    word.value[0] = Uint8Array.of(original[0] === 1 ? 0 : 1);
    await assert.rejects(() => provider.check(preimage(), 'verify_webauthn'), /check 400/);
    word.value[0] = original;
    checks.push({ name: 'forged SHA bit rejected by ZKIR check, bypassing JS', result: 'PASS' });
  }
  const query = new QueryContext(state.data, deploy.address);
  const call = new PrePartitionContractCall(deploy.address, 'verify_webauthn', op, new PreTranscript(query, trace.publicTranscript),
    trace.privateTranscriptOutputs, trace.input, trace.output, communicationCommitmentRandomness(), 'verify_webauthn');
  const tx = Transaction.fromParts(network).addCalls({ tag: 'first' }, [call], params, ttl);
  writeFileSync(new URL(`sample-${length}.unproven`, output), tx.serialize());
  console.log(`Proving ${length} bytes (large key streamed to local server)`);
  const start = performance.now();
  const proven = await tx.prove(provider, cost);
  const bound = proven.bind();
  const verificationStart = performance.now();
  const verified = bound.wellFormed(ledgerState, strictness, now);
  const verificationMilliseconds = performance.now() - verificationStart;
  const [, applied] = ledgerState.apply(verified, new TransactionContext(ledgerState, block));
  assert.equal(applied.type, 'success', applied.toString());
  const raw = bound.serialize();
  writeFileSync(new URL(`sample-${length}.proven`, output), raw);
  checks.push({ name: `${length}-byte ${limited ? 'limited' : 'strict'} WebAuthn real proof`, result: 'PASS',
    transactionBytes: raw.length, endToEndMilliseconds: performance.now() - start,
    verificationMilliseconds, transactionSha256: hex(sha(raw)) });
  console.log(`PASS verified and applied ${length}-byte proof (${raw.length} transaction bytes)`);
}

try {
  for (const length of [140, 256]) await run(length, length === 256);
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
writeFileSync(new URL('proofs.json', output), JSON.stringify({
  result: failure ? 'FAIL' : 'PASS', startedAt, completedAt: new Date().toISOString(),
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  evidenceLayer: 'local proof server plus ledger-v9 wellFormed(verifyContractProofs=true) and in-memory apply; fee balancing disabled; no node submission',
  signer: 'Node/OpenSSL software ES256', compiler: '0.35.0',
  proofServerImage: 'midnightntwrk/proof-server:9.0.0-rc.8',
  sources: Object.fromEntries(['contracts/probe-webauthn-variable.compact', 'src/tests/webauthn-variable/prove.ts',
    'src/tests/webauthn-variable/proof-provider.ts', 'src/tests/webauthn-variable/witnesses.ts'].map(p => [p, hex(sha(readFileSync(new URL(p, root))))])),
  verifierKeySha256: hex(sha(vk)), irSha256: hex(sha(ir)), checks, samples, failure,
}, null, 2) + '\n');
if (failure) throw new Error(failure);
