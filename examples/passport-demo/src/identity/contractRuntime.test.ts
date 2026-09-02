/**
 * The hex guard `contractRuntime` and the step verifier both depend on.
 *
 * There are two copies of `hexToBytes` — this module's and the step
 * verifier's in `src/verify/indexer.ts` — and they are deliberately NOT
 * merged: `verify/` stays free of the identity graph, so a reviewer can run
 * the verifier without pulling the wallet in behind it. They are otherwise
 * identical, so both are held to the same guard here and a change to one is a
 * change to both.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitSponsorReadiness,
  balancingFailure,
  hexToBytes,
  walletProviderFor,
  BalancingFailure,
} from './contractRuntime.js';
import { hexToBytes as verifierHexToBytes } from '../verify/indexer.js';
import type { LocalMidnightWallet } from '../lib/localWallet.js';
import { createSponsorError, resetSponsorReadinessCache } from '../lib/sponsor.js';
import type { SponsorReadiness } from '../lib/sponsor.js';

describe.each([
  ['identity/contractRuntime', hexToBytes],
  ['verify/indexer', verifierHexToBytes],
])('hexToBytes (%s)', (_name, hexToBytes) => {
  it('reads a hex string, with or without the 0x prefix', () => {
    expect(Array.from(hexToBytes('00ff10'))).toEqual([0, 255, 16]);
    expect(Array.from(hexToBytes('0x00ff10'))).toEqual([0, 255, 16]);
    expect(Array.from(hexToBytes('00FF10'))).toEqual([0, 255, 16]);
    expect(Array.from(hexToBytes(''))).toEqual([]);
  });

  it('refuses anything that is not hex, naming the input', () => {
    /* `parseInt` reads `zz` as NaN — stored as byte 0 — and `1g` as 1, so a
       corrupt identifier used to pass as bytes and be used as one. */
    expect(() => hexToBytes('zz')).toThrow(/zz/);
    expect(() => hexToBytes('0x1g')).toThrow(/0x1g/);
    expect(() => hexToBytes('00 ff')).toThrow();
    expect(() => hexToBytes('abc')).toThrow(/Odd-length/);
  });
});

/* -------------------------------------------------------------------------- */
/* Balancing failures, by the step that failed                                */
/* -------------------------------------------------------------------------- */

/**
 * The half of `walletProviderFor` that has no network in it: which step failed,
 * whether it is worth trying again, and what the user is told.
 *
 * Until 2026/09/02 all seven steps threw the same sentence — "the sponsor
 * cannot cover this one right now" — from one `catch` that logged nothing. That
 * is how a blocked CORS preflight on the wallet's own proof server was read,
 * for weeks, as a fee-sponsorship outage. Everything below is a step that CAN
 * fail without the sponsor having been asked at all.
 */

/** A sponsor that answers `GET /wallet-status` with a wallet that can pay. */
const READY_WALLET_STATUS = {
  total: 1,
  available: 1,
  wallets: [
    {
      index: 0,
      ready: true,
      syncState: 'ready',
      address: 'mn_addr_test1qqqq',
      dust: { balance: '288384879317778538', utxoCount: 3, isSynced: true },
    },
  ],
  version: '0.2.0',
};

/**
 * A wallet whose facade fails at exactly one step. Every earlier step answers
 * with a placeholder recipe, so the step under test is the only thing that can
 * throw.
 */
function walletThatFailsAt(
  step: 'balance' | 'sign' | 'prove',
  cause: unknown,
): LocalMidnightWallet {
  const fail = async (): Promise<never> => {
    throw cause;
  };
  return {
    facade: {
      balanceUnboundTransaction: step === 'balance' ? fail : async () => ({ recipe: true }),
      signRecipe: step === 'sign' ? fail : async () => ({ signed: true }),
      finalizeRecipe:
        step === 'prove' ? fail : async () => ({ serialize: () => Uint8Array.from([1, 2]) }),
      submitTransaction: async () => ({}),
      revert: async () => ({}),
    },
    keys: {
      shieldedSecretKeys: { coinPublicKey: '00', encryptionPublicKey: '00' },
      unshieldedKeystore: { signDataAsync: async () => ({}) },
    },
  } as unknown as LocalMidnightWallet;
}

