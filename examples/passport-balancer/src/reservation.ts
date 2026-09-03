/**
 * Who is holding the balancer's single wallet, and for WHICH PHASE of a job.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO DRAW
 * ------------------------------------------
 * A spend — a fee leg, a `.night` registration, an activation grant — is not one
 * indivisible act. It has three phases, and only two of them touch the wallet:
 *
 *   1. **Balancing.** The SDK picks the coins, and — this is the load-bearing
 *      fact — commits the picked-over state atomically before it returns.
 *      `shielded`, `unshielded`, and `dust` each run their balancing inside
 *      `SubscriptionRef.modifyEffect` on their own state ref, and the dust
 *      wallet's `CoreWallet.spendCoins` nullifies the coin and records it in
 *      `pendingDust`. A second balancing that starts afterwards therefore
 *      CANNOT select the same inputs; it sees them gone.
 *   2. **Proving.** Minutes, for a transaction carrying shielded legs. It reads
 *      no wallet state and writes none: everything it needs is already in the
 *      recipe, and the coins it will spend are already booked as spent.
 *   3. **Submitting.** Back to the wallet, to book the transaction as pending.
 *
 * So the wallet is CLAIMED during (1) and (3) and free during (2) — and (2) is
 * all but the whole wall-clock cost. Treating a whole job as one long claim is
 * what made `/wallet-status` answer `available: 0` for the two minutes an mUSD
 * grant spends proving, which turned a busy wallet into an absent one: the
 * client gates fee sponsorship on `available > 0`, so every Send and every
 * concurrent onboarding stalled behind a grant that was not using the wallet at
 * all.
 *
 * TWO COUNTERS, NOT ONE
 * ---------------------
 * `reserved` counts outstanding CLAIMS — phases (1) and (3). It is what
 * "can this wallet pay a fee right now?" must be read from.
 *
 * `jobs` counts whole spend jobs on the queue, proving included. It is what
 * background housekeeping should defer to: the DUST registration rotates NIGHT
 * UTxOs, and while that does not contend for the coins a fee leg selects, there
 * is no reason to run it in the middle of somebody's grant when it can simply
 * wait a minute.
 *
 * The queue itself is unchanged in purpose: it serialises what would otherwise
 * race. What changed is that holding the queue is no longer mistaken for
 * holding the wallet — and, since 2026/09/02, that "one at a time" is a
 * consequence of the coins rather than a rule of the queue. See
 * {@link WalletReservationOptions.lanes}: a job starts only when a DUST coin is
 * free for it, so an activation's NIGHT leg and its asset leg can run together
 * on a wallet with two coins and cannot on a wallet with one.
 */

/**
 * Where a spend job sits in the queue when it has to wait.
 *
 * There are only two answers and there is a measurement behind the second.
 * Onboarding is one user watching one screen, and the two things this service
 * does for that user are not equal: registering the name is what they are
 * waiting for, and the activation grant is money that can arrive a minute later
 * without anybody noticing. Left in arrival order they collided — the grant is
 * fired the moment the account contract exists, which is BEFORE the client can
 * post the registration, so the grant took the queue and the name waited behind
 * it and its whole confirmation loop.
 *
 * The cost was 24 seconds, and it was read off the chain rather than guessed:
 * three consecutive real claims reconstructed block by block from the stagenet
 * indexer on 2026/08/31 (register blocks 257787, 257685, 257522) each show a
 * `deposit_night` landing exactly four blocks — one block is 6.000 s — between
 * the account deploy and the resolver deploy that the registration begins with.
 *
 * THIS IS NOT WHAT FIXED THAT, AND THE MEASUREMENT SAYS SO. A priority
 * reorders what is WAITING and never interrupts what is running, and in the
 * single-Passport case above the grant is already running by the time the
 * registration arrives. Benched against the promise chain this replaces, with
 * the 38 s the chain shows a grant job holding the wallet, the registration
 * still started 37.80 s later either way — a saving of 0.00 s. The fix for that
 * case is the client no longer firing the grant during a claim at all.
 *
 * What this DOES buy is the case one browser's ordering cannot reach: a grant
 * belonging to somebody else, already stacked on the queue when a registration
 * arrives. Same bench, one running job in front: 39.80 s before, 1.80 s after —
 * 38.00 s. That is the whole of its claim, and it is worth having, because two
 * Passports onboarding within a minute of each other is the demo.
 *
 * AND, since 2026/09/02, the case a priority on the queue alone cannot reach at
 * all: a registration that has LEFT the queue to wait for a fee-capable coin.
 * See {@link WalletReservation.hold} — without it the priority evaporates the
 * moment the wait begins, which is exactly when it is worth the most.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const SpendPriority = {
  /** Fee sponsorship, activation grants, housekeeping. */
  Normal: 0,
  /** A sponsored registration: somebody is watching a screen for this one. */
  Registration: 10,
} as const;

