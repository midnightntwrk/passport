/**
 * Drills for the sponsored-registration client.
 *
 * This module is the one place where a `.night` name is asked for, and the
 * whole account model rests on what it does with the answer: the passkey
 * wallet originates exactly one transaction in its life — the account-custody
 * deploy — so a refusal here can only ever end with the name QUEUED. There is
 * no self-paid fall-back to authorise, and `selfPayWorthTrying` says only
 * whether a RETRY could honestly land.
 *
 * Two things are therefore drilled hardest:
 *
 *   1. every refusal is typed, and the ones that could DOUBLE-REGISTER
 *      (`name-taken`, `registration-in-flight`, `confirmation-failed`) are the
 *      ones marked not worth retrying; and
 *   2. a 200 is not believed on its own. The service's own answer has to name
 *      THIS Passport's account contract, and the client re-reads the registry
 *      itself before it will report the claim confirmed.
 *
 * The module is pure transport — no ledger, no SDK, no contract — so `fetch`
 * is the only seam that needs replacing, and `./midnames.js` is mocked purely
 * to keep the ledger WASM out of a test about HTTP. Nothing about the service's
 * behaviour is simulated: every body below is a shape
 * `examples/passport-balancer` really sends.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/identity`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AliasSponsorRefusal,
  aliasRefusalMessage,
  checkAliasSponsorship,
  invalidateSponsorshipProbe,
  sponsorAliasRegistration,
} from './sponsoredAlias.js';

/* `sponsorAliasRegistration` reaches for `./midnames.js` through a dynamic
   import to do its own registry read-back. The real module pulls the ledger-9
   WASM runtime in behind it, which has nothing to do with what is drilled
   here, so the read-back is the one collaborator that is replaced. */
const resolveAliasTarget = vi.fn();
vi.mock('./midnames.js', () => ({
  resolveAliasTarget: (...args: unknown[]) => resolveAliasTarget(...args),
}));

const FUNDER = 'https://67-205-177-162.sslip.io/balancer';
const ACCOUNT = '7c2f4a19e6d0b83c5194fe2a77bb0c61d8a3e94f20cb5d7e8f16a0b3c4d5e6f7';
const RESOLVER = '3d1c8b7a6f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4';
const OWNER_KEY = Uint8Array.from({ length: 32 }, (_unused, index) => index);

/** The body the balancer answers a successful `/register-alias` with. */
function registeredBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias: 'alice',
    domain: 'alice.night',
    network: 'stagenet',
    tldAddress: '29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116',
    resolverAddress: RESOLVER,
    resolverDeployTx: 'aa'.repeat(32),
    registerTx: 'bb'.repeat(32),
    target: { kind: 'contract', address: ACCOUNT },
    registeredAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Installs a `fetch` and hands back the spy, for assertions on the request. */
