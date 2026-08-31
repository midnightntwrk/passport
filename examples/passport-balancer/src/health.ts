/**
 * The sponsor's own watchdog: a periodic verdict on whether this wallet is
 * still able to sponsor, and an escalating set of remedies when it is not.
 *
 * WHY THIS IS MOSTLY ABOUT *NOT* ACTING
 * -------------------------------------
 * The balancer holds ONE large NIGHT UTxO. Every fee-bearing submission
 * nullifies the DUST it spends, and the replacement UTxO only appears when that
 * transaction lands — so for 20 to 60 seconds after a sponsorship the wallet
 * genuinely reads `available: 0, utxoCount: 0`. It is also documented (README,
 * and `CHANGE_SETTLE_MS` in `./server.ts`) that a spend puts the wallet through
 * a "syncing" flap of up to about two minutes, because the SDK scores being one
 * event AHEAD of the stream the same as being behind.
 *
 * Both of those are the service working. A watchdog that reopened the wallet or
 * restarted the process on either of them would take a healthy sponsor down
 * every time somebody onboarded — which is a worse outage than the one it was
 * written to fix. So the classifier's first job is to recognise the two states
 * in which doing nothing is correct:
 *
 *   - `busy`     — `isReserved()` or `isBusy()`. Somebody is mid-spend. A
 *                  grant's shielded proof runs about two minutes in-process,
 *                  and a contract call holds a claim on coin state for part of
 *                  it. NOTHING may run here. This is the "locked while in use"
 *                  the service owner asked for.
 *   - `settling` — no DUST, but a sponsorship landed inside the settle window,
 *                  or the process has not been up long enough to have finished
 *                  its first chain walk and DUST registration. Expected;
 *                  self-healing; intervening would be the bug.
 *
 * and only then the two in which it is not:
 *
 *   - `degraded` — the wallet can still be read, but it is not doing its job:
 *                  unsynced with nothing in flight, an indexer subscription
 *                  dropped ("RPC-CORE: disconnected … Normal Closure"), the
 *                  prover's key material never loaded, or `available: 0` long
 *                  after anything could still be settling.
 *   - `wedged`   — the wallet facade will not answer at all: `currentState()`
 *                  threw or timed out on consecutive ticks. Nothing in this
 *                  process can talk to the wallet, so nothing in this process
 *                  can repair it; the only remedy left is a restart.
 *
 * A NOTE ON THE FIFTH FAILURE, WHICH IS NOT IN HERE
 * ------------------------------------------------
 * A process that is alive but no longer answering HTTP cannot be detected from
 * inside itself — the loop that would notice is in the same event loop that is
 * not running. That case belongs to the external leg,
 * `passport-balancer-watchdog.timer` on the droplet, which curls
 * `/wallet-status` from outside and restarts the unit. The verdict named
 * `wedged` here is the narrower thing this process CAN see: a facade that has
 * stopped answering while the HTTP server still does.
 *
 * WHAT THE REMEDIES ACTUALLY CALL, AND WHAT THE SDK WILL NOT LET US DO
 * -------------------------------------------------------------------
 * Three rungs, cheapest first, each rate-limited:
 *
 *   1. `refresh`  — `wallet.currentState()` and `wallet.progress()`. A fresh
 *                   read off the facade's state observable (which carries a
 *                   30-second timeout of its own). It fixes nothing by itself;
 *                   it is how a transient is distinguished from a fault, and it
 *                   costs nothing.
 *   2. `rewarm`   — `wallet.warmProvingKeys()` and `wallet.saveSnapshot()`.
 *                   The first is a real repair, not a probe: `warmProvingKeys`
 *                   re-attempts the fetch whenever readiness is `warming` or
 *                   `failed` (it short-circuits only on `ready` and `server`),
 *                   so a start-up in which the 31 MiB of circuit key material
 *                   could not be fetched — which pins `/balance-only` on
 *                   `PROVER_UNAVAILABLE` for the life of the process — heals
 *                   here. The second checkpoints the sync state so that if the
 *                   next rung fires, the restarted process resumes near the tip
 *                   instead of walking the chain from genesis.
 *   3. `restart`  — checkpoint, then `process.exit(1)`; `Restart=always` on the
 *                   unit brings it back and `openBalancerWallet` re-establishes
 *                   the indexer subscriptions from the snapshot.
 *
 * There is deliberately NO "reopen the wallet in place" rung, and that is a
 * finding rather than an omission. `WalletFacade` does expose `start()` and
 * `stop()`, and the seed never leaves this process, so `stop()` then `start()`
 * looks like exactly the in-place reconnection this wants. It is not one:
 * `stop()` closes the submission service's Effect scope
 * (`submissionService.close()` → `Scope.close`) and `start()` does NOT reopen
 * it — it starts only the shielded, unshielded, and dust wallets and the
 * pending-transactions service. A facade restarted that way would sync happily
 * and then fail to submit anything, which is a worse fault than the one being
 * repaired and a silent one. So the escalation goes straight from `rewarm` to a
 * process restart, which is the only reopen the SDK actually supports.
 *
 * THE RESTART GATES, ALL OF WHICH MUST HOLD
 * -----------------------------------------
 *   - `isReserved()` and `isBusy()` are both false. A restart mid-spend would
 *     abandon a proof somebody is waiting on, and — worse — could drop a
 *     transaction between its balancing and its submission.
 *   - The cause is one a restart can plausibly fix (`restartEligible`). A
 *     prover whose key material will not download is not fixed by restarting
 *     into the same download, and a wallet whose sync indices have merely gone
 *     quiet is too soft a signal to bounce a live sponsor on.
 *   - At most once in any 30 minutes, and the clock is PERSISTED to the state
 *     directory. An in-memory limit would reset on the very event it is meant
 *     to bound, which is how restart loops are written by accident.
 *   - Never twice without an intervening healthy tick, likewise persisted.
 */

