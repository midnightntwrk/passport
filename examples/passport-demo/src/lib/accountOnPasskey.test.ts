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
  ACCOUNT_RECHECK_ATTEMPTS,
  accountFromBlob,
  accountRecheckDelayMs,
  accountToRemember,
  aliasFromRecoveredAccount,
  learnedLargeBlobSupport,
  mayUseLargeBlob,
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

describe('mayUseLargeBlob', () => {
  /* THE ANDROID PROMPT THAT NEVER FINISHED (2026/09/04).
     Google Password Manager's passkeys implement PRF and not largeBlob, and
     Chrome on Android narrows its account sheet to credentials that can satisfy
     the extensions a request asks for. An assertion that asks for a largeBlob
     slice against such a passkey therefore raises a sheet with nothing
     selectable in it, and the sheet does not settle — which is what the
     reviewer met, on an ordinary sign-in, days after the claim that owed the
     write. This rule is what stops the app asking. */

  it('lets an assertion ask when nothing has said otherwise', () => {
    /* Absent is "nobody has told us", not "no". A browser that has never seen
       an answer must still be allowed to find one out — that is how the
       credential's own read discovers it. */
    expect(mayUseLargeBlob({})).toBe(true);
    expect(mayUseLargeBlob(null)).toBe(true);
    expect(mayUseLargeBlob(undefined)).toBe(true);
  });

  it('lets an assertion ask when the platform said the credential can hold one', () => {
    expect(mayUseLargeBlob({ largeBlobSupported: true })).toBe(true);
  });

  it('refuses to ask once the platform has said the credential cannot', () => {
    /* The one answer that stops it, and it is a definite answer rather than an
       inference from a failure: enrolment's own `largeBlob.supported`, a write
       that came back unsupported, or a read whose results bag had no largeBlob
       slice at all. */
    expect(mayUseLargeBlob({ largeBlobSupported: false })).toBe(false);
  });
});

