import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EncryptedPassportPrivateStateStore,
  MemoryPassportEncryptedRecordStore,
  PassportStateInjection,
  joinWithPassportState,
} from '../src/index.js';
import type {
  PassportEncryptedEnvelope,
  PassportEncryptedRecordStore,
  PassportStateKeyProvider,
  PassportStateScope,
} from '../src/index.js';

const scope: PassportStateScope = {
  appId: 'org.midnight.passport.demo',
  accountId: 'mn-account-1',
};

class TestKeyProvider implements PassportStateKeyProvider {
  constructor(private readonly material: Uint8Array) {}

  async getKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', this.material, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  }
}

class FixedRecordStore implements PassportEncryptedRecordStore {
  constructor(private readonly record: PassportEncryptedEnvelope | null) {}

  async get(): Promise<PassportEncryptedEnvelope | null> {
    return this.record;
  }

  async set(): Promise<void> {}

  async delete(): Promise<void> {}

  async clear(): Promise<void> {}
}

describe('EncryptedPassportPrivateStateStore', () => {
  let records: MemoryPassportEncryptedRecordStore;
  let store: EncryptedPassportPrivateStateStore;

  beforeEach(() => {
    records = new MemoryPassportEncryptedRecordStore();
    store = new EncryptedPassportPrivateStateStore(
      records,
      new TestKeyProvider(new Uint8Array(32).fill(7)),
    );
  });

  it('persists, updates, loads, removes, and clears encrypted state', async () => {
    const log = vi.spyOn(console, 'log');
    await store.save(scope, { secret: 'not-visible', balance: 2n, bytes: new Uint8Array([1, 2, 3]) });
    expect(await store.load(scope)).toEqual({
      secret: 'not-visible',
      balance: 2n,
      bytes: new Uint8Array([1, 2, 3]),
    });

    await store.save(scope, { secret: 'rotated' });
    expect(await store.load(scope)).toEqual({ secret: 'rotated' });

    const persisted = JSON.stringify(records.snapshot());
    expect(persisted).not.toContain('rotated');
    expect(persisted).not.toContain('not-visible');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();

    await store.remove(scope);
    expect(await store.load(scope)).toBeNull();

    await store.save(scope, { secret: 'another-value' });
    await store.clear();
    expect(await store.load(scope)).toBeNull();
  });

  it('isolates scopes through storage keys and authenticated encryption data', async () => {
    await store.save(scope, { secret: 'alice' });
    await expect(store.load({ ...scope, accountId: 'mn-account-2' })).resolves.toBeNull();
    await expect(store.load({ ...scope, appId: 'other.app' })).resolves.toBeNull();
  });

  it('rejects malformed envelopes and a wrong passkey-derived key', async () => {
    await store.save(scope, { secret: 'alice' });
    const wrongKeyStore = new EncryptedPassportPrivateStateStore(
      records,
      new TestKeyProvider(new Uint8Array(32).fill(8)),
    );
    await expect(wrongKeyStore.load(scope)).rejects.toThrow('could not be unlocked');

    const malformedStore = new EncryptedPassportPrivateStateStore(
      new FixedRecordStore({
        version: 2,
        iv: 'not-an-iv',
        ciphertext: 'not-a-ciphertext',
        updatedAt: new Date().toISOString(),
      } as PassportEncryptedEnvelope),
      new TestKeyProvider(new Uint8Array(32).fill(7)),
    );
    await expect(malformedStore.load(scope)).rejects.toThrow('Unsupported Passport private-state version');
  });

  it('loads stored state at the initialPrivateState join boundary', async () => {
    await store.save(scope, { deviceSecretHex: 'encrypted', recoverySecretHex: null });
    const injection = await PassportStateInjection({
      store,
      scope,
      initialPrivateState: { deviceSecretHex: null, recoverySecretHex: null },
    });
    expect(injection.source).toBe('stored');
    expect(injection.privateState.deviceSecretHex).toBe('encrypted');

    const joined = await joinWithPassportState({
      store,
      scope,
      initialPrivateState: { deviceSecretHex: null, recoverySecretHex: null },
      join: async (initialPrivateState) => ({ initialPrivateState }),
    });
    expect(joined.result.initialPrivateState.deviceSecretHex).toBe('encrypted');
  });
});
