/**
 * The two properties an upgrade lives or dies by, executable.
 *
 * An upgrade is four to six sponsored transactions on a phone, in a tab that
 * can be closed at any point in the minutes they take. Everything in
 * `./accountUpgrade.ts` follows from two rules, and these are those rules
 * written as tests rather than as prose:
 *
 *   RESUME AFTER EACH STEP. Interrupted anywhere, the next attempt starts from
 *   what the store recorded and does only what is left.
 *
 *   SKIP WHAT IS ALREADY DONE — and decide that by asking the CHAIN, not the
 *   store. A step whose effect is already true on chain costs one read. This
 *   is the stronger of the two rules and the one that makes the first safe: a
 *   deposit that landed while the tab was closing is invisible to the store
 *   and plain in the ledger.
 *
 * Every seam is injected (`UpgradeDeps`), so none of this touches a network, a
 * wallet, or the ledger WASM. What is NOT checked here is whether the real
 * implementations behind those seams do what their names say — that is the
 * drill's job, and the drill needs a funded pre-upgrade Passport with its
 * passkey secret, which only a real device has.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AccountUpgradeError,
  upgradeAccount,
  type UpgradeDeps,
  type UpgradePhase,
} from './accountUpgrade.js';
import {
  loadPassportContractRecord,
  loadPassportUpgradeProgress,
  savePassportContractRecord,
} from './passportContractStore.js';

const CREDENTIAL = 'AQIDBA==';
const NETWORK = 'stagenet';
const OLD = 'a1'.repeat(32);
const NEW = 'b2'.repeat(32);
const DEPLOY_TX = 'cd'.repeat(33);
const RESOLVER = 'e3'.repeat(32);
const NIGHT = '01'.repeat(32);
const MUSD = '07'.repeat(32);

/** The smallest thing that behaves like `window.localStorage`. */
function installStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
      },
    },
  });
}

/** The record an upgrade hangs off: a Passport already on the old account. */
function seedRecord(): void {
  savePassportContractRecord({
    credentialId: CREDENTIAL,
    network: NETWORK,
    status: 'deployed',
    address: OLD,
    deployTxId: 'ef'.repeat(33),
    ledgerConfirmed: true,
    deviceCommitment: '12345',
  });
}

/** Enough of a wallet for the machine; every reach through it is injected. */
const handle = {
  network: { networkId: NETWORK, indexerHttpUrl: 'https://indexer.example/api/v1/graphql' },
  unshieldedAddress: 'mn_addr_test1example',
  shieldedAddress: 'mn_shield-addr_test1example',
} as never;

const secrets = { rootSecret: new Uint8Array(32), ownerSecret: new Uint8Array(32).fill(7) };

interface Chain {
  /** Balances by address, then colour. */
  night: Map<string, Map<string, bigint>>;
  shielded: Map<string, Map<string, bigint>>;
  /** Addresses the indexer serves state at. */
  served: Set<string>;
  /** What the name points at. */
  target: string | null;
  /** The resolver leaf's owner key, or null where it cannot be read. */
  leafOwner: Uint8Array | null;
}

function chain(patch: Partial<Chain> = {}): Chain {
  return {
    night: new Map([[OLD, new Map([[NIGHT, 500n]])]]),
    shielded: new Map([[OLD, new Map([[MUSD, 120n]])]]),
    served: new Set([OLD]),
    target: OLD,
    leafOwner: null,
    ...patch,
  };
}

function balancesOf(chainState: Chain, address: string, kind: 'night' | 'shielded') {
  const book = kind === 'night' ? chainState.night : chainState.shielded;
  let held = book.get(address);
  if (!held) {
    held = new Map<string, bigint>();
    book.set(address, held);
  }
  return held;
}

/**
 * Deps wired to a little world that behaves like the chain does: a withdrawal
 * empties a colour, a deploy starts being served, a re-point moves the target,
 * a deposit credits the new account. Every call is a spy, so a test can assert
 * what was NOT done as easily as what was.
 */
