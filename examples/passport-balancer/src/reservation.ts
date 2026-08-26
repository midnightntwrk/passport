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
 * The queue itself is unchanged in purpose: spends still run one at a time, so
 * two grants arriving together are served in order rather than racing the proof
 * server. What changed is that holding the queue is no longer mistaken for
 * holding the wallet.
 */

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
   * `then(run, run)` so a failed predecessor does not poison the queue: the
   * next job runs either way, and its own rejection is its caller's.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
  /** Both counters, for `/status` and for the tests. */
  counts(): { reserved: number; jobs: number };
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
}

export function createWalletReservation(options: WalletReservationOptions = {}): WalletReservation {
  const slowClaimMs = options.slowClaimMs ?? 5_000;
  let reserved = 0;
  let jobs = 0;
  let queue: Promise<unknown> = Promise.resolve();

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

  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      jobs += 1;
      try {
        return await task();
      } finally {
        jobs -= 1;
      }
    };
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    isReserved: () => reserved > 0,
    isBusy: () => jobs > 0,
    reserve,
    exclusive,
    counts: () => ({ reserved, jobs }),
  };
}
