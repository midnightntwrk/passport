/**
 * The confirm-time re-check, on a stopwatch nobody has to sit through.
 *
 * The case being held to a standard is the one that reached production on
 * 2026/09/08: the sponsor busy with its own settlement for well under a minute
 * and a person told, twice, that the fee arrangement had changed when it had
 * not. A re-check that waits that out must still refuse a real change at once,
 * in both directions, and must still give up when the wait does not help.
 */

import { describe, expect, it } from 'vitest';

import type { FeeReadiness } from './localWallet.js';
import {
  FEE_RECHECK_BACKOFF_MS,
  feeRefusalWillClear,
  settleFeeRecheck,
} from './feeRecheck.js';

const SPONSORED: FeeReadiness = { mode: 'sponsored' };

const BUSY: FeeReadiness = {
  mode: 'unsponsored',
  reason:
    'Network fees on this Passport are covered by the fee sponsor, and the sponsor cannot cover this one right now.',
  cause: 'busy',
  detail: 'sponsor reports 0/1 wallets available (#0 dust 4993664979775282371)',
};

const UNREACHABLE: FeeReadiness = {
  mode: 'unsponsored',
  reason:
    'Network fees on this Passport are covered by the fee sponsor, and the fee sponsor cannot be reached right now.',
  cause: 'unreachable',
  detail: 'wallet-status could not be fetched, twice: The operation was aborted due to timeout',
};

const DISABLED: FeeReadiness = {
  mode: 'unsponsored',
  reason:
    'Network fees on this Passport are covered by the fee sponsor, and this build has no sponsor configured, so nothing can be submitted.',
  cause: 'disabled',
  detail: null,
};

/** A sleep that records what it was asked to wait and waits none of it. */
const stopwatch = () => {
  const waited: number[] = [];
  return {
    waited,
    sleep: (milliseconds: number): Promise<void> => {
      waited.push(milliseconds);
      return Promise.resolve();
    },
  };
};

/** Answers each call from a script, so a recovery can be placed exactly. */
const answers = (...script: FeeReadiness[]) => {
  let call = 0;
  return {
    calls: () => call,
    probe: (): Promise<FeeReadiness> => Promise.resolve(script[Math.min(call++, script.length - 1)]),
  };
};

describe('which refusals are worth waiting out', () => {
  it('waits out a sponsor whose DUST is spoken for', () => {
    expect(feeRefusalWillClear(BUSY)).toBe(true);
  });

  it('waits out a sponsor that did not answer this time', () => {
    expect(feeRefusalWillClear(UNREACHABLE)).toBe(true);
  });

  it('does not wait out a build with no sponsor at all', () => {
    expect(feeRefusalWillClear(DISABLED)).toBe(false);
  });

  it('does not treat a covered fee as a refusal', () => {
    expect(feeRefusalWillClear(SPONSORED)).toBe(false);
  });
});

