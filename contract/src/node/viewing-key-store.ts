import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { validatePersistedViewingKey, validateViewingKeyScope,
  type ViewingKeyScope, type ViewingKeyStore } from '../wallet/viewing-recovery.js';

export interface FileViewingKeyStoreOptions {
  /** Dedicated directory, private to the current user. */
  directory: string;
  /** Independent caller-managed 32-byte key. Keep it outside this directory. */
  encryptionKey: Uint8Array;
}

const FORMAT = 'passport-viewing-key-v1';
const MAX_FILE_BYTES = 16 * 1024;
const queues = new Map<string, Promise<void>>();

function scopeId(scope: ViewingKeyScope): string {
  const checked = validateViewingKeyScope(scope);
  return JSON.stringify([checked.networkId, checked.address]);
}

function requirePrivate(mode: number, uid: number): void {
  if ((mode & 0o077) !== 0 || (typeof process.getuid === 'function' && uid !== process.getuid())) {
    throw new Error('viewing key storage must be owned by the current user with no group or other access');
  }
}

async function serialise<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve();
  let release: () => void;
  const pending = new Promise<void>(done => { release = done; });
  const tail = previous.then(() => pending);
  queues.set(directory, tail);
  await previous;
  try { return await action(); }
  finally {
    release!();
    if (queues.get(directory) === tail) queues.delete(directory);
  }
}

/**
 * Encrypted current-viewing-key vault with atomic replacement and acknowledged
 * file and directory fsyncs. A rejected set may have reached disk; reread before
 * retrying. Same-directory calls in this process are serialised. One writer
 * process is supported, with no rollback detection or remote-filesystem claim.
 * This vault persists keys; only a fresh chain check establishes their currency.
 */
export async function createFileViewingKeyStore(options: FileViewingKeyStoreOptions): Promise<ViewingKeyStore> {
  if (!options || typeof options.directory !== 'string' || !options.directory) throw new Error('an explicit viewing key directory is required');
  if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32) throw new Error('a caller-managed 32-byte vault encryption key is required');
  const key = Buffer.from(options.encryptionKey);
  const firstCreated = await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 });
  const directory = await realpath(resolve(options.directory));
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await directoryHandle.stat();
    requirePrivate(info.mode, info.uid);
    await directoryHandle.sync();
  } finally { await directoryHandle.close(); }
  if (firstCreated) {
    const existingParent = await realpath(dirname(firstCreated));
    for (let current = dirname(directory); ; current = dirname(current)) {
      const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await handle.sync(); } finally { await handle.close(); }
      if (current === existingParent || current === dirname(current)) break;
    }
  }
  const filename = (scope: string) => join(directory, `${createHash('sha256').update(scope).digest('hex')}.json.enc`);
  const aad = (scope: string) => Buffer.from(`${FORMAT}\0${scope}`, 'utf8');
  return {
    async get(scope) {
      const identity = scopeId(scope);
      return serialise(directory, async () => {
        let file;
        try { file = await open(filename(identity), constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
        try {
          const info = await file.stat();
          requirePrivate(info.mode, info.uid);
          if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('invalid viewing key file');
          const envelope = JSON.parse(await file.readFile('utf8'));
          if (!envelope || envelope.format !== FORMAT || typeof envelope.nonce !== 'string' || !/^[0-9a-f]{24}$/.test(envelope.nonce)
            || typeof envelope.tag !== 'string' || !/^[0-9a-f]{32}$/.test(envelope.tag)
            || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) {
            throw new Error('invalid encrypted viewing key envelope');
          }
          const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'hex'), { authTagLength: 16 });
          decipher.setAAD(aad(identity));
          decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
          const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
          try {
            const record = validatePersistedViewingKey(JSON.parse(plaintext.toString('utf8')));
            if (scopeId(record) !== identity) throw new Error('viewing key scope mismatch');
            return record;
          } finally { plaintext.fill(0); }
        } finally { await file.close(); }
      });
    },
    async set(value) {
      const record = validatePersistedViewingKey(value), identity = scopeId(record), path = filename(identity);
      // Detach and encrypt before yielding so caller mutations cannot change a write.
      const plaintext = Buffer.from(JSON.stringify(record), 'utf8');
      let envelope: string;
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        cipher.setAAD(aad(identity));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        envelope = JSON.stringify({ format: FORMAT, nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') });
      } finally { plaintext.fill(0); }
      if (Buffer.byteLength(envelope, 'utf8') > MAX_FILE_BYTES) throw new Error('viewing key record is too large');
      await serialise(directory, async () => {
        const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
        try {
          const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(envelope, 'utf8'); await file.sync(); }
          finally { await file.close(); }
          await rename(temporary, path);
          const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await parent.sync(); } finally { await parent.close(); }
        } finally { await unlink(temporary).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; }); }
      });
    },
  };
}