function installFetch(implementation: (url: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(implementation);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const request = {
  alias: 'alice',
  ownerKey: OWNER_KEY,
  contractAddress: ACCOUNT,
  network: 'stagenet' as const,
};

beforeEach(() => {
  invalidateSponsorshipProbe();
  resolveAliasTarget.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('checkAliasSponsorship', () => {
  it('is available only when /status names THIS network and says so', async () => {
    installFetch(async () => json({ network: 'stagenet', aliasSponsorship: 'available' }));
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(true);
  });

  it('reads a service pointed at another network as unavailable', async () => {
    /* The name then queues, which is the honest answer — a preview funder
       cannot register a stagenet name however healthy it reports itself. */
    installFetch(async () => json({ network: 'preview', aliasSponsorship: 'available' }));
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(false);
  });

  it('refuses every other shape of answer rather than hoping', async () => {
    const bodies: unknown[] = [
      { network: 'stagenet', aliasSponsorship: 'paused' },
      { network: 'stagenet' },
      { aliasSponsorship: 'available' },
      'available',
      null,
    ];
    for (const body of bodies) {
      invalidateSponsorshipProbe();
      installFetch(async () => json(body));
      expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(false);
    }
  });

  it('is false for a non-200, for unparseable JSON, and for a dead host', async () => {
    installFetch(async () => json({ error: 'down' }, 503));
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(false);

    invalidateSponsorshipProbe();
    installFetch(async () => new Response('<html>maintenance</html>', { status: 200 }));
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(false);

    invalidateSponsorshipProbe();
    installFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(false);
  });

  it('caches one answer per funder URL, and lets go of it after the TTL', async () => {
    vi.useFakeTimers();
    const spy = installFetch(async () =>
      json({ network: 'stagenet', aliasSponsorship: 'available' }),
    );
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(true);
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // A different funder is a different question.
    expect(await checkAliasSponsorship('https://other.example/balancer', 'stagenet')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);

    // PROBE_TTL_MS is 30 s; at 29 s the answer still stands.
    vi.setSystemTime(Date.now() + 29_000);
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 2_000);
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('drops one funder’s cached answer, or all of them', async () => {
    const spy = installFetch(async () =>
      json({ network: 'stagenet', aliasSponsorship: 'available' }),
    );
    await checkAliasSponsorship(FUNDER, 'stagenet');
    invalidateSponsorshipProbe(FUNDER);
    await checkAliasSponsorship(FUNDER, 'stagenet');
    expect(spy).toHaveBeenCalledTimes(2);
    invalidateSponsorshipProbe();
    await checkAliasSponsorship(FUNDER, 'stagenet');
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe('sponsorAliasRegistration — the request it sends', () => {
  it('names the alias, the owner key as hex, and the account contract', async () => {
    const spy = installFetch(async () => json(registeredBody()));
    resolveAliasTarget.mockResolvedValue({
      resolverAddress: RESOLVER,
      target: { kind: 'contract', hex: ACCOUNT },
    });

    const result = await sponsorAliasRegistration(FUNDER, request);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${FUNDER}/register-alias`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      alias: 'alice',
      ownerKey: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      contractAddress: ACCOUNT,
      network: 'stagenet',
    });
    /* Deliberately no payment address in the request. The leaf has an
       owner-address half a resolver may pay; filling it with the wallet's
       address would route value to the wallet, which the account model
       forbids. */
    expect(init.body as string).not.toContain('mn_addr');
    expect(result.targetUnshieldedAddress).toBe('');
    expect(result.resolverTarget).toBe('contract');
    expect(result.resolverTargetHex).toBe(ACCOUNT);
    expect(result.registryConfirmed).toBe(true);
  });
});

describe('sponsorAliasRegistration — a target that is submitted but not yet served', () => {
  const confirmed = (): void => {
    resolveAliasTarget.mockResolvedValue({
      resolverAddress: RESOLVER,
      target: { kind: 'contract', hex: ACCOUNT },
    });
  };

  it('sends `targetPending` only when the caller says the deploy is in flight', async () => {
    const spy = installFetch(async () => json(registeredBody()));
    confirmed();

    await sponsorAliasRegistration(FUNDER, { ...request, targetPending: true });
    const [, pending] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(pending.body as string)).toMatchObject({ targetPending: true });

    await sponsorAliasRegistration(FUNDER, request);
    const [, settled] = spy.mock.calls[1] as unknown as [string, RequestInit];
    /* Absent, not `false`: the request a settled target makes is byte-identical
       to the one this client has always sent. */
    expect(Object.keys(JSON.parse(settled.body as string))).not.toContain('targetPending');
  });

  it('waits for the account and asks once more when the service says target-missing', async () => {
    let posts = 0;
    installFetch(async () => {
      posts += 1;
      return posts === 1
        ? json({ error: 'target-missing', message: 'No contract state is served there.' }, 400)
        : json(registeredBody());
    });
    confirmed();
    const waited: string[] = [];

    const result = await sponsorAliasRegistration(
      FUNDER,
      { ...request, targetPending: true },
      {
        awaitTarget: async () => {
          waited.push('landed');
        },
      },
    );

    expect(posts).toBe(2);
    expect(waited).toEqual(['landed']);
    expect(result.alias).toBe('alice');
  });

  it('reports a SECOND target-missing as the refusal it is, and does not loop', async () => {
    let posts = 0;
    installFetch(async () => {
      posts += 1;
      return json({ error: 'target-missing', message: 'Still nothing there.' }, 400);
    });

    const refusal = await sponsorAliasRegistration(
      FUNDER,
      { ...request, targetPending: true },
      { awaitTarget: async () => undefined },
    ).catch((cause) => cause);

    expect(posts).toBe(2);
    expect(refusal).toBeInstanceOf(AliasSponsorRefusal);
    expect((refusal as AliasSponsorRefusal).code).toBe('target-missing');
    /* Passport's own sentence, not the service's: the reader is told the name
       was not registered and is kept, and "still nothing there" — which is
       about a contract they have never heard of — goes to the log half. */
    expect((refusal as AliasSponsorRefusal).message).toBe(
      'alice.night was not registered, and your name is kept for you.',
    );
    expect((refusal as AliasSponsorRefusal).serviceMessage).toBe('Still nothing there.');
  });

  it('lets the deploy’s own failure travel rather than blaming the name service', async () => {
    installFetch(async () =>
      json({ error: 'target-missing', message: 'No contract state is served there.' }, 400),
    );

    await expect(
      sponsorAliasRegistration(
        FUNDER,
        { ...request, targetPending: true },
        {
          awaitTarget: async () => {
            throw new Error('Your Passport account could not be set up.');
          },
        },
      ),
    ).rejects.toThrow('Your Passport account could not be set up.');
  });

  it('does not retry target-missing without a way to wait, or without the flag', async () => {
    let posts = 0;
    installFetch(async () => {
      posts += 1;
      return json({ error: 'target-missing', message: 'Nothing there.' }, 400);
    });

    // Declared pending, but the caller offered no way to wait.
    await sponsorAliasRegistration(FUNDER, { ...request, targetPending: true }).catch(
      (cause) => cause,
    );
    expect(posts).toBe(1);

    // A way to wait, but nothing was declared pending — so this is a real refusal.
    await sponsorAliasRegistration(FUNDER, request, {
      awaitTarget: async () => undefined,
    }).catch((cause) => cause);
    expect(posts).toBe(2);
  });

  it('retries nothing but target-missing', async () => {
    let posts = 0;
    installFetch(async () => {
      posts += 1;
      return json({ error: 'rate-limited', message: 'Try again later.' }, 429);
    });

    const refusal = await sponsorAliasRegistration(
      FUNDER,
      { ...request, targetPending: true },
      { awaitTarget: async () => undefined },
    ).catch((cause) => cause);

    expect(posts).toBe(1);
    expect((refusal as AliasSponsorRefusal).code).toBe('rate-limited');
  });

  it('treats an unparseable target-missing body as no retry', async () => {
    let posts = 0;
    installFetch(async () => {
      posts += 1;
      return new Response('not json', { status: 400 });
    });

    await sponsorAliasRegistration(
      FUNDER,
      { ...request, targetPending: true },
      { awaitTarget: async () => undefined },
    ).catch((cause) => cause);

    expect(posts).toBe(1);
  });
});

describe('sponsorAliasRegistration — refusals', () => {
  it('reports an unreachable service as retryable, and dates the probe', async () => {
    installFetch(async (url) => {
      if (url.endsWith('/status')) return json({ network: 'stagenet', aliasSponsorship: 'available' });
      throw new TypeError('fetch failed');
    });
    // Warm the probe cache so the invalidation is observable.
    expect(await checkAliasSponsorship(FUNDER, 'stagenet')).toBe(true);

    const refusal = await sponsorAliasRegistration(FUNDER, request).catch((cause) => cause);
    expect(refusal).toBeInstanceOf(AliasSponsorRefusal);
    expect(refusal.code).toBe('unreachable');
    expect(refusal.message).toContain('fetch failed');
    expect(refusal.selfPayWorthTrying).toBe(true);

    // The cached "available" is now demonstrably stale, so it is gone.
    const spy = installFetch(async () =>
      json({ network: 'stagenet', aliasSponsorship: 'available' }),
    );
    await checkAliasSponsorship(FUNDER, 'stagenet');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('names a non-Error transport failure rather than printing [object Object]', async () => {
    installFetch(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'the tab was closed mid-request';
    });
    const refusal = await sponsorAliasRegistration(FUNDER, request).catch((cause) => cause);
    expect(refusal.code).toBe('unreachable');
    expect(refusal.message).toContain('the tab was closed mid-request');
  });

  it('carries the service’s own code, and its sentence in the half a log reads', async () => {
    /* The code travels verbatim — callers branch on it. The SENTENCE does not:
       until 2026/09/02 it went straight to the screen, which is how "The .night
       registry rejected the registration of alice.night" came to be the thing a
       person was shown when the sponsor simply had no free DUST. */
    installFetch(async () =>
      json({ error: 'funder-empty', message: 'The sponsor holds no NIGHT.' }, 503),
    );
    const refusal = await sponsorAliasRegistration(FUNDER, request).catch((cause) => cause);
    expect(refusal.code).toBe('funder-empty');
    expect(refusal.message).toBe(
      'The sponsor is busy — your name is queued and will register on its own.',
    );
    expect(refusal.serviceMessage).toBe('The sponsor holds no NIGHT.');
    expect(refusal.name).toBe('AliasSponsorRefusal');
    expect(refusal.selfPayWorthTrying).toBe(true);
  });

  it('turns the live 502 into the sponsor’s own sentence, and shows none of its words', async () => {
    /* The body the deployed balancer actually answered with on 2026/09/02,
       five times out of five, ~60 s after the first claim of a pair: the
       registration was refused because the sponsor's single fee-capable DUST
       coin was booked by the user's own account deploy. Everything the service
       said about it is read — the diagnostic to classify, the delay to confirm
       — and none of it reaches the sentence. */
    installFetch(async () =>
      json(
        {
          error: 'register-rejected',
          message: 'The .night registry rejected the registration of alice.night.',
          detail: "DustUnavailable: no DUST coin was free to pay this transaction's fee",
          retryAfterMs: 5_000,
        },
        502,
      ),
    );
    const refusal = await sponsorAliasRegistration(FUNDER, request).catch((cause) => cause);
    expect(refusal.message).toBe(
      'The sponsor is busy — your name is queued and will register on its own.',
    );
    expect(refusal.message).not.toMatch(/registry|DUST/i);
    // The name is kept and offered the Register-now control, not abandoned.
    expect(refusal.selfPayWorthTrying).toBe(true);
    // And an operator still has every word the service said.
    expect(refusal.serviceMessage).toBe(
      'The .night registry rejected the registration of alice.night.',
    );
  });

  it('marks the three double-registration codes as not worth retrying', async () => {
    for (const error of ['name-taken', 'registration-in-flight', 'confirmation-failed']) {
      installFetch(async () => json({ error, message: `refused: ${error}` }, 409));
      const refusal = await sponsorAliasRegistration(FUNDER, request).catch((cause) => cause);
      expect(refusal.code).toBe(error);
      // A second attempt could double-register, or would fail identically.
      expect(refusal.selfPayWorthTrying).toBe(false);
    }
  });

  it('falls back to `unreachable` and the status when the body says nothing', async () => {
    installFetch(async () => new Response('gateway timeout', { status: 504 }));
    const refusal = await sponsorAliasRegistration(FUNDER, request).catch((cause) => cause);
    expect(refusal.code).toBe('unreachable');
    expect(refusal.message).toBe(
      'alice.night was not registered, and your name is kept for you.',
    );
    expect(refusal.serviceMessage).toBe('The sponsorship service refused with status 504.');
    expect(refusal.selfPayWorthTrying).toBe(true);
  });

  it('ignores non-string `error` and `message` fields', async () => {
    installFetch(async () => json({ error: 7, message: { text: 'no' } }, 400));
    const refusal = await sponsorAliasRegistration(FUNDER, request).catch((cause) => cause);
    expect(refusal.code).toBe('unreachable');
    expect(refusal.message).toBe(
      'alice.night was not registered, and your name is kept for you.',
    );
    expect(refusal.serviceMessage).toBe('The sponsorship service refused with status 400.');
  });

  it('drops the cached probe for every refusal that dates it', async () => {
    /* `rate-limited` is in this list although it no longer shares the busy
       SENTENCE: a ceiling refusal dates the probe harder than any of the
       others, because the sponsor is up and will go on refusing for the rest
       of the hour. The two questions are separate sets in the module for
       exactly this reason. */
    for (const error of [
      'funder-empty',
      'funder-no-dust',
      'rate-limited',
      'PENDING_TRANSACTION',
      'wallet-syncing',
    ]) {
      const spy = installFetch(async (url) =>
        url.endsWith('/status')
          ? json({ network: 'stagenet', aliasSponsorship: 'available' })
          : json({ error, message: error }, 503),
      );
      invalidateSponsorshipProbe();
      await checkAliasSponsorship(FUNDER, 'stagenet');
      await sponsorAliasRegistration(FUNDER, request).catch(() => undefined);
      await checkAliasSponsorship(FUNDER, 'stagenet');
      // Two probes, either side of a registration that proved the first stale.
      expect(spy.mock.calls.filter(([url]) => url.endsWith('/status'))).toHaveLength(2);
    }
  });

  it('leaves the probe alone for a refusal that does not date it', async () => {
    const spy = installFetch(async (url) =>
      url.endsWith('/status')
        ? json({ network: 'stagenet', aliasSponsorship: 'available' })
        : json({ error: 'name-taken', message: 'taken' }, 409),
    );
    await checkAliasSponsorship(FUNDER, 'stagenet');
    await sponsorAliasRegistration(FUNDER, request).catch(() => undefined);
    await checkAliasSponsorship(FUNDER, 'stagenet');
    expect(spy.mock.calls.filter(([url]) => url.endsWith('/status'))).toHaveLength(1);
  });
});

describe('sponsorAliasRegistration — a 200 that is not believed', () => {
  const cases: { why: string; body: Record<string, unknown> }[] = [
    { why: 'no resolver address', body: registeredBody({ resolverAddress: 7 }) },
    { why: 'no register transaction', body: registeredBody({ registerTx: undefined }) },
    {
      why: 'a target that is not a contract',
      body: registeredBody({ target: { kind: 'wallet', address: ACCOUNT } }),
    },
    {
      why: 'a target that is some other contract',
      body: registeredBody({ target: { kind: 'contract', address: 'ff'.repeat(32) } }),
    },
    { why: 'no target at all', body: registeredBody({ target: undefined }) },
  ];

  for (const { why, body } of cases) {
    it(`refuses a success body with ${why} — and does not retry it`, async () => {
      installFetch(async () => json(body));
      const refusal = await sponsorAliasRegistration(FUNDER, request).catch((cause) => cause);
      expect(refusal).toBeInstanceOf(AliasSponsorRefusal);
      expect(refusal.code).toBe('confirmation-failed');
      expect(refusal.message).toContain('did not name this Passport');
      /* Something DID land, so a second attempt on top of it could
         double-register. That is why this one is not worth retrying. */
      expect(refusal.selfPayWorthTrying).toBe(false);
      expect(resolveAliasTarget).not.toHaveBeenCalled();
    });
  }

  it('refuses a 200 whose body is not JSON at all', async () => {
    installFetch(async () => new Response('OK', { status: 200 }));
    const refusal = await sponsorAliasRegistration(FUNDER, request).catch((cause) => cause);
    expect(refusal.code).toBe('confirmation-failed');
  });
});

describe('sponsorAliasRegistration — the independent read-back', () => {
  async function registerWithReadBack(): Promise<{ registryConfirmed: boolean; reads: number }> {
    vi.useFakeTimers();
    installFetch(async () => json(registeredBody()));
    const pending = sponsorAliasRegistration(FUNDER, request);
    /* The client waits 3 s between its two attempts, so a miss on the first
       has to be run forward rather than waited out. */
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await pending;
    return { registryConfirmed: result.registryConfirmed, reads: resolveAliasTarget.mock.calls.length };
  }

  it('confirms on the first read, and does not read twice', async () => {
    resolveAliasTarget.mockResolvedValue({
      resolverAddress: RESOLVER,
      target: { kind: 'contract', hex: ACCOUNT },
    });
    const { registryConfirmed, reads } = await registerWithReadBack();
    expect(registryConfirmed).toBe(true);
    expect(reads).toBe(1);
    expect(resolveAliasTarget).toHaveBeenCalledWith('stagenet', 'alice');
  });

  it('confirms on the second read after indexer lag', async () => {
    resolveAliasTarget
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        resolverAddress: RESOLVER,
        target: { kind: 'contract', hex: ACCOUNT },
      });
    const { registryConfirmed, reads } = await registerWithReadBack();
    expect(registryConfirmed).toBe(true);
    expect(reads).toBe(2);
  });

  it('downgrades to “awaiting the registry” rather than failing the claim', async () => {
    /* Every way the read-back can come back wrong. None of them fails the
       claim: both transaction ids are real, and the UI has copy for a name
       whose registry read has not caught up. */
    const misses: unknown[] = [
      null,
      { resolverAddress: 'ff'.repeat(32), target: { kind: 'contract', hex: ACCOUNT } },
      { resolverAddress: RESOLVER, target: { kind: 'wallet', hex: ACCOUNT } },
      { resolverAddress: RESOLVER, target: { kind: 'contract', hex: 'ff'.repeat(32) } },
    ];
    for (const miss of misses) {
      resolveAliasTarget.mockReset();
      resolveAliasTarget.mockResolvedValue(miss);
      const { registryConfirmed, reads } = await registerWithReadBack();
      expect(registryConfirmed).toBe(false);
      expect(reads).toBe(2);
    }
  });

  it('downgrades when the read-back throws, and still returns the claim', async () => {
    vi.useFakeTimers();
    installFetch(async () => json(registeredBody()));
    resolveAliasTarget.mockRejectedValue(new Error('indexer unreachable'));
    const pending = sponsorAliasRegistration(FUNDER, request);
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await pending;
    expect(result).toMatchObject({
      alias: 'alice',
      domain: 'alice.night',
      network: 'stagenet',
      resolverAddress: RESOLVER,
      resolverDeployTxId: 'aa'.repeat(32),
      registerTxId: 'bb'.repeat(32),
      claimedAt: '2026-08-25T10:00:00.000Z',
      registryConfirmed: false,
    });
  });
});

describe('aliasRefusalMessage', () => {
  const BUSY = 'The sponsor is busy — your name is queued and will register on its own.';
  const RATE_LIMITED =
    'Passport is registering a lot of names right now. Yours is kept for you — try again in a few minutes.';
  const KEPT = 'alice.night was not registered, and your name is kept for you.';
  const base = { code: 'register-rejected', domain: 'alice.night', detail: null, retryAfterMs: null };

  it('calls the measured fault what it is: the sponsor, busy, and the name kept', () => {
    /* THE ONE THIS EXISTS FOR. On 2026/09/02 the first claim of a demo pair
       failed five times out of five and the screen said "The .night registry
       rejected the registration of alice.night". The registry had rejected
       nothing: the sponsor held one fee-capable DUST coin, the user's own
       account deploy had booked it, and the registration was refused before it
       was ever asked for. The service's own diagnostic said so — this is that
       diagnostic, verbatim from the journal — and the reader is now told the
       true thing instead. */
    expect(
      aliasRefusalMessage({
        ...base,
        detail: "DustUnavailable: no DUST coin was free to pay this transaction's fee",
      }),
    ).toBe(BUSY);
  });

  it('reads a retry delay as the sponsor asking for time, whatever the code says', () => {
    expect(aliasRefusalMessage({ ...base, retryAfterMs: 5_000 })).toBe(BUSY);
    // Including zero, which is a delay the service named rather than none.
    expect(aliasRefusalMessage({ ...base, retryAfterMs: 0 })).toBe(BUSY);
  });

  it('says the same of every code that means “cannot pay right now”', () => {
    for (const code of [
      'funder-empty',
      'funder-no-dust',
      'PENDING_TRANSACTION',
      'WALLET_SYNCING',
      'wallet-syncing',
    ]) {
      expect(aliasRefusalMessage({ ...base, code })).toBe(BUSY);
    }
  });

  it('does NOT call a ceiling refusal a busy sponsor', () => {
    /* THE COPY DEFECT OF 2026/09/04. Two signups in the sponsor soak were
       refused at the hourly ceiling and both readers were told the sponsor was
       busy and their name would register on its own. The sponsor was answering
       `/status` in 60 ms with four spend lanes open and refused in 25 ms
       without attempting anything; the name was queued in the reader's own
       browser and nowhere else; and nothing was ever going to register it. A
       reader who believes that sentence waits for something that cannot
       happen. */
    const limited = aliasRefusalMessage({ ...base, code: 'rate-limited' });
    expect(limited).toBe(RATE_LIMITED);
    expect(limited).not.toBe(BUSY);
    expect(limited).not.toMatch(/busy/i);
    expect(limited).not.toMatch(/on its own/i);
  });

  it('keeps that sentence when the refusal names a delay, which the per-caller half does', () => {
    /* The ceiling refusal carries no `retryAfterMs`; the per-client token
       bucket's carries one. Both are `rate-limited`, both mean too many names
       too recently, and the `retryAfterMs` branch below would otherwise
       recapture the second one into the busy sentence. */
    expect(aliasRefusalMessage({ ...base, code: 'rate-limited', retryAfterMs: 7_000 })).toBe(
      RATE_LIMITED,
    );
    expect(
      aliasRefusalMessage({
        ...base,
        code: 'rate-limited',
        detail: 'DustUnavailable: no DUST coin was free',
      }),
    ).toBe(RATE_LIMITED);
  });

  it('tells the reader the name is kept, and what to do about it', () => {
    /* The two things the busy sentence got wrong. The promise that survives is
       the one that is true — the record is queued locally, see
       `claimOrQueueAlias` — and the action replaces the promise that was not.
       The controls beside it are unchanged: Try again, and Continue to Home,
       which `lib/claimFailure.ts` decides from the failure rather than from
       its wording. */
    expect(RATE_LIMITED).toMatch(/kept for you/i);
    expect(RATE_LIMITED).toMatch(/try again/i);
  });

  it('keeps a taken name as its own plain sentence, and promises no queue', () => {
    /* The one refusal that is genuinely about what the reader typed. It must
       not be folded into the busy sentence: a name somebody else holds will
       never register on its own, however long the queue runs. */
    const taken = aliasRefusalMessage({ ...base, code: 'name-taken' });
    expect(taken).toBe('alice.night has already been taken — choose another name.');
    expect(taken).not.toMatch(/queue/i);
    /* And it does NOT say the name is kept, which is why the claim card cannot
       carry a fixed note promising that it is: this is the one refusal where
       the promise would be false. */
    expect(taken).not.toMatch(/kept/i);
  });

  it('says the honest non-answer when it cannot tell which party failed', () => {
    expect(aliasRefusalMessage(base)).toBe(KEPT);
    expect(aliasRefusalMessage({ ...base, code: 'confirmation-failed' })).toBe(KEPT);
    expect(aliasRefusalMessage({ ...base, detail: 'the leaf could not be deployed' })).toBe(KEPT);
  });

  it('never says “registry”, and never any of the other machinery words', () => {
    /* The house rule, held over EVERY sentence this function can produce
       rather than over the ones a test happened to name. A Passport holder is
       shown nothing about a registry, a resolver, an indexer, a contract, a
       wallet, or DUST — they hold none of it and can act on none of it. */
    const every = [
      aliasRefusalMessage(base),
      aliasRefusalMessage({ ...base, code: 'name-taken' }),
      aliasRefusalMessage({ ...base, code: 'funder-no-dust' }),
      aliasRefusalMessage({ ...base, code: 'rate-limited' }),
      aliasRefusalMessage({ ...base, retryAfterMs: 1 }),
      aliasRefusalMessage({ ...base, detail: 'DustUnavailable' }),
    ];
    for (const sentence of every) {
      expect(sentence).not.toMatch(/registry|resolver|indexer|contract|wallet|DUST|ledger|tx\b/i);
      /* And no rate, no limit, no ceiling, and no quota. The sponsor's own 429
         says "the balancer has reached its ceiling of 20 sponsored
         registrations per hour", which is an operator's sentence in every
         word. */
      expect(sentence).not.toMatch(/rate.?limit|ceiling|quota|429|balancer|sponsor\w*ed\b/i);
    }
  });

  it('says it in ONE sentence, whichever branch answers', () => {
    /* THE COPY DEFECT OF 2026/09/03. This sentence is the whole body of the
       claim screen's failure card, and the card read: an unpunctuated heading,
       a two-sentence refusal from here, a second "the name is kept for you to
       register again shortly" appended by `App.tsx`, and a note beneath the
       buttons describing the buttons. Three sentences for one fact.

       Held as a shape rather than as four string comparisons: exactly one
       terminal stop, at the end, and the fact said once. An em dash or a comma
       is how a second clause joins — a full stop is how a second sentence
       starts, and there is not one. */
    const every = [
      aliasRefusalMessage(base),
      aliasRefusalMessage({ ...base, code: 'name-taken' }),
      aliasRefusalMessage({ ...base, code: 'funder-no-dust' }),
      aliasRefusalMessage({ ...base, retryAfterMs: 1 }),
      aliasRefusalMessage({ ...base, detail: 'DustUnavailable' }),
    ];
    for (const sentence of every) {
      expect(sentence, sentence).toMatch(/\.$/);
      /* One stop only. `alice.night` carries stops of its own, so the count is
         of SENTENCE ends — a stop followed by a space or the end of the line. */
      expect(sentence.match(/\.(?=\s|$)/g) ?? [], sentence).toHaveLength(1);
      expect(sentence.match(/\bkept\b/gi) ?? [], sentence).not.toHaveLength(2);
    }
  });

  it('spends its second sentence, once, on the one refusal that needs an action', () => {
    /* THE ONE CARVE-OUT from the rule above, held here rather than left as a
       gap in the list. The 2026/09/03 ruling was against three sentences
       saying the SAME fact; this is two sentences saying two — why the name is
       not registered, and what to do — and the second exists because the
       branch it replaced promised something would happen on its own and
       nothing would. The rest of the rule still binds it: the fact is said
       once, and there is no third sentence describing the buttons. */
    const limited = aliasRefusalMessage({ ...base, code: 'rate-limited' });
    expect(limited).toMatch(/\.$/);
    expect(limited.match(/\.(?=\s|$)/g) ?? []).toHaveLength(2);
    expect(limited.match(/\bkept\b/gi) ?? []).toHaveLength(1);
  });
});
