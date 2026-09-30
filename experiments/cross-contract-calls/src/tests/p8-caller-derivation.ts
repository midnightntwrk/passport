// P8 — caller derivation: what does the ledger's OWN code resolve
// CallContext.caller to, per call frame, on REAL composed transaction bytes?
//
// At ledger-9.1.0.0-rc.3 ContractCall::context (ledger/src/structure.rs)
// derives the caller of each call frame in ORDERED arms: first
// PublicAddress::Contract(<address>) from whichever OTHER ContractAction::Call
// in the same intent claims this call (a ClaimedContractCallsValue matching
// the callee's address, entry-point hash, and communication commitment);
// then PublicAddress::User from the single-distinct-owner rule over the
// intent's unshielded inputs; otherwise None. The value lands in VM context
// slot 6, for which Compact has NO reader — so this probe does not (cannot)
// read the caller from a circuit. It instead:
//
//   (a) builds the write_then_read(42) call transaction exactly as P3 does
//       and CAPTURES the serialised bytes at every stage the API exposes —
//       unproven (before proving), proven (before balancing), and balanced
//       (the bytes actually submitted) — as lowercase hex under evidence/;
//   (b) tries to build the same unproven transaction PURELY OFFLINE (no
//       node, no indexer), through midnight-js's own
//       createUnprovenCallTxFromInitialStates with a local callee-state stub
//       (P1's local-state-provider path, one layer up), and records whether
//       that was possible;
//   (c) submits the balanced transaction as P3 does and records hash and
//       finality;
//   (d) walks the captured transaction with the TypeScript ledger API and
//       prints, per intent and per ContractCall: address, entry point,
//       communicationCommitment, and every claimed-contract-call effect in
//       the guaranteed and fallible transcripts — the TypeScript view the
//       Rust tool (rust/, running the ledger's own derivation on these
//       bytes) is cross-checked against.
//
// and, finally,
//
//   (e) RUNS the ledger's own derivation over every captured hex file, by
//       invoking rust/caller-context (built from the midnight-ledger
//       repository at the same tag, ledger-9.1.0.0-rc.3), records its output
//       verbatim, and cross-checks its view of addresses, entry points,
//       commitments, and claims against the TypeScript view of (d).
//
// Expected (structure.rs reading, CONFIRMED here by the ledger's own code):
// the Tally set and get calls inside write_then_read resolve to
// Contract(<Caller address>); the root write_then_read call, in a coinless
// transaction with no unshielded inputs, resolves to None.
//
// What this probe does NOT observe: a node evaluating a slot-6 read. Compact
// has no reader for context slot 6, so no circuit can witness the derived
// caller. What is established is what the ledger computes and marshals into
// that slot, not what a contract was seen to receive.
//
// Privacy note: midnight-js documents UnsubmittedTxData as privacy-sensitive
// and asks applications not to serialise it. This probe does so
// deliberately, on a throwaway localnet with toy contracts carrying no
// secrets, because the serialised bytes ARE the experiment's input.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

import * as ledger from '@midnightntwrk/ledger-v9';
import * as rt from '@midnight-ntwrk/compact-runtime';
import {
  createUnprovenCallTx,
  createUnprovenCallTxFromInitialStates,
  createUnprovenDeployTxFromVerifierKeys,
} from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

import * as TallyModule from '../../contracts/managed/Tally/contract/index.js';
import * as CallerModule from '../../contracts/managed/Caller/contract/index.js';

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, serialiseError, classifyCallError } from './evidence.js';
import {
  setupWallet,
  connectWitnessFree,
  compiledWitnessFree,
  type ContractHandle,
} from '../node/setup.js';
import { CONFIG, tallyZkConfigPath, callerZkConfigPath } from '../node/wallet.js';
import { bytesToHex } from '../wallet/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_DIR = path.join(EXPERIMENT_ROOT, 'evidence');
// The ledger's own ContractCall::context derivation, off-node, over bytes.
// Built from rust/caller-context, which pins the midnight-ledger repository
// at tag ledger-9.1.0.0-rc.3 (commit 4823b5351b17cc49e30f19760dbd30a73cf95e22),
// the tag @midnightntwrk/ledger-v9 1.0.0-rc.3 is built from.
const RUST_CRATE_DIR = path.join(EXPERIMENT_ROOT, 'rust', 'caller-context');
const RUST_BIN = path.join(RUST_CRATE_DIR, 'target', 'release', 'caller-context');
const RUST_TOOL_PIN =
  'rust/caller-context @ midnight-ledger ledger-9.1.0.0-rc.3 (4823b5351b17cc49e30f19760dbd30a73cf95e22)';

const X = 42n;
const WATCH_TIMEOUT_MS = 120_000;
const DESCRIPTION =
  "Run the ledger's own ContractCall::context derivation over the real composed bytes of the write_then_read call transaction, captured at every stage and submitted, and record what caller resolves to per call frame";

// ── Serialisation helpers ────────────────────────────────────────────────────

const hexOf = (v: unknown): string => {
  if (v instanceof Uint8Array) return bytesToHex(v).toLowerCase();
  if (typeof v === 'string') return v.replace(/^0x/, '').toLowerCase();
  return String(v);
};

interface HexCapture {
  stage: string;
  file: string;
  bytes: number;
  sha256: string;
}

