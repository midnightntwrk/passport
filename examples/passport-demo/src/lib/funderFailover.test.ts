/**
 * Drills for the rule that decides whether a SECOND funder may be asked.
 *
 * This is the narrow half of the endpoint work. `endpoints.test.ts` drills a
 * walk that falls through on any refusal, which is right for a proof server
 * and a fee sponsor: their work is repeatable and costs nobody anything twice.
 * The funder's is not. `/register-alias` and `/fund-account` SPEND, from a
 * wallet that is the standby's own, and the activation grant is once per
 * account for ever against each funder's separate ledger.
 *
 * So the property drilled here is a subtraction: **a refusal is an answer, and
 * an answer ends the walk.** The table in `funderAnsweredWith` is the whole of
 * it, and every row is a shape one of the two deployed services really sends —
 * a `429` from the balancer's per-caller bucket, a `503` carrying
 * `{"error":"wallet-syncing"}` while its own spend settles, and the HTML
 * `502` Caddy answers with when the Node process behind it is down.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/lib`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  firstFunderThatAnswers,
  funderAnsweredWith,
  funderDidNotAnswer,
  funderRefusalCode,
  funderTransportReason,
  type FunderAnswer,
} from './funderFailover.js';

const PRIMARY = 'https://67-205-177-162.sslip.io/balancer';
const STANDBY = 'https://standby.example/balancer';

describe('funderRefusalCode', () => {
  it('reads the code out of either field the two services use', () => {
    /* The alias and activation routes answer `error`; the fee routes answer
       `code`. Both are the funder naming its own refusal. */
    expect(funderRefusalCode({ error: 'wallet-syncing' })).toBe('wallet-syncing');
    expect(funderRefusalCode({ code: 'INSUFFICIENT_DUST' })).toBe('INSUFFICIENT_DUST');
    expect(funderRefusalCode({ error: '  PAUSED  ' })).toBe('PAUSED');
  });

  it('prefers `error` where a body carries both', () => {
    expect(funderRefusalCode({ error: 'name-taken', code: 'IGNORED' })).toBe('name-taken');
  });

  it('names nothing for a body that is not a funder refusal', () => {
    /* The HTML error page is the one that matters: it is what an edge sends on
       behalf of a service that never saw the request, and reading a code out
       of it would be reading a refusal the funder never made. */
    for (const body of [null, undefined, '<html>502 Bad Gateway</html>', 42, [], {}]) {
      expect(funderRefusalCode(body)).toBeNull();
    }
    expect(funderRefusalCode({ error: '   ' })).toBeNull();
    expect(funderRefusalCode({ error: 500 })).toBeNull();
  });
});

describe('funderAnsweredWith', () => {
  it('counts every answer the funder made itself as an answer', () => {
    /* THE WHOLE POINT. A refusal is an answer, and a standby asked behind one
       is a second wallet registering the same name or granting a second time.
       `500` is deliberately here: it comes out of the funder's own process, so
       it is a funder that received the request and may have acted on it. */
    expect(funderAnsweredWith(200, { ok: true })).toBe(true);
    expect(funderAnsweredWith(400, { error: 'invalid-request' })).toBe(true);
    expect(funderAnsweredWith(409, { error: 'name-taken' })).toBe(true);
    expect(funderAnsweredWith(429, { error: 'rate-limited', retryAfterMs: 60_000 })).toBe(true);
    expect(funderAnsweredWith(500, null)).toBe(true);
  });

  it('counts a bare 502, 503, or 504 as an edge speaking for a funder that did not', () => {
    expect(funderAnsweredWith(502, '<html>502 Bad Gateway</html>')).toBe(false);
    expect(funderAnsweredWith(503, null)).toBe(false);
    expect(funderAnsweredWith(504, {})).toBe(false);
  });

  it('lets a named code override the status, because the funder answered', () => {
    /* The balancer's own readiness refusal IS a 503. Falling through on it
       would send every busy minute of the primary's day to the standby. */
    expect(funderAnsweredWith(503, { error: 'wallet-syncing' })).toBe(true);
    expect(funderAnsweredWith(503, { code: 'INSUFFICIENT_DUST' })).toBe(true);
    expect(funderAnsweredWith(502, { error: 'PAUSED' })).toBe(true);
  });
});

describe('funderTransportReason', () => {
  it('takes an Error at its word and stringifies anything else', () => {
    expect(funderTransportReason(new Error('Failed to fetch'))).toBe('Failed to fetch');
    expect(funderTransportReason('AbortError')).toBe('AbortError');
  });
});