/**
 * A spend job that was abandoned because it stopped making progress.
 *
 * The lane is the scarce thing. Two jobs went silent holding one on 2026/09/02
 * — 23:03:31 and 23:46:30 UTC — and both times the queue behind them waited
 * until an operator restarted the service, because nothing in this process
 * could tell "proving, which is minutes" from "wedged, which is for ever". The
 * distinction this class rests on is the PROVER: a job that reports no step and
 * has nothing of ours at the prover is not slow.
 */
export class SpendJobStalled extends Error {
  readonly job: string;
  readonly step: string;
  readonly stalledMs: number;

  constructor(job: string, label: string, step: string, stalledMs: number) {
    super(
      `${label} made no progress for ${Math.round(stalledMs / 1_000)} s with nothing at the prover — last step ${step} (${job}). Its lane has been given back.`,
    );
    this.name = 'SpendJobStalled';
    this.job = job;
    this.step = step;
    this.stalledMs = stalledMs;
  }
}

/** Matches {@link SpendJobStalled} across a bundle boundary. */
export function isSpendJobStalled(cause: unknown): boolean {
  if (cause instanceof SpendJobStalled) return true;
  return cause instanceof Error && cause.name === 'SpendJobStalled';
}

/** A job that has STARTED — one lane, one record, until it settles. */
export interface RunningJob {
  id: string;
  label: string;
  priority: number;
  startedAt: number;
  /** When {@link progress} was last called, or when the job started. */
  lastProgressAt: number;
  /** The name of that step: `started`, `balanced`, `proved`, `submitted`, … */
  lastStep: string;
  /**
   * Aborted by the watchdog. Everything a job waits on that CAN be unwound —
   * the submission wrapper, the confirmation deadlines — races against it, so
   * the abort is not merely bookkeeping.
   */
  abort: AbortController;
  /**
   * The clock its own queue keeps, so `progress` stamps the record with the
   * same time the watchdog reads it by. A job stamped from `Date.now()` and
   * swept against an injected clock is a watchdog that never fires — which is
   * the whole defect, reproduced in the fix.
   */
  now: () => number;
}

/**
 * The running job, for code that is nowhere near the queue.
 *
 * Threaded through `AsyncLocalStorage` rather than through a parameter because
 * the callers that need to report a step are inside midnight-js: `balanceTx`
 * and `submitTx` are called by `deployContract`, which this service hands a
 * provider set to and never a job handle.
 */
const runningJob = new AsyncLocalStorage<RunningJob>();

export const currentJob = (): RunningJob | undefined => runningJob.getStore();

/**
 * Records that the running job has reached a step. Silent when there is no job
 * — every one of these call sites is also reachable from a probe or a test.
 */
export function progress(step: string, log?: (line: string) => void): void {
  const job = runningJob.getStore();
  if (!job) return;
  job.lastProgressAt = job.now();
  job.lastStep = step;
  (log ?? ((line: string) => console.log(line)))(`[job] ${job.label} ${step} (${job.id})`);
}

/** What `/status` publishes, and what the droplet watchdog matches a stall on. */
export interface RunningJobSummary {
  id: string;
  label: string;
  step: string;
  ageMs: number;
  sinceProgressMs: number;
}

/** One job on the queue, waiting its turn. */
interface QueuedJob {
  priority: number;
  label: string;
  start: () => void;
}

