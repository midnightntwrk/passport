// Fresh proof/server/node evidence for the signed-bootstrap reference. Target
// assertions use OpenSSL software keys, not a browser/hardware attestation.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { nodeZkConfigRegistry } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { createProofProviderFromHandlers } from '@midnight-ntwrk/midnight-js-types';
import { ContractState, CostModel } from '@midnightntwrk/ledger-v9';
import { CustodyAccount, type SignedBootstrapClientOptions } from '../wallet/account.js';
import { TemporaryBootstrapKey, deserializeSignedBootstrapRecord, serializeSignedBootstrapRecord,
  signedBootstrapActivationArgs, type BootstrapNetworkConfig } from '../wallet/signed-bootstrap.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { JubjubDevice } from '../wallet/signer.js';
import { queryTxPosition } from '../wallet/capture.js';
import { allCircuits } from '../wallet/wave-deploy.js';
import { setupWallet, compiledAccountContract, deployFaucet } from '../node/setup.js';
import { CONFIG, managedPath, userAddressBytes } from '../node/wallet.js';
import { runScenario, step, sleep } from './runner.js';
import { writeEvidence } from './evidence.js';
import { softwarePasskey, sha256, TEST_ORIGIN } from './p256-fixtures.js';

const bytes = (n = 32) => new Uint8Array(randomBytes(n));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
await runScenario('signed bootstrap: fresh proofs and on-node activation', async () => {
  const directory = process.env.EVIDENCE_DIR ?? 'evidence/signed-bootstrap';
  mkdirSync(directory, { recursive: true });
  const journal = path.join(directory, `on-node-${Date.now()}.jsonl`);
  const log = (kind: string, value: unknown) => appendFileSync(journal, JSON.stringify({ kind, value },
    (_key, value) => typeof value === 'bigint' ? value.toString() : value) + '\n');
  const samples: { label: string; keyLocation: string; milliseconds: number; proofBytes: number }[] = [];
  const transactions: { label: string; txId: string; status?: string; blockHeight?: number }[] = [];
  const artifact = path.join(managedPath, 'account');
  const sourceFiles = ['account.compact', 'account-bootstrap.compact', 'account-p256.compact', 'webauthn.compact'];
  const sources = Object.fromEntries(sourceFiles.map(file => [file,
    hex(sha256(readFileSync(path.join(managedPath, '..', file))))]));
  const fingerprint = (file: string) => ({ bytes: statSync(file).size, sha256: hex(sha256(readFileSync(file))) });
  const compiled = JSON.parse(readFileSync(path.join(artifact, 'compiler/contract-info.json'), 'utf8'));
  const assets = Object.fromEntries(['contract/index.js', 'zkir/activate_initial_passkey.zkir',
    'keys/activate_initial_passkey.prover', 'keys/activate_initial_passkey.verifier'].map(file => [file, fingerprint(path.join(artifact, file))]));
  const zkir = process.env.ZKIR_BIN ?? path.join(homedir(), '.compact/versions/0.35.0/aarch64-darwin/zkir-v3');
  const measure = spawnSync(zkir, ['mock-compile', path.join(artifact, 'zkir/activate_initial_passkey.zkir')], { encoding: 'utf8' });
  if (measure.error || measure.status !== 0) throw measure.error ?? new Error(measure.stderr);
  const dimensions = (measure.stdout + measure.stderr).match(/k=(\d+), rows=(\d+)/);
  assert.ok(dimensions, 'missing circuit k/row measurement');
  const provenance = { sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sources, compiled, assets, k: Number(dimensions[1]), rows: Number(dimensions[2]) };
  log('provenance', provenance);
  let label = 'deployment';
  const registry = await nodeZkConfigRegistry(managedPath);
  const base = httpClientProvingProvider(CONFIG.proofServer, registry);
  const timed = { ...base, async prove(...args: Parameters<typeof base.prove>) {
    const start = performance.now(), proof = await base.prove(...args);
    const sample = { label, keyLocation: args[1], milliseconds: performance.now() - start, proofBytes: proof.length };
    samples.push(sample); log('proof', sample); console.log('  proof', JSON.stringify(sample));
    return proof;
  } };
  const ctx = await setupWallet();
  ctx.providers.proofProvider = createProofProviderFromHandlers({ currentEra: tx => tx.prove(timed, CostModel.initialCostModel()) });
  const recordTx = async (name: string, result: { txId: string }) => {
    const position = await queryTxPosition(result.txId);
    assert.equal(position.error, undefined); assert.equal(position.status, 'SUCCESS');
    const record = { label: name, txId: result.txId, status: position.status, blockHeight: position.blockHeight };
    transactions.push(record); log('transaction', record);
  };
  const observeNetwork = async (): Promise<BootstrapNetworkConfig> => {
    const response = await fetch(CONFIG.node, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getBlockHash', params: [0] }) });
    assert.ok(response.ok, 'node genesis RPC failed');
    const answer = await response.json() as { result?: string; error?: unknown };
    assert.equal(answer.error, undefined); assert.match(answer.result ?? '', /^0x[0-9a-fA-F]{64}$/);
    const genesisHash = new Uint8Array(Buffer.from(answer.result!.slice(2), 'hex'));
    return { caip2Id: `midnight:${CONFIG.networkId}`, genesisHash, anchorHeight: 0n, anchorHash: genesisHash };
  };
  const network = await observeNetwork();
  if (process.env.SIGNED_BOOTSTRAP_EXPECTED_GENESIS) {
    assert.equal(hex(network.genesisHash), process.env.SIGNED_BOOTSTRAP_EXPECTED_GENESIS.replace(/^0x/, '').toLowerCase());
  }
  log('network', { ...network, genesisHash: hex(network.genesisHash), anchorHash: hex(network.anchorHash),
    trustedSource: 'dedicated local test node RPC; optional SIGNED_BOOTSTRAP_EXPECTED_GENESIS pin' });
  const publicState = async (account: CustodyAccount) => {
    const state = await ctx.providers.publicDataProvider.queryContractState(account.address);
    assert.ok(state); return ContractState.deserialize(state.serialize());
  };
  const recordPath = path.join(directory, 'onboarding-record.json');
  let interruptDeployment = false;
  const options: SignedBootstrapClientOptions = {
    network, rpId: 'localhost', origin: TEST_ORIGIN, observeNetwork,
    persist: async record => {
      writeFileSync(recordPath, serializeSignedBootstrapRecord(record), { mode: 0o600 });
      if (interruptDeployment && record.deployment) {
        interruptDeployment = false;
        throw new Error('injected interruption after durable checkpoint, before first submission');
      }
    },
    verifyDeployment: async account => {
      const state = await publicState(account);
      assert.deepEqual(state.operations().map(id => typeof id === 'string' ? id : Buffer.from(id).toString()).sort(), allCircuits().sort());
      for (const id of allCircuits()) {
        assert.deepEqual(state.operation(id)?.verifierKey, new Uint8Array(readFileSync(path.join(artifact, `keys/${id}.verifier`))), `trusted verifier ${id}`);
      }
      assert.equal(state.maintenanceAuthority.committee.length, 0, 'maintenance authority is retired');
      assert.equal(Number(state.maintenanceAuthority.threshold), 1);
    },
  };
  let accountAddress: string | undefined;
  try {
    step('deploy before creating a passkey; verify the complete roster and retired maintenance authority');
    const key = TemporaryBootstrapKey.generate(), recovery = JubjubDevice.generate();
    const deployOptions = { ...options, recovery: { recoveryPk: recovery.pk, wrap: bytes(64), vetoWindowSeconds: 3600n } };
    interruptDeployment = true;
    await assert.rejects(() => CustodyAccount.deployPasskeyDormant(ctx.providers, compiledAccountContract(), key,
      generateEncKeyPair(), deployOptions), /injected interruption/);
    const checkpoint = deserializeSignedBootstrapRecord(readFileSync(recordPath, 'utf8'));
    assert.ok(checkpoint.deployment);
    log('deployment-interruption', { address: checkpoint.deployment.address, stage: 'before first submission; checkpoint durable' });
    const session = await CustodyAccount.resumePasskeyDeployment(ctx.providers, compiledAccountContract(), checkpoint, deployOptions, key);
    assert.equal(session.address, checkpoint.deployment.address, 'resumption deploys the same committed account address');
    const account = session.account; accountAddress = account.address;
    assert.deepEqual(session.userId, account.addressBytes); assert.equal(session.userId.length, 32);
    assert.equal((await account.ledgerState()).booted, false);
    const passkey = softwarePasskey();
    await session.retainCredential({ credentialId: bytes(47), pk: passkey.pk });
    const approval = await session.approve(passkey.assertion);
    const saved = deserializeSignedBootstrapRecord(readFileSync(recordPath, 'utf8'));
    assert.deepEqual(saved.approval, approval);
    key.erase();
    const resumed = account.signedBootstrapSession(saved, options);
    await resumed.approve(async () => { throw new Error('saved approval must not prompt again'); });

    step('modified proof request rejects before proving and preserves the dormant state');
    const before = (await publicState(account)).data.toString(false), sampleCount = samples.length;
    const changed = [...signedBootstrapActivationArgs(approval)] as unknown[]; changed[1] = softwarePasskey().pk;
    await assert.rejects(() => account.callTx.activate_initial_passkey(...changed));
    assert.equal(samples.length, sampleCount, 'negative stopped at the local build layer');
    assert.equal((await publicState(account)).data.toString(false), before);

    step('a permissionless deposit after approval preserves the approved intent');
    // The reference localnet rejects the Night-input shape under its dismissal
    // budget. Use the existing non-native faucet fixture without relaxing any
    // ledger limit; this still exercises the same account custody circuits.
    const faucet = await deployFaucet(ctx.walletCtx), domain = bytes();
    const color = await faucet.unshieldedColor(domain), recipient = userAddressBytes(ctx.walletCtx);
    label = 'mint non-native custody fixture';
    await recordTx(label, { txId: await faucet.mintUnshielded(domain, 1000n, recipient) });
    await sleep(15_000);
    label = 'deposit_unshielded after approval';
    await recordTx(label, await account.depositUnshielded(color, 1000n));
    assert.equal((await account.ledgerState()).unshielded_balances.lookup(color), 1000n);

    step('pending recovery survives activation and the newly installed passkey can veto it');
    const successor = JubjubDevice.generate(), nextRecovery = JubjubDevice.generate();
    label = 'recover_submit before activation';
    await recordTx(label, await account.recoverSubmit(recovery.sk, successor, nextRecovery.pk, BigInt(Math.floor(Date.now() / 1000) + 600)));
    const pending = await account.ledgerState();
    assert.equal(pending.pending_recovery, true);
    label = 'activate_initial_passkey from retained approval';
    await resumed.activate();
    assert.ok(saved.transactionId); await recordTx(label, { txId: saved.transactionId! });
    const activated = await account.ledgerState();
    assert.equal(activated.booted, true); assert.equal(activated.device_count, 1n);
    assert.equal(activated.auth_nonce, 0n); assert.equal(activated.device_epoch, 0n);
    assert.equal(activated.round, pending.round + 1n); assert.deepEqual(activated.boot, new Uint8Array(32));
    assert.equal(activated.pending_not_before, pending.pending_not_before);
    assert.deepEqual(activated.pending_entry, pending.pending_entry);
    assert.deepEqual([...activated.devices], [passkey.device.entryAt(account.addressBytes, 0n, 0n)]);
    assert.equal(saved.retired, true);
    assert.equal(await resumed.inspect(), true, 'ambiguous prior submission resolves from exact intended state');
    const proved = samples.length; await resumed.activate(); assert.equal(samples.length, proved, 'retry does not generate a second activation proof');
    await assert.rejects(() => account.callTx.activate_initial_passkey(...signedBootstrapActivationArgs(approval)));
    account.registerDevice(passkey.device, 0n);
    label = 'recover_cancel_with_p256'; await recordTx(label, await account.recoverCancel(passkey.device));
    assert.equal((await account.ledgerState()).pending_recovery, false);
    label = 'rotate_enc_key_with_p256'; const viewingKey = bytes();
    await recordTx(label, await account.rotateEncKey(passkey.device, viewingKey));
    assert.deepEqual((await account.ledgerState()).enc_key, viewingKey);

    step('the activated passkey controls custody and cross-arm device lifecycle');
    label = 'withdraw_unshielded_with_p256';
    await recordTx(label, await account.withdrawUnshielded(passkey.device, color, 100n, recipient));
    const secondDevice = JubjubDevice.generate();
    label = 'add_device_with_p256';
    await recordTx(label, await account.addDevice(passkey.device, secondDevice));
    label = 'withdraw_unshielded_with_jubjub';
    await recordTx(label, await account.withdrawUnshielded(secondDevice, color, 100n, recipient));
    label = 'remove_device_with_p256';
    await recordTx(label, await account.removeDevice(passkey.device, secondDevice));
    const afterLifecycle = await account.ledgerState();
    assert.equal(afterLifecycle.device_count, 1n);
    assert.equal(afterLifecycle.unshielded_balances.lookup(color), 800n);
    await assert.rejects(() => account.withdrawUnshielded(secondDevice, color, 1n, recipient));
    assert.equal((await account.ledgerState()).unshielded_balances.lookup(color), 800n);
    const details = { account: account.address, network: { caip2Id: network.caip2Id, genesis: hex(network.genesisHash) },
      provenance, samples, transactions, savedApprovalAfterKeyErasure: true, resumedDeploymentCheckpoint: true, completeVerifierRoster: allCircuits(),
      custodyFixture: { kind: 'faucet-minted non-native localnet token', color: hex(color), deposited: '1000', remaining: '800' },
      negativeEnforcingLayer: 'host build; no negative proof submitted',
      notCovered: ['physical browser/synced-authenticator registration', 'identical-state cloned network distinction',
        'formal soundness proof', 'on-node recovery-finalise ordering (covered by offline state tests)'] };
    log('result', details);
    writeEvidence({ testId: 'signed-bootstrap', name: 'conformance', fileName: 'signed-bootstrap-conformance.json',
      description: 'Signed-bootstrap proof, interrupted deployment and approval resume, deposits, recovery veto, custody and device lifecycle on node',
      verdict: 'PASS', note: 'Fresh generated artifacts and accepted transactions. OpenSSL software passkey; mocked/host negatives are identified separately. Not a formal proof of soundness.', details });
  } catch (error) {
    writeEvidence({ testId: 'signed-bootstrap', name: 'conformance', fileName: 'signed-bootstrap-conformance.json',
      description: 'Signed-bootstrap on-node conformance attempt', verdict: 'FAIL', note: String(error),
      details: { account: accountAddress, provenance, samples, transactions } });
    throw error;
  }
});
