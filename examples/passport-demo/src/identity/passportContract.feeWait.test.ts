import { afterEach, describe, expect, it, vi } from 'vitest';

import { endFeeWait, feeWaitState } from '../lib/claimSteps.js';
import type { SponsorReadiness } from '../lib/sponsor.js';

import {
  FEE_WAIT_POLL_INTERVAL_MS,
  FEE_WAIT_WINDOW_MS,
  checkPassportContractFunds,
} from './passportContract.js';

/**
 * Drills for the ONE gate that stands between a person pressing claim and a
 * prover running: can the fee sponsor pay for this?
 *
 * Until 2026/09/02 it asked once and refused on the answer, which is a
 * misreading of what the answer means. The sponsor reserves its DUST against
 * every transaction it is balancing, so `available: 0` describes the next
 * minute rather than the day. Measured on the deployed balancer that day: a
 * second Passport claimed twenty seconds after a first was refused HERE, in
 * about two seconds, three times out of three — before any authenticator was
 * touched — while the sponsor was perfectly able to pay by the time the refusal
 * finished painting. A pair of Passports IS the demo.
 *
 * So what is held here is the shape of the fix rather than a call count: a busy
 * sponsor is waited out and the claim proceeds; a sponsor that never comes back
 * is refused, but only after the whole window; a build with no sponsor at all
 * is refused at once, because nothing about that clears with time; and the wait
 * is PUBLISHED throughout and cleared on every exit, because a wait nobody is
 * told about is indistinguishable from a hang.
 *
 * Everything is injected — the probe, the clock, and the sleep — so the three
 * minutes this waits in the world cost nothing here.
 */

const READY: SponsorReadiness = { state: 'ready', url: 'https://sponsor', available: 1 };
const BUSY: SponsorReadiness = {
  state: 'unavailable',
  url: 'https://sponsor',
  reason: 'sponsor reports 0/1 wallets available',
  cause: 'busy',
};
const UNREACHABLE: SponsorReadiness = {
  state: 'unavailable',
  url: 'https://sponsor',
  reason: 'wallet-status could not be fetched, twice',
  cause: 'unreachable',
};
const DISABLED: SponsorReadiness = { state: 'disabled' };

