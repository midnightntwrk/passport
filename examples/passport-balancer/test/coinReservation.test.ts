/**
 * Which coins a spend job may not be handed.
 *
 * No wallet, no SDK: the selectors under test are the SDK's own rules restated
 * from the dist (`smallestOfType`, `smallestDust`), and the reservation is
 * exercised the way the wallet exercises it — a ticket per job, `hold` after
 * balancing, `submitted` after the node takes the bytes, `observe` from the
 * state stream, `release` on revert.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CoinContention,
  coinKey,
  createCoinReservation,
  describeCoin,
  DUST_CRUMB_FLOOR,
  dustFeeFirst,
  isCoinContention,
  isCrumb,
  LARGE_NIGHT_ATOMIC,
  nightPayloadFirst,
  smallestDust,
  smallestOfType,
  unshieldedInputsOf,
  type CoinSelector,
  type SelectableCoin,
} from '../src/coinReservation.js';
import { DEFAULT_SPEND_QUEUE_MAX } from '../src/config.js';
import { TokenBucket } from '../src/limits.js';
import {
  assertNoDuplicateInputs,
  boundMsFor,
  createDustFeeSelector,
  CRUMB_BYTES,
  CRUMB_MS,
  crumbsForDeficit,
  crumbsForShape,
  DuplicateInput,
  inputKeysOf,
  isTimeToDismiss,
  MIN_TIME_TO_DISMISS_MS,
  parseTimeToDismiss,
  TIME_TO_DISMISS_TARGET,
} from '../src/coinReservation.js';

const NIGHT = '0'.repeat(64);
const night = (intentHash: string, outputNo: number, value: bigint): SelectableCoin => ({
  type: NIGHT,
  value,
  intentHash,
  outputNo,
});
const dust = (nonce: string, generated: bigint): SelectableCoin => ({
  value: generated,
  token: { nonce },
});

/** Two NIGHT UTxOs, the small one first the way the SDK would pick it. */
const n1 = night('a'.repeat(64), 0, 2_000n);
const n2 = night('b'.repeat(64), 1, 5_000n);
const n3 = night('c'.repeat(64), 0, 9_000n);

describe('the SDK rules, restated', () => {
  it('hands out the smallest coin of the imbalanced type', () => {
    assert.equal(smallestOfType([n3, n2, n1], NIGHT, 2_000n, {}), n1);
    assert.equal(smallestOfType([n1], 'ff', 1n, {}), undefined);
  });

  it('hands out the smallest dust coin with anything generated, asked for no type', () => {
    const empty = dust('0'.repeat(64), 0n);
    const small = dust('1'.repeat(64), 10n);
    const large = dust('2'.repeat(64), 10_000n);
    assert.equal(smallestDust([large, empty, small], '', 1n, {}), small);
  });
});

describe('two concurrent grants', () => {
  it('select DISJOINT NIGHT coins, because the first one holds what it took', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(smallestOfType);

    const a = coins.open('grant A');
    const chosenA = select([n1, n2, n3], NIGHT, 2_000n, {});
    assert.equal(chosenA, n1);
    a.hold([coinKey(chosenA!)]);

    const b = coins.open('grant B');
    const chosenB = select([n1, n2, n3], NIGHT, 2_000n, {});
    assert.equal(chosenB, n2, 'the second grant is not handed the coin the first took');
    b.hold([coinKey(chosenB!)]);

    assert.deepEqual(coins.excluded().sort(), [coinKey(n1), coinKey(n2)].sort());
  });

  it('a third waits, then proceeds once one of them lets go', async () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(smallestOfType);
    const a = coins.open('grant A');
    a.hold([coinKey(n1)]);
    const b = coins.open('grant B');
    b.hold([coinKey(n2)]);

    /* Only two coins exist, both taken: the shortage is contention, not poverty. */
    assert.equal(select([n1, n2], NIGHT, 2_000n, {}), undefined);
    assert.equal(coins.isContended(NIGHT, [n1, n2]), true);
    assert.equal(coins.isContended('ff', [n1, n2]), false, 'a type nobody holds is simply absent');

    const waited = coins.whenReleased(5_000);
    a.release();
    assert.equal(await waited, true, 'the wait ends on the release, not on the clock');
    assert.equal(select([n1, n2], NIGHT, 2_000n, {}), n1, 'and the freed coin is the one it gets');
  });

  it('a wait nobody satisfies ends with the bound, and says so', async () => {
    const coins = createCoinReservation({ log: () => undefined });
    assert.equal(await coins.whenReleased(0), false);
  });
});

