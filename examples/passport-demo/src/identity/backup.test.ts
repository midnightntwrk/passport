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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AliasRecord } from './aliasStore.js';
import type { PassportContractRecord } from './passportContractStore.js';

import {
  PASSPORT_BACKUP_KDF,
  PASSPORT_BACKUP_VERSION,
  PassportBackupError,
  applyPassportBackup,
  assertBackupRecordContainers,
  assertNoKeyMaterial,
  backupFileName,
  collectPassportBackup,
  describeBackupCreatedAt,
  describeBackupPassword,
  describeExportOutcome,
  exportPassportBackup,
  fileBackupBackend,
  importPassportBackup,
  openPassportBackup,
  parseBackupEnvelope,
  sealPassportBackup,
  selectBackupBackend,
  type PassportBackupBackend,
  type PassportBackupContents,
} from './backup.js';


/* Several suites restore this Passport's own contract from the file, so its
   address arrives as a claim and the chain is what settles it. Where the
   subject is the REGISTRY's answer rather than ownership, the test hands over
   a prover that says the contract holds this device; the ownership suite is
   the one that varies it. */
const holdsThisDevice = async (): Promise<boolean> => true;

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

  it('refuses to seal without a password at all', async () => {
    // The password is the whole of the protection; there is no default.
    await expect(sealPassportBackup(contents(), '')).rejects.toMatchObject({
      code: 'not-a-backup',
    });
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

/* -------------------------------------------------------------------------- */
/* The file, as a file: what a reader refuses before it decrypts anything      */
/* -------------------------------------------------------------------------- */

describe('reading a file that claims to be a backup', () => {
  it('refuses JSON that is not an object', () => {
    for (const raw of ['"a backup"', 'null', '[]', '42']) {
      expect(() => parseBackupEnvelope(raw)).toThrow(/not a Passport backup/);
    }
  });

  it('decodes an unpadded field, and refuses a length no byte count produces', async () => {
    /* `toBase64Url` strips the `=` padding, so every field of a real backup
       arrives unpadded — the reader pads it back rather than relying on the
       host's `atob` being lenient. A length of 4n+1 is not a truncated
       encoding of anything, so it is refused rather than padded into a value
       that decodes. */
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    expect(envelope.salt).not.toMatch(/=/);
    expect(() => parseBackupEnvelope(JSON.stringify(envelope))).not.toThrow();
    expect(() =>
      parseBackupEnvelope(JSON.stringify({ ...envelope, salt: `${envelope.salt}AAA` })),
    ).toThrow(/not a Passport backup/);
  });

  it('names which field is not base64url rather than failing vaguely', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    await expect(
      openPassportBackup({ ...envelope, salt: 'not base64url!' }, PASSWORD),
    ).rejects.toMatchObject({ code: 'not-a-backup' });
    await expect(
      openPassportBackup({ ...envelope, nonce: '=====' }, PASSWORD),
    ).rejects.toThrow(/nonce is not base64url/);
    await expect(
      openPassportBackup({ ...envelope, ciphertext: '@@' }, PASSWORD),
    ).rejects.toThrow(/ciphertext is not base64url/);
  });

  it('refuses base64url that is the right alphabet and the wrong length', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    // Passes the character test, fails the length — a different sentence.
    await expect(openPassportBackup({ ...envelope, salt: 'a' }, PASSWORD)).rejects.toThrow(
      /salt is not a whole number of bytes/,
    );
  });

  it('opens an envelope handed over as text, not only as an object', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    const opened = await openPassportBackup(JSON.stringify(envelope), PASSWORD);
    expect(opened.aliases.preview?.alias).toBe('alice');
  });
});

describe('a file that decrypts and still is not a backup', () => {
  /** Seals arbitrary PLAINTEXT under the module's own KDF and header. */
  async function sealRaw(plaintext: string, password: string) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: new TextEncoder().encode(
          `midnight-passport:backup:v1 ${PASSPORT_BACKUP_VERSION} ${PASSPORT_BACKUP_KDF}`,
        ),
      },
      key,
      new TextEncoder().encode(plaintext),
    );
    const b64 = (bytes: Uint8Array) =>
      Buffer.from(bytes).toString('base64url');
    return {
      v: PASSPORT_BACKUP_VERSION,
      kdf: PASSPORT_BACKUP_KDF,
      salt: b64(salt),
      nonce: b64(nonce),
      ciphertext: b64(new Uint8Array(ciphertext)),
    };
  }

  it('reports unreadable plaintext as corrupt rather than as a wrong password', async () => {
    /* The distinction matters to a user: a wrong password is worth retyping,
       and a corrupt file is not. */
    const envelope = await sealRaw('not json at all', PASSWORD);
    await expect(openPassportBackup(envelope, PASSWORD)).rejects.toMatchObject({
      code: 'corrupt-contents',
    });
    await expect(openPassportBackup(envelope, PASSWORD)).rejects.toThrow(/not readable/);
  });

  it('refuses plaintext that is JSON but is not the three record sets', async () => {
    const shapes: unknown[] = [
      null,
      42,
      { createdAt: 1, aliases: {}, passportContracts: {}, incentives: [] },
      { createdAt: 'now', aliases: null, passportContracts: {}, incentives: [] },
      { createdAt: 'now', aliases: {}, passportContracts: null, incentives: [] },
      { createdAt: 'now', aliases: {}, passportContracts: {}, incentives: {} },
      { createdAt: 'now', aliases: {}, passportContracts: {} },
    ];
    for (const shape of shapes) {
      const envelope = await sealRaw(JSON.stringify(shape), PASSWORD);
      await expect(openPassportBackup(envelope, PASSWORD)).rejects.toThrow(
        /three record sets/,
      );
    }
  });

  it('supplies this build’s format number when the file omits one', async () => {
    const envelope = await sealRaw(
      JSON.stringify({ createdAt: 'now', aliases: {}, passportContracts: {}, incentives: [] }),
      PASSWORD,
    );
    const opened = await openPassportBackup(envelope, PASSWORD);
    expect(opened.version).toBe(PASSPORT_BACKUP_VERSION);
  });
});

/* -------------------------------------------------------------------------- */
/* Never a silent drop                                                        */
/* -------------------------------------------------------------------------- */

describe('a store that reports a record was not written', () => {
  /* The summary promises a REASON for every record it did not write, and the
     bulk write path is the one that decides: it re-reads what it stored and
     reports each record's fate rather than assuming the `setItem` landed.
     Here the three stores are replaced by ones that refuse, so both the
     reported reason and the fallback for a store that gives none are drilled
     rather than assumed. The tests above run against the real stores. */
  afterEach(() => {
    vi.doUnmock('./aliasStore.js');
    vi.doUnmock('./passportContractStore.js');
    vi.doUnmock('./incentiveStore.js');
    vi.resetModules();
  });

  it('carries each store’s own reason into the summary', async () => {
    vi.resetModules();
    vi.doMock('./aliasStore.js', () => ({
      loadAliasRecords: () => ({}),
      restoreAliasRecords: (records: { network: string }[]) =>
        records.map((record) => ({
          network: record.network,
          written: false,
          reason: 'the alias store said no',
        })),
    }));
    vi.doMock('./passportContractStore.js', () => ({
      loadPassportContractRecords: () => ({}),
      passportContractRecordKey: (credentialId: string, network: string) =>
        `${credentialId}::${network}`,
      refusePassportContractRecord: () => null,
      restorePassportContractRecords: (records: { credentialId: string; network: string }[]) =>
        records.map((record) => ({
          key: `${record.credentialId}::${record.network}`,
          written: false,
          reason: 'the contract store said no',
        })),
    }));
    vi.doMock('./incentiveStore.js', () => ({
      loadIncentives: () => [],
      restoreIncentives: (records: { id: string }[]) =>
        records.map((record) => ({
          id: record.id,
          written: false,
          reason: 'the incentive store said no',
        })),
    }));

    const { applyPassportBackup: apply } = await import('./backup.js');
    const summary = await apply(contents());
    expect(summary.aliases.skipped[0]?.reason).toBe('the alias store said no');
    expect(summary.passportContracts.skipped[0]?.reason).toBe('the contract store said no');
    expect(summary.incentives.skipped[0]?.reason).toBe('the incentive store said no');
    // Nothing was written, and every record is accounted for.
    expect(summary.aliases).toMatchObject({ found: 1, restored: 0 });
    expect(summary.passportContracts).toMatchObject({ found: 1, restored: 0 });
    expect(summary.incentives).toMatchObject({ found: 1, restored: 0 });
  });

  it('still gives a reason for a store that refuses without one', async () => {
    vi.resetModules();
    vi.doMock('./aliasStore.js', () => ({
      loadAliasRecords: () => ({}),
      restoreAliasRecords: (records: { network: string }[]) =>
        records.map((record) => ({ network: record.network, written: false })),
    }));
    vi.doMock('./passportContractStore.js', () => ({
      loadPassportContractRecords: () => ({}),
      passportContractRecordKey: (credentialId: string, network: string) =>
        `${credentialId}::${network}`,
      refusePassportContractRecord: () => null,
      restorePassportContractRecords: (records: { credentialId: string; network: string }[]) =>
        records.map((record) => ({
          key: `${record.credentialId}::${record.network}`,
          written: false,
        })),
    }));
    vi.doMock('./incentiveStore.js', () => ({
      loadIncentives: () => [],
      restoreIncentives: (records: { id: string }[]) =>
        records.map((record) => ({ id: record.id, written: false })),
    }));

    const { applyPassportBackup: apply } = await import('./backup.js');
    const summary = await apply(contents());
    expect(summary.aliases.skipped[0]?.reason).toBe('the store refused it');
    expect(summary.passportContracts.skipped[0]?.reason).toBe('the store refused it');
    expect(summary.incentives.skipped[0]?.reason).toBe('the store refused it');
  });
});