function writeHex(stage: string, raw: Uint8Array): HexCapture {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `p8-tx-${stage}.hex`);
  fs.writeFileSync(file, bytesToHex(raw).toLowerCase() + '\n');
  const { createHash } = require_crypto();
  const sha256 = createHash('sha256').update(raw).digest('hex');
  console.log(`  ■ ${stage}: ${raw.length} bytes → ${path.relative(process.cwd(), file)} (sha256 ${sha256.slice(0, 16)}…)`);
  return { stage, file: path.relative(path.resolve(__dirname, '..', '..'), file), bytes: raw.length, sha256 };
}

// node:crypto via createRequire keeps this file ESM-clean under tsx.
import { createRequire } from 'node:module';
const require_crypto = () => createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto');

/**
 * Which (Signaturish, Proofish, Bindingish) marker triple deserialises the
 * bytes? The Rust tool has to pick the matching ledger type, so the answer
 * is recorded per stage rather than assumed.
 */
function deserialiseLadder(raw: Uint8Array): { markers: string[] | null; tried: string[]; error?: string } {
  const ladder: Array<[string, string, string]> = [
    ['signature', 'pre-proof', 'pre-binding'],
    ['signature', 'proof', 'pre-binding'],
    ['signature', 'proof', 'binding'],
    ['signature', 'pre-proof', 'binding'],
    ['signature-erased', 'proof', 'binding'],
    ['signature', 'no-proof', 'no-binding'],
  ];
  const tried: string[] = [];
  let lastError: string | undefined;
  for (const m of ladder) {
    tried.push(m.join('/'));
    try {
      (ledger.Transaction as any).deserialize(m[0], m[1], m[2], raw);
      return { markers: m, tried };
    } catch (e: any) {
      lastError = String(e?.message ?? e).slice(0, 200);
    }
  }
  return { markers: null, tried, error: lastError };
}

// ── The TypeScript view of the transaction ───────────────────────────────────

interface ClaimView {
  section: 'guaranteed' | 'fallible';
  seq: string;
  address: string;
  entryPointHash: string;
  commitment: string;
}

interface CallView {
  intentSegment: number;
  index: number;
  address: string;
  entryPoint: string;
  entryPointHash: string;
  communicationCommitment: string;
  claims: ClaimView[];
  hasGuaranteed: boolean;
  hasFallible: boolean;
  unshieldedInputsInIntent: number;
}

function claimsOf(section: 'guaranteed' | 'fallible', transcript: any): ClaimView[] {
  const list: any[] = transcript?.effects?.claimedContractCalls ?? [];
  return list.map((c: any) => ({
    section,
    seq: String(c[0]),
    address: hexOf(c[1]),
    entryPointHash: hexOf(c[2]),
    commitment: hexOf(c[3]),
  }));
}

/** Walk every intent and every ContractCall; deploys and maintenance updates are counted only. */
function walkTransaction(tx: any): { calls: CallView[]; intents: Array<Record<string, unknown>> } {
  const calls: CallView[] = [];
  const intents: Array<Record<string, unknown>> = [];
  const map: Map<number, any> | undefined = tx.intents;
  if (!map) return { calls, intents };
  for (const [segment, intent] of map) {
    const actions: any[] = intent.actions ?? [];
    const gOffer = intent.guaranteedUnshieldedOffer;
    const fOffer = intent.fallibleUnshieldedOffer;
    const unshieldedInputs = (gOffer?.inputs?.length ?? 0) + (fOffer?.inputs?.length ?? 0);
    const kinds = actions.map((a) =>
      a instanceof (ledger as any).ContractCall ? 'call' :
      a instanceof (ledger as any).ContractDeploy ? 'deploy' :
      a instanceof (ledger as any).MaintenanceUpdate ? 'maintenance' : a?.constructor?.name ?? 'unknown');
    intents.push({
      segment,
      actions: kinds,
      unshieldedInputs,
      unshieldedOutputs: (gOffer?.outputs?.length ?? 0) + (fOffer?.outputs?.length ?? 0),
      dustActions: intent.dustActions ? 'present' : 'absent',
      ttl: intent.ttl instanceof Date ? intent.ttl.toISOString() : String(intent.ttl),
    });
    actions.forEach((a, index) => {
      if (kinds[index] !== 'call') return;
      const entryPoint = typeof a.entryPoint === 'string' ? a.entryPoint : hexOf(a.entryPoint);
      calls.push({
        intentSegment: segment,
        index,
        address: hexOf(a.address),
        entryPoint,
        entryPointHash: hexOf((ledger as any).entryPointHash(a.entryPoint)),
        communicationCommitment: hexOf(a.communicationCommitment),
        claims: [
          ...claimsOf('guaranteed', a.guaranteedTranscript),
          ...claimsOf('fallible', a.fallibleTranscript),
        ],
        hasGuaranteed: a.guaranteedTranscript !== undefined,
        hasFallible: a.fallibleTranscript !== undefined,
        unshieldedInputsInIntent: unshieldedInputs,
      });
    });
  }
  return { calls, intents };
}

/**
 * A TypeScript RE-IMPLEMENTATION of the structure.rs arms, for cross-check
 * only. It is NOT the ledger's code and is NOT evidence of what the ledger
 * does; the Rust tool is. Pairs each call with the claim (in another call of
 * the same intent) matching its (address, entryPointHash, commitment).
 */
