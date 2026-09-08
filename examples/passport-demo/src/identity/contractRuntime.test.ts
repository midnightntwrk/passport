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
  resetSharedProviders,
  sharedPublicDataProvider,
  walletProviderFor,
  BalancingFailure,
} from './contractRuntime.js';
import { hexToBytes as verifierHexToBytes } from '../verify/indexer.js';
import {
  forgetUnconfirmedSubmissions,
  settleDeadlineFor,
  RESUBMIT_WAIT_MS,
  SETTLE_WATCH_MS,
  SUBMIT_WAIT_MS,
  UNCONFIRMED_SETTLE_WAIT_MS,
} from '../lib/chainWait.js';
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

/**
 * The submit does not wait for finality, and cannot wait for ever (2026/09/07).
 *
 * The defect is in `../lib/chainWait.ts`'s header: the SDK's own
 * `submitTransaction` waits on a polkadot-js subscription for the node's
 * `Finalized` event with no bound, and that subscription is never re-created
 * after a websocket drop and never errors. A reviewer sat on "Setting up your
 * account…" indefinitely while their transaction was in a block.
 *
 * Two rules come out of that, and both are here: ask for INCLUSION rather than
 * finality, and stop waiting at a deadline with the identifier this tab already
 * holds. What must NOT change is the failure path — a node that refuses a
 * transaction still reverts it and still gives the sponsor its fee back.
 */
