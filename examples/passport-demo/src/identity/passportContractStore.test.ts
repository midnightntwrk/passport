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
  loadPassportContractRecord,
  loadPassportContractRecords,
  passportContractRecordKey,
  refusePassportContractRecord,
  restorePassportContractRecords,
  savePassportContractRecord,
  type PassportContractRecord,
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
