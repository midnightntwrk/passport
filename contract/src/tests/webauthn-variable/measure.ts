// Full key-generation receipts, not merely generated JS or mock keys.
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { arch, cpus, homedir, platform, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = path.join(root, 'contracts/managed/probe-webauthn-variable');
const zkir = process.env.ZKIR_BIN ?? path.join(homedir(), '.compact/versions/0.35.0/aarch64-darwin/zkir-v3');
const hashFile = async (file: string) => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return { bytes: statSync(file).size, sha256: hash.digest('hex') };
};
const circuits = [];
for (const name of readdirSync(path.join(base, 'zkir')).filter(s => s.endsWith('.zkir')).map(s => s.slice(0, -5)).sort()) {
  const ir = path.join(base, 'zkir', name + '.zkir');
  const run = spawnSync(zkir, ['mock-compile', ir], { encoding: 'utf8' });
  if (run.error || run.status !== 0) throw run.error ?? new Error(run.stderr);
  const match = (run.stdout + run.stderr).match(/k=(\d+), rows=(\d+)/);
  if (!match) throw new Error(`Missing circuit shape for ${name}`);
  const assets = {
    zkir: await hashFile(ir), bzkir: await hashFile(path.join(base, 'zkir', name + '.bzkir')),
    prover: await hashFile(path.join(base, 'keys', name + '.prover')),
    verifier: await hashFile(path.join(base, 'keys', name + '.verifier')),
  };
  const measurement = { name, k: Number(match[1]), rows: Number(match[2]), assets,
    verifierFitsSingle15000ByteWave: assets.verifier.bytes <= 15_000 };
  circuits.push(measurement);
  console.log(JSON.stringify(measurement));
}
const result = {
  measuredAt: new Date().toISOString(), baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  compilerInfo: JSON.parse(readFileSync(path.join(base, 'compiler/contract-info.json'), 'utf8')),
  zkirVersion: execFileSync(zkir, ['--version'], { encoding: 'utf8' }).trim(),
  hardware: { platform: platform(), arch: arch(), cpu: cpus()[0].model, memoryBytes: totalmem() },
  capacityBytes: 256, maxSha256Blocks: 5, originCapacityBytes: 96,
  note: 'Circuit/key sizes only. No proof timing, memory peak, deployment or browser-interoperability claim.',
  sources: {
    probe: await hashFile(path.join(root, 'contracts/probe-webauthn-variable.compact')),
    webauthn: await hashFile(path.join(root, 'contracts/webauthn.compact')),
    generator: await hashFile(path.join(root, '../experiments/webauthn-variable-json/generate.mjs')),
  },
  fixedProfileBaseline: {
    source: 'evidence/p256-webauthn/circuit-sizes.json',
    measurement: JSON.parse(readFileSync(path.join(root, 'evidence/p256-webauthn/circuit-sizes.json'), 'utf8'))
      .circuits.find((c: { contract: string; circuit: string }) => c.contract === 'probe-p256' && c.circuit === 'verify_webauthn'),
    comparisonNote: 'Combined probe comparison, not isolated SHA overhead: the new probe also commits policy in constructor state and checks variable-position fields.',
  },
  initialVariableBaseline: {
    source: 'evidence/webauthn-variable-json/baseline/circuit-sizes.json',
    circuits: JSON.parse(readFileSync(path.join(root, 'evidence/webauthn-variable-json/baseline/circuit-sizes.json'), 'utf8')).circuits,
  },
  circuits,
};
const out = path.join(root, 'evidence/webauthn-variable-json'); mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'circuit-sizes.json'), JSON.stringify(result, null, 2) + '\n');
