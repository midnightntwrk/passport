/**
 * Unit tests for the endpoint-selection rule.
 *
 * This is the pure half of running the demo's two heaviest paths — proving and
 * fee sponsorship — against more than one provider, and it is the half that can
 * be drilled without a network: a list in, a decision out. The live half is
 * drilled against the real 1AM stagenet gateway and our own balancer, which is
 * the only place it means anything.
 *
 * Five properties, and every one of them is a way the demo could quietly get
 * worse if it were wrong:
 *
 *   ORDERING            the operator's order is honoured, and a healthy first
 *                       choice costs exactly one request.
 *   SKIP UNREADY        an endpoint that answers "not me" is passed over
 *                       rather than treated as a failure.
 *   FALL THROUGH        an endpoint that throws is passed over too, and what
 *                       it threw is kept so a caller can still classify it.
 *   ALL REFUSED         nothing is invented; every refusal comes back, named.
 *   ONE ENDPOINT        a list of one behaves exactly as one URL did.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/lib`.
 */

import { describe, expect, it } from 'vitest';

import {
  describeEndpointRefusals,
  firstEndpointThatServes,
  parseEndpointList,
  type EndpointAnswer,
} from './endpoints.js';

const served = <T>(value: T): EndpointAnswer<T> => ({ served: true, value });
const refused = (reason: string): EndpointAnswer<never> => ({ served: false, reason });

describe('parseEndpointList', () => {
  it('reads one URL as a list of one, unchanged', () => {
    /* THE compatibility property. `VITE_SPONSOR_URL` and
       `VITE_MIDNIGHT_PROVING_URL` held a single URL before 2026/08/31 and
       every deployment still writes one, so this is the case that must not
       move. */
    expect(parseEndpointList('https://api-stagenet.1am.xyz')).toEqual([
      'https://api-stagenet.1am.xyz',
    ]);
  });

  it('reads several in the order they were written', () => {
    expect(
      parseEndpointList('https://api-stagenet.1am.xyz, https://67-205-177-162.sslip.io/balancer'),
    ).toEqual(['https://api-stagenet.1am.xyz', 'https://67-205-177-162.sslip.io/balancer']);
  });

  it('drops blanks, trailing slashes, and a repeated host', () => {
    /* A repeat is dropped rather than honoured: asking the same host twice
       before falling through doubles the wait and buys no second opinion. A
       trailing slash makes the same host look like a different one, which is
       how a list of two ends up being a list of one host asked twice. */
    expect(parseEndpointList('https://a/,, https://a , https://b//')).toEqual([
      'https://a',
      'https://b',
    ]);
  });

  it('reads an absent or empty variable as no endpoints at all', () => {
    expect(parseEndpointList(undefined)).toEqual([]);
    expect(parseEndpointList(null)).toEqual([]);
    expect(parseEndpointList('')).toEqual([]);
    expect(parseEndpointList('   ,  ')).toEqual([]);
  });
});

describe('firstEndpointThatServes', () => {
  it('uses the first endpoint and never contacts the rest', async () => {
    const asked: string[] = [];
    const outcome = await firstEndpointThatServes(['https://a', 'https://b'], async (url) => {
      asked.push(url);
      return served(`${url} answered`);
    });
    expect(outcome).toEqual({
      served: true,
      url: 'https://a',
      index: 0,
      value: 'https://a answered',
      refusals: [],
    });
    expect(asked).toEqual(['https://a']);
  });

  it('skips an endpoint that says it is not ready, and names the one that served', async () => {
    const asked: string[] = [];
    const outcome = await firstEndpointThatServes(
      ['https://busy', 'https://free'],
      async (url, index) => {
        asked.push(`${index}:${url}`);
        return url === 'https://busy' ? refused('no dust free') : served('balanced');
      },
    );
    expect(outcome).toEqual({
      served: true,
      url: 'https://free',
      index: 1,
      value: 'balanced',
      refusals: [{ url: 'https://busy', reason: 'no dust free' }],
    });
    expect(asked).toEqual(['0:https://busy', '1:https://free']);
  });

  it('falls through an endpoint that throws, and keeps what it threw', async () => {
    /* The thrown value is carried because the caller still has to classify it
       afterwards: `sponsorBalanceOnly` waits out a 429 PENDING_TRANSACTION and
       refuses a 503, and it can only tell them apart if the error survived the
       fall-through. */
    const boom = new Error('connect ETIMEDOUT');
    const outcome = await firstEndpointThatServes(
      ['https://down', 'https://up'],
      async (url) => {
        if (url === 'https://down') throw boom;
        return served('proved');
      },
    );
    /* The refusal it fell through is carried even though the walk SUCCEEDED.
       A fall-through that logs nothing is how the day the first provider broke
       goes unnoticed until the second one breaks too. */
    expect(outcome).toEqual({
      served: true,
      url: 'https://up',
      index: 1,
      value: 'proved',
      refusals: [{ url: 'https://down', reason: 'connect ETIMEDOUT', cause: boom }],
    });
  });

  it('returns every refusal when nothing serves, inventing no result', async () => {
    const boom = new Error('connect ETIMEDOUT');
    const outcome = await firstEndpointThatServes(
      ['https://a', 'https://b'],
      async (url) => {
        if (url === 'https://a') return refused('no dust free');
        throw boom;
      },
    );
    expect(outcome).toEqual({
      served: false,
      refusals: [
        { url: 'https://a', reason: 'no dust free' },
        { url: 'https://b', reason: 'connect ETIMEDOUT', cause: boom },
      ],
    });
  });

  it('names a non-Error throw rather than printing [object Object]', async () => {
    const outcome = await firstEndpointThatServes(['https://a'], async () => {
      throw 'gateway said no';
    });
    expect(outcome).toEqual({
      served: false,
      refusals: [{ url: 'https://a', reason: 'gateway said no', cause: 'gateway said no' }],
    });
  });

  it('is a single endpoint asked once, either way', async () => {
    let calls = 0;
    const ok = await firstEndpointThatServes(['https://only'], async () => {
      calls += 1;
      return served(7);
    });
    expect(ok).toEqual({ served: true, url: 'https://only', index: 0, value: 7, refusals: [] });

    const notOk = await firstEndpointThatServes(['https://only'], async () => {
      calls += 1;
      return refused('busy');
    });
    expect(notOk).toEqual({ served: false, refusals: [{ url: 'https://only', reason: 'busy' }] });
    expect(calls).toBe(2);
  });

  it('answers an empty list without asking anything or throwing', async () => {
    /* "Nothing is configured" is a real state — `VITE_SPONSOR_URL=off` — and
       it is the caller that knows what to say about it. */
    const outcome = await firstEndpointThatServes([], async () => served('never'));
    expect(outcome).toEqual({ served: false, refusals: [] });
  });
});

describe('describeEndpointRefusals', () => {
  it('names each endpoint beside its reason', () => {
    /* Each endpoint is named because "the sponsor was busy" and "both sponsors
       were busy" are different operational facts and an operator reading one
       line should not have to guess which happened. */
    expect(
      describeEndpointRefusals([
        { url: 'https://a', reason: 'sponsor reports 0/1 wallets available' },
        { url: 'https://b', reason: 'wallet-status returned HTTP 502' },
      ]),
    ).toBe(
      'https://a: sponsor reports 0/1 wallets available; https://b: wallet-status returned HTTP 502',
    );
  });

  it('says so in words when there was nothing to ask', () => {
    expect(describeEndpointRefusals([])).toBe('no endpoint was configured');
  });
});