export interface WalletReservation {
  /**
   * True while some phase CLAIMS the wallet's coin state — balancing, signing,
   * submitting, or reverting. False while a job is merely proving.
   */
  isReserved(): boolean;
  /** True while any spend job holds the queue, proving included. */
  isBusy(): boolean;
  /**
   * Runs one claiming phase. A counter rather than a lock, deliberately: the
   * SDK's own coin selection is the mutual exclusion, and a lock here would
   * deadlock the moment a job re-entered — which a contract call does, because
   * midnight-js calls `balanceTx` and then `submitTx` inside a job that already
   * holds the queue.
   */
  reserve<T>(phase: () => Promise<T>, label?: string): Promise<T>;
  /**
   * Queues `task` behind every other spend job. Does NOT claim the wallet —
   * the phases inside `task` claim it for themselves through {@link reserve}.
   *
   * A failed predecessor does not poison the queue: the next job runs either
   * way, and its own rejection is its caller's.
   *
   * `priority` decides the order among jobs that are WAITING, and nothing else.
   * A job that has started is never interrupted, and equal priorities keep the
   * order they arrived in, so the queue is still first-come, first-served for
   * everything that does not say otherwise. See {@link SpendPriority}.
   */
  exclusive<T>(task: () => Promise<T>, options?: { priority?: number; label?: string }): Promise<T>;
  /**
   * Claims the NEXT free lane for a job that is not on the queue yet.
   *
   * WHY A JOB THAT IS NOT QUEUED NEEDS A PLACE IN THE QUEUE. A spend that finds
   * no fee-capable DUST coin gives its lane straight back and waits for one
   * outside the queue — that is `withDustWait`, and holding a lane while
   * waiting is the deadlock it exists to avoid. The cost, measured live on
   * 2026/09/02, is that the waiter also gives up its PRIORITY: the registration
   * of `bwmtkkh613ar8.night` stepped outside at 20:47:26, and the two
   * activation grants behind it — `Normal`, and never overtaking a queued
   * registration — took both coins that came free (20:48:31, 20:49:14) while it
   * watched. It registered at 20:49:50, and the first click reached Home in
   * 173.3 s against a bar of 120 s.
   *
   * So a waiter takes a HOLD instead of a lane. A hold starts nothing and
   * occupies nothing; it only stops the queue STARTING a job of strictly lower
   * priority, so the coin that comes free is still there when the waiter
   * rebuilds. Jobs already running are never touched — the coin the waiter is
   * waiting for is precisely the change one of them is about to produce — and
   * equal priorities are unaffected, so two registrations still take their
   * turns in arrival order.
   *
   * Bounded by construction: the only caller releases the hold when its coin
   * arrives or when its wait window expires, so a hold cannot outlive the wait
   * that took it. Releasing is idempotent and drains the queue.
   */
  hold(priority: number): () => void;
  /**
   * Both counters and the running jobs, for `/status` and for the tests.
   *
   * `running` is what makes a silent job visible from outside this process: the
   * droplet watchdog reads `jobsRunning: 1` with an idle prover and no step for
   * minutes and restarts the unit, which is what an operator had to do by hand
   * twice on 2026/09/02.
   */
  counts(): { reserved: number; jobs: number; running: RunningJobSummary[] };
  /** How many spend jobs may run at once RIGHT NOW. See {@link WalletReservationOptions.lanes}. */
  lanes(): number;
  /** Stops the stall watchdog. For tests and for shutdown. */
  stop(): void;
}

