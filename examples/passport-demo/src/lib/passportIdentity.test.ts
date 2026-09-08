/**
 * What a Passport is allowed to call itself, and when it is allowed to answer.
 *
 * Both rules were captured off production on 2026/09/08 getting this wrong: a
 * Passport with a passkey and nothing else answered an app with
 * `displayName: 'Midnight Passport'` — the label the passkey was enrolled
 * under, presented as the user's own name — and the sheet that asked for
 * permission to do it had armed over the Welcome screen, with a backdrop across
 * the button that would have given the Passport a real name.
 */

import { describe, expect, it } from 'vitest';

import {
  PASSPORT_SETUP_WAITING_MESSAGE,
  passportIsSetUp,
  shareableDisplayName,
  type PassportNameRecord,
} from './passportIdentity.js';

const registered: PassportNameRecord = { domain: 'alice.night', status: 'registered' };

describe('shareableDisplayName', () => {
  it('is the .night name this Passport holds', () => {
    expect(shareableDisplayName(registered)).toBe('alice.night');
  });

  it('is nothing at all where there is no record', () => {
    /* The two absences a caller can hand over: a network with no record, and a
       build configured for no public network. Neither is a name. */
    expect(shareableDisplayName(null)).toBeNull();
    expect(shareableDisplayName(undefined)).toBeNull();
  });

  it('never answers with the device label, whatever the record says', () => {
    /* The regression, stated as the thing it must never do again. There is no
       input to this function that produces the enrolled passkey's label,
       because the label is not one of its inputs any more. */
    expect(shareableDisplayName({ domain: 'Midnight Passport', status: 'queued' })).toBeNull();
    expect(shareableDisplayName({ domain: 'Midnight Passport', status: 'failed' })).toBeNull();
  });

  it('refuses a claim that has not landed', () => {
    /* A record exists from the moment a claim is attempted. Offering a queued
       or failed name would let an app record a name the registry does not
       resolve, over a Passport that does not hold it. */
    expect(shareableDisplayName({ domain: 'alice.night', status: 'queued' })).toBeNull();
    expect(shareableDisplayName({ domain: 'alice.night', status: 'failed' })).toBeNull();
  });

  it('treats a blank name as no name', () => {
    expect(shareableDisplayName({ domain: '', status: 'registered' })).toBeNull();
    expect(shareableDisplayName({ domain: '   ', status: 'registered' })).toBeNull();
    /* And a real name is handed over trimmed rather than refused. */
    expect(shareableDisplayName({ domain: '  bob.night  ', status: 'registered' })).toBe(
      'bob.night',
    );
  });
});

describe('passportIsSetUp', () => {
  it('is satisfied by a registered name on its own', () => {
    /* A name cannot be registered without the account beneath it, so the name
       is sufficient evidence of both. */
    expect(
      passportIsSetUp({
        registeredName: 'alice.night',
        accountDeployed: false,
        nameStepSettled: false,
      }),
    ).toBe(true);
  });

  it('is satisfied by a deployed account once the name step has been settled', () => {
    /* Somebody who left the name step behind still has an identity an app can
       key on: the account-custody contract. */
    expect(
      passportIsSetUp({ registeredName: null, accountDeployed: true, nameStepSettled: true }),
    ).toBe(true);
  });

  it('is not satisfied by a passkey and a wallet', () => {
    /* THE DEFECT. Every one of these is a Passport mid-setup, and a consent
       sheet over any of them is a backdrop over the user's own task. */
    expect(
      passportIsSetUp({ registeredName: null, accountDeployed: false, nameStepSettled: false }),
    ).toBe(false);
    expect(
      passportIsSetUp({ registeredName: null, accountDeployed: true, nameStepSettled: false }),
    ).toBe(false);
    expect(
      passportIsSetUp({ registeredName: null, accountDeployed: false, nameStepSettled: true }),
    ).toBe(false);
  });
});

describe('the waiting message', () => {
  it('says a thing is waiting and what ends the wait', () => {
    expect(PASSPORT_SETUP_WAITING_MESSAGE).toBe(
      'An app is waiting for your Passport. Finish setting up and it will be shared.',
    );
  });

  it('names nothing the reader cannot act on', () => {
    for (const word of ['origin', 'consent', 'request', 'timeout', 'protocol', 'profile']) {
      expect(PASSPORT_SETUP_WAITING_MESSAGE.toLowerCase()).not.toContain(word);
    }
  });
});
