/**
 * Unit tests for the pure parts of the sponsor client.
 *
 * These cover the decisions that make sponsorship honest: which URLs are
 * allowed, which `/wallet-status` bodies count as "can pay", which
 * `/balance-only` bodies count as a real balanced transaction, and how a
 * pending-transaction retry is bounded. The network calls themselves are
 * exercised against the real gateway by `scripts/`-free node proof in the
 * contract report — there is no mock of the service's behaviour here, because a
 * mock would be exactly the kind of pretend the demo must not ship.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/lib`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  assertSecureSponsorUrl,
  combineSponsorReadiness,
  createSponsorError,
  describeSponsorWalletStatus,
  normaliseSponsorHex,
  parseSponsorWalletStatus,
  resetSponsorReadinessCache,
  sponsorBalanceOnly,
  sponsorCanPay,
  sponsorConfig,
  sponsorConfigs,
  sponsorFeeRefusal,
  sponsorRefusal,
  sponsorHexToBytes,
  sponsorReadiness,
  sponsorRetryDelayMs,
  sponsorWalletIsAvailable,
  validateSponsorBalanceResult,
  SPONSOR_PROBE_RETRY_DELAY_MS,
  SponsorError,
} from './sponsor.js';

/** The exact body `https://api-preview.1am.xyz/wallet-status` returned on 2026/08/05. */
const LIVE_PREVIEW_WALLET_STATUS = {
  total: 1,
  available: 0,
  wallets: [
    {
      index: 0,
      ready: true,
      syncState: 'ready',
      address: 'mn_addr_preview1emdcrp6c8l7n8z3uwtm8mtqtxywyur4aqlte8qh8nafyvzd26c5q0k5elf',
      dust: {
        balance: '0',
        utxoCount: 0,
        isSynced: true,
        syncProgress: '100%',
        unavailableCause: 'INSUFFICIENT_DUST',
      },
    },
  ],
  version: '0.2.0',
};

describe('sponsorConfig', () => {
  /* Sponsorship is ON BY DEFAULT since 2026/08/07 — a fresh passkey wallet
     holds no DUST, so default-off failed every first transaction. An unset URL
     therefore means "this network's default gateway", `off` means disabled,
     and a network with no gateway entry stays unsponsored. */
  it('falls back to the network gateway when VITE_SPONSOR_URL is unset', () => {
    /* An unset network id means stagenet, which this build's wallet runs on,
       and stagenet's gateway is our own balancer rather than a 1AM one — there
       is no 1AM gateway on stagenet. It speaks the identical wire contract, so
       every other assertion in this file is unaffected. */
    expect(sponsorConfig({})).toEqual({
      url: 'https://67-205-177-162.sslip.io/balancer',
    });
    expect(sponsorConfig({ VITE_SPONSOR_URL: '   ' })).toEqual({
      url: 'https://67-205-177-162.sslip.io/balancer',
    });
    expect(sponsorConfig({ VITE_MIDNIGHT_NETWORK_ID: 'stagenet' })).toEqual({
      url: 'https://67-205-177-162.sslip.io/balancer',
    });
    /* The ledger-8 networks keep their entries: this build cannot transact on
       them, but the table is still the one place that says which gateway each
       network uses, and dropping them would lose that. */
    expect(sponsorConfig({ VITE_MIDNIGHT_NETWORK_ID: 'preview' })).toEqual({
      url: 'https://api-preview.1am.xyz',
    });
    expect(sponsorConfig({ VITE_MIDNIGHT_NETWORK_ID: 'preprod' })).toEqual({
      url: 'https://api-preprod.1am.xyz',
    });
  });

  it('refuses the literal `off`, and is null on a network with no gateway', () => {
    expect(() => sponsorConfig({ VITE_SPONSOR_URL: 'off' })).toThrow(/VITE_SPONSOR_URL/);
    expect(sponsorConfig({ VITE_MIDNIGHT_NETWORK_ID: 'undeployed' })).toBeNull();
  });

  it('trims the trailing slash and carries optional auth headers', () => {
    expect(
      sponsorConfig({
        VITE_SPONSOR_URL: 'https://api-preview.1am.xyz/',
        VITE_SPONSOR_API_KEY: 'k',
        VITE_SPONSOR_CLIENT_ID: 'c',
      }),
    ).toEqual({ url: 'https://api-preview.1am.xyz', apiKey: 'k', clientId: 'c' });
  });

  it('refuses a plaintext non-localhost URL rather than downgrading', () => {
    expect(() => sponsorConfig({ VITE_SPONSOR_URL: 'http://api-preview.1am.xyz' })).toThrow(
      /Insecure sponsor service URL/,
    );
  });
});

describe('assertSecureSponsorUrl', () => {
  it('allows HTTPS and localhost over HTTP', () => {
    expect(() => assertSecureSponsorUrl('https://api-preview.1am.xyz')).not.toThrow();
    expect(() => assertSecureSponsorUrl('http://localhost:8080')).not.toThrow();
    expect(() => assertSecureSponsorUrl('http://127.0.0.1:8080')).not.toThrow();
  });

  it('rejects plaintext elsewhere and rejects nonsense', () => {
    expect(() => assertSecureSponsorUrl('http://proxy.1am.xyz')).toThrow(/Insecure/);
    expect(() => assertSecureSponsorUrl('not a url')).toThrow(/Invalid sponsor service URL/);
  });
});