describe('learnedLargeBlobSupport', () => {
  it('writes down a definite answer the profile did not have', () => {
    expect(learnedLargeBlobSupport({}, false)).toEqual({ largeBlobSupported: false });
    expect(learnedLargeBlobSupport({}, true)).toEqual({ largeBlobSupported: true });
  });

  it('learns nothing from an assertion that never asked', () => {
    /* `null` is the assertion saying it did not send a largeBlob slice, which
       is not evidence about the credential and must never be recorded as any.
       Writing it down as `false` would retire the capability on the strength of
       a question nobody put. */
    expect(learnedLargeBlobSupport({}, null)).toBeNull();
    expect(learnedLargeBlobSupport({}, undefined)).toBeNull();
  });

  it('does not rewrite an answer the profile already holds', () => {
    /* A sign-in happens on every visit and this answer never changes, so a
       patch here would be a storage write and a re-render per session for a
       value nobody read differently. */
    expect(learnedLargeBlobSupport({ largeBlobSupported: false }, false)).toBeNull();
    expect(learnedLargeBlobSupport({ largeBlobSupported: true }, true)).toBeNull();
  });

  it('lets a later answer correct an earlier one', () => {
    /* Not symmetrical with the rule above and deliberately so: the two answers
       come from different ceremonies, and a credential that has just PROVED it
       can hold a blob outranks whatever enrolment guessed. */
    expect(learnedLargeBlobSupport({ largeBlobSupported: false }, true)).toEqual({
      largeBlobSupported: true,
    });
    expect(learnedLargeBlobSupport({ largeBlobSupported: true }, false)).toEqual({
      largeBlobSupported: false,
    });
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

/**
 * Drills for the other direction: what a blob READ off a passkey is worth.
 *
 * The defect these hold the line on was reproduced on 2026/09/03. A browser
 * with its site data cleared signed in with the passkey that held the account,
 * the one indexer read did not answer, and the app kept nothing at all — so the
 * user was shown the name step over an account that already existed and already
 * had a name. Every test below is one of the two ways to be wrong about that:
 * throwing away evidence, or believing it over this device's own witness.
 */
describe('accountFromBlob', () => {
  const BLOB = {
    v: 1 as const,
    acc: { address: 'b'.repeat(64), network: 'stagenet' },
    alias: 'passportwalk',
  };
  const ON_STAGENET = {
    walletNetwork: 'stagenet',
    localRecord: null,
    hasLocalAlias: false,
  };

  it('adopts an unconfirmed account rather than discarding it', () => {
    // The reported failure, in one assertion: one read that did not answer
    // used to mean nothing was kept and the user met the name step.
    expect(accountFromBlob(BLOB, ON_STAGENET, 'unconfirmed')).toEqual({
      kind: 'adopt-checking',
      account: { address: BLOB.acc.address, network: 'stagenet', alias: 'passportwalk' },
    });
  });

  it('adopts an account the chain has answered for', () => {
    expect(accountFromBlob(BLOB, ON_STAGENET, 'confirmed')).toEqual({
      kind: 'adopt-confirmed',
      account: { address: BLOB.acc.address, network: 'stagenet', alias: 'passportwalk' },
    });
  });

  it('restores no name when the blob carries none', () => {
    const decision = accountFromBlob(
      { v: 1, acc: BLOB.acc },
      ON_STAGENET,
      'confirmed',
    );
    expect(decision).toEqual({
      kind: 'adopt-confirmed',
      account: { address: BLOB.acc.address, network: 'stagenet' },
    });
  });

  it('leaves a name this browser watched being registered alone', () => {
    const decision = accountFromBlob(BLOB, { ...ON_STAGENET, hasLocalAlias: true }, 'confirmed');
    expect(decision).toEqual({
      kind: 'adopt-confirmed',
      account: { address: BLOB.acc.address, network: 'stagenet' },
    });
  });

  it('has nothing to do when this device already holds the same account', () => {
    expect(
      accountFromBlob(BLOB, { ...ON_STAGENET, localRecord: { address: BLOB.acc.address } }, 'confirmed'),
    ).toEqual({ kind: 'keep-local' });
  });

  it('keeps this device’s own witness when the blob names another account', () => {
    expect(
      accountFromBlob(BLOB, { ...ON_STAGENET, localRecord: { address: 'c'.repeat(64) } }, 'confirmed'),
    ).toEqual({ kind: 'conflict', local: 'c'.repeat(64), blob: BLOB.acc.address });
  });

  it('treats a record with no address as no record at all', () => {
    // A failed deploy leaves a record behind with nothing to compare against;
    // it must not block the account the passkey is carrying.
    expect(accountFromBlob(BLOB, { ...ON_STAGENET, localRecord: {} }, 'unconfirmed')).toMatchObject({
      kind: 'adopt-checking',
    });
  });

  it('does nothing at all without a blob', () => {
    expect(accountFromBlob(null, ON_STAGENET, 'confirmed')).toEqual({ kind: 'nothing' });
  });

  it('refuses a blob for a network this session cannot read', () => {
    // "We cannot check" must never be dressed up as an answer either way.
    expect(accountFromBlob(BLOB, { ...ON_STAGENET, walletNetwork: 'testnet' }, 'confirmed')).toEqual({
      kind: 'nothing',
    });
  });

  it('refuses a blob when no wallet is open', () => {
    expect(accountFromBlob(BLOB, { ...ON_STAGENET, walletNetwork: null }, 'confirmed')).toEqual({
      kind: 'nothing',
    });
  });
});

describe('aliasFromRecoveredAccount', () => {
  const NOW = '2026-09-03T12:00:00.000Z';
  const CREDENTIAL = 'cred-a';

  it('restores the name against the account it was read beside, unconfirmed', () => {
    expect(
      aliasFromRecoveredAccount(
        CREDENTIAL,
        { address: 'b'.repeat(64), network: 'stagenet', alias: 'passportwalk' },
        NOW,
      ),
    ).toEqual({
      /* The credential the blob was read off. Since 2026/09/04 an alias record
         that does not say whose it is cannot be stored at all — see
         `../identity/aliasStore.ts` for the orphaned Passport that closes. */
      credentialId: CREDENTIAL,
      alias: 'passportwalk',
      domain: 'passportwalk.night',
      network: 'stagenet',
      status: 'registered',
      // No transaction ids: nothing happened on THIS device to have ids for.
      recovered: true,
      resolverTarget: 'contract',
      resolverTargetHex: 'b'.repeat(64),
      updatedAt: NOW,
    });
  });

  it('claims nothing about the registry, in either direction', () => {
    /* `false` is a restore's claim, and the surface that renders it answers
       with a restore's sentence — including a promise to re-check that nothing
       re-checks a recovered record. Absent is the state this record is in. */
    const record = aliasFromRecoveredAccount(
      CREDENTIAL,
      { address: 'b'.repeat(64), network: 'stagenet', alias: 'passportwalk' },
      NOW,
    );
    expect(record && 'registryConfirmed' in record).toBe(false);
  });

  it('restores nothing for an account with no name', () => {
    expect(
      aliasFromRecoveredAccount(CREDENTIAL, { address: 'b'.repeat(64), network: 'stagenet' }, NOW),
    ).toBeNull();
  });
});

describe('accountRecheckDelayMs', () => {
  it('doubles the wait between attempts', () => {
    expect(accountRecheckDelayMs(0)).toBe(2_000);
    expect(accountRecheckDelayMs(1)).toBe(4_000);
    expect(accountRecheckDelayMs(4)).toBe(32_000);
  });

  it('stops rather than polling an address that is not coming', () => {
    expect(accountRecheckDelayMs(ACCOUNT_RECHECK_ATTEMPTS)).toBeNull();
    expect(accountRecheckDelayMs(-1)).toBeNull();
  });
});
