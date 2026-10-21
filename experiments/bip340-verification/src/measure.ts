// Standalone verifier circuit shape and actual generated key sizes.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, platform, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vectorSource } from './fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const managed = path.join(root, 'contracts/managed/probe-bip340');
const toolchainPlatform = `${arch() === 'arm64' ? 'aarch64' : arch() === 'x64' ? 'x86_64' : arch()}-${platform()}`;
const zkir = process.env.ZKIR_BIN
  ?? path.join(homedir(), '.compact/versions/0.35.0', toolchainPlatform, 'zkir-v3');
const hashFile = async (file: string) => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return { bytes: statSync(file).size, sha256: hash.digest('hex') };
};
const circuits = [];
for (const messageBytes of [0, 1, 17, 32, 100]) {
  const name = `verify_${messageBytes}`;
  const ir = path.join(managed, 'zkir', name + '.zkir');
  const shape = spawnSync(zkir, ['mock-compile', ir], { encoding: 'utf8' });
  if (shape.error || shape.status !== 0) throw shape.error ?? new Error(shape.stderr);
  const match = (shape.stdout + shape.stderr).match(/k=(\d+), rows=(\d+)/);
  if (!match) throw new Error(`Missing circuit shape for ${name}`);
  const assets = {
    zkir: await hashFile(ir), bzkir: await hashFile(path.join(managed, 'zkir', name + '.bzkir')),
    prover: await hashFile(path.join(managed, 'keys', name + '.prover')),
    verifier: await hashFile(path.join(managed, 'keys', name + '.verifier')),
  };
  const measurement = { name, messageBytes, k: Number(match[1]), rows: Number(match[2]), assets };
  circuits.push(measurement);
  console.log(JSON.stringify(measurement));
}
const sources = ['contracts/bip340.compact', 'contracts/probe-bip340.compact',
  'src/measure.ts', 'src/fixtures.ts'];
const result = {
  measuredAt: new Date().toISOString(),
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  compilerInfo: JSON.parse(readFileSync(path.join(managed, 'compiler/contract-info.json'), 'utf8')),
  zkirVersion: execFileSync(zkir, ['--version'], { encoding: 'utf8' }).trim(),
  hardware: { platform: platform(), arch: arch(), cpu: cpus()[0].model, memoryBytes: totalmem() },
  fixture: vectorSource,
  note: 'Rows describe the full probe, including its SHA-256 input commitment and ledger write. Key sizes come from full compilation. No ACC integration or node deployment is measured.',
  sources: Object.fromEntries(await Promise.all(sources.map(async file =>
    [file, await hashFile(path.join(root, file))]))),
  circuits,
};
const output = path.join(root, 'evidence');
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'circuit-sizes.json'), JSON.stringify(result, null, 2) + '\n');