describe('parseSponsorWalletStatus / sponsorWalletIsAvailable', () => {
  it('parses the live preview body and refuses to call it available', () => {
    const status = parseSponsorWalletStatus(LIVE_PREVIEW_WALLET_STATUS);
    expect(status).not.toBeNull();
    expect(status?.total).toBe(1);
    expect(status?.available).toBe(0);
    expect(status?.wallets[0]).toMatchObject({
      index: 0,
      ready: true,
      syncState: 'ready',
      dust: { balance: '0', isSynced: true },
    });
    // The whole point of the stricter gate: ready + synced + zero dust is NOT
    // available. `isBalanceServiceReady` upstream would have said yes here.
    expect(sponsorWalletIsAvailable(status)).toBe(false);
  });

  it('is available only when the service says a wallet can pay', () => {
    const status = parseSponsorWalletStatus({
      total: 2,
      available: 1,
      wallets: [{ index: 0, ready: true, dust: { balance: '900000', utxoCount: 2, isSynced: true } }],
    });
    expect(sponsorWalletIsAvailable(status)).toBe(true);
  });

  it('returns null for bodies that are not wallet-status', () => {
    expect(parseSponsorWalletStatus(null)).toBeNull();
    expect(parseSponsorWalletStatus('ok')).toBeNull();
    expect(parseSponsorWalletStatus({ status: 'healthy' })).toBeNull();
    // The legacy /ready body is deliberately NOT accepted.
    expect(parseSponsorWalletStatus({ balanceReady: true })).toBeNull();
    expect(sponsorWalletIsAvailable(null)).toBe(false);
  });
});

describe('validateSponsorBalanceResult', () => {
  it('accepts a well-formed body and normalises the hex', () => {
    expect(
      validateSponsorBalanceResult({
        txHash: '0xABCD',
        txBytes: '0xDEADBEEF',
        expiresAt: '2026-08-05T12:00:00.000Z',
      }),
    ).toEqual({
      txHash: '0xABCD',
      txBytes: 'deadbeef',
      expiresAt: '2026-08-05T12:00:00.000Z',
    });
  });

  it('tolerates a missing expiresAt but nothing else', () => {
    expect(validateSponsorBalanceResult({ txHash: 'a', txBytes: 'ff' }).expiresAt).toBe('');
    expect(() => validateSponsorBalanceResult(null)).toThrow(/not an object/);
    expect(() => validateSponsorBalanceResult({ txBytes: 'ff' })).toThrow(/missing txHash/);
    expect(() => validateSponsorBalanceResult({ txHash: 'a' })).toThrow(/missing txBytes/);
    expect(() => validateSponsorBalanceResult({ txHash: 'a', txBytes: 'zz' })).toThrow(/not hex/);
    expect(() => validateSponsorBalanceResult({ txHash: 'a', txBytes: 'abc' })).toThrow(/not hex/);
    // A submit-style body is not a balance body; it must not be waved through.
    expect(() => validateSponsorBalanceResult({ txId: '1', txHash: 'a' })).toThrow(/missing txBytes/);
  });
});

describe('hex decoding', () => {
  it('round-trips bytes', () => {
    expect(Array.from(sponsorHexToBytes('0x00ff10'))).toEqual([0, 255, 16]);
    expect(normaliseSponsorHex('AABB')).toBe('aabb');
    expect(() => sponsorHexToBytes('')).toThrow(/not hex/);
  });
});

describe('createSponsorError', () => {
  it('classifies the 503 the preview gateway returns today', () => {
    const error = createSponsorError(503, {
      error: 'WALLETS_UNAVAILABLE',
      cause: 'INSUFFICIENT_DUST',
      retryAfterMs: 5000,
    });
    expect(error).toBeInstanceOf(SponsorError);
    expect(error.status).toBe(503);
    expect(error.code).toBe('WALLETS_UNAVAILABLE');
    expect(error.detail).toBe('INSUFFICIENT_DUST');
    expect(error.retryAfterMs).toBe(5000);
    expect(error.isRetryable).toBe(true);
    expect(error.isPendingTransaction).toBe(false);
  });

  it('classifies a pending transaction and an unnamed failure', () => {
    expect(createSponsorError(429, { error: 'PENDING_TRANSACTION' }).isPendingTransaction).toBe(true);
    expect(createSponsorError(429, { message: 'tx already pending' }).isPendingTransaction).toBe(true);
    const unknown = createSponsorError(500, null);
    expect(unknown.code).toBe('UNKNOWN');
    expect(unknown.detail).toBe('HTTP 500');
    expect(unknown.retryAfterMs).toBeUndefined();
  });
});

describe('sponsorRetryDelayMs', () => {
  it('honours retryAfterMs, floors it, and never overruns the budget', () => {
    expect(sponsorRetryDelayMs(5_000, 20_000)).toBe(5_000);
    expect(sponsorRetryDelayMs(0, 20_000)).toBe(250);
    expect(sponsorRetryDelayMs(undefined, 20_000)).toBe(2_000);
    expect(sponsorRetryDelayMs(5_000, 900)).toBe(900);
  });
});

