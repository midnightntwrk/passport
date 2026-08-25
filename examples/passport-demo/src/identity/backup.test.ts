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

import {
  PASSPORT_BACKUP_KDF,
  PASSPORT_BACKUP_VERSION,
  PassportBackupError,
  applyPassportBackup,
  assertNoKeyMaterial,
  backupFileName,
  collectPassportBackup,
  describeBackupPassword,
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
    // Passes the character test, fails the decode — a different sentence.
    await expect(openPassportBackup({ ...envelope, salt: 'a' }, PASSWORD)).rejects.toThrow(
      /salt could not be decoded/,
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

    const location = await fileBackupBackend.write('passport-backup-2026-08-25.json', '{}');
    /* An `<a download>` click reports nothing back — a blocked download, a
       cancelled dialog, and a written file are the same non-event here — so
       the words stop at what is true and send the user to check. */
    expect(location).toMatch(/^passport-backup-2026-08-25\.json — your browser was asked to save it/);
    expect(location).not.toMatch(/in this device's downloads/);
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
      async write(_fileName, envelope) {
        written.push(envelope);
        return 'in memory';
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
    expect(exported.location).toBe('in memory');
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

  it('refuses a name, a resolver target, or a reward id that is not the shape of one', async () => {
    const forged = contents();
    forged.aliases.preview!.resolverTargetHex = 'zz';
    const first = await applyPassportBackup(forged);
    expect(first.aliases.skipped[0]?.reason).toMatch(/not a 32-byte address/);

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
    expect(summary.passportContracts.skipped[0]?.reason).toMatch(/an older record/);
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
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'ff'.repeat(32) },
    });
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD);

    expect(summary.registryCheck).toEqual({ ran: true, confirmed: 1, unconfirmed: 0, otherNetworks: 0 });
    const stored = (await module.collectPassportBackup()).aliases.preview;
    expect(stored?.registryConfirmed).toBe(true);
    expect(stored?.resolverTargetHex).toBe('ff'.repeat(32));
  });

  it('leaves a name the registry does not answer for awaiting the registry', async () => {
    const module = await withRegistry(null);
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD);

    expect(summary.registryCheck).toMatchObject({ ran: true, confirmed: 0, unconfirmed: 1 });
    expect((await module.collectPassportBackup()).aliases.preview?.registryConfirmed).toBe(false);
  });

  it('treats a name pointing somewhere else as unconfirmed, not as agreement', async () => {
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'wallet', hex: 'ff'.repeat(32) },
    });
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD)).registryCheck).toMatchObject({
      unconfirmed: 1,
    });
  });

  it('reports an unreachable registry as a check that did not confirm', async () => {
    const module = await withRegistry('unreachable');
    const envelope = JSON.stringify(await module.sealPassportBackup(contents(), PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD)).registryCheck).toMatchObject({
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
    expect((await module.importPassportBackup(envelope, PASSWORD)).registryCheck).toMatchObject({
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
        target: { kind: 'contract', hex: 'ff'.repeat(32) },
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
    const summary = await module.importPassportBackup(envelope, PASSWORD);
    expect(summary.aliases.restored).toBe(1);
    expect(summary.registryCheck).toMatchObject({ ran: true, confirmed: 0, unconfirmed: 1 });
  });

  it('says there was nothing to check when the backup wrote no names', async () => {
    const module = await withRegistry(null);
    const payload = contents();
    payload.aliases = {};
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    expect((await module.importPassportBackup(envelope, PASSWORD)).registryCheck).toEqual({
      ran: false,
      reason: 'the backup wrote no name claims, so there was nothing to check.',
    });
  });

  it('does not re-check a name that was restored as queued', async () => {
    const module = await withRegistry({
      resolverAddress: '0200beef',
      target: { kind: 'contract', hex: 'ff'.repeat(32) },
    });
    const payload = contents();
    payload.aliases.preview = {
      ...contents().aliases.preview!,
      status: 'queued',
      queuedReason: 'the registry was unreachable',
    };
    const envelope = JSON.stringify(await module.sealPassportBackup(payload, PASSWORD));
    const summary = await module.importPassportBackup(envelope, PASSWORD);
    expect(summary.aliases.restored).toBe(1);
    expect(summary.registryCheck).toEqual({ ran: true, confirmed: 0, unconfirmed: 0, otherNetworks: 0 });
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
    const location = await fileBackupBackend.write('passport-backup.json', '{"v":1}');
    expect(location).toBe('my-passport.json, where you chose to save it');
    expect(picker.written).toEqual(['{"v":1}']);
  });

  it('falls back to the suggested name when the handle does not carry one', async () => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      }),
    });
    expect(await fileBackupBackend.write('passport-backup.json', '{}')).toBe(
      'passport-backup.json, where you chose to save it',
    );
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
      const location = await fileBackupBackend.write('passport-backup.json', '{}');
      expect(location).toMatch(/your browser was asked to save it/);
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

  it('keeps a resolver target hex recorded without a target kind', async () => {
    const payload = contents();
    delete payload.aliases.preview!.resolverTarget;
    payload.aliases.preview!.resolverTargetHex = 'ff'.repeat(32);
    const summary = await applyPassportBackup(payload);
    expect(summary.aliases.restored).toBe(1);
    const stored = (await collectPassportBackup()).aliases.preview;
    expect(stored?.resolverTargetHex).toBe('ff'.repeat(32));
    expect(stored?.resolverTarget).toBeUndefined();
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
    // The store stamps a record that arrives without a timestamp.
    const stored = (await collectPassportBackup()).passportContracts['AQIDBA==::preview'];
    expect(stored?.updatedAt).toMatch(/^\d{4}-/);
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