function deps(chainState: Chain, overrides: Partial<UpgradeDeps> = {}) {
  const calls = {
    withdrawNight: vi.fn(),
    withdrawShielded: vi.fn(),
    submitAccount: vi.fn(),
    repointBySponsor: vi.fn(),
    repointByUser: vi.fn(),
    depositNight: vi.fn(),
    depositShielded: vi.fn(),
  };
  /* `Promise.resolve(...)` rather than `async`, throughout: none of these has
     anything to await, and an `async` that awaits nothing is a function whose
     shape says it does chain work. The one thing they DO model is that the
     machine only ever sees promises. */
  const base: UpgradeDeps = {
    hasOneTxTransfer: (_indexer, address) =>
      Promise.resolve(chainState.served.has(address) && address === NEW),
    readAccountState: (_handle, address) => {
      if (!chainState.served.has(address)) return Promise.reject(new Error(`no state at ${address}`));
      return Promise.resolve({
        nightBalances: new Map(balancesOf(chainState, address, 'night')),
        shieldedCoins: new Map(balancesOf(chainState, address, 'shielded')),
        deviceCount: 1,
        grants: [],
        deviceEpoch: 0,
        round: 0n,
        activeDeviceCommitments: new Set<bigint>(),
      });
    },
    withdrawNight: (_handle, _secret, request) => {
      calls.withdrawNight(request);
      balancesOf(chainState, request.contractAddress, 'night').delete(request.colourHex);
      return Promise.resolve();
    },
    withdrawShielded: (_handle, _secret, request) => {
      calls.withdrawShielded(request);
      balancesOf(chainState, request.contractAddress, 'shielded').delete(request.colourHex);
      return Promise.resolve();
    },
    deriveDeviceSecret: () => Promise.resolve(new Uint8Array(32).fill(3)),
    submitAccount: () => {
      calls.submitAccount();
      chainState.served.add(NEW);
      return Promise.resolve({
        address: NEW,
        identifier: DEPLOY_TX,
        deviceCommitment: '12345',
        settled: Promise.resolve({}),
      });
    },
    awaitOnLedger: (_indexer, address) => Promise.resolve(chainState.served.has(address)),
    resolveName: () =>
      Promise.resolve(
        chainState.target === null
          ? null
          : {
              resolverAddress: RESOLVER,
              target: { kind: 'contract' as const, hex: chainState.target },
            },
      ),
    readLeafOwnerKey: () => Promise.resolve(chainState.leafOwner),
    deriveOwnerKey: () => Promise.resolve(new Uint8Array(32).fill(7)),
    repointBySponsor: (funderUrl, body) => {
      calls.repointBySponsor(funderUrl, body);
      chainState.target = body.newAccount;
      return Promise.resolve();
    },
    repointByUser: (_handle, _secret, resolverAddress, newAccount) => {
      calls.repointByUser(resolverAddress, newAccount);
      chainState.target = newAccount;
      return Promise.resolve();
    },
    depositNight: (_handle, request) => {
      calls.depositNight(request);
      const book = balancesOf(chainState, request.contractAddress, 'night');
      book.set(request.colourHex, (book.get(request.colourHex) ?? 0n) + request.amount);
      return Promise.resolve();
    },
    depositShielded: (_handle, request) => {
      calls.depositShielded(request);
      const book = balancesOf(chainState, request.contractAddress, 'shielded');
      book.set(request.colourHex, (book.get(request.colourHex) ?? 0n) + request.amount);
      return Promise.resolve();
    },
    now: () => 0,
    /* The clock never moves, so a window that would have closed never does —
       these tests are about decisions, not about timeouts, and a real sleep
       would make them slow for nothing. `pollUntilTrue` ends on its answer. */
    sleep: () => Promise.resolve(),
    ...overrides,
  };
  return { deps: base, calls };
}

const request = {
  oldAddress: OLD,
  name: 'alice',
  credentialId: CREDENTIAL,
  funderUrl: 'https://sponsor.example',
};

beforeEach(() => {
  installStorage();
  seedRecord();
});