describe('submitTx, bounded and not waiting for finality', () => {
  /** A finalized transaction, which carries its own identifiers. */
  const TX = { identifiers: () => ['xy'.repeat(33)] };
  const IDENTIFIER = 'xy'.repeat(33);
  /* The two paths that submit, told apart so each can be followed to its own
     settlement wait. A shielded send's first leg is followed by the wait
     between the payment's two steps; a deployment by the account's own. */
  const SEND_IDENTIFIER = 'a1'.repeat(33);
  const SEND_TX = { identifiers: () => [SEND_IDENTIFIER] };
  const DEPLOY_IDENTIFIER = 'b2'.repeat(33);
  const DEPLOY_TX = { identifiers: () => [DEPLOY_IDENTIFIER] };
  /** `SETTLE_DEADLINE_MS` in `App.tsx`: three minutes between a send's legs. */
  const SEND_SETTLE_MS = 180_000;

  /** A facade whose submission service can be told how to behave. */
  function walletWithSubmission(service: {
    submitTransaction: (tx: unknown, waitForStatus?: string) => Promise<unknown>;
  }): { wallet: LocalMidnightWallet; pending: unknown[]; reverted: unknown[] } {
    const pending: unknown[] = [];
    const reverted: unknown[] = [];
    return {
      pending,
      reverted,
      wallet: {
        facade: {
          /* Enough of a balancing path to reach the sponsor, so a booking is
             remembered by the time the refusal test submits. */
          balanceUnboundTransaction: async () => ({ recipe: true }),
          signRecipe: async () => ({ signed: true }),
          finalizeRecipe: async () => ({ serialize: () => Uint8Array.from([1, 2]) }),
          submissionService: service,
          pendingTransactionsService: {
            addPendingTransaction: async (tx: unknown) => void pending.push(tx),
          },
          submitTransaction: async () => 'the facade waited for finality',
          revert: async (tx: unknown) => void reverted.push(tx),
        },
        keys: {
          shieldedSecretKeys: { coinPublicKey: '00', encryptionPublicKey: '00' },
          unshieldedKeystore: { signDataAsync: async () => ({}) },
        },
      } as unknown as LocalMidnightWallet,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    /* The register is tab-lifetime by design, so a suite that shares a module
       instance has to empty it between cases or one test's unacknowledged
       submission would shorten the next one's wait. */
    forgetUnconfirmedSubmissions();
  });

  it('asks the node for inclusion, not finality, and answers with the identifier', async () => {
    const asked: (string | undefined)[] = [];
    const { wallet, pending } = walletWithSubmission({
      submitTransaction: async (_tx, waitForStatus) => {
        asked.push(waitForStatus);
        return { _tag: 'InBlock' };
      },
    });
    await expect(walletProviderFor(wallet).submitTx(TX)).resolves.toBe(IDENTIFIER);
    expect(asked).toEqual(['InBlock']);
    // The pending set is still written first, exactly as the facade does it.
    expect(pending).toEqual([TX]);
  });

  it('stops waiting at the deadline and asks the node once more', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const asked: (string | undefined)[] = [];
    let attempt = 0;
    const { wallet, reverted, pending } = walletWithSubmission({
      submitTransaction: (_tx, waitForStatus) => {
        asked.push(waitForStatus);
        attempt += 1;
        // The subscription that lost its socket: silent, for ever.
        if (attempt === 1) return new Promise(() => {});
        return Promise.resolve({ _tag: 'InBlock' });
      },
    });
    const submitted = walletProviderFor(wallet).submitTx(TX);
    await vi.advanceTimersByTimeAsync(SUBMIT_WAIT_MS);
    expect(await submitted).toBe(IDENTIFIER);
    // The same bytes, asked for at inclusion again — nothing was rebuilt.
    expect(asked).toEqual(['InBlock', 'InBlock']);
    /* The pending set is written ONCE. The first attempt booked it and nothing
       at the bound gave it back, so writing it again would be writing a fact
       that is already true. */
    expect(pending).toEqual([TX]);
    /* NOTHING is given back at the deadline. The transaction may be in a block
       already — that is the whole defect — and reverting it, or handing the
       sponsor back a fee that has been spent, would turn a slow wait into a
       wrong one. */
    expect(reverted).toEqual([]);
    // ONE line, naming what happened to both attempts.
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/nothing answered within 60s/);
    expect(info.mock.calls[0]?.[0]).toMatch(/took the transaction on a second attempt/);
    /* Answered on the second attempt is ANSWERED. The wait that follows is the
       full one, because the node has said it has the transaction. */
    expect(settleDeadlineFor(IDENTIFIER, SEND_SETTLE_MS)).toBe(SEND_SETTLE_MS);
  });

  it('carries on, saying so, when the node answers that it already has it', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let attempt = 0;
    const { wallet, reverted } = walletWithSubmission({
      submitTransaction: () => {
        attempt += 1;
        if (attempt === 1) return new Promise(() => {});
        /* The real shape, three layers deep: the capabilities layer's tagged
           error, the node client's own, and the polkadot-js `RpcError` that is
           the only one carrying the node's own words. */
        return Promise.reject(
          new Error('Transaction submission error', {
            cause: new Error('Transaction submission failed', {
              cause: new Error('1013: Transaction Already Imported'),
            }),
          }),
        );
      },
    });
    const submitted = walletProviderFor(wallet).submitTx(TX);
    await vi.advanceTimersByTimeAsync(SUBMIT_WAIT_MS);
    expect(await submitted).toBe(IDENTIFIER);
    /* NOT unbooked. "I already have this" is the opposite of a refusal, and
       dropping the pending entry would drop a transaction about to apply. */
    expect(reverted).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/already with the node/);
    // The first attempt did reach the node, so the wait after it is the full one.
    expect(settleDeadlineFor(IDENTIFIER, SEND_SETTLE_MS)).toBe(SEND_SETTLE_MS);
  });

  it('lets a refusal at the second attempt travel, and hands the fee straight back', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
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
        return new Response(
          JSON.stringify({ txHash: 'ab'.repeat(32), txBytes: '00ff', expiresAt: '' }),
          { status: 200 },
        );
      }),
    );
    const cause = new Error('RpcError: 1010: Invalid Transaction: Custom error: 231');
    let attempt = 0;
    const { wallet, reverted } = walletWithSubmission({
      submitTransaction: () => {
        attempt += 1;
        if (attempt === 1) return new Promise(() => {});
        return Promise.reject(cause);
      },
    });
    const provider = walletProviderFor(wallet);
    // Balances (and fails on the sponsor's bytes) so a booking is remembered.
    await provider.balanceTx({}).catch(() => undefined);
    const submitted = provider.submitTx(TX);
    const thrown = submitted.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SUBMIT_WAIT_MS);
    /* UNCHANGED, and that is the whole requirement: `submitTx`'s
       sponsor-abandon test and every retry rule above it read this error's own
       words, so a second attempt must not re-wrap or reclassify it. */
    expect(await thrown).toBe(cause);
    expect(reverted.at(-1)).toBe(TX);
    await vi.advanceTimersByTimeAsync(0);
    expect(abandons).toEqual([JSON.stringify({ txHash: 'ab'.repeat(32) })]);
    vi.unstubAllGlobals();
  });

  it('marks a transaction nothing answered for twice, and shortens what follows', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    /* BOTH PATHS THAT SUBMIT. A shielded send's first leg and a new account's
       deployment go through this one provider, and each is followed by its own
       settlement wait — three minutes and two. */
    for (const [name, tx, identifier, normalMs] of [
      ['the shielded send', SEND_TX, SEND_IDENTIFIER, SEND_SETTLE_MS],
      ['the deployment', DEPLOY_TX, DEPLOY_IDENTIFIER, SETTLE_WATCH_MS],
    ] as const) {
      info.mockClear();
      const { wallet, reverted } = walletWithSubmission({
        // Dead both times: the socket the sponsor's bytes never left through.
        submitTransaction: () => new Promise(() => {}),
      });
      const submitted = walletProviderFor(wallet).submitTx(tx);
      await vi.advanceTimersByTimeAsync(SUBMIT_WAIT_MS);
      await vi.advanceTimersByTimeAsync(RESUBMIT_WAIT_MS);
      expect(await submitted, name).toBe(identifier);
      // Still nothing given back: it may be on chain, and nobody can say.
      expect(reverted, name).toEqual([]);
      expect(info, name).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0]?.[0], name).toMatch(/unconfirmed after two attempts/);
      /* THE POINT OF THE WHOLE CHANGE. The settlement that follows is given a
         minute rather than the two or three it would have had, so the person
         is told what happened — and offered the card that carries on — instead
         of watching a spinner for a transaction that may never have been
         sent. */
      expect(settleDeadlineFor(identifier, normalMs), name).toBe(UNCONFIRMED_SETTLE_WAIT_MS);
    }
  });

  it('stops the moment the device loses its network, and still asks once more', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const listeners = new Set<() => void>();
    const device = {
      navigator: { onLine: true },
      addEventListener: (event: string, handler: () => void) => {
        if (event === 'offline') listeners.add(handler);
      },
      removeEventListener: (_event: string, handler: () => void) => void listeners.delete(handler),
    };
    for (const [key, value] of Object.entries(device)) vi.stubGlobal(key, value);
    try {
      const { wallet } = walletWithSubmission({
        submitTransaction: () => new Promise(() => {}),
      });
      const submitted = walletProviderFor(wallet).submitTx(TX);
      await vi.advanceTimersByTimeAsync(0);
      for (const handler of listeners) handler();
      await vi.advanceTimersByTimeAsync(RESUBMIT_WAIT_MS);
      expect(await submitted).toBe(IDENTIFIER);
      /* Both bounds are named, in order and by their own words, so an operator
         can tell a radio handoff from a node that simply did not speak. */
      expect(info.mock.calls[0]?.[0]).toMatch(/this device lost its network connection/);
      expect(info.mock.calls[0]?.[0]).toMatch(/nothing answered within 20s/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still reverts, and still releases the fee, when the node REFUSES it', async () => {
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
        return new Response(
          JSON.stringify({ txHash: 'ab'.repeat(32), txBytes: '00ff', expiresAt: '' }),
          { status: 200 },
        );
      }),
    );
    const cause = new Error('RpcError: 1010: Invalid Transaction: Custom error: 231');
    const { wallet, reverted } = walletWithSubmission({
      submitTransaction: async () => {
        throw cause;
      },
    });
    const provider = walletProviderFor(wallet);
    // Balances (and fails on the sponsor's bytes) so a booking is remembered.
    await provider.balanceTx({}).catch(() => undefined);
    await expect(provider.submitTx(TX)).rejects.toBe(cause);
    // The last revert is the submission's own; the first is the balancing
    // recipe the sponsor's unreadable bytes abandoned.
    expect(reverted.at(-1)).toBe(TX);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(abandons).toEqual([JSON.stringify({ txHash: 'ab'.repeat(32) })]);
    vi.unstubAllGlobals();
  });

  it('leaves the SDK’s own wait alone where there is no identifier to answer with', async () => {
    const { wallet } = walletWithSubmission({
      submitTransaction: async () => ({ _tag: 'InBlock' }),
    });
    /* No identifier means nothing to carry on WITH, so bounding the wait would
       only replace a long wait with a wrong answer. */
    await expect(walletProviderFor(wallet).submitTx({})).resolves.toBe(
      'the facade waited for finality',
    );
  });

  it('falls back to the facade’s own method where no submission service exists', async () => {
    const wallet = {
      facade: {
        submitTransaction: async () => 'the facade waited for finality',
        revert: async () => ({}),
      },
      keys: {
        shieldedSecretKeys: { coinPublicKey: '00', encryptionPublicKey: '00' },
        unshieldedKeystore: { signDataAsync: async () => ({}) },
      },
    } as unknown as LocalMidnightWallet;
    await expect(walletProviderFor(wallet).submitTx(TX)).resolves.toBe(
      'the facade waited for finality',
    );
  });

  it('asks again through the facade too, where that is the only way to ask', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let attempt = 0;
    const wallet = {
      facade: {
        /* No submission service at all, so both attempts are the facade's own
           method — which waits for FINALITY and has no bound of its own. The
           second attempt is bounded here exactly like the first. */
        submitTransaction: () => {
          attempt += 1;
          if (attempt === 1) return new Promise(() => {});
          return Promise.resolve('the facade waited for finality');
        },
        revert: async () => ({}),
      },
      keys: {
        shieldedSecretKeys: { coinPublicKey: '00', encryptionPublicKey: '00' },
        unshieldedKeystore: { signDataAsync: async () => ({}) },
      },
    } as unknown as LocalMidnightWallet;
    const submitted = walletProviderFor(wallet).submitTx(TX);
    await vi.advanceTimersByTimeAsync(SUBMIT_WAIT_MS);
    expect(await submitted).toBe(IDENTIFIER);
    expect(attempt).toBe(2);
    expect(info.mock.calls[0]?.[0]).toMatch(/took the transaction on a second attempt/);
  });

  it('says so and carries on when even the revert fails', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const cause = new Error('the node would not take it');
    const wallet = {
      facade: {
        submissionService: {
          submitTransaction: async () => {
            throw cause;
          },
        },
        pendingTransactionsService: { addPendingTransaction: async () => undefined },
        submitTransaction: async () => 'unused',
        revert: async () => {
          throw new Error('the pending set had already forgotten it');
        },
      },
      keys: {
        shieldedSecretKeys: { coinPublicKey: '00', encryptionPublicKey: '00' },
        unshieldedKeystore: { signDataAsync: async () => ({}) },
      },
    } as unknown as LocalMidnightWallet;
    // The ORIGINAL error travels; the revert's own failure is only a log line.
    await expect(walletProviderFor(wallet).submitTx(TX)).rejects.toBe(cause);
    expect(debug).toHaveBeenCalled();
  });
});

