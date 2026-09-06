/**
 * How patient a name claim is when the service refuses it — the rule, not the
 * waiting.
 *
 * THE DEFECT THIS EXISTS FOR (2026/09/05)
 * ------------------------------------------------------------------------
 * The sponsor's own side failed to deploy the resolver leaf and answered
 * `deploy-failed` — "the resolver contract for alice.night could not be
 * deployed, so nothing was registered". Nothing about that refusal is a fact
 * about the reader, the name, or anything they could act on: it is the service
 * failing at a step it takes on its own, and the next attempt a minute later
 * usually lands. What the reader got was the failure card — "The claim did not
 * complete. alice.night was not registered, and your name is kept for you." —
 * with Try again and Continue to Home, and then Passport waited for a human to
 * press one of them.
 *
 * The opening balance, refused by the same service on the same afternoon, waits
 * ten minutes and asks again seven times without troubling anybody (see
 * `FUND_ACCOUNT_RETRY_DELAYS_MS` in `App.tsx` and the outcomes in
 * `lib/activation.ts`). The claim is the more important of the two and was the
 * less patient. This module is the claim's half of that schedule.
 *
 * WHAT IS NOT RETRIED, AND WHY IT MATTERS MORE THAN WHAT IS
 * ------------------------------------------------------------------------
 * A retry that asks a second time for a name that may ALREADY have landed is
 * how one Passport ends up paying for two registrations, so the classification
 * below is deliberately conservative: `selfPayWorthTrying` is honoured exactly
 * as `identity/sponsoredAlias.ts` sets it — `registration-in-flight` and
 * `confirmation-failed` are the two refusals the service makes when it cannot
 * say whether the registration landed — and `bind-failed` joins them here,
 * because a bind failure means the NAME IS REGISTERED and only its target is
 * missing. Asking again under any of the three could register twice.
 *
 * Three more are final for a different reason: asking again would fail
 * identically. `name-taken` is a fact about the name; `invalid-request`,
 * `invalid-name`, and `not-found` are facts about what was sent; and
 * `rate-limited` is the sponsor's hourly ceiling, which clears in tens of
 * minutes rather than in this window and whose own sentence already tells the
 * reader to come back in a few minutes (see `SPONSOR_RATE_LIMITED_SENTENCE`).
 * Spending eight minutes of silent retries against a ceiling would burn the
 * per-caller bucket as well, and end by saying the same thing.
 *
 * Everything else is the service failing at its own work — `deploy-failed`, a
 * registry it could not read, no NIGHT or no DUST free, a wallet still walking
 * the chain, a 500, a timeout, a socket that was not there (the 2026/09/05
 * outage was four and a half hours of exactly that) — and every one of them
 * clears without anybody doing anything. Those are retried.
 *
 * PURE, like `lib/activation.ts` and for the same reason: there is no jsdom in
 * this workspace, so a decision left inside a `.tsx` or inside `App.tsx` cannot
 * be drilled at all. The classification, the backoff, the wall-clock bound, and
 * the sentence the reader sees are all here; `App.tsx` supplies the attempt and
 * the screen paints the answer.
 */

/** What one refusal means for a schedule. */
export type ClaimRetryVerdict = 'final' | 'retry';

/**
 * The part of a sponsor refusal a schedule decides on — deliberately a plain
 * shape rather than `AliasSponsorRefusal`, so this module stays importable
 * without the transport it describes.
 */
export interface ClaimRefusal {
  /** The service's machine-readable `error` code, or `'unreachable'`. */
  code: string;
  /**
   * `AliasSponsorRefusal.selfPayWorthTrying` — false where a second attempt
   * could DOUBLE-REGISTER or would fail identically. A false here is final
   * whatever the code says.
   */
  worthRetrying: boolean;
  /** The `retryAfterMs` the service named beside the refusal, where it named one. */
  retryAfterMs?: number | null;
}

/**
 * Refusals that must NOT be asked again inside this window. See the module
 * header: the first three may already have registered the name, and the rest
 * would fail in exactly the same way.
 */
const CLAIM_FINAL_CODES = new Set([
  'registration-in-flight',
  'confirmation-failed',
  'bind-failed',
  'name-taken',
  'invalid-request',
  'invalid-name',
  'not-found',
  'rate-limited',
]);

/** Whether this refusal ends the claim, or earns another attempt. */
export function classifyClaimRefusal(refusal: ClaimRefusal): ClaimRetryVerdict {
  if (!refusal.worthRetrying) return 'final';
  return CLAIM_FINAL_CODES.has(refusal.code) ? 'final' : 'retry';
}

