/**
 * Drills for `zkArtefactCache.ts` — the rule that a ZK artefact is fetched
 * once rather than once per library layer that wants it.
 *
 * The provider is a counting stand-in rather than a mock of
 * `FetchZkConfigProvider`: what is being drilled is the memo and its idle rule,
 * and the only thing this module needs of a provider is that its three reads
 * are the three reads. The ONE thing that is exercised against a real
 * `ZKConfigProvider` shape is the inheritance: `get` and `getVerifierKeys` are
 * midnight-js's own compositions of the three abstract reads, and the whole
 * reason this wraps with `Object.create` rather than reimplementing them is
 * that they must keep working and must be memoised. So a class with those two
 * methods on its prototype is built here and the drill checks that a call to
 * either lands on the memo.
 */
import { describe, expect, it } from 'vitest';

import {
  ZK_ARTEFACT_IDLE_MS,
  memoisingZkConfigProvider,
  type ZkArtefactSource,
} from './zkArtefactCache.js';

/** A provider that counts what it was asked for and answers with the ask. */
function countingProvider(): ZkArtefactSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getProverKey: async (circuitId: string) => {
      calls.push(`prover:${circuitId}`);
      return `prover-bytes:${circuitId}`;
    },
    getVerifierKey: async (circuitId: string) => {
      calls.push(`verifier:${circuitId}`);
      return `verifier-bytes:${circuitId}`;
    },
    getZKIR: async (circuitId: string) => {
      calls.push(`zkir:${circuitId}`);
      return `zkir-bytes:${circuitId}`;
    },
  };
}

/**
 * The shape midnight-js's own `ZKConfigProvider` has: three abstract reads,
 * and two compositions of them on the prototype.
 */
class ProviderWithCompositions implements ZkArtefactSource {
  calls: string[] = [];

  async getProverKey(circuitId: string): Promise<unknown> {
    this.calls.push(`prover:${circuitId}`);
    return `prover-bytes:${circuitId}`;
  }

  async getVerifierKey(circuitId: string): Promise<unknown> {
    this.calls.push(`verifier:${circuitId}`);
    return `verifier-bytes:${circuitId}`;
  }

  async getZKIR(circuitId: string): Promise<unknown> {
    this.calls.push(`zkir:${circuitId}`);
    return `zkir-bytes:${circuitId}`;
  }

  /* Both of these read through `this`, exactly as midnight-js's do. */
  async get(circuitId: string): Promise<Record<string, unknown>> {
    return {
      circuitId,
      proverKey: await this.getProverKey(circuitId),
      verifierKey: await this.getVerifierKey(circuitId),
      zkir: await this.getZKIR(circuitId),
    };
  }

  async getVerifierKeys(circuitIds: string[]): Promise<[string, unknown][]> {
    return Promise.all(
      circuitIds.map(async (id): Promise<[string, unknown]> => [id, await this.getVerifierKey(id)]),
    );
  }
}

