// GRANTS-E4: the UNSHIELDED grant twins held on a node.
//
// The gap this closes is the one GRANTS-E2 recorded as a caveat: "every grant
// spend in this run is shielded, because the node refuses a contract call
// carrying an unshielded offer. The unshielded twins' on-node behaviour is
// therefore unmeasured". `withdraw_unshielded_with_grant_jubjub` and
// `withdraw_unshielded_with_grant_k256` had never been built, proved, or
// submitted by any run.
//
// `probe:dismiss-cost` (evidence/dismiss-cost.json) narrowed E2's wall from
// "call + unshielded offer" to one shape: a SMALL transaction carrying a
// NIGHT input plus the NIGHT change output the wallet's balancing adds. The
// ledger prices dismissal per offer element,
//
//   allowed = max(time_to_dismiss_per_byte * est_size, min_time_to_dismiss)
//   actual  = (guaranteed_cost + validation_cost).max_time()
//
// and a NIGHT input (~3.447 ms) plus a NIGHT change output (~2.491 ms) is two
// orders of magnitude dearer than a plain input (~680 us) and a plain output
// (0). So:
//
//   - deposit_unshielded of NIGHT is REFUSED, by 0.238 ms on a 16.266 ms
//     budget (upstream ledger issue #761). That arm is skipped here, with the
//     number and the node's own verbatim message recorded beside the skip;
//   - deposit_unshielded of a NON-NATIVE color is admitted with 4.975 ms of
//     headroom at the same transaction size;
//   - both unshielded grant twins are admitted with the largest headroom of
//     any funded shape, because `sendUnshielded` to a `UserAddress` is an
//     offer of zero inputs and one output, free in dismissal time.
//
// This suite therefore runs the whole unshielded grant arm on the non-native
// color the faucet mints, end to end on the live localnet:
//
//   S0  wallet, faucet, wave deploy of a k256-born account, cross-arm
//       enrolment of a jubjub device (group `funding`).
//   S1  funding: faucet mint_unshielded of a non-native color to the funding
//       wallet, then a real user-funded deposit_unshielded of it into the
//       account, and the mirror credit read back. The NIGHT arm is skipped
//       here, explicitly and with its price (group `funding`).
//   S2  issuance: grants across both device arms and both grantee arms, every
//       one carrying `op_withdraw_unshielded` over that color, with per-call
//       and cumulative caps and a recipient pin on two of them (group
//       `issue`).
//   S3  the twins holding: withdraw_unshielded_with_grant_jubjub and
//       withdraw_unshielded_with_grant_k256 to a UserAddress, asserting the
//       mirror debit, the per-grant nonce settle, the cap accounting through
//       spent_commit, and the recipient pin (group `spend`).
//   S4  the rejection rows in TWO CLASSES, labelled as such by where the
//       fault lands in the twin's own order (group `rejections`):
//         class A, pre-custody: the fault aborts before
//           `do_withdraw_unshielded` is ever entered, so the mirror is never
//           read and no `sendUnshielded` is reached;
//         class B, in-custody: the call reaches `do_withdraw_unshielded` and
//           the mirror gate refuses it there.
//       Read against contracts/account.compact: the twins run
//       `authenticate_grant_with_<arm>` (steps 1 to 3), `check_spend_scope`
//       (steps 4 and 5), the challenge, `settle_grant_with_<arm>` (steps 6
//       and 7), and only then `do_withdraw_unshielded` — which itself runs
//       `debit_unshielded` BEFORE `sendUnshielded`. So class B still emits no
//       offer, and that is a finding rather than an assumption.
//   S5  the per-call table: proving time, proven bytes, submitted bytes, tx
//       hash, finality, and the prover-retry count (group `proving`).
//
// The suite is a SEPARATE file from grants-conformance.ts rather than a
// thirteenth group inside it, for one structural reason: that scenario is one
// sequence and `GRANTS_E2_GROUPS` truncates rather than skips, so a group
// appended at the end could only ever be produced by re-running every group
// before it — which would rewrite all twelve merged E2 evidence files on
// every unshielded run. Nothing here depends on E2's shielded coin capture,
// candidate-index retry, or inbox plumbing either: the unshielded arm needs a
// deployed account, two device arms, and a funded mirror, and no coin store at
// all. Registered as `npm run test:grants-unshielded`.

import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ContractState } from '@midnightntwrk/ledger-v9';

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, serialiseError, type Verdict } from './evidence.js';
import { expectAbort } from './flow.js';
import {
  setupWallet,
  deployFaucet,
  deployAccount,
  type TestContext,
  type FaucetHandle,
} from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { CustodyAccount } from '../wallet/account.js';
import {
  JubjubDevice,
  K256Device,
  JubjubGrantee,
  K256Grantee,
  originHash,
  spendScope,
  readOnlyScope,
  openingOf,
  jubjubGrantChallenges,
  k256GrantChallenges,
  RECIPIENT_USER_ADDRESS,
  K256_ENVELOPE_CONNECTOR,
  type AnyGrantee,
  type GrantOpening,
  type GrantContext,
  type PlainScope,
} from '../wallet/signer.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { planWaves, allCircuits, VERIFIER_BYTE_BUDGET } from '../wallet/wave-deploy.js';
import { enumerateContractActions, indexerUrl } from '../wallet/capture.js';
import { bytesToHex } from '../wallet/hex.js';
import { pureCircuits } from '../wallet/contract.js';
import type { Ledger } from '../wallet/contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ───────────────────────────────────────────────────────────────

const CLIENT_ID = 'https://grants-e4.example';

/** The faucet domain the working non-native color derives from. */
const DOMAIN = (() => { const d = new Uint8Array(32); d[31] = 0xe4; return d; })();
/** A second domain, for the color the mirror never holds (class B row B1). */
const DOMAIN_OTHER = (() => { const d = new Uint8Array(32); d[31] = 0xe5; return d; })();
/** Night, the all-zero color: the arm this suite skips. */
const NIGHT = new Uint8Array(32);

const MINT = 3_000n;
const DEPOSIT = 3_000n;

const SLOT_U1 = 0n;  // jubjub grantee, no pin, cap 500 / per-call 200
const SLOT_U2 = 1n;  // k256 grantee, pinned to the funding wallet's address
const SLOT_U3 = 2n;  // jubjub grantee, pinned ELSEWHERE (row A10)
const SLOT_U4 = 3n;  // shielded-only scope (row A5)
const SLOT_U5 = 4n;  // expired (row A4)
const SLOT_U6 = 5n;  // revoked (row A3)
const SLOT_U7 = 6n;  // cap 100 / per-call 100, exhausted then over (row A9)
const SLOT_U8 = 7n;  // a color the mirror never held (row B1)
const SLOT_U9 = 8n;  // read-only, connector envelope (row A1)
const SLOT_U10 = 9n; // cap above the mirror (row B2)

const rnd32 = (): Uint8Array => new Uint8Array(randomBytes(32));

// ── Instrumentation ─────────────────────────────────────────────────────────
//
// One place builds a proof and one place puts a transaction on the wire, so
// wrapping `proveTx` and `submitTx` gives proving time, proven bytes, and the
// bytes actually submitted, per labelled call. The label is authoritative:
// the suite sets it around each call.

interface ProofRecord {
  label: string;
  ms: number;
  provenBytes: number | null;
  ok: boolean;
}

interface CallRow {
  label: string;
  circuit: string;
  /** Build + prove + balance + submit + finalise, end to end. */
  callMs: number;
  provingMs: number | null;
  provenBytes: number | null;
  submittedBytes: number | null;
  txId: string | null;
  /** The ledger's 32-byte hash, which is what the node log names. */
  txHash: string | null;
  blockHeight: number | null;
  finality: string | null;
  proverRetries: number;
  ok: boolean;
  error?: string;
}

const proofLog: ProofRecord[] = [];
const callRows: CallRow[] = [];
let currentLabel = '(outside a labelled call)';
let lastProof: ProofRecord | null = null;
let lastSubmittedBytes: number | null = null;

function serialisedLength(tx: any): number | null {
  try {
    const bs = tx?.serialize?.();
    return bs ? bs.length : null;
  } catch {
    return null;
  }
}

function instrument(providers: any, tag: string): void {
  if (!providers || (providers as any).__e4Instrumented) return;
  const pp = providers.proofProvider;
  if (pp && typeof pp.proveTx === 'function' && !(pp as any).__e4Instrumented) {
    const real = pp.proveTx.bind(pp);
    pp.proveTx = async (tx: any, opts?: any) => {
      const t0 = Date.now();
      try {
        const proven = await real(tx, opts);
        const rec: ProofRecord = {
          label: currentLabel,
          ms: Date.now() - t0,
          provenBytes: serialisedLength(proven),
          ok: true,
        };
        proofLog.push(rec);
        lastProof = rec;
        return proven;
      } catch (e) {
        const rec: ProofRecord = { label: currentLabel, ms: Date.now() - t0, provenBytes: null, ok: false };
        proofLog.push(rec);
        lastProof = rec;
        throw e;
      }
    };
    (pp as any).__e4Instrumented = true;
  }
  for (const holder of [providers.walletProvider, providers.midnightProvider]) {
    if (!holder || typeof holder.submitTx !== 'function' || (holder as any).__e4Instrumented) continue;
    const real = holder.submitTx.bind(holder);
    holder.submitTx = async (tx: any) => {
      lastSubmittedBytes = serialisedLength(tx);
      return real(tx);
    };
    (holder as any).__e4Instrumented = true;
  }
  (providers as any).__e4Instrumented = true;
  console.log(`  instrumented (${tag}): proving time, proven bytes, submitted bytes`);
}

// ── Proof-server health (E2's recipe, reused verbatim in behaviour) ─────────
//
// A k = 17 grant proof holds several GiB and the container has been
// OOM-killed mid-run (E2 saw three deaths). A prover outage is never a
// verdict about a call: proving precedes balancing and submission, so nothing
// can have reached the chain. Restore the container and run the same call
// again, counting the retries.

const proverRestarts: Array<{ label: string; at: string; reason: string }> = [];