export interface WalletReservationOptions {
  /**
   * A claim held longer than this is reported through {@link onSlowClaim}.
   *
   * The point is not diagnostics for their own sake: every second of a claim is
   * a second `/wallet-status` answers `available: 0`, so a phase that grew a
   * network wait — as `submitTx` silently had, waiting on finalisation — should
   * announce itself in the journal rather than be found by polling from a
   * laptop three weeks later.
   */
  slowClaimMs?: number;
  onSlowClaim?: (label: string, heldMs: number) => void;
  /**
   * How many spend jobs may run at once, asked AFRESH before every start.
   *
   * WHY THIS IS A FUNCTION AND NOT A NUMBER. The real limit is not a
   * configuration figure, it is how many DUST coins are free: the SDK's coin
   * selection is "the smallest coin with value above zero, until the fee is
   * covered", so a job that starts with no free coin does not wait politely —
   * it fails to balance, or it sweeps a coin a running job was about to spend.
   * `./wallet.ts` therefore passes `min(BALANCER_SPEND_LANES, free FEE-CAPABLE
   * DUST coins)` — a spend's change is a DUST coin the moment it lands and
   * cannot carry a fee of its own for minutes afterwards, so counting it opens
   * a lane no job can use — and the queue reads it at each drain, so lanes
   * close as coins are spent and reopen as change becomes fee-capable, without
   * anybody publishing an event.
   *
   * Defaults to one, which is the behaviour this queue had before lanes
   * existed: strictly one spend at a time.
   */
  lanes?: () => number;
  /**
   * How long a RUNNING job may report no step before it is aborted, with
   * nothing of ours at the prover. Absent turns the watchdog off, which is the
   * behaviour every test that does not ask for it keeps.
   */
  stallMs?: number;
  /**
   * False while this service has a proof outstanding. A job that is proving
   * reports nothing for minutes and is perfectly healthy, so the watchdog never
   * fires while this is false. Absent means "always idle".
   */
  proverIdle?: () => boolean;
  /** How often the watchdog looks. */
  watchdogIntervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export function createWalletReservation(options: WalletReservationOptions = {}): WalletReservation {
  const slowClaimMs = options.slowClaimMs ?? 5_000;
  const lanes = options.lanes ?? ((): number => 1);
  /* Never below one. A lane count of zero would not throttle the queue, it
     would STOP it: `drain` is called on arrival and on completion, so with no
     job running there would be nothing left to call it again and the queue
     would stall with work in it until the next arrival. A caller reporting no
     free coins gets one lane, whose job then waits on the fee estimate — which
     is a wait it can be given a budget for, unlike a stalled queue. */
  const laneCount = (): number => Math.max(1, Math.floor(lanes()));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  let reserved = 0;
  let jobs = 0;
  let nextJobId = 0;
  /* Keyed by id so an abort can find its own record, and iterated by the
     watchdog. Entries are removed in `finish`, on every path. */
  const running = new Map<string, RunningJob>();
  const waiting: QueuedJob[] = [];
  /* Outstanding priority holds — see `hold`. A multiset rather than a counter
     per level, because the only question ever asked of it is its maximum. */
  const holds: number[] = [];
  const highestHold = (): number =>
    holds.reduce((highest, one) => (one > highest ? one : highest), Number.NEGATIVE_INFINITY);

  /* One job runs at a time, and `jobs` is the count of running ones — which is
     zero exactly when the wallet is free to start the next. Called after every
     arrival and after every completion, so a queue can never stall with work
     in it.

     A job arriving at an idle wallet therefore STARTS synchronously, where the
     old promise chain gave it a microtask's delay first. That is the more
     honest of the two — `isBusy()` is true from the moment the job is running —
     and nothing depended on the delay: every task here is an async function,
     which cannot get past its own first await in the same tick. */
  const drain = (): void => {
    /* A loop rather than a single start, and the lane count is re-read on every
       pass: a drain that opened three lanes on one reading could start three
       jobs against a coin count that the first of them has already changed. */
    while (jobs < laneCount()) {
      const next = waiting[0];
      if (!next) return;
      /* A hold outranks what is merely waiting. Peeked rather than shifted, so
         a blocked job keeps its place: this defers it, it never drops it. */
      if (next.priority < highestHold()) return;
      waiting.shift();
      next.start();
    }
  };

  const reserve = async <T>(phase: () => Promise<T>, label = 'phase'): Promise<T> => {
    reserved += 1;
    const startedAt = Date.now();
    try {
      return await phase();
    } finally {
      reserved -= 1;
      const heldMs = Date.now() - startedAt;
      if (options.onSlowClaim && heldMs >= slowClaimMs) options.onSlowClaim(label, heldMs);
    }
  };

  const exclusive = <T>(
    task: () => Promise<T>,
    jobOptions: { priority?: number; label?: string } = {},
  ): Promise<T> => {
    const priority = jobOptions.priority ?? SpendPriority.Normal;
    const label = jobOptions.label ?? 'spend';
    return new Promise<T>((settle, fail) => {
      nextJobId += 1;
      const id = `job-${nextJobId}`;
      log(`[job] ${label} queued (${id})`);
      /* Inserted BEFORE the first waiting job of lower priority, and after
         every job of equal or higher priority. That is what makes equal
         priorities first-come, first-served: the scan stops at the first
         strictly-lower entry, so an arrival never overtakes its own peers. */
      const entry: QueuedJob = {
        priority,
        label,
        start: () => {
          jobs += 1;
          const startedAt = now();
          const record: RunningJob = {
            id,
            label,
            priority,
            startedAt,
            lastProgressAt: startedAt,
            lastStep: 'started',
            abort: new AbortController(),
            now,
          };
          running.set(id, record);
          log(`[job] ${label} started (${id})`);
          /* Settles ONCE, whichever of the task and the watchdog gets there
             first. A watchdog abort rejects the caller and gives the lane back
             immediately; the underlying task may still be waiting on something
             the SDK cannot cancel, and its eventual settlement is discarded. */
          let settled = false;
          const finish = (settleJob: () => void): void => {
            if (settled) return;
            settled = true;
            running.delete(id);
            jobs -= 1;
            settleJob();
            drain();
          };
          const done = (outcome: string): void => {
            log(`[job] ${label} ${outcome} after ${((now() - startedAt) / 1_000).toFixed(1)} s (${id})`);
          };
          let task_: Promise<T>;
          try {
            task_ = runningJob.run(record, task);
          } catch (cause: unknown) {
            /* A task that throws before its first await. Async functions cannot
               do this, and every caller passes one — but a queue that let a
               synchronous throw escape `exclusive` would leave `jobs` standing
               at one for ever and stall every spend after it. */
            done('failed');
            finish(() => fail(cause));
            return;
          }
          record.abort.signal.addEventListener('abort', () => {
            const cause = record.abort.signal.reason;
            done('aborted');
            finish(() => fail(cause));
          });
          task_.then(
            (value) => {
              if (!settled) done('done');
              finish(() => settle(value));
            },
            (cause: unknown) => {
              if (!settled) done('failed');
              finish(() => fail(cause));
            },
          );
        },
      };
      let index = waiting.length;
      while (index > 0 && waiting[index - 1]!.priority < priority) index -= 1;
      waiting.splice(index, 0, entry);
      drain();
    });
  };

  const hold = (priority: number): (() => void) => {
    holds.push(priority);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const at = holds.indexOf(priority);
      if (at >= 0) holds.splice(at, 1);
      drain();
    };
  };

