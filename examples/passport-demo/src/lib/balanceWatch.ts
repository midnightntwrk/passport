/**
 * WHEN TO READ THE ACCOUNT AGAIN, SO A BALANCE STOPS NEEDING A RELOAD.
 *
 * THE DEFECT THIS IS THE PURE HALF OF
 * -----------------------------------
 * Reported 2026/09/02: "The mUSD balance was never updated to 100; after I
 * refresh the page the 100 mUSD appeared", and, from the other side of a
 * transfer, "the recipient's balance did not update automatically after a
 * send". Both are the same shape of mistake, made in two places:
 *
 *   THE SPONSOR'S ANSWER IS NOT THE LEDGER. Activation asks the sponsor for an
 *   opening balance and re-reads the account the instant the sponsor answers
 *   200. The sponsor answers when it has SUBMITTED the deposit; the figure the
 *   screen reads comes from the chain a beat later. One read, taken at exactly
 *   the wrong moment, is a read of the state before the deposit — and nothing
 *   ever read again, so the opening balance sat at zero until the reader
 *   reloaded the page themselves.
 *
 *   NOBODY TELLS YOU MONEY ARRIVED. Every read this app made was a
 *   consequence of something the READER had just done. An amount somebody else
 *   sends lands with no local event to hang a read off at all, so a Passport
 *   left open showed a stale figure indefinitely.
 *
 * So the account is WATCHED. Two cadences, because the two facts above want
 * different ones:
 *
 *   CHASING — something has been announced and the figure has not moved yet.
 *   Read after {@link BALANCE_WATCH_CHASE_FIRST_MS}, then further apart on each
 *   attempt up to {@link BALANCE_WATCH_CHASE_CEILING_MS}, for at most
 *   {@link BALANCE_WATCH_CHASE_WINDOW_MS} — the same ten minutes the activation
 *   grant's own retry schedule is given, because that is how long the thing
 *   being chased can honestly take. The chase ends the moment the holdings
 *   change, which is the only evidence that what was announced has landed.
 *
 *   STEADY — nothing is expected, but a transfer from someone else can arrive
 *   at any time. Every {@link BALANCE_WATCH_STEADY_MS} while the screen is in
 *   front of somebody. Slow on purpose: it is a courtesy, not a subscription,
 *   and a Passport left open on a desk should not be a load generator.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never invents a figure. A watch only decides WHEN to ask; what comes back
 * is whatever the account itself says, and a reading that has not arrived is
 * shown as on its way, never as money. It also never runs while the document
 * is hidden — a backgrounded tab's timers are throttled to something between
 * useless and dishonest, so the watch pauses and reads once on the way back.
 *
 * There is no DOM and no React in here, on the same principle as
 * `feeReadinessPoll.ts`: a controller with injected timers and an injected
 * clock is a thing a test can drive with `vi.useFakeTimers()`, and this
 * workspace has no jsdom to render a hook into. The React glue that owns the
 * `visibilitychange` listener is `src/screens/useBalanceWatch.ts`.
 */

/** The first chase read, and the floor for every one after it. */
export const BALANCE_WATCH_CHASE_FIRST_MS = 5_000;

/**
 * The longest gap a chase will grow to.
 *
 * The backoff exists so ten minutes of chasing is not a hundred and twenty
 * reads; the ceiling exists so the tail of a chase is still quicker than the
 * steady cadence, which would otherwise overtake it and make the last minutes
 * of a chase slower than not chasing at all.
 */
export const BALANCE_WATCH_CHASE_CEILING_MS = 20_000;

/**
 * How long a chase may run before it gives up and falls back to steady.
 *
 * Ten minutes, matching the activation grant's own retry schedule in
 * `App.tsx`: the grant is the slowest thing that is ever chased, and a chase
 * that expired first would leave the one case it was written for uncovered.
 */
export const BALANCE_WATCH_CHASE_WINDOW_MS = 10 * 60_000;

/** The cadence when nothing in particular is expected. */
export const BALANCE_WATCH_STEADY_MS = 30_000;