describe('a reverted job frees its coins', () => {
  it('release returns every held coin to selection', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(smallestOfType);
    const a = coins.open('grant A');
    a.hold([coinKey(n1), coinKey(n2)]);
    assert.equal(select([n1, n2], NIGHT, 1n, {}), undefined);
    a.release();
    assert.equal(select([n1, n2], NIGHT, 1n, {}), n1);
    assert.deepEqual(coins.excluded(), []);
  });

  it('a second release, or a hold after release, changes nothing', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const a = coins.open('grant A');
    a.hold([coinKey(n1)]);
    a.release();
    a.release();
    a.hold([coinKey(n2)]);
    assert.deepEqual(coins.excluded(), []);
  });
});

describe('a submitted transaction keeps its coins out of reach', () => {
  it('even when the facade puts them back in `available` before the sync applies the spend', () => {
    const log: string[] = [];
    let now = 1_000;
    const coins = createCoinReservation({ now: () => now, log: (line) => log.push(line) });
    const select = coins.guard(smallestOfType);
    const a = coins.open('grant A');
    a.hold([coinKey(n1)]);
    a.submitted(now + 60_000);

    /* The facade's PARTIAL_SUCCESS revert: n1 is back in available. */
    coins.observe([coinKey(n1), coinKey(n2)], []);
    assert.equal(select([n1, n2], NIGHT, 1n, {}), n2, 'n1 is in flight and stays excluded');

    /* Releasing the ticket now does nothing: the exclusion is the transaction's, not the job's. */
    a.release();
    assert.equal(select([n1, n2], NIGHT, 1n, {}), n2);

    /* The sync applies the spend: n1 is in neither list. */
    coins.observe([coinKey(n2)], []);
    assert.deepEqual(coins.excluded(), []);
    assert.match(log.at(-1)!, /is applied on chain — forgotten/);
  });

  it('is forgotten once its transaction cannot land any more, with a line saying so', () => {
    const log: string[] = [];
    let now = 1_000;
    const coins = createCoinReservation({ now: () => now, log: (line) => log.push(line) });
    const select = coins.guard(smallestOfType);
    const a = coins.open('grant A');
    a.hold([coinKey(n1)]);
    a.submitted(now + 60_000);
    assert.equal(select([n1], NIGHT, 1n, {}), undefined);
    now += 60_001;
    assert.equal(select([n1], NIGHT, 1n, {}), n1);
    assert.match(log.at(-1)!, /TTL has passed — selectable again/);
  });

  it('a coin still pending in the wallet is not mistaken for applied', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const a = coins.open('grant A');
    a.hold([coinKey(n1)]);
    a.submitted(Date.now() + 60_000);
    coins.observe([], [coinKey(n1)]);
    assert.deepEqual(coins.excluded(), [coinKey(n1)]);
  });
});

describe('naming a coin for the journal', () => {
  it('keys unshielded coins by intent hash and index, and the others by nonce', () => {
    assert.equal(coinKey(n1), `u:${'a'.repeat(64)}:0`);
    assert.equal(coinKey({ type: 'ff', value: 1n, nonce: 'abc' }), 'n:abc');
    assert.equal(coinKey(dust('def', 1n)), 'n:def');
  });

  it('reads as the type, the shortened key, and the value', () => {
    assert.equal(describeCoin(n1), `NIGHT u:aaaaaaaaaa…aaaaaa:0 value 2000`);
    assert.equal(describeCoin(dust('9'.repeat(64), 77n)), `DUST n:9999999999…99999999 value 77`);
    assert.equal(
      describeCoin({ type: 'ab'.repeat(32), value: 5n, nonce: 'n' }, { [`${'ab'.repeat(32)}`]: 'mUSD' }),
      'mUSD n:n value 5',
    );
  });
});