function reimplementedCallerHint(calls: CallView[]): Array<Record<string, unknown>> {
  return calls.map((callee) => {
    const claimants = calls.filter(
      (other) =>
        other !== callee &&
        other.intentSegment === callee.intentSegment &&
        other.claims.some(
          (c) =>
            c.address === callee.address &&
            c.entryPointHash === callee.entryPointHash &&
            commitmentsEqual(c.commitment, callee.communicationCommitment),
        ),
    );
    const contractArm = claimants.length ? `Contract(${claimants[0].address})` : null;
    // The User arm needs the single-distinct-owner rule over unshielded inputs;
    // with zero unshielded inputs in the intent it cannot fire.
    const userArm = callee.unshieldedInputsInIntent === 0 ? null : 'User(<needs owner resolution — see Rust tool>)';
    return {
      call: `${callee.entryPoint}@${callee.address.slice(0, 12)}…`,
      claimants: claimants.map((c) => `${c.entryPoint}@${c.address.slice(0, 12)}…`),
      claimantCount: claimants.length,
      tsHint: contractArm ?? userArm ?? 'None',
    };
  });
}

/** Fr vs hex-string commitments may differ in byte order; try both. */
function commitmentsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const rev = (h: string) => (h.match(/../g) ?? []).reverse().join('');
  return rev(a) === b;
}

function printCalls(label: string, view: ReturnType<typeof walkTransaction>): void {
  console.log(`  [${label}] ${view.intents.length} intent(s): ${JSON.stringify(view.intents)}`);
  for (const c of view.calls) {
    console.log(
      `  [${label}] seg ${c.intentSegment} #${c.index} ${c.entryPoint} @ ${c.address.slice(0, 16)}… ` +
      `ep_hash ${c.entryPointHash.slice(0, 16)}… comm ${c.communicationCommitment.slice(0, 16)}… ` +
      `(${c.hasGuaranteed ? 'G' : '-'}${c.hasFallible ? 'F' : '-'}) claims: ${c.claims.length}`,
    );
    for (const cl of c.claims) {
      console.log(
        `      ↳ claims [${cl.section}] seq ${cl.seq} → ${cl.address.slice(0, 16)}… ep_hash ${cl.entryPointHash.slice(0, 16)}… comm ${cl.commitment.slice(0, 16)}…`,
      );
    }
  }
}

// ── Offline construction (no node, no indexer) ───────────────────────────────

/**
 * Build the unproven write_then_read(42) transaction with NO network: the
 * pair "deployed" offline through midnight-js's deploy path (keyed initial
 * states, derived addresses), a local callee-state stub in place of the
 * indexer, verifier keys from disk, and dummy wallet keys (everything is
 * coinless so no Zswap output ever consults them).
 */
async function buildOffline(details: Record<string, unknown>): Promise<Uint8Array | null> {
  const offline: Record<string, unknown> = {};
  details.offline = offline;
  try {
    const COIN_PK = '0'.repeat(64);
    // Dummy encryption key: never consulted for coinless deploys and calls.
    const ENC_PK = '0'.repeat(64);

    // midnight-js's call assembler requires every invoked operation to carry
    // its DEPLOYED verifier key ("present in states read from chain, or
    // produced by a real deploy" — observed on the second run of this probe
    // when P1-style initialState() states were passed). So the pair is first
    // "deployed" OFFLINE through midnight-js's own deploy path, which keys
    // the initial states from the on-disk artefacts and derives the
    // addresses (ContractDeploy.address); the call is then built against
    // those keyed states. Addresses therefore differ from the live pair;
    // the byte structure does not.
    const tallyDeploy: any = await (createUnprovenDeployTxFromVerifierKeys as any)(
      new NodeZkConfigProvider(tallyZkConfigPath),
      COIN_PK,
      { compiledContract: compiledWitnessFree('tally', TallyModule, tallyZkConfigPath) },
      ENC_PK,
    );
    const tallyAddress: string = tallyDeploy.public.contractAddress;
    const tallyState = tallyDeploy.public.initialContractState;
    const callerDeploy: any = await (createUnprovenDeployTxFromVerifierKeys as any)(
      new NodeZkConfigProvider(callerZkConfigPath),
      COIN_PK,
      {
        compiledContract: compiledWitnessFree('caller', CallerModule, callerZkConfigPath),
        args: [{ bytes: rt.encodeContractAddress(tallyAddress) }],
      },
      ENC_PK,
    );
    const callerAddress: string = callerDeploy.public.contractAddress;
    const callerState = callerDeploy.public.initialContractState;
    offline.addressesFrom = 'offline deploy (ContractDeploy.address of locally built deploy transactions; NOT the live pair)';
    offline.tallyAddress = tallyAddress;
    offline.callerAddress = callerAddress;
    offline.stateClass = tallyState?.constructor?.name ?? typeof tallyState;
    offline.deployTxBytes = {
      tally: tallyDeploy.private?.unprovenTx?.serialize?.().length ?? null,
      caller: callerDeploy.private?.unprovenTx?.serialize?.().length ?? null,
    };

    const blockHash = 'de'.repeat(32);
    let stubQueries = 0;
    const stubProvider = {
      queryContractState: async (address: string, offset?: any) => {
        stubQueries++;
        offline.stubOffsetSeen = offset ?? null;
        return hexOf(address) === hexOf(tallyAddress) ? tallyState : null;
      },
    };

    const t0 = performance.now();
    const built: any = await (createUnprovenCallTxFromInitialStates as any)(
      new NodeZkConfigProvider(callerZkConfigPath),
      {
        compiledContract: compiledWitnessFree('caller', CallerModule, callerZkConfigPath),
        contractAddress: callerAddress,
        circuitId: 'write_then_read',
        args: [X],
        coinPublicKey: COIN_PK,
        initialContractState: callerState,
        initialZswapChainState: new (ledger as any).ZswapChainState(),
        ledgerParameters: (ledger as any).LedgerParameters.initialParameters(),
      },
      ENC_PK,
      { publicDataProvider: stubProvider, blockHash },
    );
    offline.buildMs = Math.round(performance.now() - t0);
    offline.stubQueries = stubQueries;
    offline.calls = (built.calls ?? []).map((c: any) => `${c.circuitId}@${hexOf(c.contractAddress).slice(0, 12)}…`);
    const tx = built.private?.unprovenTx;
    if (!tx) throw new Error('offline build returned no unprovenTx');
    const raw: Uint8Array = tx.serialize();
    offline.possible = true;
    offline.view = walkTransaction(tx);
    printCalls('offline', offline.view as any);
    return raw;
  } catch (e: any) {
    offline.possible = false;
    offline.error = serialiseError(e);
    console.log(`  offline construction NOT possible: ${e?.message ?? e}`);
    return null;
  }
}


