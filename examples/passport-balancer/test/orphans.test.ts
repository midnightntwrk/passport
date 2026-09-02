/**
 * The DUST this service books against transactions it does not submit.
 *
 * `/balance-only` is the one endpoint whose whole job is to spend on somebody
 * else's behalf and then let go: it books a DUST coin as spent, hands the merged
 * transaction back, and never sees whether it lands. Until 2026/09/02 that
 * booking stood for the full thirty-minute balancing TTL whatever happened
 * next — so when the node refused a caller's transaction at 14:12:57Z the
 * balancer's only DUST coins went with it, `/wallet-status` read
 * `dust 0 / utxoCount 0` from 14:13:00Z, and every registration and activation
 * was refused for the rest of that window.
 *
 * The sweeper below is what makes the booking provisional. What these tests
 * guard is the asymmetry it turns on: reverting a transaction that DID land
 * would double-spend, so a definite absence is the ONLY thing that releases
 * anything. An indexer that cannot answer, a window that has not elapsed, a
 * hash already ruled on — none of them may revert a coin.
 *
 * No chain, no clock, no wallet: the indexer and the facade are both fakes and
 * `now` is arithmetic on a fixed `T0`, so a landing, a rejection, and a sweep sit
 * exactly where each case wants them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  balancerIsSettling,
  createOrphanWatch,
  shortfallRefusal,
  transactionLanded,
  type OrphanEntry,
} from '../src/wallet.js';

/** An arbitrary fixed instant. */
const T0 = 1_800_000_000_000;
const ORPHAN_MS = 120_000;
const SETTLE_MS = 300_000;

const entry = (overrides: Partial<OrphanEntry> = {}): OrphanEntry => ({
  txHash: 'aa'.repeat(32),
  identifier: 'bb'.repeat(33),
  finalized: { marker: 'the merged transaction' },
  balancedAt: T0,
  ...overrides,
});

/**
 * A watch wired to fakes, with the clock and the indexer's answers under the
 * test's control and every revert recorded rather than performed.
 */
