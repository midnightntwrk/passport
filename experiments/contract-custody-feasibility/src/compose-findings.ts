// Regenerate FINDINGS.md's results table mechanically from evidence/*.json.
//
// Reads every JSON file in evidence/, looks up the matching test id, and
// rewrites the section between the markers
//
//   <!-- BEGIN-RESULTS-TABLE -->
//   ...
//   <!-- END-RESULTS-TABLE -->
//
// in FINDINGS.md. If the markers are absent, replaces the whole "Per-test
// results" table.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EVIDENCE_DIR = path.join(ROOT, 'evidence');
const FINDINGS = path.join(ROOT, 'FINDINGS.md');

const TEST_ORDER = ['U1', 'U2', 'U3', 'U4', 'S1', 'S2', 'S3', 'S4', 'D1', 'D2'];
const TEST_DESCRIPTIONS: Record<string, string> = {
  U1: 'receiveUnshielded user→contract',
  U2: 'sendUnshielded contract→contract (was 186)',
  U3: 'sendUnshielded contract→user (regression)',
  U4: 'end-to-end roundtrip',
  S1: 'mintShieldedToken to kernel.self()',
  S2: 'sendImmediateShielded (atomic mint+send)',
  S3: 'cross-transaction shielded custody',
  S4: 'receiveShielded user→contract (net-new)',
  D1: 'contract pays its own tx Dust fee',
  D2: 'contract acts as paymaster for user tx',
};

interface Evidence {
  test: string;
  name: string;
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'PENDING';
  txHash?: string;
  errorCode?: string;
  note: string;
}

function loadEvidence(): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  if (!fs.existsSync(EVIDENCE_DIR)) return out;
  for (const f of fs.readdirSync(EVIDENCE_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, f), 'utf-8')) as Evidence;
      if (data.test) {
        const existing = out.get(data.test);
        // Newer file beats older if both exist for the same test id.
        if (!existing || (data as any).ranAt > (existing as any).ranAt) out.set(data.test, data);
      }
    } catch {
      // Skip unparseable files.
    }
  }
  return out;
}

function buildTable(evidence: Map<string, Evidence>): string {
  const lines: string[] = [];
  lines.push('| Test | Status  | Tx hash / error code | Note                                         |');
  lines.push('| ---- | ------- | -------------------- | -------------------------------------------- |');
  for (const id of TEST_ORDER) {
    const e = evidence.get(id);
    if (!e) {
      lines.push(`| ${id}   | PENDING | —                    | ${TEST_DESCRIPTIONS[id]}`.padEnd(94) + '|');
      continue;
    }
    const tx = e.txHash ? trimTx(e.txHash) : e.errorCode ?? '—';
    lines.push(`| ${id}   | ${e.verdict.padEnd(7)} | ${tx.padEnd(20)} | ${(e.note || TEST_DESCRIPTIONS[id]).slice(0, 44).padEnd(44)} |`);
  }
  return lines.join('\n');
}

function trimTx(tx: string): string {
  return tx.length > 20 ? tx.slice(0, 8) + '...' + tx.slice(-7) : tx;
}

function rewriteFindings(newTable: string): void {
  const text = fs.readFileSync(FINDINGS, 'utf-8');
  const begin = '<!-- BEGIN-RESULTS-TABLE -->';
  const end = '<!-- END-RESULTS-TABLE -->';

  if (text.includes(begin) && text.includes(end)) {
    const re = new RegExp(`${begin}[\\s\\S]*?${end}`);
    const out = text.replace(re, `${begin}\n\n${newTable}\n\n${end}`);
    fs.writeFileSync(FINDINGS, out);
    console.log(`Updated FINDINGS.md results table (${TEST_ORDER.length} rows).`);
    return;
  }

  // Fallback: replace the existing table heuristically by finding the line
  // starting with `| Test | Status` and the next blank line after the body.
  const headerIdx = text.split('\n').findIndex((l) => /^\|\s*Test\s*\|\s*Status/.test(l));
  if (headerIdx === -1) {
    console.warn('Could not locate results table in FINDINGS.md; appending instead.');
    fs.appendFileSync(FINDINGS, `\n\n${newTable}\n`);
    return;
  }
  const lines = text.split('\n');
  let endIdx = headerIdx + 2;
  while (endIdx < lines.length && lines[endIdx].startsWith('|')) endIdx++;
  lines.splice(headerIdx, endIdx - headerIdx, ...newTable.split('\n'));
  fs.writeFileSync(FINDINGS, lines.join('\n'));
  console.log(`Updated FINDINGS.md results table (heuristic replace).`);
}

const ev = loadEvidence();
console.log(`Loaded ${ev.size} evidence file(s).`);
rewriteFindings(buildTable(ev));
