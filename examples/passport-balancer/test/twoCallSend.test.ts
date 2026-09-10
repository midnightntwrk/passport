/**
 * The one-transaction Passport send, as the sponsor sees it.
 *
 * WHAT CHANGES ON THE WIRE. A send today is a Passport withdrawing to the
 * in-app wallet and the wallet depositing into the recipient — two contract
 * calls in two transactions, each one balanced by `/balance-only` on its own.
 * The one-transaction send replaces both with a single transaction carrying TWO
 * contract calls and TWO proofs: the sender's `transfer_shielded_to_account`
 * root call and the recipient's `deposit_shielded` callee call. Measured on the
 * reference experiment (P7, 2026/09/03): some 26 KB proven, against the 22,526
 * bytes the two-leg send's larger transaction measured.
 *
 * WHAT THE SPONSOR HAS TO DO ABOUT IT. Almost nothing, and this file is the
 * evidence for both halves of that:
 *
 *   - the request bound, the DUST selection and the input cap all take the
 *     bigger shape without moving, and the tests below pin the numbers;
 *   - the SIZE RULE does not. `1010: Custom error: 231` bounds a transaction's
 *     processing time by a budget that grows with its BYTES, and two contract
 *     calls roughly double the processing while adding about a sixth to the
 *     bytes. `/balance-only` had no guard for it at all: it handed back
 *     whatever the SDK balanced and let the node be the first to notice. The
 *     climb the balancer's own jobs have always run is now run for a caller's
 *     transaction too — with one difference, which is that it never refuses.
 *
 * No wallet and no SDK here: every rule under test is arithmetic on the
 * ledger's own parameters, driven the way `balanceOnly` in `../src/wallet.ts`
 * drives it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  boundMsFor,
  createCoinReservation,
  createDustFeeSelector,
  crumbsForShape,
  CRUMB_BYTES,
  CRUMB_MS,
  DUST_CRUMB_FLOOR,
  dustFeeFirst,
  feeShapeFromCost,
  isCrumb,
  MAX_DUST_INPUTS_CEILING,
  MAX_FEE_LEG_PADDING,
  maxDustInputsFor,
  nextFeeLegPadding,
  paddingForVerdict,
  parseTimeToDismiss,
  timeToDismissSentence,
  TIME_TO_DISMISS_TARGET,
  type CoinSelector,
  type SelectableCoin,
} from '../src/coinReservation.js';
import { MAX_BODY_BYTES } from '../src/limits.js';

/** The two-leg send's larger transaction, measured on stagenet 2026/09/03. */
const ONE_CALL_BYTES = 22_526;
/** The one-transaction send: two calls, two proofs. P7, some 26 KB proven. */
const TWO_CALL_BYTES = 26_043;
/** The chain's own ceiling on one transaction, stagenet block 299524. */
const TRANSACTION_BYTE_LIMIT = 1_048_576;

const dust = (nonce: string, generated: bigint): SelectableCoin => ({
  value: generated,
  token: { nonce },
});

/** The SDK's balancing loop, as `test/coinReservation.test.ts` restates it. */
function balanceLike(select: CoinSelector, coins: SelectableCoin[], need: bigint): SelectableCoin[] {
  const inputs: SelectableCoin[] = [];
  let pool = [...coins];
  let remaining = need;
  while (remaining > 0n) {
    const chosen = select(pool, 'dust', -remaining, {});
    if (!chosen) throw new Error('insufficient');
    inputs.push(chosen);
    pool = pool.filter((coin) => coin !== chosen);
    remaining -= chosen.value;
  }
  return inputs;
}

describe('the request bound a two-call transaction has to clear', () => {
  it('carries a 26 KB two-call transaction at well under a hundredth of the limit', () => {
    assert.equal(MAX_BODY_BYTES, 4 * 1024 * 1024);
    assert.ok(TWO_CALL_BYTES < MAX_BODY_BYTES / 100, `${TWO_CALL_BYTES} bytes against ${MAX_BODY_BYTES}`);
  });

  it('carries it as hex too, which is the shape an operator reproduces a failure with', () => {
    /* `transactionBytesFrom` in `../src/server.ts` accepts `{"txBytes": "<hex>"}`
       and bare hex beside the raw octet-stream the demo posts. Hex is two
       characters a byte, so the same transaction is twice the body. */
    assert.ok(TWO_CALL_BYTES * 2 + 32 < MAX_BODY_BYTES);
  });

  it('is larger than any transaction the chain itself would accept', () => {
    /* So the bound is the node's, never this service's: nothing that could
       land is refused at the door. */
    assert.ok(MAX_BODY_BYTES > TRANSACTION_BYTE_LIMIT);
    assert.ok(TWO_CALL_BYTES < TRANSACTION_BYTE_LIMIT);
  });
});