describe('memoisingZkConfigProvider', () => {
  it('fetches each artefact once, however many layers ask for it', async () => {
    const provider = countingProvider();
    const memo = memoisingZkConfigProvider(provider);

    /* The live shape: lookupKey, then check, then prove — three asks for the
       same circuit inside one leg. */
    for (let ask = 0; ask < 3; ask += 1) {
      await memo.getProverKey('withdraw_shielded');
      await memo.getVerifierKey('withdraw_shielded');
      await memo.getZKIR('withdraw_shielded');
    }

    expect(provider.calls).toEqual([
      'prover:withdraw_shielded',
      'verifier:withdraw_shielded',
      'zkir:withdraw_shielded',
    ]);
  });

  it('answers with the same bytes it fetched', async () => {
    const memo = memoisingZkConfigProvider(countingProvider());
    await expect(memo.getProverKey('deposit_shielded')).resolves.toBe(
      'prover-bytes:deposit_shielded',
    );
    await expect(memo.getVerifierKey('deposit_shielded')).resolves.toBe(
      'verifier-bytes:deposit_shielded',
    );
    await expect(memo.getZKIR('deposit_shielded')).resolves.toBe('zkir-bytes:deposit_shielded');
  });

  it('serves two circuits without confusing them', async () => {
    const provider = countingProvider();
    const memo = memoisingZkConfigProvider(provider);

    await expect(memo.getProverKey('withdraw_shielded')).resolves.toBe(
      'prover-bytes:withdraw_shielded',
    );
    await expect(memo.getProverKey('deposit_shielded')).resolves.toBe(
      'prover-bytes:deposit_shielded',
    );
    await memo.getProverKey('withdraw_shielded');

    expect(provider.calls).toEqual(['prover:withdraw_shielded', 'prover:deposit_shielded']);
  });

  it('shares one fetch between concurrent asks rather than starting a second', async () => {
    const provider = countingProvider();
    const memo = memoisingZkConfigProvider(provider);

    const [first, second] = await Promise.all([
      memo.getProverKey('withdraw_shielded'),
      memo.getProverKey('withdraw_shielded'),
    ]);

    expect(first).toBe(second);
    expect(provider.calls).toEqual(['prover:withdraw_shielded']);
  });

  it('drops an artefact nothing has asked for in the idle window', async () => {
    const provider = countingProvider();
    let clock = 1_000;
    const memo = memoisingZkConfigProvider(provider, { now: () => clock });

    await memo.getProverKey('withdraw_shielded');
    clock += ZK_ARTEFACT_IDLE_MS - 1;
    await memo.getProverKey('withdraw_shielded');
    expect(provider.calls).toEqual(['prover:withdraw_shielded']);

    /* The last READ restarts the window, not the fetch: a key in use is kept. */
    clock += ZK_ARTEFACT_IDLE_MS;
    await memo.getProverKey('withdraw_shielded');
    expect(provider.calls).toEqual(['prover:withdraw_shielded', 'prover:withdraw_shielded']);
  });

  it('takes an idle window from the caller', async () => {
    const provider = countingProvider();
    let clock = 0;
    const memo = memoisingZkConfigProvider(provider, { now: () => clock, idleMs: 10 });

    await memo.getZKIR('recover');
    clock += 10;
    await memo.getZKIR('recover');

    expect(provider.calls).toEqual(['zkir:recover', 'zkir:recover']);
  });

  it('sweeps an idle artefact even when a different one is asked for', async () => {
    const provider = countingProvider();
    let clock = 0;
    const memo = memoisingZkConfigProvider(provider, { now: () => clock, idleMs: 10 });

    await memo.getProverKey('withdraw_shielded');
    clock += 10;
    /* Nothing asks for `withdraw_shielded` again; the ask for another circuit
       is what evicts it, which is the only moment the answer can matter. */
    await memo.getProverKey('deposit_shielded');
    clock += 1;
    await memo.getProverKey('withdraw_shielded');

    expect(provider.calls).toEqual([
      'prover:withdraw_shielded',
      'prover:deposit_shielded',
      'prover:withdraw_shielded',
    ]);
  });

  it('does not remember a failure', async () => {
    const calls: string[] = [];
    let failNext = true;
    const memo = memoisingZkConfigProvider({
      getProverKey: async (circuitId: string) => {
        calls.push(circuitId);
        if (failNext) {
          failNext = false;
          throw new Error('the network went away');
        }
        return `prover-bytes:${circuitId}`;
      },
      getVerifierKey: async () => 'unused',
      getZKIR: async () => 'unused',
    });

    await expect(memo.getProverKey('withdraw_shielded')).rejects.toThrow('the network went away');
    await expect(memo.getProverKey('withdraw_shielded')).resolves.toBe(
      'prover-bytes:withdraw_shielded',
    );
    expect(calls).toEqual(['withdraw_shielded', 'withdraw_shielded']);
  });

  it('leaves a retry already in flight alone when the first attempt fails', async () => {
    const calls: string[] = [];
    let release: (() => void) | null = null;
    let attempt = 0;
    const memo = memoisingZkConfigProvider({
      getProverKey: async (circuitId: string) => {
        calls.push(circuitId);
        attempt += 1;
        if (attempt === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new Error('slow failure');
        }
        return `prover-bytes:${circuitId}`;
      },
      getVerifierKey: async () => 'unused',
      getZKIR: async () => 'unused',
    });

    const failing = memo.getProverKey('withdraw_shielded');
    const failed = failing.catch((cause: Error) => cause.message);
    /* The second ask is made only after the first is evicted, which is what
       the delayed rejection below arranges — so the entry the eviction sees is
       no longer the one that failed. */
    (release as unknown as () => void)();
    await expect(failed).resolves.toBe('slow failure');

    const second = memo.getProverKey('withdraw_shielded');
    await expect(memo.getProverKey('withdraw_shielded')).resolves.toBe(
      'prover-bytes:withdraw_shielded',
    );
    await expect(second).resolves.toBe('prover-bytes:withdraw_shielded');
    expect(calls).toEqual(['withdraw_shielded', 'withdraw_shielded']);
  });

  it('memoises the compositions the provider inherits, and leaves it unwrapped', async () => {
    const provider = new ProviderWithCompositions();
    const memo = memoisingZkConfigProvider(provider);

    /* `get` composes all three; `getVerifierKeys` composes one of them. Both
       reach the memo through `this` because the memo IS the prototype chain. */
    await memo.get('withdraw_shielded');
    await memo.get('withdraw_shielded');
    await memo.getVerifierKeys(['withdraw_shielded', 'deposit_shielded']);

    expect(provider.calls).toEqual([
      'prover:withdraw_shielded',
      'verifier:withdraw_shielded',
      'zkir:withdraw_shielded',
      'verifier:deposit_shielded',
    ]);
    /* Downstream `instanceof` checks — midnight-js has one — still answer. */
    expect(memo).toBeInstanceOf(ProviderWithCompositions);
    /* And the provider it wrapped was not touched. */
    expect(Object.hasOwn(provider, 'getProverKey')).toBe(false);
  });

  it('uses a real clock when none is given', async () => {
    const provider = countingProvider();
    const memo = memoisingZkConfigProvider(provider, { idleMs: 0 });

    await memo.getVerifierKey('add_device');
    await memo.getVerifierKey('add_device');

    /* An idle window of zero evicts on the next ask however long the wall
       clock says has passed, which is what exercises the default `now`. */
    expect(provider.calls).toEqual(['verifier:add_device', 'verifier:add_device']);
  });
});
