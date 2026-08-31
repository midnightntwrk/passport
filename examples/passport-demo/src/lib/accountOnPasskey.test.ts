/**
 * Drills for the rule that decides when the account reaches the passkey.
 *
 * What is worth holding to here is not that three functions return objects. It
 * is the two ways this rule can be wrong, both of which somebody has already
 * met:
 *
 *   - it can cost a ceremony nobody asked for. The claim used to write the
 *     blob itself, which is a whole user-verified assertion, and the product
 *     owner met it as a passkey prompt on a finished Home screen. So the note
 *     must never be anything but a note, and the write must only ever be
 *     OFFERED to an assertion that is already happening;
 *   - it can quietly stop writing. A ride-along that is retired on the first
 *     refusal, or a note that is marked written when nothing was written,
 *     means a second device never finds the Passport and nothing says why.
 *
 * Each test below is one of those two.
 */

import { describe, expect, it } from 'vitest';

import {
  accountToRemember,
  pendingAccountBlob,
  settledAccountOnPasskey,
  type AccountOnPasskeyProfile,
} from './accountOnPasskey.js';

const ACCOUNT = { address: 'a'.repeat(64), network: 'stagenet' };

describe('accountToRemember', () => {
  it('notes an account this Passport has never recorded', () => {
    expect(accountToRemember({}, ACCOUNT, 'alice')).toEqual({
      address: ACCOUNT.address,
      network: ACCOUNT.network,
      alias: 'alice',
      written: false,
    });
  });

  it('notes an account with no name, without inventing an empty one', () => {
    /* A deploy can land before any name does. `alias: undefined` in the blob
       would serialise as a key with no value; absent is what the format
       means. */
    expect(accountToRemember({}, ACCOUNT)).toEqual({
      address: ACCOUNT.address,
      network: ACCOUNT.network,
      written: false,
    });
  });

  it('has nothing to say about an account already recorded', () => {
    /* Returning a fresh note here would reset `written` on every claim screen
       render and put the blob back on the queue for ever. */
    const profile: AccountOnPasskeyProfile = {
      accountOnPasskey: { ...ACCOUNT, alias: 'alice', written: true },
    };
    expect(accountToRemember(profile, ACCOUNT, 'alice')).toBeNull();
  });

  it('re-notes when a second name lands on the same account', () => {
    /* The blob carries the name. A name that has changed makes the bytes on
       the credential stale, so the note goes back to unwritten. */
    const profile: AccountOnPasskeyProfile = {
      accountOnPasskey: { ...ACCOUNT, alias: 'alice', written: true },
    };
    expect(accountToRemember(profile, ACCOUNT, 'bob')).toEqual({
      ...ACCOUNT,
      alias: 'bob',
      written: false,
    });
  });

  it('re-notes when the account itself changes', () => {
    const profile: AccountOnPasskeyProfile = {
      accountOnPasskey: { ...ACCOUNT, written: true },
    };
    expect(accountToRemember(profile, { ...ACCOUNT, network: 'preview' })).toEqual({
      address: ACCOUNT.address,
      network: 'preview',
      written: false,
    });
  });
});

describe('pendingAccountBlob', () => {
  it('offers the note as a version-1 blob', () => {
    const profile: AccountOnPasskeyProfile = {
      accountOnPasskey: { ...ACCOUNT, alias: 'alice', written: false },
    };
    expect(pendingAccountBlob(profile)).toEqual({
      v: 1,
      acc: { address: ACCOUNT.address, network: ACCOUNT.network },
      alias: 'alice',
    });
  });

  it('omits the name when there is none, rather than carrying an empty one', () => {
    const profile: AccountOnPasskeyProfile = {
      accountOnPasskey: { ...ACCOUNT, written: false },
    };
    expect(pendingAccountBlob(profile)).toEqual({
      v: 1,
      acc: { address: ACCOUNT.address, network: ACCOUNT.network },
    });
  });

  it('offers nothing for a Passport with no account yet', () => {
    /* The assertion must keep its READ here: this is precisely the device that
       may have to recover an account it has never seen. */
    expect(pendingAccountBlob({})).toBeNull();
    expect(pendingAccountBlob(null)).toBeNull();
    expect(pendingAccountBlob(undefined)).toBeNull();
  });

  it('offers nothing once the note has reached the credential', () => {
    expect(
      pendingAccountBlob({ accountOnPasskey: { ...ACCOUNT, written: true } }),
    ).toBeNull();
  });

  it('offers nothing on a credential the platform said cannot hold a blob', () => {
    /* Not a saving of effort — a saving of the READ. Spending the largeBlob
       slice on a write that the platform has already said will not happen
       gives up the only thing that slice is good for. */
    expect(
      pendingAccountBlob({
        largeBlobSupported: false,
        accountOnPasskey: { ...ACCOUNT, written: false },
      }),
    ).toBeNull();
  });
});

describe('settledAccountOnPasskey', () => {
  const pending: AccountOnPasskeyProfile = {
    accountOnPasskey: { ...ACCOUNT, alias: 'alice', written: false },
  };

  it('marks the note written, and the credential proved capable', () => {
    expect(settledAccountOnPasskey(pending, 'written')).toEqual({
      accountOnPasskey: { ...ACCOUNT, alias: 'alice', written: true },
      largeBlobSupported: true,
    });
  });

  it('retires the ride-along on a platform with no largeBlob at all', () => {
    /* Permanent, and the only permanent answer here: asking again can only
       cost the read on every future sign-in for nothing. */
    expect(settledAccountOnPasskey(pending, 'unsupported')).toEqual({
      largeBlobSupported: false,
    });
  });

  it('records NOTHING when the authenticator merely refused', () => {
    /* Retryable. Writing this down as an answer would retire a capability over
       one bad attempt, and the note would never be written again. */
    expect(settledAccountOnPasskey(pending, 'refused')).toBeNull();
  });

  it('records nothing when the assertion carried no write', () => {
    expect(settledAccountOnPasskey(pending, null)).toBeNull();
  });

  it('records nothing when there was no note to settle', () => {
    expect(settledAccountOnPasskey({}, 'written')).toBeNull();
  });
});
