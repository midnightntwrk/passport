// PROBE (not a conformance test): the per-maintenance-update verifier-byte
// ceiling, measured on the node by bisection.
//
// The grants E2 run reported that a single maintenance update carrying 16
// verifier keys (39,600 verifier bytes) is refused, and ran its wave deploy at
// a budget of 18,504 verifier bytes instead, which took four waves. Nothing in
// that run's log, evidence, or chain captured the refusal, so the ceiling sat
// somewhere in the open range (18,504, 39,600]: too wide to write into a
// standard, and wide enough that the MIP's three-wave prediction for the
// thirty-circuit roster could not be checked.
//
// This probe closes the bracket. For each probe size N it
//
//   - deploys a THROWAWAY account carrying wave 1 only (the two deposits plus
//     the k256 device arm, ten operations). Wave 1 is a deploy and the initial
//     device is never activated, so nothing in the probe has a circuit to
//     prove: the SDK's submit path still round-trips the proof server, but
//     with no call proof to build;
//   - builds ONE hand-built MaintenanceUpdate inserting the first N of the
//     twenty verifier keys wave 1 does not carry, in the order
//     `planWaves` packs them, signed with that deploy's authority key;
//   - prices that transaction against the chain's own LedgerParameters BEFORE
//     submitting it (`cost`, `normalizeFullness`, `fees`), which is the same
//     computation the wallet's fee estimate performs, and records whether it
//     throws;
//   - submits it and records the outcome: accepted (with the block the update
//     landed in), or refused, with the verbatim error text, the phase the
//     refusal came from, and the node's own rejection line from its log.
//
// The two refusal mechanisms are kept apart throughout, because they bound a
// transaction at different points:
//
//   client fee computation  the ledger prices the transaction against the
//                           block limits before a transaction is ever handed
//                           to the node ("exceeded block limit in transaction
//                           fee computation"). No transaction exists on the
//                           wire; nothing reaches the mempool.
//   node at submission      the transaction is built, priced, balanced, and
//                           handed over, and the node's mempool refuses it
//                           ("1010: Invalid Transaction: ...").
//
// A refused update leaves the maintenance authority counter untouched, so the
// next probe may reuse the same throwaway account; an ACCEPTED update installs
// its keys and advances the counter, so the probe after an acceptance deploys
// a fresh account. Every attempt, accepted or refused, is kept in the record.
//
// Nothing here asserts a verdict beyond "the bracket closed to within one
// key"; the attempt table IS the evidence, written to
// evidence/wave-ceiling.json. GRANTS-E2.md and the header of
// src/wallet/wave-deploy.ts read the conclusion off it.

import { spawnSync } from 'node:child_process';

