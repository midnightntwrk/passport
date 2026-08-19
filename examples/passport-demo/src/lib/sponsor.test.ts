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
  createSponsorError,
  normaliseSponsorHex,
  parseSponsorWalletStatus,
  resetSponsorReadinessCache,
  sponsorBalanceOnly,
  sponsorConfig,
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
    expect(sponsorConfig({})).toEqual({ url: 'https://api-preview.1am.xyz' });
    expect(sponsorConfig({ VITE_SPONSOR_URL: '   ' })).toEqual({
      url: 'https://api-preview.1am.xyz',
    });
    expect(sponsorConfig({ VITE_MIDNIGHT_NETWORK_ID: 'preprod' })).toEqual({
      url: 'https://api-preprod.1am.xyz',
    });
  });

  it('is disabled by the literal `off`, and on a network with no gateway', () => {
    expect(sponsorConfig({ VITE_SPONSOR_URL: 'off' })).toBeNull();
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
    expect(result).toEqual({ txHash: 'aa', txBytes: 'bbcc', expiresAt: 'later' });
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
