#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const infra = resolve(root, 'infra');
const envPath = resolve(infra, '.env');
const compose = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.macos.yml'];

function log(message) {
  console.log(`\n[passport-demo] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
  return result.stdout ?? '';
}

function read(command, args, options = {}) {
  return run(command, args, { ...options, stdio: 'pipe' }).trim();
}

function ensureEnv() {
  if (existsSync(envPath)) return;
  const secret = randomBytes(32).toString('hex');
  writeFileSync(
    envPath,
    [
      `APP__INFRA__SECRET=${secret}`,
      'WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001',
      'WALLET_SEED_SECONDARY=0000000000000000000000000000000000000000000000000000000000000002',
      '',
    ].join('\n'),
  );
  log('created infra/.env with local demo seeds');
}

function envFromFile() {
  const env = { ...process.env, MIDNIGHT_NETWORK: 'local' };
  for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    env[key.trim()] = rest.join('=').trim();
  }
  return env;
}

function ensureContracts() {
  const account = resolve(root, 'contracts/managed/account/contract/index.js');
  const faucet = resolve(root, 'contracts/managed/faucet/contract/index.js');
  const identityRegistry = resolve(root, 'contracts/managed/identity_registry/contract/index.js');
  if (existsSync(account) && existsSync(faucet) && existsSync(identityRegistry)) return;
  log('compiling Compact contracts');
  run('npm', ['run', 'compile']);
}

function dockerReady() {
  try {
    run('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function serviceState(name) {
  try {
    const id = read('docker', [...compose, 'ps', '-q', name], { cwd: infra });
    if (!id) return '';
    return read('docker', ['inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', id]);
  } catch {
    return '';
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureLocalnet() {
  if (!dockerReady()) {
    throw new Error('Docker is not running. Start Docker Desktop, then run npm run demo again.');
  }

  log('starting Midnight node and proof server');
  run('docker', [...compose, 'up', '-d', 'node', 'proof-server'], { cwd: infra });

  log('waiting for node health');
  for (let i = 0; i < 40; i += 1) {
    if (serviceState('node').includes('healthy')) break;
    sleep(1500);
  }

  log('starting indexer');
  run('docker', [...compose, 'up', '-d', 'indexer'], { cwd: infra });
  sleep(10_000);

  if (!serviceState('indexer').includes('healthy')) {
    log('indexer was not healthy yet; retrying after first blocks');
    run('docker', [...compose, 'up', '-d', 'indexer'], { cwd: infra });
    sleep(10_000);
  }

  const indexer = serviceState('indexer');
  if (!indexer.includes('running')) {
    throw new Error(`Indexer did not stay up (${indexer}). Check docker compose logs indexer.`);
  }
}

function deployFaucet() {
  log('deploying local faucet and identity registry contracts');
  run('npm', ['run', 'deploy'], { env: envFromFile() });
}

function startApp() {
  log('starting Vite at http://localhost:5173/');
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
    cwd: resolve(root, 'app'),
    env: process.env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

try {
  ensureEnv();
  ensureContracts();
  ensureLocalnet();
  deployFaucet();
  startApp();
} catch (error) {
  console.error(`\n[passport-demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
