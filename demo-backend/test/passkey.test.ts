import { afterEach, describe, expect, it } from 'vitest';

import { WebAuthnPrfKeyProvider } from '../src/index.js';

const scope = { appId: 'org.midnight.passport.demo', accountId: 'passport-account' };
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function replaceNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

describe('WebAuthnPrfKeyProvider', () => {
  it('rejects a missing WebAuthn credential API', async () => {
    replaceNavigator({});
    await expect(
      WebAuthnPrfKeyProvider.enroll({ label: 'Midnight Passport', userId: 'dynamic-user-1' }),
    ).rejects.toThrow('WebAuthn is unavailable');
  });

  it('reports cancelled passkey enrollment and unlock operations', async () => {
    replaceNavigator({
      credentials: {
        create: async () => null,
        get: async () => null,
      },
    });

    await expect(
      WebAuthnPrfKeyProvider.enroll({ label: 'Midnight Passport', userId: 'dynamic-user-1' }),
    ).rejects.toThrow('Passport passkey creation was cancelled');

    const provider = new WebAuthnPrfKeyProvider({
      credentialId: 'AQID',
      label: 'Midnight Passport',
    });
    await expect(provider.getKey(scope)).rejects.toThrow('Passport passkey unlock was cancelled');
  });

  it('discovers a resident passkey with no allowCredentials and reports which answered', async () => {
    const rawId = new Uint8Array([1, 2, 3, 4]).buffer;
    let capturedOptions: CredentialRequestOptions | undefined;
    replaceNavigator({
      credentials: {
        get: async (options: CredentialRequestOptions) => {
          capturedOptions = options;
          return {
            rawId,
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(7).buffer } },
            }),
          };
        },
      },
    });

    const discovered = await WebAuthnPrfKeyProvider.discover({ rpId: 'localhost' });
    const publicKey = capturedOptions?.publicKey as Record<string, unknown>;
    // The discoverable contract: the platform must be free to offer every
    // resident credential, so no allow-list may be sent at all.
    expect('allowCredentials' in publicKey).toBe(false);
    expect(publicKey.userVerification).toBe('required');
    expect(publicKey.rpId).toBe('localhost');
    expect(
      (publicKey.extensions as { prf?: { eval?: { first?: ArrayBuffer } } }).prf?.eval?.first,
    ).toBeInstanceOf(ArrayBuffer);
    // base64 of [1,2,3,4] — the same encoding enroll stores.
    expect(discovered.credentialId).toBe('AQIDBA==');
    discovered.dispose();
  });

  it('derives byte-identical wallet seeds on the discoverable and targeted paths', async () => {
    const prfOutput = new Uint8Array(32).fill(5);
    replaceNavigator({
      credentials: {
        get: async () => ({
          rawId: new Uint8Array([9, 9, 9]).buffer,
          getClientExtensionResults: () => ({
            prf: { results: { first: prfOutput.slice().buffer } },
          }),
        }),
      },
    });

    const discovered = await WebAuthnPrfKeyProvider.discover({ rpId: 'localhost' });
    const discoveredSeed = await discovered.deriveWalletSeed(scope);
    const targeted = new WebAuthnPrfKeyProvider({
      credentialId: discovered.credentialId,
      label: 'Midnight Passport',
    });
    const targetedSeed = await targeted.deriveWalletSeed(scope);

    expect(discoveredSeed).toHaveLength(32);
    expect([...discoveredSeed]).toEqual([...targetedSeed]);
    // A different scope must not produce the same seed: the HKDF info string
    // carries the scope, on both paths.
    const otherSeed = await discovered.deriveWalletSeed({ ...scope, accountId: 'other-account' });
    expect([...otherSeed]).not.toEqual([...discoveredSeed]);

    const stateKey = await discovered.deriveStateKey(scope);
    expect(stateKey.extractable).toBe(false);

    discovered.dispose();
    await expect(discovered.deriveWalletSeed(scope)).rejects.toThrow('already been disposed');
  });

  it('reuses a non-exportable key for one operation and locks explicitly', async () => {
    let assertions = 0;
    replaceNavigator({
      credentials: {
        get: async () => {
          assertions += 1;
          return {
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(9).buffer } },
            }),
          };
        },
      },
    });

    const provider = new WebAuthnPrfKeyProvider({
      credentialId: 'AQID',
      label: 'Midnight Passport',
    });
    const first = await provider.getKey(scope);
    const second = await provider.getKey(scope);
    provider.lock(scope);
    const third = await provider.getKey(scope);

    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(first.extractable).toBe(false);
    expect(assertions).toBe(2);
  });
});
