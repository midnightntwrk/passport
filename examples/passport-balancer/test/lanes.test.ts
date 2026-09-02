/**
 * How many spend jobs the queue may start, and what a "free coin" has to be.
 *
 * THE FAILURE THIS PINS DOWN, measured on the deployed balancer on 2026/09/02
 * at 21:33. `/status` reported `lanes: 3` against three DUST UTxOs, so the
 * queue started the activation grant, the mUSD leg, and a name registration
 * together — but only ONE of those three coins carried enough generated DUST to
 * pay a contract call's fee on its own. The two jobs that lost the race spent
 * fifteen seconds balancing before failing, then waited 22 s and 45 s for a
 * coin: sixty-seven seconds of a 157-second registration, on the click a user
 * is watching, spent losing races the queue should never have started.
 *
 * The coins were not equal because a spend's CHANGE is a DUST coin the moment
 * it lands and cannot carry a fee for minutes afterwards — `generatedNow`
 * starts near zero and grows against the NIGHT backing it. So a lane may only
 * be opened on a FEE-CAPABLE coin.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { feeCapableCoinCount, spendLaneCount } from '../src/wallet.js';
import { createWalletReservation } from '../src/reservation.js';
import { FEE_CAPABLE_SPECKS } from '../src/resolverPool.js';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One fee-capable coin and two freshly landed change coins — the live shape. */
const oneCapableTwoChange = [
  { generatedNow: 24_000_000_000_000_000_000n },
  { generatedNow: 0n },
  { generatedNow: 1_000_000_000_000n },
];

describe('fee-capable coin counting', () => {
  it('counts only coins that clear the fee floor on their own', () => {
    assert.equal(feeCapableCoinCount(oneCapableTwoChange, FEE_CAPABLE_SPECKS), 1);
  });

  it('counts a coin sitting exactly on the floor', () => {
    assert.equal(
      feeCapableCoinCount([{ generatedNow: FEE_CAPABLE_SPECKS }], FEE_CAPABLE_SPECKS),
      1,
    );
  });

  it('counts nothing when every coin is change that has not regenerated', () => {
    assert.equal(
      feeCapableCoinCount([{ generatedNow: 0n }, { generatedNow: 5n }], FEE_CAPABLE_SPECKS),
      0,
    );
  });
});

describe('spend lanes', () => {
  it('opens one lane for the live shape, not three', () => {
    /* The regression. Three UTxOs, ceiling three, one fee-capable coin: the
       queue must start one job, not three. */
    const capable = feeCapableCoinCount(oneCapableTwoChange, FEE_CAPABLE_SPECKS);
    assert.equal(spendLaneCount(capable, 3), 1);
  });

  it('opens a lane per fee-capable coin up to the configured ceiling', () => {
    assert.equal(spendLaneCount(2, 3), 2);
    assert.equal(spendLaneCount(5, 3), 3);
  });

  it('never drops to zero, because a stopped queue never drains again', () => {
    assert.equal(spendLaneCount(0, 3), 1);
    assert.equal(spendLaneCount(0, 0), 1);
  });
});

describe('a lane that opens with no job ending', () => {
  it('starts the job that was waiting for it', async () => {
    /* THE STALL, on the deployed service on 2026/09/02 at 22:36. One job
       running, `lanes: 3`, and a job waiting behind it for eight minutes with
       two lanes standing open. `drain` runs on arrival and on completion, which
       was enough while the lane count was a constant — the only thing that
       could free a lane was a job ending, and that drains. It stopped being
       enough when lanes became a reading of the free fee-capable coins, because
       a lane now also opens when a coin the wallet already holds finishes
       regenerating, and the queue never hears that. */
    let capable = 1;
    const reservation = createWalletReservation({ lanes: () => spendLaneCount(capable, 3) });
    const ran: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = reservation.exclusive(
      () =>
        new Promise<void>((resolve) => {
          ran.push('first');
          releaseFirst = resolve;
        }),
    );
    await settle();
    const second = reservation.exclusive(async () => {
      ran.push('second');
    });
    await settle();
    assert.deepEqual(ran, ['first'], 'one coin, one lane, one job');

    /* A coin the wallet already held has regenerated. */
    capable = 2;
    reservation.laneCountChanged();
    await settle();
    assert.deepEqual(ran, ['first', 'second']);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(reservation.counts(), { reserved: 0, jobs: 0 });
  });

  it('starts nothing when the count has not really moved', async () => {
    const reservation = createWalletReservation({ lanes: () => 1 });
    const ran: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = reservation.exclusive(
      () =>
        new Promise<void>((resolve) => {
          ran.push('first');
          releaseFirst = resolve;
        }),
    );
    await settle();
    const second = reservation.exclusive(async () => {
      ran.push('second');
    });
    await settle();
    reservation.laneCountChanged();
    reservation.laneCountChanged();
    await settle();
    assert.deepEqual(ran, ['first']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(ran, ['first', 'second']);
  });
});
