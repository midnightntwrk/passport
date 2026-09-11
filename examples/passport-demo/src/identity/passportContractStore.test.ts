/**
 * The `'submitted'` record, and the rules that stop it becoming a lie.
 *
 * The store's founding rule was that nothing is written here until the chain
 * has answered. That rule was written against one mistake — reporting an
 * account that does not exist — and on 2026/09/07 the opposite one turned out
 * to be the expensive one: a deploy that landed in block 359977 was remembered
 * nowhere, so a reopened Passport offered the name step with no account and one
 * claim away from a SECOND contract on a second sponsored fee.
 *
 * So the exception exists, and everything below is a way of keeping it an
 * exception: a submitted record must carry what a resume needs, it may not
 * borrow a stronger record's evidence, it must survive a reload, and it must
 * never be mistaken for a deployed one by anything that reads the store.
 *
 * The module header on `./passportContractStore.ts` is the written version of
 * all of this; these are the same statements, executable.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPassportUpgradeProgress,
  completePassportUpgrade,
  loadPassportContractRecord,
  loadPassportContractRecords,
  loadPassportUpgradeProgress,
  passportContractRecordKey,
  refusePassportContractRecord,
  restorePassportContractRecords,
  savePassportContractRecord,
  savePassportUpgradeProgress,
  type PassportContractRecord,
  type PassportUpgradeProgress,
} from './passportContractStore.js';

const ADDRESS = 'ab'.repeat(32);
const IDENTIFIER = 'cd'.repeat(33);

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

function submitted(patch: Partial<PassportContractRecord> = {}): PassportContractRecord {
  return {
    credentialId: 'AQIDBA==',
    network: 'stagenet',
    status: 'submitted',
    address: ADDRESS,
    deployTxId: IDENTIFIER,
    updatedAt: '2026-09-07T09:00:00.000Z',
    ...patch,
  };
}

beforeEach(() => {
  installStorage();
});

describe('a deploy this browser has sent and not yet had answered for', () => {
  it('is stored, and read back, so a reopened Passport still knows about it', () => {
    savePassportContractRecord(submitted());
    const record = loadPassportContractRecord('AQIDBA==', 'stagenet');
    expect(record).toMatchObject({
      status: 'submitted',
      address: ADDRESS,
      deployTxId: IDENTIFIER,
      updatedAt: '2026-09-07T09:00:00.000Z',
    });
  });

  it('must carry the address and the identifier a resume needs', () => {
    expect(refusePassportContractRecord(submitted({ address: undefined }))).toMatch(
      /must carry both the contract address and the transaction identifier/,
    );
    expect(refusePassportContractRecord(submitted({ deployTxId: undefined }))).toMatch(
      /must carry both the contract address and the transaction identifier/,
    );
    expect(refusePassportContractRecord(submitted())).toBeNull();
  });

  it('may not borrow the evidence a deployed or recovered record has earned', () => {
    expect(refusePassportContractRecord(submitted({ ledgerConfirmed: true }))).toMatch(
      /cannot claim a confirmed on-chain read-back or a recovery/,
    );
    expect(refusePassportContractRecord(submitted({ recovered: true }))).toMatch(
      /cannot claim a confirmed on-chain read-back or a recovery/,
    );
    /* An UNCONFIRMED read-back is exactly what a submission has, so it is not
       a claim and it is allowed. */
    expect(refusePassportContractRecord(submitted({ ledgerConfirmed: false }))).toBeNull();
  });

  it('is still not a status the store will invent one of its own beside', () => {
    expect(
      refusePassportContractRecord({
        credentialId: 'AQIDBA==',
        network: 'stagenet',
        status: 'pending' as unknown as 'failed',
      }),
    ).toMatch(/status must be submitted, deployed or failed/);
  });

  it('is replaced by the deployed record when the chain answers, on the same key', () => {
    savePassportContractRecord(submitted());
    savePassportContractRecord({
      ...submitted(),
      status: 'deployed',
      ledgerConfirmed: true,
      updatedAt: '2026-09-07T09:00:30.000Z',
    });
    const records = loadPassportContractRecords();
    expect(Object.keys(records)).toEqual([passportContractRecordKey('AQIDBA==', 'stagenet')]);
    expect(records[passportContractRecordKey('AQIDBA==', 'stagenet')]).toMatchObject({
      status: 'deployed',
      ledgerConfirmed: true,
    });
  });

  it('is replaced by a failure that KEEPS the attempt, when it never appears', () => {
    savePassportContractRecord(submitted());
    savePassportContractRecord({
      ...submitted(),
      status: 'failed',
      failureReason:
        'Setting your account up was interrupted, and it has not appeared since. You can try again.',
      updatedAt: '2026-09-07T09:02:00.000Z',
    });
    const record = loadPassportContractRecord('AQIDBA==', 'stagenet');
    expect(record?.status).toBe('failed');
    // Nothing about the attempt is thrown away with it.
    expect(record?.address).toBe(ADDRESS);
    expect(record?.deployTxId).toBe(IDENTIFIER);
  });

  it('survives a bulk restore’s reader, which filters on the same list', () => {
    const [outcome] = restorePassportContractRecords([submitted()]);
    expect(outcome?.written).toBe(true);
    expect(loadPassportContractRecord('AQIDBA==', 'stagenet')?.status).toBe('submitted');
  });
});

