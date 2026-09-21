// PROBE (not a conformance test): what every unshielded shape of this
// contract costs against the node's time-to-dismiss budget, priced off-node
// with the node's own check and WITHOUT submitting.
//
// The grants E2 run could not exercise the unshielded grant twins, because
// this localnet refuses a contract call paired with an unshielded offer:
// `Malformed(FeeCalculation(OutsideTimeToDismiss))`. E2 recorded that as one
// undifferentiated wall across "call + unshielded offer", which left the
// twins' own standing unknown: `withdraw_unshielded_with_grant_jubjub` and
// `withdraw_unshielded_with_grant_k256` have never been built, proved, or
// submitted by any run.
//
// The wall is not undifferentiated. The ledger prices dismissal per element:
//
//   allowed = max(time_to_dismiss_per_byte * est_size, min_time_to_dismiss)
//   actual  = (guaranteed_cost + validation_cost).max_time()
//
// (ledger/src/structure.rs, `Transaction::cost`), and the per-element offer
// costs differ by two orders of magnitude between an unshielded INPUT of
// NIGHT and an unshielded OUTPUT. A deposit carries a NIGHT input; a
// withdrawal emits `sendUnshielded` to a `UserAddress`, which is an offer of
// zero inputs and one output. Those are not the same shape and need not share
// a verdict.
//
// So this probe prices each shape the way the node will, before anything is
// sent. For each shape it
//
//   - builds and PROVES the call through the suite's own client (the same
//     `CustodyAccount` / faucet helpers every suite calls), so the proof, the
//     transcript, and the offer are the real ones;
//   - lets the wallet BALANCE it (the Dust spend that pays the fee, and any
//     change output balancing adds are part of what the node prices);
//   - intercepts the submission, and prices the balanced transaction against
//     the chain's own `LedgerParameters` with `cost(params, true)` — the same
//     call the node makes — recording either the pass or the
//     `OutsideTimeToDismiss` triple { time_to_dismiss,
//     allowed_time_to_dismiss, size };
//   - throws the submission away. Nothing in the shape table reaches the
//     mempool.
//
// Two figures are recorded per shape, because they answer different
// questions: `cost(params)` is the modelled resource cost with no dismissal
// enforcement (what the wallet's own fee estimate computes), and
// `cost(params, true)` is the enforced form that refuses.
//
// A refusal carries the ledger's own three numbers; a PASS carries none, so
// "admitted" would otherwise come with no "by how much". The same three are
// therefore reconstructed for every shape from what the API does expose —
// `est_size` from the cost map's `blockUsage`, the budget from the chain's
// printed `time_to_dismiss_per_byte` and `min_time_to_dismiss`, and the
// dismissal time as an upper bound from the cost map's own
// `max(readTime, computeTime)`. The reconstruction is calibrated against the
// ledger's figures on every shape that IS refused, and the check is recorded
// beside the row: on this run all three agree, the bound exactly.
//
// One caveat on the off-node price, stated so the table is read correctly:
// the JS binding exposes `cost`, which prices a contract call's verifier-key
// read at the ledger's default `VERIFIER_KEY_SIZE` (2,875 bytes), while the
// node's enforcement reads the key's real serialised size from state (2,745
// bytes for every k256 circuit here, 2,313 for every jubjub one). The
// off-node figure is therefore very slightly CONSERVATIVE — it charges a
// larger cell read than the node will — by the cost of a cell read over 130
// to 562 bytes per call. It cannot turn a node refusal into an off-node pass.
//
// Prerequisites are submitted, and are named as such in the evidence: the
// faucet deploy, the account's wave deploy and activation, the cross-arm
// enrolment of a jubjub device, two grant issues, the non-native mint, and
// the one funding deposit the withdraw shapes cannot be built without. Every
// one of those is either a deploy, a coinless call, or the single deposit this
// probe is allowed to submit. The shapes in the table are never submitted.
//
// Nothing here asserts a verdict beyond the table: the per-shape triple IS
// the evidence, written to evidence/dismiss-cost.json.

import { spawnSync } from 'node:child_process';

import { LedgerParameters, Transaction } from '@midnightntwrk/ledger-v9';

import { runScenario, step, sleep, waitForLedger } from './runner.js';
import { serialiseError, writeEvidence } from './evidence.js';
import {
  deployFaucet,
  deployAccount,
  setupWallet,
  type FaucetHandle,
  type TestContext,
} from '../node/setup.js';
import { CONFIG, userAddressBytes } from '../node/wallet.js';
import { CustodyAccount } from '../wallet/account.js';
import {
  JubjubDevice,
  JubjubGrantee,
  K256Device,
  K256Grantee,
  openingOf,
  originHash,
  spendScope,
  type AnyGrantee,
  type GrantOpening,
} from '../wallet/signer.js';
import { generateEncKeyPair, sealInboxEntry } from '../wallet/inbox.js';
import { bytesToHex } from '../wallet/hex.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** Night: the all-zero color. */
const NIGHT = new Uint8Array(32);
/** The faucet domain the non-native color derives from. */
const DOMAIN = (() => {
  const d = new Uint8Array(32);
  d[31] = 0x77;
  return d;
})();

const CLIENT_ID = 'https://dismiss-cost.example';
const MINT = 3_000n;
const DEPOSIT = 3_000n;
const WITHDRAW = 1_000n;
const SLOT_JUBJUB = 0n;
const SLOT_K256 = 1n;

