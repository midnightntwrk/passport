import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const contract = resolve(here, '..', '..');
const helper = join(here, 'ci-run.mjs');

function runCase(label, kind, pattern, childArgs, { timeoutMs } = {}) {
  const evidence = mkdtempSync(join(tmpdir(), 'passport-ci-run-'));
  const child = spawnSync(process.execPath, [helper, label, kind, pattern, '--', ...childArgs], {
    cwd: contract,
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      CI_EVIDENCE_DIR: evidence,
      ...(timeoutMs === undefined ? {} : { CI_COMMAND_TIMEOUT_MS: String(timeoutMs) }),
    },
  });
  const reportPath = join(evidence, 'commands', `${label}.json`);
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    rmSync(evidence, { recursive: true, force: true });
    throw new Error(`ci-run did not retain a readable command report for ${label}`, { cause: error });
  }
  return { child, report, evidence };
}

function assertRetained(result, expectedStatus) {
  assert.equal(result.report.status, expectedStatus);
  assert.equal(result.child.error, undefined);
  return result;
}

test('command mode retains a successful child result', t => {
  const result = runCase('command-pass', 'command', '-', [
    process.execPath, '-e', 'process.stdout.write("completed\\n")',
  ]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 0);
  assertRetained(result, 'passed');
  assert.equal(result.report.code, 0);
});

test('command mode retains a non-zero child result', t => {
  const result = runCase('command-nonzero', 'command', '-', [
    process.execPath, '-e', 'process.exit(7)',
  ]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.code, 7);
});

test('command mode retains a spawn error', t => {
  const result = runCase('command-spawn-error', 'command', '-', [
    join(resultlessDirectory(), 'missing-executable'),
  ]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.code, null);
  assert.match(result.report.error, /ENOENT/);
});

test('command mode terminates and records a timed-out child', t => {
  const result = runCase('command-timeout', 'command', '-', [
    process.execPath, '-e', 'setInterval(() => {}, 1000)',
  ], { timeoutMs: 100 });
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.timedOut, true);
});

test('TAP mode accepts a complete non-empty passing summary', t => {
  const result = runCase('tap-valid', 'tap', '-', [process.execPath, '-e', [
    'console.log("# tests 2")',
    'console.log("# pass 2")',
    'console.log("# fail 0")',
    'console.log("# cancelled 0")',
    'console.log("# skipped 0")',
    'console.log("# todo 0")',
  ].join('; ')]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 0);
  assertRetained(result, 'passed');
  assert.equal(result.report.tests, 2);
  assert.equal(result.report.completionVerified, true);
});

test('TAP mode rejects a zero-test summary', t => {
  const result = runCase('tap-zero', 'tap', '-', [process.execPath, '-e', [
    'console.log("# tests 0")', 'console.log("# pass 0")',
    'console.log("# fail 0")', 'console.log("# cancelled 0")',
    'console.log("# skipped 0")', 'console.log("# todo 0")',
  ].join('; ')]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.tests, 0);
});

test('TAP mode rejects missing summary counts', t => {
  const result = runCase('tap-missing-counts', 'tap', '-', [
    process.execPath, '-e', 'console.log("tests finished")',
  ]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.completionVerified, false);
});

test('TAP mode rejects duplicate summary fields', t => {
  const result = runCase('tap-duplicate-fields', 'tap', '-', [process.execPath, '-e', [
    'console.log("# tests 1")',
    'console.log("# pass 1")',
    'console.log("# pass 1")',
    'console.log("# fail 0")',
    'console.log("# cancelled 0")',
    'console.log("# skipped 0")',
    'console.log("# todo 0")',
  ].join('; ')]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.completionVerified, false);
});

test('TAP mode rejects skipped tests', t => {
  const result = runCase('tap-skipped', 'tap', '-', [process.execPath, '-e', [
    'console.log("# tests 1")',
    'console.log("# pass 1")',
    'console.log("# fail 0")',
    'console.log("# cancelled 0")',
    'console.log("# skipped 1")',
    'console.log("# todo 0")',
  ].join('; ')]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.completionVerified, false);
});

test('TAP mode rejects malformed summary counts', t => {
  const result = runCase('tap-malformed-counts', 'tap', '-', [process.execPath, '-e', [
    'console.log("# tests one")',
    'console.log("# pass 1")',
    'console.log("# fail 0")',
    'console.log("# cancelled 0")',
    'console.log("# skipped 0")',
    'console.log("# todo 0")',
  ].join('; ')]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.completionVerified, false);
});

test('scenario mode rejects output without the named completion marker', t => {
  const result = runCase('scenario-missing-completion', 'scenario', 'expected-scenario', [
    process.execPath, '-e', 'console.log("◆ other-scenario: PASS")',
  ]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.completionVerified, false);
});

test('Cargo mode rejects a successful zero-test result', t => {
  const result = runCase('cargo-zero-tests', 'cargo', '-', [process.execPath, '-e', [
    'console.log("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out")',
  ].join('; ')]);
  t.after(() => rmSync(result.evidence, { recursive: true, force: true }));
  assert.equal(result.child.status, 1);
  assertRetained(result, 'failed');
  assert.equal(result.report.tests, 0);
  assert.equal(result.report.completionVerified, false);
});

function resultlessDirectory() {
  return join(tmpdir(), `passport-command-${process.pid}-${Date.now()}`);
}