describe('which record wins on a restore', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('writes a record the store refuses as malformed into `skipped`, per store', async () => {
    const broken = contents();
    // A 'deployed' contract with no deployment transaction: the store refuses.
    delete broken.passportContracts['AQIDBA==::preview']!.deployTxId;
    const summary = await applyPassportBackup(broken);
    expect(summary.passportContracts.restored).toBe(0);
    expect(summary.passportContracts.skipped[0]).toEqual({
      key: 'AQIDBA==::preview',
      reason: expect.stringMatching(/must carry both the contract address/),
    });
  });

  it('overwrites a local record written before records carried a timestamp', async () => {
    /* A record from an older build: no `updatedAt` at all. The backup's copy
       cannot be shown to be OLDER than it, so the backup wins — the rule
       protects a demonstrably newer local record, not any local record. */
    const undated = { ...contents().aliases.preview!, alias: 'older' };
    delete (undated as { updatedAt?: string }).updatedAt;
    /* And unconfirmed, so this drills the timestamp rule alone: a name the
       REGISTRY has confirmed in this browser is a separate rule below, and
       nothing in a file may overwrite one. */
    delete (undated as { registryConfirmed?: boolean }).registryConfirmed;
    window.localStorage.setItem('passport-alias:v1', JSON.stringify({ preview: undated }));

    const summary = await applyPassportBackup(contents());
    expect(summary.aliases.restored).toBe(1);
    const collected = await collectPassportBackup();
    expect(collected.aliases.preview?.alias).toBe('alice');
  });

  it('restores a record the local browser holds with no timestamp of its own', async () => {
    const undated = contents();
    delete (undated.aliases.preview as { updatedAt?: string }).updatedAt;
    // Nothing local yet: an undated record is still newer than nothing.
    const first = await applyPassportBackup(undated);
    expect(first.aliases.restored).toBe(1);

    /* Now there IS something local. An undated candidate cannot be shown to be
       newer, so the local record stands — and the reason says THAT rather than
       claiming a newer local record, which is a different fact. */
    const second = await applyPassportBackup(undated);
    expect(second.aliases.restored).toBe(0);
    expect(second.aliases.skipped[0]?.reason).toBe(
      'the record in the file carries no timestamp, so it could not be shown to be newer than the one already here',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The backend, and the two operations the screen calls                       */
/* -------------------------------------------------------------------------- */

describe('the file backend', () => {
  /** The smallest `document` and object-URL machinery the backend touches. */
  function installDownloadEnvironment(): {
    anchors: Record<string, unknown>[];
    revoked: string[];
    appended: number;
    removed: number;
  } {
    const anchors: Record<string, unknown>[] = [];
    const revoked: string[] = [];
    const record = { appended: 0, removed: 0 };
    Object.defineProperty(globalThis, 'document', {
      value: {
        createElement: () => {
          const anchor: Record<string, unknown> = {
            click: () => {},
            remove: () => {
              record.removed += 1;
            },
          };
          anchors.push(anchor);
          return anchor;
        },
        body: {
          append: () => {
            record.appended += 1;
          },
        },
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'URL', {
      value: Object.assign(Object.create(URL), {
        createObjectURL: () => 'blob:passport/1',
        revokeObjectURL: (url: string) => revoked.push(url),
      }),
      configurable: true,
      writable: true,
    });
    return {
      anchors,
      revoked,
      get appended() {
        return record.appended;
      },
      get removed() {
        return record.removed;
      },
    };
  }

  const realUrl = globalThis.URL;

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
    Object.defineProperty(globalThis, 'URL', { value: realUrl, configurable: true, writable: true });
    vi.useRealTimers();
  });

  it('is unavailable where there is no document to download through', () => {
    Reflect.deleteProperty(globalThis, 'document');
    expect(fileBackupBackend.isAvailable()).toBe(false);
  });

  it('refuses to write rather than pretending a download started', async () => {
    Reflect.deleteProperty(globalThis, 'document');
    await expect(fileBackupBackend.write('passport-backup.json', '{}')).rejects.toMatchObject({
      code: 'backup-not-written',
      message: expect.stringMatching(/cannot save files/),
    });
  });

  it('downloads through an anchor and says only that the browser was asked', async () => {
    vi.useFakeTimers();
    const environment = installDownloadEnvironment();
    expect(fileBackupBackend.isAvailable()).toBe(true);

    const outcome = await fileBackupBackend.write('passport-backup-2026-08-25.json', '{}');
    /* An `<a download>` click reports nothing back — a blocked download, a
       cancelled dialog, and a written file are the same non-event here — so
       the backend answers with the case rather than with a claim, and
       `describeExportOutcome` is what turns it into words. */
    expect(outcome).toEqual({
      kind: 'handed-to-browser',
      fileName: 'passport-backup-2026-08-25.json',
    });
    expect(environment.anchors[0]).toMatchObject({
      href: 'blob:passport/1',
      download: 'passport-backup-2026-08-25.json',
      rel: 'noopener',
    });
    expect(environment.appended).toBe(1);
    expect(environment.removed).toBe(1);

    // The blob must outlive the click; the release is scheduled, not immediate.
    expect(environment.revoked).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(environment.revoked).toEqual(['blob:passport/1']);
  });

  it('asks for a file rather than inventing one, and reads the one it is given', async () => {
    await expect(fileBackupBackend.read()).rejects.toThrow(/Choose a backup file/);
    const picked = { text: async () => '{"v":1}' } as unknown as File;
    expect(await fileBackupBackend.read(picked)).toBe('{"v":1}');
  });

  it('resolves `file` by name and by default, and refuses anything else', () => {
    expect(selectBackupBackend('file')).toBe(fileBackupBackend);
    expect(selectBackupBackend()).toBe(fileBackupBackend);
    expect(() => selectBackupBackend('dropbox')).toThrow(
      /No Passport backup backend is registered under "dropbox"/,
    );
  });
});

describe('export and import, end to end through a backend', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  /** A backend that keeps the envelope in memory — the seam the screen uses. */
  function memoryBackend(): PassportBackupBackend & { written: string[] } {
    const written: string[] = [];
    return {
      id: 'memory',
      label: 'this test',
      isAvailable: () => true,
      async write(fileName, envelope) {
        written.push(envelope);
        return { kind: 'saved', fileName, location: 'in memory' };
      },
      async read() {
        return written[written.length - 1] ?? '';
      },
      written,
    };
  }

  it('collects, seals, hands over, and reports what went in', async () => {
    await applyPassportBackup(contents());
    const backend = memoryBackend();
    const exported = await exportPassportBackup(PASSWORD, backend);

    expect(exported.fileName).toMatch(/^passport-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(exported.outcome).toEqual({
      kind: 'saved',
      fileName: exported.fileName,
      location: 'in memory',
    });
    expect(exported.counts).toEqual({ aliases: 1, passportContracts: 1, incentives: 1 });
    // The file is pretty-printed JSON and carries nothing readable of its own.
    expect(backend.written[0]).toMatch(/^\{\n/);
    expect(backend.written[0]).not.toContain('alice');
  });

  it('reads back through the same backend and writes into a fresh browser', async () => {
    await applyPassportBackup(contents());
    const backend = memoryBackend();
    await exportPassportBackup(PASSWORD, backend);

    // A fresh browser: new storage, nothing in it.
    installStorage();
    const summary = await importPassportBackup(
      { text: async () => backend.written[0]! } as unknown as File,
      PASSWORD,
      backend,
    );
    expect(summary.aliases).toMatchObject({ found: 1, restored: 1 });
    expect(summary.passportContracts).toMatchObject({ found: 1, restored: 1 });
    expect(summary.incentives).toMatchObject({ found: 1, restored: 1 });
    // Nothing re-checked it against a chain, so the ledger check is absent.
    expect(summary.ledgerCheck).toBeUndefined();
  });

  it('takes the envelope as text without going through a backend read', async () => {
    await applyPassportBackup(contents());
    const backend = memoryBackend();
    await exportPassportBackup(PASSWORD, backend);
    installStorage();
    const summary = await importPassportBackup(backend.written[0]!, PASSWORD, backend);
    expect(summary.aliases.restored).toBe(1);
  });

  it('fails the import with the envelope’s own error on a wrong password', async () => {
    await applyPassportBackup(contents());
    const backend = memoryBackend();
    await exportPassportBackup(PASSWORD, backend);
    await expect(
      importPassportBackup(backend.written[0]!, 'wrong', backend),
    ).rejects.toMatchObject({ code: 'wrong-password-or-tampered' });
  });
});

describe('password guidance, at the band boundaries', () => {
  it('calls a long password strong, whatever it is made of', () => {
    expect(describeBackupPassword('a'.repeat(20)).level).toBe('strong');
  });

  it('calls a medium password strong only when it has real variety', () => {
    // 16 characters, three character classes.
    expect(describeBackupPassword('Abcdefghijklmn12').level).toBe('strong');
    // 16 characters, two classes: not strong, and the message says why to add
    // words rather than promising anything about an attacker.
    const fair = describeBackupPassword('abcdefghijklmn12');
    expect(fair.level).toBe('fair');
    expect(fair.message).toContain('unrelated words');
    // 15 characters with every class is still only fair — length leads.
    expect(describeBackupPassword('Abc1!efghijklmn').level).toBe('fair');
  });

  it('holds the too-short and weak boundaries exactly', () => {
    expect(describeBackupPassword('a'.repeat(7)).level).toBe('too-short');
    expect(describeBackupPassword('a'.repeat(8)).level).toBe('weak');
    expect(describeBackupPassword('a'.repeat(11)).level).toBe('weak');
    expect(describeBackupPassword('a'.repeat(12)).level).toBe('fair');
    expect(describeBackupPassword('').level).toBe('too-short');
  });
});

/* -------------------------------------------------------------------------- */
/* The envelope's own lengths, checked before a key is derived                 */
/* -------------------------------------------------------------------------- */

describe('an envelope whose fields are the wrong size', () => {
  /* A wrong-length nonce is a fact about the FILE. Reporting it as
     `wrong-password-or-tampered` sends a user to look for a password that
     would never have opened it, so each of these is `not-a-backup` and names
     the field and the length. */

  it('refuses an empty salt, nonce, or ciphertext by name', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    for (const field of ['salt', 'nonce', 'ciphertext'] as const) {
      await expect(
        openPassportBackup({ ...envelope, [field]: '' }, PASSWORD),
      ).rejects.toMatchObject({
        code: 'not-a-backup',
        message: expect.stringMatching(new RegExp(`${field} is empty`)),
      });
    }
  });

  it('refuses a salt or nonce of the wrong byte length, and says by how much', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    const b64 = (bytes: number) => Buffer.from(new Uint8Array(bytes)).toString('base64url');
    await expect(
      openPassportBackup({ ...envelope, salt: b64(15) }, PASSWORD),
    ).rejects.toThrow(/salt is 15 bytes; a Passport backup's salt is 16/);
    await expect(
      openPassportBackup({ ...envelope, nonce: b64(8) }, PASSWORD),
    ).rejects.toMatchObject({
      code: 'not-a-backup',
      message: expect.stringMatching(/nonce is 8 bytes/),
    });
    // Not "the password is wrong" — that is the sentence this replaces.
    await expect(
      openPassportBackup({ ...envelope, nonce: b64(8) }, PASSWORD),
    ).rejects.not.toThrow(/password is wrong/);
  });

  it('refuses a ciphertext too short to hold even the tag', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    await expect(
      openPassportBackup(
        { ...envelope, ciphertext: Buffer.from(new Uint8Array(16)).toString('base64url') },
        PASSWORD,
      ),
    ).rejects.toThrow(/too few to hold even the authentication tag/);
  });

  it('applies the same lengths to a file read as text', () => {
    expect(() =>
      parseBackupEnvelope(
        JSON.stringify({
          v: PASSPORT_BACKUP_VERSION,
          kdf: PASSPORT_BACKUP_KDF,
          salt: 'AAAA',
          nonce: '',
          ciphertext: 'AAAA',
        }),
      ),
    ).toThrow(/salt is 3 bytes/);
  });
});

/* -------------------------------------------------------------------------- */
/* The KDF descriptor as a family, not a literal                              */
/* -------------------------------------------------------------------------- */

describe('reading a backup sealed with different KDF parameters', () => {
  /** Seals this module's own payload under an ARBITRARY descriptor. */
  async function sealWith(
    hash: string,
    iterations: number,
    password: string,
    payload: PassportBackupContents = contents(),
  ) {
    const kdf = `PBKDF2-${hash}-${iterations}`;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash, salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: new TextEncoder().encode(
          `midnight-passport:backup:v1 ${PASSPORT_BACKUP_VERSION} ${kdf}`,
        ),
      },
      key,
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    return {
      v: PASSPORT_BACKUP_VERSION,
      kdf,
      salt: b64(salt),
      nonce: b64(nonce),
      ciphertext: b64(new Uint8Array(ciphertext)),
    };
  }

  it('opens a file sealed with a higher iteration count than this build writes', async () => {
    /* The day OWASP's recommendation moves, `PASSPORT_BACKUP_KDF` moves with
       it — and every file already written must still open. The count comes out
       of the file, which is safe because the descriptor is authenticated. */
    const envelope = await sealWith('SHA-256', 700_000, PASSWORD);
    const opened = await openPassportBackup(envelope, PASSWORD);
    expect(opened.aliases.preview?.alias).toBe('alice');
  });

  it('opens a file sealed under another hash in the same family', async () => {
    const envelope = await sealWith('SHA-512', 210_000, PASSWORD);
    expect((await openPassportBackup(envelope, PASSWORD)).aliases.preview?.alias).toBe('alice');
  });

  it('still refuses a count below the floor, above the ceiling, or unreadable', async () => {
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    for (const [kdf, message] of [
      ['PBKDF2-SHA-256-1000', /runs between 100000 and 10000000/],
      ['PBKDF2-SHA-256-99999999', /runs between 100000 and 10000000/],
      ['PBKDF2-SHA-384-600000', /this Passport runs SHA-256 and SHA-512/],
      ['scrypt-16384-8-1', /could not read that as one of them/],
      ['PBKDF2-SHA-256', /could not read that as one of them/],
    ] as const) {
      await expect(openPassportBackup({ ...envelope, kdf }, PASSWORD)).rejects.toMatchObject({
        code: 'unsupported-kdf',
        message: expect.stringMatching(message),
      });
    }
  });

  it('refuses a file whose authenticated count was rewritten within the range', async () => {
    /* Parsing the count is only safe because the tag covers it: an attacker
       who lowers 600,000 to 100,000 derives a different key and fails GCM. */
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    await expect(
      openPassportBackup({ ...envelope, kdf: 'PBKDF2-SHA-256-100000' }, PASSWORD),
    ).rejects.toMatchObject({ code: 'wrong-password-or-tampered' });
  });
});

/* -------------------------------------------------------------------------- */
/* The allow-list, as a structure rather than a list of suspicious words       */
/* -------------------------------------------------------------------------- */

describe('the fields a payload may carry', () => {
  it('refuses key names a blocklist of likely words would miss', () => {
    for (const field of ['privKey', 'sk', 'signing_key', 'entropy', 'xprv', 'viewingKey']) {
      const poisoned = contents() as unknown as Record<string, unknown>;
      poisoned.aliases = { preview: { ...contents().aliases.preview, [field]: 'aa' } };
      expect(() => assertNoKeyMaterial(poisoned)).toThrow(/state, never keys/);
    }
  });

  it('names a value that is the size of a key, wherever it is hiding', () => {
    const poisoned = contents() as unknown as Record<string, unknown>;
    poisoned.passportContracts = {
      'AQIDBA==::preview': { ...contents().passportContracts['AQIDBA==::preview'], note: 'ab'.repeat(32) },
    };
    expect(() => assertNoKeyMaterial(poisoned)).toThrow(/is the size of one/);
  });

  it('refuses an unknown field even when it looks harmless', () => {
    const poisoned = contents() as unknown as Record<string, unknown>;
    poisoned.incentives = [{ ...contents().incentives[0], colour: 'red' }];
    expect(() => assertNoKeyMaterial(poisoned)).toThrow(/is not a field a Passport backup carries/);
  });

  it('refuses a nested object where a record field takes a plain value', () => {
    const poisoned = contents() as unknown as Record<string, unknown>;
    poisoned.aliases = { preview: { ...contents().aliases.preview, alias: { hidden: 'aa' } } };
    expect(() => assertNoKeyMaterial(poisoned)).toThrow(/nested object where a plain value belongs/);
  });

  it('lets every field the three record types really carry through', () => {
    expect(() => assertNoKeyMaterial(contents())).not.toThrow();
    // And a non-object is not this check's business to refuse.
    expect(() => assertNoKeyMaterial('a backup')).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* What a restore refuses to believe                                          */
/* -------------------------------------------------------------------------- */

describe('a file that claims more than a file can know', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('refuses a corrupt record before it writes anything at all', async () => {
    const broken = contents() as unknown as { passportContracts: Record<string, unknown> };
    broken.passportContracts = { 'AQIDBA==::preview': null };
    await expect(applyPassportBackup(broken as PassportBackupContents)).rejects.toMatchObject({
      code: 'corrupt-contents',
    });
    // Nothing was half-written on the way to the crash.
    expect(Object.keys((await collectPassportBackup()).aliases)).toEqual([]);
  });

  it('refuses an aliases container that is not a set of records', async () => {
    const broken = contents() as unknown as { aliases: unknown };
    broken.aliases = [];
    await expect(applyPassportBackup(broken as PassportBackupContents)).rejects.toThrow(
      /not a set of records/,
    );
  });

  it('refuses a recovered contract record outright', async () => {
    /* `recovered` says "this device read the address out of the passkey's own
       largeBlob and the indexer answered". A file cannot have done either. */
    const forged = contents();
    Object.assign(forged.passportContracts['AQIDBA==::preview']!, {
      recovered: true,
      ledgerConfirmed: true,
      deployTxId: undefined,
      updatedAt: '9999-12-31T00:00:00.000Z',
    });
    const summary = await applyPassportBackup(forged);
    expect(summary.passportContracts.restored).toBe(0);
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(/left for your passkey to re-seed/);
    expect((await collectPassportBackup()).passportContracts).toEqual({});
  });

  it('writes a contract record the file called confirmed as unconfirmed', async () => {
    const summary = await applyPassportBackup(contents());
    expect(summary.passportContracts.restored).toBe(1);
    const stored = (await collectPassportBackup()).passportContracts['AQIDBA==::preview'];
    expect(stored?.ledgerConfirmed).toBe(false);
    expect(stored?.address).toBe('cc'.repeat(32));
  });

  it('refuses an address or a transaction id that is not the shape of one', async () => {
    for (const [field, value, message] of [
      ['address', 'attacker', /not 64 hex characters/],
      ['deployTxId', 'x', /not a transaction id/],
      ['deviceCommitment', 'not a field', /not a Field/],
    ] as const) {
      const forged = contents();
      Object.assign(forged.passportContracts['AQIDBA==::preview']!, { [field]: value });
      const summary = await applyPassportBackup(forged);
      expect(summary.passportContracts.restored).toBe(0);
      expect(summary.passportContracts.skipped[0]?.reason).toMatch(message);
    }
  });

  it('never overwrites a contract record the indexer has confirmed here', async () => {
    await applyPassportBackup(contents());
    // What the ledger re-check does after a restore: it, and only it, confirms.
    const { savePassportContractRecord } = await import('./passportContractStore.js');
    savePassportContractRecord({
      ...contents().passportContracts['AQIDBA==::preview']!,
      ledgerConfirmed: true,
      updatedAt: '2026-08-20T00:00:00.000Z',
    });

    const forged = contents();
    Object.assign(forged.passportContracts['AQIDBA==::preview']!, {
      address: 'ab'.repeat(32),
      updatedAt: '9999-12-31T00:00:00.000Z',
    });
    const summary = await applyPassportBackup(forged);
    expect(summary.passportContracts.restored).toBe(0);
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(/the indexer confirmed/);
    expect((await collectPassportBackup()).passportContracts['AQIDBA==::preview']?.address).toBe(
      'cc'.repeat(32),
    );
  });

  it('writes a restored name as awaiting the registry, whatever the file says', async () => {
    const summary = await applyPassportBackup(contents());
    expect(summary.aliases.restored).toBe(1);
    // The file said `registryConfirmed: true`. Only a registry read may.
    expect((await collectPassportBackup()).aliases.preview?.registryConfirmed).toBe(false);
  });

  it('never overwrites a name the registry has confirmed here', async () => {
    const { saveAliasRecord } = await import('./aliasStore.js');
    saveAliasRecord({ ...contents().aliases.preview!, updatedAt: '2026-08-20T00:00:00.000Z' });
    const forged = contents();
    forged.aliases.preview!.alias = 'attacker';
    forged.aliases.preview!.updatedAt = '9999-12-31T00:00:00.000Z';
    const summary = await applyPassportBackup(forged);
    expect(summary.aliases.restored).toBe(0);
    expect(summary.aliases.skipped[0]?.reason).toMatch(/the registry itself confirmed/);
    expect((await collectPassportBackup()).aliases.preview?.alias).toBe('alice');
  });

  it('refuses a record whose status is not one a store has', async () => {
    const forged = contents();
    (forged.aliases.preview as { status: string }).status = 'confirmed';
    (forged.passportContracts['AQIDBA==::preview'] as { status: string }).status = 'live';
    (forged.incentives[0] as { label?: string }).label = undefined;
    const summary = await applyPassportBackup(forged);
    expect(summary.aliases.skipped[0]?.reason).toMatch(/not a status an alias record has/);
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(
      /not a status a contract record has/,
    );
    expect(summary.incentives.skipped[0]?.reason).toMatch(/missing the fields a reward has/);
  });

  it('refuses a name or a reward id that is not the shape of one', async () => {
    const nameless = contents();
    (nameless.aliases.preview as { alias?: string }).alias = '';
    const second = await applyPassportBackup(nameless);
    expect(second.aliases.skipped[0]?.reason).toMatch(/no name to restore/);

    const badTx = contents();
    forgeTxIds(badTx);
    const third = await applyPassportBackup(badTx);
    expect(third.aliases.skipped[0]?.reason).toMatch(/registerTxId is not a transaction id/);
    expect(third.incentives.skipped[0]?.reason).toMatch(/txId is not a transaction id/);
  });
});

/** Puts ids that are not transaction ids into a payload, in one place. */
function forgeTxIds(payload: PassportBackupContents): void {
  payload.aliases.preview!.registerTxId = 'not-a-txid';
  payload.incentives[0]!.txId = 'nope';
}

/* -------------------------------------------------------------------------- */
/* One write per store, and a count of what actually landed                    */
/* -------------------------------------------------------------------------- */

/** A `localStorage` that counts, drops, or throws — the three cases that matter. */
function installStorageThat(behaviour: 'counts' | 'drops' | 'throws'): {
  writes: string[];
} {
  const map = new Map<string, string>();
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
          writes.push(key);
          if (behaviour === 'throws') throw new Error('the quota is full');
          if (behaviour === 'drops') return;
          map.set(key, value);
        },
        removeItem: (key: string) => void map.delete(key),
      },
    },
  });
  return { writes };
}

