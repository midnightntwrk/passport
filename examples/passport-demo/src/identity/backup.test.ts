/**
 * Round-trip drill for the private-state backup.
 *
 * Everything here runs on Node's own WebCrypto — the same `crypto.subtle` the
 * browser gives us — so what passes here is what the browser executes, not a
 * mock of it. The three facts worth proving are the three a user depends on:
 * a backup opens with its password, a wrong password fails cleanly rather than
 * returning junk, and a single altered byte fails cleanly rather than being
 * restored.
 *
 * The store round trip is drilled against a minimal in-memory `localStorage`,
 * because the three stores this module allow-lists talk to `window.localStorage`
 * and nothing else. No behaviour of theirs is mocked; only the storage is.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/identity`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PASSPORT_BACKUP_KDF,
  PASSPORT_BACKUP_VERSION,
  PassportBackupError,
  applyPassportBackup,
  assertNoKeyMaterial,
  backupFileName,
  collectPassportBackup,
  describeBackupPassword,
  openPassportBackup,
  parseBackupEnvelope,
  sealPassportBackup,
  selectBackupBackend,
  type PassportBackupContents,
} from './backup.js';

const PASSWORD = 'correct horse battery staple';

function contents(): PassportBackupContents {
  return {
    version: PASSPORT_BACKUP_VERSION,
    createdAt: '2026-08-19T09:00:00.000Z',
    aliases: {
      preview: {
        alias: 'alice',
        domain: 'night',
        network: 'preview',
        status: 'registered',
        resolverAddress: '0200abcd',
        resolverDeployTxId: 'aa'.repeat(32),
        registerTxId: 'bb'.repeat(32),
        registryConfirmed: true,
        resolverTarget: 'contract',
        updatedAt: '2026-08-19T08:59:00.000Z',
      },
    },
    passportContracts: {
      'AQIDBA==::preview': {
        credentialId: 'AQIDBA==',
        network: 'preview',
        status: 'deployed',
        address: 'cc'.repeat(32),
        deployTxId: 'dd'.repeat(32),
        txIdResolved: true,
        ledgerConfirmed: true,
        feePaidBy: 'sponsored',
        updatedAt: '2026-08-19T08:58:00.000Z',
      },
    },
    incentives: [
      {
        id: 'raffle-1',
        app: 'Midnight Raffle',
        label: 'One free entry',
        txId: 'ee'.repeat(32),
        network: 'preview',
        redeemedAt: '2026-08-19T08:57:00.000Z',
      },
    ],
  };
}

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

describe('passport backup envelope', () => {
  it('round-trips a payload through seal and open', async () => {
    const payload = contents();
    const envelope = await sealPassportBackup(payload, PASSWORD);

    expect(envelope.v).toBe(PASSPORT_BACKUP_VERSION);
    expect(envelope.kdf).toBe('PBKDF2-SHA-256-600000');
    // 16 salt bytes and 12 nonce bytes, base64url, unpadded.
    expect(envelope.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(envelope.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(envelope.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    // The file leaks its parameters and nothing else.
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'kdf', 'nonce', 'salt', 'v']);
    expect(JSON.stringify(envelope)).not.toContain('alice');

    const opened = await openPassportBackup(envelope, PASSWORD);
    expect(opened).toEqual(payload);
  });

  it('produces a different envelope every time for the same input', async () => {
    const payload = contents();
    const first = await sealPassportBackup(payload, PASSWORD);
    const second = await sealPassportBackup(payload, PASSWORD);
    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('fails cleanly on the wrong password', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    await expect(openPassportBackup(envelope, 'not the password')).rejects.toMatchObject({
      name: 'PassportBackupError',
      code: 'wrong-password-or-tampered',
    });
  });

  it('fails cleanly on a tampered ciphertext', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    // Flip one base64url character of the ciphertext.
    const flipped = `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`;
    await expect(
      openPassportBackup({ ...envelope, ciphertext: flipped }, PASSWORD),
    ).rejects.toMatchObject({ code: 'wrong-password-or-tampered' });
  });

  it('fails cleanly when the authenticated header is rewritten', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    // The KDF descriptor is plaintext but covered by the GCM tag. Downgrading
    // it is refused before decryption even runs.
    await expect(
      openPassportBackup(
        JSON.stringify({ ...envelope, kdf: 'PBKDF2-SHA-256-1000' }),
        PASSWORD,
      ),
    ).rejects.toMatchObject({ code: 'unsupported-kdf' });
  });

  it('refuses files that are not backups', () => {
    expect(() => parseBackupEnvelope('not json')).toThrow(PassportBackupError);
    expect(() => parseBackupEnvelope('{"v":1}')).toThrow(/five fields/);
    expect(() =>
      parseBackupEnvelope(
        JSON.stringify({ v: 99, kdf: PASSPORT_BACKUP_KDF, salt: 'a', nonce: 'b', ciphertext: 'c' }),
      ),
    ).toThrow(/newer Passport/);
  });
});

describe('the no-key-material invariant', () => {
  it('refuses any payload carrying something that reads as a key', () => {
    expect(() => assertNoKeyMaterial({ aliases: {}, deviceSecret: 'aa' })).toThrow(
      /state, never keys/,
    );
    expect(() => assertNoKeyMaterial({ nested: [{ walletSeed: 'aa' }] })).toThrow(
      /state, never keys/,
    );
    expect(() => assertNoKeyMaterial(contents())).not.toThrow();
  });

  it('refuses to seal a payload carrying key material', async () => {
    const poisoned = { ...contents(), recoverySecret: 'deadbeef' } as PassportBackupContents;
    await expect(sealPassportBackup(poisoned, PASSWORD)).rejects.toMatchObject({
      code: 'key-material-present',
    });
  });
});

describe('collect and apply against the real stores', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('restores a backup into an empty browser and reports what it wrote', async () => {
    const summary = await applyPassportBackup(contents());
    expect(summary.aliases).toMatchObject({ found: 1, restored: 1, skipped: [] });
    expect(summary.passportContracts).toMatchObject({ found: 1, restored: 1, skipped: [] });
    expect(summary.incentives).toMatchObject({ found: 1, restored: 1, skipped: [] });

    // What the stores now hold is what a fresh export must carry.
    const collected = await collectPassportBackup();
    expect(collected.aliases.preview?.alias).toBe('alice');
    expect(collected.passportContracts['AQIDBA==::preview']?.address).toBe('cc'.repeat(32));
    expect(collected.incentives).toHaveLength(1);

    // And that export round-trips.
    const reopened = await openPassportBackup(
      await sealPassportBackup(collected, PASSWORD),
      PASSWORD,
    );
    expect(reopened.aliases).toEqual(collected.aliases);
    expect(reopened.passportContracts).toEqual(collected.passportContracts);
    expect(reopened.incentives).toEqual(collected.incentives);
  });

  it('keeps a newer local record instead of overwriting it, and says so', async () => {
    await applyPassportBackup(contents());
    const stale = contents();
    stale.aliases.preview!.updatedAt = '2020-01-01T00:00:00.000Z';
    stale.passportContracts['AQIDBA==::preview']!.updatedAt = '2020-01-01T00:00:00.000Z';
    const summary = await applyPassportBackup(stale);
    expect(summary.aliases.restored).toBe(0);
    expect(summary.aliases.skipped[0]?.reason).toBe('this browser already holds a newer record');
    expect(summary.passportContracts.restored).toBe(0);
    expect(summary.incentives.skipped[0]?.reason).toBe('already redeemed in this browser');
  });

  it('reports a malformed record as skipped rather than dropping it', async () => {
    const broken = contents();
    // A 'registered' alias with no registration transaction: the store refuses
    // it, and the summary carries the store's own words.
    delete broken.aliases.preview!.registerTxId;
    const summary = await applyPassportBackup(broken);
    expect(summary.aliases.restored).toBe(0);
    expect(summary.aliases.skipped[0]?.reason).toMatch(/must carry both/);
  });
});

describe('backends and guidance', () => {
  it('ships exactly one backend, and refuses Drive with the reason', () => {
    expect(selectBackupBackend().id).toBe('file');
    expect(() => selectBackupBackend('google-drive')).toThrow(/no Google OAuth client/);
  });

  it('names the file by date', () => {
    expect(backupFileName(new Date('2026-08-19T12:00:00Z'))).toMatch(
      /^passport-backup-\d{4}-\d{2}-\d{2}\.json$/,
    );
  });

  it('hints at password strength without promising security', () => {
    expect(describeBackupPassword('short').level).toBe('too-short');
    expect(describeBackupPassword('abcdefghij').level).toBe('weak');
    expect(describeBackupPassword('abcdefghijklmn').level).toBe('fair');
    expect(describeBackupPassword(PASSWORD).level).toBe('strong');
  });
});