/* -------------------------------------------------------------------------- */
/* The upgrade block                                                          */
/* -------------------------------------------------------------------------- */

/**
 * An upgrade is four to six sponsored transactions and this block is the only
 * thing that stops an interrupted one repeating them. The rules below are the
 * same two the record itself keeps, applied one level down: a step may only be
 * marked done once what it produced is written beside it, and the Passport does
 * not move to the new account until the chain has answered for it.
 */
const NEW_ADDRESS = '99'.repeat(32);
const NEW_TX = '88'.repeat(33);

function deployed(): PassportContractRecord {
  return {
    credentialId: 'AQIDBA==',
    network: 'stagenet',
    status: 'deployed',
    address: ADDRESS,
    deployTxId: IDENTIFIER,
    ledgerConfirmed: true,
    deviceCommitment: '11',
  };
}

function started(): Parameters<typeof savePassportUpgradeProgress>[2] {
  return { fromAddress: ADDRESS, name: 'alice', startedAt: '2026-09-10T09:00:00.000Z' };
}

describe('an upgrade in progress', () => {
  beforeEach(() => {
    savePassportContractRecord(deployed());
  });

  it('hangs off the record for the account being left, and reads back', () => {
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', started());
    expect(loadPassportUpgradeProgress('AQIDBA==', 'stagenet')).toMatchObject({
      fromAddress: ADDRESS,
      name: 'alice',
    });
    /* And the Passport is still on the account it is on. */
    expect(loadPassportContractRecord('AQIDBA==', 'stagenet')?.address).toBe(ADDRESS);
  });

  it('MERGES what each step learned rather than replacing the block', () => {
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', { ...started(), drained: true });
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', {
      ...started(),
      toAddress: NEW_ADDRESS,
      toDeployTxId: NEW_TX,
    });
    /* The drain the second write said nothing about is still recorded — a step
       that erased the one before it would send a resume back to re-drain an
       account it had already emptied. */
    expect(loadPassportUpgradeProgress('AQIDBA==', 'stagenet')).toMatchObject({
      drained: true,
      toAddress: NEW_ADDRESS,
      toDeployTxId: NEW_TX,
    });
  });

  it('clears a field a step explicitly passes as undefined', () => {
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', {
      ...started(),
      failureReason: 'the service was busy',
    });
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', {
      ...started(),
      failureReason: undefined,
    });
    expect(loadPassportUpgradeProgress('AQIDBA==', 'stagenet')?.failureReason).toBeUndefined();
  });

  it('refuses to attach to a credential this browser holds no account for', () => {
    expect(() => savePassportUpgradeProgress('OTHER', 'stagenet', started())).toThrow(
      /no Passport account for that credential/,
    );
  });

  it('may not report a step done without what that step produced', () => {
    const withUpgrade = (upgrade: Partial<PassportUpgradeProgress>): PassportContractRecord => ({
      ...deployed(),
      upgrade: { ...started(), ...upgrade },
    });
    expect(refusePassportContractRecord(withUpgrade({ deployed: true }))).toMatch(
      /without naming its address/,
    );
    expect(refusePassportContractRecord(withUpgrade({ repointed: true }))).toMatch(
      /without naming the account it now points at/,
    );
    expect(
      refusePassportContractRecord(
        withUpgrade({ repointed: true, toAddress: NEW_ADDRESS, name: '' }),
      ),
    ).toMatch(/no name cannot report one as re-pointed/);
    expect(refusePassportContractRecord(withUpgrade({ refunded: true }))).toMatch(
      /before it reports the drain it is refunding/,
    );
    expect(
      refusePassportContractRecord(
        withUpgrade({ toAddress: NEW_ADDRESS, deployed: true, drained: true, refunded: true }),
      ),
    ).toBeNull();
  });

  it('is not carried into a backup, because it is a fact about one browser', () => {
    /* The export projects onto a fixed field list (`../identity/backup.ts`),
       and `upgrade` is deliberately not on it. This is the store's half of
       that: the field exists on the record and nothing here puts it on the
       list. */
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', started());
    const record = loadPassportContractRecord('AQIDBA==', 'stagenet')!;
    expect(record.upgrade).toBeDefined();
    expect(refusePassportContractRecord(record)).toBeNull();
  });
});