// ── The ledger's own derivation (rust/caller-context) ────────────────────────
//
// The TypeScript hint above is a re-implementation and is NOT evidence. This
// arm runs the ledger's OWN ContractCall::context over the captured bytes,
// through a small Rust binary that links midnight-ledger at the same tag the
// wasm binding is built from, and reports caller per call frame.

interface RustClaim {
  transcript: string;
  seq: number;
  address: string;
  ep_hash: string;
  communication_commitment: string;
  matches_action_index: number | null;
}

interface RustCall {
  action_index: number;
  address: string;
  entry_point: string;
  ep_hash: string;
  communication_commitment: string;
  has_guaranteed_transcript: boolean;
  has_fallible_transcript: boolean;
  claims: RustClaim[];
  claimed_by: Array<{ action_index: number; address: string; entry_point: string; guaranteed: boolean; seq: number }>;
  caller_selected_by_action_index: number | null;
  caller: string;
}

interface RustIntent {
  segment: number;
  actions: number;
  deploys: number;
  maintenance_updates: number;
  guaranteed_unshielded_offer: unknown;
  fallible_unshielded_offer: unknown;
  calls: RustCall[];
  anomalies: unknown[];
}

interface RustReport {
  input_file: string;
  input_encoding: string;
  input_bytes: number;
  header_tag: string;
  deserialised_as: string;
  attempts: Array<{ candidate: string; ok: boolean; error: string | null }>;
  transaction_kind: string;
  network_id: string;
  intents: RustIntent[];
}

class RustToolUnavailable extends Error {}

/** Invoke the built binary twice on one capture: human-readable, then JSON. */
function runRustTool(relativeHexFile: string): { report: RustReport; text: string } {
  if (!fs.existsSync(RUST_BIN)) {
    throw new RustToolUnavailable(
      `the caller-derivation tool is not built: ${path.relative(EXPERIMENT_ROOT, RUST_BIN)} does not exist. ` +
        'Build it with `cd rust/caller-context && cargo build --release` (the first build compiles the ledger ' +
        'ZK dependency graph and takes on the order of 15 to 30 minutes; incremental rebuilds take about 30 s), ' +
        'then re-run this probe.',
    );
  }
  const opts = { encoding: 'utf8' as const, maxBuffer: 256 * 1024 * 1024, cwd: EXPERIMENT_ROOT };
  let text: string;
  let json: string;
  try {
    text = execFileSync(RUST_BIN, [relativeHexFile], opts);
    json = execFileSync(RUST_BIN, [relativeHexFile, '--json'], opts);
  } catch (e: any) {
    throw new RustToolUnavailable(
      `the caller-derivation tool failed on ${relativeHexFile}: ${e?.message ?? e}` +
        (e?.stderr ? ` :: stderr ${String(e.stderr).slice(0, 400)}` : ''),
    );
  }
  return { report: JSON.parse(json) as RustReport, text };
}

/**
 * Communication commitments are Fr values, and the two views render them
 * differently. The TypeScript API emits a one-byte tag followed by the
 * MINIMAL little-endian value bytes, so a full-width value renders as 33
 * bytes (tag 0x73) and a value whose high byte is zero renders shorter (a
 * 31-byte value was observed with tag 0x6f). The Rust tool emits the padded
 * 32 little-endian bytes. Both are therefore reduced to the minimal
 * little-endian form, so that what is compared is the value and not the
 * rendering. Addresses and entry-point hashes are raw 32-byte arrays in both
 * views and are compared as they stand.
 */
const trimTrailingZeroBytes = (h: string): string => h.replace(/(?:00)+$/, '');
/** TypeScript rendering (tag byte + minimal little-endian bytes) to canonical form. */
const canonicalTsFr = (h: string): string => trimTrailingZeroBytes(h.slice(2));
/** Rust rendering (padded 32 little-endian bytes) to canonical form. */
const canonicalRustFr = (h: string): string => trimTrailingZeroBytes(h);

interface CallerRow {
  stage: string;
  segment: number;
  actionIndex: number;
  entryPoint: string;
  address: string;
  caller: string;
  selectedByActionIndex: number | null;
}

