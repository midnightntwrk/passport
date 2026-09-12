// PROBE (not a conformance test): the unit and semantics of
// kernel.blockTimeLessThan / kernel.blockTimeGreaterThan, measured on the node.
//
// Grants E3 for the scoped-grants MIP (section 5.1, `expires_at`): the MIP
// leaves the unit unpinned ("the unit of kernel.blockTimeLessThan on the
// target ledger") and says the never-expires arm executes in the simulator
// only. This probe deploys contracts/probe-block-time.compact and drives a
// fixed matrix of arguments through the three circuits, recording for each:
//
//   - the argument and the host clock (s and ms) at submission,
//   - the latest block as the indexer reports it and as the node reports it
//     (timestamp inherent decoded from chain_getBlock),
//   - the client-side outcome: a build-time abort (the circuit assert fires
//     while the client executes the program against its own clock), a
//     proof-time abort, a balance or submission rejection, or a submitted
//     transaction with its id,
//   - the node-side outcome: included (status, block height, block
//     timestamp), or not included within the wait window.
//
// Nothing here asserts a verdict; the matrix IS the evidence, written through
// the evidence writer to evidence/block-time-unit.json. GRANTS-E3.md reads the
// conclusion off it.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, createUnprovenCallTx, submitTxAsync } from '@midnight-ntwrk/midnight-js-contracts';
import * as ledger from '@midnightntwrk/ledger-v9';

import * as ProbeModule from '../../contracts/managed/probe-block-time/contract/index.js';
import { runScenario, step, sleep } from './runner.js';
import { serialiseError, writeEvidence } from './evidence.js';
import { setupWallet } from '../node/setup.js';
import { createProviders, managedPath, CONFIG } from '../node/wallet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

const PRIVATE_STATE_ID = 'probe-block-time';
const probeZkConfigPath = path.join(managedPath, 'probe-block-time');

/** How long to wait for inclusion before calling a submitted tx "not included". */
const INCLUSION_WAIT_MS = Number(process.env.INCLUSION_WAIT_MS ?? '150000');

// ── Chain observers ─────────────────────────────────────────────────────────