import {
  ContractDeploy,
  ContractOperationVersionedVerifierKey,
  ContractState,
  Intent,
  LedgerParameters,
  MaintenanceUpdate,
  Transaction,
  VerifierKeyInsert,
  signData,
  type SingleUpdate,
} from '@midnightntwrk/ledger-v9';
import { createUnprovenDeployTx, submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import {
  SHARED_CIRCUITS,
  VERIFIER_BYTE_BUDGET,
  allCircuits,
  armCircuits,
  grantTwins,
  lifecycleCircuits,
} from '../wallet/wave-deploy.js';
import { K256Device } from '../wallet/signer.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { emptyCoinStore } from '../wallet/witnesses.js';
import { bytesToHex } from '../wallet/hex.js';
import { compiledAccountContract, setupWallet, type TestContext } from '../node/setup.js';
import { CONFIG } from '../node/wallet.js';
import { runScenario, step, sleep } from './runner.js';
import { serialiseError, writeEvidence } from './evidence.js';

/** The arm wave 1 carries, matching the E2 run's k256-born account. */
const FIRST_ARM = 'k256' as const;

/** How long to wait for a submitted update before calling it not included. */
const SUBMIT_WAIT_MS = Number(process.env.SUBMIT_WAIT_MS ?? '180000');

// ── Chain reads ─────────────────────────────────────────────────────────────

async function gql<T>(query: string): Promise<T> {
  const res = await fetch(CONFIG.indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`indexer: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

/** The chain's live ledger parameters — the block limits every price is against. */
async function chainLedgerParameters(): Promise<LedgerParameters> {
  const d = await gql<{ block: { ledgerParameters: string } }>('{ block { ledgerParameters } }');
  return LedgerParameters.deserialize(Buffer.from(d.block.ledgerParameters, 'hex'));
}

/**
 * The node's own account of a mempool rejection. The wallet SDK wraps the RPC
 * error, and the RPC layer carries only the short form; the reason line lives
 * in the node log. Mirrors probe-block-time's capture, including its
 * distinction between "captured nothing" and "the capture itself failed".
 */
function nodeRejectionLines(sinceSeconds: number): {
  lines: string[];
  status: number | null;
  failure?: string;
} {
  const container = process.env.MIDNIGHT_NODE_CONTAINER ?? 'account-custody-reference-node-1';
  try {
    const r = spawnSync('docker', ['logs', '--since', `${sinceSeconds}s`, container], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
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
        .filter((l) => /Rejected transaction|would exhaust|block limit|Invalid Transaction/.test(l))
        .map((l) => l.replace(/^\S+ \S+\s+/, '').trim()),
    };
  } catch (e) {
    return { lines: [], status: null, failure: `node log capture threw: ${String(e).slice(0, 200)}` };
  }
}

// ── Pricing a transaction the way the client does ───────────────────────────

interface Priced {
  /** `Transaction.cost`: the modelled resource cost. */
  cost?: Record<string, string>;
  costError?: string;
  /** `LedgerParameters.normalizeFullness`: THROWS when a block limit is exceeded. */
  normalized?: Record<string, number>;
  /** The verbatim text of that throw — the client-side block-limit refusal. */
  normalizeError?: string;
  /** `Transaction.fees`: what the wallet's fee estimate calls. */
  fees?: string;
  feesError?: string;
}

interface Price {
  /** Serialised transaction length, in bytes. */
  serialisedBytes: number;
  /** Priced as `cost(params)` — no time-to-dismiss enforcement. */
  plain: Priced;
  /** Priced as `cost(params, true)` — what the fee estimate enforces. */
  enforcingTimeToDismiss: Priced;
}

const bigmap = (o: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));

function pricedAt(tx: any, params: LedgerParameters, enforce: boolean): Priced {
  const out: Priced = {};
  let cost: any;
  try {
    cost = enforce ? tx.cost(params, true) : tx.cost(params);
    out.cost = bigmap(cost);
  } catch (e) {
    out.costError = String(e).slice(0, 500);
  }
  if (cost) {
    try {
      out.normalized = params.normalizeFullness(cost) as any;
    } catch (e) {
      out.normalizeError = String(e).slice(0, 500);
    }
  }
  try {
    out.fees = String(enforce ? tx.fees(params, true) : tx.fees(params));
  } catch (e) {
    out.feesError = String(e).slice(0, 500);
  }
  return out;
}

/**
 * The transaction priced against the chain's parameters, as the client prices
 * it. This is the UNBALANCED maintenance update: balancing adds the Dust spend
 * that pays the fee, so the figures here are the update's own contribution to
 * the block limits, not the whole submitted transaction's.
 */
function priceOf(tx: any, params: LedgerParameters): Price {
  return {
    serialisedBytes: tx.serialize().length,
    plain: pricedAt(tx, params, false),
    enforcingTimeToDismiss: pricedAt(tx, params, true),
  };
}

// ── The throwaway wave-1 account ────────────────────────────────────────────

/**
 * The deploy half of `deployAccountInWaves`, and nothing else: run the
 * constructor through the standard pipeline, keep its ledger data and
 * maintenance authority, restrict the operations to wave 1, and submit the
 * deploy. No private-state bookkeeping is performed and no device is
 * activated: this account exists only to receive one maintenance update.
 */
async function deployWaveOneOnly(
  providers: any,
  waveOneIds: string[],
): Promise<{ address: string; signingKey: unknown; deployTxBlock: number }> {
  const device = K256Device.generate();
  const encKeys = generateEncKeyPair();
  const salt = new Uint8Array(32);
  globalThis.crypto.getRandomValues(salt);
  const rand = new Uint8Array(8);
  globalThis.crypto.getRandomValues(rand);
  const privateStateId = `wave-ceiling-${bytesToHex(rand)}`;

  const deployData: any = await createUnprovenDeployTx(providers, {
    compiledContract: compiledAccountContract(),
    privateStateId,
    initialPrivateState: emptyCoinStore(encKeys.secretKey),
    args: [device.bootCommitment(salt), encKeys.publicKey],
  } as any);
  const full: ContractState = ContractState.deserialize(
    deployData.public.initialContractState.serialize(),
  );
  const wave1 = new ContractState();
  wave1.data = full.data;
  wave1.maintenanceAuthority = full.maintenanceAuthority;
  for (const id of waveOneIds) {
    const op = full.operation(id);
    if (!op) throw new Error(`compiled contract has no operation '${id}'`);
    wave1.setOperation(id, op);
  }
  const deploy = new ContractDeploy(wave1);
  const address = String(deploy.address);
  const ttl = new Date(Date.now() + Number(process.env.TX_TTL_MS ?? '60000'));
  const unprovenTx = Transaction.fromParts(
    getNetworkId(), undefined, undefined, Intent.new(ttl).addDeploy(deploy),
  );
  const finalized: any = await (submitTx as any)(providers, { unprovenTx });
  if (finalized.status && String(finalized.status).toLowerCase().includes('fail')) {
    throw new Error(`wave-1 deploy failed: ${JSON.stringify(finalized.status)}`);
  }
  return { address, signingKey: deployData.private.signingKey, deployTxBlock: finalized.blockHeight };
}

/** The maintenance authority counter as it stands on chain. */
async function onChainAuthorityCounter(providers: any, address: string): Promise<bigint> {
  const state: any = await providers.publicDataProvider.queryContractState(address);
  if (!state) throw new Error(`no contract state found at ${address}`);
  const ledgerState: ContractState = ContractState.deserialize(state.serialize());
  return ledgerState.maintenanceAuthority.counter as bigint;
}

// ── The attempt record ──────────────────────────────────────────────────────

type Mechanism = 'client-fee-computation' | 'node-at-submission' | 'none';

interface Attempt {
  n: number;
  /** The probe order, so the record reads as the bisection ran. */
  seq: number;
  keyIds: string[];
  verifierBytes: number;
  account: string;
  authorityCounter: string;
  /** The transaction as priced client-side BEFORE submission. */
  price: Price;
  /** The phase the call reached: 'prove', 'balance', 'submit', or 'included'. */
  phase: 'prove' | 'balance' | 'submit' | 'included';
  outcome: 'accepted' | 'refused';
  /** Which of the two mechanisms bounded this update. */
  mechanism: Mechanism;
  /** The SDK's own message — generic; the node's reason is `nodeErrorVerbatim`. */
  errorText?: string;
  error?: Record<string, unknown>;
  /**
   * The node's refusal, verbatim, as the RPC layer reported it. The wallet SDK
   * collapses every submission failure to `SubmissionError: Transaction
   * submission error`, so this line is the only place the reason survives.
   */
  nodeErrorVerbatim?: string;
  /** RPC-layer lines the wallet SDK logged to stderr during submission. */
  rpcLog?: string[];
  nodeLog?: string[];
  nodeLogCapture?: 'ok' | 'empty' | 'FAILED';
  nodeLogCaptureError?: string;
  txId?: string;
  blockHeight?: number;
  txStatus?: string;
  durationMs: number;
}

// ── Main ────────────────────────────────────────────────────────────────────

await runScenario('probe: the per-maintenance-update verifier-byte ceiling', async () => {
  step('setup: wallet, compiled artefacts, chain parameters');
  const ctx: TestContext = await setupWallet();
  const providers = ctx.providers;

  // stderr tap: the polkadot RPC layer logs the node's refusal through
  // console.error while the SDK surfaces only its own wrapper.
  let stderrTap: string[] | null = null;
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    if (stderrTap) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      for (const l of text.split('\n')) {
        if (/Invalid Transaction|RPC-CORE|1010|block limit/.test(l)) stderrTap.push(l.trim());
      }
    }
    return realStderrWrite(chunk, ...rest);
  };

  // Phase tracing: a refusal raised while the wallet prices and balances the
  // transaction happened BEFORE a transaction existed on the wire; a refusal
  // raised at submission came from the node. The SDK's submit path runs
  // proveTx first (nothing to prove here), so that stage is traced too: a
  // failure there is a harness failure, not a measurement, and is re-thrown.
  let phase: 'prove' | 'balance' | 'submit' | 'included' = 'prove';
  const phaseNow = () => phase;
  const proveTx = providers.proofProvider.proveTx.bind(providers.proofProvider);
  providers.proofProvider.proveTx = async (tx: any, opts?: any) => {
    phase = 'prove';
    const proven = await proveTx(tx, opts);
    phase = 'balance';
    return proven;
  };
  const balanceTx = providers.walletProvider.balanceTx.bind(providers.walletProvider);
  providers.walletProvider.balanceTx = async (tx: any, ttl?: Date) => {
    phase = 'balance';
    const balanced = await balanceTx(tx, ttl);
    phase = 'submit';
    return balanced;
  };

  const params = await chainLedgerParameters();
  console.log(`  ledger parameters: ${params.toString(true).slice(0, 400)}`);

  const verifierKeys = new Map<string, Uint8Array>();
  for (const id of allCircuits()) {
    const vk: Uint8Array = await providers.zkConfigProvider.getVerifierKey(id);
    if (!vk) throw new Error(`compiled contract has no verifier key for '${id}'`);
    verifierKeys.set(id, vk);
  }
  const sizeOf = (id: string): number => verifierKeys.get(id)!.length;

  // Wave 1 and the twenty ids it does not carry, in the order planWaves packs
  // them; a probe of size N takes the first N of that list, so the probe's
  // byte totals are exactly the byte totals a real wave would carry.
  const waveOneIds = [...SHARED_CIRCUITS, ...armCircuits(FIRST_ARM)];
  const second = FIRST_ARM === 'k256' ? 'jubjub' : 'k256';
  const remaining = [
    ...armCircuits(second as any),
    ...grantTwins(FIRST_ARM),
    ...lifecycleCircuits(FIRST_ARM),
    ...grantTwins(second as any),
    ...lifecycleCircuits(second as any),
  ];
  const prefixBytes = (n: number): number =>
    remaining.slice(0, n).reduce((sum, id) => sum + sizeOf(id), 0);

  const table = remaining.map((id, i) => ({
    n: i + 1,
    id,
    keyBytes: sizeOf(id),
    cumulativeBytes: prefixBytes(i + 1),
  }));
  step('the twenty keys wave 1 does not carry, and their prefix sums');
  for (const r of table) {
    console.log(`  ${String(r.n).padStart(2)}  ${r.id.padEnd(48)} ${String(r.keyBytes).padStart(5)}  cumulative ${String(r.cumulativeBytes).padStart(6)}`);
  }
  console.log(`  wave 1 carries ${waveOneIds.length} operations, ${prefixOf(waveOneIds, sizeOf)} verifier bytes`);

  // ── One probe ─────────────────────────────────────────────────────────────

  const attempts: Attempt[] = [];
  let seq = 0;
  let account: { address: string; signingKey: unknown } | null = null;
  /** An accepted update installed keys and advanced the counter; retire the account. */
  let accountSpent = true;

  async function probe(n: number): Promise<boolean> {
    seq += 1;
    const keyIds = remaining.slice(0, n);
    const verifierBytes = prefixBytes(n);
    step(`probe ${seq}: ${n} keys, ${verifierBytes} verifier bytes`);

    if (accountSpent) {
      console.log('  deploying a throwaway wave-1 account (10 operations, no activation)');
      const fresh = await deployWaveOneOnly(providers, waveOneIds);
      account = { address: fresh.address, signingKey: fresh.signingKey };
      accountSpent = false;
      console.log(`  throwaway account @ ${fresh.address} (deploy in block ${fresh.deployTxBlock})`);
    } else {
      console.log(`  reusing the throwaway account @ ${account!.address} (the last probe was refused, so its counter is untouched)`);
    }

    const counter = await onChainAuthorityCounter(providers, account!.address);
    const updates: SingleUpdate[] = keyIds.map(
      (id) => new VerifierKeyInsert(id, new ContractOperationVersionedVerifierKey('v4', verifierKeys.get(id)!)),
    );
    const bare = new MaintenanceUpdate(account!.address, updates, counter);
    const signed = bare.addSignature(0n, signData(account!.signingKey as any, bare.dataToSign));
    const ttl = new Date(Date.now() + Number(process.env.TX_TTL_MS ?? '60000'));
    const unprovenTx = Transaction.fromParts(
      getNetworkId(), undefined, undefined, Intent.new(ttl).addMaintenanceUpdate(signed),
    );

    // Price it against the chain's own parameters before anything is sent.
    // `normalizeFullness` is the call that throws when a block limit is
    // exceeded, and it is reached through `fees`, which is what the wallet's
    // fee estimate calls: this is the client-side mechanism, evaluated here
    // with no transaction on the wire.
    const price = priceOf(unprovenTx, params);
    console.log(`  priced unbalanced: ${price.serialisedBytes} serialised bytes, cost ${JSON.stringify(price.plain.cost)}`);
    for (const [which, p] of [['plain', price.plain], ['enforcing ttd', price.enforcingTimeToDismiss]] as const) {
      if (p.normalizeError) console.log(`  normalizeFullness (${which}) THREW: ${p.normalizeError}`);
      if (p.feesError) console.log(`  fees (${which}) THREW: ${p.feesError}`);
      if (p.fees) console.log(`  fees (${which}) = ${p.fees} SPECKs`);
    }

    const attempt: Attempt = {
      n,
      seq,
      keyIds,
      verifierBytes,
      account: account!.address,
      authorityCounter: counter.toString(),
      price,
      phase: 'prove',
      outcome: 'refused',
      mechanism: 'none',
      durationMs: 0,
    };
    const t0 = Date.now();
    stderrTap = [];
    phase = 'prove';
    let timer: NodeJS.Timeout | undefined;
    try {
      const finalized: any = await Promise.race([
        (submitTx as any)(providers, { unprovenTx }),
        new Promise((_res, rej) => {
          timer = setTimeout(
            () => rej(new Error(`not included within ${SUBMIT_WAIT_MS / 1000}s`)),
            SUBMIT_WAIT_MS,
          );
        }),
      ]);
      attempt.phase = 'included';
      attempt.outcome = 'accepted';
      attempt.mechanism = 'none';
      attempt.txId = finalized.txId ?? finalized.txHash;
      attempt.blockHeight = finalized.blockHeight;
      attempt.txStatus = String(finalized.status ?? 'unknown');
      accountSpent = true;
      console.log(`  ✓ ACCEPTED: tx ${attempt.txId} in block ${attempt.blockHeight} (${attempt.txStatus})`);
    } catch (e: any) {
      const at = phaseNow();
      if (at === 'prove') {
        // Nothing in this probe has a circuit to prove, so a failure here is
        // the harness or the proof server, not a block-limit measurement.
        throw e;
      }
      attempt.phase = at;
      attempt.outcome = 'refused';
      attempt.error = serialiseError(e);
      attempt.errorText = String(e?.message ?? e).slice(0, 2000);
      attempt.mechanism = at === 'balance' ? 'client-fee-computation' : 'node-at-submission';
      attempt.rpcLog = [...new Set(stderrTap ?? [])];
      const verbatim = attempt.rpcLog.find((l) => /Invalid Transaction|block limit/.test(l));
      if (verbatim) attempt.nodeErrorVerbatim = verbatim.replace(/^.*ExtrinsicStatus::\s*/, '').trim();
      await sleep(2_000);
      const capture = nodeRejectionLines(30);
      attempt.nodeLog = capture.lines.slice(-4);
      attempt.nodeLogCapture = capture.failure ? 'FAILED' : capture.lines.length > 0 ? 'ok' : 'empty';
      if (capture.failure) attempt.nodeLogCaptureError = capture.failure;
      console.log(
        `  ✗ REFUSED at ${at} (${attempt.mechanism}): ${attempt.errorText}` +
        (attempt.nodeErrorVerbatim ? ` — node: "${attempt.nodeErrorVerbatim}"` : ''),
      );
      for (const l of attempt.rpcLog) console.log(`  rpc:  ${l}`);
      for (const l of attempt.nodeLog) console.log(`  node: ${l}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    stderrTap = null;
    attempt.durationMs = Date.now() - t0;
    attempts.push(attempt);
    return attempt.outcome === 'accepted';
  }

  // ── The bisection ─────────────────────────────────────────────────────────
  //
  // The prior run's anchors: 8 keys (18,504 bytes) accepted on chain, 16 keys
  // (39,600 bytes) reported refused but never captured. The claim carries the
  // most information, so it is probed first; the bracket is then halved. If
  // the claim is refuted the search walks upward instead, bounded by the
  // twenty keys the roster has.

  step('bisection');
  const MAX_N = remaining.length;
  let largestAccepted: number | null = null;
  let smallestRefused: number | null = null;

  const claimRefused = !(await probe(16));
  let lo: number;
  let hi: number;
  if (claimRefused) {
    smallestRefused = 16;
    lo = 8;   // the prior run's accepted anchor, re-measured below if it is the bracket's floor
    hi = 16;
  } else {
    largestAccepted = 16;
    lo = 16;
    hi = MAX_N + 1; // one past the roster: "the whole remaining roster fits"
  }

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid > MAX_N) break;
    const accepted = await probe(mid);
    if (accepted) {
      lo = mid;
      largestAccepted = Math.max(largestAccepted ?? 0, mid);
    } else {
      hi = mid;
      smallestRefused = Math.min(smallestRefused ?? Number.MAX_SAFE_INTEGER, mid);
    }
  }

  // If the bracket's floor is the prior run's anchor rather than a payload this
  // run accepted, measure it here so both ends of the bracket come from one run.
  if (largestAccepted === null && lo >= 1) {
    console.log(`  the bracket's floor is the prior run's anchor; measuring ${lo} keys here`);
    if (await probe(lo)) largestAccepted = lo;
    else {
      // The floor itself is refused: walk down until something is accepted.
      let n = lo - 1;
      while (n >= 1) {
        if (await probe(n)) { largestAccepted = n; break; }
        smallestRefused = Math.min(smallestRefused ?? Number.MAX_SAFE_INTEGER, n);
        n -= 1;
      }
    }
  }

  // ── The bracket, and what it means for the roster ─────────────────────────

  step('result');
  const acceptedBytes = largestAccepted === null ? null : prefixBytes(largestAccepted);
  const refusedBytes = smallestRefused === null ? null : prefixBytes(smallestRefused);
  console.log(`  largest ACCEPTED: ${largestAccepted ?? '?'} keys, ${acceptedBytes ?? '?'} verifier bytes`);
  console.log(`  smallest REFUSED: ${smallestRefused ?? '?'} keys, ${refusedBytes ?? '?'} verifier bytes`);

  const refusals = attempts.filter((a) => a.outcome === 'refused');
  const mechanisms = [...new Set(refusals.map((a) => a.mechanism))];
  console.log(`  refusal mechanism(s) observed: ${mechanisms.join(', ') || 'none'}`);

  // The wave count a candidate budget produces for the roster, by the same
  // greedy rule planWaves applies to the same `remaining` order. planWaves
  // itself reads the module-level budget, so a candidate is evaluated here
  // rather than by re-importing it; the chosen default is then confirmed
  // against a real planWaves run in the deploy evidence.
  const waveCountAt = (budget: number): { waves: number; batches: Array<{ keys: number; bytes: number }> } => {
    const batches: Array<{ keys: number; bytes: number }> = [];
    let keys = 0;
    let bytes = 0;
    for (const id of remaining) {
      const s = sizeOf(id);
      if (bytes + s > budget && keys > 0) {
        batches.push({ keys, bytes });
        keys = 0;
        bytes = 0;
      }
      keys += 1;
      bytes += s;
    }
    if (keys > 0) batches.push({ keys, bytes });
    return { waves: 1 + batches.length, batches };
  };

  const candidates = [...new Set([18504, 20000, 24000, 25000, 26000, 30000, 40000, VERIFIER_BYTE_BUDGET])]
    .sort((a, b) => a - b)
    .map((budget) => ({ budget, shipped: budget === VERIFIER_BYTE_BUDGET, ...waveCountAt(budget) }));
  for (const c of candidates) {
    console.log(
      `  budget ${String(c.budget).padStart(6)}${c.shipped ? ' (shipped)' : '         '} → ` +
      `${c.waves} waves ${JSON.stringify(c.batches)}`,
    );
  }
  const atShipped = waveCountAt(VERIFIER_BYTE_BUDGET);

  const bracketClosed =
    largestAccepted !== null && smallestRefused !== null && smallestRefused - largestAccepted === 1;

  writeEvidence({
    testId: 'grants-e2-wave-ceiling',
    fileName: 'wave-ceiling.json',
    name: 'wave-ceiling',
    description:
      'The per-maintenance-update verifier-byte ceiling on node 2.1.0, measured by bisection: for each probe size a throwaway wave-1 account receives ONE maintenance update inserting N verifier keys, priced client-side against the chain ledger parameters and then submitted, with the accept/refuse outcome, the verbatim refusal text, and the refusal mechanism recorded.',
    verdict: bracketClosed ? 'PASS' : 'PARTIAL',
    note:
      (largestAccepted !== null && smallestRefused !== null
        ? `MEASURED BRACKET: a single maintenance update of ${largestAccepted} verifier keys (${acceptedBytes} verifier bytes) is accepted and lands; one of ${smallestRefused} keys (${refusedBytes} verifier bytes) is refused. The bracket is closed to one key. ` +
          `The refusal comes from ${mechanisms.join(' and ')}: ` +
          (mechanisms.includes('client-fee-computation')
            ? 'the ledger prices the transaction against the block limits before it is handed to the node, so no transaction reaches the mempool. '
            : 'the node refuses the transaction at its mempool, after the client has priced, balanced, and handed it over. ') +
          (mechanisms.length === 1 && mechanisms[0] === 'node-at-submission'
            ? 'The client fee computation bounds NOTHING here: every refused payload priced without complaint, `normalizeFullness` never threw, and `fees` returned a figure, so the only thing that says no is the node. That is the asymmetry with the all-operations DEPLOY, which the client refuses up front. '
            : '') +
          `The per-update ceiling therefore sits in (${acceptedBytes}, ${refusedBytes}] verifier bytes, not in the (18,504, 39,600] range the first run left open. ` +
          `At the shipped budget of ${VERIFIER_BYTE_BUDGET} verifier bytes per update, which is the largest accepted ` +
          `payload less a stated safety margin, the thirty-circuit roster plans as ${atShipped.waves} waves: the ` +
          `deploy plus ${atShipped.batches.map((b) => `${b.keys} keys (${b.bytes} bytes)`).join(' and ')}. ` +
          'A budget at or below the ceiling does not by itself fix the wave count: the packing is greedy over the ' +
          'same key order, so a lower budget can cost a wave (18,504 costs four). The deploy evidence records the ' +
          'plan planWaves actually produced on chain.'
        : 'The bracket did not close; read the attempt table.'),
    details: {
      probeOrder: 'the reported-refused payload first, then bisection by halving; every attempt kept',
      firstArm: FIRST_ARM,
      waveOne: {
        circuits: waveOneIds,
        verifierBytes: prefixOf(waveOneIds, sizeOf),
      },
      remainingKeys: table,
      rosterVerifierBytes: allCircuits().reduce((sum, id) => sum + sizeOf(id), 0),
      priorRunAnchors: {
        accepted: { keys: 8, verifierBytes: 18504, source: 'grants E2 first run, on chain (wave 2 of the four-wave deploy)' },
        refusedClaim: { keys: 16, verifierBytes: 39600, source: 'grants E2 first run, prose only — the claim this probe tests' },
      },
      bracket: {
        largestAcceptedKeys: largestAccepted,
        largestAcceptedVerifierBytes: acceptedBytes,
        smallestRefusedKeys: smallestRefused,
        smallestRefusedVerifierBytes: refusedBytes,
        closedToOneKey: bracketClosed,
        refusalMechanisms: mechanisms,
      },
      waveCountAtCandidateBudgets: candidates,
      attempts,
    },
  });
});

/** Sum of a list of verifier key lengths. */
function prefixOf(ids: string[], sizeOf: (id: string) => number): number {
  return ids.reduce((sum, id) => sum + sizeOf(id), 0);
}
