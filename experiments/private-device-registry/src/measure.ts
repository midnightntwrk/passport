// Measure generated circuit shape without generating keys or proofs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, platform, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const compilerVersion = '0.35.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const managed = path.join(root, 'contracts/managed/registry');
const { values } = parseArgs({ options: {
  'zkir-bin': { type: 'string' }, help: { type: 'boolean', short: 'h' },
} });

if (values.help) {
  console.log('Usage: node --import tsx src/measure.ts [--zkir-bin /path/to/zkir-v3]\n' +
    'ZKIR_BIN overrides discovery in COMPACT_DIRECTORY (default ~/.compact).\n' +
    'EVIDENCE_DIR overrides the default evidence/ output directory. Compile first with npm run compile.');
  process.exit(0);
}

function hashFile(file: string) {
  const bytes = readFileSync(file);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function executable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

function locateZkir(): { binary: string; selectedBy: string } {
  if (values['zkir-bin']) return { binary: values['zkir-bin'], selectedBy: '--zkir-bin' };
  if (process.env.ZKIR_BIN) return { binary: process.env.ZKIR_BIN, selectedBy: 'ZKIR_BIN' };
  const compactDirectory = process.env.COMPACT_DIRECTORY ?? path.join(homedir(), '.compact');
  const versionDirectory = path.resolve(compactDirectory, 'versions', compilerVersion);
  const nativeArch = arch() === 'arm64' ? 'aarch64' : arch() === 'x64' ? 'x86_64' : arch();
  const nativePlatform = `${nativeArch}-${platform()}`;
  const name = platform() === 'win32' ? 'zkir-v3.exe' : 'zkir-v3';
  // Prefer the manager's native triplet; allow native platform suffixes
  // such as -gnu/-musl without selecting an unrelated installed platform.
  const directories = existsSync(versionDirectory)
    ? readdirSync(versionDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() &&
        (entry.name === nativePlatform || entry.name.startsWith(`${nativePlatform}-`)))
      .map(entry => entry.name).sort()
    : [];
  const candidates = [nativePlatform, ...directories.filter(name => name !== nativePlatform)]
    .map(directory => path.join(versionDirectory, directory, name));
  const binary = candidates.find(executable);
  if (!binary) throw new Error(`Cannot find Compact ${compilerVersion} zkir-v3 for ${nativePlatform}. ` +
    'Install that toolchain, set COMPACT_DIRECTORY, or supply ZKIR_BIN / --zkir-bin.');
  return { binary, selectedBy: `Compact ${compilerVersion} toolchain discovery` };
}

function run(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`Cannot run zkir-v3: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`zkir-v3 ${args[0]} failed ` +
    `(exit ${result.status}, signal ${result.signal ?? 'none'}):\n${result.stdout}${result.stderr}`);
  return result.stdout + result.stderr;
}

function compactSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'managed') return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? compactSources(file) : entry.name.endsWith('.compact') ? [file] : [];
  }).sort();
}

async function main() {
  const infoPath = path.join(managed, 'compiler/contract-info.json');
  const irDirectory = path.join(managed, 'zkir');
  if (!existsSync(infoPath) || !existsSync(irDirectory)) {
    throw new Error('Missing compiled registry artifacts. Run npm run compile in experiments/private-device-registry first.');
  }
  const info = JSON.parse(readFileSync(infoPath, 'utf8')) as Record<string, unknown>;
  if (info['compiler-version'] !== compilerVersion) {
    throw new Error(`Expected Compact ${compilerVersion} artifacts; found ${String(info['compiler-version'])}. Run npm run compile.`);
  }
  const names = readdirSync(irDirectory).filter(name => name.endsWith('.zkir')).sort();
  if (names.length === 0) throw new Error('No generated .zkir circuits found. Run npm run compile first.');
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const { binary, selectedBy } = locateZkir();
  const toolVersion = run(binary, ['--version']).trim();
  const circuits = [];
  for (const filename of names) {
    const file = path.join(irDirectory, filename);
    const ir = JSON.parse(readFileSync(file, 'utf8')) as { version: unknown; instructions: { op: string }[] };
    if (!Array.isArray(ir.instructions) || ir.instructions.some(instruction => typeof instruction.op !== 'string')) {
      throw new Error(`Unexpected ZKIR instruction format in ${filename}`);
    }
    const opcodeCounts: Record<string, number> = {};
    for (const instruction of ir.instructions) opcodeCounts[instruction.op] = (opcodeCounts[instruction.op] ?? 0) + 1;
    const began = performance.now();
    const output = run(binary, ['mock-compile', file]);
    const mockCompileMilliseconds = performance.now() - began;
    const match = output.match(/k=(\d+),\s*rows=(\d+)/);
    if (!match) throw new Error(`Missing circuit shape in zkir-v3 output for ${filename}: ${output}`);
    const measurement = {
      name: filename.slice(0, -5), k: Number(match[1]), rows: Number(match[2]),
      mockCompileMilliseconds, ir: { file: `contracts/managed/registry/zkir/${filename}`, ...hashFile(file), version: ir.version },
      instructionCount: ir.instructions.length,
      opcodeCounts: Object.fromEntries(Object.entries(opcodeCounts).sort(([a], [b]) => a.localeCompare(b))),
    };
    circuits.push(measurement);
    console.log(`${measurement.name}: k=${measurement.k}, rows=${measurement.rows}, mock-compile=${mockCompileMilliseconds.toFixed(1)} ms`);
  }
  const sources = [...compactSources(path.join(root, 'contracts')), fileURLToPath(import.meta.url)];
  const result = {
    completed: true, startedAt, completedAt: new Date().toISOString(), elapsedMilliseconds: performance.now() - start,
    scope: 'Circuit shape from zkir-v3 mock-compile. Instruction counts are IR counts, not constraint rows. Timings measure mock compilation, not proving. No key generation, proof size, proof timing, proof verification or node acceptance is measured.',
    tool: { version: toolVersion, selectedBy },
    compiler: { version: info['compiler-version'], commit: info['compiler-commit'],
      languageVersion: info['language-version'], runtimeVersion: info['runtime-version'], infoFile: hashFile(infoPath) },
    hardware: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, memoryBytes: totalmem() },
    node: process.version,
    sources: Object.fromEntries(sources.map(file => [path.relative(root, file).split(path.sep).join('/'), hashFile(file)])),
    packageLock: hashFile(path.join(root, 'package-lock.json')),
    circuits,
  };
  const outputDirectory = process.env.EVIDENCE_DIR ? path.resolve(process.env.EVIDENCE_DIR) : path.join(root, 'evidence');
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(path.join(outputDirectory, 'measurements.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Measured ${circuits.length} circuits; wrote ${path.join(outputDirectory, 'measurements.json')}`);
}

main().catch(error => {
  console.error(`Measurement failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