import type { ProvingState } from './availability.js';

/* -------------------------------------------------------------------------- */
/* The verdict                                                                */
/* -------------------------------------------------------------------------- */

export type HealthVerdict = 'healthy' | 'busy' | 'settling' | 'degraded' | 'wedged';

/**
 * Everything the verdict is allowed to look at — the same facts `walletStatus()`
 * already gathers, plus the loop's own bookkeeping. No I/O, no clock, no
 * wallet: `now` is passed in so a test can place a two-minute proof or a
 * forty-second settle wherever it likes.
 */
export interface HealthFacts {
  now: number;
  /** Milliseconds this process has been up, for the start-up grace. */
  uptimeMs: number;
  /**
   * False when the wallet could not be read at all — `currentState()` threw or
   * hit its 30-second timeout. This is the fact that separates "the wallet is
   * in a bad state" from "there is no longer a wallet answering".
   */
  stateReadable: boolean;
  /** `progress.isSynced` — the SDK's own strict verdict, not a guess. */
  synced: boolean;
  /**
   * Every one of the three sub-wallets reports its indexer subscription
   * connected. A synced wallet whose subscriptions have dropped is the
   * "RPC-CORE: disconnected … Normal Closure" failure, and it is invisible in
   * the balance alone.
   */
  connected: boolean;
  /** Spendable DUST, in Specks. Zero is the interesting value. */
  dustSpecks: bigint;
  /** How many DUST UTxOs back that balance. Zero and zero travel together. */
  utxoCount: number;
  proving: ProvingState;
  /** A CLAIM on the wallet's coin state — seconds. See `./reservation.ts`. */
  reserved: boolean;
  /** A whole spend job on the queue, proving included — minutes. */
  busy: boolean;
  /**
   * When this service last successfully sponsored anything — a balanced fee
   * leg, a registered name, a funded account. `null` when it has not sponsored
   * since it started, which is normal on a quiet morning and is why its absence
   * is never on its own a fault.
   */
  lastSponsorshipAt: number | null;
  /**
   * When the wallet's observed facts last changed — the sync indices, the
   * connection flags, the UTxO count. NOT the DUST balance, which is computed
   * against the current time and therefore moves even on a dead wallet.
   */
  lastStateChangeAt: number;
  /** Unhealthy ticks BEFORE this one, so the first bad tick sees zero. */
  consecutiveUnhealthy: number;
}

export interface HealthAssessment {
  verdict: HealthVerdict;
  /** One line, logged verbatim and published on `/status`. */
  reason: string;
  /** Only `degraded` and `wedged` act. */
  act: boolean;
  /**
   * Whether a process restart is a plausible repair for THIS cause. False for
   * causes a restart would either not fix (key material that will not download)
   * or should not be risked on (a soft staleness signal).
   */
  restartEligible: boolean;
}