function harness(options: {
  landed?: (identifier: string) => Promise<boolean | null>;
  revert?: (entry: OrphanEntry) => Promise<void>;
} = {}) {
  let now = T0;
  const reverted: OrphanEntry[] = [];
  const asked: string[] = [];
  const lines: string[] = [];
  const watch = createOrphanWatch({
    orphanMs: ORPHAN_MS,
    now: () => now,
    landed: async (identifier) => {
      asked.push(identifier);
      return options.landed ? options.landed(identifier) : false;
    },
    revert: async (candidate) => {
      reverted.push(candidate);
      if (options.revert) await options.revert(candidate);
    },
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
  });
  return {
    watch,
    reverted,
    asked,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the orphan watch', () => {
  it('drops a transaction the chain has, without reverting its DUST', async () => {
    const h = harness({ landed: async () => true });
    h.watch.watch(entry());
    h.advance(ORPHAN_MS + 1);
    await h.watch.sweep();

    assert.equal(h.reverted.length, 0, 'a landed transaction must never be reverted');
    assert.equal(h.watch.size, 0, 'and must not be asked about again');
    assert.equal(h.watch.released, 0);
  });

  it('releases the DUST of a transaction the chain does not have', async () => {
    const h = harness({ landed: async () => false });
    h.watch.watch(entry());
    h.advance(ORPHAN_MS + 1);
    await h.watch.sweep();

    assert.equal(h.reverted.length, 1);
    assert.equal(h.reverted[0]?.txHash, entry().txHash);
    assert.equal(h.watch.size, 0);
    assert.equal(h.watch.released, 1);
    assert.match(h.lines.join('\n'), /released the DUST booked for/);
  });

  it('releases it exactly once, however many sweeps run', async () => {
    const h = harness({ landed: async () => false });
    h.watch.watch(entry());
    h.advance(ORPHAN_MS + 1);
    await h.watch.sweep();
    await h.watch.sweep();
    await h.watch.sweep();

    assert.equal(h.reverted.length, 1, 'a second revert would un-book a coin twice');
    assert.equal(h.watch.released, 1);
  });

  it('leaves a transaction inside the window alone, and does not even ask', async () => {
    const h = harness({ landed: async () => false });
    h.watch.watch(entry());
    h.advance(ORPHAN_MS - 1);
    await h.watch.sweep();

    assert.deepEqual(h.asked, [], 'the indexer is not worth troubling before the window');
    assert.equal(h.reverted.length, 0);
    assert.equal(h.watch.size, 1, 'and it is still outstanding');
  });

  it('leaves it alone when the indexer cannot answer, and asks again next sweep', async () => {
    let answer: boolean | null = null;
    const h = harness({ landed: async () => answer });
    h.watch.watch(entry());
    h.advance(ORPHAN_MS + 1);
    await h.watch.sweep();

    assert.equal(h.reverted.length, 0, 'silence is not evidence of absence');
    assert.equal(h.watch.size, 1);

    answer = false;
    await h.watch.sweep();
    assert.equal(h.reverted.length, 1);
    assert.equal(h.asked.length, 2);
  });

  it('sweeps each outstanding transaction on its own age', async () => {
    const h = harness({ landed: async (id) => id === 'old' });
    h.watch.watch(entry({ txHash: 'one', identifier: 'old', balancedAt: T0 }));
    h.watch.watch(entry({ txHash: 'two', identifier: 'gone', balancedAt: T0 }));
    h.watch.watch(entry({ txHash: 'three', identifier: 'young', balancedAt: T0 + ORPHAN_MS }));
    h.advance(ORPHAN_MS + 1);
    await h.watch.sweep();

    assert.deepEqual(
      h.reverted.map((candidate) => candidate.txHash),
      ['two'],
    );
    assert.equal(h.watch.size, 1, 'the young one is still being watched');
  });

  it('keeps counting the transaction as outstanding when the revert itself fails', async () => {
    const h = harness({
      landed: async () => false,
      revert: async () => {
        throw new Error('the facade refused');
      },
    });
    h.watch.watch(entry());
    h.advance(ORPHAN_MS + 1);
    await h.watch.sweep();

    assert.equal(h.watch.released, 0, 'nothing was released, so nothing is counted');
    assert.match(h.lines.join('\n'), /could not release the DUST booked for/);
  });

  describe('POST /balance-only/abandon', () => {
    it('reverts immediately, without waiting for the window', async () => {
      const h = harness({ landed: async () => false });
      h.watch.watch(entry());

      assert.equal(await h.watch.abandon(entry().txHash), true);
      assert.equal(h.reverted.length, 1);
      assert.equal(h.watch.size, 0);
      assert.equal(h.watch.released, 1);
      assert.deepEqual(h.asked, [], 'the caller said its submit failed; that is the answer');
    });

    it('answers false for a hash it is not watching, and reverts nothing', async () => {
      const h = harness();
      h.watch.watch(entry());

      assert.equal(await h.watch.abandon('a hash nobody balanced'), false);
      assert.equal(h.reverted.length, 0);
      assert.equal(h.watch.size, 1);
    });

    it('cannot revert twice when the sweeper has already released it', async () => {
      const h = harness({ landed: async () => false });
      h.watch.watch(entry());
      h.advance(ORPHAN_MS + 1);
      await h.watch.sweep();

      assert.equal(await h.watch.abandon(entry().txHash), false);
      assert.equal(h.reverted.length, 1);
    });
  });
});

