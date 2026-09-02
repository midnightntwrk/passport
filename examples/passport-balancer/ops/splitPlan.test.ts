/**
 * The split's numbers, pinned.
 *
 * These are not illustrative: they are the figures an operator would read off
 * `split-night.ts --plan` before deciding whether to move 4,998.916 NIGHT. Each
 * one is derived from the ledger's own DUST parameters and from fees measured
 * on chain, so a change to any of them is a change to the decision — hence a
 * failing test rather than a silently different plan.
 *
 * Every Speck figure is a BigInt. A `number` cannot hold 3.12e18 exactly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeSplitPlan,
  formatMilli,
  formatNightAtomic,
  formatSplitPlan,
  LEDGER_DUST_PARAMETERS,
  MEASURED_ACTIVATION_FEE_SPECKS,
  MEASURED_ACTIVATION_WITH_SEND_FEE_SPECKS,
  MEASURED_MAX_FEE_SPECKS,
  MEASURED_OLD_COIN_SPECKS,
} from './splitPlan.js';

/** The balancer's holding on 2026/09/02: 4,998.916 NIGHT at 6 decimals. */
const TOTAL = 4_998_916_000n;

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

test('N=8 on 4,998.916 NIGHT divides exactly', () => {
  const plan = computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 8 });
  assert.equal(plan.perCoinAtomicNight, 624_864_500n);
  assert.equal(plan.remainderAtomicNight, 0n);
  assert.equal(plan.explicitOutputs, 7);
  assert.equal(plan.changeAtomicNight, 624_864_500n);
  assert.equal(
    plan.perCoinAtomicNight * 7n + plan.changeAtomicNight,
    TOTAL,
    'the seven outputs plus the change must account for every atomic unit',
  );
});

test('N=8 caps and generation rates', () => {
  const plan = computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 8 });
  assert.equal(plan.perCoinCapSpecks, 3_124_322_500_000_000_000n); // 3.12e18
  assert.equal(plan.totalCapSpecks, 24_994_580_000_000_000_000n); // 2.499e19
  assert.equal(plan.perCoinSpecksPerSecond, 5_165_754_821_500n); // 5.166e12
  assert.equal(plan.aggregateSpecksPerSecond, 41_326_038_572_000n); // 4.13e13
  /* The split moves DUST between coins; it does not create or destroy any. */
  assert.equal(plan.perCoinCapSpecks * 8n, plan.totalCapSpecks);
  assert.equal(plan.perCoinSpecksPerSecond * 8n, plan.aggregateSpecksPerSecond);
});

test('N=8 fee horizons — the window in which the split has not helped yet', () => {
  const plan = computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 8 });
  assert.equal(plan.secondsToFirstFeePerCoin, 2_653n); // ≈ 44 min
  assert.equal(plan.secondsToSecondFeePerCoin, 5_305n); // ≈ 88 min
  assert.equal(plan.singleLaneGapSeconds, plan.secondsToFirstFeePerCoin);
  /* Sweeping every coin at once — which is what smallest-first selection does
     while the coins are small — covers one fee far sooner. This is the real
     blackout after a split, and the figure that matters if the pre-split DUST
     does not survive the NIGHT rotation. */
  assert.equal(plan.secondsToFirstFeeAggregate, 332n); // ≈ 5.5 min
  assert.equal(plan.worstCaseBlackoutSeconds, plan.secondsToFirstFeeAggregate);
});

test('N=8 sustained capacity', () => {
  const plan = computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 8 });
  assert.equal(plan.aggregateSpecksPerHour, 148_773_738_859_200_000n);
  assert.equal(plan.feesPerHourMilli, 10_859n); // 10.859 maximum fees per hour
  assert.equal(plan.activationsPerHourMilli, 3_611n); // 3.611 activations per hour
  assert.equal(plan.activationsWithSendPerHourMilli, 2_828n); // 2.828 with a first send
  assert.equal(formatMilli(plan.feesPerHourMilli), '10.859');
  assert.equal(formatMilli(plan.activationsWithSendPerHourMilli), '2.828');
});

