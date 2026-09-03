/**
 * The input pin, tested.
 *
 * `splitPlan.test.ts` pins what the split COSTS. This file pins what it
 * SPENDS, which is the property the 2026/09/02 ruling actually turns on: the
 * original ~4,998.87 NIGHT coin and one of the three 5,000 coins must come
 * through the operation untouched, because their accrued DUST is what pays
 * every fee while the ten new coins generate from zero.
 *
 * The hazard is concrete and it is the SDK's default behaviour. `chooseCoin`
 * (`wallet-sdk-capabilities/dist/balancer/Balancer.js:63-68`) sorts candidates
 * by value ASCENDING and takes the first, repeatedly, until the outputs are
 * covered. The smallest NIGHT UTxO in this wallet is the original coin. So a
 * plain `transferTransaction` self-send of 5,000 NIGHT — the obvious way to
 * split one coin — consumes the original coin FIRST and then breaks a 5,000 to
 * make up the shortfall. {@link chooseCoin} below reproduces that exactly, so
 * the test suite states the danger rather than assuming the reader remembers
 * it, and the rest of the file shows the pinned selector refusing to do it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertOnlyChosenInputs,
  createPinnedSelector,
  matchesRef,
  parseNightAmount,
  parseUtxoRef,
  Refusal,
  resolveRefs,
  utxoKey,
  type TransactionLike,
  type UtxoLike,
} from './splitInputs.js';

const NIGHT = '0100000000000000000000000000000000000000000000000000000000000000';

const coin = (intentHash: string, outputNo: number, night: bigint): UtxoLike => ({
  intentHash,
  outputNo,
  value: night * 1_000_000n,
  type: NIGHT,
});

/**
 * The live wallet on 2026/09/02: the original coin plus three inbound 5,000
 * NIGHT UTxOs. The hashes are the transaction prefixes the ruling names; the
 * ledger keys UTxOs by `intentHash`, and the plan's own listing is where the
 * operator gets the real ones.
 */
const ORIGINAL = coin('a0a0a0a0deadbeef', 0, 4_998n); // 4,998.87 rounded for the fixture
const NEWEST_A = coin('667b6124aaaaaaaa', 0, 5_000n);
const NEWEST_B = coin('8bab7b5ebbbbbbbb', 0, 5_000n);
const THIRD = coin('7577ca12cccccccc', 1, 5_000n);
const WALLET = [ORIGINAL, NEWEST_A, NEWEST_B, THIRD];

/**
 * The SDK's stock selector, reproduced from
 * `wallet-sdk-capabilities/dist/balancer/Balancer.js:63-68`. Present only so
 * the test below can show what it would do.
 */
const chooseCoin = (coins: readonly UtxoLike[], tokenType: string): UtxoLike | undefined =>
  coins
    .filter((candidate) => candidate.type === tokenType)
    .sort((a, b) => Number(a.value - b.value))
    .at(0);

/**
 * `doBalance`'s accumulate-until-covered loop, from
 * `wallet-sdk-capabilities/dist/balancer/Balancer.js:41-60`: keep asking the
 * selector for a coin until the running total exceeds what the outputs need,
 * then emit the overshoot as change.
 */
function accumulate(
  coins: readonly UtxoLike[],
  needed: bigint,
  select: (coins: readonly UtxoLike[], tokenType: string) => UtxoLike | undefined,
): { inputs: string[]; change: bigint } {
  let remaining = [...coins];
  let total = 0n;
  const inputs: string[] = [];
  while (total <= needed) {
    const picked = select(remaining, NIGHT);
    if (!picked) throw new Error('InsufficientFundsError');
    inputs.push(utxoKey(picked));
    total += picked.value;
    remaining = remaining.filter((candidate) => utxoKey(candidate) !== utxoKey(picked));
  }
  return { inputs, change: total - needed };
}

test('the SDK s own selector would eat the coin the ruling protects', () => {
  /* A self-send of exactly 5,000 NIGHT does NOT come out of one 5,000 UTxO. */
  const outcome = accumulate(WALLET, 5_000n * 1_000_000n, chooseCoin);
  assert.deepEqual(outcome.inputs, [utxoKey(ORIGINAL), utxoKey(NEWEST_A)]);
  assert.equal(outcome.inputs.length, 2);
  assert.ok(
    outcome.inputs.includes(utxoKey(ORIGINAL)),
    'smallest-first takes the original coin first — this is the whole reason --inputs exists',
  );
});

