import { asArrayBuffer, fromBase64, toBase64, utf8 } from './encoding.js';
import type {
  PassportStateKeyProvider,
  PassportStateScope,
  PassportWalletSeedProvider,
} from './types.js';

const PRF_SALT = utf8('midnight-passport:webauthn-prf:v1');
const KDF_SALT = utf8('midnight-passport:state-encryption:v1');
/**
 * Wallet seed material is derived from the SAME PRF output as the private-state
 * encryption key, but through a different HKDF salt AND a different info
 * prefix. The two secrets are therefore cryptographically separated: recovering
 * one tells an attacker nothing about the other, and neither can be substituted
 * for the other. Never reuse `KDF_SALT` here, and never reuse this salt there.
 */
const WALLET_SEED_KDF_SALT = utf8('midnight-passport:wallet-seed:v1');

export interface PassportPasskeyReference {
  credentialId: string;
  label: string;
  rpId?: string;
}

export interface EnrollPassportPasskeyOptions {
  label: string;
  userId: string;
  rpName?: string;
  rpId?: string;
  existingCredentialId?: string;
}

export interface DiscoverPassportPasskeyOptions {
  /** Relying-party id. Defaults to the current hostname, matching enrolment. */
  rpId?: string;
}

/**
 * What {@link WebAuthnPrfKeyProvider.enrollWithPrf} returns: the enrolled
 * credential, plus — when and only when the platform evaluated the PRF during
 * `credentials.create` — a one-shot handle over that creation-time PRF output.
 *
 * Most platforms return no PRF result at creation (they report only
 * `prf.enabled`), so `prf` is `null` and the caller must run ONE assertion via
 * {@link WebAuthnPrfKeyProvider.assertOnce}. Where it is returned, enrolment
 * alone yields every secret the profile needs and the user sees exactly one
 * prompt. Callers own the handle and MUST `dispose()` it.
 */
export interface EnrolledPassportPasskey {
  reference: PassportPasskeyReference;
  /** Non-null only where the authenticator returned a PRF result at creation. */
  prf: DiscoveredPassportPasskey | null;
}

/**
 * The outcome of one discoverable assertion: which resident credential the
 * user picked, plus one-shot derivations over that assertion's PRF output.
 *
 * The PRF bytes are retained privately until {@link dispose} is called, so a
 * caller can look the credential up first and only then choose the derivation
 * scope — without a second passkey prompt. Callers MUST call `dispose()` when
 * finished; every derivation after that throws.
 */
export interface DiscoveredPassportPasskey {
  /** Base64 of the answering credential's rawId — the same encoding `enroll` returns. */
  credentialId: string;
  /** Same bytes {@link WebAuthnPrfKeyProvider.deriveWalletSeed} would produce for `scope`. */
  deriveWalletSeed(scope: PassportStateScope): Promise<Uint8Array>;
  /** Same key {@link WebAuthnPrfKeyProvider.getKey} would derive for `scope` (uncached). */
  deriveStateKey(scope: PassportStateScope): Promise<CryptoKey>;
  /** Zeroes and releases the retained PRF output. */
  dispose(): void;
}

function getNavigator(): Navigator {
  if (!globalThis.navigator?.credentials) {
    throw new Error('WebAuthn is unavailable in this environment.');
  }
  return globalThis.navigator;
}

function randomChallenge(): Uint8Array {
  const challenge = new Uint8Array(32);
  globalThis.crypto.getRandomValues(challenge);
  return challenge;
}

async function userHandle(userId: string): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.digest(
    'SHA-256',
    asArrayBuffer(utf8(`midnight-passport:user:v1:${userId}`)),
  );
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid domain|relying party|rp id|security/i.test(message)) {
    return 'Passport passkeys require a valid HTTPS origin or localhost relying-party domain.';
  }
  return message;
}