describe('the size rule, for a transaction that carries two calls', () => {
  it('gives the bigger transaction a bigger budget — 2 µs a byte, either way', () => {
    assert.equal(boundMsFor(ONE_CALL_BYTES), 45.052);
    assert.equal(boundMsFor(TWO_CALL_BYTES), 52.086);
    assert.ok(
      boundMsFor(TWO_CALL_BYTES) > boundMsFor(ONE_CALL_BYTES),
      'bytes buy processing time, so the second proof pays for some of its own compute',
    );
  });

  it('reads a proven transaction’s shape off the ledger’s cost record', () => {
    /* `Transaction.cost(params)` reports picoseconds and bytes; `fees` is
       "*only* accurate when called with proven transactions"
       (ledger-v9.d.ts:2559), which is why `/balance-only` asks after proving. */
    const shape = feeShapeFromCost({
      readTimePs: 6_000_000_000n,
      computeTimePs: 35_000_000_000n,
      blockUsageBytes: BigInt(TWO_CALL_BYTES),
      serialisedBytes: TWO_CALL_BYTES,
    });
    assert.ok(shape);
    assert.equal(shape.takesMs, 41);
    assert.equal(shape.bytes, TWO_CALL_BYTES);
    assert.equal(shape.boundMs, 52.086);
    assert.ok(shape.useOfBound > TIME_TO_DISMISS_TARGET, 'over the target this service pads towards');
    assert.ok(shape.takesMs < shape.boundMs, 'and still under the bound the LEDGER would refuse on');
  });

  it('measures nothing when the cost record stops agreeing with the bytes on the wire', () => {
    /* The whole point of the cross-check: a unit or model change must disable
       this arithmetic rather than pad against a number that means something
       else. `fees(params, true)` is the hard guard underneath either way. */
    const wrongUnits = feeShapeFromCost({
      readTimePs: 6_000_000_000n,
      computeTimePs: 35_000_000_000n,
      blockUsageBytes: 200n,
      serialisedBytes: TWO_CALL_BYTES,
    });
    assert.equal(wrongUnits, null);
    assert.equal(
      feeShapeFromCost({
        readTimePs: 0n,
        computeTimePs: 0n,
        blockUsageBytes: BigInt(TWO_CALL_BYTES),
        serialisedBytes: TWO_CALL_BYTES,
      }),
      null,
      'a transaction that takes no time at all is not a measurement',
    );
  });

  it('writes the ledger’s own sentence for a near miss, and reads it back', () => {
    const shape = feeShapeFromCost({
      readTimePs: 6_000_000_000n,
      computeTimePs: 35_000_000_000n,
      blockUsageBytes: BigInt(TWO_CALL_BYTES),
      serialisedBytes: TWO_CALL_BYTES,
    });
    assert.ok(shape);
    const parsed = parseTimeToDismiss(timeToDismissSentence(shape));
    assert.deepEqual(parsed, { takesMs: 41, bytes: TWO_CALL_BYTES, allowedMs: 52.086 });
  });
});

describe('the padding a two-call transaction asks for', () => {
  const shape = feeShapeFromCost({
    readTimePs: 6_000_000_000n,
    computeTimePs: 35_000_000_000n,
    blockUsageBytes: BigInt(TWO_CALL_BYTES),
    serialisedBytes: TWO_CALL_BYTES,
  });
  const sentence = timeToDismissSentence(shape!);

  it('is three crumbs, in one step, and the arithmetic holds', () => {
    assert.equal(crumbsForShape(41, TWO_CALL_BYTES), 3);
    assert.equal(paddingForVerdict(sentence, 0), 3);
    const takes = 41 + 3 * CRUMB_MS;
    const bound = boundMsFor(TWO_CALL_BYTES + 3 * CRUMB_BYTES);
    assert.ok(takes <= TIME_TO_DISMISS_TARGET * bound, `${takes} ms against ${bound} ms`);
    assert.ok(
      41 + 2 * CRUMB_MS > TIME_TO_DISMISS_TARGET * boundMsFor(TWO_CALL_BYTES + 2 * CRUMB_BYTES),
      'two would not do',
    );
  });

  it('subtracts the crumbs the transaction already carries', () => {
    /* The ledger's sentence describes the shape as BUILT, padding included, so
       reading it against a bare transaction would ask for the same crumbs
       twice. Same rule the contract climb has always used. */
    const padded = feeShapeFromCost({
      readTimePs: 6_000_000_000n,
      computeTimePs: BigInt(Math.round((35 + 2 * CRUMB_MS) * 1e9)),
      blockUsageBytes: BigInt(TWO_CALL_BYTES + 2 * CRUMB_BYTES),
      serialisedBytes: TWO_CALL_BYTES + 2 * CRUMB_BYTES,
    });
    assert.ok(padded);
    assert.equal(paddingForVerdict(timeToDismissSentence(padded), 2), 3);
  });
});