/**
 * How long the watch stands off while the Passport is in the middle of
 * something, before asking again whether it still is.
 *
 * WHY A WATCH STANDS OFF AT ALL (2026/09/03). A read of the account is not
 * free: it is an indexer round trip and a ledger-state decode, and the timer
 * this module owns is the only read in the app that can land in the middle of
 * a proving run rather than following something the reader did. A shielded leg
 * is already the largest allocation Passport ever makes — 19.5 MB of prover
 * key per artefact read, RSS 330 MB at rest against 787 MB mid-leg, measured
 * on stagenet — and a browser died in that window on 2026/09/03 at 16:30:46
 * UTC. A courtesy read has no business being the thing on top.
 *
 * DEFERRED, NEVER DROPPED. The read that was due is taken as soon as the work
 * releases, so nothing this watch exists for is lost: the opening balance that
 * 2026/09/02's report was about lands DURING activation, which is exactly a
 * busy stretch, and a watch that skipped its read there would have been a
 * regression dressed as an optimisation. Two seconds, because that is short
 * against every cadence here and long enough that standing off is not itself a
 * poll.
 */
export const BALANCE_WATCH_BUSY_STANDOFF_MS = 2_000;

/** How the growth between chase reads is shaped. Gentle: 5s, 7.5s, 11.2s… */
const CHASE_GROWTH = 1.5;

/** Everything the delay rule needs to know about where a watch has got to. */
export interface BalanceProbeSchedule {
  /** True while something has been announced and the holdings have not moved. */
  chasing: boolean;
  /** Chase reads already made in this run. `0` before the first one. */
  attempt: number;
  /** Milliseconds since this chase began. Ignored when not chasing. */
  elapsedMs: number;
}

/**
 * A chase that has run out of its window.
 *
 * Separate from the delay rule because the controller has to ACT on it — the
 * chase is abandoned, not merely slowed — and a caller that only read the
 * delay back would keep an expired chase alive forever at the steady cadence
 * while still calling itself chasing.
 */
export function chaseIsSpent(elapsedMs: number): boolean {
  return elapsedMs >= BALANCE_WATCH_CHASE_WINDOW_MS;
}

/**
 * How long to wait before reading the account again.
 *
 * An expired chase gets the steady cadence rather than a chase one, so a
 * controller that has not yet noticed the window is spent still cannot poll
 * quickly forever.
 */
export function nextBalanceProbeDelayMs(schedule: BalanceProbeSchedule): number {
  if (!schedule.chasing) return BALANCE_WATCH_STEADY_MS;
  if (chaseIsSpent(schedule.elapsedMs)) return BALANCE_WATCH_STEADY_MS;
  const grown = BALANCE_WATCH_CHASE_FIRST_MS * CHASE_GROWTH ** Math.max(0, schedule.attempt);
  return Math.round(Math.min(grown, BALANCE_WATCH_CHASE_CEILING_MS));
}

/**
 * What the account holds, as the screens are handed it.
 *
 * A subset of Home's `account` prop rather than an import of it: this module
 * is in the coverage denominator and the screen's prop type is a `.tsx` away,
 * and the only thing the watch needs from a balance is whether it CHANGED.
 */
export interface HoldingsSnapshot {
  /** Formatted NIGHT. `null` is "not known", never a zero. */
  nightBalance: string | null;
  stablecoin: { colourHex: string; amount: bigint } | null;
  otherShielded: readonly { colourHex: string; amount: bigint }[];
}

/**
 * A fingerprint of what an account holds, for "has it moved yet".
 *
 * Sorted by colour, so the same holdings read twice cannot fingerprint
 * differently because the indexer returned them in another order — a chase
 * that ended on a re-ordering would end on nothing having happened.
 *
 * An unknown NIGHT figure fingerprints as `?`, distinct from a real `0`: a
 * read that failed and an account that is empty are different facts, and a
 * chase must not treat "the read came back broken" as "the money arrived".
 */
export function holdingsSignature(account: HoldingsSnapshot | null): string {
  if (!account) return 'no-account';
  const colours = [
    ...(account.stablecoin ? [account.stablecoin] : []),
    ...account.otherShielded,
  ]
    .map((held) => `${held.colourHex}:${held.amount}`)
    .sort();
  return `night=${account.nightBalance ?? '?'}|${colours.join(',')}`;
}

/**
 * Whether this account holds anything at all.
 *
 * The question the opening-balance line asks: an account with nothing in it
 * and no failure recorded is one whose grant is still on its way. A `null`
 * NIGHT figure is NOT nothing — it is a figure nobody has read yet — so it
 * answers false here for the same reason it fingerprints as `?` above.
 */
export function accountHoldsSomething(account: HoldingsSnapshot | null): boolean {
  if (!account) return false;
  if (account.nightBalance !== null && account.nightBalance !== '0') return true;
  if (account.stablecoin && account.stablecoin.amount > 0n) return true;
  return account.otherShielded.some((held) => held.amount > 0n);
}