async function deriveKey(prfOutput: Uint8Array, scope: PassportStateScope): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    asArrayBuffer(prfOutput),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const info = utf8(`midnight-passport:scope:v1:${scope.appId}:${scope.accountId}`);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: asArrayBuffer(KDF_SALT), info: asArrayBuffer(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Derives 32 bytes of wallet seed material from the same PRF output.
 *
 * This is the ONLY place in the demo backend that yields raw key bytes. It
 * exists because the Midnight wallet SDK needs a seed it can feed to
 * `HDWallet.fromSeed`, which a non-exportable `CryptoKey` cannot provide. The
 * separation from {@link deriveKey} is the distinct HKDF salt plus the distinct
 * info prefix, so this output is independent of the private-state encryption
 * key derived from the very same assertion.
 */
async function deriveWalletSeedBytes(
  prfOutput: Uint8Array,
  scope: PassportStateScope,
): Promise<Uint8Array> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    asArrayBuffer(prfOutput),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const info = utf8(`midnight-passport:wallet-seed:v1:${scope.appId}:${scope.accountId}`);
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asArrayBuffer(WALLET_SEED_KDF_SALT),
      info: asArrayBuffer(info),
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Wraps ONE ceremony's PRF output in the one-shot derivation handle.
 *
 * Every path that obtains a PRF output — the discoverable assertion, the
 * targeted single assertion, and the creation-time evaluation — funnels
 * through here, so all three derive byte-identical material for a given
 * credential and scope: same {@link deriveKey}, same
 * {@link deriveWalletSeedBytes}, same HKDF salts and info strings.
 */
function oneShotFromPrf(credentialId: string, prfResult: ArrayBuffer): DiscoveredPassportPasskey {
  let output: Uint8Array | null = new Uint8Array(prfResult);
  const take = (): Uint8Array => {
    if (!output) throw new Error('This discovered passkey has already been disposed.');
    return output;
  };
  return {
    credentialId,
    deriveWalletSeed: async (scope) => deriveWalletSeedBytes(take(), scope),
    deriveStateKey: async (scope) => deriveKey(take(), scope),
    dispose: () => {
      output?.fill(0);
      output = null;
    },
  };
}

/** The PRF slice of a client-extension results bag, however it was obtained. */
type PrfExtensionResults = AuthenticationExtensionsClientOutputs & {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
};

/**
 * Browser-only WebAuthn PRF adapter. The PRF output is immediately turned
 * into a non-exportable AES key and is never persisted by this module.
 */
export class WebAuthnPrfKeyProvider implements PassportStateKeyProvider, PassportWalletSeedProvider {
  private readonly sessionKeys = new Map<string, { key: CryptoKey; expiresAt: number }>();

  constructor(
    private readonly reference: PassportPasskeyReference,
    private readonly cacheTtlMs = 30_000,
  ) {}

  /** Clears derived keys after one logical Passport operation. */
  lock(scope?: PassportStateScope): void {
    if (!scope) {
      this.sessionKeys.clear();
      return;
    }
    this.sessionKeys.delete(`${scope.appId}\u0000${scope.accountId}`);
  }

  /**
   * Enrols a credential, returning it alongside the creation-time PRF output
   * where the platform supplied one.
   *
   * `credentials.create` asks for `prf: { eval: { first: PRF_SALT } }` in
   * addition to enabling the extension. Some platforms answer with
   * `results.first` there and then; where they do, the whole profile — private
   * state key AND wallet seed — is derivable from this single ceremony and the
   * user is never prompted again. Where they do not (the common case), `prf`
   * is `null`, WITHOUT any user-visible error: the caller runs exactly one
   * {@link assertOnce}. Enrolment happens once either way.
   */
  static async enrollWithPrf(
    options: EnrollPassportPasskeyOptions,
  ): Promise<EnrolledPassportPasskey> {
    const navigator = getNavigator();
    const hostname = globalThis.location?.hostname;
    const rpId = options.rpId ?? hostname;
    const rp: PublicKeyCredentialRpEntity = {
      name: options.rpName ?? 'Midnight Passport',
      ...(rpId ? { id: rpId } : {}),
    };
    try {
      const credential = (await navigator.credentials.create({
        publicKey: {
          rp,
          user: {
            id: await userHandle(options.userId),
            name: options.label,
            displayName: options.label,
          },
          challenge: asArrayBuffer(randomChallenge()),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          ...(options.existingCredentialId
            ? {
                excludeCredentials: [
                  { type: 'public-key', id: asArrayBuffer(fromBase64(options.existingCredentialId)) },
                ],
              }
            : {}),
          // Enable the extension AND ask for the salt to be evaluated now.
          // Platforms that honour the eval hand back everything this profile
          // needs without a single assertion; the rest just report `enabled`.
          extensions: {
            prf: { eval: { first: asArrayBuffer(PRF_SALT) } },
          } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error('Passport passkey creation was cancelled.');
      const extension = credential.getClientExtensionResults() as PrfExtensionResults;
      const evaluated = extension.prf?.results?.first;
      // A returned result proves the extension is live even on a platform that
      // omits the `enabled` flag when it evaluates eagerly.
      if (!extension.prf?.enabled && !evaluated) {
        throw new Error(
          'This authenticator does not support the WebAuthn PRF extension. Use a recent platform passkey or PRF-capable security key.',
        );
      }
      const credentialId = toBase64(new Uint8Array(credential.rawId));
      return {
        reference: { credentialId, label: options.label, rpId },
        prf: evaluated ? oneShotFromPrf(credentialId, evaluated) : null,
      };
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }

  /**
   * Enrols a credential and discards any creation-time PRF output.
   *
   * Kept for callers that only want the reference. Prefer
   * {@link enrollWithPrf} on the onboarding path: throwing the output away
   * here is what costs the user an extra passkey prompt.
   */
  static async enroll(options: EnrollPassportPasskeyOptions): Promise<PassportPasskeyReference> {
    const enrolled = await WebAuthnPrfKeyProvider.enrollWithPrf(options);
    enrolled.prf?.dispose();
    return enrolled.reference;
  }

  /**
   * Runs exactly ONE targeted assertion against a known credential and hands
   * back a one-shot handle over its PRF output — the counterpart to
   * {@link discover} for the case where the credential is already known.
   *
   * This is what collapses "unlock the private state" and "derive the wallet
   * seed" into a single passkey prompt: the caller decrypts with
   * `deriveStateKey` (which proves the passkey is the right one) and derives
   * the wallet seed with `deriveWalletSeed`, both from the same assertion.
   * Byte-identical to the cached {@link getKey} / uncached
   * {@link deriveWalletSeed} pair — same PRF salt, same HKDF constants.
   *
   * Callers MUST call `dispose()`; the PRF output must never outlive the flow.
   */
  static async assertOnce(
    reference: PassportPasskeyReference,
  ): Promise<DiscoveredPassportPasskey> {
    const navigator = getNavigator();
    try {
      const assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: asArrayBuffer(randomChallenge()),
          allowCredentials: [
            { type: 'public-key', id: asArrayBuffer(fromBase64(reference.credentialId)) },
          ],
          userVerification: 'required',
          extensions: {
            prf: { eval: { first: asArrayBuffer(PRF_SALT) } },
          } as AuthenticationExtensionsClientInputs,
          ...(reference.rpId ? { rpId: reference.rpId } : {}),
        },
      })) as PublicKeyCredential | null;
      if (!assertion) throw new Error('Passport passkey unlock was cancelled.');
      const extension = assertion.getClientExtensionResults() as PrfExtensionResults;
      const result = extension.prf?.results?.first;
      if (!result) throw new Error('The authenticator did not return a PRF result.');
      return oneShotFromPrf(toBase64(new Uint8Array(assertion.rawId)), result);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }

  /**
   * Runs ONE discoverable assertion — no `allowCredentials` at all — so the
   * platform shows its own account picker of resident passkeys for this rpId,
   * and reports which credential answered.
   *
   * The PRF evaluation is byte-for-byte the targeted path's: the same
   * {@link PRF_SALT}, and the same HKDF salts and info strings via
   * {@link deriveKey} and {@link deriveWalletSeedBytes}. A credential
   * therefore derives identical material whichever path asserted it. The
   * targeted {@link getKey} / {@link deriveWalletSeed} path remains the
   * default fast path when the credential is already known.
   */
  static async discover(
    options: DiscoverPassportPasskeyOptions = {},
  ): Promise<DiscoveredPassportPasskey> {
    const navigator = getNavigator();
    const rpId = options.rpId ?? globalThis.location?.hostname;
    try {
      const assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: asArrayBuffer(randomChallenge()),
          // Deliberately NO allowCredentials: an empty allow-list is what
          // makes the authenticator offer every resident credential for this
          // rpId instead of demanding one we name in advance.
          userVerification: 'required',
          extensions: {
            prf: { eval: { first: asArrayBuffer(PRF_SALT) } },
          } as AuthenticationExtensionsClientInputs,
          ...(rpId ? { rpId } : {}),
        },
      })) as PublicKeyCredential | null;
      if (!assertion) throw new Error('Passport passkey selection was cancelled.');
      const extension = assertion.getClientExtensionResults() as PrfExtensionResults;
      const result = extension.prf?.results?.first;
      if (!result) throw new Error('The authenticator did not return a PRF result.');
      return oneShotFromPrf(toBase64(new Uint8Array(assertion.rawId)), result);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }

  /**
   * Runs one WebAuthn assertion and returns the raw PRF output. Callers own the
   * returned bytes and MUST zero them once they have derived from them.
   */
  private async evaluatePrf(): Promise<Uint8Array> {
    const navigator = getNavigator();
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: asArrayBuffer(randomChallenge()),
        allowCredentials: [
          { type: 'public-key', id: asArrayBuffer(fromBase64(this.reference.credentialId)) },
        ],
        userVerification: 'required',
        extensions: {
          prf: { eval: { first: asArrayBuffer(PRF_SALT) } },
        } as AuthenticationExtensionsClientInputs,
        ...(this.reference.rpId ? { rpId: this.reference.rpId } : {}),
      },
    })) as PublicKeyCredential | null;
    if (!assertion) throw new Error('Passport passkey unlock was cancelled.');
    const extension = assertion.getClientExtensionResults() as PrfExtensionResults;
    const result = extension.prf?.results?.first;
    if (!result) throw new Error('The authenticator did not return a PRF result.');
    return new Uint8Array(result);
  }

  async getKey(scope: PassportStateScope): Promise<CryptoKey> {
    const scopeKey = `${scope.appId}\u0000${scope.accountId}`;
    const cached = this.sessionKeys.get(scopeKey);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    if (cached) this.sessionKeys.delete(scopeKey);
    try {
      const output = await this.evaluatePrf();
      try {
        const key = await deriveKey(output, scope);
        this.sessionKeys.set(scopeKey, { key, expiresAt: Date.now() + this.cacheTtlMs });
        return key;
      } finally {
        output.fill(0);
      }
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }

  /**
   * Returns 32 bytes of Midnight wallet seed material for `scope`.
   *
   * Deliberately NOT cached. Unlike the private-state key, these bytes leave
   * this module, so every call costs a fresh user-verified assertion and the
   * caller decides how long to hold them. The seed is domain-separated from the
   * private-state encryption key — see {@link WALLET_SEED_KDF_SALT}.
   */
  async deriveWalletSeed(scope: PassportStateScope): Promise<Uint8Array> {
    try {
      const output = await this.evaluatePrf();
      try {
        return await deriveWalletSeedBytes(output, scope);
      } finally {
        output.fill(0);
      }
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }
}
