// P9 — voluntary lending: can a contract hand its own identity to a call it
// never made?
//
// P8 establishes what the ledger DOES: at ledger-9.1.0.0-rc.3
// ContractCall::context derives CallContext.caller for each call frame from
// whichever OTHER ContractAction::Call in the same intent CLAIMS it — a
// ClaimedContractCallsValue matching the callee's (address, entry-point
// hash, communication commitment) — falling back to the single-distinct-
// owner rule over the intent's unshielded inputs, and to None otherwise.
//
// The claim is an effect a caller's transcript emits. The runtime emits it
// when a circuit makes a genuine cross-contract call, but the kernel
// primitive behind it, kernel.claimContractCall(addr, ep_hash, comm), takes
// wholly chosen arguments from Compact source and compiles on compactc
// 0.34.0. The Lender contract exports exactly that primitive on
// client-supplied arguments. If a transaction can pair a Lender.lend claim
// with an unrelated ROOT call in one intent, then any contract can nominate
// itself as the caller of any call, and "the caller is the contract that
// called me" is not a property a callee could ever rely on, even once
// upstream surfaces VM context slot 6 to Compact.
//
// Arms (select with P9_ARMS, default all four):
//
//   main       Tally.set(v) as a direct ROOT call plus Lender.lend claiming
//              it, grafted into ONE intent, claimant first. The open
//              question: accepted or refused, and at which stage.
//   control-a  the same with a WRONG commitment (comm + 1). Expected
//              refusal: effects_check's subset rule
//              (RealCallsSubsetCheckFailure) — no real call carries that
//              triple.
//   control-b  a Tally.set that is a GENUINE sub-call of
//              Caller.write_then_read AND is additionally claimed by
//              Lender in the same intent. Expected refusal:
//              effects_check's uniqueness rule
//              (ClaimedCallsUniquenessFailure) — two claimants, one triple.
//   control-c  the main composition with the actions in the other order
//              ([set, lend]). Expected refusal: call_sequencing_check
//              (CallSequencingViolation) — a claimed call must sit at a
//              strictly greater index than its claimant. This arm is what
//              makes the main arm's ordering a measurement rather than an
//              accident.
//
// Every arm records the stage of any refusal explicitly (construction /
// proving / balancing / submission / finality) alongside the classifier's
// reading, because the stage IS the finding.
//
// Privacy note: as in P8, UnsubmittedTxData is serialised deliberately, on a
// throwaway localnet with toy contracts carrying no secrets, because the
// bytes ARE the experiment's input.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

import { createUnprovenCallTx } from '@midnight-ntwrk/midnight-js-contracts';

import * as TallyModule from '../../contracts/managed/Tally/contract/index.js';
import * as CallerModule from '../../contracts/managed/Caller/contract/index.js';
import * as LenderModule from '../../contracts/managed/Lender/contract/index.js';

import { runScenario, step, sleep } from './runner.js';
import { writeEvidence, serialiseError, classifyCallError } from './evidence.js';
import {
  setupWallet,
  connectWitnessFree,
  deployWitnessFree,
  compiledWitnessFree,
  contractRefArg,
  loadDeployment,
  type ContractHandle,
} from '../node/setup.js';
import {
  tallyZkConfigPath,
  callerZkConfigPath,
  lenderZkConfigPath,
  type WalletContext,
} from '../node/wallet.js';
import { bytesToHex } from '../wallet/hex.js';
import {
  buildOfflineComposition,
  entryPointHashBytes,
  entryPointHashHex,
  findCall,
  graftIntoOneIntent,
  summariseTx,
} from './p9-compose.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_DIR = path.join(EXPERIMENT_ROOT, 'evidence');
// P8's tool, reused unchanged: rust/caller-context links midnight-ledger at
// the tag the wasm binding is built from and runs ContractCall::context over
// serialised transaction bytes.
const RUST_BIN = path.join(EXPERIMENT_ROOT, 'rust', 'caller-context', 'target', 'release', 'caller-context');
const RUST_TOOL =
  'rust/caller-context @ midnight-ledger ledger-9.1.0.0-rc.3 (4823b5351b17cc49e30f19760dbd30a73cf95e22)';
const require_crypto = () =>
  createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto');

const WATCH_TIMEOUT_MS = 120_000;
const DESCRIPTION =
  'Voluntary lending: a contract emits kernel.claimContractCall on client-supplied arguments for a call it never made, so the ledger derives it as that call\'s caller';

// Distinct written values per arm keep the arms distinguishable in the
// Tally ledger and in the indexer.
const V_MAIN = 7n;
const V_CONTROL_A = 11n;
const V_CONTROL_B = 13n;
const V_CONTROL_C = 17n;