describe('detecting which build the account is', () => {
  it('does nothing at all when the old account already has the circuit', async () => {
    const world = chain({ served: new Set([OLD]) });
    const { deps: wired, calls } = deps(world, { hasOneTxTransfer: () => Promise.resolve(true) });
    const result = await upgradeAccount(handle, secrets, request, undefined, wired);

    expect(result.outcome).toBe('not-needed');
    expect(result.newAddress).toBe(OLD);
    expect(calls.withdrawNight).not.toHaveBeenCalled();
    expect(calls.submitAccount).not.toHaveBeenCalled();
    /* And the record is untouched — this Passport is on the account it was on. */
    expect(loadPassportContractRecord(CREDENTIAL, NETWORK)?.address).toBe(OLD);
  });

  it('refuses rather than guessing when the chain cannot be asked', async () => {
    const { deps: wired, calls } = deps(chain(), { hasOneTxTransfer: () => Promise.resolve(null) });
    await expect(upgradeAccount(handle, secrets, request, undefined, wired)).rejects.toMatchObject({
      code: 'build-unknown',
      step: 'detect',
    });
    /* NOTHING was drained on the strength of a read that failed. */
    expect(calls.withdrawNight).not.toHaveBeenCalled();
    expect(calls.withdrawShielded).not.toHaveBeenCalled();
  });

  it('refuses an address that is not an address, before anything else', async () => {
    const { deps: wired } = deps(chain());
    await expect(
      upgradeAccount(handle, secrets, { ...request, oldAddress: 'nonsense' }, undefined, wired),
    ).rejects.toBeInstanceOf(AccountUpgradeError);
  });
});

describe('a whole upgrade', () => {
  it('drains, deploys, re-points, refunds, and switches the store onto the new account', async () => {
    const world = chain();
    const { deps: wired, calls } = deps(world);
    const phases: UpgradePhase[] = [];

    const result = await upgradeAccount(
      handle,
      secrets,
      request,
      (phase) => phases.push(phase),
      wired,
    );

    expect(result).toMatchObject({ outcome: 'upgraded', oldAddress: OLD, newAddress: NEW });
    expect(calls.withdrawNight).toHaveBeenCalledTimes(1);
    expect(calls.withdrawShielded).toHaveBeenCalledTimes(1);
    expect(calls.submitAccount).toHaveBeenCalledTimes(1);
    expect(calls.depositNight).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: NEW, colourHex: NIGHT, amount: 500n }),
    );
    expect(calls.depositShielded).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: NEW, colourHex: MUSD, amount: 120n }),
    );
    /* Everything that came out went back in, to the penny. */
    expect(world.night.get(NEW)?.get(NIGHT)).toBe(500n);
    expect(world.shielded.get(NEW)?.get(MUSD)).toBe(120n);
    expect(world.target).toBe(NEW);

    /* THE SWITCH. The store now names the new account and nothing else, and the
       upgrade block is gone rather than left lying about as a finished one. */
    const record = loadPassportContractRecord(CREDENTIAL, NETWORK);
    expect(record?.address).toBe(NEW);
    expect(record?.deployTxId).toBe(DEPLOY_TX);
    expect(record?.ledgerConfirmed).toBe(true);
    expect(record?.upgrade).toBeUndefined();
    expect(loadPassportUpgradeProgress(CREDENTIAL, NETWORK)).toBeNull();

    /* The six steps were reported in order, each at least once. */
    const seen = phases.map((phase) => phase.step);
    expect(seen[0]).toBe('detect');
    expect(seen.at(-1)).toBe('switch');
    for (const step of ['drain', 'deploy', 'repoint', 'refund']) {
      expect(seen).toContain(step);
    }
  });

  it('takes the whole shielded coin, which is the only branch that leaves the account spendable', async () => {
    const { deps: wired, calls } = deps(chain());
    await upgradeAccount(handle, secrets, request, undefined, wired);
    expect(calls.withdrawShielded).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: OLD, colourHex: MUSD, amount: 120n }),
    );
  });

  it('skips the name step entirely for a Passport that has none', async () => {
    const world = chain();
    const { deps: wired, calls } = deps(world);
    const result = await upgradeAccount(
      handle,
      secrets,
      { ...request, name: null },
      undefined,
      wired,
    );
    expect(result).toMatchObject({ outcome: 'upgraded', name: null });
    expect(calls.repointBySponsor).not.toHaveBeenCalled();
    expect(calls.repointByUser).not.toHaveBeenCalled();
    /* And the value still moved. */
    expect(world.night.get(NEW)?.get(NIGHT)).toBe(500n);
  });
});

