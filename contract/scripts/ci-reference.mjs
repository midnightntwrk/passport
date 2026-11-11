#!/usr/bin/env node
// Each suite has its own completion assertion, so an empty runner cannot pass.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const contract = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runner = resolve(contract, 'scripts/ci-run.mjs');
const tasks = [];
const npm = (script, kind = 'tap', pattern = '-') => tasks.push([script.replaceAll(':', '-'), kind, pattern, '--', 'npm', 'run', script]);
for (const name of ['device-reconnection', 'grant-preflight', 'recovery-bootstrap', 'multi-coin',
  'durable-change', 'chain-recovery', 'viewing-recovery', 'input-validation']) npm(`test:${name}`);
for (const name of ['unit', 'recovery-offline', 'recovery-sim', 'grants-capability-offline']) {
  npm(`test:${name}`, 'scenario', name === 'unit' ? 'unit-offline' : name);
}
npm('test:p256-offline', 'pattern', '^PASS P-256/WebAuthn:');
npm('test:grants-offline', 'pattern', '^\\s*[1-9]\\d* passed, 0 failed\\s*$');
npm('test:grants-caller-offline', 'pattern', '^PASS caller scope:');
npm('test:view-envelope-offline', 'pattern', '^PASS: 192-byte envelope,');
npm('test:ecc', 'pattern', '^Recorded [1-9]\\d* rows in ');
npm('test:ecc-wallet', 'pattern', '^Wallet checks complete: ([1-9]\\d*)/\\1 expectations matched\\.$');
for (const stage of ['nonces', 'encodings', 'recovery']) npm(`test:ecc-${stage}`, 'pattern', `^${stage}: ([1-9]\\d*)/\\1 checks passed$`);
tasks.push(['ecc-import-boundaries', 'pattern', '^Import boundary checks complete: ([1-9]\\d*)/\\1 expectations matched\\.$',
  '--', process.execPath, '--import', 'tsx', 'src/tests/ecc-import-boundaries.ts']);
// Unit execution regenerates deterministic vectors. Refuse drift before native tests
// consume them, so a circuit change cannot silently rewrite its expected fixtures.
tasks.push(['pinned-vectors', 'command', '-', '--', 'git', 'diff', '--exit-code', '--', 'src/tests/vectors/grants-v3.json']);
for (const crate of ['signer-rs', 'buss-rs']) {
  tasks.push([`${crate}-tests`, 'cargo', '-', '--', 'cargo', 'test', '--locked', '--manifest-path', `${crate}/Cargo.toml`]);
}
tasks.push(['signer-build', 'command', '-', '--', 'cargo', 'build', '--locked', '--manifest-path', 'signer-rs/Cargo.toml']);
npm('test:crossimpl-offline', 'scenario', 'crossimpl-offline');
let failures = 0;
async function run(task) {
  try {
    const child = spawn(process.execPath, [runner, ...task], { cwd: contract, stdio: 'inherit' });
    const result = await new Promise(resolveResult => {
      child.once('error', error => resolveResult({ code: null, error: error.message }));
      child.once('close', (code, signal) => resolveResult({ code, signal }));
    });
    if (result.code !== 0) {
      failures++;
      console.error(`${task[0]} failed: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    failures++;
    console.error(`${task[0]} could not start: ${error.message}`);
  }
}

const fixtureLabels = new Set(['test-unit', 'pinned-vectors']);
const nativeLabels = new Set(['signer-rs-tests', 'buss-rs-tests', 'signer-build', 'test-crossimpl-offline']);
// Only unit-offline writes the pinned vectors. Complete it and check for drift
// before running independent suites or native consumers of those fixtures.
for (const task of tasks.filter(task => fixtureLabels.has(task[0]))) await run(task);

// The ECC suites use separate report/preimage files. Initialise their common
// directory before concurrent writers; file-store fixtures use unique temp dirs,
// and the SDK HTTP/WebSocket fixture binds an ephemeral port.
mkdirSync(resolve(contract, 'evidence/ecc-validation'), { recursive: true });
const parallelTasks = tasks.filter(task => !fixtureLabels.has(task[0]) && !nativeLabels.has(task[0]));
let nextTask = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (nextTask < parallelTasks.length) {
    const task = parallelTasks[nextTask++];
    await run(task);
  }
}));

// Native tests, binary construction, and cross-implementation execution retain
// their serial order after all TypeScript work has completed.
for (const task of tasks.filter(task => nativeLabels.has(task[0]))) await run(task);
if (failures) {
  console.error(`${failures}/${tasks.length} reference commands failed`);
  process.exitCode = 1;
} else console.log(`${tasks.length}/${tasks.length} reference commands passed`);
