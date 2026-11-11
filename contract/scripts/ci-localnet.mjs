#!/usr/bin/env node
// Public evidence is allowlisted. Private profiles and raw service/fixture logs
// stay in a separate temporary directory and are removed after the run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const contract = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = process.env.CI_COMPOSE_PROJECT;
assert.match(project ?? '', /^passport-ci-[a-z0-9-]+$/, 'use a unique passport-ci- project');
const compose = ['compose', '-p', project, '-f', resolve(contract, 'infra/docker-compose.ci.yml')];
const children = new Set();
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  for (const child of children) { try { process.kill(-child.pid, signal); } catch {} }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const commands = [];
let privateDirectory;
let outputDirectory;
let env = { ...process.env, APP__INFRA__SECRET: 'unused-cleanup' };

async function run(label, executable, args, timeoutMs = 120_000) {
  const start = Date.now();
  const log = privateDirectory ? createWriteStream(resolve(privateDirectory, `${label}.log`), { mode: 0o600 }) : null;
  let stdout = '';
  const child = spawn(executable, args, { cwd: contract, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.on('data', chunk => { log?.write(chunk); if (stdout.length < 4_000_000) stdout += chunk; });
  child.stderr.on('data', chunk => log?.write(chunk));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
  const result = await new Promise(resolve => {
    child.on('error', () => resolve({ code: null, signal: null, spawnError: true }));
    child.on('close', (code, signal) => resolve({ code, signal, spawnError: false }));
  });
  clearTimeout(timer); children.delete(child); log?.end();
  const record = { label, command: [executable, ...args], elapsedMs: Date.now() - start,
    ...result, timedOut, status: result.code === 0 && !timedOut ? 'PASS' : 'FAIL' };
  commands.push(record);
  if (outputDirectory) await writeFile(resolve(outputDirectory, 'localnet-commands.json'), JSON.stringify(commands, null, 2));
  console.log(`${label}: ${record.status} (${record.elapsedMs} ms)`);
  assert.equal(record.status, 'PASS', `${label} failed; exit=${result.code}, signal=${result.signal}, timeout=${timedOut}`);
  return stdout;
}
async function cleanup() {
  await run('cleanup', 'docker', [...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '10']);
}
if (process.argv[2] === 'cleanup') {
  const path = resolve(process.env.CI_EVIDENCE_DIR ?? '.', 'localnet/result.json');
  const result = await readFile(path, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (result?.project === project && result?.ownedProject === true) await cleanup();
  else console.log('No project owned by this run to clean up.');
} else {
  assert.equal(process.argv[2], undefined, 'unexpected argument');
  assert.ok(isAbsolute(process.env.CI_EVIDENCE_DIR ?? ''), 'set an absolute CI_EVIDENCE_DIR');
  outputDirectory = resolve(process.env.CI_EVIDENCE_DIR, 'localnet');
  await mkdir(outputDirectory, { recursive: false });
  privateDirectory = await mkdtemp(resolve(tmpdir(), 'passport-ci-private-'));
  env = { ...env, APP__INFRA__SECRET: randomBytes(32).toString('hex'), MIDNIGHT_NETWORK: 'local',
    WALLET_SEED: '0'.repeat(63) + '1', PROOF_SERVER_URL: 'http://127.0.0.1:6300',
    INDEXER_URL: 'http://localhost:8088/api/v4/graphql', MIDNIGHT_INDEXER_URL: 'http://localhost:8088/api/v4/graphql',
    INDEXER_WS_URL: 'ws://localhost:8088/api/v4/graphql/ws',
    MIDNIGHT_NODE_CONTAINER: `${project}-node-1`, MIDNIGHT_PROOF_CONTAINER: `${project}-proof-server-1` };
  const evidence = { version: 1, status: 'RUNNING', project, startedAt: new Date().toISOString(),
    scope: 'Full keyed build, two native-prover/SDK controls, and a three-process JubJub guardian recovery journey. No P-256 proof, browser ceremony, full localnet matrix, or complete wallet-recovery claim.' };
  const save = () => writeFile(resolve(outputDirectory, 'result.json'), JSON.stringify(evidence, null, 2));
  async function jsonPost(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    assert.ok(response.ok); const bodyResult = await response.json();
    assert.equal(bodyResult.error, undefined); assert.equal(bodyResult.errors, undefined); return bodyResult;
  }
  const rpc = async (method, params = []) => (await jsonPost('http://localhost:9944', { jsonrpc: '2.0', id: 1, method, params })).result;
  async function until(label, probe) {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && !interrupted) {
      try { const result = await probe(); if (result) return result; } catch {}
      await delay(2_000);
    }
    throw new Error(`${label} did not become ready within 300 seconds`);
  }
  let ownedProject = false;
  let ownedPrivateState = false;
  try {
    await save();
    const privateState = resolve(contract, 'midnight-level-db');
    const existing = await lstat(privateState).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    assert.equal(existing, null, 'refuse pre-existing midnight-level-db; use a fresh checkout');
    ownedPrivateState = true;
    const volumes = await run('preflight-volumes', 'docker', ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]);
    const containers = await run('preflight-containers', 'docker', [...compose, 'ps', '--all', '--quiet']);
    assert.equal(volumes.trim(), '', 'refuse pre-existing CI volumes');
    assert.equal(containers.trim(), '', 'refuse pre-existing CI containers');
    ownedProject = true;
    evidence.ownedProject = true;
    await save();
    await run('pull-pinned-images', 'docker', [...compose, 'pull'], 600_000);
    await run('start-node-prover', 'docker', [...compose, 'up', '-d', 'node', 'proof-server']);
    evidence.genesisHash = await until('node block production', async () => {
      const head = await rpc('chain_getHeader');
      return Number.parseInt(head.number, 16) >= 2 ? await rpc('chain_getBlockHash', [0]) : null;
    });
    evidence.proverVersion = await until('proof server', async () => {
      const response = await fetch('http://127.0.0.1:6300/version', { signal: AbortSignal.timeout(2_000) });
      return response.ok ? response.text() : null;
    });
    assert.match(evidence.proverVersion, /9\.0\.0-rc\.8/);
    // This indexer can exit when started before block 1 exists.
    await run('start-indexer', 'docker', [...compose, 'up', '-d', 'indexer']);
    evidence.indexedAnchor = await until('matching indexed node head', async () => {
      const data = await jsonPost('http://localhost:8088/api/v4/graphql', { query: '{ block { height hash } }' });
      const block = data.data?.block;
      if (!block || block.height < 2) return null;
      const hash = await rpc('chain_getBlockHash', [block.height]);
      assert.equal(hash.replace(/^0x/, ''), block.hash.replace(/^0x/, '')); return block;
    });
    evidence.nodeVersion = await rpc('system_version');
    evidence.runtimeVersion = await rpc('state_getRuntimeVersion');
    evidence.images = [];
    for (const service of ['node', 'indexer', 'proof-server']) {
      const id = (await run(`identity-${service}`, 'docker', [...compose, 'ps', '--quiet', service])).trim();
      assert.ok(id);
      const info = (await run(`inspect-${service}`, 'docker', ['inspect', '--format',
        '{{json .Config.Image}}|{{json .Image}}', id])).trim().split('|').map(JSON.parse);
      const image = JSON.parse(await run(`image-${service}`, 'docker', ['image', 'inspect', info[1], '--format',
        '{{json .RepoDigests}}']));
      evidence.images.push({ service, configuredImage: info[0], imageId: info[1], repoDigests: image });
    }
    await save();
    const proverOutput = await run('native-prover-controls', process.execPath,
      ['--import', 'tsx', '--test', '--test-reporter=tap', 'src/tests/change-qualification.ts'], 300_000);
    assert.match(proverOutput, /# tests 2\b/); assert.match(proverOutput, /# pass 2\b/); assert.match(proverOutput, /# fail 0\b/);
    await writeFile(resolve(outputDirectory, 'native-prover-controls.log'), proverOutput);
    const fixture = resolve(privateDirectory, 'fixture');
    for (const phase of ['provision', 'restore', 'finalise-spend']) {
      const text = await run(`viewing-${phase}`, process.execPath,
        ['--import', 'tsx', 'src/tests/viewing-recovery-localnet.ts', phase, fixture], 1_800_000);
      assert.ok(text.includes(`viewing-recovery-localnet ${phase}: PASS`));
    }
    const receipt = JSON.parse(await readFile(resolve(fixture, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'PASS'); assert.equal(receipt.steps.length, 3);
    assert.equal(receipt.transactions.length, 10); assert.equal(new Set(receipt.transactions.map(t => t.txId)).size, 10);
    assert.equal(receipt.deployment.genesisHash, evidence.genesisHash.replace(/^0x/, ''));
    assert.ok(receipt.deployment.verifiers.length > 0);
    assert.ok(receipt.deployment.verifiers.every(key => key.identical));
    for (const tx of receipt.transactions) {
      assert.equal(tx.status, 'SUCCESS'); assert.ok(tx.identifiers.includes(tx.txId));
      assert.equal(tx.nodeBlockHash.replace(/^0x/, ''), tx.raw.block.hash.replace(/^0x/, ''));
    }
    // The receipt schema contains public identifiers, assertions, and hashes.
    // No other file from the fixture directory is copied to public evidence.
    await writeFile(resolve(outputDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2));
    evidence.status = 'PASS';
  } catch (error) {
    evidence.status = 'FAIL';
    // Do not include child stdout, private JSON, or environment values here.
    evidence.failure = error instanceof Error ? error.message : 'localnet failure';
    process.exitCode = 1;
  } finally {
    if (ownedProject) {
      try { await cleanup(); evidence.cleanup = 'PASS'; }
      catch { evidence.cleanup = 'FAIL'; evidence.status = 'FAIL'; process.exitCode = 1; }
    }
    await rm(privateDirectory, { recursive: true, force: true });
    if (ownedPrivateState) await rm(resolve(contract, 'midnight-level-db'), { recursive: true, force: true });
    evidence.finishedAt = new Date().toISOString();
    await save();
  }
}