describe('the NIGHT payload selector', () => {
  const lineage = night('d'.repeat(64), 0, LARGE_NIGHT_ATOMIC);
  const bigger = night('e'.repeat(64), 0, LARGE_NIGHT_ATOMIC * 30n);

  it('never picks a 1,000-NIGHT lineage for a 2,000-atomic grant while change exists', () => {
    assert.equal(nightPayloadFirst([bigger, lineage, n2, n1], NIGHT, 2_000n, {}), n1);
    assert.equal(nightPayloadFirst([lineage, n2], NIGHT, 2_000n, {}), n2);
  });

  it('hands back NOTHING for a small need when only lineages remain — the wallet waits instead', () => {
    assert.equal(nightPayloadFirst([bigger, lineage], NIGHT, 2_000n, {}), undefined);
    assert.equal(nightPayloadFirst([bigger, lineage], NIGHT, -2_000n, {}), undefined, 'a deficit is a negative amount');
    assert.equal(nightPayloadFirst([bigger, lineage], NIGHT, 10n, {}), undefined, "a registration's COST");
  });

  it('spends a lineage only for a need no change coin could cover, smallest lineage first', () => {
    assert.equal(nightPayloadFirst([bigger, lineage], NIGHT, LARGE_NIGHT_ATOMIC, {}), lineage);
    assert.equal(nightPayloadFirst([bigger, lineage], NIGHT, -(LARGE_NIGHT_ATOMIC * 2n), {}), lineage);
  });

  it('is the plain smallest-first rule for any other token', () => {
    const a = { type: 'ff', value: 5n, nonce: 'a' };
    const b = { type: 'ff', value: 1n, nonce: 'b' };
    assert.equal(nightPayloadFirst([a, b], 'ff', 1n, {}), b);
  });

  it('composes with the guard: a held change coin is skipped for the next change coin, not a lineage', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(nightPayloadFirst);
    coins.open('grant A').hold([coinKey(n1)]);
    assert.equal(select([lineage, n1, n2], NIGHT, 2_000n, {}), n2);
  });
});

describe('reading the unshielded inputs from a balanced recipe', () => {
  const input = (intentHash: string, outputNo: number, value: bigint) => ({
    value,
    owner: 'owner',
    type: NIGHT,
    intentHash,
    outputNo,
  });

  it("walks every intent's guaranteed and fallible offers of an unbound recipe", () => {
    const recipe = {
      type: 'UNBOUND_TRANSACTION',
      baseTransaction: {
        intents: new Map([
          [1, { guaranteedUnshieldedOffer: { inputs: [input('A'.repeat(64), 0, 10n)] } }],
          [61517, { fallibleUnshieldedOffer: { inputs: [input('b'.repeat(64), 1, 2_000n)] } }],
        ]),
      },
    };
    const found = unshieldedInputsOf(recipe);
    assert.deepEqual(
      found.map(coinKey),
      [`u:${'a'.repeat(64)}:0`, `u:${'b'.repeat(64)}:1`],
      'keys are lowercased, so the recipe and the wallet state agree',
    );
    assert.equal(found[1]!.value, 2_000n);
  });

  it('reads an unproven recipe and a finalized one too, and nothing from a recipe with no intents', () => {
    const one = unshieldedInputsOf({
      type: 'UNPROVEN_TRANSACTION',
      transaction: { intents: new Map([[1, { guaranteedUnshieldedOffer: { inputs: [input('c'.repeat(64), 2, 5n)] } }]]) },
    });
    assert.equal(one.length, 1);
    assert.deepEqual(unshieldedInputsOf({ type: 'UNBOUND_TRANSACTION', baseTransaction: {} }), []);
    assert.deepEqual(unshieldedInputsOf(undefined), []);
  });
});

describe('the coins a balance creates', () => {
  const successor = dust('5'.repeat(64), 1_000n);

  it('are excluded while the job is open, and while its transaction is in flight', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(smallestDust);
    const deploy = coins.open('the registration of famtl14uefvbh.night');
    deploy.hold([coinKey(dust('1'.repeat(64), 5n))]);
    deploy.created([coinKey(successor)]);
    assert.equal(select([successor], '', 1n, {}), undefined, 'held: not on chain yet');
    deploy.submitted(Date.now() + 60_000);
    assert.equal(select([successor], '', 1n, {}), undefined, 'in flight: still not on chain');
    assert.deepEqual(coins.excluded().sort(), [coinKey(dust('1'.repeat(64), 5n)), coinKey(successor)].sort());
  });

  it('become selectable the moment the spend that created them is applied', () => {
    const log: string[] = [];
    const coins = createCoinReservation({ log: (line) => log.push(line) });
    const select = coins.guard(smallestDust);
    const spent = dust('1'.repeat(64), 5n);
    const deploy = coins.open('the registration of famtl14uefvbh.night');
    deploy.hold([coinKey(spent)]);
    deploy.created([coinKey(successor)]);
    deploy.submitted(Date.now() + 60_000);

    /* The successor is in available throughout; the spent coin is pending until applied. */
    coins.observe([coinKey(successor)], [coinKey(spent)]);
    assert.equal(select([successor], '', 1n, {}), undefined, 'predecessor still pending');

    coins.observe([coinKey(successor)], []);
    assert.equal(select([successor], '', 1n, {}), successor, 'the deploy landed: the successor is real');
    assert.match(log.at(-1)!, /is applied on chain — forgotten \(1 consumed, 1 created\)/);
    assert.deepEqual(coins.excluded(), []);
  });

  it('a revert before submission frees the created coins with the consumed ones', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(smallestDust);
    const job = coins.open('grant');
    job.hold([coinKey(dust('1'.repeat(64), 5n))]);
    job.created([coinKey(successor)]);
    job.release();
    assert.equal(select([successor], '', 1n, {}), successor);
  });

  it('expire with the transaction, and the line counts them', () => {
    const log: string[] = [];
    let now = 1_000;
    const coins = createCoinReservation({ now: () => now, log: (line) => log.push(line) });
    const select = coins.guard(smallestDust);
    const job = coins.open('grant');
    job.hold([coinKey(dust('1'.repeat(64), 5n))]);
    job.created([coinKey(successor)]);
    job.submitted(now + 10);
    now += 11;
    assert.equal(select([successor], '', 1n, {}), successor);
    assert.match(log.at(-1)!, /TTL has passed — selectable again \(2 coins\)/);
  });
});

