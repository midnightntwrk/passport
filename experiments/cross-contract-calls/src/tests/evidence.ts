// Evidence capture — one JSON file per probe under evidence/, same
// conventions as the sibling experiments (contract-to-contract-transfer,
// account-custody reference harness). compose-findings.ts renders the table
// in FINDINGS.md from these files.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(__dirname, '..', '..', 'evidence');

// BLOCKED is P5's best-effort verdict: a published-stack gap stopped the
// probe before it could answer its question; the recorded failure IS the
// evidence.
export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED';

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
      // Defaults mirror infra/docker-compose.yml and package.json; override
      // via env when running against a different stack.
      node: process.env.MIDNIGHT_NODE_TAG ?? 'midnightntwrk/midnight-node:2.1.0-2e92c4ae642c',
      indexer: process.env.MIDNIGHT_INDEXER_TAG ?? 'midnightntwrk/indexer-standalone:4.4.0-rc.2',
      proofServer: process.env.MIDNIGHT_PROOF_TAG ?? 'midnightntwrk/proof-server:9.0.0-rc.6',
      compactc: process.env.COMPACTC_VERSION ?? '0.34.0',
      compactRuntime: '0.19.0',
      compactJs: '2.5.5-rc.8',
      midnightJs: '5.0.0-beta.7',
      ledgerV9: '1.0.0-rc.3',
    },
  };
  const file = path.join(EVIDENCE_DIR, `${e.testId.toLowerCase()}-${e.name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(full, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
  console.log(`\n■ evidence → ${path.relative(process.cwd(), file)} [${e.verdict}]`);
}

// ── Error forensics ──────────────────────────────────────────────────────────
//
// The midnight-js scoped-transaction wrapper layers errors several deep;
// capture the full cause chain so the evidence shows the exact underlying
// failure rather than the generic wrapper.

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

export interface CallClassification {
  outcome:
    | 'node-accepted'
    | 'node-rejected'
    | 'prover-rejected'
    | 'construction-rejected'
    | 'sdk-glue-crash'
    | 'inconclusive';
  errorCode: string;
  note: string;
}

/**
 * Where along the pipeline did a cross-contract call transaction fail?
 * The stages matter individually for this experiment:
 *   - construction-rejected → the compact-runtime cross-contract execution
 *     (implementation-binding guard, re-entrancy guard, callee assertion)
 *     refused the call tree locally; nothing was proven or submitted.
 *     For P4/P5 negatives this is a CLIENT-side rejection, not the ledger's.
 *   - prover-rejected  → the proof server refused a proof (HTTP 400); the
 *     transaction never reached the node.
 *   - node-rejected    → the ledger refused the two-call intent; the error
 *     code is the on-node verdict (P4's atomicity evidence lives here).
 *   - sdk-glue-crash   → JS↔WASM boundary crash before submission; says
 *     nothing about the protocol.
 *   - inconclusive     → anything else; read details.error.causeChain.
 */
export function classifyCallError(err: any): CallClassification {
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
      note: `Node rejected the transaction with ledger error ${substrate[1]} — an on-node verdict.`,
    };
  }
  // The node 2.1.0 fee wall: small call+offer transactions are
  // mempool-rejected by the fee model (Malformed(FeeCalculation(
  // OutsideTimeToDismiss))). P6/P7 are designed to avoid it (in-circuit
  // mint funding, no user offer), so hitting it IS a finding: a fee-model
  // limit, not a cross-contract verdict.
  if (msg.includes('outsidetimetodismiss')) {
    return {
      outcome: 'node-rejected',
      errorCode: 'fee-wall-outside-time-to-dismiss',
      note:
        'The node mempool-rejected the transaction at the known node 2.1.0 fee wall ' +
        '(FeeCalculation OutsideTimeToDismiss). This is the fee-model limit on small ' +
        'call+offer transactions, not a verdict on the cross-contract mechanism.',
    };
  }
  const malformed = msg.match(/malformederror::?(\w+)/);
  if (malformed) {
    return {
      outcome: 'node-rejected',
      errorCode: `malformed-${malformed[1].toLowerCase()}`,
      note: `Node rejected with MalformedError::${malformed[1]} — an on-node verdict.`,
    };
  }
  if (msg.includes('proof server response') && msg.includes('400')) {
    return {
      outcome: 'prover-rejected',
      errorCode: 'prove-400',
      note:
        'The proof server rejected a proof in the call tree as unsatisfiable (HTTP 400). ' +
        'No transaction was submitted; the failure is pre-node.',
    };
  }
  if (
    msg.includes('contractinterfacemismatch') ||
    msg.includes('reentran') ||
    msg.includes('calls to witnesses in non-root contracts') ||
    msg.includes('failed assert')
  ) {
    return {
      outcome: 'construction-rejected',
      errorCode: 'runtime-guard',
      note:
        'compact-runtime refused the call tree during local execution (guard or in-circuit ' +
        'assert); nothing was proven or submitted. A client-side rejection, not a ledger verdict.',
    };
  }
  if (msg.includes("reading 'buffer'") || msg.includes('wasm')) {
    return {
      outcome: 'sdk-glue-crash',
      errorCode: 'js-wasm-glue',
      note:
        'Off-chain proving crashed in the JS↔WASM boundary before any transaction was ' +
        'submitted. Not a protocol verdict.',
    };
  }
  // The wallet SDK wraps the node's refusal of a submitted transaction as a
  // bare SubmissionError with no cause detail; the transaction WAS proven and
  // submitted, so the refusal is the node's (P4's stale-composed-tx evidence
  // classifies here).
  if (msg.includes('transaction submission error') || (err?.name ?? '').includes('SubmissionError')) {
    return {
      outcome: 'node-rejected',
      errorCode: 'submission-refused',
      note:
        'The node refused the transaction at the submission RPC (wallet SDK SubmissionError). ' +
        'The transaction was proven and submitted; the refusal is an on-node verdict, though the ' +
        'SDK wrapper hides the specific ledger error code.',
    };
  }
  if (msg.includes('contractruntimeerror') || msg.includes('error executing circuit')) {
    return {
      outcome: 'construction-rejected',
      errorCode: 'contract-runtime-error',
      note:
        'compact-runtime failed during local circuit execution / proof construction; the ' +
        'transaction never reached the node. Not a ledger verdict.',
    };
  }
  return {
    outcome: 'inconclusive',
    errorCode: 'js-error',
    note: 'Failed before a tx hash with no known signature — see details.error.causeChain.',
  };
}