const ALL_ARMS = ['main', 'control-a', 'control-b', 'control-c'] as const;
type Arm = (typeof ALL_ARMS)[number];
const ARMS: Arm[] = (process.env.P9_ARMS ?? ALL_ARMS.join(','))
  .split(',')
  .map((a) => a.trim())
  .filter((a): a is Arm => (ALL_ARMS as readonly string[]).includes(a));

// ── Serialisation helpers (P8's, so the Rust tool reads one format) ─────────

interface HexCapture {
  stage: string;
  file: string;
  bytes: number;
  sha256: string;
}

function writeHex(stage: string, raw: Uint8Array): HexCapture {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `p9-tx-${stage}.hex`);
  fs.writeFileSync(file, bytesToHex(raw).toLowerCase() + '\n');
  const sha256 = require_crypto().createHash('sha256').update(raw).digest('hex');
  console.log(
    `  ■ ${stage}: ${raw.length} bytes → ${path.relative(process.cwd(), file)} (sha256 ${sha256.slice(0, 16)}…)`,
  );
  return {
    stage,
    file: path.relative(path.resolve(__dirname, '..', '..'), file),
    bytes: raw.length,
    sha256,
  };
}

// ── Prove, balance, submit; record the exact stage of any refusal ───────────

interface Refusal {
  stage: string;
  classifier: string;
  errorCode: string;
  message: string;
  error: Record<string, unknown>;
  /** The node's own refusal, scraped from the RPC logger (see captureRpcLog). */
  nodeRpcLines?: string[];
  substrateCustomErrorCode?: number | null;
}

/**
 * The wallet SDK surfaces a node refusal as a bare "Transaction submission
 * error" with no cause detail, while the node's actual verdict arrives on
 * the @polkadot RPC logger, which writes straight to the console:
 *
 *   RPC-CORE: submitAndWatchExtrinsic(...): ExtrinsicStatus:: 1010:
 *   Invalid Transaction: Custom error: 212
 *
 * That line is the only place the node's code appears, and the codes are
 * what distinguish one refused control from another, so the console is
 * tapped for the duration of a submission and the matching lines recorded
 * verbatim alongside the SDK's error. Tapping is scoped to the call and the
 * original console functions still receive everything.
 *
 * What the codes MEAN is deliberately not asserted: Substrate's
 * InvalidTransaction::Custom(u8) mapping lives in the node, not in the
 * ledger crate this experiment pins, and no numbering appears in
 * midnight-ledger's MalformedTransaction. The codes are recorded as
 * observations, and what each control isolates is established by its
 * construction, not by decoding its code.
 */