/** The message the intercepted submission throws; matched, never surfaced. */
const SENTINEL = '__DRY_RUN__ priced off-node, deliberately not submitted';

function rnd32(): Uint8Array {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}

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

/** The chain's live ledger parameters — the limits every price is against. */
async function chainLedgerParameters(): Promise<{ params: LedgerParameters; hex: string }> {
  const d = await gql<{ block: { ledgerParameters: string } }>('{ block { ledgerParameters } }');
  return {
    params: LedgerParameters.deserialize(Buffer.from(d.block.ledgerParameters, 'hex')),
    hex: d.block.ledgerParameters,
  };
}

/**
 * The node's own account of a mempool rejection, for the prerequisites this
 * probe does submit. Mirrors probe-wave-ceiling's capture, including its
 * distinction between "captured nothing" and "the capture itself failed".
 */
function nodeRejectionLines(sinceSeconds: number): {
  lines: string[];
  failure?: string;
} {
  const container = process.env.MIDNIGHT_NODE_CONTAINER ?? 'account-custody-reference-node-1';
  try {
    const r = spawnSync('docker', ['logs', '--since', `${sinceSeconds}s`, container], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error || (r.status ?? null) !== 0) {
      const why = r.error ? String(r.error.message) : `exit status ${String(r.status)}`;
      return { lines: [], failure: `node log capture failed (docker logs ${container}): ${why}` };
    }
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    return {
      lines: out
        .split('\n')
        .filter((l) => /Rejected transaction|would exhaust|block limit|Invalid Transaction/.test(l))
        .map((l) => l.replace(/^\S+ \S+\s+/, '').trim()),
    };
  } catch (e) {
    return { lines: [], failure: `node log capture threw: ${String(e).slice(0, 200)}` };
  }
}

// ── Durations ───────────────────────────────────────────────────────────────

const UNIT_PS: Record<string, number> = {
  ps: 1,
  ns: 1e3,
  'μs': 1e6,
  us: 1e6,
  ms: 1e9,
  s: 1e12,
};

/** A `CostDuration`'s Debug form ("16.313ms") back to picoseconds. Debug
 *  rounds to three decimals, so this is the text's precision, not the
 *  ledger's; the verbatim message is kept beside every parse. */
function parseDuration(text: string): number | null {
  const m = text.match(/^([0-9]+(?:\.[0-9]+)?)(ps|ns|μs|us|ms|s)$/);
  if (!m) return null;
  return Number(m[1]) * UNIT_PS[m[2]];
}

const asMs = (ps: number | null | undefined): string =>
  ps === null || ps === undefined ? '—' : (ps / 1e9).toFixed(3);

/**
 * The two dismissal limits, read off the chain's own parameters. The JS
 * binding does not expose `LedgerParameters.limits`, but `toString(true)`
 * prints it, and these two fields are what the budget is computed from
 * (ledger/src/structure.rs: `max(time_to_dismiss_per_byte * est_size,
 * min_time_to_dismiss)`).
 */
interface DismissalLimits {
  perBytePs: number;
  floorPs: number;
  perByteText: string;
  floorText: string;
}

function readDismissalLimits(paramsText: string): DismissalLimits {
  const per = paramsText.match(/time_to_dismiss_per_byte:\s*(\S+?),/);
  const floor = paramsText.match(/min_time_to_dismiss:\s*(\S+?),/);
  if (!per || !floor) {
    throw new Error('the chain parameters do not print time_to_dismiss_per_byte / min_time_to_dismiss');
  }
  const perBytePs = parseDuration(per[1]);
  const floorPs = parseDuration(floor[1]);
  if (perBytePs === null || floorPs === null) {
    throw new Error(`unparsable dismissal limits: ${per[1]} / ${floor[1]}`);
  }
  return { perBytePs, floorPs, perByteText: per[1], floorText: floor[1] };
}

/** The `OutsideTimeToDismiss` triple, read out of the thrown message. */
interface Triple {
  timeToDismissPs: number | null;
  allowedTimeToDismissPs: number | null;
  sizeBytes: number | null;
  timeToDismissText: string;
  allowedTimeToDismissText: string;
}

