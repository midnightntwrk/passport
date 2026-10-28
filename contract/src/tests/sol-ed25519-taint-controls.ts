// The controls of the format flag's privacy, compiled: the compiler refuses
// every undisclosed path from a private flag to the ledger, and the ZKIR taint
// analysis (src/tests/zkir-taint.ts) reports a disclosed one and clears one
// that only feeds a hash, as the arm's signing format does.
//
// Needs the Compact compiler (`compact compile +0.35.0`) on the PATH, like
// `npm run compile`; the offline suites run sol-ed25519-taint-offline.ts on
// the built account instead. Each control in src/tests/taint-controls/ is
// compiled with --skip-zk into a temporary folder:
//   leak-undisclosed  the flag written to the ledger            refused
//   leak-branch       a ledger operation on one branch only      refused
//   leak-select       a public value selected by the flag        refused
//   leak-disclosed    the flag written WITH disclose()           compiles; the analysis reports it
//   no-leak           the flag selects a hashed head only        compiles; the analysis clears it
// A refusal counts only with the compiler's witness-disclosure message naming
// the flag.
//
// Writes $EVIDENCE_DIR/sol-ed25519-taint-controls.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fieldInputs, taint, type ContractInfo, type Zkir } from './zkir-taint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'taint-controls');
const COMPILER = process.env.COMPACT ?? 'compact';
const REFUSAL = /potential witness-value disclosure must be declared but is not[\s\S]*parameter offchain/;

interface Case { name: string; verdict: 'PASS' | 'FAIL'; detail?: string }
const cases: Case[] = [];
const ok = (name: string, cond: boolean, detail?: string) => {
  cases.push({ name, verdict: cond ? 'PASS' : 'FAIL', ...(detail ? { detail } : {}) });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-controls-'));
const compile = (name: string) => {
  const out = path.join(tmp, name);
  const r = spawnSync(COMPILER, ['compile', '+0.35.0', '--feature-zkir-v3', '--skip-zk', path.join(DIR, `${name}.compact`), out], { encoding: 'utf8' });
  if (r.error) throw new Error(`cannot run ${COMPILER}: ${r.error.message}`);
  return { status: r.status, text: `${r.stdout}${r.stderr}`, out };
};
const analyse = (out: string) => {
  const z = JSON.parse(fs.readFileSync(path.join(out, 'zkir', 'leak.zkir'), 'utf8')) as Zkir;
  const info = JSON.parse(fs.readFileSync(path.join(out, 'compiler', 'contract-info.json'), 'utf8')) as ContractInfo;
  return taint(z, fieldInputs(info, z, 'leak', 'offchain'));
};

const results: Record<string, unknown> = {};
try {
  for (const name of ['leak-undisclosed', 'leak-branch', 'leak-select']) {
    const c = compile(name);
    results[name] = { status: c.status, message: c.text.trim().split('\n').slice(0, 8).join('\n') };
    ok(`${name}: refused by the compiler's witness-disclosure analysis`, c.status !== 0 && REFUSAL.test(c.text), c.text.slice(0, 300));
  }
  {
    const c = compile('leak-disclosed');
    const r = c.status === 0 ? analyse(c.out) : undefined;
    results['leak-disclosed'] = { status: c.status, taint: r };
    ok('leak-disclosed: compiles, and the taint analysis reports the flag in a ledger operation', c.status === 0 && r?.disclosed === true && r.sinks.impactInput >= 1, JSON.stringify(r?.sinks ?? c.text.slice(0, 200)));
  }
  {
    const c = compile('no-leak');
    const r = c.status === 0 ? analyse(c.out) : undefined;
    results['no-leak'] = { status: c.status, taint: r };
    ok('no-leak: compiles, and the taint analysis finds the flag in no public instruction while it reaches the hash',
      c.status === 0 && r?.disclosed === false && r.taintedInstructionsByOp.sha512 === 1, JSON.stringify(r ?? c.text.slice(0, 200)));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = cases.filter((c) => c.verdict !== 'PASS');
const verdict = failed.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-taint-controls.json'),
    JSON.stringify({ suite: 'sol-ed25519-taint-controls', ranAt: new Date().toISOString(), compiler: COMPILER, cases, results, verdict }, null, 2) + '\n');
}
console.log(`\n◆ sol-ed25519-taint-controls: ${verdict} (${cases.length} cases, ${failed.length} failed)`);
process.exit(verdict === 'PASS' ? 0 : 1);
