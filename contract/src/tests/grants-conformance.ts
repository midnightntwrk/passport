// Scoped-grants conformance on node — the E2 experiment of the scoped-grants
// MIP. Testing items 1, 2, 3, 6, 9, 10, and 11 against a live ledger-9
// localnet, driven entirely through the stage-two wallet grant surface
// (signer.ts, account.ts, wave-deploy.ts).
//
// Scenario, in order:
//
//   S0  setup + wave deploy of a k256-born account (Testing 6, less the
//       spec_version = 1 control, which needs a v1 build this tree does not
//       carry); the maintenance authority is read back from chain and shown
//       retired, and the authority counter is recorded per wave.
//   S1  cross-arm enrolment: the k256 owner device enrols a jubjub device,
//       so both device arms can issue on node.
//   S2  issuance of five grants across both device arms and both grantee
//       arms (Testing 1, first half).
//   S3  funding: mint, deposit_shielded, capture the qualified coin.
//   S4  the first grant shielded spend, with the change entry appended in
//       the SAME transaction (Testing 1, 10; GR-1, GR-5, GR-12, GR-13,
//       INV-4). The change coin's description is predicted before the call
//       from the standard library's nonce evolution and checked against the
//       coin the circuit returns.
//   S5  consecutive nonces under one grant, then a spend on the other
//       grantee arm (Testing 9, partial).
//   S6  the rejection matrix, each item a build-time abort with no
//       transaction and no state change (Testing 2; GR-2..GR-7, GR-9,
//       GR-14; the authorisation MIP's S10).
//   S7  owner liveness (Testing 3; GR-5, AUTH-8).
//   S8  direct transfer under a grant: the contract-recipient twin composed
//       with the payee's claim in one transaction (Testing 10).
//   S9  kill totality (Testing 11; GR-9).
//   S11 grantee-key validation on both arms: the identity in both encodings
//       the k256 type admits, an off-curve pair, a point of another curve of
//       the same shape, the JubJub identity, a small-order point, an
//       off-curve JubJub pair, each arm's key against the other arm's twin,
//       and a device key issued as a grantee (Testing 2's key rows; GR-14,
//       GR-4, GR-2; section 3.3).
//   S12 the expiry rows on the grant twins themselves: `expires_at = 0` and
//       `expires_at = head + 3600` both spending on node, the transcripts
//       read back to show which one records a block-time read, and an expiry
//       inside the admission margin (Testing 1's expiry half; GR-7; E3).
//   S13 composition: revoke plus issue over one id, batch issuance, and two
//       grant calls under one grant, each in ONE transaction, with the
//       reordered pair as the negative control (Testing 9; GR-5, GR-11,
//       GR-13).
//   S14 concurrency: the owner and a grantee over one coin, and Testing
//       item 3 leg (b) re-run with the ORIGINAL pre-deposit signature
//       (Testing 10; INV-5; AUTH-8).
//   S10 the proving-time table. It runs LAST, after S11 to S14, so the table
//       covers every proof of the run; the number is the one the first run
//       gave it and the group order in GRANTS_E2_GROUPS keeps it at the end.
//
// Every proof is timed at `providers.proofProvider.proveTx`, and every
// logical call is timed end to end (build + prove + submit).
//
// S12, S13, and S14 need three things the high-level client hides: the stage
// a call failed at, a submission with no rebuild, and two calls on ONE
// contract in one transaction. See the helper block below `Held`.

import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';

import {
  transientHash,
  degradeToTransient,
  upgradeFromTransient,
  convertBytesToUint,
  CompactTypeVector,
  CompactTypeField,
  ChargedState,
} from '@midnight-ntwrk/compact-runtime';
import { ContractState, Transaction } from '@midnightntwrk/ledger-v9';
import {
  createUnprovenCallTx,
  createUnprovenCallTxFromInitialStates,
  submitTx,
} from '@midnight-ntwrk/midnight-js-contracts';
import { parseCoinPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { rawTokenType, encodeRawTokenType } from '@midnightntwrk/ledger-v9';

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, serialiseError, type Verdict } from './evidence.js';
import { mintToUser, userCoinPublicKey, expectAbort, type MintedCoin } from './flow.js';
import {
  setupWallet,
  deployFaucet,
  deployAccount,
  compiledAccountContract,
  type TestContext,
  type FaucetHandle,
} from '../node/setup.js';
import { CONFIG } from '../node/wallet.js';
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
  jubjubChallenges,
  k256Challenges,
  grantAuthArgs,
  authArgs,
  scopeArgs,
  scopeDigest,
  RECIPIENT_ZSWAP_COIN_PUBLIC_KEY,
  RECIPIENT_CONTRACT_ADDRESS,
  K256_ENVELOPE_CONNECTOR,
  K256_ENVELOPE_NONE,
  type AnyGrantee,
  type GrantOpening,
  type GrantContext,
  type JubjubAuthorisation,
} from '../wallet/signer.js';
import { planWaves, allCircuits, VERIFIER_BYTE_BUDGET } from '../wallet/wave-deploy.js';
import {
  generateEncKeyPair,
  sealInboxEntry,
  openInboxEntry,
  type EncKeyPair,
  type PlainCoin,
} from '../wallet/inbox.js';
import { candidateIndices, enumerateContractActions, indexerUrl } from '../wallet/capture.js';
import { bytesToHex, hexToBytes32 } from '../wallet/hex.js';
import { pureCircuits } from '../wallet/contract.js';
import type { ShieldedCoin, Ledger, JubjubPoint, Secp256k1Point } from '../wallet/contract.js';

// ── Instrumentation ─────────────────────────────────────────────────────────
//
// The proof provider is the only place a proof is built, so wrapping
// `proveTx` gives every proof's wall time. The circuit id is read from the
// unproven transaction where the SDK exposes it and, in every case, from the
// label the suite sets around the call — the label is authoritative, the
// extracted ids are a cross-check.

interface ProofRecord {
  label: string;
  circuits: string[];
  ms: number;
  ok: boolean;
}

interface CallRecord {
  label: string;
  ms: number;
  ok: boolean;
  note?: string;
}

const proofLog: ProofRecord[] = [];
const callLog: CallRecord[] = [];
let currentLabel = '(outside a labelled call)';

function circuitIdsOf(tx: any): string[] {
  const out: string[] = [];
  try {
    const intents = tx?.intents;
    const values = intents instanceof Map ? [...intents.values()] : Object.values(intents ?? {});
    for (const intent of values as any[]) {
      const actions = intent?.actions ?? intent?.guaranteedCoins ?? [];
      for (const action of actions as any[]) {
        const ep = action?.entryPoint ?? action?.entry_point;
        if (ep === undefined || ep === null) continue;
        out.push(
          typeof ep === 'string'
            ? ep
            : Buffer.from(ep as Uint8Array).toString('utf8').replace(/\0+$/, ''),
        );
      }
    }
  } catch {
    // best effort only; the label carries the attribution
  }
  return out;
}

function instrumentProofProvider(providers: any, tag: string): void {
  const pp = providers?.proofProvider;
  if (!pp || typeof pp.proveTx !== 'function' || (pp as any).__instrumented) return;
  const original = pp.proveTx.bind(pp);
  pp.proveTx = async (unprovenTx: any, config?: any) => {
    const circuits = circuitIdsOf(unprovenTx);
    const t0 = Date.now();
    try {
      const r = await original(unprovenTx, config);
      proofLog.push({ label: currentLabel, circuits, ms: Date.now() - t0, ok: true });
      return r;
    } catch (e) {
      proofLog.push({ label: currentLabel, circuits, ms: Date.now() - t0, ok: false });
      throw e;
    }
  };
  (pp as any).__instrumented = true;
  console.log(`  proof provider instrumented (${tag})`);
}

/**
 * The proof server is the run's memory ceiling: a k = 17 grant proof holds
 * about 3 GiB, and two of them in flight (the composed direct transfer of
 * S8 proves two circuits) exhausts the Docker VM and the container is
 * OOM-killed (exit 137), after which every later call fails with
 * `connect ECONNREFUSED 127.0.0.1:6300`. A restart is lossless — the
 * prover holds no state — so the suite restarts it rather than letting one
 * crash take the remaining groups with it. Each restart is recorded.
 */
const proverRestarts: Array<{ label: string; at: string }> = [];

async function proverHealthy(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:6300/health', { signal: AbortSignal.timeout(3_000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureProver(label: string): Promise<void> {
  if (await proverHealthy()) return;
  console.log(`  ⚠ proof server not answering before "${label}" — restarting it`);
  proverRestarts.push({ label, at: new Date().toISOString() });
  try {
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve) => {
      execFile('docker', ['start', 'account-custody-reference-proof-server-1'], () => resolve());
    });
  } catch { /* fall through to the wait below */ }
  for (let i = 0; i < 60; i++) {
    if (await proverHealthy()) {
      console.log('  ✓ proof server back up');
      return;
    }
    await sleep(2_000);
  }
  throw new Error('proof server did not come back up');
}

/** Recycle the prover deliberately, to hand a memory-heavy call a fresh
 *  process (it caches several GiB across proofs). */
async function restartProver(label: string): Promise<void> {
  console.log(`  recycling the proof server before ${label} (it caches several GiB across proofs)`);
  proverRestarts.push({ label: `deliberate: ${label}`, at: new Date().toISOString() });
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve) => {
    execFile('docker', ['restart', 'account-custody-reference-proof-server-1'], () => resolve());
  });
  for (let i = 0; i < 60; i++) {
    if (await proverHealthy()) return;
    await sleep(2_000);
  }
  throw new Error('proof server did not come back up after a deliberate restart');
}

/**
 * True when a failure is the proof SERVER rather than the witness: a dead or
 * restarting container answers with a fetch failure, and treating that as "this
 * candidate index is wrong" silently burns the right candidate (it cost a run).
 */
function proverOutage(message: string): boolean {
  // Both halves, so that a 400 from a live prover (an unsatisfiable witness,
  // which is a real verdict about the candidate) is never read as an outage.
  return /:6300|proof server|'prove' returned an error/i.test(message)
    && /FetchError|ECONNREFUSED|fetch failed|socket hang up|ECONNRESET|network timeout|EAI_AGAIN/i.test(message);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  await ensureProver(label);
  const previous = currentLabel;
  currentLabel = label;
  const t0 = Date.now();
  try {
    // A proof-server outage is not a verdict about the call: proving precedes
    // balancing and submission, so nothing can have reached the chain when one
    // happens. Restore the container and run the same call again. Deploys are
    // excluded: re-running one would deploy a second contract.
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fn();
        callLog.push({ label, ms: Date.now() - t0, ok: true });
        return r;
      } catch (e: any) {
        const message = String(e?.message ?? e);
        if (attempt >= 2 || label.startsWith('deploy:') || !proverOutage(message)) throw e;
        console.log(`  (the proof server dropped during "${label}"; restoring it and running the call again)`);
        proverRestarts.push({ label: `outage during: ${label}`, at: new Date().toISOString() });
        await ensureProver(label);
      }
    }
  } catch (e: any) {
    callLog.push({ label, ms: Date.now() - t0, ok: false, note: String(e?.message ?? e).slice(0, 160) });
    throw e;
  } finally {
    currentLabel = previous;
  }
}

/** Tee console.log into `sink` while the thunk runs. */
async function withConsoleCapture<T>(sink: string[], fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    sink.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original(...args);
  };
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

// ── The standard library's nonce evolution (MIP section 6.5) ────────────────
//
// `send` derives both output coins' nonces from the input coin's nonce by
// the kernel's nonce-evolution rule, so a grantee CAN precompute the change
// coin's description before it proves. The two tags and the widths below are
// read off the compiled contract (contracts/managed/account/contract/
// index.js, the inlined `send`): the sent coin evolves under
// "midnight:kernel:nonce_evolve" (28 bytes) and the change coin under
// "midnight:kernel:nonce_evolve/2" (30 bytes), each hashed transiently with
// the degraded input nonce. Predicting it is what makes the same-transaction
// change append of Testing 10 realisable: the entry must be sealed BEFORE
// the grantee signs, since the challenge binds it.

const FIELD_MAX =
  52435875175126190479447740508185965837690552500527637822603658699938581184512n;
const NONCE_EVOLVE_SENT = 'midnight:kernel:nonce_evolve';
const NONCE_EVOLVE_CHANGE = 'midnight:kernel:nonce_evolve/2';
const VECTOR2_FIELD = new CompactTypeVector(2, CompactTypeField);

function evolveNonce(tag: string, nonce: Uint8Array): Uint8Array {
  const tagBytes = new TextEncoder().encode(tag);
  return upgradeFromTransient(
    transientHash(VECTOR2_FIELD as any, [
      convertBytesToUint(FIELD_MAX, tagBytes.length, tagBytes, 'Field', '<standard library>'),
      degradeToTransient(nonce),
    ] as any),
  );
}

const predictChangeCoin = (coin: PlainCoin, amount: bigint): PlainCoin => ({
  nonce: evolveNonce(NONCE_EVOLVE_CHANGE, coin.nonce),
  color: coin.color,
  value: coin.value - amount,
});

const predictSentCoin = (coin: PlainCoin, amount: bigint): PlainCoin => ({
  nonce: evolveNonce(NONCE_EVOLVE_SENT, coin.nonce),
  color: coin.color,
  value: amount,
});

// ── Small helpers ───────────────────────────────────────────────────────────

const rnd32 = (): Uint8Array => new Uint8Array(randomBytes(32));
const eq = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const short = (b: Uint8Array): string => bytesToHex(b).slice(0, 16) + '…';

interface LedgerSnapshot {
  round: string;
  authNonce: string;
  inboxCount: string;
  deviceCount: string;
  grantGeneration: string;
  grantCount: string;
}

async function snapshot(account: CustodyAccount): Promise<LedgerSnapshot> {
  const l = await account.ledgerState();
  return {
    round: l.round.toString(),
    authNonce: l.auth_nonce.toString(),
    inboxCount: l.inbox_count.toString(),
    deviceCount: l.device_count.toString(),
    grantGeneration: l.grant_generation.toString(),
    grantCount: l.grants.size().toString(),
  };
}

function sameSnapshot(a: LedgerSnapshot, b: LedgerSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function recordOf(l: any, grantId: Uint8Array): Record<string, unknown> | null {
  if (!l.grants.member(grantId)) return null;
  const g = l.grants.lookup(grantId);
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
    read: g.scope.read,
    op_withdraw_shielded: g.scope.op_withdraw_shielded,
    op_withdraw_shielded_to_contract: g.scope.op_withdraw_shielded_to_contract,
  };
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

async function txStatusByHash(hash: string): Promise<string> {
  const query = `query($o: TransactionOffset!) {
    transactions(offset: $o) { __typename hash block { height }
      ... on RegularTransaction { transactionResult { status } } }
  }`.trim();
  try {
    const res = await fetch(indexerUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { o: { hash: hash.replace(/^0x/, '') } } }),
    });
    const body: any = await res.json();
    if (body?.errors?.length) return `unavailable (${String(body.errors[0]?.message).slice(0, 80)})`;
    const t = (body?.data?.transactions ?? [])[0];
    if (!t) return 'unavailable (indexer returned no transaction)';
    return `${t.__typename}${t.transactionResult ? `/${t.transactionResult.status}` : ''} @block ${t?.block?.height}`;
  } catch (e: any) {
    return `unavailable (${String(e?.message).slice(0, 80)})`;
  }
}

// ── Held-coin bookkeeping ───────────────────────────────────────────────────
//
// One coin of the working color at a time, plus the commitment-tree
// candidates its carrying transaction wrote. The change of a `send` is the
// LAST commitment of the spend's window, so the candidate list is tried from
// the back; a wrong candidate fails at proving with no transaction (INV-5).

interface Held {
  coin: PlainCoin;
  candidates: bigint[];
}

function changeFirst(candidates: bigint[]): bigint[] {
  return [...candidates].reverse();
}


// ── Phase tracing, raw submission, and same-contract composition ────────────
//
// S12, S13, and S14 need what the high-level client deliberately hides: the
// stage a call failed at (circuit execution, proving, balancing, or node
// admission), a submission with no dust retry (a retry would rebuild the call
// and so re-read the clock, which is exactly what S12's admission row
// measures), and two calls on ONE contract inside ONE transaction. The three
// wrappers below are the phase tracer of `probe-block-time.ts`, reused here.

type Phase = 'build' | 'prove' | 'balance' | 'submit' | 'submitted';
let phase: Phase = 'build';
const phaseNow = (): Phase => phase;
const setPhase = (p: Phase): void => { phase = p; };

/** The polkadot RPC layer writes `Invalid Transaction: Custom error: n` to
 *  stderr while the SDK surfaces only a generic wrapper; tap it. */
let stderrTap: string[] | null = null;
{
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    if (stderrTap) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      for (const line of text.split('\n')) {
        if (/Invalid Transaction|Custom error|Transaction submission/.test(line)) {
          stderrTap.push(line.replace(/^\S+ \S+\s+/, '').trim());
        }
      }
    }
    return (realWrite as any)(chunk, ...rest);
  };
}

function instrumentPhases(providers: any): void {
  if ((providers as any).__phaseInstrumented) return;
  const proveTx = providers.proofProvider.proveTx.bind(providers.proofProvider);
  providers.proofProvider.proveTx = async (tx: any, opts?: any) => {
    setPhase('prove');
    return proveTx(tx, opts);
  };
  const balanceTx = providers.walletProvider.balanceTx.bind(providers.walletProvider);
  providers.walletProvider.balanceTx = async (tx: any, ttl?: Date) => {
    setPhase('balance');
    return balanceTx(tx, ttl);
  };
  const submit = providers.walletProvider.submitTx.bind(providers.walletProvider);
  const wrapped = async (tx: any) => {
    setPhase('submit');
    const id = await submit(tx);
    setPhase('submitted');
    return id;
  };
  providers.walletProvider.submitTx = wrapped;
  providers.midnightProvider.submitTx = wrapped;
  (providers as any).__phaseInstrumented = true;
  console.log('  phase tracer installed (build / prove / balance / submit)');
}

/** The node's own account of a mempool rejection: the SDK wraps the RPC error
 *  and the RPC layer carries only `Custom error: <n>`. */
function nodeRejectionLines(sinceSeconds: number): { lines: string[]; failure?: string } {
  const container = process.env.MIDNIGHT_NODE_CONTAINER ?? 'account-custody-reference-node-1';
  try {
    const r = spawnSync('docker', ['logs', '--since', `${sinceSeconds}s`, container], { encoding: 'utf8' });
    if (r.error || (r.status ?? 1) !== 0) {
      return { lines: [], failure: `docker logs ${container}: ${r.error ? String(r.error.message) : `exit ${String(r.status)}`}` };
    }
    return {
      lines: `${r.stdout ?? ''}\n${r.stderr ?? ''}`
        .split('\n')
        .filter((l) => /Rejected transaction|would fail|Transcript\(/.test(l))
        .map((l) => l.replace(/^\S+ \S+\s+/, '').trim()),
    };
  } catch (e) {
    return { lines: [], failure: `node log capture threw: ${String(e).slice(0, 200)}` };
  }
}

/** One attempt at a call, with the stage it reached recorded. */
interface Attempted {
  ok: boolean;
  stage: Phase;
  txId?: string;
  message?: string;
  rpcLog?: string[];
  nodeLog?: string[];
  ms: number;
}

/** Prove, balance, and submit ONE unproven transaction with no dust retry,
 *  recording the stage a failure reached and, for a submission refusal, the
 *  RPC line and the node's own log line. */
async function rawSubmit(
  providers: any,
  /** Either the unproven transaction, or a thunk that rebuilds it. A thunk
   *  also enables the dust-race retry: the wallet builds fees from a dust
   *  state that lags the chain, and a rejected submission changes nothing. */
  source: any | (() => Promise<any>),
  circuitId: string | string[],
  opts?: { dustRetries?: number },
): Promise<Attempted> {
  const retries = typeof source === 'function' ? (opts?.dustRetries ?? 2) : 0;
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    setPhase('build');
    stderrTap = [];
    try {
      const unprovenTx = typeof source === 'function' ? await source() : source;
      const finalized: any = await (submitTx as any)(providers, { unprovenTx, circuitId });
      const txId = finalized?.public?.txId ?? finalized?.txId ?? finalized?.transactionHash;
      return { ok: true, stage: 'submitted', txId, ms: Date.now() - t0, rpcLog: [...new Set(stderrTap)] };
    } catch (e: any) {
      const at = phaseNow();
      const message = String(e?.message ?? e);
      const rpcLog = [...new Set(stderrTap ?? [])];
      if (at === 'submit' && attempt < retries && /DustDoubleSpend|NotNormalized/.test(message)) {
        console.log('  (submission rejected on the wallet dust race; rebuilding in 12 s)');
        stderrTap = null;
        await sleep(12_000);
        continue;
      }
      if (at === 'prove' && typeof source === 'function' && attempt < 4 && proverOutage(message)) {
        console.log('  (the proof server dropped mid-proof; restoring it and retrying the same call)');
        stderrTap = null;
        await ensureProver('rawSubmit');
        continue;
      }
      let nodeLog: string[] = [];
      if (at === 'submit') {
        await sleep(1_500);
        const cap = nodeRejectionLines(20);
        nodeLog = cap.failure ? [`(capture failed) ${cap.failure}`] : cap.lines.slice(-3);
      }
      return { ok: false, stage: at, message, rpcLog, nodeLog, ms: Date.now() - t0 };
    } finally {
      stderrTap = null;
    }
  }
}

/** Prove an unproven transaction and throw the rest away: the only way to ask
 *  "would this witness satisfy the circuit?" without spending anything. */
async function proveOnly(providers: any, unprovenTx: any): Promise<void> {
  setPhase('prove');
  await providers.proofProvider.proveTx(unprovenTx);
}

interface ChainStates {
  contractState: any;
  zswap: any;
  ledgerParameters: any;
}

async function readStates(providers: any, address: string): Promise<ChainStates> {
  const [zswap, contractState, ledgerParameters] =
    await providers.publicDataProvider.queryZSwapAndContractState(address);
  return { contractState, zswap, ledgerParameters };
}

/**
 * The contract state a second call in the SAME transaction must be built
 * against: the chain's state with its data replaced by the state value the
 * first call produced. Without it both calls record the same pre-state reads
 * (the same `auth_nonce`, the same grant `nonce`) and the node refuses the
 * pair on a transcript read mismatch.
 */