export interface HealthPolicy {
  /**
   * How long after start-up an unsynced or DUST-less wallet is still merely
   * starting. A cold start walks the chain and then waits for the DUST
   * registration to cover its own fee out of projected generation, which is
   * minutes on a fresh wallet; treating that as a fault would restart the
   * service into the same wait forever.
   */
  startupGraceMs: number;
  /**
   * How long after a sponsorship a DUST-less, possibly unsynced wallet is
   * merely settling. The observed window is 20–60 seconds for the DUST
   * replacement and up to about two minutes for the post-spend syncing flap;
   * this is `CHANGE_SETTLE_MS`, the figure the service already refuses to
   * disbelieve a shortfall inside.
   */
  settleWindowMs: number;
  /**
   * How long the wallet's sync indices may stand still before it is reported as
   * stale. Soft, and never on its own a reason to restart.
   */
  stallMs: number;
  /** Consecutive unreadable ticks before the facade is called wedged. */
  wedgeTicks: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  startupGraceMs: 900_000,
  settleWindowMs: 300_000,
  stallMs: 1_800_000,
  wedgeTicks: 2,
};

const seconds = (ms: number): string => `${Math.round(ms / 1_000)} s`;
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

/**
 * The whole classifier. Pure: same facts in, same verdict out, no clock and no
 * chain, which is what lets `test/health.test.ts` place a forty-second settle
 * and a two-minute proof exactly where it wants them.
 *
 * The order of the branches IS the policy, and it is the safe order: the two
 * "do nothing" verdicts are decided before any of the "act" ones, so no
 * combination of facts can reach a remedy while a spend is in flight or while
 * the DUST is merely on its way back.
 */