function parseTriple(message: string): Triple | null {
  const m = message.match(
    /this transaction would take (\S+) to dismiss, but given its size of (\d+) bytes, it may take at most ([^\s"]+?)\.?$/m,
  );
  if (!m) return null;
  return {
    timeToDismissText: m[1],
    sizeBytes: Number(m[2]),
    allowedTimeToDismissText: m[3],
    timeToDismissPs: parseDuration(m[1]),
    allowedTimeToDismissPs: parseDuration(m[3]),
  };
}

// ── Pricing ─────────────────────────────────────────────────────────────────

const bigmap = (o: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));

interface Price {
  /** Serialised length of the balanced transaction, in bytes. */
  serialisedBytes: number;
  /** `cost(params)`: the modelled resource cost, dismissal not enforced. */
  cost?: Record<string, string>;
  costError?: string;
  /** `cost(params, true)`: the enforced form — what the node computes. */
  enforcedCost?: Record<string, string>;
  enforcedError?: string;
  /** The triple, when the enforced form refused. */
  triple?: Triple;
  /** `fees(params, true)`, in SPECKs, when the enforced form passes. */
  feesSpecks?: string;
  feesError?: string;
  /** Verdict: whether the node's own check passes on this transaction. */
  verdict: 'ADMIT' | 'REFUSE' | 'UNPRICED';
  /** By how much, in picoseconds: actual less allowed (negative = headroom). */
  marginPs?: number | null;

  // ── Derived, so an ADMITTED shape reports "by how much" too ──────────────
  //
  // The refusal message carries the triple; a PASS carries nothing, so the
  // same three figures are reconstructed from what the cost map and the
  // chain's limits do expose. Both reconstructions are exact or conservative,
  // never optimistic:
  //
  //   est_size   The cost map's `blockUsage` IS `est_size` (the ledger builds
  //              block usage from the same estimate). Where a shape is
  //              refused, the probe cross-checks it against the triple's own
  //              `size`, and records the agreement.
  //   allowed    max(time_to_dismiss_per_byte * est_size, min_time_to_dismiss),
  //              computed from the chain's printed limits — exact.
  //   actual     `max(readTime, computeTime)` of the UNENFORCED cost. The
  //              ledger's dismissal time is (guaranteed + validation).max_time()
  //              while this cost is validation + application, so this is an
  //              UPPER BOUND, tight for a guaranteed-phase-only transaction
  //              (on the refused shape the bound equals the triple exactly).
  //
  /** est_size, from the cost map's blockUsage. */
  estSizeDerivedBytes?: number;
  /** The budget, computed from the chain's own limits. */
  allowedDerivedPs?: number;
  /** An upper bound on the dismissal time. */
  actualUpperBoundPs?: number;
  /** allowed less the upper bound: a LOWER BOUND on the headroom. */
  headroomLowerBoundPs?: number;
  /** Whether the derivation agrees with the triple, where both exist. */
  derivationCheck?: string;
}

/**
 * The balanced transaction as ledger-v9 sees it. The wallet SDK and this
 * suite share one hoisted copy of the wasm module, so the object handed to
 * `submitTx` is already a ledger-v9 `Transaction`; the round trip through
 * `serialize` is the fallback for a stack where they are not deduped.
 */
function asLedgerTransaction(tx: any): any {
  if (typeof tx?.cost === 'function') return tx;
  return (Transaction as any).deserialize('signature', 'proof', 'binding', tx.serialize());
}

function price(rawTx: any, params: LedgerParameters, limits: DismissalLimits): Price {
  const tx = asLedgerTransaction(rawTx);
  const out: Price = { serialisedBytes: tx.serialize().length, verdict: 'UNPRICED' };
  let raw: any;
  try {
    raw = tx.cost(params);
    out.cost = bigmap(raw as any);
  } catch (e) {
    out.costError = String(e).slice(0, 500);
  }
  if (raw) {
    out.estSizeDerivedBytes = Number(raw.blockUsage);
    out.allowedDerivedPs = Math.max(limits.perBytePs * out.estSizeDerivedBytes, limits.floorPs);
    out.actualUpperBoundPs = Math.max(Number(raw.readTime), Number(raw.computeTime));
    out.headroomLowerBoundPs = out.allowedDerivedPs - out.actualUpperBoundPs;
  }
  try {
    out.enforcedCost = bigmap(tx.cost(params, true) as any);
    out.verdict = 'ADMIT';
  } catch (e) {
    out.enforcedError = String(e).slice(0, 800);
    const triple = parseTriple(out.enforcedError);
    if (triple) {
      out.triple = triple;
      out.verdict = 'REFUSE';
      out.marginPs =
        triple.timeToDismissPs !== null && triple.allowedTimeToDismissPs !== null
          ? triple.timeToDismissPs - triple.allowedTimeToDismissPs
          : null;
      // The derivation is calibrated here, where the ledger's own three
      // figures are in hand: est_size against blockUsage, the computed budget
      // against the reported one, and the upper bound against the reported
      // dismissal time (which it must not undercut).
      const parts: string[] = [];
      if (out.estSizeDerivedBytes !== undefined && triple.sizeBytes !== null) {
        parts.push(
          out.estSizeDerivedBytes === triple.sizeBytes
            ? `est_size: blockUsage ${out.estSizeDerivedBytes} == triple size`
            : `est_size MISMATCH: blockUsage ${out.estSizeDerivedBytes} vs triple size ${triple.sizeBytes}`,
        );
      }
      if (out.allowedDerivedPs !== undefined && triple.allowedTimeToDismissPs !== null) {
        const delta = Math.abs(out.allowedDerivedPs - triple.allowedTimeToDismissPs);
        parts.push(
          delta <= 1e6
            ? `allowed: derived ${asMs(out.allowedDerivedPs)} ms == reported ${asMs(triple.allowedTimeToDismissPs)} ms`
            : `allowed MISMATCH: derived ${asMs(out.allowedDerivedPs)} ms vs reported ${asMs(triple.allowedTimeToDismissPs)} ms`,
        );
      }
      if (out.actualUpperBoundPs !== undefined && triple.timeToDismissPs !== null) {
        parts.push(
          out.actualUpperBoundPs + 1e6 >= triple.timeToDismissPs
            ? `bound: ${asMs(out.actualUpperBoundPs)} ms >= reported ${asMs(triple.timeToDismissPs)} ms (sound)`
            : `bound UNSOUND: ${asMs(out.actualUpperBoundPs)} ms < reported ${asMs(triple.timeToDismissPs)} ms`,
        );
      }
      out.derivationCheck = parts.join('; ');
    }
  }
  try {
    out.feesSpecks = String(tx.fees(params, true));
  } catch (e) {
    out.feesError = String(e).slice(0, 500);
  }
  return out;
}

// ── The dry run ─────────────────────────────────────────────────────────────

type Phase = 'build' | 'prove' | 'balance' | 'balanced';

interface DryOutcome {
  phase: Phase;
  tx?: any;
  error?: any;
  durationMs: number;
}

/**
 * Run one of the suite's own call helpers as far as the wire and stop there.
 * `proveTx` and `submitTx` are borrowed on every providers object the call
 * might travel through (the account's and the faucet's are distinct objects);
 * the submission is intercepted, the balanced transaction kept, and a
 * sentinel thrown so nothing reaches the node. The sentinel's text is chosen
 * not to match `submitWithDustRetry`'s retry predicate, so an intercepted
 * call is not retried three times.
 */
async function dryRun(providersList: any[], fn: () => Promise<unknown>): Promise<DryOutcome> {
  let captured: any;
  let phase: Phase = 'build';
  const restore: Array<() => void> = [];
  const patched = new Set<any>();

  for (const p of providersList) {
    if (!patched.has(p.proofProvider)) {
      patched.add(p.proofProvider);
      const real = p.proofProvider.proveTx.bind(p.proofProvider);
      p.proofProvider.proveTx = async (tx: any, opts?: any) => {
        phase = 'prove';
        const proven = await real(tx, opts);
        phase = 'balance';
        return proven;
      };
      restore.push(() => {
        p.proofProvider.proveTx = real;
      });
    }
    for (const holder of [p.walletProvider, p.midnightProvider]) {
      if (!holder || patched.has(holder)) continue;
      patched.add(holder);
      const real = holder.submitTx.bind(holder);
      holder.submitTx = async (tx: any) => {
        captured = tx;
        phase = 'balanced';
        throw new Error(SENTINEL);
      };
      restore.push(() => {
        holder.submitTx = real;
      });
    }
  }

  const t0 = Date.now();
  try {
    await fn();
    return {
      phase: 'balanced',
      tx: captured,
      error: new Error('the call returned: the submission interception did not hold'),
      durationMs: Date.now() - t0,
    };
  } catch (e: any) {
    const isSentinel = String(e?.message ?? e).includes(SENTINEL);
    return {
      phase,
      tx: isSentinel ? captured : undefined,
      error: isSentinel ? undefined : e,
      durationMs: Date.now() - t0,
    };
  } finally {
    for (const r of restore) r();
  }
}

// ── The shape record ────────────────────────────────────────────────────────

interface Row {
  /** The shape letter, as the probe's plan names it. */
  id: string;
  label: string;
  /** The circuit the call targets, or the operation for a non-call shape. */
  circuit: string;
  /** The offer the transaction carries, in the ledger's own terms. */
  offer: string;
  /** How far the dry run got. */
  phase: Phase | 'not-attempted';
  price?: Price;
  /** Set when the shape could not be built or proved at all. */
  blocked?: string;
  error?: Record<string, unknown>;
  durationMs: number;
}

const rows: Row[] = [];

/**
 * The four figures a row reports, preferring the ledger's own where the
 * refusal carried them and falling back to the derivation where it did not.
 * `actualIsBound` says which: a bound is an upper bound on the dismissal
 * time, so a headroom read off it is a lower bound on the headroom.
 */
function figures(p: Price): {
  estSize: number | null;
  allowedPs: number | null;
  actualPs: number | null;
  actualIsBound: boolean;
  marginPs: number | null;
} {
  const t = p.triple;
  if (t && t.timeToDismissPs !== null && t.allowedTimeToDismissPs !== null) {
    return {
      estSize: t.sizeBytes,
      allowedPs: t.allowedTimeToDismissPs,
      actualPs: t.timeToDismissPs,
      actualIsBound: false,
      marginPs: t.timeToDismissPs - t.allowedTimeToDismissPs,
    };
  }
  return {
    estSize: p.estSizeDerivedBytes ?? null,
    allowedPs: p.allowedDerivedPs ?? null,
    actualPs: p.actualUpperBoundPs ?? null,
    actualIsBound: true,
    marginPs: p.headroomLowerBoundPs === undefined ? null : -p.headroomLowerBoundPs,
  };
}

function record(row: Row): void {
  rows.push(row);
  const p = row.price;
  if (!p) {
    console.log(`  ${row.id}  ${row.label.padEnd(46)} NOT PRICED — ${row.blocked ?? 'see error'}`);
    return;
  }
  const f = figures(p);
  console.log(
    `  ${row.id}  ${row.label.padEnd(46)} ${String(p.serialisedBytes).padStart(7)} B  ` +
    `ttd ${asMs(f.actualPs).padStart(9)}${f.actualIsBound ? '≤' : ' '} ms  allowed ${asMs(f.allowedPs).padStart(9)} ms  ` +
    `est_size ${String(f.estSize ?? '—').padStart(7)}  ${p.verdict}`,
  );
  if (p.enforcedError) console.log(`      enforced: ${p.enforcedError.slice(0, 220)}`);
  if (p.derivationCheck) console.log(`      derivation: ${p.derivationCheck}`);
  if (p.feesSpecks) console.log(`      fees(params, true) = ${p.feesSpecks} SPECKs`);
  if (p.feesError) console.log(`      fees(params, true) THREW: ${p.feesError.slice(0, 200)}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

await runScenario('probe: the time-to-dismiss cost of every unshielded shape', async () => {
  const details: Record<string, unknown> = {};
  const prerequisites: Array<Record<string, unknown>> = [];

  step('setup: wallet, chain parameters, faucet, and a wave-deployed account');
  const ctx: TestContext = await setupWallet();
  const { params, hex } = await chainLedgerParameters();
  const paramsText = params.toString(true);
  const limits = readDismissalLimits(paramsText);
  details.ledgerParametersHex = hex;
  details.ledgerParameters = paramsText;
  details.dismissalLimits = {
    timeToDismissPerByte: limits.perByteText,
    minTimeToDismiss: limits.floorText,
    timeToDismissPerBytePs: limits.perBytePs,
    minTimeToDismissPs: limits.floorPs,
  };
  console.log(
    `  dismissal budget: max(${limits.perByteText}/byte x est_size, ${limits.floorText})`,
  );
  console.log(`  ledger parameters: ${paramsText.slice(0, 600)}`);

  const recipient = userAddressBytes(ctx.walletCtx);
  details.recipientUserAddress = bytesToHex(recipient);

  const faucet: FaucetHandle = await deployFaucet(ctx.walletCtx);
  console.log(`  faucet  @ ${faucet.address}`);
  prerequisites.push({ what: 'faucet deploy', address: faucet.address, outcome: 'accepted' });

  const color = await faucet.unshieldedColor(DOMAIN);
  details.nonNativeColor = bytesToHex(color);
  details.faucetAddress = faucet.address;
  console.log(`  non-native color = ${bytesToHex(color)}`);

  const device = K256Device.generate();
  const encKeys = generateEncKeyPair();
  const account: CustodyAccount = await deployAccount(ctx, device, encKeys);
  console.log(`  account @ ${account.address}`);
  details.accountAddress = account.address;
  details.ownerDeviceArm = 'k256';
  prerequisites.push({ what: 'account wave deploy + activation', address: account.address, outcome: 'accepted' });

  const providersAll = [ctx.providers, faucet.providers];

  step('prerequisite: the k256 owner enrols a jubjub device (cross-arm, coinless)');
  const jDevice = JubjubDevice.generate();
  const l0 = await account.ledgerState();
  const enrol = await account.addDevice(device, jDevice);
  await waitForLedger(
    () => account.ledgerState(),
    'jubjub device enrolled',
    (l) => l.device_count === 2n && l.auth_nonce === l0.auth_nonce + 1n,
  );
  console.log(`  ✓ enrolled: ${enrol.txId}`);
  prerequisites.push({ what: 'add_device_with_k256 (enrol jubjub device)', txId: enrol.txId, outcome: 'accepted' });

  step('prerequisite: issue one unshielded spend grant to each grantee arm (coinless)');
  const oh = originHash(CLIENT_ID);
  const jGrantee = JubjubGrantee.generate();
  const kGrantee = K256Grantee.generate();
  const grants: Record<'jubjub' | 'k256', { grantee: AnyGrantee; opening: GrantOpening }> = {} as any;

  for (const [arm, grantee, slot] of [
    ['jubjub', jGrantee, SLOT_JUBJUB],
    ['k256', kGrantee, SLOT_K256],
  ] as const) {
    const scope = spendScope({
      withdrawUnshielded: true,
      color,
      cap: 2_000n,
      perCallCap: WITHDRAW,
      maxCoinValue: WITHDRAW,
    });
    const salt = rnd32();
    const id = account.grantIdOf(grantee, oh, slot);
    const tx = await account.issueGrant(device, id, scope, salt);
    await waitForLedger(
      () => account.ledgerState(),
      `${arm} grant recorded`,
      (l) => l.grants.member(id),
    );
    console.log(`  ✓ ${arm} grantee grant issued: ${tx.txId}`);
    prerequisites.push({
      what: `issue_grant_with_k256 (${arm} grantee, unshielded spend scope)`,
      txId: tx.txId,
      grantId: bytesToHex(id),
      outcome: 'accepted',
    });
    grants[arm] = { grantee, opening: openingOf(scope, salt, oh, slot) };
  }

  // ── Shapes priced before any funding ─────────────────────────────────────

  step('shapes (a) to (c): priced with no funding needed');

  // (a) The coinless control. A gated call with no offer at all: the floor
  //     every other shape is read against.
  {
    const entry = sealInboxEntry(encKeys.publicKey, {
      nonce: rnd32(),
      color,
      value: 1n,
    });
    const out = await dryRun(providersAll, () => account.appendInbox(device, entry));
    record({
      id: '(a)',
      label: 'coinless control: append_inbox_with_k256',
      circuit: 'append_inbox_with_k256',
      offer: 'none (proof only)',
      phase: out.phase,
      price: out.tx ? price(out.tx, params, limits) : undefined,
      blocked: out.tx ? undefined : 'the dry run did not reach a balanced transaction',
      error: out.error ? serialiseError(out.error) : undefined,
      durationMs: out.durationMs,
    });
  }

  // (b) The faucet mint of the non-native color to a user address: a contract
  //     call whose offer is one unshielded OUTPUT and no input.
  {
    const out = await dryRun(providersAll, () => faucet.mintUnshielded(DOMAIN, MINT, recipient));
    record({
      id: '(b)',
      label: 'faucet.mint_unshielded (non-native) → user',
      circuit: 'mint_unshielded',
      offer: 'unshielded: 0 inputs, 1 output (non-native)',
      phase: out.phase,
      price: out.tx ? price(out.tx, params, limits) : undefined,
      blocked: out.tx ? undefined : 'the dry run did not reach a balanced transaction',
      error: out.error ? serialiseError(out.error) : undefined,
      durationMs: out.durationMs,
    });
  }

  // (c) deposit_unshielded of NIGHT: the funding leg E2 could not perform.
  //     The offer carries a NIGHT input, and balancing adds the NIGHT change
  //     output the client does not reserve for (upstream ledger issue #761).
  {
    const out = await dryRun(providersAll, () => account.depositUnshielded(NIGHT, DEPOSIT));
    record({
      id: '(c)',
      label: 'deposit_unshielded (NIGHT)',
      circuit: 'deposit_unshielded',
      offer: 'unshielded: 1 NIGHT input (+ balancing change output)',
      phase: out.phase,
      price: out.tx ? price(out.tx, params, limits) : undefined,
      blocked: out.tx ? undefined : 'the dry run did not reach a balanced transaction',
      error: out.error ? serialiseError(out.error) : undefined,
      durationMs: out.durationMs,
    });
  }

  // ── The mint, submitted, so the non-native shapes can be built ───────────

  step('prerequisite: mint the non-native color to the funding wallet (submitted)');
  let mintTx: string | undefined;
  let mintError: unknown;
  try {
    mintTx = await faucet.mintUnshielded(DOMAIN, MINT, recipient);
    console.log(`  ✓ mint accepted: ${mintTx}`);
    prerequisites.push({ what: 'faucet.mint_unshielded (non-native) → user', txId: mintTx, outcome: 'accepted' });
  } catch (e: any) {
    mintError = e;
    const capture = nodeRejectionLines(60);
    console.log(`  ✗ mint REFUSED: ${String(e?.message ?? e).slice(0, 300)}`);
    for (const l of capture.lines.slice(-4)) console.log(`  node: ${l}`);
    prerequisites.push({
      what: 'faucet.mint_unshielded (non-native) → user',
      outcome: 'refused',
      error: String(e?.message ?? e).slice(0, 600),
      nodeLog: capture.lines.slice(-4),
      nodeLogCaptureError: capture.failure,
    });
  }
  if (mintTx) {
    console.log('  waiting 20s for the wallet to index the minted tokens...');
    await sleep(20_000);
  }

  // (d) deposit_unshielded of the non-native color, priced but not submitted.
  step('shape (d): deposit_unshielded of the non-native color');
  if (!mintTx) {
    record({
      id: '(d)',
      label: 'deposit_unshielded (non-native)',
      circuit: 'deposit_unshielded',
      offer: 'unshielded: 1 non-native input (+ balancing change output)',
      phase: 'not-attempted',
      blocked: 'the non-native mint did not land, so the funding wallet holds none of the color',
      error: mintError ? serialiseError(mintError) : undefined,
      durationMs: 0,
    });
  } else {
    const out = await dryRun(providersAll, () => account.depositUnshielded(color, DEPOSIT));
    record({
      id: '(d)',
      label: 'deposit_unshielded (non-native)',
      circuit: 'deposit_unshielded',
      offer: 'unshielded: 1 non-native input (+ balancing change output)',
      phase: out.phase,
      price: out.tx ? price(out.tx, params, limits) : undefined,
      blocked: out.tx ? undefined : 'the dry run did not reach a balanced transaction',
      error: out.error ? serialiseError(out.error) : undefined,
      durationMs: out.durationMs,
    });
  }

  // ── The one funding deposit this probe submits ───────────────────────────

  step('prerequisite: fund the mirror with the non-native color (the one submitted deposit)');
  let funded = false;
  if (mintTx) {
    try {
      const dep = await account.depositUnshielded(color, DEPOSIT);
      await waitForLedger(
        () => account.ledgerState(),
        `non-native mirror = ${DEPOSIT}`,
        (l) => l.unshielded_balances.member(color) && l.unshielded_balances.lookup(color) === DEPOSIT,
      );
      funded = true;
      console.log(`  ✓ deposit accepted: ${dep.txId}`);
      prerequisites.push({
        what: 'deposit_unshielded (non-native), the probe\'s single submitted deposit',
        txId: dep.txId,
        outcome: 'accepted',
      });
    } catch (e: any) {
      const capture = nodeRejectionLines(60);
      console.log(`  ✗ deposit REFUSED: ${String(e?.message ?? e).slice(0, 400)}`);
      for (const l of capture.lines.slice(-4)) console.log(`  node: ${l}`);
      prerequisites.push({
        what: 'deposit_unshielded (non-native), the probe\'s single submitted deposit',
        outcome: 'refused',
        error: String(e?.message ?? e).slice(0, 800),
        nodeLog: capture.lines.slice(-4),
        nodeLogCaptureError: capture.failure,
      });
      details.fundingRefusal = serialiseError(e);
    }
  } else {
    prerequisites.push({
      what: 'deposit_unshielded (non-native), the probe\'s single submitted deposit',
      outcome: 'not attempted (no minted color to deposit)',
    });
  }
  details.mirrorFunded = funded;

  // ── The withdraw shapes ─────────────────────────────────────────────────

  const unfunded = 'the mirror is unfunded, so no withdrawal can be built: the circuit asserts the balance before a transaction exists';

  step('shapes (e) to (g): the withdraw twins, device and grant');

  // (e) The device path: withdraw_unshielded_with_jubjub. sendUnshielded to a
  //     UserAddress — zero inputs, one output.
  if (!funded) {
    record({
      id: '(e)',
      label: 'withdraw_unshielded_with_jubjub (device)',
      circuit: 'withdraw_unshielded_with_jubjub',
      offer: 'unshielded: 0 inputs, 1 output (to a UserAddress)',
      phase: 'not-attempted',
      blocked: unfunded,
      durationMs: 0,
    });
  } else {
    const out = await dryRun(providersAll, () =>
      account.withdrawUnshielded(jDevice, color, WITHDRAW, recipient));
    record({
      id: '(e)',
      label: 'withdraw_unshielded_with_jubjub (device)',
      circuit: 'withdraw_unshielded_with_jubjub',
      offer: 'unshielded: 0 inputs, 1 output (to a UserAddress)',
      phase: out.phase,
      price: out.tx ? price(out.tx, params, limits) : undefined,
      blocked: out.tx ? undefined : 'the dry run did not reach a balanced transaction',
      error: out.error ? serialiseError(out.error) : undefined,
      durationMs: out.durationMs,
    });
  }

  // (f), (g) The two unshielded grant twins — the shapes the gap is about.
  for (const [id, arm] of [
    ['(f)', 'jubjub'],
    ['(g)', 'k256'],
  ] as const) {
    const label = `withdraw_unshielded_with_grant_${arm} (grantee)`;
    if (!funded) {
      record({
        id,
        label,
        circuit: `withdraw_unshielded_with_grant_${arm}`,
        offer: 'unshielded: 0 inputs, 1 output (to a UserAddress)',
        phase: 'not-attempted',
        blocked: unfunded,
        durationMs: 0,
      });
      continue;
    }
    const g = grants[arm];
    const out = await dryRun(providersAll, () =>
      account.withdrawUnshieldedWithGrant(g.grantee, g.opening, color, WITHDRAW, recipient));
    record({
      id,
      label,
      circuit: `withdraw_unshielded_with_grant_${arm}`,
      offer: 'unshielded: 0 inputs, 1 output (to a UserAddress)',
      phase: out.phase,
      price: out.tx ? price(out.tx, params, limits) : undefined,
      blocked: out.tx ? undefined : 'the dry run did not reach a balanced transaction',
      error: out.error ? serialiseError(out.error) : undefined,
      durationMs: out.durationMs,
    });
  }

  // (h) The to-contract grant twin. There is no unshielded one: the contract
  //     exports `withdraw_shielded_to_contract_with_grant_<arm>` and no
  //     unshielded counterpart, so the third grant twin is a SHIELDED shape,
  //     already built, proved, and submitted on this node by the E2 run. It
  //     cannot be priced here without first landing a shielded mint and a
  //     deposit_shielded, which is a node round trip this probe does not take.
  record({
    id: '(h)',
    label: 'to-contract grant twin (shielded; no unshielded twin exists)',
    circuit: 'withdraw_shielded_to_contract_with_grant_{jubjub,k256}',
    offer: 'shielded (zswap), not unshielded',
    phase: 'not-attempted',
    blocked:
      'the contract exports no withdraw_unshielded_to_contract twin: the to-contract grant twins are ' +
      'SHIELDED, and both were built, proved, and submitted on this node by the E2 run ' +
      '(evidence/grants-e2-direct-grants-conformance-direct.json). Pricing one here needs a landed ' +
      'shielded mint and deposit_shielded first, which this probe does not submit.',
    durationMs: 0,
  });

  // ── The table ───────────────────────────────────────────────────────────

  step('per-shape table');
  const header =
    'id   shape                                            bytes  est_size     ttd(ms)  allowed(ms)  margin(ms)  verdict';
  console.log(`  ${header}`);
  console.log(
    '  (a "≤" on ttd marks the derived upper bound, used where the shape passed and the ledger reported no triple;\n' +
    '   the margin beside it is then a LOWER bound on the headroom, printed negative)',
  );
  const table = rows.map((r) => {
    const t = r.price?.triple;
    const f = r.price ? figures(r.price) : null;
    const row = {
      id: r.id,
      label: r.label,
      circuit: r.circuit,
      offer: r.offer,
      phase: r.phase,
      serialisedBytes: r.price?.serialisedBytes ?? null,
      /** est_size: the triple's where it exists, else the cost map's blockUsage. */
      estSizeBytes: f?.estSize ?? null,
      /** True when ttd is the derived upper bound rather than the ledger's own. */
      timeToDismissIsUpperBound: f?.actualIsBound ?? null,
      timeToDismissPs: f?.actualPs ?? null,
      allowedTimeToDismissPs: f?.allowedPs ?? null,
      marginPs: f?.marginPs ?? null,
      /** The ledger's own text, only ever present on a refusal. */
      reportedTimeToDismiss: t?.timeToDismissText ?? null,
      reportedAllowedTimeToDismiss: t?.allowedTimeToDismissText ?? null,
      reportedSizeBytes: t?.sizeBytes ?? null,
      derivedEstSizeBytes: r.price?.estSizeDerivedBytes ?? null,
      derivedAllowedPs: r.price?.allowedDerivedPs ?? null,
      derivedActualUpperBoundPs: r.price?.actualUpperBoundPs ?? null,
      derivedHeadroomLowerBoundPs: r.price?.headroomLowerBoundPs ?? null,
      derivationCheck: r.price?.derivationCheck ?? null,
      verdict: r.price?.verdict ?? 'NOT PRICED',
      feesSpecks: r.price?.feesSpecks ?? null,
      feesError: r.price?.feesError ?? null,
      cost: r.price?.cost ?? null,
      enforcedCost: r.price?.enforcedCost ?? null,
      enforcedError: r.price?.enforcedError ?? null,
      blocked: r.blocked ?? null,
      error: r.error ?? null,
      durationMs: r.durationMs,
    };
    console.log(
      `  ${r.id.padEnd(4)} ${r.label.slice(0, 46).padEnd(46)} ${String(row.serialisedBytes ?? '—').padStart(7)}  ` +
      `${String(row.estSizeBytes ?? '—').padStart(8)}  ${asMs(row.timeToDismissPs).padStart(9)}` +
      `${row.timeToDismissIsUpperBound ? '≤' : ' '} ${asMs(row.allowedTimeToDismissPs).padStart(11)}  ` +
      `${asMs(row.marginPs).padStart(10)}  ${row.verdict}`,
    );
    return row;
  });

  details.shapes = table;
  details.prerequisitesSubmitted = prerequisites;
  details.method =
    'Each shape was built and proved through the suite\'s own client, balanced by the wallet, and then priced ' +
    'against the chain\'s live LedgerParameters with Transaction.cost(params, true) — the call the node makes ' +
    '(ledger/src/structure.rs, Transaction::cost). The submission was intercepted and discarded: no shape in ' +
    'this table reached the mempool. The off-node price charges a contract call\'s verifier-key read at the ' +
    'ledger default VERIFIER_KEY_SIZE = 2,875 bytes, while the node reads the real size from state (2,745 for ' +
    'every k256 circuit here, 2,313 for every jubjub one), so the figures are marginally conservative. ' +
    'Where a shape PASSED the ledger reports no triple, so est_size, the budget, and the dismissal time are ' +
    'reconstructed: est_size from the cost map\'s blockUsage, the budget as max(time_to_dismiss_per_byte x ' +
    'est_size, min_time_to_dismiss) from the chain\'s own printed limits, and the dismissal time as an UPPER ' +
    'BOUND from max(readTime, computeTime) of the unenforced cost (the ledger charges dismissal on guaranteed ' +
    'plus validation, this cost covers validation plus application). A margin printed against a bound is ' +
    'therefore a lower bound on the headroom. derivationCheck on the refused row records the calibration.';

  const priced = table.filter((r) => r.verdict === 'ADMIT' || r.verdict === 'REFUSE');
  const refused = priced.filter((r) => r.verdict === 'REFUSE');
  details.summary = {
    shapesPriced: priced.length,
    headroomLowerBoundMs: Object.fromEntries(
      priced
        .filter((r) => r.verdict === 'ADMIT' && r.derivedHeadroomLowerBoundPs !== null)
        .map((r) => [`${r.id} ${r.circuit}`, asMs(r.derivedHeadroomLowerBoundPs)]),
    ),
    overBudgetMs: Object.fromEntries(
      refused.map((r) => [`${r.id} ${r.circuit}`, asMs(r.marginPs)]),
    ),
    shapesRefused: refused.map((r) => `${r.id} ${r.circuit}`),
    shapesAdmitted: priced.filter((r) => r.verdict === 'ADMIT').map((r) => `${r.id} ${r.circuit}`),
    shapesNotPriced: table.filter((r) => r.verdict === 'NOT PRICED').map((r) => `${r.id} ${r.circuit}`),
  };

  const verdict = priced.length === 0 ? 'FAIL' : table.some((r) => r.verdict === 'NOT PRICED') ? 'PARTIAL' : 'PASS';

  writeEvidence({
    testId: 'DISMISS-COST',
    name: 'probe-dismiss-cost',
    fileName: 'dismiss-cost.json',
    description:
      'Time-to-dismiss cost of every unshielded shape of the account custody contract, priced off-node with the ' +
      'node\'s own check (Transaction.cost(params, true)) against the chain\'s live LedgerParameters, WITHOUT ' +
      'submitting: the coinless control, the faucet mint, both deposit legs, the device withdraw twin, and both ' +
      'unshielded grant twins.',
    verdict,
    note:
      `${priced.length} of ${table.length} shapes priced. Refused by the node\'s own check: ` +
      `${refused.length === 0 ? 'none' : refused.map((r) => `${r.id} ${r.circuit}`).join(', ')}. ` +
      'The table is the evidence; the per-shape triple is the node\'s own arithmetic.',
    details,
  });
});