/**
 * The backoff, in the order it is spent.
 *
 * It doubles to two minutes and then stays there: the refusals worth waiting
 * out clear when the service finishes something of its own, which is tens of
 * seconds after each of its spends, and a poll faster than that is a rate
 * limit rather than a shorter wait. Six entries, 390 seconds of waiting, which
 * leaves room inside {@link CLAIM_RETRY_WINDOW_MS} for the attempts themselves.
 */
export const CLAIM_RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 80_000, 120_000, 120_000];

/**
 * The wall-clock bound on the whole schedule, measured from the first refusal.
 *
 * Eight minutes, and it is the bound that actually holds: an ATTEMPT can take
 * as long as `REGISTER_TIMEOUT_MS` allows, so counting delays alone would let a
 * schedule run far past anything a person would call patient. A delay that
 * would end past this is not taken — the schedule is spent instead, and the
 * failure card the reader would have seen at the first refusal is shown then.
 */
export const CLAIM_RETRY_WINDOW_MS = 480_000;

/**
 * Floor on a delay, so a `retryAfterMs: 0` cannot spin, and ceiling on one, so
 * a single large hint cannot swallow the window in one sleep. The same pair of
 * reasons `lib/sponsor.ts` clamps its own `retryAfterMs` for.
 */
const CLAIM_RETRY_MIN_DELAY_MS = 2_000;
const CLAIM_RETRY_MAX_DELAY_MS = 120_000;

/**
 * How long to wait before attempt `attempt + 1`, or `null` when the schedule is
 * spent — either because the backoff has run out or because the wait would end
 * past {@link CLAIM_RETRY_WINDOW_MS}.
 *
 * `attempt` is the number of refusals absorbed so far, minus one: the first
 * refusal asks with `0` and is given ten seconds.
 */
export function claimRetryDelayMs(input: {
  attempt: number;
  /** Milliseconds since the schedule started. */
  elapsedMs: number;
  retryAfterMs?: number | null;
}): number | null {
  const scheduled = CLAIM_RETRY_DELAYS_MS[input.attempt];
  if (scheduled === undefined) return null;
  /* The service's own figure wins where it gave one — it knows when it will be
     free and the backoff is only a guess about that — clamped at both ends. */
  const asked =
    typeof input.retryAfterMs === 'number' &&
    Number.isFinite(input.retryAfterMs) &&
    input.retryAfterMs >= 0
      ? Math.max(CLAIM_RETRY_MIN_DELAY_MS, Math.min(input.retryAfterMs, CLAIM_RETRY_MAX_DELAY_MS))
      : scheduled;
  return asked > CLAIM_RETRY_WINDOW_MS - input.elapsedMs ? null : asked;
}

/**
 * The one sentence a reader sees while the claim is being patient.
 *
 * No machinery in it, by the rule that governs every other sentence on the
 * claim screen: no resolver, no contract, no sponsor, no DUST, no indexer.
 * What is true and useful is that the thing that registers names is busy, that
 * Passport is still working, and — through the countdown beside it — that
 * something is going to happen without the reader doing anything.
 */
export const CLAIM_RETRYING_SENTENCE = 'The name service is busy. Trying again…';

/**
 * The live line under it. `null` — and anything already due — is an attempt in
 * flight rather than a wait, and says so instead of counting down to zero and
 * sitting there.
 */