describe('settling the fee re-check on confirm', () => {
  it('sends straight away when the sponsor is still doing what was promised', async () => {
    const seen: FeeReadiness[] = [];
    let waits = 0;
    const outcome = await settleFeeRecheck({
      quoted: 'sponsored',
      first: SPONSORED,
      probe: (): Promise<FeeReadiness> => {
        throw new Error('the sponsor must not be asked again');
      },
      onReadiness: (readiness) => seen.push(readiness),
      onWaiting: () => {
        waits += 1;
      },
      sleep: stopwatch().sleep,
    });
    expect(outcome).toEqual({ agreed: true, readiness: SPONSORED, probes: 0 });
    expect(seen).toEqual([]);
    // No wait began, so nothing tells the sheet it is checking the fee.
    expect(waits).toBe(0);
  });

  it('waits out a busy sponsor and sends once it comes back', async () => {
    /* THE 2026/09/08 CASE. The sponsor had just landed a spend of its own and
       had nothing free for a few seconds. Nothing had changed. */
    const clock = stopwatch();
    const sponsor = answers(SPONSORED);
    const seen: FeeReadiness[] = [];
    let waits = 0;
    const outcome = await settleFeeRecheck({
      quoted: 'sponsored',
      first: BUSY,
      probe: sponsor.probe,
      onReadiness: (readiness) => seen.push(readiness),
      onWaiting: () => {
        waits += 1;
      },
      sleep: clock.sleep,
    });
    expect(outcome).toEqual({ agreed: true, readiness: SPONSORED, probes: 1 });
    // Said once, however many times the sponsor is asked.
    expect(waits).toBe(1);
    // The first step of the published backoff, and only the first.
    expect(clock.waited).toEqual([FEE_RECHECK_BACKOFF_MS[0]]);
    expect(sponsor.calls()).toBe(1);
    // The fee line was told, so it is showing the answer the send went on.
    expect(seen).toEqual([SPONSORED]);
  });

  it('keeps asking, on the published backoff, until it comes back', async () => {
    const clock = stopwatch();
    const sponsor = answers(BUSY, BUSY, SPONSORED);
    const outcome = await settleFeeRecheck({
      quoted: 'sponsored',
      first: BUSY,
      probe: sponsor.probe,
      onReadiness: () => {},
      onWaiting: () => {},
      sleep: clock.sleep,
    });
    expect(outcome.agreed).toBe(true);
    expect(outcome.probes).toBe(3);
    expect(clock.waited).toEqual(FEE_RECHECK_BACKOFF_MS.slice(0, 3));
  });

  it('gives up after the whole window and reports the refusal', async () => {
    const clock = stopwatch();
    const sponsor = answers(BUSY);
    const outcome = await settleFeeRecheck({
      quoted: 'sponsored',
      first: BUSY,
      probe: sponsor.probe,
      onReadiness: () => {},
      onWaiting: () => {},
      sleep: clock.sleep,
    });
    expect(outcome).toEqual({ agreed: false, readiness: BUSY, probes: 4 });
    expect(clock.waited).toEqual([...FEE_RECHECK_BACKOFF_MS]);
    // Twenty seconds, said as a sum rather than as four numbers.
    expect(clock.waited.reduce((total, step) => total + step, 0)).toBe(20_000);
  });

  it('reports a sponsor that stood down properly without waiting at all', async () => {
    const outcome = await settleFeeRecheck({
      quoted: 'sponsored',
      first: DISABLED,
      probe: (): Promise<FeeReadiness> => {
        throw new Error('a build with no sponsor must not be asked again');
      },
      onReadiness: () => {},
      onWaiting: () => {},
      sleep: stopwatch().sleep,
    });
    expect(outcome).toEqual({ agreed: false, readiness: DISABLED, probes: 0 });
  });

  it('stops asking the moment a wait turns into a real refusal', async () => {
    const clock = stopwatch();
    const sponsor = answers(BUSY, DISABLED, SPONSORED);
    const outcome = await settleFeeRecheck({
      quoted: 'sponsored',
      first: BUSY,
      probe: sponsor.probe,
      onReadiness: () => {},
      onWaiting: () => {},
      sleep: clock.sleep,
    });
    expect(outcome).toEqual({ agreed: false, readiness: DISABLED, probes: 2 });
    expect(sponsor.calls()).toBe(2);
  });

  it('reports a fee that has become covered, which is a change like any other', async () => {
    /* The other direction. Somebody who confirmed against "you are paying this
       one yourself" is not sent on a different arrangement without being told,
       however much better the new one is. */
    const outcome = await settleFeeRecheck({
      quoted: 'unsponsored',
      first: SPONSORED,
      probe: (): Promise<FeeReadiness> => {
        throw new Error('a changed arrangement must not be waited out');
      },
      onReadiness: () => {},
      onWaiting: () => {},
      sleep: stopwatch().sleep,
    });
    expect(outcome).toEqual({ agreed: false, readiness: SPONSORED, probes: 0 });
  });

  it('does not wait when there was no quote to get back to', async () => {
    /* The fee line said "could not check". There is no arrangement for the
       sponsor to return to, so a wait would prove nothing. */
    const outcome = await settleFeeRecheck({
      quoted: null,
      first: BUSY,
      probe: (): Promise<FeeReadiness> => {
        throw new Error('an unread quote must not be waited out');
      },
      onReadiness: () => {},
      onWaiting: () => {},
      sleep: stopwatch().sleep,
    });
    expect(outcome).toEqual({ agreed: false, readiness: BUSY, probes: 0 });
  });

  it('waits on a real clock when it is not given one', async () => {
    const sponsor = answers(SPONSORED);
    const before = Date.now();
    const outcome = await settleFeeRecheck({
      quoted: 'sponsored',
      first: UNREACHABLE,
      probe: sponsor.probe,
      onReadiness: () => {},
      onWaiting: () => {},
      delaysMs: [5],
    });
    expect(outcome.agreed).toBe(true);
    expect(Date.now() - before).toBeGreaterThanOrEqual(4);
  });
});
