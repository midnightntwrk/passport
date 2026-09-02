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
import { FEE_CAPABLE_SPECKS } from '../src/resolverPool.js';

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
