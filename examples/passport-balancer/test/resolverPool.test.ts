/**
 * The resolver-leaf pool: its ledger, its gate, its consumption, and the
 * fallback when the shelf is bare.
 *
 * WHAT THESE GUARD
 * ----------------
 * One promise, stated four ways. A pre-deployed leaf costs 1.37e16 Specks and a
 * block, and the whole reason for holding a shelf of them is that the user
 * should never pay that wait. The filler is therefore the lowest-priority thing
 * the service does, and "lowest priority" here is not a queue position — it is
 * a list of preconditions, every one of which has to be able to say no.
 *
 * So the gate is pure and every pause reason is asserted by name, including the
 * one the live sponsor sits at today: two DUST coins means one fee-capable
 * coin, which means paused, which is CORRECT. A future change that quietly
 * relaxed that gate would take the sponsor's last usable coin to stock a shelf
 * and put fee sponsorship on the floor for a block, and it would do it during a
 * demo. The assertion below is what stops it.
 *
 * No chain, no wallet, no proof server: the gate takes facts and a clock, and
 * the ledger is a real `JsonLedger` in a temporary directory, because atomic
 * write-and-rename is the thing being trusted and a mock of it proves nothing.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { JsonLedger, type ResolverEntry } from '../src/ledgers.js';
import {
  FEE_CAPABLE_SPECKS,
  MIN_DEPLOY_INTERVAL_MS,
  MIN_FEE_CAPABLE_COINS,
  QUIET_MS,
  assessResolverPool,
  resolverLedgerFrom,
  startResolverPool,
  type ResolverLedger,
  type ResolverPoolFacts,
} from '../src/resolverPool.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const NOW = 1_800_000_000_000;

/** Every gate open. Each test closes exactly one, so the reason is unambiguous. */
function openGates(overrides: Partial<ResolverPoolFacts> = {}): ResolverPoolFacts {
  return {
    now: NOW,
    depth: 60,
    target: 100,
    floor: 50,
    verdict: 'healthy',
    reservationBooked: false,
    feeCapableCoins: 2,
    proofInFlight: false,
    lastRequestAt: NOW - 10 * QUIET_MS,
    lastDeployAt: NOW - 10 * MIN_DEPLOY_INTERVAL_MS,
    deploying: false,
    ...overrides,
  };
}

/** An in-memory shelf, so the gating tests need no directory. */
function shelf(entries: ResolverEntry[] = []): ResolverLedger & { all: ResolverEntry[] } {
  const all = [...entries];
  return {
    all,
    depth: () => all.filter((entry) => entry.consumedAt === undefined).length,
    oldestFree: () => {
      const index = all.findIndex((entry) => entry.consumedAt === undefined);
      return index < 0 ? null : { key: all[index]!.address, entry: all[index]! };
    },
    record: async (key, entry) => {
      const index = all.findIndex((held) => held.address === key);
      if (index < 0) all.push(entry);
      else all[index] = entry;
    },
  };
}

function leaf(suffix: string): ResolverEntry {
  return {
    address: `${'0'.repeat(60)}${suffix.padStart(4, '0')}`,
    deployTx: `deploy-${suffix}`,
    deployedAt: new Date(NOW).toISOString(),
  };
}

const temporaryDirectories: string[] = [];
after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'resolver-pool-'));
  temporaryDirectories.push(directory);
  return directory;
}

/* -------------------------------------------------------------------------- */
/* The ledger                                                                 */
/* -------------------------------------------------------------------------- */

describe('the resolver ledger', () => {
  it('writes resolvers-<network>.json beside the other ledgers and reads it back', async () => {
    const directory = await stateDirectory();
    const ledger = await JsonLedger.open<ResolverEntry>(directory, 'stagenet', 'resolvers');
    await ledger.record('aa', { address: 'aa', deployTx: 'tx-aa', deployedAt: 'then' });

    const raw = JSON.parse(
      await readFile(join(directory, 'resolvers-stagenet.json'), 'utf8'),
    ) as Record<string, ResolverEntry>;
    assert.deepEqual(raw.aa, { address: 'aa', deployTx: 'tx-aa', deployedAt: 'then' });

    /* Reopened rather than reused: the point of the file is that a restart
       does not forget the leaves it has already paid for. */
    const reopened = await JsonLedger.open<ResolverEntry>(directory, 'stagenet', 'resolvers');
    assert.equal(reopened.get('aa')?.deployTx, 'tx-aa');
  });

  it('counts only unconsumed leaves as depth, and hands out the oldest first', async () => {
    const directory = await stateDirectory();
    const ledger = await JsonLedger.open<ResolverEntry>(directory, 'stagenet', 'resolvers');
    await ledger.record('one', { address: 'one', deployTx: 't1', deployedAt: 'a' });
    await ledger.record('two', { address: 'two', deployTx: 't2', deployedAt: 'b' });
    const adapted = resolverLedgerFrom(ledger);
    assert.equal(adapted.depth(), 2);
    assert.equal(adapted.oldestFree()?.key, 'one');

    await ledger.record('one', {
      address: 'one',
      deployTx: 't1',
      deployedAt: 'a',
      consumedBy: 'somebody',
      consumedAt: 'c',
    });
    assert.equal(adapted.depth(), 1);
    assert.equal(adapted.oldestFree()?.key, 'two');
  });
});

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

