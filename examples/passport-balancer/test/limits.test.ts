/**
 * The abuse guards, tested without a chain and without a clock.
 *
 * What these exist to hold true is one live hole, found by audit on 2026/09/01
 * and closed the same day: `/balance-only`, `/register-alias`, and
 * `/fund-account` ran their handlers for any caller who knew the URL, and
 * `/balance-only` paid a DUST fee on every one of them. The CORS allow-list was
 * never a gate — it decides which headers a browser is handed back, long after
 * the handler has run and the fee has been paid.
 *
 * The forwarded-address tests are the ones that matter most, because a
 * per-client limit keyed on a header anybody can set is not a limit at all: an
 * abuser sends a fresh `X-Forwarded-For` per request and gets a fresh bucket
 * every time. Everything below is on a fake clock, so a refill is asserted
 * rather than waited for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_BALANCE_BURST,
  DEFAULT_BALANCE_MAX_PER_MIN,
  DEFAULT_SPEND_BURST,
  DEFAULT_SPEND_MAX_PER_MIN,
  DEFAULT_SPEND_QUEUE_MAX,
  loadConfig,
} from '../src/config.js';
import {
  RefusalCounts,
  SpendAdmission,
  TokenBucket,
  UNKNOWN_CLIENT,
  clientAddress,
  clientKeyAccepted,
  normaliseAddress,
} from '../src/limits.js';

/** A clock the tests move by hand. */
function fakeClock(startAt = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = startAt;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** A seed-carrying environment, so `loadConfig` gets past its own first gate. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { BALANCER_SEED: 'a'.repeat(64), ...extra };
}

describe('the per-client token bucket', () => {
  it('serves the whole burst at once and then refuses', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerMinute: 12, burst: 6, now: clock.now });

    for (let call = 1; call <= 6; call += 1) {
      assert.equal(bucket.take('1.2.3.4').allowed, true, `call ${call} should be served`);
    }
    const refused = bucket.take('1.2.3.4');
    assert.equal(refused.allowed, false);
    /* Twelve a minute is one token every five seconds, and the bucket is empty,
       so the whole five is outstanding. */
    assert.equal(refused.retryAfterMs, 5_000);
  });

  it('refills at the configured rate and not faster', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerMinute: 12, burst: 6, now: clock.now });
    for (let call = 0; call < 6; call += 1) bucket.take('1.2.3.4');

    clock.advance(4_999);
    assert.equal(bucket.take('1.2.3.4').allowed, false, 'a token is not yet whole');
    clock.advance(1);
    assert.equal(bucket.take('1.2.3.4').allowed, true, 'five seconds buys exactly one');
    assert.equal(bucket.take('1.2.3.4').allowed, false, 'and exactly one');
  });

  it('never refills past the burst, however long a client is silent', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerMinute: 12, burst: 6, now: clock.now });
    bucket.take('1.2.3.4');
    clock.advance(24 * 60 * 60 * 1_000);

    for (let call = 1; call <= 6; call += 1) {
      assert.equal(bucket.take('1.2.3.4').allowed, true, `call ${call} should be served`);
    }
    assert.equal(bucket.take('1.2.3.4').allowed, false, 'a day of silence is still one burst');
  });

  it('keys each client separately, so one caller cannot spend another’s budget', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerMinute: 3, burst: 3, now: clock.now });
    for (let call = 0; call < 3; call += 1) bucket.take('1.2.3.4');

    assert.equal(bucket.take('1.2.3.4').allowed, false, 'the flooder is out of tokens');
    assert.equal(bucket.take('5.6.7.8').allowed, true, 'and everybody else is untouched');
  });

  it('is off entirely when the rate is zero — the documented off switch', () => {
    const bucket = new TokenBucket({ ratePerMinute: 0, burst: 1 });
    assert.equal(bucket.enabled, false);
    for (let call = 0; call < 1_000; call += 1) {
      assert.equal(bucket.take('1.2.3.4').allowed, true);
    }
    assert.equal(bucket.size, 0, 'a disabled bucket remembers nobody');
  });

  it('forgets idle keys, and only once forgetting them changes nothing', () => {
    const clock = fakeClock();
    /* One a minute with a burst of one: a full refill takes 60 s, so the floor
       under `idleMs` is 60 s even though 1 ms was asked for. */
    const bucket = new TokenBucket({ ratePerMinute: 1, burst: 1, now: clock.now, idleMs: 1 });
    bucket.take('1.2.3.4');
    assert.equal(bucket.size, 1);
    assert.equal(bucket.take('1.2.3.4').allowed, false, 'still empty a moment later');

    clock.advance(60_000);
    assert.equal(bucket.take('5.6.7.8').allowed, true);
    assert.equal(bucket.size, 1, 'the idle key was swept, the live one kept');
    /* And the sweep gave nothing away: a minute is exactly the refill, so the
       forgotten key would have had its token back regardless. */
    assert.equal(bucket.take('1.2.3.4').allowed, true);
  });
});