function callerRows(stage: string, report: RustReport): CallerRow[] {
  const rows: CallerRow[] = [];
  for (const intent of report.intents) {
    for (const c of intent.calls) {
      rows.push({
        stage,
        segment: intent.segment,
        actionIndex: c.action_index,
        entryPoint: c.entry_point,
        address: c.address,
        caller: c.caller,
        selectedByActionIndex: c.caller_selected_by_action_index,
      });
    }
  }
  return rows;
}

/**
 * Do the two independent views of the same bytes agree? Any disagreement is
 * a finding in itself, so it is recorded rather than tolerated.
 */
function crossCheck(
  stage: string,
  tsView: ReturnType<typeof walkTransaction> | undefined,
  report: RustReport,
): Record<string, unknown> {
  if (!tsView) return { stage, compared: false, reason: 'no TypeScript view was recorded for this stage' };
  const tsCalls = new Map(tsView.calls.map((c) => [`seg ${c.intentSegment} #${c.index}`, c]));
  const rustCalls = new Map<string, RustCall>();
  for (const intent of report.intents) {
    for (const c of intent.calls) rustCalls.set(`seg ${intent.segment} #${c.action_index}`, c);
  }
  const mismatches: string[] = [];
  for (const k of tsCalls.keys()) if (!rustCalls.has(k)) mismatches.push(`${k}: in the TypeScript view, not in the Rust view`);
  for (const k of rustCalls.keys()) if (!tsCalls.has(k)) mismatches.push(`${k}: in the Rust view, not in the TypeScript view`);
  for (const [k, t] of tsCalls) {
    const r = rustCalls.get(k);
    if (!r) continue;
    if (t.address !== r.address) mismatches.push(`${k}: address ${t.address} (TS) vs ${r.address} (Rust)`);
    if (t.entryPoint !== r.entry_point) mismatches.push(`${k}: entry point ${t.entryPoint} (TS) vs ${r.entry_point} (Rust)`);
    if (t.entryPointHash !== r.ep_hash) mismatches.push(`${k}: ep_hash ${t.entryPointHash} (TS) vs ${r.ep_hash} (Rust)`);
    if (canonicalTsFr(t.communicationCommitment) !== canonicalRustFr(r.communication_commitment)) {
      mismatches.push(`${k}: communication commitment ${t.communicationCommitment} (TS) vs ${r.communication_commitment} (Rust)`);
    }
    // Claims serialise unordered on the wire, so compare them as sets.
    const tsClaims = t.claims
      .map((c) => `${c.seq}|${c.address}|${c.entryPointHash}|${canonicalTsFr(c.commitment)}`)
      .sort();
    const rustClaims = r.claims
      .map((c) => `${c.seq}|${c.address}|${c.ep_hash}|${canonicalRustFr(c.communication_commitment)}`)
      .sort();
    if (JSON.stringify(tsClaims) !== JSON.stringify(rustClaims)) {
      mismatches.push(`${k}: claims ${JSON.stringify(tsClaims)} (TS) vs ${JSON.stringify(rustClaims)} (Rust)`);
    }
  }
  const tsSegments = tsView.intents.map((i: any) => Number(i.segment)).sort((a, b) => a - b);
  const rustSegments = report.intents.map((i) => i.segment).sort((a, b) => a - b);
  if (JSON.stringify(tsSegments) !== JSON.stringify(rustSegments)) {
    mismatches.push(`intent segments ${JSON.stringify(tsSegments)} (TS) vs ${JSON.stringify(rustSegments)} (Rust)`);
  }
  return {
    stage,
    compared: true,
    callsCompared: tsCalls.size,
    agree: mismatches.length === 0,
    mismatches,
    frRenderingNote:
      'Communication commitments are compared as values, not renderings: the TypeScript API emits a one-byte ' +
      'tag followed by the minimal little-endian value bytes (33 bytes with tag 0x73 for a full-width value, ' +
      'shorter when the high bytes are zero, for example 32 bytes with tag 0x6f for a 31-byte value), while the ' +
      'Rust tool emits the padded 32 little-endian bytes. Addresses and entry-point hashes are raw 32-byte ' +
      'arrays in both views and are compared as they stand.',
  };
}

/**
 * The expectation under test, per capture: the two Tally sub-calls resolve to
 * Contract(<the Caller address>), the root write_then_read call resolves to
 * None. Every deviation is listed; an empty list is the only pass.
 */
function evaluateExpectation(stage: string, report: RustReport): { stage: string; met: boolean; deviations: string[] } {
  const deviations: string[] = [];
  const callIntents = report.intents.filter((i) => i.calls.length > 0);
  if (callIntents.length !== 1) deviations.push(`expected exactly 1 intent carrying contract calls, saw ${callIntents.length}`);
  for (const intent of callIntents) {
    const roots = intent.calls.filter((c) => c.entry_point === 'write_then_read');
    const subs = intent.calls.filter((c) => c.entry_point === 'set' || c.entry_point === 'get');
    if (roots.length !== 1) {
      deviations.push(`segment ${intent.segment}: expected 1 root write_then_read call, saw ${roots.length}`);
      continue;
    }
    if (subs.length !== 2) deviations.push(`segment ${intent.segment}: expected 2 sub-calls (set and get), saw ${subs.length}`);
    if (roots[0].caller !== 'None') {
      deviations.push(`segment ${intent.segment}: root write_then_read caller is ${roots[0].caller}, expected None`);
    }
    const expected = `Contract(${roots[0].address})`;
    for (const sub of subs) {
      if (sub.caller !== expected) deviations.push(`segment ${intent.segment}: ${sub.entry_point} caller is ${sub.caller}, expected ${expected}`);
    }
    if (intent.anomalies.length) {
      deviations.push(`segment ${intent.segment}: claim-graph anomalies reported: ${JSON.stringify(intent.anomalies)}`);
    }
  }
  return { stage, met: deviations.length === 0, deviations };
}

