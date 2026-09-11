/**
 * `POST /repoint-alias` — every gate, and the one it must never let through.
 *
 * This endpoint spends a proved transaction on behalf of somebody it cannot
 * authenticate, so what it is worth is entirely what its gates are worth. There
 * is no bearer token in this service — `/register-alias` and `/fund-account`
 * have none either — and the proof of control is a question only a passkey can
 * make the chain answer yes to: does the new account carry, as an ACTIVE
 * device, a commitment the old account also carries as an active device?
 *
 * The tests below are that claim, checked from both ends: a holder upgrading
 * their own Passport gets through, and every way of not being that holder is
 * turned away before a fee is spent. The three bounding reads — the name is
 * really on the old account, the leaf is really still this service's, the new
 * account is really an upgrade — are checked for the same reason: each one
 * narrows what a passing request can do.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RepointReadFailure, createRepointDesk, type RepointDeskDeps } from '../src/repoint.js';

const OLD = 'a1'.repeat(32);
const NEW = 'b2'.repeat(32);
const RESOLVER = 'e3'.repeat(32);
const SPONSOR_KEY = new Uint8Array(32).fill(1);
const HOLDER_KEY = new Uint8Array(32).fill(2);

interface Spent {
  label: string;
  contractAddress: string;
}

function desk(overrides: Partial<RepointDeskDeps> = {}) {
  const spends: Spent[] = [];
  const deps: RepointDeskDeps = {
    networkId: 'stagenet',
    available: true,
    unavailableReason: null,
    normaliseAccount: (value: string) => {
      const raw = value.trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
      if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error(`Invalid Midnight contract address: ${value}`);
      return raw;
    },
    normaliseAlias: (value: string) => {
      const label = value.trim().toLowerCase();
      if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new Error(`Not a Passport name: ${value}`);
      return label;
    },
    domainOf: (label: string) => `${label}.night`,
    resolve: async () => ({
      resolverAddress: RESOLVER,
      target: { kind: 'contract', hex: OLD },
    }),
    leafOwnerKey: async () => SPONSOR_KEY,
    sponsorOwnerKey: SPONSOR_KEY,
    activeDeviceCommitments: async () => new Set(['12345']),
    hasOneTxTransfer: async () => true,
    repoint: async (request) => {
      spends.push(request);
      return { resolverAddress: RESOLVER, updateTx: 'ff'.repeat(32), updateBlock: 407_010 };
    },
    ...overrides,
  };
  return { desk: createRepointDesk(deps), spends };
}

const body = { name: 'alice', newAccount: NEW, oldAccount: OLD, network: 'stagenet' };

describe('a holder moving their own name to their upgraded Passport', () => {
  it('is let through, and the name is reported pointing at the new account', async () => {
    const { desk: subject, spends } = desk();
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 200);
    assert.deepEqual(outcome.body.target, { kind: 'contract', address: NEW });
    assert.equal(outcome.body.domain, 'alice.night');
    assert.equal(outcome.body.alreadyPointing, false);
    assert.deepEqual(spends, [{ label: 'alice', contractAddress: NEW }]);
  });

  it('answers a retry after a landed move without spending again', async () => {
    const { desk: subject, spends } = desk({
      resolve: async () => ({ resolverAddress: RESOLVER, target: { kind: 'contract', hex: NEW } }),
    });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.alreadyPointing, true);
    assert.equal(spends.length, 0);
  });

  it('matches on ANY shared active device, not on a set being equal', async () => {
    /* A Passport with a second device registered has a bigger set on one side.
       What proves control is one commitment in common. */
    const { desk: subject, spends } = desk({
      activeDeviceCommitments: async (address) =>
        address === OLD ? new Set(['12345', '67890']) : new Set(['12345']),
    });
    assert.equal((await subject.repoint(body)).status, 200);
    assert.equal(spends.length, 1);
  });
});

describe('proof of control', () => {
  it('refuses a new account that shares no active device with the old one', async () => {
    const { desk: subject, spends } = desk({
      activeDeviceCommitments: async (address) =>
        address === OLD ? new Set(['12345']) : new Set(['99999']),
    });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 403);
    assert.equal(outcome.body.error, 'not-your-passport');
    assert.equal(spends.length, 0);
  });

  it('refuses when one of the two is not an account contract at all', async () => {
    const { desk: subject, spends } = desk({
      activeDeviceCommitments: async () => {
        throw new RepointReadFailure(
          400,
          'not-an-account',
          'The contract at that address is not a Passport account-custody contract.',
        );
      },
    });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 400);
    assert.equal(outcome.body.error, 'not-an-account');
    assert.equal(spends.length, 0);
  });

  it('says "we could not ask" rather than "no" when the indexer is down', async () => {
    const { desk: subject, spends } = desk({
      activeDeviceCommitments: async () => {
        throw new RepointReadFailure(503, 'indexer-unreachable', 'The indexer could not be read.');
      },
    });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 503);
    assert.equal(outcome.body.error, 'indexer-unreachable');
    assert.equal(spends.length, 0);
  });
});

