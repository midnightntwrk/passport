import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_ACCOUNT_BLOB_BYTES,
  WebAuthnPrfKeyProvider,
  decodeAccountBlob,
  encodeAccountBlob,
} from '../src/index.js';
import type { PassportAccountBlob } from '../src/index.js';

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

  it('asks for a PRF evaluation at creation and hands the output back when the platform obliges', async () => {
    const rawId = new Uint8Array([4, 5, 6]).buffer;
    const prfOutput = new Uint8Array(32).fill(3);
    let creations = 0;
    let assertions = 0;
    let capturedOptions: CredentialCreationOptions | undefined;
    replaceNavigator({
      credentials: {
        create: async (options: CredentialCreationOptions) => {
          creations += 1;
          capturedOptions = options;
          return {
            rawId,
            getClientExtensionResults: () => ({
              prf: { enabled: true, results: { first: prfOutput.slice().buffer } },
            }),
          };
        },
        get: async () => {
          assertions += 1;
          throw new Error('create must not need an assertion when the platform evaluates the PRF');
        },
      },
    });

    const enrolled = await WebAuthnPrfKeyProvider.enrollWithPrf({
      label: 'Midnight Passport',
      userId: 'local-1',
    });
    const publicKey = capturedOptions?.publicKey as Record<string, unknown>;
    // The eval — not merely `prf: {}` — is what makes a zero-assertion create
    // possible at all.
    expect(
      (publicKey.extensions as { prf?: { eval?: { first?: ArrayBuffer } } }).prf?.eval?.first,
    ).toBeInstanceOf(ArrayBuffer);
    expect(enrolled.reference.credentialId).toBe('BAUG');
    expect(enrolled.prf).not.toBeNull();

    // Both secrets from that one ceremony, and byte-identical to the targeted
    // path's — the whole point of collapsing the prompts.
    const seed = await enrolled.prf!.deriveWalletSeed(scope);
    const key = await enrolled.prf!.deriveStateKey(scope);
    expect(seed).toHaveLength(32);
    expect(key.extractable).toBe(false);
    enrolled.prf!.dispose();

    expect(creations).toBe(1);
    expect(assertions).toBe(0);
  });

  it('falls back to no creation-time PRF, without erroring, when the platform only enables it', async () => {
    let creations = 0;
    replaceNavigator({
      credentials: {
        create: async () => {
          creations += 1;
          return {
            rawId: new Uint8Array([7, 7]).buffer,
            getClientExtensionResults: () => ({ prf: { enabled: true } }),
          };
        },
      },
    });

    const enrolled = await WebAuthnPrfKeyProvider.enrollWithPrf({
      label: 'Midnight Passport',
      userId: 'local-2',
    });
    expect(enrolled.prf).toBeNull();
    expect(enrolled.reference.credentialId).toBe('Bwc=');
    // Never enrol twice: the fallback is an assertion, not a second create.
    expect(creations).toBe(1);
  });

  it('asserts a known credential exactly once and derives both secrets from it', async () => {
    const prfOutput = new Uint8Array(32).fill(11);
    let assertions = 0;
    let capturedOptions: CredentialRequestOptions | undefined;
    replaceNavigator({
      credentials: {
        get: async (options: CredentialRequestOptions) => {
          assertions += 1;
          capturedOptions = options;
          return {
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            getClientExtensionResults: () => ({
              prf: { results: { first: prfOutput.slice().buffer } },
            }),
          };
        },
      },
    });

    const reference = { credentialId: 'AQIDBA==', label: 'Midnight Passport', rpId: 'localhost' };
    const once = await WebAuthnPrfKeyProvider.assertOnce(reference);
    const publicKey = capturedOptions?.publicKey as Record<string, unknown>;
    // Targeted, unlike discover(): the credential is already known.
    expect(publicKey.allowCredentials).toHaveLength(1);
    expect(publicKey.rpId).toBe('localhost');

    const seedOnce = await once.deriveWalletSeed(scope);
    await once.deriveStateKey(scope);
    // One ceremony, both secrets — this is the single-sign guarantee.
    expect(assertions).toBe(1);

    const targeted = new WebAuthnPrfKeyProvider(reference);
    const targetedSeed = await targeted.deriveWalletSeed(scope);
    expect([...seedOnce]).toEqual([...targetedSeed]);

    once.dispose();
    await expect(once.deriveStateKey(scope)).rejects.toThrow('already been disposed');
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

/**
 * largeBlob — account metadata recovery.
 *
 * WebAuthn cannot be driven headlessly, so these drills stand in for the
 * ceremony, not for the authenticator: they pin the request this module BUILDS
 * and the way it reads the answer, including every "this platform does not do
 * largeBlob" shape a real client returns. The two legs that need a human are
 * named in the module header.
 */
describe('WebAuthn largeBlob account metadata', () => {
  const reference = { credentialId: 'AQIDBA==', label: 'Midnight Passport', rpId: 'localhost' };
  const blob: PassportAccountBlob = {
    v: 1,
    acc: { address: 'ab'.repeat(32), network: 'preview' },
    alias: 'alice',
  };

  it('round-trips a blob and refuses one too large for an authenticator', () => {
    expect(decodeAccountBlob(encodeAccountBlob(blob))).toEqual(blob);
    expect(encodeAccountBlob(blob).byteLength).toBeLessThan(MAX_ACCOUNT_BLOB_BYTES);
    expect(() =>
      encodeAccountBlob({ ...blob, alias: 'a'.repeat(MAX_ACCOUNT_BLOB_BYTES) }),
    ).toThrow(/may not exceed 2048 bytes/);
  });

  it('reads anything it does not fully understand as no metadata at all', () => {
    expect(decodeAccountBlob(null)).toBeNull();
    expect(decodeAccountBlob(new Uint8Array(0))).toBeNull();
    expect(decodeAccountBlob(new TextEncoder().encode('not json'))).toBeNull();
    // A future format, and a blob with nothing usable in it.
    expect(decodeAccountBlob(new TextEncoder().encode('{"v":2,"acc":{}}'))).toBeNull();
    expect(
      decodeAccountBlob(new TextEncoder().encode('{"v":1,"acc":{"address":"","network":"x"}}')),
    ).toBeNull();
  });

  it('asks for the blob on the same assertion that evaluates the PRF', async () => {
    let capturedOptions: CredentialRequestOptions | undefined;
    let assertions = 0;
    replaceNavigator({
      credentials: {
        get: async (options: CredentialRequestOptions) => {
          assertions += 1;
          capturedOptions = options;
          return {
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(4).buffer } },
              largeBlob: { blob: encodeAccountBlob(blob).slice().buffer },
            }),
          };
        },
      },
    });

    const once = await WebAuthnPrfKeyProvider.assertOnce(reference);
    const publicKey = capturedOptions?.publicKey as Record<string, unknown>;
    const extensions = publicKey.extensions as {
      prf?: unknown;
      largeBlob?: { read?: boolean; write?: unknown };
    };
    // Read and PRF ride together; a write may never be in the same bag.
    expect(extensions.largeBlob?.read).toBe(true);
    expect('write' in (extensions.largeBlob ?? {})).toBe(false);
    expect(extensions.prf).toBeDefined();
    expect(once.accountBlob).toEqual(blob);
    // No second ceremony was needed to obtain it.
    expect(assertions).toBe(1);
    once.dispose();
  });

  it('reports no blob, and never fails, on a platform without the extension', async () => {
    replaceNavigator({
      credentials: {
        get: async () => ({
          rawId: new Uint8Array([9]).buffer,
          // Exactly what a client that ignores largeBlob returns.
          getClientExtensionResults: () => ({
            prf: { results: { first: new Uint8Array(32).fill(1).buffer } },
          }),
        }),
      },
    });
    const discovered = await WebAuthnPrfKeyProvider.discover({ rpId: 'localhost' });
    expect(discovered.accountBlob).toBeNull();
    // The secrets are unaffected: today's behaviour, exactly.
    expect(await discovered.deriveWalletSeed(scope)).toHaveLength(32);
    discovered.dispose();
  });

  it('writes the blob in its own assertion and reports that it was written', async () => {
    let capturedOptions: CredentialRequestOptions | undefined;
    replaceNavigator({
      credentials: {
        get: async (options: CredentialRequestOptions) => {
          capturedOptions = options;
          return {
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            getClientExtensionResults: () => ({ largeBlob: { written: true } }),
          };
        },
      },
    });

    const result = await WebAuthnPrfKeyProvider.writeAccountBlob(reference, blob);
    expect(result).toEqual({ written: true, reason: null });
    const publicKey = capturedOptions?.publicKey as Record<string, unknown>;
    const extensions = publicKey.extensions as { largeBlob?: { write?: ArrayBuffer } };
    expect(extensions.largeBlob?.write).toBeInstanceOf(ArrayBuffer);
    // The write ceremony derives nothing, so no PRF salt goes on the wire.
    expect('prf' in (publicKey.extensions as Record<string, unknown>)).toBe(false);
    expect(publicKey.allowCredentials).toHaveLength(1);
  });

  it('never throws on a write the platform will not do, and says why', async () => {
    replaceNavigator({
      credentials: {
        get: async () => ({
          rawId: new Uint8Array([1]).buffer,
          getClientExtensionResults: () => ({}),
        }),
      },
    });
    await expect(WebAuthnPrfKeyProvider.writeAccountBlob(reference, blob)).resolves.toEqual({
      written: false,
      reason: 'This platform does not implement the WebAuthn largeBlob extension.',
    });

    replaceNavigator({
      credentials: {
        get: async () => ({
          rawId: new Uint8Array([1]).buffer,
          getClientExtensionResults: () => ({ largeBlob: { written: false } }),
        }),
      },
    });
    await expect(WebAuthnPrfKeyProvider.writeAccountBlob(reference, blob)).resolves.toMatchObject({
      written: false,
      reason: 'The authenticator refused to store the blob on this credential.',
    });

    replaceNavigator({ credentials: { get: async () => null } });
    await expect(WebAuthnPrfKeyProvider.writeAccountBlob(reference, blob)).resolves.toMatchObject({
      written: false,
      reason: 'The user cancelled the write.',
    });

    replaceNavigator({});
    await expect(WebAuthnPrfKeyProvider.writeAccountBlob(reference, blob)).resolves.toMatchObject({
      written: false,
    });
  });

  it('asks for largeBlob support at enrolment without ever making it a condition', async () => {
    let capturedOptions: CredentialCreationOptions | undefined;
    replaceNavigator({
      credentials: {
        create: async (options: CredentialCreationOptions) => {
          capturedOptions = options;
          return {
            rawId: new Uint8Array([5, 5]).buffer,
            getClientExtensionResults: () => ({
              prf: { enabled: true },
              largeBlob: { supported: true },
            }),
          };
        },
      },
    });

    const enrolled = await WebAuthnPrfKeyProvider.enrollWithPrf({
      label: 'Midnight Passport',
      userId: 'local-blob',
    });
    const publicKey = capturedOptions?.publicKey as Record<string, unknown>;
    const extensions = publicKey.extensions as { largeBlob?: { support?: string } };
    // 'required' would make enrolment fail on every platform without
    // largeBlob, which is most of them. It must always be 'preferred'.
    expect(extensions.largeBlob?.support).toBe('preferred');
    expect(enrolled.largeBlobSupported).toBe(true);
  });

  it('reports unknown largeBlob support as null rather than guessing', async () => {
    replaceNavigator({
      credentials: {
        create: async () => ({
          rawId: new Uint8Array([6, 6]).buffer,
          getClientExtensionResults: () => ({ prf: { enabled: true } }),
        }),
      },
    });
    const enrolled = await WebAuthnPrfKeyProvider.enrollWithPrf({
      label: 'Midnight Passport',
      userId: 'local-blob-2',
    });
    expect(enrolled.largeBlobSupported).toBeNull();
  });

  it('reads a blob on its own without deriving anything, and degrades to null', async () => {
    replaceNavigator({
      credentials: {
        get: async () => ({
          rawId: new Uint8Array([1, 2, 3, 4]).buffer,
          getClientExtensionResults: () => ({
            largeBlob: { blob: encodeAccountBlob(blob).slice().buffer },
          }),
        }),
      },
    });
    await expect(WebAuthnPrfKeyProvider.readAccountBlob(reference)).resolves.toEqual(blob);

    replaceNavigator({});
    await expect(WebAuthnPrfKeyProvider.readAccountBlob(reference)).resolves.toBeNull();
  });
});