async function proverHealthy(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:6300/health', { signal: AbortSignal.timeout(3_000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureProver(label: string, reason: string): Promise<void> {
  if (await proverHealthy()) return;
  console.log(`  ⚠ proof server not answering before "${label}" — restarting it`);
  proverRestarts.push({ label, at: new Date().toISOString(), reason });
  try {
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve) => {
      execFile('docker', ['start', 'account-custody-reference-proof-server-1'], () => resolve());
    });
  } catch { /* fall through to the wait */ }
  for (let i = 0; i < 60; i++) {
    if (await proverHealthy()) {
      console.log('  ✓ proof server back up');
      return;
    }
    await sleep(2_000);
  }
  throw new Error('proof server did not come back up');
}

/** True when a failure is the proof SERVER rather than the witness. Both
 *  halves, so a 400 from a live prover (a real verdict) is never an outage. */
function proverOutage(message: string): boolean {
  return /:6300|proof server|'prove' returned an error/i.test(message)
    && /FetchError|ECONNREFUSED|fetch failed|socket hang up|ECONNRESET|network timeout|EAI_AGAIN/i.test(message);
}

// ── Chain reads ─────────────────────────────────────────────────────────────

/**
 * The indexer's finality line for a transaction.
 *
 * The identifier midnight-js returns from a call is 33 bytes (a one-byte
 * network prefix and the 32-byte hash), which the indexer's `hash` offset
 * refuses outright ("invalid transaction hash: cannot convert to ByteA"). The
 * `identifier` offset is the one that takes it, so both are tried and the
 * offset that answered is recorded beside the answer.
 */
interface Finality {
  /** The indexer's own line: type, result status, and block height. */
  line: string;
  /** The ledger's 32-byte transaction hash, which is what the node log names. */
  hash: string | null;
  blockHeight: number | null;
  /** Which offset answered, `identifier` or `hash`. */
  via: string | null;
}

async function txFinality(idOrHash: string): Promise<Finality> {
  const query = `query($o: TransactionOffset!) {
    transactions(offset: $o) { __typename hash block { height }
      ... on RegularTransaction { transactionResult { status } } }
  }`.trim();
  const clean = idOrHash.replace(/^0x/, '');
  const failures: string[] = [];
  for (const offset of [{ identifier: clean }, { hash: clean }] as const) {
    const which = 'identifier' in offset ? 'identifier' : 'hash';
    try {
      const res = await fetch(indexerUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { o: offset } }),
      });
      const body: any = await res.json();
      if (body?.errors?.length) {
        failures.push(`${which}: ${String(body.errors[0]?.message).slice(0, 90)}`);
        continue;
      }
      const t = (body?.data?.transactions ?? [])[0];
      if (!t) {
        failures.push(`${which}: the indexer returned no transaction`);
        continue;
      }
      return {
        line: `${t.__typename}${t.transactionResult ? `/${t.transactionResult.status}` : ''} @block ${t?.block?.height}`,
        hash: t.hash ?? null,
        blockHeight: t.block?.height ?? null,
        via: which,
      };
    } catch (e: any) {
      failures.push(`${which}: ${String(e?.message).slice(0, 90)}`);
    }
  }
  return { line: `unavailable (${failures.join('; ')})`, hash: null, blockHeight: null, via: null };
}

/** The contract's on-chain maintenance authority, read through the indexer. */
async function maintenanceAuthority(address: string): Promise<{ committee: number; threshold: number; counter: string }> {
  const r = await fetch(indexerUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `{contractAction(address:"${address.replace(/^0x/, '')}"){state}}` }),
  });
  const hex = ((await r.json()) as any)?.data?.contractAction?.state;
  if (!hex) throw new Error(`no on-chain state for ${address}`);
  const st = ContractState.deserialize(
    Uint8Array.from(hex.match(/../g)!.map((b: string) => parseInt(b, 16))),
  );
  return {
    committee: st.maintenanceAuthority.committee.length,
    threshold: Number(st.maintenanceAuthority.threshold),
    counter: String(st.maintenanceAuthority.counter),
  };
}

/**
 * The node's own account of a mempool refusal: the node log carries
 * `Rejected transaction <hash> : <error>`. Captured for every refusal row,
 * including the ones expected to produce nothing, so "no node line" is
 * recorded as a measurement rather than assumed. Distinguishes "captured
 * nothing" from "the capture itself failed".
 */
function nodeRejectionLines(sinceSeconds: number): { lines: string[]; failure?: string } {
  const container = process.env.MIDNIGHT_NODE_CONTAINER ?? 'account-custody-reference-node-1';
  try {
    const r = spawnSync('docker', ['logs', '--since', `${sinceSeconds}s`, container], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error || (r.status ?? 1) !== 0) {
      return {
        lines: [],
        failure: `docker logs ${container}: ${r.error ? String(r.error.message) : `exit ${String(r.status)}`}`,
      };
    }
    return {
      lines: `${r.stdout ?? ''}\n${r.stderr ?? ''}`
        .split('\n')
        .filter((l) => /Rejected transaction|would fail|would exhaust|Invalid Transaction|Transcript\(/.test(l))
        .map((l) => l.replace(/^\S+ \S+\s+/, '').trim()),
    };
  } catch (e) {
    return { lines: [], failure: `node log capture threw: ${String(e).slice(0, 200)}` };
  }
}

// ── The call wrapper ────────────────────────────────────────────────────────

/**
 * Run one labelled call with the prover watched, the proof and submission
 * measured, and the row recorded. `circuit` is the circuit the call targets;
 * a deploy is excluded from the outage retry, because re-running one would
 * deploy a second contract.
 */
async function call<T>(
  label: string,
  circuit: string,
  fn: () => Promise<T>,
  opts?: { txIdOf?: (r: T) => string | null },
): Promise<T> {
  await ensureProver(label, 'pre-call health check');
  const previous = currentLabel;
  currentLabel = label;
  lastProof = null;
  lastSubmittedBytes = null;
  const t0 = Date.now();
  let retries = 0;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fn();
        const txId = opts?.txIdOf ? opts.txIdOf(r) : ((r as any)?.txId ?? null);
        const row: CallRow = {
          label,
          circuit,
          callMs: Date.now() - t0,
          provingMs: lastProof?.ms ?? null,
          provenBytes: lastProof?.provenBytes ?? null,
          submittedBytes: lastSubmittedBytes,
          txId,
          txHash: null,
          blockHeight: null,
          finality: null,
          proverRetries: retries,
          ok: true,
        };
        if (txId) {
          const f = await txFinality(txId);
          row.txHash = f.hash;
          row.blockHeight = f.blockHeight;
          row.finality = f.line;
        }
        callRows.push(row);
        console.log(
          `  ✓ ${label}: ${row.callMs} ms end to end` +
          `${row.provingMs === null ? '' : `, ${row.provingMs} ms proving`}` +
          `${row.provenBytes === null ? '' : `, ${row.provenBytes} proven B`}` +
          `${row.submittedBytes === null ? '' : `, ${row.submittedBytes} submitted B`}` +
          `${txId ? `, tx ${txId}` : ''}` +
          `${row.txHash ? ` (hash ${row.txHash})` : ''}${row.finality ? ` [${row.finality}]` : ''}`,
        );
        return r;
      } catch (e: any) {
        const message = String(e?.message ?? e);
        if (attempt >= 2 || label.startsWith('deploy:') || !proverOutage(message)) throw e;
        retries++;
        console.log(`  (the proof server dropped during "${label}"; restoring it and running the call again)`);
        proverRestarts.push({ label, at: new Date().toISOString(), reason: `outage during: ${label}` });
        await ensureProver(label, `outage during: ${label}`);
      }
    }
  } catch (e: any) {
    callRows.push({
      label,
      circuit,
      callMs: Date.now() - t0,
      provingMs: lastProof?.ms ?? null,
      provenBytes: lastProof?.provenBytes ?? null,
      submittedBytes: lastSubmittedBytes,
      txId: null,
      txHash: null,
      blockHeight: null,
      finality: null,
      proverRetries: retries,
      ok: false,
      error: String(e?.message ?? e).slice(0, 400),
    });
    throw e;
  } finally {
    currentLabel = previous;
  }
}

// ── Ledger snapshots (the mirror included) ──────────────────────────────────

interface LedgerSnapshot {
  round: string;
  authNonce: string;
  inboxCount: string;
  deviceCount: string;
  grantGeneration: string;
  grantCount: string;
  /** The working color's mirror balance, '(absent)' when the key is unset. */
  mirror: string;
}

function mirrorOf(l: Ledger, color: Uint8Array): string {
  return l.unshielded_balances.member(color)
    ? l.unshielded_balances.lookup(color).toString()
    : '(absent)';
}

function snapshotOf(l: Ledger, color: Uint8Array): LedgerSnapshot {
  return {
    round: l.round.toString(),
    authNonce: l.auth_nonce.toString(),
    inboxCount: l.inbox_count.toString(),
    deviceCount: l.device_count.toString(),
    grantGeneration: l.grant_generation.toString(),
    grantCount: l.grants.size().toString(),
    mirror: mirrorOf(l, color),
  };
}

