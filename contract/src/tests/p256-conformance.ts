// Accepted-proof authorisation and per-circuit proving samples. Assertions for
// account calls come from the explicitly labelled OpenSSL test authenticator;
// the probe also proves the previously captured real WebAuthn assertion.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { nodeZkConfigRegistry } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { createProofProviderFromHandlers } from '@midnight-ntwrk/midnight-js-types';
import { CostModel } from '@midnightntwrk/ledger-v9';
import * as Probe from '../../contracts/managed/probe-p256/contract/index.js';
import { CustodyAccount } from '../wallet/account.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { JubjubDevice, K256Device, originHash, readOnlyScope } from '../wallet/signer.js';
import { p256Challenges } from '../wallet/signer-p256.js';
import { parseES256Signature, webauthnPolicy } from '../wallet/webauthn.js';
import { queryTxPosition } from '../wallet/capture.js';
import { setupWallet, compiledAccountContract } from '../node/setup.js';
import { CONFIG, managedPath, createProviders } from '../node/wallet.js';
import { runScenario, step } from './runner.js';
import { writeEvidence } from './evidence.js';
import { softwarePasskey, sha256, TEST_ORIGIN } from './p256-fixtures.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
await runScenario('P-256/WebAuthn on-node', async () => {
  const samples: { label: string; keyLocation: string; startedAt: string; milliseconds: number; proofBytes: number }[] = [];
  const transactions: { label: string; txId: string; blockHeight?: number; status?: string }[] = [];
  let label = 'deployment';
  const evidenceDir = process.env.EVIDENCE_DIR ?? 'evidence/p256-webauthn';
  mkdirSync(evidenceDir, { recursive: true });
  const journal = path.join(evidenceDir, `run-${Date.now()}.jsonl`);
  const log = (kind: string, value: unknown) => appendFileSync(journal, JSON.stringify({ kind, value }) + '\n');
  const container = process.env.MIDNIGHT_PROOF_CONTAINER;
  const proverEnvironment = container ? {
    container: JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' })).map((c: any) => ({
      image: c.Image, platform: c.Platform, configuredImage: c.Config.Image, cpus: c.HostConfig.NanoCpus, memory: c.HostConfig.Memory,
    })),
    dockerVM: execFileSync('docker', ['info', '--format', '{{.Architecture}} {{.NCPU}} CPUs {{.MemTotal}} memoryBytes'], { encoding: 'utf8' }).trim(),
  } : { note: 'Set MIDNIGHT_PROOF_CONTAINER to capture local Docker allocation and image identity.' };
  log('environment', proverEnvironment);
  const registry = await nodeZkConfigRegistry(managedPath);
  const base = httpClientProvingProvider(CONFIG.proofServer, registry);
  const timed = { ...base, async prove(...args: Parameters<typeof base.prove>) {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const proof = await base.prove(...args);
    const sample = { label, keyLocation: args[1], startedAt, milliseconds: performance.now() - start, proofBytes: proof.length };
    samples.push(sample); log('proof', sample); console.log('  proving', JSON.stringify(sample));
    return proof;
  } };
  const proofProvider = createProofProviderFromHandlers({ currentEra: tx => tx.prove(timed, CostModel.initialCostModel()) });
  const ctx = await setupWallet();
  ctx.providers.proofProvider = proofProvider;
  const record = async (name: string, result: { txId: string }) => {
    const position = await queryTxPosition(result.txId);
    assert.equal(position.error, undefined);
    assert.equal(position.status, 'SUCCESS');
    transactions.push({ label: name, txId: result.txId, blockHeight: position.blockHeight, status: position.status });
    log('transaction', transactions.at(-1));
  };

  step('deploy passkey-first account; activate enrolled RP/origin');
  const f = softwarePasskey();
  const account = await CustodyAccount.deploy(ctx.providers, compiledAccountContract(), f.device, generateEncKeyPair());
  const j = JubjubDevice.generate(), k = K256Device.generate();
  label = 'p256 adds jubjub'; await record(label, await account.addDevice(f.device, j));
  label = 'jubjub adds k256'; await record(label, await account.addDevice(j, k));
  const second = softwarePasskey();
  label = 'k256 adds p256'; await record(label, await account.addDevice(k, second.device));

  step('same operation under every arm: first observation plus two repeats');
  for (const device of [j, k, f.device]) {
    for (let i = 0; i < 3; i++) {
      label = `rotate_enc_key_with_${device.arm}/${i}`;
      await record(label, await account.rotateEncKey(device, rnd()));
    }
  }
  step('bypass adapter: tampered policy, argument, signature and stale authorisation fail locally');
  const key = rnd(), context = await account.callContext();
  const auth = await f.device.sign(p256Challenges.rotateEncKey(context, f.pk, key), await account.resolveUseCounter(f.device));
  const before = (await account.ledgerState()).auth_nonce;
  await assert.rejects(() => account.rotateEncKeyWithAuth(key, { ...auth, policy: { ...auth.policy, rp_id_hash: rnd() } }));
  await assert.rejects(() => account.rotateEncKeyWithAuth(rnd(), auth));
  await assert.rejects(() => account.rotateEncKeyWithAuth(key, { ...auth, sig: { ...auth.sig, s: 1n } }));
  assert.equal((await account.ledgerState()).auth_nonce, before);
  label = 'p256 valid after negative probes'; await record(label, await account.rotateEncKeyWithAuth(key, auth));
  await assert.rejects(() => account.rotateEncKeyWithAuth(key, auth));

  step('passkey-authorised grant lifecycle');
  const grantId = second.grantee.grantId(account.addressBytes, originHash(TEST_ORIGIN), 0n);
  label = 'issue_grant_with_p256';
  await record(label, await account.issueGrant(f.device, grantId,
    readOnlyScope({ readPkHash: rnd(), rpIdHash: second.policy.rp_id_hash }), rnd()));
  label = 'revoke_grant_with_p256'; await record(label, await account.revokeGrant(f.device, grantId));

  step('native P-256 and complete WebAuthn verifier probes: captured real high-S assertion');
  const providers = await createProviders<keyof Probe.ProvableCircuits<{}>>(ctx.walletCtx, path.join(managedPath, 'probe-p256'));
  providers.proofProvider = proofProvider;
  const compiled = CompiledContract.make('probe-p256', Probe.Contract).pipe(
    CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(path.join(managedPath, 'probe-p256')));
  const deployed = await deployContract(providers, { compiledContract: compiled, privateStateId: 'p256-probe', initialPrivateState: {} });
  const v = JSON.parse(readFileSync(new URL('../../../experiments/p256-in-circuit/webauthn/vector.json', import.meta.url), 'utf8'));
  const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
  const challenge = hex(v.challenge_hex), data = hex(v.authenticator_data_hex);
  const sig = parseES256Signature(hex(v.signature_der_hex));
  const pk = { x: BigInt('0x' + v.pk_x_hex), y: BigInt('0x' + v.pk_y_hex), identity: false };
  const digest = sha256(Buffer.concat([data, sha256(Buffer.from(v.client_data_json_b64url, 'base64url'))]));
  for (const circuit of ['verify_ecdsa', 'verify_webauthn'] as const) {
    for (let i = 0; i < 3; i++) {
      label = `${circuit}/${i}`;
      const args = circuit === 'verify_ecdsa' ? [digest, sig, pk] : [challenge, webauthnPolicy('localhost', TEST_ORIGIN), data, sig, pk];
      const result = await (deployed.callTx[circuit] as any)(...args);
      await record(label, { txId: result.public.txId });
    }
  }
  let containerPeakMemoryBytes: number | null = null;
  if (container) {
    try {
      containerPeakMemoryBytes = Number(execFileSync('docker', ['exec', container, 'cat', '/sys/fs/cgroup/memory.peak'], { encoding: 'utf8' }).trim());
    } catch { /* cgroup v1 and remote proof servers need another memory observer */ }
  }
  writeEvidence({ testId: 'p256-webauthn', name: 'conformance-and-proving', fileName: 'conformance-and-proving.json',
    description: 'P-256 WebAuthn profile wa-json134: enrolled account, cross-arm calls, lifecycle, real-assertion verifier probes',
    verdict: 'PASS', note: 'Account calls: OpenSSL software authenticator. Verifier probes: captured real WebAuthn assertion. Negatives rejected at build stage.',
    details: { account: account.address, transactions, samples, profile: 'wa-json134', proverEnvironment, containerPeakMemoryBytes,
      methodology: 'Sequential per-circuit ProvingProvider.prove wall time, including key lookup/load and local HTTP transfer; excludes signing, circuit execution/check, wallet balancing and node inclusion. First observation + two repeats per circuit; no claim of OS/server cold caches. Key generation excluded.' } });
});
