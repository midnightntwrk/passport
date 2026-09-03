/**
 * The split's numbers, pinned.
 *
 * These are not illustrative: they are the figures an operator reads off
 * `split-night.ts --plan` before deciding whether to move 10,000 NIGHT out of a
 * 19,998.87 NIGHT wallet. Each one is derived from the ledger's own DUST
 * parameters and from fees measured on chain, so a change to any of them is a
 * change to the decision — hence a failing test rather than a silently
 * different plan.
 *
 * THE 2026/09/02 RULING, which is what these figures describe: the sponsor
 * holds four material unshielded UTxOs — the original ~4,998.87 NIGHT coin and
 * three inbound 5,000 NIGHT coins (txs 667b6124…, 8bab7b5e…, 7577ca12…, blocks
 * 290930/290937/290956), all registered for DUST generation. The two NEWEST
 * 5,000 coins are to be split into ten UTxOs of 1,000 NIGHT, one transaction
 * each. The original coin and the third 5,000 stay untouched so their accrued
 * DUST keeps paying fees throughout the ramp.
 *
 * Every Speck figure is a BigInt. A `number` cannot hold 5e18 exactly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ATOMIC_PER_NIGHT,
  computeSplitPlan,
  FEE_CAPABLE_SPECKS,
  formatMilli,
  formatNightAtomic,
  formatSplitPlan,
  LEDGER_DUST_PARAMETERS,
  MEASURED_ACTIVATION_FEE_SPECKS,
  MEASURED_ACTIVATION_WITH_SEND_FEE_SPECKS,
  MEASURED_DUST_REGISTRATION_FEE_SPECKS,
  MEASURED_MAX_FEE_SPECKS,
  MEASURED_REGISTER_FEE_SPECKS,
  RULED_PER_COIN_ATOMIC_NIGHT,
} from './splitPlan.js';

/** One inbound coin: 5,000 NIGHT at six decimals. */
const FIVE_THOUSAND = 5_000_000_000n;
/** The original coin, 4,998.87 NIGHT. */
const ORIGINAL = 4_998_870_000n;
/** What the sponsor holds in total, across all four UTxOs. */
const WHOLE_WALLET = ORIGINAL + FIVE_THOUSAND * 3n;

/**
 * DUST the two untouched coins are taken to hold when the ramp begins. A
 * deliberately conservative reading of the ~2.52e19 Specks `/status` reported
 * across all four coins on 2026/09/02: rather less than half of it, so the ramp
 * budget below is a floor and not a hope.
 */
const UNTOUCHED_SPENDABLE = 12_000_000_000_000_000_000n;

/** Run one, and run two: one 5,000 coin split into five coins of 1,000. */
const oneRun = () =>
  computeSplitPlan({
    spendAtomicNight: FIVE_THOUSAND,
    outputs: 5,
    perCoinAtomicNight: RULED_PER_COIN_ATOMIC_NIGHT,
    untouchedCoinsAtomicNight: [ORIGINAL, FIVE_THOUSAND, FIVE_THOUSAND],
    untouchedSpendableSpecks: UNTOUCHED_SPENDABLE,
  });

/** Both runs together — the shape the wallet ends up in. */
const bothRuns = () =>
  computeSplitPlan({
    spendAtomicNight: FIVE_THOUSAND * 2n,
    outputs: 10,
    perCoinAtomicNight: RULED_PER_COIN_ATOMIC_NIGHT,
    untouchedCoinsAtomicNight: [ORIGINAL, FIVE_THOUSAND],
    untouchedSpendableSpecks: UNTOUCHED_SPENDABLE,
  });

test('the ledger parameters are the ones measured on stagenet', () => {
  assert.equal(LEDGER_DUST_PARAMETERS.nightDustRatio, 5_000_000_000n);
  assert.equal(LEDGER_DUST_PARAMETERS.generationDecayRate, 8_267n);
  assert.equal(LEDGER_DUST_PARAMETERS.timeToCapSeconds, 604_815n);
  assert.equal(LEDGER_DUST_PARAMETERS.graceSeconds, 10_800n);
  /* time-to-cap IS ratio/rate, rounded up — the parameters are consistent, and
     a future parameter bump that broke this would invalidate every projection
     below. */
  const derived =
    (LEDGER_DUST_PARAMETERS.nightDustRatio + LEDGER_DUST_PARAMETERS.generationDecayRate - 1n) /
    LEDGER_DUST_PARAMETERS.generationDecayRate;
  assert.equal(derived, LEDGER_DUST_PARAMETERS.timeToCapSeconds);
});

test('the ruling is one thousand NIGHT per coin', () => {
  assert.equal(ATOMIC_PER_NIGHT, 1_000_000n);
  assert.equal(RULED_PER_COIN_ATOMIC_NIGHT, 1_000_000_000n);
  assert.equal(formatNightAtomic(RULED_PER_COIN_ATOMIC_NIGHT), '1000.000000');
});

