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

  static async enroll(options: EnrollPassportPasskeyOptions): Promise<PassportPasskeyReference> {
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
          extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error('Passport passkey creation was cancelled.');
      const extension = credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
        prf?: { enabled?: boolean };
      };
      if (!extension.prf?.enabled) {
        throw new Error(
          'This authenticator does not support the WebAuthn PRF extension. Use a recent platform passkey or PRF-capable security key.',
        );
      }
      return { credentialId: toBase64(new Uint8Array(credential.rawId)), label: options.label, rpId };
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
    const extension = assertion.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
      prf?: { results?: { first?: ArrayBuffer } };
    };
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
