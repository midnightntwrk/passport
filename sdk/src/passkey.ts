import { asArrayBuffer, fromBase64, toBase64, utf8 } from './encoding.js';
import type { PassportStateKeyProvider, PassportStateScope } from './types.js';

const PRF_SALT = utf8('midnight-passport:webauthn-prf:v1');
const KDF_SALT = utf8('midnight-passport:state-encryption:v1');

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
 * Browser-only WebAuthn PRF adapter. The PRF output is immediately turned
 * into a non-exportable AES key and is never persisted by this SDK.
 */
export class WebAuthnPrfKeyProvider implements PassportStateKeyProvider {
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

  async getKey(scope: PassportStateScope): Promise<CryptoKey> {
    const scopeKey = `${scope.appId}\u0000${scope.accountId}`;
    const cached = this.sessionKeys.get(scopeKey);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    if (cached) this.sessionKeys.delete(scopeKey);
    const navigator = getNavigator();
    try {
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
      const output = new Uint8Array(result);
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
}