describe('the filler gate', () => {
  it('deploys when every precondition holds', () => {
    const verdict = assessResolverPool(openGates());
    assert.equal(verdict.deploy, true);
    assert.equal(verdict.state, 'filling');
    assert.equal(verdict.reason, 'filling to 100');
  });

  it('says so when the shelf is below its floor, and still only deploys one', () => {
    const verdict = assessResolverPool(openGates({ depth: 12 }));
    assert.equal(verdict.deploy, true);
    assert.equal(verdict.reason, 'below the floor of 50, filling to 100');
  });

  it('is idle, not paused, when the shelf is full', () => {
    const verdict = assessResolverPool(openGates({ depth: 100 }));
    assert.deepEqual(verdict, {
      state: 'idle',
      reason: 'the pool holds 100 of 100 leaves',
      deploy: false,
    });
  });

  it('is idle when the pool is switched off', () => {
    const verdict = assessResolverPool(openGates({ target: 0, depth: 0 }));
    assert.equal(verdict.state, 'idle');
    assert.equal(verdict.reason, 'the pool is switched off');
    assert.equal(verdict.deploy, false);
  });

  it('reports a deploy already running as filling and starts no second one', () => {
    const verdict = assessResolverPool(openGates({ deploying: true }));
    assert.deepEqual(verdict, {
      state: 'filling',
      reason: 'a leaf is being deployed',
      deploy: false,
    });
  });

  /* Every unhealthy verdict, by name. The list is the health module's own
     union, and a new verdict added there without a decision here would
     otherwise default to whatever the last branch happened to do. */
  for (const verdict of ['busy', 'settling', 'degraded', 'wedged', 'dust-wedged'] as const) {
    it(`pauses while health is ${verdict}`, () => {
      const assessment = assessResolverPool(openGates({ verdict }));
      assert.deepEqual(assessment, {
        state: 'paused',
        reason: `health is ${verdict}`,
        deploy: false,
      });
    });
  }

  it('pauses before the watchdog has said anything at all', () => {
    const assessment = assessResolverPool(openGates({ verdict: null }));
    assert.equal(assessment.state, 'paused');
    assert.equal(assessment.reason, 'no health verdict yet');
    assert.equal(assessment.deploy, false);
  });

  it('pauses while anything else holds or waits for the wallet', () => {
    const assessment = assessResolverPool(openGates({ reservationBooked: true }));
    assert.deepEqual(assessment, {
      state: 'paused',
      reason: 'the wallet is booked',
      deploy: false,
    });
  });

  /* THE LIVE READING. The deployed sponsor holds two DUST coins, one of which
     is fee-capable, and the correct behaviour there is to do nothing at all. */
  it('pauses on one fee-capable coin, which is the deployed sponsor today', () => {
    const assessment = assessResolverPool(openGates({ feeCapableCoins: 1 }));
    assert.deepEqual(assessment, {
      state: 'paused',
      reason: 'one fee-capable coin',
      deploy: false,
    });
  });

  it('pauses on no fee-capable coin', () => {
    assert.equal(assessResolverPool(openGates({ feeCapableCoins: 0 })).reason, 'no fee-capable coin');
  });

  it('needs a coin to spend AND a coin to leave behind', () => {
    assert.equal(MIN_FEE_CAPABLE_COINS, 2);
    assert.equal(assessResolverPool(openGates({ feeCapableCoins: 2 })).deploy, true);
  });

  it('pauses while a proof this service asked for is outstanding', () => {
    const assessment = assessResolverPool(openGates({ proofInFlight: true }));
    assert.deepEqual(assessment, {
      state: 'paused',
      reason: 'a proof is in flight',
      deploy: false,
    });
  });

  it('pauses until a full minute has passed since anybody asked for anything', () => {
    const justInside = assessResolverPool(openGates({ lastRequestAt: NOW - (QUIET_MS - 1) }));
    assert.deepEqual(justInside, {
      state: 'paused',
      reason: 'a request landed in the last 60 s',
      deploy: false,
    });
    assert.equal(assessResolverPool(openGates({ lastRequestAt: NOW - QUIET_MS })).deploy, true);
  });

  it('never deploys two leaves inside a minute', () => {
    const tooSoon = assessResolverPool(
      openGates({ lastDeployAt: NOW - (MIN_DEPLOY_INTERVAL_MS - 1) }),
    );
    assert.deepEqual(tooSoon, {
      state: 'paused',
      reason: 'a leaf was deployed in the last 60 s',
      deploy: false,
    });
    assert.equal(
      assessResolverPool(openGates({ lastDeployAt: NOW - MIN_DEPLOY_INTERVAL_MS })).deploy,
      true,
    );
  });

  it('reports the most fundamental obstruction, not the last one it found', () => {
    /* Wedged AND booked AND short of coins. An operator reading this needs to
       be told about the wedge, not about the coin count it caused. */
    const assessment = assessResolverPool(
      openGates({ verdict: 'dust-wedged', reservationBooked: true, feeCapableCoins: 0 }),
    );
    assert.equal(assessment.reason, 'health is dust-wedged');
  });

  it('puts the fee floor at 1.5e16 Specks', () => {
    assert.equal(FEE_CAPABLE_SPECKS, 15_000_000_000_000_000n);
  });
});