export interface BalanceWatchOptions {
  /**
   * Re-reads the account. A rejection is swallowed: a read that failed is not
   * news the watch can act on, and the next tick will ask again.
   */
  refresh: () => void | Promise<void>;
  /** The holdings fingerprint RIGHT NOW. Read after each probe settles. */
  signature: () => string;
  /**
   * Whether the Passport is in the middle of something a read must not be
   * piled on top of — see {@link BALANCE_WATCH_BUSY_STANDOFF_MS}. Defaults to
   * "never busy", so a caller that does not know keeps the old behaviour.
   */
  busy?: () => boolean;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `setTimeout`. Returns whatever handle `clearTimer` takes. */
  setTimer?: (run: () => void, delayMs: number) => unknown;
  /** Defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
}

export interface BalanceWatch {
  /**
   * Something has been announced — an opening balance, a send, a row on the
   * trail that was not there a moment ago. Starts (or restarts) a chase from
   * the fingerprint as it stands now.
   */
  expectChange: () => void;
  /** The document went away, or the screen did. No reads until `resume`. */
  pause: () => void;
  /** Back in front of somebody: read once now, then carry on. */
  resume: () => void;
  /** For good. Any read in flight is ignored when it lands. */
  stop: () => void;
  /** Whether a chase is running. For drills, and for a screen that asks. */
  chasing: () => boolean;
}

/**
 * Starts watching an account.
 *
 * The first read is scheduled, not immediate: every caller has just read the
 * account itself — that is what put the screen on screen — and an immediate
 * second read would be the same answer twice. `resume` is the exception, and
 * deliberately so: a tab coming back from the background has been showing a
 * figure that stopped being watched, and the first thing it owes the reader is
 * a fresh one.
 *
 * Each read is scheduled after the previous one SETTLED, never on a fixed
 * clock, so a slow indexer cannot be asked twice at once.
 */
export function startBalanceWatch(options: BalanceWatchOptions): BalanceWatch {
  const now = options.now ?? (() => Date.now());
  const busy = options.busy ?? ((): boolean => false);
  const setTimer =
    options.setTimer ?? ((run: () => void, delayMs: number) => setTimeout(run, delayMs));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let stopped = false;
  let paused = false;
  let inFlight = false;
  let timer: unknown = null;
  let chasing = false;
  let chaseStartedAt = 0;
  let chaseAttempt = 0;
  /* The fingerprint the chase is measured against — what the account held when
     the announcement was made. The chase ends when the account stops matching
     it, which is the only evidence available that the thing landed. */
  let chaseBaseline = '';

  const cancel = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const schedule = (delayMs?: number): void => {
    if (stopped || paused) return;
    cancel();
    const delay =
      delayMs ??
      nextBalanceProbeDelayMs({
        chasing,
        attempt: chaseAttempt,
        elapsedMs: now() - chaseStartedAt,
      });
    timer = setTimer(() => {
      timer = null;
      void probe();
    }, delay);
  };

  const probe = async (): Promise<void> => {
    if (stopped || paused || inFlight) return;
    /* STOOD OFF, NOT SKIPPED. The read that was due is taken as soon as the
       work releases — the chase keeps its baseline, its clock, and its attempt
       count, so a stretch of busy costs the chase nothing but the standoff. */
    if (busy()) {
      schedule(BALANCE_WATCH_BUSY_STANDOFF_MS);
      return;
    }
    inFlight = true;
    if (chasing) chaseAttempt += 1;
    try {
      await options.refresh();
    } catch {
      /* A read that could not be made says nothing about the money. The screen
         shows its own unavailable state; the watch simply asks again. */
    } finally {
      inFlight = false;
      if (!stopped) {
        /* Two ways a chase ends: the figure moved, or the window is spent. */
        if (chasing && (options.signature() !== chaseBaseline || chaseIsSpent(now() - chaseStartedAt))) {
          chasing = false;
        }
        schedule();
      }
    }
  };

  schedule();

  return {
    expectChange: (): void => {
      if (stopped) return;
      chasing = true;
      chaseAttempt = 0;
      chaseStartedAt = now();
      chaseBaseline = options.signature();
      schedule();
    },
    pause: (): void => {
      if (stopped || paused) return;
      paused = true;
      cancel();
    },
    resume: (): void => {
      if (stopped || !paused) return;
      paused = false;
      void probe();
    },
    stop: (): void => {
      stopped = true;
      cancel();
    },
    chasing: (): boolean => chasing,
  };
}