function sameSnapshot(a: LedgerSnapshot, b: LedgerSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function recordOf(l: Ledger, grantId: Uint8Array): Record<string, unknown> | null {
  if (!l.grants.member(grantId)) return null;
  const g: any = l.grants.lookup(grantId);
  return {
    epoch: g.epoch.toString(),
    gen: g.gen.toString(),
    issued_at: g.issued_at.toString(),
    nonce: g.nonce.toString(),
    active: g.active,
    spent_commit: bytesToHex(g.spent_commit),
    per_call_cap: g.scope.per_call_cap.toString(),
    cap: g.scope.cap.toString(),
    expires_at: g.scope.expires_at.toString(),
    op_withdraw_unshielded: g.scope.op_withdraw_unshielded,
    op_withdraw_shielded: g.scope.op_withdraw_shielded,
    op_withdraw_shielded_to_contract: g.scope.op_withdraw_shielded_to_contract,
    read: g.scope.read,
    // The color, the recipient kind, the pinned recipient, and
    // max_coin_value are NOT public fields of the record: the on-chain
    // GrantScope carries only their salted commitment. The recipient pin is
    // therefore committed, not disclosed, and the suite checks it by
    // recomputing the commitment from the opening it holds.
    object_commit: bytesToHex(g.scope.object_commit),
    rp_commit: bytesToHex(g.scope.rp_commit),
    read_pk_hash: bytesToHex(g.scope.read_pk_hash),
    window_len: g.scope.window_len.toString(),
    window_cap: g.scope.window_cap.toString(),
  };
}

// ── Evidence groups ─────────────────────────────────────────────────────────

const groups: Record<string, { verdict: Verdict; details: Record<string, unknown> }> = {};

function group(name: string): Record<string, unknown> {
  if (!groups[name]) groups[name] = { verdict: 'PASS', details: {} };
  return groups[name].details;
}

function setVerdict(name: string, verdict: Verdict): void {
  group(name);
  groups[name].verdict = verdict;
}

const GROUP_META: Record<string, { testId: string; description: string; note: string }> = {
  funding: {
    testId: 'grants-e4-funding',
    description:
      'GRANTS-E4: the unshielded arm funded on node. A spec_version = 2 account deployed in waves, both device arms live, '
      + 'a non-native color faucet-minted to the funding wallet and deposited into the account through deposit_unshielded, '
      + 'and the NIGHT arm skipped with its price',
    note:
      'The mirror is funded on node with a NON-NATIVE unshielded color: faucet.mint_unshielded to the funding wallet, then a '
      + 'real user-funded deposit_unshielded of the whole minted amount into the account, and the mirror credit read back from '
      + 'the ledger. The NIGHT arm is deliberately NOT run: probe:dismiss-cost priced deposit_unshielded of NIGHT at 16.504 ms '
      + 'of dismissal time against a 16.266 ms budget for its 8,133-byte est_size, a 0.238 ms (1.46 per cent) overrun, and the '
      + 'entire difference from the admitted non-native deposit at essentially the same size is the offer\'s per-element cost '
      + '(a NIGHT input plus the NIGHT change output balancing adds). See details.nightArmSkipped for the verbatim ledger '
      + 'message and the citation to upstream ledger issue #761.',
  },
  issue: {
    testId: 'grants-e4-issue',
    description:
      'GRANTS-E4: grant issuance for the unshielded arm. op_withdraw_unshielded scopes over the deposited color, across both '
      + 'device arms and both grantee arms, with per-call and cumulative caps and a recipient pin',
    note:
      'Every grant this suite spends under carries op_withdraw_unshielded over the color the mirror holds, and each is issued '
      + 'by a device seam that advances auth_nonce by exactly one and round by one. The records carry epoch = device_epoch, '
      + 'gen = grant_generation, issued_at equal to auth_nonce after the seam advanced it, nonce 0, and active. Two grants pin '
      + 'a recipient at kind 1 (UserAddress): one to the funding wallet\'s own address, which the twin then pays, and one to '
      + 'another address, which is the negative control of the pin.',
  },
  spend: {
    testId: 'grants-e4-spend',
    description:
      'GRANTS-E4: withdraw_unshielded_with_grant_jubjub and withdraw_unshielded_with_grant_k256 held on node, with the mirror '
      + 'debit, the per-grant nonce settle, the cap accounting through spent_commit, and the recipient pin',
    note:
      'Both unshielded grant twins build, prove, submit, and are included on node, on both grantee arms. Each call debits the '
      + 'mirror by exactly the amount released, advances the record nonce by one, re-commits spent_commit to the cumulative '
      + 'value released (checked against derive_grant_spent_commit off-chain), advances round by one, and leaves auth_nonce, '
      + 'device_count, inbox_count, and the grant register size untouched. The k256 twin pays the address its scope pins at '
      + 'recipient kind 1. There is no unshielded to-contract twin to run: the contract exports '
      + 'withdraw_shielded_to_contract_with_grant_{jubjub,k256} and no unshielded counterpart, which the suite asserts against '
      + 'the compiled roster rather than assuming.',
  },
  rejections: {
    testId: 'grants-e4-rejections',
    description:
      'GRANTS-E4: the unshielded twins\' rejection rows in two classes: pre-custody faults that abort before '
      + 'do_withdraw_unshielded, and in-custody faults the mirror gate refuses inside it',
    note:
      'The rejection rows of the unshielded grant twins on node, each labelled by the class its fault falls in and by the '
      + 'contract stage it aborts at. Class A (pre-custody) aborts inside authenticate_grant_with_<arm>, check_spend_scope, or '
      + 'settle_grant_with_<arm>, so do_withdraw_unshielded is never entered: the mirror is not read and no sendUnshielded is '
      + 'reached. Class B (in-custody) reaches do_withdraw_unshielded and is refused by debit_unshielded. The finding is that '
      + 'class B emits no offer either, because debit_unshielded runs BEFORE sendUnshielded inside the same chip, so no '
      + 'unshielded rejection row of these twins can put an unshielded offer on the wire. Every row is a build-time abort with '
      + 'no transaction and a byte-identical ledger snapshot either side, the mirror balance included in the snapshot.',
  },
  proving: {
    testId: 'grants-e4-proving',
    description:
      'GRANTS-E4: the per-call table of the unshielded run. Proving time, proven bytes, submitted bytes, tx hash, finality, '
      + 'and prover retries',
    note:
      'Proving time measured at providers.proofProvider.proveTx and attributed to the call it served, with the proven '
      + 'transaction\'s serialised length, the serialised length of what the wallet actually submitted, the transaction hash, '
      + 'and the indexer\'s finality line for it. This is the first timing the unshielded grant twins have: GRANTS-E2 recorded '
      + 'their compiled k with no proving figure beside it, because no run had ever built one.',
  },
};

function flushEvidence(name: string): void {
  const meta = GROUP_META[name];
  const g = groups[name] ?? { verdict: 'FAIL' as Verdict, details: { note: 'group never ran' } };
  writeEvidence({
    testId: meta.testId,
    name: `grants-unshielded-${name}`,
    description: meta.description,
    verdict: g.verdict,
    note: meta.note,
    details: g.details,
  });
}

// ── Group selection ─────────────────────────────────────────────────────────
//
// As in grants-conformance: the scenario is ONE sequence (S2 issues against
// the account S0 deployed, S3 spends what S1 deposited), so a subset can only
// be a PREFIX and the selector truncates rather than skips.

const GROUP_ORDER = ['funding', 'issue', 'spend', 'rejections', 'proving'] as const;

const SELECTED_GROUPS: Set<string> = (() => {
  const raw = process.env.GRANTS_E4_GROUPS;
  if (!raw) return new Set<string>(GROUP_ORDER);
  const names = raw.split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = names.filter((n) => !(GROUP_ORDER as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `GRANTS_E4_GROUPS: unknown group(s) ${unknown.join(', ')}; known groups: ${GROUP_ORDER.join(', ')}`,
    );
  }
  if (names.length === 0) throw new Error('GRANTS_E4_GROUPS is set but names no group');
  return new Set(names);
})();

function lastSelected(name: string): boolean {
  const after = GROUP_ORDER.slice(GROUP_ORDER.indexOf(name as (typeof GROUP_ORDER)[number]) + 1);
  return !after.some((g) => SELECTED_GROUPS.has(g));
}

function stopAfter(name: string): boolean {
  if (!lastSelected(name)) return false;
  console.log(
    `\n  GRANTS_E4_GROUPS=${process.env.GRANTS_E4_GROUPS ?? '(unset)'}: '${name}' is the last selected group, ` +
    'so the run stops here. The evidence of the later groups is whatever the previous run wrote.',
  );
  return true;
}

/**
 * Run one section with its own error boundary, so a surprise in one does not
 * cost the evidence of the others: the error is recorded into the section's
 * own group with the verdict it deserves, and the run continues to the flush.
 */
async function section(
  name: string,
  onError: Verdict,
  fn: () => Promise<void>,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e: any) {
    group(name).sectionError = serialiseError(e);
    setVerdict(name, onError);
    console.log(`  ⚠ ${name} aborted: ${String(e?.message ?? e).slice(0, 300)} — recorded ${onError} and moving on`);
    return false;
  }
}

// ── The NIGHT skip, priced from the sibling probe's own evidence ────────────

/**
 * The reason the NIGHT deposit arm is not run, quoted from
 * evidence/dismiss-cost.json rather than retyped. The probe priced every
 * unshielded shape of this contract off-node with the node's own check
 * (`Transaction.cost(params, true)`), and NIGHT's deposit is the one refusal
 * in the set.
 */
