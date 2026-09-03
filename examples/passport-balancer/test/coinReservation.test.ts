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
  coinKey,
  createCoinReservation,
  describeCoin,
  smallestDust,
  smallestOfType,
  type SelectableCoin,
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
