import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_ACCOUNT_BLOB_BYTES,
  PassportEnrolmentConflictError,
  PassportPasskeyDiscoveryError,
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

    // GOLDEN VECTOR — the seed a well-formed scope derived before the scope
    // validation landed, byte for byte. Rejecting collision-capable scopes must
    // never change the label of a scope that was always fine: if it did, every
    // wallet already derived from this scope would be unreachable. Recorded
    // from PRF output `Uint8Array(32).fill(5)` under the scope above.
    expect([...discoveredSeed]).toEqual([
      6, 132, 168, 189, 229, 137, 26, 171, 70, 112, 90, 79, 134, 30, 194, 233, 160, 99, 226, 250,
      110, 89, 137, 91, 77, 5, 6, 126, 169, 183, 157, 182,
    ]);
    // A colon inside the accountId is well-formed and MUST keep deriving: every
    // shipped multi-passkey Passport uses `passport-local:<credential>`.
    const colonScoped = await discovered.deriveWalletSeed({
      ...scope,
      accountId: 'passport-local:AQIDBA',
    });
    expect(colonScoped).toHaveLength(32);

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
            // base64 of [1,2,3] — the credential the provider below targets.
            // A targeted assertion now refuses any other credential's answer.
            rawId: new Uint8Array([1, 2, 3]).buffer,
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
    // Nothing was asked to be written, so there is no write to report.
    expect(once.accountBlobWritten).toBeNull();
    // No second ceremony was needed to obtain it.
    expect(assertions).toBe(1);
    once.dispose();
  });

  /* THE RIDE-ALONG (2026/08/31). A largeBlob write is only possible during an
     assertion and may not be paired with a read, so on its own it is a whole
     user-verified ceremony — which arrived, for the product owner, as a passkey
     prompt on a finished Home screen they had pressed nothing to summon. These
     three hold the alternative: the write is carried by an assertion that was
     happening anyway, it costs nothing, and what became of it is reported
     precisely enough that a caller knows whether to try again. */
  const assertionExtensions = (
    options: CredentialRequestOptions | undefined,
  ): { prf?: unknown; largeBlob?: { read?: boolean; write?: unknown } } =>
    (options?.publicKey as Record<string, unknown>).extensions as {
      prf?: unknown;
      largeBlob?: { read?: boolean; write?: unknown };
    };

  it('carries a blob on the sign-in assertion instead of a read, for no extra ceremony', async () => {
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
              largeBlob: { written: true },
            }),
          };
        },
      },
    });

    const once = await WebAuthnPrfKeyProvider.assertOnce(reference, {
      writeAccountBlob: blob,
    });
    const extensions = assertionExtensions(capturedOptions);
    // The write, and — because the specification forbids the pair — no read.
    expect(extensions.largeBlob?.write).toBeInstanceOf(ArrayBuffer);
    expect('read' in (extensions.largeBlob ?? {})).toBe(false);
    // The PRF still rides along: this is the sign-in's own assertion.
    expect(extensions.prf).toBeDefined();
    expect(await once.deriveWalletSeed(scope)).toHaveLength(32);
    expect(once.accountBlobWritten).toBe('written');
    // An assertion that wrote read nothing, and does not pretend otherwise.
    expect(once.accountBlob).toBeNull();
    // ONE ceremony, which is the whole point.
    expect(assertions).toBe(1);
    once.dispose();
  });

  it('separates a refusal, which is retryable, from a platform that has no largeBlob', async () => {
    const outcomeFor = async (largeBlob: unknown): Promise<string | null> => {
      replaceNavigator({
        credentials: {
          get: async () => ({
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(4).buffer } },
              ...(largeBlob === undefined ? {} : { largeBlob }),
            }),
          }),
        },
      });
      const once = await WebAuthnPrfKeyProvider.assertOnce(reference, {
        writeAccountBlob: blob,
      });
      const outcome = once.accountBlobWritten;
      once.dispose();
      return outcome;
    };

    // The extension answered and the write did not land: ask again next time.
    expect(await outcomeFor({ written: false })).toBe('refused');
    // The slice is absent altogether: this credential will never hold a blob.
    expect(await outcomeFor(undefined)).toBe('unsupported');
  });

  it('sends no largeBlob slice at all for a credential known not to hold one', async () => {
    /* THE ANDROID PROMPT THAT NEVER FINISHED (2026/09/04).
       Google Password Manager's passkeys implement PRF and do not implement
       largeBlob, and Chrome on Android narrows its account sheet to the
       credentials that can satisfy the extensions a request asks for. An
       assertion asking for a largeBlob write against a GPM passkey therefore
       raises a sheet with nothing selectable in it, and it does not settle —
       reported as "the passkey prompt did not finish", on an ordinary sign-in,
       days after the claim that owed the write.

       So `largeBlob: false` OMITS the slice rather than sending `read: false`.
       An extension the client must reconcile against the authenticator is one
       more thing that can narrow a picker; one that was never sent cannot. */
    let capturedOptions: CredentialRequestOptions | undefined;
    replaceNavigator({
      credentials: {
        get: async (options: CredentialRequestOptions) => {
          capturedOptions = options;
          return {
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(4).buffer } },
            }),
          };
        },
      },
    });

    const once = await WebAuthnPrfKeyProvider.assertOnce(reference, {
      writeAccountBlob: blob,
      largeBlob: false,
    });
    const extensions = assertionExtensions(capturedOptions);
    // Not `{ read: false }`, and not `{ write: … }`. Absent.
    expect('largeBlob' in extensions).toBe(false);
    // The PRF is untouched: the sign-in itself must still work, and on Android
    // it is the only extension that ever did.
    expect(extensions.prf).toBeDefined();
    expect(await once.deriveWalletSeed(scope)).toHaveLength(32);
    // Nothing was written and nothing was read, and neither is claimed.
    expect(once.accountBlobWritten).toBeNull();
    expect(once.accountBlob).toBeNull();
    /* And nothing was LEARNT. An assertion that did not ask has no evidence
       about the credential, and recording one would retire a capability on the
       strength of a question nobody put. */
    expect(once.largeBlobSupported).toBeNull();
    once.dispose();
  });

  it('learns from an ordinary read whether the credential can hold a blob at all', async () => {
    /* THE CHEAP HALF OF THE SAME FIX. Only the browser that ENROLLED a
       credential ever sees `largeBlob.supported`; a passkey synced from another
       device, or picked out of the platform's own account picker, arrives with
       the question open — and the app then had no way to answer it except by
       attempting the write that hangs. A read answers it for free and cannot
       narrow a picker. By specification the client omits the whole output when
       the authenticator has no largeBlob, and returns an empty slice when it
       has one and simply holds nothing: "cannot" against "has not". */
    const supportFor = async (largeBlob: unknown): Promise<boolean | null> => {
      replaceNavigator({
        credentials: {
          get: async () => ({
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(4).buffer } },
              ...(largeBlob === undefined ? {} : { largeBlob }),
            }),
          }),
        },
      });
      const once = await WebAuthnPrfKeyProvider.assertOnce(reference);
      const supported = once.largeBlobSupported;
      once.dispose();
      return supported;
    };

    // Supported, and holding nothing yet.
    expect(await supportFor({})).toBe(true);
    // Supported, and holding something.
    expect(await supportFor({ blob: new Uint8Array([1]).buffer })).toBe(true);
    // The slice is absent altogether: this credential will never hold a blob.
    expect(await supportFor(undefined)).toBe(false);
  });

  it('falls back to the read rather than failing a sign-in over an unencodable blob', async () => {
    /* An oversize payload is a programming error. It must not be the reason
       somebody cannot get into their Passport, so the assertion sends exactly
       what it would have sent with nothing offered. */
    let capturedOptions: CredentialRequestOptions | undefined;
    replaceNavigator({
      credentials: {
        get: async (options: CredentialRequestOptions) => {
          capturedOptions = options;
          return {
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(4).buffer } },
            }),
          };
        },
      },
    });

    const once = await WebAuthnPrfKeyProvider.assertOnce(reference, {
      writeAccountBlob: { ...blob, alias: 'a'.repeat(MAX_ACCOUNT_BLOB_BYTES) },
    });
    const extensions = assertionExtensions(capturedOptions);
    expect(extensions.largeBlob?.read).toBe(true);
    expect('write' in (extensions.largeBlob ?? {})).toBe(false);
    expect(once.accountBlobWritten).toBeNull();
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

