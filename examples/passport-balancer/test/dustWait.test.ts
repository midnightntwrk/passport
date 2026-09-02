/**
 * Waiting for a coin instead of refusing the first claim of an onboarding.
 *
 * THE FAILURE, with a measurement against it. The sponsor holds ONE DUST coin
 * above the fee floor. During onboarding the user's own account deploy books it
 * for about 100 s, and the registration the click fires arrives inside that
 * window — so on the deployed balancer a FIRST name claim failed 5/5 times
 * about sixty seconds after the click, `/register-alias` answering 502 with
 * `DustUnavailable: no DUST coin was free to pay this transaction's fee` in the
 * journal. The user pressed Claim a second time and it completed in 52–58 s,
 * because by then the coin was back.
 *
 * Nothing was wrong except the budget: the registration path passed
 * `waitForDustMs: 0`, so its fee estimate gave up the instant it found no coin.
 * The budget inside the job stays zero — a job that waits holds a lane, which
 * is what blocked every other spend for ten minutes on 2026/09/02 — and the
 * wait moves OUTSIDE the queue, where it holds nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withNodeRejectionRetry } from '../src/account.js';
import {
  DustUnavailable,
  DustWaitExhausted,
  isDustShortfall,
  withDustWait,
} from '../src/wallet.js';

/** Exactly what midnight-js handed back on the live run at 20:36 on 2026/09/02. */
const AS_MIDNIGHT_JS_REWRAPS_IT = new Error(
  "Unexpected error submitting scoped transaction '<unnamed>': DustUnavailable: no DUST coin was free to pay this transaction's fee: Insufficient Funds: could not balance dust",
);

describe('the priority a wait must not cost the caller', () => {
  /* Measured live on 2026/09/02: the registration of `bwmtkkh613ar8.night`
     stepped outside the queue at 20:47:26, the two activation grants behind it
     took the coins that came free at 20:48:31 and 20:49:14, and the first click
     reached Home in 173.3 s against a bar of 120 s. */
  it('holds the queue for the length of the wait, and lets go once the rebuild is on it', async () => {
    const log: string[] = [];
    let attempts = 0;
    const spend = async (): Promise<string> => {
      attempts += 1;
      if (attempts === 1) throw new DustUnavailable('could not balance dust');
      log.push('rebuilt');
      return 'registered';
    };

    const result = await withDustWait(spend, {
      label: 'the registration of alice.night',
      windowMs: 240_000,
      awaitFreeCoin: async () => {
        log.push('waiting');
        return true;
      },
      holdWhileWaiting: () => {
        log.push('held');
        return () => log.push('released');
      },
      log: () => {},
    });

    assert.equal(result, 'registered');
    assert.deepEqual(log, ['held', 'waiting', 'rebuilt', 'released']);
  });

  it('lets go when the window is exhausted, so a refusal frees the queue', async () => {
    const log: string[] = [];
    await assert.rejects(
      withDustWait(
        async () => {
          throw new DustUnavailable('could not balance dust');
        },
        {
          label: 'the registration of alice.night',
          windowMs: 30_000,
          awaitFreeCoin: async () => false,
          holdWhileWaiting: () => {
            log.push('held');
            return () => log.push('released');
          },
          log: () => {},
        },
      ),
      DustWaitExhausted,
    );
    assert.deepEqual(log, ['held', 'released']);
  });

  it('takes no hold at all when nothing had to wait', async () => {
    const log: string[] = [];
    await withDustWait(async () => 'registered', {
      label: 'the registration of alice.night',
      windowMs: 240_000,
      awaitFreeCoin: async () => true,
      holdWhileWaiting: () => {
        log.push('held');
        return () => log.push('released');
      },
      log: () => {},
    });
    assert.deepEqual(log, []);
  });

  it('lets go when the spend fails for a reason waiting cannot mend', async () => {
    const log: string[] = [];
    let attempts = 0;
    await assert.rejects(
      withDustWait(
        async () => {
          attempts += 1;
          if (attempts === 1) throw new DustUnavailable('could not balance dust');
          throw new Error('the circuit refused');
        },
        {
          label: 'the registration of alice.night',
          windowMs: 240_000,
          awaitFreeCoin: async () => true,
          holdWhileWaiting: () => {
            log.push('held');
            return () => log.push('released');
          },
          log: () => {},
        },
      ),
      /the circuit refused/,
    );
    assert.deepEqual(log, ['held', 'released']);
  });
});

describe('recognising our own DUST shortfall through a re-wrap', () => {
  it('sees the class itself', () => {
    assert.equal(isDustShortfall(new DustUnavailable('could not balance dust')), true);
  });

  it('sees it through a `cause` chain', () => {
    assert.equal(
      isDustShortfall(new Error('deploy failed', { cause: new DustUnavailable('x') })),
      true,
    );
  });

  it('sees it in the text midnight-js re-raises, which carries no cause at all', () => {
    assert.equal(isDustShortfall(AS_MIDNIGHT_JS_REWRAPS_IT), true);
  });

  it('does NOT claim somebody else’s insufficient funds', () => {
    /* The SDK's own phrase, without our class name: a caller's transaction
       being short is not this service waiting for its own coin. */
    assert.equal(isDustShortfall(new Error('Insufficient Funds: could not balance dust')), false);
  });

  it('does not claim an unrelated failure', () => {
    assert.equal(isDustShortfall(new Error('call to a circuit that does not exist')), false);
  });
});