describe('the three bounding reads', () => {
  it('refuses a name that is not currently on the old account', async () => {
    /* Without this, a holder who proved control of two of their OWN accounts
       could name somebody else's name and move it onto one of them. */
    const { desk: subject, spends } = desk({
      resolve: async () => ({
        resolverAddress: RESOLVER,
        target: { kind: 'contract', hex: 'cc'.repeat(32) },
      }),
    });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.error, 'target-moved');
    assert.equal(spends.length, 0);
  });

  it('refuses a name pointing at a wallet rather than at the old account', async () => {
    const { desk: subject } = desk({
      resolve: async () => ({
        resolverAddress: RESOLVER,
        target: { kind: 'wallet', hex: OLD },
      }),
    });
    assert.equal((await subject.repoint(body)).body.error, 'target-moved');
  });

  it('refuses a leaf the holder already owns, and says they can move it themselves', async () => {
    const { desk: subject, spends } = desk({ leafOwnerKey: async () => HOLDER_KEY });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.error, 'owner-is-user');
    assert.match(String(outcome.body.message), /can move it itself/);
    assert.equal(spends.length, 0);
  });

  it('refuses rather than guessing when the leaf’s owner cannot be read', async () => {
    const { desk: subject, spends } = desk({ leafOwnerKey: async () => null });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 503);
    assert.equal(outcome.body.error, 'registry-unreachable');
    assert.equal(spends.length, 0);
  });

  it('refuses a new account that is not an upgrade at all', async () => {
    const { desk: subject, spends } = desk({ hasOneTxTransfer: async () => false });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.error, 'not-an-upgrade');
    assert.equal(spends.length, 0);
  });

  it('does NOT refuse when the build cannot be read — the proof already held', async () => {
    const { desk: subject, spends } = desk({ hasOneTxTransfer: async () => null });
    assert.equal((await subject.repoint(body)).status, 200);
    assert.equal(spends.length, 1);
  });
});

describe('shape and availability', () => {
  it('refuses a body with no name', async () => {
    const { desk: subject } = desk();
    const outcome = await subject.repoint({ newAccount: NEW, oldAccount: OLD });
    assert.equal(outcome.status, 400);
    assert.equal(outcome.body.error, 'invalid-alias');
  });

  it('refuses a name that is not a Passport name', async () => {
    const { desk: subject } = desk();
    assert.equal((await subject.repoint({ ...body, name: 'not a name!' })).body.error, 'invalid-alias');
  });

  it('refuses an address that is not one', async () => {
    const { desk: subject } = desk();
    assert.equal(
      (await subject.repoint({ ...body, newAccount: 'nope' })).body.error,
      'invalid-contract-address',
    );
  });

  it('refuses a move to the address it is already on', async () => {
    const { desk: subject } = desk();
    const outcome = await subject.repoint({ ...body, newAccount: OLD });
    assert.equal(outcome.status, 400);
    assert.match(String(outcome.body.message), /nothing to move/);
  });

  it('refuses a request naming another network', async () => {
    const { desk: subject } = desk();
    const outcome = await subject.repoint({ ...body, network: 'preview' });
    assert.equal(outcome.status, 400);
    assert.equal(outcome.body.error, 'wrong-network');
  });

  it('refuses a name that is not registered', async () => {
    const { desk: subject, spends } = desk({ resolve: async () => null });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 404);
    assert.equal(outcome.body.error, 'name-not-registered');
    assert.equal(spends.length, 0);
  });

  it('refuses when the registry cannot be read', async () => {
    const { desk: subject } = desk({
      resolve: async () => {
        throw new Error('the indexer is down');
      },
    });
    assert.equal((await subject.repoint(body)).body.error, 'registry-unreachable');
  });

  it('says so plainly when the service cannot re-point at all', async () => {
    const { desk: subject, spends } = desk({
      available: false,
      unavailableReason: 'no .night registry is configured',
    });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 503);
    assert.equal(outcome.body.error, 'repoint-unsupported');
    assert.equal(spends.length, 0);
  });

  it('reports a refused spend as a refusal rather than crashing', async () => {
    const { desk: subject } = desk({
      repoint: async () => {
        throw new Error('the node refused the transaction');
      },
    });
    const outcome = await subject.repoint(body);
    assert.equal(outcome.status, 502);
    assert.equal(outcome.body.error, 'repoint-failed');
  });
});

describe('one at a time', () => {
  it('refuses a second move of the same name while the first is in the air', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: Spent[] = [];
    const { desk: subject } = desk({
      repoint: async (request) => {
        held.push(request);
        await gate;
        return { resolverAddress: RESOLVER, updateTx: 'ff'.repeat(32), updateBlock: 1 };
      },
    });
    const first = subject.repoint(body);
    /* Let the first request reach its spend before the second arrives. */
    await new Promise((resolve) => setImmediate(resolve));
    const second = await subject.repoint(body);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'repoint-in-flight');
    release();
    assert.equal((await first).status, 200);
    /* The second request never reached the spend — one proof, not two. */
    assert.equal(held.length, 1);
  });

  it('lets the name be asked for again once the first has finished', async () => {
    const { desk: subject, spends } = desk();
    await subject.repoint(body);
    await subject.repoint(body);
    assert.equal(spends.length, 2);
  });
});