describe('resuming', () => {
  /**
   * Runs an upgrade that fails at `failAt`, then runs it again with everything
   * working — which is what a person pressing "Try again" does.
   */
  async function interruptThenResume(overrides: Partial<UpgradeDeps>) {
    const world = chain();
    const first = deps(world, overrides);
    await expect(
      upgradeAccount(handle, secrets, request, undefined, first.deps),
    ).rejects.toBeInstanceOf(AccountUpgradeError);
    const second = deps(world);
    const result = await upgradeAccount(handle, secrets, request, undefined, second.deps);
    return { world, first, second, result };
  }

  it('after a landed drain, does not withdraw again', async () => {
    const { second, result } = await interruptThenResume({
      /* The drain lands; the deploy is what fails. */
      submitAccount: () => Promise.reject(new Error('the prover fell over')),
    });
    expect(result.outcome).toBe('upgraded');
    expect(second.calls.withdrawNight).not.toHaveBeenCalled();
    expect(second.calls.withdrawShielded).not.toHaveBeenCalled();
  });

  it('after a submitted deploy, does not deploy a second contract', async () => {
    const { second, result } = await interruptThenResume({
      /* The deploy is submitted and the chain is serving it; the RE-POINT is
         what fails. This is the expensive case: an upgrade that forgot the
         submission would pay a second sponsored fee for a second account. */
      repointBySponsor: () => Promise.reject(new Error('the service was busy')),
    });
    expect(result.outcome).toBe('upgraded');
    expect(second.calls.submitAccount).not.toHaveBeenCalled();
    expect(result.newAddress).toBe(NEW);
  });

  it('after a landed re-point, does not ask for it again', async () => {
    const { second, result } = await interruptThenResume({
      /* Name moved; the refund is what fails. */
      depositNight: () => Promise.reject(new Error('the node refused the deposit')),
    });
    expect(result.outcome).toBe('upgraded');
    expect(second.calls.repointBySponsor).not.toHaveBeenCalled();
    expect(second.calls.repointByUser).not.toHaveBeenCalled();
  });

  it('after a landed deposit, pays that colour back exactly once', async () => {
    const world = chain();
    /* The NIGHT leg lands, the shielded one fails. */
    const first = deps(world, {
      depositShielded: () => Promise.reject(new Error('the node refused the deposit')),
    });
    await expect(
      upgradeAccount(handle, secrets, request, undefined, first.deps),
    ).rejects.toMatchObject({ code: 'refund-failed', step: 'refund' });
    expect(first.calls.depositNight).toHaveBeenCalledTimes(1);

    const second = deps(world);
    await upgradeAccount(handle, secrets, request, undefined, second.deps);
    expect(second.calls.depositNight).not.toHaveBeenCalled();
    expect(second.calls.depositShielded).toHaveBeenCalledTimes(1);
    expect(world.night.get(NEW)?.get(NIGHT)).toBe(500n);
  });

  it('records where it stopped, and what it had already done', async () => {
    const world = chain();
    const { deps: wired } = deps(world, {
      repointBySponsor: () => Promise.reject(new Error('the service was busy')),
    });
    await expect(
      upgradeAccount(handle, secrets, request, undefined, wired),
    ).rejects.toBeInstanceOf(AccountUpgradeError);

    const progress = loadPassportUpgradeProgress(CREDENTIAL, NETWORK);
    expect(progress).toMatchObject({
      fromAddress: OLD,
      name: 'alice',
      toAddress: NEW,
      drained: true,
      deployed: true,
    });
    expect(progress?.repointed).toBeUndefined();
    expect(progress?.failureReason).toBeTruthy();
    /* WHAT CAME OUT is written down, because nothing else can reconstruct it
       once the old account is empty. */
    expect(progress?.drainedNight).toEqual([[NIGHT, '500']]);
    expect(progress?.drainedShielded).toEqual([[MUSD, '120']]);
    /* And the Passport is still on the OLD account: until the name and the
       value have moved, that is what a Passport is. */
    expect(loadPassportContractRecord(CREDENTIAL, NETWORK)?.address).toBe(OLD);
  });

  it('does not re-record the drained figures against a half-drained account', async () => {
    const world = chain();
    /* The NIGHT withdrawal lands, the shielded one fails. */
    const first = deps(world, {
      withdrawShielded: () => Promise.reject(new Error('the node refused the withdrawal')),
    });
    await expect(
      upgradeAccount(handle, secrets, request, undefined, first.deps),
    ).rejects.toMatchObject({ step: 'drain' });
    expect(world.night.get(OLD)?.get(NIGHT)).toBeUndefined();

    const second = deps(world);
    await upgradeAccount(handle, secrets, request, undefined, second.deps);
    /* The refund still knows about the NIGHT that left on the first attempt,
       which a re-read of the half-drained account would have lost. */
    expect(world.night.get(NEW)?.get(NIGHT)).toBe(500n);
    expect(second.calls.withdrawNight).not.toHaveBeenCalled();
    expect(second.calls.withdrawShielded).toHaveBeenCalledTimes(1);
  });
});