test('the pinned selector cannot reach a protected coin at all', () => {
  const selector = createPinnedSelector();
  selector.allow.add(utxoKey(NEWEST_A));
  const outcome = accumulate(WALLET, 4_000n * 1_000_000n, selector.select);
  assert.deepEqual(outcome.inputs, [utxoKey(NEWEST_A)]);
  assert.equal(outcome.change, 1_000n * 1_000_000n, 'the fifth coin is the change output');
  assert.deepEqual(selector.handedOut, [utxoKey(NEWEST_A)]);
  assert.deepEqual(selector.refusedFor, []);
});

test('an allow-list too small to cover the outputs fails rather than reaching further', () => {
  const selector = createPinnedSelector();
  selector.allow.add(utxoKey(NEWEST_A));
  /* 6,000 NIGHT of outputs out of one 5,000 coin. The stock selector would
     simply take a second UTxO; this one runs out and says so, which becomes an
     InsufficientFundsError before anything is signed. */
  assert.throws(() => accumulate(WALLET, 6_000n * 1_000_000n, selector.select), /Insufficient/);
  assert.deepEqual(selector.handedOut, [utxoKey(NEWEST_A)]);
  assert.deepEqual(selector.refusedFor, [NIGHT]);
});

test('an empty allow-list hands out nothing — the state before the wallet has synced', () => {
  const selector = createPinnedSelector();
  assert.equal(selector.select(WALLET, NIGHT), undefined);
  assert.deepEqual(selector.handedOut, []);
});

test('within the allow-list the SDK s smallest-first order is preserved', () => {
  const selector = createPinnedSelector();
  selector.allow.add(utxoKey(NEWEST_A));
  selector.allow.add(utxoKey(ORIGINAL));
  assert.equal(utxoKey(selector.select(WALLET, NIGHT)!), utxoKey(ORIGINAL));
});

test('a UTxO of another token type is never selected', () => {
  const selector = createPinnedSelector();
  const shielded: UtxoLike = { ...NEWEST_A, type: '02'.padEnd(64, '0') };
  selector.allow.add(utxoKey(shielded));
  assert.equal(selector.select([shielded], NIGHT), undefined);
});

test('references parse, and a malformed one is rejected', () => {
  assert.deepEqual(parseUtxoRef('667b6124:0'), { intentHashPrefix: '667b6124', outputNo: 0 });
  assert.deepEqual(parseUtxoRef('667B6124:12'), { intentHashPrefix: '667b6124', outputNo: 12 });
  assert.throws(() => parseUtxoRef('667b6124'), /output index/);
  assert.throws(() => parseUtxoRef('667b6124:'), /output index/);
  assert.throws(() => parseUtxoRef('667b6124:x'), /output index/);
  assert.throws(() => parseUtxoRef('zz:0'), /not a UTxO reference/);
  assert.throws(() => parseUtxoRef('66:0'), /at least four hex/);
  assert.throws(() => parseUtxoRef(':0'), /not a UTxO reference/);
});

test('a reference matches on the output number as well as the hash', () => {
  assert.ok(matchesRef(THIRD, parseUtxoRef('7577ca12:1')));
  assert.ok(!matchesRef(THIRD, parseUtxoRef('7577ca12:0')), 'the output index is part of the name');
});

test('references resolve to exactly the two newest coins', () => {
  const withMeta = WALLET.map((utxo) => ({ utxo }));
  const chosen = resolveRefs(withMeta, ['667b6124:0', '8bab7b5e:0'].map(parseUtxoRef));
  assert.deepEqual(chosen.map((entry) => utxoKey(entry.utxo)), [
    utxoKey(NEWEST_A),
    utxoKey(NEWEST_B),
  ]);
  const chosenKeys = new Set(chosen.map((entry) => utxoKey(entry.utxo)));
  const untouched = withMeta.filter((entry) => !chosenKeys.has(utxoKey(entry.utxo)));
  assert.deepEqual(untouched.map((entry) => utxoKey(entry.utxo)), [
    utxoKey(ORIGINAL),
    utxoKey(THIRD),
  ]);
});

