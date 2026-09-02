/**
 * The shelf of pre-deployed resolver leaves, and the filler that keeps it
 * stocked out of the sponsor's idle minutes.
 *
 * WHAT A POOLED LEAF IS
 * ---------------------
 * A Midnames leaf is a contract whose `DOMAIN_TARGET` says where a name points
 * and whose `DOMAIN_OWNER` says who may change it. Registering a name is two
 * dependent proofs — deploy the leaf, then `register_domain_for` on the TLD —
 * and the first is the expensive one: 1.37e16 Specks against 8.5e14 for the
 * registration, and a block of waiting on top, all of it spent while somebody
 * is watching a screen.
 *
 * None of that deploy depends on the user. `DOMAIN` is sealed at construction,
 * but `DOMAIN_TARGET` is settable afterwards by `update_domain_target` and
 * `DOMAIN_OWNER` by `change_owner`, both gated on the caller's derived key
 * matching the leaf's current owner. So a leaf can be built ahead of time with
 * no domain, a zero target, and the SPONSOR's own key as owner, and bound to a
 * person later: `update_domain_target(account contract)` on the leaf and
 * `register_domain_for(user key, label, leaf)` on the TLD, which are
 * independent of each other and therefore run together, and then
 * `change_owner(user key, user address)` in the background once the name is
 * confirmed. Two concurrent proofs replace two dependent ones, and the deploy
 * has already happened.
 *
 * THE FILLER IS THE LOWEST-PRIORITY THING THIS SERVICE DOES
 * ---------------------------------------------------------
 * Every gate below exists to make one promise: a leaf deploy never costs a user
 * anything. It is not a priority on the spend queue — a priority still competes
 * — it is a set of preconditions that make the filler simply not ask. It
 * deploys ONE leaf at a time, at most one a minute, and only when the wallet is
 * healthy, unbooked, holding two fee-capable DUST coins so that spending one
 * leaves one free, proving nothing, and a full minute past the last request a
 * person made. Any of those failing is a PAUSE and not a fault: on today's
 * two-coin sponsor the filler sits at `paused` with the reason "one fee-capable
 * coin", and that is the system working.
 *
 * Nothing here holds the spend queue while it waits. The gate is evaluated, and
 * either a job is queued or the tick ends; a filler that queued a job and then
 * waited for a coin would be exactly the thing it is written not to be.
 */

import type { HealthVerdict } from './health.js';
import type { JsonLedger, ResolverEntry } from './ledgers.js';

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The DUST a leaf deploy has to be able to reach for.
 *
 * 1.5e16 Specks, which is the fee floor the sponsor's own measurements put
 * under a contract deploy: the leaf itself costs 1.37e16 and the floor carries
 * the margin. A coin below it is not a coin a deploy can be balanced against,
 * so counting coins rather than the total balance is the whole point — the
 * SDK's selection is per-coin, and 3e16 Specks spread over four small coins
 * pays for no deploy at all.
 */
export const FEE_CAPABLE_SPECKS = 15_000_000_000_000_000n;

/**
 * How many fee-capable coins must exist before the filler will spend one.
 *
 * Two, and the second one is the user's. A sponsor down to its last usable coin
 * that spends it on a leaf has taken fee sponsorship offline for a block to
 * stock a shelf, which inverts the whole priority. So the filler spends the
 * second coin and never the last.
 */
export const MIN_FEE_CAPABLE_COINS = 2;

/** How long the service must have been left alone before a leaf is deployed. */
export const QUIET_MS = 60_000;

/** The floor under the gap between two deploys. */
export const MIN_DEPLOY_INTERVAL_MS = 60_000;

/** How often the filler looks, when it is running. */
export const DEFAULT_POOL_INTERVAL_MS = 30_000;

export type ResolverPoolState = 'idle' | 'filling' | 'paused';

/** Everything the gate is allowed to look at. No clock, no I/O: see `now`. */
export interface ResolverPoolFacts {
  now: number;
  /** Unconsumed leaves on the shelf. */
  depth: number;
  target: number;
  floor: number;
  /** The health watchdog's last word, or `null` before its first tick. */
  verdict: HealthVerdict | null;
  /**
   * Anything on the spend queue at all — running, waiting, or holding a claim
   * on the wallet's coins. The reservation's own two counters collapsed into
   * one deliberately: the filler defers to a booked wallet AND to a queued one,
   * because a leaf deploy that slots in ahead of a waiting registration is the
   * failure this whole module is written to avoid.
   */
  reservationBooked: boolean;
  /** DUST coins whose value right now clears {@link FEE_CAPABLE_SPECKS}. */
  feeCapableCoins: number;
  /** A proof this service asked for is outstanding at the prover. */
  proofInFlight: boolean;
  /** When a person last asked this service for something. 0 for never. */
  lastRequestAt: number;
  /** When this filler last deployed a leaf. 0 for never. */
  lastDeployAt: number;
  /** A deploy started by an earlier tick has not finished. */
  deploying: boolean;
}

