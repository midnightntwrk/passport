/**
 * The retry storm behind the outage of 2026/09/05, and the schedule that ends
 * it.
 *
 * WHAT HAPPENED. The submission socket died at 14:48 UTC and stayed dead until
 * an operator restarted the service at 20:12. Every minute of those five hours
 * the housekeeping tick in `./server.ts` asked the account funder for a spare
 * mUSD coin; every attempt proved a `mint_shielded` circuit against the 1AM
 * prover — `[job] the spare mUSD mint failed after 7.4 s` — and then failed at
 * the submission, because every submission was failing. 249 `[asset] no spare
 * mUSD coin` lines, 249 proofs, and not one of them could have succeeded.
 *
 * The pre-mint is housekeeping: nobody waits on it, and an activation that
 * finds no spare mints its own. So there is no cost to being patient here and a
 * real one — somebody else's prover quota — to being eager.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SPARE_MINT_BACKOFF_BASE_MS,
  SPARE_MINT_BACKOFF_CAP_MS,
  createSpareMintSchedule,
} from '../src/account.js';

/** An arbitrary fixed instant; every figure below is arithmetic on it. */
const T0 = 1_800_000_000_000;

describe('when the spare mUSD mint may be attempted again', () => {
  it('lets the first attempt through with nothing against it', () => {
    const schedule = createSpareMintSchedule();
    assert.equal(schedule.due(T0, true), true);
    assert.deepEqual(schedule.snapshot(), { failures: 0, nextAttemptAt: null });
  });

  it('backs off exponentially from 15 s to an eight-minute ceiling', () => {
    const schedule = createSpareMintSchedule();
    const waits: number[] = [];
    let now = T0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      schedule.failed(now);
      const next = schedule.snapshot().nextAttemptAt!;
      waits.push(next - now);
      now = next;
    }
    assert.deepEqual(
      waits,
      [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 480_000, 480_000],
      'doubling from the base, then held at the cap',
    );
    assert.equal(waits[0], SPARE_MINT_BACKOFF_BASE_MS);
    assert.equal(waits.at(-1), SPARE_MINT_BACKOFF_CAP_MS);
  });

  it('refuses every attempt inside the wait it just set, and allows the one after it', () => {
    const schedule = createSpareMintSchedule();
    schedule.failed(T0);
    assert.equal(schedule.due(T0 + 1_000, true), false, 'a second later');
    assert.equal(schedule.due(T0 + 14_999, true), false, 'and a millisecond short of the wait');
    assert.equal(schedule.due(T0 + 15_000, true), true, 'and through at the wait itself');
  });

  it('clears the whole backoff on one mint that works', () => {
    const schedule = createSpareMintSchedule();
    schedule.failed(T0);
    schedule.failed(T0 + 15_000);
    schedule.failed(T0 + 45_000);
    assert.equal(schedule.due(T0 + 46_000, true), false);

    schedule.succeeded();
    assert.deepEqual(schedule.snapshot(), { failures: 0, nextAttemptAt: null });
    assert.equal(schedule.due(T0 + 46_000, true), true);
  });

  it('STOPS altogether while nothing can be submitted, whatever the backoff says', () => {
    /* The rule that matters more than the backoff. A mint attempted while the
       submission socket is dead is guaranteed to fail, and it spends 7.4 s of
       the prover to find out. */
    const schedule = createSpareMintSchedule();
    assert.equal(schedule.due(T0, false), false, 'on a schedule with nothing against it');
    schedule.succeeded();
    assert.equal(schedule.due(T0 + 10 * 60_000, false), false, 'and long after any wait');
  });

  it('does not let a dead socket advance, extend, or shorten the backoff', () => {
    /* A stop is not a failure: the attempt was never made, no proof was spent,
       and the moment submissions work again the schedule is where it was. */
    const schedule = createSpareMintSchedule();
    schedule.failed(T0);
    for (let tick = 0; tick < 300; tick += 1) schedule.due(T0 + tick * 60_000, false);
    assert.deepEqual(schedule.snapshot(), { failures: 1, nextAttemptAt: T0 + 15_000 });
    assert.equal(schedule.due(T0 + 60_000, true), true, 'and the socket coming back is enough');
  });

  it('turns the five-hour storm of 2026/09/05 into a handful of proofs', () => {
    /* The measured shape of the incident, replayed: a minute tick from 14:48 to
       20:12, with the socket reported dead throughout — and, separately, the
       same five hours with the socket lying about itself so only the backoff
       holds. */
    const OUTAGE_MINUTES = 324;

    const stopped = createSpareMintSchedule();
    let stoppedAttempts = 0;
    for (let minute = 0; minute < OUTAGE_MINUTES; minute += 1) {
      const now = T0 + minute * 60_000;
      if (!stopped.due(now, false)) continue;
      stoppedAttempts += 1;
      stopped.failed(now);
    }
    assert.equal(stoppedAttempts, 0, 'not one proof spent on a socket that could not carry it');

    const backedOff = createSpareMintSchedule();
    let backedOffAttempts = 0;
    for (let minute = 0; minute < OUTAGE_MINUTES; minute += 1) {
      const now = T0 + minute * 60_000;
      if (!backedOff.due(now, true)) continue;
      backedOffAttempts += 1;
      backedOff.failed(now);
    }
    assert.ok(
      backedOffAttempts <= 45,
      `the backoff alone cuts 249 attempts to ${backedOffAttempts}`,
    );
    assert.ok(backedOffAttempts >= 5, 'without giving up on the spare entirely');
  });
});