/**
 * Scope→label injectivity.
 *
 * The two halves of a scope are glued into every HKDF info string with a bare
 * separator and nothing is escaped, so an appId carrying that separator makes
 * two different scopes derive the same secret. These pin the rule at the
 * derivation sites; `private-state.test.ts` pins it at the storage site.
 */
describe('scope encoding is injective', () => {
  const prfOutput = new Uint8Array(32).fill(5);

  async function discoveredHandle() {
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
    return WebAuthnPrfKeyProvider.discover({ rpId: 'localhost' });
  }

  it('refuses the appId half of a colliding pair on every derivation path', async () => {
    const handle = await discoveredHandle();
    // These two flattened to the SAME label before the rule existed:
    // 'demo:eu' + 'alice' and 'demo' + 'eu:alice'.
    const colliding = { appId: 'demo:eu', accountId: 'alice' };
    const wellFormed = { appId: 'demo', accountId: 'eu:alice' };

    await expect(handle.deriveWalletSeed(colliding)).rejects.toThrow(/may not contain/);
    await expect(handle.deriveStateKey(colliding)).rejects.toThrow(/may not contain/);
    // The other half of the pair is unambiguous and still derives.
    expect(await handle.deriveWalletSeed(wellFormed)).toHaveLength(32);
    handle.dispose();
  });

  it('refuses a pipe or a control character, and an empty half', async () => {
    const handle = await discoveredHandle();
    await expect(handle.deriveWalletSeed({ appId: 'demo|eu', accountId: 'alice' })).rejects.toThrow(
      /may not contain/,
    );
    await expect(
      handle.deriveWalletSeed({ appId: 'demo\u0000eu', accountId: 'alice' }),
    ).rejects.toThrow(/control characters/);
    await expect(
      handle.deriveWalletSeed({ appId: 'demo', accountId: 'alice\u0000bob' }),
    ).rejects.toThrow(/control characters/);
    await expect(handle.deriveWalletSeed({ appId: '  ', accountId: 'alice' })).rejects.toThrow(
      /requires an appId/,
    );
    handle.dispose();
  });

  it('runs the same rule on the cached targeted provider', async () => {
    replaceNavigator({
      credentials: {
        get: async () => ({
          rawId: new Uint8Array([1, 2, 3]).buffer,
          getClientExtensionResults: () => ({
            prf: { results: { first: prfOutput.slice().buffer } },
          }),
        }),
      },
    });
    const provider = new WebAuthnPrfKeyProvider({
      credentialId: 'AQID',
      label: 'Midnight Passport',
    });
    await expect(provider.getKey({ appId: 'a:b', accountId: 'c' })).rejects.toThrow(
      /may not contain/,
    );
    await expect(provider.deriveWalletSeed({ appId: 'a|b', accountId: 'c' })).rejects.toThrow(
      /may not contain/,
    );
  });
});

