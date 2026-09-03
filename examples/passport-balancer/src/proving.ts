/**
 * How many proofs this service has outstanding, and why anything cares.
 *
 * The stall watchdog in `./reservation.ts` aborts a spend job that has reported
 * no step for `BALANCER_JOB_STALL_MS`. That rule is only safe because of the
 * counter in this module: a contract proof is legitimately minutes long and
 * reports nothing at all while it runs, so a watchdog that could not tell
 * "proving" from "wedged" would abort healthy registrations. The watchdog
 * therefore fires only while {@link proofsInFlight} is zero — nothing of ours is
 * at the prover, so a job that is not moving is not working either.
 *
 * It is a process-wide counter rather than a value threaded through the call
 * graph because the four places that prove are nowhere near each other: the
 * fee-leg prover inside `/balance-only`, `finalizeRecipe` inside the contract
 * wallet provider, and midnight-js's own `proveTx` for a contract deploy or
 * call — the last of which this service reaches only by wrapping the provider
 * it hands to midnight-js.
 *
 * The same counter is what `/status` publishes as `proofInFlight`, and what the
 * resolver-pool filler reads before it decides the sponsor is busy.
 */

let outstanding = 0;

/** How many proofs are at the prover right now. */
export function proofsInFlight(): number {
  return outstanding;
}

/** True while NOTHING of ours is at the prover. See the module note. */
export function proverIdle(): boolean {
  return outstanding === 0;
}

/**
 * Counts `work` as a proof for as long as it runs.
 *
 * The decrement is in a `finally`, so a proof that fails still stops being
 * counted — a leaked increment would disable the stall watchdog for the life of
 * the process, which is the failure this whole change exists to prevent.
 */
export async function countingProof<T>(work: () => Promise<T>): Promise<T> {
  outstanding += 1;
  try {
    return await work();
  } finally {
    outstanding -= 1;
  }
}

/** For tests that need a known starting point. */
export function resetProofCounter(): void {
  outstanding = 0;
}