export function claimRetryLine(remainingMs: number | null): string {
  if (remainingMs === null || remainingMs <= 0) return 'Trying now…';
  const seconds = Math.ceil(remainingMs / 1_000);
  if (seconds < 60) return `Retrying in ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `Retrying in ${minutes} min` : `Retrying in ${minutes} min ${rest} s`;
}

/**
 * What the host tells the screen while a schedule is waiting.
 *
 * `dueAt` is `null` while an attempt is actually in flight, which is why this
 * is a shape rather than a timestamp: the panel stays up across both states —
 * with "Continue to Home" on it throughout — and only the line beneath it
 * changes.
 */
export interface ClaimRetryNotice {
  /** Attempts refused so far. One on the first refusal. */
  attempt: number;
  /** When the next attempt is due, or `null` while one is being made. */
  dueAt: number | null;
}

/** How one absorbed refusal ended. */
export type ClaimRetryOutcome =
  /** Wait over — ask again now. */
  | 'retry'
  /** The refusal is final: report it. */
  | 'final'
  /** The backoff or the window ran out: report the refusal. */
  | 'spent'
  /** The run was abandoned: report the refusal. */
  | 'cancelled';

export interface ClaimRetryRun {
  /** Attempts refused so far, for a caller that wants to say so in a log. */
  readonly attempt: number;
  /**
   * Decides what to do about one refusal and, for a retry, waits out the
   * backoff before resolving `'retry'`.
   */
  absorb(
    refusal: ClaimRefusal,
    onWait?: (notice: ClaimRetryNotice) => void,
  ): Promise<ClaimRetryOutcome>;
  /** Ends the current wait early — the reader pressed "Try now". */
  tryNow(): void;
  /** Abandons the run. A wait in progress resolves `'cancelled'`. */
  cancel(): void;
}

export interface ClaimRetryOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Starts a schedule. The clock starts HERE rather than at the first refusal, so
 * {@link CLAIM_RETRY_WINDOW_MS} bounds the whole registration — the attempts
 * included — rather than only the sleeping between attempts.
 *
 * Both the timer and the clock are injected so a test never really waits.
 */
export function startClaimRetry(options: ClaimRetryOptions = {}): ClaimRetryRun {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const startedAt = now();
  let attempt = 0;
  let cancelled = false;
  let wake: ((outcome: ClaimRetryOutcome) => void) | null = null;
  let timer: unknown = null;

  /* One way out of a wait, whoever ends it. A call with nothing waiting is a
     no-op rather than an error: "Try now" can be pressed while an attempt is
     already in flight, and a cancel arrives whenever the claim ends. */
  const settle = (outcome: ClaimRetryOutcome): void => {
    const resolve = wake;
    if (resolve === null) return;
    wake = null;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    resolve(outcome);
  };

  return {
    get attempt() {
      return attempt;
    },
    async absorb(refusal, onWait) {
      attempt += 1;
      if (cancelled) return 'cancelled';
      if (classifyClaimRefusal(refusal) === 'final') return 'final';
      const delayMs = claimRetryDelayMs({
        attempt: attempt - 1,
        elapsedMs: now() - startedAt,
        retryAfterMs: refusal.retryAfterMs ?? null,
      });
      if (delayMs === null) return 'spent';
      onWait?.({ attempt, dueAt: now() + delayMs });
      return await new Promise<ClaimRetryOutcome>((resolve) => {
        wake = resolve;
        timer = setTimer(() => {
          timer = null;
          settle('retry');
        }, delayMs);
      });
    },
    tryNow() {
      settle('retry');
    },
    cancel() {
      cancelled = true;
      settle('cancelled');
    },
  };
}

/**
 * The claim's registration step, made patient — the loop `App.tsx` runs around
 * `sponsorAliasRegistration`.
 *
 * It is here rather than inline in the claim for the reason the rest of this
 * module is: `App.tsx` cannot be drilled, and "a transient refusal followed by
 * a success lands the name and never shows the failure card" is precisely the
 * behaviour worth holding. The two things the host must keep are its own, and
 * are done in `onRefusal`: the account's activation grant is held the moment a
 * refusal is in hand (see `lib/activationHold.ts`), and a failure that is not a
 * sponsor refusal at all — the account deploy's own, most of all — is thrown
 * from there and outranks everything here.
 *
 * The refusal that ends the run is re-thrown UNCHANGED, so the caller's mapping
 * of it to a sentence, and the card the reader ends up looking at, are exactly
 * what they were before any of this existed.
 */
export async function withClaimRetry<T>(input: {
  run: ClaimRetryRun;
  /** One attempt at the registration. */
  attempt: () => Promise<T>;
  /**
   * Turns a thrown cause into the refusal to decide on. It may THROW instead,
   * for anything that is not a refusal this schedule may absorb.
   */
  onRefusal: (cause: unknown) => ClaimRefusal;
  /** Where the screen's notice goes. `null` clears it. */
  onNotice: (notice: ClaimRetryNotice | null) => void;
}): Promise<T> {
  for (;;) {
    try {
      return await input.attempt();
    } catch (cause) {
      const refusal = input.onRefusal(cause);
      const outcome = await input.run.absorb(refusal, input.onNotice);
      if (outcome !== 'retry') {
        input.onNotice(null);
        throw cause;
      }
      /* The wait is over and the next attempt is being made. The panel stays —
         with its way to Home on it — and only its countdown stands down. */
      input.onNotice({ attempt: input.run.attempt, dueAt: null });
    }
  }
}