describe('the spend admission cap', () => {
  it('admits up to the cap and refuses past it', () => {
    const admission = new SpendAdmission(3);
    assert.equal(admission.enter(), true);
    assert.equal(admission.enter(), true);
    assert.equal(admission.enter(), true);
    assert.equal(admission.enter(), false, 'the fourth is refused rather than queued');
    assert.equal(admission.depth, 3);
  });

  it('frees a slot when a request finishes', () => {
    const admission = new SpendAdmission(1);
    assert.equal(admission.enter(), true);
    assert.equal(admission.enter(), false);
    admission.leave();
    assert.equal(admission.depth, 0);
    assert.equal(admission.enter(), true, 'the next caller gets the freed slot');
  });

  it('cannot be driven below zero by a double release', () => {
    const admission = new SpendAdmission(2);
    admission.enter();
    admission.leave();
    admission.leave();
    assert.equal(admission.depth, 0);
    assert.equal(admission.enter(), true);
    assert.equal(admission.enter(), true);
    assert.equal(admission.enter(), false, 'the cap still holds');
  });

  it('is unbounded at zero', () => {
    const admission = new SpendAdmission(0);
    for (let call = 0; call < 100; call += 1) assert.equal(admission.enter(), true);
    assert.equal(admission.depth, 100);
  });
});