/** A clock a test can move, so a thirty-second wait costs no wall-clock time. */
const clockFrom = (start = 0): { now: () => number; advance: (ms: number) => void } => {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
};

const silent = (): void => undefined;

describe('waiting for a fee-capable coin', () => {
  it('runs the registration when a coin comes free at t+30 s', async () => {
    const clock = clockFrom();
    let attempts = 0;
    const spend = async (): Promise<string> => {
      attempts += 1;
      if (attempts === 1) throw new DustUnavailable('insufficient funds to cover the dust fee');
      return 'registered';
    };
    let asked = 0;
    const result = await withDustWait(spend, {
      label: 'the registration of alice.night',
      windowMs: 240_000,
      awaitFreeCoin: async (maxMs) => {
        asked += 1;
        assert.equal(maxMs, 240_000, 'the whole remaining window is offered to the wait');
        clock.advance(30_000);
        return true;
      },
      now: clock.now,
      log: silent,
    });
    assert.equal(result, 'registered');
    assert.equal(attempts, 2, 'the spend is REBUILT after the wait, not resubmitted');
    assert.equal(asked, 1);
  });

  it('offers only what is left of the window to a second wait', async () => {
    const clock = clockFrom();
    let attempts = 0;
    const offered: number[] = [];
    const result = await withDustWait(
      async () => {
        attempts += 1;
        if (attempts <= 2) throw new DustUnavailable('could not balance dust');
        return 'registered';
      },
      {
        label: 'a registration',
        windowMs: 240_000,
        awaitFreeCoin: async (maxMs) => {
          offered.push(maxMs);
          clock.advance(30_000);
          return true;
        },
        now: clock.now,
        log: silent,
      },
    );
    assert.equal(result, 'registered');
    assert.deepEqual(offered, [240_000, 210_000]);
  });

  it('refuses with a typed shortfall, and a retry-after, when the window is exhausted', async () => {
    const clock = clockFrom();
    let attempts = 0;
    await assert.rejects(
      () =>
        withDustWait(
          async () => {
            attempts += 1;
            throw new DustUnavailable('insufficient funds');
          },
          {
            label: 'the registration of alice.night',
            windowMs: 240_000,
            awaitFreeCoin: async (maxMs) => {
              clock.advance(maxMs);
              return false;
            },
            retryAfterMs: 15_000,
            now: clock.now,
            log: silent,
          },
        ),
      (cause: unknown) => {
        assert.ok(cause instanceof DustWaitExhausted);
        assert.equal(cause.retryAfterMs, 15_000);
        assert.equal(cause.waitedMs, 240_000);
        assert.match(cause.message, /no fee-capable DUST coin came free/);
        assert.match(cause.message, /the registration of alice.night/);
        return true;
      },
    );
    assert.equal(attempts, 1, 'nothing is spent after the window is gone');
  });

  it('refuses immediately, and asks for no wait at all, when the window is zero', async () => {
    let asked = 0;
    await assert.rejects(
      () =>
        withDustWait(
          async () => {
            throw new DustUnavailable('insufficient funds');
          },
          {
            label: 'a grant',
            windowMs: 0,
            awaitFreeCoin: async () => {
              asked += 1;
              return true;
            },
            log: silent,
          },
        ),
      DustWaitExhausted,
    );
    assert.equal(asked, 0);
  });

  it('rethrows anything that is not a DUST shortfall, untouched and at once', async () => {
    const refused = new Error('call to a circuit that does not exist');
    let attempts = 0;
    let asked = 0;
    await assert.rejects(
      () =>
        withDustWait(
          async () => {
            attempts += 1;
            throw refused;
          },
          {
            label: 'a registration',
            windowMs: 240_000,
            awaitFreeCoin: async () => {
              asked += 1;
              return true;
            },
            log: silent,
          },
        ),
      (cause: unknown) => cause === refused,
    );
    assert.equal(attempts, 1);
    assert.equal(asked, 0, 'a refused circuit is not made better by waiting for a coin');
  });

  it('carries the rebuild-and-retry ladder into the attempt AFTER the wait', async () => {
    /* The two failures compose, and this is the case that says so: the first
       attempt finds no coin, the wait frees one, and the rebuilt attempt is
       then refused by the NODE — which is `withNodeRejectionRetry`'s failure,
       and it must still be rebuilt rather than reported. */
    const clock = clockFrom();
    let attempt = 0;
    const spend = (): Promise<string> =>
      withNodeRejectionRetry(
        async () => {
          attempt += 1;
          if (attempt === 1) throw AS_MIDNIGHT_JS_REWRAPS_IT;
          if (attempt === 2) {
            throw new Error('RpcError: 1010: Invalid Transaction: Custom error: 231');
          }
          return 'registered';
        },
        {
          label: 'register_domain_for alice.night',
          synced: async () => true,
          wait: async () => undefined,
          log: silent,
        },
      );
    const result = await withDustWait(spend, {
      label: 'the registration of alice.night',
      windowMs: 240_000,
      awaitFreeCoin: async () => {
        clock.advance(30_000);
        return true;
      },
      now: clock.now,
      log: silent,
    });
    assert.equal(result, 'registered');
    assert.equal(attempt, 3, 'shortfall, then a node rejection, then the build that lands');
  });
});