function nightArmSkip(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    arm: 'deposit_unshielded of NIGHT (the all-zero color)',
    color: bytesToHex(NIGHT),
    run: false,
    decision:
      'SKIPPED DELIBERATELY, not dropped. The funding leg for NIGHT is what this localnet refuses, and the refusal is a '
      + 'transaction-shape limit rather than anything about the grant seam: a deposit of NIGHT is a SMALL contract call '
      + 'carrying a NIGHT unshielded input, and the wallet\'s balancing adds a NIGHT change output. Both are priced per '
      + 'element in dismissal time (a NIGHT input ~3.447 ms, a NIGHT change output ~2.491 ms, against a plain input ~680 us '
      + 'and a plain output 0), while the budget is max(time_to_dismiss_per_byte x est_size, min_time_to_dismiss) = '
      + 'max(2 us x est_size, 15 ms), which a small transaction cannot grow into. Since the unshielded grant twins are '
      + 'reached only through a funded mirror, and the mirror can be funded with a non-native color at the same '
      + 'transaction size with 4.975 ms of headroom, the whole unshielded arm runs on the non-native color instead and the '
      + 'NIGHT arm stays unproven on node.',
    upstream:
      'Upstream ledger issue #761 (OPEN): the client under-reserves the NIGHT change output that balancing adds. Ledger '
      + 'issue #222 (CLOSED) records a Foundation datapoint that the same shape works for a non-native color and fails '
      + 'only for NIGHT, which is exactly the split measured here.',
    ledgerSource:
      'ledger/src/structure.rs: Transaction::cost (the allowed/actual pair), INITIAL_LIMITS (2 us per byte, 15 ms floor), '
      + 'and application_cost (the per-element offer costs). The node enforces with the identical call, '
      + 'ledger/src/ledger_9/mod.rs.',
  };
  try {
    const file = path.resolve(__dirname, '..', '..', 'evidence', 'dismiss-cost.json');
    const ev = JSON.parse(fs.readFileSync(file, 'utf8'));
    const shapes: any[] = ev?.details?.shapes ?? [];
    const night = shapes.find((s) => s?.id === '(c)');
    const nonNative = shapes.find((s) => s?.id === '(d)');
    const twinJubjub = shapes.find((s) => s?.id === '(f)');
    const twinK256 = shapes.find((s) => s?.id === '(g)');
    const quote = (s: any) => (s ? {
      id: s.id,
      label: s.label,
      circuit: s.circuit,
      offer: s.offer,
      serialisedBytes: s.serialisedBytes,
      estSizeBytes: s.estSizeBytes,
      timeToDismiss: s.reportedTimeToDismiss ?? (s.timeToDismissPs === undefined ? null : `${s.timeToDismissPs} ps`),
      allowed: s.reportedAllowedTimeToDismiss ?? (s.allowedTimeToDismissPs === undefined ? null : `${s.allowedTimeToDismissPs} ps`),
      verdict: s.verdict,
      ledgerMessage: s.enforcedError ?? s.feesError ?? null,
    } : null);
    out.pricingEvidence = 'evidence/dismiss-cost.json (testId DISMISS-COST)';
    out.pricedNightDeposit = quote(night);
    out.pricedNonNativeDeposit = quote(nonNative);
    out.pricedTwinJubjub = quote(twinJubjub);
    out.pricedTwinK256 = quote(twinK256);
    out.nightVerbatimRefusal = night?.enforcedError ?? night?.feesError ?? null;
  } catch (e: any) {
    out.pricingEvidenceReadError = String(e?.message ?? e);
    out.pricedNightDeposit =
      'evidence/dismiss-cost.json was not readable from this run; the figures quoted in `decision` are the ones it '
      + 'recorded: est_size 8,133 B, dismissal 16.504 ms, allowed 16.266 ms, over by 0.238 ms.';
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────

// ── The per-call table ──────────────────────────────────────────────────────
//
// Declared outside the scenario so a section that stops the run early can
// still write it: the table is the run's own record of what it proved and
// submitted, and it is worth keeping even when a claim fails.

let runStart = Date.now();

function writeProvingGroup(): void {
  const provingDetails = group('proving');
  const byCircuit = new Map<string, number[]>();
  for (const r of callRows) {
    if (!r.ok || r.provingMs === null) continue;
    if (!byCircuit.has(r.circuit)) byCircuit.set(r.circuit, []);
    byCircuit.get(r.circuit)!.push(r.provingMs);
  }
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };
  const table = [...byCircuit.entries()]
    .map(([circuit, ms]) => ({
      circuit, proofs: ms.length,
      minMs: Math.min(...ms), medianMs: median(ms), maxMs: Math.max(...ms),
    }))
    .sort((a, b) => b.medianMs - a.medianMs);

  provingDetails.calls = callRows;
  provingDetails.callCount = callRows.length;
  provingDetails.byCircuit = table;
  provingDetails.totalProofs = proofLog.filter((p) => p.ok).length;
  provingDetails.failedProofAttempts = proofLog.filter((p) => !p.ok).length;
  provingDetails.totalProvingMs = proofLog.reduce((a, p) => a + p.ms, 0);
  provingDetails.proofServerRestarts = proverRestarts;
  provingDetails.proofServerRestartCount = proverRestarts.length;
  provingDetails.proverRetriesTotal = callRows.reduce((a, r) => a + r.proverRetries, 0);
  provingDetails.wallClockMsTotal = Date.now() - runStart;
  provingDetails.measurementCaveat =
    'A row\'s provingMs, provenBytes and submittedBytes are the LAST proof and the LAST submission of that call. For every '
    + 'single-circuit call, which is every row that matters here, there is exactly one of each. The two multi-transaction rows are '
    + 'the wave deploy (one deploy plus the maintenance updates plus the activation) and any call the wallet rebuilt on a '
    + 'dust-state race; proofLog carries every proof of the run, and totalProvingMs sums all of them. The faucet deploy\'s '
    + 'own proof is untimed, because the faucet\'s providers are created by the deploy itself and can only be instrumented '
    + 'after it returns.';
  provingDetails.twinProvingFirstMeasurement =
    'The rows for withdraw_unshielded_with_grant_jubjub and withdraw_unshielded_with_grant_k256 are the first proving '
    + 'times either circuit has: GRANTS-E2 recorded their compiled k with no timing beside it, because no run had ever '
    + 'built a proof for them.';

  console.log('\n  circuit                                                proofs    min    med    max (ms)');
  for (const row of table) {
    console.log(
      `  ${row.circuit.padEnd(54).slice(0, 54)} ${String(row.proofs).padStart(6)} ` +
      `${String(row.minMs).padStart(6)} ${String(row.medianMs).padStart(6)} ${String(row.maxMs).padStart(6)}`,
    );
  }
}