describe('recording what a balance is handed', () => {
  it('holds each coin the instant the selector hands it out, with no state to diff', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(smallestOfType);
    const a = coins.open('the spare mUSD mint');
    coins.beginBalance(a);
    assert.equal(select([n1, n2, n3], NIGHT, 1n, {}), n1);
    assert.deepEqual(coins.excluded(), [coinKey(n1)], 'held before the SDK has committed anything');
    /* Its own held coin is still selectable BY ITSELF: within one balance the
       SDK removes each chosen coin from its own pool (`isCoinEqual` in
       `doBalance`), so the guard need not; across attempts, that is how a
       rebuild keeps what it holds. */
    assert.equal(select([n2, n3], NIGHT, 1n, {}), n2, 'the pool the SDK asks with no longer has n1');
    const handed = coins.endBalance();
    assert.deepEqual(handed, [n1, n2]);

    /* The next balance, serialised behind it, is handed the one coin left. */
    const b = coins.open('the activation grant');
    coins.beginBalance(b);
    assert.equal(select([n1, n2, n3], NIGHT, 1n, {}), n3);
    assert.deepEqual(coins.endBalance(), [n3]);
    assert.deepEqual(coins.excluded().sort(), [coinKey(n1), coinKey(n2), coinKey(n3)].sort());
    a.release();
    assert.deepEqual(coins.excluded(), [coinKey(n3)]);
  });

  it('records nothing outside a balance, and endBalance with none active is empty', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(smallestOfType);
    assert.equal(select([n1], NIGHT, 1n, {}), n1);
    assert.deepEqual(coins.excluded(), []);
    assert.deepEqual(coins.endBalance(), []);
    assert.equal(coins.hasFlights(), false);
  });
});

/**
 * The SDK's balancing loop, restated: ask the selector for the remaining need,
 * take what it returns, remove it from the pool, ask again until covered or
 * refused. `doBalance` in wallet-sdk-capabilities' `Balancer.js`.
 */
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

describe('the DUST fee selector', () => {
  const crumbs = Array.from({ length: 40 }, (_, i) => dust(String(i).padStart(64, '0'), 3_968_160_000n));
  const large = dust('f'.repeat(64), 1_063_482_701_844_916_860n);
  const mid = dust('e'.repeat(64), 70_879_718_578_226_536n);

  it('forty-one coins with one large: exactly ONE input, the large one', () => {
    const inputs = balanceLike(dustFeeFirst, [...crumbs, large], 15_000_000_000_000_000n);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0], large);
  });

  it('several coins cover the need: the SMALLEST that covers it, alone', () => {
    const inputs = balanceLike(dustFeeFirst, [large, mid, ...crumbs], 15_000_000_000_000_000n);
    assert.deepEqual(inputs, [mid]);
  });

  it('none covers the need: largest first, the shortest set', () => {
    const a = dust('a'.repeat(64), 9n * DUST_CRUMB_FLOOR);
    const b = dust('b'.repeat(64), 5n * DUST_CRUMB_FLOOR);
    const c = dust('c'.repeat(64), 2n * DUST_CRUMB_FLOOR);
    const inputs = balanceLike(dustFeeFirst, [c, ...crumbs, a, b], 13n * DUST_CRUMB_FLOOR);
    assert.deepEqual(inputs, [a, b]);
  });

  it('crumbs below the floor are passed over while anything else exists, and used only when nothing else does', () => {
    assert.equal(dustFeeFirst([...crumbs, mid], 'dust', -1n, {}), mid, 'a crumb would have covered 1 Speck, and is still not chosen');
    const only = dustFeeFirst(crumbs, 'dust', -1n, {});
    assert.ok(only && crumbs.includes(only), 'with nothing else, a crumb it is');
    assert.equal(dustFeeFirst([dust('0'.repeat(64), 0n)], 'dust', -1n, {}), undefined, 'a coin with nothing generated is never an input');
  });

  it('sits behind the guard: a held large coin is not the one input', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(dustFeeFirst);
    coins.open('other').hold([coinKey(large)]);
    assert.equal(select([large, mid, ...crumbs], 'dust', -15_000_000_000_000_000n, {}), mid);
  });
});

