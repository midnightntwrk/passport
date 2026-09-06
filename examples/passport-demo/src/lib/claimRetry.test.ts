/**
 * The claim's patience, drilled — classification, backoff, bound, and the loop.
 *
 * The defect is in the module header: on 2026/09/05 the service could not
 * deploy the resolver leaf, said so, and the reader was handed a failure card
 * over a refusal that had nothing to do with them and would have cleared on its
 * own. The two halves worth holding here are opposite in spirit and both
 * matter — that a transient refusal is asked again and NEVER reaches the card,
 * and that a refusal which may already have registered the name is never asked
 * again at all.
 *
 * Every schedule below runs on an injected clock and an injected timer, so
 * nothing in this file waits for a real second.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CLAIM_RETRYING_SENTENCE,
  CLAIM_RETRY_DELAYS_MS,
  CLAIM_RETRY_WINDOW_MS,
  claimRetryDelayMs,
  claimRetryLine,
  classifyClaimRefusal,
  startClaimRetry,
  withClaimRetry,
  type ClaimRefusal,
  type ClaimRetryNotice,
} from './claimRetry.js';

/** One turn of the microtask queue, so a rejected attempt reaches the loop. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A refusal the service makes about its own work, unless told otherwise. */
const refusalOf = (code: string, over: Partial<ClaimRefusal> = {}): ClaimRefusal => ({
  code,
  worthRetrying: true,
  ...over,
});

/**
 * A timer that fires when this test says so, and a clock that moves when this
 * test says so. Returned together because a schedule reads both and a test that
 * advanced one without the other would be measuring a window that never moves.
 */
function fakeTimers() {
  let clock = 1_000;
  const pending: { fn: () => void; ms: number; handle: number }[] = [];
  let next = 1;
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const handle = next;
      next += 1;
      pending.push({ fn, ms, handle });
      return handle;
    },
    clearTimer: (handle: unknown) => {
      const at = pending.findIndex((entry) => entry.handle === handle);
      if (at >= 0) pending.splice(at, 1);
    },
    /** What the schedule asked to be woken after, for the newest wait. */
    waiting: () => pending.at(-1)?.ms ?? null,
    /** Moves the clock on and fires everything due. */
    advance: (ms: number) => {
      clock += ms;
      const due = pending.splice(0, pending.length);
      for (const entry of due) entry.fn();
    },
    /** Moves the clock WITHOUT firing anything — how the window is spent. */
    idle: (ms: number) => {
      clock += ms;
    },
  };
}

describe('classifyClaimRefusal', () => {
  /* The table, and it is the whole rule. The first group may already have put
     the name on chain or would fail identically; the second is the service
     failing at its own work, every one of which clears on its own. */
  const finals = [
    'registration-in-flight',
    'confirmation-failed',
    'bind-failed',
    'name-taken',
    'invalid-request',
    'invalid-name',
    'not-found',
    'rate-limited',
  ];
  const retries = [
    'deploy-failed',
    'register-rejected',
    'registry-unreachable',
    'target-missing',
    'unreachable',
    'internal',
    'funder-empty',
    'funder-no-dust',
    'WALLETS_UNAVAILABLE',
    'INSUFFICIENT_DUST',
    'WALLET_SYNCING',
    'PENDING_TRANSACTION',
  ];

  it.each(finals)('%s is final', (code) => {
    expect(classifyClaimRefusal(refusalOf(code))).toBe('final');
  });

  it.each(retries)('%s earns another attempt', (code) => {
    expect(classifyClaimRefusal(refusalOf(code))).toBe('retry');
  });

  it('takes the service’s own "not worth trying" as final, whatever the code', () => {
    /* `selfPayWorthTrying` is false for exactly the refusals the service cannot
       say landed or not. A code this module has never heard of, with that flag
       down, must not be asked again either. */
    expect(classifyClaimRefusal(refusalOf('something-new', { worthRetrying: false }))).toBe('final');
  });
});