describe('the climb `/balance-only` runs for a caller’s transaction', () => {
  /**
   * `balanceOnly` in `../src/wallet.ts`, with the wallet taken out: balance,
   * measure, and either hand the transaction back or release it and balance
   * again with more crumbs. The model is the chain's own rule — each crumb
   * spend is {@link CRUMB_BYTES} of transaction and {@link CRUMB_MS} of
   * processing — and the transaction is the two-call send above.
   */
  const climb = (freeCrumbs: number, bareMs = 41, bareBytes = TWO_CALL_BYTES) => {
    const asked: number[] = [];
    let padding = 0;
    for (let round = 0; ; round += 1) {
      asked.push(padding);
      const applied = Math.min(padding, freeCrumbs);
      const shape = feeShapeFromCost({
        readTimePs: 0n,
        computeTimePs: BigInt(Math.round((bareMs + applied * CRUMB_MS) * 1e9)),
        blockUsageBytes: BigInt(bareBytes + applied * CRUMB_BYTES),
        serialisedBytes: bareBytes + applied * CRUMB_BYTES,
      });
      assert.ok(shape);
      if (shape.useOfBound <= TIME_TO_DISMISS_TARGET) {
        return { outcome: 'under the target' as const, applied, asked, rounds: round + 1 };
      }
      const next = nextFeeLegPadding({
        message: timeToDismissSentence(shape),
        asked: padding,
        applied,
        freeCrumbs,
      });
      if (next === null || round >= MAX_FEE_LEG_PADDING) {
        return { outcome: 'handed back' as const, applied, asked, rounds: round + 1 };
      }
      padding = next;
    }
  };

  it('reaches a shape under the target in two rounds when the crumbs are there', () => {
    const run = climb(40);
    assert.equal(run.outcome, 'under the target');
    assert.deepEqual(run.asked, [0, 3]);
    assert.equal(run.applied, 3);
  });

  it('pads as far as the crumbs allow and then hands the transaction back — it never refuses', () => {
    /* THE DIFFERENCE FROM THE CONTRACT CLIMB. A job of ours may fail; a user's
       send may not. The transaction handed back is exactly the transaction this
       service handed back before the guard existed, so a node that refuses it
       leaves the caller no worse off than a service that refused it first. */
    const run = climb(1);
    assert.equal(run.outcome, 'handed back');
    assert.equal(run.applied, 1, 'the one crumb that was free was still used');
  });

  it('hands back the unpadded transaction when no crumb is free at all', () => {
    const run = climb(0);
    assert.equal(run.outcome, 'handed back');
    assert.equal(run.applied, 0);
    assert.equal(run.rounds, 1, 'and does not prove a second fee leg to find that out');
  });

  it('stops at the cap however far over the bound the transaction is', () => {
    const run = climb(40, 400);
    assert.equal(run.outcome, 'handed back');
    assert.ok(run.rounds <= MAX_FEE_LEG_PADDING + 1, `${run.rounds} rounds`);
    assert.ok(run.applied <= MAX_FEE_LEG_PADDING);
  });

  it('never asks for a padding it has already tried, so the climb terminates', () => {
    for (const free of [0, 1, 2, 3, 5, 8, 40]) {
      const run = climb(free, 120);
      for (let i = 1; i < run.asked.length; i += 1) {
        assert.ok(
          (run.asked[i] as number) > (run.asked[i - 1] as number),
          `padding went ${run.asked[i - 1]} → ${run.asked[i]} with ${free} crumbs free`,
        );
      }
    }
  });
});