/* -------------------------------------------------------------------------- */
/* The filler                                                                 */
/* -------------------------------------------------------------------------- */

describe('the filler', () => {
  it('deploys one leaf per tick and records it on the shelf', async () => {
    const ledger = shelf();
    const deploys: number[] = [];
    let clock = NOW;
    const pool = startResolverPool({
      ledger,
      target: 100,
      floor: 50,
      intervalMs: 0,
      now: () => clock,
      facts: async () => ({
        verdict: 'healthy',
        reservationBooked: false,
        feeCapableCoins: 2,
        proofInFlight: false,
        lastRequestAt: 0,
      }),
      deploy: async () => {
        deploys.push(clock);
        return { address: `leaf-${deploys.length}`, deployTx: `tx-${deploys.length}` };
      },
      log: () => undefined,
      warn: () => undefined,
    });

    assert.equal((await pool.tick()).deploy, true);
    assert.equal(ledger.depth(), 1);
    assert.equal(ledger.all[0]?.deployTx, 'tx-1');

    /* The very next tick, on the same clock: refused by the one-a-minute floor
       rather than by anything about the shelf. */
    const immediate = await pool.tick();
    assert.equal(immediate.deploy, false);
    assert.equal(immediate.reason, 'a leaf was deployed in the last 60 s');
    assert.equal(deploys.length, 1);

    clock += MIN_DEPLOY_INTERVAL_MS;
    assert.equal((await pool.tick()).deploy, true);
    assert.equal(deploys.length, 2);
    assert.equal(ledger.depth(), 2);
    pool.stop();
  });

  it('holds the one-a-minute floor after a FAILED deploy too', async () => {
    const ledger = shelf();
    let attempts = 0;
    const pool = startResolverPool({
      ledger,
      target: 100,
      floor: 50,
      intervalMs: 0,
      now: () => NOW,
      facts: async () => ({
        verdict: 'healthy',
        reservationBooked: false,
        feeCapableCoins: 4,
        proofInFlight: false,
        lastRequestAt: 0,
      }),
      deploy: async () => {
        attempts += 1;
        throw new Error('the node refused the leaf');
      },
      log: () => undefined,
      warn: () => undefined,
    });

    await pool.tick();
    assert.equal(attempts, 1);
    assert.equal(ledger.depth(), 0, 'a failed deploy must not put a leaf on the shelf');
    /* A failed deploy still cost a proof and possibly a coin. Retrying it on
       the next tick is how a broken artefact becomes a spend loop. */
    assert.equal((await pool.tick()).reason, 'a leaf was deployed in the last 60 s');
    assert.equal(attempts, 1);
    pool.stop();
  });

  it('pauses rather than deploys when the facts cannot be read', async () => {
    const ledger = shelf();
    let deployed = false;
    const pool = startResolverPool({
      ledger,
      target: 100,
      floor: 50,
      intervalMs: 0,
      now: () => NOW,
      facts: async () => {
        throw new Error('the wallet did not answer');
      },
      deploy: async () => {
        deployed = true;
        return { address: 'never', deployTx: 'never' };
      },
      log: () => undefined,
      warn: () => undefined,
    });
    const verdict = await pool.tick();
    assert.deepEqual(verdict, {
      state: 'paused',
      reason: 'the wallet could not be read',
      deploy: false,
    });
    assert.equal(deployed, false);
    pool.stop();
  });

  it('publishes depth, target, floor, state, reason, and the last deploy', async () => {
    const ledger = shelf([leaf('1'), leaf('2')]);
    const pool = startResolverPool({
      ledger,
      target: 100,
      floor: 50,
      intervalMs: 0,
      now: () => NOW,
      facts: async () => ({
        verdict: 'healthy',
        reservationBooked: false,
        feeCapableCoins: 1,
        proofInFlight: false,
        lastRequestAt: 0,
      }),
      deploy: async () => ({ address: 'never', deployTx: 'never' }),
      log: () => undefined,
      warn: () => undefined,
    });

    assert.deepEqual(pool.snapshot(), {
      depth: 2,
      target: 100,
      floor: 50,
      state: 'idle',
      reason: 'not looked yet',
      lastDeployAt: null,
    });

    await pool.tick();
    assert.deepEqual(pool.snapshot(), {
      depth: 2,
      target: 100,
      floor: 50,
      state: 'paused',
      reason: 'one fee-capable coin',
      lastDeployAt: null,
    });
    pool.stop();
  });
});