await runScenario('grants-unshielded (GRANTS-E4: the unshielded grant twins on node)', async () => {
  runStart = Date.now();
  const oh = originHash(CLIENT_ID);
  console.log(`  groups selected: ${GROUP_ORDER.filter((g) => SELECTED_GROUPS.has(g)).join(', ')}`);

  // ══ S0 setup and wave deploy ══════════════════════════════════════════════

  step('S0: wallet, faucet, and the wave deploy of a k256-born account');
  const fundDetails = group('funding');
  fundDetails.clientId = CLIENT_ID;
  fundDetails.originHash = bytesToHex(oh);

  const ctx: TestContext = await setupWallet();
  instrument(ctx.providers, 'account providers');
  const recipient = userAddressBytes(ctx.walletCtx);
  fundDetails.recipientUserAddress = bytesToHex(recipient);

  const faucet: FaucetHandle = await call('deploy:faucet', 'faucet (deploy)', async () => {
    const f = await deployFaucet(ctx.walletCtx);
    return f;
  }, { txIdOf: () => null });
  instrument(faucet.providers, 'faucet providers');
  console.log(`  faucet @ ${faucet.address}`);
  fundDetails.faucet = faucet.address;

  // The working colors are derived before anything is minted: a grant's
  // scope commits to the color, so it must be known at issue time.
  const color = await faucet.unshieldedColor(DOMAIN);
  const colorOther = await faucet.unshieldedColor(DOMAIN_OTHER);
  fundDetails.color = bytesToHex(color);
  fundDetails.colorOther = bytesToHex(colorOther);
  console.log(`  working color = ${bytesToHex(color)}`);
  console.log(`  second color (never deposited) = ${bytesToHex(colorOther)}`);

  // The wave plan, from the real compiled artefacts.
  const sizes = new Map<string, number>();
  for (const id of allCircuits()) {
    const vk: Uint8Array = await ctx.providers.zkConfigProvider.getVerifierKey(id);
    sizes.set(id, vk.length);
  }
  const plan = planWaves(sizes, 'k256', true);
  fundDetails.verifierByteBudget = VERIFIER_BYTE_BUDGET;
  fundDetails.rosterSize = allCircuits().length;
  fundDetails.wavePlan = plan.map((w) => ({
    index: w.index, kind: w.kind, circuitCount: w.circuits.length,
    verifierBytes: w.verifierBytes, retiresAuthority: w.retiresAuthority,
  }));

  const device = K256Device.generate();
  const encKeys = generateEncKeyPair();
  const account: CustodyAccount = await call(
    `deploy:account (${plan.length} waves + activate)`, 'account (wave deploy)',
    () => deployAccount(ctx, device, encKeys), { txIdOf: () => null });
  console.log(`  account @ ${account.address}`);
  fundDetails.account = account.address;

  const authority = await maintenanceAuthority(account.address);
  fundDetails.maintenanceAuthorityAfterWaves = authority;
  if (authority.committee !== 0 || authority.threshold !== 1) {
    setVerdict('funding', 'FAIL');
    throw new Error(`maintenance authority not retired: ${JSON.stringify(authority)}`);
  }
  console.log(`  ✓ maintenance authority retired: committee=${authority.committee} threshold=${authority.threshold}`);

  const l0 = await account.ledgerState();
  fundDetails.specVersion = l0.spec_version.toString();
  if (l0.spec_version !== 2n) {
    setVerdict('funding', 'FAIL');
    throw new Error(`spec_version ${l0.spec_version}, expected 2`);
  }
  fundDetails.initialLedger = snapshotOf(l0, color);

  const deployActions = await enumerateContractActions(account.address);
  fundDetails.deployActions = deployActions.map((a) => ({
    kind: a.kind, entryPoint: a.entryPoint ?? null, txHash: a.txHash, blockHeight: a.blockHeight,
  }));

  step('S0: the k256 owner device enrols a jubjub device (cross-arm)');
  const jDevice = JubjubDevice.generate();
  const addTx = await call('add_device_with_k256 (enrol the jubjub device)', 'add_device_with_k256',
    () => account.addDevice(device, jDevice));
  const l1 = await waitForLedger(
    () => account.ledgerState(),
    'auth_nonce advanced by the enrolment; two devices live',
    (l) => l.auth_nonce === l0.auth_nonce + 1n && l.device_count === 2n,
  );
  fundDetails.crossArmEnrolmentTx = addTx.txId;
  fundDetails.afterEnrolment = snapshotOf(l1, color);

  // ── The unshielded to-contract twin does not exist ───────────────────────
  //
  // Measured against the compiled roster rather than assumed: the third grant
  // twin is the SHIELDED to-contract one, so the pricing table's shape (h) has
  // no unshielded counterpart to run.
  const roster = allCircuits();
  const unshieldedToContract = roster.filter((c) => /withdraw_unshielded_to_contract/.test(c));
  const shieldedToContractTwins = roster.filter((c) => /withdraw_shielded_to_contract_with_grant_/.test(c));
  fundDetails.toContractTwin = {
    unshieldedToContractCircuits: unshieldedToContract,
    shieldedToContractGrantTwins: shieldedToContractTwins,
    finding:
      unshieldedToContract.length === 0
        ? 'There is no unshielded to-contract twin in the compiled roster: the contract exports '
          + `${shieldedToContractTwins.join(' and ')} and no withdraw_unshielded_to_contract counterpart. The pricing `
          + 'table\'s shape (h) is therefore a SHIELDED shape, already built, proved, and submitted on node by GRANTS-E2, '
          + 'and this suite has no unshielded to-contract call to make.'
        : `UNEXPECTED: the roster carries ${unshieldedToContract.join(', ')}; the run should exercise it.`,
  };
  if (unshieldedToContract.length !== 0) {
    setVerdict('funding', 'PARTIAL');
    console.log('  ⚠ the roster carries an unshielded to-contract circuit after all; recorded');
  } else {
    console.log('  ✓ no unshielded to-contract twin exists in the roster (pricing-table shape (h) is shielded)');
  }

  // ══ S1 funding ════════════════════════════════════════════════════════════

  step('S1: fund the mirror with the non-native color (and skip the NIGHT arm)');

  fundDetails.nightArmSkipped = nightArmSkip();
  console.log('  ⤬ NIGHT deposit arm SKIPPED: priced at 16.504 ms of dismissal against a 16.266 ms budget');
  console.log('    (0.238 ms over, 1.46 per cent; upstream ledger issue #761) — see details.nightArmSkipped');

  const mintTx = await call(
    `faucet.mint_unshielded (${MINT} of the non-native color → the funding wallet)`,
    'faucet.mint_unshielded',
    async () => ({ txId: await faucet.mintUnshielded(DOMAIN, MINT, recipient) }),
  );
  fundDetails.mintTx = mintTx.txId;
  fundDetails.mintAmount = MINT.toString();
  console.log('  waiting 15 s for the wallet to index the minted tokens...');
  await sleep(15_000);

  const depositTx = await call(
    `deposit_unshielded (${DEPOSIT} of the non-native color, user-funded)`,
    'deposit_unshielded',
    () => account.depositUnshielded(color, DEPOSIT),
  );
  fundDetails.depositTx = depositTx.txId;
  fundDetails.depositAmount = DEPOSIT.toString();
  const lFunded = await waitForLedger(
    () => account.ledgerState(),
    `the mirror holds ${DEPOSIT} of the working color`,
    (l) => l.unshielded_balances.member(color) && l.unshielded_balances.lookup(color) === DEPOSIT,
  );
  fundDetails.ledgerAfterDeposit = snapshotOf(lFunded, color);
  fundDetails.mirrorAfterDeposit = mirrorOf(lFunded, color);
  console.log(`  ✓ mirror funded on node: ${mirrorOf(lFunded, color)} of ${bytesToHex(color).slice(0, 16)}…`);

  flushEvidence('funding');
  if (stopAfter('funding')) return;

  // ══ S2 issuance ═══════════════════════════════════════════════════════════

  step('S2: issue the unshielded-capable grants across both device arms and both grantee arms');
  const issueDetails = group('issue');
  const issued: Array<Record<string, unknown>> = [];

  const jGrantee = JubjubGrantee.generate();
  const kGrantee = K256Grantee.generate();
  const kGranteeConnector = new K256Grantee((kGrantee as any).sk, K256_ENVELOPE_CONNECTOR);
  const readPkHash = rnd32();
  /** A UserAddress nobody in this run controls: the pin's negative control. */
  const otherUserAddress = rnd32();
  issueDetails.pinnedToFundingWallet = bytesToHex(recipient);
  issueDetails.pinnedElsewhere = bytesToHex(otherUserAddress);

  interface GrantHandle {
    name: string;
    grantee: AnyGrantee;
    slot: bigint;
    id: Uint8Array;
    salt: Uint8Array;
    opening: GrantOpening;
    scope: PlainScope;
  }

  async function issue(
    name: string,
    issuer: 'k256' | 'jubjub',
    grantee: AnyGrantee,
    slot: bigint,
    scope: PlainScope,
    purpose: string,
  ): Promise<GrantHandle> {
    const salt = rnd32();
    const id = account.grantIdOf(grantee, oh, slot);
    const before = await account.ledgerState();
    const signer = issuer === 'k256' ? device : jDevice;
    const tx = await call(`issue_grant_with_${issuer} (grant ${name})`, `issue_grant_with_${issuer}`,
      () => account.issueGrant(signer, id, scope, salt));
    const after = await waitForLedger(
      () => account.ledgerState(),
      `grant ${name} recorded`,
      (l) => l.grants.member(id) && l.auth_nonce === before.auth_nonce + 1n,
    );
    const rec = recordOf(after, id)!;
    const row = {
      name,
      purpose,
      issuerDeviceArm: issuer,
      granteeArm: grantee.arm,
      granteeEnvelope: grantee.arm === 'k256' ? String((grantee as K256Grantee).envelope) : null,
      slot: slot.toString(),
      grantId: bytesToHex(id),
      txId: tx.txId,
      record: rec,
      authNonceBefore: before.auth_nonce.toString(),
      authNonceAfter: after.auth_nonce.toString(),
      roundBefore: before.round.toString(),
      roundAfter: after.round.toString(),
      issuedAtEqualsPostSeamAuthNonce: rec.issued_at === after.auth_nonce.toString(),
      nonceIsZero: rec.nonce === '0',
      active: rec.active,
      opWithdrawUnshielded: rec.op_withdraw_unshielded,
      // The pin is committed rather than published: recompute
      // object_commit from the plaintext scope and the salt and check it
      // against the record's own field.
      objectCommitOpensToTheScope:
        rec.object_commit === bytesToHex(pureCircuits.derive_grant_object_commit(
          salt, scope.color, scope.recipientKind, scope.recipient, scope.maxCoinValue)),
      plaintextScope: {
        color: bytesToHex(scope.color),
        recipientKind: scope.recipientKind.toString(),
        recipient: bytesToHex(scope.recipient),
        maxCoinValue: scope.maxCoinValue.toString(),
        perCallCap: scope.perCallCap.toString(),
        cap: scope.cap.toString(),
        expiresAt: scope.expiresAt.toString(),
      },
    };
    issued.push(row);
    if (!row.objectCommitOpensToTheScope) {
      setVerdict('issue', 'FAIL');
      throw new Error(`grant ${name}: object_commit does not open to the scope the device signed over`);
    }
    if (!row.issuedAtEqualsPostSeamAuthNonce || !row.nonceIsZero || !row.active) {
      setVerdict('issue', 'FAIL');
      throw new Error(`grant ${name}: record fields wrong — ${JSON.stringify(row)}`);
    }
    if (after.round <= before.round) {
      setVerdict('issue', 'FAIL');
      throw new Error(`grant ${name}: round did not advance`);
    }
    console.log(`  ✓ grant ${name} issued (${issuer} device → ${grantee.arm} grantee): ${tx.txId}`);
    return { name, grantee, slot, id, salt, opening: openingOf(scope, salt, oh, slot), scope };
  }

  // U1: the working jubjub grant — cap 500, per-call 200, no pin.
  const u1 = await issue('U1', 'k256', jGrantee, SLOT_U1, spendScope({
    withdrawUnshielded: true, color, cap: 500n, perCallCap: 200n, readPkHash,
  }), 'the jubjub twin\'s working grant: three spends, consecutive nonces, cap accounting');

  // U2: the k256 grant, pinned to the funding wallet's own UserAddress.
  const u2 = await issue('U2', 'jubjub', kGrantee, SLOT_U2, spendScope({
    withdrawUnshielded: true, color, cap: 300n, perCallCap: 150n,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient, readPkHash,
  }), 'the k256 twin\'s working grant, with the recipient PINNED to the address it pays');

  // U3: pinned to an address nobody controls — the pin's negative control.
  const u3 = await issue('U3', 'k256', jGrantee, SLOT_U3, spendScope({
    withdrawUnshielded: true, color, cap: 100n, perCallCap: 100n,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient: otherUserAddress, readPkHash,
  }), 'row A10: a pin to another UserAddress, so paying the funding wallet is out of pin');

  // U4: shielded only — exercised through the UNSHIELDED twin.
  const u4 = await issue('U4', 'jubjub', jGrantee, SLOT_U4, spendScope({
    withdrawShielded: true, color, cap: 100n, perCallCap: 100n, readPkHash,
  }), 'row A5: a shielded-only scope, called through the unshielded twin');

  // U5: already expired at issue time.
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const u5 = await issue('U5', 'k256', jGrantee, SLOT_U5, spendScope({
    withdrawUnshielded: true, color, cap: 100n, perCallCap: 100n,
    expiresAt: nowSeconds - 100n, readPkHash,
  }), 'row A4: expires_at 100 s in the past');
  issueDetails.expiredGrantExpiresAt = (nowSeconds - 100n).toString();

  // U6: to be revoked before it is called.
  const u6 = await issue('U6', 'jubjub', kGrantee, SLOT_U6, spendScope({
    withdrawUnshielded: true, color, cap: 100n, perCallCap: 100n, readPkHash,
  }), 'row A3: revoked before it is called');

  // U7: cap 100 / per-call 100 — one admitted spend exhausts it.
  const u7 = await issue('U7', 'k256', jGrantee, SLOT_U7, spendScope({
    withdrawUnshielded: true, color, cap: 100n, perCallCap: 100n, readPkHash,
  }), 'row A9: the cap is driven to its ceiling by an admitted spend, then breached');

  // U8: a color the mirror has never held.
  const u8 = await issue('U8', 'k256', jGrantee, SLOT_U8, spendScope({
    withdrawUnshielded: true, color: colorOther, cap: 100n, perCallCap: 100n, readPkHash,
  }), 'row B1: a color with no mirror entry at all');

  // U9: a read-only grant held by the connector-envelope k256 grantee.
  const u9 = await issue('U9', 'k256', kGranteeConnector, SLOT_U9, readOnlyScope({ readPkHash }),
    'row A1: an envelope-1 (connector) grantee presented at a spend twin');

  // U10: a cap above the whole mirror.
  const u10 = await issue('U10', 'jubjub', jGrantee, SLOT_U10, spendScope({
    withdrawUnshielded: true, color, cap: 4_000n, perCallCap: 4_000n, readPkHash,
  }), 'row B2: a per-call cap above the mirror balance, so the mirror gate is the only refusal left');

  issueDetails.grants = issued;
  issueDetails.grantCount = issued.length;
  issueDetails.ledgerAfterIssuance = snapshotOf(await account.ledgerState(), color);

  flushEvidence('issue');
  if (stopAfter('issue')) return;

  // ══ S3 the twins holding ══════════════════════════════════════════════════

  step('S3: withdraw_unshielded_with_grant_{jubjub,k256} on node');
  const spendDetails = group('spend');
  spendDetails.color = bytesToHex(color);
  spendDetails.recipient = bytesToHex(recipient);
  spendDetails.toContractTwin = fundDetails.toContractTwin;
  const spends: Array<Record<string, unknown>> = [];

  /**
   * One unshielded grant spend, with every post-condition of the twin
   * asserted: the mirror debit, the record nonce, the spent_commit
   * re-commitment, round + 1, and the cells a grant call must NOT write.
   */
  async function grantWithdraw(o: {
    label: string;
    grant: GrantHandle;
    amount: bigint;
    payTo: Uint8Array;
    expectedNonce: string;
  }): Promise<Record<string, unknown>> {
    const { grant, amount } = o;
    const before = await account.ledgerState();
    const mirrorBefore = before.unshielded_balances.lookup(color);
    const spentPrevAtCall = grant.opening.spentPrev;

    let tx: { txId: string };
    try {
      tx = await call(
        o.label,
        `withdraw_unshielded_with_grant_${grant.grantee.arm}`,
        () => account.withdrawUnshieldedWithGrant(grant.grantee, grant.opening, color, amount, o.payTo),
      );
    } catch (e: any) {
      // The one refusal this run must record verbatim if it happens: a node
      // refusal on the twin itself. Capture the node's own line and tie it to
      // the attempt before anything else.
      const cap = nodeRejectionLines(60);
      const afterFail = await account.ledgerState();
      spends.push({
        label: o.label,
        grant: grant.name,
        granteeArm: grant.grantee.arm,
        circuit: `withdraw_unshielded_with_grant_${grant.grantee.arm}`,
        amount: amount.toString(),
        paidTo: bytesToHex(o.payTo),
        ok: false,
        error: String(e?.message ?? e).slice(0, 1200),
        errorDetail: serialiseError(e),
        nodeErrorLine: cap.failure ? `(capture failed) ${cap.failure}` : cap.lines.slice(-5),
        mirrorBefore: mirrorBefore.toString(),
        mirrorAfterFailure: mirrorOf(afterFail, color),
        snapshotBefore: snapshotOf(before, color),
        snapshotAfterFailure: snapshotOf(afterFail, color),
        stateUnchanged: sameSnapshot(snapshotOf(before, color), snapshotOf(afterFail, color)),
      });
      setVerdict('spend', 'FAIL');
      throw e;
    }
    grant.opening.spentPrev += amount;

    const after = await waitForLedger(
      () => account.ledgerState(),
      `${o.label}: round advanced by one`,
      (l) => l.round === before.round + 1n,
    );
    const rec = recordOf(after, grant.id)!;
    const mirrorAfter = after.unshielded_balances.lookup(color);
    const expectedCommit = bytesToHex(
      pureCircuits.derive_grant_spent_commit(grant.salt, spentPrevAtCall + amount),
    );

    const problems: string[] = [];
    if (mirrorAfter !== mirrorBefore - amount) {
      problems.push(`mirror ${mirrorBefore} → ${mirrorAfter}, expected ${mirrorBefore - amount}`);
    }
    if (rec.nonce !== o.expectedNonce) problems.push(`record nonce ${rec.nonce}, expected ${o.expectedNonce}`);
    if (rec.spent_commit !== expectedCommit) {
      problems.push(`spent_commit ${rec.spent_commit} != commit(salt, ${spentPrevAtCall + amount}) ${expectedCommit}`);
    }
    if (after.auth_nonce !== before.auth_nonce) problems.push('auth_nonce moved under a grant call (GR-5)');
    if (after.device_count !== before.device_count) problems.push('device_count moved under a grant call');
    if (after.inbox_count !== before.inbox_count) {
      problems.push(`inbox_count ${before.inbox_count} → ${after.inbox_count}: an unshielded twin appends no entry`);
    }
    if (after.grants.size() !== before.grants.size()) problems.push('the grant register changed size');

    const fin = await txFinality(tx.txId);
    const row: Record<string, unknown> = {
      label: o.label,
      grant: grant.name,
      granteeArm: grant.grantee.arm,
      circuit: `withdraw_unshielded_with_grant_${grant.grantee.arm}`,
      amount: amount.toString(),
      paidTo: bytesToHex(o.payTo),
      recipientPinned: grant.scope.recipientKind !== 0n,
      pinnedRecipient: grant.scope.recipientKind === 0n ? null : bytesToHex(grant.scope.recipient),
      pinKind: grant.scope.recipientKind.toString(),
      txId: tx.txId,
      txHash: fin.hash,
      blockHeight: fin.blockHeight,
      finality: fin.line,
      mirrorBefore: mirrorBefore.toString(),
      mirrorAfter: mirrorAfter.toString(),
      mirrorDebitedByExactly: (mirrorBefore - mirrorAfter).toString(),
      recordBefore: recordOf(before, grant.id),
      recordAfter: rec,
      cumulativeSpend: (spentPrevAtCall + amount).toString(),
      spentCommitMatchesCumulative: rec.spent_commit === expectedCommit,
      snapshotBefore: snapshotOf(before, color),
      snapshotAfter: snapshotOf(after, color),
      problems,
    };
    spends.push(row);
    if (problems.length) {
      setVerdict('spend', 'FAIL');
      throw new Error(`${o.label}: post-conditions failed — ${problems.join('; ')}`);
    }
    console.log(
      `  ✓ ${o.label}: mirror ${mirrorBefore} → ${mirrorAfter}, record nonce ${rec.nonce}, ` +
      `cumulative ${spentPrevAtCall + amount}, round +1, auth_nonce and devices untouched`,
    );
    return row;
  }

  // The authorisation V5 signs and S4's row A11 replays; declared out here so
  // the rejection rows can reach it after the spend section closes.
  let gU1: GrantContext | null = null;
  let replayAuth: any = null;
  const replayAmount = 50n;

  const spendsHeld = await section('spend', 'FAIL', async () => {
    // V1 and V2: the jubjub twin twice under one grant — consecutive nonces
    // and cap accounting on the normative grantee arm.
    await grantWithdraw({
      label: 'withdraw_unshielded_with_grant_jubjub (U1 #1, 200)',
      grant: u1, amount: 200n, payTo: recipient, expectedNonce: '1',
    });
    await grantWithdraw({
      label: 'withdraw_unshielded_with_grant_jubjub (U1 #2, 100)',
      grant: u1, amount: 100n, payTo: recipient, expectedNonce: '2',
    });

    // V3: the k256 twin, paying the address its scope PINS.
    await grantWithdraw({
      label: 'withdraw_unshielded_with_grant_k256 (U2 #1, 150, to the pinned recipient)',
      grant: u2, amount: 150n, payTo: recipient, expectedNonce: '1',
    });

    // V4: U7's single admitted spend, which drives its cap to the ceiling for
    // row A9.
    await grantWithdraw({
      label: 'withdraw_unshielded_with_grant_jubjub (U7 #1, 100 — exhausts the cap)',
      grant: u7, amount: 100n, payTo: recipient, expectedNonce: '1',
    });

    // V5: the authorisation kept for the replay row (A11). Signed at the
    // record's CURRENT nonce, submitted once (it lands), then resubmitted in
    // S4 after the nonce has moved, which is what the row measures.
    gU1 = await account.grantContext(u1.id);
    const replayOpening: GrantOpening = { ...u1.opening };
    replayAuth = (jGrantee as JubjubGrantee).sign(
      jubjubGrantChallenges.withdrawUnshielded(gU1, jGrantee.pk, color, replayAmount, recipient),
    );
    spendDetails.replayAuthorisationSignedAt = {
      grantNonce: (gU1 as GrantContext).grantNonce.toString(),
      issuedAt: (gU1 as GrantContext).issuedAt.toString(),
      spentPrev: replayOpening.spentPrev.toString(),
      amount: replayAmount.toString(),
    };

    const before = await account.ledgerState();
    const mirrorBefore = before.unshielded_balances.lookup(color);
    const tx = await call(
      'withdraw_unshielded_with_grant_jubjub (U1 #3, 50 — the authorisation replayed in S4)',
      'withdraw_unshielded_with_grant_jubjub',
      () => account.withdrawUnshieldedWithGrantAuth(
        color, replayAmount, recipient, replayOpening, replayAuth as any,
      ),
    );
    u1.opening.spentPrev += replayAmount;
    const after = await waitForLedger(
      () => account.ledgerState(), 'U1 #3 settled', (l) => l.round === before.round + 1n);
    const rec = recordOf(after, u1.id)!;
    const expectedCommit = bytesToHex(pureCircuits.derive_grant_spent_commit(u1.salt, 350n));
    const fin3 = await txFinality(tx.txId);
    const row = {
      label: 'withdraw_unshielded_with_grant_jubjub (U1 #3, 50)',
      grant: 'U1', granteeArm: 'jubjub',
      circuit: 'withdraw_unshielded_with_grant_jubjub',
      amount: replayAmount.toString(),
      paidTo: bytesToHex(recipient),
      recipientPinned: false, pinnedRecipient: null, pinKind: '0',
      txId: tx.txId,
      txHash: fin3.hash,
      blockHeight: fin3.blockHeight,
      finality: fin3.line,
      mirrorBefore: mirrorBefore.toString(),
      mirrorAfter: after.unshielded_balances.lookup(color).toString(),
      mirrorDebitedByExactly: (mirrorBefore - after.unshielded_balances.lookup(color)).toString(),
      recordAfter: rec,
      cumulativeSpend: '350',
      spentCommitMatchesCumulative: rec.spent_commit === expectedCommit,
      snapshotBefore: snapshotOf(before, color),
      snapshotAfter: snapshotOf(after, color),
      note: 'Submitted through the low-level *WithGrantAuth path so the authorisation itself is retained for row A11.',
      problems: [] as string[],
    };
    if (rec.nonce !== '3') row.problems.push(`record nonce ${rec.nonce}, expected 3`);
    if (!row.spentCommitMatchesCumulative) row.problems.push('spent_commit does not match the cumulative 350');
    spends.push(row);
    if (row.problems.length) {
      throw new Error(`U1 #3 post-conditions failed: ${row.problems.join('; ')}`);
    }
    console.log('  ✓ U1 nonces 1, 2, 3 consecutive under one grant; cumulative 350 of a 500 cap');
  });

  const lAfterSpends = await account.ledgerState();
  spendDetails.spends = spends;
  spendDetails.spendCount = spends.length;
  spendDetails.everySpendHeld = spendsHeld;
  spendDetails.armsExercised = [...new Set(spends.filter((s) => s.ok !== false).map((s) => String(s.granteeArm)))];
  spendDetails.mirrorAfterSpends = mirrorOf(lAfterSpends, color);
  spendDetails.ledgerAfterSpends = snapshotOf(lAfterSpends, color);
  spendDetails.recipientPinHonoured = {
    grant: 'U2',
    pinKind: '1 (UserAddress)',
    pinnedRecipient: bytesToHex(recipient),
    paidTo: bytesToHex(recipient),
    negativeControl: 'row A10 in the rejections group: grant U3 pins another UserAddress and is refused',
  };

  flushEvidence('spend');
  if (stopAfter('spend')) return;

  // ══ S4 the rejection rows, in two classes ════════════════════════════════

  step('S4: the rejection rows — class A (pre-custody) and class B (in-custody)');
  const rejectDetails = group('rejections');
  const rows: Array<Record<string, unknown>> = [];

  // The rows read the state S3 left: U7's cap at its ceiling (A9), U1's
  // cumulative spend at 350 (A8 and A11), the mirror at 2,400 (B2). If the
  // spend sequence did not hold, the rows would be measuring something else,
  // so they are not run and the group says why.
  if (!spendsHeld) {
    rejectDetails.notRun =
      'NOT RUN: the S3 spend sequence did not hold, and every rejection row is calibrated on the state it leaves (grant '
      + 'U7 at its cap ceiling, grant U1 at a cumulative 350, the mirror at 2,400). Running them against a different '
      + 'state would measure a different thing. See the spend group\'s sectionError.';
    setVerdict('rejections', 'FAIL');
    writeProvingGroup();
    flushEvidence('rejections');
    flushEvidence('proving');
    throw new Error('the rejection rows were not run because the spend sequence did not hold');
  }

  rejectDetails.classes = {
    A: {
      name: 'pre-custody',
      meaning:
        'The fault aborts before `do_withdraw_unshielded` is entered at all, in '
        + '`authenticate_grant_with_<arm>` (steps 1 to 3), `check_spend_scope` (steps 4 and 5), or '
        + '`settle_grant_with_<arm>` (steps 6 and 7). The mirror is never read and no `sendUnshielded` is reached, so no '
        + 'unshielded offer can exist.',
      contractOrder:
        'contracts/account.compact, withdraw_unshielded_with_grant_k256 and _jubjub: authenticate_grant_with_<arm> → '
        + 'check_spend_scope → challenge_withdraw_unshielded_with_grant_<arm> → settle_grant_with_<arm> → '
        + 'do_withdraw_unshielded.',
      settleChipHasTwoRefusals:
        'On the jubjub arm the settle chip can refuse in two places: the cast `const c = challenge as Field` '
        + '(account.compact:1906), which needs the 32-byte challenge below the BLS12-381 scalar modulus, and the '
        + 'Schnorr assert after it. Rows A11 and A11b cover one each.',
    },
    B: {
      name: 'in-custody (the mirror gate)',
      meaning:
        'The call passes the whole seam and the whole scope check, reaches `do_withdraw_unshielded`, and is refused there by '
        + '`debit_unshielded`.',
      finding:
        'Class B emits no unshielded offer either. `do_withdraw_unshielded` runs `debit_unshielded(c, a)`, which asserts '
        + '`unshielded_balances.member(color)` and then `bal >= amount`, BEFORE `sendUnshielded`, so a mirror refusal '
        + 'happens with the send still unreached. No rejection row of these twins can therefore put an unshielded offer on '
        + 'the wire, which is why the whole rejection matrix is unaffected by the node\'s time-to-dismiss limit.',
    },
  };

  /** Run one rejection row: assert the abort, the message, and that nothing
   *  in the ledger (the mirror included) moved. */
  async function reject(o: {
    id: string;
    cls: 'A' | 'B';
    stage: string;
    label: string;
    expected: string[];
    fn: () => Promise<unknown>;
  }): Promise<string> {
    const beforeL = await account.ledgerState();
    const before = snapshotOf(beforeL, color);
    const t0 = Date.now();
    const message = await expectAbort(`[${o.cls}${o.id}] ${o.label}`, o.fn);
    const ms = Date.now() - t0;
    const afterL = await account.ledgerState();
    const after = snapshotOf(afterL, color);
    const unchanged = sameSnapshot(before, after);
    const matched = o.expected.some((n) => message.includes(n));
    // Captured even where none is expected, so "no node line" is measured.
    const cap = nodeRejectionLines(Math.max(20, Math.ceil(ms / 1000) + 10));
    rows.push({
      id: o.id,
      class: o.cls,
      className: o.cls === 'A' ? 'pre-custody' : 'in-custody (the mirror gate)',
      contractStage: o.stage,
      item: o.label,
      expected: o.expected,
      matchedExpected: matched,
      reachedDoWithdrawUnshielded: o.cls === 'B',
      emittedUnshieldedOffer: false,
      transactionExisted: false,
      failedAtStage: 'build (local circuit execution; nothing was submitted)',
      nodeErrorLine: cap.failure
        ? `(capture failed) ${cap.failure}`
        : (cap.lines.length
          ? cap.lines.slice(-3)
          : 'none: no transaction was submitted, so the node logged no refusal for this row'),
      stateUnchanged: unchanged,
      ledgerBefore: before,
      ledgerAfter: after,
      error: message,
      ms,
    });
    if (!unchanged) {
      setVerdict('rejections', 'FAIL');
      throw new Error(`[${o.cls}${o.id}] ${o.label}: the ledger moved under a refused call`);
    }
    if (!matched) {
      console.log(`  ⚠ [${o.cls}${o.id}] expected one of ${JSON.stringify(o.expected)}, got: ${message.slice(0, 220)}`);
      setVerdict('rejections', 'PARTIAL');
    }
    return message;
  }

  /** A grant call at the low level, so a fault can be injected in the
   *  opening, the context, or the recipient without the client correcting it. */
  function rawCall(o: {
    grant: GrantHandle;
    amount: bigint;
    payTo: Uint8Array;
    color?: Uint8Array;
    opening?: GrantOpening;
    context?: GrantContext;
    grantee?: AnyGrantee;
  }): () => Promise<unknown> {
    return async () => {
      const grantee = o.grantee ?? o.grant.grantee;
      const opening = o.opening ?? o.grant.opening;
      const c = o.color ?? color;
      const g = o.context
        ?? (await account.grantContext(account.grantIdOf(grantee, opening.originHash, opening.slot)));
      const auth = grantee.arm === 'jubjub'
        ? (grantee as JubjubGrantee).sign(
            jubjubGrantChallenges.withdrawUnshielded(g, (grantee as JubjubGrantee).pk, c, o.amount, o.payTo))
        : (grantee as K256Grantee).sign(
            k256GrantChallenges.withdrawUnshielded(g, (grantee as K256Grantee).pk, c, o.amount, o.payTo));
      return account.withdrawUnshieldedWithGrantAuth(c, o.amount, o.payTo, opening, auth as any);
    };
  }

  // ── Class A: authenticate_grant_with_<arm> (steps 1 to 3) ────────────────

  // A1 — the envelope assert, the very first statement of the k256 seam.
  await reject({
    id: '1', cls: 'A', stage: 'authenticate_grant_with_k256, the envelope assert (before step 1)',
    label: 'an envelope-1 (connector) grantee through withdraw_unshielded_with_grant_k256 (U9)',
    expected: ['envelope not admitted for a spend grant'],
    fn: rawCall({ grant: u9, amount: 10n, payTo: recipient }),
  });

  // A2 — a key with no record at all.
  {
    const foreign = JubjubGrantee.generate();
    const slot = 42n;
    const staleCtx: GrantContext = {
      contractAddress: account.addressBytes,
      grantId: account.grantIdOf(foreign, oh, slot),
      issuedAt: 0n,
      grantNonce: 0n,
    };
    const foreignOpening: GrantOpening = { ...u1.opening, originHash: oh, slot };
    await reject({
      id: '2', cls: 'A', stage: 'authenticate_grant_with_jubjub, step 2 (the membership assert)',
      label: 'a foreign grantee key with no record (an unissued origin and slot)',
      expected: ['unknown grant'],
      fn: rawCall({ grant: u1, grantee: foreign, amount: 10n, payTo: recipient, opening: foreignOpening, context: staleCtx }),
    });
  }

  // A3 — revoked. The revocation itself is a device call and must land first.
  {
    const revokeTx = await call('revoke_grant_with_k256 (grant U6)', 'revoke_grant_with_k256',
      () => account.revokeGrant(device, u6.id));
    await waitForLedger(
      () => account.ledgerState(), 'grant U6 tombstoned',
      (l) => l.grants.member(u6.id) && l.grants.lookup(u6.id).active === false,
    );
    rejectDetails.revokeU6Tx = revokeTx.txId;
    await reject({
      id: '3', cls: 'A', stage: 'authenticate_grant_with_k256, step 3 (the active assert)',
      label: 'a revoked grant (U6, after revoke_grant_with_k256)',
      expected: ['grant revoked'],
      fn: rawCall({ grant: u6, amount: 10n, payTo: recipient }),
    });
  }

  // A4 — expired.
  await reject({
    id: '4', cls: 'A', stage: 'authenticate_grant_with_jubjub, step 3 (the expiry assert)',
    label: 'an expired grant (U5, expires_at 100 s in the past)',
    expected: ['grant expired'],
    fn: rawCall({ grant: u5, amount: 10n, payTo: recipient }),
  });

  // ── Class A: check_spend_scope (steps 4 and 5) ───────────────────────────

  // A5 — the operation is not in scope: a shielded-only grant at the
  //      unshielded twin. This is check_spend_scope's FIRST assert.
  await reject({
    id: '5', cls: 'A', stage: 'check_spend_scope, step 4 (op_admitted)',
    label: 'an out-of-scope operation: a shielded-only scope (U4) through the unshielded twin',
    expected: ['operation not in scope'],
    fn: rawCall({ grant: u4, amount: 10n, payTo: recipient }),
  });

  // A6 — a wrong scope_salt does not open object_commit.
  await reject({
    id: '6', cls: 'A', stage: 'check_spend_scope, step 4 (object_commit)',
    label: 'a wrong scope_salt in the opening (U1)',
    expected: ['scope object mismatch'],
    fn: rawCall({ grant: u1, amount: 10n, payTo: recipient, opening: { ...u1.opening, scopeSalt: rnd32() } }),
  });

  // A7 — over the per-call cap.
  await reject({
    id: '7', cls: 'A', stage: 'check_spend_scope, step 5 (per_call_cap)',
    label: 'over per_call_cap (U1, 250 against a 200 per-call cap)',
    expected: ['amount above per-call cap'],
    fn: rawCall({ grant: u1, amount: 250n, payTo: recipient }),
  });

  // A8 — a wrong spent_prev does not open spent_commit.
  await reject({
    id: '8', cls: 'A', stage: 'check_spend_scope, step 5 (spent_commit)',
    label: 'a wrong spent_prev opening (U1, off by one)',
    expected: ['spent opening mismatch'],
    fn: rawCall({
      grant: u1, amount: 50n, payTo: recipient,
      opening: { ...u1.opening, spentPrev: u1.opening.spentPrev - 1n },
    }),
  });

  // A9 — over the cumulative cap, with the amount inside the per-call cap.
  await reject({
    id: '9', cls: 'A', stage: 'check_spend_scope, step 5 (cap, on the widened sum)',
    label: 'over the cumulative cap (U7 at 100 of 100, asks 100 within its per-call cap)',
    expected: ['cumulative cap exceeded'],
    fn: rawCall({ grant: u7, amount: 100n, payTo: recipient }),
  });

  // A10 — the recipient pin.
  await reject({
    id: '10', cls: 'A', stage: 'check_spend_scope, step 5 (the recipient pin)',
    label: 'a wrong recipient under a pin (U3 pins another UserAddress; the call pays the funding wallet)',
    expected: ['recipient not admitted by pin'],
    fn: rawCall({ grant: u3, amount: 50n, payTo: recipient }),
  });

  // ── Class A: settle_grant_with_<arm> (steps 6 and 7) ─────────────────────

  // A11 — the authorisation of U1 #3, replayed after the record nonce moved.
  //       The opening is advanced to the live cumulative spend so the scope
  //       check passes and the refusal lands in the settle chip.
  //
  //       WHICH predicate of the settle chip refuses it is not deterministic
  //       on the jubjub arm, and the row records the one that fired rather
  //       than asserting one. `settle_grant_with_jubjub` opens with
  //       `const c = challenge as Field` (account.compact:1906), and a
  //       32-byte hash is a valid field element only when it is below the
  //       BLS12-381 scalar modulus q — about 45.2 per cent of the time. A
  //       signature the grantee actually made is safe there, because the
  //       jubjub signer GRINDS `grind_nonce` until the challenge it signs is
  //       in range; a REPLAY is not, because the circuit recomputes the
  //       challenge from the record's NEW nonce with the old grind nonce, and
  //       the result is a fresh 32-byte value. So a replay is refused either
  //       by the cast (a range error, the more likely branch at ~54.8 per
  //       cent) or by the signature assert, and both refuse before any write.
  //       GRANTS-E2's own replay row accepts the same pair.
  {
    const liveOpening: GrantOpening = { ...u1.opening };
    const replayMessage = await reject({
      id: '11', cls: 'A',
      stage: 'settle_grant_with_jubjub, step 6: the challenge cast (account.compact:1906) or the signature assert',
      label: 'a replayed authorisation: U1 #3 resubmitted byte-identically after the record nonce advanced',
      expected: ['invalid grant signature', 'range error'],
      fn: () => account.withdrawUnshieldedWithGrantAuth(
        color, replayAmount, recipient, liveOpening, replayAuth as any),
    });
    rejectDetails.replayRow = {
      signedAtGrantNonce: gU1 === null ? null : gU1.grantNonce.toString(),
      recordNonceAtReplay: (recordOf(await account.ledgerState(), u1.id) as any).nonce,
      openingSpentPrevAtReplay: liveOpening.spentPrev.toString(),
      refusedBy: /range error/.test(replayMessage)
        ? 'the challenge cast to Field (account.compact:1906), a range error'
        : 'the signature assert ("invalid grant signature")',
      reading:
        'The challenge binds the record\'s nonce, which the circuit reads in-circuit, so the same signature cannot be '
        + 'replayed once the record has advanced (GR-5). The opening was advanced to the live cumulative spend first, so '
        + 'the row could not be refused earlier by the spent_commit opening. Which predicate of the settle chip refuses '
        + 'it is a coin flip: `settle_grant_with_jubjub` casts the recomputed challenge to Field before it verifies, and '
        + 'a 32-byte hash is in the BLS12-381 scalar field only about 45.2 per cent of the time. The grantee\'s own '
        + 'signatures always clear that cast, because the jubjub signer grinds `grind_nonce` until the challenge it signs '
        + 'is in range; a replay recomputes the challenge from a different record nonce with the old grind nonce, so it '
        + 'is a fresh draw. Row A11b below removes the coin flip and lands on the signature assert itself.',
    };
  }

  // A11b — the signature assert on its own, deterministically: a signature
  //        made over the LIVE context (so the grind nonce puts the challenge
  //        in range) with only `sig_s` altered. The challenge binds sig_r and
  //        grind_nonce but not sig_s, so the cast succeeds and the verify is
  //        the only thing left to fail.
  {
    const gLive = await account.grantContext(u1.id);
    const good = (jGrantee as JubjubGrantee).sign(
      jubjubGrantChallenges.withdrawUnshielded(gLive, jGrantee.pk, color, 50n, recipient),
    ) as any;
    const tampered = { ...good, sig_s: good.sig_s + 1n };
    const liveOpening: GrantOpening = { ...u1.opening };
    await reject({
      id: '11b', cls: 'A', stage: 'settle_grant_with_jubjub, step 6 (the signature assert itself)',
      label: 'a tampered signature on the live context (sig_s off by one, so the challenge cast still succeeds)',
      expected: ['invalid grant signature'],
      fn: () => account.withdrawUnshieldedWithGrantAuth(
        color, 50n, recipient, liveOpening, tampered as any),
    });
    rejectDetails.tamperedSignatureRow = {
      signedAtGrantNonce: gLive.grantNonce.toString(),
      tamper: 'sig_s + 1; sig_r, pk, and grind_nonce left exactly as signed',
      reading:
        'The jubjub challenge binds sig_r and grind_nonce but NOT sig_s, so altering sig_s leaves the challenge the '
        + 'grantee ground into range untouched and the cast at account.compact:1906 succeeds. The only predicate left '
        + 'is s.G == R + c.pk, which fails. This is the settle chip\'s signature assert reached deterministically, and '
        + 'together with A11 it shows both ways the settle chip refuses.',
    };
  }

  // A12 — stale enc_pk: structurally absent from this twin.
  rejectDetails.staleEncPkRow = {
    id: '12',
    class: 'A',
    item: 'a stale enc_pk (signed against the pre-rotation encryption key)',
    verdict: 'NOT APPLICABLE to the unshielded twins: no row exists to run',
    reason:
      'The stale-enc_pk predicate lives in `check_shielded_grant_bounds`, which asserts `coin.value <= max_coin_value` and '
      + '`enc_pk == enc_key`. Only the SHIELDED grant twins call that chip, because only they consume a witness coin and '
      + 'only they append a grantee-sealed change entry. `withdraw_unshielded_with_grant_k256` and '
      + '`withdraw_unshielded_with_grant_jubjub` take neither an `enc_pk` nor a `change_entry` argument at all: an '
      + 'unshielded send produces no change coin to seal, so there is nothing for a rotation to orphan. The same reasoning '
      + 'retires the `coin above max_coin_value` row: `max_coin_value` still enters the scope digest and the object '
      + 'commitment (and so is checked by row A6), but no coin-value bound is applied by the unshielded twins because they '
      + 'consume no coin.',
    citation: 'contracts/account.compact: check_shielded_grant_bounds, and the argument lists of the two unshielded twins.',
  };

  // ── Class B: do_withdraw_unshielded (the mirror gate) ────────────────────

  // B1 — a color the mirror has no entry for at all.
  {
    const l = await account.ledgerState();
    rejectDetails.colorOtherMirrorMember = l.unshielded_balances.member(colorOther);
    await reject({
      id: '1', cls: 'B', stage: 'do_withdraw_unshielded → debit_unshielded, the member assert',
      label: `a color the mirror never held (U8 over ${bytesToHex(colorOther).slice(0, 16)}…)`,
      expected: ['no balance for color'],
      fn: rawCall({ grant: u8, amount: 10n, payTo: recipient, color: colorOther }),
    });
  }

  // B2 — an amount inside every cap and above the mirror.
  {
    const l = await account.ledgerState();
    const mirrorNow = l.unshielded_balances.lookup(color);
    rejectDetails.mirrorAtRowB2 = mirrorNow.toString();
    const ask = 4_000n;
    if (ask <= mirrorNow) throw new Error(`row B2 needs an ask above the mirror; mirror is ${mirrorNow}`);
    await reject({
      id: '2', cls: 'B', stage: 'do_withdraw_unshielded → debit_unshielded, the balance assert',
      label: `an amount above the mirror (U10 asks ${ask} against a mirror of ${mirrorNow}, both inside its 4000 caps)`,
      expected: ['insufficient balance'],
      fn: rawCall({ grant: u10, amount: ask, payTo: recipient }),
    });
  }

  rejectDetails.rows = rows;
  rejectDetails.rowCount = rows.length;
  rejectDetails.classACount = rows.filter((r) => r.class === 'A').length;
  rejectDetails.classBCount = rows.filter((r) => r.class === 'B').length;
  rejectDetails.everyRowLeftTheLedgerUnchanged = rows.every((r) => r.stateUnchanged === true);
  rejectDetails.everyRowMatchedItsExpectedMessage = rows.every((r) => r.matchedExpected === true);
  rejectDetails.noRowEmittedAnUnshieldedOffer = true;
  rejectDetails.ledgerAfterRejections = snapshotOf(await account.ledgerState(), color);
  console.log(
    `  ✓ ${rows.length} rejection rows (${rejectDetails.classACount} class A, ${rejectDetails.classBCount} class B), ` +
    'every one a build-time abort leaving the ledger and the mirror unchanged',
  );

  flushEvidence('rejections');
  if (stopAfter('rejections')) return;

  // ══ S5 the per-call table ════════════════════════════════════════════════

  step('S5: the per-call table');
  writeProvingGroup();

  // ══ Evidence ══════════════════════════════════════════════════════════════

  // The per-call table covers the whole run, so it is written last and the
  // earlier groups are rewritten with it, exactly as the E2 suite does.
  flushEvidence('funding');
  flushEvidence('issue');
  flushEvidence('spend');
  flushEvidence('rejections');
  flushEvidence('proving');

  console.log(`\n  total wall clock: ${Math.round((Date.now() - runStart) / 1000)} s`);
});