describe('is a DUST shortfall settling or empty?', () => {
  it('is not settling on a wallet that has never spent and holds nothing outstanding', () => {
    assert.equal(
      balancerIsSettling({ now: T0, lastSpendAt: 0, settleWindowMs: SETTLE_MS, orphans: 0 }),
      false,
    );
  });

  it('is settling inside the change window of this service’s own spend', () => {
    assert.equal(
      balancerIsSettling({
        now: T0,
        lastSpendAt: T0 - (SETTLE_MS - 1),
        settleWindowMs: SETTLE_MS,
        orphans: 0,
      }),
      true,
    );
  });

  it('is no longer settling once that window has passed', () => {
    assert.equal(
      balancerIsSettling({
        now: T0,
        lastSpendAt: T0 - SETTLE_MS,
        settleWindowMs: SETTLE_MS,
        orphans: 0,
      }),
      false,
    );
  });

  it('is settling while a balanced transaction is outstanding, whatever the clock says', () => {
    assert.equal(
      balancerIsSettling({
        now: T0,
        lastSpendAt: T0 - 10 * SETTLE_MS,
        settleWindowMs: SETTLE_MS,
        orphans: 1,
      }),
      true,
    );
  });
});

describe('the refusal a shortfall earns', () => {
  it('is a retryable 429 while it is settling, carrying the real cause', () => {
    const refusal = shortfallRefusal(
      'INSUFFICIENT_DUST',
      'The balancer holds no spendable DUST, so it cannot pay this transaction’s fee.',
      true,
    );

    assert.equal(refusal.status, 429);
    assert.equal(refusal.code, 'PENDING_TRANSACTION', 'the code sponsor.ts waits out');
    assert.equal(refusal.retryAfterMs, 3_000);
    assert.equal(refusal.cause, 'INSUFFICIENT_DUST');
    assert.match(refusal.message, /no spendable DUST/);
  });

  it('is an honest 503 when nothing explains it', () => {
    const refusal = shortfallRefusal(
      'WALLET_SYNCING',
      'The balancer wallet is still syncing and cannot balance a transaction yet.',
      false,
    );

    assert.equal(refusal.status, 503);
    assert.equal(refusal.code, 'WALLET_SYNCING');
    assert.equal(refusal.retryAfterMs, undefined);
  });
});

describe('asking the indexer whether a transaction landed', () => {
  const url = 'https://indexer.example/api/v4/graphql';
  const withFetch = async <T>(
    stub: (input: unknown, init?: unknown) => Promise<unknown>,
    body: () => Promise<T>,
  ): Promise<T> => {
    const original = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = stub;
    try {
      return await body();
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
  };

  const json = (payload: unknown, ok = true): Response =>
    ({ ok, json: async () => payload }) as unknown as Response;

  it('is true when the indexer returns a transaction', async () => {
    const seen = await withFetch(
      async () => json({ data: { transactions: [{ hash: 'ff'.repeat(32) }] } }),
      () => transactionLanded(url, 'an identifier'),
    );
    assert.equal(seen, true);
  });

  it('is false only for an empty list from a response that parsed', async () => {
    const seen = await withFetch(
      async () => json({ data: { transactions: [] } }),
      () => transactionLanded(url, 'an identifier'),
    );
    assert.equal(seen, false);
  });

  it('is null — never false — when the question could not be put', async () => {
    const network = await withFetch(
      async () => {
        throw new Error('ECONNRESET');
      },
      () => transactionLanded(url, 'an identifier'),
    );
    assert.equal(network, null);

    const http = await withFetch(
      async () => json({}, false),
      () => transactionLanded(url, 'an identifier'),
    );
    assert.equal(http, null);

    const graphql = await withFetch(
      async () => json({ errors: [{ message: 'bad offset' }] }),
      () => transactionLanded(url, 'an identifier'),
    );
    assert.equal(graphql, null);

    const shapeless = await withFetch(
      async () => json({ data: {} }),
      () => transactionLanded(url, 'an identifier'),
    );
    assert.equal(shapeless, null);
  });

  it('asks by identifier, which is what the caller was handed', async () => {
    let sent = '';
    await withFetch(
      async (_input, init) => {
        sent = String((init as { body?: unknown }).body);
        return json({ data: { transactions: [] } });
      },
      () => transactionLanded(url, 'the-identifier'),
    );
    assert.match(sent, /transactions\(offset: \{ identifier: \\"the-identifier\\" \}\)/);
  });
});