test('a reference that names nothing, or names two things, is a refusal', () => {
  const withMeta = WALLET.map((utxo) => ({ utxo }));
  assert.throws(() => resolveRefs(withMeta, [parseUtxoRef('ffffffff:0')]), Refusal);
  assert.throws(() => resolveRefs(withMeta, [parseUtxoRef('ffffffff:0')]), /matches/);
  /* A prefix short enough to hit two UTxOs is a coin toss, so it is refused. */
  const twins = [coin('abcd1111', 0, 1n), coin('abcd2222', 0, 1n)].map((utxo) => ({ utxo }));
  assert.throws(() => resolveRefs(twins, [parseUtxoRef('abcd:0')]), /lengthen the hash prefix/);
  assert.throws(
    () => resolveRefs(withMeta, [parseUtxoRef('667b6124:0'), parseUtxoRef('667b6124:0')]),
    /named twice/,
  );
});

test('NIGHT amounts parse to atomic units, and only to six places', () => {
  assert.equal(parseNightAmount('1000'), 1_000_000_000n);
  assert.equal(parseNightAmount('1000.5'), 1_000_500_000n);
  assert.equal(parseNightAmount('4998.87'), 4_998_870_000n);
  assert.equal(parseNightAmount('0.000001'), 1n);
  assert.throws(() => parseNightAmount('1000.0000001'), /six places/);
  assert.throws(() => parseNightAmount('-1'), /six places/);
  assert.throws(() => parseNightAmount(undefined), /six places/);
});

/* -------------------------------------------------------------------------- */
/* The second, independent check                                              */
/* -------------------------------------------------------------------------- */

const transactionSpending = (...inputs: UtxoLike[]): TransactionLike => ({
  intents: new Map([[0, { fallibleUnshieldedOffer: { inputs } }]]),
});

test('the built transaction is checked against --inputs, not merely trusted', () => {
  const selector = createPinnedSelector();
  const chosen = new Set([utxoKey(NEWEST_A), utxoKey(NEWEST_B)]);
  selector.handedOut.push(utxoKey(NEWEST_A), utxoKey(NEWEST_B));
  const seen = assertOnlyChosenInputs(transactionSpending(NEWEST_A, NEWEST_B), chosen, selector);
  assert.deepEqual(seen.sort(), [utxoKey(NEWEST_A), utxoKey(NEWEST_B)].sort());
});

test('a transaction that reached a protected coin is refused before signing', () => {
  const selector = createPinnedSelector();
  const chosen = new Set([utxoKey(NEWEST_A)]);
  assert.throws(
    () => assertOnlyChosenInputs(transactionSpending(NEWEST_A, ORIGINAL), chosen, selector),
    /would spend .* which is NOT among --inputs/,
  );
  /* Both sections of the intent are read: a protected coin in the guaranteed
     offer is caught exactly as one in the fallible offer is. */
  const guaranteed: TransactionLike = {
    intents: new Map([[0, { guaranteedUnshieldedOffer: { inputs: [ORIGINAL] } }]]),
  };
  assert.throws(() => assertOnlyChosenInputs(guaranteed, chosen, selector), Refusal);
});

test('the selector s own ledger is checked too, and an empty transaction is refused', () => {
  const selector = createPinnedSelector();
  selector.handedOut.push(utxoKey(ORIGINAL));
  assert.throws(
    () =>
      assertOnlyChosenInputs(
        transactionSpending(NEWEST_A),
        new Set([utxoKey(NEWEST_A)]),
        selector,
      ),
    /the selector handed out/,
  );

  const clean = createPinnedSelector();
  assert.throws(
    () => assertOnlyChosenInputs(transactionSpending(), new Set([utxoKey(NEWEST_A)]), clean),
    /spends no unshielded input at all/,
  );
  assert.throws(
    () => assertOnlyChosenInputs({}, new Set([utxoKey(NEWEST_A)]), clean),
    /carries no intents/,
  );
});