/**
 * The indexer provider is built ONCE for a tab (2026/09/03).
 *
 * `indexerPublicDataProvider` builds an Apollo client, an `InMemoryCache`, a
 * retry link, and a `graphql-ws` client, and offers no way to reach any of them
 * again. Every caller in this app used to build one per read and drop it, which
 * cost nothing while a read followed something the reader had just done — and
 * became a per-tick allocation the day `lib/balanceWatch.ts` began re-reading
 * the account every five to thirty seconds for as long as a Passport is open.
 *
 * Nothing here reaches the network: constructing the provider opens no socket
 * (the `graphql-ws` client is lazy) and no query is made.
 */
describe('sharedPublicDataProvider', () => {
  afterEach(() => {
    resetSharedProviders();
  });

  it('hands the same provider back for the same indexer', async () => {
    const first = await sharedPublicDataProvider(
      'https://indexer.example/api/v4/graphql',
      'wss://indexer.example/api/v4/graphql/ws',
    );
    const second = await sharedPublicDataProvider(
      'https://indexer.example/api/v4/graphql',
      'wss://indexer.example/api/v4/graphql/ws',
    );
    expect(second).toBe(first);
  });

  it('does not serve one indexer’s provider to a caller that asked for another', async () => {
    const stagenet = await sharedPublicDataProvider(
      'https://indexer.example/api/v4/graphql',
      'wss://indexer.example/api/v4/graphql/ws',
    );
    const elsewhere = await sharedPublicDataProvider(
      'https://other.example/api/v4/graphql',
      'wss://other.example/api/v4/graphql/ws',
    );
    expect(elsewhere).not.toBe(stagenet);
    /* And the subscription URL is part of the answer, not decoration. */
    const otherSocket = await sharedPublicDataProvider(
      'https://indexer.example/api/v4/graphql',
      'wss://elsewhere.example/api/v4/graphql/ws',
    );
    expect(otherSocket).not.toBe(stagenet);
  });

  it('builds a new one after the cache is dropped', async () => {
    const before = await sharedPublicDataProvider(
      'https://indexer.example/api/v4/graphql',
      'wss://indexer.example/api/v4/graphql/ws',
    );
    resetSharedProviders();
    const after = await sharedPublicDataProvider(
      'https://indexer.example/api/v4/graphql',
      'wss://indexer.example/api/v4/graphql/ws',
    );
    expect(after).not.toBe(before);
  });
});
