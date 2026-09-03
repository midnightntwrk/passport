// Evidence capture — one JSON file per probe under evidence/, same
// conventions as the sibling experiments (dust-sponsorship-feasibility,
// contract-custody-feasibility). compose-findings.ts renders the table in
// FINDINGS.md from these files.

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
      // Defaults mirror infra/docker-compose.yml; override via env when
      // running against a different stack.
      node: process.env.MIDNIGHT_NODE_TAG ?? 'midnightntwrk/midnight-node:2.1.0-2e92c4ae642c',
      indexer: process.env.MIDNIGHT_INDEXER_TAG ?? 'midnightntwrk/indexer-standalone:4.4.0-rc.2',
      proofServer: process.env.MIDNIGHT_PROOF_TAG ?? 'midnightntwrk/proof-server:9.0.0-rc.6',
    },
  };
  const file = path.join(EVIDENCE_DIR, `${e.testId.toLowerCase()}-${e.name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(full, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
  console.log(`\n■ evidence → ${path.relative(process.cwd(), file)} [${e.verdict}]`);
}

// ── Error forensics (S5 crib) ───────────────────────────────────────────────
//
// The midnight-js scoped-transaction wrapper layers errors several deep;
// capture the full cause chain so the evidence shows the exact underlying
// failure (e.g. the wasm-bindgen TypeError that S5 mistook for a protocol
// wall) rather than the generic wrapper.

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

export interface SpendClassification {
  outcome: 'node-accepted' | 'node-rejected' | 'prover-rejected' | 'sdk-glue-crash' | 'inconclusive';
  errorCode: string;
  note: string;
}

/**
 * The three outcomes that matter for the witness-spend question:
 *   - node-rejected  → protocol wall: the ledger refuses witness-QSCI spends.
 *   - sdk-glue-crash → the S5 signature: off-chain proving crashed, the tx
 *     never reached the node. Says nothing about the protocol (run W4).
 *   - inconclusive   → anything else; read the causeChain.
 */
export function classifySpendError(err: any): SpendClassification {
  const chain: string[] = [];
  let cur: any = err;
  let guard = 0;
  while (cur && guard++ < 8) {
    chain.push(String(cur?.message ?? cur).toLowerCase());
    cur = cur?.cause;
  }
  const msg = chain.join(' | ');
  const substrate = msg.match(/custom error:\s*(\d+)/);
  if (substrate) {
    return {
      outcome: 'node-rejected',
      errorCode: `ledger-${substrate[1]}`,
      note: `Node rejected the witness-QSCI spend with ledger error ${substrate[1]} — protocol-level wall.`,
    };
  }
  if (msg.includes('proof server response') && msg.includes('400')) {
    return {
      outcome: 'prover-rejected',
      errorCode: 'prove-400',
      note:
        'The proof server rejected the witness as unsatisfiable (HTTP 400) — for spends this ' +
        'is the wrong-mt_index signature: the Merkle path does not match the coin commitment. ' +
        'No transaction was submitted.',
    };
  }
  const malformed = msg.match(/malformederror::?(\w+)/);
  if (malformed) {
    return {
      outcome: 'node-rejected',
      errorCode: `malformed-${malformed[1].toLowerCase()}`,
      note: `Node rejected with MalformedError::${malformed[1]} — protocol-level wall.`,
    };
  }
  if (msg.includes('reading \'buffer\'') || msg.includes('wasm')) {
    return {
      outcome: 'sdk-glue-crash',
      errorCode: 'js-wasm-glue',
      note:
        'Off-chain proving crashed in the JS↔WASM boundary before any transaction was ' +
        'submitted — the S5 signature. Not a protocol verdict; escalate to W4 (manual offer).',
    };
  }
  if (msg.includes('contractruntimeerror') || msg.includes('error executing circuit')) {
    return {
      outcome: 'sdk-glue-crash',
      errorCode: 'contract-runtime-error',
      note:
        'compact-runtime failed during local circuit execution / proof construction; the ' +
        'transaction never reached the node. Not a protocol verdict; escalate to W4.',
    };
  }
  return {
    outcome: 'inconclusive',
    errorCode: 'js-error',
    note: 'Failed before a tx hash with no known signature — see details.error.causeChain.',
  };
}
