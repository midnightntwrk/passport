#!/usr/bin/env node
// Requires real compiler-generated keys. mock-compile measures circuit shape;
// it is not reported as proof generation or proof verification.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { arch, cpus, platform, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const managed = resolve(root, 'contracts/managed/account');
const out = resolve(root, process.env.EVIDENCE_DIR ?? 'evidence/signed-bootstrap');
const zkir = process.env.ZKIR_BIN ?? 'zkir-v3';
const hashes = new Map();
async function sha(file) {
  if (hashes.has(file)) return hashes.get(file);
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  const value = hash.digest('hex'); hashes.set(file, value); return value;
}
const info = JSON.parse(readFileSync(resolve(managed, 'compiler/contract-info.json'), 'utf8'));
const manifestFile = resolve(managed, 'compiler/contract-manifest.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
let manifestFiles = 0;
async function verifyManifest(tree, prefix = '') {
  for (const [name, entry] of Object.entries(tree)) {
    if (!entry || typeof entry !== 'object') continue;
    const relative = `${prefix}${name}`;
    if (entry.type === 'directory') await verifyManifest(entry, `${relative}/`);
    if (entry.type === 'file') {
      const file = resolve(managed, relative);
      if (!existsSync(file) || statSync(file).size !== entry.size || await sha(file) !== entry.hash)
        throw new Error(`Compiler manifest mismatch: ${relative}`);
      manifestFiles++;
    }
  }
}
await verifyManifest(manifest);
const { expectedVk } = await import(pathToFileURL(resolve(managed, 'contract/index.js')).href);
const circuits = [];
for (const name of readdirSync(resolve(managed, 'zkir')).filter(f => f.endsWith('.zkir')).map(f => f.slice(0, -5)).sort()) {
  const ir = resolve(managed, 'zkir', `${name}.zkir`);
  const run = spawnSync(zkir, ['mock-compile', ir], { encoding: 'utf8' });
  if (run.error || run.status !== 0) throw run.error ?? new Error(run.stderr);
  const match = (run.stdout + run.stderr).match(/k=(\d+), rows=(\d+)/);
  if (!match) throw new Error(`Missing circuit shape for ${name}`);
  const assets = {};
  for (const [kind, directory] of [['zkir', 'zkir'], ['bzkir', 'zkir'], ['prover', 'keys'], ['verifier', 'keys']]) {
    const file = resolve(managed, directory, `${name}.${kind}`);
    assets[kind] = { bytes: statSync(file).size, sha256: await sha(file) };
    if (!assets[kind].bytes) throw new Error(`Empty artifact: ${file}`);
  }
  if (expectedVk[name] !== assets.verifier.sha256) throw new Error(`Runtime expectedVk mismatch: ${name}`);
  circuits.push({ name, k: Number(match[1]), rows: Number(match[2]), assets });
  console.log(`${name}: k=${match[1]}, rows=${match[2]}`);
}
if (circuits.length !== 53 || !circuits.some(c => c.name === 'activate_initial_passkey'))
  throw new Error('Unexpected schema-4 operation roster');
const sources = {};
for (const name of ['account.compact', 'account-p256.compact', 'account-bootstrap.compact', 'webauthn.compact'])
  sources[`contracts/${name}`] = await sha(resolve(root, 'contracts', name));
const command = (...args) => execFileSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8' }).trim();
const report = {
  recordedAt: new Date().toISOString(), gitCommit: command('git', 'rev-parse', 'HEAD'),
  gitStatus: command('git', 'status', '--porcelain=v1'),
  compilerVersion: info['compiler-version'], runtimeVersion: manifest['runtime-version'],
  zkirVersion: command(zkir, '--version'), nodeVersion: process.version,
  hardware: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  manifest: { sha256: await sha(manifestFile), verifiedFiles: manifestFiles, expectedVkCount: Object.keys(expectedVk).length },
  sources, packageLockSha256: await sha(resolve(root, 'package-lock.json')), circuits,
  methodology: 'Shape from zkir-v3 mock-compile; real keyed compiler manifest and runtime expectedVk independently checked against file hashes. These are circuit/key inventory results, not proof-generation timings or proof-verification results.',
};
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'circuit-sizes.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`PASS keyed schema-4 inventory: ${circuits.length} circuits, ${manifestFiles} manifest entries`);