/** Answers the readiness probe `ready`, and `POST /balance-only` with `body`. */
function stubSponsor(balanceOnly: () => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/wallet-status')) {
        return new Response(JSON.stringify(READY_WALLET_STATUS), { status: 200 });
      }
      return balanceOnly();
    }),
  );
}

describe('balanceTx, by the step that failed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSponsorReadinessCache();
  });

  it('reports the SDK running out of coins as `balance`, and does not retry it', async () => {
    resetSponsorReadinessCache();
    stubSponsor(() => new Response('{}', { status: 200 }));
    const wallet = walletThatFailsAt('balance', new Error('Insufficient funds'));
    const failure = await walletProviderFor(wallet)
      .balanceTx({})
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(BalancingFailure);
    expect((failure as BalancingFailure).name).toBe('BalancingFailure');
    expect((failure as BalancingFailure).stage).toBe('balance');
    /* A wallet that does not hold the coins will not hold them a second time,
       and a retry loop over this is a sheet that hangs before saying so. */
    expect((failure as BalancingFailure).retryable).toBe(false);
    expect((failure as BalancingFailure).cause).toBeInstanceOf(Error);
  });

  it('reports a proof the wallet could not compute as `prove`, without naming a host', async () => {
    resetSponsorReadinessCache();
    stubSponsor(() => new Response('{}', { status: 200 }));
    /* The live failure, in the shape the browser produced it: the wallet's own
       Zswap spend proof POSTed to an address whose CORS preflight was blocked,
       which surfaces as a rejected `fetch`. It was reported as a sponsor
       refusal, and the sponsor had not been asked yet. */
    const wallet = walletThatFailsAt('prove', new TypeError('Failed to fetch'));
    const failure = (await walletProviderFor(wallet)
      .balanceTx({})
      .catch((cause: unknown) => cause)) as BalancingFailure;
    expect(failure.stage).toBe('prove');
    expect(failure.retryable).toBe(true);
    expect(failure.userMessage).toContain('could not prove this step');
    // Constraint (b): no host, no wallet, no DUST, no gateway in what is read.
    expect(failure.userMessage).not.toMatch(/sslip|1am|prover|http/i);
    expect((failure.cause as Error).message).toBe('Failed to fetch');
  });

  it('reports what the sponsor itself refused as `sponsor`', async () => {
    resetSponsorReadinessCache();
    /* A 400 rather than a 503 so the round is not repeated: the ten-minute
       contract retry window is right in production and would be the whole test
       here. Which sponsor refusals are worth repeating is drilled below and,
       exhaustively, in `../lib/sponsor.test.ts`. */
    stubSponsor(
      () => new Response(JSON.stringify({ error: 'INVALID_TRANSACTION' }), { status: 400 }),
    );
    const wallet = walletThatFailsAt('none' as never, null);
    const failure = (await walletProviderFor(wallet)
      .balanceTx({})
      .catch((cause: unknown) => cause)) as BalancingFailure;
    expect(failure.stage).toBe('sponsor');
    expect(failure.retryable).toBe(false);
    expect(failure.userMessage).toContain('cannot cover this one right now');
  });

  it('classifies each sponsor refusal by whether the sponsor clears it', () => {
    const transient = balancingFailure(
      'sponsor',
      createSponsorError(503, { error: 'INSUFFICIENT_DUST' }),
    );
    expect(transient.stage).toBe('sponsor');
    expect(transient.retryable).toBe(true);
    expect(transient.userMessage).toContain('cannot cover this one right now');

    // A transaction the service will refuse identically forever is not retried.
    expect(
      balancingFailure('sponsor', createSponsorError(400, { error: 'INVALID_TRANSACTION' }))
        .retryable,
    ).toBe(false);

    /* Nothing reached the service at all — a transport failure or the
       "no fee sponsor would balance this" summary of a list that all refused —
       is a condition that clears. */
    expect(balancingFailure('sponsor', new TypeError('Failed to fetch')).retryable).toBe(true);

    // And the steps that are structural, whatever produced them.
    expect(balancingFailure('sign', new Error('no')).retryable).toBe(false);
    expect(balancingFailure('deserialise', new Error('no')).retryable).toBe(false);
    // A stamp that expired while we waited is worth building again.
    expect(balancingFailure('expired', new Error('expired')).retryable).toBe(true);
  });
});