describe('skipping what the chain says is already done', () => {
  it('skips a colour the old account no longer holds', async () => {
    const world = chain({ night: new Map([[OLD, new Map()]]) });
    const { deps: wired, calls } = deps(world);
    await upgradeAccount(handle, secrets, request, undefined, wired);
    expect(calls.withdrawNight).not.toHaveBeenCalled();
    expect(calls.withdrawShielded).toHaveBeenCalledTimes(1);
  });

  it('skips the deploy when the recorded new account is already served', async () => {
    /* The store remembers a submission this browser never saw land; the chain
       has it. This is the reload the store's own header was written for. */
    const world = chain({ served: new Set([OLD, NEW]) });
    savePassportContractRecord({
      ...loadPassportContractRecord(CREDENTIAL, NETWORK)!,
      upgrade: {
        fromAddress: OLD,
        name: 'alice',
        startedAt: '2026-09-10T09:00:00.000Z',
        toAddress: NEW,
        toDeployTxId: DEPLOY_TX,
        drained: true,
        drainedNight: [],
        drainedShielded: [],
      },
    });
    const { deps: wired, calls } = deps(world);
    const result = await upgradeAccount(handle, secrets, request, undefined, wired);
    expect(result.newAddress).toBe(NEW);
    expect(calls.submitAccount).not.toHaveBeenCalled();
  });

  it('skips the re-point when the name already resolves to the new account', async () => {
    const world = chain({ served: new Set([OLD, NEW]), target: NEW });
    savePassportContractRecord({
      ...loadPassportContractRecord(CREDENTIAL, NETWORK)!,
      upgrade: {
        fromAddress: OLD,
        name: 'alice',
        startedAt: '2026-09-10T09:00:00.000Z',
        toAddress: NEW,
        toDeployTxId: DEPLOY_TX,
        drained: true,
        deployed: true,
        drainedNight: [],
        drainedShielded: [],
      },
    });
    const { deps: wired, calls } = deps(world);
    await upgradeAccount(handle, secrets, request, undefined, wired);
    expect(calls.repointBySponsor).not.toHaveBeenCalled();
    expect(calls.repointByUser).not.toHaveBeenCalled();
  });

  it('skips a refund the new account already carries, whoever put it there', async () => {
    const world = chain({ served: new Set([OLD, NEW]), target: NEW });
    /* The deposit landed; the record of it did not. */
    world.night.set(NEW, new Map([[NIGHT, 500n]]));
    savePassportContractRecord({
      ...loadPassportContractRecord(CREDENTIAL, NETWORK)!,
      upgrade: {
        fromAddress: OLD,
        name: 'alice',
        startedAt: '2026-09-10T09:00:00.000Z',
        toAddress: NEW,
        toDeployTxId: DEPLOY_TX,
        drained: true,
        deployed: true,
        repointed: true,
        drainedNight: [[NIGHT, '500']],
        drainedShielded: [],
      },
    });
    const { deps: wired, calls } = deps(world);
    await upgradeAccount(handle, secrets, request, undefined, wired);
    expect(calls.depositNight).not.toHaveBeenCalled();
    expect(world.night.get(NEW)?.get(NIGHT)).toBe(500n);
  });

  it('pays only the difference when part of a colour is already back', async () => {
    const world = chain({ served: new Set([OLD, NEW]), target: NEW });
    world.night.set(NEW, new Map([[NIGHT, 300n]]));
    savePassportContractRecord({
      ...loadPassportContractRecord(CREDENTIAL, NETWORK)!,
      upgrade: {
        fromAddress: OLD,
        name: 'alice',
        startedAt: '2026-09-10T09:00:00.000Z',
        toAddress: NEW,
        toDeployTxId: DEPLOY_TX,
        drained: true,
        deployed: true,
        repointed: true,
        drainedNight: [[NIGHT, '500']],
        drainedShielded: [],
      },
    });
    const { deps: wired, calls } = deps(world);
    await upgradeAccount(handle, secrets, request, undefined, wired);
    expect(calls.depositNight).toHaveBeenCalledWith(
      expect.objectContaining({ colourHex: NIGHT, amount: 200n }),
    );
    expect(world.night.get(NEW)?.get(NIGHT)).toBe(500n);
  });
});

