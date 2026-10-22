// Exercise the SDK/artifact boundary as well as the generated JavaScript:
// manifest-checked deployment construction, ledger class conversion, and
// wave-maintenance key decoding/signing. No proofs or network submission.
import { strict as assert } from 'node:assert';
import { createUnprovenDeployTxFromVerifierKeys } from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  ContractState, ContractOperationVersionedVerifierKey, MaintenanceUpdate,
  VerifierKeyInsert, sampleSigningKey, signData,
} from '@midnightntwrk/ledger-v9';
import { compiledAccountContract, compiledControlContract, compiledFaucetContract } from '../node/setup.js';
import { zkConfigPath, controlZkConfigPath, faucetZkConfigPath } from '../node/wallet.js';
import { JubjubDevice } from '../wallet/signer.js';
import { Contract } from '../wallet/contract.js';
import { emptyCoinStore, makeWitnesses } from '../wallet/witnesses.js';
import { allCircuits, ARMS, planWaves, VERIFIER_BYTE_BUDGET } from '../wallet/wave-deploy.js';
import { runScenario, step } from './runner.js';

void runScenario('toolchain-offline', async () => {
  const coinPublicKey = '00'.repeat(32);
  const encryptionPublicKey = '00'.repeat(32);
  const accountProvider = new NodeZkConfigProvider(zkConfigPath);
  const zero32 = new Uint8Array(32);
  const signingKey = sampleSigningKey();

  step('deployment inventory matches generated circuits and BIP-340 is grant-only');
  const roster = allCircuits();
  const bip340Circuits = [
    'withdraw_unshielded_with_grant_bip340',
    'withdraw_shielded_with_grant_bip340',
    'withdraw_shielded_to_contract_with_grant_bip340',
  ].sort();
  assert.equal(new Set(roster).size, roster.length, 'deployment roster must not repeat keys');
  assert.deepEqual(Object.keys(new Contract(makeWitnesses()).impureCircuits).sort(), [...roster].sort());
  assert.deepEqual(roster.filter(id => id.endsWith('_bip340')).sort(), bip340Circuits,
    'BIP-340 must expose only the three scoped-grant withdrawals');
  assert.deepEqual(ARMS, ['k256', 'jubjub', 'p256'], 'BIP-340 must not become an owner arm');

  step('SDK constructs account and scaffolding deployments from checked artifacts');
  assert.equal(await accountProvider.getArtifactRuntimeVersion(), '0.20.0');
  const account = await createUnprovenDeployTxFromVerifierKeys(accountProvider, coinPublicKey, {
    compiledContract: compiledAccountContract(),
    initialPrivateState: emptyCoinStore(),
    signingKey,
    args: [zero32, zero32, JubjubDevice.generate().pk, new Uint8Array(64), 60n],
  }, encryptionPublicKey);
  const state = ContractState.deserialize(account.public.initialContractState.serialize());
  assert.equal(account.era, 'ledger9');
  assert.ok(account.private.unprovenTx.serialize().length > 0);
  const control = await createUnprovenDeployTxFromVerifierKeys(
    new NodeZkConfigProvider(controlZkConfigPath), coinPublicKey,
    { compiledContract: compiledControlContract(), signingKey, initialPrivateState: {} }, encryptionPublicKey);
  const faucet = await createUnprovenDeployTxFromVerifierKeys(
    new NodeZkConfigProvider(faucetZkConfigPath), coinPublicKey,
    { compiledContract: compiledFaucetContract(), signingKey, initialPrivateState: {} }, encryptionPublicKey);
  for (const deployment of [control, faucet]) {
    assert.equal(deployment.era, 'ledger9');
    assert.ok(deployment.private.unprovenTx.serialize().length > 0);
  }

  step('all account ZKIR/VKs load; every arm\'s wave plan covers the roster and signs v4 updates');
  const keys = new Map<string, Uint8Array>();
  for (const id of roster) {
    const vk = await accountProvider.getVerifierKey(id);
    assert.ok((await accountProvider.getZKIR(id)).length > 0);
    assert.deepEqual(state.operation(id)?.verifierKey, new Uint8Array(vk));
    keys.set(id, vk);
  }
  const sizes = new Map([...keys].map(([id, vk]) => [id, vk.length]));
  for (const arm of ARMS) {
    const waves = planWaves(sizes, arm, true);
    assert.deepEqual(waves.flatMap((w) => w.circuits).sort(), [...roster].sort());
    assert.ok(bip340Circuits.every(id => waves.slice(1).some(wave => wave.circuits.includes(id))),
      'grant-only keys must be installed in maintenance, not the initial owner roster');
    assert.ok(waves.every((w) => w.verifierBytes <= VERIFIER_BYTE_BUDGET), 'deploy and maintenance fit the budget');
    assert.equal(waves.filter((w) => w.retiresAuthority).length, 1);
    assert.equal(waves.at(-1)?.retiresAuthority, true);
    for (const wave of waves.slice(1)) {
      const updates = wave.circuits.map((id) =>
        new VerifierKeyInsert(id, new ContractOperationVersionedVerifierKey('v4', keys.get(id)!)));
      const update = new MaintenanceUpdate(account.public.contractAddress, updates, 0n);
      assert.equal(update.addSignature(0n, signData(signingKey, update.dataToSign)).signatures.length, 1);
    }
    console.log(`  ✓ ${arm}: ${keys.size} circuits across ${waves.length} planned waves`);
  }
});