/* -------------------------------------------------------------------------- */
/* Consumption, and the fallback                                              */
/* -------------------------------------------------------------------------- */

describe('taking a leaf off the shelf', () => {
  function idlePool(ledger: ResolverLedger) {
    return startResolverPool({
      ledger,
      target: 100,
      floor: 50,
      intervalMs: 0,
      now: () => NOW,
      facts: async () => ({
        verdict: 'healthy',
        reservationBooked: true,
        feeCapableCoins: 2,
        proofInFlight: false,
        lastRequestAt: NOW,
      }),
      deploy: async () => ({ address: 'never', deployTx: 'never' }),
      log: () => undefined,
      warn: () => undefined,
    });
  }

  it('marks a leaf consumed the instant it is taken, not when the binding lands', async () => {
    const ledger = shelf([leaf('1')]);
    const pool = idlePool(ledger);
    const taken = await pool.take('account-contract-aa');
    assert.ok(taken);
    assert.equal(taken.consumedBy, 'account-contract-aa');
    assert.equal(typeof taken.consumedAt, 'string');
    assert.equal(ledger.depth(), 0);
    assert.equal(ledger.all[0]?.consumedBy, 'account-contract-aa');
    pool.stop();
  });

  it('never hands the same leaf to two registrations', async () => {
    const ledger = shelf([leaf('1'), leaf('2')]);
    const pool = idlePool(ledger);
    /* Started together, deliberately: this is the race the instant marking
       exists to lose. */
    const [first, second] = await Promise.all([pool.take('aa'), pool.take('bb')]);
    assert.ok(first && second);
    assert.notEqual(first.address, second.address);
    assert.equal(ledger.depth(), 0);
    pool.stop();
  });

  it('returns null on a bare shelf, which is the caller’s cue to deploy its own', async () => {
    const ledger = shelf();
    const pool = idlePool(ledger);
    assert.equal(await pool.take('aa'), null);
    /* And again — a bare shelf is not an error state and does not latch. */
    assert.equal(await pool.take('bb'), null);
    pool.stop();
  });

  it('empties, and then falls back, once its last leaf is spent', async () => {
    const ledger = shelf([leaf('1')]);
    const pool = idlePool(ledger);
    assert.ok(await pool.take('aa'));
    assert.equal(await pool.take('bb'), null, 'the fallback path must take over silently');
    assert.equal(pool.snapshot().depth, 0);
    pool.stop();
  });

  it('survives a restart with its consumption intact', async () => {
    const directory = await stateDirectory();
    const ledger = await JsonLedger.open<ResolverEntry>(directory, 'stagenet', 'resolvers');
    await ledger.record('one', { address: 'one', deployTx: 't1', deployedAt: 'a' });
    await ledger.record('two', { address: 'two', deployTx: 't2', deployedAt: 'b' });
    const pool = idlePool(resolverLedgerFrom(ledger));
    const taken = await pool.take('aa');
    assert.equal(taken?.address, 'one');
    pool.stop();

    const reopened = await JsonLedger.open<ResolverEntry>(directory, 'stagenet', 'resolvers');
    const restarted = idlePool(resolverLedgerFrom(reopened));
    assert.equal(restarted.snapshot().depth, 1);
    assert.equal((await restarted.take('bb'))?.address, 'two');
    restarted.stop();
  });
});