describe('a ticket across its own rebuild attempts', () => {
  it('keeps its coins held after a refusal, may be handed them again, and nobody else may', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(nightPayloadFirst);
    const grant = coins.open('the activation grant for 1cfa…');
    coins.beginBalance(grant);
    assert.equal(select([n1, n2], NIGHT, -2_000n, {}), n1);
    coins.endBalance();
    /* Refused at the RPC: nothing is released. The rebuild balances again. */
    coins.beginBalance(grant);
    assert.equal(select([n1, n2], NIGHT, -2_000n, {}), n1, 'its own held coin, again');
    coins.endBalance();
    const other = coins.open('the activation grant for c427…');
    coins.beginBalance(other);
    assert.equal(select([n1, n2], NIGHT, -2_000n, {}), n2, 'the job beside it is not handed n1');
    coins.endBalance();
    assert.equal(grant.isOpen(), true);
    grant.release();
    assert.equal(grant.isOpen(), false);
  });

  it('a released coin is selectable by the next asker in the same tick — one ordered path', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(smallestOfType);
    const refused = coins.open('refused grant');
    refused.hold([coinKey(n1)]);
    const next = coins.open('registration');
    coins.beginBalance(next);
    assert.equal(select([n1, n2], NIGHT, 1n, {}), n2, 'held elsewhere: not n1');
    refused.release();
    assert.equal(select([n1, n2], NIGHT, 1n, {}), n1, 'the release is visible to the very next call');
    coins.endBalance();
  });

  it('a submitted ticket becomes a flight and a fresh ticket serves the next attempt', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const t = coins.open('grant');
    t.hold([coinKey(n1)]);
    t.submitted(Date.now() + 60_000);
    assert.equal(t.isOpen(), false);
    assert.equal(coins.hasFlights(), true);
    t.hold([coinKey(n2)]);
    assert.deepEqual(coins.excluded(), [coinKey(n1)], 'a flight takes no more coins');
  });
});

describe('inputs that arrived without a selector being asked', () => {
  it('are refused when another job holds one of them, and the refusal is rebuildable', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const a = coins.open('the activation grant for 1cfa…');
    a.hold([coinKey(n1)]);
    const b = coins.open('the activation grant for c427…');
    assert.throws(
      () => coins.claimInputs(b, [n1]),
      (cause: unknown) => cause instanceof CoinContention && cause.key === coinKey(n1) && /1cfa/.test(cause.heldBy),
    );
    assert.equal(isCoinContention(new Error('wrapped', { cause: new CoinContention('k', 'x') })), true);
    assert.equal(isCoinContention(new Error('insufficient funds')), false);
  });

  it('are refused when one is in flight, and otherwise held by the claimant', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const a = coins.open('grant A');
    a.hold([coinKey(n1)]);
    a.submitted(Date.now() + 60_000);
    const b = coins.open('grant B');
    assert.throws(() => coins.claimInputs(b, [n1]), /in flight/);
    coins.claimInputs(b, [n2, n3]);
    assert.deepEqual(coins.excluded().sort(), [coinKey(n1), coinKey(n2), coinKey(n3)].sort());
    coins.claimInputs(b, [n2]);
  });
});

describe('the queue depth and the journal name for dust', () => {
  it('queues thirty-two sponsorship requests by default', () => {
    assert.equal(DEFAULT_SPEND_QUEUE_MAX, 32);
  });

  it("names a coin the dust wallet types as 'dust' DUST", () => {
    assert.equal(describeCoin({ type: 'dust', value: 5n, token: { nonce: 'ab' } }), 'DUST n:ab value 5');
  });
});