interface IndexerBlock {
  height: number;
  hash: string;
  /** As the indexer reports it (observed: milliseconds since the UNIX epoch). */
  timestamp: number;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(CONFIG.indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`indexer: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

async function indexerLatestBlock(): Promise<IndexerBlock> {
  const d = await gql<{ block: IndexerBlock }>('{ block { height hash timestamp } }');
  return d.block;
}

async function indexerTxByIdentifier(txId: string): Promise<any | null> {
  const d = await gql<{ transactions: any[] }>(
    `query ($offset: TransactionOffset!) {
       transactions(offset: $offset) {
         hash
         block { height hash timestamp }
         ... on RegularTransaction {
           identifiers
           transactionResult { status segments { id success } }
         }
       }
     }`,
    { offset: { identifier: txId } },
  );
  return d.transactions[0] ?? null;
}

async function indexerLedgerParameters(): Promise<string> {
  const d = await gql<{ block: { ledgerParameters: string } }>('{ block { ledgerParameters } }');
  return d.block.ledgerParameters;
}

interface NodeHead {
  height: number;
  hash: string;
  /** The Substrate timestamp inherent (extrinsic 0), milliseconds. */
  timestampMs: number;
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
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

async function nodeHead(): Promise<NodeHead> {
  const hash = await rpc<string>('chain_getBlockHash');
  const block = await rpc<{ block: { header: { number: string }; extrinsics: string[] } }>(
    'chain_getBlock',
    [hash],
  );
  const height = parseInt(block.block.header.number, 16);
  // Extrinsic 0 is the timestamp inherent: compact(len) | version | pallet | call | compact(ms).
  const x = Buffer.from(block.block.extrinsics[0].slice(2), 'hex');
  const [, afterLen] = scaleCompact(x, 0);
  const [ts] = scaleCompact(x, afterLen + 3);
  return { height, hash, timestampMs: Number(ts) };
}

interface NodeLogCapture {
  /** Matching lines, most recent last. Empty either because there were none or because the capture failed. */
  lines: string[];
  /** `spawnSync` exit status: 0 on success, non-zero on a docker failure, null when the process could not be spawned. */
  status: number | null;
  /** Set only when the capture itself failed, so an empty `lines` is never read as "the node said nothing". */
  failure?: string;
}

/**
 * The node's own account of a mempool rejection. The wallet SDK wraps the RPC
 * error as `SubmissionError: Transaction submission error` and the RPC layer
 * only carries `Invalid Transaction: Custom error: <n>`; the reason lives in
 * the node log (`🚫 Rejected transaction <hash> from mempool: ...`). Read the
 * localnet container's recent log lines. A failed `spawnSync` (no docker, wrong
 * container name, no permission) is reported as a capture failure rather than
 * as an empty result: the two are not the same evidence.
 */
function nodeRejectionLines(sinceSeconds: number): NodeLogCapture {
  const container = process.env.MIDNIGHT_NODE_CONTAINER ?? 'account-custody-reference-node-1';
  try {
    // Substrate logs on stderr; read both streams.
    const r = spawnSync('docker', ['logs', '--since', `${sinceSeconds}s`, container], { encoding: 'utf8' });
    const status = r.status ?? null;
    if (r.error || status !== 0) {
      const why = r.error ? String(r.error.message) : `exit status ${String(status)}`;
      return { lines: [], status, failure: `node log capture failed (docker logs ${container}): ${why}` };
    }
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    return {
      status,
      lines: out
        .split('\n')
        .filter((l) => /Rejected transaction|would fail|Transcript\(/.test(l))
        .map((l) => l.replace(/^\S+ \S+\s+/, '').trim()),
    };
  } catch (e) {
    return { lines: [], status: null, failure: `node log capture threw: ${String(e).slice(0, 200)}` };
  }
}

// ── The matrix ──────────────────────────────────────────────────────────────

type Circuit = 'before' | 'after' | 'never';

interface Case {
  circuit: Circuit;
  /** Human label of the argument, in terms of now. */
  label: string;
  arg: (nowS: bigint, nowMs: bigint, height: bigint) => bigint;
  /**
   * Enforcement-point cases only: shift the clock compact-runtime reads when
   * it builds the call context (and nothing else), so the client's recorded
   * comparison result and the node's re-evaluation can be made to disagree.
   */
  clientSkewS?: number;
  /** What the case is for, when it is not part of the unit matrix. */
  purpose?: string;
  /** unit (the E3 matrix), enforcement (client/node disagreement), sweep (admission-time offset). */
  group?: 'unit' | 'enforcement' | 'sweep';
}

const CASES: Case[] = [
  { circuit: 'before', label: 'now_s + 3600', arg: (s) => s + 3600n },
  { circuit: 'before', label: 'now_s - 3600', arg: (s) => s - 3600n },
  { circuit: 'before', label: 'now_ms + 3600000', arg: (_s, ms) => ms + 3_600_000n },
  { circuit: 'before', label: 'now_ms - 3600000', arg: (_s, ms) => ms - 3_600_000n },
  { circuit: 'before', label: '0', arg: () => 0n },
  { circuit: 'before', label: '2^63', arg: () => 1n << 63n },
  { circuit: 'before', label: 'block height + 1000', arg: (_s, _ms, h) => h + 1000n },
  { circuit: 'after', label: 'now_s - 3600', arg: (s) => s - 3600n },
  { circuit: 'after', label: 'now_s + 3600', arg: (s) => s + 3600n },
  { circuit: 'after', label: 'now_ms - 3600000', arg: (_s, ms) => ms - 3_600_000n },
  { circuit: 'after', label: 'now_ms + 3600000', arg: (_s, ms) => ms + 3_600_000n },
  { circuit: 'after', label: '0', arg: () => 0n },
  { circuit: 'never', label: '0', arg: () => 0n },
  { circuit: 'never', label: 'now_s + 3600', arg: (s) => s + 3600n },
  { circuit: 'never', label: 'now_s - 3600', arg: (s) => s - 3600n },
  // ── Enforcement point: client-true, node-false (and the converse) ──────────
  {
    circuit: 'before', label: 'now_s + 2', arg: (s) => s + 2n,
    purpose: 'client (host clock) says true; inclusion lands 4-8 s later, so the including block time exceeds t',
  },
  {
    circuit: 'never', label: 'now_s + 2', arg: (s) => s + 2n,
    purpose: 'the MIP arm at the inclusion boundary: client-true, block-time-false',
  },
  {
    circuit: 'before', label: 'now_s - 300 (client clock -600 s)', arg: (s) => s - 300n, clientSkewS: -600,
    purpose: 'slow client clock: the client records true for a t already in the chain past',
  },
  {
    circuit: 'after', label: 'now_s + 300 (client clock +600 s)', arg: (s) => s + 300n, clientSkewS: 600,
    purpose: 'fast client clock: the client records true for a t still in the chain future',
  },
  {
    circuit: 'never', label: 'now_s - 300 (client clock -600 s)', arg: (s) => s - 300n, clientSkewS: -600,
    purpose: 'the MIP arm under a slow client clock: an expired grant the client believes live',
  },
  {
    circuit: 'before', label: 'now_s + 300 (client clock +600 s)', arg: (s) => s + 300n, clientSkewS: 600,
    purpose: 'fast client clock against a t the chain would accept: does the client refuse on its own clock',
  },
  // ── Admission-time sweep: t just ahead of (before) or behind (after) the
  // host clock, to bracket the time the node evaluates against at mempool
  // admission relative to the wall clock and the last block.
  ...[2, 5, 8, 10, 12, 15, 20].map((k): Case => ({
    circuit: 'before', label: `now_s + ${k}`, arg: (s) => s + BigInt(k), group: 'sweep',
    purpose: `sweep: blockTimeLessThan with t ${k} s ahead of the host clock`,
  })),
  ...[1, 3, 6, 12, 20].map((k): Case => ({
    circuit: 'after', label: `now_s - ${k}`, arg: (s) => s - BigInt(k), group: 'sweep',
    purpose: `sweep: blockTimeGreaterThan with t ${k} s behind the host clock`,
  })),
  {
    circuit: 'never', label: 'now_s + 10', arg: (s) => s + 10n, group: 'sweep',
    purpose: 'sweep: the MIP arm with t 10 s ahead of the host clock',
  },
];

/** PROBE_GROUPS=unit,enforcement,sweep (default: unit,enforcement). */
const GROUPS = new Set((process.env.PROBE_GROUPS ?? 'unit,enforcement').split(','));
const SELECTED = CASES.filter((c) => GROUPS.has(c.group ?? (c.purpose ? 'enforcement' : 'unit')));
/** Evidence file suffix: 'unit' for the default matrix, else the group list. */
const EVIDENCE_NAME = process.env.PROBE_GROUPS ? [...GROUPS].join('-') : 'unit';

type Phase = 'build' | 'prove' | 'balance' | 'submit' | 'submitted';

interface Row {
  n: number;
  circuit: Circuit;
  label: string;
  argument: string;
  /** Host clock at submission. */
  nowS: number;
  nowMs: number;
  /** What compact-runtime feeds as secondsSinceEpoch (Math.floor(Date.now()/1000), plus any skew). */
  clientAssumedTimeS: number;
  clientSkewS?: number;
  purpose?: string;
  indexerLatest: IndexerBlock;
  nodeHead: NodeHead;
  /** Where the call stopped client-side, or 'submitted'. */
  clientPhase: Phase;
  clientOutcome: string;
  clientError?: Record<string, unknown>;
  /** `String(error)`: the Effect FiberFailure prints the wrapped RPC error. */
  clientErrorText?: string;
  /** RPC-layer lines the wallet SDK logged to stderr during submission. */
  rpcLog?: string[];
  /** The node's own rejection line(s) from the container log. */
  nodeLog?: string[];
  /** `ok` (lines captured), `empty` (docker read, nothing matched), or `FAILED` (the capture itself did not run). */
  nodeLogCapture?: 'ok' | 'empty' | 'FAILED';
  /** `spawnSync` exit status of the `docker logs` call, null when it could not be spawned. */
  nodeLogSpawnStatus?: number | null;
  /** Why the capture failed, when it did. */
  nodeLogCaptureError?: string;
  txId?: string;
  /** Host clock when the node acknowledged the submission. */
  submitDoneMs?: number;
  /** Host clock when the submission was refused, for the sweep. */
  refusedAtMs?: number;
  /** The intents' ttl values of the transaction handed to the node, ISO. */
  submittedIntentTtls?: string[];
  nodeOutcome: string;
  included?: {
    status: string;
    segments: unknown;
    blockHeight: number;
    blockHash: string;
    blockTimestamp: number;
    txHash: string;
    /** including-block timestamp (s) minus argument, when the unit is seconds. */
    blockTimeMinusArgS?: string;
    /** including-block timestamp (s) minus host now (s) at submission. */
    inclusionLatencyS: number;
  };
  passesBefore: string;
  passesAfter: string;
  durationMs: number;
}

// ── Main ────────────────────────────────────────────────────────────────────

await runScenario('probe: kernel block-time unit and enforcement point', async () => {
  step('setup: wallet, probe contract');
  const ctx = await setupWallet();
  const providers = await createProviders(ctx.walletCtx, probeZkConfigPath);

  // Phase tracing: wrap the three provider stages so an error can be
  // attributed to build (circuit execution), prove, balance, or submit.
  let phase: Phase = 'build';
  // Read through a function: TypeScript narrows the `let` to its last literal
  // assignment and cannot see the mutations made inside the wrappers.
  const phaseNow = (): Phase => phase;
  let lastIntentTtls: string[] | undefined;
  const proveTx = providers.proofProvider.proveTx.bind(providers.proofProvider);
  providers.proofProvider.proveTx = async (tx: any, opts?: any) => {
    phase = 'prove';
    return proveTx(tx, opts);
  };
  const balanceTx = providers.walletProvider.balanceTx.bind(providers.walletProvider);
  providers.walletProvider.balanceTx = async (tx: any, ttl?: Date) => {
    phase = 'balance';
    return balanceTx(tx, ttl);
  };
  const submitTx = providers.walletProvider.submitTx.bind(providers.walletProvider);
  const submitWrapped = async (tx: any) => {
    phase = 'submit';
    try {
      const ttls: string[] = [];
      for (const [, intent] of (tx.intents ?? new Map()) as Map<number, any>) {
        const ttl = intent?.ttl;
        ttls.push(ttl instanceof Date ? ttl.toISOString() : String(ttl));
      }
      lastIntentTtls = ttls;
    } catch {
      lastIntentTtls = undefined;
    }
    const id = await submitTx(tx);
    phase = 'submitted';
    return id;
  };
  providers.walletProvider.submitTx = submitWrapped;
  providers.midnightProvider.submitTx = submitWrapped;

  // Clock shim for the enforcement cases. compact-runtime's createCallContext
  // takes `maybeTime ?? Math.floor(Date.now() / 1000)` and nothing in the
  // midnight-js call path passes a time, so the only handle on "the time the
  // circuit assumes" is Date.now as seen from circuit-context.js. The shim
  // shifts that call site alone (checked on the stack), leaving ttl
  // computation and every other clock read untouched.
  // stderr tap: the polkadot RPC layer logs `Invalid Transaction: Custom error: n`
  // through console.error while the SDK surfaces only a generic wrapper.
  let stderrTap: string[] | null = null;
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    if (stderrTap) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      for (const l of text.split('\n')) if (/Invalid Transaction|RPC-CORE|1010/.test(l)) stderrTap.push(l.trim());
    }
    return realStderrWrite(chunk, ...rest);
  };

  const realNow = Date.now;
  const withClientSkew = async <T,>(skewS: number | undefined, fn: () => Promise<T>): Promise<T> => {
    if (!skewS) return fn();
    Date.now = function skewedNow() {
      const real = realNow();
      const stack = new Error().stack ?? '';
      return stack.includes('compact-runtime') ? real + skewS * 1000 : real;
    };
    try {
      return await fn();
    } finally {
      Date.now = realNow;
    }
  };

  const compiled = CompiledContract.make('probe-block-time', (ProbeModule as any).Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(probeZkConfigPath),
  );
  const deployed: any = await deployContract(providers, {
    compiledContract: compiled,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {},
  } as any);
  const address: string = deployed.deployTxData.public.contractAddress;
  console.log(`  probe @ ${address}`);
  console.log(
    `  deploy tx ${deployed.deployTxData.public.txId ?? deployed.deployTxData.public.txHash} ` +
      `in block ${deployed.deployTxData.public.blockHeight} ts ${deployed.deployTxData.public.blockTimestamp}`,
  );

  const readPasses = async (): Promise<bigint> => {
    const state = await providers.publicDataProvider.queryContractState(address);
    if (!state) throw new Error(`no contract state at ${address}`);
    return (ProbeModule as any).ledger(state.data).passes as bigint;
  };

  // Ledger parameters (ttl / time-to-dismiss knobs), for the record.
  let ledgerParams: Record<string, string> = {};
  try {
    const hex = await indexerLedgerParameters();
    const params = ledger.LedgerParameters.deserialize(Buffer.from(hex, 'hex'));
    const text = params.toString();
    const pick = (re: RegExp) => text.match(re)?.[1];
    ledgerParams = {
      global_ttl_s: pick(/global_ttl:\s*Duration\(\s*(\d+)/) ?? '?',
      min_time_to_dismiss: pick(/min_time_to_dismiss:\s*([^,}\n]+)/) ?? '?',
      time_to_dismiss_per_byte: pick(/time_to_dismiss_per_byte:\s*([^,}\n]+)/) ?? '?',
    };
    console.log(`  ledger parameters: ${JSON.stringify(ledgerParams)}`);
  } catch (e) {
    console.log(`  (ledger parameters unreadable: ${String(e).slice(0, 120)})`);
  }

  // Clock skew between the host and the node's block production.
  step('clock: host vs node vs indexer');
  const head0 = await nodeHead();
  const idx0 = await indexerLatestBlock();
  const host0 = Date.now();
  console.log(`  host now            ${host0} ms  (${Math.floor(host0 / 1000)} s)`);
  console.log(`  node head           #${head0.height} ts ${head0.timestampMs} ms  (host - node = ${host0 - head0.timestampMs} ms)`);
  console.log(`  indexer latest      #${idx0.height} ts ${idx0.timestamp} ms  (host - indexer = ${host0 - idx0.timestamp} ms)`);

  const rows: Row[] = [];
  let n = 0;
  for (const c of SELECTED) {
    n++;
    step(`${n}/${SELECTED.length}  ${c.circuit}(${c.label})${c.purpose ? `  [${c.purpose}]` : ''}`);
    const passesBefore = await readPasses();
    const idx = await indexerLatestBlock();
    const head = await nodeHead();
    const nowMs = Date.now();
    const nowS = Math.floor(nowMs / 1000);
    const arg = c.arg(BigInt(nowS), BigInt(nowMs), BigInt(head.height));
    console.log(`  arg = ${arg}   now_s = ${nowS}   now_ms = ${nowMs}   node head #${head.height} @ ${head.timestampMs}   indexer #${idx.height} @ ${idx.timestamp}`);

    const row: Row = {
      n,
      circuit: c.circuit,
      label: c.label,
      argument: arg.toString(),
      nowS,
      nowMs,
      clientAssumedTimeS: nowS + (c.clientSkewS ?? 0),
      clientSkewS: c.clientSkewS,
      purpose: c.purpose,
      indexerLatest: idx,
      nodeHead: head,
      clientPhase: 'build',
      clientOutcome: '',
      nodeOutcome: 'not submitted',
      passesBefore: passesBefore.toString(),
      passesAfter: passesBefore.toString(),
      durationMs: 0,
    };
    const t0 = Date.now();
    phase = 'build';
    lastIntentTtls = undefined;
    stderrTap = [];

    let txId: string | undefined;
    // Retry only the dust-state race the suites also retry; every other
    // rejection is a finding and is recorded as-is.
    for (let attempt = 0; ; attempt++) {
      try {
        const opts = {
          compiledContract: compiled,
          circuitId: c.circuit,
          contractAddress: address,
          args: [arg],
          privateStateId: PRIVATE_STATE_ID,
        } as any;
        providers.privateStateProvider.setContractAddress(address);
        const unproven: any = await withClientSkew(c.clientSkewS, () => createUnprovenCallTx(providers, opts));
        txId = await submitTxAsync(providers, {
          unprovenTx: unproven.private.unprovenTx,
          circuitId: c.circuit,
        } as any);
        row.submitDoneMs = Date.now();
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (phaseNow() === 'submit' && /DustDoubleSpend|NotNormalized/.test(msg) && attempt < 3) {
          console.log('  (dust-state race at submission; retrying in 10s)');
          await sleep(10_000);
          phase = 'build';
          continue;
        }
        const at = phaseNow();
        row.clientPhase = at;
        row.clientError = serialiseError(e);
        row.clientErrorText = String(e).slice(0, 2000);
        if (at === 'submit') {
          row.refusedAtMs = Date.now();
          row.rpcLog = [...new Set(stderrTap ?? [])];
          await sleep(1_500);
          const capture = nodeRejectionLines(20);
          row.nodeLog = capture.lines.slice(-3);
          row.nodeLogSpawnStatus = capture.status;
          row.nodeLogCapture = capture.failure ? 'FAILED' : capture.lines.length > 0 ? 'ok' : 'empty';
          if (capture.failure) {
            row.nodeLogCaptureError = capture.failure;
            console.log(`  node: (${capture.failure})`);
          } else if (capture.lines.length === 0) {
            console.log('  node: (no matching rejection line in the window)');
          }
          for (const l of row.nodeLog) console.log(`  node: ${l}`);
          for (const l of row.rpcLog) console.log(`  rpc:  ${l}`);
        }
        const chain = (row.clientError.causeChain as Array<{ message: string }>)
          .map((x) => x.message)
          .join(' | ');
        row.clientOutcome = `${at}-time abort: ${chain}`;
        row.nodeOutcome =
          at === 'submit' ? 'mempool-rejected (see clientOutcome)' : 'not submitted';
        console.log(`  ✗ ${row.clientOutcome.slice(0, 300)}`);
        break;
      }
    }

    if (txId) {
      row.clientPhase = 'submitted';
      row.txId = txId;
      row.submittedIntentTtls = lastIntentTtls;
      row.clientOutcome = `submitted ${txId}`;
      console.log(`  → submitted ${txId}  (intent ttl(s): ${lastIntentTtls?.join(', ') ?? '?'})`);
      const watch = providers.publicDataProvider.watchForTxData(txId);
      const timeout = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), INCLUSION_WAIT_MS));
      const outcome = await Promise.race([watch.then((d: any) => ({ d })), timeout]);
      if (outcome === 'timeout') {
        const seen = await indexerTxByIdentifier(txId);
        row.nodeOutcome = seen
          ? `indexer shows the tx (late): ${JSON.stringify(seen).slice(0, 200)}`
          : `not included within ${INCLUSION_WAIT_MS / 1000}s; indexer has no transaction with this identifier (dismissed or dropped)`;
        const capture = nodeRejectionLines(Math.ceil(INCLUSION_WAIT_MS / 1000) + 10);
        row.nodeLog = capture.lines.slice(-5);
        row.nodeLogSpawnStatus = capture.status;
        row.nodeLogCapture = capture.failure ? 'FAILED' : capture.lines.length > 0 ? 'ok' : 'empty';
        if (capture.failure) {
          row.nodeLogCaptureError = capture.failure;
          console.log(`  node: (${capture.failure})`);
        }
        for (const l of row.nodeLog) console.log(`  node: ${l}`);
        console.log(`  ✗ ${row.nodeOutcome}`);
      } else {
        const d = outcome.d;
        const blockTsS = Math.floor(Number(d.blockTimestamp) / 1000);
        row.included = {
          status: String(d.status),
          segments: d.segmentStatusMap ? Object.fromEntries(d.segmentStatusMap) : undefined,
          blockHeight: d.blockHeight,
          blockHash: d.blockHash,
          blockTimestamp: Number(d.blockTimestamp),
          txHash: d.txHash,
          blockTimeMinusArgS: (BigInt(blockTsS) - arg).toString(),
          inclusionLatencyS: blockTsS - nowS,
        };
        row.nodeOutcome = `included: status ${d.status} in block #${d.blockHeight} ts ${d.blockTimestamp}`;
        console.log(`  ✓ ${row.nodeOutcome}  (block_s - arg = ${row.included.blockTimeMinusArgS}, block_s - now_s = ${row.included.inclusionLatencyS})`);
      }
      // Let the indexer's contract-state view catch up before reading the counter.
      await sleep(3_000);
    }
    stderrTap = null;
    row.passesAfter = (await readPasses()).toString();
    row.durationMs = Date.now() - t0;
    console.log(`  passes ${row.passesBefore} → ${row.passesAfter}`);
    rows.push(row);
  }

  step('matrix');
  for (const r of rows) {
    console.log(
      `  ${String(r.n).padStart(2)}  ${r.circuit.padEnd(6)} ${r.label.padEnd(20)} ` +
        `${r.clientPhase.padEnd(9)} ${r.nodeOutcome.slice(0, 70)}  passes ${r.passesBefore}→${r.passesAfter}`,
    );
  }

  const enforcement = rows.filter((r) => r.purpose);
  console.log(`  unit rows: ${rows.length - enforcement.length}, enforcement rows: ${enforcement.length}`);
  writeEvidence({
    testId: 'block-time',
    name: EVIDENCE_NAME,
    description:
      'kernel.blockTimeLessThan / kernel.blockTimeGreaterThan on the node: argument matrix in seconds, milliseconds, 0, 2^63, and block height, through before/after/never circuits; plus enforcement-point rows where the client clock and the including block disagree.',
    // PASS when every row reached a definite outcome: included, a build-time
    // abort, or a submission refusal carrying both the RPC reason and the
    // node's own rejection line. A submit-phase failure with no node log line
    // is PARTIAL: `Custom error: 104` alone does not say why the node refused.
    verdict: rows.every(
      (r) =>
        r.included ||
        r.clientPhase === 'build' ||
        (r.clientPhase === 'submit' && (r.rpcLog?.length ?? 0) > 0 && (r.nodeLog?.length ?? 0) > 0),
    )
      ? 'PASS'
      : 'PARTIAL',
    note:
      'Each row records the argument, the host clock and the chain head at submission, the client-side phase reached, ' +
      'and the node-side outcome. The conclusion is drawn in GRANTS-E3.md.',
    details: {
      contractAddress: address,
      deployTx: deployed.deployTxData.public.txId ?? deployed.deployTxData.public.txHash,
      clientTimeSource: 'compact-runtime createCallContext: maybeTime ?? Math.floor(Date.now() / 1000)',
      clock: {
        hostNowMs: host0,
        nodeHead: head0,
        indexerLatest: idx0,
        hostMinusNodeMs: host0 - head0.timestampMs,
        hostMinusIndexerMs: host0 - idx0.timestamp,
      },
      ledgerParameters: ledgerParams,
      txTtlMs: Number(process.env.TX_TTL_MS ?? '60000'),
      inclusionWaitMs: INCLUSION_WAIT_MS,
      rows,
    },
  });
});
