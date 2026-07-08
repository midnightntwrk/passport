// W1 — compile-time disclosure probe.
//
// Compiles the three probe contracts that intentionally omit disclose() on
// coin data, and captures the compiler's diagnostics verbatim. The point is
// not whether they compile (they must not — Compact requires declared
// disclosure) but WHAT the compiler says would be disclosed:
//
//   PASS = every disclosure the stdlib paths force is a HIDING HASH of the
//   coin (commitment / nullifier "link" diagnostics) or a branch bit —
//   i.e. nothing forces publication of the raw nonce, colour, or value.
//   FAIL = any diagnostic names a raw coin field as the published object.
//
// The main contract must also compile (its disclosures declared), proving
// the required declarations are expressible.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeEvidence } from './evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const PROBES = [
  'p1-receive-undisclosed',
  'p2-send-undisclosed',
  'p3-change-undisclosed',
];

interface ProbeResult {
  probe: string;
  exitCode: number | null;
  rejected: boolean;
  disclosureNatures: string[];
  rawOutputFile: string;
}

function compile(src: string, out: string): { code: number | null; output: string } {
  const r = spawnSync('compact', ['compile', src, out], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
  });
  return { code: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

/** Pull each "nature of the disclosure: …" clause out of the diagnostics. */
function extractNatures(output: string): string[] {
  const natures: string[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('nature of the disclosure:')) {
      const clause: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].includes('via this path') || lines[j].includes('nature of the disclosure:')) break;
        clause.push(lines[j].trim());
      }
      natures.push(clause.join(' ').trim());
    }
  }
  return natures;
}

// Classify each disclosure clause by what the compiler says is published:
//   hash — a commitment/nullifier link ("… given by a hash of the witness
//     value"): hiding, the design's assumption.
//   bit — a boolean ("the boolean value of … a comparison involving …"):
//     1-bit facts such as has-change / sufficient-balance, plus the change
//     conditional branch. Real but bounded leakage; catalogued as a finding.
//   other — anything else, which would include raw-field publication and
//     fails the probe.
function classifyNature(nature: string): 'hash' | 'bit' | 'other' {
  if (/hash of|commitment|nullifier/.test(nature)) return 'hash';
  if (/boolean value|conditional|branch/.test(nature)) return 'bit';
  return 'other';
}

const results: ProbeResult[] = [];
let mainCompiled = false;

for (const probe of PROBES) {
  const src = path.join('contracts', 'probes', `${probe}.compact`);
  const out = path.join('contracts', 'managed', 'probes', probe);
  console.log(`── compiling ${probe} (expected: rejected with disclosure diagnostics)`);
  const { code, output } = compile(src, out);
  const evidenceFile = path.join(ROOT, 'evidence', `w1-${probe}.compiler.txt`);
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, output);
  const natures = extractNatures(output);
  results.push({
    probe,
    exitCode: code,
    rejected: code !== 0,
    disclosureNatures: natures,
    rawOutputFile: path.relative(ROOT, evidenceFile),
  });
  console.log(`   exit=${code}; ${natures.length} disclosure clause(s)`);
}

console.log('── compiling the main contract (expected: success with declared disclosures)');
const main = compile('contracts/stateless.compact', 'contracts/managed/stateless');
mainCompiled = main.code === 0;
console.log(`   exit=${main.code}`);

const allRejected = results.every((r) => r.rejected);
const allNatures = results.flatMap((r) => r.disclosureNatures);
const byClass = { hash: [] as string[], bit: [] as string[], other: [] as string[] };
for (const n of allNatures) byClass[classifyNature(n)].push(n);

const verdict = allRejected && mainCompiled && byClass.other.length === 0 ? 'PASS' : 'FAIL';

writeEvidence({
  testId: 'W1',
  name: 'compile-disclosure',
  description:
    'Compiler-forced disclosure surface for stdlib receiveShielded/sendShielded with witness coins',
  verdict,
  note:
    verdict === 'PASS'
      ? `Compiler-forced disclosures decompose into ${byClass.hash.length} hiding-hash clause(s) ` +
        `(commitment/nullifier links) and ${byClass.bit.length} single-bit clause(s) (has-change / ` +
        'sufficient-balance comparisons and the change branch). No clause forces raw ' +
        'nonce/colour/value publication, and the main contract compiles with the disclosures ' +
        'declared. The bit-level clauses are a catalogued finding: each stateless spend leaks ' +
        'a handful of comparison bits. On-chain confirmation of what is actually published is W6.'
      : 'Unexpected disclosure shape or compile outcome — read details and the .compiler.txt files.',
  details: {
    probes: results,
    mainContractCompiled: mainCompiled,
    disclosuresByClass: { hash: byClass.hash.length, bit: byClass.bit.length, other: byClass.other.length },
    bitLevelClauses: [...new Set(byClass.bit)],
    otherClauses: byClass.other,
    compactVersion: spawnSync('compact', ['compile', '--version'], { encoding: 'utf-8' }).stdout?.trim(),
  },
});

process.exit(verdict === 'PASS' ? 0 : 1);