export function assessHealth(
  facts: HealthFacts,
  policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
): HealthAssessment {
  const noDust = facts.dustSpecks <= 0n || facts.utxoCount <= 0;

  /* 1. In use. Decided first and unconditionally: whatever else is true, a
        wallet somebody is spending from is not a wallet to repair. */
  if (facts.reserved) {
    return {
      verdict: 'busy',
      reason: 'a claim on this wallet’s coin state is outstanding — balancing, signing, or submitting',
      act: false,
      restartEligible: false,
    };
  }
  if (facts.busy) {
    return {
      verdict: 'busy',
      reason: 'a spend job holds the queue — proving, most likely, which is minutes for a shielded leg',
      act: false,
      restartEligible: false,
    };
  }

  /* 2. Not answering at all. Ahead of the start-up grace, because a facade that
        cannot be read is not a facade that is still catching up — a syncing
        wallet answers `currentState()` perfectly well and simply reports
        `isSynced: false`. */
  if (!facts.stateReadable) {
    const ticks = facts.consecutiveUnhealthy + 1;
    if (ticks >= policy.wedgeTicks) {
      return {
        verdict: 'wedged',
        reason: `the wallet facade has not answered for ${ticks} consecutive checks — nothing in this process can reach it`,
        act: true,
        restartEligible: true,
      };
    }
    return {
      verdict: 'degraded',
      reason: 'the wallet state could not be read this tick',
      act: true,
      restartEligible: true,
    };
  }

  /* 3. Still starting. A cold start walks the chain and then waits for the DUST
        registration to be affordable; both are minutes and neither is a fault. */
  if (facts.uptimeMs < policy.startupGraceMs && (!facts.synced || noDust)) {
    return {
      verdict: 'settling',
      reason: `still starting up (${seconds(facts.uptimeMs)} in): ${facts.synced ? 'synced, DUST not yet accrued' : 'walking the chain'}`,
      act: false,
      restartEligible: false,
    };
  }

  /* 4. The DUST case, and the reason this whole module leans towards inaction.
        Deliberately NOT gated on `synced`: a spend puts the wallet through a
        syncing flap of up to about two minutes as well as nullifying its DUST,
        and both halves of that are the same expected event. */
  if (noDust && facts.lastSponsorshipAt !== null) {
    const since = facts.now - facts.lastSponsorshipAt;
    if (since < policy.settleWindowMs) {
      return {
        verdict: 'settling',
        reason: `sponsored ${seconds(since)} ago — the DUST it spent is nullified until that transaction lands, and the replacement comes with it`,
        act: false,
        restartEligible: false,
      };
    }
  }

  /* 5. Genuinely degraded, in the order the causes are worth reporting. */
  if (!facts.synced) {
    return {
      verdict: 'degraded',
      reason: `not synced, with nothing in flight and ${seconds(facts.uptimeMs)} of uptime`,
      act: true,
      restartEligible: true,
    };
  }
  if (!facts.connected) {
    return {
      verdict: 'degraded',
      reason: 'an indexer subscription has dropped — synced, but no longer following the chain',
      act: true,
      restartEligible: true,
    };
  }
  if (facts.proving === 'failed') {
    return {
      verdict: 'degraded',
      /* Not restart-eligible: the fix is to fetch the key material again, which
         `warmProvingKeys()` does in place. Restarting would re-attempt the same
         download from a cold cache and lose the sync position for nothing. */
      reason: 'the proving key material could not be loaded, so /balance-only refuses with PROVER_UNAVAILABLE',
      act: true,
      restartEligible: false,
    };
  }
  if (facts.proving === 'warming') {
    return {
      verdict: 'degraded',
      reason: `the prover has been warming for ${minutes(facts.uptimeMs)} — past the point where that is a cold start`,
      act: true,
      restartEligible: false,
    };
  }
  if (noDust) {
    return {
      verdict: 'degraded',
      reason: facts.lastSponsorshipAt === null
        ? 'no spendable DUST, and this service has sponsored nothing to explain it'
        : `no spendable DUST ${minutes(facts.now - facts.lastSponsorshipAt)} after the last sponsorship — too long to be change still settling`,
      act: true,
      restartEligible: true,
    };
  }
  if (facts.now - facts.lastStateChangeAt >= policy.stallMs) {
    return {
      verdict: 'degraded',
      /* Soft, and so never a reason to bounce a live sponsor by itself: a very
         quiet stagenet could in principle produce nothing this wallet considers
         relevant for half an hour. It earns a refresh and a re-warm, and if the
         cause is real one of the hard branches above will catch it too. */
      reason: `the wallet’s sync indices have not moved in ${minutes(facts.now - facts.lastStateChangeAt)}`,
      act: true,
      restartEligible: false,
    };
  }

  return {
    verdict: 'healthy',
    reason: `synced, connected, ${facts.utxoCount} DUST UTxO(s), able to prove`,
    act: false,
    restartEligible: false,
  };
}

/* -------------------------------------------------------------------------- */
/* The remedy ladder                                                          */
/* -------------------------------------------------------------------------- */

export type HealthRemedy = 'none' | 'refresh' | 'rewarm' | 'restart';

export interface RemedyPolicy {
  /** Unhealthy ticks, this one included, before the re-warm rung is reached. */
  rewarmAfterTicks: number;
  rewarmCooldownMs: number;
  /** Unhealthy ticks before a `degraded` cause may ask for a restart. */
  restartAfterTicks: number;
  /** The hard floor between two restart requests. Persisted, not in memory. */
  restartCooldownMs: number;
}

export const DEFAULT_REMEDY_POLICY: RemedyPolicy = {
  rewarmAfterTicks: 2,
  rewarmCooldownMs: 300_000,
  restartAfterTicks: 3,
  restartCooldownMs: 1_800_000,
};

/**
 * Restart bookkeeping that must SURVIVE the restart it bounds.
 *
 * Kept on disk in the state directory for one reason: a rate limit on restarts
 * that lives in the restarted process's memory is not a rate limit. Both fields
 * here are read before a restart is requested and written as part of requesting
 * it.
 */
export interface HealthRecord {
  /** Restart requests this service has made, ever, on this droplet. */
  restarts: number;
  lastRestartRequestAt: string | null;
  lastRestartReason: string | null;
  /**
   * True from the moment a restart is requested until a healthy tick is seen.
   * This is what "never twice consecutively without an intervening healthy
   * tick" means once the tick in question is on the other side of a reboot.
   */
  awaitingHealthyTick: boolean;
}

export const EMPTY_HEALTH_RECORD: HealthRecord = {
  restarts: 0,
  lastRestartRequestAt: null,
  lastRestartReason: null,
  awaitingHealthyTick: false,
};

