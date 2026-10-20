// Generated Compact JavaScript execution, including adversarial witness values.
// Passing these tests is not evidence that a ZK proof has been generated.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  createCircuitContext, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract, ledger,
  type ImpureCircuits, type Witnesses,
} from '../../../contracts/managed/probe-bip340/contract/index.js';
import { vectors, vectorSource, type Vector } from './fixtures.js';
import {
  bytes32, fieldOrder, fixedPointWitness, identity, liftX, scalarOrder, witnesses,
  type PrivateState,
} from './witnesses.js';

const invalidSignature = /invalid BIP-340 signature/;
const sha256 = (...bytes: Uint8Array[]) =>
  new Uint8Array(createHash('sha256').update(Buffer.concat(bytes)).digest());
type Circuit = keyof ImpureCircuits<PrivateState>;

function circuitFor(length: number): Circuit {
  assert.ok([0, 1, 17, 32, 100].includes(length), `missing probe for message length ${length}`);
  return `verify_${length}` as Circuit;
}

async function harness(customWitnesses: Witnesses<PrivateState> = witnesses) {
  const contract = new Contract<PrivateState>(customWitnesses);
  const address = sampleContractAddress();
  const coinKey = { bytes: new Uint8Array(32) };
  const initial = await contract.initialState(createConstructorContext({}, coinKey));
  // Each invocation begins from the same empty probe state. A rejected call
  // cannot affect another case, and setup failures occur outside assert.rejects.
  return async (name: Circuit, publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
    const context = createCircuitContext({ circuitId: name, contractAddress: address,
      coinPublicKeyOrZswapState: coinKey, contractState: initial.currentContractState, privateState: {} });
    return contract.impureCircuits[name](context, publicKey, message, signature);
  };
}

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log('PASS', name);
}

// Noble is an independent oracle for these official vectors, not the complete
// BIP340 definition: noble 2.2 deliberately rejects s=0, while BIP340 permits it.
for (const vector of vectors) {
  await test(`official vector ${vector.index}: ${vector.valid ? 'accept' : 'reject'}${vector.comment ? ' (' + vector.comment + ')' : ''}`, async () => {
    assert.equal(schnorr.verify(vector.signature, vector.message, vector.publicKey), vector.valid,
      'independent implementation disagrees with the official fixture');
    // Vectors 5 and 14 have no liftable key. Feed a real unrelated point to the
    // circuit so these cases test its byte binding rather than host validation.
    const substituted = vector.index === 5 || vector.index === 14;
    const call = await harness(substituted ? fixedPointWitness(liftX(vectors[0].publicKey)) : witnesses);
    const invoke = () => call(circuitFor(vector.message.length), vector.publicKey, vector.message, vector.signature);
    if (!vector.valid) {
      await assert.rejects(invoke, invalidSignature);
      return;
    }
    const result = await invoke();
    assert.deepEqual(ledger(result.context.callContext.currentQueryContext.state).accepted,
      sha256(vector.publicKey, vector.message, vector.signature), 'probe must bind the exact input bytes');
  });
}

const good = vectors[0];
const goodPoint = liftX(good.publicKey);
const otherPoint = liftX(schnorr.getPublicKey(bytes32(1n)));
const call = await harness();
const invoke = (vector: Pick<Vector, 'publicKey' | 'message' | 'signature'>) =>
  call('verify_32', vector.publicKey, vector.message, vector.signature);

for (const [name, point] of [
  ['unrelated valid point', otherPoint],
  ['same x with odd y', { ...goodPoint, y: fieldOrder - goodPoint.y }],
  ['identity', identity],
] as const) {
  await test(`malicious lift witness: ${name}`, async () => {
    const maliciousCall = await harness(fixedPointWitness(point));
    await assert.rejects(() => maliciousCall('verify_32', good.publicKey, good.message, good.signature), invalidSignature);
  });
}

await test('malicious lift witness: off-curve point rejected by native point validation', async () => {
  // Keep x bound and y even, ensuring this reaches native point validation.
  const maliciousCall = await harness(fixedPointWitness({ ...goodPoint, y: goodPoint.y + 2n }));
  await assert.rejects(() => maliciousCall('verify_32', good.publicKey, good.message, good.signature),
    /point|curve|secp256k1/i);
});

await test('malicious lift witness: noncanonical coordinate cannot alias the public key', async () => {
  const maliciousCall = await harness(fixedPointWitness({ ...goodPoint, x: goodPoint.x + fieldOrder }));
  await assert.rejects(() => maliciousCall('verify_32', good.publicKey, good.message, good.signature),
    /field|range|point|curve|secp256k1/i);
});

for (const [name, scalar] of [['n', scalarOrder], ['n+1', scalarOrder + 1n], ['maximum 256-bit value', (1n << 256n) - 1n]] as const) {
  await test(`noncanonical signature scalar ${name} rejected`, async () => {
    const signature = new Uint8Array(good.signature);
    signature.set(bytes32(scalar), 32);
    await assert.rejects(() => invoke({ ...good, signature }), invalidSignature);
  });
}

for (const [name, r] of [['p', fieldOrder], ['p+1', fieldOrder + 1n], ['maximum 256-bit value', (1n << 256n) - 1n]] as const) {
  await test(`noncanonical signature r ${name} rejected`, async () => {
    const signature = new Uint8Array(good.signature);
    signature.set(bytes32(r));
    await assert.rejects(() => invoke({ ...good, signature }), invalidSignature);
  });
}

for (const field of ['publicKey', 'message', 'signature'] as const) {
  await test(`one-bit ${field} substitution rejected`, async () => {
    const altered = { ...good, [field]: new Uint8Array(good[field]) };
    altered[field][0] ^= 1;
    // A substituted public key need not be liftable. Preserve the original
    // witness deliberately: the circuit must bind it to the supplied key bytes.
    const boundCall = await harness(fixedPointWitness(goodPoint));
    await assert.rejects(() => boundCall('verify_32', altered.publicKey, altered.message, altered.signature), invalidSignature);
  });
}

for (const [field, length] of [
  ['publicKey', 31], ['publicKey', 33], ['message', 31], ['message', 33],
  ['signature', 63], ['signature', 65],
] as const) {
  await test(`generated API rejects ${field} length ${length}`, async () => {
    const bytes = new Uint8Array(length);
    bytes.set(good[field].subarray(0, length));
    // This checks the fixed-width generated API, not a separate circuit-level
    // variable-length encoding policy.
    await assert.rejects(() => invoke({ ...good, [field]: bytes }), /length|size|bytes|Uint8Array/i);
  });
}

await test('independent generated signatures at every supported message length', async () => {
  const secret = bytes32(0x1234567890abcdefn);
  const publicKey = schnorr.getPublicKey(secret);
  for (const length of [0, 1, 17, 32, 100]) {
    const message = Uint8Array.from({ length }, (_, index) => (index * 73 + length) & 255);
    const signature = schnorr.sign(message, secret, new Uint8Array(32));
    const result = await call(circuitFor(length), publicKey, message, signature);
    assert.deepEqual(ledger(result.context.callContext.currentQueryContext.state).accepted,
      sha256(publicKey, message, signature));
  }
});

console.log(JSON.stringify({ result: 'PASS', tests: passed, officialVectors: vectors.length,
  fixture: vectorSource, evidenceLayer: 'generated Compact JavaScript execution; no ZK proofs' }, null, 2));
