import { asArrayBuffer, decodeState, encodeState, fromBase64, toBase64, utf8 } from './encoding.js';
import type {
  PassportEncryptedEnvelope,
  PassportEncryptedRecordStore,
  PassportPrivateStateStore,
  PassportStateKeyProvider,
  PassportStateScope,
} from './types.js';

const ENVELOPE_VERSION = 1 as const;
const DOMAIN = 'midnight-passport:private-state:v1';

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto is required for Passport private-state storage.');
  }
  return globalThis.crypto;
}

function validateScope(scope: PassportStateScope): void {
  if (!scope.appId.trim()) throw new Error('Passport state scope requires an appId.');
  if (!scope.accountId.trim()) throw new Error('Passport state scope requires an accountId.');
}

function additionalData(scope: PassportStateScope): Uint8Array {
  validateScope(scope);
  return utf8(`${DOMAIN}|${scope.appId}|${scope.accountId}`);
}

async function storageKey(scope: PassportStateScope): Promise<string> {
  const digest = await webCrypto().subtle.digest('SHA-256', asArrayBuffer(additionalData(scope)));
  return `passport-state:${toBase64(new Uint8Array(digest))}`;
}

export class MemoryPassportEncryptedRecordStore implements PassportEncryptedRecordStore {
  private readonly values = new Map<string, PassportEncryptedEnvelope>();

  async get(key: string): Promise<PassportEncryptedEnvelope | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: PassportEncryptedEnvelope): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async clear(): Promise<void> {
    this.values.clear();
  }

  /** Test-only inspection hook. It never decrypts an envelope. */
  snapshot(): PassportEncryptedEnvelope[] {
    return [...this.values.values()].map((value) => structuredClone(value));
  }
}

export class IndexedDbPassportEncryptedRecordStore implements PassportEncryptedRecordStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly databaseName = 'midnight-passport',
    private readonly objectStoreName = 'private-state',
  ) {}

  async get(key: string): Promise<PassportEncryptedEnvelope | null> {
    return this.request('readonly', (store) => store.get(key)).then(
      (value) => (value as PassportEncryptedEnvelope | undefined) ?? null,
    );
  }

  async set(key: string, value: PassportEncryptedEnvelope): Promise<void> {
    await this.request('readwrite', (store) => store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(key));
  }

  async clear(): Promise<void> {
    await this.request('readwrite', (store) => store.clear());
  }

  private async database(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) {
      throw new Error('IndexedDB is unavailable. Use a browser storage adapter.');
    }
    this.dbPromise ??= new Promise((resolve, reject) => {
      // Do not request a fixed database version. Integrators can safely add
      // their own object stores to the same Passport database over time.
      const request = globalThis.indexedDB.open(this.databaseName);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.objectStoreName)) {
          request.result.createObjectStore(this.objectStoreName);
        }
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to open Passport storage.'));
      request.onsuccess = () => resolve(request.result);
    });
    return this.dbPromise;
  }

  private async request<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.database();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(this.objectStoreName, mode);
      const request = operation(transaction.objectStore(this.objectStoreName));
      request.onerror = () => reject(request.error ?? new Error('Passport storage request failed.'));
      request.onsuccess = () => resolve(request.result);
    });
  }
}

export class EncryptedPassportPrivateStateStore implements PassportPrivateStateStore {
  constructor(
    private readonly records: PassportEncryptedRecordStore,
    private readonly keys: PassportStateKeyProvider,
  ) {}

  async save<T>(scope: PassportStateScope, state: T): Promise<void> {
    const crypto = webCrypto();
    const key = await this.keys.getKey(scope);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: asArrayBuffer(iv),
        additionalData: asArrayBuffer(additionalData(scope)),
        tagLength: 128,
      },
      key,
      asArrayBuffer(encodeState(state)),
    );
    await this.records.set(await storageKey(scope), {
      version: ENVELOPE_VERSION,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      updatedAt: new Date().toISOString(),
    });
  }

  async load<T>(scope: PassportStateScope): Promise<T | null> {
    const envelope = await this.records.get(await storageKey(scope));
    if (!envelope) return null;
    if (envelope.version !== ENVELOPE_VERSION) {
      throw new Error(`Unsupported Passport private-state version: ${String(envelope.version)}.`);
    }
    const key = await this.keys.getKey(scope);
    try {
      const plaintext = await webCrypto().subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: asArrayBuffer(fromBase64(envelope.iv)),
          additionalData: asArrayBuffer(additionalData(scope)),
          tagLength: 128,
        },
        key,
        asArrayBuffer(fromBase64(envelope.ciphertext)),
      );
      return decodeState<T>(new Uint8Array(plaintext));
    } catch (error) {
      throw new Error(
        `Passport private state could not be unlocked for this app and account: ${
          error instanceof Error ? error.message : 'unknown encryption error'
        }`,
      );
    }
  }

  async remove(scope: PassportStateScope): Promise<void> {
    await this.records.delete(await storageKey(scope));
  }

  async clear(): Promise<void> {
    await this.records.clear();
  }
}