/** A clock that only moves when the wait sleeps, so the window is exact. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}

describe('checkPassportContractFunds', () => {
  afterEach(() => {
    endFeeWait();
  });

  it('proceeds on the first answer, and never announces a wait it did not have', async () => {
    const readiness = vi.fn(async (_force: boolean) => READY);
    expect(await checkPassportContractFunds({ readiness, ...fakeClock() })).toEqual({ ok: true });
    /* One probe, uncached-flag false: the first read is allowed to be the
       cheap one every other fee gate on the page has already paid for. */
    expect(readiness.mock.calls).toEqual([[false]]);
    expect(feeWaitState().waiting).toBe(false);
  });

  it('waits out a busy sponsor and then proceeds — the second Passport of a pair', async () => {
    /* The measured fault, in miniature: the sponsor says `available: 0` for the
       first minute of the window because the first Passport's own deploy has
       its only fee-capable coin booked, and then it can pay. Before this it was
       three refusals out of three attempts. */
    const clock = fakeClock();
    let call = 0;
    const readiness = vi.fn(async (_force: boolean) => {
      call += 1;
      return call <= 15 ? BUSY : READY;
    });
    expect(await checkPassportContractFunds({ readiness, ...clock })).toEqual({ ok: true });
    expect(readiness).toHaveBeenCalledTimes(16);
    /* Every probe after the first bypasses the readiness cache. A watcher that
       read a thirty-second cache would tell somebody to keep waiting for half
       the time they had already been free. */
    expect(readiness.mock.calls.slice(1).every(([force]) => force === true)).toBe(true);
    // The window was nowhere near spent: 15 sleeps of the poll interval.
    expect(clock.now()).toBe(15 * FEE_WAIT_POLL_INTERVAL_MS);
  });

  it('waits out an unreachable sponsor too, and comes back when it answers', async () => {
    /* `unreachable` is not a verdict about DUST — `lib/sponsor.ts` reports it
       only after two failed probes of its own — and the deployed service
       demonstrably returns from it. There is nothing the reader could do with
       the distinction, so it is waited out exactly like `busy`. */
    let call = 0;
    const readiness = vi.fn(async () => {
      call += 1;
      return call <= 3 ? UNREACHABLE : READY;
    });
    expect(await checkPassportContractFunds({ readiness, ...fakeClock() })).toEqual({ ok: true });
    expect(readiness).toHaveBeenCalledTimes(4);
  });

  it('refuses at once, with no wait at all, when the build has no sponsor', async () => {
    /* The one refusal time cannot fix. Three minutes of a counting timer before
       saying so would be the same lie told slowly. */
    const clock = fakeClock();
    const readiness = vi.fn(async () => DISABLED);
    const answer = await checkPassportContractFunds({ readiness, ...clock });
    expect(answer.ok).toBe(false);
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(0);
    expect(answer.ok === false && answer.reason).toMatch(/no sponsor configured/i);
  });

  it('refuses when the sponsor stands down mid-wait, without spending the window', async () => {
    const clock = fakeClock();
    let call = 0;
    const readiness = vi.fn(async () => {
      call += 1;
      return call === 1 ? BUSY : DISABLED;
    });
    const answer = await checkPassportContractFunds({ readiness, ...clock });
    expect(answer.ok).toBe(false);
    expect(readiness).toHaveBeenCalledTimes(2);
    expect(clock.now()).toBe(FEE_WAIT_POLL_INTERVAL_MS);
  });

  it('refuses only once the whole window is exhausted, with the sponsor’s own reason', async () => {
    const clock = fakeClock();
    const readiness = vi.fn(async () => BUSY);
    const answer = await checkPassportContractFunds({ readiness, ...clock });
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toBe(
      'Network fees on this Passport are covered by the fee sponsor, and the sponsor cannot cover this one right now.',
    );
    /* Three minutes, asked every four seconds: the window is spent, not
       abandoned early, and the count is what the two constants say it is. */
    expect(clock.now()).toBeGreaterThanOrEqual(FEE_WAIT_WINDOW_MS);
    expect(readiness).toHaveBeenCalledTimes(FEE_WAIT_WINDOW_MS / FEE_WAIT_POLL_INTERVAL_MS + 1);
  });

  it('never puts a figure or a machinery word in the refusal it hands the screen', async () => {
    /* The sponsor's own diagnostic — wallet indices, DUST balances — travels in
       `reason` on the readiness and belongs in a log. What comes out of here is
       read by a person who holds none of it. */
    const answer = await checkPassportContractFunds({
      readiness: async () => BUSY,
      windowMs: 0,
      ...fakeClock(),
    });
    expect(answer.ok === false && answer.reason).not.toMatch(/DUST|wallet-status|0\/1|\d{6}/);
  });

  it('publishes the wait while it waits, and clears it on every way out', async () => {
    const during: boolean[] = [];
    let call = 0;
    const readiness = vi.fn(async () => {
      during.push(feeWaitState().waiting);
      call += 1;
      return call <= 2 ? BUSY : READY;
    });
    await checkPassportContractFunds({ readiness, ...fakeClock() });
    // First probe before any wait; the two after it are inside one.
    expect(during).toEqual([false, true, true]);
    expect(feeWaitState().waiting).toBe(false);

    // And on the refusing exit as well, so a failed claim leaves no ghost line.
    await checkPassportContractFunds({
      readiness: async () => BUSY,
      windowMs: 0,
      ...fakeClock(),
    });
    expect(feeWaitState().waiting).toBe(false);
  });

  it('waits with a real clock when none is injected, and does not spin', async () => {
    /* The defaults are the deployed behaviour, so they are exercised rather
       than assumed: a zero window still takes the wait's own exit path, and the
       default sleep is a real `setTimeout` on a fake timer. */
    vi.useFakeTimers();
    try {
      let call = 0;
      const pending = checkPassportContractFunds({
        readiness: async () => {
          call += 1;
          return call === 1 ? BUSY : READY;
        },
        intervalMs: 10,
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
