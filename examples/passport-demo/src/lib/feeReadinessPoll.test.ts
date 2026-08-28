/**
 * The sponsor watcher, driven on a fake clock.
 *
 * What is being held to a standard here is the behaviour the dead-modal defect
 * needed and did not have: that a surface which opened while the sponsor was
 * busy finds out, on its own, when the sponsor comes back — and that the
 * sponsor's diagnostic goes to a log rather than towards a screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeeReadiness } from './localWallet.js';
import {
  FEE_READINESS_POLL_INTERVAL_MS,
  startFeeReadinessPoll,
  type FeeReadinessSnapshot,
} from './feeReadinessPoll.js';

const SPONSORED: FeeReadiness = { mode: 'sponsored' };

const busy = (detail: string): FeeReadiness => ({
  mode: 'unsponsored',
  reason:
    'Network fees on this Passport are covered by the fee sponsor, and the sponsor cannot cover this one right now.',
  cause: 'busy',
  detail,
});

/** The live detail that reached a user's screen on 2026/08/25. */
const LIVE_DETAIL = 'sponsor reports 0/1 wallets available (#0 dust 4993664979775282371)';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets every queued microtask run without advancing the fake clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('startFeeReadinessPoll', () => {
  it('probes at once, and says it is probing before it has an answer', async () => {
    const seen: FeeReadinessSnapshot[] = [];
    const poll = startFeeReadinessPoll({
      probe: async () => SPONSORED,
      onChange: (snapshot) => seen.push(snapshot),
      log: () => {},
    });
    // The first change is published synchronously, before any await.
    expect(seen).toEqual([{ fee: null, error: null, probing: true }]);
    await settle();
    expect(seen.at(-1)).toEqual({ fee: SPONSORED, error: null, probing: false });
    poll.stop();
  });

  it('enables itself the moment the sponsor flips to available', async () => {
    /* The whole point. The surface asks once, is told no, and is then told yes
       without anybody having closed and reopened anything. */
    let answer: FeeReadiness = busy(LIVE_DETAIL);
    const probe = vi.fn(async () => answer);
    const seen: FeeReadinessSnapshot[] = [];
    const poll = startFeeReadinessPoll({
      probe,
      onChange: (snapshot) => seen.push(snapshot),
      log: () => {},
    });

    await settle();
    expect(seen.at(-1)?.fee).toEqual(busy(LIVE_DETAIL));
    expect(probe).toHaveBeenCalledTimes(1);

    // Nothing happens in between: the tick is the interval, not a spin.
    await vi.advanceTimersByTimeAsync(FEE_READINESS_POLL_INTERVAL_MS - 1);
    expect(probe).toHaveBeenCalledTimes(1);

    // The sponsor's DUST comes back, as it does within a minute or two.
    answer = SPONSORED;
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toEqual({ fee: SPONSORED, error: null, probing: false });

    // And it keeps watching, because a sponsor can drain again.
    await vi.advanceTimersByTimeAsync(FEE_READINESS_POLL_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it('probes immediately when asked again, and re-arms the interval from there', async () => {
    const probe = vi.fn(async () => busy(LIVE_DETAIL));
    const poll = startFeeReadinessPoll({
      probe,
      onChange: () => {},
      log: () => {},
    });
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);

    // "Check again", three seconds in: now, not in another two.
    await vi.advanceTimersByTimeAsync(3_000);
    poll.checkAgain();
    await settle();
    expect(probe).toHaveBeenCalledTimes(2);

    /* The cancelled tick does not fire late: the clock that would have run it
       is past, and the next probe is a full interval after the manual one. */
    await vi.advanceTimersByTimeAsync(FEE_READINESS_POLL_INTERVAL_MS - 1);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it('never runs two probes at once, however often it is asked', async () => {
    let release: (readiness: FeeReadiness) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<FeeReadiness>((resolve) => {
          release = resolve;
        }),
    );
    const poll = startFeeReadinessPoll({ probe, onChange: () => {}, log: () => {} });
    expect(probe).toHaveBeenCalledTimes(1);
    poll.checkAgain();
    poll.checkAgain();
    expect(probe).toHaveBeenCalledTimes(1);
    release(SPONSORED);
    await settle();
    poll.stop();
  });

  it('sends the sponsor’s diagnostic to the log, once, and nowhere else', async () => {
    /* The defect this half fixes: "0/1 wallets available (#0 dust …)" reached a
       user's screen. It is a fact about a wallet that is not theirs, and it now
       goes only here. Once per distinct value — a sheet left open for a minute
       must not write the same line twelve times. */
    const logged: string[] = [];
    const answers: FeeReadiness[] = [
      busy(LIVE_DETAIL),
      busy(LIVE_DETAIL),
      busy('sponsor reports 0/2 wallets available (#0 dust 0, #1 dust 12)'),
      SPONSORED,
    ];
    let index = 0;
    const poll = startFeeReadinessPoll({
      probe: async () => answers[Math.min(index++, answers.length - 1)],
      onChange: (snapshot) => {
        // Nothing a surface reads carries the diagnostic in its sentence.
        if (snapshot.fee?.mode === 'unsponsored') {
          expect(snapshot.fee.reason).not.toMatch(/\d/);
        }
      },
      log: (message) => logged.push(message),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(FEE_READINESS_POLL_INTERVAL_MS * 3);
    expect(logged).toEqual([
      `Fee sponsor busy: ${LIVE_DETAIL}`,
      'Fee sponsor busy: sponsor reports 0/2 wallets available (#0 dust 0, #1 dust 12)',
    ]);
    poll.stop();
  });

  it('logs through console.info when no log is supplied', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const poll = startFeeReadinessPoll({ probe: async () => busy('detail'), onChange: () => {} });
    await settle();
    expect(info).toHaveBeenCalledWith('Fee sponsor busy: detail');
    poll.stop();
    info.mockRestore();
  });

  it('says nothing to the log when the sponsor is fine, or names no detail', async () => {
    const logged: string[] = [];
    const answers: FeeReadiness[] = [
      SPONSORED,
      { mode: 'unsponsored', reason: 'no sponsor here', cause: 'disabled', detail: null },
    ];
    let index = 0;
    const poll = startFeeReadinessPoll({
      probe: async () => answers[Math.min(index++, answers.length - 1)],
      onChange: () => {},
      log: (message) => logged.push(message),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(FEE_READINESS_POLL_INTERVAL_MS);
    expect(logged).toEqual([]);
    poll.stop();
  });

  it('reports a probe that threw as an error, and keeps watching', async () => {
    /* A probe that throws is "we could not tell", which is a different sentence
       from "the sponsor is not covering this" — and it must not stop the watch,
       because a closed wallet reopens. */
    const answers = [
      () => Promise.reject(new Error('The Passport signing session is not open.')),
      () => Promise.reject('a string, from somewhere careless'),
      () => Promise.resolve(SPONSORED),
    ];
    let index = 0;
    const seen: FeeReadinessSnapshot[] = [];
    const poll = startFeeReadinessPoll({
      probe: () => answers[Math.min(index++, answers.length - 1)](),
      onChange: (snapshot) => seen.push(snapshot),
      log: () => {},
      intervalMs: 1_000,
    });
    await settle();
    expect(seen.at(-1)).toEqual({
      fee: null,
      error: 'The Passport signing session is not open.',
      probing: false,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen.at(-1)?.error).toBe('a string, from somewhere careless');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen.at(-1)).toEqual({ fee: SPONSORED, error: null, probing: false });
    poll.stop();
  });

  it('drops an answer that arrives after it was stopped, and never ticks again', async () => {
    let release: (readiness: FeeReadiness) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<FeeReadiness>((resolve) => {
          release = resolve;
        }),
    );
    const seen: FeeReadinessSnapshot[] = [];
    const poll = startFeeReadinessPoll({
      probe,
      onChange: (snapshot) => seen.push(snapshot),
      log: () => {},
    });
    expect(seen).toHaveLength(1);
    poll.stop();
    release(SPONSORED);
    await settle();
    // No second publish: the sheet is gone, and setting state on it would be a
    // React warning at best.
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FEE_READINESS_POLL_INTERVAL_MS * 3);
    expect(probe).toHaveBeenCalledTimes(1);
    // And asking a stopped watcher again does nothing at all.
    poll.checkAgain();
    expect(probe).toHaveBeenCalledTimes(1);
    // Stopping twice is not an error either.
    poll.stop();
  });

  it('drops a REJECTION that arrives after it was stopped', async () => {
    let fail: (cause: unknown) => void = () => {};
    const seen: FeeReadinessSnapshot[] = [];
    const poll = startFeeReadinessPoll({
      probe: () =>
        new Promise<FeeReadiness>((_resolve, reject) => {
          fail = reject;
        }),
      onChange: (snapshot) => seen.push(snapshot),
      log: () => {},
    });
    poll.stop();
    fail(new Error('too late'));
    await settle();
    expect(seen).toHaveLength(1);
  });
});
