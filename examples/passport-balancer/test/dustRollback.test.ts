/**
 * The dust wedge, and the repair, proved against the wedge itself.
 *
 * `test/fixtures/wedged-dust-snapshot.json` is not a construction. It is the
 * sync snapshot this service wrote at 16:24:03Z on 2026/09/02, taken off the
 * droplet before the operator moved it aside — the state in which
 * `/wallet-status` had been answering `dust 0 / utxoCount 0 /
 * INSUFFICIENT_DUST` for thirty-five minutes while the wallet held all 4,998
 * NIGHT it started with and its DUST sync reported complete. Only the shielded
 * and unshielded halves are omitted; nothing in this repair reads them.
 *
 * What the first case asserts is the whole finding: the coins were NEVER GONE.
 * The stored ledger state carries both of them — nonce 108f32bb… seq 368,
 * initial value 24,946,432,797,282,076,896, and nonce bc40058e… seq 2 — each
 * with `pending_until: 2026-09-02T18:48:42Z`, which is exactly the 15:48:42Z
 * balancing of 693ab0ca… plus the three-hour grace period. `utxos()` and
 * `wallet_balance()` skip pending entries, so the wallet read zero; one
 * `processTtls` past that flag and it reads its own money again.
 *
 * The second case is the guard that keeps this from being run as a ritual. A
 * healthy snapshot — which is what the output of a repair is — must be refused,
 * because a repair that reports success on a wallet that was never wedged is
 * how a false diagnosis becomes a restart loop.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { NothingToRepair, rollbackDustSnapshot } from '../src/dustRollback.js';

/* Resolved from this file rather than from the working directory: the tests are
   bundled to `dist/test/` and run from the package root, and a relative
   `test/fixtures/…` would find the fixture from one of those and not the other. */
const fixture = readFileSync(
  join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'wedged-dust-snapshot.json'),
  'utf8',
);

/* The 15:49:12Z balancing that wedged it, plus a minute — so the grace period
   the sweep has to reach past is genuinely in the future of `now`, exactly as
   it was when the wallet was answering INSUFFICIENT_DUST. */
const T0 = Date.parse('2026-09-02T16:24:03.778Z');

/** What the big coin was carrying, from the indexer-decoded state. */
const BIG_COIN_INITIAL_VALUE = 24_946_432_797_282_076_896n;

describe('rollbackDustSnapshot', () => {
  it('gives back the two coins the wedged snapshot was hiding', () => {
    const result = rollbackDustSnapshot(fixture, T0);

    assert.equal(result.utxosBefore, 0, 'the stored state reports no spendable DUST — the wedge');
    assert.equal(result.utxosAfter, 2, 'both coins come back');
    assert.ok(
      result.balanceAfter >= BIG_COIN_INITIAL_VALUE,
      `the repaired balance (${result.balanceAfter}) is at least the big coin's initial value`,
    );
    assert.equal(result.savedAt, '2026-09-02T16:24:03.778Z');
  });

  it('refuses to repair what it has already repaired', () => {
    const repaired = rollbackDustSnapshot(fixture, T0).snapshot;

    assert.throws(
      () => rollbackDustSnapshot(repaired, T0),
      (cause: unknown) =>
        cause instanceof NothingToRepair && /nothing to repair/.test((cause as Error).message),
    );
  });

  it('carries every other field of the snapshot through untouched', () => {
    const original = JSON.parse(fixture) as Record<string, unknown>;
    const repaired = JSON.parse(rollbackDustSnapshot(fixture, T0).snapshot) as Record<
      string,
      unknown
    >;

    for (const key of ['version', 'networkId', 'unshieldedAddress', 'savedAt', 'shielded', 'unshielded']) {
      assert.deepEqual(repaired[key], original[key], `${key} is carried through`);
    }
    /* And the DUST envelope keeps everything but the ledger state — the sync
       offset above all, because losing it would turn a repair into a cold walk. */
    const before = JSON.parse(original.dust as string) as Record<string, unknown>;
    const after = JSON.parse(repaired.dust as string) as Record<string, unknown>;
    assert.deepEqual(after.offset, before.offset);
    assert.deepEqual(after.publicKey, before.publicKey);
    assert.deepEqual(after.networkId, before.networkId);
    assert.notEqual(after.state, before.state, 'the ledger state itself is rewritten');
  });

  it('reports a snapshot it cannot read as an error rather than as a repair', () => {
    assert.throws(() => rollbackDustSnapshot('not json', T0), /not JSON/);
    assert.throws(() => rollbackDustSnapshot('{}', T0), /no serialised `dust` wallet state/);
    assert.throws(() => rollbackDustSnapshot(JSON.stringify({ dust: '{}' }), T0), /ledger `state`/);
    assert.throws(
      () => rollbackDustSnapshot(JSON.stringify({ dust: JSON.stringify({ state: 'zz' }) }), T0),
      /hex/,
    );
  });
});
