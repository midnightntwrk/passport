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
  /**
   * What the platform said about `largeBlob` at creation: `true` when the
   * credential can hold a blob, `false` when it said it cannot, `null` when it
   * said nothing at all (an older client that ignores the extension).
   *
   * Enrolment asks with `support: 'preferred'`, which by specification NEVER
   * fails creation, so all three answers are ordinary. Nothing in the demo
   * depends on this being `true`.
   */
  largeBlobSupported: boolean | null;
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
  /**
   * The account metadata the authenticator had stored against this credential
   * under the WebAuthn `largeBlob` extension, or `null`.
   *
   * `null` covers every ordinary case and is NEVER an error: the platform does
   * not implement largeBlob, the credential was enrolled without it, nothing
   * has been written yet, or the stored bytes did not parse. See
   * {@link PassportAccountBlob}. The read costs no extra ceremony — it rides
   * on the same assertion that produced the PRF output.
   */
  accountBlob: PassportAccountBlob | null;
  /** Same bytes {@link WebAuthnPrfKeyProvider.deriveWalletSeed} would produce for `scope`. */
  deriveWalletSeed(scope: PassportStateScope): Promise<Uint8Array>;
  /** Same key {@link WebAuthnPrfKeyProvider.getKey} would derive for `scope` (uncached). */
  deriveStateKey(scope: PassportStateScope): Promise<CryptoKey>;
  /** Zeroes and releases the retained PRF output. */
  dispose(): void;
}

/**
 * ACCOUNT METADATA RECOVERY VIA THE WebAuthn largeBlob EXTENSION
 * -------------------------------------------------------------
 * A passkey can carry a small blob of opaque bytes that travels with it
 * wherever the platform syncs the credential. Passport uses that to answer one
 * question on a device that has never seen this Passport before: WHICH
 * account-custody contract is mine?
 *
 * The blob is metadata, never key material — the same rule the private-state
 * backup keeps. A contract address is public: it is on the ledger, and anyone
 * who has it can read the contract's public state and nothing else. Acting as
 * the Passport still needs the PRF-derived secrets, which are not in here and
 * never will be.
 *
 * What the blob is NOT: proof. A blob says a contract address was written here
 * once. It does not say the contract exists, and a caller that seeds a record
 * from it MUST confirm the address against the chain before telling the user
 * anything was recovered.
 *
 * SIZE. CTAP 2.1 obliges an authenticator to store only about a kilobyte for
 * the whole large-blob array, and the platform compresses each entry, so the
 * budget is small and shared. {@link MAX_ACCOUNT_BLOB_BYTES} caps one entry at
 * 2 KB — Hector's figure, and comfortably above what this payload needs — and
 * {@link encodeAccountBlob} refuses anything larger rather than letting the
 * authenticator fail opaquely.
 *
 * SUPPORT IS PATCHY. Chrome and Safari implement largeBlob for platform
 * authenticators; other combinations do not, and a credential enrolled before
 * this code existed cannot hold a blob at all. Every path here therefore
 * degrades to exactly today's behaviour: reads return `null`, writes report
 * `written: false` with a reason, and nothing throws.
 */
export interface PassportAccountBlob {
  /** Format version. Only `1` is written or read today. */
  v: 1;
  /** The Passport account-custody contract this passkey is bound to. */
  acc: {
    /** Raw 64-hex contract address, as the deployment reported it. */
    address: string;
    /** The network it was deployed on, e.g. `preview`. */
    network: string;
  };
  /** The `.night` name claimed alongside it, when there is one. */
  alias?: string;
}

/**
 * The ceiling one credential's blob may occupy, before the platform's own
 * compression. Two kilobytes, deliberately generous against a payload that
 * runs to a couple of hundred bytes.
 */
export const MAX_ACCOUNT_BLOB_BYTES = 2048;

/** What one write attempt did, and — when it did nothing — why. */
export interface PassportAccountBlobWriteResult {
  /** True ONLY when the authenticator reported `written: true`. */
  written: boolean;
  /**
   * Why not, in words fit for a log line. `null` when {@link written} is true.
   * A write that did not happen is never an error condition here: the Passport
   * works exactly as it did before largeBlob existed.
   */
  reason: string | null;
}

