/**
 * The endpoint list, tested without a node and without an indexer.
 *
 * The single thing worth proving here is the thing an operator is betting on
 * when they add a second provider: THAT ONE URL STILL BEHAVES AS ONE URL DID.
 * Every deployment of this service runs with one node and one indexer, so a
 * list-of-one that took a different code path — a probe it did not used to
 * send, an extra attempt, a reordering — would be a change to production dressed
 * up as a change to configuration. Half the cases below are that assertion.
 *
 * The other half is the order. Nothing here load-balances, nothing remembers a
 * winner between calls, and nothing reorders: an operator who writes
 * `ours,theirs` gets ours first every time and can prove failover by writing it
 * the other way round.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  askIndexers,
  describeUrlRefusals,
  firstUrlThatServes,
  forgetIndexerUrlInUse,
  indexerUrlInUse,
  parseUrlList,
  urlsOf,
} from '../src/endpoints.js';
import { networkEndpoints } from '../src/config.js';

const NODE = 'wss://rpc.stagenet.shielded.tools';
const INDEXER = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';

describe('reading an endpoint list out of one variable', () => {
  it('reads a single URL as a list of one, unchanged', () => {
    assert.deepEqual(parseUrlList(NODE), [NODE]);
  });

  it('reads a comma list in the order it was written', () => {
    assert.deepEqual(parseUrlList(`${NODE},wss://second.example`), [NODE, 'wss://second.example']);
  });

  it('drops blanks, trims, and never invents an endpoint out of punctuation', () => {
    assert.deepEqual(parseUrlList(' a , , b '), ['a', 'b']);
    assert.deepEqual(parseUrlList(''), []);
    assert.deepEqual(parseUrlList('   '), []);
    assert.deepEqual(parseUrlList(','), []);
    assert.deepEqual(parseUrlList(undefined), []);
    assert.deepEqual(parseUrlList(null), []);
  });

  it('treats a trailing slash as the same endpoint, and keeps a repeat only once', () => {
    /* A list that names the same host twice would ask it twice before falling
       through, doubling the wait for no second opinion. */
    assert.deepEqual(parseUrlList('https://host/base/,https://host/base'), ['https://host/base']);
  });

  it('reads either form of the list, as one', () => {
    assert.deepEqual(urlsOf(INDEXER), [INDEXER]);
    assert.deepEqual(urlsOf([INDEXER, 'https://second.example']), [
      INDEXER,
      'https://second.example',
    ]);
  });
});

describe('resolving the configured endpoints', () => {
  /* The network defaults are the fallback and are what every deployment runs
     on; `stagenet` is the one this service is deployed against. */
  const stagenet = (env: NodeJS.ProcessEnv) => networkEndpoints('stagenet', env);

  it('gives a one-entry list for an unset environment — the default, as always', () => {
    const endpoints = stagenet({});
    assert.equal(endpoints.nodeUrls.length, 1);
    assert.equal(endpoints.indexerHttpUrls.length, 1);
    assert.equal(endpoints.nodeUrls[0], endpoints.nodeUrl);
    assert.equal(endpoints.indexerHttpUrls[0], endpoints.indexerHttpUrl);
    assert.equal(endpoints.relayUrls[0], endpoints.relayUrl);
    assert.equal(endpoints.indexerWsUrls[0], endpoints.indexerWsUrl);
  });

  it('still honours the singular variables, as a list of one', () => {
    /* No deployed environment file has to change for this, which is the whole
       reason the singular names were kept. */
    const endpoints = stagenet({
      BALANCER_NODE_URL: 'wss://mine.example',
      BALANCER_INDEXER_URL: 'https://mine.example/graphql',
    });
    assert.deepEqual(endpoints.nodeUrls, ['wss://mine.example']);
    assert.equal(endpoints.nodeUrl, 'wss://mine.example');
    assert.deepEqual(endpoints.indexerHttpUrls, ['https://mine.example/graphql']);
  });

  it('prefers the plural when both are set, and keeps the operator’s order', () => {
    const endpoints = stagenet({
      BALANCER_NODE_URL: 'wss://ignored.example',
      BALANCER_NODE_URLS: 'wss://ours.example,wss://theirs.example',
    });
    assert.deepEqual(endpoints.nodeUrls, ['wss://ours.example', 'wss://theirs.example']);
    assert.equal(endpoints.nodeUrl, 'wss://ours.example', 'the first is the preferred one');
  });

  it('falls through a variable that is set but names nothing', () => {
    /* An operator who blanks a variable gets the default back, not a service
       that cannot reach a node. */
    const endpoints = stagenet({ BALANCER_NODE_URLS: ' , ' });
    assert.equal(endpoints.nodeUrls.length, 1);
    assert.equal(endpoints.nodeUrls[0], stagenet({}).nodeUrl);
  });

  it('derives one WebSocket per indexer, in the same order', () => {
    const endpoints = stagenet({
      BALANCER_INDEXER_URLS: 'https://one.example/graphql,https://two.example/graphql',
    });
    assert.deepEqual(endpoints.indexerWsUrls, [
      'wss://one.example/graphql/ws',
      'wss://two.example/graphql/ws',
    ]);
    assert.equal(endpoints.relayUrls.length, 1, 'the node list is untouched by the indexer one');
  });

  it('pads an explicit WebSocket list rather than pairing an indexer with somebody else’s socket', () => {
    const endpoints = stagenet({
      BALANCER_INDEXER_URLS: 'https://one.example/graphql,https://two.example/graphql',
      BALANCER_INDEXER_WS_URLS: 'wss://one.example/subscriptions',
    });
    assert.deepEqual(endpoints.indexerWsUrls, [
      'wss://one.example/subscriptions',
      'wss://two.example/graphql/ws',
    ]);
  });

  it('refuses a network it knows nothing about and names both variables', () => {
    assert.throws(
      () => networkEndpoints('nowhere', {}),
      /BALANCER_INDEXER_URLS and BALANCER_NODE_URLS/,
    );
  });
});

