import type { PassportPasskeyReference } from '@midnight-ntwrk/passport-sdk';

const DATABASE = 'midnight-passport';
const STORE = 'public-profile';

export interface DemoPassportProfile {
  subjectId: string;
  passkey: PassportPasskeyReference;
  createdAt: string;
  /** Public retry metadata. The transaction itself remains encrypted. */
  passportPreparation?: {
    address: string;
    preparedAt: string;
    network: 'preview';
    artifact: 'passport-c1-pilot-v1';
  };
  /** Set only after Dynamic returns a real transaction hash for a C1 deployment. */
  passportContract?: {
    address: string;
    deployedAt: string;
    txHash: string;
    network: 'preview';
    status: 'submitted' | 'confirmed';
    artifact: 'passport-c1-pilot-v1';
  };
}

async function database(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable in this browser.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      if (!request.result.objectStoreNames.contains('private-state')) {
        request.result.createObjectStore('private-state');
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Unable to open Passport profile storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function request<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const result = operation(transaction.objectStore(STORE));
    result.onsuccess = () => resolve(result.result);
    result.onerror = () => reject(result.error ?? new Error('Passport profile storage request failed.'));
  });
}

export async function loadDemoProfile(subjectId: string): Promise<DemoPassportProfile | null> {
  return (await request('readonly', (store) => store.get(subjectId))) ?? null;
}

export async function saveDemoProfile(profile: DemoPassportProfile): Promise<void> {
  await request('readwrite', (store) => store.put(profile, profile.subjectId));
}

export async function deleteDemoProfile(subjectId: string): Promise<void> {
  await request('readwrite', (store) => store.delete(subjectId));
}