async function captureRpcLog<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: any; lines: string[] }> {
  const lines: string[] = [];
  const originals: Record<string, (...a: any[]) => void> = {};
  for (const channel of ['log', 'error', 'warn', 'info'] as const) {
    originals[channel] = console[channel];
    console[channel] = (...args: any[]) => {
      const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
      if (/RPC-CORE|Invalid Transaction|Custom error/i.test(text)) lines.push(text.trim());
      originals[channel](...args);
    };
  }
  try {
    return { result: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    for (const channel of ['log', 'error', 'warn', 'info'] as const) {
      console[channel] = originals[channel] as any;
    }
  }
}

function substrateCustomErrorCode(lines: string[]): number | null {
  for (const line of lines) {
    const m = line.match(/custom error:\s*(\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

interface ArmOutcome {
  arm: string;
  expectation: string;
  built: boolean;
  graft?: Record<string, unknown>;
  composition?: Record<string, unknown>;
  hex?: HexCapture[];
  stageReached: 'construction' | 'proving' | 'balancing' | 'submission' | 'finality';
  accepted: boolean;
  txId?: string;
  status?: string | null;
  blockHeight?: number | null;
  refusal?: Refusal;
  timings?: Record<string, number>;
  balancedCaptureError?: Record<string, unknown>;
  submissionRpcLines?: string[];
}

async function proveBalanceSubmit(
  providers: any,
  tx: any,
  arm: string,
  outcome: ArmOutcome,
  captures: HexCapture[],
): Promise<void> {
  const timings: Record<string, number> = {};
  outcome.timings = timings;
  const label = arm === 'main' ? 'lend' : arm;

  const fail = (stage: ArmOutcome['stageReached'], e: any, rpcLines: string[] = []) => {
    const cls = classifyCallError(e);
    const code = substrateCustomErrorCode(rpcLines);
    outcome.stageReached = stage;
    outcome.accepted = false;
    outcome.refusal = {
      stage,
      classifier: cls.outcome,
      errorCode: cls.errorCode,
      message: String(e?.message ?? e).slice(0, 400),
      error: serialiseError(e),
      ...(rpcLines.length ? { nodeRpcLines: [...new Set(rpcLines)] } : {}),
      ...(code === null ? {} : { substrateCustomErrorCode: code }),
    };
    console.log(
      `  ${arm}: REFUSED at ${stage} — ${cls.errorCode}${code === null ? '' : ` (node: Custom error ${code})`}: ` +
        `${String(e?.message ?? e).slice(0, 160)}`,
    );
  };

  outcome.stageReached = 'proving';
  const t0 = performance.now();
  let proven: any;
  try {
    proven = await providers.proofProvider.proveTx(tx);
  } catch (e: any) {
    fail('proving', e);
    return;
  }
  timings.proveMs = Math.round(performance.now() - t0);
  const provenRaw: Uint8Array = proven.serialize();
  const cap = writeHex(label, provenRaw);
  captures.push(cap);
  (outcome.hex ??= []).push(cap);

  outcome.stageReached = 'balancing';
  const t1 = performance.now();
  let balanced: any;
  try {
    balanced = await providers.walletProvider.balanceTx(proven);
  } catch (e: any) {
    fail('balancing', e);
    return;
  }
  timings.balanceMs = Math.round(performance.now() - t1);
  try {
    const balancedCap = writeHex(`${label}-balanced`, balanced.serialize());
    captures.push(balancedCap);
    (outcome.hex ??= []).push(balancedCap);
  } catch (e: any) {
    outcome.balancedCaptureError = serialiseError(e);
  }

  outcome.stageReached = 'submission';
  const t2 = performance.now();
  const submission = await captureRpcLog<string>(() => providers.midnightProvider.submitTx(balanced));
  if (submission.error !== undefined) {
    fail('submission', submission.error, submission.lines);
    return;
  }
  const txId = submission.result as string;
  timings.submitMs = Math.round(performance.now() - t2);
  outcome.txId = txId;
  if (submission.lines.length) outcome.submissionRpcLines = [...new Set(submission.lines)];

  outcome.stageReached = 'finality';
  const t3 = performance.now();
  try {
    const finalized: any = await Promise.race([
      providers.publicDataProvider.watchForTxData(txId),
      sleep(WATCH_TIMEOUT_MS).then(() => ({ status: 'watch-timeout' })),
    ]);
    timings.finaliseMs = Math.round(performance.now() - t3);
    outcome.status = finalized?.status ?? null;
    outcome.blockHeight = finalized?.blockHeight ?? null;
    outcome.accepted = finalized?.status === 'SucceedEntirely';
    console.log(`  ${arm}: tx ${txId} · status ${outcome.status} · block ${outcome.blockHeight}`);
  } catch (e: any) {
    fail('finality', e);
  }
}

// ── The ledger's own derivation (rust/caller-context) ───────────────────────
//
// claimAudit() in p9-compose.ts is a TypeScript READING of verify.rs and is
// not evidence. This arm runs the ledger's OWN ContractCall::context over the
// captured bytes of every arm, and it is what answers P9's question: with the
// Lender the only claimant of a root Tally.set call, does the ledger resolve
// that call's caller to the Lender? The interfaces mirror P8's; the tool and
// its output shape are unchanged.

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
  claims: RustClaim[];
  claimed_by: Array<{
    action_index: number;
    address: string;
    entry_point: string;
    guaranteed: boolean;
    seq: number;
  }>;
  caller_selected_by_action_index: number | null;
  caller: string;
}

interface RustIntent {
  segment: number;
  actions: number;
  calls: RustCall[];
  anomalies: unknown[];
}

interface RustReport {
  input_file: string;
  input_encoding: string;
  input_bytes: number;
  header_tag: string;
  deserialised_as: string;
  transaction_kind: string;
  network_id: string;
  intents: RustIntent[];
}

class RustToolUnavailable extends Error {}

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

const sameAddress = (a: string, b: string): boolean =>
  a.replace(/^0x/, '').toLowerCase() === b.replace(/^0x/, '').toLowerCase();

interface DerivedCall {
  segment: number;
  actionIndex: number;
  entryPoint: string;
  address: string;
  caller: string;
  selectedByActionIndex: number | null;
  claimedBy: string[];
  claims: string[];
}

function derivedCalls(report: RustReport): DerivedCall[] {
  const rows: DerivedCall[] = [];
  for (const intent of report.intents) {
    for (const c of intent.calls) {
      rows.push({
        segment: intent.segment,
        actionIndex: c.action_index,
        entryPoint: c.entry_point,
        address: c.address,
        caller: c.caller,
        selectedByActionIndex: c.caller_selected_by_action_index,
        claimedBy: c.claimed_by.map(
          (b) => `#${b.action_index} ${b.entry_point}@${b.address.slice(0, 12)} (seq ${b.seq})`,
        ),
        claims: c.claims.map(
          (cl) =>
            `seq ${cl.seq} -> ${cl.address.slice(0, 12)}/${cl.ep_hash.slice(0, 12)}/${cl.communication_commitment.slice(0, 12)} ` +
            (cl.matches_action_index === null ? '(matches NO call)' : `(matches call #${cl.matches_action_index})`),
        ),
      });
    }
  }
  return rows;
}

// ── Arm construction ────────────────────────────────────────────────────────

interface Ctx {
  walletCtx: WalletContext;
  tally: ContractHandle;
  lender: ContractHandle;
  caller?: ContractHandle;
}

/** An unproven single-call transaction through the ordinary call path. */
async function unprovenCall(
  handle: ContractHandle,
  name: string,
  module: any,
  zkPath: string,
  circuitId: string,
  args: unknown[],
): Promise<any> {
  const unsubmitted: any = await createUnprovenCallTx(handle.providers, {
    compiledContract: compiledWitnessFree(name, module, zkPath),
    circuitId,
    contractAddress: handle.address,
    args,
  } as any);
  return unsubmitted.private.unprovenTx;
}

/**
 * The main arm and controls a and c: a direct ROOT Tally.set call, plus a
 * Lender.lend claiming its (address, ep_hash, comm) triple, in ONE intent.
 *
 * `commOffset` perturbs the commitment (control-a). `claimantFirst` decides
 * which transaction is the graft base, and hence whether the claimant sits
 * before the claimed call (the sequencing rule) or after it (control-c).
 */
async function composeLendOverRootSet(
  ctx: Ctx,
  value: bigint,
  commOffset: bigint,
  claimantFirst: boolean,
  outcome: ArmOutcome,
): Promise<any> {
  const setTx = await unprovenCall(
    ctx.tally, 'tally', TallyModule, tallyZkConfigPath, 'set', [value],
  );
  const setCall = findCall(setTx, ctx.tally.address, 'set');
  const comm = BigInt(setCall.commBigInt) + commOffset;
  const lendTx = await unprovenCall(
    ctx.lender, 'lender', LenderModule, lenderZkConfigPath, 'lend',
    [contractRefArg(ctx.tally.address), entryPointHashBytes('set'), comm],
  );
  const composition: Record<string, unknown> = {
    setCall: {
      address: setCall.address,
      entryPoint: setCall.entryPoint,
      entryPointHash: setCall.entryPointHash,
      communicationCommitment: setCall.communicationCommitment,
      commBigInt: setCall.commBigInt,
    },
    commitmentHandedToLender: comm.toString(),
    commitmentOffset: commOffset.toString(),
    claimantFirst,
  };
  // The graft base keeps its own actions first: base = the lend transaction
  // puts the claimant at index 0 (the sequencing rule wants the claimed call
  // later); base = the set transaction inverts that, which is control-c.
  const base = claimantFirst ? lendTx : setTx;
  const donor = claimantFirst ? setTx : lendTx;
  const graft = graftIntoOneIntent(base, donor, 'append');
  outcome.graft = { accepted: true, segment: graft.segment, order: graft.order };
  composition.merged = summariseTx(graft.tx);
  outcome.composition = composition;
  return graft.tx;
}

/** control-b: a genuine sub-call of write_then_read, additionally claimed. */
async function composeDoubleClaim(ctx: Ctx, value: bigint, outcome: ArmOutcome): Promise<any> {
  const callerTx = await unprovenCall(
    ctx.caller!, 'caller', CallerModule, callerZkConfigPath, 'write_then_read', [value],
  );
  const subSet = findCall(callerTx, ctx.tally.address, 'set');
  const root = findCall(callerTx, ctx.caller!.address, 'write_then_read');
  const composition: Record<string, unknown> = {
    subCall: {
      address: subSet.address,
      entryPoint: subSet.entryPoint,
      entryPointHash: subSet.entryPointHash,
      communicationCommitment: subSet.communicationCommitment,
      commBigInt: subSet.commBigInt,
      indexBeforeGraft: subSet.index,
    },
    alreadyClaimedBy: `${root.entryPoint}@${root.address.slice(0, 12)}`,
    subCallCommitmentReadableFromUnprovenTx: true,
  };
  const lendTx = await unprovenCall(
    ctx.lender, 'lender', LenderModule, lenderZkConfigPath, 'lend',
    [contractRefArg(ctx.tally.address), entryPointHashBytes('set'), BigInt(subSet.commBigInt)],
  );
  // PREPEND the lend call: the claimed sub-call must keep a strictly greater
  // index than BOTH claimants, so the order becomes
  // [lend, write_then_read, set, get] and only the uniqueness rule is left
  // to fire.
  const graft = graftIntoOneIntent(callerTx, lendTx, 'prepend');
  outcome.graft = { accepted: true, segment: graft.segment, order: graft.order };
  composition.merged = summariseTx(graft.tx);
  outcome.composition = composition;
  return graft.tx;
}

// ── The probe ───────────────────────────────────────────────────────────────

await runScenario('p9-lending', async () => {
  const details: Record<string, unknown> = {};
  const captures: HexCapture[] = [];
  details.hexFiles = captures;
  details.armsRequested = ARMS;
  details.entryPointHashes = {
    set: entryPointHashHex('set'),
    get: entryPointHashHex('get'),
    write_then_read: entryPointHashHex('write_then_read'),
    lend: entryPointHashHex('lend'),
  };
  details.kernelPrimitive = {
    declaredSignature:
      'kernel.claimContractCall(addr: Bytes<32>, ep_hash: Bytes<32>, comm: Field): []',
    establishedFrom:
      'compactc 0.34.0 diagnostics: zero arguments gives "Kernel claimContractCall requires 3 arguments but received 0"; a ContractAddress struct in position 1 gives "expected first argument of claimContractCall to have type Bytes<32> but received struct ContractAddress<bytes: Bytes<32>>"; a Uint<64> gives "expected second argument ... to have type Bytes<32>" and "expected third argument ... to have type Field"',
    disclosureRequired:
      'all three arguments need disclose(): "ledger operation might disclose the address of a contract being called"',
    ledgerWriteRequired:
      'no: a claim-only circuit with no ledger field compiles. Lender.lends is a harness convention (EXPERIMENT_GUIDELINE: every probe circuit changes public state, because a zero-effect call can hang the wallet SDK finalisation watch).',
  };

  step('offline arm: compose the claim and the claimed call with no node and no indexer');
  const offlineRaw = await buildOfflineComposition(details, V_MAIN);
  if (offlineRaw) captures.push(writeHex('offline-composed', offlineRaw));

  step('wallet, the deployed Tally, and the Lender');
  const walletCtx = await setupWallet();
  const tally: ContractHandle = await connectWitnessFree(walletCtx, {
    name: 'tally',
    module: TallyModule,
    zkPath: tallyZkConfigPath,
  });
  const lenderRecorded = loadDeployment('lender');
  const lender: ContractHandle = lenderRecorded
    ? await connectWitnessFree(walletCtx, {
        name: 'lender',
        module: LenderModule,
        zkPath: lenderZkConfigPath,
      })
    : await deployWitnessFree(walletCtx, {
        name: 'lender',
        module: LenderModule,
        zkPath: lenderZkConfigPath,
      });
  details.tallyAddress = tally.address;
  details.lenderAddress = lender.address;
  details.lenderDeployment = lenderRecorded
    ? `connected to the recorded deployment ${lenderRecorded.slice(0, 12)}…`
    : "deployed in this run and recorded in deployment.json as 'lender'";
  console.log(`  tally @ ${tally.address.slice(0, 16)}… · lender @ ${lender.address.slice(0, 16)}…`);

  const tallyBefore = await tally.ledgerState();
  const lenderBefore = await lender.ledgerState();
  details.before = {
    tally: { total: tallyBefore.total, writes: tallyBefore.writes },
    lender: { lends: lenderBefore.lends },
  };

  const ctx: Ctx = { walletCtx, tally, lender };
  const outcomes: Record<string, ArmOutcome> = {};
  details.arms = outcomes;

  const runArm = async (
    arm: Arm,
    expectation: string,
    compose: (outcome: ArmOutcome) => Promise<any>,
  ): Promise<ArmOutcome | null> => {
    if (!ARMS.includes(arm)) return null;
    step(`arm ${arm}: ${expectation}`);
    const outcome: ArmOutcome = {
      arm,
      expectation,
      built: false,
      stageReached: 'construction',
      accepted: false,
    };
    outcomes[arm] = outcome;
    let tx: any;
    try {
      tx = await compose(outcome);
      outcome.built = true;
    } catch (e: any) {
      const cls = classifyCallError(e);
      outcome.refusal = {
        stage: 'construction',
        classifier: cls.outcome,
        errorCode: cls.errorCode,
        message: String(e?.message ?? e).slice(0, 400),
        error: serialiseError(e),
      };
      console.log(`  ${arm}: REFUSED at construction — ${String(e?.message ?? e).slice(0, 200)}`);
      return outcome;
    }
    await proveBalanceSubmit(lender.providers, tx, arm, outcome, captures);
    return outcome;
  };

  // ── main ──────────────────────────────────────────────────────────────────
  const main = await runArm(
    'main',
    'Lender.lend claims a direct ROOT Tally.set call in the same intent (claimant first)',
    (o) => composeLendOverRootSet(ctx, V_MAIN, 0n, true, o),
  );

  // The ledger's own caller derivation runs after every arm, over all the
  // captures at once (see the "caller derivation" step below).

  // ── control-a: wrong commitment ───────────────────────────────────────────
  await runArm(
    'control-a',
    'the same composition with comm + 1 — expected refusal by the effects_check subset rule',
    (o) => composeLendOverRootSet(ctx, V_CONTROL_A, 1n, true, o),
  );

  // ── control-b: two claimants on one triple ────────────────────────────────
  if (ARMS.includes('control-b')) {
    try {
      ctx.caller = await connectWitnessFree(walletCtx, {
        name: 'caller',
        module: CallerModule,
        zkPath: callerZkConfigPath,
      });
      details.callerAddress = ctx.caller.address;
    } catch (e: any) {
      details.controlBSetupError = serialiseError(e);
    }
    if (ctx.caller) {
      await runArm(
        'control-b',
        'a genuine write_then_read sub-call ALSO claimed by Lender — expected refusal by the uniqueness rule',
        (o) => composeDoubleClaim(ctx, V_CONTROL_B, o),
      );
    } else {
      outcomes['control-b'] = {
        arm: 'control-b',
        expectation: 'two claimants on one triple',
        built: false,
        stageReached: 'construction',
        accepted: false,
        refusal: {
          stage: 'construction',
          classifier: 'inconclusive',
          errorCode: 'caller-not-available',
          message: 'could not connect to the deployed Caller — see details.controlBSetupError',
          error: {},
        },
      };
    }
  }

  // ── control-c: the claimant AFTER the claimed call ────────────────────────
  await runArm(
    'control-c',
    'the main composition ordered [set, lend] — expected refusal by call_sequencing_check',
    (o) => composeLendOverRootSet(ctx, V_CONTROL_C, 0n, false, o),
  );

  // ── The ledger's own caller derivation over every capture ─────────────────
  step("run the ledger's OWN ContractCall::context derivation over every capture (rust/caller-context)");
  const derivation: Record<string, unknown> = {
    tool: RUST_TOOL,
    what:
      "the ledger's own ContractCall::context(...).caller at ledger-9.1.0.0-rc.3, run off-node over the bytes " +
      'this run captured. NOT a node evaluating a slot-6 read: Compact has no reader for context slot 6, so ' +
      'these are the values the ledger computes and marshals into that slot, not values a contract was seen to receive.',
    lenderAddress: lender.address,
    tallyAddress: tally.address,
  };
  details.rustCallerDerivation = derivation;
  const runs: Array<Record<string, unknown>> = [];
  derivation.runs = runs;
  // Only the MAIN arm's captures answer the lending question; a control's
  // set call is expected NOT to resolve to the Lender, and its resolution is
  // recorded per run rather than folded into the aggregate.
  const MAIN_STAGES = ['lend', 'lend-balanced'];
  const lendingConfirmedOn: string[] = [];
  const lendingContradictedOn: string[] = [];
  const controlResolutions: Array<Record<string, unknown>> = [];

  // Each capture belongs to an arm, and the arm carries the node's verdict on
  // those very bytes; carrying it into the derivation keeps the two halves of
  // the finding (what the ledger derives, what the node did) side by side.
  const nodeOutcomeFor = (stage: string): Record<string, unknown> => {
    const armName = stage.replace(/-balanced$/, '');
    const arm = armName === 'lend' ? 'main' : armName;
    const o = outcomes[arm as Arm];
    if (!o) {
      return { submitted: false, note: 'built offline; never submitted' };
    }
    return {
      arm,
      submitted: o.stageReached === 'submission' || o.stageReached === 'finality',
      accepted: o.accepted,
      txId: o.txId ?? null,
      status: o.status ?? null,
      blockHeight: o.blockHeight ?? null,
      refusedAt: o.refusal?.stage ?? null,
      errorCode: o.refusal?.errorCode ?? null,
      substrateCustomErrorCode: o.refusal?.substrateCustomErrorCode ?? null,
    };
  };
  try {
    for (const cap of captures) {
      const { report, text } = runRustTool(cap.file);
      const perCall = derivedCalls(report);
      const anomalies = report.intents
        .filter((i) => (i.anomalies ?? []).length > 0)
        .map((i) => ({ segment: i.segment, anomalies: i.anomalies }));
      // The question P9 asks, per capture: with the Lender the only claimant,
      // what does the ledger resolve the Tally.set call's caller to?
      const setRows = perCall.filter(
        (r) => r.entryPoint === 'set' && sameAddress(r.address, tally.address),
      );
      const expected = `Contract(${lender.address.replace(/^0x/, '').toLowerCase()})`;
      const lentTo = setRows.map((r) => r.caller);
      const lendingHeld = setRows.length > 0 && setRows.every((r) => r.caller === expected);
      if (setRows.length > 0) {
        if (MAIN_STAGES.includes(cap.stage)) {
          (lendingHeld ? lendingConfirmedOn : lendingContradictedOn).push(cap.stage);
        } else {
          controlResolutions.push({ stage: cap.stage, setCallCaller: lentTo, matchesTheLender: lendingHeld });
        }
      }
      // Where one call is claimed by more than one other, which claimant did
      // the ledger's find_map take? This is the control-b question, and the
      // answer is a property of action ORDER rather than of who really made
      // the call.
      const contestedCalls = perCall
        .filter((r) => r.claimedBy.length > 1)
        .map((r) => ({
          call: `#${r.actionIndex} ${r.entryPoint}@${r.address.slice(0, 12)}`,
          claimedBy: r.claimedBy,
          selectedByActionIndex: r.selectedByActionIndex,
          caller: r.caller,
        }));
      runs.push({
        stage: cap.stage,
        file: cap.file,
        bytes: cap.bytes,
        sha256: cap.sha256,
        nodeOutcome: nodeOutcomeFor(cap.stage),
        deserialisedAs: report.deserialised_as,
        headerTag: report.header_tag,
        perCall,
        setCallCaller: lentTo,
        expectedIfLendingHolds: expected,
        lendingHeld,
        contestedCalls,
        claimGraphObservations: anomalies,
        verbatimOutput: text,
      });
      for (const r of perCall) {
        console.log(
          `  [${cap.stage}] seg ${r.segment} #${r.actionIndex} ${r.entryPoint}@${r.address.slice(0, 12)} ` +
            `→ caller ${r.caller}${r.selectedByActionIndex === null ? '' : ` (selected by #${r.selectedByActionIndex})`}`,
        );
      }
    }
    derivation.lendingConfirmedOn = lendingConfirmedOn;
    derivation.lendingContradictedOn = lendingContradictedOn;
    derivation.controlResolutions = controlResolutions;
    derivation.lendingConfirmed = lendingConfirmedOn.length > 0 && lendingContradictedOn.length === 0;
  } catch (e: any) {
    derivation.error = serialiseError(e);
    derivation.lendingConfirmed = false;
    console.log(`  caller derivation NOT run: ${e?.message ?? e}`);
  }

  // ── What the run establishes, stated against what it observed ─────────────
  //
  // Built from the observations rather than asserted: each line is present
  // only when the run actually produced the observation behind it.
  const interpretation: Record<string, unknown> = {};
  details.interpretation = interpretation;
  {
    // The same contested call appears in a capture and in its balanced twin;
    // report each distinct shape once.
    const contested = [
      ...new Map(
        runs
          .flatMap((r) => ((r as any).contestedCalls ?? []) as Array<Record<string, unknown>>)
          .map((c) => [JSON.stringify(c), c]),
      ).values(),
    ];
    const refusedControls = ALL_ARMS.filter((a) => a !== 'main' && outcomes[a] && !outcomes[a].accepted).map(
      (a) => ({
        arm: a,
        stage: outcomes[a].refusal?.stage,
        code: outcomes[a].refusal?.substrateCustomErrorCode ?? null,
      }),
    );
    if (derivation.lendingConfirmed === true && main?.accepted) {
      interpretation.lending =
        'A contract that exports a chosen-argument claim circuit can name itself the caller of a root call ' +
        'composed with it in the same intent. The node admitted the composition and the ledger derives that ' +
        `call's caller as Contract(<Lender>).`;
      interpretation.voluntaryNotForgery =
        'This is voluntary lending by the Lender, not forgery by a third party. The claim is an effect of the ' +
        "Lender's own transcript, it reaches the first public input of the Lender's proof, and a contract that " +
        'exports no such circuit cannot be made to emit one. What a claim circuit gives away is the exclusive ' +
        'right to be the contract the ledger names as the caller of a call in the same intent.';
      interpretation.rootCallerIsDecidedByComposition =
        'The claimed call here is a ROOT call, made directly by the client rather than by any circuit of the ' +
        'claimant. The ledger nonetheless derives its caller as the claimant, so a callee reading slot 6 would ' +
        'see a contract that did not call it. Correspondingly, the Lender call itself resolves to None.';
    }
    if (contested.length) {
      interpretation.actionOrderDecidesTheWinner =
        'Where one call is claimed twice, the ledger takes the FIRST claimant in action order (find_map over ' +
        `intent.actions): ${JSON.stringify(contested)}. A second claimant placed earlier therefore supersedes the ` +
        'contract that genuinely made the call, in the derivation. The uniqueness rule is what stops such a ' +
        'transaction reaching a block, so the integrity of the Contract arm rests on that check rather than on the ' +
        'derivation.';
    }
    if (refusedControls.length) {
      interpretation.enforcementIsAtTheNode =
        'Every control was built, proven, balanced, and submitted; the refusals came from the node: ' +
        `${JSON.stringify(refusedControls)}. Nothing in the client refused these compositions, and the ` +
        'caller-derivation tool never refuses anything, so the checks that discipline claims are observable only ' +
        'as a submission verdict.';
    }
    if (outcomes['control-c']) {
      interpretation.derivationIgnoresSequencing =
        'The derivation tool runs ContractCall::context alone and never runs well_formed, so it resolves a caller ' +
        'for control-c (claimant AFTER the claimed call) as readily as for the main arm. The node refused those ' +
        'bytes. A caller value read off unverified bytes therefore means nothing on its own: the sequencing, ' +
        'subset, and uniqueness checks are what make the derivation meaningful, and they live at admission.';
    }
    interpretation.notObserved =
      'No node was observed evaluating a slot-6 read, because Compact has no reader for context slot 6 and no ' +
      'circuit in this experiment reads it. The caller values here are what the ledger computes and marshals into ' +
      'that slot, established by running the ledger\'s own ContractCall::context off-node over the submitted bytes.';
    interpretation.errorCodeMapping =
      'The node reports its refusals as Substrate InvalidTransaction::Custom(u8) codes. The mapping from code to ' +
      'named check is not established here: it lives in the node, and midnight-ledger carries no numbering for ' +
      'MalformedTransaction. What each control isolates is established by its construction, not by its code.';
  }

  // ── State after ───────────────────────────────────────────────────────────
  step('ledger state after the arms');
  try {
    const tallyAfter = await tally.ledgerState();
    const lenderAfter = await lender.ledgerState();
    details.after = {
      tally: { total: tallyAfter.total, writes: tallyAfter.writes },
      lender: { lends: lenderAfter.lends },
    };
    details.stateMoved = {
      tallyWrites: `${tallyBefore.writes} → ${tallyAfter.writes}`,
      lenderLends: `${lenderBefore.lends} → ${lenderAfter.lends}`,
    };
    console.log(
      `  tally.total ${tallyBefore.total} → ${tallyAfter.total} ` +
      `(writes ${tallyBefore.writes} → ${tallyAfter.writes}) · ` +
      `lender.lends ${lenderBefore.lends} → ${lenderAfter.lends}`,
    );
  } catch (e: any) {
    details.afterError = serialiseError(e);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const mainAccepted = main?.accepted === true;
  const mainRefused = main != null && main.accepted === false && main.refusal != null;
  const controlSummary = ALL_ARMS.filter((a) => a !== 'main' && outcomes[a])
    .map((a) => {
      const o = outcomes[a];
      const code = o.refusal?.substrateCustomErrorCode;
      return o.accepted
        ? `${a}: ACCEPTED (unexpected — ${o.status})`
        : `${a}: refused at ${o.refusal?.stage}${code === undefined ? '' : `, node Custom error ${code}`}`;
    })
    .join('; ');

  const lendingConfirmed = derivation.lendingConfirmed === true;
  const verdict = mainAccepted ? (lendingConfirmed ? 'PASS' : 'PARTIAL') : mainRefused ? 'PASS' : 'BLOCKED';
  const note = mainAccepted
    ? lendingConfirmed
      ? `Voluntary lending WORKS: a Lender contract claiming a root Tally.set call it never made landed on node 2.1.0, ` +
        `and the ledger's own derivation resolves that call's caller to Contract(<Lender>). ` +
        `The Lender exports kernel.claimContractCall on wholly client-supplied arguments; the two calls were composed ` +
        `into ONE intent, claimant first, proven, and submitted as tx ${String(main?.txId).slice(0, 16)}… ` +
        `(${main?.status}). The Lender's own call resolves to None, so the identity is lent rather than shared. This is ` +
        `the Lender consenting, not a third party forging: the claim is an effect of the Lender's own proven ` +
        `transcript, and a contract exporting no such circuit cannot be made to lend. Confirmed on ` +
        `${lendingConfirmedOn.join(' and ')}; the derivation is off-node, because no circuit can read slot 6. ` +
        `Controls: ${controlSummary || 'none run'}.`
      : `The composition LANDED (tx ${String(main?.txId).slice(0, 16)}…, ${main?.status}) but the ledger's own ` +
        `derivation does NOT resolve Tally.set's caller to the Lender on ${lendingContradictedOn.join(', ') || 'any capture'}: ` +
        `see details.rustCallerDerivation. Controls: ${controlSummary || 'none run'}.`
    : mainRefused
      ? `Voluntary lending was REFUSED at ${main?.refusal?.stage} (${main?.refusal?.errorCode}): ` +
        `${main?.refusal?.message.slice(0, 160)}. The graft itself ` +
        `${main?.graft ? 'WAS accepted by the TypeScript/wasm binding' : 'was refused at construction'}; the refusal ` +
        `stage is the finding. Controls: ${controlSummary || 'none run'}.`
      : `The main arm did not reach a submission verdict (stage ${main?.stageReached ?? 'not run'}); ` +
        `see details.arms.main. Controls: ${controlSummary || 'none run'}.`;

  writeEvidence({
    testId: 'P9',
    name: 'lending',
    description: DESCRIPTION,
    verdict,
    txHash: mainAccepted ? main?.txId : undefined,
    errorCode: mainAccepted ? undefined : main?.refusal?.errorCode,
    note,
    details,
  });
});