describe('the SDK asking twice within one balance', () => {
  const large = dust('f'.repeat(64), 1_063_482_701_844_916_860n);
  const mid = dust('e'.repeat(64), 70_879_718_578_226_536n);

  it('is handed two DISTINCT coins, or one coin and then none', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(dustFeeFirst);
    const job = coins.open('the activation grant');
    coins.beginBalance(job);
    const first = select([large, mid], 'dust', -15_000_000_000_000_000n, {});
    const second = select([large, mid], 'dust', -15_000_000_000_000_000n, {});
    assert.equal(first, mid);
    assert.equal(second, large, 'the second ask of the same balance is not answered with mid again');
    assert.equal(select([large, mid], 'dust', -1n, {}), undefined, 'and a third ask, with both handed, gets none');
    coins.endBalance();
    /* The same job's NEXT balance may have its own coins again. */
    coins.beginBalance(job);
    assert.equal(select([large, mid], 'dust', -15_000_000_000_000_000n, {}), mid);
    coins.endBalance();
  });

  it('a transaction that names one input twice is refused before proving, and that is rebuildable', () => {
    const nullifier = 'ab'.repeat(32);
    const recipe = {
      type: 'UNBOUND_TRANSACTION',
      baseTransaction: { intents: new Map([[1, { guaranteedUnshieldedOffer: { inputs: [{ intentHash: 'c'.repeat(64), outputNo: 0, value: 10n, type: NIGHT, owner: 'o' }] } }]]) },
      balancingTransaction: {
        intents: new Map([[2, { dustActions: { spends: [{ oldNullifier: nullifier }, { oldNullifier: nullifier }] } }]]),
      },
    };
    assert.deepEqual(inputKeysOf(recipe), [`u:${'c'.repeat(64)}:0`, `d:${nullifier}`, `d:${nullifier}`]);
    assert.throws(() => assertNoDuplicateInputs(recipe), (cause: unknown) => cause instanceof DuplicateInput && isCoinContention(cause));
    assert.throws(
      () => createCoinReservation({ log: () => undefined }).claimInputs(createCoinReservation({ log: () => undefined }).open('x'), [n1, n1]),
      DuplicateInput,
    );
  });
});

describe('a job refused on its inputs', () => {
  it('is not handed them again, keeps them from everyone else, and is told plainly when nothing else is free', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(nightPayloadFirst);
    const grant = coins.open('grant');
    coins.beginBalance(grant);
    assert.equal(select([n1, n2], NIGHT, -2_000n, {}), n1);
    coins.endBalance();
    grant.refused();
    assert.equal(grant.avoiding(), 1);
    coins.beginBalance(grant);
    assert.equal(select([n1, n2], NIGHT, -2_000n, {}), n2, 'a different shape');
    coins.endBalance();
    grant.refused();
    coins.beginBalance(grant);
    assert.equal(select([n1, n2], NIGHT, -2_000n, {}), undefined, 'nothing else: the balance fails and the job says so');
    coins.endBalance();
    const other = coins.open('registration');
    coins.beginBalance(other);
    assert.equal(select([n1, n2, n3], NIGHT, 1n, {}), n3, 'the refused coins are still held from others');
    coins.endBalance();
    grant.release();
    assert.equal(grant.avoiding(), 0);
    assert.deepEqual(coins.excluded(), [coinKey(n3)]);
  });
});

describe('padding a fee leg for size', () => {
  const crumbs = Array.from({ length: 5 }, (_, i) => dust(String(i).padStart(64, '0'), 3_968_160_000n + BigInt(i)));
  const large = dust('f'.repeat(64), 1_063_482_701_844_916_860n);

  it('answers the first `padding` asks with the largest crumbs, then the covering coin', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(createDustFeeSelector(coins));
    const job = coins.open('grant');
    coins.setDustPadding(2);
    coins.beginBalance(job);
    const inputs = balanceLike(select, [large, ...crumbs], 15_000_000_000_000_000n);
    coins.endBalance();
    assert.deepEqual(inputs, [crumbs[4], crumbs[3], large], 'the largest crumbs first — the oldest');
  });

  it('with no padding is the one-coin selector', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const select = coins.guard(createDustFeeSelector(coins));
    coins.beginBalance(coins.open('grant'));
    assert.deepEqual(balanceLike(select, [large, ...crumbs], 15_000_000_000_000_000n), [large]);
    coins.endBalance();
  });

  it("recognises the ledger's refusal wherever it is wrapped", () => {
    const ledgerMessage =
      'exceeded the maximum time to dismiss for transaction size; this transaction would take 12s to dismiss, but given its size of 9000 bytes, it may take at most 9s';
    assert.equal(isTimeToDismiss(new Error(ledgerMessage)), true);
    assert.equal(isTimeToDismiss(new Error('outer', { cause: new Error(ledgerMessage) })), true);
    assert.equal(isTimeToDismiss(new Error('insufficient funds')), false);
  });
});

describe('a probe the client was told to repeat', () => {
  it('gets its rate-limit token back', () => {
    let now = 0;
    const bucket = new TokenBucket({ ratePerMinute: 3, burst: 3, now: () => now });
    assert.equal(bucket.take('c').allowed, true);
    assert.equal(bucket.take('c').allowed, true);
    assert.equal(bucket.take('c').allowed, true);
    assert.equal(bucket.take('c').allowed, false, 'the fourth in the same instant is refused');
    bucket.refund('c');
    assert.equal(bucket.take('c').allowed, true, 'a refunded probe leaves room for the next');
    bucket.refund('unknown');
  });
});

