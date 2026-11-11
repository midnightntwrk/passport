import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { ChangeJournal, ChangeJournalStore } from '../wallet/change-journal.js';

export interface FileChangeJournalOptions {
  /** Dedicated local directory. Existing directories must be private to the current user. */
  directory: string;
  /** Caller-managed random 32-byte encryption key. Keep it outside the journal directory. */
  encryptionKey: Uint8Array;
}

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const FORMAT = 'passport-change-journal-v1';
const directoryQueues = new Map<string, Promise<void>>();

async function serialise<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = directoryQueues.get(directory) ?? Promise.resolve();
  let release: () => void;
  const pending = new Promise<void>(done => { release = done; });
  const tail = previous.then(() => pending);
  directoryQueues.set(directory, tail);
  await previous;
  try { return await action(); }
  finally {
    release!();
    if (directoryQueues.get(directory) === tail) directoryQueues.delete(directory);
  }
}

function checkJournal(scope: string, value: unknown): asserts value is ChangeJournal {
  const journal = value as ChangeJournal;
  if (!scope || !journal || journal.version !== 1 || journal.scope !== scope || !Array.isArray(journal.entries)) {
    throw new Error('invalid change journal snapshot or scope');
  }
}

function requirePrivate(mode: number, uid: number): void {
  if ((mode & 0o077) !== 0 || (typeof process.getuid === 'function' && uid !== process.getuid())) {
    throw new Error('change journal storage must be owned by the current user with no group or other access');
  }
}

/**
 * Encrypted local journal with atomic replacement and acknowledged disk flushes.
 * A successful set fsyncs both the new file and its containing directory. A
 * rejected write may nevertheless have replaced the snapshot, so callers must
 * stop submission and reread the journal before retrying.
 *
 * This store supports one writer process. Calls from instances in this process
 * sharing the canonical directory are serialised. It offers no cross-process
 * compare-and-swap, remote-filesystem guarantees, rollback detection, or backup
 * of the encryption key. The coordinator must guard each read-modify-write.
 */
export async function createFileChangeJournalStore(options: FileChangeJournalOptions): Promise<ChangeJournalStore> {
  if (typeof options.directory !== 'string' || options.directory.length === 0) {
    throw new Error('an explicit change journal directory is required');
  }
  if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32) {
    throw new Error('a caller-managed 32-byte change journal encryption key is required');
  }
  const key = Buffer.from(options.encryptionKey);
  const firstCreated = await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 });
  const directory = await realpath(resolve(options.directory));
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await directoryHandle.stat();
    requirePrivate(info.mode, info.uid);
    await directoryHandle.sync();
  } finally { await directoryHandle.close(); }
  // Persist every newly created directory entry, including the journal
  // directory's name in its parent, before accepting any journal writes.
  if (firstCreated) {
    const existingParent = await realpath(dirname(firstCreated));
    for (let current = dirname(directory); ; current = dirname(current)) {
      const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await handle.sync(); } finally { await handle.close(); }
      if (current === existingParent || current === dirname(current)) break;
    }
  }

  const filename = (scope: string) => {
    if (typeof scope !== 'string' || !scope) throw new Error('change journal scope is required');
    return join(directory, `${createHash('sha256').update(scope).digest('hex')}.json.enc`);
  };
  const aad = (scope: string) => Buffer.from(`${FORMAT}\0${scope}`, 'utf8');

  return {
    async get(scope) {
      const path = filename(scope);
      return serialise(directory, async () => {
        let file;
        try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
        try {
          const info = await file.stat();
          requirePrivate(info.mode, info.uid);
          if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) throw new Error('invalid change journal file');
          const envelope = JSON.parse(await file.readFile('utf8'));
          if (envelope.format !== FORMAT || !/^[0-9a-f]{24}$/.test(envelope.nonce)
            || !/^[0-9a-f]{32}$/.test(envelope.tag) || typeof envelope.ciphertext !== 'string') {
            throw new Error('invalid encrypted change journal envelope');
          }
          const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'hex'), { authTagLength: 16 });
          decipher.setAAD(aad(scope));
          decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
          const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
          const snapshot = JSON.parse(plaintext.toString('utf8'));
          checkJournal(scope, snapshot);
          return snapshot;
        } finally { await file.close(); }
      });
    },
    async set(scope, journal) {
      checkJournal(scope, journal);
      // Serialise before yielding, so a caller cannot mutate the submitted snapshot.
      const plaintext = Buffer.from(JSON.stringify(journal), 'utf8');
      const path = filename(scope);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      cipher.setAAD(aad(scope));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = JSON.stringify({ format: FORMAT, nonce: nonce.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') });
      if (Buffer.byteLength(envelope, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('change journal snapshot is too large');
      await serialise(directory, async () => {
        const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
        try {
          const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try {
            await file.writeFile(envelope, 'utf8');
            await file.sync();
          } finally { await file.close(); }
          await rename(temporary, path);
          const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await parent.sync(); } finally { await parent.close(); }
        } finally {
          await unlink(temporary).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
        }
      });
    },
  };
}