describe('the decision itself', () => {
  const sentence = timeToDismissSentence({
    takesMs: 41,
    bytes: TWO_CALL_BYTES,
    boundMs: boundMsFor(TWO_CALL_BYTES),
    useOfBound: 41 / boundMsFor(TWO_CALL_BYTES),
  });

  it('asks for what the sentence calls for, clamped to the crumbs that are free', () => {
    assert.equal(nextFeeLegPadding({ message: sentence, asked: 0, applied: 0, freeCrumbs: 40 }), 3);
    assert.equal(nextFeeLegPadding({ message: sentence, asked: 0, applied: 0, freeCrumbs: 2 }), 2);
  });

  it('gives up rather than rebuilding the same shape', () => {
    assert.equal(
      nextFeeLegPadding({ message: sentence, asked: 2, applied: 2, freeCrumbs: 2 }),
      null,
      'every free crumb is already in the transaction',
    );
    assert.equal(
      nextFeeLegPadding({
        message: sentence,
        asked: MAX_FEE_LEG_PADDING,
        applied: MAX_FEE_LEG_PADDING,
        freeCrumbs: 40,
      }),
      null,
      'at the cap',
    );
  });

  it('never hands back a padding at or below the one just tried', () => {
    for (let asked = 0; asked <= MAX_FEE_LEG_PADDING; asked += 1) {
      for (const freeCrumbs of [0, 1, 4, 40]) {
        const next = nextFeeLegPadding({ message: sentence, asked, applied: Math.min(asked, freeCrumbs), freeCrumbs });
        if (next !== null) assert.ok(next > asked, `${asked} → ${next}`);
        if (next !== null) assert.ok(next <= MAX_FEE_LEG_PADDING);
      }
    }
  });
});

describe('the DUST that pays for a two-call transaction', () => {
  /* A two-call transaction costs more to process and weighs more, so its fee is
     larger than a one-call send's. Nothing in the selection is keyed to a
     transaction shape — the SDK re-estimates after every input it takes and
     the selector answers the remaining need — so the only question is whether a
     LARGER need still resolves to a short set of inputs. */
  const oneCallFee = 12_000_000_000_000_000n;
  const twoCallFee = oneCallFee * 2n;
  const crumbs = Array.from({ length: 40 }, (_, i) => dust(String(i).padStart(64, '0'), 3_968_160_000n));

  it('takes ONE covering coin for the bigger fee, the smallest that covers it', () => {
    const big = dust('f'.repeat(64), 1_063_482_701_844_916_860n);
    const mid = dust('e'.repeat(64), 70_879_718_578_226_536n);
    const small = dust('d'.repeat(64), 30_000_000_000_000_000n);
    assert.deepEqual(balanceLike(dustFeeFirst, [big, mid, small, ...crumbs], twoCallFee), [small]);
  });

  it('combines the fewest coins when none covers it, well inside the input cap', () => {
    const a = dust('a'.repeat(64), 14n * DUST_CRUMB_FLOOR);
    const b = dust('b'.repeat(64), 11n * DUST_CRUMB_FLOOR);
    const c = dust('c'.repeat(64), 4n * DUST_CRUMB_FLOOR);
    const inputs = balanceLike(dustFeeFirst, [c, ...crumbs, a, b], twoCallFee);
    assert.deepEqual(inputs, [a, b], 'largest first, so the set is as short as it can be');
    assert.ok(inputs.length < maxDustInputsFor({ blockUsage: 200_000, bytesWritten: 50_000 }));
  });

  it('leaves room for the padding on top of the fee, under the ledger’s input cap', () => {
    const cap = maxDustInputsFor({ blockUsage: 200_000, bytesWritten: 50_000 });
    assert.equal(cap, MAX_DUST_INPUTS_CEILING);
    assert.ok(
      cap >= 1 + MAX_FEE_LEG_PADDING,
      'one covering coin and the full padding fit in one fee leg',
    );
  });

  it('builds the two-call fee leg with a covering coin and the padding asked for', () => {
    const coins = createCoinReservation({ log: () => undefined });
    coins.setMaxDustInputs(maxDustInputsFor({ blockUsage: 200_000, bytesWritten: 50_000 }));
    const select = coins.guard(createDustFeeSelector(coins));
    const covering = dust('f'.repeat(64), 1_063_482_701_844_916_860n);

    coins.setDustPadding(3);
    coins.beginBalance(null);
    const inputs = balanceLike(select, [covering, ...crumbs], twoCallFee);
    const selected = coins.endBalance();

    assert.equal(selected.filter(isCrumb).length, 3, 'three crumbs of padding');
    assert.equal(inputs.at(-1), covering, 'and the covering coin behind them');
    assert.ok(inputs.length <= coins.maxDustInputs());
  });

  it('reports the padding it APPLIED when the crumbs run out, not the padding asked for', () => {
    /* What `balanceOnly` counts out of `endBalance()`, and what the next round
       of the climb reads the ledger's sentence against. */
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(createDustFeeSelector(coins));
    const covering = dust('f'.repeat(64), 1_063_482_701_844_916_860n);
    const oneCrumb = crumbs.slice(0, 1);

    coins.setDustPadding(4);
    coins.beginBalance(null);
    balanceLike(select, [covering, ...oneCrumb], twoCallFee);
    assert.equal(coins.endBalance().filter(isCrumb).length, 1);
  });
});