describe('sponsorReadiness', () => {
  it('reports disabled without touching the network', async () => {
    resetSponsorReadinessCache();
    const fetchSpy = vi.fn();
    expect(await sponsorReadiness({ config: null, fetch: fetchSpy as never })).toEqual({
      state: 'disabled',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports unavailable for the live preview body, and caches the probe', async () => {
    resetSponsorReadinessCache();
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify(LIVE_PREVIEW_WALLET_STATUS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const options = { config: { url: 'https://api-preview.1am.xyz' }, fetch: fetchSpy as never };
    const first = await sponsorReadiness(options);
    expect(first.state).toBe('unavailable');
    expect(first.state === 'unavailable' && first.reason).toMatch(/0\/1 wallets available/);
    await sponsorReadiness(options);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('probes again when forced, so a watcher is never told a cached answer', async () => {
    /* The Send sheet WATCHES this while it is open. A cached verdict is exactly
       what a watcher must not have: the commonest refusal — the sponsor's DUST
       reserved against a transaction in flight — clears in about a minute, and
       a 30-second cache would keep the control disabled for half the time the
       sponsor was already free. */
    resetSponsorReadinessCache();
    let available = 0;
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ total: 1, available, wallets: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const options = { config: { url: 'https://api-preview.1am.xyz' }, fetch: fetchSpy as never };
    expect((await sponsorReadiness(options)).state).toBe('unavailable');
    // The sponsor comes back, well inside the cache's TTL.
    available = 1;
    // Unforced: still the cached refusal, and no second call.
    expect((await sponsorReadiness(options)).state).toBe('unavailable');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Forced: asked again, and the answer has changed.
    expect((await sponsorReadiness({ ...options, force: true })).state).toBe('ready');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // And the forced answer replaces the cache, so the next reader agrees.
    expect((await sponsorReadiness(options)).state).toBe('ready');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    resetSponsorReadinessCache();
  });

  it('retries a transport failure once, then names the error it hit', async () => {
    resetSponsorReadinessCache();
    const slept: number[] = [];
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const readiness = await sponsorReadiness({
      config: { url: 'https://api-preview.1am.xyz' },
      fetch: fetchSpy as never,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    // Never throws: a send must not fail because a FEE OPTIMISER was down.
    expect(readiness).toEqual({
      state: 'unavailable',
      url: 'https://api-preview.1am.xyz',
      reason: 'wallet-status could not be fetched, twice: fetch failed',
      // Nothing came back at all, so nothing was learned about the sponsor's
      // DUST: this is not the transient `busy` a surface should wait out.
      cause: 'unreachable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The injectable seam is what the retry waits on — the test never really
    // sleeps, and a real 500 ms delay would otherwise be spent here.
    expect(slept).toEqual([SPONSOR_PROBE_RETRY_DELAY_MS]);
  });

  it('retries an unparseable 200 once, with its own distinct reason', async () => {
    resetSponsorReadinessCache();
    const slept: number[] = [];
    // The incident behind the retry: the service answered, fast, with a body
    // the parser did not recognise. That is a schema failure, not a network one.
    const fetchSpy = vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 }));
    const readiness = await sponsorReadiness({
      config: { url: 'https://api-preview.1am.xyz' },
      fetch: fetchSpy as never,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(readiness).toEqual({
      state: 'unavailable',
      url: 'https://api-preview.1am.xyz',
      reason: 'wallet-status returned an unrecognised body, twice',
      cause: 'unreachable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([SPONSOR_PROBE_RETRY_DELAY_MS]);
  });

  it('believes a well-formed unavailable answer the first time', async () => {
    resetSponsorReadinessCache();
    const slept: number[] = [];
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify(LIVE_PREVIEW_WALLET_STATUS), { status: 200 }),
    );
    const readiness = await sponsorReadiness({
      config: { url: 'https://api-preview.1am.xyz' },
      fetch: fetchSpy as never,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(readiness.state).toBe('unavailable');
    /* And it is the TRANSIENT cause: the service answered, its DUST is simply
       spoken for. That is what lets a surface wait rather than refuse. */
    expect(readiness).toMatchObject({ cause: 'busy' });
    // A verdict is a verdict: only a FAILURE to reach one is worth retrying.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('believes an HTTP error answer the first time too', async () => {
    resetSponsorReadinessCache();
    const fetchSpy = vi.fn(async () => new Response('nope', { status: 502 }));
    const readiness = await sponsorReadiness({
      config: { url: 'https://api-preview.1am.xyz' },
      fetch: fetchSpy as never,
      sleep: async () => {},
    });
    expect(readiness).toEqual({
      state: 'unavailable',
      url: 'https://api-preview.1am.xyz',
      reason: 'wallet-status returned HTTP 502',
      cause: 'unreachable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports ready only when a wallet is genuinely available', async () => {
    resetSponsorReadinessCache();
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          total: 1,
          available: 1,
          wallets: [{ index: 0, ready: true, dust: { balance: '5000000', isSynced: true } }],
        }),
        { status: 200 },
      ),
    );
    expect(
      await sponsorReadiness({
        config: { url: 'https://api-preview.1am.xyz' },
        fetch: fetchSpy as never,
      }),
    ).toEqual({ state: 'ready', url: 'https://api-preview.1am.xyz', available: 1 });
    resetSponsorReadinessCache();
  });
});

describe('sponsorBalanceOnly', () => {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const config = { url: 'https://api-preview.1am.xyz' };

  it('posts octet-stream bytes and validates the reply', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ txHash: 'aa', txBytes: 'bbcc', expiresAt: 'later' }), {
        status: 200,
      }),
    );
    const result = await sponsorBalanceOnly(bytes, { config, fetch: fetchSpy as never });
    /* `servedBy` is the endpoint that balanced it — the operator's answer to
       "where was this transaction's fee paid", which after the fact nothing
       else can give. */
    expect(result).toEqual({
      txHash: 'aa',
      txBytes: 'bbcc',
      expiresAt: 'later',
      servedBy: 'https://api-preview.1am.xyz',
    });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api-preview.1am.xyz/balance-only');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream',
    );
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
  });

  it('sends the optional auth headers only when configured', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ txHash: 'aa', txBytes: 'bb' }), { status: 200 }),
    );
    await sponsorBalanceOnly(bytes, {
      config: { url: config.url, apiKey: 'key', clientId: 'client' },
      fetch: fetchSpy as never,
    });
    const headers = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('key');
    expect(headers['X-Client-ID']).toBe('client');
  });

  it('throws a typed terminal error on 503 without retrying', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: 'WALLETS_UNAVAILABLE',
          cause: 'INSUFFICIENT_DUST',
          retryAfterMs: 5000,
        }),
        { status: 503 },
      ),
    );
    await expect(sponsorBalanceOnly(bytes, { config, fetch: fetchSpy as never })).rejects.toThrow(
      /WALLETS_UNAVAILABLE/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 inside the window and gives up at the deadline', async () => {
    let clock = 0;
    const slept: number[] = [];
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'PENDING_TRANSACTION', retryAfterMs: 6_000 }), {
        status: 429,
      }),
    );
    await expect(
      sponsorBalanceOnly(bytes, {
        config,
        fetch: fetchSpy as never,
        now: () => clock,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
      }),
    ).rejects.toThrow(/PENDING_TRANSACTION/);
    // 20 s budget, 6 s per wait: four attempts, three waits, then the deadline.
    expect(slept).toEqual([6_000, 6_000, 6_000, 2_000]);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('retries a thrown POST exactly once, and never a POST that answered', async () => {
    const slept: number[] = [];
    let calls = 0;
    const fetchSpy = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ txHash: 'aa', txBytes: 'bbcc' }), { status: 200 });
    });
    const result = await sponsorBalanceOnly(bytes, {
      config,
      fetch: fetchSpy as never,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(result.txBytes).toBe('bbcc');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([SPONSOR_PROBE_RETRY_DELAY_MS]);
  });

  it('gives up after a second thrown POST rather than posting a third time', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      sponsorBalanceOnly(bytes, { config, fetch: fetchSpy as never, sleep: async () => {} }),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 503 the transport delivered', async () => {
    const slept: number[] = [];
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'WALLETS_UNAVAILABLE' }), { status: 503 }),
    );
    await expect(
      sponsorBalanceOnly(bytes, {
        config,
        fetch: fetchSpy as never,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    ).rejects.toThrow(/WALLETS_UNAVAILABLE/);
    // A body that arrived is a body to act on — re-posting it could balance
    // the same transaction twice.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('refuses to run at all when sponsorship is not configured', async () => {
    await expect(sponsorBalanceOnly(bytes, { config: null })).rejects.toThrow(
      /VITE_SPONSOR_URL is unset/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The seams every caller in the app actually uses                            */
/* -------------------------------------------------------------------------- */

describe('the zero-argument forms the app calls', () => {
  it('reads the build’s own environment without being handed one', () => {
    /* `sponsorConfig()` with no argument is what `resolveConfig` falls back to,
       and what every call site in `App.tsx` and `contractRuntime.ts` reaches.
       Which URL it answers with depends on the build, so what is asserted is
       the invariant that holds for every build: sponsorship is either off, or
       it is pointed somewhere a signed transaction may safely go. */
    const config = sponsorConfig();
    if (config !== null) {
      expect(config.url).not.toMatch(/\/$/);
      expect(() => assertSecureSponsorUrl(config.url)).not.toThrow();
    }
  });

  it('resolves that configuration only when `config` is absent, not when it is null', async () => {
    resetSponsorReadinessCache();
    // An explicit `null` means "disabled" and must not be re-resolved from the
    // environment — otherwise a caller could not switch sponsorship off.
    expect(await sponsorReadiness({ config: null })).toEqual({ state: 'disabled' });

    /* An ABSENT `config` is the opposite instruction: go and read the build's
       own environment. Which answer that produces is the build's business, so
       what is asserted is that the service was consulted exactly when a
       configuration was found, and not otherwise. */
    resetSponsorReadinessCache();
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
    const readiness = await sponsorReadiness({ fetch: fetchSpy as never });
    if (readiness.state === 'disabled') expect(fetchSpy).not.toHaveBeenCalled();
    else expect(fetchSpy).toHaveBeenCalledTimes(1);
    resetSponsorReadinessCache();
  });

  it('falls back to the ambient fetch when none is injected', async () => {
    resetSponsorReadinessCache();
    const ambient = vi.fn(async () =>
      new Response(
        JSON.stringify({
          total: 1,
          available: 1,
          wallets: [{ index: 0, ready: true, dust: { balance: '1', utxoCount: 1, isSynced: true } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', ambient);
    try {
      const readiness = await sponsorReadiness({ config: { url: 'https://sponsor.example' } });
      expect(readiness.state).toBe('ready');
      expect(ambient).toHaveBeenCalledTimes(1);

      // And the same for the POST path.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ txHash: 'aa', txBytes: 'bb' }), { status: 200 })),
      );
      await expect(
        sponsorBalanceOnly(Uint8Array.from([1]), {
          config: { url: 'https://sponsor.example' },
        }),
      ).resolves.toMatchObject({ txBytes: 'bb' });
    } finally {
      vi.unstubAllGlobals();
      resetSponsorReadinessCache();
    }
  });

  it('really waits between attempts when no sleep is injected', async () => {
    resetSponsorReadinessCache();
    /* The default sleep is a real timer, and it is the one production uses.
       Fake timers are what make asserting on it cheap; the point of the
       assertion is that the retry is scheduled at all. */
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const pending = sponsorReadiness({
        config: { url: 'https://sponsor.example' },
        fetch: fetchSpy as never,
      });
      await vi.advanceTimersByTimeAsync(SPONSOR_PROBE_RETRY_DELAY_MS + 1);
      const readiness = await pending;
      expect(readiness.state).toBe('unavailable');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      resetSponsorReadinessCache();
    }
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    resetSponsorReadinessCache();
    let release!: (response: Response) => void;
    const fetchSpy = vi.fn(
      () => new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const options = { config: { url: 'https://sponsor.example' }, fetch: fetchSpy as never };
    const first = sponsorReadiness(options);
    const second = sponsorReadiness(options);
    release(
      new Response(
        JSON.stringify({
          total: 1,
          available: 1,
          wallets: [{ index: 0, ready: true, dust: { balance: '9', utxoCount: 1, isSynced: true } }],
        }),
        { status: 200 },
      ),
    );
    expect(await first).toEqual(await second);
    // A send must not queue behind a second copy of a probe already running.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resetSponsorReadinessCache();
  });

  it('names a non-Error transport failure rather than printing [object Object]', async () => {
    resetSponsorReadinessCache();
    const fetchSpy = vi.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'the worker went away';
    });
    const readiness = await sponsorReadiness({
      config: { url: 'https://sponsor.example' },
      fetch: fetchSpy as never,
      sleep: async () => {},
    });
    expect(readiness).toMatchObject({
      state: 'unavailable',
      reason: 'wallet-status could not be fetched, twice: the worker went away',
    });
    resetSponsorReadinessCache();
  });
});

describe('sponsorCanPay', () => {
  it('is true only for a ready sponsor', async () => {
    resetSponsorReadinessCache();
    expect(await sponsorCanPay({ config: null })).toBe(false);

    resetSponsorReadinessCache();
    const ready = vi.fn(async () =>
      new Response(
        JSON.stringify({
          total: 1,
          available: 1,
          wallets: [{ index: 0, ready: true, dust: { balance: '9', utxoCount: 1, isSynced: true } }],
        }),
        { status: 200 },
      ),
    );
    expect(
      await sponsorCanPay({ config: { url: 'https://sponsor.example' }, fetch: ready as never }),
    ).toBe(true);

    resetSponsorReadinessCache();
    const empty = vi.fn(async () =>
      new Response(JSON.stringify(LIVE_PREVIEW_WALLET_STATUS), { status: 200 }),
    );
    expect(
      await sponsorCanPay({ config: { url: 'https://sponsor.example' }, fetch: empty as never }),
    ).toBe(false);
    resetSponsorReadinessCache();
  });
});

describe('parseSponsorWalletStatus, on bodies the gateway has really sent', () => {
  it('tolerates a missing or non-array wallets list', () => {
    expect(parseSponsorWalletStatus({ total: 0, available: 0 })).toEqual({
      total: 0,
      available: 0,
      wallets: [],
    });
    expect(parseSponsorWalletStatus({ total: 1, available: 1, wallets: 'one' })?.wallets).toEqual([]);
  });

  it('drops entries that are not objects and fills in the fields they omit', () => {
    const status = parseSponsorWalletStatus({
      total: 3,
      available: 1,
      wallets: [null, 'wallet', { ready: true }, { index: '0', dust: 'none' }],
    });
    expect(status?.wallets).toEqual([
      // No index, no dust: the defaults say so rather than inventing a wallet.
      { index: -1, ready: true, dust: { balance: '0', utxoCount: 0, isSynced: false } },
      { index: -1, ready: false, dust: { balance: '0', utxoCount: 0, isSynced: false } },
    ]);
    // `syncState` is present only when the service sent a string.
    expect(status?.wallets[0]).not.toHaveProperty('syncState');
  });

  it('refuses a body whose totals are not numbers', () => {
    expect(parseSponsorWalletStatus({ total: '1', available: 1 })).toBeNull();
    expect(parseSponsorWalletStatus({ total: 1, available: null })).toBeNull();
    expect(parseSponsorWalletStatus([])).toBeNull();
  });
});

describe('describeSponsorWalletStatus', () => {
  it('names each wallet’s dust, and says nothing extra when there are none', () => {
    expect(
      describeSponsorWalletStatus({
        total: 2,
        available: 0,
        wallets: [
          { index: 0, ready: true, dust: { balance: '0', utxoCount: 0, isSynced: true } },
          { index: 1, ready: false, dust: { balance: '12', utxoCount: 1, isSynced: false } },
        ],
      }),
    ).toBe('sponsor reports 0/2 wallets available (#0 dust 0, #1 dust 12)');
    expect(describeSponsorWalletStatus({ total: 0, available: 0, wallets: [] })).toBe(
      'sponsor reports 0/0 wallets available',
    );
  });
});

describe('SponsorError classification', () => {
  it('names the two causes a caller shows differently', () => {
    const syncing = createSponsorError(503, { error: 'WALLET_SYNCING' });
    expect(syncing.isWalletSyncing).toBe(true);
    expect(syncing.isInsufficientDust).toBe(false);

    const dry = createSponsorError(503, { error: 'INSUFFICIENT_DUST' });
    expect(dry.isInsufficientDust).toBe(true);
    expect(dry.isWalletSyncing).toBe(false);
    expect(dry.isRetryable).toBe(true);
    expect(createSponsorError(400, { error: 'BAD_REQUEST' }).isRetryable).toBe(false);
  });

  it('recognises a pending transaction named only in the assembled message', () => {
    /* `message` is `${code}: ${detail}`, so a service that puts the phrase in
       its CODE is still recognised — the detail alone would miss it. */
    const error = createSponsorError(429, { error: 'ALREADY PENDING', message: 'wait' });
    expect(error.detail).toBe('wait');
    expect(error.isPendingTransaction).toBe(true);
    // And a 503 carrying the same words is not a pending transaction.
    expect(createSponsorError(503, { error: 'PENDING_TRANSACTION' }).isPendingTransaction).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The refusal every fee gate gives                                           */
/* -------------------------------------------------------------------------- */

describe('sponsorFeeRefusal', () => {
  /* This one sentence is what `checkPassportContractFunds`,
     `checkAccountCustodyFees`, `feeReadiness()`, and `balanceTx` all say when
     the fee cannot be covered. It replaced four different sentences that each
     told the user their own wallet was short of DUST — a fee a Passport holder
     is never asked for, and a top-up no surface offers. */

  it('names the sponsor, and never a token the user would have to hold', () => {
    const sentences = [
      sponsorFeeRefusal({ state: 'disabled' }),
      sponsorFeeRefusal({ state: 'unavailable', reason: 'the wallet is still syncing' }),
      sponsorFeeRefusal({
        state: 'unavailable',
        reason: 'wallet-status could not be fetched, twice: fetch failed',
        cause: 'unreachable',
      }),
    ];
    for (const sentence of sentences) {
      expect(sentence).toContain('fee sponsor');
      // No token, and no second payer for the user to be nudged towards.
      expect(sentence).not.toMatch(/dust/i);
      expect(sentence).not.toMatch(/\bNIGHT\b/);
      expect(sentence).not.toMatch(/your wallet|this wallet/i);
    }
  });

  it('keeps the sponsor’s own reason OUT of the sentence, and says so plainly', () => {
    /* The join this replaced is what put "sponsor reports 0/1 wallets available
       (#0 dust 4993664979775282371)" on a user's screen — a wallet index and a
       DUST balance, from a wallet that is not theirs. The sentence is now the
       sentence; the diagnostic is a field beside it. */
    expect(
      sponsorFeeRefusal({
        state: 'unavailable',
        reason: 'sponsor reports 0/1 wallets available (#0 dust 4993664979775282371)',
        cause: 'busy',
      }),
    ).toBe(
      'Network fees on this Passport are covered by the fee sponsor, and the sponsor cannot ' +
        'cover this one right now.',
    );
  });

  it('says a sponsor that could not be reached was not reached', () => {
    /* Two different facts, and a user can act on the difference: one clears
       itself in a minute, the other may not. */
    expect(
      sponsorFeeRefusal({
        state: 'unavailable',
        reason: 'wallet-status returned HTTP 502',
        cause: 'unreachable',
      }),
    ).toBe(
      'Network fees on this Passport are covered by the fee sponsor, and the fee sponsor ' +
        'cannot be reached right now.',
    );
  });

  it('carries no figure at all, whatever the sponsor said', () => {
    /* The property that matters, asserted as a property: no digit from the
       sponsor's diagnostic survives into the sentence. */
    for (const reason of [
      'sponsor reports 0/1 wallets available (#0 dust 4993664979775282371)',
      'sponsor reports 0/2 wallets available (#0 dust 0, #1 dust 12)',
      'wallet-status returned HTTP 502',
    ]) {
      for (const cause of ['busy', 'unreachable'] as const) {
        expect(sponsorFeeRefusal({ state: 'unavailable', reason, cause })).not.toMatch(/\d/);
      }
    }
  });

  it('says the build has no sponsor when none is configured, rather than inventing a reason', () => {
    expect(sponsorFeeRefusal({ state: 'disabled' })).toBe(
      'Network fees on this Passport are covered by the fee sponsor, and this build has no ' +
        'sponsor configured, so nothing can be submitted.',
    );
  });

  it('asks for nothing the user could do, because there is nothing they could do', () => {
    /* The template itself must not send anyone looking for a balance they are
       not supposed to have. A sponsor-supplied reason is quoted verbatim and
       is the sponsor's own business; these are the words this module chooses. */
    for (const sentence of [
      sponsorFeeRefusal({ state: 'disabled' }),
      sponsorFeeRefusal({ state: 'unavailable', reason: 'wallet-status returned HTTP 502' }),
    ]) {
      expect(sentence).not.toMatch(/top up|faucet|fund your|your balance/i);
    }
  });

  it('takes a real non-ready readiness straight from `sponsorReadiness`', () => {
    /* The gates pass the readiness value through untouched, so the shape the
       probe returns has to be the shape this accepts — url and all. */
    const readiness = {
      state: 'unavailable',
      url: 'https://example.test',
      reason: 'no funds',
      cause: 'busy',
    } as const;
    expect(sponsorFeeRefusal(readiness)).toContain('fee sponsor');
    expect(sponsorFeeRefusal(readiness)).not.toContain('no funds');
  });
});

describe('sponsorRefusal', () => {
  /* The structured half. A surface reads `message` and branches on `cause`; the
     only thing that may ever read `detail` is a log. */

  it('separates the sentence from the diagnostic', () => {
    expect(
      sponsorRefusal({
        state: 'unavailable',
        reason: 'sponsor reports 0/1 wallets available (#0 dust 4993664979775282371)',
        cause: 'busy',
      }),
    ).toEqual({
      message:
        'Network fees on this Passport are covered by the fee sponsor, and the sponsor cannot ' +
          'cover this one right now.',
      cause: 'busy',
      detail: 'sponsor reports 0/1 wallets available (#0 dust 4993664979775282371)',
    });
  });

  it('has nothing to detail when there is no sponsor configured', () => {
    expect(sponsorRefusal({ state: 'disabled' })).toEqual({
      message:
        'Network fees on this Passport are covered by the fee sponsor, and this build has no ' +
          'sponsor configured, so nothing can be submitted.',
      cause: 'disabled',
      detail: null,
    });
  });

  it('treats a refusal that names no cause as busy, never as unreachable', () => {
    /* A caller that learned the sponsor had stood down some other way — a
       `/balance-only` that failed mid-flight — REACHED the service, so "cannot
       be reached" would be the wrong claim to put on the screen. */
    const refusal = sponsorRefusal({ state: 'unavailable', reason: 'balancing threw' });
    expect(refusal.cause).toBe('busy');
    expect(refusal.message).toContain('cannot cover this one right now');
    expect(refusal.detail).toBe('balancing threw');
  });
});

/* -------------------------------------------------------------------------- */
/* More than one sponsor                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The failover rules, in the vocabulary a fee gate branches on.
 *
 * The selection rule itself is drilled in `./endpoints.test.ts`. What is
 * asserted here is what this module does WITH it: which endpoint pays, what a
 * user is told when none of them will, and — the property the whole change
 * turns on — that a list of one is indistinguishable from the single URL
 * `VITE_SPONSOR_URL` used to hold.
 */
describe('sponsorConfigs', () => {
  const GATEWAY = 'https://api-stagenet.1am.xyz';
  const BALANCER = 'https://67-205-177-162.sslip.io/balancer';

  it('reads a comma-separated list in the order an operator wrote it', () => {
    expect(sponsorConfigs({ VITE_SPONSOR_URL: `${GATEWAY}, ${BALANCER}` })).toEqual([
      { url: GATEWAY },
      { url: BALANCER },
    ]);
  });

  it('reads one URL as a list of one, and refuses `off` by name', () => {
    expect(sponsorConfigs({ VITE_SPONSOR_URL: GATEWAY })).toEqual([{ url: GATEWAY }]);
    /* `off` used to answer with an empty list, which built a Passport whose one
       deploy could not be paid for and only said so at the first transaction.
       The refusal names the variable so the operator knows what to change. */
    expect(() => sponsorConfigs({ VITE_SPONSOR_URL: 'off' })).toThrow(/VITE_SPONSOR_URL/);
    expect(sponsorConfigs({ VITE_MIDNIGHT_NETWORK_ID: 'undeployed' })).toEqual([]);
  });

  it('shares the optional credentials across every endpoint in the list', () => {
    expect(
      sponsorConfigs({
        VITE_SPONSOR_URL: `${GATEWAY},${BALANCER}`,
        VITE_SPONSOR_API_KEY: 'key',
        VITE_SPONSOR_CLIENT_ID: 'client',
      }),
    ).toEqual([
      { url: GATEWAY, apiKey: 'key', clientId: 'client' },
      { url: BALANCER, apiKey: 'key', clientId: 'client' },
    ]);
  });

  it('refuses the whole list when any entry could leak a signed transaction', () => {
    /* Refused at configuration time rather than skipped at send time: an
       endpoint silently dropped from a failover list is a single point of
       failure nobody knows they have. */
    expect(() => sponsorConfigs({ VITE_SPONSOR_URL: `${GATEWAY},http://elsewhere` })).toThrow(
      /Insecure sponsor service URL/,
    );
  });

  it('names the first endpoint through the single-sponsor accessor', () => {
    expect(sponsorConfig({ VITE_SPONSOR_URL: `${GATEWAY},${BALANCER}` })).toEqual({
      url: GATEWAY,
    });
  });
});

describe('combineSponsorReadiness', () => {
  const busy = (url: string) =>
    ({ state: 'unavailable', url, reason: `${url} has no dust`, cause: 'busy' }) as const;
  const dead = (url: string) =>
    ({ state: 'unavailable', url, reason: `${url} timed out`, cause: 'unreachable' }) as const;
  const ready = (url: string) => ({ state: 'ready', url, available: 1 }) as const;

  it('is disabled when nothing is configured', () => {
    expect(combineSponsorReadiness([])).toEqual({ state: 'disabled' });
  });

  it('hands back a single endpoint’s answer verbatim, diagnostic and all', () => {
    /* The compatibility property, at the level a fee gate reads: a list of one
       must produce the identical `reason` string the single-URL build produced,
       because `feeReadinessPoll` logs it and an operator greps it. */
    expect(combineSponsorReadiness([busy('https://a')])).toEqual(busy('https://a'));
    expect(combineSponsorReadiness([ready('https://a')])).toEqual(ready('https://a'));
  });

  it('takes the first endpoint that can pay', () => {
    expect(combineSponsorReadiness([busy('https://a'), ready('https://b')])).toEqual(
      ready('https://b'),
    );
  });

  it('calls an all-refused list busy when any one of them answered', () => {
    /* `busy` is the transient cause and the one a surface waits out. At least
       one service answered and told us about its DUST, so "cannot be reached"
       would be contradicted by the evidence. */
    const combined = combineSponsorReadiness([dead('https://a'), busy('https://b')]);
    expect(combined).toEqual({
      state: 'unavailable',
      url: 'https://a',
      reason: 'https://a: https://a timed out; https://b: https://b has no dust',
      cause: 'busy',
    });
    // And the sentence a user reads is the one they read about a single sponsor.
    expect(sponsorFeeRefusal(combined as never)).toBe(
      'Network fees on this Passport are covered by the fee sponsor, and the sponsor cannot cover this one right now.',
    );
  });

  it('calls it unreachable only when nothing was learned from any of them', () => {
    const combined = combineSponsorReadiness([dead('https://a'), dead('https://b')]);
    expect(combined).toMatchObject({ state: 'unavailable', cause: 'unreachable' });
    expect(sponsorFeeRefusal(combined as never)).toBe(
      'Network fees on this Passport are covered by the fee sponsor, and the fee sponsor cannot be reached right now.',
    );
  });
});

describe('failover, end to end through the client', () => {
  const GATEWAY = 'https://gateway.example';
  const BALANCER = 'https://balancer.example';
  const configs = [{ url: GATEWAY }, { url: BALANCER }];
  const bytes = Uint8Array.from([9, 9]);

  const walletStatus = (available: number) =>
    new Response(
      JSON.stringify({
        total: 1,
        available,
        wallets: [{ index: 0, ready: true, syncState: 'ready', dust: { balance: '1', utxoCount: 1, isSynced: true } }],
      }),
      { status: 200 },
    );

  it('probes past a sponsor that cannot pay and names the one that can', async () => {
    resetSponsorReadinessCache();
    const asked: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      asked.push(url);
      return walletStatus(url.startsWith(GATEWAY) ? 0 : 1);
    });
    const readiness = await sponsorReadiness({ configs, fetch: fetchSpy as never });
    expect(readiness).toEqual({ state: 'ready', url: BALANCER, available: 1 });
    expect(asked).toEqual([`${GATEWAY}/wallet-status`, `${BALANCER}/wallet-status`]);
  });

  it('never contacts the second sponsor while the first can pay', async () => {
    resetSponsorReadinessCache();
    const fetchSpy = vi.fn(async () => walletStatus(1));
    const readiness = await sponsorReadiness({ configs, fetch: fetchSpy as never });
    expect(readiness).toEqual({ state: 'ready', url: GATEWAY, available: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caches the verdict per LIST, so reordering the list re-probes', async () => {
    resetSponsorReadinessCache();
    const fetchSpy = vi.fn(async () => walletStatus(1));
    await sponsorReadiness({ configs, fetch: fetchSpy as never });
    await sponsorReadiness({ configs, fetch: fetchSpy as never });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const reversed = await sponsorReadiness({
      configs: [{ url: BALANCER }, { url: GATEWAY }],
      fetch: fetchSpy as never,
    });
    expect(reversed).toEqual({ state: 'ready', url: BALANCER, available: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('balances at the second sponsor when the first refuses, and says which paid', async () => {
    const fetchSpy = vi.fn(async (url: string) =>
      url.startsWith(GATEWAY)
        ? new Response(JSON.stringify({ error: 'WALLETS_UNAVAILABLE' }), { status: 503 })
        : new Response(JSON.stringify({ txHash: 'ab', txBytes: 'cd' }), { status: 200 }),
    );
    const result = await sponsorBalanceOnly(bytes, { configs, fetch: fetchSpy as never });
    expect(result.servedBy).toBe(BALANCER);
    expect(result.txBytes).toBe('cd');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('falls through a sponsor whose POST never answered at all', async () => {
    const slept: number[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.startsWith(GATEWAY)) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ txHash: 'ab', txBytes: 'cd' }), { status: 200 });
    });
    const result = await sponsorBalanceOnly(bytes, {
      configs,
      fetch: fetchSpy as never,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(result.servedBy).toBe(BALANCER);
    /* The first endpoint still gets its own single retry before the list moves
       on — a throw means nothing reached us, so re-posting cannot balance the
       same transaction twice. */
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([SPONSOR_PROBE_RETRY_DELAY_MS]);
  });

  it('waits out a pending transaction only after every sponsor has refused', async () => {
    /* Falling through FIRST and waiting SECOND is the whole point: waiting ten
       minutes on a busy sponsor is right when it is the only one and wrong
       when another is idle. */
    let clock = 0;
    const slept: number[] = [];
    /* The gateway is mid-transaction for one round and free the next; the
       balancer never frees up. So round one refuses twice, and only THEN is
       there anything to wait for. */
    let gatewayCalls = 0;
    const pending = () =>
      new Response(JSON.stringify({ error: 'PENDING_TRANSACTION', retryAfterMs: 1_000 }), {
        status: 429,
      });
    const fetchSpy = vi.fn(async (url: string) => {
      if (!url.startsWith(GATEWAY)) return pending();
      gatewayCalls += 1;
      return gatewayCalls === 1
        ? pending()
        : new Response(JSON.stringify({ txHash: 'ab', txBytes: 'cd' }), { status: 200 });
    });
    const result = await sponsorBalanceOnly(bytes, {
      configs,
      fetch: fetchSpy as never,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    expect(result.servedBy).toBe(GATEWAY);
    // Round one: both refused. One wait. Round two: the first sponsor served.
    expect(slept).toEqual([1_000]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('refuses in the same words when every sponsor refuses, naming both only in the log half', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'WALLETS_UNAVAILABLE' }), { status: 503 }),
    );
    let failure = '';
    try {
      await sponsorBalanceOnly(bytes, { configs, fetch: fetchSpy as never });
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(failure).toContain(GATEWAY);
    expect(failure).toContain(BALANCER);
    /* What a user reads is unchanged: the endpoint names live in `detail`,
       which is a log line, and never in the sentence. */
    const refusal = sponsorRefusal({ state: 'unavailable', reason: failure });
    expect(refusal.message).toBe(
      'Network fees on this Passport are covered by the fee sponsor, and the sponsor cannot cover this one right now.',
    );
    expect(refusal.message).not.toContain(GATEWAY);
  });
});