export interface ResolverPoolVerdict {
  state: ResolverPoolState;
  reason: string;
  /** True only when every gate passed and a leaf should be deployed now. */
  deploy: boolean;
}

/**
 * Should a leaf be deployed this instant, and if not, what is the honest
 * one-line reason?
 *
 * Pure, so every pause reason is a unit test rather than a stagenet afternoon.
 * The ORDER of the checks is the message the reason carries: the most
 * fundamental obstruction is reported first, so an operator reading "health is
 * dust-wedged" is not left wondering whether the coin count also mattered.
 */
export function assessResolverPool(facts: ResolverPoolFacts): ResolverPoolVerdict {
  if (facts.deploying) {
    return { state: 'filling', reason: 'a leaf is being deployed', deploy: false };
  }
  if (facts.target <= 0) {
    return { state: 'idle', reason: 'the pool is switched off', deploy: false };
  }
  if (facts.depth >= facts.target) {
    return {
      state: 'idle',
      reason: `the pool holds ${facts.depth} of ${facts.target} leaves`,
      deploy: false,
    };
  }
  if (facts.verdict !== 'healthy') {
    return {
      state: 'paused',
      reason: facts.verdict === null ? 'no health verdict yet' : `health is ${facts.verdict}`,
      deploy: false,
    };
  }
  if (facts.reservationBooked) {
    return { state: 'paused', reason: 'the wallet is booked', deploy: false };
  }
  if (facts.feeCapableCoins < MIN_FEE_CAPABLE_COINS) {
    return {
      state: 'paused',
      reason:
        facts.feeCapableCoins === 1 ? 'one fee-capable coin' : 'no fee-capable coin',
      deploy: false,
    };
  }
  if (facts.proofInFlight) {
    return { state: 'paused', reason: 'a proof is in flight', deploy: false };
  }
  if (facts.lastRequestAt > 0 && facts.now - facts.lastRequestAt < QUIET_MS) {
    return {
      state: 'paused',
      reason: `a request landed in the last ${QUIET_MS / 1_000} s`,
      deploy: false,
    };
  }
  if (facts.lastDeployAt > 0 && facts.now - facts.lastDeployAt < MIN_DEPLOY_INTERVAL_MS) {
    return {
      state: 'paused',
      reason: `a leaf was deployed in the last ${MIN_DEPLOY_INTERVAL_MS / 1_000} s`,
      deploy: false,
    };
  }
  return {
    state: 'filling',
    reason:
      facts.depth < facts.floor
        ? `below the floor of ${facts.floor}, filling to ${facts.target}`
        : `filling to ${facts.target}`,
    deploy: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Binding a leaf that already exists                                         */
/* -------------------------------------------------------------------------- */

/** A leaf off the shelf, as a registration is handed it. */
export interface PooledResolver {
  address: string;
  /** The indexer's ledger HASH for the deploy — already resolved, at deploy. */
  deployTx: string;
  /** The block it landed in, where the indexer knew one at the time. */
  deployBlock?: number | null;
}

/**
 * The deploy transaction a finished registration reports, resolved for a fresh
 * deploy and simply READ for a pooled one.
 *
 * The difference matters more than it looks. `resolveTransactionHash` maps a
 * midnight-js transaction IDENTIFIER to the indexer's ledger hash, and the
 * indexer's `transactions(offset: { identifier })` returns an empty list for
 * anything that is not an identifier. A pooled leaf's `deployTx` is ALREADY the
 * hash — the filler resolved it when it deployed the leaf, minutes or hours ago
 * — so passing it back through the lookup finds nothing and spends the full
 * retry budget, thirty seconds, at the very end of the request the pool exists
 * to make quick. So the pooled branch never asks.
 */
export async function deployTransactionReference(
  pooled: PooledResolver | undefined,
  identifier: string,
  lookup: (identifier: string) => Promise<{ hash: string; block: number | null }>,
): Promise<{ hash: string; block: number | null }> {
  if (pooled) return { hash: pooled.deployTx, block: pooled.deployBlock ?? null };
  return lookup(identifier);
}

/* -------------------------------------------------------------------------- */
/* The pool                                                                   */
/* -------------------------------------------------------------------------- */

/** What `/status` publishes as `resolverPool`. */
export interface ResolverPoolSnapshot {
  depth: number;
  target: number;
  floor: number;
  state: ResolverPoolState;
  reason: string;
  lastDeployAt: string | null;
}

/**
 * The ledger operations the pool needs, named rather than the whole
 * {@link JsonLedger}, so a test can stand one up without a state directory.
 */
export interface ResolverLedger {
  /** Unconsumed leaves. */
  depth(): number;
  /** The oldest unconsumed leaf, or `null` when the shelf is bare. */
  oldestFree(): { key: string; entry: ResolverEntry } | null;
  record(key: string, entry: ResolverEntry): Promise<void>;
}

/** Adapts the on-disk `resolvers-<network>.json` to {@link ResolverLedger}. */
export function resolverLedgerFrom(ledger: JsonLedger<ResolverEntry>): ResolverLedger {
  const free = (entry: ResolverEntry): boolean => entry.consumedAt === undefined;
  return {
    depth: () => ledger.countWhere(free),
    oldestFree: () => ledger.findWhere(free),
    record: (key, entry) => ledger.record(key, entry),
  };
}

export interface ResolverPoolOptions {
  ledger: ResolverLedger;
  target: number;
  floor: number;
  /** Everything the gate needs that this module cannot read for itself. */
  facts: () => Promise<
    Omit<ResolverPoolFacts, 'now' | 'depth' | 'target' | 'floor' | 'deploying' | 'lastDeployAt'>
  >;
  /** Deploys one unbound leaf. Called at most once at a time, once a minute. */
  deploy: () => Promise<{ address: string; deployTx: string; deployBlock?: number | null }>;
  intervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  warn?: (line: string, cause?: unknown) => void;
}

export interface ResolverPool {
  /** Cheap, reads nothing: the last tick's verdict and the ledger's depth. */
  snapshot(): ResolverPoolSnapshot;
  /**
   * Takes the oldest free leaf and marks it consumed BEFORE returning it, so a
   * second caller arriving mid-binding cannot be handed the same one. `null`
   * when the shelf is bare, which is the caller's cue to deploy its own.
   */
  take(consumedBy: string): Promise<ResolverEntry | null>;
  /** Runs one gate evaluation now, and any deploy it calls for. */
  tick(): Promise<ResolverPoolVerdict>;
  stop(): void;
}

export function startResolverPool(options: ResolverPoolOptions): ResolverPool {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string, cause?: unknown) => console.warn(line, cause));
  const intervalMs = options.intervalMs ?? DEFAULT_POOL_INTERVAL_MS;

  let deploying = false;
  let lastDeployAt = 0;
  let state: ResolverPoolState = 'idle';
  let reason = 'not looked yet';
  let stopped = false;

  const tick = async (): Promise<ResolverPoolVerdict> => {
    let verdict: ResolverPoolVerdict;
    try {
      const read = await options.facts();
      verdict = assessResolverPool({
        ...read,
        now: now(),
        depth: options.ledger.depth(),
        target: options.target,
        floor: options.floor,
        lastDeployAt,
        deploying,
      });
    } catch (cause) {
      /* A gate that cannot be read is a pause and never a deploy. The facts it
         failed on are the ones protecting a user's coin. */
      verdict = { state: 'paused', reason: 'the wallet could not be read', deploy: false };
      warn('[pool] the filler could not read the wallet, so it is not deploying', cause);
    }
    state = verdict.state;
    reason = verdict.reason;
    if (!verdict.deploy) return verdict;

    deploying = true;
    state = 'filling';
    try {
      const leaf = await options.deploy();
      lastDeployAt = now();
      await options.ledger.record(leaf.address, {
        address: leaf.address,
        deployTx: leaf.deployTx,
        deployedAt: new Date(lastDeployAt).toISOString(),
        /* Resolved once here, at a moment nobody is waiting, so that binding
           this leaf later never has to ask the indexer anything. */
        ...(leaf.deployBlock === undefined ? {} : { deployBlock: leaf.deployBlock }),
      });
      log(
        `[pool] deployed resolver leaf ${leaf.address} (${leaf.deployTx}); the shelf now holds ${options.ledger.depth()} of ${options.target}`,
      );
    } catch (cause) {
      /* Counted as a deploy for the purposes of the one-a-minute floor: a leaf
         that failed cost a proof and possibly a coin, and retrying it
         immediately is how a broken artefact turns into a spend loop. */
      lastDeployAt = now();
      warn('[pool] a resolver leaf deploy failed; the shelf is unchanged', cause);
    } finally {
      deploying = false;
    }
    return verdict;
  };

  const timer =
    options.target > 0 && intervalMs > 0
      ? setInterval(() => {
          if (stopped) return;
          void tick().catch((cause) => warn('[pool] the filler tick failed', cause));
        }, intervalMs)
      : null;
  timer?.unref();

  return {
    snapshot: () => ({
      depth: options.ledger.depth(),
      target: options.target,
      floor: options.floor,
      state,
      reason,
      lastDeployAt: lastDeployAt > 0 ? new Date(lastDeployAt).toISOString() : null,
    }),

    async take(consumedBy: string): Promise<ResolverEntry | null> {
      /* No await between the read and the write, so two takes in one tick
         cannot both see the same leaf free: `record` commits to the in-memory
         map before it touches the disk. */
      const found = options.ledger.oldestFree();
      if (!found) return null;
      const consumed: ResolverEntry = {
        ...found.entry,
        consumedBy,
        consumedAt: new Date(now()).toISOString(),
      };
      const written = options.ledger.record(found.key, consumed);
      await written;
      return consumed;
    },

    tick,

    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
