// Constraint checks, real proof generation and structural in-memory ledger
// application. The ledger WASM build does not cryptographically verify proofs.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CompactTypeSecp256k1Point, createCircuitContext, createConstructorContext,
  sampleContractAddress, type Secp256k1Point,
} from '@midnight-ntwrk/compact-runtime';
import {
  ContractDeploy, ContractOperation, ContractState, CostModel, Intent, LedgerParameters,
  LedgerState, PrePartitionContractCall, PreTranscript, QueryContext, Transaction,
  TransactionContext, WellFormedStrictness, communicationCommitmentRandomness,
  createCheckPayload, parseCheckResult, proofDataIntoSerializedPreimage, type ProvingProvider,
} from '@midnightntwrk/ledger-v9';
import {
  Contract, type ImpureCircuits, type Witnesses,
} from '../contracts/managed/probe-bip340/contract/index.js';
import { checkStreamingEncoding, proveStream } from './proof-provider.js';
import { vectors, vectorSource, type Vector } from './fixtures.js';
import {
  fieldOrder, fixedPointWitness, identity, liftX, witnesses, type PrivateState,
} from './witnesses.js';

const root = new URL('../', import.meta.url);
const managed = new URL('contracts/managed/probe-bip340/', root);
const output = new URL('evidence/', root);
const captures = new URL('proof-artifacts/', managed);
mkdirSync(output, { recursive: true });
mkdirSync(captures, { recursive: true });
const endpoint = 'http://127.0.0.1:6391';
const network = 'undeployed';
const startedAt = new Date().toISOString();
const coinKey = { bytes: new Uint8Array(32) };
const params = LedgerParameters.initialParameters();
const cost = CostModel.initialCostModel();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Circuit = keyof ImpureCircuits<PrivateState>;
const circuitNames: Circuit[] = ['verify_0', 'verify_1', 'verify_17', 'verify_32', 'verify_100'];
const circuitFor = (vector: Vector): Circuit => {
  const circuit = `verify_${vector.message.length}` as Circuit;
  assert.ok(circuitNames.includes(circuit));
  return circuit;
};
const material = Object.fromEntries(circuitNames.map(name => {
  const files = [`keys/${name}.prover`, `keys/${name}.verifier`, `zkir/${name}.bzkir`]
    .map(file => fileURLToPath(new URL(file, managed)));
  return [name, { files, verifierKey: readFileSync(files[1]), ir: readFileSync(files[2]) }];
})) as unknown as Record<Circuit, { files: string[]; verifierKey: Uint8Array; ir: Uint8Array }>;
const checks: unknown[] = [];
const proofs: unknown[] = [];
let failure: string | undefined;