/**
 * Enrolment overwrite guard.
 *
 * The user handle is deterministic and resident keys are required, so a second
 * `create` for the same (rpId, user.id) REPLACES the credential and takes its
 * PRF secret — and every wallet seed derived from it — with it. Two mechanisms
 * stand against that: exclusion of every id we know, and asking the
 * authenticator itself before creating anything.
 */
describe('enrolment overwrite guard', () => {
  it('excludes every known credential, not only the deprecated single id', async () => {
    let capturedOptions: CredentialCreationOptions | undefined;
    replaceNavigator({
      credentials: {
        create: async (options: CredentialCreationOptions) => {
          capturedOptions = options;
          return {
            rawId: new Uint8Array([8, 8]).buffer,
            getClientExtensionResults: () => ({ prf: { enabled: true } }),
          };
        },
      },
    });

    await WebAuthnPrfKeyProvider.enrollWithPrf({
      label: 'Midnight Passport',
      userId: 'local-exclude',
      knownCredentialIds: ['AQID', 'BAUG', 'AQID'],
      // The deprecated alias still counts, and is folded in rather than ignored.
      existingCredentialId: 'Bwc=',
    });
    const publicKey = capturedOptions?.publicKey as Record<string, unknown>;
    const excluded = publicKey.excludeCredentials as { id: ArrayBuffer; type: string }[];
    // Three: the duplicate collapses, the alias joins.
    expect(excluded).toHaveLength(3);
    expect(excluded.every((entry) => entry.type === 'public-key')).toBe(true);
    expect(excluded.every((entry) => entry.id instanceof ArrayBuffer)).toBe(true);
  });

  it('asks for a FRESH user handle on every enrolment, so no create can replace a passkey', async () => {
    /* The re-login defect of 2026/09/03, in one assertion. The handle used to
       be SHA-256 over a constant id, so a create on a browser whose site data
       had been cleared named the pair the surviving credential occupied — and
       `residentKey: 'required'` makes that a REPLACEMENT, not a refusal. The
       replaced credential's PRF secret, and with it the wallet seed and the
       `.night` name it held, were gone. Two enrolments, two handles, and the
       authenticator has nothing to overwrite. */
    const handles: string[] = [];
    replaceNavigator({
      credentials: {
        create: async (options: CredentialCreationOptions) => {
          const publicKey = options.publicKey as unknown as {
            user: { id: ArrayBuffer };
          };
          handles.push(Buffer.from(new Uint8Array(publicKey.user.id)).toString('hex'));
          return {
            rawId: new Uint8Array([9]).buffer,
            getClientExtensionResults: () => ({ prf: { enabled: true } }),
          };
        },
      },
    });

    const options = { label: 'Midnight Passport', userId: 'passport-local-device' };
    await WebAuthnPrfKeyProvider.enrollWithPrf(options);
    // The SAME userId a second time: it is the case the defect was reported in.
    await WebAuthnPrfKeyProvider.enrollWithPrf(options);

    expect(handles).toHaveLength(2);
    expect(handles[0]).not.toBe(handles[1]);
    // 32 bytes of randomness, not a digest of anything a caller passed.
    expect(handles[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sends no exclusion list at all when nothing is known', async () => {
    let capturedOptions: CredentialCreationOptions | undefined;
    replaceNavigator({
      credentials: {
        create: async (options: CredentialCreationOptions) => {
          capturedOptions = options;
          return {
            rawId: new Uint8Array([8]).buffer,
            getClientExtensionResults: () => ({ prf: { enabled: true } }),
          };
        },
      },
    });
    await WebAuthnPrfKeyProvider.enrollWithPrf({ label: 'Midnight Passport', userId: 'local-none' });
    const publicKey = capturedOptions?.publicKey as Record<string, unknown>;
    expect('excludeCredentials' in publicKey).toBe(false);
  });

  it('raises a distinct conflict error when the authenticator reports InvalidStateError', async () => {
    replaceNavigator({
      credentials: {
        create: async () => {
          // Exactly what a browser throws when excludeCredentials matched.
          const error = new Error('The authenticator recognised an excluded credential.');
          error.name = 'InvalidStateError';
          throw error;
        },
      },
    });

    const enrolment = WebAuthnPrfKeyProvider.enrollWithPrf({
      label: 'Midnight Passport',
      userId: 'local-conflict',
      knownCredentialIds: ['AQID'],
    });
    // Catchable as its own type — not a message the caller has to match.
    await expect(enrolment).rejects.toBeInstanceOf(PassportEnrolmentConflictError);
    await expect(enrolment).rejects.toThrow(/already holds a Passport passkey/);
  });

  it('leaves every other enrolment failure as the ordinary flattened error', async () => {
    replaceNavigator({
      credentials: {
        create: async () => {
          const error = new Error('The user cancelled.');
          error.name = 'NotAllowedError';
          throw error;
        },
      },
    });
    const enrolment = WebAuthnPrfKeyProvider.enrollWithPrf({
      label: 'Midnight Passport',
      userId: 'local-cancel',
    });
    await expect(enrolment).rejects.not.toBeInstanceOf(PassportEnrolmentConflictError);
    await expect(enrolment).rejects.toThrow('The user cancelled.');
  });

  it('signs in to a resident credential instead of creating one', async () => {
    let creations = 0;
    let assertions = 0;
    replaceNavigator({
      credentials: {
        create: async () => {
          creations += 1;
          throw new Error('discoverOrEnroll must not create when a passkey already answers');
        },
        get: async () => {
          assertions += 1;
          return {
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(2).buffer } },
            }),
          };
        },
      },
    });

    const outcome = await WebAuthnPrfKeyProvider.discoverOrEnroll({
      label: 'Midnight Passport',
      userId: 'local-discoverable',
      rpId: 'localhost',
    });
    expect(outcome.outcome).toBe('existing');
    expect(outcome.enrolled).toBeNull();
    expect(outcome.discovered?.credentialId).toBe('AQIDBA==');
    // The whole point: the surviving passkey was never at risk of replacement,
    // and the user saw ONE prompt rather than a create followed by a sign-in.
    expect(creations).toBe(0);
    expect(assertions).toBe(1);
    outcome.discovered?.dispose();
  });

  it('enrols only when discovery finds nothing, cancellation included', async () => {
    for (const failure of [
      async () => null,
      async () => {
        const error = new Error('The user cancelled.');
        error.name = 'NotAllowedError';
        throw error;
      },
    ]) {
      let creations = 0;
      let capturedOptions: CredentialCreationOptions | undefined;
      replaceNavigator({
        credentials: {
          get: failure,
          create: async (options: CredentialCreationOptions) => {
            creations += 1;
            capturedOptions = options;
            return {
              rawId: new Uint8Array([3, 3]).buffer,
              getClientExtensionResults: () => ({ prf: { enabled: true } }),
            };
          },
        },
      });

      const outcome = await WebAuthnPrfKeyProvider.discoverOrEnroll({
        label: 'Midnight Passport',
        userId: 'local-empty',
        rpId: 'localhost',
        knownCredentialIds: ['AQID'],
      });
      expect(outcome.outcome).toBe('enrolled');
      expect(outcome.discovered).toBeNull();
      expect(creations).toBe(1);
      // The second line of defence still rides along on the create.
      const publicKey = capturedOptions?.publicKey as Record<string, unknown>;
      expect(publicKey.excludeCredentials).toHaveLength(1);
      outcome.enrolled?.prf?.dispose();
    }
  });

  it('refuses to create over a passkey that answered without a PRF result', async () => {
    // The dangerous case: a resident credential exists and answers, but the
    // authenticator returns no PRF output. Treating that as "nothing there"
    // would create a second credential for the same user handle — and the
    // platform replaces the first, orphaning every secret derived from it.
    let creations = 0;
    replaceNavigator({
      credentials: {
        get: async () => ({
          rawId: new Uint8Array([9, 9]).buffer,
          getClientExtensionResults: () => ({}),
        }),
        create: async () => {
          creations += 1;
          throw new Error('discoverOrEnroll must not create over an answering passkey');
        },
      },
    });

    const outcome = await WebAuthnPrfKeyProvider.discoverOrEnroll({
      label: 'Midnight Passport',
      userId: 'local-answered',
      rpId: 'localhost',
    });
    /* Reported, not thrown: a dead end here strands every user whose
       authenticator answers without PRF, and creating would replace the
       credential. The caller is told, and decides. */
    expect(outcome.outcome).toBe('unusable-credential');
    expect(outcome).toMatchObject({ reason: 'prf-missing' });
    expect(creations).toBe(0);
  });

  it('does not treat an unknown discovery failure as an empty device', async () => {
    let creations = 0;
    replaceNavigator({
      credentials: {
        get: async () => {
          const error = new Error('The operation is insecure.');
          error.name = 'SecurityError';
          throw error;
        },
        create: async () => {
          creations += 1;
          return {
            rawId: new Uint8Array([7, 7]).buffer,
            getClientExtensionResults: () => ({ prf: { enabled: true } }),
          };
        },
      },
    });

    /* An authenticator that failed for a reason of its own has told us
       nothing about what it holds, so enrolment proceeds — guarded, as it
       always was, by the exclusion list, which is what makes the
       authenticator itself refuse to replace a credential we know about. A
       hard failure here was a regression: it stranded onboarding on every
       browser that errors for any reason at all. */
    const outcome = await WebAuthnPrfKeyProvider.discoverOrEnroll({
      label: 'Midnight Passport',
      userId: 'local-unknown',
      rpId: 'localhost',
      knownCredentialIds: ['AQID'],
    });
    expect(outcome.outcome).toBe('enrolled');
    expect(creations).toBe(1);
  });

  it('retries an unexplained failure once before it creates anything', async () => {
    /* A transient error must not be the reason a credential is created: the
       create uses a deterministic user handle, and on a browser whose local
       storage was cleared the exclusion list is empty. So an unexplained
       failure is asked a second time, and a credential that answers on the
       retry is signed into rather than replaced. */
    let gets = 0;
    let creations = 0;
    replaceNavigator({
      credentials: {
        get: async () => {
          gets += 1;
          if (gets === 1) {
            const error = new Error('The operation is insecure.');
            error.name = 'SecurityError';
            throw error;
          }
          return {
            rawId: new Uint8Array([5, 5]).buffer,
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array(32).fill(4).buffer } },
            }),
          };
        },
        create: async () => {
          creations += 1;
          throw new Error('a retry that answers must not lead to a create');
        },
      },
    });

    const outcome = await WebAuthnPrfKeyProvider.discoverOrEnroll({
      label: 'Midnight Passport',
      userId: 'local-transient',
      rpId: 'localhost',
    });
    expect(gets).toBe(2);
    expect(creations).toBe(0);
    expect(outcome.outcome).toBe('existing');
    outcome.discovered?.dispose();
  });

  it('does not retry a cancellation, because that is the user\'s answer', async () => {
    let gets = 0;
    let creations = 0;
    replaceNavigator({
      credentials: {
        get: async () => {
          gets += 1;
          const error = new Error('The user cancelled.');
          error.name = 'NotAllowedError';
          throw error;
        },
        create: async () => {
          creations += 1;
          return {
            rawId: new Uint8Array([6, 6]).buffer,
            getClientExtensionResults: () => ({ prf: { enabled: true } }),
          };
        },
      },
    });

    const outcome = await WebAuthnPrfKeyProvider.discoverOrEnroll({
      label: 'Midnight Passport',
      userId: 'local-cancelled-once',
      rpId: 'localhost',
    });
    expect(gets).toBe(1);
    expect(creations).toBe(1);
    expect(outcome.outcome).toBe('enrolled');
    outcome.enrolled?.prf?.dispose();
  });

  it('reports a dismissed picker as cancelled, with the reason preserved', async () => {
    replaceNavigator({
      credentials: {
        get: async () => {
          const error = new Error('The user cancelled.');
          error.name = 'NotAllowedError';
          throw error;
        },
        create: async () => {
          throw new Error('unreachable');
        },
      },
    });
    await expect(WebAuthnPrfKeyProvider.discover({ rpId: 'localhost' })).rejects.toMatchObject({
      name: 'PassportPasskeyDiscoveryError',
      reason: 'cancelled',
    });
  });
});

