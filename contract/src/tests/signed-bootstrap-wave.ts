// Uses real ledger state/VK decoding; provider reads are mocks. These checks
// cover interrupted-deployment inspection, not submission or chain finality.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ContractDeploy, ContractMaintenanceAuthority, ContractOperation, ContractState, Intent,
  sampleSigningKey, signatureVerifyingKey,
} from '@midnightntwrk/ledger-v9';
import { allCircuits, resumeAccountInWaves, type WaveDeploymentCheckpoint } from '../wallet/wave-deploy.js';

const verifier = new Uint8Array(readFileSync(new URL('../../contracts/managed/control/keys/deposit_public.verifier', import.meta.url)));
const otherVerifier = new Uint8Array(readFileSync(new URL('../../contracts/managed/control/keys/spend_public.verifier', import.meta.url)));
function operation(bytes = verifier) {
  const result = new ContractOperation(); result.verifierKey = bytes; return result;
}
function fixture() {
  const key = sampleSigningKey();
  const initial = new ContractState();
  initial.maintenanceAuthority = new ContractMaintenanceAuthority([signatureVerifyingKey(key)], 1, 0n);
  initial.setOperation('deposit_unshielded', operation());
  const deploy = new ContractDeploy(initial);
  const checkpoint: WaveDeploymentCheckpoint = { version: 1, address: String(deploy.address),
    initialState: initial.serialize(), deploymentIntent: Intent.new(new Date(Date.now() + 60000)).addDeploy(deploy).serialize(),
    privateStateId: 'bootstrap-checkpoint-test', firstArm: 'p256', retireAuthority: true };
  let live: ContractState | undefined = ContractState.deserialize(initial.serialize());
  let storedKey: typeof key | undefined = key;
  const providers = {
    zkConfigProvider: { getVerifierKey: async () => verifier },
    publicDataProvider: { queryContractState: async () => live },
    privateStateProvider: { getSigningKey: async () => storedKey, setContractAddress: async () => {} },
  };
  return { checkpoint, providers, key, initial,
    live: () => live!, setLive: (value: ContractState | undefined) => { live = value; },
    setKey: (value: typeof key | undefined) => { storedKey = value; } };
}

test('B11: a complete retired deployment resumes without its erased maintenance key', async () => {
  const f = fixture();
  for (const id of allCircuits()) f.live().setOperation(id, operation());
  f.live().maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 6n);
  // Actual ledger API supplies named operations and raw VKs as expected.
  assert.deepEqual(f.live().operations().sort(), allCircuits().sort());
  assert.deepEqual(f.live().operation('activate_initial_passkey')!.verifierKey, verifier);
  f.setKey(undefined);
  assert.equal(await resumeAccountInWaves(f.providers, f.checkpoint), f.checkpoint.address);
});

test('B11: partial deployment cannot proceed after key loss or premature authority retirement', async () => {
  const f = fixture(); f.setKey(undefined);
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /no usable maintenance/);
  f.setKey(f.key); f.live().maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 1n);
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /no usable maintenance/);
  f.setLive(undefined); f.setKey(undefined);
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /missing retained maintenance key/);
});

test('B11: checkpoint identity, installed verifier substitutions and extra operations reject before submission', async () => {
  const f = fixture();
  await assert.rejects(() => resumeAccountInWaves(f.providers, { ...f.checkpoint, address: '00'.repeat(32) }), /address mismatch/);
  const alteredInitial = ContractState.deserialize(f.checkpoint.initialState);
  alteredInitial.setOperation('activate_initial_passkey', operation());
  await assert.rejects(() => resumeAccountInWaves(f.providers, { ...f.checkpoint, initialState: alteredInitial.serialize() }), /initial state mismatch/);
  f.live().setOperation('activate_initial_passkey', operation(otherVerifier));
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /unexpected deployed verifier/);
  f.setLive(ContractState.deserialize(f.initial.serialize()));
  f.live().setOperation('unexpected_takeover', operation());
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /unexpected deployed verifier/);
});

test('B11: maintenance identity and configured retirement policy are checked even for complete rosters', async () => {
  const f = fixture(); f.setKey(sampleSigningKey());
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /does not match deployment checkpoint/);
  f.setKey(f.key);
  for (const id of allCircuits()) f.live().setOperation(id, operation());
  f.live().maintenanceAuthority = new ContractMaintenanceAuthority([signatureVerifyingKey(sampleSigningKey())], 1, 3n);
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /deployed maintenance authority/);
  f.live().maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 4n);
  await assert.rejects(() => resumeAccountInWaves(f.providers, { ...f.checkpoint, retireAuthority: false }), /unexpected retired/);
});