describe('finishing an upgrade', () => {
  beforeEach(() => {
    savePassportContractRecord(deployed());
  });

  it('switches the Passport onto the new account and forgets the block', () => {
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', {
      ...started(),
      toAddress: NEW_ADDRESS,
      toDeployTxId: NEW_TX,
      toDeviceCommitment: '22',
      drained: true,
      deployed: true,
      repointed: true,
      refunded: true,
    });
    completePassportUpgrade('AQIDBA==', 'stagenet');

    const record = loadPassportContractRecord('AQIDBA==', 'stagenet');
    expect(record).toMatchObject({
      status: 'deployed',
      address: NEW_ADDRESS,
      deployTxId: NEW_TX,
      deviceCommitment: '22',
      ledgerConfirmed: true,
    });
    expect(record?.upgrade).toBeUndefined();
    expect(loadPassportUpgradeProgress('AQIDBA==', 'stagenet')).toBeNull();
  });

  it('drops a stale recovered or restored flag, because THIS browser deployed it', () => {
    savePassportContractRecord({ ...deployed(), recovered: true, restoredFromBackup: true });
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', {
      ...started(),
      toAddress: NEW_ADDRESS,
      toDeployTxId: NEW_TX,
      deployed: true,
    });
    completePassportUpgrade('AQIDBA==', 'stagenet');
    const record = loadPassportContractRecord('AQIDBA==', 'stagenet');
    expect(record?.recovered).toBeUndefined();
    expect(record?.restoredFromBackup).toBeUndefined();
    /* And the record still passes the store's own predicate, which a kept
       `recovered` would have exempted from the transaction-id rule for ever. */
    expect(refusePassportContractRecord(record!)).toBeNull();
  });

  it('refuses before the new account has been seen on chain', () => {
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', {
      ...started(),
      toAddress: NEW_ADDRESS,
      toDeployTxId: NEW_TX,
    });
    expect(() => completePassportUpgrade('AQIDBA==', 'stagenet')).toThrow(
      /only be finished once its new account has been seen on chain/,
    );
    expect(loadPassportContractRecord('AQIDBA==', 'stagenet')?.address).toBe(ADDRESS);
  });

  it('is forgotten without touching the account, when there is nothing to resume', () => {
    savePassportUpgradeProgress('AQIDBA==', 'stagenet', started());
    clearPassportUpgradeProgress('AQIDBA==', 'stagenet');
    expect(loadPassportUpgradeProgress('AQIDBA==', 'stagenet')).toBeNull();
    expect(loadPassportContractRecord('AQIDBA==', 'stagenet')?.address).toBe(ADDRESS);
  });
});