describe('one NIGHT coin for a small need', () => {
  const c10a = night('1'.repeat(64), 0, 10n);
  const c10b = night('2'.repeat(64), 0, 10n);
  const c12020 = night('3'.repeat(64), 0, 12_020n);
  const c17980 = night('4'.repeat(64), 0, 17_980n);

  it('is the smallest change coin that covers the need, not six crumbs and a coin', () => {
    assert.equal(nightPayloadFirst([c10a, c10b, c12020, c17980], NIGHT, -2_000n, {}), c12020);
    assert.equal(nightPayloadFirst([c10a, c10b, c17980], NIGHT, -12_500n, {}), c17980);
  });

  it('accumulates largest-first only when no single change coin covers it', () => {
    assert.equal(nightPayloadFirst([c10a, c10b, c12020], NIGHT, -15_000n, {}), c12020);
    assert.equal(nightPayloadFirst([c10a, c10b], NIGHT, -15n, {}), c10a);
  });
});

describe('how many crumbs a deficit is worth', () => {
  it('reads the ledger line and pads by the deficit plus one', () => {
    const line =
      'exceeded the maximum time to dismiss for transaction size; this transaction would take 29.513ms to dismiss, but given its size of 9503 bytes, it may take at most 19.006ms';
    assert.equal(crumbsForDeficit(line), 5, '10.5 ms short at 3.3 ms a crumb is four, plus one');
    assert.equal(
      crumbsForDeficit('this transaction would take 34.818ms to dismiss, but given its size of 15509 bytes, it may take at most 31.018ms'),
      3,
    );
  });

  it('handles seconds and microseconds, never fewer than one nor more than eight, and two when it cannot read the line', () => {
    assert.equal(crumbsForDeficit('would take 1s to dismiss, but given its size of 1 bytes, it may take at most 900ms'), 8);
    assert.equal(crumbsForDeficit('would take 500µs to dismiss, but given its size of 1 bytes, it may take at most 400µs'), 2, 'any deficit at all is one crumb plus the margin');
    assert.equal(crumbsForDeficit('would take 1ms to dismiss, but given its size of 1 bytes, it may take at most 5ms'), 1);
    assert.equal(crumbsForDeficit('something else entirely'), 2);
  });
});

describe("the chain's fee rule, in the ledger's own numbers", () => {
  /* The proven grant of 07:18:09 on 2026/09/03, from the journal: 15.935 ms in
     7,118 bytes against a 15.000 ms bound; refused with one DUST input,
     refused with two and three, landed with four (a6f08aff…, 07:28:03). */
  const REAL = 'exceeded the maximum time to dismiss for transaction size; this transaction would take 15.935ms to dismiss, but given its size of 7118 bytes, it may take at most 15.000ms';

  it("parses the ledger's sentence", () => {
    assert.deepEqual(parseTimeToDismiss(REAL), { takesMs: 15.935, bytes: 7118, allowedMs: 15 });
    assert.equal(parseTimeToDismiss('something else'), null);
  });

  it('states the bound as the parameters do: a 15 ms floor, then 2 µs a byte', () => {
    assert.equal(boundMsFor(7118), 15);
    assert.equal(boundMsFor(15_509), 31.018);
  });

  it('pads the real 7,118-byte grant to four crumbs, under the target, in one step', () => {
    const k = crumbsForShape(15.935, 7118);
    assert.equal(k, 4);
    const takes = 15.935 + k * CRUMB_MS;
    const bound = boundMsFor(7118 + k * CRUMB_BYTES);
    assert.ok(takes <= TIME_TO_DISMISS_TARGET * bound, `${takes} ms against ${bound} ms`);
    assert.ok(15.935 + 3 * CRUMB_MS > TIME_TO_DISMISS_TARGET * boundMsFor(7118 + 3 * CRUMB_BYTES), 'three would not do');
  });

  it('needs one crumb fewer for a grant that spends an exact coin and makes no change', () => {
    assert.equal(crumbsForShape(15.935 - 2.49, 7118 - 80), 3);
    assert.equal(crumbsForShape(5, 7000), 0, 'a transaction already under the target needs none');
    assert.equal(crumbsForShape(200, 7000), 8, 'and nothing sensible is capped at eight');
  });
});