test('sustained capacity does not depend on how many coins the NIGHT sits in', () => {
  const two = computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 2 });
  const eight = computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 8 });
  assert.equal(two.aggregateSpecksPerSecond, eight.aggregateSpecksPerSecond);
  assert.equal(two.feesPerHourMilli, eight.feesPerHourMilli);
  /* What the split buys is concurrency, not throughput: more coins, each
     smaller, each slower to hold a whole fee. */
  assert.ok(eight.perCoinSpecksPerSecond < two.perCoinSpecksPerSecond);
  assert.ok(eight.secondsToFirstFeePerCoin > two.secondsToFirstFeePerCoin);
});

test('the old DUST coin decays over about seven days', () => {
  const plan = computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 8 });
  assert.equal(plan.oldCoinSpecks, MEASURED_OLD_COIN_SPECKS);
  assert.equal(plan.oldCoinDecaySeconds, 603_650n); // 6.99 days
  assert.ok(plan.oldCoinDecaySeconds < plan.timeToCapSeconds);
});

test('the measured fee constants are the ones the plan is sized against', () => {
  assert.equal(MEASURED_MAX_FEE_SPECKS, 13_700_000_000_000_000n);
  assert.equal(MEASURED_ACTIVATION_FEE_SPECKS, 41_200_000_000_000_000n);
  assert.equal(MEASURED_ACTIVATION_WITH_SEND_FEE_SPECKS, 52_600_000_000_000_000n);
  /* One activation is five sponsored legs, none of them larger than the
     maximum single fee. */
  assert.ok(MEASURED_ACTIVATION_FEE_SPECKS < MEASURED_MAX_FEE_SPECKS * 5n);
  assert.ok(MEASURED_ACTIVATION_WITH_SEND_FEE_SPECKS > MEASURED_ACTIVATION_FEE_SPECKS);
});

test('an uneven division puts the remainder in the change output', () => {
  const plan = computeSplitPlan({ totalAtomicNight: 1_000_000_007n, outputs: 3 });
  assert.equal(plan.perCoinAtomicNight, 333_333_335n);
  assert.equal(plan.remainderAtomicNight, 2n);
  assert.equal(plan.changeAtomicNight, 333_333_337n);
  assert.equal(plan.perCoinAtomicNight * 2n + plan.changeAtomicNight, 1_000_000_007n);
});

test('N=1 is the no-op plan', () => {
  const plan = computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 1 });
  assert.equal(plan.explicitOutputs, 0);
  assert.equal(plan.changeAtomicNight, TOTAL);
  assert.equal(plan.perCoinSpecksPerSecond, plan.aggregateSpecksPerSecond);
});

test('nonsensical inputs are refused rather than sized', () => {
  assert.throws(() => computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 0 }));
  assert.throws(() => computeSplitPlan({ totalAtomicNight: TOTAL, outputs: -1 }));
  assert.throws(() => computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 2.5 }));
  assert.throws(() => computeSplitPlan({ totalAtomicNight: 0n, outputs: 8 }));
  assert.throws(() => computeSplitPlan({ totalAtomicNight: 7n, outputs: 8 }));
});

test('the printed plan carries the figures and the refusal', () => {
  const printed = formatSplitPlan(computeSplitPlan({ totalAtomicNight: TOTAL, outputs: 8 }));
  assert.match(printed, /8 coins/);
  assert.match(printed, /624864500/);
  assert.match(printed, /3124322500000000000/);
  assert.match(printed, /10\.859/);
  assert.match(printed, /NOT approved/);
  assert.match(printed, /ops\/SPLIT\.md/);
});

test('atomic NIGHT formats with six decimals', () => {
  assert.equal(formatNightAtomic(TOTAL), '4998.916000');
  assert.equal(formatNightAtomic(624_864_500n), '624.864500');
  assert.equal(formatNightAtomic(1n), '0.000001');
});
