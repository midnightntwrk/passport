#!/usr/bin/env node
// Preserve provenance even if installation, compilation, or a regression fails.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [phase = 'final', status = 'unknown'] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error('Invalid evidence phase');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = process.env.CI_EVIDENCE_DIR;
if (!directory || !directory.startsWith('/')) throw new Error('CI_EVIDENCE_DIR must be absolute');
mkdirSync(directory, { recursive: true });
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const command = (executable, args) => {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
  return { exitCode: result.status, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '', error: result.error?.message };
};
const manifest = files => Object.fromEntries(files.sort().map(file => [relative(root, file), existsSync(file) && lstatSync(file).isFile() ? hash(file) : null]));
const walk = directory => !existsSync(directory) ? [] : readdirSync(directory).flatMap(name => {
  const file = resolve(directory, name);
  const entry = lstatSync(file);
  if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in evidence inputs: ${file}`);
  return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
});
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const sourceFiles = tracked.filter(file => /^(contract\/(src|scripts|contracts|infra|signer-rs|buss-rs)|\.github\/workflows)\//.test(file) && !file.startsWith('contract/contracts/managed/'));
const generated = walk(resolve(root, 'contract/contracts/managed'));
const toolchain = process.env.COMPACT_DIR ? walk(process.env.COMPACT_DIR) : [];
// Existing committed evidence is not evidence from this run. Retain only JSON
// reports written after this job's initial snapshot, alongside command logs.
const initialPath = resolve(directory, 'initial.json');
const initialTime = existsSync(initialPath) ? Date.parse(JSON.parse(readFileSync(initialPath, 'utf8')).recordedAt) : Date.now();
const publicReports = ['runtime', 'wallet', 'import-boundaries', 'nonces', 'encodings', 'recovery']
  .map(name => resolve(root, 'contract/evidence/ecc-validation', `${name}.json`));
const suiteReports = phase === 'final' ? publicReports.filter(file =>
  existsSync(file) && statSync(file).mtimeMs >= initialTime) : [];
const lane = process.env.CI_LANE ?? 'reference';
const compileModeFile = resolve(directory, 'compile-mode.txt');
const compileMode = existsSync(compileModeFile) ? readFileSync(compileModeFile, 'utf8').trim() : null;
for (const file of suiteReports) {
  const destination = resolve(directory, 'suites', relative(resolve(root, 'contract/evidence'), file));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(file, destination);
}
const report = {
  phase, status, lane, compileMode, recordedAt: new Date().toISOString(),
  scope: lane === 'localnet'
    ? 'Bounded localnet and native prover evidence, with explicitly recorded fixture steps and artefact scope. This does not establish release readiness or branch-protection enforcement.'
    : 'Reference generated-runtime, offline, and native regression evidence. Routine CI generates no proving or verifier keys; keyed SDK assembly and proof/localnet checks are separate manual validation. This does not establish proof verification, localnet acceptance, release readiness, or branch-protection enforcement.',
  event: process.env.GITHUB_EVENT_NAME ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  githubSha: process.env.GITHUB_SHA ?? null,
  pullRequestHeadSha: process.env.REFERENCE_PR_HEAD_SHA || null,
  pullRequestBaseSha: process.env.REFERENCE_PR_BASE_SHA || null,
  git: { commit: command('git', ['rev-parse', 'HEAD']), status: command('git', ['status', '--porcelain=v1']),
    diff: command('git', ['diff', '--stat']) },
  tools: { node: process.version, npm: command('npm', ['--version']),
    compact: command(process.env.COMPACTC ?? 'compactc', ['--version']),
    zkir: command(process.env.ZKIR_BIN ?? 'zkir-v3', ['--version']),
    rustc: command('rustc', ['--version', '--verbose']), cargo: command('cargo', ['--version']) },
  lockfiles: manifest(['contract/package-lock.json', 'contract/package.json', 'contract/signer-rs/Cargo.lock',
    'contract/signer-rs/Cargo.toml', 'contract/buss-rs/Cargo.lock', 'contract/buss-rs/Cargo.toml'].map(file => resolve(root, file))),
  sources: manifest(sourceFiles.map(file => resolve(root, file))),
  generated: manifest(generated), toolchain: manifest(toolchain), suiteReports: manifest(suiteReports),
};
writeFileSync(resolve(directory, `${phase}.json`), `${JSON.stringify(report, null, 2)}\n`);
if (phase === 'final' && process.env.GITHUB_STEP_SUMMARY) {
  const commands = walk(resolve(directory, 'commands')).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(file, 'utf8')));
  const passed = commands.filter(report => report.status === 'passed').length;
  writeFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Reference ${lane} job: **${status}**. ${passed}/${commands.length} recorded commands passed.\n\n` +
    `Logs, command exit statuses, test completion checks, source hashes, generated artefact hashes, lockfile hashes, and toolchain hashes are retained in the evidence artefact. Compile mode: ${compileMode ?? 'not reached'}.\n`);
}