/** A payload with `count` records in each of the three stores. */
function manyRecords(count: number): PassportBackupContents {
  const payload = contents();
  payload.aliases = {};
  payload.passportContracts = {};
  payload.incentives = [];
  for (let index = 0; index < count; index += 1) {
    payload.aliases[`net-${index}`] = {
      ...contents().aliases.preview!,
      network: `net-${index}`,
    };
    payload.passportContracts[`key-${index}`] = {
      ...contents().passportContracts['AQIDBA==::preview']!,
      credentialId: `cred-${index}`,
    };
    payload.incentives.push({
      ...contents().incentives[0]!,
      id: `reward-${index}`,
      redeemedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, count - index)).toISOString(),
    });
  }
  return payload;
}

describe('what a restore costs, and what it counts', () => {
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('writes each store exactly once, however many records the file carries', async () => {
    const storage = installStorageThat('counts');
    const summary = await applyPassportBackup(manyRecords(12));
    expect(summary.aliases.restored).toBe(12);
    expect(summary.passportContracts.restored).toBe(12);
    expect(summary.incentives.restored).toBe(12);
    /* Three `setItem` calls for thirty-six records — one per store. A save per
       record re-serialised each store's whole map and notified every React
       subscriber, once per record. */
    expect(storage.writes).toEqual([
      'passport-alias:v1',
      'passport-contract:v1',
      'passport-incentives:v1',
    ]);
  });

  it('counts nothing as restored when storage refuses the write', async () => {
    installStorageThat('throws');
    const summary = await applyPassportBackup(contents());
    for (const store of [summary.aliases, summary.passportContracts, summary.incentives]) {
      expect(store.restored).toBe(0);
      expect(store.restoredKeys).toEqual([]);
      expect(store.skipped[0]?.reason).toMatch(/refused to store the record: the quota is full/);
    }
  });

  it('counts nothing as restored when the write does not read back', async () => {
    /* Safari in private mode, and every storage that accepts a write and keeps
       nothing. The old code counted the attempt and told the user "1 of 1". */
    installStorageThat('drops');
    const summary = await applyPassportBackup(contents());
    for (const store of [summary.aliases, summary.passportContracts, summary.incentives]) {
      expect(store.restored).toBe(0);
      expect(store.skipped[0]?.reason).toMatch(/did not read back/);
    }
  });
});

describe('two entries in one file that land on one key', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('keeps the newer of them and says the older was not written', async () => {
    /* The store's key is derived from the record, not taken from the file, so
       two entries can collapse onto one. Compared only against the pre-restore
       snapshot, the second one always won — including when it was years old. */
    const payload = contents();
    payload.passportContracts = {
      recent: {
        ...contents().passportContracts['AQIDBA==::preview']!,
        address: 'ab'.repeat(32),
        updatedAt: '2026-08-19T00:00:00.000Z',
      },
      stale: {
        ...contents().passportContracts['AQIDBA==::preview']!,
        address: 'ba'.repeat(32),
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
    };
    const summary = await applyPassportBackup(payload);
    expect(summary.passportContracts).toMatchObject({ found: 2, restored: 1 });
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(
      /the file carries another record for this credential and network/,
    );
    expect((await collectPassportBackup()).passportContracts['AQIDBA==::preview']?.address).toBe(
      'ab'.repeat(32),
    );
  });

  it('prefers the newer entry whichever order the file lists them in', async () => {
    const payload = contents();
    payload.passportContracts = {
      stale: {
        ...contents().passportContracts['AQIDBA==::preview']!,
        address: 'ba'.repeat(32),
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
      recent: {
        ...contents().passportContracts['AQIDBA==::preview']!,
        address: 'ab'.repeat(32),
        updatedAt: '2026-08-19T00:00:00.000Z',
      },
    };
    const summary = await applyPassportBackup(payload);
    expect(summary.passportContracts.restored).toBe(1);
    /* One pair of sentences for both sides of a collision, read against the
       record that really wins the key — see `DeferredReason`. */
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(
      /dated "2026-08-19T00:00:00\.000Z", which was restored instead/,
    );
    expect((await collectPassportBackup()).passportContracts['AQIDBA==::preview']?.address).toBe(
      'ab'.repeat(32),
    );
  });

  it('writes one copy of a reward the file carries twice', async () => {
    const payload = contents();
    payload.incentives = [contents().incentives[0]!, contents().incentives[0]!];
    const summary = await applyPassportBackup(payload);
    expect(summary.incentives).toMatchObject({ found: 2, restored: 1 });
    expect(summary.incentives.skipped[0]?.reason).toMatch(/carries this reward twice/);
  });
});

describe('timestamps that cannot be compared', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('says a repeated restore found the same record, not a newer one', async () => {
    await applyPassportBackup(contents());
    const summary = await applyPassportBackup(contents());
    expect(summary.aliases.skipped[0]?.reason).toBe(
      'this browser already holds this record, unchanged',
    );
  });

  it('says so when a local timestamp cannot be read, rather than claiming it is newer', async () => {
    /* A corrupted local `updatedAt` used to make every comparison false, so
       the key could never be restored again and the summary asserted a newer
       local record that did not exist. */
    window.localStorage.setItem(
      'passport-alias:v1',
      JSON.stringify({
        preview: { ...contents().aliases.preview, registryConfirmed: false, updatedAt: 'whenever' },
      }),
    );
    const summary = await applyPassportBackup(contents());
    expect(summary.aliases.restored).toBe(0);
    expect(summary.aliases.skipped[0]?.reason).toMatch(/which cannot be ordered/);
    expect(summary.aliases.skipped[0]?.reason).toContain('whenever');
  });
});

