// A fresh, scoped, memory-only test client. Implements the full SDK interface
// so attach/call paths cannot silently fall back to the funding wallet's DB.
import { strict as assert } from 'node:assert';
import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import type { CoinStorePrivateState } from '../../wallet/witnesses.js';

export function freshPrivateState(expectedAddress: string): PrivateStateProvider<string, CoinStorePrivateState> {
  let address: string | undefined;
  const states = new Map<string, CoinStorePrivateState>();
  const keys = new Map<string, Parameters<PrivateStateProvider['setSigningKey']>[1]>();
  const scoped = (id: string) => { assert.equal(address, expectedAddress, 'private state must be scoped'); return `${address}:${id}`; };
  const noExport = async (): Promise<never> => { throw new Error('import/export is outside the fresh-client experiment'); };
  return {
    setContractAddress(value) { assert.equal(value, expectedAddress); address = value; },
    get: async id => structuredClone(states.get(scoped(id)) ?? null),
    set: async (id, value) => { states.set(scoped(id), structuredClone(value)); },
    remove: async id => { states.delete(scoped(id)); },
    clear: async () => { states.clear(); },
    getSigningKey: async id => keys.get(id) ?? null,
    setSigningKey: async (id, value) => { keys.set(id, value); },
    removeSigningKey: async id => { keys.delete(id); },
    clearSigningKeys: async () => { keys.clear(); },
    exportPrivateStates: noExport, importPrivateStates: noExport,
    exportSigningKeys: noExport, importSigningKeys: noExport,
  };
}
