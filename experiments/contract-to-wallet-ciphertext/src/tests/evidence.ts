// Evidence capture — one JSON file per probe under evidence/, following the
// convention the sibling experiments use. compose-findings.ts renders the
// results table in FINDINGS.md from these files.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(__dirname, '..', '..', 'evidence');

export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL';

export interface Evidence {
  testId: string;
  name: string;
  description: string;
  verdict: Verdict;
  txHash?: string;
  errorCode?: string;
  note: string;
  details?: Record<string, unknown>;
  ranAt: string;
  stack?: Record<string, string>;
}

export function writeEvidence(e: Omit<Evidence, 'ranAt' | 'stack'>): void {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const full: Evidence = {
    ...e,
    ranAt: new Date().toISOString(),
    stack: {
      node: process.env.MIDNIGHT_NODE_TAG ?? 'midnightntwrk/midnight-node:1.0.0',
      indexer: process.env.MIDNIGHT_INDEXER_TAG ?? 'midnightntwrk/indexer-standalone:4.3.3',
      proofServer: process.env.MIDNIGHT_PROOF_TAG ?? 'midnightntwrk/proof-server:8.1.0',
    },
  };
  const file = path.join(EVIDENCE_DIR, `${e.testId.toLowerCase()}-${e.name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(full, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
  console.log(`\n■ evidence → ${path.relative(process.cwd(), file)} [${e.verdict}]`);
}

// ── Error forensics ─────────────────────────────────────────────────────────
//
// The midnight-js scoped-transaction wrapper layers errors several deep, so
// record the whole cause chain: arm A's result is an error message, and it
// matters which layer produced it.

export function serialiseError(e: any): Record<string, unknown> {
  const causeChain: Array<Record<string, unknown>> = [];
  let cur: any = e;
  let guard = 0;
  while (cur && guard++ < 8) {
    causeChain.push({
      name: cur?.name ?? typeof cur,
      tag: cur?._tag ?? null,
      message: cur?.message ?? String(cur),
    });
    cur = cur?.cause;
  }
  return {
    name: e?.name ?? typeof e,
    message: e?.message ?? String(e),
    stack: e?.stack?.split('\n').slice(0, 16).join('\n') ?? null,
    causeChain,
  };
}