describe('rewards keep their order, and the cap keeps the newest', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('restores a file of sixty newest-first and drops only the oldest ten', async () => {
    const payload = manyRecords(60);
    payload.aliases = {};
    payload.passportContracts = {};
    const summary = await applyPassportBackup(payload);

    expect(summary.incentives.found).toBe(60);
    expect(summary.incentives.restored).toBe(50);
    expect(summary.incentives.skipped).toHaveLength(10);
    expect(summary.incentives.skipped[0]?.reason).toMatch(/50 most recent rewards/);

    const stored = (await collectPassportBackup()).incentives;
    expect(stored).toHaveLength(50);
    // Newest first, and the newest is still there — the cap fell on the oldest.
    expect(stored[0]?.id).toBe('reward-0');
    expect(stored[49]?.id).toBe('reward-49');
    expect(stored.some((record) => record.id === 'reward-59')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Re-checking a restored name against the registry                           */
/* -------------------------------------------------------------------------- */

describe('a restored name, against the registry that would know', () => {
  beforeEach(() => installStorage());
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    vi.doUnmock('./midnames.js');
    vi.doUnmock('./aliasStore.js');
    vi.resetModules();
  });

  /** Imports `backup.js` with the registry answering `target`. */
  async function withRegistry(target: unknown) {
    vi.resetModules();
    vi.doMock('./midnames.js', () => ({
      MIDNAMES_INDEXER_URLS: { stagenet: '', preview: '', preprod: '', mainnet: '' },
      resolveAliasTarget: async () =>
        target === 'unreachable' ? Promise.reject(new Error('no indexer')) : target,
    }));
    return import('./backup.js');
  }

  it('confirms a restored name only where the registry points at the contract', async () => {
    /* `contents()` deploys this Passport's contract at `cc…cc` on preview, and
       that — not merely "a contract" — is what the leaf must point at. */
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'cc'.repeat(32) },
    });
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice);

    expect(summary.registryCheck).toEqual({
      ran: true,
      confirmed: 1,
      unconfirmed: 0,
      otherNetworks: 0,
      notRegistered: 0,
    });
    const stored = (await module.collectPassportBackup()).aliases.preview;
    expect(stored?.registryConfirmed).toBe(true);
    expect(stored?.resolverTargetHex).toBe('cc'.repeat(32));
  });

  it('leaves a name the registry does not answer for awaiting the registry', async () => {
    const module = await withRegistry(null);
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice);

    expect(summary.registryCheck).toMatchObject({
      ran: true,
      confirmed: 0,
      unconfirmed: 1,
      unconfirmedReasons: [{ network: 'preview', reason: 'the registry had no answer for this name' }],
    });
    expect((await module.collectPassportBackup()).aliases.preview?.registryConfirmed).toBe(false);
  });

  it('treats a name pointing somewhere else as unconfirmed, not as agreement', async () => {
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'wallet', hex: 'ff'.repeat(32) },
    });
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice)).registryCheck).toMatchObject({
      unconfirmed: 1,
      unconfirmedReasons: [
        { network: 'preview', reason: expect.stringContaining('to a wallet target') },
      ],
    });
  });

  it('reports an unreachable registry as a check that did not confirm', async () => {
    const module = await withRegistry('unreachable');
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice)).registryCheck).toMatchObject({
      ran: true,
      confirmed: 0,
      unconfirmed: 1,
    });
    expect((await module.collectPassportBackup()).aliases.preview?.registryConfirmed).toBe(false);
  });

  it('leaves a name claimed on a network it cannot read alone, and counts it', async () => {
    const module = await withRegistry(null);
    const payload = contents();
    payload.aliases = { localnet: { ...contents().aliases.preview!, network: 'localnet' } };
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice)).registryCheck).toMatchObject({
      ran: true,
      otherNetworks: 1,
    });
  });

  it('does not count a confirmation this browser could not store', async () => {
    /* "Confirmed" is a claim about what is in storage, so it is counted from
       the write's own read-back rather than from the registry's answer. */
    vi.resetModules();
    vi.doMock('./midnames.js', () => ({
      MIDNAMES_INDEXER_URLS: { stagenet: '', preview: '', preprod: '', mainnet: '' },
      resolveAliasTarget: async () => ({
        resolverAddress: '0200beef',
        target: { kind: 'contract', hex: 'cc'.repeat(32) },
      }),
    }));
    const held: Record<string, unknown> = {};
    let writes = 0;
    vi.doMock('./aliasStore.js', () => ({
      loadAliasRecords: () => held,
      restoreAliasRecords: (records: { network: string }[]) =>
        records.map((record) => {
          writes += 1;
          if (writes > 1) {
            return { network: record.network, written: false, reason: 'storage went away' };
          }
          held[record.network] = record;
          return { network: record.network, written: true };
        }),
    }));

    const module = await import('./backup.js');
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice);
    expect(summary.aliases.restored).toBe(1);
    expect(summary.registryCheck).toMatchObject({
      ran: true,
      confirmed: 0,
      unconfirmed: 1,
      unconfirmedReasons: [
        { network: 'preview', reason: 'this browser did not store the confirmation, so it is not claimed' },
      ],
    });
  });

  it('says there was nothing to check when the backup wrote no names', async () => {
    const module = await withRegistry(null);
    const payload = contents();
    payload.aliases = {};
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice)).registryCheck).toEqual({
      ran: false,
      reason: 'the backup wrote no name claims, so there was nothing to check.',
    });
  });

  it('does not re-check a name that was restored as queued', async () => {
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'cc'.repeat(32) },
    });
    const payload = contents();
    payload.aliases.preview = {
      ...contents().aliases.preview!,
      status: 'queued',
      queuedReason: 'the registry was unreachable',
    };
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice);
    expect(summary.aliases.restored).toBe(1);
    /* It is not re-checked, and it is COUNTED — the four buckets add up to the
       number of names the same summary says were restored. */
    expect(summary.registryCheck).toEqual({
      ran: true,
      confirmed: 0,
      unconfirmed: 0,
      otherNetworks: 0,
      notRegistered: 1,
      notRegisteredReasons: [
        {
          network: 'preview',
          reason:
            'the restored claim is queued, not registered — there is no registration yet for the registry to answer for',
        },
      ],
    });
  });

  /* ------------------------------------------------------------------------ */
  /* "points at a contract" is not the question; "points at MINE" is           */
  /* ------------------------------------------------------------------------ */

  it('refuses to confirm a name the registry binds to another account', async () => {
    /* The name expired and somebody else registered it. Their leaf is a
       CONTRACT target too, so kind alone confirmed it and put their name on
       this Passport's identity card. */
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'ff'.repeat(32) },
    });
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice);

    expect(summary.registryCheck).toMatchObject({
      ran: true,
      confirmed: 0,
      unconfirmed: 1,
      unconfirmedReasons: [
        { network: 'preview', reason: expect.stringContaining('registered to a different account') },
      ],
    });
    expect((await module.collectPassportBackup()).aliases.preview?.registryConfirmed).toBe(false);
  });

  it('does not confirm a name when this browser holds no contract on that network', async () => {
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'cc'.repeat(32) },
    });
    const payload = contents();
    payload.passportContracts = {};
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice)).registryCheck).toMatchObject({
      confirmed: 0,
      unconfirmedReasons: [
        { network: 'preview', reason: expect.stringContaining('holds no Passport contract') },
      ],
    });
  });

  it('refuses to confirm a name claimed under a domain Passport does not register', async () => {
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'cc'.repeat(32) },
    });
    const payload = contents();
    payload.aliases.preview = { ...contents().aliases.preview!, domain: 'day' };
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice)).registryCheck).toMatchObject({
      confirmed: 0,
      unconfirmedReasons: [
        { network: 'preview', reason: expect.stringContaining('.night') },
      ],
    });
  });

  it('compares against every contract this browser holds on that network', async () => {
    /* Two credentials, two contracts, one network — and a failed record that
       is no address at all. The name is bound to the second one. */
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'ab'.repeat(32) },
    });
    const template = contents().passportContracts['AQIDBA==::preview']!;
    const payload = contents();
    payload.passportContracts = {
      first: { ...template, credentialId: 'one', address: 'cc'.repeat(32) },
      second: { ...template, credentialId: 'two', address: 'ab'.repeat(32) },
      broken: {
        credentialId: 'three',
        network: 'preview',
        status: 'failed',
        failureReason: 'the proof server was unreachable',
        updatedAt: '2026-08-19T08:58:00.000Z',
      },
    };
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice)).registryCheck).toEqual({
      ran: true,
      confirmed: 1,
      unconfirmed: 0,
      otherNetworks: 0,
      notRegistered: 0,
    });
  });

  it('matches an address the file shouted in upper case', async () => {
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'CC'.repeat(32) },
    });
    const payload = contents();
    payload.passportContracts['AQIDBA==::preview']!.address = 'CC'.repeat(32);
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice);
    expect(summary.registryCheck).toMatchObject({ confirmed: 1 });
    const stored = await module.collectPassportBackup();
    expect(stored.passportContracts['AQIDBA==::preview']?.address).toBe('cc'.repeat(32));
    expect(stored.aliases.preview?.resolverTargetHex).toBe('cc'.repeat(32));
  });
});

/* -------------------------------------------------------------------------- */
/* Saving a file, and knowing whether it was saved                            */
/* -------------------------------------------------------------------------- */

