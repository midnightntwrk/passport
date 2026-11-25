// node --import <contract>/node_modules/tsx/dist/loader.mjs generate.mjs CONTRACT WORK
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { accountFixtures } from './accounts.mjs';

if (process.argv.length !== 4) throw Error('Usage: generate.mjs CONTRACT WORK');
const [contract, work] = process.argv.slice(2).map(value => path.resolve(value));
const destination = path.join(work, 'preimages');
if (existsSync(destination)) throw Error('Fixtures already exist at ' + destination);
const req = createRequire(path.join(contract, 'package.json'));
const runtime = await import(req.resolve('@midnight-ntwrk/compact-runtime'));
const fixtures = new Map();

// AccountSim invokes this public dispatch table after constructing its context.
// Retain one successful call per circuit; use the original result to advance the simulator.
function captureCalls(circuits) {
  for (const [name, original] of Object.entries(circuits)) {
    circuits[name] = async (...args) => {
      const result = await original(...args);
      if (!fixtures.has(name)) {
        const trace = result.context.callProofDataTrace.at(-1);
        fixtures.set(name, runtime.proofDataIntoSerializedPreimage(
          trace.input, trace.output, trace.publicTranscript, trace.privateTranscriptOutputs, name,
        ));
      }
      return result;
    };
  }
}

await accountFixtures(contract, captureCalls);
const info = JSON.parse(readFileSync(path.join(contract, 'contracts/managed/account/compiler/contract-info.json')));
const accountNames = info.circuits.filter(circuit => circuit.proof).map(circuit => circuit.name).sort();
assert(accountNames.length > 0, 'Compiled account has no proof-bearing circuits');
assert.deepEqual([...fixtures.keys()].sort(), accountNames, 'Fixture coverage differs from the compiled account');

const { K256Device } = await import(path.join(contract, 'src/wallet/signer.ts'));
const { softwarePasskey } = await import(path.join(contract, 'src/tests/p256-fixtures.ts'));
const { parseES256Signature } = await import(path.join(contract, 'src/wallet/webauthn.ts'));
const vector = JSON.parse(readFileSync(path.join(contract, '../experiments/p256-in-circuit/webauthn/vector.json')));
const sha256 = bytes => new Uint8Array(createHash('sha256').update(bytes).digest());
const hex = value => new Uint8Array(Buffer.from(value, 'hex'));
const challenge = hex(vector.challenge_hex);
const authData = hex(vector.authenticator_data_hex);
const digest = sha256(Buffer.concat([authData, sha256(Buffer.from(vector.client_data_json_b64url, 'base64url'))]));
const signature = parseES256Signature(hex(vector.signature_der_hex));
const pk = { x: BigInt('0x' + vector.pk_x_hex), y: BigInt('0x' + vector.pk_y_hex), identity: false };
const { policy } = softwarePasskey();
const k1 = K256Device.generate();
const webauthn = [challenge, policy, authData, signature, pk];

const probes = [
  ['acc-profile-probe-k1', [
    ['verify_k1', [k1.signedDigest(challenge), k1.sign(challenge, 0n).sig, k1.pk]],
  ]],
  ['acc-profile-probe-p256', [
    ['verify_ecdsa', [digest, signature, pk]],
    ['verify_webauthn', webauthn],
    ['verify_webauthn_profiled', [...webauthn, false]],
  ]],
];

// Standalone compiler output has no npm project. Load its unmodified ESM
// alongside a link to the same runtime used by AccountSim and the fixture code.
const staging = mkdtempSync(path.join(work, '.fixture-build-'));
try {
  symlinkSync(path.join(contract, 'node_modules'), path.join(staging, 'node_modules'), 'dir');
  for (const [artifact, cases] of probes) {
    const modulePath = path.join(staging, artifact + '.mjs');
    copyFileSync(path.join(work, artifact, 'contract/index.js'), modulePath);
    const { Contract } = await import(modulePath);
    const probe = new Contract({});
    captureCalls(probe.impureCircuits);
    const coinPublicKey = { bytes: new Uint8Array(32) };
    const initial = await probe.initialState(runtime.createConstructorContext({}, coinPublicKey));
    for (const [name, args] of cases) {
      const context = runtime.createCircuitContext({
        circuitId: name, contractAddress: runtime.sampleContractAddress(),
        coinPublicKeyOrZswapState: coinPublicKey, contractState: initial.currentContractState.data,
        privateState: {},
      });
      await probe.impureCircuits[name](context, ...args);
    }
  }
  const files = path.join(staging, 'preimages');
  mkdirSync(files, { mode: 0o700 });
  for (const [name, bytes] of fixtures) writeFileSync(path.join(files, name + '.bin'), bytes, { mode: 0o600 });
  renameSync(files, destination);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log('Captured ' + accountNames.length + ' account and ' +
  (fixtures.size - accountNames.length) + ' standalone fixtures in ' + destination);