describe('asking a list until one serves', () => {
  it('asks exactly once when there is exactly one', async () => {
    const asked: string[] = [];
    const outcome = await firstUrlThatServes([NODE], async (url) => {
      asked.push(url);
      return { served: true, value: 1 };
    });
    assert.deepEqual(asked, [NODE]);
    assert.equal(outcome.served, true);
    assert.deepEqual(outcome.served ? outcome.refusals : null, []);
  });

  it('stops at the first that serves — the rest are never contacted', async () => {
    const asked: string[] = [];
    const outcome = await firstUrlThatServes(['a', 'b', 'c'], async (url) => {
      asked.push(url);
      return { served: true, value: url };
    });
    assert.deepEqual(asked, ['a']);
    assert.equal(outcome.served && outcome.index, 0);
  });

  it('falls through a refusal AND a throw, and carries both', async () => {
    const outcome = await firstUrlThatServes(['a', 'b', 'c'], async (url) => {
      if (url === 'a') return { served: false, reason: 'answered 502' };
      if (url === 'b') throw new Error('fetch failed');
      return { served: true, value: url };
    });
    assert.equal(outcome.served, true);
    assert.equal(outcome.served && outcome.url, 'c');
    assert.equal(outcome.refusals.length, 2, 'a fall-through that succeeds must not be silent');
    assert.equal(
      describeUrlRefusals(outcome.refusals),
      'a: answered 502; b: fetch failed',
      'each endpoint named beside its reason',
    );
  });

  it('answers rather than throws when every one of them refuses', async () => {
    const outcome = await firstUrlThatServes(['a', 'b'], async () => {
      throw new Error('fetch failed');
    });
    assert.equal(outcome.served, false);
    assert.equal(outcome.refusals.length, 2);
  });

  it('answers an empty list rather than throwing at it', async () => {
    const outcome = await firstUrlThatServes([], async () => ({ served: true, value: 1 }));
    assert.equal(outcome.served, false);
    assert.equal(describeUrlRefusals(outcome.refusals), 'no endpoint was configured');
  });
});

describe('asking the indexers', () => {
  it('returns exactly what one indexer returned, whatever it was', async () => {
    /* The single-URL case is yesterday's behaviour byte for byte: an unusable
       answer from the only indexer is still the answer. */
    forgetIndexerUrlInUse();
    assert.equal(
      await askIndexers(
        INDEXER,
        async () => null,
        (value) => value !== null,
      ),
      null,
    );
    assert.equal(indexerUrlInUse(), null, 'nothing served, so nothing is in use');
  });

  it('falls through an unusable answer and names who served', async () => {
    forgetIndexerUrlInUse();
    const value = await askIndexers(
      ['https://one.example', 'https://two.example'],
      async (url) => (url === 'https://two.example' ? 342_015 : null),
      (height) => height !== null,
    );
    assert.equal(value, 342_015);
    assert.equal(indexerUrlInUse(), 'https://two.example');
  });

  it('starts again at the front on the next call — no sticky winner', async () => {
    forgetIndexerUrlInUse();
    const order: string[] = [];
    const ask = async (url: string): Promise<number | null> => {
      order.push(url);
      return url === 'https://two.example' ? 1 : null;
    };
    const usable = (v: number | null): boolean => v !== null;
    await askIndexers(['https://one.example', 'https://two.example'], ask, usable);
    await askIndexers(['https://one.example', 'https://two.example'], ask, usable);
    assert.deepEqual(order, [
      'https://one.example',
      'https://two.example',
      'https://one.example',
      'https://two.example',
    ]);
  });

  it('keeps the last answer when nothing was usable, rather than inventing one', async () => {
    const value = await askIndexers(
      ['https://one.example', 'https://two.example'],
      async (url) => url,
      () => false,
    );
    assert.equal(value, 'https://two.example');
  });

  it('throws only when not one of them could be asked at all', async () => {
    await assert.rejects(
      askIndexers(
        ['https://one.example', 'https://two.example'],
        async () => {
          throw new Error('fetch failed');
        },
        () => true,
      ),
      /fetch failed/,
    );
    await assert.rejects(
      askIndexers([], async () => 1, () => true),
      /no indexer URL is configured/,
    );
  });
});