describe('the save path that can report back', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'showSaveFilePicker');
    Reflect.deleteProperty(globalThis, 'document');
  });

  function installPicker(behaviour: 'writes' | 'cancelled' | 'unavailable'): { written: string[] } {
    const written: string[] = [];
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        if (behaviour === 'cancelled') {
          const error = new Error('The user aborted a request.');
          error.name = 'AbortError';
          throw error;
        }
        if (behaviour === 'unavailable') throw new Error('this document is not active');
        return {
          name: 'my-passport.json',
          createWritable: async () => ({
            write: async (data: string) => void written.push(data),
            close: async () => {},
          }),
        };
      },
    });
    return { written };
  }

  it('says where the file went, because the picker resolves only once it is written', async () => {
    const picker = installPicker('writes');
    const outcome = await fileBackupBackend.write('passport-backup.json', '{"v":1}');
    expect(outcome).toEqual({
      kind: 'saved',
      fileName: 'passport-backup.json',
      location: 'my-passport.json, where you chose to save it',
    });
    expect(picker.written).toEqual(['{"v":1}']);
  });

  it('falls back to the suggested name when the handle does not carry one', async () => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      }),
    });
    expect(await fileBackupBackend.write('passport-backup.json', '{}')).toEqual({
      kind: 'saved',
      fileName: 'passport-backup.json',
      location: 'passport-backup.json, where you chose to save it',
    });
  });

  it('reports a cancelled save as no backup at all', async () => {
    installPicker('cancelled');
    await expect(fileBackupBackend.write('passport-backup.json', '{}')).rejects.toMatchObject({
      code: 'backup-not-written',
      message: 'The save was cancelled, so no backup file was written.',
    });
  });

  it('falls back to the download when the picker itself cannot run', async () => {
    installPicker('unavailable');
    const anchors: Record<string, unknown>[] = [];
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => {
          const anchor: Record<string, unknown> = { click: () => {}, remove: () => {} };
          anchors.push(anchor);
          return anchor;
        },
        body: { append: () => {} },
      },
    });
    const realUrl = globalThis.URL;
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      writable: true,
      value: Object.assign(Object.create(URL), {
        createObjectURL: () => 'blob:passport/2',
        revokeObjectURL: () => {},
      }),
    });
    try {
      const outcome = await fileBackupBackend.write('passport-backup.json', '{}');
      expect(outcome).toMatchObject({ kind: 'handed-to-browser' });
      expect(anchors).toHaveLength(1);
    } finally {
      Object.defineProperty(globalThis, 'URL', { value: realUrl, configurable: true, writable: true });
    }
  });

  it('is available wherever either path is', () => {
    installPicker('writes');
    Reflect.deleteProperty(globalThis, 'document');
    expect(fileBackupBackend.isAvailable()).toBe(true);
  });

  it('reports a write that failed after the picker as no backup at all', async () => {
    /* The picker resolved, so the user believes they chose a file — and then
       the handle refused. Falling through to the download path would put a
       second file somewhere they did not choose, and letting the DOMException
       out would put its own words on the screen. */
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        name: 'my-passport.json',
        createWritable: async () => {
          throw new Error('the volume is read-only');
        },
      }),
    });
    await expect(fileBackupBackend.write('passport-backup.json', '{}')).rejects.toMatchObject({
      code: 'backup-not-written',
      message:
        'The file you chose could not be written, so no backup was saved: the volume is read-only',
    });
  });

  it('says the same when the write itself throws something that is not an Error', async () => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({
          write: async () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'the disk is full';
          },
          close: async () => {},
        }),
      }),
    });
    await expect(fileBackupBackend.write('passport-backup.json', '{}')).rejects.toMatchObject({
      code: 'backup-not-written',
      message: expect.stringContaining('the disk is full'),
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The edges of the two guards, and of the record shapes                      */
/* -------------------------------------------------------------------------- */

describe('the guards at their edges', () => {
  it('leaves a container it cannot walk to the corrupt-contents check', () => {
    /* Two questions, two answers: "is this dangerous" and "is this corrupt".
       The structural guard declines the second rather than answering it with
       the wrong code. */
    expect(() => assertNoKeyMaterial({ aliases: 'not a map' })).not.toThrow();
    expect(() => assertNoKeyMaterial({ aliases: { preview: null } })).not.toThrow();
    expect(() => assertNoKeyMaterial({ incentives: [null, 'a reward'] })).not.toThrow();
  });

  it('reads 64 bytes of hex as a key, and ordinary words as words', () => {
    const withField = (value: unknown) => {
      const poisoned = contents() as unknown as Record<string, unknown>;
      poisoned.incentives = [{ ...contents().incentives[0], note: value }];
      return () => assertNoKeyMaterial(poisoned);
    };
    expect(withField('ab'.repeat(64))).toThrow(/is the size of one/);
    expect(withField('a sentence, with punctuation')).toThrow(
      /is not a field a Passport backup carries/,
    );
    expect(withField('short')).toThrow(/is not a field a Passport backup carries/);
  });

  it('refuses an incentives list that is not a list, and an entry that is not a record', async () => {
    installStorage();
    try {
      const notAList = contents() as unknown as { incentives: unknown };
      notAList.incentives = {};
      await expect(applyPassportBackup(notAList as PassportBackupContents)).rejects.toThrow(
        /incentives are not a list/,
      );
      const notARecord = contents() as unknown as { incentives: unknown[] };
      notARecord.incentives = [null];
      await expect(applyPassportBackup(notARecord as PassportBackupContents)).rejects.toThrow(
        /incentive at position 0 is not a record/,
      );
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });
});

describe('the fields a record may leave out', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('never carries a resolver target out of a file, whatever shape it is in', async () => {
    /* `resolverTargetHex` is the ADDRESS the Receive sheet falls back to for
       "Your account", and it consults no confirmation flag before it does.
       A file's word for where a name points is therefore a file's word for
       where the user's money should be sent, and it does not travel — the
       registry re-check writes both fields back when it can confirm the name,
       and until then the pair is simply absent. */
    const payload = contents();
    delete payload.aliases.preview!.resolverTarget;
    payload.aliases.preview!.resolverTargetHex = 'ff'.repeat(32);
    const summary = await applyPassportBackup(payload);
    expect(summary.aliases.restored).toBe(1);
    const stored = (await collectPassportBackup()).aliases.preview;
    expect(stored?.resolverTargetHex).toBeUndefined();
    expect(stored?.resolverTarget).toBeUndefined();

    // …and a well-formed one from an attacker's file fares exactly the same.
    const crafted = contents();
    crafted.aliases.preview!.resolverTarget = 'contract';
    crafted.aliases.preview!.resolverTargetHex = 'ab'.repeat(32);
    crafted.aliases.preview!.updatedAt = '2027-01-01T00:00:00.000Z';
    await applyPassportBackup(crafted);
    const after = (await collectPassportBackup()).aliases.preview;
    expect(after?.resolverTargetHex).toBeUndefined();
    expect(after?.resolverTarget).toBeUndefined();
  });

  it('restores a failed contract record with its reason and no fee payer', async () => {
    const payload = contents();
    payload.passportContracts['AQIDBA==::preview'] = {
      credentialId: 'AQIDBA==',
      network: 'preview',
      status: 'failed',
      failureReason: 'the proof server refused',
      feePaidBy: 'someone else' as unknown as 'sponsored',
      updatedAt: '2026-08-19T08:58:00.000Z',
    };
    const summary = await applyPassportBackup(payload);
    expect(summary.passportContracts.restored).toBe(1);
    const stored = (await collectPassportBackup()).passportContracts['AQIDBA==::preview'];
    expect(stored?.failureReason).toBe('the proof server refused');
    // A fee payer that is not one of the two this app records does not travel.
    expect(stored?.feePaidBy).toBeUndefined();
  });

  it('restores a contract record and a reward that carry no timestamp or network', async () => {
    const payload = contents();
    // A real deployment records the device commitment; it travels as written.
    payload.passportContracts['AQIDBA==::preview']!.deviceCommitment = '12345678901234567890';
    delete (payload.passportContracts['AQIDBA==::preview'] as { updatedAt?: string }).updatedAt;
    delete (payload.incentives[0] as { network?: string }).network;
    const summary = await applyPassportBackup(payload);
    expect(summary.passportContracts.restored).toBe(1);
    expect(summary.incentives.restored).toBe(1);
    /* The store does NOT stamp a record that arrives without a timestamp: an
       invented date outranks a genuine backup for ever. See the store's own
       `updatedAt`. */
    const stored = (await collectPassportBackup()).passportContracts['AQIDBA==::preview'];
    expect(stored?.updatedAt).toBeUndefined();
    expect(stored?.deviceCommitment).toBe('12345678901234567890');
    expect((await collectPassportBackup()).incentives[0]?.network).toBe('');
  });

  it('names a contract record it cannot key, and keys the one it can', async () => {
    const nameless = contents();
    (nameless.passportContracts['AQIDBA==::preview'] as { credentialId: unknown }).credentialId = 42;
    const first = await applyPassportBackup(nameless);
    expect(first.passportContracts.skipped[0]).toEqual({
      key: 'an unnamed contract record',
      reason: expect.stringMatching(/names no credential and network/),
    });

    const networkless = contents();
    networkless.passportContracts['AQIDBA==::preview']!.network = '';
    const second = await applyPassportBackup(networkless);
    expect(second.passportContracts.skipped[0]?.reason).toMatch(/names no credential and network/);
  });

  it('names a reward it cannot key', async () => {
    const payload = contents();
    delete (payload.incentives[0] as { id?: string }).id;
    const summary = await applyPassportBackup(payload);
    expect(summary.incentives.skipped[0]?.key).toBe('an unnamed reward');
  });
});

/* -------------------------------------------------------------------------- */
/* The tripwires on top of the structural allow-list                          */
/* -------------------------------------------------------------------------- */

describe('a value that is the size of a key, under a name the allow-list justified', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('restores it, because the allow-list on NAMES is the whole contract', async () => {
    /* The value tripwire on the three free-text fields is gone (2026/08/26).
       It refused ordinary app-written text — a 43-character reward slug is 32
       bytes of base64 by its arithmetic — and it refused it on import only,
       so a file this app exported cleanly could never restore that record on
       any device. It was a guess that destroyed data and could not keep a
       determined secret out either way. */
    const payload = contents();
    payload.aliases.preview!.status = 'queued';
    payload.aliases.preview!.queuedReason = 'ab'.repeat(32);
    payload.incentives[0]!.label = Buffer.alloc(32, 7).toString('base64');
    const summary = await applyPassportBackup(payload);

    expect(summary.aliases.restored).toBe(1);
    expect(summary.incentives.restored).toBe(1);
    expect(summary.aliases.skipped).toEqual([]);
    expect(summary.incentives.skipped).toEqual([]);
  });

  it('still refuses the same value under a name nobody justified, and names it', () => {
    /* What actually holds the invariant: a field whose NAME is not on the list
       is refused whatever its value, and `looksLikeSecret` survives only to
       word that refusal. */
    const poisoned = contents() as unknown as Record<string, unknown>;
    poisoned.aliases = {
      preview: { ...contents().aliases.preview, note: 'ab'.repeat(32) },
    };
    expect(() => assertNoKeyMaterial(poisoned)).toThrow(/is the size of one/);
  });
});

describe('record containers a file may not carry', () => {
  it('refuses a store keyed `__proto__`, before any store sees it', () => {
    /* `records['__proto__'] = record` on an ordinary object sets a prototype
       and stores nothing, and the read-back that decides whether a record was
       written then answers from `Object.prototype`. JSON.parse is how such a
       file really arrives — an object literal would set the prototype here
       instead of creating the property. */
    const payload = contents();
    payload.aliases = JSON.parse('{"__proto__": {"alias": "evil"}}');
    expect(() => assertBackupRecordContainers(payload)).toThrow(
      /keyed "__proto__", which is not a key a store may hold/,
    );
    expect(() => assertBackupRecordContainers(payload)).toThrow(/Nothing was written/);
  });

  it('refuses an incentive identified as one of those names', () => {
    // A reward is keyed by its own id wherever a caller holds a set of them.
    const payload = contents();
    payload.incentives[0]!.id = 'constructor';
    expect(() => assertBackupRecordContainers(payload)).toThrow(
      /identified as "constructor", which is not an id a store may hold/,
    );
  });

  it('accepts the containers a real backup carries', () => {
    expect(() => assertBackupRecordContainers(contents())).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* What an adversarial file may claim, and what the stores may report          */
/* -------------------------------------------------------------------------- */

describe('a record key that is not a key a store may hold', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  /**
   * `__proto__` has to arrive through `JSON.parse` to be an OWN property — an
   * object literal would assign the prototype instead, which is the very bug
   * this refusal exists for and not a payload a file could produce.
   */
  function aliasesKeyedBy(key: string): PassportBackupContents {
    const payload = contents();
    payload.aliases = JSON.parse(
      `{${JSON.stringify(key)}:${JSON.stringify(contents().aliases.preview)}}`,
    ) as PassportBackupContents['aliases'];
    return payload;
  }

  function contractsKeyedBy(key: string): PassportBackupContents {
    const payload = contents();
    payload.passportContracts = JSON.parse(
      `{${JSON.stringify(key)}:${JSON.stringify(contents().passportContracts['AQIDBA==::preview'])}}`,
    ) as PassportBackupContents['passportContracts'];
    return payload;
  }

  it.each(['__proto__', 'constructor', 'prototype'])(
    'refuses an alias keyed "%s" rather than reporting it restored',
    async (key) => {
      /* It used to pass every shape check, be counted `restored: 1`, and
         persist nothing at all: the bulk write set a prototype and the
         read-back found `Object.prototype` sitting where the record should be. */
      await expect(applyPassportBackup(aliasesKeyedBy(key))).rejects.toMatchObject({
        code: 'corrupt-contents',
        message: expect.stringContaining(key),
      });
      expect(Object.keys((await collectPassportBackup()).aliases)).toEqual([]);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'refuses a contract record keyed "%s"',
    async (key) => {
      await expect(applyPassportBackup(contractsKeyedBy(key))).rejects.toMatchObject({
        code: 'corrupt-contents',
        message: expect.stringContaining(key),
      });
      expect(Object.keys((await collectPassportBackup()).passportContracts)).toEqual([]);
    },
  );

  it('refuses a reward that identifies itself as __proto__', async () => {
    const payload = contents();
    payload.incentives = [{ ...contents().incentives[0]!, id: '__proto__' }];
    await expect(applyPassportBackup(payload)).rejects.toMatchObject({
      code: 'corrupt-contents',
      message: expect.stringContaining('__proto__'),
    });
    expect((await collectPassportBackup()).incentives).toEqual([]);
  });

  it('never reports a __proto__ record written unless the store really holds it', async () => {
    /* The belt to the file guard's braces: whatever reaches the store, the
       count it reports is the count it can read back as an OWN property. */
    const { restoreAliasRecords, loadAliasRecords } = await import('./aliasStore.js');
    const outcomes = restoreAliasRecords([
      { ...contents().aliases.preview!, network: '__proto__' },
    ]);
    expect(Object.hasOwn(loadAliasRecords(), '__proto__')).toBe(outcomes[0]?.written);
    expect(outcomes[0]?.written).toBe(true);
  });

  it('hands out record maps nothing can inherit an answer from', async () => {
    const { loadAliasRecords } = await import('./aliasStore.js');
    const { loadPassportContractRecords } = await import('./passportContractStore.js');
    expect(Object.getPrototypeOf(loadAliasRecords())).toBe(null);
    expect(Object.getPrototypeOf(loadPassportContractRecords())).toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* A restore adds and refreshes; it never takes away                          */
/* -------------------------------------------------------------------------- */

describe('what a restore may never take away', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  /** The state a file used to be able to overwrite: deployed, and unconfirmed. */
  function holdDeployedContract(): void {
    window.localStorage.setItem(
      'passport-contract:v1',
      JSON.stringify({
        'AQIDBA==::preview': {
          ...contents().passportContracts['AQIDBA==::preview'],
          ledgerConfirmed: false,
          updatedAt: '2026-08-19T08:58:00.000Z',
        },
      }),
    );
  }

  it('does not let a future-dated failed record discard a deployed address', async () => {
    holdDeployedContract();
    const payload = contents();
    payload.passportContracts = {
      'AQIDBA==::preview': {
        credentialId: 'AQIDBA==',
        network: 'preview',
        status: 'failed',
        failureReason: 'the proof server was unreachable',
        updatedAt: '2030-01-01T00:00:00.000Z',
      },
    };
    const summary = await applyPassportBackup(payload);

    expect(summary.passportContracts.restored).toBe(0);
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(
      /a restore does not take a contract away/,
    );
    const held = (await collectPassportBackup()).passportContracts['AQIDBA==::preview'];
    expect(held?.status).toBe('deployed');
    expect(held?.address).toBe('cc'.repeat(32));
  });

  it('does not let a deployed record with no address of its own replace one that has one', async () => {
    holdDeployedContract();
    const payload = contents();
    payload.passportContracts = {
      'AQIDBA==::preview': {
        credentialId: 'AQIDBA==',
        network: 'preview',
        status: 'deployed',
        updatedAt: '2030-01-01T00:00:00.000Z',
      },
    };
    const summary = await applyPassportBackup(payload);
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(
      /a restore does not take a contract away/,
    );
    expect((await collectPassportBackup()).passportContracts['AQIDBA==::preview']?.address).toBe(
      'cc'.repeat(32),
    );
  });

  it('does not let a file change the address of a contract this browser deployed', async () => {
    /* Same status, a real-looking transaction id, a date from the future: the
       one thing different is the address. The local record is not yet
       indexer-confirmed, so neither of the earlier rules fires; this one
       must, because the Receive sheet shows `record.address` for any
       deployed record and would hand out the file's address. */
    holdDeployedContract();
    const payload = contents();
    payload.passportContracts = {
      'AQIDBA==::preview': {
        credentialId: 'AQIDBA==',
        network: 'preview',
        status: 'deployed',
        address: 'dd'.repeat(32),
        deployTxId: 'ee'.repeat(32),
        updatedAt: '2030-01-01T00:00:00.000Z',
      },
    };
    const summary = await applyPassportBackup(payload);

    expect(summary.passportContracts.restored).toBe(0);
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(
      /does not change the address of a contract this browser deployed/,
    );
    const held = (await collectPassportBackup()).passportContracts['AQIDBA==::preview'];
    expect(held?.address).toBe('cc'.repeat(32));
  });

  it('replaces a failed record this browser holds with a newer deployment from the file', async () => {
    /* The rule protects a DEPLOYED local record, and nothing else — a failed
       one carries no address to lose. */
    window.localStorage.setItem(
      'passport-contract:v1',
      JSON.stringify({
        'AQIDBA==::preview': {
          credentialId: 'AQIDBA==',
          network: 'preview',
          status: 'failed',
          failureReason: 'the proof server was unreachable',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      }),
    );
    const summary = await applyPassportBackup(contents());
    expect(summary.passportContracts.restored).toBe(1);
    expect((await collectPassportBackup()).passportContracts['AQIDBA==::preview']?.address).toBe(
      'cc'.repeat(32),
    );
  });

  it('reads only ISO-8601 timestamps, so a bare number cannot beat a real date', async () => {
    /* `Date.parse('99999')` answers with the first of January in the year
       99999, so a file dated like that was newer than everything here. */
    holdDeployedContract();
    const payload = contents();
    payload.passportContracts['AQIDBA==::preview']!.address = 'cc'.repeat(32);
    payload.passportContracts['AQIDBA==::preview']!.updatedAt = '99999';
    const summary = await applyPassportBackup(payload);

    expect(summary.passportContracts.restored).toBe(0);
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(/which cannot be ordered/);
    expect(summary.passportContracts.skipped[0]?.reason).toContain('99999');
    expect((await collectPassportBackup()).passportContracts['AQIDBA==::preview']?.address).toBe(
      'cc'.repeat(32),
    );
  });

  it('treats a well-shaped date that is not a day as unreadable', async () => {
    holdDeployedContract();
    const payload = contents();
    payload.passportContracts['AQIDBA==::preview']!.address = 'cc'.repeat(32);
    payload.passportContracts['AQIDBA==::preview']!.updatedAt = '2026-13-01';
    const summary = await applyPassportBackup(payload);
    expect(summary.passportContracts.restored).toBe(0);
    expect(summary.passportContracts.skipped[0]?.reason).toContain('2026-13-01');
  });
});

/* -------------------------------------------------------------------------- */
/* The cap falls on the file, never on what this browser already earned        */
/* -------------------------------------------------------------------------- */

describe('a restore may not evict the rewards already here', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  /** `count` rewards, newest first, in the year given. */
  function rewards(count: number, prefix: string, year: number) {
    const list = [];
    for (let index = 0; index < count; index += 1) {
      list.push({
        ...contents().incentives[0]!,
        id: `${prefix}-${index}`,
        redeemedAt: new Date(Date.UTC(year, 0, 1, 0, 0, count - index)).toISOString(),
      });
    }
    return list;
  }

  function holdRewards(count: number, prefix: string, year: number): void {
    window.localStorage.setItem(
      'passport-incentives:v1',
      JSON.stringify(rewards(count, prefix, year)),
    );
  }

  function fileOf(count: number, prefix: string, year: number): PassportBackupContents {
    const payload = contents();
    payload.aliases = {};
    payload.passportContracts = {};
    payload.incentives = rewards(count, prefix, year);
    return payload;
  }

  it('keeps every local reward when the file is full of newer ones', async () => {
    /* Fifty future-dated rewards in a file used to take all fifty places and
       report `skipped: 0` — the user's own rewards gone, and nothing said. */
    holdRewards(50, 'mine', 2026);
    const summary = await applyPassportBackup(fileOf(50, 'theirs', 2030));

    expect(summary.incentives.found).toBe(50);
    expect(summary.incentives.restored).toBe(0);
    expect(summary.incentives.skipped).toHaveLength(50);
    expect(summary.incentives.skipped[0]?.reason).toMatch(/never evicted by a restore/);

    const held = (await collectPassportBackup()).incentives;
    expect(held).toHaveLength(50);
    expect(held.every((record) => record.id.startsWith('mine-'))).toBe(true);
  });

  it('gives the file exactly the room that is left, newest first', async () => {
    holdRewards(45, 'mine', 2026);
    const summary = await applyPassportBackup(fileOf(10, 'theirs', 2030));

    expect(summary.incentives.restored).toBe(5);
    expect(summary.incentives.skipped).toHaveLength(5);
    expect([...summary.incentives.restoredKeys].sort()).toEqual([
      'theirs-0',
      'theirs-1',
      'theirs-2',
      'theirs-3',
      'theirs-4',
    ]);
    const held = (await collectPassportBackup()).incentives;
    expect(held).toHaveLength(50);
    expect(held[0]?.id).toBe('theirs-0');
  });
});

/* -------------------------------------------------------------------------- */
/* A reason that names another record's fate has to wait for it                */
/* -------------------------------------------------------------------------- */

describe('a dedupe reason that has to wait for the store', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('does not say the newer of two colliding records was restored when it was not', async () => {
    /* This used to make the winner a record the STORE refuses — an address and
       no deployment transaction. The dedup now asks the store's own predicate
       before it chooses, so that collision cannot arise; what still can is a
       browser that refuses the write. A full or partitioned `localStorage`
       throws from `setItem`, the winner is not written, and "which was
       restored instead" would name a record nothing holds. */
    const template = contents().passportContracts['AQIDBA==::preview']!;
    const payload = contents();
    payload.passportContracts = {
      recent: { ...template, updatedAt: '2026-08-19T00:00:00.000Z' },
      stale: { ...template, updatedAt: '2020-01-01T00:00:00.000Z' },
    };
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.setItem =
      () => {
        throw new Error('the quota is exceeded');
      };
    const summary = await applyPassportBackup(payload);

    expect(summary.passportContracts.restored).toBe(0);
    const reasons = summary.passportContracts.skipped.map((entry) => entry.reason).join(' | ');
    expect(reasons).toMatch(/which was preferred to this one and was not written either/);
    expect(reasons).not.toMatch(/which was restored instead/);
  });

  it('does not say the first copy of a duplicated reward was restored when the cap refused it', async () => {
    const held = [];
    for (let index = 0; index < 50; index += 1) {
      held.push({
        ...contents().incentives[0]!,
        id: `mine-${index}`,
        redeemedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 50 - index)).toISOString(),
      });
    }
    window.localStorage.setItem('passport-incentives:v1', JSON.stringify(held));

    const payload = contents();
    payload.aliases = {};
    payload.passportContracts = {};
    payload.incentives = [contents().incentives[0]!, contents().incentives[0]!];
    const summary = await applyPassportBackup(payload);

    expect(summary.incentives.restored).toBe(0);
    expect(summary.incentives.skipped).toHaveLength(2);
    expect(summary.incentives.skipped[0]?.reason).toMatch(
      /the first copy was preferred and was not written either/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Free text is the one place a name check cannot help                         */
/* -------------------------------------------------------------------------- */

describe('the three fields that hold free text', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('restores every one of them, whatever the text happens to look like', async () => {
    /* `queuedReason`, `failureReason`, and `label` are written by an app or by
       a service, in its own words. A file this app exported must restore in
       full, and no arithmetic on the length of a sentence is allowed to decide
       otherwise — see the module header. */
    const payload = contents();
    payload.aliases.preview!.status = 'queued';
    payload.aliases.preview!.queuedReason = 'ab'.repeat(32);
    payload.passportContracts['AQIDBA==::preview']!.status = 'failed';
    payload.passportContracts['AQIDBA==::preview']!.failureReason = 'cd'.repeat(32);
    payload.passportContracts['AQIDBA==::preview']!.address = undefined;
    payload.passportContracts['AQIDBA==::preview']!.deployTxId = undefined;
    payload.incentives[0]!.label = 'ef'.repeat(32);

    const summary = await applyPassportBackup(payload);
    expect(summary.aliases.restored).toBe(1);
    expect(summary.passportContracts.restored).toBe(1);
    expect(summary.incentives.restored).toBe(1);
    expect([
      ...summary.aliases.skipped,
      ...summary.passportContracts.skipped,
      ...summary.incentives.skipped,
    ]).toEqual([]);
  });

  it('lets free text that reads as free text through', async () => {
    const payload = contents();
    payload.aliases.preview!.queuedReason = 'the registry was unreachable';
    payload.incentives[0]!.label = 'One free entry';
    const summary = await applyPassportBackup(payload);
    expect(summary.aliases.restored).toBe(1);
    expect(summary.incentives.restored).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* One case for every hex identifier, chosen on the way in                     */
/* -------------------------------------------------------------------------- */

describe('a file that shouts its identifiers in upper case', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('stores every hex identifier in the case the rest of the app writes', async () => {
    /* `HEX_64` and `TX_ID` are case-insensitive, and everything downstream —
       the indexer read, the registry comparison, the explorer URL — is a
       string. An address restored in upper case never matched again. */
    const payload = contents();
    payload.passportContracts['AQIDBA==::preview']!.address = 'CC'.repeat(32);
    payload.passportContracts['AQIDBA==::preview']!.deployTxId = 'DD'.repeat(32);
    payload.aliases.preview!.resolverDeployTxId = 'AA'.repeat(32);
    payload.aliases.preview!.registerTxId = 'BB'.repeat(32);
    payload.incentives[0]!.txId = 'EE'.repeat(32);

    await applyPassportBackup(payload);
    const stored = await collectPassportBackup();

    expect(stored.passportContracts['AQIDBA==::preview']?.address).toBe('cc'.repeat(32));
    expect(stored.passportContracts['AQIDBA==::preview']?.deployTxId).toBe('dd'.repeat(32));
    expect(stored.aliases.preview?.resolverDeployTxId).toBe('aa'.repeat(32));
    expect(stored.aliases.preview?.registerTxId).toBe('bb'.repeat(32));
    expect(stored.incentives[0]?.txId).toBe('ee'.repeat(32));
  });
});

/* -------------------------------------------------------------------------- */
/* A record this device never submitted says so                                */
/* -------------------------------------------------------------------------- */

describe('telling a restored contract record from a submitted one', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('marks every contract record a restore writes as restored from a backup', async () => {
    /* Both an unconfirmed submission and an unconfirmed restore carry
       `ledgerConfirmed: false`, and the card was telling the second story with
       the first one's words. See `../screens/PassportContract.tsx`. */
    await applyPassportBackup(contents());
    const stored = (await collectPassportBackup()).passportContracts['AQIDBA==::preview'];
    expect(stored?.restoredFromBackup).toBe(true);
    expect(stored?.ledgerConfirmed).toBe(false);
  });

  it('leaves a record this device deployed unmarked', async () => {
    const { savePassportContractRecord, loadPassportContractRecord } = await import(
      './passportContractStore.js'
    );
    savePassportContractRecord({ ...contents().passportContracts['AQIDBA==::preview']! });
    expect(loadPassportContractRecord('AQIDBA==', 'preview')?.restoredFromBackup).toBeUndefined();
  });

  it('does not let a file assert the mark away', async () => {
    const payload = contents();
    payload.passportContracts['AQIDBA==::preview']!.restoredFromBackup = false;
    await applyPassportBackup(payload);
    expect(
      (await collectPassportBackup()).passportContracts['AQIDBA==::preview']?.restoredFromBackup,
    ).toBe(true);
  });
});

describe('what a restore may not take away', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('refuses a file that would replace a deployed contract with a failed one', async () => {
    /* The one rule here that does not consult the dates. `ledgerConfirmed`
       protected only the records the chain had answered for, so a file dated
       in the future could replace a local `deployed` record — address,
       transaction id, and all — with a `failed` one carrying nothing but a
       sentence, and the address this browser deployed was gone. */
    const seeded = contents();
    seeded.passportContracts['AQIDBA==::preview']!.ledgerConfirmed = false;
    const first = await applyPassportBackup(seeded);
    expect(first.passportContracts.restored).toBe(1);

    const downgrade = contents();
    const record = downgrade.passportContracts['AQIDBA==::preview']!;
    record.status = 'failed';
    record.failureReason = 'the deploy was refused';
    delete (record as { address?: string }).address;
    delete (record as { deployTxId?: string }).deployTxId;
    record.ledgerConfirmed = false;
    record.updatedAt = '2099-01-01T00:00:00.000Z';

    const summary = await applyPassportBackup(downgrade);
    expect(summary.passportContracts.restored).toBe(0);
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(
      /a restore does not take a contract away/,
    );
    // And the address this browser deployed is still there.
    const stored = await collectPassportBackup();
    expect(stored.passportContracts['AQIDBA==::preview']?.address).toBe('cc'.repeat(32));
  });

  it('reads a timestamp that is the right shape and is not a day as no timestamp', async () => {
    await applyPassportBackup(contents());
    const nonsense = contents();
    // `2026-13-01` passes the pattern and is not a date. It must not be
    // treated as newer than what this browser holds.
    nonsense.aliases.preview!.updatedAt = '2026-13-01T00:00:00.000Z';
    nonsense.aliases.preview!.alias = 'shouldnotwin';
    const summary = await applyPassportBackup(nonsense);
    expect(summary.aliases.restored).toBe(0);
    const stored = await collectPassportBackup();
    expect(stored.aliases.preview?.alias).toBe('alice');
  });
});

describe('a sentence that was a prediction until the stores answered', () => {
  /* "the file carries another record for this credential, dated X, which was
     restored instead" is written while the file is being READ — before the
     store has been asked for anything — so it was a prediction, and the store
     going on to refuse that other record made it a false one. Both endings are
     now recorded and settled once the write outcomes are in. Two file entries
     collapsing onto one store key is what produces the prediction: the store's
     key is derived from the record, and the file's own map keys are ignored. */

  /** Two file entries for one store key, the PREFERRED one first. */
  function twoForOneKey(): PassportBackupContents {
    const payload = contents();
    const base = payload.passportContracts['AQIDBA==::preview']!;
    payload.passportContracts = {
      preferred: { ...base, updatedAt: '2030-01-01T00:00:00.000Z' },
      superseded: { ...base, updatedAt: '2020-01-01T00:00:00.000Z' },
    } as PassportBackupContents['passportContracts'];
    return payload;
  }

  it('says the other record WAS restored when the store took it', async () => {
    installStorage();
    try {
      const summary = await applyPassportBackup(twoForOneKey());
      expect(summary.passportContracts.restored).toBe(1);
      expect(summary.passportContracts.skipped[0]?.reason).toMatch(/which was restored instead/);
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('says it was NOT restored when the store refused it after all', async () => {
    vi.resetModules();
    vi.doMock('./passportContractStore.js', () => ({
      loadPassportContractRecords: () => ({}),
      passportContractRecordKey: (credentialId: string, network: string) =>
        `${credentialId}::${network}`,
      refusePassportContractRecord: () => null,
      /* The store's own bulk writer, answering that it wrote nothing — which
         is what a full or partitioned localStorage really produces. */
      restorePassportContractRecords: (records: { credentialId: string; network: string }[]) =>
        records.map((record) => ({
          key: `${record.credentialId}::${record.network}`,
          written: false,
          reason: 'the store refused the record it was handed',
        })),
    }));
    installStorage();
    try {
      const module = await import('./backup.js');
      const summary = await module.applyPassportBackup(twoForOneKey());
      expect(summary.passportContracts.restored).toBe(0);
      const reasons = summary.passportContracts.skipped.map((entry) => entry.reason).join(' | ');
      expect(reasons).toMatch(/was preferred to this one and was not written either/);
      // And the prediction is nowhere in the summary, because it did not happen.
      expect(reasons).not.toMatch(/which was restored instead/);
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
      vi.doUnmock('./passportContractStore.js');
      vi.resetModules();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The review of 2026/08/26                                                    */
/* -------------------------------------------------------------------------- */

describe('a contract address a file merely claims', () => {
  beforeEach(() => installStorage());
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    vi.doUnmock('./midnames.js');
    vi.resetModules();
  });

  async function withRegistry(target: unknown) {
    vi.resetModules();
    vi.doMock('./midnames.js', () => ({
      MIDNAMES_INDEXER_URLS: { stagenet: '', preview: '', preprod: '', mainnet: '' },
      resolveAliasTarget: async () => target,
    }));
    return import('./backup.js');
  }

  /* The attack this suite exists for: a crafted backup names a real contract
     the attacker controls, and a name they registered to it. The registry
     agrees the name resolves there — it does. Only the contract's own device
     set can say the contract is not this Passport's. */
  const craftedPayload = () => {
    const payload = contents();
    payload.passportContracts['AQIDBA==::preview']!.address = 'ab'.repeat(32);
    return payload;
  };
  const attackerRegistry = {
    resolverAddress: '0200beef',
    target: { kind: 'contract', hex: 'ab'.repeat(32) },
  };

  it('refuses to confirm a name against a restored contract that does not hold this device', async () => {
    const module = await withRegistry(attackerRegistry);
    const envelope = JSON.stringify(await module.sealPassportBackup(craftedPayload(), PASSWORD));
    const summary = await module.importPassportBackup(
      envelope,
      PASSWORD,
      undefined,
      async () => false,
    );

    expect(summary.registryCheck).toMatchObject({ confirmed: 0, unconfirmed: 1 });
    expect(summary.registryCheck).toMatchObject({ ran: true });
    expect(
      (summary.registryCheck as { unconfirmedReasons?: { reason: string }[] })
        .unconfirmedReasons?.[0]?.reason,
    ).toMatch(
      /does not hold this Passport as a device/,
    );
    const stored = (await module.collectPassportBackup()).aliases.preview;
    expect(stored?.registryConfirmed).not.toBe(true);
    // The resolver target is the field Home reads for the Receive sheet.
    expect(stored?.resolverTargetHex).toBeUndefined();
  });

  it('puts the question to the chain with the address the registry answered', async () => {
    const module = await withRegistry(attackerRegistry);
    const asked: { network: string; address: string }[] = [];
    const envelope = JSON.stringify(await module.sealPassportBackup(craftedPayload(), PASSWORD));
    await module.importPassportBackup(envelope, PASSWORD, undefined, async (network, address) => {
      asked.push({ network, address });
      return true;
    });

    expect(asked).toEqual([{ network: 'preview', address: 'ab'.repeat(32) }]);
  });

  it('confirms the name once the contract answers that it holds this device', async () => {
    const module = await withRegistry(attackerRegistry);
    const envelope = JSON.stringify(await module.sealPassportBackup(craftedPayload(), PASSWORD));
    const summary = await module.importPassportBackup(
      envelope,
      PASSWORD,
      undefined,
      async () => true,
    );

    expect(summary.registryCheck).toMatchObject({ confirmed: 1, unconfirmed: 0 });
  });

  it('leaves it unconfirmed when there is no way to put the question', async () => {
    const module = await withRegistry(attackerRegistry);
    const envelope = JSON.stringify(await module.sealPassportBackup(craftedPayload(), PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD);

    expect(summary.registryCheck).toMatchObject({ confirmed: 0, unconfirmed: 1 });
    expect(summary.registryCheck).toMatchObject({ ran: true });
    expect(
      (summary.registryCheck as { unconfirmedReasons?: { reason: string }[] })
        .unconfirmedReasons?.[0]?.reason,
    ).toMatch(
      /ownership of it could not be checked/,
    );
  });

  it('does not read a chain that could not be asked as a no', async () => {
    const module = await withRegistry(attackerRegistry);
    const envelope = JSON.stringify(await module.sealPassportBackup(craftedPayload(), PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, async () => {
      throw new Error('the indexer could not be reached');
    });

    expect(summary.registryCheck).toMatchObject({ ran: true });
    expect(
      (summary.registryCheck as { unconfirmedReasons?: { reason: string }[] })
        .unconfirmedReasons?.[0]?.reason,
    ).toMatch(
      /could not be asked whether it holds this Passport/,
    );
  });

  it('asks nothing of the chain for a contract this browser deployed itself', async () => {
    /* The normal case, and the one that must not cost a user-verification
       prompt: the address came from a deployment this browser watched. */
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'cc'.repeat(32) },
    });
    const { savePassportContractRecord } = await import('./passportContractStore.js');
    savePassportContractRecord({
      credentialId: 'AQIDBA==',
      network: 'preview',
      status: 'deployed',
      address: 'cc'.repeat(32),
      deployTxId: 'dd'.repeat(32),
      updatedAt: '2026-08-26T09:00:00.000Z',
    });
    const payload = contents();
    delete payload.passportContracts['AQIDBA==::preview'];
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    let asked = 0;
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, async () => {
      asked += 1;
      return false;
    });

    expect(asked).toBe(0);
    expect(summary.registryCheck).toMatchObject({ confirmed: 1 });
  });
});

describe('the name a record really carries', () => {
  beforeEach(() => installStorage());
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    vi.doUnmock('./midnames.js');
    vi.resetModules();
  });

  /** Imports `backup.js` with the registry answering `target`. */
  async function withRegistry(target: unknown) {
    vi.resetModules();
    vi.doMock('./midnames.js', () => ({
      MIDNAMES_INDEXER_URLS: { stagenet: '', preview: '', preprod: '', mainnet: '' },
      resolveAliasTarget: async () => target,
    }));
    return import('./backup.js');
  }

  it('confirms a name whose domain is the whole name, which is what every writer stores', async () => {
    /* `aliasDomainOf` in `../App.tsx` and the funder's own answer both store
       `domain` as `alice.night`. The check compared it against the bare string
       `'night'`, so every genuine record failed and stayed awaiting the
       registry for good; only the fixtures, carrying `domain: 'night'`, agreed
       with it. */
    const payload = contents();
    payload.aliases.preview!.domain = 'alice.night';
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'cc'.repeat(32) },
    });
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice);

    expect(summary.registryCheck).toEqual({
      ran: true,
      confirmed: 1,
      unconfirmed: 0,
      otherNetworks: 0,
      notRegistered: 0,
    });
    const stored = (await module.collectPassportBackup()).aliases.preview;
    expect(stored?.registryConfirmed).toBe(true);
    expect(stored?.domain).toBe('alice.night');
  });

  it('still refuses a whole name under a domain Passport does not register', async () => {
    const payload = contents();
    payload.aliases.preview!.domain = 'alice.example';
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'cc'.repeat(32) },
    });
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD, undefined, holdsThisDevice);

    expect(summary.registryCheck).toMatchObject({
      confirmed: 0,
      unconfirmed: 1,
      unconfirmedReasons: [
        {
          network: 'preview',
          reason: 'the record\'s name "alice.example" is not under .night, and Passport registers names under .night',
        },
      ],
    });
  });
});

describe('a second file entry landing on a key the first already took', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('does not let it walk past the guards the first one had to pass', async () => {
    /* The local record is a deployed contract with an address. The file
       carries TWO entries for its key: a deployment newer than the local one,
       and — newer still — a `failed` record with nothing but a sentence. The
       second used to take the `staged` branch, be compared only against the
       first, and be written with the downgrade rule never consulted at all:
       the address this browser deployed was gone. */
    const { savePassportContractRecord, loadPassportContractRecord } = await import(
      './passportContractStore.js'
    );
    savePassportContractRecord({
      credentialId: 'AQIDBA==',
      network: 'preview',
      status: 'deployed',
      address: 'cc'.repeat(32),
      deployTxId: 'dd'.repeat(32),
      updatedAt: '2026-08-19T08:00:00.000Z',
    });

    const payload = contents();
    payload.passportContracts = {
      first: {
        credentialId: 'AQIDBA==',
        network: 'preview',
        status: 'deployed',
        address: 'aa'.repeat(32),
        deployTxId: 'bb'.repeat(32),
        updatedAt: '2026-08-20T00:00:00.000Z',
      },
      second: {
        credentialId: 'AQIDBA==',
        network: 'preview',
        status: 'failed',
        failureReason: 'the proof server refused',
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
    };
    const summary = await applyPassportBackup(payload);

    const stored = loadPassportContractRecord('AQIDBA==', 'preview');
    expect(stored?.status).toBe('deployed');
    /* Neither entry gets past the guards: the newer one names a different
       address for a contract this browser deployed, the later `failed` one is
       a downgrade. The browser keeps what it deployed. */
    expect(stored?.address).toBe('cc'.repeat(32));
    const reasons = summary.passportContracts.skipped.map((entry) => entry.reason).join(' | ');
    expect(reasons).toMatch(/does not change the address of a contract this browser deployed/);
    expect(reasons).toMatch(/a restore does not take a contract away/);
  });
});

describe('what a restore may never take away from a name', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('keeps a registered claim the registry has not answered for yet', async () => {
    /* The claim path writes exactly this while the registry read-back lags,
       and tells the user the name "was submitted". A file dated later saying
       the claim failed used to replace it whole — transaction ids, resolver
       address, and all — for a name that is live on chain. */
    const { saveAliasRecord, loadAliasRecord } = await import('./aliasStore.js');
    saveAliasRecord({
      alias: 'alice',
      domain: 'alice.night',
      network: 'preview',
      status: 'registered',
      resolverAddress: '0200abcd',
      resolverDeployTxId: 'aa'.repeat(32),
      registerTxId: 'bb'.repeat(32),
      registryConfirmed: false,
      updatedAt: '2026-08-19T08:00:00.000Z',
    });

    const payload = contents();
    payload.aliases.preview = {
      alias: 'alice',
      domain: 'alice.night',
      network: 'preview',
      status: 'failed',
      queuedReason: 'the registry refused the name',
      updatedAt: '2027-01-01T00:00:00.000Z',
    };
    const summary = await applyPassportBackup(payload);

    const stored = loadAliasRecord('preview');
    expect(stored?.status).toBe('registered');
    expect(stored?.registerTxId).toBe('bb'.repeat(32));
    expect(stored?.resolverDeployTxId).toBe('aa'.repeat(32));
    expect(stored?.resolverAddress).toBe('0200abcd');
    expect(summary.aliases.skipped[0]?.reason).toMatch(/a restore does not take a name away/);
  });

  it('still takes a newer registered claim from the file', async () => {
    const { saveAliasRecord, loadAliasRecord } = await import('./aliasStore.js');
    saveAliasRecord({
      alias: 'alice',
      domain: 'alice.night',
      network: 'preview',
      status: 'queued',
      queuedReason: 'the sponsor was busy',
      updatedAt: '2026-08-19T08:00:00.000Z',
    });
    const summary = await applyPassportBackup(contents());
    expect(summary.aliases.restored).toBe(1);
    expect(loadAliasRecord('preview')?.status).toBe('registered');
  });
});

describe('an export this browser’s own data cannot block', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('exports a reward whose label is an ordinary slug of key length', async () => {
    /* 43 characters of `[A-Za-z0-9_-]` is 32 bytes by the tripwire's
       arithmetic. `saveIncentive` stores such a label happily, and the export
       path then threw `key-material-present` on every attempt — including the
       Backup screen's own holdings read, so the button went dead with it. */
    const slug = 'midnight-raffle-earlybird-tier2-badge-26q3x';
    expect(slug).toHaveLength(43);
    const { saveIncentive } = await import('./incentiveStore.js');
    saveIncentive({
      id: 'raffle-9',
      app: 'Midnight Raffle',
      label: slug,
      network: 'preview',
      redeemedAt: '2026-08-20T00:00:00.000Z',
    });

    const collected = await collectPassportBackup();
    expect(collected.incentives[0]?.label).toBe(slug);
    const envelope = await sealPassportBackup(collected, PASSWORD);
    expect((await openPassportBackup(envelope, PASSWORD)).incentives[0]?.label).toBe(slug);
  });

  it('leaves behind a field nobody justified rather than refusing to export', async () => {
    /* `localStorage` is writable by anything on the origin, and a record with
       a stray field or a nested value in it used to make the export throw for
       good. The list is applied instead of asserted: what the file may carry
       travels, and the rest is simply not there. */
    window.localStorage.setItem(
      'passport-alias:v1',
      JSON.stringify({
        preview: {
          alias: 'alice',
          domain: 'alice.night',
          network: 'preview',
          status: 'registered',
          resolverDeployTxId: 'aa'.repeat(32),
          registerTxId: 'bb'.repeat(32),
          updatedAt: '2026-08-19T08:00:00.000Z',
          walletSeed: 'ff'.repeat(32),
          notes: { hidden: 'an object where a plain value belongs' },
          /* A JUSTIFIED name holding an object: the name gets it past the
             allow-list, and the shape is still not one a record carries. */
          resolverTarget: { kind: 'contract' },
          /* …and a justified name holding null, which IS a plain value and
             travels as written. */
          resolverAddress: null,
        },
      }),
    );

    const collected = await collectPassportBackup();
    expect(collected.aliases.preview?.alias).toBe('alice');
    expect(collected.aliases.preview).not.toHaveProperty('walletSeed');
    expect(collected.aliases.preview).not.toHaveProperty('notes');
    expect(collected.aliases.preview).not.toHaveProperty('resolverTarget');
    expect(collected.aliases.preview?.resolverAddress).toBeNull();
    await expect(sealPassportBackup(collected, PASSWORD)).resolves.toBeTruthy();
  });

  it('restores a record whose label is key-sized, because export never refused it', async () => {
    /* The tripwire moved, then narrowed, then went (2026/08/26). Refusing here
       was the export lock-out one step later: a file that sealed cleanly and
       then refused, on every device, to restore the one record it was taken to
       preserve. */
    const payload = contents();
    payload.incentives[0]!.label = 'ef'.repeat(32);
    const summary = await applyPassportBackup(payload);
    expect(summary.incentives.restored).toBe(1);
    expect(summary.incentives.skipped).toEqual([]);
    expect(summary.aliases.restored).toBe(1);
    expect(summary.passportContracts.restored).toBe(1);
  });
});

describe('an envelope handed over as an object, not as text', () => {
  it('names an unsupported version rather than blaming the password', async () => {
    /* The comment promised the object arm re-checked everything; it re-checked
       the KDF and the field lengths and never the version. A `v: 2` file built
       its AAD from that 2, failed the tag, and told the user their password was
       wrong about a file no password would open here. */
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    await expect(openPassportBackup({ ...envelope, v: 2 }, PASSWORD)).rejects.toMatchObject({
      code: 'unsupported-version',
    });
    await expect(
      openPassportBackup({ ...envelope, v: '1' as unknown as number }, PASSWORD),
    ).rejects.toMatchObject({ code: 'not-a-backup' });
    // …and the version this build writes still opens.
    await expect(openPassportBackup(envelope, PASSWORD)).resolves.toBeTruthy();
  });
});

describe('the headline over a restore that worked', () => {
  it('answers with a date only when the file carries one it can read', () => {
    expect(describeBackupCreatedAt('2026-08-19T09:00:00.000Z')).toBe(
      new Date('2026-08-19T09:00:00.000Z').toLocaleString(),
    );
    // The one timestamp `openPassportBackup` checks only as "a string".
    expect(describeBackupCreatedAt('yesterday-ish')).toBeNull();
    expect(describeBackupCreatedAt('99999')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The stores' own bulk paths, which the exported API reaches directly         */
/* -------------------------------------------------------------------------- */

describe('a bulk write that must not destroy what it replaces', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('refuses an alias record its own reader would filter out, before staging it', async () => {
    /* `refuseAliasRecord` checked the transaction-id invariants and nothing
       about the shape, so a record with a non-string `alias` was staged over
       the valid record for that network, persisted, and dropped by the reader
       on the way back. The caller heard only "did not read back"; the record
       it had overwritten was gone. */
    const { saveAliasRecord, restoreAliasRecords, loadAliasRecord } = await import(
      './aliasStore.js'
    );
    saveAliasRecord({
      alias: 'alice',
      domain: 'alice.night',
      network: 'preview',
      status: 'registered',
      resolverDeployTxId: 'aa'.repeat(32),
      registerTxId: 'bb'.repeat(32),
      updatedAt: '2026-08-19T08:00:00.000Z',
    });

    const [outcome] = restoreAliasRecords([
      {
        alias: 123 as unknown as string,
        domain: 'm',
        network: 'preview',
        status: 'failed',
        queuedReason: 'r',
        updatedAt: '',
      },
    ]);
    expect(outcome).toMatchObject({ written: false });
    expect(outcome?.reason).toMatch(/must carry the name, the domain/);
    // The record that was already here is untouched.
    expect(loadAliasRecord('preview')?.alias).toBe('alice');

    const [badStatus] = restoreAliasRecords([
      {
        alias: 'bob',
        domain: 'bob.night',
        network: 'preview',
        status: 'pending' as unknown as 'failed',
        queuedReason: 'r',
        updatedAt: '',
      },
    ]);
    expect(badStatus?.reason).toMatch(/status must be registered, queued, or failed/);
    expect(loadAliasRecord('preview')?.alias).toBe('alice');
  });

  it('refuses a contract record its own reader would filter out, before staging it', async () => {
    const {
      savePassportContractRecord,
      restorePassportContractRecords,
      loadPassportContractRecord,
    } = await import('./passportContractStore.js');
    savePassportContractRecord({
      credentialId: 'AQIDBA==',
      network: 'preview',
      status: 'deployed',
      address: 'cc'.repeat(32),
      deployTxId: 'dd'.repeat(32),
      updatedAt: '2026-08-19T08:00:00.000Z',
    });

    const [outcome] = restorePassportContractRecords([
      {
        credentialId: 'AQIDBA==',
        network: 42 as unknown as string,
        status: 'failed',
        failureReason: 'r',
        updatedAt: '',
      },
    ]);
    expect(outcome?.reason).toMatch(/must name the credential and the network/);

    const [badStatus] = restorePassportContractRecords([
      {
        credentialId: 'AQIDBA==',
        network: 'preview',
        status: 'pending' as unknown as 'failed',
        updatedAt: '2027-01-01T00:00:00.000Z',
      },
    ]);
    expect(badStatus?.reason).toMatch(/status must be deployed or failed/);
    expect(loadPassportContractRecord('AQIDBA==', 'preview')?.address).toBe('cc'.repeat(32));
  });
});

describe('rewards a restore may not lose or misorder', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('never deletes a reward this browser already holds for an incoming id', async () => {
    /* The local copy used to be dropped from the merge before the cap, on the
       reasoning that a same-id record REPLACES it. It then had to win a place
       back like any other record, and a batch of newer ones took the room —
       so the reward the user already held was deleted outright, while the
       outcome text asserted that local rewards are never evicted. */
    const { saveIncentive, restoreIncentives, loadIncentives, INCENTIVE_LIMIT } = await import(
      './incentiveStore.js'
    );
    for (let index = 0; index < INCENTIVE_LIMIT - 1; index += 1) {
      saveIncentive({
        id: `local-${index}`,
        app: 'Midnight Raffle',
        label: 'a local reward',
        network: 'preview',
        redeemedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
    }
    saveIncentive({
      id: 'shared',
      app: 'Midnight Raffle',
      label: 'the one both copies name',
      network: 'preview',
      redeemedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(loadIncentives()).toHaveLength(INCENTIVE_LIMIT);

    const outcomes = restoreIncentives([
      {
        id: 'shared',
        app: 'Midnight Raffle',
        label: 'the file’s copy',
        network: 'preview',
        redeemedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'newer',
        app: 'Midnight Raffle',
        label: 'a newer reward from the file',
        network: 'preview',
        redeemedAt: '2027-01-01T00:00:00.000Z',
      },
    ]);

    const held = loadIncentives();
    expect(held.find((record) => record.id === 'shared')?.label).toBe('the one both copies name');
    expect(outcomes.find((outcome) => outcome.id === 'shared')).toMatchObject({
      written: false,
      reason: expect.stringMatching(/the copy already here is the one that keeps its place/),
    });
  });

  it('does not let a reward dated “99999” outrank a real one for the last place', async () => {
    /* `Date.parse('99999')` is the year 99999, and `redeemedAtRank` took it.
       The junk sorted first, took every place the cap had left, and pushed the
       genuine rewards out with the cap as their stated reason. */
    const { saveIncentive, restoreIncentives, loadIncentives, INCENTIVE_LIMIT } = await import(
      './incentiveStore.js'
    );
    for (let index = 0; index < INCENTIVE_LIMIT - 1; index += 1) {
      saveIncentive({
        id: `local-${index}`,
        app: 'Midnight Raffle',
        label: 'a local reward',
        network: 'preview',
        redeemedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
    }

    const outcomes = restoreIncentives([
      {
        id: 'junk',
        app: 'Midnight Raffle',
        label: 'a reward with no readable date',
        network: 'preview',
        redeemedAt: '99999',
      },
      {
        id: 'genuine',
        app: 'Midnight Raffle',
        label: 'a reward with a real date',
        network: 'preview',
        redeemedAt: '2026-08-20T00:00:00.000Z',
      },
    ]);

    const held = loadIncentives();
    expect(held.map((record) => record.id)).toContain('genuine');
    expect(held.map((record) => record.id)).not.toContain('junk');
    expect(outcomes.find((outcome) => outcome.id === 'junk')).toMatchObject({ written: false });
    // A record with no readable date sorts LAST, so it never leads the list.
    expect(held[0]?.id).toBe('genuine');
  });
});

/* -------------------------------------------------------------------------- */
/* The second review of 2026/08/26                                             */
/* -------------------------------------------------------------------------- */

describe('a restored record that carries no date of its own', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('is not stamped with the moment it was restored', async () => {
    /* The stores wrote `record.updatedAt || now`, so a hand-edited or
       old-format entry with no timestamp was persisted carrying TODAY. The
       no-downgrade rule only runs against an existing local record, so the
       first restore of such a file wrote it unopposed — and the user's own,
       correctly dated backup was then permanently "older" than a date the
       restore itself invented. */
    const undated = contents();
    delete (undated.aliases.preview as Partial<AliasRecord>).updatedAt;
    delete (undated.passportContracts['AQIDBA==::preview'] as Partial<PassportContractRecord>)
      .updatedAt;
    expect((await applyPassportBackup(undated)).aliases.restored).toBe(1);

    const { loadAliasRecord } = await import('./aliasStore.js');
    const { loadPassportContractRecord } = await import('./passportContractStore.js');
    expect(loadAliasRecord('preview')?.updatedAt).toBeUndefined();
    expect(loadPassportContractRecord('AQIDBA==', 'preview')?.updatedAt).toBeUndefined();
    /* A restore may record WHEN it ran — that is a fact about this browser —
       and nothing may read it as the record's own date. */
    expect(loadAliasRecord('preview')?.restoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // …and the genuine backup, dated years earlier, still restores over it.
    const genuine = contents();
    genuine.aliases.preview!.alias = 'bob';
    genuine.aliases.preview!.updatedAt = '2020-01-01T00:00:00.000Z';
    const summary = await applyPassportBackup(genuine);
    expect(summary.aliases.restored).toBe(1);
    expect(loadAliasRecord('preview')?.alias).toBe('bob');
  });
});

describe('two file entries colliding on one contract key', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('prefers the entry the store will take over the newer one it would refuse', async () => {
    /* `deployTxId` is only shape-checked when present, so a newer entry
       missing it passed the date-only dedup, displaced a fully restorable
       older entry, and was then refused outright by the store — the file's
       two-entry claim restored neither. */
    const payload = contents();
    const base = payload.passportContracts['AQIDBA==::preview']!;
    payload.passportContracts = {
      restorable: { ...base, updatedAt: '2026-01-01T00:00:00.000Z' },
      newerButRefused: { ...base, deployTxId: undefined, updatedAt: '2027-01-01T00:00:00.000Z' },
    } as PassportBackupContents['passportContracts'];

    const summary = await applyPassportBackup(payload);
    const { loadPassportContractRecord } = await import('./passportContractStore.js');

    expect(summary.passportContracts.restored).toBe(1);
    expect(loadPassportContractRecord('AQIDBA==', 'preview')?.updatedAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(summary.passportContracts.skipped.map((entry) => entry.reason).join(' | ')).toMatch(
      /must carry both the contract address and the deployment transaction id/,
    );
  });

  it('says a colliding record carries no date rather than quoting one it has not got', async () => {
    const payload = contents();
    const base = { ...payload.passportContracts['AQIDBA==::preview']! };
    delete (base as Partial<PassportContractRecord>).updatedAt;
    payload.passportContracts = {
      first: { ...base },
      second: { ...base },
    } as PassportBackupContents['passportContracts'];

    const summary = await applyPassportBackup(payload);
    expect(summary.passportContracts.restored).toBe(1);
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(
      /carrying no date, which was restored instead/,
    );
  });

  it('names the record that really won the key in every skip a three-way collision leaves', async () => {
    /* The deferred sentence baked in the date of whichever record happened to
       be staged when it was written, so a third entry displacing that one left
       two skips naming a record nothing ever wrote. */
    const payload = contents();
    const base = payload.passportContracts['AQIDBA==::preview']!;
    payload.passportContracts = {
      staged: { ...base, updatedAt: '2025-01-01T00:00:00.000Z' },
      oldest: { ...base, updatedAt: '2024-01-01T00:00:00.000Z' },
      newest: { ...base, updatedAt: '2026-01-01T00:00:00.000Z' },
    } as PassportBackupContents['passportContracts'];

    const summary = await applyPassportBackup(payload);
    expect(summary.passportContracts.restored).toBe(1);
    const reasons = summary.passportContracts.skipped.map((entry) => entry.reason);
    expect(reasons).toHaveLength(2);
    for (const reason of reasons) {
      expect(reason).toContain('2026-01-01T00:00:00.000Z');
      expect(reason).not.toContain('2025-01-01T00:00:00.000Z');
    }
  });
});

describe('a label a granting app really wrote', () => {
  beforeEach(() => installStorage());
  afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

  it('restores a 43-character reward label this app exported without complaint', async () => {
    /* 43 characters of slug is 32 bytes by the tripwire's arithmetic. Export
       projected it cleanly and every import then refused that one record for
       ever, so a file this app wrote could not restore what it carried. */
    const label = 'midnight-raffle-earlybird-tier2-badge-26q3x';
    expect(label).toHaveLength(43);
    const { saveIncentive } = await import('./incentiveStore.js');
    saveIncentive({
      id: 'raffle-slug',
      app: 'Midnight Raffle',
      label,
      network: 'preview',
      redeemedAt: '2026-08-19T08:57:00.000Z',
    });

    const envelope = JSON.stringify(
      await sealPassportBackup(await collectPassportBackup(), PASSWORD),
    );
    installStorage(); // a browser that has never seen this Passport
    const summary = await importPassportBackup(envelope, PASSWORD);

    expect(summary.incentives.restored).toBe(1);
    expect(summary.incentives.skipped).toEqual([]);
    const { loadIncentives } = await import('./incentiveStore.js');
    expect(loadIncentives()[0]?.label).toBe(label);
  });
});

describe('a format number this build does not read', () => {
  it('says which direction the mismatch goes, and refuses to guess when it goes neither', async () => {
    const older = { v: 0, kdf: PASSPORT_BACKUP_KDF, salt: 'a', nonce: 'b', ciphertext: 'c' };
    expect(() => parseBackupEnvelope(JSON.stringify(older))).toThrow(
      /written by an older Passport \(format 0\); this one reads format 1 and cannot read older files/,
    );
    expect(() => parseBackupEnvelope(JSON.stringify({ ...older, v: 2 }))).toThrow(
      /written by a newer Passport \(format 2\)/,
    );
    expect(() => parseBackupEnvelope(JSON.stringify({ ...older, v: 1.5 }))).toThrow(
      /is not a whole number, so this Passport cannot tell what wrote it/,
    );

    // The object arm is the only way a number JSON cannot carry arrives.
    const envelope = await sealPassportBackup(contents(), PASSWORD);
    await expect(openPassportBackup({ ...envelope, v: 0 }, PASSWORD)).rejects.toThrow(
      /an older Passport/,
    );
    await expect(openPassportBackup({ ...envelope, v: Number.NaN }, PASSWORD)).rejects.toThrow(
      /is not a whole number/,
    );
  });
});

describe('what the screen may say about where a backup went', () => {
  it('words the anchor-download fallback as a download started, not a file saved', () => {
    /* The picker resolves only once the bytes are on disk; an `<a download>`
       click is the same non-event whether the file was written, the dialog
       cancelled, or the download blocked by policy. The panel asserted "Saved
       as" over both, and a user may delete local data trusting it. */
    const saved = describeExportOutcome({
      kind: 'saved',
      fileName: 'passport-backup-2026-08-26.json',
      location: 'my-passport.json, where you chose to save it',
    });
    expect(saved.headline).toBe('Saved as passport-backup-2026-08-26.json');
    expect(saved.detail).toContain('my-passport.json, where you chose to save it');

    const handed = describeExportOutcome({
      kind: 'handed-to-browser',
      fileName: 'passport-backup-2026-08-26.json',
    });
    expect(handed.headline).toBe('Download started — check your downloads folder');
    expect(handed.detail).toMatch(/cannot confirm the save on this browser/);
    expect(handed.detail).toContain('passport-backup-2026-08-26.json');
    expect(handed.headline).not.toMatch(/Saved as/);
    expect(handed.detail).not.toMatch(/Written to/);
  });
});

describe('every name a restore wrote, accounted for', () => {
  beforeEach(() => installStorage());
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    vi.doUnmock('./midnames.js');
    vi.resetModules();
  });

  it('counts a queued name into a bucket of its own rather than skipping it', async () => {
    /* `confirmRestoredAliases` walked past a `queued` or `failed` record with
       no counter and no reason, so the summary said "Names: 1 of 1" over a
       registry line whose three buckets summed to nothing. */
    vi.resetModules();
    vi.doMock('./midnames.js', () => ({
      MIDNAMES_INDEXER_URLS: { stagenet: '', preview: '', preprod: '', mainnet: '' },
      resolveAliasTarget: async () => null,
    }));
    const module = await import('./backup.js');

    const payload = contents();
    payload.aliases.preview!.status = 'queued';
    payload.aliases.preview!.queuedReason = 'the sponsor holds no NIGHT on preview right now';
    payload.aliases.preprod = {
      ...contents().aliases.preview!,
      network: 'preprod',
      status: 'failed',
      queuedReason: 'the registration transaction was rejected',
    };
    const summary = await module.applyPassportBackup(payload);
    expect(summary.aliases.restored).toBe(2);

    /* `ghost` is the third case: a key the restore reported writing whose
       record is not here to look up. All three used to `continue` in silence. */
    const check = await module.confirmRestoredAliases([...summary.aliases.restoredKeys, 'ghost']);
    expect(check.ran).toBe(true);
    if (!check.ran) return;
    expect(check.notRegistered).toBe(3);
    expect(check.confirmed + check.unconfirmed + check.otherNetworks + check.notRegistered).toBe(3);
    expect(check.notRegisteredReasons).toEqual([
      { network: 'preview', reason: expect.stringMatching(/queued, not registered/) },
      { network: 'preprod', reason: expect.stringMatching(/claim failed/) },
      { network: 'ghost', reason: expect.stringMatching(/no name record/) },
    ]);
  });
});

describe('the one date in the payload that used to be checked as "a string"', () => {
  it('hands its consumers a createdAt this module could read, or none at all', async () => {
    const payload = contents();
    payload.createdAt = 'the day before yesterday';
    const opened = await openPassportBackup(await sealPassportBackup(payload, PASSWORD), PASSWORD);
    expect(opened.createdAt).toBe('');
    expect(describeBackupCreatedAt(opened.createdAt)).toBeNull();

    // A readable one survives verbatim, because it is the file's own word.
    const kept = await openPassportBackup(
      await sealPassportBackup(contents(), PASSWORD),
      PASSWORD,
    );
    expect(kept.createdAt).toBe('2026-08-19T09:00:00.000Z');
  });
});