describe('the forwarded-address trust rule', () => {
  it('ignores X-Forwarded-For from the internet, however loudly it claims', () => {
    assert.equal(
      clientAddress({ socketAddress: '203.0.113.9', forwardedFor: '10.0.0.1' }),
      '203.0.113.9',
    );
    /* The whole attack in one line: a fresh forged address per request would be
       a fresh bucket per request. The socket is what answers. */
    assert.equal(
      clientAddress({ socketAddress: '203.0.113.9', forwardedFor: 'not-an-address, 8.8.8.8' }),
      '203.0.113.9',
    );
  });

  it('believes it from loopback, where Caddy is', () => {
    assert.equal(
      clientAddress({ socketAddress: '127.0.0.1', forwardedFor: '203.0.113.9' }),
      '203.0.113.9',
    );
  });

  it('reads the chain from the right, which is the end a client cannot reach', () => {
    /* Caddy APPENDS the address it observed to whatever arrived, so a client
       sending `X-Forwarded-For: 10.0.0.1` produces `10.0.0.1, <real>`. The
       rightmost entry is the only one it did not write. */
    assert.equal(
      clientAddress({ socketAddress: '127.0.0.1', forwardedFor: '10.0.0.1, 203.0.113.9' }),
      '203.0.113.9',
    );
  });

  it('skips further trusted proxies to reach the real caller', () => {
    assert.equal(
      clientAddress({
        socketAddress: '127.0.0.1',
        forwardedFor: '10.0.0.1, 203.0.113.9, 198.51.100.7',
        trustedProxies: ['127.0.0.1', '198.51.100.7'],
      }),
      '203.0.113.9',
    );
  });

  it('falls back to the peer when the chain says nothing usable', () => {
    assert.equal(clientAddress({ socketAddress: '127.0.0.1' }), '127.0.0.1');
    assert.equal(clientAddress({ socketAddress: '127.0.0.1', forwardedFor: '  ,  ' }), '127.0.0.1');
    assert.equal(
      clientAddress({ socketAddress: '127.0.0.1', forwardedFor: '127.0.0.1, ::1' }),
      '127.0.0.1',
      'a chain that is entirely proxies names no caller',
    );
  });

  it('answers something for a socket it cannot read', () => {
    assert.equal(clientAddress({ socketAddress: undefined }), UNKNOWN_CLIENT);
    assert.equal(clientAddress({ socketAddress: '' }), UNKNOWN_CLIENT);
  });

  it('spells one address one way, so one client is one bucket', () => {
    assert.equal(normaliseAddress('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(normaliseAddress('  203.0.113.9  '), '203.0.113.9');
    assert.equal(normaliseAddress('203.0.113.9:51234'), '203.0.113.9');
    assert.equal(normaliseAddress('[2001:DB8::1]:443'), '2001:db8::1');
    assert.equal(normaliseAddress('2001:DB8::1'), '2001:db8::1');
    assert.equal(normaliseAddress(undefined), null);
    /* A dual-stack socket reports loopback as `::ffff:127.0.0.1`, and a proxy
       list written by hand says `127.0.0.1`. They have to be the same peer or
       the trust rule silently stops trusting Caddy. */
    assert.equal(
      clientAddress({ socketAddress: '::ffff:127.0.0.1', forwardedFor: '203.0.113.9' }),
      '203.0.113.9',
    );
  });
});

describe('the shared-secret gate', () => {
  it('admits everybody when no key is configured', () => {
    assert.equal(clientKeyAccepted(undefined, undefined), true);
    assert.equal(clientKeyAccepted(undefined, 'anything'), true);
    assert.equal(clientKeyAccepted('', 'anything'), true);
  });

  it('admits only the right key when one is configured', () => {
    assert.equal(clientKeyAccepted('s3cret', 's3cret'), true);
    assert.equal(clientKeyAccepted('s3cret', ' s3cret '), true, 'trimmed, as a header often is');
    assert.equal(clientKeyAccepted('s3cret', 's3crets'), false);
    assert.equal(clientKeyAccepted('s3cret', 'S3CRET'), false);
    assert.equal(clientKeyAccepted('s3cret', ''), false);
    assert.equal(clientKeyAccepted('s3cret', undefined), false, 'a missing header is a refusal');
    /* A repeated header arrives as an array; the first value is the one read,
       and a wrong first value is not rescued by a right second one. */
    assert.equal(clientKeyAccepted('s3cret', ['s3cret', 'wrong']), true);
    assert.equal(clientKeyAccepted('s3cret', ['wrong', 's3cret']), false);
  });
});

describe('the guard configuration', () => {
  it('defaults to the ceilings the demo runs with', () => {
    const config = loadConfig(env());
    assert.deepEqual(config.balanceRate, {
      perMinute: DEFAULT_BALANCE_MAX_PER_MIN,
      burst: DEFAULT_BALANCE_BURST,
    });
    assert.deepEqual(config.aliasRate, {
      perMinute: DEFAULT_SPEND_MAX_PER_MIN,
      burst: DEFAULT_SPEND_BURST,
    });
    assert.deepEqual(config.accountRate, {
      perMinute: DEFAULT_SPEND_MAX_PER_MIN,
      burst: DEFAULT_SPEND_BURST,
    });
    assert.equal(config.spendQueueMax, DEFAULT_SPEND_QUEUE_MAX);
    assert.deepEqual(config.trustedProxies, ['127.0.0.1', '::1']);
    assert.equal(config.clientKey, undefined, 'the key gate is off until an operator sets one');
  });

  it('takes every knob from the environment', () => {
    const config = loadConfig(
      env({
        BALANCER_BALANCE_MAX_PER_MIN: '30',
        BALANCER_BALANCE_BURST: '10',
        BALANCER_ALIAS_MAX_PER_MIN: '1',
        BALANCER_ALIAS_BURST: '2',
        BALANCER_ACCOUNT_MAX_PER_MIN: '0',
        BALANCER_ACCOUNT_BURST: '4',
        BALANCER_SPEND_QUEUE_MAX: '2',
        BALANCER_TRUSTED_PROXIES: '127.0.0.1, 10.0.0.5',
        BALANCER_CLIENT_KEY: 's3cret',
      }),
    );
    assert.deepEqual(config.balanceRate, { perMinute: 30, burst: 10 });
    assert.deepEqual(config.aliasRate, { perMinute: 1, burst: 2 });
    assert.deepEqual(config.accountRate, { perMinute: 0, burst: 4 });
    assert.equal(config.spendQueueMax, 2);
    assert.deepEqual(config.trustedProxies, ['127.0.0.1', '10.0.0.5']);
    assert.equal(config.clientKey, 's3cret');
  });

  it('refuses to start on a ceiling that is not a whole number', () => {
    /* A mistyped limit that silently became NaN would read as "no limit" — the
       one failure mode a limit must not have. */
    assert.throws(
      () => loadConfig(env({ BALANCER_BALANCE_MAX_PER_MIN: 'lots' })),
      /BALANCER_BALANCE_MAX_PER_MIN/,
    );
    assert.throws(() => loadConfig(env({ BALANCER_ALIAS_BURST: '-1' })), /BALANCER_ALIAS_BURST/);
    assert.throws(
      () => loadConfig(env({ BALANCER_SPEND_QUEUE_MAX: '2.5' })),
      /BALANCER_SPEND_QUEUE_MAX/,
    );
  });

  it('keeps the existing hourly ceilings untouched', () => {
    /* The per-client bucket sits UNDER the global ceiling; it does not replace
       it, and a change that quietly dropped one would leave the wallet open to
       a distributed flood. */
    const config = loadConfig(env());
    assert.equal(config.aliasMaxPerHour, 20);
    assert.equal(config.accountMaxPerHour, 30);
  });

  it('lets the deployment raise those ceilings without touching the per-client ones', () => {
    /* What `deploy/passport-balancer.service` sets after the 2026/09/04 sponsor
       soak. The ceilings are GLOBAL, and they were the binding constraint on
       that hour — 18 signups with one other tester on the same service
       exhausted both, and the last two were refused a name. The per-client
       limits are what bounds ONE caller and must survive the raise: a global
       ceiling lifted without them hands the hour to whoever asks fastest. */
    const config = loadConfig(
      env({ BALANCER_ALIAS_MAX_PER_HOUR: '60', BALANCER_ACCOUNT_MAX_PER_HOUR: '80' }),
    );
    assert.equal(config.aliasMaxPerHour, 60);
    assert.equal(config.accountMaxPerHour, 80);
    assert.equal(config.aliasRate.perMinute, DEFAULT_SPEND_MAX_PER_MIN);
    assert.equal(config.aliasRate.burst, DEFAULT_SPEND_BURST);
    assert.equal(config.accountRate.perMinute, DEFAULT_SPEND_MAX_PER_MIN);
    assert.equal(config.accountRate.burst, DEFAULT_SPEND_BURST);
  });
});

describe('what /status says was turned away', () => {
  /* THE BLIND SPOT THIS CLOSES. Through the 2026/09/04 sponsor soak
     `/status.refusedRateLimited` read 0 while the journal carried six genuine
     429s — two alias ceilings and six account ceilings — because the hourly
     ceilings refuse in the route handlers, hundreds of lines from the guard
     that owned the counter, and never touched it. An operator watching a demo
     had a number that looked like an answer and was not one. */

  it('starts at zero on every counter', () => {
    assert.deepEqual(new RefusalCounts().snapshot(), {
      refusedRateLimited: 0,
      refusedCeiling: 0,
      refusedQueueFull: 0,
      refusedUnauthorised: 0,
    });
  });

  it('counts a ceiling refusal as rate-limited, because that is what the caller was told', () => {
    const counts = new RefusalCounts();
    counts.countCeiling();
    counts.countCeiling();
    const snapshot = counts.snapshot();
    assert.equal(snapshot.refusedRateLimited, 2);
    assert.equal(snapshot.refusedCeiling, 2);
  });

  it('keeps the two gates apart, and the ceiling is always a subset', () => {
    /* The per-client bucket says "you are asking too fast"; the ceiling says
       "the hour is spent for everybody". Both answer `rate-limited` on the
       wire, and the operator's action differs: wait, or raise the ceiling. */
    const counts = new RefusalCounts();
    counts.countRateLimited();
    counts.countRateLimited();
    counts.countCeiling();
    const snapshot = counts.snapshot();
    assert.equal(snapshot.refusedRateLimited, 3);
    assert.equal(snapshot.refusedCeiling, 1);
    assert.ok(snapshot.refusedCeiling <= snapshot.refusedRateLimited);
  });

  it('counts the other two gates without touching either rate figure', () => {
    const counts = new RefusalCounts();
    counts.countQueueFull();
    counts.countUnauthorised();
    counts.countUnauthorised();
    assert.deepEqual(counts.snapshot(), {
      refusedRateLimited: 0,
      refusedCeiling: 0,
      refusedQueueFull: 1,
      refusedUnauthorised: 2,
    });
  });

  it('hands back a snapshot, not the live counters', () => {
    /* `/status` serialises what it is given. A live object handed out would
       change under a response already being written. */
    const counts = new RefusalCounts();
    const before = counts.snapshot();
    counts.countCeiling();
    assert.equal(before.refusedCeiling, 0);
    assert.equal(counts.snapshot().refusedCeiling, 1);
  });
});
