#!/usr/bin/env node
// Execute a bounded command, retaining its log and checking test completion.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [label, kind, pattern, separator, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9-]*$/.test(label ?? '') || separator !== '--' || !command ||
    !['command', 'tap', 'cargo', 'scenario', 'pattern'].includes(kind)) {
  throw new Error('Usage: ci-run.mjs <label> <command|tap|cargo|scenario|pattern> <pattern-or-dash> -- <command> [args...]');
}
const directory = process.env.CI_EVIDENCE_DIR;
if (!directory || !directory.startsWith('/')) throw new Error('CI_EVIDENCE_DIR must be absolute');
const timeoutMs = Number(process.env.CI_COMMAND_TIMEOUT_MS ?? 600_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid command timeout');
mkdirSync(resolve(directory, 'logs'), { recursive: true });
mkdirSync(resolve(directory, 'commands'), { recursive: true });
const log = createWriteStream(resolve(directory, 'logs', `${label}.log`));
const report = { label, kind, command: [command, ...args], cwd: process.cwd(),
  startedAt: new Date().toISOString(), timeoutMs, status: 'running' };
const reportPath = resolve(directory, 'commands', `${label}.json`);
const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
save();
const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on('data', chunk => { log.write(chunk); destination.write(chunk); output += chunk.toString(); });
}
const timer = setTimeout(() => {
  report.timedOut = true;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The process may already have exited. */ }
}, timeoutMs);
const result = await new Promise(resolveResult => {
  child.once('error', error => resolveResult({ code: null, signal: null, error: error.message }));
  child.once('close', (code, signal) => resolveResult({ code, signal }));
});
clearTimeout(timer);
await new Promise(resolveLog => log.end(resolveLog));
Object.assign(report, result, { completedAt: new Date().toISOString() });
let completion = true;
if (kind === 'tap') {
  const count = key => Number(output.match(new RegExp(`^# ${key} (\\d+)\\s*$`, 'm'))?.[1] ?? NaN);
  report.tests = count('tests');
  completion = report.tests > 0 && count('pass') === report.tests &&
    ['fail', 'cancelled', 'skipped', 'todo'].every(key => count(key) === 0);
} else if (kind === 'cargo') {
  const results = [...output.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)];
  report.tests = results.reduce((sum, row) => sum + Number(row[2]), 0);
  completion = report.tests > 0 && results.every(row => row[1] === 'ok' && Number(row[3]) === 0 && Number(row[4]) === 0);
} else if (kind === 'scenario') {
  completion = output.includes(`◆ ${pattern}: PASS`) && !output.includes(`◆ ${pattern}: FAIL`);
} else if (kind === 'pattern') {
  completion = new RegExp(pattern, 'm').test(output);
}
report.completionVerified = completion;
report.status = result.code === 0 && !report.timedOut && completion ? 'passed' : 'failed';
save();
if (report.status !== 'passed') {
  console.error(`${label}: failed (exit=${result.code}, completion=${completion}, timeout=${Boolean(report.timedOut)})`);
  process.exitCode = 1;
}
