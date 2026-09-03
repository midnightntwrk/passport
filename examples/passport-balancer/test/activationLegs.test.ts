/**
 * Which half of an activation is still owed.
 *
 * Pinned to the 2026/09/03 acceptance: 13/13 registrations first-click, and
 * 4 of 13 Passports with no NIGHT, because an entry the asset leg wrote first
 * made the NIGHT leg read as done.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activationLegs, shouldRetryGrant } from '../src/activationLegs.js';

const base = {
  heldNight: 0n,
  heldAsset: 0n,
  assetSupported: true,
  grantAtomic: 2_000n,
  assetGrant: 100n,
};

describe('which legs an activation still owes', () => {
  it('a fresh account owes both', () => {
    assert.deepEqual(activationLegs({ ...base, previous: null }), {
      nightNeeded: true,
      assetNeeded: true,
    });
  });

  it('an entry with mUSD and NO NIGHT transaction still owes the NIGHT — the 4-of-13 case', () => {
    assert.deepEqual(
      activationLegs({ ...base, previous: { asset: { depositTx: '0xmusd' } } }),
      { nightNeeded: true, assetNeeded: false },
    );
    assert.deepEqual(
      activationLegs({ ...base, previous: { txHash: null, asset: { depositTx: '0xmusd' } } }),
      { nightNeeded: true, assetNeeded: false },
    );
  });

  it('an entry with the NIGHT transaction and no asset owes the mUSD only', () => {
    assert.deepEqual(activationLegs({ ...base, previous: { txHash: '0xnight' } }), {
      nightNeeded: false,
      assetNeeded: true,
    });
  });

  it('both recorded owes nothing, whatever the balances say', () => {
    assert.deepEqual(
      activationLegs({ ...base, previous: { txHash: '0xnight', asset: { depositTx: '0xmusd' } } }),
      { nightNeeded: false, assetNeeded: false },
    );
  });

  it('a balance already there covers a leg nobody recorded, whoever paid it', () => {
    assert.deepEqual(activationLegs({ ...base, previous: null, heldNight: 2_000n, heldAsset: 100n }), {
      nightNeeded: false,
      assetNeeded: false,
    });
  });

  it('no asset support means no asset leg', () => {
    assert.equal(activationLegs({ ...base, previous: null, assetSupported: false }).assetNeeded, false);
  });
});

describe('whether the sponsor tries a failed grant again itself', () => {
  it('yes for what the chain may do differently next time', () => {
    for (const code of ['deposit-failed', 'confirmation-failed', 'register-rejected']) {
      assert.equal(shouldRetryGrant(code), true, code);
    }
  });

  it('no for what the caller has to fix', () => {
    assert.equal(shouldRetryGrant('not-an-account'), false);
    assert.equal(shouldRetryGrant('indexer-unreachable'), false);
  });
});