function successorState(contractState: any, nextStateValue: any): any {
  const cloned = (contractState.constructor as any).deserialize(contractState.serialize());
  cloned.data = new ChargedState(nextStateValue);
  return cloned;
}

// ── Transaction transcripts through the indexer (S12) ──────────────────────
//
// The indexer serves the whole transaction as `raw`; ledger-v9 deserialises
// it, and each contract call carries the public transcript the client
// recorded and the node re-executed. A `kernel.blockTimeLessThan` is a read
// of the call context followed by an `lt` and a `popeq` of the Boolean, so a
// record whose `expires_at` is 0 — where the contract's `t == 0 || …` short
// circuits — records no `lt` at all.

interface TranscriptSummary {
  identifier: string;
  hash: string | null;
  blockHeight: number | null;
  status: string | null;
  calls: Array<{
    entryPoint: string;
    /** Which transcript section this row is: guaranteed or fallible. Both are
     *  walked, because where a call's operations land is the SDK's
     *  partitioning decision and it is not the same on every run. */
    section: 'guaranteed' | 'fallible';
    ops: number;
    opKinds: string[];
    ltOps: number;
    /** Every `idx` key read as a single byte, in order. */
    idxKeys: number[];
    /** The Boolean results of every `popeq` that follows an `lt`. */
    ltResults: string[];
  }>;
  error?: string;
}

function opKind(op: any): string {
  return typeof op === 'string' ? op : Object.keys(op)[0];
}

function idxKeyOf(op: any): number | null {
  const path = op?.idx?.path;
  if (!Array.isArray(path) || path.length !== 1) return null;
  const v = path[0]?.value?.value?.[0];
  if (v === undefined) return null;
  const k = Object.keys(v);
  return k.length === 0 ? 0 : Number((v as any)[k[0]]);
}

async function txTranscript(identifier: string, address: string): Promise<TranscriptSummary> {
  const out: TranscriptSummary = { identifier, hash: null, blockHeight: null, status: null, calls: [] };
  try {
    const query = `query($o: TransactionOffset!) {
      transactions(offset: $o) { hash block { height }
        ... on RegularTransaction { raw transactionResult { status } } }
    }`.trim();
    const res = await fetch(indexerUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { o: { identifier: identifier.replace(/^0x/, '') } } }),
    });
    const body: any = await res.json();
    if (body?.errors?.length) { out.error = JSON.stringify(body.errors).slice(0, 300); return out; }
    const t = (body?.data?.transactions ?? [])[0];
    if (!t) { out.error = 'indexer returned no transaction'; return out; }
    out.hash = t.hash;
    out.blockHeight = t.block?.height ?? null;
    out.status = t.transactionResult?.status ?? null;
    const raw = Uint8Array.from(String(t.raw).match(/../g)!.map((b) => parseInt(b, 16)));
    const tx: any = (Transaction as any).deserialize('signature', 'proof', 'binding', raw);
    const want = address.replace(/^0x/, '').toLowerCase();
    for (const [, intent] of (tx.intents ?? new Map()) as Map<number, any>) {
      for (const action of (intent?.actions ?? []) as any[]) {
        const addr = String(action?.address ?? '').replace(/^0x/, '').toLowerCase();
        if (addr && want && addr !== want) continue;
        const sections: Array<['guaranteed' | 'fallible', any]> = [
          ['guaranteed', action?.guaranteedTranscript],
          ['fallible', action?.fallibleTranscript],
        ];
        for (const [section, tr] of sections) {
        if (!tr) continue;
        const program = tr.program as any[];
        const kinds = program.map(opKind);
        const idxKeys: number[] = [];
        const ltResults: string[] = [];
        program.forEach((op, i) => {
          const k = idxKeyOf(op);
          if (k !== null) idxKeys.push(k);
          if (opKind(op) === 'lt') {
            const next = program[i + 1];
            ltResults.push(next && (next as any).popeq
              ? JSON.stringify((next as any).popeq.result?.value ?? null)
              : '(no popeq after lt)');
          }
        });
        out.calls.push({
          entryPoint: typeof action.entryPoint === 'string'
            ? action.entryPoint
            : Buffer.from(action.entryPoint ?? []).toString('utf8').replace(/\0+$/, ''),
          section,
          ops: program.length,
          opKinds: kinds,
          ltOps: kinds.filter((k) => k === 'lt').length,
          idxKeys,
          ltResults,
        });
        }
      }
    }
  } catch (e: any) {
    out.error = String(e?.message ?? e).slice(0, 300);
  }
  return out;
}

// ── The node's head block, for the expiry rows (E3's method) ────────────────