describe('a grant that spends an exact 0.002-NIGHT coin', () => {
  /* WHAT THE SPLIT BOUGHT. The proven grant of 07:18:09 on 2026/09/03 was
     15.935 ms in 7,118 bytes — a `deposit_night` whose NIGHT payload came
     from a covering coin and therefore carried a CHANGE OUTPUT. An
     unshielded output measured 2.49 ms in about 80 bytes on the chain's own
     parameters, so the same grant paid from an EXACT 2,000-atomic coin makes
     no change and is 13.445 ms in 7,038 bytes: under the ledger's 15 ms
     floor, which is the check `balanceTx` runs before it proves anything.
     Nothing has to be padded, so the fee leg is one covering DUST coin and
     the transaction carries a single DUST input. */
  const OUTPUT_MS = 2.49;
  const OUTPUT_BYTES = 80;
  const EXACT_MS = 15.935 - OUTPUT_MS;
  const EXACT_BYTES = 7118 - OUTPUT_BYTES;

  const exact = night('9'.repeat(64), 0, 2_000n);
  const covering = night('8'.repeat(64), 0, 12_020n);
  const lineage = night('7'.repeat(64), 0, LARGE_NIGHT_ATOMIC);
  const crumbs = Array.from({ length: 5 }, (_, i) =>
    dust(String(i).padStart(64, '0'), 3_968_160_000n + BigInt(i)),
  );
  const large = dust('f'.repeat(64), 1_063_482_701_844_916_860n);
  const FEE = 15_000_000_000_000_000n;

  it('is under the ledger\'s bound, so the first attempt needs no padding at all', () => {
    assert.equal(boundMsFor(EXACT_BYTES), MIN_TIME_TO_DISMISS_MS, 'still on the floor at 7,038 bytes');
    assert.ok(
      EXACT_MS <= boundMsFor(EXACT_BYTES),
      `${EXACT_MS} ms against a ${boundMsFor(EXACT_BYTES)} ms bound — this is the check that reverts and re-balances`,
    );
    assert.ok(
      15.935 > boundMsFor(7118),
      'the same grant WITH a change output is over the bound, which is why it was padded',
    );
  });

  it('builds the grant leg with the exact coin and ONE DUST input, zero crumbs', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const selectNight = coins.guard(nightPayloadFirst);
    const selectDust = coins.guard(createDustFeeSelector(coins));
    const job = coins.open('deposit_night');

    coins.setDustPadding(0);
    coins.beginBalance(job);
    const payload = selectNight([lineage, covering, exact], NIGHT, -2_000n, {});
    const fee = balanceLike(selectDust, [large, ...crumbs], FEE);
    const selected = coins.endBalance();

    assert.equal(payload, exact, 'the exact coin, so there is no change output');
    assert.deepEqual(fee, [large], 'one covering DUST coin, no crumbs ahead of it');
    assert.equal(selected.filter(isCrumb).length, 0, 'zero applied padding');
    assert.equal(
      selected.filter((coin) => coin.token !== undefined).length,
      1,
      'a single DUST input',
    );
  });

  it('reports the padding it APPLIED, which is what the crumbs allowed', () => {
    const coins = createCoinReservation({ log: () => undefined });
    const selectDust = coins.guard(createDustFeeSelector(coins));
    const mine = coins.open('deposit_night');
    const other = coins.open('registration');
    /* Four of the five crumbs are held by the job beside this one, exactly as
       they were at 12:13:02 on 2026/09/03 when a balance asked for four and
       carried one. */
    other.hold(crumbs.slice(1).map(coinKey));

    assert.equal(coins.freeCrumbs(mine, [large, ...crumbs]), 1, 'one crumb is free');
    assert.equal(
      coins.freeCrumbs(other, [large, ...crumbs]),
      5,
      'its holder may have its own again, and the free one besides',
    );

    coins.setDustPadding(Math.min(4, coins.freeCrumbs(mine, [large, ...crumbs])));
    coins.beginBalance(mine);
    const fee = balanceLike(selectDust, [large, ...crumbs], FEE);
    const selected = coins.endBalance();

    assert.deepEqual(fee, [crumbs[0], large], 'the one free crumb, then the covering coin');
    assert.equal(selected.filter(isCrumb).length, 1, 'ONE applied, not the four a naive round would report');
  });
});

describe('an exact NIGHT coin', () => {
  it('is chosen over a covering one, because it makes no change output', () => {
    const exact = night('9'.repeat(64), 0, 2_000n);
    const bigger = night('8'.repeat(64), 0, 12_020n);
    assert.equal(nightPayloadFirst([bigger, exact], NIGHT, -2_000n, {}), exact);
    assert.equal(nightPayloadFirst([bigger], NIGHT, -2_000n, {}), bigger);
  });
});
