/**
 * The re-check that runs between "Send" and the first transaction, and the
 * twenty seconds it now gives the fee sponsor to answer for itself.
 *
 * WHY THIS EXISTS
 * ---------------
 * The fee line on the review screen is a prediction, so the sponsor is asked
 * again on confirm and nothing is submitted if the answer has changed. That is
 * the right rule and it stays. What was wrong was the reading of "changed".
 *
 * The sponsor takes its own DUST out of circulation while it settles a
 * transaction it has just made, and for well under a minute afterwards it
 * reports that it has nothing free. Measured live on 2026/09/08, 17:00–17:02
 * UTC: the sponsor was healthy the whole time, its supervisor logged one
 * degraded tick and cleared it unaided, and two people pressing Send in that
 * window were told "Nothing was sent — the fee arrangement changed" and left
 * to work out for themselves that pressing it again a minute later would work.
 * Nothing about the arrangement had changed. The sponsor was busy.
 *
 * So a refusal that will clear on its own is WAITED OUT rather than reported.
 * The sponsor is asked again after two seconds, then four, then six, then
 * eight — twenty seconds in all, which is the same budget the send path itself
 * already gives a sponsor that answers "somebody is ahead of you". The moment
 * it answers the way the fee line promised, the send goes ahead; if it has not
 * by the end, the person gets the sentence they always got.
 *
 * WHAT IS NOT WAITED FOR
 * ----------------------
 * A REAL change of arrangement, either way round: a fee that was going to be
 * covered and now would not be at all, and a fee that was not going to be
 * covered and now would be. Both make the sentence the person confirmed
 * against untrue, and both are reported at once. Waiting is only ever for a
 * sponsor that is momentarily unable, never for one that has stood down.
 *
 * There is no DOM and no React in here on purpose — see `feeReadinessPoll.ts`,
 * which exists for the same reason and watches the same probe while a sheet is
 * merely open.
 */

import type { FeeReadiness } from './localWallet.js';

/**
 * How long the sponsor is given, and in what steps: 2 s, 4 s, 6 s, 8 s.
 *
 * Twenty seconds in four asks. It starts short because the commonest wait is
 * the short one and a two-second pause reads as the button thinking rather
 * than as a stall, and it lengthens so that a sponsor which is going to take
 * the whole window is not asked ten times on the way there.
 */
export const FEE_RECHECK_BACKOFF_MS: readonly number[] = [2_000, 4_000, 6_000, 8_000];

/**
 * Whether this refusal is one that clears on its own.
 *
 * `busy` is the sponsor's DUST being spoken for by transactions in flight and
 * `unreachable` is a service that did not answer this time; both are about the
 * next few seconds. `disabled` is a build with no sponsor configured at all,
 * which no amount of waiting improves — and neither does an answer that says
 * the fee WOULD be covered, which is a change rather than a refusal.
 */
export function feeRefusalWillClear(readiness: FeeReadiness): boolean {
  return readiness.mode === 'unsponsored' && readiness.cause !== 'disabled';
}

export interface SettleFeeRecheckOptions {
  /** The mode the fee line promised, or `null` if it could not be read. */
  quoted: FeeReadiness['mode'] | null;
  /** The answer the confirm-time re-check already got. */
  first: FeeReadiness;
  /** Asks the sponsor again. Should bypass any cache. */
  probe: () => Promise<FeeReadiness>;
  /** Every answer, as it arrives, so the fee line stays current while waiting. */
  onReadiness: (readiness: FeeReadiness) => void;
  /**
   * Called once, and only when a wait is actually about to begin. It is what a
   * surface hangs "Checking the fee…" on: a send that settles on the first
   * answer must not flash a wait that never happened.
   */
  onWaiting: () => void;
  /** Defaults to {@link FEE_RECHECK_BACKOFF_MS}. */
  delaysMs?: readonly number[];
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface FeeRecheckOutcome {
  /** `true` when the sponsor is doing what the fee line promised, so send. */
  agreed: boolean;
  /** The last answer read, which is what the fee line should now show. */
  readiness: FeeReadiness;
  /** Extra asks this took. `0` means nothing was waited for. */
  probes: number;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Settles the confirm-time re-check, waiting only where waiting can help.
 *
 * Never throws on its own account: a `probe` that rejects is the caller's to
 * handle, exactly as the first one is.
 */
export async function settleFeeRecheck(
  options: SettleFeeRecheckOptions,
): Promise<FeeRecheckOutcome> {
  const delays = options.delaysMs ?? FEE_RECHECK_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;

  let latest = options.first;
  // The answer the fee line promised. Nothing to settle.
  if (latest.mode === options.quoted) return { agreed: true, readiness: latest, probes: 0 };
  /* A change rather than a wait, or a quote there is no getting back to: a fee
     line that could not be read in the first place has no arrangement for the
     sponsor to return to, so there is nothing for a wait to prove. */
  if (options.quoted !== 'sponsored' || !feeRefusalWillClear(latest)) {
    return { agreed: false, readiness: latest, probes: 0 };
  }

  options.onWaiting();
  for (let index = 0; index < delays.length; index += 1) {
    await sleep(delays[index]);
    latest = await options.probe();
    options.onReadiness(latest);
    const probes = index + 1;
    if (latest.mode === options.quoted) return { agreed: true, readiness: latest, probes };
    // It stood down properly while we waited. Say so rather than keep asking.
    if (!feeRefusalWillClear(latest)) return { agreed: false, readiness: latest, probes };
  }
  return { agreed: false, readiness: latest, probes: delays.length };
}