describe('claimRetryDelayMs', () => {
  it('doubles to two minutes and then holds there', () => {
    const delays = CLAIM_RETRY_DELAYS_MS.map((_, attempt) =>
      claimRetryDelayMs({ attempt, elapsedMs: 0 }),
    );
    expect(delays).toEqual([10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);
  });

  it('is spent once the backoff runs out', () => {
    expect(claimRetryDelayMs({ attempt: CLAIM_RETRY_DELAYS_MS.length, elapsedMs: 0 })).toBeNull();
  });

  it('never takes a wait that would end past the window', () => {
    /* Five seconds left, and the schedule's own next wait is ten. The bound is
       the wall clock rather than the sum of the delays, because an ATTEMPT can
       take minutes and a schedule counting only its sleeps would run far past
       anything a person would call patient. */
    expect(claimRetryDelayMs({ attempt: 0, elapsedMs: CLAIM_RETRY_WINDOW_MS - 5_000 })).toBeNull();
    expect(claimRetryDelayMs({ attempt: 0, elapsedMs: CLAIM_RETRY_WINDOW_MS - 10_000 })).toBe(
      10_000,
    );
  });

  it('honours a retryAfterMs the service named', () => {
    expect(claimRetryDelayMs({ attempt: 0, elapsedMs: 0, retryAfterMs: 45_000 })).toBe(45_000);
  });

  it('clamps a retryAfterMs at both ends', () => {
    // A zero cannot spin, and one huge hint cannot swallow the whole window.
    expect(claimRetryDelayMs({ attempt: 0, elapsedMs: 0, retryAfterMs: 0 })).toBe(2_000);
    expect(claimRetryDelayMs({ attempt: 0, elapsedMs: 0, retryAfterMs: 900_000 })).toBe(120_000);
  });

  it('ignores a retryAfterMs that is not a usable number', () => {
    for (const retryAfterMs of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(claimRetryDelayMs({ attempt: 0, elapsedMs: 0, retryAfterMs })).toBe(10_000);
    }
  });
});

describe('claimRetryLine', () => {
  it('counts the seconds down', () => {
    expect(claimRetryLine(40_000)).toBe('Retrying in 40 s');
    // Rounded UP, so the line never says a second that has already gone.
    expect(claimRetryLine(9_100)).toBe('Retrying in 10 s');
  });

  it('says minutes once there are minutes to say', () => {
    expect(claimRetryLine(120_000)).toBe('Retrying in 2 min');
    expect(claimRetryLine(80_000)).toBe('Retrying in 1 min 20 s');
  });

  it('says an attempt is being made rather than counting to nothing', () => {
    expect(claimRetryLine(null)).toBe('Trying now…');
    expect(claimRetryLine(0)).toBe('Trying now…');
    expect(claimRetryLine(-5_000)).toBe('Trying now…');
  });

  it('has no machinery in the sentence beside it', () => {
    expect(CLAIM_RETRYING_SENTENCE).not.toMatch(
      /resolver|contract|sponsor|DUST|indexer|registry|wallet/i,
    );
  });
});

describe('startClaimRetry', () => {
  it('waits the backoff out and then asks again, counting the attempts', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    expect(run.attempt).toBe(0);

    const notices: ClaimRetryNotice[] = [];
    const first = run.absorb(refusalOf('deploy-failed'), (notice) => notices.push(notice));
    expect(run.attempt).toBe(1);
    expect(timers.waiting()).toBe(10_000);
    expect(notices).toEqual([{ attempt: 1, dueAt: 11_000 }]);
    timers.advance(10_000);
    await expect(first).resolves.toBe('retry');

    // The second refusal is given the second delay, not the first again.
    const second = run.absorb(refusalOf('deploy-failed'));
    expect(timers.waiting()).toBe(20_000);
    timers.advance(20_000);
    await expect(second).resolves.toBe('retry');
    expect(run.attempt).toBe(2);
  });

  it('waits as long as the service asked, where it asked', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    const waiting = run.absorb(refusalOf('WALLET_SYNCING', { retryAfterMs: 30_000 }));
    expect(timers.waiting()).toBe(30_000);
    timers.advance(30_000);
    await expect(waiting).resolves.toBe('retry');
  });

  it('reports a final refusal without waiting for anything', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    await expect(run.absorb(refusalOf('name-taken', { worthRetrying: false }))).resolves.toBe(
      'final',
    );
    expect(timers.waiting()).toBeNull();
  });

  it('reports the schedule spent once the window has gone', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    // The attempt itself took the whole window — the commonest way this ends.
    timers.idle(CLAIM_RETRY_WINDOW_MS);
    await expect(run.absorb(refusalOf('deploy-failed'))).resolves.toBe('spent');
    expect(timers.waiting()).toBeNull();
  });

  it('asks now when the reader presses Try now, and drops the timer', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    const waiting = run.absorb(refusalOf('deploy-failed'));
    run.tryNow();
    await expect(waiting).resolves.toBe('retry');
    // Cleared rather than left to fire into a wait that is over.
    expect(timers.waiting()).toBeNull();
  });

  it('is cancellable, mid-wait and before the next refusal alike', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    const waiting = run.absorb(refusalOf('deploy-failed'));
    run.cancel();
    await expect(waiting).resolves.toBe('cancelled');
    // And a run already abandoned absorbs nothing more.
    await expect(run.absorb(refusalOf('deploy-failed'))).resolves.toBe('cancelled');
  });

  it('ignores a Try now or a cancel with nothing waiting', () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    expect(() => {
      run.tryNow();
      run.cancel();
    }).not.toThrow();
  });

  it('runs on the real clock and the real timer by default', async () => {
    vi.useFakeTimers();
    try {
      const run = startClaimRetry();
      const waiting = run.absorb(refusalOf('deploy-failed'));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(waiting).resolves.toBe('retry');
      /* And the default `clearTimer` is exercised where a wait ends early —
         the "Try now" path, on the timers the browser actually provides. */
      const second = run.absorb(refusalOf('deploy-failed'));
      run.tryNow();
      await expect(second).resolves.toBe('retry');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withClaimRetry', () => {
  /**
   * THE ONE THIS EXISTS FOR. A transient refusal followed by a success must
   * land the name and never reach the failure card — which, on the claim
   * screen, is exactly "the host was never given an error to show".
   */
  it('lands the name after a transient refusal, with nothing thrown', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    const notices: (ClaimRetryNotice | null)[] = [];
    const refused = new Error('deploy-failed');
    let calls = 0;
    const attempt = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(refused)
        : Promise.resolve({ alias: 'alice', registryConfirmed: true });
    });

    const claim = withClaimRetry({
      run,
      attempt,
      onRefusal: () => refusalOf('deploy-failed'),
      onNotice: (notice) => notices.push(notice),
    });
    // The wait is real, and the reader is told about it while it lasts.
    await tick();
    expect(notices).toEqual([{ attempt: 1, dueAt: 11_000 }]);
    timers.advance(10_000);

    await expect(claim).resolves.toEqual({ alias: 'alice', registryConfirmed: true });
    expect(attempt).toHaveBeenCalledTimes(2);
    /* The SAME result the first attempt would have returned, so everything the
       host does with it — the record, the activity row, the toast — is what a
       first-try success produces. And the countdown stood down while the second
       attempt was in flight, with the panel and its way to Home still up. */
    expect(notices.at(-1)).toEqual({ attempt: 1, dueAt: null });
  });

  it('re-throws the refusal unchanged once the schedule is spent', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    const notices: (ClaimRetryNotice | null)[] = [];
    const refused = new Error('the service could not deploy the leaf');
    timers.idle(CLAIM_RETRY_WINDOW_MS);

    await expect(
      withClaimRetry({
        run,
        attempt: () => Promise.reject(refused),
        onRefusal: () => refusalOf('deploy-failed'),
        onNotice: (notice) => notices.push(notice),
      }),
      /* Unchanged: the caller's mapping of a refusal to a sentence, and the
         card the reader ends up on, are what they were before the schedule
         existed. */
    ).rejects.toBe(refused);
    // And the notice is cleared, so no countdown outlives the run.
    expect(notices).toEqual([null]);
  });

  it('stops at once on a refusal that may already have registered the name', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    const refused = new Error('confirmation-failed');
    const attempt = vi.fn(() => Promise.reject(refused));

    await expect(
      withClaimRetry({
        run,
        attempt,
        onRefusal: () => refusalOf('confirmation-failed', { worthRetrying: false }),
        onNotice: () => {},
      }),
    ).rejects.toBe(refused);
    // ONE call. A second would be the double registration this guards.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('lets the host throw something that outranks the name service', async () => {
    const timers = fakeTimers();
    const run = startClaimRetry(timers);
    /* The account deploy's own failure, which the claim reads synchronously in
       `App.tsx` and throws from `onRefusal`: there is nothing for a patient
       retry to wait for when the account the name would point at is gone. */
    const deployFailed = new Error('your Passport account could not be set up');
    const attempt = vi.fn(() => Promise.reject(new Error('target-missing')));

    await expect(
      withClaimRetry({
        run,
        attempt,
        onRefusal: () => {
          throw deployFailed;
        },
        onNotice: () => {},
      }),
    ).rejects.toBe(deployFailed);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