test('one 5,000 coin divides into five coins of 1,000 with nothing over', () => {
  const plan = oneRun();
  assert.equal(plan.perCoinAtomicNight, 1_000_000_000n);
  assert.equal(plan.remainderAtomicNight, 0n);
  assert.equal(plan.explicitOutputs, 4);
  assert.equal(plan.changeAtomicNight, 1_000_000_000n);
  assert.equal(
    plan.perCoinAtomicNight * 4n + plan.changeAtomicNight,
    FIVE_THOUSAND,
    'the four outputs plus the change must account for every atomic unit spent',
  );
  /* The split moves NIGHT between UTxOs; it does not move it out of the
     wallet. Every atomic unit is still there afterwards. */
  assert.equal(plan.spendAtomicNight + plan.untouchedAtomicNight, WHOLE_WALLET);
  assert.equal(plan.totalAtomicNight, WHOLE_WALLET);
  assert.equal(plan.totalAtomicNight, 19_998_870_000n);
});

test('a 1,000-NIGHT coin: cap, rate, and the three fee horizons', () => {
  const plan = oneRun();
  assert.equal(plan.perCoinCapSpecks, 5_000_000_000_000_000_000n); // 5e18
  assert.equal(plan.perCoinSpecksPerSecond, 8_267_000_000_000n); // 8.267e12
  /* The three moments in a new coin's life that the operator cares about, in
     the order they happen. */
  assert.equal(plan.secondsToRegistrationFeePerCoin, 103n); // 8.5e14 — under 2 min
  assert.equal(plan.secondsToFirstFeePerCoin, 1_658n); // 1.37e16 — 28 min
  assert.equal(plan.secondsToLaneCapablePerCoin, 1_815n); // 1.5e16 — 30 min
  assert.equal(plan.secondsToSecondFeePerCoin, 3_315n); // 2 × 1.37e16 — 55 min
  /* Lane-capable is STRICTLY LATER than one fee: `FEE_CAPABLE_SPECKS` carries
     margin over the largest measured fee, and it is the floor `src/wallet.ts`
     actually counts lanes against. Plan the ramp on the later figure. */
  assert.ok(plan.secondsToLaneCapablePerCoin > plan.secondsToFirstFeePerCoin);
});

test('the ruling s ~6 min to a registration fee is nearer 2 min, and 17 min for the midname leg', () => {
  /* The ruling quoted "≈6 min to a registration fee 8.5e14". At 8,267 Specks
     per atomic NIGHT per second a 1,000 NIGHT coin makes 8.267e12 Specks/s, so
     8.5e14 lands in 103 s. Six minutes is nearer the MIDNAME registration leg
     (8.5e15, the second-largest measured fee) at 1,029 s — which is 17 min, not
     6. Both are pinned here so the discrepancy is on the record rather than in
     somebody's head, and neither is on the critical path: the untouched coins
     pay every fee during the ramp. */
  assert.equal(MEASURED_DUST_REGISTRATION_FEE_SPECKS, 850_000_000_000_000n);
  assert.equal(MEASURED_REGISTER_FEE_SPECKS, 8_500_000_000_000_000n);
  assert.equal(MEASURED_REGISTER_FEE_SPECKS, MEASURED_DUST_REGISTRATION_FEE_SPECKS * 10n);
  assert.equal(oneRun().secondsToRegistrationFeePerCoin, 103n);
  const againstMidnameLeg = computeSplitPlan({
    spendAtomicNight: FIVE_THOUSAND,
    outputs: 5,
    perCoinAtomicNight: RULED_PER_COIN_ATOMIC_NIGHT,
    registrationFeeSpecks: MEASURED_REGISTER_FEE_SPECKS,
  });
  assert.equal(againstMidnameLeg.secondsToRegistrationFeePerCoin, 1_029n);
});

test('there is NO blackout, because the untouched coins never stop paying', () => {
  /* This is the whole reason for splitting two UTxOs rather than the wallet.
     The old sizing quoted a ≈332 s window in which the sponsor could not pay a
     fee at all; leaving two loaded coins alone removes it outright. */
  for (const plan of [oneRun(), bothRuns()]) {
    assert.equal(plan.blackoutSeconds, 0n);
    assert.ok(plan.feesUntouchedCoinsCanPayNow > 0n);
  }
  assert.equal(oneRun().feesUntouchedCoinsCanPayNow, 875n);
  /* And the ramp is comfortably funded: the untouched coins carry hundreds of
     maximum fees through the 1,815 s the new coins need. */
  assert.equal(oneRun().feesUntouchedCoinsCanPayDuringRamp, 892n);
  assert.equal(bothRuns().feesUntouchedCoinsCanPayDuringRamp, 886n);

  /* A wallet-wide split — no untouched coins — is what the blackout figure is
     FOR, and it is still computed so the contrast is visible. */
  const wholeWallet = computeSplitPlan({
    spendAtomicNight: WHOLE_WALLET,
    outputs: 19,
    perCoinAtomicNight: RULED_PER_COIN_ATOMIC_NIGHT,
  });
  assert.equal(wholeWallet.untouchedCoins, 0);
  assert.ok(wholeWallet.blackoutSeconds > 0n);
  assert.equal(wholeWallet.blackoutSeconds, wholeWallet.secondsToFirstFeeAcrossNewCoins);
});