describe('awaitSponsorReadiness', () => {
  const busy = (): SponsorReadiness => ({
    state: 'unavailable',
    url: 'https://sponsor.example',
    reason: 'no wallet has dust free',
    cause: 'busy',
  });
  const ready = (): SponsorReadiness => ({
    state: 'ready',
    url: 'https://sponsor.example',
    available: 1,
  });

  it('waits a busy sponsor out and returns to balancing when it frees up', async () => {
    /* `busy` is DUST reserved against work in flight, not an outage. Our own
       balancer is busy for 20-60 s after each spend and makes five during an
       activation, so a gate that refused on the first `busy` refused for a
       sponsor that was working. */
    const verdicts: SponsorReadiness[] = [busy(), busy(), busy(), ready()];
    const forced: boolean[] = [];
    let clock = 0;
    const readiness = await awaitSponsorReadiness({
      probe: async (force) => {
        forced.push(force);
        return verdicts.shift() ?? ready();
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(readiness.state).toBe('ready');
    // First probe reads the cache; every re-probe bypasses it, or the wait
    // would end up to thirty seconds after the sponsor was free.
    expect(forced).toEqual([false, true, true, true]);
  });

  it('gives up on a busy sponsor at the window, having probed it repeatedly', async () => {
    let probes = 0;
    let clock = 0;
    const failure = (await awaitSponsorReadiness({
      probe: async () => {
        probes += 1;
        return busy();
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      windowMs: 10_000,
    }).catch((cause: unknown) => cause)) as BalancingFailure;
    expect(failure).toBeInstanceOf(BalancingFailure);
    expect(failure.stage).toBe('readiness');
    expect(failure.retryable).toBe(true);
    // 10 s of window at a 2 s interval: five re-probes after the first.
    expect(probes).toBe(6);
  });

  it('gives an unreachable sponsor exactly one more chance', async () => {
    /* Nothing has been learned about DUST, so one retry covers the fast
       unparseable `200` that motivated retrying at all — and no more, because
       holding a send open for ninety seconds against a host that is down buys
       the user nothing. */
    let probes = 0;
    const readiness = await awaitSponsorReadiness({
      probe: async () => {
        probes += 1;
        return probes === 1
          ? { state: 'unavailable', url: 'https://sponsor.example', reason: 'fetch failed', cause: 'unreachable' }
          : ready();
      },
      sleep: async () => {},
      now: () => 0,
    });
    expect(readiness.state).toBe('ready');
    expect(probes).toBe(2);
  });

  it('refuses immediately, and permanently, when sponsorship is not configured', async () => {
    const failure = (await awaitSponsorReadiness({
      probe: async () => ({ state: 'disabled' }),
      sleep: async () => {},
      now: () => 0,
    }).catch((cause: unknown) => cause)) as BalancingFailure;
    expect(failure.stage).toBe('readiness');
    // No amount of waiting configures a build.
    expect(failure.retryable).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* submitTx: handing a rejected transaction's fee straight back               */
/* -------------------------------------------------------------------------- */

/**
 * A node rejection is the one failure that makes the sponsor's booked DUST
 * certainly dead, and on 2026/09/02 nobody told the sponsor so: the coin stayed
 * spoken-for until a sweeper found it two minutes later, and every registration
 * and grant behind it waited out those two minutes. `submitTx` now says so on
 * the spot — as a courtesy fired beside the failure, never in front of it.
 */
describe('submitTx, after the node refuses a sponsored transaction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSponsorReadinessCache();
  });

  /**
   * A wallet whose balancing gets all the way past the sponsor and then dies on
   * the sponsor's bytes, which is the cheapest way to reach `submitTx` with a
   * sponsor's booking remembered: the booking is recorded before deserialising.
   */
  function walletThatSubmitFails(cause: unknown): LocalMidnightWallet {
    return {
      facade: {
        balanceUnboundTransaction: async () => ({ recipe: true }),
        signRecipe: async () => ({ signed: true }),
        finalizeRecipe: async () => ({ serialize: () => Uint8Array.from([1, 2]) }),
        submitTransaction: async () => {
          throw cause;
        },
        revert: async () => ({}),
      },
      keys: {
        shieldedSecretKeys: { coinPublicKey: '00', encryptionPublicKey: '00' },
        unshieldedKeystore: { signDataAsync: async () => ({}) },
      },
    } as unknown as LocalMidnightWallet;
  }

  const BALANCED = JSON.stringify({
    txHash: 'ab'.repeat(32),
    txBytes: '00ff',
    expiresAt: '',
  });

  /** Balances once (which fails on the bytes), then submits. */
  async function balanceThenSubmit(cause: unknown): Promise<{
    thrown: unknown;
    abandons: string[];
  }> {
    const abandons: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string }) => {
        const url = String(input);
        if (url.includes('/wallet-status')) {
          return new Response(JSON.stringify(READY_WALLET_STATUS), { status: 200 });
        }
        if (url.includes('/balance-only/abandon')) {
          abandons.push(init?.body ?? '');
          return new Response('{}', { status: 200 });
        }
        return new Response(BALANCED, { status: 200 });
      }),
    );
    const provider = walletProviderFor(walletThatSubmitFails(cause));
    // The sponsor's bytes are not a transaction, so this throws AFTER the
    // booking has been remembered — which is exactly the state under test.
    await provider.balanceTx({}).catch(() => undefined);
    let thrown: unknown;
    await provider.submitTx({}).catch((error: unknown) => {
      thrown = error;
    });
    // The abandon is fired, not awaited: let its microtasks run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { thrown, abandons };
  }

  it('tells the sponsor to release the fee, and rethrows the node’s own error', async () => {
    const cause = new Error('RpcError: 1010: Invalid Transaction: Custom error: 231');
    const { thrown, abandons } = await balanceThenSubmit(cause);
    expect(thrown).toBe(cause);
    expect(abandons).toEqual([JSON.stringify({ txHash: 'ab'.repeat(32) })]);
  });

  it('says nothing to the sponsor when the submit merely failed to reach the node', async () => {
    /* A dropped connection is NOT a rejection: the transaction may still be in
       flight, and releasing a fee that is about to be spent is worse than
       waiting for the sweeper. */
    const cause = new TypeError('Failed to fetch');
    const { thrown, abandons } = await balanceThenSubmit(cause);
    expect(thrown).toBe(cause);
    expect(abandons).toEqual([]);
  });

  it('says nothing when no sponsor balanced anything', async () => {
    const abandons: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).includes('/balance-only/abandon')) abandons.push('x');
        return new Response('{}', { status: 200 });
      }),
    );
    const cause = new Error('1010: Invalid Transaction');
    let thrown: unknown;
    await walletProviderFor(walletThatSubmitFails(cause))
      .submitTx({})
      .catch((error: unknown) => {
        thrown = error;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thrown).toBe(cause);
    expect(abandons).toEqual([]);
  });
});