/**
 * A targeted assertion names one credential. Nothing in the browser API
 * obliges the caller to check that the credential which answered is that one,
 * and a different credential's PRF output opens a different wallet.
 */
describe('targeted assertions verify the answering credential', () => {
  const mismatched = {
    credentials: {
      get: async () => ({
        // Asked for 'AQIDBA==' ([1,2,3,4]); a different credential answers.
        rawId: new Uint8Array([9, 9, 9, 9]).buffer,
        getClientExtensionResults: () => ({
          prf: { results: { first: new Uint8Array(32).fill(6).buffer } },
        }),
      }),
    },
  };

  it('refuses a mismatched rawId on assertOnce', async () => {
    replaceNavigator(mismatched);
    await expect(
      WebAuthnPrfKeyProvider.assertOnce({
        credentialId: 'AQIDBA==',
        label: 'Midnight Passport',
        rpId: 'localhost',
      }),
    ).rejects.toThrow('A different passkey answered');
  });

  it('refuses a mismatched rawId before the PRF output reaches a derivation', async () => {
    replaceNavigator(mismatched);
    const provider = new WebAuthnPrfKeyProvider({
      credentialId: 'AQIDBA==',
      label: 'Midnight Passport',
    });
    await expect(provider.getKey(scope)).rejects.toThrow('A different passkey answered');
    await expect(provider.deriveWalletSeed(scope)).rejects.toThrow('A different passkey answered');
  });
});