describe('who owns the name’s resolver', () => {
  it('calls the circuit itself when the leaf is the holder’s', async () => {
    const world = chain({ leafOwner: new Uint8Array(32).fill(7) });
    const { deps: wired, calls } = deps(world);
    await upgradeAccount(handle, secrets, request, undefined, wired);
    expect(calls.repointByUser).toHaveBeenCalledWith(RESOLVER, NEW);
    expect(calls.repointBySponsor).not.toHaveBeenCalled();
  });

  it('asks the service when the leaf is not the holder’s', async () => {
    const world = chain({ leafOwner: new Uint8Array(32).fill(9) });
    const { deps: wired, calls } = deps(world);
    await upgradeAccount(handle, secrets, request, undefined, wired);
    expect(calls.repointBySponsor).toHaveBeenCalledWith(
      'https://sponsor.example',
      expect.objectContaining({ name: 'alice', newAccount: NEW, oldAccount: OLD }),
    );
    expect(calls.repointByUser).not.toHaveBeenCalled();
  });

  it('asks the service when the leaf’s owner cannot be read at all', async () => {
    const world = chain({ leafOwner: null });
    const { deps: wired, calls } = deps(world);
    await upgradeAccount(handle, secrets, request, undefined, wired);
    expect(calls.repointBySponsor).toHaveBeenCalled();
  });

  it('refuses rather than guessing when there is no service and the leaf is not ours', async () => {
    const world = chain({ leafOwner: new Uint8Array(32).fill(9) });
    const { deps: wired } = deps(world);
    await expect(
      upgradeAccount(handle, secrets, { ...request, funderUrl: null }, undefined, wired),
    ).rejects.toMatchObject({ code: 'repoint-failed', step: 'repoint' });
  });

  it('refuses when the name is not registered on this network', async () => {
    const world = chain({ target: null });
    const { deps: wired } = deps(world);
    await expect(
      upgradeAccount(handle, secrets, request, undefined, wired),
    ).rejects.toMatchObject({ code: 'repoint-failed' });
  });
});