// ── The probe ────────────────────────────────────────────────────────────────

await runScenario('p8-caller-derivation', async () => {
  const details: Record<string, unknown> = {};
  const captures: HexCapture[] = [];
  details.hexFiles = captures;

  step('offline arm: build the unproven transaction with no node and no indexer');
  const offlineRaw = await buildOffline(details);
  if (offlineRaw) {
    const cap = writeHex('offline-unproven', offlineRaw);
    (details.offline as any).ladder = deserialiseLadder(offlineRaw);
    captures.push(cap);
  }

  step('reconnect to the pair P2 deployed');
  const walletCtx = await setupWallet();
  const tally: ContractHandle = await connectWitnessFree(walletCtx, {
    name: 'tally',
    module: TallyModule,
    zkPath: tallyZkConfigPath,
  });
  const caller: ContractHandle = await connectWitnessFree(walletCtx, {
    name: 'caller',
    module: CallerModule,
    zkPath: callerZkConfigPath,
  });
  details.tallyAddress = tally.address;
  details.callerAddress = caller.address;
  details.expectedEntryPointHashes = {
    set: hexOf((ledger as any).entryPointHash('set')),
    get: hexOf((ledger as any).entryPointHash('get')),
    write_then_read: hexOf((ledger as any).entryPointHash('write_then_read')),
  };
  const providers: any = caller.providers;

  const tallyBefore = await tally.ledgerState();
  const callerBefore = await caller.ledgerState();
  details.before = {
    tally: { total: tallyBefore.total, writes: tallyBefore.writes },
    caller: { calls: callerBefore.calls, last_observed: callerBefore.last_observed },
  };

  step(`build the unproven write_then_read(${X}) transaction (as P3, via createUnprovenCallTx)`);
  const t0 = performance.now();
  const unsubmitted: any = await createUnprovenCallTx(providers, {
    compiledContract: compiledWitnessFree('caller', CallerModule, callerZkConfigPath),
    circuitId: 'write_then_read',
    contractAddress: caller.address,
    args: [X],
  } as any);
  const buildMs = Math.round(performance.now() - t0);
  const unproven: any = unsubmitted.private.unprovenTx;
  const unprovenRaw: Uint8Array = unproven.serialize();
  captures.push(writeHex('unproven', unprovenRaw));
  details.callsInTrace = (unsubmitted.calls ?? []).map((c: any) => `${c.circuitId}@${hexOf(c.contractAddress).slice(0, 12)}…`);

  step('TypeScript view of the UNPROVEN transaction: intents, calls, claims');
  const unprovenView = walkTransaction(unproven);
  printCalls('unproven', unprovenView);
  details.unprovenView = unprovenView;
  details.unprovenLadder = deserialiseLadder(unprovenRaw);

  step('prove (proof server), capture the proven transaction before balancing');
  const t1 = performance.now();
  let proven: any;
  try {
    proven = await providers.proofProvider.proveTx(unproven);
  } catch (e: any) {
    const cls = classifyCallError(e);
    details.error = serialiseError(e);
    writeEvidence({
      testId: 'P8', name: 'caller-derivation', description: DESCRIPTION, verdict: 'BLOCKED',
      errorCode: cls.errorCode,
      note: `Proving failed (${cls.outcome}); unproven bytes captured at ${captures.map((c) => c.file).join(', ')}. ${cls.note}`,
      details,
    });
    throw e;
  }
  const proveMs = Math.round(performance.now() - t1);
  const provenRaw: Uint8Array = proven.serialize();
  captures.push(writeHex('proven', provenRaw));
  details.provenLadder = deserialiseLadder(provenRaw);
  const provenView = walkTransaction(proven);
  printCalls('proven', provenView);
  details.provenView = provenView;

  step('balance (the wallet adds the Dust fee intent), capture the SUBMITTED bytes, submit');
  let balancedRaw: Uint8Array | null = null;
  let submission: Record<string, unknown>;
  const t2 = performance.now();
  try {
    const balanced: any = await providers.walletProvider.balanceTx(proven);
    try {
      balancedRaw = balanced.serialize();
      captures.push(writeHex('balanced', balancedRaw!));
      details.balancedLadder = deserialiseLadder(balancedRaw!);
      const balancedView = walkTransaction(balanced);
      printCalls('balanced', balancedView);
      details.balancedView = balancedView;
    } catch (e: any) {
      details.balancedCaptureError = serialiseError(e);
    }
    const txId: string = await providers.midnightProvider.submitTx(balanced);
    const finalized: any = await Promise.race([
      providers.publicDataProvider.watchForTxData(txId),
      sleep(WATCH_TIMEOUT_MS).then(() => ({ status: 'watch-timeout' })),
    ]);
    submission = {
      accepted: true,
      txId,
      status: finalized?.status ?? null,
      blockHeight: finalized?.blockHeight ?? null,
    };
    console.log(`  tx ${txId} · status ${finalized?.status} · block ${finalized?.blockHeight}`);
  } catch (e: any) {
    const cls = classifyCallError(e);
    submission = { accepted: false, stage: cls.outcome, errorCode: cls.errorCode, error: serialiseError(e) };
    console.log(`  submission FAILED at ${cls.outcome}: ${cls.errorCode}`);
  }
  details.submission = submission;
  details.timings = { buildMs, proveMs, balanceSubmitFinaliseMs: Math.round(performance.now() - t2) };
  details.sizes = Object.fromEntries(captures.map((c) => [c.stage, c.bytes]));

  if ((submission as any).accepted) {
    step('both ledgers advanced');
    const tallyAfter = await waitForLedger(
      () => tally.ledgerState(), `tally.total = ${X}`,
      (l: any) => l.total === X && l.writes === tallyBefore.writes + 1n,
    );
    const callerAfter = await waitForLedger(
      () => caller.ledgerState(), `caller.last_observed = ${X}`,
      (l: any) => l.last_observed === X && l.calls === callerBefore.calls + 1n,
    );
    details.after = {
      tally: { total: tallyAfter.total, writes: tallyAfter.writes },
      caller: { calls: callerAfter.calls, last_observed: callerAfter.last_observed },
    };
  }

  step('cross-check hint (TypeScript re-implementation of the structure.rs arms — NOT the ledger)');
  const hint = reimplementedCallerHint(unprovenView.calls);
  details.tsReimplementedCallerHint = hint;
  for (const h of hint) console.log(`  ${h.call} ← ${h.tsHint} (claimants: ${(h.claimants as string[]).join(', ') || 'none'})`);

  // Structural checks on the TypeScript view (the part this file CAN assert).
  const rootCalls = unprovenView.calls.filter((c) => c.entryPoint === 'write_then_read');
  const subCalls = unprovenView.calls.filter((c) => c.entryPoint === 'set' || c.entryPoint === 'get');
  if (rootCalls.length !== 1) throw new Error(`expected 1 root call, saw ${rootCalls.length}`);
  if (subCalls.length !== 2) throw new Error(`expected 2 sub-calls (set, get), saw ${subCalls.length}`);
  const rootClaims = rootCalls[0].claims;
  details.structure = {
    rootClaimsCount: rootClaims.length,
    rootCommitmentPresent: rootCalls[0].communicationCommitment.length > 0,
    subCallsClaimedByRoot: subCalls.map((s) =>
      rootClaims.some((c) => c.address === s.address && c.entryPointHash === s.entryPointHash && commitmentsEqual(c.commitment, s.communicationCommitment))),
    unshieldedInputsInCallIntent: rootCalls[0].unshieldedInputsInIntent,
  };
  console.log(`  root claims ${rootClaims.length} call(s); sub-calls claimed by root: ${JSON.stringify((details.structure as any).subCallsClaimedByRoot)}; root commitment field present: ${(details.structure as any).rootCommitmentPresent}`);

  const offlinePossible = (details.offline as any)?.possible === true;
  const sub: any = submission;

  // ── The ledger's own derivation over every capture ─────────────────────────
  step("run the ledger's OWN ContractCall::context derivation over every capture (rust/caller-context)");
  const rustRuns: Array<Record<string, unknown>> = [];
  const perCall: CallerRow[] = [];
  const crossChecks: Array<Record<string, unknown>> = [];
  const expectations: Array<{ stage: string; met: boolean; deviations: string[] }> = [];
  const tsViewFor: Record<string, ReturnType<typeof walkTransaction> | undefined> = {
    'offline-unproven': (details.offline as any)?.view,
    unproven: details.unprovenView as any,
    proven: details.provenView as any,
    balanced: details.balancedView as any,
  };

  try {
    for (const cap of captures) {
      const { report, text } = runRustTool(cap.file);
      console.log(text.trimEnd());
      // Verbatim, because the tool's output IS the evidence this probe exists
      // to produce; the parsed form is kept alongside it for machine reading.
      rustRuns.push({ stage: cap.stage, input: cap.file, verbatimOutput: text, json: report });
      perCall.push(...callerRows(cap.stage, report));
      crossChecks.push(crossCheck(cap.stage, tsViewFor[cap.stage], report));
      expectations.push(evaluateExpectation(cap.stage, report));
    }
  } catch (e: any) {
    details.rustCallerDerivation = {
      tool: RUST_TOOL_PIN,
      binary: path.relative(EXPERIMENT_ROOT, RUST_BIN),
      available: false,
      error: serialiseError(e),
      runs: rustRuns,
    };
    writeEvidence({
      testId: 'P8',
      name: 'caller-derivation',
      description: DESCRIPTION,
      verdict: 'BLOCKED',
      txHash: sub.accepted ? sub.txId : undefined,
      errorCode: 'caller-derivation-tool-unavailable',
      note:
        `The bytes were captured (${captures.map((c) => `${c.stage} ${c.bytes} B`).join(', ')}) but the ledger's own ` +
        `derivation could not be run, so the question this probe asks is unanswered: ${e?.message ?? e}`,
      details,
    });
    throw e;
  }

  details.rustCallerDerivation = {
    tool: RUST_TOOL_PIN,
    binary: path.relative(EXPERIMENT_ROOT, RUST_BIN),
    available: true,
    expectation:
      'the Tally set and get calls resolve to Contract(<Caller address>); the root write_then_read call, ' +
      'in an intent with no unshielded inputs, resolves to None',
    expectationPerStage: expectations,
    perCall,
    crossCheckAgainstTypeScript: crossChecks,
    runs: rustRuns,
  };

  step('caller per call frame, as the ledger derives it');
  for (const r of perCall) {
    console.log(
      `  [${r.stage}] seg ${r.segment} #${r.actionIndex} ${r.entryPoint} @ ${r.address.slice(0, 16)}… ` +
      `→ caller ${r.caller}${r.selectedByActionIndex === null ? '' : ` (selected by action #${r.selectedByActionIndex})`}`,
    );
  }

  const expectationMet = expectations.length > 0 && expectations.every((x) => x.met);
  const crossChecksAgree = crossChecks.every((c) => c.compared !== true || c.agree === true);
  const deviations = expectations.flatMap((x) => x.deviations);
  const mismatches = crossChecks.flatMap((c) => ((c.mismatches as string[]) ?? []));
  const uncomparedStages = crossChecks.filter((c) => c.compared === false).map((c) => c.stage);
  console.log(
    `\n  expectation ${expectationMet ? 'MET' : 'NOT met'} on ${expectations.length} capture(s); ` +
    `Rust and TypeScript views ${crossChecksAgree ? 'agree' : 'DISAGREE'}` +
    (uncomparedStages.length ? ` (${uncomparedStages.join(', ')} not compared)` : ''),
  );

  // PASS needs all three legs: the ledger's derivation matched the
  // expectation on every capture, the two independent views of the same
  // bytes agreed, and the composition was accepted on chain. A derivation
  // that is right on bytes the node never accepted is only PARTIAL.
  const verdict: 'PASS' | 'FAIL' | 'PARTIAL' =
    !expectationMet || !crossChecksAgree ? 'FAIL' : sub.accepted ? 'PASS' : 'PARTIAL';

  // The captures do not all share one Caller: the offline arm derives its own
  // pair from the on-disk artefacts, so the addresses are reported as a set.
  const callerAddrs = [...new Set(perCall.filter((r) => r.entryPoint === 'write_then_read').map((r) => r.address))];
  const rootFrames = perCall.filter((r) => r.entryPoint === 'write_then_read').length;
  const subFrames = perCall.filter((r) => r.entryPoint === 'set' || r.entryPoint === 'get').length;
  // Whether the User arm could have fired at all, read off every capture
  // rather than assumed from one: it needs unshielded inputs in the intent.
  const callIntents = rustRuns.flatMap((r) => (r.json as RustReport).intents.filter((i) => i.calls.length > 0));
  const allCallIntentsCoinless = callIntents.every(
    (i) => i.guaranteed_unshielded_offer === null && i.fallible_unshielded_offer === null,
  );

  // compose-findings.ts truncates the note at 220 characters for the table,
  // so the result itself has to land in the first sentence; the supporting
  // detail follows it.
  const observedSentence = expectationMet
    ? `Observed: the ledger's own ContractCall::context, at tag ledger-9.1.0.0-rc.3, run off-node over real ` +
      `composed bytes, resolves Tally set and get to Contract(<Caller address>) and the root write_then_read to None.`
    : `Observed: the ledger's own ContractCall::context, at tag ledger-9.1.0.0-rc.3, run off-node over real ` +
      `composed bytes, did NOT resolve as the source reading predicted: ${deviations.join('; ')}.`;
  const detailSentence = expectationMet
    ? `That holds on all ${rustRuns.length} captures [${captures.map((c) => `${c.stage} ${c.bytes} B`).join(', ')}]: ` +
      `${subFrames} sub-call frames resolve to Contract(<the address of the root call in the same intent>) and ` +
      `${rootFrames} root frames to None, across ${callIntents.length} call-carrying intents whose unshielded ` +
      `offers are ${allCallIntentsCoinless ? 'all absent, so the User arm could not fire' : 'NOT all absent, see details'}; ` +
      `the Caller addresses observed were ${callerAddrs.join(' and ')} (the offline arm derives its own pair).`
    : '';
  const notObservedSentence =
    'NOT observed: a node evaluating a slot-6 read, because Compact has no reader for context slot 6 and no circuit ' +
    'in this experiment reads it, so these are the values the ledger computes and marshals into that slot rather ' +
    'than values a contract was seen to receive.';

  writeEvidence({
    testId: 'P8',
    name: 'caller-derivation',
    description: DESCRIPTION,
    verdict,
    txHash: sub.accepted ? sub.txId : undefined,
    errorCode: sub.accepted ? undefined : sub.errorCode,
    note:
      `${observedSentence} ${notObservedSentence} ` +
      `${detailSentence}${detailSentence ? ' ' : ''}` +
      `The Rust and TypeScript views of the same bytes ${crossChecksAgree ? 'agree on every address, entry point, communication commitment, and claim' : `DISAGREE: ${mismatches.join('; ')}`}; ` +
      `offline construction ${offlinePossible ? 'POSSIBLE (no node, no indexer)' : 'NOT possible, see details.offline.error'}; ` +
      (sub.accepted ? `submitted as ${String(sub.txId).slice(0, 16)}… (${sub.status}).` : `submission failed at ${sub.stage}: ${sub.errorCode}.`),
    details,
  });

  if (!expectationMet || !crossChecksAgree) {
    throw new Error(
      `caller derivation did not match the expectation or the two views disagree: ` +
      `${[...deviations, ...mismatches].join('; ')}`,
    );
  }
});