describe('firstFunderThatAnswers', () => {
  const answered = <T>(value: T): FunderAnswer<T> => ({ answered: true, value });

  it('asks one funder when the first one answers, and logs nothing', async () => {
    const asked: string[] = [];
    const log = vi.fn();
    const outcome = await firstFunderThatAnswers(
      [PRIMARY, STANDBY],
      async (url) => {
        asked.push(url);
        return answered('granted');
      },
      'the activation grant',
      log,
    );
    expect(asked).toEqual([PRIMARY]);
    expect(outcome).toMatchObject({ served: true, url: PRIMARY, index: 0, value: 'granted' });
    // No failover happened, so there is nothing for an operator to know.
    expect(log).not.toHaveBeenCalled();
  });

  it('STOPS at a refusal the funder made, however unhelpful it was', async () => {
    /* The refusal is carried out as the VALUE — that is how a caller keeps
       classifying it exactly as it classifies one funder's refusal today — and
       the standby is never contacted. */
    const asked: string[] = [];
    const outcome = await firstFunderThatAnswers(
      [PRIMARY, STANDBY],
      async (url) => {
        asked.push(url);
        return answered({ status: 429, error: 'rate-limited' });
      },
      'the activation grant',
      vi.fn(),
    );
    expect(asked).toEqual([PRIMARY]);
    expect(outcome).toMatchObject({ served: true, index: 0 });
  });

  it('falls through a funder that did not answer, and says so once', async () => {
    const log = vi.fn();
    const outcome = await firstFunderThatAnswers(
      [PRIMARY, STANDBY],
      async (url) =>
        url === PRIMARY ? funderDidNotAnswer('Failed to fetch') : answered('granted'),
      'the activation grant',
      log,
    );
    expect(outcome).toMatchObject({ served: true, url: STANDBY, index: 1 });
    expect(log).toHaveBeenCalledTimes(1);
    /* ONE line, naming the INDEX in the operator's own list first — "endpoint
       1" is the fact they can act on — then the URL, then what was fallen
       through. No secrets, and nothing a reader ever sees. */
    expect(log.mock.calls[0]?.[0]).toBe(
      `[funder] the activation grant answered by endpoint 1 (${STANDBY}) after ${PRIMARY}: Failed to fetch`,
    );
  });

  it('carries every silence back when nobody answered, and invents nothing', async () => {
    const outcome = await firstFunderThatAnswers(
      [PRIMARY, STANDBY],
      async (url) => funderDidNotAnswer(`${url} is down`),
      'name registration',
      vi.fn(),
    );
    expect(outcome.served).toBe(false);
    expect(outcome.refusals.map((refusal) => refusal.url)).toEqual([PRIMARY, STANDBY]);
  });

  it('reads a throw from the ask as a funder that did not answer', async () => {
    /* A `fetch` rejection is the only thing a throw from here can honestly
       mean, and treating it as silence is what lets a caller be written
       without a try/catch around every branch. */
    const outcome = await firstFunderThatAnswers(
      [PRIMARY, STANDBY],
      async (url) => {
        if (url === PRIMARY) throw new Error('The operation was aborted');
        return answered('granted');
      },
      'the activation grant',
      vi.fn(),
    );
    expect(outcome).toMatchObject({ served: true, index: 1 });
  });

  it('answers an unconfigured funder without asking anybody', async () => {
    // `VITE_FUNDER_URL` unset is a real state — every name simply queues.
    const ask = vi.fn();
    const outcome = await firstFunderThatAnswers([], ask, 'name registration', vi.fn());
    expect(outcome).toEqual({ served: false, refusals: [] });
    expect(ask).not.toHaveBeenCalled();
  });

  it('logs through console.info when no logger is given', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await firstFunderThatAnswers(
        [PRIMARY, STANDBY],
        async (url) => (url === PRIMARY ? funderDidNotAnswer('down') : answered('ok')),
        'the sponsorship probe',
      );
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
    }
  });
});

describe('the failover table, end to end', () => {
  /**
   * The four rows the standby droplet was specified against, each run through
   * the classification and the walk together — because it is the PAIR that has
   * to be right, and either half alone can be read as correct while the demo
   * grants twice.
   */
  const rows: Array<{
    what: string;
    fail: () => FunderAnswer<string>;
    expectStandby: boolean;
  }> = [
    {
      what: 'a network error',
      fail: () => funderDidNotAnswer(funderTransportReason(new Error('Failed to fetch'))),
      expectStandby: true,
    },
    {
      what: 'a 429 the funder itself sent',
      fail: () =>
        funderAnsweredWith(429, { error: 'rate-limited' })
          ? { answered: true, value: '429 rate-limited' }
          : funderDidNotAnswer('429'),
      expectStandby: false,
    },
    {
      what: 'a 503 naming a code',
      fail: () =>
        funderAnsweredWith(503, { error: 'INSUFFICIENT_DUST' })
          ? { answered: true, value: '503 INSUFFICIENT_DUST' }
          : funderDidNotAnswer('503'),
      expectStandby: false,
    },
    {
      what: 'a 502 carrying an HTML error page',
      fail: () =>
        funderAnsweredWith(502, '<html>502 Bad Gateway</html>')
          ? { answered: true, value: '502' }
          : funderDidNotAnswer('HTTP 502'),
      expectStandby: true,
    },
  ];

  for (const row of rows) {
    it(`${row.expectStandby ? 'asks' : 'does not ask'} the standby after ${row.what}`, async () => {
      const asked: string[] = [];
      await firstFunderThatAnswers(
        [PRIMARY, STANDBY],
        async (url) => {
          asked.push(url);
          return url === PRIMARY ? row.fail() : { answered: true, value: 'granted' };
        },
        'the activation grant',
        vi.fn(),
      );
      expect(asked).toEqual(row.expectStandby ? [PRIMARY, STANDBY] : [PRIMARY]);
    });
  }
});