/** Serialises a blob, refusing anything the authenticator would not hold. */
export function encodeAccountBlob(blob: PassportAccountBlob): Uint8Array {
  const bytes = utf8(JSON.stringify(blob));
  if (bytes.byteLength > MAX_ACCOUNT_BLOB_BYTES) {
    throw new Error(
      `A Passport account blob may not exceed ${MAX_ACCOUNT_BLOB_BYTES} bytes; this one is ${bytes.byteLength}.`,
    );
  }
  return bytes;
}

/**
 * Parses bytes an authenticator handed back. Returns `null` for anything that
 * is not a version-1 blob with a real address and network — a blob written by
 * a future Passport, or by something else entirely, must read as "nothing
 * here" rather than as a half-understood record.
 */
export function decodeAccountBlob(bytes: ArrayBuffer | Uint8Array | null | undefined): PassportAccountBlob | null {
  if (!bytes) return null;
  try {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (view.byteLength === 0 || view.byteLength > MAX_ACCOUNT_BLOB_BYTES) return null;
    const parsed = JSON.parse(new TextDecoder().decode(view)) as Partial<PassportAccountBlob>;
    if (!parsed || parsed.v !== 1) return null;
    const account = parsed.acc;
    if (!account || typeof account.address !== 'string' || typeof account.network !== 'string') {
      return null;
    }
    if (!account.address || !account.network) return null;
    return {
      v: 1,
      acc: { address: account.address, network: account.network },
      ...(typeof parsed.alias === 'string' && parsed.alias ? { alias: parsed.alias } : {}),
    };
  } catch {
    return null;
  }
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
function oneShotFromPrf(
  credentialId: string,
  prfResult: ArrayBuffer,
  accountBlob: PassportAccountBlob | null = null,
): DiscoveredPassportPasskey {
  let output: Uint8Array | null = new Uint8Array(prfResult);
  const take = (): Uint8Array => {
    if (!output) throw new Error('This discovered passkey has already been disposed.');
    return output;
  };
  return {
    credentialId,
    accountBlob,
    deriveWalletSeed: async (scope) => deriveWalletSeedBytes(take(), scope),
    deriveStateKey: async (scope) => deriveKey(take(), scope),
    dispose: () => {
      output?.fill(0);
      output = null;
    },
  };
}

/**
 * The PRF and largeBlob slices of a client-extension results bag, however it
 * was obtained. Every field is optional because every one of them is absent on
 * some real platform, and absence is never an error.
 */
type PrfExtensionResults = AuthenticationExtensionsClientOutputs & {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
  largeBlob?: { supported?: boolean; blob?: ArrayBuffer; written?: boolean };
};

/**
 * The extension bag every read-side ceremony sends: evaluate the PRF, and — in
 * the SAME assertion, so it costs no extra prompt — hand back the stored
 * account blob if this credential has one.
 *
 * A write cannot ride along: the specification forbids `read` and `write` in
 * one assertion, which is why {@link WebAuthnPrfKeyProvider.writeAccountBlob}
 * is a ceremony of its own.
 */
function readExtensions(): AuthenticationExtensionsClientInputs {
  return {
    prf: { eval: { first: asArrayBuffer(PRF_SALT) } },
    largeBlob: { read: true },
  } as AuthenticationExtensionsClientInputs;
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
          //
          // `largeBlob: { support: 'preferred' }` asks for a credential with
          // room for a blob. 'preferred' is the only value
          // that may be used here: 'required' makes creation FAIL on every
          // platform without largeBlob, which is most of them, and a passkey
          // that cannot be created is a far worse outcome than a passkey that
          // cannot carry metadata. Nothing downstream depends on the answer.
          extensions: {
            prf: { eval: { first: asArrayBuffer(PRF_SALT) } },
            largeBlob: { support: 'preferred' },
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
        largeBlobSupported:
          typeof extension.largeBlob?.supported === 'boolean'
            ? extension.largeBlob.supported
            : null,
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
          extensions: readExtensions(),
          ...(reference.rpId ? { rpId: reference.rpId } : {}),
        },
      })) as PublicKeyCredential | null;
      if (!assertion) throw new Error('Passport passkey unlock was cancelled.');
      const extension = assertion.getClientExtensionResults() as PrfExtensionResults;
      const result = extension.prf?.results?.first;
      if (!result) throw new Error('The authenticator did not return a PRF result.');
      return oneShotFromPrf(
        toBase64(new Uint8Array(assertion.rawId)),
        result,
        decodeAccountBlob(extension.largeBlob?.blob),
      );
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
          extensions: readExtensions(),
          ...(rpId ? { rpId } : {}),
        },
      })) as PublicKeyCredential | null;
      if (!assertion) throw new Error('Passport passkey selection was cancelled.');
      const extension = assertion.getClientExtensionResults() as PrfExtensionResults;
      const result = extension.prf?.results?.first;
      if (!result) throw new Error('The authenticator did not return a PRF result.');
      return oneShotFromPrf(
        toBase64(new Uint8Array(assertion.rawId)),
        result,
        decodeAccountBlob(extension.largeBlob?.blob),
      );
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }

  /**
   * Writes the account blob onto a credential — ONE targeted assertion, and a
   * best effort that NEVER throws.
   *
   * WHY A SEPARATE CEREMONY. The specification forbids `largeBlob.read` and
   * `largeBlob.write` in the same assertion, and a write is only possible
   * during `credentials.get` — never during `credentials.create`. So the blob
   * cannot be written as part of the enrolment or the sign-in that reads it;
   * it costs its own user-verified assertion. Callers should run it inside the
   * user gesture that already earned a prompt (immediately after a successful
   * claim), so the user experiences one continuous action rather than a prompt
   * out of nowhere.
   *
   * WHY IT NEVER THROWS. Everything this write buys is a nicety on a future
   * device. Nothing that has already happened — the deployed contract, the
   * registered name — depends on it, so a platform without largeBlob, a
   * cancelled prompt, and a refused write all resolve with `written: false`
   * and the reason, for the caller to log. Making this path throw would invite
   * a caller to surface a failure the user cannot act on and need not care
   * about.
   *
   * WHAT GOES IN. Public metadata only: a contract address, its network, and
   * the name. Never key material — see {@link PassportAccountBlob}.
   */
  static async writeAccountBlob(
    reference: PassportPasskeyReference,
    blob: PassportAccountBlob,
  ): Promise<PassportAccountBlobWriteResult> {
    let payload: Uint8Array;
    try {
      payload = encodeAccountBlob(blob);
    } catch (error) {
      return { written: false, reason: errorMessage(error) };
    }
    try {
      const navigator = getNavigator();
      const assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: asArrayBuffer(randomChallenge()),
          allowCredentials: [
            { type: 'public-key', id: asArrayBuffer(fromBase64(reference.credentialId)) },
          ],
          userVerification: 'required',
          // Write only. No `prf` eval here: this ceremony derives nothing, so
          // asking for PRF output would put a secret on the wire for no reason.
          extensions: {
            largeBlob: { write: asArrayBuffer(payload) },
          } as AuthenticationExtensionsClientInputs,
          ...(reference.rpId ? { rpId: reference.rpId } : {}),
        },
      })) as PublicKeyCredential | null;
      if (!assertion) return { written: false, reason: 'The user cancelled the write.' };
      const extension = assertion.getClientExtensionResults() as PrfExtensionResults;
      if (extension.largeBlob?.written === true) return { written: true, reason: null };
      return {
        written: false,
        reason:
          extension.largeBlob === undefined
            ? 'This platform does not implement the WebAuthn largeBlob extension.'
            : 'The authenticator refused to store the blob on this credential.',
      };
    } catch (error) {
      return { written: false, reason: errorMessage(error) };
    }
  }

  /**
   * Reads the account blob on its own — ONE targeted assertion, and never
   * throws.
   *
   * The sign-in paths do NOT need this: {@link assertOnce} and
   * {@link discover} already carry `accountBlob` from the assertion they were
   * going to run anyway. This exists for the case where a caller holds a
   * credential reference and wants the metadata without deriving anything.
   */
  static async readAccountBlob(
    reference: PassportPasskeyReference,
  ): Promise<PassportAccountBlob | null> {
    try {
      const navigator = getNavigator();
      const assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: asArrayBuffer(randomChallenge()),
          allowCredentials: [
            { type: 'public-key', id: asArrayBuffer(fromBase64(reference.credentialId)) },
          ],
          userVerification: 'required',
          extensions: { largeBlob: { read: true } } as AuthenticationExtensionsClientInputs,
          ...(reference.rpId ? { rpId: reference.rpId } : {}),
        },
      })) as PublicKeyCredential | null;
      if (!assertion) return null;
      const extension = assertion.getClientExtensionResults() as PrfExtensionResults;
      return decodeAccountBlob(extension.largeBlob?.blob);
    } catch {
      // A credential without largeBlob, a cancelled prompt, and an unavailable
      // authenticator are all "no metadata here" — the caller's fallback is
      // exactly the behaviour that existed before this extension.
      return null;
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
