/**
 * The balancer's Midnight wallet, run under plain Node against ledger-9.
 *
 * Structurally this is `examples/passport-funder/src/wallet.ts` — a facade, a
 * serialised sync snapshot on disk, a one-spend-at-a-time queue, and a DUST
 * registration at start-up. The API underneath is NOT the same, and the
 * differences are called out where they bite:
 *
 *   1. **The ledger is the hyphenless scope.** `@midnight-ntwrk/wallet-sdk`
 *      2.0.0-beta.2 binds to `@midnightntwrk/ledger-v9`, not
 *      `@midnight-ntwrk/ledger-v9`. Two different WASM modules; importing the
 *      hyphenated one here would hand the facade objects from a foreign
 *      instance. Everything below imports the scope the SDK itself imports.
 *   2. **There is no global network id.** `setNetworkId`/`getNetworkId` from
 *      `midnight-js-network-id` are gone. The network is a field on the wallet
 *      configuration and an argument to `createKeystore`.
 *   3. **The keystore takes a tagged secret.** `createKeystore({ kind, secret },
 *      networkId)` — `kind` names the signature scheme, and the NightExternal
 *      role key is `schnorr` exactly as it was on ledger-8. (The HD wallet
 *      gained a separate `EcdsaUnshielded` role for the other scheme; role
 *      *numbers* are unchanged, so a seed derives the same address as before.)
 *   4. **Cost parameters are required**, not optional, on the dust wallet.
 *   5. **Proving can happen in this process.** The beta ships a WASM prover
 *      (`makeWasmProvingService`) whose default key-material provider fetches
 *      the four ledger-9 circuit keys over HTTPS and caches them in memory. A
 *      proof server is therefore an optimisation on stagenet, not a
 *      precondition — which matters, because stagenet publishes none.
 *   6. **Transaction history is an interface, not a stub.** The old
 *      `{ upsert, getAll, get, serialize }` shape is now
 *      `gotPending`/`gotFinalized`/`gotRejected`, and the SDK ships
 *      `NoOpTransactionHistoryStorage` for services that keep no history.
 *   7. **A DUST registration pays for itself out of the DUST it is about to
 *      generate**, so it has to wait for that projection to cover its own fee —
 *      `estimateRegistration` then `waitForGeneratedDust`. On ledger-8 the
 *      registration was submitted immediately.
 *
 * The seed is read once at start-up and never leaves this process.
 */

import { Buffer } from 'node:buffer';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Rx from 'rxjs';

import * as ledger from '@midnightntwrk/ledger-v9';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { Zkir, type KeyMaterialProvider } from '@midnight-ntwrk/zkir-v2';
/* Everything else comes through the umbrella `@midnight-ntwrk/wallet-sdk`
   package, which is what this service actually depends on. The individual
   `wallet-sdk-*` packages are present only because the umbrella pulls them in,
   and reaching past it would leave this code importing packages nothing here
   declares — which is precisely how the `@midnight-ntwrk/ledger-v9` /
   `@midnightntwrk/ledger-v9` confusion arises in the first place. */
import { NoOpTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk';
import {
  makeServerProvingService,
  makeWasmProvingService,
} from '@midnight-ntwrk/wallet-sdk/capabilities/proving';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk/dust';
import {
  WalletFacade,
  type BalancingRecipe,
  type FacadeState,
  type UtxoWithMeta,
} from '@midnight-ntwrk/wallet-sdk/facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk/hd';
import { WasmProver } from '@midnight-ntwrk/wallet-sdk/prover-client/effect';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk/shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk/unshielded';

import type { BalancerConfig } from './config.js';
import {
  createWalletReservation,
  currentJob,
  progress,
  type RunningJobSummary,
} from './reservation.js';
import { countingProof, proverIdle } from './proving.js';
import {
  CONTRACT_PROOF_TIMEOUT_MS,
  ProofTimeout,
  queryTransactionByIdentifier,
  withDeadline,
} from './contractRuntime.js';
import { isSubmissionTimeout, serialisedSubmissionService } from './submission.js';
import { FEE_CAPABLE_SPECKS } from './resolverPool.js';

// The wallet SDK's indexer client needs a global WebSocket under plain Node.
(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket;

export const NIGHT_DECIMALS = 6;

/** Formats atomic NIGHT for logs, on the same 6-decimal human scale the demo uses. */
export function formatNight(value: bigint): string {
  const scale = 10n ** BigInt(NIGHT_DECIMALS);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(NIGHT_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** Account 0, index 0 — the derivation the demo, the funder, and the prototype share. */
export function deriveRoleKeys(seedHex: string): Record<0 | 2 | 3, Uint8Array> {
  const wallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (wallet.type !== 'seedOk') throw new Error('The balancer seed was rejected by the HD wallet.');
  const derived = wallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  wallet.hdWallet.clear();
  if (derived.type !== 'keysDerived') {
    throw new Error('Key derivation from the balancer seed failed.');
  }
  return derived.keys;
}

/** The bech32m unshielded address a seed produces on a given network. */
export function unshieldedAddressFromSeed(seedHex: string, networkId: string): string {
  const keys = deriveRoleKeys(seedHex);
  const keystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] },
    networkId,
  );
  return PublicKey.fromKeyStore(keystore).address;
}

interface StoredSnapshot {
  version: 1;
  networkId: string;
  unshieldedAddress: string;
  savedAt: string;
  shielded: string;
  unshielded: string;
  dust: string;
}

function snapshotPath(config: BalancerConfig): string {
  return join(config.stateDir, `sync-snapshot-${config.networkId}.json`);
}

/**
 * The file that says "resume everything except the DUST".
 *
 * The last resort under a wedge, and narrower than deleting the snapshot. The
 * shielded and unshielded halves of a stored snapshot are never the fault — the
 * pending flags live in the DUST state alone — so throwing all three away costs
 * a full chain walk to repair one. Writing this file instead restores the two
 * that are sound and starts the DUST wallet from chain, which is the only thing
 * that forgets a `pending_until` no revert will clear.
 *
 * Consumed once and deleted, so a cold DUST start can never become permanent
 * through a file somebody forgot about.
 */
function dustColdStartPath(config: BalancerConfig): string {
  return join(config.stateDir, `dust-cold-start-${config.networkId}`);
}

/**
 * `./server.ts`'s `resyncDust` remedy writes this when the snapshot repair
 * itself failed. Exported so the remedy and the reader agree on the path
 * without either of them spelling it out twice.
 */
export function markDustColdStart(config: BalancerConfig): Promise<void> {
  return writeFile(dustColdStartPath(config), new Date().toISOString(), 'utf8');
}

async function loadSnapshot(
  config: BalancerConfig,
  address: string,
): Promise<StoredSnapshot | null> {
  try {
    const raw = await readFile(snapshotPath(config), 'utf8');
    const parsed = JSON.parse(raw) as StoredSnapshot;
    if (
      parsed.version !== 1 ||
      parsed.networkId !== config.networkId ||
      parsed.unshieldedAddress !== address
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * How far behind each wallet is, for `/status` and the sync log.
 *
 * `applied` versus `highestRelevant` is the pair that DECIDES `isSynced`: the
 * SDK's `isStrictlyComplete()` is `isConnected && applied === highestRelevant`,
 * where "relevant" means relevant to THIS wallet, not the chain tip. `highest`
 * is the tip the indexer reports and is carried only for an operator's sense of
 * scale — on the stagenet indexer (4.4.0-pre-alpha.16) it comes through as 0,
 * so it must never be mistaken for the sync verdict.
 */
export interface SyncSnapshotProgress {
  isSynced: boolean;
  shielded: WalletProgress;
  unshielded: WalletProgress;
  dust: WalletProgress;
}

export interface WalletProgress {
  applied: string;
  highestRelevant: string;
  highest: string;
  connected: boolean;
  complete: boolean;
}

/* -------------------------------------------------------------------------- */
/* Synced, and synced ENOUGH                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How far this leg has applied PAST the last progress figure the indexer gave
 * it. Zero for a leg that is level or behind.
 *
 * A malformed figure — an unparseable string from a wallet that answered badly
 * — reads as zero, which is the conservative answer: it leaves the SDK's own
 * `complete` as the only thing that can call the leg synced.
 */
function aheadBy(leg: WalletProgress): bigint {
  try {
    const gap = BigInt(leg.applied) - BigInt(leg.highestRelevant);
    return gap > 0n ? gap : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Is this wallet synced ENOUGH to select coins — including in the two to four
 * and a half minutes after one of its own spends, when the SDK says it is not?
 *
 * WHAT `applied > highest` ACTUALLY MEANS, read out of the SDK rather than
 * guessed (`@midnight-ntwrk/wallet-sdk-unshielded-wallet/dist/v1/SyncProgress.js`
 * and `…-abstractions/dist/SyncProgress.js`, both 2.0.0-beta.2):
 *
 *     isCompleteWithin(data, maxGap) {
 *       const applyLag = BigInt(Math.abs(Number(data.highestTransactionId - data.appliedId)));
 *       return data.isConnected && applyLag <= maxGap;
 *     }
 *
 * and `isStrictlyComplete()` is that with `maxGap` of zero. The lag is an
 * ABSOLUTE value, so a wallet one id AHEAD of the figure scores exactly as
 * incomplete as a wallet one id behind — and the two are not the same event at
 * all. The two figures come from two DIFFERENT messages on the indexer's
 * subscription (`…/dist/v1/Sync.js`): a `UnshieldedTransactionsProgress`
 * message sets `highestTransactionId`, and a transaction message sets
 * `appliedId` to `update.transaction.id`. So when this wallet's OWN submission
 * arrives before the next progress announcement, it applies a transaction whose
 * id is higher than the last `highestTransactionId` it was told about, and the
 * SDK scores that as unsynced until the announcement catches up. Measured live
 * on 2026/09/02: `unshielded applied 9549 > highest 9521` for 2–4.5 minutes
 * after every spend, during which `/wallet-status` answered `available: 0` and
 * a second Passport 20 s behind the first was refused in two seconds.
 *
 * A wallet that is AHEAD has everything the indexer has told it about and one
 * thing more — it is strictly better informed than a `complete` one, never
 * worse — so for the question this service actually asks ("can this wallet
 * select coins right now?") it is synced. A leg BEHIND its figure is not, and
 * a leg whose subscription has dropped is not either: those keep the SDK's own
 * verdict.
 *
 * This is deliberately NOT a redefinition of `isSynced`, which stays exactly
 * what the SDK says and is still what `/status` publishes as `progress`. It is
 * the readiness question, asked separately, because those are two questions.
 */
/** One leg's answer: the SDK's own `complete`, or connected and AHEAD of it. */
export function isLegEffectivelySynced(leg: WalletProgress): boolean {
  if (leg.complete) return true;
  return leg.connected && aheadBy(leg) > 0n;
}

export function isEffectivelySynced(progress: SyncSnapshotProgress): boolean {
  if (progress.isSynced) return true;
  return (
    isLegEffectivelySynced(progress.shielded) &&
    isLegEffectivelySynced(progress.unshielded) &&
    isLegEffectivelySynced(progress.dust)
  );
}

/**
 * The legs that are ahead, named — `unshielded applied 9549 > highest 9521` —
 * or `null` when none is. What the health verdict says instead of guessing at
 * a prover.
 */
export function syncAheadDetail(progress: SyncSnapshotProgress): string | null {
  const named: Array<[string, WalletProgress]> = [
    ['shielded', progress.shielded],
    ['unshielded', progress.unshielded],
    ['dust', progress.dust],
  ];
  const ahead = named
    .filter(([, leg]) => aheadBy(leg) > 0n)
    .map(([name, leg]) => `${name} applied ${leg.applied} > highest ${leg.highestRelevant}`);
  return ahead.length > 0 ? ahead.join(', ') : null;
}

/**
 * One spendable shielded coin, flattened to the three fields a Compact
 * `ShieldedCoinInfo` argument needs.
 *
 * Deliberately NOT the SDK's `AvailableCoin`: the asset grant's only interest in
 * the wallet's coin set is "which coin do I hand to `deposit_shielded`", and
 * keeping the SDK's shielded types out of `./account.ts` is what stops that
 * module from acquiring a second opinion about which ledger package is in play.
 * `nonce` and `type` are the ledger's own string forms — hex, `0x`-prefixed or
 * not, exactly as the wallet reports them.
 */
/**
 * How many of these DUST coins could carry a transaction fee ON THEIR OWN.
 *
 * Coins, not the balance, and this is the only count a lane may be opened on.
 * The SDK's selection is per coin, so 3e16 Specks spread over four small coins
 * pays for no contract call at all — and, the case that cost a live run, a
 * spend's CHANGE is a DUST coin from the moment it lands and is not fee-capable
 * for minutes afterwards, because `generatedNow` starts near zero and grows
 * against the NIGHT backing it.
 */
export function feeCapableCoinCount(
  coins: ReadonlyArray<{ generatedNow: bigint }>,
  minSpecks: bigint,
): number {
  return coins.filter((coin) => coin.generatedNow >= minSpecks).length;
}

/**
 * How many spend jobs the queue may run at once, given a ceiling and the coins.
 *
 * Never below one: a lane count of zero would not throttle the queue, it would
 * STOP it — `drain` runs on arrival and on completion, so with nothing running
 * there would be nothing left to call it again. A wallet with no fee-capable
 * coin therefore gets one lane, whose job fails fast and waits for a coin
 * outside the queue. See `withDustWait`.
 */
export function spendLaneCount(feeCapableFree: number, ceiling: number): number {
  return Math.max(1, Math.min(ceiling, feeCapableFree));
}

export interface ShieldedCoin {
  readonly nonce: string;
  readonly type: string;
  readonly value: bigint;
}

export interface BalanceOnlyResult {
  txHash: string;
  /** Lower-case hex, no `0x` prefix — what `sponsor.ts` normalises to. */
  txBytes: string;
  expiresAt: string;
}

/* -------------------------------------------------------------------------- */
/* The orphan watch                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One balanced transaction this wallet has booked DUST against and handed back
 * to a caller who has not been seen submitting it.
 *
 * `finalized` is the merged transaction `finalizeRecipe` produced, kept only so
 * `facade.revert` can be given the same object back. Nothing here is key
 * material and nothing here names a user.
 */
export interface OrphanEntry {
  /** The ledger hash the caller was handed, and the key this map is read by. */
  txHash: string;
  /** What the indexer is asked about — `transactions(offset: { identifier })`. */
  identifier: string;
  finalized: unknown;
  balancedAt: number;
}

export interface OrphanWatchOptions {
  /**
   * How long a balanced transaction may go unseen before its DUST is taken
   * back. `config.balanceOrphanMs`.
   */
  orphanMs: number;
  /**
   * Whether the chain has this identifier. `null` — and only `null` — means the
   * question could not be put, which is never grounds for reverting anything.
   */
  landed(identifier: string): Promise<boolean | null>;
  /** Hand the DUST back: `facade.revert(finalized)`, under a claim. */
  revert(entry: OrphanEntry): Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface OrphanWatch {
  /** Book a balanced transaction as outstanding. */
  watch(entry: OrphanEntry): void;
  /**
   * Release one entry now, on the caller's word that its own submit failed.
   * `false` when nothing was being watched under that hash — a second call, or
   * a transaction the sweeper has already ruled on.
   */
  abandon(txHash: string): Promise<boolean>;
  /** One pass: everything past `orphanMs` is asked about and judged. */
  sweep(): Promise<void>;
  /** How many balanced transactions are outstanding right now. */
  readonly size: number;
  /** How many this watch has released since the process started. */
  readonly released: number;
}

/**
 * `/balance-only` books this wallet's DUST as spent and hands the transaction
 * to somebody else to submit. When that submit never happens — the node
 * rejected the transaction, the browser closed, a preflight failed — the
 * booking stands until the balancing TTL expires, which is thirty minutes of a
 * balancer that answers `INSUFFICIENT_DUST` to everybody.
 *
 * That is not a hypothesis. On 2026/09/02 at 14:12:57Z a transaction the node
 * refused (`Custom error: 239`) took the wallet's only DUST coins with it;
 * `/wallet-status` read `dust 0 / utxoCount 0` from 14:13:00Z and onboarding
 * was refused for the rest of the window.
 *
 * So the booking is now provisional: if the chain has not seen the transaction
 * `orphanMs` after it was balanced, the DUST comes back. The asymmetry is
 * deliberate — reverting a transaction that DOES land would double-spend, so
 * an indexer that cannot answer is treated as "still waiting", never as
 * "absent", and only a definite absence releases anything.
 *
 * Pure of the chain and of the clock, so `test/orphans.test.ts` can place a
 * landing, a rejection, and a sweep exactly where it wants them.
 */
export function createOrphanWatch(options: OrphanWatchOptions): OrphanWatch {
  const entries = new Map<string, OrphanEntry>();
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  let released = 0;

  /**
   * Deletes BEFORE reverting, so a sweep and an `/balance-only/abandon` racing
   * over the same hash cannot revert it twice. A revert that then fails leaves
   * the booking in the SDK's hands until the TTL or a restart clears it, which
   * is exactly where it was before this existed.
   */
  const release = async (entry: OrphanEntry, why: string): Promise<boolean> => {
    if (!entries.delete(entry.txHash)) return false;
    try {
      await options.revert(entry);
      released += 1;
      log(`[balance] released the DUST booked for ${entry.txHash}: ${why}`);
      return true;
    } catch (cause) {
      warn(
        `[balance] could not release the DUST booked for ${entry.txHash}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return false;
    }
  };

  return {
    watch(entry: OrphanEntry): void {
      entries.set(entry.txHash, entry);
    },

    async abandon(txHash: string): Promise<boolean> {
      const entry = entries.get(txHash);
      if (!entry) return false;
      return release(entry, 'the caller reported that its own submit failed');
    },

    async sweep(): Promise<void> {
      for (const entry of [...entries.values()]) {
        const age = now() - entry.balancedAt;
        if (age < options.orphanMs) continue;
        const seen = await options.landed(entry.identifier);
        /* The indexer could not be asked. Ask again next tick: an unanswered
           question is not evidence of absence, and reverting on one would
           double-spend a transaction that had in fact landed. */
        if (seen === null) continue;
        if (seen) {
          entries.delete(entry.txHash);
          continue;
        }
        await release(entry, `not on chain ${Math.round(age / 1_000)} s after balancing`);
      }
    },

    get size(): number {
      return entries.size;
    },

    get released(): number {
      return released;
    },
  };
}

/**
 * Is a DUST shortfall read right now explainable, or is this wallet empty?
 *
 * Two ways it is explainable, and both are bounded: the balancer's own last
 * spend has not had its change back yet, or a transaction it balanced is still
 * outstanding and the sweeper has not ruled on it. Either way the answer to the
 * caller is "come back in three seconds", not "this service cannot help you" —
 * which is the difference that lost a send on 2026/09/02.
 *
 * Pure, so `test/orphans.test.ts` can put the clock exactly where it wants it.
 */
export function balancerIsSettling(input: {
  now: number;
  /** Epoch milliseconds of this service's last own spend; 0 for "never". */
  lastSpendAt: number;
  settleWindowMs: number;
  /** Balanced transactions still outstanding. */
  orphans: number;
}): boolean {
  if (input.orphans > 0) return true;
  if (input.lastSpendAt <= 0) return false;
  return input.now - input.lastSpendAt < input.settleWindowMs;
}

/**
 * Is this wallet's DUST hidden from it rather than absent?
 *
 * A wedge has a SIGNATURE, and it is the conjunction below — every one of these
 * at once, and none of them alone:
 *
 *   - the wallet is synced, so it is not merely behind the chain;
 *   - it holds NIGHT, so there is something for that NIGHT to be generating;
 *   - it reports no spendable DUST UTxO;
 *   - nothing is pending — no transaction of its own is in flight, so no coin
 *     is legitimately booked against one;
 *   - nothing it balanced is outstanding, so the orphan sweeper has no claim
 *     either;
 *   - it is neither claimed nor busy, so nobody is spending from it now;
 *   - and its last spend is older than the orphan window, so the settle this
 *     would otherwise be has had every chance to complete.
 *
 * That leaves exactly one explanation: the ledger is holding coins the wallet
 * still owns behind a `pending_until` flag that no revert will now clear. See
 * `./dustRollback.ts` for how it gets there and what undoes it.
 *
 * Pure and clock-free, so `test/health.test.ts` can place a wedge, a settle,
 * and a spend-in-flight exactly where it wants them.
 */
export function isDustWedged(facts: {
  synced: boolean;
  nightAtomic: bigint;
  dustUtxoCount: number;
  pendingTransactions: number;
  orphans: number;
  reserved: boolean;
  busy: boolean;
  now: number;
  lastSpendAt: number;
  orphanMs: number;
}): boolean {
  if (!facts.synced) return false;
  if (facts.nightAtomic <= 0n) return false;
  if (facts.dustUtxoCount > 0) return false;
  if (facts.pendingTransactions > 0) return false;
  if (facts.orphans > 0) return false;
  if (facts.reserved || facts.busy) return false;
  /* Never inside the settle: a spend that has just happened SHOULD read as no
     DUST, and repairing that would revert a transaction on its way to a block. */
  if (facts.lastSpendAt > 0 && facts.now - facts.lastSpendAt <= facts.orphanMs) return false;
  return true;
}

/**
 * The fee estimate could not be covered because no DUST coin was free.
 *
 * Typed, and thrown rather than waited out, because the wait used to happen
 * INSIDE the spend job: `balanceTx` sat in a ten-minute retry loop holding the
 * queue while every registration and every grant behind it waited. On
 * 2026/09/02 the spare mint did exactly that for ten minutes with a queue depth
 * of one. The wait belongs before the job — see `awaitFreeDustCoin` — and the
 * job itself should fail fast and let its caller decide.
 */
export class DustUnavailable extends Error {
  constructor(detail: string) {
    super(`no DUST coin was free to pay this transaction's fee: ${detail}`);
    this.name = 'DustUnavailable';
  }
}

/**
 * A call into the wallet facade that never came back.
 *
 * THE FAILURE THIS NAMES, AND WHERE IT WAS MEASURED. On 2026/09/03 a spend job
 * wrote `the spare mUSD mint proved (job-13)` at 01:45:29 UTC and then nothing
 * — no step, no error, no line of any kind for eight minutes, until systemd
 * killed the process. `proved` is logged by `midnight-js` finishing the circuit
 * proof; the next thing the job does is call into the wallet facade to estimate
 * its fee and balance the transaction, and neither of those calls had a ceiling
 * of any kind. Every other wait in a spend job had been given one by then. This
 * is the three that had been missed.
 *
 * Rebuildable, like a node rejection: nothing has been submitted at the point
 * any of the three runs, so the caller may simply build the transaction again.
 */
export class WalletCallTimeout extends Error {
  readonly call: string;

  constructor(call: string, waitedMs: number) {
    super(`the wallet did not finish ${call} within ${Math.round(waitedMs / 1_000)} s`);
    this.name = 'WalletCallTimeout';
    this.call = call;
  }
}

/** Matches {@link WalletCallTimeout} across a bundle boundary. */
export function isWalletCallTimeout(cause: unknown): boolean {
  if (cause instanceof WalletCallTimeout) return true;
  return cause instanceof Error && cause.name === 'WalletCallTimeout';
}

/**
 * The background chain walk stopped producing state events.
 *
 * Reported rather than repaired. A wallet that is not syncing is a wallet whose
 * indexer socket has gone quiet, and the health loop already knows how to
 * rewarm one — what was missing was any way to find out, since the wait itself
 * had no ceiling and simply never returned.
 */
export class SyncStalled extends Error {
  constructor(waitedMs: number) {
    super(
      `the chain walk reported nothing for ${Math.round(waitedMs / 1_000)} s — the indexer subscription has most likely gone quiet`,
    );
    this.name = 'SyncStalled';
  }
}

/** Matches {@link SyncStalled} across a bundle boundary. */
export function isSyncStalled(cause: unknown): boolean {
  if (cause instanceof SyncStalled) return true;
  return cause instanceof Error && cause.name === 'SyncStalled';
}

/** Three seconds — half a block, and the figure `/wallet-status` publishes. */
const SHORTFALL_RETRY_AFTER_MS = 3_000;

/**
 * The wait for a coin ran out, and nothing was spent.
 *
 * Typed and carrying its own `retryAfterMs`, because the caller has to turn it
 * into a refusal a client can act on rather than into a 502. On 2026/09/02 the
 * first claim of an onboarding failed 5/5 with `DustUnavailable` surfacing as
 * a 502 about sixty seconds after the click, and the user had to press Claim
 * again — which then worked, in 52–58 s, because by then the coin their own
 * account deploy had booked was back. This service waits for that coin now, and
 * only when the wait itself is exhausted does anybody see a refusal.
 */
export class DustWaitExhausted extends Error {
  constructor(
    readonly label: string,
    readonly waitedMs: number,
    readonly retryAfterMs: number,
  ) {
    super(
      `no fee-capable DUST coin came free for ${label} within ${Math.round(waitedMs / 1_000)} s`,
    );
    this.name = 'DustWaitExhausted';
  }
}

/**
 * Is this failure OUR DUST shortfall, however deeply it has been re-wrapped?
 *
 * It has to be asked this way rather than with `instanceof`, and the live run
 * on 2026/09/02 20:36 is why: midnight-js catches whatever a wallet provider
 * throws and re-raises it as its own `Error`, so the registration's register
 * leg came back as
 *
 *   Unexpected error submitting scoped transaction '<unnamed>':
 *   DustUnavailable: no DUST coin was free to pay this transaction's fee:
 *   Insufficient Funds: could not balance dust
 *
 * — a plain `Error` carrying our class's NAME in its text and nothing else of
 * it. So the `cause` chain is walked first, and the text is the fallback. It
 * matches on `DustUnavailable`, which only this module produces, rather than on
 * the SDK's own "insufficient funds": somebody else's shortfall is not a reason
 * for this service to sit and wait for its own coin.
 */
export function isDustShortfall(cause: unknown): boolean {
  let seen: unknown = cause;
  for (let depth = 0; seen !== null && seen !== undefined && depth < 8; depth += 1) {
    if (seen instanceof DustUnavailable) return true;
    seen = (seen as { cause?: unknown }).cause;
  }
  return /DustUnavailable/.test(cause instanceof Error ? cause.message : String(cause));
}

export interface DustWaitOptions {
  /** What is waiting, for the journal and for the refusal. */
  label: string;
  /** The whole budget, across every wait this call makes. */
  windowMs: number;
  /** Normally `wallet.awaitFreeDustCoin`, bound to {@link FEE_CAPABLE_SPECKS}. */
  awaitFreeCoin: (maxMs: number) => Promise<boolean>;
  /** How long a refused caller should be told to wait. */
  retryAfterMs?: number;
  /**
   * Takes a priority hold on the spend queue for the length of the wait, and
   * returns its release. Without one the wait costs the caller its PRIORITY:
   * see `hold` in `./reservation.ts`, and the 173.3-second first click that
   * paid for the lesson.
   */
  holdWhileWaiting?: () => () => void;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Runs a spend, and WAITS rather than refusing when no coin was free for it.
 *
 * THE WAIT IS OUT HERE AND NOT INSIDE THE JOB, and that is the whole shape of
 * it. `contractWalletProvider`'s own `waitForDustMs` stays zero — a job that
 * has started and cannot find a coin holds a lane while it waits, which is what
 * let one fee estimate block every other registration for ten minutes on
 * 2026/09/02. So the job fails fast with {@link DustUnavailable}, gives its
 * lane back within a second, and this waits for a coin holding nothing at all
 * before running `spend` AGAIN.
 *
 * Running it again is a REBUILD, not a resubmission: `spend` is a thunk that
 * re-enters the queue and rebuilds its transaction against the wallet as it now
 * stands, so whatever rebuild-and-retry ladder lives inside it —
 * `withNodeRejectionRetry`, in both the registration and the grant — applies to
 * the attempt after the wait exactly as it did to the first.
 *
 * Anything that is not a DUST shortfall is rethrown untouched and immediately:
 * a refused circuit or an unreachable prover is not made better by waiting.
 */
export async function withDustWait<T>(
  spend: () => Promise<T>,
  options: DustWaitOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const startedAt = now();
  const deadline = startedAt + Math.max(0, options.windowMs);
  const retryAfterMs = options.retryAfterMs ?? SHORTFALL_RETRY_AFTER_MS;
  /* Released the instant the rebuilt attempt is ON the queue, and never
     before: `spend` enqueues synchronously (it calls `wallet.exclusive`
     directly), so between the release and the enqueue there is no tick for a
     lower-priority job to take the coin this wait was for. A `spend` that
     somehow did not enqueue synchronously would only lose the priority it
     never had — it cannot deadlock, because the hold is dropped either way. */
  let release: (() => void) | null = null;
  const attempt = async (): Promise<T> => {
    try {
      const running = spend();
      release?.();
      release = null;
      return await running;
    } finally {
      release?.();
      release = null;
    }
  };
  for (;;) {
    try {
      return await attempt();
    } catch (cause) {
      if (!isDustShortfall(cause)) throw cause;
      const remaining = deadline - now();
      if (remaining <= 0) throw new DustWaitExhausted(options.label, now() - startedAt, retryAfterMs);
      log(
        `[dust] ${options.label} found no fee-capable coin free — waiting up to ${Math.round(remaining / 1_000)} s for one rather than refusing`,
      );
      release = options.holdWhileWaiting?.() ?? null;
      let free: boolean;
      try {
        free = await options.awaitFreeCoin(remaining);
      } catch (waitCause) {
        release?.();
        release = null;
        throw waitCause;
      }
      if (!free) {
        release?.();
        release = null;
        throw new DustWaitExhausted(options.label, now() - startedAt, retryAfterMs);
      }
      log(
        `[dust] a fee-capable coin came free after ${Math.round((now() - startedAt) / 1_000)} s — rebuilding ${options.label}, ahead of anything of lower priority still waiting`,
      );
    }
  }
}


/**
 * The refusal a DUST shortfall or an unsynced read earns.
 *
 * A 429 while it is settling, because `sponsor.ts` retries PENDING_TRANSACTION
 * inside a 600-second window for a contract call and a 503 sends it to the next
 * sponsor in its list instead — which, mid-send, means the second leg of a
 * transfer is proved against a state the first leg has already moved. The
 * original code travels as `cause`, so an operator still sees which of the two
 * conditions it was.
 */
export function shortfallRefusal(code: string, message: string, settling: boolean): BalanceRefusal {
  if (settling) {
    return new BalanceRefusal(429, 'PENDING_TRANSACTION', message, {
      retryAfterMs: SHORTFALL_RETRY_AFTER_MS,
      cause: code,
    });
  }
  return new BalanceRefusal(503, code, message);
}

/**
 * Whether the indexer has a transaction carrying this identifier — the same
 * query shape `./contractRuntime.ts` resolves hashes with, asked once, because
 * the sweeper's own six-second cadence is the retry.
 *
 * `null` for anything that is not a definite answer: a network failure, a
 * GraphQL error, a body that does not parse. Only an empty `transactions` list
 * from a response that parsed is "not on chain".
 */
export async function transactionLanded(
  indexerHttpUrl: string,
  identifier: string,
): Promise<boolean | null> {
  const query = `{ transactions(offset: { identifier: "${identifier}" }) { hash } }`;
  try {
    const response = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: { transactions?: Array<{ hash?: string }> };
      errors?: unknown[];
    };
    if (body.errors && body.errors.length > 0) return null;
    const found = body.data?.transactions;
    if (!Array.isArray(found)) return null;
    return found.length > 0;
  } catch {
    return null;
  }
}

/**
 * A refusal the HTTP layer can turn into the wire shape `sponsor.ts` parses:
 * `{ error, message }` with an optional `cause` and `retryAfterMs`.
 */
export class BalanceRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly cause?: string;
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { cause?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'BalanceRefusal';
    this.status = status;
    this.code = code;
    if (extra.cause !== undefined) this.cause = extra.cause;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

/**
 * The circuits a Midnight transaction can need proofs for. The balancing leg
 * this service adds only ever spends DUST, so `midnight/dust/spend` is the one
 * that must work; the three Zswap circuits are warmed with it because they cost
 * seconds now and would cost a caller's first request otherwise.
 */
const PROVING_KEY_LOCATIONS = [
  'midnight/dust/spend',
  'midnight/zswap/spend',
  'midnight/zswap/output',
  'midnight/zswap/sign',
] as const;

export type ProvingReadiness =
  /** An external proof server is configured; its health is that server's business. */
  | { state: 'server'; url: string }
  | { state: 'warming' }
  | { state: 'ready'; warmedInMs: number; bytes: number }
  | { state: 'failed'; reason: string };

/**
 * The midnight-js v5 `WalletProvider` / `MidnightProvider` pair, backed by the
 * beta wallet SDK — what a contract deploy or circuit call balances, signs, and
 * submits through.
 *
 * This is the join `deploy-stagenet` proved on chain: midnight-js hands out an
 * `UnboundTransaction` and expects a `FinalizedTransaction` back, which is
 * exactly `balanceUnboundTransaction` → `signRecipe` → `finalizeRecipe` on the
 * facade. Both sides speak `@midnightntwrk/ledger-v9` 1.0.0-rc.3, so the
 * objects cross the boundary unconverted.
 */
export interface ContractWalletProvider {
  getCoinPublicKey(): unknown;
  getEncryptionPublicKey(): unknown;
  balanceTx(tx: unknown, ttl?: Date): Promise<unknown>;
  submitTx(tx: unknown): Promise<string>;
}

export interface ContractWalletProviderOptions {
  /**
   * How long `balanceTx` may wait for a DUST coin to come free before it gives
   * up with a {@link DustUnavailable}.
   *
   * ZERO BY DEFAULT, and that default is the fix. The wait used to be an
   * unconditional ten minutes taken INSIDE the spend job, so a job that found
   * no free coin held the queue for its whole budget — measured at 15:49:03 to
   * 15:59:07 on 2026/09/02, blocking every registration behind it. Wait before
   * the job with {@link BalancerWallet.awaitFreeDustCoin} instead; a job that
   * has started should fail fast.
   */
  waitForDustMs?: number;
}

export interface BalancerWallet {
  readonly address: string;
  /** `'server'` when an external prover is configured, `'wasm'` when in-process. */
  readonly provingMode: 'server' | 'wasm';
  /**
   * Whether this service can prove a DUST fee leg. In WASM mode that is not a
   * given — the circuit keys come over the network — so it is established at
   * start-up rather than discovered inside somebody's first request.
   */
  provingReadiness(): ProvingReadiness;
  /** Fetches and caches the proving key material. Safe to call more than once. */
  warmProvingKeys(): Promise<ProvingReadiness>;
  currentState(): Promise<FacadeState>;
  waitForSync(onTick?: (progress: SyncSnapshotProgress) => void): Promise<void>;
  progress(state?: FacadeState): Promise<SyncSnapshotProgress>;
  /** Atomic NIGHT held right now. */
  nightBalance(state?: FacadeState): Promise<bigint>;
  /** Spendable DUST (Specks) right now. */
  dustBalance(state?: FacadeState): Promise<bigint>;
  /**
   * This wallet's own shielded balance of one raw token type — the colour a
   * minted mUSD coin carries, not NIGHT.
   */
  shieldedBalance(tokenType: string, state?: FacadeState): Promise<bigint>;
  /**
   * The spendable shielded coins this wallet holds of one colour.
   *
   * Read from the wallet's own coin set rather than assumed from what a mint
   * was called with: a coin is only spendable once the wallet has really seen
   * it, and that is the thing the asset grant has to wait for.
   */
  availableShieldedCoins(tokenType: string, state?: FacadeState): Promise<ShieldedCoin[]>;
  /**
   * The 32 bytes a Compact `CoinPublicKey` argument takes for THIS wallet — the
   * recipient a mint pays to when the balancer is minting to itself.
   */
  shieldedCoinPublicKeyBytes(): Promise<Uint8Array>;
  /** How many DUST UTxOs back that balance — `/wallet-status` reports it. */
  dustUtxoCount(state?: FacadeState): Promise<number>;
  /**
   * Transactions this wallet has booked as pending and not yet seen resolved.
   *
   * The fact that separates a wallet mid-spend from a wedged one: a DUST
   * balance of zero with something pending is correct and temporary, and the
   * same reading with nothing pending is the ledger holding coins behind an
   * expired grace period. See {@link isDustWedged}.
   */
  pendingTransactionCount(state?: FacadeState): Promise<number>;
  /**
   * Whether this wallet's DUST is hidden rather than absent, read from the live
   * state. `false` for every explainable shortfall — see {@link isDustWedged}
   * for the full conjunction and why each term is in it.
   */
  dustWedged(state?: FacadeState): Promise<boolean>;
  /**
   * Waits, OUTSIDE any spend job, until at least one DUST coin is free.
   *
   * This is the wait `balanceTx` used to do from inside the queue, which is
   * what let one job's fee estimate block every other job for ten minutes. Here
   * it blocks only its own caller, and a caller that gives up gives up without
   * ever having held the queue. `true` when a coin came free, `false` when the
   * budget ran out.
   *
   * `minSpecks` counts only coins big enough to carry a fee ON THEIR OWN, which
   * is the count that actually decides whether a spend can start: the SDK's
   * selection is per coin. Pass {@link FEE_CAPABLE_SPECKS} for a contract call.
   * Omitting it counts any coin at all, which is the older, weaker question.
   */
  awaitFreeDustCoin(maxMs: number, options?: { minSpecks?: bigint }): Promise<boolean>;
  /** Spend jobs running right now — `/status` publishes it as `jobsRunning`. */
  jobCount(): number;
  /**
   * What each running spend job is doing, and how long since it last said so.
   *
   * This is what makes a silent job visible from OUTSIDE the process. On
   * 2026/09/02 `/status` could say `jobsRunning: 1` for thirty-seven minutes
   * and nothing could tell whether that job was proving or wedged; the droplet
   * watchdog now reads a step and an age and can decide.
   */
  runningJobs(): RunningJobSummary[];
  /**
   * How many may run at once: the configured ceiling, or the free FEE-CAPABLE
   * DUST coins if there are fewer.
   */
  spendLanes(): number;
  /**
   * Registers every unregistered NIGHT UTxO for DUST generation, so the
   * balancer has DUST to spend on other people's fees. Returns what happened.
   */
  registerDustIfNeeded(): Promise<
    'registered' | 'already-generating' | 'no-night' | 'waiting-for-dust'
  >;
  /**
   * The whole point of the service: take somebody else's finalized transaction,
   * add a DUST fee leg paid from this wallet, prove that leg, and hand the
   * merged transaction back. Nothing is submitted here — the caller's own
   * wallet submits, which is what the demo's balancing path in
   * `examples/passport-demo/src/identity/contractRuntime.ts` expects.
   */
  balanceOnly(transactionBytes: Uint8Array): Promise<BalanceOnlyResult>;
  /**
   * Gives back the DUST booked for one balanced transaction, on the caller's
   * word that its own submit failed. `false` when nothing is outstanding under
   * that hash. The sweeper would get there anyway; this only makes it immediate.
   */
  abandonBalance(txHash: string): Promise<boolean>;
  /**
   * Balanced transactions still outstanding, and how many this process has
   * given the DUST back for. Published on `/status` as `balancesWatched` and
   * `balancesOrphaned`, and read by the health watchdog.
   */
  orphanStats(): { watching: number; released: number };
  /**
   * True while this wallet's DUST shortfall is explainable — its own last spend
   * is still settling, or a balanced transaction is still outstanding. The
   * difference between "come back in three seconds" and "this wallet is empty".
   */
  isSettling(): boolean;
  /**
   * True while a CLAIM on this wallet's coin state is outstanding — a balancing,
   * a signature, a submission, or a revert. Deliberately NOT true while a job is
   * merely proving: see `./reservation.ts` for why the two are different
   * questions, and what conflating them cost.
   *
   * This is the signal `/wallet-status` publishes as `available`.
   */
  isReserved(): boolean;
  /**
   * True while any spend job holds the queue, proving included. For background
   * housekeeping that has no reason to run mid-grant — the DUST registration —
   * rather than for a caller's "can you pay a fee?".
   */
  isBusy(): boolean;
  /**
   * Runs `task` as one spend job, queued behind every other spend job.
   *
   * `/balance-only` reserves DUST; a sponsored registration spends NIGHT and
   * DUST twice over. Serialising them keeps two grants arriving together from
   * racing the proof server, and keeps the order of what this wallet submits
   * predictable.
   *
   * It does NOT by itself claim the wallet's coins — the phases inside do, for
   * as long as they need them. That is why {@link contractWalletProvider} may
   * take a claim inside a job that already holds the queue without deadlocking.
   *
   * `priority` reorders only what is still WAITING — see {@link SpendPriority},
   * which is where the measurement behind the one non-default value lives.
   */
  exclusive<T>(
    task: () => Promise<T>,
    options?: { priority?: number; label?: string },
  ): Promise<T>;
  /**
   * Keeps the queue's next lane for a job that is waiting for a DUST coin
   * outside the queue. See `hold` in `./reservation.ts` for the measurement
   * that put it there; {@link withDustWait} is its only caller.
   */
  hold(priority: number): () => void;
  /**
   * The provider midnight-js balances, signs, and submits contract
   * transactions through. Built per job, because it snapshots the wallet's
   * shielded keys; calls made through it MUST be inside {@link exclusive}.
   */
  contractWalletProvider(options?: ContractWalletProviderOptions): ContractWalletProvider;
  saveSnapshot(): Promise<void>;
  close(): Promise<void>;
}

/**
 * What `./server.ts` knows and this module does not: when the balancer last
 * spent on its OWN account — a sponsored registration, an activation grant —
 * and how long that spend's change is allowed to be in flight before a
 * shortfall stops being explainable.
 *
 * Both have defaults, so a `sync-check` or a test can open a wallet without
 * them and get today's behaviour.
 */
export interface BalancerWalletHooks {
  /** Epoch milliseconds of this service's last own spend; 0 for "never". */
  lastSpendAt?: () => number;
  /** `CHANGE_SETTLE_MS` — how long that spend's change may take to come back. */
  settleWindowMs?: number;
  /**
   * Called when a revert has just failed to give this wallet its DUST back and
   * the live state now carries the wedge signature.
   *
   * Fired from the one place the failure is provable the instant it happens —
   * immediately after `facade.revert` on a transaction that spent DUST — so the
   * repair starts within a health tick rather than at the next ten-minute one.
   * `./server.ts` turns it into a `dustRepairPending` flag and an immediate
   * health tick.
   */
  onDustWedged?: () => void;
}

export async function openBalancerWallet(
  config: BalancerConfig,
  hooks: BalancerWalletHooks = {},
): Promise<BalancerWallet> {
  /* The wallet SDK takes its network as a field (point 2 above), but midnight-js
     5 does NOT: it keeps the id in module-level state and `getNetworkId` THROWS
     when it is unset — `Transaction.fromParts` and `parseCoinPublicKeyToHex`
     both call it, so every contract deploy and every circuit call goes through
     it. It is also the bech32m tag, so a mismatch here would silently produce
     addresses for another network. Set once, here, where the network is first
     known and before anything can use it. */
  setNetworkId(config.networkId);

  const keys = deriveRoleKeys(config.seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore: UnshieldedKeystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] },
    config.networkId,
  );
  const publicKey = PublicKey.fromKeyStore(unshieldedKeystore);
  const address = publicKey.address;

  const configuration = {
    networkId: config.networkId,
    indexerClientConnection: {
      indexerHttpUrl: config.indexerHttpUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    relayURL: new URL(config.relayUrl),
    costParameters: { feeBlocksMargin: config.feeBlocksMargin },
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    ...(config.provingServerUrl ? { provingServerUrl: new URL(config.provingServerUrl) } : {}),
  };

  /* Stagenet publishes no proof server, and the balancing DUST leg has to be
     proved by somebody. The beta SDK can do it here: the WASM prover pulls the
     four ledger-9 circuit keys (`zswap/spend`, `zswap/output`, `zswap/sign`,
     `dust/spend`) plus their BLS parameters and keeps them in memory. When
     BALANCER_PROVER_URL names a server — the 9.0.0-rc.5_experimental image,
     once it is hosted — that is used instead, because a server proves faster
     than a Node worker.

     The key-material provider is constructed HERE rather than left to
     `makeWasmProvingService()`'s default, because the cache lives in that
     object's closure: warming a provider the prover does not hold would warm
     nothing. */
  const provingServerUrl = config.provingServerUrl;
  const provingMode: 'server' | 'wasm' = provingServerUrl ? 'server' : 'wasm';
  /* Inert until something asks it for a key — it is just a cache and a `fetch`
     — so it costs nothing to build in server mode too, and building it
     unconditionally keeps the branch below to one decision. */
  const keyMaterialProvider: KeyMaterialProvider = WasmProver.makeDefaultKeyMaterialProvider();
  const provingService = provingServerUrl
    ? makeServerProvingService({ provingServerUrl: new URL(provingServerUrl) })
    : makeWasmProvingService({ keyMaterialProvider });

  const startFacade = async (snapshot: StoredSnapshot | null): Promise<WalletFacade> =>
    WalletFacade.init({
      configuration,
      /* NOT the SDK's default service, and this is the fix for the two silent
         hangs of 2026/09/02. The default holds ONE polkadot-js connection for
         the whole facade and disconnects it at the end of every submission,
         and polkadot-js drops `author_*` subscriptions on the reconnect without
         erroring them — so one submission ending kills another's watch in
         silence, for ever. `./submission.ts` serialises submissions so two
         watches never coexist, and bounds each one. */
      submissionService: (cfg: { relayURL: URL }) =>
        /* Cast because the SDK types `submitTransaction` as an OVERLOAD SET
           whose return type follows the status the caller asked for, and this
           wrapper deliberately does not honour that: it asks the node for
           `'Submitted'` whatever it was handed, so it would be lying to claim
           it returns a `Finalized` event. Nothing in this service reads the
           return value — the facade discards it, and `submitTx` below returns
           the identifier it already had — so the narrower truth is the safe
           one. */
        serialisedSubmissionService(cfg, {
          timeoutMs: config.submitTimeoutMs,
          /* The running job's watchdog, so an abort actually unwinds the wait
             rather than merely rejecting the caller above it. */
          signal: () => currentJob()?.abort.signal,
          /* So a job waiting its turn to submit is visibly waiting rather than
             silent — see `onStep` in `./submission.ts`. */
          onStep: (step) => progress(step),
        }) as never,
      provingService: () => provingService,
      shielded: (cfg) =>
        snapshot
          ? ShieldedWallet(cfg).restore(snapshot.shielded)
          : ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (cfg) =>
        snapshot
          ? UnshieldedWallet(cfg).restore(snapshot.unshielded)
          : UnshieldedWallet(cfg).startWithPublicKey(publicKey),
      dust: (cfg) =>
        /* An EMPTY `dust` field is the cold-start request above, and it is a
           different thing from no snapshot at all: the other two wallets still
           resume. */
        snapshot && snapshot.dust
          ? DustWallet(cfg).restore(snapshot.dust)
          : DustWallet(cfg).startWithSecretKey(
              dustSecretKey,
              ledger.LedgerParameters.initialParameters().dust,
            ),
    });

  await mkdir(config.stateDir, { recursive: true });
  let cached = await loadSnapshot(config, address);
  /* Consumed here, and deleted whether or not it changes anything: a marker
     that survived its own restart would cold-walk the DUST wallet on every
     start for ever. */
  let dustColdStart = false;
  try {
    await readFile(dustColdStartPath(config), 'utf8');
    dustColdStart = true;
    await rm(dustColdStartPath(config), { force: true });
  } catch {
    // No marker, which is the ordinary case.
  }
  if (dustColdStart && cached) {
    console.warn(
      '[dust] a DUST cold start was requested — resuming the shielded and unshielded wallets from the snapshot and walking the DUST from chain, which is the only thing that forgets a pending flag the ledger will not clear',
    );
    cached = { ...cached, dust: '' };
  }
  let facade: WalletFacade;
  let resumed = false;
  if (cached) {
    try {
      facade = await startFacade(cached);
      resumed = true;
      console.log(`[wallet] resumed sync from the snapshot saved at ${cached.savedAt}`);
    } catch (cause) {
      console.warn('[wallet] stored sync snapshot rejected; cold-starting', cause);
      facade = await startFacade(null);
    }
  } else {
    facade = await startFacade(null);
  }
  if (!resumed) console.log('[wallet] cold start — walking the chain from genesis');

  await facade.start(shieldedSecretKeys, dustSecretKey);

  const nightTokenType = ledger.nativeToken().raw;
  let closed = false;

  const currentState = (): Promise<FacadeState> =>
    Rx.firstValueFrom(facade.state().pipe(Rx.timeout({ first: 30_000 })));

  const progressOf = (state: FacadeState): SyncSnapshotProgress => {
    const shielded = state.shielded.progress;
    const unshielded = state.unshielded.progress;
    const dust = state.dust.progress;
    return {
      isSynced: state.isSynced,
      shielded: {
        applied: shielded.appliedIndex.toString(),
        highestRelevant: shielded.highestRelevantWalletIndex.toString(),
        highest: shielded.highestIndex.toString(),
        connected: shielded.isConnected,
        complete: shielded.isStrictlyComplete(),
      },
      unshielded: {
        /* The unshielded wallet counts TRANSACTIONS relevant to its address
           rather than ledger indices, so it has no separate "relevant" figure —
           every id it knows about is one of its own. */
        applied: unshielded.appliedId.toString(),
        highestRelevant: unshielded.highestTransactionId.toString(),
        highest: unshielded.highestTransactionId.toString(),
        connected: unshielded.isConnected,
        complete: unshielded.isStrictlyComplete(),
      },
      dust: {
        applied: dust.appliedIndex.toString(),
        highestRelevant: dust.highestRelevantWalletIndex.toString(),
        highest: dust.highestIndex.toString(),
        connected: dust.isConnected,
        complete: dust.isStrictlyComplete(),
      },
    };
  };

  /* Snapshot saves are serialised through this chain. Two of them can be asked
     for at once — the "first synced" subscription and `close()` land together
     on a short run — and concurrently they raced on one shared `.tmp` name:
     whichever renamed first left the other renaming a file that was no longer
     there (ENOENT, observed on the very first stagenet run). Serialising also
     means a save never reads a half-serialised wallet state. */
  let saveQueue: Promise<void> = Promise.resolve();

  const writeSnapshot = async (): Promise<void> => {
    if (closed) return;
    try {
      const [shielded, unshielded, dust] = await Promise.all([
        facade.shielded.serializeState(),
        facade.unshielded.serializeState(),
        facade.dust.serializeState(),
      ]);
      const snapshot: StoredSnapshot = {
        version: 1,
        networkId: config.networkId,
        unshieldedAddress: address,
        savedAt: new Date().toISOString(),
        shielded,
        unshielded,
        dust,
      };
      const path = snapshotPath(config);
      const temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify(snapshot), 'utf8');
      await rename(temp, path);
    } catch (cause) {
      // Losing the cache costs a longer sync next time and nothing else.
      console.warn('[wallet] unable to save the sync snapshot', cause);
    }
  };

  const saveSnapshot = (): Promise<void> => {
    const next = saveQueue.then(writeSnapshot, writeSnapshot);
    saveQueue = next.catch(() => undefined);
    return next;
  };

  const dustUtxoCountOf = (state: FacadeState): number => state.dust.availableCoins.length;
  const feeCapableCountOf = (state: FacadeState, minSpecks: bigint): number =>
    feeCapableCoinCount(state.dust.availableCoins, minSpecks);
  const pendingCountOf = (state: FacadeState): number => state.pending.all.length;

  // Refresh the snapshot every minute while synced, so a killed process resumes
  // from close to the tip rather than replaying 150k blocks.
  let sawSynced = false;
  const snapshotTimer = setInterval(() => {
    if (sawSynced) void saveSnapshot();
  }, 60_000);
  snapshotTimer.unref();
  const snapshotSubscription = facade.state().subscribe({
    next: (state) => {
      /* The lane count, refreshed from the same stream that changes it. Every
         spend and every block with dust activity comes through here, so a lane
         closes within a block of its coin being taken and reopens within a
         block of the change landing.

         FEE-CAPABLE coins, not coins. The whole point of a lane is "a job may
         start because there is a coin for it to spend", and a coin only pays
         for a contract call if it carries the fee ON ITS OWN — the SDK's
         selection is per coin. A spend's CHANGE is a DUST coin from the moment
         it lands and is not fee-capable for minutes afterwards, because its
         `generatedNow` starts near zero and grows against the NIGHT backing it.
         Counting it opened lanes that no job could use.

         Measured, on the deployed service on 2026/09/02 21:33: three DUST
         UTxOs, one of them fee-capable, `lanes: 3` — so the queue started the
         activation grant, the mUSD leg, AND the registration together, and the
         two that lost the coin race spent fifteen seconds balancing before
         failing and then waited 22 s and 45 s for a coin. Sixty-seven seconds
         of a 157-second registration, on the click a user is watching, spent
         losing races the queue should never have started. */
      freeDustCoins = feeCapableCoinCount(state.dust.availableCoins, FEE_CAPABLE_SPECKS);
      if (state.isSynced && !sawSynced) {
        sawSynced = true;
        void saveSnapshot();
      } else if (!state.isSynced) {
        sawSynced = false;
      }
    },
    error: () => undefined,
  });

  /* Who holds this wallet, and for which PHASE — see `./reservation.ts`.
     Balancing, signing, submitting, and reverting CLAIM the wallet's coin
     state; proving claims nothing, because by the time a recipe reaches the
     prover the SDK has already committed its inputs as spent. The claim is what
     `/wallet-status` publishes as `available`; the queue is only a running
     order. Holding the two apart is the difference between a fee sponsor that
     is busy for a second and one that reads as absent for two minutes. */
  /* How many FEE-CAPABLE DUST coins this wallet can start a job against right
     now — see the subscription above for why the qualifier is load-bearing.
     Cached rather than read per drain: `drain` is synchronous and the state read
     is not, and a lane count that is a few hundred milliseconds stale is exactly
     as safe as one that is current — the fee estimate inside the job is what
     actually finds out whether a coin was free, and it now fails fast when one
     was not. Refreshed on every state event, which on stagenet is every block
     with dust activity. */
  let freeDustCoins = 0;

  const reservation = createWalletReservation({
    /* The ceiling is configuration; the floor is the chain. A job may start
       only when there is a coin for it to spend, so lanes close as coins are
       taken and reopen as change lands. */
    lanes: () => spendLaneCount(freeDustCoins, config.spendLanes),
    /* The watchdog that gives a silent job's lane back. It fires only while
       nothing of ours is at the prover — see `./proving.ts` — because a job
       that is proving legitimately reports no step for minutes. */
    stallMs: config.jobStallMs,
    maxMs: config.jobMaxMs,
    proverIdle,
    onSlowClaim: (label, heldMs) =>
      console.log(
        `[claim] ${label} held this wallet for ${(heldMs / 1_000).toFixed(1)} s — /wallet-status answered available: 0 for that long`,
      ),
  });
  const { exclusive, reserve, hold } = reservation;

  /* Every transaction this wallet has balanced and handed away, until the chain
     has been seen carrying it or `config.balanceOrphanMs` has passed without
     it. See `createOrphanWatch` for what that window is protecting against. */
  const orphans = createOrphanWatch({
    orphanMs: config.balanceOrphanMs,
    landed: (identifier) => transactionLanded(config.indexerHttpUrl, identifier),
    revert: async (entry) => {
      await reserve(
        () => facade.revert(entry.finalized as ledger.FinalizedTransaction),
        'orphaned fee-leg release',
      );
      /* The sweeper's revert is the one most likely to be a no-op: by the time
         it fires, `balanceOrphanMs` of event batches have gone past and the
         SDK's `pendingDust` list was emptied by the first of them. On
         2026/09/02 at 15:51:16 it logged 'released the DUST booked for 693ab0…'
         and restored nothing at all. */
      await noticeWedgeAfterRevert();
    },
  });

  const lastSpendAt = hooks.lastSpendAt ?? (() => 0);
  const settleWindowMs = hooks.settleWindowMs ?? 300_000;
  /* A shortfall READ INSIDE this window is a wallet mid-recovery, not an empty
     one: a spend consumes its whole DUST UTxO and the replacement arrives a
     block or two later, and an outstanding balancing has the same shape until
     the sweeper rules on it. `/fund-account` already waits this out; until now
     `/balance-only` answered 503 instantly and the client gave up on us. */
  const isSettling = (): boolean =>
    balancerIsSettling({
      now: Date.now(),
      lastSpendAt: lastSpendAt(),
      settleWindowMs,
      orphans: orphans.size,
    });

  const onDustWedged = hooks.onDustWedged ?? ((): void => undefined);

  /**
   * Read the live state and ask whether the wedge signature is present.
   *
   * Deliberately swallows a state that cannot be read: this runs on the failure
   * path of a revert, and a wallet that will not answer is a different fault
   * with its own verdict in `./health.ts`. Announcing a wedge on no evidence
   * would be the worst of the two mistakes available here.
   */
  const readDustWedged = async (state?: FacadeState): Promise<boolean> => {
    try {
      const current = state ?? (await currentState());
      return isDustWedged({
        synced: current.isSynced,
        nightAtomic: current.unshielded.balances[nightTokenType] ?? 0n,
        dustUtxoCount: dustUtxoCountOf(current),
        pendingTransactions: pendingCountOf(current),
        orphans: orphans.size,
        reserved: reservation.isReserved(),
        busy: reservation.isBusy(),
        now: Date.now(),
        lastSpendAt: lastSpendAt(),
        orphanMs: config.balanceOrphanMs,
      });
    } catch {
      return false;
    }
  };

  /**
   * Called after every revert of a transaction that spent DUST.
   *
   * The revert is the SDK's only route back from a spend, and after the first
   * replayed event batch it is a no-op — see `./dustRollback.ts`. So the check
   * belongs here, where the failure has just happened, rather than at whatever
   * the health loop's next tick happens to be.
   */
  const noticeWedgeAfterRevert = async (): Promise<void> => {
    if (await readDustWedged()) {
      console.warn(
        '[dust] the revert gave nothing back and this wallet now holds NIGHT with no spendable DUST, nothing pending, and nothing outstanding — the ledger is holding its coins behind an expired grace period',
      );
      onDustWedged();
    }
  };

  /**
   * Polls for a free DUST coin, from OUTSIDE the spend queue.
   *
   * A second is the cadence rather than the ten this replaced: the thing being
   * waited for is a block landing and an event batch replaying, both of which
   * are seconds, and the caller is holding nothing while it waits.
   */
  const awaitFreeDustCoin = async (
    maxMs: number,
    options: { minSpecks?: bigint } = {},
  ): Promise<boolean> => {
    const minSpecks = options.minSpecks ?? 0n;
    const deadline = Date.now() + Math.max(0, maxMs);
    let announced = false;
    for (;;) {
      try {
        const state = await currentState();
        const free =
          minSpecks > 0n ? feeCapableCountOf(state, minSpecks) : dustUtxoCountOf(state);
        if (free > 0) return true;
        if (!announced) {
          announced = true;
          console.log(
            `[dust] no ${minSpecks > 0n ? 'fee-capable ' : ''}DUST coin is free — waiting up to ${Math.round(maxMs / 1_000)} s outside the spend queue`,
          );
        }
      } catch {
        // An unreadable state is not a free coin; asked again below.
      }
      if (Date.now() >= deadline) return false;
      await new Promise((settle) => setTimeout(settle, Math.min(1_000, deadline - Date.now() + 1)));
    }
  };

  /* Six seconds — a block — so a rejected transaction's DUST is back within one
     sweep of the window closing rather than at the next health tick. */
  const orphanTimer = setInterval(() => {
    if (!closed) void orphans.sweep();
  }, 6_000);
  orphanTimer.unref();

  const dustBalance = async (state?: FacadeState): Promise<bigint> =>
    (state ?? (await currentState())).dust.balance(new Date());

  /** Every NIGHT UTxO this wallet holds that is not yet generating DUST. */
  const unregisteredNightUtxos = (state: FacadeState): UtxoWithMeta[] =>
    (state.unshielded.availableCoins ?? []).filter(
      (coin) =>
        coin.utxo.type === nightTokenType && coin.meta.registeredForDustGeneration === false,
    ) as UtxoWithMeta[];

  let provingReadiness: ProvingReadiness = provingServerUrl
    ? { state: 'server', url: provingServerUrl }
    : { state: 'warming' };
  let warmInFlight: Promise<ProvingReadiness> | null = null;

  const warmProvingKeys = (): Promise<ProvingReadiness> => {
    /* Nothing to warm when an external prover holds the keys, and nothing to
       redo once they are in memory. */
    if (provingMode === 'server' || provingReadiness.state === 'ready') {
      return Promise.resolve(provingReadiness);
    }
    if (warmInFlight) return warmInFlight;
    const startedAt = Date.now();
    warmInFlight = (async () => {
      try {
        let bytes = 0;
        const ks = new Set<number>();
        for (const location of PROVING_KEY_LOCATIONS) {
          const material = await keyMaterialProvider.lookupKey(location);
          if (!material) throw new Error(`no key material published for ${location}`);
          bytes += material.proverKey.length + material.verifierKey.length + material.ir.length;
          /* The IR names the circuit's size, and the BLS parameters are fetched
             per size. Reading it here means the parameters are cached too, so a
             first `/balance-only` is not also a multi-megabyte download. */
          ks.add(Zkir.deserialize(material.ir).getK());
        }
        for (const k of ks) {
          bytes += (await keyMaterialProvider.getParams(k)).length;
        }
        provingReadiness = { state: 'ready', warmedInMs: Date.now() - startedAt, bytes };
      } catch (cause) {
        provingReadiness = {
          state: 'failed',
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      } finally {
        warmInFlight = null;
      }
      return provingReadiness;
    })();
    return warmInFlight;
  };

  return {
    address,
    provingMode,

    provingReadiness: () => provingReadiness,
    warmProvingKeys,

    currentState,

    async progress(state?: FacadeState): Promise<SyncSnapshotProgress> {
      return progressOf(state ?? (await currentState()));
    },

    async waitForSync(onTick?: (progress: SyncSnapshotProgress) => void): Promise<void> {
      const ticker = onTick
        ? setInterval(() => {
            void currentState()
              .then((state) => onTick(progressOf(state)))
              .catch(() => undefined);
          }, 5_000)
        : null;
      try {
        /* Bounded, because a wedged indexer socket produces no state events at
           all and this wait is on the service's start path: without a ceiling a
           dead socket is a service that never finishes starting and never says
           why. The caller logs the stall and lets the health loop's existing
           rewarm remedy act — this is a report, not a repair. */
        await Rx.firstValueFrom(
          facade.state().pipe(
            Rx.filter((state) => state.isSynced),
            Rx.timeout({
              each: config.syncStallMs,
              with: () => Rx.throwError(() => new SyncStalled(config.syncStallMs)),
            }),
          ),
        );
      } finally {
        if (ticker) clearInterval(ticker);
      }
    },

    async nightBalance(state?: FacadeState): Promise<bigint> {
      const current = state ?? (await currentState());
      return current.unshielded.balances[nightTokenType] ?? 0n;
    },

    dustBalance,

    async dustUtxoCount(state?: FacadeState): Promise<number> {
      return dustUtxoCountOf(state ?? (await currentState()));
    },

    async pendingTransactionCount(state?: FacadeState): Promise<number> {
      return pendingCountOf(state ?? (await currentState()));
    },

    dustWedged: readDustWedged,

    awaitFreeDustCoin,

    jobCount: () => reservation.counts().jobs,
    runningJobs: () => reservation.counts().running,
    spendLanes: () => reservation.lanes(),

    async shieldedBalance(tokenType: string, state?: FacadeState): Promise<bigint> {
      const current = state ?? (await currentState());
      return current.shielded.balances[tokenType] ?? 0n;
    },

    async availableShieldedCoins(tokenType: string, state?: FacadeState): Promise<ShieldedCoin[]> {
      const current = state ?? (await currentState());
      return current.shielded.availableCoins
        .filter((entry) => String(entry.coin.type) === tokenType)
        .map((entry) => ({
          nonce: String(entry.coin.nonce),
          type: String(entry.coin.type),
          value: entry.coin.value,
        }));
    },

    async shieldedCoinPublicKeyBytes(): Promise<Uint8Array> {
      /* Taken from the wallet's own address rather than from
         `shieldedSecretKeys.coinPublicKey`, which is the ledger's string form:
         the circuit argument is 32 raw bytes, and the address object is where
         those bytes already are. This is the same read the shielded-receipt
         drill minted against. */
      const shieldedAddress = await facade.shielded.getAddress();
      return new Uint8Array(shieldedAddress.coinPublicKey.data);
    },

    async registerDustIfNeeded(): Promise<
      'registered' | 'already-generating' | 'no-night' | 'waiting-for-dust'
    > {
      const state = await currentState();
      const unregistered = unregisteredNightUtxos(state);
      if (unregistered.length === 0) {
        if ((state.unshielded.balances[nightTokenType] ?? 0n) === 0n) return 'no-night';
        return 'already-generating';
      }

      /* ledger-9 makes the registration pay its own fee out of the DUST the
         registered UTxOs are ALREADY projected to have generated — there is no
         other DUST on a fresh wallet to pay it with. So the fee has to be
         estimated first, and the transaction cannot be built until the
         projection covers it. On a freshly fauceted wallet that is a wait of
         minutes, not a failure, so it gets its own return value. */
      const { fee } = await facade.estimateRegistration(unregistered);
      try {
        await facade.waitForGeneratedDust(unregistered, fee, { timeoutMs: 60_000 });
      } catch {
        console.log(
          `[dust] the registration fee is ${fee} Specks and the registered NIGHT has not generated that much yet — will retry`,
        );
        return 'waiting-for-dust';
      }

      const recipe = await facade.registerNightUtxosForDustGeneration(
        unregistered,
        unshieldedKeystore.getPublicKey(),
        unshieldedKeystore.signDataAsync,
      );
      const finalized = await facade.finalizeRecipe(recipe);
      await facade.submitTransaction(finalized);
      console.log(
        `[dust] registered ${unregistered.length} NIGHT UTxO(s) for DUST generation (tx ${String(finalized.transactionHash())})`,
      );
      return 'registered';
    },

    isReserved: reservation.isReserved,
    isBusy: reservation.isBusy,
    isSettling,

    async abandonBalance(txHash: string): Promise<boolean> {
      const released = await orphans.abandon(txHash);
      /* A caller telling us its submit failed is the EARLIEST this service can
         learn a balancing is dead, and therefore the best chance a revert has
         of still finding its own booking in the SDK's list. When it does not —
         the six-second event window has usually closed — this is where the
         wedge becomes visible. */
      if (released) await noticeWedgeAfterRevert();
      return released;
    },
    orphanStats: () => ({ watching: orphans.size, released: orphans.released }),

    exclusive,
    hold,

    contractWalletProvider(options: ContractWalletProviderOptions = {}): ContractWalletProvider {
      const waitForDustMs = options.waitForDustMs ?? 0;
      return {
        getCoinPublicKey: () => shieldedSecretKeys.coinPublicKey,
        getEncryptionPublicKey: () => shieldedSecretKeys.encryptionPublicKey,

        async balanceTx(tx: unknown, ttl?: Date): Promise<unknown> {
          const deadline = ttl ?? new Date(Date.now() + config.balanceTtlMs);

          /* Under ledger-9 the fee is DUST, and DUST accrues per block. A wallet
             a few Specks short is not broken, it is early — so the fee is
             estimated first and the estimate is retried rather than turned into
             a failed registration. `deploy-stagenet` needed exactly this to get
             its TLD on chain. */
          /* THE BUDGET IS THE CALLER'S, AND IT IS ZERO BY DEFAULT. This loop
             runs inside a spend job, so every second it waits is a second every
             other registration and grant waits behind it. The old unconditional
             ten minutes is what let the spare mint hold the queue from 15:49:03
             to 15:59:07 on 2026/09/02 with a queue depth of one. A caller that
             genuinely wants to wait for DUST waits with `awaitFreeDustCoin`
             before it ever enters the queue. */
          const startedAt = Date.now();
          for (;;) {
            try {
              /* Bounded — see {@link WalletCallTimeout}. This is one of the two
                 calls the job of 2026/09/03 01:45:29 vanished between. */
              await withDeadline(
                () => facade.estimateTransactionFee(tx as never, dustSecretKey, { ttl: deadline }),
                config.walletCallTimeoutMs,
                (waitedMs) => new WalletCallTimeout('estimating the fee', waitedMs),
              );
              break;
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              if (!/insufficient funds|could not balance dust/i.test(message)) throw cause;
              if (Date.now() - startedAt >= waitForDustMs) throw new DustUnavailable(message);
              console.log(`[contract] waiting for DUST (${message.slice(0, 80)})`);
              await new Promise((settle) =>
                setTimeout(settle, Math.min(10_000, waitForDustMs - (Date.now() - startedAt))),
              );
            }
          }

          let recipe: BalancingRecipe | null = null;
          try {
            /* `facade.validateTransaction` is NOT called here, and must not be.
               The beta SDK's validation service builds a BLANK ledger state
               (`LedgerState.blank(networkId)` with only the real parameters) and
               runs `wellFormed` against it, so any transaction that CALLS a
               deployed contract fails with
               `call to non-existant contract ContractAddress(…)` — measured on
               stagenet against a TLD that demonstrably existed, at block 157797.
               The check is sound for a self-contained transfer and structurally
               impossible for a contract call. */
            /* Bounded, and the step reported before it rather than only after:
               a job that goes quiet here now says in the journal WHICH call it
               is inside, which the eight-minute silence of 2026/09/03 did not.
               The other two calls of that trio are the fee estimate above and
               the signing below. */
            progress('balancing');
            const balanced = await reserve(
              () =>
                withDeadline(
                  () =>
                    facade.balanceUnboundTransaction(
                      tx as never,
                      { shieldedSecretKeys, dustSecretKey },
                      { ttl: deadline },
                    ),
                  config.walletCallTimeoutMs,
                  (waitedMs) => new WalletCallTimeout('balancing the transaction', waitedMs),
                ),
              'contract balancing',
            );
            recipe = balanced;
            progress('balanced');
            const signed = await reserve(
              () =>
                withDeadline(
                  () => facade.signRecipe(balanced, unshieldedKeystore.signDataAsync),
                  config.walletCallTimeoutMs,
                  (waitedMs) => new WalletCallTimeout('signing the recipe', waitedMs),
                ),
              'contract signing',
            );
            recipe = signed;
            /* Proving, and NOT under a claim. This is the long half of an mUSD
               grant — minutes, for a transaction carrying shielded legs — and it
               reads no wallet state: the coins it will spend were committed as
               spent by the balancing above, so a `/balance-only` arriving now
               selects different ones. Holding the claim through it is what made
               `/wallet-status` answer `available: 0` while a grant proved. */
            /* Bounded, and counted as a proof while it runs. The bound is the
               same ten minutes a contract proof gets: a dust proof that has not
               finished by then is not slow, and the lane it holds is one every
               registration behind it is waiting for. The catch below reverts
               the recipe, so a `ProofTimeout` gives the DUST back rather than
               leaving it booked against a proof nobody is waiting for. */
            const proved = await countingProof(() =>
              withDeadline(
                () => facade.finalizeRecipe(signed),
                CONTRACT_PROOF_TIMEOUT_MS,
                (waitedMs) => new ProofTimeout(waitedMs),
              ),
            );
            /* Named apart from the contract proof above it: a spend job proves
               twice, once for the circuit and once for the DUST fee leg, and a
               journal with two identical `proved` lines does not say which
               half is slow. */
            progress('fee leg proved');
            return proved;
          } catch (cause) {
            const toRevert = recipe;
            if (toRevert) {
              try {
                await reserve(() => facade.revert(toRevert));
              } catch {
                // Reserved coins are released on restart anyway.
              }
              await noticeWedgeAfterRevert();
            }
            throw cause;
          }
        },

        async submitTx(tx: unknown): Promise<string> {
          /* `facade.submitTransaction` is two steps welded together: it books
             the transaction as pending in this wallet's own state, and then it
             calls the submission service with `waitForStatus: 'Finalized'` —
             which does not return until the node has FINALISED the transaction.
             On stagenet that is 15 to 25 seconds, measured 2026/08/26, and only
             the first step touches the wallet.
             So the two are taken apart here, with the facade's own error path
             (revert the transaction if submission fails) preserved. Holding a
             claim across the finalisation wait refused every fee request for its
             duration, and refused it for a wallet that was doing nothing but
             waiting on somebody else's block. */
          const finalized = tx as ledger.FinalizedTransaction;
          await reserve(
            () => facade.pendingTransactionsService.addPendingTransaction(finalized),
            'contract submission booking',
          );
          const identifier = String(finalized.identifiers().at(-1));
          try {
            await facade.submissionService.submitTransaction(finalized, 'Finalized');
            progress('submitted');
          } catch (cause) {
            /* A submission this service STOPPED WAITING FOR is not a failed
               one. Both hangs of 2026/09/02 had their transaction in a block
               already — 291694 and 292118 — so reverting on a timeout would
               throw away DUST that the chain has genuinely spent and rebuild a
               transaction that has genuinely landed. The indexer is asked
               first, and only an answer of "not there" is treated as failure. */
            if (isSubmissionTimeout(cause)) {
              const seen = await queryTransactionByIdentifier(config.indexerHttpUrl, identifier);
              if (seen.landed) {
                console.log(
                  `[job] the node never acknowledged ${identifier}, but it is on chain in block ${seen.block ?? '?'} — carrying on`,
                );
                progress('submitted');
                return identifier;
              }
              /* Not on chain YET, and possibly on its way: the bytes were handed
                 to the node before this service gave up on the answer. Reverting
                 now would double-spend the DUST if it lands a second later, so
                 the booking is handed to the orphan sweeper, which reverts it in
                 `balanceOrphanMs` if the chain never carries it. */
              console.log(
                `[job] the node never acknowledged ${identifier} and it is not on chain — watching it as an orphan and rebuilding`,
              );
              orphans.watch({
                txHash: String(finalized.transactionHash()),
                identifier,
                finalized,
                balancedAt: Date.now(),
              });
              throw cause;
            }
            try {
              await reserve(() => facade.revert(finalized));
            } catch {
              // Best effort — the original submission failure is the real news.
            }
            /* The node-rejection path, and the one the two wedges of
               2026/09/02 came down. When the revert lands within the SDK's
               six-second event window it works and this finds nothing; when it
               does not, this is where the service learns it has lost its own
               DUST rather than an hour later. */
            await noticeWedgeAfterRevert();
            throw cause;
          }
          return identifier;
        },
      };
    },

    async balanceOnly(transactionBytes: Uint8Array): Promise<BalanceOnlyResult> {
      if (closed) {
        throw new BalanceRefusal(503, 'WALLETS_UNAVAILABLE', 'The balancer wallet is closed.');
      }
      /* A claim on the wallet's coin state is outstanding — somebody is
         selecting, signing, or submitting coins this instant. That is seconds,
         not minutes, and `sponsor.ts` retries a 429 PENDING_TRANSACTION inside a
         20-second window, so coming back shortly is the right answer. A job that
         is merely PROVING is not a reason to refuse: it holds nothing. */
      if (reservation.isReserved()) {
        throw new BalanceRefusal(
          429,
          'PENDING_TRANSACTION',
          'This balancer wallet already has a transaction pending. Try again shortly.',
          { retryAfterMs: 2_000 },
        );
      }

      /* Deserialise BEFORE claiming the queue: a malformed body is the caller's
         mistake and must not lock anybody else out. The three markers say what
         kind of transaction is on the wire — a FINALIZED one, which is what a
         caller sends after it has signed and proved locally. */
      let incoming: ledger.FinalizedTransaction;
      try {
        incoming = ledger.Transaction.deserialize<
          ledger.SignatureEnabled,
          ledger.Proof,
          ledger.Binding
        >('signature', 'proof', 'binding', transactionBytes);
      } catch (cause) {
        throw new BalanceRefusal(
          400,
          'INVALID_TRANSACTION',
          'The request body is not a serialised finalized Midnight transaction.',
          { cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }

      /* A shortfall inside the settle window is the same event `/fund-account`
         waits up to five minutes for, and answering it 503 is what made the
         client fall through to the upstream gateway mid-send on 2026/09/02 —
         where its second leg was proved against a state the first leg had
         already moved, and never landed. So the two conditions below are
         reported as a 429 the client's existing PENDING_TRANSACTION retry waits
         out, and stay 503 only for a wallet that is genuinely empty or
         genuinely unsynced with nothing in flight to explain it. */
      const settling = isSettling();
      const refuseShortfall = (code: string, message: string): never => {
        throw shortfallRefusal(code, message, settling);
      };

      const state = await currentState();
      if (!state.isSynced) {
        refuseShortfall(
          'WALLET_SYNCING',
          'The balancer wallet is still syncing and cannot balance a transaction yet.',
        );
      }
      if ((await dustBalance(state)) <= 0n) {
        refuseShortfall(
          'INSUFFICIENT_DUST',
          'The balancer holds no spendable DUST, so it cannot pay this transaction’s fee.',
        );
      }

      /* Resolves instantly once warm, and a start-up preflight has normally
         warmed it already; this is the belt-and-braces path for a service whose
         first request beats its own preflight. */
      const proving = await warmProvingKeys();
      if (proving.state === 'failed') {
        throw new BalanceRefusal(
          503,
          'PROVER_UNAVAILABLE',
          'The balancer cannot prove a DUST fee leg: its proving key material could not be loaded.',
          { cause: proving.reason },
        );
      }

      const ttl = new Date(Date.now() + config.balanceTtlMs);
      let recipe: BalancingRecipe | null = null;
      try {
        /* `facade.validateTransaction` is deliberately NOT run on the incoming
           transaction — the same finding the registration path records above:
           the beta SDK validates against a BLANK ledger state, so any
           transaction that CALLS a deployed contract fails with `call to
           non-existant contract`. Transfers and deploys passed it, which is why
           this only surfaced on the first account withdrawal from the live app
           (2026/08/25: withdraw_night, refused as BALANCE_FAILED). The ledger's
           own deserialisation above is the structural guard; the node is the
           judge of validity, and it rejects what it rejects with a real reason. */

        /* DUST and nothing else. The caller balanced its own shielded and
           unshielded legs before it asked (`BALANCE_WITHOUT_DUST` in
           `sponsor.ts`); adding to those here would spend the balancer's NIGHT
           on somebody else's transfer. */
        const reserved = await reserve(
          () =>
            facade.balanceFinalizedTransaction(
              incoming,
              { shieldedSecretKeys, dustSecretKey },
              { ttl, tokenKindsToBalance: ['dust'] },
            ),
          'fee-leg balancing',
        );
        recipe = reserved;

        /* A DUST-only balancing leg has no signable segment, so this signs
           nothing today. It stays in the pipeline because it is the step that
           would sign one if a future balancing leg ever carried an unshielded
           input, and a silently missing signature is a node rejection with no
           useful error. */
        const signed = await reserve(
          () => facade.signRecipe(reserved, unshieldedKeystore.signDataAsync),
          'fee-leg signing',
        );
        recipe = signed;

        /* Proving happens here — the WASM prover or the configured server —
           and outside the claim, for the reason `./reservation.ts` gives: the
           DUST this leg spends is already booked as spent, so another caller's
           balancing in this window picks a different coin. */
        const balanced = await facade.finalizeRecipe(signed);

        /* `finalizeRecipe` books the merged transaction as pending so the
           wallet does not double-spend its DUST while it is in flight. The
           balancer never submits it, though: the caller does — and if that
           submit never happens the booking would stand for the whole TTL. So
           the booking is watched, and the sweeper takes the DUST back when the
           chain has not seen this transaction `balanceOrphanMs` from now. */
        const txHash = String(balanced.transactionHash());
        orphans.watch({
          txHash,
          identifier: String(balanced.identifiers().at(-1)),
          finalized: balanced,
          balancedAt: Date.now(),
        });

        return {
          txHash,
          txBytes: Buffer.from(balanced.serialize()).toString('hex'),
          expiresAt: ttl.toISOString(),
        };
      } catch (cause) {
        const toRevert = recipe;
        if (toRevert) {
          try {
            await reserve(() => facade.revert(toRevert));
          } catch {
            // Best effort — reserved coins are released on restart anyway.
          }
          await noticeWedgeAfterRevert();
        }
        if (cause instanceof BalanceRefusal) throw cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new BalanceRefusal(
          502,
          'BALANCE_FAILED',
          'The balancer could not add a fee leg to this transaction.',
          { cause: message },
        );
      }
    },

    saveSnapshot,

    async close(): Promise<void> {
      if (closed) return;
      clearInterval(snapshotTimer);
      clearInterval(orphanTimer);
      snapshotSubscription.unsubscribe();
      await saveSnapshot();
      closed = true;
      await facade.stop();
    },
  };
}
