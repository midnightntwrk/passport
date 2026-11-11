#!/usr/bin/env node
// Compile fresh runtimes while preparing the two independent native test builds.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const contract = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runner = resolve(contract, 'scripts/ci-run.mjs');
const tasks = [
  { label: 'compile-reference', command: ['npm', 'run', 'ci:compile'] },
  ...['signer-rs', 'buss-rs'].map(crate => ({
    label: `${crate}-prebuild`,
    command: ['cargo', 'test', '--no-run', '--locked', '--manifest-path', `${crate}/Cargo.toml`],
    env: { ...process.env, CARGO_BUILD_JOBS: '1' },
  })),
];

async function run({ label, command, env = process.env }) {
  const child = spawn(process.execPath, [runner, label, 'command', '-', '--', ...command],
    { cwd: contract, env, stdio: 'inherit' });
  const result = await new Promise(resolveResult => {
    child.once('error', error => resolveResult({ code: null, error: error.message }));
    child.once('close', (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) throw new Error(`${label} failed: ${JSON.stringify(result)}`);
}

// Three top-level commands at most; a failed command cannot leave the others unawaited.
const results = await Promise.allSettled(tasks.map(run));
const failures = results.filter(result => result.status === 'rejected');
for (const result of failures) console.error(result.reason);
if (failures.length) {
  console.error(`${failures.length}/${tasks.length} preparation commands failed`);
  process.exitCode = 1;
} else console.log(`${tasks.length}/${tasks.length} preparation commands passed`);