  /* -------------------------------------------------------------------------- */
  /* The stall watchdog                                                         */
  /* -------------------------------------------------------------------------- */

  const proverIdle = options.proverIdle ?? ((): boolean => true);
  const stallMs = options.stallMs ?? 0;

  /** One pass. Exported through nothing; the timer and the tests drive it. */
  const sweepStalled = (): void => {
    if (stallMs <= 0) return;
    if (!proverIdle()) return;
    const at = now();
    for (const job of [...running.values()]) {
      if (job.abort.signal.aborted) continue;
      const idleMs = at - job.lastProgressAt;
      if (idleMs < stallMs) continue;
      log(
        `[job] aborting ${job.label} after ${Math.round(idleMs / 1_000)} s with no progress — last step ${job.lastStep} (${job.id})`,
      );
      job.abort.abort(new SpendJobStalled(job.id, job.label, job.lastStep, idleMs));
    }
  };

  const watchdog =
    stallMs > 0
      ? setInterval(sweepStalled, options.watchdogIntervalMs ?? 5_000)
      : null;
  watchdog?.unref();

  return {
    isReserved: () => reserved > 0,
    isBusy: () => jobs > 0,
    reserve,
    exclusive,
    hold,
    counts: () => ({
      reserved,
      jobs,
      running: [...running.values()].map((job) => ({
        id: job.id,
        label: job.label,
        step: job.lastStep,
        ageMs: now() - job.startedAt,
        sinceProgressMs: now() - job.lastProgressAt,
      })),
    }),
    lanes: laneCount,
    stop: () => {
      if (watchdog) clearInterval(watchdog);
    },
  };
}