export interface RemedyState {
  lastRewarmAt: number | null;
  record: HealthRecord;
}

export interface RemedyChoice {
  remedy: HealthRemedy;
  /** Why this rung and not the next one — logged, so a decision is auditable. */
  reason: string;
}

/**
 * Which rung this tick has earned. Pure, for the same reason `assessHealth` is:
 * the rate limits are the part most worth testing and the part least pleasant
 * to test against a real clock.
 */
export function chooseRemedy(
  assessment: HealthAssessment,
  facts: HealthFacts,
  state: RemedyState,
  policy: RemedyPolicy = DEFAULT_REMEDY_POLICY,
): RemedyChoice {
  if (!assessment.act) return { remedy: 'none', reason: assessment.verdict };

  const ticks = facts.consecutiveUnhealthy + 1;

  /* A wedged facade needs no patience: by construction it has already failed
     `wedgeTicks` consecutive checks, and no in-process remedy can reach it. A
     merely degraded one waits out `restartAfterTicks` first. */
  const ticksForRestart = assessment.verdict === 'wedged' ? 0 : policy.restartAfterTicks;

  if (assessment.restartEligible && ticks >= ticksForRestart) {
    /* Re-checked here as well as in `assessHealth`, and not because the facts
       could have changed between the two — they cannot, it is one snapshot —
       but because this is the gate that must be impossible to reach past by
       adding a branch above. A restart while a spend is in flight is the one
       failure this whole module must never cause. */
    if (facts.reserved || facts.busy) {
      return { remedy: 'refresh', reason: 'a restart is warranted, but the wallet is in use' };
    }
    const last = state.record.lastRestartRequestAt
      ? Date.parse(state.record.lastRestartRequestAt)
      : null;
    if (last !== null && Number.isFinite(last) && facts.now - last < policy.restartCooldownMs) {
      const wait = policy.restartCooldownMs - (facts.now - last);
      return {
        remedy: 'refresh',
        reason: `a restart is warranted, but the last one was ${minutes(facts.now - last)} ago — ${minutes(wait)} of the cooldown left`,
      };
    }
    if (state.record.awaitingHealthyTick) {
      return {
        remedy: 'refresh',
        reason: 'a restart is warranted, but the previous restart has not yet been followed by a healthy tick',
      };
    }
    return {
      remedy: 'restart',
      reason: `${ticks} consecutive unhealthy checks, nothing in flight, and the restart cooldown has elapsed`,
    };
  }

  if (ticks >= policy.rewarmAfterTicks) {
    if (
      state.lastRewarmAt === null ||
      facts.now - state.lastRewarmAt >= policy.rewarmCooldownMs
    ) {
      return { remedy: 'rewarm', reason: `${ticks} consecutive unhealthy checks` };
    }
    return {
      remedy: 'refresh',
      reason: `a re-warm is warranted, but the last one was ${seconds(facts.now - state.lastRewarmAt)} ago`,
    };
  }

  return { remedy: 'refresh', reason: `unhealthy check ${ticks}` };
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What one tick reads — every fact except the three the loop itself owns: the
 * clock, the unhealthy streak, and when the state last changed.
 */
export type HealthProbeReading = Omit<
  HealthFacts,
  'now' | 'consecutiveUnhealthy' | 'lastStateChangeAt'
> & {
  /**
   * A cheap string over the facts that ought to move on a live chain — the sync
   * indices, the connection flags, the UTxO count. The loop compares it with
   * the previous tick's to maintain `lastStateChangeAt`, so the probe does not
   * have to remember anything.
   */
  fingerprint: string;
};

/** `./server.ts` supplies this from the live wallet. */
export type HealthProbe = () => Promise<HealthProbeReading>;

export interface HealthRemedies {
  /** Re-read the wallet's state. Rejects if it cannot. */
  refresh(): Promise<void>;
  /** Re-fetch the proving key material, and checkpoint the sync snapshot. */
  rewarm(): Promise<void>;
  /** Checkpoint, then leave with a non-zero status for systemd to notice. */
  restart(reason: string): Promise<void>;
}

export interface HealthRecordStore {
  read(): HealthRecord;
  write(record: HealthRecord): Promise<void>;
}

export interface HealthLoopOptions {
  intervalMs: number;
  probe: HealthProbe;
  remedies: HealthRemedies;
  store: HealthRecordStore;
  policy?: HealthPolicy;
  remedyPolicy?: RemedyPolicy;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => number;
  /** Injectable so a test gets a deterministic schedule. */
  random?: () => number;
}

/** What `GET /status` publishes as `health`. */
export interface HealthSnapshot {
  intervalMs: number;
  checks: number;
  lastCheckAt: string | null;
  verdict: HealthVerdict | null;
  reason: string | null;
  consecutiveUnhealthy: number;
  lastRemedy: {
    remedy: HealthRemedy;
    at: string;
    reason: string;
    outcome: 'ok' | 'failed';
    detail?: string;
  } | null;
  restartsRequestedSinceBoot: number;
  restartsRequestedTotal: number;
  lastRestartRequestAt: string | null;
  lastRestartReason: string | null;
  awaitingHealthyTick: boolean;
}

export interface HealthMonitor {
  /** For `/status`. Cheap; reads nothing. */
  snapshot(): HealthSnapshot;
  /** Runs one tick now, and resolves once it and any remedy have finished. */
  tick(): Promise<HealthAssessment | null>;
  stop(): void;
}

/**
 * How far either side of the interval a tick may land.
 *
 * Small on purpose. The point is not to spread load — one tick every ten
 * minutes is nothing — it is that this service already has a snapshot save and
 * a DUST registration retry on exact sixty-second boundaries, and a health
 * check that lands on the same second as one of them every time would be
 * reading the wallet mid-write for the life of the process.
 */
const JITTER_FRACTION = 0.05;

export function startHealthLoop(options: HealthLoopOptions): HealthMonitor {
  const policy = options.policy ?? DEFAULT_HEALTH_POLICY;
  const remedyPolicy = options.remedyPolicy ?? DEFAULT_REMEDY_POLICY;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));

  const bootedAt = now();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  /* One tick at a time, remedy included. A re-warm can take seconds and a
     checkpoint can take longer; a second tick landing on top of the first would
     double-count the unhealthy streak and could run two remedies at once. */
  let inFlight = false;

  let consecutiveUnhealthy = 0;
  let lastFingerprint: string | null = null;
  let lastStateChangeAt = bootedAt;
  let lastRewarmAt: number | null = null;
  let restartsSinceBoot = 0;

  const snapshot: HealthSnapshot = {
    intervalMs: options.intervalMs,
    checks: 0,
    lastCheckAt: null,
    verdict: null,
    reason: null,
    consecutiveUnhealthy: 0,
    lastRemedy: null,
    restartsRequestedSinceBoot: 0,
    restartsRequestedTotal: options.store.read().restarts,
    lastRestartRequestAt: options.store.read().lastRestartRequestAt,
    lastRestartReason: options.store.read().lastRestartReason,
    awaitingHealthyTick: options.store.read().awaitingHealthyTick,
  };

  const publishRecord = (record: HealthRecord): void => {
    snapshot.restartsRequestedTotal = record.restarts;
    snapshot.lastRestartRequestAt = record.lastRestartRequestAt;
    snapshot.lastRestartReason = record.lastRestartReason;
    snapshot.awaitingHealthyTick = record.awaitingHealthyTick;
  };

  const runTick = async (): Promise<HealthAssessment | null> => {
    if (inFlight || stopped) return null;
    inFlight = true;
    try {
      const at = now();
      let facts: HealthFacts;
      try {
        const reading = await options.probe();
        if (lastFingerprint !== null && reading.fingerprint !== lastFingerprint) {
          lastStateChangeAt = at;
        }
        lastFingerprint = reading.fingerprint;
        facts = { ...reading, now: at, lastStateChangeAt, consecutiveUnhealthy };
      } catch (cause) {
        /* The probe itself is written not to throw — it reports an unreadable
           wallet as `stateReadable: false`. If it throws anyway, that IS an
           unreadable wallet, and swallowing it would make the watchdog blind to
           exactly the failure it exists for. */
        warn(`[health] the probe failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        facts = {
          now: at,
          uptimeMs: at - bootedAt,
          stateReadable: false,
          synced: false,
          connected: false,
          dustSpecks: 0n,
          utxoCount: 0,
          proving: 'failed',
          reserved: false,
          busy: false,
          lastSponsorshipAt: null,
          lastStateChangeAt,
          consecutiveUnhealthy,
        };
      }

      const assessment = assessHealth(facts, policy);
      const unhealthy = assessment.verdict === 'degraded' || assessment.verdict === 'wedged';
      /* Only `healthy` clears the streak. `busy` and `settling` LEAVE IT ALONE:
         a wallet that was degraded and is now merely mid-spend has not been
         shown to be well, and zeroing the count there would let a fault that
         happens to coincide with traffic never escalate. */
      const previousStreak = consecutiveUnhealthy;
      if (assessment.verdict === 'healthy') consecutiveUnhealthy = 0;
      else if (unhealthy) consecutiveUnhealthy = previousStreak + 1;

      snapshot.checks += 1;
      snapshot.lastCheckAt = new Date(at).toISOString();
      snapshot.verdict = assessment.verdict;
      snapshot.reason = assessment.reason;
      snapshot.consecutiveUnhealthy = consecutiveUnhealthy;

      const record = options.store.read();
      if (assessment.verdict === 'healthy' && record.awaitingHealthyTick) {
        const cleared: HealthRecord = { ...record, awaitingHealthyTick: false };
        await options.store.write(cleared);
        publishRecord(cleared);
        log('[health] healthy again — the restart bar is lifted');
      }

      const choice = chooseRemedy(
        assessment,
        facts,
        { lastRewarmAt, record: options.store.read() },
        remedyPolicy,
      );

      const line = `[health] ${assessment.verdict}: ${assessment.reason}`;
      if (unhealthy) warn(`${line} — remedy: ${choice.remedy} (${choice.reason})`);
      else log(line);

      if (choice.remedy === 'none') return assessment;

      const startedAt = now();
      try {
        if (choice.remedy === 'refresh') {
          await options.remedies.refresh();
          log(`[health] refreshed the wallet state in ${seconds(now() - startedAt)}`);
        } else if (choice.remedy === 'rewarm') {
          await options.remedies.rewarm();
          lastRewarmAt = now();
          log(`[health] re-warmed the prover and checkpointed the wallet in ${seconds(now() - startedAt)}`);
        } else {
          const requested: HealthRecord = {
            restarts: record.restarts + 1,
            lastRestartRequestAt: new Date(startedAt).toISOString(),
            lastRestartReason: assessment.reason,
            awaitingHealthyTick: true,
          };
          /* Written BEFORE the exit, or the limit it enforces would not exist:
             a process that dies between deciding and recording has no memory of
             having decided. */
          await options.store.write(requested);
          publishRecord(requested);
          restartsSinceBoot += 1;
          snapshot.restartsRequestedSinceBoot = restartsSinceBoot;
          warn(
            `[health] REQUESTING A RESTART — ${assessment.reason}. This is restart request ${requested.restarts}; the next one cannot come for ${minutes(remedyPolicy.restartCooldownMs)}, and not until a healthy check has been seen.`,
          );
          await options.remedies.restart(assessment.reason);
        }
        snapshot.lastRemedy = {
          remedy: choice.remedy,
          at: new Date(startedAt).toISOString(),
          reason: choice.reason,
          outcome: 'ok',
        };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        warn(`[health] the ${choice.remedy} remedy failed: ${detail}`);
        snapshot.lastRemedy = {
          remedy: choice.remedy,
          at: new Date(startedAt).toISOString(),
          reason: choice.reason,
          outcome: 'failed',
          detail,
        };
      }

      return assessment;
    } finally {
      inFlight = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    const jitter = options.intervalMs * JITTER_FRACTION;
    const delay = Math.max(1_000, Math.round(options.intervalMs + (random() * 2 - 1) * jitter));
    timer = setTimeout(() => {
      void runTick()
        .catch((cause) => warn(`[health] the check failed: ${cause}`))
        .finally(schedule);
    }, delay);
    /* Unreferenced so the watchdog never becomes the reason this process will
       not exit — SIGTERM handling is `./server.ts`'s, and it saves a snapshot. */
    timer.unref();
  };

  schedule();

  return {
    snapshot: () => ({ ...snapshot }),
    tick: runTick,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