async function nodeRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(CONFIG.node, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`node rpc ${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** SCALE compact<u32/u64> decode at offset i. */
function scaleCompact(bs: Uint8Array, i: number): [bigint, number] {
  const mode = bs[i] & 3;
  if (mode === 0) return [BigInt(bs[i] >> 2), i + 1];
  if (mode === 1) return [BigInt((bs[i] | (bs[i + 1] << 8)) >>> 2), i + 2];
  if (mode === 2) {
    const v = (bs[i] | (bs[i + 1] << 8) | (bs[i + 2] << 16) | (bs[i + 3] << 24)) >>> 0;
    return [BigInt(v >>> 2), i + 4];
  }
  const n = (bs[i] >> 2) + 4;
  let v = 0n;
  for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(bs[i + 1 + k]);
  return [v, i + 1 + n];
}

async function nodeHead(): Promise<{ height: number; timestampMs: number }> {
  const hash = await nodeRpc<string>('chain_getBlockHash');
  const block = await nodeRpc<{ block: { header: { number: string }; extrinsics: string[] } }>(
    'chain_getBlock', [hash],
  );
  const height = parseInt(block.block.header.number, 16);
  const x = Buffer.from(block.block.extrinsics[0].slice(2), 'hex');
  const [, afterLen] = scaleCompact(x, 0);
  const [ts] = scaleCompact(x, afterLen + 3);
  return { height, timestampMs: Number(ts) };
}

// ── Weak and malformed grantee keys (S11) ───────────────────────────────────

/** secp256k1's prime field modulus. */
const SECP256K1_P = 2n ** 256n - 2n ** 32n - 977n;
/** The JubJub base field modulus (the BLS12-381 scalar field). */
const JUBJUB_Q = BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001');

const powMod = (b: bigint, e: bigint, m: bigint): bigint => {
  let r = 1n; let base = b % m; let exp = e;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return r;
};

const onSecp256k1 = (x: bigint, y: bigint): boolean =>
  (y * y) % SECP256K1_P === (((x * x) % SECP256K1_P) * x + 7n) % SECP256K1_P;

/**
 * A point of a DIFFERENT curve of the same shape: `y^2 = x^3 + b` for a `b`
 * that is not secp256k1's 7. Such a point is what an invalid-curve attack
 * presents, and no coordinate test in the seam distinguishes it from a real
 * key. p = 3 mod 4, so the square root is a single exponentiation.
 */
function invalidCurvePoint(b: bigint): { x: bigint; y: bigint; b: bigint } {
  for (let x = 1n; x < 200n; x++) {
    const rhs = (((x * x) % SECP256K1_P) * x + b) % SECP256K1_P;
    const y = powMod(rhs, (SECP256K1_P + 1n) / 4n, SECP256K1_P);
    if ((y * y) % SECP256K1_P === rhs && !onSecp256k1(x, y)) return { x, y, b };
  }
  throw new Error(`no point found on y^2 = x^3 + ${b}`);
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
  deploy: {
    testId: 'grants-e2-deploy',
    description: 'Scoped grants Testing 6: the spec_version = 2 roster deployed in waves, the maintenance authority retired after the last wave, and both device arms live',
    // `{waveCount}` is substituted by flushEvidence from the plan this run
    // actually followed, so the note can never disagree with the chain again.
    note: 'The 30-circuit spec_version = 2 roster deployed in {waveCount} waves within the per-block parameters, with the wave plan computed from the compiled artefacts and the authority counter read from chain before each maintenance wave; after the last wave the on-chain maintenance authority carries an empty committee at threshold 1, which no signature set can satisfy. The spec_version = 1 control of Testing item 6 was NOT run: it needs a compiled v1 build of the contract, which this tree does not carry. Hence PARTIAL.',
  },
  issue: {
    testId: 'grants-e2-issue',
    description: 'Scoped grants Testing 1 (first half): issuance across both device arms and both grantee arms; record fields, auth_nonce and round advance',
    note: 'Seven grants issued across both device arms (k256 and jubjub) and both grantee arms. Every record carries epoch = device_epoch, gen = grant_generation, issued_at equal to auth_nonce AFTER the device seam advanced it, nonce 0, and active; each issue advanced auth_nonce by exactly one and advanced round.',
  },
  spend: {
    testId: 'grants-e2-spend',
    description: 'Scoped grants: grant shielded spends with the change entry appended in the same transaction, consecutive nonces, both grantee arms (Testing 1 spend half, Testing 9 consecutive nonces, Testing 10 change append; each item is only part of its Testing item)',
    note: 'Grant shielded spends execute on node on both grantee arms. Each advances the record nonce by one and re-commits spent_commit to the cumulative value released, advances round by one, leaves auth_nonce and device_count untouched, and appends the change entry in the SAME transaction (inbox_count + 1), where the entry decrypts to the change coin the circuit returned. The change coin description was predicted before proving from the standard library nonce evolution and matched the circuit result every time.',
  },
  rejections: {
    testId: 'grants-e2-rejections',
    description: 'Scoped grants Testing 2: the rejection matrix, each a build-time abort with no transaction and no state change',
    note: 'The rejection matrix: every item aborted at build time with no transaction, and the ledger snapshot (round, auth_nonce, inbox_count, device_count, grant_generation, register size) was identical before and after each one.',
  },
  liveness: {
    testId: 'grants-e2-liveness',
    description: 'Scoped grants Testing 3: a pending owner signature survives a grant call, and a permissionless deposit does not invalidate a pending grantee call',
    note: 'An owner signature pending across a grant call still verifies and lands, because a grant call writes neither auth_nonce nor the device set. A permissionless deposit_shielded landing between the grantee signing and the grantee submitting does not invalidate the grantee call.',
  },
  direct: {
    testId: 'grants-e2-direct',
    description: 'Scoped grants Testing 10: the contract-recipient grant twin composed with the payee claim in one transaction',
    note: 'The contract-recipient grant twin composed with the payee account deposit claim in one client-composed transaction, following the device-twin recipe (build both unproven calls, graft the payee intent, prove both circuits, submit) with candidate retry over the change index.',
  },
  kill: {
    testId: 'grants-e2-kill',
    description: 'Scoped grants: revoke_all_grants makes every record inert and re-issue under the new generation works (Testing 11 less the recovery epoch bump, which no circuit exposes yet)',
    note: 'revoke_all_grants bumped grant_generation to 1 and cleared the register; a call under a pre-kill grant fails at the membership assert; a grant re-issued under the new generation carries gen 1 and nonce 0 and authorises a spend.',
  },
  keys: {
    testId: 'grants-e2-keys',
    description: 'Scoped grants Testing 2 (key rows), GR-14, GR-4, GR-2 and the authorisation MIP S10/S12: grantee-key validation on both arms, on node',
    note: 'Grantee-key validation as the seam performs it on node: the identity in both encodings the k256 type admits, an off-curve pair, a point of another curve of the same shape (the invalid-curve twin), the JubJub identity (0, 1), a small-order point, an off-curve JubJub pair, each arm\'s key against the other arm\'s twin, and a device key issued as a grantee. Each row records whether a transaction existed, the stage the refusal landed at, and the verbatim text. The issue leg is the finding: issue_grant takes grant_id, never the key, so no key check is possible in-circuit at issuance, and the reference client does not perform the section 3.3 check either.',
  },
  expiry: {
    testId: 'grants-e2-expiry',
    description: 'Scoped grants Testing 1 (expiry half), GR-7: expires_at = 0 and expires_at = head + 3600 on the grant twins, and an expiry inside the admission margin',
    note: 'The expiry rows on the grant twins themselves rather than on E3\'s probe contract: a record with expires_at = 0 and one with expires_at = the chain head\'s block time plus 3600 s each spend on node with state advancing, and the transaction transcripts read back through the indexer show the zero record producing no block-time read (no lt op) while the forward-dated one records exactly one. A third record whose expires_at falls inside the admission margin builds on the client and is refused by the node at admission with no state change.',
  },
  composition: {
    testId: 'grants-e2-composition',
    description: 'Scoped grants Testing 9, GR-5, GR-11, GR-13: revoke plus issue over one id, batch issuance, and two grant calls under one grant, each in ONE transaction',
    note: 'Composition of two calls on the SAME contract in one transaction, built by chaining the contract state: the second call is built against the state value the first produced, so it records the successor reads (auth_nonce + 1, grant nonce + 1) rather than repeating the first call\'s. Revoke plus issue over one grant id, batch issuance of two grants, and two grant calls under one grant with consecutive nonces are each one transaction; the same two grant calls grafted in the opposite segment order are submitted as the negative control.',
  },
  concurrency: {
    testId: 'grants-e2-concurrency',
    description: 'Scoped grants Testing 10 (remaining leg), INV-5, Testing 3 leg (b): owner and grantee over one coin, and a pre-signed grantee call across a permissionless deposit',
    note: 'The owner and a grantee select the same held coin and both build; the loser is recorded with the stage it failed at and the winner\'s spend is shown intact, with no mis-spend. Testing item 3 leg (b) is re-run properly: the qualified coin index is resolved by prove-only candidate trials BEFORE the grantee signs, a permissionless deposit_shielded then lands, and the ORIGINAL signature is built, proved, and submitted unchanged.',
  },
  proving: {
    testId: 'grants-e2-proving',
    description: 'Proving time per circuit over the whole E2 run, with the compiled k of each circuit',
    note: 'Proving time measured at providers.proofProvider.proveTx for every proof of the run, attributed to the circuit of the call it served, with the compiled k of each circuit from the measurement table; wall-clock per call (build, prove, submit) recorded alongside.',
  },
};

/**
 * The number of waves the run's own plan produced, set in S0 from `planWaves`
 * over the compiled artefacts. The deploy note quotes it rather than a
 * hard-coded word: the budget is a measured figure that can be re-measured,
 * and the first run's note said "three" while the plan, the log, and the chain
 * all said four.
 */
let plannedWaveCount: number | null = null;

function flushEvidence(name: string): void {
  const meta = GROUP_META[name];
  const g = groups[name] ?? { verdict: 'FAIL' as Verdict, details: { note: 'group never ran' } };
  writeEvidence({
    testId: meta.testId,
    name: `grants-conformance-${name}`,
    description: meta.description,
    verdict: g.verdict,
    note: meta.note.replace(
      '{waveCount}',
      plannedWaveCount === null ? 'the planned number of' : String(plannedWaveCount),
    ),
    details: g.details,
  });
}

// ── Group selection ─────────────────────────────────────────────────────────
//
// The scenario is ONE sequence: S2 issues against the account S0 deployed, S4
// spends the coin S3 deposited, S9 kills the grants S2 issued. A subset can
// therefore only be a PREFIX of it, and GRANTS_E2_GROUPS truncates rather than
// skips: every group up to and including the last selected one runs, the run
// stops there, and the evidence of the groups after it is left exactly as the
// previous run wrote it. Unset runs the whole scenario.
//
//   GRANTS_E2_GROUPS=deploy   run S0 and S1, then stop, which regenerates the
//                             deploy evidence alone (after a budget change,
//                             say) without re-running the whole scenario.

const GROUP_ORDER = [
  'deploy', 'issue', 'spend', 'rejections', 'liveness', 'direct', 'kill',
  'keys', 'expiry', 'composition', 'concurrency', 'proving',
] as const;

const SELECTED_GROUPS: Set<string> = (() => {
  const raw = process.env.GRANTS_E2_GROUPS;
  if (!raw) return new Set<string>(GROUP_ORDER);
  const names = raw.split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = names.filter((n) => !(GROUP_ORDER as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `GRANTS_E2_GROUPS: unknown group(s) ${unknown.join(', ')}; known groups: ${GROUP_ORDER.join(', ')}`,
    );
  }
  if (names.length === 0) throw new Error('GRANTS_E2_GROUPS is set but names no group');
  return new Set(names);
})();

/** True once no selected group remains after `name`, so the run may stop there. */
function lastSelected(name: string): boolean {
  const after = GROUP_ORDER.slice(GROUP_ORDER.indexOf(name as (typeof GROUP_ORDER)[number]) + 1);
  return !after.some((g) => SELECTED_GROUPS.has(g));
}

/** Stop the scenario after `name` when nothing selected comes after it. */
function stopAfter(name: string): boolean {
  if (!lastSelected(name)) return false;
  console.log(
    `\n  GRANTS_E2_GROUPS=${process.env.GRANTS_E2_GROUPS ?? '(unset)'}: '${name}' is the last selected ` +
    'group, so the run stops here. The evidence of the later groups is whatever the previous run wrote.',
  );
  return true;
}

// ── Constants ───────────────────────────────────────────────────────────────

const CLIENT_ID = 'https://grants-e2.example';
const MINT_MAIN = 1000n;
const MINT_AUX = 40n;

const SLOT_A = 0n;
const SLOT_B = 1n;
const SLOT_C = 2n;
const SLOT_D = 3n;
const SLOT_E = 4n;
const SLOT_L = 5n;
const SLOT_G = 6n;
const SLOT_F = 7n;

await runScenario('grants-conformance (scoped grants E2)', async () => {
  const runStart = Date.now();
  const oh = originHash(CLIENT_ID);
  console.log(`  groups selected: ${GROUP_ORDER.filter((g) => SELECTED_GROUPS.has(g)).join(', ')}`);

  // ══ S0 setup and wave deploy ══════════════════════════════════════════════

  step('S0: wallet, faucet, and the wave deploy of a k256-born account');
  const deployDetails = group('deploy');
  deployDetails.clientId = CLIENT_ID;
  deployDetails.originHash = bytesToHex(oh);

  const ctx: TestContext = await setupWallet();
  instrumentProofProvider(ctx.providers, 'account providers');
  instrumentPhases(ctx.providers);
  const faucet: FaucetHandle = await timed('deploy:faucet', () => deployFaucet(ctx.walletCtx));
  instrumentProofProvider(faucet.providers, 'faucet providers');
  console.log(`  faucet @ ${faucet.address}`);

  // The working colors are derived before anything is minted: a grant's
  // scope commits to the color, so it must be known at issue time.
  const colorSeedMain = bytesToHex(rnd32());
  const colorSeedAux = bytesToHex(rnd32());
  const colorMain = encodeRawTokenType(rawTokenType(hexToBytes32(colorSeedMain), faucet.address));
  const colorAux = encodeRawTokenType(rawTokenType(hexToBytes32(colorSeedAux), faucet.address));
  deployDetails.colorMain = bytesToHex(colorMain);
  deployDetails.colorAux = bytesToHex(colorAux);

  // The wave plan, computed from the real compiled artefacts, is the table
  // the deploy will follow.
  const sizes = new Map<string, number>();
  for (const id of allCircuits()) {
    const vk: Uint8Array = await ctx.providers.zkConfigProvider.getVerifierKey(id);
    sizes.set(id, vk.length);
  }
  const plan = planWaves(sizes, 'k256', true);
  plannedWaveCount = plan.length;
  deployDetails.verifierByteBudget = VERIFIER_BYTE_BUDGET;
  deployDetails.waveBudgetFinding =
    'MEASURED by probe:wave-ceiling (evidence/wave-ceiling.json, node 2.1.0): the per-maintenance-update ceiling sits ' +
    'in (29,484, 32,229] verifier bytes. One update carrying 12 verifier keys (29,484 bytes) lands; 13 keys (32,229), ' +
    '14 keys (34,974) and 16 keys (39,600) are each refused by the node at submission with "1010: Invalid Transaction: ' +
    'Transaction would exhaust the block limits". The client fee computation refuses none of them: it priced every ' +
    'refused payload, normalizeFullness did not throw, and fees returned a figure. The NODE therefore bounds a ' +
    'maintenance update, while the client-side "exceeded block limit in transaction fee computation" is what bounds ' +
    'the all-operations DEPLOY. This run drove wave-deploy at ' + String(VERIFIER_BYTE_BUDGET) + ' verifier bytes per ' +
    'update (the shipped default being the largest accepted payload less a stated safety margin), and the plan below ' +
    'is what that budget produces.';
  deployDetails.rosterSize = allCircuits().length;
  deployDetails.rosterVerifierBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
  deployDetails.plan = plan.map((w) => ({
    index: w.index,
    kind: w.kind,
    circuitCount: w.circuits.length,
    verifierBytes: w.verifierBytes,
    retiresAuthority: w.retiresAuthority,
    circuits: w.circuits,
  }));

  const device = K256Device.generate();
  let encKeys: EncKeyPair = generateEncKeyPair();
  const deployLines: string[] = [];
  const account = await withConsoleCapture(deployLines, () =>
    timed(`deploy:account-A (${plan.length} waves + activate)`, () => deployAccount(ctx, device, encKeys)));
  console.log(`  account A @ ${account.address}`);
  deployDetails.accountA = account.address;

  // The counters the waves were BUILT against, as wave-deploy read them from
  // chain, plus the authority as it stands now.
  const counterLines = deployLines
    .map((l) => l.match(/wave (\d+): one maintenance update inserting (\d+) verifier keys \((\d+) verifier bytes, authority counter (\d+)\)/))
    .filter(Boolean)
    .map((m) => ({ wave: Number(m![1]), circuits: Number(m![2]), verifierBytes: Number(m![3]), authorityCounterBefore: m![4] }));
  deployDetails.authorityCounterPerWave = counterLines;

  const actions = await enumerateContractActions(account.address);
  const waveTxs: Array<Record<string, unknown>> = [];
  for (const a of actions) {
    if (a.kind === 'ContractCall') continue; // the activation, not a wave
    waveTxs.push({ kind: a.kind, txHash: a.txHash, blockHeight: a.blockHeight, status: await txStatusByHash(a.txHash) });
  }
  deployDetails.waveTransactions = waveTxs;
  deployDetails.contractActions = actions.map((a) => ({ kind: a.kind, entryPoint: a.entryPoint ?? null, txHash: a.txHash, blockHeight: a.blockHeight }));

  const authority = await maintenanceAuthority(account.address);
  deployDetails.maintenanceAuthorityAfterWaves = authority;
  if (authority.committee !== 0 || authority.threshold !== 1) {
    setVerdict('deploy', 'FAIL');
    throw new Error(`maintenance authority not retired: ${JSON.stringify(authority)}`);
  }
  console.log(`  ✓ maintenance authority retired: committee=${authority.committee} threshold=${authority.threshold} counter=${authority.counter}`);

  const l0 = await account.ledgerState();
  deployDetails.specVersion = l0.spec_version.toString();
  deployDetails.initialLedger = await snapshot(account);
  if (l0.spec_version !== 2n) {
    setVerdict('deploy', 'FAIL');
    throw new Error(`spec_version ${l0.spec_version}, expected 2`);
  }
  deployDetails.specVersion1Control =
    'NOT RUN. Testing item 6 also asks that a spec_version = 1 account be shown unable to gain grants. ' +
    'That control needs a compiled v1 (pre-grants) build of the contract, which this tree does not carry: ' +
    'contracts/account.compact is the spec_version = 2 source and the managed artefacts are its 30-circuit roster. ' +
    'The control is therefore outstanding, and the deploy leg of item 6 is reported without it.';
  setVerdict('deploy', 'PARTIAL');

  // ══ S1 cross-arm enrolment ════════════════════════════════════════════════

  step('S1: the k256 owner device enrols a jubjub device (cross-arm)');
  const jDevice = JubjubDevice.generate();
  const addTx = await timed('add_device_with_k256 (enrol jubjub device)', () =>
    account.addDevice(device, jDevice));
  const l1 = await waitForLedger(
    () => account.ledgerState(),
    'auth_nonce advanced by the enrolment',
    (l) => l.auth_nonce === l0.auth_nonce + 1n && l.device_count === 2n,
  );
  deployDetails.crossArmEnrolmentTx = addTx.txId;
  deployDetails.afterEnrolment = await snapshot(account);
  console.log(`  ✓ jubjub device enrolled: tx ${addTx.txId}; devices ${l1.device_count}`);

  flushEvidence('deploy');
  if (stopAfter('deploy')) return;

  // ══ S2 issuance ═══════════════════════════════════════════════════════════

  step('S2: issue grants A–E across both device arms and both grantee arms');
  const issueDetails = group('issue');
  const issued: Array<Record<string, unknown>> = [];

  const jGrantee = JubjubGrantee.generate();
  const kGrantee = K256Grantee.generate();
  const kGranteeConnector = new K256Grantee((kGrantee as any).sk, K256_ENVELOPE_CONNECTOR);
  const readPkHash = rnd32();

  interface GrantHandle {
    name: string;
    grantee: AnyGrantee;
    slot: bigint;
    id: Uint8Array;
    salt: Uint8Array;
    opening: GrantOpening;
    scope: any;
  }

  async function issue(
    name: string,
    issuer: 'k256' | 'jubjub',
    grantee: AnyGrantee,
    slot: bigint,
    scope: any,
  ): Promise<GrantHandle> {
    const salt = rnd32();
    const id = account.grantIdOf(grantee, oh, slot);
    const before = await account.ledgerState();
    const signer = issuer === 'k256' ? device : jDevice;
    const tx = await timed(`issue_grant_with_${issuer} (grant ${name})`, () =>
      account.issueGrant(signer, id, scope, salt));
    const after = await waitForLedger(
      () => account.ledgerState(),
      `grant ${name} recorded`,
      (l) => l.grants.member(id) && l.auth_nonce === before.auth_nonce + 1n,
    );
    const rec = recordOf(after, id)!;
    const row = {
      name,
      issuer,
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
      epochMatchesDeviceEpoch: rec.epoch === after.device_epoch.toString(),
      genMatchesGeneration: rec.gen === after.grant_generation.toString(),
    };
    issued.push(row);
    if (!row.issuedAtEqualsPostSeamAuthNonce || !row.nonceIsZero || !row.active) {
      setVerdict('issue', 'FAIL');
      throw new Error(`grant ${name}: record fields wrong — ${JSON.stringify(row)}`);
    }
    if (after.auth_nonce !== before.auth_nonce + 1n) {
      setVerdict('issue', 'FAIL');
      throw new Error(`grant ${name}: auth_nonce did not advance by one`);
    }
    if (after.round <= before.round) {
      setVerdict('issue', 'FAIL');
      throw new Error(`grant ${name}: round did not advance`);
    }
    console.log(`  ✓ grant ${name} issued (${issuer} device → ${grantee.arm} grantee): ${tx.txId}`);
    console.log(`    issued_at ${rec.issued_at} (auth_nonce after the seam), nonce 0, active`);
    return { name, grantee, slot, id, salt, opening: openingOf(scope, salt, oh, slot), scope };
  }

  const scopeA = spendScope({
    withdrawShielded: true,
    color: colorMain,
    cap: 500n,
    perCallCap: 200n,
    maxCoinValue: 1000n,
    expiresAt: 0n,
    readPkHash,
  });
  const grantA = await issue('A', 'k256', jGrantee, SLOT_A, scopeA);

  const scopeB = spendScope({
    withdrawShielded: true,
    color: colorMain,
    cap: 100n,
    perCallCap: 100n,
    maxCoinValue: 1000n,
    readPkHash,
  });
  const grantB = await issue('B', 'jubjub', kGrantee, SLOT_B, scopeB);

  const scopeC = readOnlyScope({ readPkHash });
  const grantC = await issue('C', 'k256', kGranteeConnector, SLOT_C, scopeC);

  const scopeD = spendScope({
    withdrawShielded: true,
    color: colorMain,
    cap: 500n,
    perCallCap: 50n,
    maxCoinValue: 50n,
    readPkHash,
  });
  const grantD = await issue('D', 'jubjub', jGrantee, SLOT_D, scopeD);

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const scopeE = spendScope({
    withdrawShielded: true,
    color: colorMain,
    cap: 500n,
    perCallCap: 200n,
    maxCoinValue: 1000n,
    expiresAt: nowSeconds - 100n,
    readPkHash,
  });
  const grantE = await issue('E', 'k256', kGrantee, SLOT_E, scopeE);
  issueDetails.expiredGrantExpiresAt = (nowSeconds - 100n).toString();

  // Two working grants the scenario needs beyond the five the plan names:
  // L carries the liveness spends of S7 and the stale-enc_pk item of S6
  // (both need cap headroom that A does not have once its cap is
  // exhausted), and G carries the recipient pin.
  const scopeL = spendScope({
    withdrawShielded: true,
    color: colorMain,
    cap: 300n,
    perCallCap: 100n,
    maxCoinValue: 1000n,
    readPkHash,
  });
  const grantL = await issue('L', 'k256', jGrantee, SLOT_L, scopeL);

  const pinnedCpk = rnd32();
  const scopeG = spendScope({
    withdrawShielded: true,
    color: colorMain,
    cap: 200n,
    perCallCap: 100n,
    maxCoinValue: 1000n,
    recipientKind: RECIPIENT_ZSWAP_COIN_PUBLIC_KEY,
    recipient: pinnedCpk,
    readPkHash,
  });
  const grantG = await issue('G', 'k256', jGrantee, SLOT_G, scopeG);
  issueDetails.pinnedRecipient = bytesToHex(pinnedCpk);

  issueDetails.grants = issued;
  issueDetails.ledgerAfterIssuance = await snapshot(account);

  flushEvidence('issue');
  if (stopAfter('issue')) return;

  // ══ S3 funding ════════════════════════════════════════════════════════════

  step('S3: mint 1000 of the working color and deposit it under a sealed inbox entry');
  const spendDetails = group('spend');
  const userCpk = await userCoinPublicKey(ctx);
  spendDetails.recipientCoinPublicKey = bytesToHex(userCpk);

  const minted: MintedCoin = await timed('faucet mint_shielded (main color)', () =>
    mintToUser(ctx, faucet, colorSeedMain, MINT_MAIN));
  if (!eq(minted.color, colorMain)) {
    setVerdict('spend', 'FAIL');
    throw new Error('the minted color differs from the color committed by the grant scopes');
  }
  const depositEntry = sealInboxEntry(encKeys.publicKey, minted);
  const deposit = await timed('deposit_shielded (funding)', () =>
    account.depositShielded({ nonce: minted.nonce, color: minted.color, value: minted.value }, depositEntry));
  console.log(`  depositTx = ${deposit.txId}`);
  await sleep(10_000);
  const depCandidates = await candidateIndices(deposit.txId);
  spendDetails.depositTx = deposit.txId;
  spendDetails.depositCandidates = depCandidates.candidates.map(String);
  const held: Held = {
    coin: { nonce: minted.nonce, color: minted.color, value: minted.value },
    candidates: depCandidates.candidates,
  };
  await account.putCoin({ ...held.coin, mtIndex: held.candidates[0] });
  const ledgerFunded = await waitForLedger(
    () => account.ledgerState(),
    'deposit landed (inbox grew)',
    (l) => l.inbox_count >= 1n,
  );
  spendDetails.inboxCountAfterDeposit = ledgerFunded.inbox_count.toString();

  // ── The grant-spend driver ────────────────────────────────────────────────

  const changePredictions: Array<Record<string, unknown>> = [];

  interface SpendOutcomeRow {
    txId: string;
    change: ShieldedCoin | null;
    attempts: Array<Record<string, string>>;
    before: Ledger;
    after: Ledger;
  }

  async function grantSpend(opts: {
    label: string;
    grant: GrantHandle;
    recipient: Uint8Array;
    amount: bigint;
    sealTo: Uint8Array;
  }): Promise<SpendOutcomeRow> {
    const { grant, recipient, amount } = opts;
    const before = await account.ledgerState();
    const predicted = predictChangeCoin(held.coin, amount);
    const changeEntry = sealInboxEntry(opts.sealTo, predicted);
    const attempts: Array<Record<string, string>> = [];
    const queue = changeFirst(held.candidates);
    let proverRetries = 0;
    for (let idx = queue.shift(); idx !== undefined; idx = queue.shift()) {
      await account.putCoin({ ...held.coin, mtIndex: idx });
      try {
        const r = await timed(opts.label, () =>
          account.withdrawShieldedWithGrant(
            grant.grantee, grant.opening, recipient, held.coin.color, amount, changeEntry,
          ));
        attempts.push({ mtIndex: idx.toString(), outcome: `accepted: ${r.txId}` });
        grant.opening.spentPrev += amount;
        const matched = !!r.change
          && eq(r.change.nonce, predicted.nonce)
          && eq(r.change.color, predicted.color)
          && r.change.value === predicted.value;
        changePredictions.push({
          label: opts.label,
          predictedNonce: bytesToHex(predicted.nonce),
          predictedValue: predicted.value.toString(),
          actualNonce: r.change ? bytesToHex(r.change.nonce) : null,
          actualValue: r.change ? r.change.value.toString() : null,
          matched,
        });
        if (!matched) {
          console.log('  ⚠ the predicted change coin does NOT match the circuit result');
        } else {
          console.log(`  ✓ change coin predicted before proving: value ${predicted.value}, nonce ${short(predicted.nonce)}`);
        }
        const after = await waitForLedger(
          () => account.ledgerState(),
          `${opts.label}: round advanced by one`,
          (l) => l.round === before.round + 1n,
        );
        await sleep(5_000);
        const cand = await candidateIndices(r.txId);
        if (r.change) {
          held.coin = { nonce: r.change.nonce, color: r.change.color, value: r.change.value };
          held.candidates = cand.candidates;
          await account.putCoin({ ...held.coin, mtIndex: changeFirst(cand.candidates)[0] });
        }
        return { txId: r.txId, change: r.change, attempts, before, after };
      } catch (e: any) {
        const message = String(e?.message ?? e);
        attempts.push({ mtIndex: idx.toString(), outcome: `rejected: ${message.slice(0, 120)}` });
        if (proverOutage(message) && proverRetries < 3) {
          // The prover died mid-attempt, so this candidate was never really
          // tested. Bring it back and try the same index again.
          proverRetries++;
          console.log(`  (the proof server dropped during mt_index ${idx}; restoring it and retrying the same index)`);
          await ensureProver(opts.label);
          queue.unshift(idx);
        }
      }
    }
    throw new Error(`${opts.label}: no candidate mt_index produced an accepted spend: ${JSON.stringify(attempts)}`);
  }

  // ══ S4 first grant spend ══════════════════════════════════════════════════

  step('S4: grant A — the jubjub grantee spends 200, change appended in the SAME transaction');
  const a1 = await grantSpend({
    label: 'withdraw_shielded_with_grant_jubjub (A #1, 200)',
    grant: grantA,
    recipient: userCpk,
    amount: 200n,
    sealTo: encKeys.publicKey,
  });
  const beforeA1 = a1.before;
  const afterA1 = a1.after;
  const recA1 = recordOf(afterA1, grantA.id)!;
  spendDetails.spendA1 = {
    txId: a1.txId,
    attempts: a1.attempts,
    record: recA1,
    authNonceBefore: beforeA1.auth_nonce.toString(),
    authNonceAfter: afterA1.auth_nonce.toString(),
    roundBefore: beforeA1.round.toString(),
    roundAfter: afterA1.round.toString(),
    deviceCountBefore: beforeA1.device_count.toString(),
    deviceCountAfter: afterA1.device_count.toString(),
    inboxBefore: beforeA1.inbox_count.toString(),
    inboxAfter: afterA1.inbox_count.toString(),
  };
  const problems: string[] = [];
  if (recA1.nonce !== '1') problems.push(`grant nonce ${recA1.nonce}, expected 1`);
  if (afterA1.auth_nonce !== beforeA1.auth_nonce) problems.push('auth_nonce moved under a grant call (GR-5)');
  if (afterA1.device_count !== beforeA1.device_count) problems.push('device_count moved under a grant call');
  if (afterA1.round !== beforeA1.round + 1n) problems.push(`round ${beforeA1.round} → ${afterA1.round}, expected +1`);
  if (afterA1.inbox_count !== beforeA1.inbox_count + 1n) problems.push(`inbox_count ${beforeA1.inbox_count} → ${afterA1.inbox_count}, expected +1 in the same transaction`);

  // The spent commitment re-commits to the cumulative value released.
  const expectedSpentCommit = bytesToHex(pureCircuits.derive_grant_spent_commit(grantA.salt, 200n));
  if (recA1.spent_commit !== expectedSpentCommit) {
    problems.push(`spent_commit ${recA1.spent_commit} != commit(salt, 200) ${expectedSpentCommit}`);
  }
  spendDetails.spendA1SpentCommitMatches = recA1.spent_commit === expectedSpentCommit;

  // The appended entry decrypts to the change coin the circuit returned.
  const appendedEntry = afterA1.inbox.lookup(afterA1.inbox_count - 1n);
  const opened = openInboxEntry(encKeys.secretKey, appendedEntry);
  spendDetails.changeEntryDecrypts = !!opened && !!a1.change
    && opened.value === a1.change.value
    && eq(opened.nonce, a1.change.nonce)
    && eq(opened.color, a1.change.color);
  if (!spendDetails.changeEntryDecrypts) {
    problems.push('the entry appended by the twin does not decrypt to the returned change coin (INV-4)');
  }
  if (problems.length) {
    spendDetails.problems = problems;
    setVerdict('spend', 'FAIL');
    throw new Error(`S4 post-conditions failed: ${problems.join('; ')}`);
  }
  console.log('  ✓ nonce 1, spent_commit re-committed, round +1, auth_nonce and device_count untouched, inbox +1 in the same tx');

  // ══ S5 consecutive nonces and the other grantee arm ═══════════════════════

  step('S5: grant A spends 100 again (consecutive nonces), then grant B spends 100 on the k256 arm');
  const a2 = await grantSpend({
    label: 'withdraw_shielded_with_grant_jubjub (A #2, 100)',
    grant: grantA,
    recipient: userCpk,
    amount: 100n,
    sealTo: encKeys.publicKey,
  });
  const afterA2 = a2.after;
  const recA2 = recordOf(afterA2, grantA.id)!;
  spendDetails.spendA2 = { txId: a2.txId, attempts: a2.attempts, record: recA2 };
  if (recA2.nonce !== '2') {
    setVerdict('spend', 'FAIL');
    throw new Error(`grant A nonce ${recA2.nonce} after the second call, expected 2`);
  }
  const expectedSpent300 = bytesToHex(pureCircuits.derive_grant_spent_commit(grantA.salt, 300n));
  spendDetails.spendA2SpentCommitMatches = recA2.spent_commit === expectedSpent300;
  console.log('  ✓ consecutive nonces 1, 2 under one grant; cumulative spend 300');

  const b1 = await grantSpend({
    label: 'withdraw_shielded_with_grant_k256 (B #1, 100)',
    grant: grantB,
    recipient: userCpk,
    amount: 100n,
    sealTo: encKeys.publicKey,
  });
  const afterB1 = b1.after;
  spendDetails.spendB1 = { txId: b1.txId, attempts: b1.attempts, record: recordOf(afterB1, grantB.id) };
  console.log('  ✓ the k256 grantee arm spends on node');
  spendDetails.changePredictions = changePredictions;
  spendDetails.heldCoinAfterS5 = { value: held.coin.value.toString(), nonce: bytesToHex(held.coin.nonce) };

  flushEvidence('spend');

  // ══ S6 rejection matrix ═══════════════════════════════════════════════════

  step('S6: the rejection matrix — each a build-time abort with no transaction');
  const rejectDetails = group('rejections');
  const rejections: Array<Record<string, unknown>> = [];

  /** Run one rejection item and assert that the ledger did not move. */
  async function reject(
    label: string,
    expectedNeedles: string[],
    fn: () => Promise<unknown>,
  ): Promise<string> {
    const before = await snapshot(account);
    const message = await expectAbort(label, fn);
    const after = await snapshot(account);
    const unchanged = sameSnapshot(before, after);
    const matched = expectedNeedles.some((n) => message.includes(n));
    rejections.push({
      item: label,
      expected: expectedNeedles,
      matchedExpected: matched,
      stateUnchanged: unchanged,
      ledgerBefore: before,
      ledgerAfter: after,
      error: message,
    });
    if (!unchanged) {
      setVerdict('rejections', 'FAIL');
      throw new Error(`${label}: the ledger moved under a refused call`);
    }
    if (!matched) {
      console.log(`  ⚠ ${label}: expected one of ${JSON.stringify(expectedNeedles)}, got: ${message.slice(0, 200)}`);
      setVerdict('rejections', 'PARTIAL');
    }
    return message;
  }

  /** Sign and submit a grant spend at the low level, with no retry: used by
   *  the rejection items, which must abort before any transaction exists. */
  async function rawGrantSpend(o: {
    grant: GrantHandle;
    recipient: Uint8Array;
    amount: bigint;
    spentPrevOverride?: bigint;
    encPkOverride?: Uint8Array;
    sealTo?: Uint8Array;
    context?: GrantContext;
    opening?: GrantOpening;
  }): Promise<unknown> {
    const grant = o.grant;
    const opening = { ...(o.opening ?? grant.opening) };
    if (o.spentPrevOverride !== undefined) opening.spentPrev = o.spentPrevOverride;
    const g = o.context ?? (await account.grantContext(account.grantIdOf(grant.grantee, opening.originHash, opening.slot)));
    const enc = o.encPkOverride ?? (await account.encKey());
    const coin = await account.heldCoin(held.coin.color);
    const predicted = predictChangeCoin(held.coin, o.amount);
    const changeEntry = sealInboxEntry(o.sealTo ?? enc, predicted);
    const auth = grant.grantee.arm === 'jubjub'
      ? (grant.grantee as JubjubGrantee).sign(
          jubjubGrantChallenges.withdrawShielded(g, (grant.grantee as JubjubGrantee).pk, o.recipient, held.coin.color, o.amount, changeEntry, enc, coin))
      : (grant.grantee as K256Grantee).sign(
          k256GrantChallenges.withdrawShielded(g, (grant.grantee as K256Grantee).pk, o.recipient, held.coin.color, o.amount, changeEntry, enc, coin));
    return account.withdrawShieldedWithGrantAuth(
      o.recipient, held.coin.color, o.amount, changeEntry, enc, opening, auth as any,
    );
  }

  // (1) over per_call_cap
  await reject('over per_call_cap (grant A, 250 against a 200 per-call cap)', ['amount above per-call cap'], () =>
    rawGrantSpend({ grant: grantA, recipient: userCpk, amount: 250n }));

  // (2) cumulative cap. Grant A stands at 300 of 500 with a 200 per-call
  //     cap, so no single admissible amount can breach the cap; the cap is
  //     first driven to its ceiling by an admitted 200, which also extends
  //     the consecutive-nonce chain of Testing 9 to three.
  const a3 = await grantSpend({
    label: 'withdraw_shielded_with_grant_jubjub (A #3, 200 — exhausts the cap)',
    grant: grantA,
    recipient: userCpk,
    amount: 200n,
    sealTo: encKeys.publicKey,
  });
  const afterA3 = a3.after;
  const recA3 = recordOf(afterA3, grantA.id)!;
  spendDetails.spendA3 = { txId: a3.txId, attempts: a3.attempts, record: recA3 };
  rejectDetails.capExhaustingSpendTx = a3.txId;
  if (recA3.nonce !== '3') {
    setVerdict('spend', 'PARTIAL');
    rejectDetails.note = `grant A nonce ${recA3.nonce} after the third call, expected 3`;
  }
  await reject('over cap (grant A at 500 of 500, asks 100 within the per-call cap)', ['cumulative cap exceeded'], () =>
    rawGrantSpend({ grant: grantA, recipient: userCpk, amount: 100n }));

  // (3) wrong spent_prev opening
  await reject('wrong spent_prev opening (grant A, spent_prev off by one)', ['spent opening mismatch'], () =>
    rawGrantSpend({ grant: grantA, recipient: userCpk, amount: 50n, spentPrevOverride: grantA.opening.spentPrev - 1n }));

  // (4) wrong recipient under a pin
  await reject('wrong recipient under a pin (grant G pinned to another coin public key)', ['recipient not admitted by pin'], () =>
    rawGrantSpend({ grant: grantG, recipient: userCpk, amount: 50n }));

  // (5) coin above max_coin_value
  await reject('coin above max_coin_value (grant D, max_coin_value 50)', ['coin above max_coin_value'], () =>
    rawGrantSpend({ grant: grantD, recipient: userCpk, amount: 50n }));

  // (6) revoked
  const revokeB = await timed('revoke_grant_with_jubjub (grant B)', () =>
    account.revokeGrant(jDevice, grantB.id));
  await waitForLedger(
    () => account.ledgerState(),
    'grant B tombstoned',
    (l) => l.grants.member(grantB.id) && l.grants.lookup(grantB.id).active === false,
  );
  rejectDetails.revokeBTx = revokeB.txId;
  await reject('revoked grant (grant B after revoke_grant_with_jubjub)', ['grant revoked'], () =>
    rawGrantSpend({ grant: grantB, recipient: userCpk, amount: 10n }));

  // (7) expired
  await reject('expired grant (grant E, expires_at 100 s in the past)', ['grant expired'], () =>
    rawGrantSpend({ grant: grantE, recipient: userCpk, amount: 50n }));

  // (8) envelope-1 grantee against a spend twin
  await reject('envelope-1 grantee through withdraw_shielded_with_grant_k256 (grant C)', ['envelope not admitted for a spend grant'], () =>
    rawGrantSpend({ grant: grantC, recipient: userCpk, amount: 10n }));

  // (9) a grantee key against a device-gated circuit
  {
    const fakeDevice = new JubjubDevice((jGrantee as any).sk);
    const callCtx = await account.callContext();
    const probeKey = rnd32();
    const auth: JubjubAuthorisation = fakeDevice.sign(
      jubjubChallenges.rotateEncKey(callCtx, fakeDevice.pk, probeKey), 0n,
    );
    await reject('a grantee key against a device-gated circuit (rotate_enc_key_with_jubjub)', ['unknown device entry'], () =>
      account.rotateEncKeyWithAuth(probeKey, auth));
  }

  // (10) cross-arm: the jubjub grantee's key presented at grant B's identity
  {
    const crossOpening: GrantOpening = { ...grantB.opening, originHash: oh, slot: SLOT_B };
    const staleContext: GrantContext = {
      contractAddress: account.addressBytes,
      grantId: account.grantIdOf(jGrantee, oh, SLOT_B),
      issuedAt: 0n,
      grantNonce: 0n,
    };
    await reject("cross-arm: the jubjub grantee's key at grant B's origin and slot", ['unknown grant'], () =>
      rawGrantSpend({
        grant: { ...grantA, grantee: jGrantee, opening: crossOpening } as GrantHandle,
        recipient: userCpk,
        amount: 10n,
        opening: crossOpening,
        context: staleContext,
      }));
  }

  // (11) identical resubmission of a Grant A authorisation
  {
    const g = await account.grantContext(grantA.id);
    const enc = await account.encKey();
    const coin = await account.heldCoin(held.coin.color);
    const predicted = predictChangeCoin(held.coin, 50n);
    const changeEntry = sealInboxEntry(enc, predicted);
    const openingAtSigning: GrantOpening = { ...grantA.opening };
    const auth = (jGrantee as JubjubGrantee).sign(
      jubjubGrantChallenges.withdrawShielded(g, jGrantee.pk, userCpk, held.coin.color, 50n, changeEntry, enc, coin));
    // The call itself is refused (grant A is at its cap), so the replay is
    // of an authorisation that could never settle; the point of the item is
    // WHICH predicate refuses a byte-identical resubmission, and the answer
    // is recorded rather than assumed.
    const first = await reject('replayed grant A authorisation (identical resubmission)', ['cumulative cap exceeded', 'spent opening mismatch', 'invalid grant signature', 'range error'], () =>
      account.withdrawShieldedWithGrantAuth(userCpk, held.coin.color, 50n, changeEntry, enc, openingAtSigning, auth as any));
    rejectDetails.replayRefusedBy = first;
  }

  // (12) stale enc_pk: sign against the live key, rotate, then submit.
  {
    const encOld = await account.encKey();
    const coin = await account.heldCoin(held.coin.color);
    const g = await account.grantContext(grantL.id);
    const predicted = predictChangeCoin(held.coin, 50n);
    const changeEntry = sealInboxEntry(encOld, predicted);
    const openingAtSigning: GrantOpening = { ...grantL.opening };
    const auth = (jGrantee as JubjubGrantee).sign(
      jubjubGrantChallenges.withdrawShielded(g, jGrantee.pk, userCpk, held.coin.color, 50n, changeEntry, encOld, coin));

    const newEncKeys = generateEncKeyPair();
    const rotateTx = await timed('rotate_enc_key_with_k256 (owner rotates between signing and submission)', () =>
      account.rotateEncKey(device, newEncKeys.publicKey));
    await waitForLedger(
      () => account.ledgerState(),
      'enc_key rotated',
      (l) => eq(l.enc_key, newEncKeys.publicKey),
    );
    rejectDetails.rotateEncKeyTx = rotateTx.txId;
    rejectDetails.encKeyOld = bytesToHex(encOld);
    rejectDetails.encKeyNew = bytesToHex(newEncKeys.publicKey);

    await reject('stale enc_pk (grant L signed against the pre-rotation key)', ['stale encryption key'], () =>
      account.withdrawShieldedWithGrantAuth(userCpk, held.coin.color, 50n, changeEntry, encOld, openingAtSigning, auth as any));

    // Entries sealed before the rotation stay readable with the retained
    // secret; the account keeps both, and everything sealed from here on
    // goes to the new key.
    const l = await account.ledgerState();
    let readableWithOld = 0;
    for (let i = 0n; i < l.inbox_count; i++) {
      if (openInboxEntry(encKeys.secretKey, l.inbox.lookup(i))) readableWithOld++;
    }
    rejectDetails.inboxEntriesStillReadableWithTheOldSecret = readableWithOld;
    const oldKeys = encKeys;
    encKeys = { publicKey: newEncKeys.publicKey, secretKey: newEncKeys.secretKey };
    rejectDetails.retainedOldSecret = bytesToHex(oldKeys.secretKey).slice(0, 16) + '…';
  }

  rejectDetails.items = rejections;
  rejectDetails.itemCount = rejections.length;
  console.log(`  ✓ ${rejections.length} rejection items, every one leaving the ledger unchanged`);

  flushEvidence('spend');
  flushEvidence('rejections');
  if (stopAfter('rejections')) return;

  // ══ S7 owner liveness ═════════════════════════════════════════════════════

  step('S7: owner liveness (Testing 3, GR-5, AUTH-8)');
  const livenessDetails = group('liveness');

  // (a) an owner signature pending across a grant call
  const pendingEntry = sealInboxEntry(encKeys.publicKey, { nonce: rnd32(), color: colorMain, value: 0n });
  const ownerCtx = await account.callContext();
  const ownerCounter = await account.resolveUseCounter(device);
  const pendingAuth = device.sign(k256Challenges.appendInbox(ownerCtx, device.pk, pendingEntry), ownerCounter);
  livenessDetails.pendingOwnerSignatureAt = {
    authNonce: ownerCtx.authNonce.toString(),
    useCounter: ownerCounter.toString(),
  };

  const l1a = await grantSpend({
    label: 'withdraw_shielded_with_grant_jubjub (L #1, 100 — between owner signing and submission)',
    grant: grantL,
    recipient: userCpk,
    amount: 100n,
    sealTo: encKeys.publicKey,
  });
  livenessDetails.interveningGrantCallTx = l1a.txId;

  const pendingSubmitted = await timed('append_inbox_with_k256 (pre-signed, submitted after a grant call)', () =>
    account.appendInboxWithAuth(pendingEntry, pendingAuth));
  livenessDetails.pendingOwnerCallTx = pendingSubmitted.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'the pending owner call advanced auth_nonce',
    (l) => l.auth_nonce > ownerCtx.authNonce,
  );
  livenessDetails.ledgerAfterPendingOwnerCall = await snapshot(account);
  console.log(`  ✓ the owner's pre-signed call still verifies after a grant call: ${pendingSubmitted.txId}`);

  // (b) a permissionless deposit between grantee signing and submission
  const auxMint = await timed('faucet mint_shielded (aux color)', () =>
    mintToUser(ctx, faucet, colorSeedAux, MINT_AUX));
  // The index the grantee signs over is resolved first, by proving throwaway
  // calls and submitting none of them: the first run guessed it, the guess was
  // wrong, and the leg could only be closed by re-signing after the deposit,
  // which is the one thing it must not do. S14 leg (b) repeats this on a fresh
  // coin; here it makes the original leg deterministic.
  const legBRes = await resolveIndexByProving({
    label: 'S7 leg (b) coin', coin: held.coin, candidates: changeFirst(held.candidates),
    amount: 100n, grantId: grantL.id, opening: grantL.opening,
  });
  livenessDetails.preSignedCoinResolution = {
    resolved: legBRes.mtIndex?.toString() ?? null,
    attempts: legBRes.attempts,
  };
  if (legBRes.mtIndex !== null) await account.putCoin({ ...held.coin, mtIndex: legBRes.mtIndex });
  const gL = await account.grantContext(grantL.id);
  const encNow = await account.encKey();
  const coinNow = await account.heldCoin(held.coin.color);
  const predictedL2 = predictChangeCoin(held.coin, 100n);
  const changeEntryL2 = sealInboxEntry(encKeys.publicKey, predictedL2);
  const openingL2: GrantOpening = { ...grantL.opening };
  const authL2 = (jGrantee as JubjubGrantee).sign(
    jubjubGrantChallenges.withdrawShielded(gL, jGrantee.pk, userCpk, held.coin.color, 100n, changeEntryL2, encNow, coinNow));
  livenessDetails.granteeSignedAt = { grantNonce: gL.grantNonce.toString(), issuedAt: gL.issuedAt.toString() };

  const auxEntry = sealInboxEntry(encKeys.publicKey, auxMint);
  const inboxBeforeDeposit = (await account.ledgerState()).inbox_count;
  const auxDeposit = await timed('deposit_shielded (permissionless, between grantee signing and submission)', () =>
    account.depositShielded({ nonce: auxMint.nonce, color: auxMint.color, value: auxMint.value }, auxEntry));
  livenessDetails.interveningDepositTx = auxDeposit.txId;
  const afterDeposit = await waitForLedger(
    () => account.ledgerState(),
    'the permissionless deposit landed',
    (l) => l.inbox_count > inboxBeforeDeposit,
  );
  livenessDetails.roundBeforeGranteeCall = afterDeposit.round.toString();

  // The pre-signed call is submitted exactly as signed. Its qualified coin
  // (mt_index included) is bound into the challenge, so a wrong candidate
  // index can only be recovered by re-signing, which would place the
  // signature after the deposit and weaken the property under test; that
  // fallback is therefore recorded when it is used.
  let l2: { txId: string; change: ShieldedCoin | null };
  let preSignedLanded = true;
  try {
    l2 = await timed('withdraw_shielded_with_grant_jubjub (L #2, pre-signed across a deposit)', () =>
      account.withdrawShieldedWithGrantAuth(userCpk, held.coin.color, 100n, changeEntryL2, encNow, openingL2, authL2 as any));
  } catch (e: any) {
    preSignedLanded = false;
    livenessDetails.preSignedFirstAttemptError = String(e?.message ?? e).slice(0, 200);
    setVerdict('liveness', 'PARTIAL');
    let landed: any = null;
    for (const idx of changeFirst(held.candidates)) {
      await account.putCoin({ ...held.coin, mtIndex: idx });
      try {
        const gRetry = await account.grantContext(grantL.id);
        const coinRetry = await account.heldCoin(held.coin.color);
        const authRetry = (jGrantee as JubjubGrantee).sign(
          jubjubGrantChallenges.withdrawShielded(gRetry, jGrantee.pk, userCpk, held.coin.color, 100n, changeEntryL2, encNow, coinRetry));
        landed = await timed('withdraw_shielded_with_grant_jubjub (L #2, re-signed after the deposit)', () =>
          account.withdrawShieldedWithGrantAuth(userCpk, held.coin.color, 100n, changeEntryL2, encNow, openingL2, authRetry as any));
        break;
      } catch { /* next candidate */ }
    }
    if (!landed) throw e;
    l2 = landed;
  }
  livenessDetails.preSignedCallLandedAsSigned = preSignedLanded;
  grantL.opening.spentPrev += 100n;
  livenessDetails.granteeCallAfterDepositTx = l2.txId;
  const changeMatchedL2 = !!l2.change && eq(l2.change.nonce, predictedL2.nonce) && l2.change.value === predictedL2.value;
  changePredictions.push({
    label: 'L #2 (pre-signed across a deposit)',
    predictedNonce: bytesToHex(predictedL2.nonce),
    predictedValue: predictedL2.value.toString(),
    actualNonce: l2.change ? bytesToHex(l2.change.nonce) : null,
    actualValue: l2.change ? l2.change.value.toString() : null,
    matched: changeMatchedL2,
  });
  const afterL2 = await waitForLedger(
    () => account.ledgerState(),
    'the pre-signed grantee call settled',
    (l) => l.round > afterDeposit.round,
  );
  livenessDetails.roundAfterGranteeCall = afterL2.round.toString();
  livenessDetails.grantLRecordAfter = recordOf(afterL2, grantL.id);
  await sleep(5_000);
  if (l2.change) {
    const cand = await candidateIndices(l2.txId);
    held.coin = { nonce: l2.change.nonce, color: l2.change.color, value: l2.change.value };
    held.candidates = cand.candidates;
    await account.putCoin({ ...held.coin, mtIndex: changeFirst(cand.candidates)[0] });
  }
  livenessDetails.ledgerAfterGranteeCall = await snapshot(account);
  // The tick belongs only to the leg that actually held: if the call signed
  // BEFORE the deposit did not land and a re-signed one did, the property
  // under test was not shown, and the line says so where it is read.
  console.log(
    preSignedLanded
      ? `  ✓ a permissionless deposit did not invalidate the pending grantee call: ${l2.txId}`
      : '  ⚠ PARTIAL: the call signed BEFORE the deposit did NOT land ' +
        `(${String(livenessDetails.preSignedFirstAttemptError)}); only a call RE-SIGNED after the deposit ` +
        `landed (${l2.txId}), over a recovered qualified-coin index, so this leg does not show that a ` +
        'permissionless deposit leaves a pending grantee call valid.',
  );

  flushEvidence('liveness');
  if (stopAfter('liveness')) return;

  // ══ S8 direct transfer under a grant ══════════════════════════════════════

  step('S8: direct transfer under a grant — the contract-recipient twin composed with the payee claim');
  const directDetails = group('direct');
  try {
    const deviceB = K256Device.generate();
    const encKeysB = generateEncKeyPair();
    const accountB = await timed(`deploy:account-B (${plan.length} waves + activate)`, () =>
      deployAccount(ctx, deviceB, encKeysB));
    directDetails.accountB = accountB.address;
    console.log(`  account B @ ${accountB.address}`);

    const scopeF = spendScope({
      withdrawShieldedToContract: true,
      color: colorMain,
      cap: 200n,
      perCallCap: 150n,
      maxCoinValue: 1000n,
      recipientKind: RECIPIENT_CONTRACT_ADDRESS,
      recipient: accountB.addressBytes,
      readPkHash,
    });
    const grantF = await issue('F', 'k256', kGrantee, SLOT_F, scopeF);
    directDetails.grantF = { grantId: bytesToHex(grantF.id), slot: SLOT_F.toString() };

    const DIRECT = 150n;
    const inboxABefore = (await account.ledgerState()).inbox_count;
    // The composed transaction proves TWO circuits, one of them k = 17, and
    // that is the run's memory peak: on the reference stack it OOM-killed
    // the prover mid-proof. Hand it a fresh process.
    await restartProver('the composed direct transfer');
    const composeAttempts: Array<Record<string, string>> = [];
    let composedTxId: string | null = null;
    let sent: any = null;
    let changeA: any = null;

    const pointAt = async (address: string) => {
      const p = ctx.providers.privateStateProvider;
      if (typeof p.setContractAddress === 'function') await p.setContractAddress(address);
    };

    for (const idx of changeFirst(held.candidates)) {
      // The previous round left the private-state provider pointed at account
      // B; write and read A's coin store with it pointed at A, or the witness
      // the circuit consumes is not the coin the grantee signed over and the
      // seam refuses with `invalid grant signature`.
      await pointAt(account.address);
      await account.putCoin({ ...held.coin, mtIndex: idx });
      try {
        const gF = await account.grantContext(grantF.id);
        const encF = await account.encKey();
        const coinF = await account.heldCoin(held.coin.color);
        const predictedF = predictChangeCoin(held.coin, DIRECT);
        const changeEntryF = sealInboxEntry(encKeys.publicKey, predictedF);
        const authF = (kGrantee as K256Grantee).sign(
          k256GrantChallenges.withdrawShieldedToContract(
            gF, kGrantee.pk, accountB.addressBytes, held.coin.color, DIRECT, changeEntryF, encF, coinF));

        await pointAt(account.address);
        const callA: any = await timed('withdraw_shielded_to_contract_with_grant_k256 (build)', () =>
          (createUnprovenCallTx as any)(ctx.providers, {
            compiledContract: compiledAccountContract(),
            circuitId: 'withdraw_shielded_to_contract_with_grant_k256',
            contractAddress: account.address,
            args: [
              { bytes: accountB.addressBytes },
              held.coin.color,
              DIRECT,
              changeEntryF,
              encF,
              ...grantAuthArgs(grantF.opening, authF as any),
            ],
            privateStateId: account.privateStateId,
          }));

        const resultA = callA?.private?.result;
        if (!Array.isArray(resultA) || !resultA[0]?.nonce) {
          throw new Error('[sent, change] not found on the unproven call result');
        }
        sent = resultA[0];
        changeA = resultA[1]?.is_some ? resultA[1].value : null;
        directDetails.sentNoncePredicted = bytesToHex(predictSentCoin(held.coin, DIRECT).nonce);
        directDetails.sentNonceActual = bytesToHex(sent.nonce);
        directDetails.changeNoncePredicted = bytesToHex(predictedF.nonce);
        directDetails.changeNonceActual = changeA ? bytesToHex(changeA.nonce) : null;

        const directEntryB = sealInboxEntry(encKeysB.publicKey, {
          nonce: sent.nonce, color: sent.color, value: sent.value,
        });
        await pointAt(accountB.address);
        const callB: any = await (createUnprovenCallTx as any)(ctx.providers, {
          compiledContract: compiledAccountContract(),
          circuitId: 'deposit_shielded',
          contractAddress: accountB.address,
          args: [{ nonce: sent.nonce, color: sent.color, value: sent.value }, directEntryB],
          privateStateId: accountB.privateStateId,
        });

        const txA = callA?.private?.unprovenTx;
        const txB = callB?.private?.unprovenTx;
        if (!txA || !txB) throw new Error('unprovenTx missing from UnsubmittedCallTxData.private');
        const intentB = [...(txB.intents as Map<number, any>).values()][0];
        if (!intentB) throw new Error('cannot extract B’s intent');
        const composed = txA.addIntent({ tag: 'random' }, intentB) ?? txA;

        const finalized: any = await timed('submit composed direct transfer (grant twin + payee claim)', () =>
          (submitTx as any)(ctx.providers, {
            unprovenTx: composed,
            circuitId: ['withdraw_shielded_to_contract_with_grant_k256', 'deposit_shielded'],
          }));
        composedTxId = finalized?.txId ?? finalized?.transactionHash;
        composeAttempts.push({ mtIndex: idx.toString(), outcome: `accepted: ${composedTxId}` });
        grantF.opening.spentPrev += DIRECT;
        break;
      } catch (e: any) {
        composeAttempts.push({ mtIndex: idx.toString(), outcome: `rejected: ${String(e?.message).slice(0, 160)}` });
      }
    }
    directDetails.composeAttempts = composeAttempts;

    if (!composedTxId) {
      directDetails.outcome = 'composition never landed for any candidate index';
      setVerdict('direct', 'PARTIAL');
      console.log('  ⚠ the composed direct transfer did not land; recorded PARTIAL and moving on');
    } else {
      directDetails.composedTxId = composedTxId;
      await sleep(10_000);
      const ledgerB = await waitForLedger(
        () => accountB.ledgerState(),
        'B claimed the direct transfer',
        (l) => l.inbox_count >= 1n,
      );
      directDetails.inboxB = ledgerB.inbox_count.toString();
      const ledgerAafter = await account.ledgerState();
      directDetails.inboxABefore = inboxABefore.toString();
      directDetails.inboxAAfter = ledgerAafter.inbox_count.toString();
      directDetails.inboxAGrewByOne = ledgerAafter.inbox_count === inboxABefore + 1n;
      const recF = recordOf(ledgerAafter, grantF.id)!;
      directDetails.grantFRecord = recF;
      directDetails.grantFNonceIsOne = recF.nonce === '1';
      if (!directDetails.inboxAGrewByOne || !directDetails.grantFNonceIsOne) {
        setVerdict('direct', 'PARTIAL');
      }
      if (changeA) {
        const cand = await candidateIndices(composedTxId);
        held.coin = { nonce: changeA.nonce, color: changeA.color, value: changeA.value };
        held.candidates = cand.candidates.length ? cand.candidates : held.candidates;
        await account.putCoin({ ...held.coin, mtIndex: changeFirst(held.candidates)[0] });
        directDetails.changeCandidates = held.candidates.map(String);
      }
      console.log(`  ✓ composed direct transfer accepted: ${composedTxId}`);
    }
  } catch (e: any) {
    directDetails.error = serialiseError(e);
    setVerdict('direct', 'PARTIAL');
    console.log(`  ⚠ S8 aborted: ${String(e?.message).slice(0, 200)} — recorded PARTIAL and moving on`);
  }

  flushEvidence('direct');
  if (stopAfter('direct')) return;

  // ══ S9 kill totality ══════════════════════════════════════════════════════

  step('S9: kill totality — revoke_all_grants, then re-issue under the new generation');
  const killDetails = group('kill');
  const beforeKill = await account.ledgerState();
  killDetails.grantGenerationBefore = beforeKill.grant_generation.toString();
  killDetails.grantCountBefore = beforeKill.grants.size().toString();

  const revokeAll = await timed('revoke_all_grants_with_jubjub', () => account.revokeAllGrants(jDevice));
  killDetails.revokeAllTx = revokeAll.txId;
  const afterKill = await waitForLedger(
    () => account.ledgerState(),
    'grant_generation bumped and the register cleared',
    (l) => l.grant_generation === beforeKill.grant_generation + 1n,
  );
  killDetails.grantGenerationAfter = afterKill.grant_generation.toString();
  killDetails.grantsEmptyAfter = afterKill.grants.isEmpty();
  killDetails.grantCountAfter = afterKill.grants.size().toString();
  if (afterKill.grant_generation !== 1n) {
    setVerdict('kill', 'FAIL');
    throw new Error(`grant_generation ${afterKill.grant_generation}, expected 1`);
  }
  if (!afterKill.grants.isEmpty()) {
    setVerdict('kill', 'FAIL');
    throw new Error('revoke_all_grants did not clear the register');
  }
  console.log('  ✓ generation 1, register empty');

  {
    const staleContext: GrantContext = {
      contractAddress: account.addressBytes,
      grantId: grantA.id,
      issuedAt: BigInt(String(recA3.issued_at)),
      grantNonce: BigInt(String(recA3.nonce)),
    };
    const before = await snapshot(account);
    const msg = await expectAbort("grant A's next spend after revoke_all_grants", () =>
      rawGrantSpend({ grant: grantA, recipient: userCpk, amount: 10n, spentPrevOverride: 0n, context: staleContext }));
    const after = await snapshot(account);
    killDetails.postKillSpendError = msg;
    killDetails.postKillStateUnchanged = sameSnapshot(before, after);
    killDetails.postKillMatchedUnknownGrant = msg.includes('unknown grant');
    if (!killDetails.postKillMatchedUnknownGrant) {
      console.log(`  ⚠ expected "unknown grant", got: ${msg.slice(0, 200)}`);
      setVerdict('kill', 'PARTIAL');
    }
  }

  const scopeAReissued = spendScope({
    withdrawShielded: true,
    color: colorMain,
    cap: 100n,
    perCallCap: 50n,
    maxCoinValue: 1000n,
    readPkHash,
  });
  const grantA2 = await issue('A (re-issued under generation 1)', 'k256', jGrantee, SLOT_A, scopeAReissued);
  const recReissued = recordOf(await account.ledgerState(), grantA2.id)!;
  killDetails.reissuedRecord = recReissued;
  killDetails.reissuedGenerationIsOne = recReissued.gen === '1';
  killDetails.reissuedNonceIsZero = recReissued.nonce === '0';

  const reissuedSpend = await grantSpend({
    label: 'withdraw_shielded_with_grant_jubjub (re-issued A, 25)',
    grant: grantA2,
    recipient: userCpk,
    amount: 25n,
    sealTo: encKeys.publicKey,
  });
  const afterReissuedSpend = await account.ledgerState();
  killDetails.reissuedSpendTx = reissuedSpend.txId;
  killDetails.reissuedRecordAfterSpend = recordOf(afterReissuedSpend, grantA2.id);
  console.log(`  ✓ a spend under the new generation succeeds: ${reissuedSpend.txId}`);

  flushEvidence('kill');
  if (stopAfter('kill')) return;

  // ══ S11 to S14: shared plumbing ═══════════════════════════════════════════
  //
  // The four sections below close the on-node items the first run left open.
  // Each is wrapped so that a surprise in one does not cost the evidence of
  // the others; what they share lives here.

  /** Point the private-state provider at account A. Every direct
   *  `createUnprovenCallTx` below reads the coin store through it. Declared
   *  as a function so the earlier scenarios can use it too: S8 points the
   *  provider at account B mid-loop, and whatever runs next must point it
   *  back before it touches the coin store. */
  async function pointAtA(): Promise<void> {
    const p = ctx.providers.privateStateProvider;
    if (typeof p.setContractAddress === 'function') await p.setContractAddress(account.address);
  }

  /** The coins the S11 refill deposits, in deposit order. */
  const refills: Held[] = [];

  const coinPublicKeyHex = parseCoinPublicKeyToHex(
    ctx.providers.walletProvider.getCoinPublicKey(), getNetworkId());
  const walletEncPk = ctx.providers.walletProvider.getEncryptionPublicKey();

  interface CallSpec { circuitId: string; args: unknown[] }

  /** Build one call against an explicit contract state (no chain read). */
  async function buildOn(states: ChainStates, spec: CallSpec): Promise<any> {
    await pointAtA();
    const privateState = await ctx.providers.privateStateProvider.get(account.privateStateId);
    setPhase('build');
    return (createUnprovenCallTxFromInitialStates as any)(
      ctx.providers.zkConfigProvider,
      {
        compiledContract: compiledAccountContract(),
        circuitId: spec.circuitId,
        contractAddress: account.address,
        args: spec.args,
        coinPublicKey: coinPublicKeyHex,
        initialContractState: states.contractState,
        initialZswapChainState: states.zswap,
        ledgerParameters: states.ledgerParameters,
        initialPrivateState: privateState,
      },
      walletEncPk,
    );
  }

  /**
   * Graft the second call's intent onto the first call's transaction, in the
   * given segment order (ascending puts the first call in the lower segment),
   * and carry the second call's Zswap offer across with it.
   *
   * The offer is the part `addIntent` alone does not move, and it is what the
   * first attempt at this section got wrong. An Intent holds the contract
   * actions and the UNSHIELDED offers; a contract call's SHIELDED inputs and
   * outputs live on the transaction's guaranteed Zswap offer, which is
   * transaction-global rather than per segment. Grafting the intent alone
   * therefore produces a transaction whose transcript claims nullifiers no
   * offer carries, and the node refuses it before execution with
   * `Malformed(EffectsCheck(NullifiersNeqClaimedNullifiers))` (measured; see
   * GRANTS-E2.md). Merging the two guaranteed offers is the whole fix, and it
   * is a no-op for a second call that moves no coin, such as a lifecycle call.
   */
  /** Thrown when the pair cannot be ordered as asked without invalidating a
   *  Zswap proof; the caller rebuilds, which redraws the segment ids. */
  class SegmentOrderNeedsRebuild extends Error {}

  function graft(first: any, second: any, order: 'ascending' | 'descending'): {
    composed: any; segments: number[]; offerMerged: boolean;
    offerShapes: Record<string, unknown>;
  } {
    const tx1 = first.private.unprovenTx;
    const tx2 = second.private.unprovenTx;
    const s1 = Number([...(tx1.intents as Map<number, any>).keys()][0]);
    const s2 = Number([...(tx2.intents as Map<number, any>).keys()][0]);
    const intent2 = [...(tx2.intents as Map<number, any>).values()][0];
    if (!intent2) throw new Error('the second call carries no intent to graft');

    // Each of these is a wasm-backed accessor: read it ONCE into a local.
    const shape = (o: any) => (o ? { inputs: o.inputs?.length ?? null, outputs: o.outputs?.length ?? null } : null);
    const fallibleShape = (m: any) => (m ? [...(m as Map<number, any>).entries()].map(([k, v]) => [k, shape(v)]) : null);
    const ownOffer = tx1.guaranteedOffer;
    const theirOffer = tx2.guaranteedOffer;
    const theirFallible = tx2.fallibleOffer as Map<number, any> | undefined;
    const before = {
      ownGuaranteed: shape(ownOffer),
      theirGuaranteed: shape(theirOffer),
      ownFallible: fallibleShape(tx1.fallibleOffer),
      theirFallible: fallibleShape(theirFallible),
      firstSegment: s1,
      secondSegment: s2,
    };

    // Where a call's coin operations land is the SDK's partitioning decision
    // and it is not stable: the same circuit put its input and outputs in the
    // GUARANTEED offer on one run and in the FALLIBLE offer, keyed by the
    // call's own segment, on the next. The guaranteed offer is
    // transaction-global, so it can be merged and the intent placed at any
    // segment; a fallible offer's proofs are bound to their segment, and
    // moving it is refused by the node with `Malformed(Zswap(InvalidProof))`.
    // So a second call whose coins are fallible must keep its own segment, and
    // the ordering is then whatever the SDK's random draw gave: if it is the
    // wrong way round the caller rebuilds.
    const pinned = !!theirFallible && (theirFallible as Map<number, any>).size > 0;
    const target = pinned ? s2 : (order === 'ascending' ? s1 + 1 : s1 - 1);
    if (pinned) {
      const wanted = order === 'ascending' ? s2 > s1 : s2 < s1;
      if (!wanted) {
        throw new SegmentOrderNeedsRebuild(
          `the second call's coins are pinned to segment ${s2} and the first sits at ${s1}, ` +
          `which is the wrong way round for the ${order} case`,
        );
      }
    }
    if (target < 1 || target > 65535) {
      throw new Error(
        `cannot place the second intent at segment ${target} (the first call landed at ${s1}); ` +
        'segments are 1..65535, so this pair cannot be ordered as asked — rebuild and retry',
      );
    }

    let out = tx1.addIntent({ tag: 'specific', value: target }, intent2) ?? tx1;
    let offerMerged = false;
    if (theirOffer) {
      const mine = out.guaranteedOffer;
      out.guaranteedOffer = mine ? mine.merge(theirOffer) : theirOffer;
      offerMerged = true;
    }
    if (theirFallible) {
      for (const [seg, offer] of theirFallible as Map<number, any>) {
        out = out.addZswapOffer({ tag: 'specific', value: Number(seg) }, offer) ?? out;
        offerMerged = true;
      }
    }
    return {
      composed: out,
      segments: [...(out.intents as Map<number, any>).keys()].map(Number).sort((a, b) => a - b),
      offerMerged,
      offerShapes: {
        before,
        pinnedToItsOwnSegment: pinned,
        after: { guaranteed: shape(out.guaranteedOffer), fallible: fallibleShape(out.fallibleOffer) },
      },
    };
  }


  /** Find a coin's commitment-tree index by proving a call per candidate and
   *  submitting none of them (INV-5: a wrong index is unsatisfiable). */
  async function resolveIndexByProving(o: {
    label: string; coin: PlainCoin; candidates: bigint[]; amount: bigint;
    grantId: Uint8Array; opening: GrantOpening;
  }): Promise<{ mtIndex: bigint | null; attempts: Array<Record<string, string>> }> {
    const attempts: Array<Record<string, string>> = [];
    const queue = [...o.candidates];
    let retries = 0;
    for (let idx = queue.shift(); idx !== undefined; idx = queue.shift()) {
      await account.putCoin({ ...o.coin, mtIndex: idx });
      try {
        const g = await account.grantContext(o.grantId);
        const enc = await account.encKey();
        const qualified = await account.heldCoin(o.coin.color);
        const predicted = predictChangeCoin(o.coin, o.amount);
        const entry = sealInboxEntry(enc, predicted);
        const auth = (jGrantee as JubjubGrantee).sign(
          jubjubGrantChallenges.withdrawShielded(
            g, jGrantee.pk, userCpk, o.coin.color, o.amount, entry, enc, qualified));
        await pointAtA();
        const built: any = await (createUnprovenCallTx as any)(ctx.providers, {
          compiledContract: compiledAccountContract(),
          circuitId: 'withdraw_shielded_with_grant_jubjub',
          contractAddress: account.address,
          args: [
            { bytes: userCpk }, o.coin.color, o.amount, entry, enc,
            ...grantAuthArgs(o.opening, auth as any),
          ],
          privateStateId: account.privateStateId,
        });
        await timed(`${o.label}: prove-only trial at mt_index ${idx}`, () =>
          proveOnly(ctx.providers, built.private.unprovenTx));
        attempts.push({ mtIndex: idx.toString(), outcome: 'proved (nothing submitted)' });
        return { mtIndex: idx, attempts };
      } catch (e: any) {
        const message = String(e?.message ?? e);
        if (proverOutage(message) && retries < 3) {
          retries++;
          console.log(`  (the proof server dropped during the trial at mt_index ${idx}; restoring it and retrying)`);
          attempts.push({ mtIndex: idx.toString(), outcome: `prover outage, retried: ${message.slice(0, 100)}` });
          await ensureProver(o.label);
          queue.unshift(idx);
          continue;
        }
        attempts.push({ mtIndex: idx.toString(), outcome: `unsatisfiable: ${message.slice(0, 120)}` });
      }
    }
    return { mtIndex: null, attempts };
  }

  // ══ S11 grantee-key validation ════════════════════════════════════════════
  //
  // Section 3.3 states key validation as "performed by the authoriser at
  // issuance and by the seam at every use". The issuance half cannot exist
  // in-circuit: `issue_grant` takes `grant_id`, a 32-byte commitment the
  // client computed, and never the key, so every row below ISSUES cleanly and
  // is refused, if at all, at the twin. Each row therefore records three
  // things: whether the issue landed, where the spend refusal landed, and the
  // verbatim text.

  step('S11: grantee-key validation on both arms (Testing 2 key rows; GR-14, GR-4, GR-2)');
  const keyDetails = group('keys');
  try {
    const keyRows: Array<Record<string, unknown>> = [];
    // Attached now, not at the end: the array is the same object, so a row is
    // in the evidence the moment it is pushed, even if a later row throws.
    keyDetails.rows = keyRows;


    // Re-funding. S3's 1,000 is spent down to a handful of units by S9, and the
    // sections below need headroom plus three more coins of the working color:
    // one coin can be consumed once, S13 composes two grant calls in one
    // transaction, and its ordering control may consume a coin of its own.
    for (const round of [1, 2, 3, 4]) {
      const m: MintedCoin = await timed(`faucet mint_shielded (refill ${round})`, () =>
        mintToUser(ctx, faucet, colorSeedMain, 1000n));
      const entry = sealInboxEntry(encKeys.publicKey, m);
      const dep = await timed(`deposit_shielded (refill ${round})`, () =>
        account.depositShielded({ nonce: m.nonce, color: m.color, value: m.value }, entry));
      await sleep(10_000);
      const cand = await candidateIndices(dep.txId);
      refills.push({ coin: { nonce: m.nonce, color: m.color, value: m.value }, candidates: cand.candidates });
      console.log(`  refill ${round}: deposited 1000 (${dep.txId}), candidates ${cand.candidates.join(', ')}`);
    }
    keyDetails.refillDeposits = refills.map((r) => ({
      value: r.coin.value.toString(),
      nonce: bytesToHex(r.coin.nonce),
      candidates: r.candidates.map(String),
    }));
    const abandoned = { ...held.coin };
    held.coin = refills[0].coin;
    held.candidates = refills[0].candidates;
    await account.putCoin({ ...held.coin, mtIndex: held.candidates[0] });
    keyDetails.coinAbandonedAfterS9 = { value: abandoned.value.toString(), nonce: bytesToHex(abandoned.nonce) };

    const WIDE = spendScope({
      withdrawShielded: true,
      color: colorMain,
      cap: 100n,
      perCallCap: 50n,
      maxCoinValue: 5000n,
      readPkHash,
    });

    /** Issue a grant at a raw id — the id of a key the client cannot sign with. */
    async function issueAt(label: string, id: Uint8Array, slot: bigint, scope: any = WIDE): Promise<{
      id: Uint8Array; salt: Uint8Array; opening: GrantOpening; txId: string;
    }> {
      const salt = rnd32();
      const before = await account.ledgerState();
      const tx = await timed(`issue_grant_with_jubjub (${label})`, () =>
        account.issueGrant(jDevice, id, scope, salt));
      await waitForLedger(
        () => account.ledgerState(),
        `${label}: record present`,
        (l) => l.grants.member(id) && l.auth_nonce === before.auth_nonce + 1n,
      );
      return { id, salt, opening: openingOf(scope, salt, oh, slot), txId: tx.txId };
    }

    /** One spend attempt under an arbitrary key and a dummy signature. Nothing
     *  here can produce a valid signature: the point of the row is WHICH
     *  predicate refuses, and at which stage. */
    async function spendUnderKey(o: {
      arm: 'k256' | 'jubjub';
      pk: any;
      envelope?: bigint;
      opening: GrantOpening;
      amount?: bigint;
    }): Promise<unknown> {
      const amount = o.amount ?? 10n;
      const enc = await account.encKey();
      const predicted = predictChangeCoin(held.coin, amount);
      const changeEntry = sealInboxEntry(enc, predicted);
      const auth: any = o.arm === 'k256'
        ? { arm: 'k256', pk: o.pk, envelope: o.envelope ?? K256_ENVELOPE_NONE, sig: { r: 1n, s: 1n } }
        : {
            arm: 'jubjub', pk: o.pk,
            sig_r: pureCircuits.compute_public_point_with_jubjub(1n),
            sig_s: 0n, grind_nonce: 0n,
          };
      return account.withdrawShieldedWithGrantAuth(
        userCpk, held.coin.color, amount, changeEntry, enc, o.opening, auth,
      );
    }

    /** Run one key row: record the ledger either side, the stage, and the text. */
    async function keyRow(o: {
      item: string;
      what: string;
      issuedTx: string | null;
      grantId: Uint8Array;
      expect: string[];
      run: () => Promise<unknown>;
    }): Promise<string> {
      const before = await snapshot(account);
      setPhase('build');
      let message = '';
      let chain: Record<string, unknown> | null = null;
      let stage: Phase = 'build';
      let landed: string | null = null;
      try {
        const r: any = await o.run();
        landed = r?.txId ?? '(a transaction was accepted)';
        stage = 'submitted';
      } catch (e: any) {
        stage = phaseNow();
        message = String(e?.message ?? e);
        chain = serialiseError(e);
      }
      const after = await snapshot(account);
      const unchanged = sameSnapshot(before, after);
      const matched = o.expect.length === 0 || o.expect.some((n) => message.includes(n));
      keyRows.push({
        item: o.item,
        what: o.what,
        issueTx: o.issuedTx,
        grantId: bytesToHex(o.grantId),
        expected: o.expect,
        matchedExpected: matched,
        refusalStage: landed ? 'none (accepted)' : stage,
        transactionSubmitted: landed !== null,
        txId: landed,
        error: message,
        errorChain: chain,
        ledgerBefore: before,
        ledgerAfter: after,
        stateUnchanged: unchanged,
      });
      if (landed) {
        console.log(`  ⚠ ${o.item}: ACCEPTED (${landed})`);
      } else {
        console.log(`  ✓ ${o.item}: refused at ${stage} — ${message.slice(0, 110)}`);
        if (!matched) {
          console.log(`    ⚠ expected one of ${JSON.stringify(o.expect)}`);
          setVerdict('keys', 'PARTIAL');
        }
        if (!unchanged) {
          setVerdict('keys', 'FAIL');
          throw new Error(`${o.item}: the ledger moved under a refused call`);
        }
      }
      return message;
    }

    // ── k256 arm ──────────────────────────────────────────────────────────────

    // (1) and (2): the point at infinity in BOTH encodings the type admits. The
    //     identity derivation binds x and y only, so the two encodings share one
    //     grant_id and one record; the guard compares coordinates, not the flag.
    const k1IdFlagged = { x: 0n, y: 0n, identity: true } as Secp256k1Point;
    const k1IdUnflagged = { x: 0n, y: 0n, identity: false } as Secp256k1Point;
    const idFlaggedId = pureCircuits.derive_grant_id_with_k256(
      { bytes: account.addressBytes }, k1IdFlagged, K256_ENVELOPE_NONE, oh, 20n);
    const idUnflaggedId = pureCircuits.derive_grant_id_with_k256(
      { bytes: account.addressBytes }, k1IdUnflagged, K256_ENVELOPE_NONE, oh, 20n);
    keyDetails.k256IdentityEncodingsShareOneGrantId = eq(idFlaggedId, idUnflaggedId);
    const idGrant = await issueAt('k256 identity point', idFlaggedId, 20n);
    keyDetails.issuanceFinding =
      'ISSUED WITHOUT COMPLAINT. issue_grant_with_<arm> takes grant_id (Bytes<32>) and never the grantee key, ' +
      'so the contract cannot apply the section 3.3 checks at issuance; and CustodyAccount.issueGrant, which is ' +
      'this package\'s authoriser, does not apply them either. Every weak-key row below therefore has a live, ' +
      'well-formed record behind it, and the only thing that refuses is the seam at use.';
    await keyRow({
      item: 'k1 identity, flagged encoding {0, 0, identity: true}',
      what: 'the secp256k1 point at infinity as a grantee key',
      issuedTx: idGrant.txId,
      grantId: idFlaggedId,
      expect: ['device key is the point at infinity'],
      run: () => spendUnderKey({ arm: 'k256', pk: k1IdFlagged, opening: idGrant.opening }),
    });
    await keyRow({
      item: 'k1 identity, unflagged twin {0, 0, identity: false}',
      what: 'the same point under the encoding a flag-based guard would miss; same grant_id, same record',
      issuedTx: idGrant.txId,
      grantId: idUnflaggedId,
      expect: ['device key is the point at infinity'],
      run: () => spendUnderKey({ arm: 'k256', pk: k1IdUnflagged, opening: idGrant.opening }),
    });

    // (3) off-curve coordinates: y^2 != x^3 + 7, and on no curve of that shape
    //     that the runtime knows about.
    const k1Off = { x: 1n, y: 1n, identity: false } as Secp256k1Point;
    keyDetails.k256OffCurveIsOffCurve = !onSecp256k1(1n, 1n);
    const offId = pureCircuits.derive_grant_id_with_k256(
      { bytes: account.addressBytes }, k1Off, K256_ENVELOPE_NONE, oh, 21n);
    const offGrant = await issueAt('k256 off-curve pair', offId, 21n);
    await keyRow({
      item: 'k1 off-curve coordinate pair (1, 1)',
      what: 'a coordinate pair satisfying no secp256k1 point equation',
      issuedTx: offGrant.txId,
      grantId: offId,
      expect: [],
      run: () => spendUnderKey({ arm: 'k256', pk: k1Off, opening: offGrant.opening }),
    });

    // (4) the invalid-curve twin: a genuine point of y^2 = x^3 + b for b != 7.
    const twin = invalidCurvePoint(2n);
    const k1Twin = { x: twin.x, y: twin.y, identity: false } as Secp256k1Point;
    keyDetails.k256InvalidCurvePoint = {
      curve: `y^2 = x^3 + ${twin.b}`,
      x: twin.x.toString(),
      y: twin.y.toString(),
      onSecp256k1: onSecp256k1(twin.x, twin.y),
    };
    const twinId = pureCircuits.derive_grant_id_with_k256(
      { bytes: account.addressBytes }, k1Twin, K256_ENVELOPE_NONE, oh, 22n);
    const twinGrant = await issueAt('k256 invalid-curve twin', twinId, 22n);
    await keyRow({
      item: `k1 invalid-curve twin on y^2 = x^3 + ${twin.b}`,
      what: 'a well-formed point of a different curve of the same shape — what an invalid-curve attack presents',
      issuedTx: twinGrant.txId,
      grantId: twinId,
      expect: [],
      run: () => spendUnderKey({ arm: 'k256', pk: k1Twin, opening: twinGrant.opening }),
    });

    // (5) another curve's shape, which is also the cross-arm row in the k256
    //     direction: the jubjub grantee's coordinates presented as a k256 key.
    try {
      const jAsK1 = { x: (jGrantee.pk as any).x, y: (jGrantee.pk as any).y, identity: false } as Secp256k1Point;
      const jAsK1Id = pureCircuits.derive_grant_id_with_k256(
        { bytes: account.addressBytes }, jAsK1, K256_ENVELOPE_NONE, oh, 23n);
      const jAsK1Grant = await issueAt('jubjub key as a k256 grantee', jAsK1Id, 23n);
      await keyRow({
        item: "v1 grantee key presented against the k256 twin (another curve's shape)",
        what: 'the JubJub grantee key\'s coordinates carried as a Secp256k1Point through withdraw_shielded_with_grant_k256',
        issuedTx: jAsK1Grant.txId,
        grantId: jAsK1Id,
        expect: [],
        run: () => spendUnderKey({ arm: 'k256', pk: jAsK1, opening: jAsK1Grant.opening }),
      });
    } catch (e: any) {
      keyRows.push({
        item: "v1 grantee key presented against the k256 twin (another curve's shape)",
        what: 'the JubJub grantee key coordinates carried as a Secp256k1Point',
        refusalStage: 'before a transaction exists (client-side encoding or issuance)',
        transactionSubmitted: false,
        error: String(e?.message ?? e),
      });
      console.log(`  ✓ v1 key against the k256 twin: refused client-side — ${String(e?.message).slice(0, 140)}`);
    }

    // ── jubjub arm ────────────────────────────────────────────────────────────

    // (6) the identity (0, 1): on the curve, well-formed grant_id, and the
    //     cofactor-clearing guard is the only thing that rejects it.
    const jId = { x: 0n, y: 1n } as JubjubPoint;
    const jIdId = pureCircuits.derive_grant_id_with_jubjub({ bytes: account.addressBytes }, jId, oh, 24n);
    const jIdGrant = await issueAt('jubjub identity (0, 1)', jIdId, 24n);
    await keyRow({
      item: 'v1 identity (0, 1)',
      what: 'the JubJub identity as a grantee key',
      issuedTx: jIdGrant.txId,
      grantId: jIdId,
      expect: ['grantee key has small order'],
      run: () => spendUnderKey({ arm: 'jubjub', pk: jId, opening: jIdGrant.opening }),
    });

    // (7) a point of order 2, (0, -1). The offline suite found ecMul traps on a
    //     point outside the prime-order subgroup before the guard's comparison
    //     is reached; this row records where the rejection lands on node.
    const jSmall = { x: 0n, y: JUBJUB_Q - 1n } as JubjubPoint;
    const jSmallId = pureCircuits.derive_grant_id_with_jubjub({ bytes: account.addressBytes }, jSmall, oh, 25n);
    const jSmallGrant = await issueAt('jubjub order-2 point', jSmallId, 25n);
    const smallMsg = await keyRow({
      item: 'v1 order-2 point (0, q - 1)',
      what: 'a point of small order but outside the prime-order subgroup',
      issuedTx: jSmallGrant.txId,
      grantId: jSmallId,
      expect: [],
      run: () => spendUnderKey({ arm: 'jubjub', pk: jSmall, opening: jSmallGrant.opening }),
    });
    keyDetails.smallOrderRejectionSite = /small order/.test(smallMsg)
      ? 'the GUARD: the cofactor-clearing assert of section 6.2 step 1 fired'
      : /unreachable|ContractRuntimeError|executing circuit/i.test(smallMsg)
        ? 'the RUNTIME, not the guard: circuit execution trapped inside the curve built-in before the guard could compare anything, so the rejection is the runtime\'s and the assert is never reached'
        : 'neither of the two expected sites; see the row text';
    keyDetails.smallOrderRejectionText = smallMsg.slice(0, 1200);

    // (8) an off-curve JubJub pair.
    const jOff = { x: 1n, y: 1n } as JubjubPoint;
    const jOffId = pureCircuits.derive_grant_id_with_jubjub({ bytes: account.addressBytes }, jOff, oh, 26n);
    const jOffGrant = await issueAt('jubjub off-curve pair', jOffId, 26n);
    await keyRow({
      item: 'v1 off-curve coordinate pair (1, 1)',
      what: 'a pair satisfying neither the twisted-Edwards equation nor any subgroup condition',
      issuedTx: jOffGrant.txId,
      grantId: jOffId,
      expect: [],
      run: () => spendUnderKey({ arm: 'jubjub', pk: jOff, opening: jOffGrant.opening }),
    });

    // (9) the cross-arm row in the other direction: the k256 grantee's
    //     coordinates carried as a JubjubPoint through the jubjub twin.
    try {
      const k1AsJ = { x: (kGrantee.pk as any).x, y: (kGrantee.pk as any).y } as JubjubPoint;
      const k1AsJId = pureCircuits.derive_grant_id_with_jubjub({ bytes: account.addressBytes }, k1AsJ, oh, 27n);
      const k1AsJGrant = await issueAt('k256 key as a jubjub grantee', k1AsJId, 27n);
      await keyRow({
        item: 'k1 grantee key presented against the jubjub twin',
        what: 'the secp256k1 grantee key\'s coordinates carried as a JubjubPoint through withdraw_shielded_with_grant_jubjub',
        issuedTx: k1AsJGrant.txId,
        grantId: k1AsJId,
        expect: [],
        run: () => spendUnderKey({ arm: 'jubjub', pk: k1AsJ, opening: k1AsJGrant.opening }),
      });
    } catch (e: any) {
      // A secp256k1 coordinate can exceed the JubJub base field modulus, in
      // which case it is not the encoding of any JubJub point and the client
      // refuses before a transaction exists — itself the section 3.4 rule.
      keyRows.push({
        item: 'k1 grantee key presented against the jubjub twin',
        what: 'the secp256k1 grantee key coordinates carried as a JubjubPoint',
        refusalStage: 'before a transaction exists (client-side encoding or issuance)',
        transactionSubmitted: false,
        error: String(e?.message ?? e),
        kx: String((kGrantee.pk as any).x),
        jubjubBaseFieldModulus: String(JUBJUB_Q),
        coordinateAboveTheModulus: ((kGrantee.pk as any).x as bigint) >= JUBJUB_Q
          || ((kGrantee.pk as any).y as bigint) >= JUBJUB_Q,
      });
      console.log(`  ✓ k1 key against the jubjub twin: refused client-side — ${String(e?.message).slice(0, 140)}`);
    }

    // (10) a DEVICE key issued as a grantee. GR-2 asks the authoriser to refuse
    //      this and says the contract cannot check it, since device keys are not
    //      stored. The row shows both halves on node: the reference client does
    //      not refuse, and the seam then admits the spend.
    const deviceAsGrantee = new K256Grantee((device as any).sk, K256_ENVELOPE_NONE);
    const devGranteeId = account.grantIdOf(deviceAsGrantee, oh, 28n);
    const devSalt = rnd32();
    const devScope = spendScope({
      withdrawShielded: true, color: colorMain, cap: 40n, perCallCap: 20n,
      maxCoinValue: 5000n, readPkHash,
    });
    const devIssueTx = await timed('issue_grant_with_jubjub (device key as grantee)', () =>
      account.issueGrant(jDevice, devGranteeId, devScope, devSalt));
    await waitForLedger(
      () => account.ledgerState(),
      'the device-key grant is recorded',
      (l) => l.grants.member(devGranteeId),
    );
    keyDetails.deviceKeyAsGranteeIssueTx = devIssueTx.txId;
    keyDetails.deviceKeyAsGranteeIssueRefused = false;
    const devHandle: GrantHandle = {
      name: 'device-as-grantee', grantee: deviceAsGrantee, slot: 28n, id: devGranteeId,
      salt: devSalt, opening: openingOf(devScope, devSalt, oh, 28n), scope: devScope,
    };
    // The k256 grant twin is a k = 17 proof and the heaviest call of this
    // section; hand it a fresh prover rather than one that has just carried
    // the whole rejection matrix (the first run of this section lost the row
    // to an out-of-memory prover mid-retry).
    await restartProver('the device-key-as-grantee spend');
    try {
      const devSpend = await grantSpend({
        label: 'withdraw_shielded_with_grant_k256 (a DEVICE key acting as a grantee)',
        grant: devHandle,
        recipient: userCpk,
        amount: 20n,
        sealTo: encKeys.publicKey,
      });
      keyDetails.deviceKeyAsGranteeSpendTx = devSpend.txId;
      keyDetails.deviceKeyAsGranteeRecord = recordOf(devSpend.after, devGranteeId);
      keyDetails.deviceKeyAsGranteeSpendAttempts = devSpend.attempts;
      console.log(`  ⚠ a device key acting as a grantee spent successfully: ${devSpend.txId} (GR-2 is authoriser-side only)`);
    } catch (e: any) {
      keyDetails.deviceKeyAsGranteeSpendError = String(e?.message ?? e).slice(0, 400);
      keyDetails.deviceKeyAsGranteeSpendTx = null;
      setVerdict('keys', 'PARTIAL');
      console.log(`  ⚠ the device-key-as-grantee spend did not land: ${String(e?.message).slice(0, 200)}`);
    }
    keyDetails.gr2Finding =
      'GR-2 is an AUTHORISER obligation only, confirmed on node. A key enrolled as a device of this account was ' +
      'issued a grant and spent under the grant seam in the same run: the seam looks the key up in `grants` under ' +
      'the grant tag family and finds a live record, and nothing in the contract can see that the same key also ' +
      'holds a device entry, because device entries are salted rolling commitments rather than stored keys. The ' +
      'two authorities remain disjoint in the sense GR-2 states (no ONE credential satisfies both seams in one ' +
      'call), but the refusal to issue is enforceable only off-chain, and this package\'s client does not enforce it.';

    keyDetails.rows = keyRows;
    keyDetails.rowCount = keyRows.length;
  } catch (e: any) {
    keyDetails.sectionError = serialiseError(e);
    keyDetails.rowCount = (keyDetails.rows as unknown[] | undefined)?.length ?? 0;
    if (groups['keys'].verdict !== 'FAIL') setVerdict('keys', 'PARTIAL');
    console.log(`  ⚠ S11 aborted: ${String(e?.message).slice(0, 240)} — recorded and moving on`);
  }

  flushEvidence('keys');
  if (stopAfter('keys')) return;

  // ══ S12 expiry on the grant twins ═════════════════════════════════════════
  //
  // E3 pinned the unit and the enforcement point of `kernel.blockTimeLessThan`
  // on a probe contract. This section pins the same three rows on the grant
  // twins themselves, and reads the transcripts back to show the difference
  // between a record that is checked and one that short circuits.

  step('S12: the expiry rows on the grant twins (Testing 1 expiry half; GR-7)');
  const expiryDetails = group('expiry');
  try {

    const head0 = await nodeHead();
    const headSeconds = BigInt(Math.floor(head0.timestampMs / 1000));
    expiryDetails.chainHeadAtStart = {
      height: head0.height,
      timestampMs: head0.timestampMs,
      timestampSeconds: headSeconds.toString(),
      hostClockSeconds: String(Math.floor(Date.now() / 1000)),
    };
    expiryDetails.e3Reference =
      'E3 (evidence/block-time-unit.json, block-time-sweep.json) measured the unit as whole seconds since the UNIX ' +
      'epoch, enforced twice and never in the proof: compact-runtime evaluates the comparison against the host wall ' +
      'clock at build and aborts there when it is false, and the node re-executes the recorded transcript at mempool ' +
      'admission against its own block context, refusing on a ReadMismatch with `1010: Invalid Transaction: Custom ' +
      'error: 104`. The node\'s admission-time block time ran 8.2 to 10.2 s ahead of the wall clock on this stack.';

    const zeroSalt = rnd32();
    const zeroScope = spendScope({
      withdrawShielded: true, color: colorMain, cap: 60n, perCallCap: 30n,
      maxCoinValue: 5000n, expiresAt: 0n, readPkHash,
    });
    const zeroId = account.grantIdOf(jGrantee, oh, 30n);
    const zeroIssue = await timed('issue_grant_with_jubjub (expires_at = 0)', () =>
      account.issueGrant(jDevice, zeroId, zeroScope, zeroSalt));
    await waitForLedger(() => account.ledgerState(), 'the never-expiring record is present',
      (l) => l.grants.member(zeroId));
    const zeroGrant: GrantHandle = {
      name: 'Z0', grantee: jGrantee, slot: 30n, id: zeroId, salt: zeroSalt,
      opening: openingOf(zeroScope, zeroSalt, oh, 30n), scope: zeroScope,
    };

    const farSalt = rnd32();
    const farExpiry = headSeconds + 3600n;
    const farScope = spendScope({
      withdrawShielded: true, color: colorMain, cap: 60n, perCallCap: 30n,
      maxCoinValue: 5000n, expiresAt: farExpiry, readPkHash,
    });
    const farId = account.grantIdOf(jGrantee, oh, 31n);
    const farIssue = await timed('issue_grant_with_jubjub (expires_at = head + 3600)', () =>
      account.issueGrant(jDevice, farId, farScope, farSalt));
    await waitForLedger(() => account.ledgerState(), 'the forward-dated record is present',
      (l) => l.grants.member(farId));
    const farGrant: GrantHandle = {
      name: 'Z1', grantee: jGrantee, slot: 31n, id: farId, salt: farSalt,
      opening: openingOf(farScope, farSalt, oh, 31n), scope: farScope,
    };
    expiryDetails.issued = {
      zero: { grantId: bytesToHex(zeroId), expiresAt: '0', issueTx: zeroIssue.txId },
      forward: { grantId: bytesToHex(farId), expiresAt: farExpiry.toString(), issueTx: farIssue.txId },
    };

    const zeroBefore = await account.ledgerState();
    const zeroSpend = await grantSpend({
      label: 'withdraw_shielded_with_grant_jubjub (Z0, expires_at = 0)',
      grant: zeroGrant, recipient: userCpk, amount: 30n, sealTo: encKeys.publicKey,
    });
    const farBefore = await account.ledgerState();
    const farSpend = await grantSpend({
      label: 'withdraw_shielded_with_grant_jubjub (Z1, expires_at = head + 3600)',
      grant: farGrant, recipient: userCpk, amount: 30n, sealTo: encKeys.publicKey,
    });
    expiryDetails.zeroSpend = {
      txId: zeroSpend.txId,
      roundBefore: zeroBefore.round.toString(),
      roundAfter: zeroSpend.after.round.toString(),
      record: recordOf(zeroSpend.after, zeroId),
    };
    expiryDetails.forwardSpend = {
      txId: farSpend.txId,
      roundBefore: farBefore.round.toString(),
      roundAfter: farSpend.after.round.toString(),
      record: recordOf(farSpend.after, farId),
    };

    // The transcripts. `t == 0 || kernel.blockTimeLessThan(t)` short circuits on
    // the zero record, so its transcript carries no ledger time read at all,
    // while the forward-dated one carries exactly one comparison whose Boolean
    // the node re-derives at admission.
    await sleep(6_000);
    const zeroTranscript = await txTranscript(zeroSpend.txId, account.address);
    const farTranscript = await txTranscript(farSpend.txId, account.address);
    expiryDetails.zeroTranscript = zeroTranscript;
    expiryDetails.forwardTranscript = farTranscript;
    const zeroLt = zeroTranscript.calls.reduce((a, c) => a + c.ltOps, 0);
    const farLt = farTranscript.calls.reduce((a, c) => a + c.ltOps, 0);
    expiryDetails.zeroRecordBlockTimeReads = zeroLt;
    expiryDetails.forwardRecordBlockTimeReads = farLt;
    expiryDetails.transcriptSections = {
      zero: zeroTranscript.calls.map((c) => [c.section, c.ops, c.ltOps]),
      forward: farTranscript.calls.map((c) => [c.section, c.ops, c.ltOps]),
    };
    expiryDetails.transcriptFinding =
      `The zero record's transaction records ${zeroLt} ledger time comparison(s) and the forward-dated one ` +
      `${farLt}. A kernel.blockTimeLessThan reaches the public transcript as a read of the call context followed ` +
      'by an `lt` and a `popeq` of the Boolean; the `t == 0 ||` arm of the contract short circuits before the ' +
      'ledger operation runs, so nothing about time is recorded and the node has nothing to re-derive.';
    if (zeroLt !== 0 || farLt !== 1) {
      console.log(`  ⚠ expected 0 and 1 block-time reads, saw ${zeroLt} and ${farLt}`);
      setVerdict('expiry', 'PARTIAL');
    } else {
      console.log('  ✓ the zero record records NO block-time read; the forward-dated one records exactly one');
    }

    // The admission row. The client's comparison is against its own wall clock
    // at BUILD; the node re-derives it at admission, one block interval plus a
    // tolerance later, and on this call the gap also has to carry a k = 17
    // proof. The margin is therefore E3's 8.2 to 10.2 s PLUS this call's
    // prove-and-balance latency, which the row measures.
    const marginSalt = rnd32();
    const marginLead = 10n;
    // 180 s of headroom: the issue, the ledger wait, and the prove-only index
    // resolution all happen before the timing window opens.
    const marginExpiry = BigInt(Math.floor(Date.now() / 1000)) + 180n;
    const marginScope = spendScope({
      withdrawShielded: true, color: colorMain, cap: 60n, perCallCap: 30n,
      maxCoinValue: 5000n, expiresAt: marginExpiry, readPkHash,
    });
    const marginId = account.grantIdOf(jGrantee, oh, 32n);
    const marginIssue = await timed('issue_grant_with_jubjub (expires_at inside the admission margin)', () =>
      account.issueGrant(jDevice, marginId, marginScope, marginSalt));
    await waitForLedger(() => account.ledgerState(), 'the short-dated record is present',
      (l) => l.grants.member(marginId));
    const marginOpening = openingOf(marginScope, marginSalt, oh, 32n);

    // The qualified coin index is resolved BEFORE the timing window opens, by
    // proving throwaway calls: a wrong index fails at the PROVER, and this row
    // must fail at the NODE or it measures nothing.
    const marginRes = await resolveIndexByProving({
      label: 'S12 margin coin', coin: held.coin, candidates: changeFirst(held.candidates),
      amount: 30n, grantId: marginId, opening: marginOpening,
    });
    expiryDetails.marginCoinResolution = {
      resolved: marginRes.mtIndex?.toString() ?? null,
      attempts: marginRes.attempts,
    };
    if (marginRes.mtIndex !== null) await account.putCoin({ ...held.coin, mtIndex: marginRes.mtIndex });

    // Wait until the wall clock sits `marginLead` seconds before expiry, so the
    // client builds (its clock reads below t) and the node refuses.
    const buildAt = marginExpiry - marginLead;
    while (BigInt(Math.floor(Date.now() / 1000)) < buildAt) await sleep(1_000);
    const hostAtBuild = BigInt(Math.floor(Date.now() / 1000));
    const headAtBuild = await nodeHead();

    const marginBefore = await snapshot(account);
    const marginEnc = await account.encKey();
    const marginCoin = await account.heldCoin(held.coin.color);
    const marginPredicted = predictChangeCoin(held.coin, 30n);
    const marginEntry = sealInboxEntry(marginEnc, marginPredicted);
    const marginCtx = await account.grantContext(marginId);
    const marginAuth = (jGrantee as JubjubGrantee).sign(
      jubjubGrantChallenges.withdrawShielded(
        marginCtx, jGrantee.pk, userCpk, held.coin.color, 30n, marginEntry, marginEnc, marginCoin));
    await pointAtA();
    const marginBuildStart = Date.now();
    let marginAttempt: Attempted;
    try {
      const built: any = await (createUnprovenCallTx as any)(ctx.providers, {
        compiledContract: compiledAccountContract(),
        circuitId: 'withdraw_shielded_with_grant_jubjub',
        contractAddress: account.address,
        args: [
          { bytes: userCpk }, held.coin.color, 30n, marginEntry, marginEnc,
          ...grantAuthArgs(marginOpening, marginAuth as any),
        ],
        privateStateId: account.privateStateId,
      });
      const builtAt = Date.now();
      marginAttempt = await timed('withdraw_shielded_with_grant_jubjub (expiry inside the admission margin)', () =>
        rawSubmit(ctx.providers, built.private.unprovenTx, 'withdraw_shielded_with_grant_jubjub'));
      expiryDetails.marginBuildMs = builtAt - marginBuildStart;
    } catch (e: any) {
      marginAttempt = { ok: false, stage: phaseNow(), message: String(e?.message ?? e), ms: Date.now() - marginBuildStart };
    }
    await sleep(6_000);
    const marginAfter = await snapshot(account);
    expiryDetails.marginRow = {
      grantId: bytesToHex(marginId),
      issueTx: marginIssue.txId,
      expiresAt: marginExpiry.toString(),
      leadSeconds: marginLead.toString(),
      hostClockAtBuild: hostAtBuild.toString(),
      chainHeadAtBuild: { height: headAtBuild.height, timestampSeconds: String(Math.floor(headAtBuild.timestampMs / 1000)) },
      clientBuiltTheCall: marginAttempt.stage !== 'build',
      stage: marginAttempt.stage,
      accepted: marginAttempt.ok,
      txId: marginAttempt.txId ?? null,
      error: marginAttempt.message ?? null,
      rpcLog: marginAttempt.rpcLog ?? [],
      nodeLog: marginAttempt.nodeLog ?? [],
      buildToOutcomeMs: marginAttempt.ms,
      ledgerBefore: marginBefore,
      ledgerAfter: marginAfter,
      stateUnchanged: sameSnapshot(marginBefore, marginAfter),
      recordNonceAfter: recordOf(await account.ledgerState(), marginId),
    };
    if (marginAttempt.ok) {
      console.log(`  ⚠ the short-dated call was ACCEPTED (${marginAttempt.txId}); the lead of ${marginLead} s exceeded the margin`);
      setVerdict('expiry', 'PARTIAL');
      // The call landed, so the coin and the record both moved.
      marginOpening.spentPrev += 30n;
      const cand = await candidateIndices(marginAttempt.txId!);
      held.coin = marginPredicted;
      held.candidates = cand.candidates.length ? cand.candidates : held.candidates;
      await account.putCoin({ ...held.coin, mtIndex: changeFirst(held.candidates)[0] });
    } else {
      console.log(`  ✓ refused at ${marginAttempt.stage}: ${String(marginAttempt.message).slice(0, 140)}`);
      for (const l of marginAttempt.rpcLog ?? []) console.log(`    rpc:  ${l}`);
      for (const l of marginAttempt.nodeLog ?? []) console.log(`    node: ${l}`);
      if (!sameSnapshot(marginBefore, marginAfter)) {
        setVerdict('expiry', 'FAIL');
        throw new Error('the ledger moved under a refused short-dated call');
      }
    }
  } catch (e: any) {
    expiryDetails.sectionError = serialiseError(e);
    if (groups['expiry'].verdict !== 'FAIL') setVerdict('expiry', 'PARTIAL');
    console.log(`  ⚠ S12 aborted: ${String(e?.message).slice(0, 240)} — recorded and moving on`);
  }

  flushEvidence('expiry');
  if (stopAfter('expiry')) return;

  // ══ S13 composition ═══════════════════════════════════════════════════════
  //
  // Two calls on the SAME contract in ONE transaction. The obstacle the first
  // run stopped at is that both calls, built independently, read the same
  // pre-state and record the same `auth_nonce` (or the same grant `nonce`) in
  // their transcripts, and the node refuses the pair. The fix is to build the
  // second call against the state value the first produced:
  // `createUnprovenCallTxFromInitialStates` takes an explicit contract state,
  // and `nextContractState` on the first call's result is exactly that
  // successor. Segment ids order the intents, so the same two calls grafted in
  // the opposite order are the negative control.

  step('S13: composition — revoke plus issue, batch issuance, and two grant calls in one transaction');
  const compDetails = group('composition');
  try {


    // ── (a) revoke plus issue over ONE grant id, in one transaction ───────────

    const rSalt = rnd32();
    const rScope = spendScope({
      withdrawShielded: true, color: colorMain, cap: 40n, perCallCap: 20n,
      maxCoinValue: 5000n, readPkHash,
    });
    const rId = account.grantIdOf(jGrantee, oh, 33n);
    const rIssue = await timed('issue_grant_with_jubjub (the record S13a re-issues)', () =>
      account.issueGrant(jDevice, rId, rScope, rSalt));
    await waitForLedger(() => account.ledgerState(), 'the S13a record is live',
      (l) => l.grants.member(rId) && l.grants.lookup(rId).active === true);
    const beforeReissue = await account.ledgerState();
    const firstIncarnation = recordOf(beforeReissue, rId);

    const reSalt = rnd32();
    const reScope = spendScope({
      withdrawShielded: true, color: colorMain, cap: 30n, perCallCap: 15n,
      maxCoinValue: 5000n, readPkHash,
    });
    {
      let segments: number[] = [];
      const attempt = await timed('composed revoke + issue over one grant id', () =>
        rawSubmit(ctx.providers, async () => {
          const states = await readStates(ctx.providers, account.address);
          const counter = await account.resolveUseCounter(jDevice);
          const nonce0 = (await account.ledgerState()).auth_nonce;
          const revokeAuth = jDevice.sign(
            jubjubChallenges.revokeGrant({ contractAddress: account.addressBytes, authNonce: nonce0 }, jDevice.pk, rId),
            counter);
          const issueAuth = jDevice.sign(
            jubjubChallenges.issueGrant(
              { contractAddress: account.addressBytes, authNonce: nonce0 + 1n }, jDevice.pk, rId,
              scopeDigest(reSalt, reScope)),
            counter + 1n);
          const callRevoke = await buildOn(states, {
            circuitId: 'revoke_grant_with_jubjub',
            args: [rId, ...authArgs(revokeAuth)],
          });
          const callIssue = await buildOn(
            { ...states, contractState: successorState(states.contractState, callRevoke.public.nextContractState) },
            { circuitId: 'issue_grant_with_jubjub', args: [rId, ...scopeArgs(reScope), reSalt, ...authArgs(issueAuth)] },
          );
          const g = graft(callRevoke, callIssue, 'ascending');
          segments = g.segments;
          return g.composed;
        }, ['revoke_grant_with_jubjub', 'issue_grant_with_jubjub']));
      await sleep(6_000);
      const afterReissue = await account.ledgerState();
      const secondIncarnation = recordOf(afterReissue, rId);
      compDetails.revokeThenIssue = {
        grantId: bytesToHex(rId),
        firstIssueTx: rIssue.txId,
        segments,
        accepted: attempt.ok,
        stage: attempt.stage,
        txId: attempt.txId ?? null,
        error: attempt.message ?? null,
        rpcLog: attempt.rpcLog ?? [],
        nodeLog: attempt.nodeLog ?? [],
        authNonceBefore: beforeReissue.auth_nonce.toString(),
        authNonceAfter: afterReissue.auth_nonce.toString(),
        roundBefore: beforeReissue.round.toString(),
        roundAfter: afterReissue.round.toString(),
        firstIncarnation,
        secondIncarnation,
        freshIncarnation: !!secondIncarnation
          && secondIncarnation.active === true
          && secondIncarnation.nonce === '0'
          && secondIncarnation.issued_at !== (firstIncarnation as any)?.issued_at,
      };
      if (!attempt.ok) {
        console.log(`  ⚠ revoke + issue in one transaction refused at ${attempt.stage}: ${String(attempt.message).slice(0, 200)}`);
        setVerdict('composition', 'PARTIAL');
      } else {
        console.log(`  ✓ revoke + issue over one id in ONE transaction: ${attempt.txId}, auth_nonce ` +
          `${beforeReissue.auth_nonce} → ${afterReissue.auth_nonce}`);
      }
    }

    // ── (b) batch issuance: two grants in one transaction ─────────────────────

    {
      const l = await account.ledgerState();
      const saltP = rnd32();
      const saltQ = rnd32();
      const scopeP = spendScope({ withdrawShielded: true, color: colorMain, cap: 20n, perCallCap: 10n, maxCoinValue: 5000n, readPkHash });
      const scopeQ = readOnlyScope({ readPkHash });
      const idP = account.grantIdOf(jGrantee, oh, 35n);
      const idQ = account.grantIdOf(kGrantee, oh, 36n);
      let segments: number[] = [];
      const attempt = await timed('composed batch issuance (two grants)', () =>
        rawSubmit(ctx.providers, async () => {
          const states = await readStates(ctx.providers, account.address);
          const now = await account.ledgerState();
          const counter = await account.resolveUseCounter(jDevice);
          const authP = jDevice.sign(
            jubjubChallenges.issueGrant({ contractAddress: account.addressBytes, authNonce: now.auth_nonce }, jDevice.pk, idP, scopeDigest(saltP, scopeP)),
            counter);
          const authQ = jDevice.sign(
            jubjubChallenges.issueGrant({ contractAddress: account.addressBytes, authNonce: now.auth_nonce + 1n }, jDevice.pk, idQ, scopeDigest(saltQ, scopeQ)),
            counter + 1n);
          const callP = await buildOn(states, { circuitId: 'issue_grant_with_jubjub', args: [idP, ...scopeArgs(scopeP), saltP, ...authArgs(authP)] });
          const callQ = await buildOn(
            { ...states, contractState: successorState(states.contractState, callP.public.nextContractState) },
            { circuitId: 'issue_grant_with_jubjub', args: [idQ, ...scopeArgs(scopeQ), saltQ, ...authArgs(authQ)] });
          const g = graft(callP, callQ, 'ascending');
          segments = g.segments;
          return g.composed;
        }, ['issue_grant_with_jubjub', 'issue_grant_with_jubjub']));
      await sleep(6_000);
      const after = await account.ledgerState();
      compDetails.batchIssuance = {
        segments,
        accepted: attempt.ok,
        stage: attempt.stage,
        txId: attempt.txId ?? null,
        error: attempt.message ?? null,
        rpcLog: attempt.rpcLog ?? [],
        nodeLog: attempt.nodeLog ?? [],
        authNonceBefore: l.auth_nonce.toString(),
        authNonceAfter: after.auth_nonce.toString(),
        roundBefore: l.round.toString(),
        roundAfter: after.round.toString(),
        bothRecorded: after.grants.member(idP) && after.grants.member(idQ),
        recordP: recordOf(after, idP),
        recordQ: recordOf(after, idQ),
      };
      if (!attempt.ok) {
        console.log(`  ⚠ batch issuance refused at ${attempt.stage}: ${String(attempt.message).slice(0, 200)}`);
        setVerdict('composition', 'PARTIAL');
      } else {
        console.log(`  ✓ two grants issued in ONE transaction: ${attempt.txId}`);
      }
    }

    // ── (c) two grant calls under ONE grant, consecutive nonces ───────────────
    //
    // One coin can be consumed once, so the two calls consume the two coins the
    // S11 refill deposited. Each call's qualified coin (mt_index included) is in
    // its challenge, so both indices are resolved BEFORE either is signed, by
    // proving a throwaway call per candidate and submitting nothing.

    const ySalt = rnd32();
    const yScope = spendScope({
      withdrawShielded: true, color: colorMain, cap: 100n, perCallCap: 50n,
      maxCoinValue: 5000n, readPkHash,
    });
    const yId = account.grantIdOf(jGrantee, oh, 34n);
    const yIssue = await timed('issue_grant_with_jubjub (the grant S13c spends twice)', () =>
      account.issueGrant(jDevice, yId, yScope, ySalt));
    await waitForLedger(() => account.ledgerState(), 'the S13c record is live', (l) => l.grants.member(yId));
    const yOpening = openingOf(yScope, ySalt, oh, 34n);


    // Four coins: two for the accepted pair, and two more for the ordering
    // control, which may itself consume one. The control runs first, so its
    // coins have to be its own or the accepted pair would be left without.
    const coinA = { ...held.coin };
    const candA = [...changeFirst(held.candidates)];
    const coinB = { ...refills[1].coin };
    const candB = [...refills[1].candidates];
    const coinC = { ...refills[2].coin };
    const coinD = { ...refills[3].coin };
    const resA = await resolveIndexByProving({
      label: 'S13c coin A', coin: coinA, candidates: candA, amount: 10n, grantId: yId, opening: yOpening,
    });
    const resB = await resolveIndexByProving({
      label: 'S13c coin B', coin: coinB, candidates: candB, amount: 10n, grantId: yId, opening: yOpening,
    });
    const resC = await resolveIndexByProving({
      label: 'S13c control coin C', coin: coinC, candidates: [...refills[2].candidates], amount: 10n, grantId: yId, opening: yOpening,
    });
    const resD = await resolveIndexByProving({
      label: 'S13c control coin D', coin: coinD, candidates: [...refills[3].candidates], amount: 10n, grantId: yId, opening: yOpening,
    });
    compDetails.coinIndexResolution = {
      coinA: { value: coinA.value.toString(), resolved: resA.mtIndex?.toString() ?? null, attempts: resA.attempts },
      coinB: { value: coinB.value.toString(), resolved: resB.mtIndex?.toString() ?? null, attempts: resB.attempts },
      controlCoinC: { value: coinC.value.toString(), resolved: resC.mtIndex?.toString() ?? null, attempts: resC.attempts },
      controlCoinD: { value: coinD.value.toString(), resolved: resD.mtIndex?.toString() ?? null, attempts: resD.attempts },
    };

    if (resA.mtIndex === null || resB.mtIndex === null || resC.mtIndex === null || resD.mtIndex === null) {
      compDetails.twoGrantCalls = {
        outcome: 'NOT ATTEMPTED: one of the four coins has no candidate index that satisfies the circuit',
      };
      setVerdict('composition', 'PARTIAL');
    } else {
      /** Build the pair afresh: both calls under one grant, nonces n and n + 1.
       *  `first` and `second` are the two coins the calls consume, so the
       *  ordering control can be given its own pair. */
      const buildPair = async (
        first: { coin: PlainCoin; mtIndex: bigint } = { coin: coinA, mtIndex: resA.mtIndex! },
        second: { coin: PlainCoin; mtIndex: bigint } = { coin: coinB, mtIndex: resB.mtIndex! },
      ) => {
        const coinA = first.coin;
        const coinB = second.coin;
        const states = await readStates(ctx.providers, account.address);
        const g = await account.grantContext(yId);
        const enc = await account.encKey();

        await account.putCoin({ ...coinA, mtIndex: first.mtIndex });
        const qualifiedA = await account.heldCoin(coinA.color);
        const predictedA = predictChangeCoin(coinA, 10n);
        const entryA = sealInboxEntry(enc, predictedA);
        const openingA: GrantOpening = { ...yOpening };
        const authA = (jGrantee as JubjubGrantee).sign(
          jubjubGrantChallenges.withdrawShielded(g, jGrantee.pk, userCpk, coinA.color, 10n, entryA, enc, qualifiedA));
        const call1 = await buildOn(states, {
          circuitId: 'withdraw_shielded_with_grant_jubjub',
          args: [{ bytes: userCpk }, coinA.color, 10n, entryA, enc, ...grantAuthArgs(openingA, authA as any)],
        });

        await account.putCoin({ ...coinB, mtIndex: second.mtIndex });
        const qualifiedB = await account.heldCoin(coinB.color);
        const predictedB = predictChangeCoin(coinB, 10n);
        const entryB = sealInboxEntry(enc, predictedB);
        const openingB: GrantOpening = { ...yOpening, spentPrev: yOpening.spentPrev + 10n };
        const authB = (jGrantee as JubjubGrantee).sign(
          jubjubGrantChallenges.withdrawShielded(
            { ...g, grantNonce: g.grantNonce + 1n }, jGrantee.pk, userCpk, coinB.color, 10n, entryB, enc, qualifiedB));
        const call2 = await buildOn(
          { ...states, contractState: successorState(states.contractState, call1.public.nextContractState) },
          {
            circuitId: 'withdraw_shielded_with_grant_jubjub',
            args: [{ bytes: userCpk }, coinB.color, 10n, entryB, enc, ...grantAuthArgs(openingB, authB as any)],
          });
        return { call1, call2, grantNonceAtBuild: g.grantNonce, changeA: predictedA, changeB: predictedB };
      };

      /**
       * Build the pair and graft it in the wanted order, redrawing the SDK's
       * random segment ids until the order is achievable. Only needed when the
       * second call's coins are pinned to their own segment; a build costs no
       * proof.
       */
      const graftWithRetry = async (
        order: 'ascending' | 'descending',
        keep: (pair: Awaited<ReturnType<typeof buildPair>>) => void,
        coins?: [{ coin: PlainCoin; mtIndex: bigint }, { coin: PlainCoin; mtIndex: bigint }],
      ) => {
        const rejected: string[] = [];
        for (let attempt = 0; attempt < 8; attempt++) {
          const pair = coins ? await buildPair(coins[0], coins[1]) : await buildPair();
          keep(pair);
          try {
            const g = graft(pair.call1, pair.call2, order);
            if (rejected.length > 0) {
              compDetails.segmentRedraws = [...(compDetails.segmentRedraws as string[] ?? []), ...rejected];
            }
            return g;
          } catch (e: any) {
            if (!(e instanceof SegmentOrderNeedsRebuild)) throw e;
            rejected.push(`${order}: ${String(e.message)}`);
          }
        }
        throw new Error(`${order}: eight builds in a row drew segment ids in the wrong order: ${rejected.join(' | ')}`);
      };

      // The ordering control, on its own pair of coins: the same two calls with
      // the nonce n + 1 call in the LOWER segment. It runs first and may
      // consume one of its coins, which is why it does not share the coins of
      // the accepted pair below.
      const beforeBad = await snapshot(account);
      let badSegments: number[] = [];
      let badGraftError: string | null = null;
      let badAttempt: Attempted;
      let badPair: any = null;
      try {
        badAttempt = await timed('composed pair, REORDERED (nonce n + 1 first)', () =>
          rawSubmit(ctx.providers, async () => {
            const bad = await graftWithRetry('descending', (p) => { badPair = p; },
              [{ coin: coinC, mtIndex: resC.mtIndex! }, { coin: coinD, mtIndex: resD.mtIndex! }]);
            badSegments = bad.segments;
            compDetails.reorderedPairOffer = { merged: bad.offerMerged, shapes: bad.offerShapes };
            return bad.composed;
          }, ['withdraw_shielded_with_grant_jubjub', 'withdraw_shielded_with_grant_jubjub']));
      } catch (e: any) {
        badGraftError = String(e?.message ?? e);
        badAttempt = { ok: false, stage: 'build', message: badGraftError, ms: 0 };
      }
      await sleep(8_000);
      const afterBadLedger = await account.ledgerState();
      const afterBad = await snapshot(account);
      const recAfterBad = recordOf(afterBadLedger, yId);
      const nonceAtControlBuild = badPair ? BigInt(String(badPair.grantNonceAtBuild)) : 0n;
      const controlNonceDelta = recAfterBad
        ? BigInt(String(recAfterBad.nonce)) - nonceAtControlBuild
        : 0n;
      // Whatever the control consumed, the record and the opening must agree
      // before the accepted pair is built: each call releases 10.
      yOpening.spentPrev += 10n * controlNonceDelta;

      // Two ways the reordering can be refused, and the run may see either.
      // When the calls partition into the GUARANTEED section the node refuses
      // the whole transaction at admission on a transcript read mismatch; when
      // they partition into the FALLIBLE section the transaction is included
      // and the out-of-order call simply fails, which the ledger tolerates, so
      // the record advances by one rather than two. Both show the second call
      // did not apply; only a delta of two would be a counter-example.
      const controlVerdict = !badAttempt.ok
        ? 'refused at admission: the whole transaction was rejected'
        : controlNonceDelta === 1n
          ? 'included, but only ONE of the two calls applied: the out-of-order call failed in the fallible section'
          : controlNonceDelta === 2n
            ? 'INCONCLUSIVE: both calls applied under the reordered graft, so the segment id did not order them'
            : `unexpected: the record advanced by ${controlNonceDelta}`;
      compDetails.reorderedPair = {
        segments: badSegments,
        graftError: badGraftError,
        note: 'the call carrying grant nonce n + 1 sits in the LOWER segment',
        verdict: controlVerdict,
        accepted: badAttempt.ok,
        stage: badAttempt.stage,
        txId: badAttempt.txId ?? null,
        transactionStatus: badAttempt.txId ? await txStatusByHash(badAttempt.txId) : null,
        error: badAttempt.message ?? null,
        rpcLog: badAttempt.rpcLog ?? [],
        nodeLog: badAttempt.nodeLog ?? [],
        grantNonceAtBuild: nonceAtControlBuild.toString(),
        grantNonceAfter: recAfterBad ? recAfterBad.nonce : null,
        callsApplied: controlNonceDelta.toString(),
        ledgerBefore: beforeBad,
        ledgerAfter: afterBad,
        stateUnchanged: sameSnapshot(beforeBad, afterBad),
      };
      console.log(`  ${controlNonceDelta === 2n ? '⚠' : '✓'} reordered pair: ${controlVerdict}`);
      for (const l of badAttempt.nodeLog ?? []) console.log(`    node: ${l}`);
      if (controlNonceDelta === 2n) setVerdict('composition', 'PARTIAL');

      // The accepted pair, on the two coins the control did not touch.
      {
        const beforeGood = await account.ledgerState();
        let goodSegments: number[] = [];
        let good: any = null;
        const goodAttempt = await timed('composed pair, two grant calls under ONE grant', () =>
          rawSubmit(ctx.providers, async () => {
            const g2 = await graftWithRetry('ascending', (p) => { good = p; });
            goodSegments = g2.segments;
            compDetails.twoGrantCallsOffer = { merged: g2.offerMerged, shapes: g2.offerShapes };
            return g2.composed;
          }, ['withdraw_shielded_with_grant_jubjub', 'withdraw_shielded_with_grant_jubjub']));
        await sleep(8_000);
        const afterGood = await account.ledgerState();
        const recY = recordOf(afterGood, yId);
        const nonceAtGoodBuild = good ? BigInt(String(good.grantNonceAtBuild)) : 0n;
        const goodDelta = recY ? BigInt(String(recY.nonce)) - nonceAtGoodBuild : 0n;
        compDetails.twoGrantCalls = {
          segments: goodSegments,
          grantNonceAtBuild: nonceAtGoodBuild.toString(),
          accepted: goodAttempt.ok,
          stage: goodAttempt.stage,
          txId: goodAttempt.txId ?? null,
          transactionStatus: goodAttempt.txId ? await txStatusByHash(goodAttempt.txId) : null,
          error: goodAttempt.message ?? null,
          rpcLog: goodAttempt.rpcLog ?? [],
          nodeLog: goodAttempt.nodeLog ?? [],
          roundBefore: beforeGood.round.toString(),
          roundAfter: afterGood.round.toString(),
          inboxBefore: beforeGood.inbox_count.toString(),
          inboxAfter: afterGood.inbox_count.toString(),
          authNonceBefore: beforeGood.auth_nonce.toString(),
          authNonceAfter: afterGood.auth_nonce.toString(),
          recordAfter: recY,
          callsApplied: goodDelta.toString(),
          nonceAdvancedByTwo: goodDelta === 2n,
          spentCommitMatches: !!recY && recY.spent_commit === bytesToHex(
            pureCircuits.derive_grant_spent_commit(ySalt, yOpening.spentPrev + 10n * goodDelta)),
        };
        yOpening.spentPrev += 10n * goodDelta;
        if (goodAttempt.ok && goodDelta === 2n) {
          console.log(`  ✓ two grant calls under one grant in ONE transaction: ${goodAttempt.txId}, ` +
            `grant nonce ${nonceAtGoodBuild} → ${recY?.nonce}, inbox +2`);
          const cand = await candidateIndices(goodAttempt.txId!);
          const changeB = good.changeB;
          held.coin = { nonce: changeB.nonce, color: changeB.color, value: changeB.value };
          held.candidates = cand.candidates.length ? cand.candidates : held.candidates;
          await account.putCoin({ ...held.coin, mtIndex: changeFirst(held.candidates)[0] });
        } else {
          console.log(`  ⚠ the ordered pair applied ${goodDelta} of its two calls at ${goodAttempt.stage}: ` +
            `${String(goodAttempt.message).slice(0, 200)}`);
          for (const l of goodAttempt.nodeLog ?? []) console.log(`    node: ${l}`);
          setVerdict('composition', 'PARTIAL');
          // Nothing reliable to carry forward; leave the store on coin A.
          await account.putCoin({ ...coinA, mtIndex: resA.mtIndex! });
          held.coin = coinA;
        }
      }
    }
  } catch (e: any) {
    compDetails.sectionError = serialiseError(e);
    if (groups['composition'].verdict !== 'FAIL') setVerdict('composition', 'PARTIAL');
    console.log(`  ⚠ S13 aborted: ${String(e?.message).slice(0, 240)} — recorded and moving on`);
  }

  flushEvidence('composition');
  if (stopAfter('composition')) return;

  // ══ S14 concurrency ═══════════════════════════════════════════════════════

  step('S14: concurrency — one coin, two claimants; and the pre-signed grantee call, properly');
  const concDetails = group('concurrency');
  try {

    // ── (a) the owner and a grantee select the SAME held coin ────────────────

    const raceSalt = rnd32();
    const raceScope = spendScope({
      withdrawShielded: true, color: colorMain, cap: 60n, perCallCap: 30n,
      maxCoinValue: 5000n, readPkHash,
    });
    const raceId = account.grantIdOf(jGrantee, oh, 37n);
    const raceIssue = await timed('issue_grant_with_jubjub (the grant S14a races)', () =>
      account.issueGrant(jDevice, raceId, raceScope, raceSalt));
    await waitForLedger(() => account.ledgerState(), 'the S14a record is live', (l) => l.grants.member(raceId));
    const raceOpening = openingOf(raceScope, raceSalt, oh, 37n);

    const raceCoin = { ...held.coin };
    const raceRes = await resolveIndexByProving({
      label: 'S14a coin', coin: raceCoin, candidates: changeFirst(held.candidates),
      amount: 10n, grantId: raceId, opening: raceOpening,
    });
    concDetails.raceCoin = {
      value: raceCoin.value.toString(),
      nonce: bytesToHex(raceCoin.nonce),
      resolvedIndex: raceRes.mtIndex?.toString() ?? null,
      attempts: raceRes.attempts,
    };

    if (raceRes.mtIndex === null) {
      concDetails.race = { outcome: 'NOT RUN: the held coin has no candidate index that satisfies the circuit' };
      setVerdict('concurrency', 'PARTIAL');
    } else {
      await account.putCoin({ ...raceCoin, mtIndex: raceRes.mtIndex });
      const states = await readStates(ctx.providers, account.address);
      const l = await account.ledgerState();

      // The owner's call and the grantee's call over the SAME qualified coin,
      // built against the same state. Both are complete, signed, unproven
      // transactions before either is proved.
      const ownerCounter = await account.resolveUseCounter(device);
      const qualified = await account.heldCoin(raceCoin.color);
      const ownerAuth = device.sign(
        k256Challenges.withdrawShielded(
          { contractAddress: account.addressBytes, authNonce: l.auth_nonce },
          device.pk, userCpk, raceCoin.color, 10n, qualified),
        ownerCounter);
      const ownerCall = await buildOn(states, {
        circuitId: 'withdraw_shielded_with_k256',
        args: [{ bytes: userCpk }, raceCoin.color, 10n, ...authArgs(ownerAuth)],
      });

      const g = await account.grantContext(raceId);
      const enc = await account.encKey();
      const predicted = predictChangeCoin(raceCoin, 10n);
      const granteeEntry = sealInboxEntry(enc, predicted);
      const granteeAuth = (jGrantee as JubjubGrantee).sign(
        jubjubGrantChallenges.withdrawShielded(
          g, jGrantee.pk, userCpk, raceCoin.color, 10n, granteeEntry, enc, qualified));
      const granteeCall = await buildOn(states, {
        circuitId: 'withdraw_shielded_with_grant_jubjub',
        args: [{ bytes: userCpk }, raceCoin.color, 10n, granteeEntry, enc, ...grantAuthArgs(raceOpening, granteeAuth as any)],
      });
      console.log('  both calls built over the same qualified coin; proving the owner first');

      let ownerBuilds = 0;
      const ownerAttempt = await timed('race: the owner proves and submits first', () =>
        rawSubmit(ctx.providers, async () => {
          // The first attempt submits the transaction built above, alongside the
          // grantee's, before either was proved. A rebuild happens only on the
          // wallet's dust race, which changes no ledger state.
          if (ownerBuilds++ === 0) return ownerCall.private.unprovenTx;
          const st = await readStates(ctx.providers, account.address);
          const now = await account.ledgerState();
          const c = await account.resolveUseCounter(device);
          await account.putCoin({ ...raceCoin, mtIndex: raceRes.mtIndex! });
          const q = await account.heldCoin(raceCoin.color);
          const a = device.sign(
            k256Challenges.withdrawShielded(
              { contractAddress: account.addressBytes, authNonce: now.auth_nonce },
              device.pk, userCpk, raceCoin.color, 10n, q),
            c);
          const built = await buildOn(st, {
            circuitId: 'withdraw_shielded_with_k256',
            args: [{ bytes: userCpk }, raceCoin.color, 10n, ...authArgs(a)],
          });
          return built.private.unprovenTx;
        }, 'withdraw_shielded_with_k256'));
      concDetails.ownerCallRebuilds = ownerBuilds - 1;
      await sleep(8_000);
      const afterOwner = await account.ledgerState();

      const beforeLoser = await snapshot(account);
      const loserAttempt = await timed('race: the grantee proves the same coin second', () =>
        rawSubmit(ctx.providers, granteeCall.private.unprovenTx, 'withdraw_shielded_with_grant_jubjub'));
      await sleep(6_000);
      const afterLoser = await snapshot(account);
      const recRace = recordOf(await account.ledgerState(), raceId);

      concDetails.race = {
        grantId: bytesToHex(raceId),
        issueTx: raceIssue.txId,
        winner: {
          who: 'the owner, through withdraw_shielded_with_k256',
          accepted: ownerAttempt.ok,
          stage: ownerAttempt.stage,
          txId: ownerAttempt.txId ?? null,
          error: ownerAttempt.message ?? null,
          authNonceBefore: l.auth_nonce.toString(),
          authNonceAfter: afterOwner.auth_nonce.toString(),
          roundBefore: l.round.toString(),
          roundAfter: afterOwner.round.toString(),
        },
        loser: {
          who: 'the grantee, through withdraw_shielded_with_grant_jubjub, over the same coin',
          accepted: loserAttempt.ok,
          stage: loserAttempt.stage,
          txId: loserAttempt.txId ?? null,
          error: loserAttempt.message ?? null,
          rpcLog: loserAttempt.rpcLog ?? [],
          nodeLog: loserAttempt.nodeLog ?? [],
          ledgerBefore: beforeLoser,
          ledgerAfter: afterLoser,
          stateUnchanged: sameSnapshot(beforeLoser, afterLoser),
          grantRecordAfter: recRace,
          grantNonceUnmoved: !!recRace && recRace.nonce === '0',
        },
        misSpendPossible: ownerAttempt.ok && loserAttempt.ok,
      };

      // Leg (ii). The loser above carries pre-owner transcript reads, so its
      // refusal could be attributed to the stale reads rather than to the coin.
      // Rebuild the grantee's call against the CURRENT state, still selecting
      // the coin the owner has just spent, and prove it: nothing about the
      // transcript is stale now, so whatever refuses is the coin itself (INV-5).
      if (ownerAttempt.ok) {
        await account.putCoin({ ...raceCoin, mtIndex: raceRes.mtIndex });
        let staleStage: Phase = 'build';
        let staleMessage = '';
        let staleProved = false;
        try {
          const stNow = await readStates(ctx.providers, account.address);
          const gNow = await account.grantContext(raceId);
          const encNow2 = await account.encKey();
          const qNow = await account.heldCoin(raceCoin.color);
          const predictedNow = predictChangeCoin(raceCoin, 10n);
          const entryNow = sealInboxEntry(encNow2, predictedNow);
          const authNow = (jGrantee as JubjubGrantee).sign(
            jubjubGrantChallenges.withdrawShielded(
              gNow, jGrantee.pk, userCpk, raceCoin.color, 10n, entryNow, encNow2, qNow));
          const builtNow = await buildOn(stNow, {
            circuitId: 'withdraw_shielded_with_grant_jubjub',
            args: [{ bytes: userCpk }, raceCoin.color, 10n, entryNow, encNow2,
              ...grantAuthArgs(raceOpening, authNow as any)],
          });
          await timed('race leg (ii): prove the grantee call over the coin the owner already spent', () =>
            proveOnly(ctx.providers, builtNow.private.unprovenTx));
          staleProved = true;
        } catch (e: any) {
          staleStage = phaseNow();
          staleMessage = String(e?.message ?? e);
        }
        const afterStale = await snapshot(account);
        (concDetails.race as any).spentCoinRebuilt = {
          note: 'the same grant call rebuilt against the state AFTER the owner spent the coin, so no transcript read is stale; only the coin is gone',
          proved: staleProved,
          stage: staleProved ? 'proved (nothing was submitted)' : staleStage,
          error: staleMessage || null,
          stateUnchanged: sameSnapshot(afterLoser, afterStale),
        };
        console.log(staleProved
          ? '  ⚠ the grantee call over the spent coin still PROVED; the refusal is not at proving'
          : `  ✓ the grantee call over the spent coin fails at ${staleStage}: ${staleMessage.slice(0, 140)}`);
      }
      if (!ownerAttempt.ok) {
        console.log(`  ⚠ the owner's call did not land (${String(ownerAttempt.message).slice(0, 160)})`);
        setVerdict('concurrency', 'PARTIAL');
      } else if (loserAttempt.ok) {
        console.log(`  ⚠ BOTH spends of one coin landed (${ownerAttempt.txId}, ${loserAttempt.txId})`);
        setVerdict('concurrency', 'FAIL');
      } else {
        console.log(`  ✓ the owner's spend landed (${ownerAttempt.txId}); the grantee's same-coin call failed at ` +
          `${loserAttempt.stage}: ${String(loserAttempt.message).slice(0, 140)}`);
        for (const ln of loserAttempt.nodeLog ?? []) console.log(`    node: ${ln}`);
      }

      // Re-point the store at the owner's change coin for the next leg.
      if (ownerAttempt.ok) {
        const changeOwner = predictChangeCoin(raceCoin, 10n);
        const cand = await candidateIndices(ownerAttempt.txId!);
        held.coin = changeOwner;
        held.candidates = cand.candidates.length ? cand.candidates : held.candidates;
        await account.putCoin({ ...held.coin, mtIndex: changeFirst(held.candidates)[0] });
        concDetails.ownerChangePrediction = {
          predictedNonce: bytesToHex(changeOwner.nonce),
          predictedValue: changeOwner.value.toString(),
          note: 'the owner twin returns its change through the same standard-library nonce evolution; the value is carried forward for the next leg and verified by the prove-only resolution below',
        };
      }
    }

    // ── (b) Testing item 3 leg (b), with the ORIGINAL signature ───────────────
    //
    // The first run could only land a call RE-SIGNED after the deposit, because
    // the qualified coin (mt_index included) is in the challenge and the index
    // had been guessed. Here the index is resolved BEFORE the grantee signs, by
    // proving a throwaway call per candidate; the signature that finally lands
    // is then the one made before the deposit, unchanged.

    const preSalt = rnd32();
    const preScope = spendScope({
      withdrawShielded: true, color: colorMain, cap: 60n, perCallCap: 30n,
      maxCoinValue: 5000n, readPkHash,
    });
    const preId = account.grantIdOf(jGrantee, oh, 38n);
    const preIssue = await timed('issue_grant_with_jubjub (the grant S14b pre-signs under)', () =>
      account.issueGrant(jDevice, preId, preScope, preSalt));
    await waitForLedger(() => account.ledgerState(), 'the S14b record is live', (l) => l.grants.member(preId));
    const preOpening = openingOf(preScope, preSalt, oh, 38n);

    // A freshly deposited coin, so this leg does not inherit the index of a
    // change coin another section predicted: the property under test is the
    // signature's survival, not the bookkeeping.
    const preMint: MintedCoin = await timed('faucet mint_shielded (S14b coin)', () =>
      mintToUser(ctx, faucet, colorSeedMain, 100n));
    const preDeposit = await timed('deposit_shielded (S14b coin)', () =>
      account.depositShielded({ nonce: preMint.nonce, color: preMint.color, value: preMint.value },
        sealInboxEntry(encKeys.publicKey, preMint)));
    await sleep(10_000);
    const preCand = await candidateIndices(preDeposit.txId);
    const preCoin = { nonce: preMint.nonce, color: preMint.color, value: preMint.value };
    concDetails.preSignedDepositTx = preDeposit.txId;
    const preRes = await resolveIndexByProving({
      label: 'S14b coin', coin: preCoin, candidates: preCand.candidates,
      amount: 10n, grantId: preId, opening: preOpening,
    });
    concDetails.preSignedCoin = {
      value: preCoin.value.toString(),
      resolvedIndex: preRes.mtIndex?.toString() ?? null,
      attempts: preRes.attempts,
      note: 'resolved by prove-only candidate trials BEFORE the grantee signed; nothing was submitted by a trial',
    };

    if (preRes.mtIndex === null) {
      concDetails.preSigned = { outcome: 'NOT RUN: no candidate index satisfied the circuit for the held coin' };
      setVerdict('concurrency', 'PARTIAL');
    } else {
      await account.putCoin({ ...preCoin, mtIndex: preRes.mtIndex });
      const gPre = await account.grantContext(preId);
      const encPre = await account.encKey();
      const qualifiedPre = await account.heldCoin(preCoin.color);
      const predictedPre = predictChangeCoin(preCoin, 10n);
      const entryPre = sealInboxEntry(encPre, predictedPre);
      const signedAt = new Date().toISOString();
      const authPre = (jGrantee as JubjubGrantee).sign(
        jubjubGrantChallenges.withdrawShielded(
          gPre, jGrantee.pk, userCpk, preCoin.color, 10n, entryPre, encPre, qualifiedPre));
      const signedAuthDigest = bytesToHex(new Uint8Array(
        Buffer.from(JSON.stringify({
          r: { x: String((authPre as any).sig_r.x), y: String((authPre as any).sig_r.y) },
          s: String((authPre as any).sig_s),
          grind: String((authPre as any).grind_nonce),
        })),
      )).slice(0, 64);

      // A permissionless deposit lands between the signature and the call.
      const auxMint2: MintedCoin = await timed('faucet mint_shielded (S14b intervening deposit)', () =>
        mintToUser(ctx, faucet, colorSeedAux, 7n));
      const inboxBefore = (await account.ledgerState()).inbox_count;
      const auxEntry2 = sealInboxEntry(encKeys.publicKey, auxMint2);
      const auxDep = await timed('deposit_shielded (permissionless, after the grantee signed)', () =>
        account.depositShielded({ nonce: auxMint2.nonce, color: auxMint2.color, value: auxMint2.value }, auxEntry2));
      const afterDeposit = await waitForLedger(
        () => account.ledgerState(), 'the intervening deposit landed', (l) => l.inbox_count > inboxBefore);

      // The ORIGINAL signature, built and submitted unchanged.
      const preAttempt = await timed('withdraw_shielded_with_grant_jubjub (the ORIGINAL pre-deposit signature)', () =>
        rawSubmit(ctx.providers, async () => {
          // Rebuilt, never re-signed: `authPre`, `entryPre`, and `encPre` are
          // the ones made before the deposit landed.
          await account.putCoin({ ...preCoin, mtIndex: preRes.mtIndex! });
          await pointAtA();
          const built: any = await (createUnprovenCallTx as any)(ctx.providers, {
            compiledContract: compiledAccountContract(),
            circuitId: 'withdraw_shielded_with_grant_jubjub',
            contractAddress: account.address,
            args: [
              { bytes: userCpk }, preCoin.color, 10n, entryPre, encPre,
              ...grantAuthArgs(preOpening, authPre as any),
            ],
            privateStateId: account.privateStateId,
          });
          return built.private.unprovenTx;
        }, 'withdraw_shielded_with_grant_jubjub'));
      await sleep(8_000);
      const afterPre = await account.ledgerState();
      const recPre = recordOf(afterPre, preId);
      concDetails.preSigned = {
        grantId: bytesToHex(preId),
        issueTx: preIssue.txId,
        granteeSignedAt: signedAt,
        signatureFingerprint: signedAuthDigest,
        signedOverGrantNonce: gPre.grantNonce.toString(),
        interveningDepositTx: auxDep.txId,
        inboxBeforeDeposit: inboxBefore.toString(),
        inboxAfterDeposit: afterDeposit.inbox_count.toString(),
        roundAfterDeposit: afterDeposit.round.toString(),
        accepted: preAttempt.ok,
        stage: preAttempt.stage,
        txId: preAttempt.txId ?? null,
        error: preAttempt.message ?? null,
        rpcLog: preAttempt.rpcLog ?? [],
        nodeLog: preAttempt.nodeLog ?? [],
        roundAfterCall: afterPre.round.toString(),
        recordAfter: recPre,
        reSigned: false,
        landedWithTheOriginalSignature: preAttempt.ok,
      };
      if (preAttempt.ok) {
        preOpening.spentPrev += 10n;
        console.log(`  ✓ the call signed BEFORE the permissionless deposit landed unchanged: ${preAttempt.txId}`);
        const cand = await candidateIndices(preAttempt.txId!);
        held.coin = predictedPre;
        held.candidates = cand.candidates.length ? cand.candidates : held.candidates;
        await account.putCoin({ ...held.coin, mtIndex: changeFirst(held.candidates)[0] });
      } else {
        console.log(`  ⚠ the pre-signed call failed at ${preAttempt.stage}: ${String(preAttempt.message).slice(0, 200)}`);
        setVerdict('concurrency', 'PARTIAL');
      }
    }
  } catch (e: any) {
    concDetails.sectionError = serialiseError(e);
    if (groups['concurrency'].verdict !== 'FAIL') setVerdict('concurrency', 'PARTIAL');
    console.log(`  ⚠ S14 aborted: ${String(e?.message).slice(0, 240)} — recorded and moving on`);
  }

  flushEvidence('concurrency');
  if (stopAfter('concurrency')) return;

  // ══ S10 proving-time table ════════════════════════════════════════════════

  step('S10: proving-time table');
  const provingDetails = group('proving');

  // The compiled k of each circuit, from the measurement table.
  const measurementsPath = new URL(
    '../../../.planning/grants-e2/measurements.txt', import.meta.url,
  );
  const kByCircuit: Record<string, number> = {};
  try {
    const fs = await import('node:fs');
    const text = fs.readFileSync(measurementsPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^(\S+)\s+(\d+)\s+/);
      if (m) kByCircuit[m[1]] = Number(m[2]);
    }
  } catch (e: any) {
    provingDetails.measurementsReadError = String(e?.message ?? e);
  }

  // Attribute each proof to the circuit its label names; fall back to the
  // ids extracted from the transaction where the label is composite.
  function circuitOfLabel(label: string): string {
    const explicit = label.match(/^([a-z0-9_]+)(?:\s|$)/);
    if (explicit && kByCircuit[explicit[1]] !== undefined) return explicit[1];
    if (/^deploy:/.test(label)) return '(deploy / activation)';
    if (/composed direct transfer/.test(label)) return 'withdraw_shielded_to_contract_with_grant_k256 + deposit_shielded';
    if (/faucet mint/.test(label)) return 'faucet.mint_shielded';
    // The sections added after the first run (S11 to S14) name their calls by
    // what they are testing rather than by the circuit, so map them back.
    if (/prove-only trial/.test(label)) return 'withdraw_shielded_with_grant_jubjub (prove-only trials)';
    if (/^race leg \(ii\)/.test(label)) return 'withdraw_shielded_with_grant_jubjub (prove-only, spent coin)';
    if (/^race: the owner/.test(label)) return 'withdraw_shielded_with_k256';
    if (/^race: the grantee/.test(label)) return 'withdraw_shielded_with_grant_jubjub';
    if (/^composed revoke \+ issue/.test(label)) return 'revoke_grant_with_jubjub + issue_grant_with_jubjub (composed)';
    if (/^composed batch issuance/.test(label)) return 'issue_grant_with_jubjub x2 (composed)';
    if (/^composed pair/.test(label)) return 'withdraw_shielded_with_grant_jubjub x2 (composed)';
    return label;
  }

  const byCircuit = new Map<string, number[]>();
  for (const p of proofLog) {
    if (!p.ok) continue;
    const c = circuitOfLabel(p.label);
    if (!byCircuit.has(c)) byCircuit.set(c, []);
    byCircuit.get(c)!.push(p.ms);
  }
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };
  const table = [...byCircuit.entries()]
    .map(([circuit, ms]) => ({
      circuit,
      k: kByCircuit[circuit] ?? null,
      proofs: ms.length,
      minMs: Math.min(...ms),
      medianMs: median(ms),
      maxMs: Math.max(...ms),
    }))
    .sort((a, b) => b.medianMs - a.medianMs);
  provingDetails.provingTable = table;
  provingDetails.totalProofs = proofLog.filter((p) => p.ok).length;
  provingDetails.failedProofAttempts = proofLog.filter((p) => !p.ok).length;
  provingDetails.totalProvingMs = proofLog.reduce((a, p) => a + p.ms, 0);
  provingDetails.proofs = proofLog.map((p) => ({ label: p.label, circuits: p.circuits, ms: p.ms, ok: p.ok }));
  provingDetails.calls = callLog;
  provingDetails.wallClockMsTotal = Date.now() - runStart;
  provingDetails.proofServerRestarts = proverRestarts;
  provingDetails.changePredictions = changePredictions;
  provingDetails.changePredictionAllMatched = changePredictions.every((c) => c.matched === true);

  console.log('\n  circuit                                            k  proofs   min    med    max (ms)');
  for (const row of table) {
    console.log(
      `  ${row.circuit.padEnd(50).slice(0, 50)} ${String(row.k ?? '-').padStart(2)} ` +
      `${String(row.proofs).padStart(6)} ${String(row.minMs).padStart(6)} ` +
      `${String(row.medianMs).padStart(6)} ${String(row.maxMs).padStart(6)}`,
    );
  }

  // ══ Evidence ══════════════════════════════════════════════════════════════

  spendDetails.changePredictions = changePredictions;

  flushEvidence('deploy');
  flushEvidence('issue');
  flushEvidence('spend');
  flushEvidence('rejections');
  flushEvidence('liveness');
  flushEvidence('direct');
  flushEvidence('kill');
  flushEvidence('keys');
  flushEvidence('expiry');
  flushEvidence('composition');
  flushEvidence('concurrency');
  flushEvidence('proving');

  console.log(`\n  total wall clock: ${Math.round((Date.now() - runStart) / 1000)} s`);
});