async function checkRaw(
  preimage: Uint8Array, circuit: Circuit,
  rejection: false | 'circuit' | 'native-point-decoding' = false,
) {
  const response = await fetch(new URL('/check', endpoint), {
    method: 'POST', body: createCheckPayload(preimage, material[circuit].ir) as BodyInit,
    headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(120_000),
  });
  if (rejection) {
    const reason = await response.text();
    assert.equal(response.status, 400, `invalid assignment accepted or infrastructure failed: ${reason}`);
    const expected = rejection === 'native-point-decoding'
      ? /Failed to decode \[Fq\(.*\] as Secp256k1Point/
      : /assert|constraint|Cannot extract coordinates of the Secp256k1 identity/i;
    assert.match(reason, expected,
      `negative must fail the circuit, not HTTP, serialisation or generated JavaScript: ${reason}`);
    return reason;
  }
  assert.equal(response.status, 200, await response.clone().text());
  return parseCheckResult(new Uint8Array(await response.arrayBuffer()));
}

async function traceFor(vector: Vector, bypassFinalAssertion = false) {
  // These keys are intentionally unliftable. Supply a real, unrelated point so
  // their rejection tests the circuit's key binding, not noble's host validator.
  const selected: Witnesses<PrivateState> = vector.index === 5 || vector.index === 14
    ? fixedPointWitness(liftX(vectors[0].publicKey)) : witnesses;
  const contract = new Contract<PrivateState>(selected);
  if (bypassFinalAssertion) {
    // Test-only mutation of this instance, never of generated files or ZKIR.
    // Run the original verifier to populate its witness transcript, then mask
    // its Boolean result so the caller constructs a fresh ledger transcript.
    // /check still runs the ORIGINAL binary circuit and its final assertion.
    type Verifier = (...args: unknown[]) => Promise<boolean>;
    const internal = contract as unknown as Record<string, Verifier>;
    for (let index = 0; index < circuitNames.length; index++) {
      const name = `_verifyBip340_${index}`;
      const original = internal[name];
      assert.equal(typeof original, 'function', `compiler internals changed: ${name}`);
      internal[name] = async (...args: unknown[]) => { await original.apply(contract, args); return true; };
    }
  }
  const initial = await contract.initialState(createConstructorContext({}, coinKey));
  const circuit = circuitFor(vector);
  const result = await contract.impureCircuits[circuit](createCircuitContext({
    circuitId: circuit, contractAddress: sampleContractAddress(),
    coinPublicKeyOrZswapState: coinKey, contractState: initial.currentContractState, privateState: {},
  }), vector.publicKey, vector.message, vector.signature);
  const trace = result.context.callProofDataTrace.at(-1)!;
  assert.equal(trace.privateTranscriptOutputs.length, 1, 'expected only the lift_x witness');
  return { trace, circuit };
}

type Trace = Awaited<ReturnType<typeof traceFor>>['trace'];
const preimage = (trace: Trace, circuit: Circuit) => proofDataIntoSerializedPreimage(
  trace.input, trace.output, trace.publicTranscript, trace.privateTranscriptOutputs, circuit,
);

async function checkConstraints() {
  for (const vector of vectors) {
    const { trace, circuit } = await traceFor(vector, !vector.valid);
    const reason = await checkRaw(preimage(trace, circuit), circuit, vector.valid ? false : 'circuit');
    checks.push({ name: `official vector ${vector.index}`, valid: vector.valid,
      messageBytes: vector.message.length, comment: vector.comment,
      result: vector.valid ? 'ACCEPTED' : 'REJECTED',
      ...(vector.valid ? {} : { reason }) });
    console.log(`PASS ZKIR ${vector.valid ? 'accept' : 'reject'} official vector ${vector.index}`);
  }
  const { trace, circuit } = await traceFor(vectors[0]);
  const point = liftX(vectors[0].publicKey);
  const attacks: [string, Secp256k1Point][] = [
    ['unrelated valid lift point', liftX(vectors[1].publicKey)],
    ['odd-Y lift point with the correct x', { ...point, y: fieldOrder - point.y }],
    ['identity lift point', identity],
    ['off-curve lift point with the correct x and even y', { ...point, y: point.y + 2n }],
  ];
  for (const [name, forgedPoint] of attacks) {
    const forged = structuredClone(trace);
    // Direct raw witness assignment bypasses generated type checks and noble.
    // Inputs and their public SHA-256 commitment remain correct and unchanged.
    forged.privateTranscriptOutputs[0] = {
      value: CompactTypeSecp256k1Point.toValue(forgedPoint),
      alignment: CompactTypeSecp256k1Point.alignment(),
    };
    const rejectionLayer = name.startsWith('off-curve') ? 'native-point-decoding' : 'circuit';
    const reason = await checkRaw(preimage(forged, circuit), circuit, rejectionLayer);
    checks.push({ name, result: 'REJECTED', rejectionLayer, reason });
    console.log(`PASS ZKIR reject ${name}`);
  }
}

const strictness = new WellFormedStrictness();
// Laboratory-only ledger: omit transaction fees. These flags stay enabled, but
// ledger-v9 WASM is built without proof-verifying; native verification is separate.
strictness.enforceBalancing = false;
assert.equal(strictness.verifyContractProofs, true);
assert.equal(strictness.verifyNativeProofs, true);
assert.equal(strictness.verifySignatures, true);
const provider: ProvingProvider = {
  lookupKey: async location => {
    assert.ok(circuitNames.includes(location as Circuit), `unknown key location ${location}`);
    const { verifierKey, ir } = material[location as Circuit];
    return { proverKey: new Uint8Array(), verifierKey, ir };
  },
  check: async (data, location) => {
    assert.ok(circuitNames.includes(location as Circuit));
    return await checkRaw(data, location as Circuit) as (bigint | undefined)[];
  },
  prove: async (data, location, binding) => {
    assert.ok(circuitNames.includes(location as Circuit));
    checkStreamingEncoding(data);
    const result = await proveStream(endpoint, data, binding, material[location as Circuit].files);
    proofs.push({ circuit: location, proofBytes: result.proof.length,
      proveRequestMilliseconds: result.milliseconds, requestBytes: result.requestBytes,
      proofSha256: sha256(result.proof) });
    // Public official fixtures only. These ignored artifacts allow a native
    // verifier to consume the exact preimage, proof, key and binding override.
    writeFileSync(new URL(`${location}.preimage`, captures), data);
    writeFileSync(new URL(`${location}.proof`, captures), result.proof);
    writeFileSync(new URL(`${location}.json`, captures), JSON.stringify({
      circuit: location, binding: binding?.toString(),
      verifierKey: material[location as Circuit].files[1],
      ir: material[location as Circuit].files[2],
      preimageSha256: sha256(data), proofSha256: sha256(result.proof),
    }, null, 2) + '\n');
    return result.proof;
  },
};

async function proveVector(vector: Vector) {
  const circuit = circuitFor(vector);
  const now = new Date(), ttl = new Date(now.getTime() + 60 * 60_000);
  const block = { secondsSinceEpoch: BigInt(Math.floor(now.getTime() / 1000)), secondsSinceEpochErr: 0,
    parentBlockHash: '00'.repeat(32), lastBlockTime: BigInt(Math.floor(now.getTime() / 1000)) };
  const contract = new Contract<PrivateState>(witnesses);
  const initial = await contract.initialState(createConstructorContext({}, coinKey));
  const state = ContractState.deserialize(initial.currentContractState.serialize());
  for (const name of circuitNames) {
    const operation = new ContractOperation();
    operation.verifierKey = material[name].verifierKey;
    state.setOperation(name, operation);
  }
  const deploy = new ContractDeploy(state);
  let ledgerState = LedgerState.blank(network);
  const deployTx = await Transaction.fromParts(network, undefined, undefined, Intent.new(ttl).addDeploy(deploy))
    .prove(provider, cost);
  const [next, deployment] = ledgerState.apply(deployTx.bind().wellFormed(ledgerState, strictness, now),
    new TransactionContext(ledgerState, block));
  assert.equal(deployment.type, 'success', deployment.toString());
  ledgerState = next;
  const result = await contract.impureCircuits[circuit](createCircuitContext({
    circuitId: circuit, contractAddress: deploy.address, coinPublicKeyOrZswapState: coinKey,
    contractState: initial.currentContractState, privateState: {},
  }), vector.publicKey, vector.message, vector.signature);
  const trace = result.context.callProofDataTrace.at(-1)!;
  const operation = new ContractOperation();
  operation.verifierKey = material[circuit].verifierKey;
  const call = new PrePartitionContractCall(deploy.address, circuit, operation,
    new PreTranscript(new QueryContext(state.data, deploy.address), trace.publicTranscript),
    trace.privateTranscriptOutputs, trace.input, trace.output, communicationCommitmentRandomness(), circuit);
  const tx = Transaction.fromParts(network).addCalls({ tag: 'first' }, [call], params, ttl);
  console.log(`Proving official vector ${vector.index} (${vector.message.length} message bytes)`);
  const start = performance.now();
  const bound = (await tx.prove(provider, cost)).bind();
  const structuralCheckStart = performance.now();
  const verified = bound.wellFormed(ledgerState, strictness, now);
  const [, applied] = ledgerState.apply(verified, new TransactionContext(ledgerState, block));
  assert.equal(applied.type, 'success', applied.toString());
  const structuralCheckMilliseconds = performance.now() - structuralCheckStart;
  const serialised = bound.serialize();
  checks.push({ name: `official vector ${vector.index} real proof`, result: 'PASS',
    messageBytes: vector.message.length, transactionBytes: serialised.length,
    endToEndMilliseconds: performance.now() - start, structuralCheckMilliseconds,
    transactionSha256: sha256(serialised) });
  console.log(`PASS generated and structurally applied ${circuit} proof (${serialised.length} transaction bytes)`);
}

try {
  await checkConstraints();
  // Three representative lengths exercise empty input, the common digest-sized
  // input and a longer message. /check covers every official positive above.
  for (const index of [0, 15, 18]) await proveVector(vectors[index]);
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }

const sources = [
  'contracts/bip340.compact', 'contracts/probe-bip340.compact',
  'src/prove.ts', 'src/witnesses.ts', 'src/fixtures.ts',
  'src/proof-provider.ts',
];
writeFileSync(new URL('proofs.json', output), JSON.stringify({
  result: failure ? 'FAIL' : 'PASS', startedAt, completedAt: new Date().toISOString(),
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  evidenceLayer: 'Original ZKIR /check for positive and forged negative assignments; local proof-server generation; ledger-v9 structural wellFormed and in-memory apply; fee balancing disabled; no node submission',
  limitation: 'ledger-v9 WASM omits the proof-verifying build feature. Its verification flags do not establish cryptographic proof verification; use the separate native verifier and its evidence.',
  compilerInfo: JSON.parse(readFileSync(new URL('compiler/contract-info.json', managed), 'utf8')),
  proofServerImage: 'midnightntwrk/proof-server:9.0.0-rc.8',
  runtimeVersions: Object.fromEntries(['@midnight-ntwrk/compact-runtime', '@midnightntwrk/ledger-v9']
    .map(name => [name, JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, root), 'utf8')).version])),
  fixture: vectorSource,
  sources: Object.fromEntries(sources.map(file => [file, sha256(readFileSync(new URL(file, root)))])),
  circuits: Object.fromEntries(circuitNames.map(name => [name, {
    verifierKeySha256: sha256(material[name].verifierKey), irSha256: sha256(material[name].ir),
  }])),
  checks, proofs, failure,
}, null, 2) + '\n');
if (failure) throw new Error(failure);