test('lanes: three during the first run, two during the second, twelve once ramped', () => {
  const first = oneRun();
  /* Run one leaves three loaded coins alone, so the queue keeps three lanes
     from the moment the transaction lands. */
  assert.equal(first.untouchedCoins, 3);
  assert.equal(first.lanesAtSplit, 3);

  const both = bothRuns();
  /* Run two leaves two. This is the low-water mark of the whole operation:
     BALANCER_SPEND_LANES is 3 today, so the wallet drops to two lanes for the
     ~30 min the new coins take to clear the fee-capable floor. */
  assert.equal(both.untouchedCoins, 2);
  assert.equal(both.lanesAtSplit, 2);
  assert.equal(both.lanesWhenRamped, 12);
  assert.equal(both.laneCeiling, 12);
  assert.equal(both.secondsToLaneCapablePerCoin, 1_815n);
  /* Twelve lanes need BALANCER_SPEND_LANES raised to twelve; left at three the
     split buys nothing at all. `spendLaneCount` is min(ceiling, fee-capable). */
  const stillAtThree = computeSplitPlan({
    spendAtomicNight: FIVE_THOUSAND * 2n,
    outputs: 10,
    perCoinAtomicNight: RULED_PER_COIN_ATOMIC_NIGHT,
    untouchedCoinsAtomicNight: [ORIGINAL, FIVE_THOUSAND],
    untouchedSpendableSpecks: UNTOUCHED_SPENDABLE,
    laneCeiling: 3,
  });
  assert.equal(stillAtThree.lanesWhenRamped, 3);
});

test('the new coins together cover a fee long before any one of them does', () => {
  assert.equal(oneRun().secondsToFirstFeeAcrossNewCoins, 332n); // five coins
  assert.equal(bothRuns().secondsToFirstFeeAcrossNewCoins, 166n); // ten coins
  /* Sweeping every new coin at once is what smallest-first selection does while
     they are small. It is not a lane, though — `feeCapableCoinCount` counts
     coins that hold a fee ALONE — which is why the ramp is planned on
     `secondsToLaneCapablePerCoin` and not on this. */
  assert.ok(bothRuns().secondsToFirstFeeAcrossNewCoins < bothRuns().secondsToLaneCapablePerCoin);
});

test('sustained capacity is a property of the NIGHT, not of how it is cut up', () => {
  const both = bothRuns();
  assert.equal(both.aggregateSpecksPerSecond, 165_330_658_290_000n); // 1.653e14
  assert.equal(both.aggregateSpecksPerHour, 595_190_369_844_000_000n);
  assert.equal(both.totalCapSpecks, 99_994_350_000_000_000_000n); // 9.999e19
  assert.equal(both.feesPerHourMilli, 43_444n); // 43.444 maximum fees per hour
  assert.equal(both.activationsPerHourMilli, 14_446n); // 14.446 activations per hour
  assert.equal(both.activationsWithSendPerHourMilli, 11_315n); // 11.315 with a first send
  assert.equal(formatMilli(both.feesPerHourMilli), '43.444');
  assert.equal(formatMilli(both.activationsWithSendPerHourMilli), '11.315');
  /* Neither run changes any of it: the aggregate rate is the whole wallet's
     NIGHT times the decay rate, and the split moves neither. */
  assert.equal(oneRun().aggregateSpecksPerSecond, both.aggregateSpecksPerSecond);
  assert.equal(oneRun().feesPerHourMilli, both.feesPerHourMilli);
  assert.equal(
    both.newCoinsSpecksPerSecond + both.untouchedSpecksPerSecond,
    both.aggregateSpecksPerSecond,
  );
});

test('what the split buys is concurrency, and it pays for it in per-coin latency', () => {
  const thousands = bothRuns();
  const fiveThousands = computeSplitPlan({
    spendAtomicNight: FIVE_THOUSAND * 2n,
    outputs: 2,
    perCoinAtomicNight: FIVE_THOUSAND,
    untouchedCoinsAtomicNight: [ORIGINAL, FIVE_THOUSAND],
    untouchedSpendableSpecks: UNTOUCHED_SPENDABLE,
  });
  assert.equal(thousands.aggregateSpecksPerSecond, fiveThousands.aggregateSpecksPerSecond);
  assert.ok(thousands.lanesWhenRamped > fiveThousands.lanesWhenRamped);
  assert.ok(thousands.perCoinSpecksPerSecond < fiveThousands.perCoinSpecksPerSecond);
  assert.ok(thousands.secondsToLaneCapablePerCoin > fiveThousands.secondsToLaneCapablePerCoin);
});

