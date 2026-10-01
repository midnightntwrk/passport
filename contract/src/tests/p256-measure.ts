// Reproducible circuit shape/key inventory. Proving samples are recorded by
// test:p256 against these same assets; key generation is not proving time.
import { createReadStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { arch, cpus, homedir, platform, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const zkir = process.env.ZKIR_BIN ?? path.join(homedir(), '.compact/versions/0.35.0/aarch64-darwin/zkir-v3');
const shaFile = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const circuits = [];
for (const contract of ['probe-p256', 'account']) {
  const base = path.join(root, 'contracts/managed', contract);
  for (const file of readdirSync(path.join(base, 'zkir')).filter(f => f.endsWith('.zkir')).sort()) {
    const name = file.slice(0, -5);
    const ir = path.join(base, 'zkir', file);
    const run = spawnSync(zkir, ['mock-compile', ir], { encoding: 'utf8' });
    if (run.error || run.status !== 0) throw run.error ?? new Error(run.stderr);
    const output = run.stdout + run.stderr;
    const match = output.match(/k=(\d+), rows=(\d+)/);
    if (!match) throw new Error(`missing circuit shape: ${output}`);
    const files = { zkir: ir, prover: path.join(base, 'keys', `${name}.prover`), verifier: path.join(base, 'keys', `${name}.verifier`) };
    const assets = {};
    for (const [kind, file] of Object.entries(files)) assets[kind] = { bytes: statSync(file).size, sha256: await shaFile(file) };
    circuits.push({ contract, circuit: name, k: Number(match[1]), rows: Number(match[2]), assets });
    console.log(`${contract}/${name}: k=${match[1]} rows=${match[2]} prover=${assets['prover'].bytes} B`);
  }
}
const sources = {};
for (const file of ['account.compact', 'account-p256.compact', 'webauthn.compact', 'probe-p256.compact']) {
  sources[file] = await shaFile(path.join(root, 'contracts', file));
}
const result = {
  measuredAt: new Date().toISOString(), compiler: JSON.parse(readFileSync(path.join(root, 'contracts/managed/account/compiler/contract-info.json'), 'utf8'))['compiler-version'],
  zkirVersion: execFileSync(zkir, ['--version'], { encoding: 'utf8' }).trim(),
  hardware: { platform: platform(), arch: arch(), cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  profile: 'wa-json134', sources, circuits,
};
const out = path.join(root, 'evidence/p256-webauthn');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'circuit-sizes.json'), JSON.stringify(result, null, 2) + '\n');
