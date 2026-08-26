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

  it('refuses a scope that could collide with another, and keeps the ones that cannot', async () => {
    // Before the rule, these two flattened to the same AAD and the same
    // storage key, so one scope's save() overwrote the other's envelope.
    const colliding: PassportStateScope = { appId: 'demo:eu', accountId: 'alice' };
    const wellFormed: PassportStateScope = { appId: 'demo', accountId: 'eu:alice' };
    await expect(store.save(colliding, { secret: 'x' })).rejects.toThrow(/may not contain/);
    await expect(store.load(colliding)).rejects.toThrow(/may not contain/);
    await expect(store.save({ appId: 'demo|eu', accountId: 'alice' }, {})).rejects.toThrow(
      /may not contain/,
    );
    await expect(store.save({ appId: 'demo\u0000', accountId: 'alice' }, {})).rejects.toThrow(
      /control characters/,
    );
    await expect(store.save({ appId: '', accountId: 'alice' }, {})).rejects.toThrow(
      'Passport state scope requires an appId.',
    );
    await expect(store.save({ appId: 'demo', accountId: '' }, {})).rejects.toThrow(
      'Passport state scope requires an accountId.',
    );

    // The unambiguous half of the pair still round-trips — and so does the
    // colon-bearing accountId every shipped multi-passkey Passport uses.
    await store.save(wellFormed, { secret: 'alice' });
    expect(await store.load(wellFormed)).toEqual({ secret: 'alice' });
    const shipped: PassportStateScope = {
      appId: 'org.midnight.passport.demo',
      accountId: 'passport-local:AQIDBA',
    };
    await store.save(shipped, { secret: 'shipped' });
    expect(await store.load(shipped)).toEqual({ secret: 'shipped' });
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