test('the measured fee constants are the ones the plan is sized against', () => {
  assert.equal(MEASURED_MAX_FEE_SPECKS, 13_700_000_000_000_000n);
  assert.equal(MEASURED_ACTIVATION_FEE_SPECKS, 41_200_000_000_000_000n);
  assert.equal(MEASURED_ACTIVATION_WITH_SEND_FEE_SPECKS, 52_600_000_000_000_000n);
  /* The fee-capable floor the service counts lanes against carries margin over
     the largest single fee, and is smaller than one whole activation. */
  assert.equal(FEE_CAPABLE_SPECKS, 15_000_000_000_000_000n);
  assert.ok(FEE_CAPABLE_SPECKS > MEASURED_MAX_FEE_SPECKS);
  assert.ok(FEE_CAPABLE_SPECKS < MEASURED_ACTIVATION_FEE_SPECKS);
  /* One activation is five sponsored legs, none of them larger than the
     maximum single fee. */
  assert.ok(MEASURED_ACTIVATION_FEE_SPECKS < MEASURED_MAX_FEE_SPECKS * 5n);
  assert.ok(MEASURED_ACTIVATION_WITH_SEND_FEE_SPECKS > MEASURED_ACTIVATION_FEE_SPECKS);
});

test('an uneven division puts the remainder in the change output', () => {
  const plan = computeSplitPlan({ spendAtomicNight: 1_000_000_007n, outputs: 3 });
  assert.equal(plan.perCoinAtomicNight, 333_333_335n);
  assert.equal(plan.remainderAtomicNight, 2n);
  assert.equal(plan.changeAtomicNight, 333_333_337n);
  assert.equal(plan.perCoinAtomicNight * 2n + plan.changeAtomicNight, 1_000_000_007n);
});

test('nonsensical inputs are refused rather than sized', () => {
  assert.throws(() => computeSplitPlan({ spendAtomicNight: FIVE_THOUSAND, outputs: 0 }));
  assert.throws(() => computeSplitPlan({ spendAtomicNight: FIVE_THOUSAND, outputs: -1 }));
  assert.throws(() => computeSplitPlan({ spendAtomicNight: FIVE_THOUSAND, outputs: 2.5 }));
  assert.throws(() => computeSplitPlan({ spendAtomicNight: 0n, outputs: 5 }));
  assert.throws(() => computeSplitPlan({ spendAtomicNight: 7n, outputs: 8 }));
  /* Six coins of 1,000 do not come out of one 5,000 UTxO. Refusing in
     arithmetic means the operator finds out before a seed is read. */
  assert.throws(
    () =>
      computeSplitPlan({
        spendAtomicNight: FIVE_THOUSAND,
        outputs: 6,
        perCoinAtomicNight: RULED_PER_COIN_ATOMIC_NIGHT,
      }),
    /carry only/,
  );
  assert.throws(() =>
    computeSplitPlan({
      spendAtomicNight: FIVE_THOUSAND,
      outputs: 5,
      untouchedCoinsAtomicNight: [0n],
    }),
  );
  assert.throws(() =>
    computeSplitPlan({ spendAtomicNight: FIVE_THOUSAND, outputs: 5, laneCeiling: 0 }),
  );
});

test('the printed plan carries the figures an operator has to read', () => {
  const printed = formatSplitPlan(bothRuns());
  assert.match(printed, /10 coins of 1000\.000000 NIGHT/);
  assert.match(printed, /1000000000/);
  assert.match(printed, /5000000000000000000/); // the per-coin cap
  assert.match(printed, /43\.444/);
  assert.match(printed, /blackout\s+none/);
  assert.match(printed, /lanes once ramped\s+12/);
  assert.match(printed, /BALANCER_SPEND_LANES ≥ 12/);
  assert.match(printed, /ops\/SPLIT\.md/);
  /* 1,815 s crosses no rounding boundary that would hide it. */
  assert.match(printed, /1815 s \(30 min\)/);
});

test('atomic NIGHT formats with six decimals', () => {
  assert.equal(formatNightAtomic(WHOLE_WALLET), '19998.870000');
  assert.equal(formatNightAtomic(FIVE_THOUSAND), '5000.000000');
  assert.equal(formatNightAtomic(ORIGINAL), '4998.870000');
  assert.equal(formatNightAtomic(1n), '0.000001');
});
