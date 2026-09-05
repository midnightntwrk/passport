/**
 * A passkey for the engines that have no virtual authenticator.
 *
 * WHY THIS EXISTS. `passkey.ts` drives WebAuthn through the Chrome DevTools
 * Protocol's `WebAuthn` domain, and that domain is Chromium's alone. WebKit
 * and Firefox expose nothing equivalent to Playwright, so on those engines a
 * ceremony either waits for a human or fails — and a Passport with no passkey
 * has no wallet and nothing to test. Which would leave the whole cross-browser
 * question unaskable, when the thing actually worth asking is not "does
 * Chromium's authenticator work" (it does, and `passkey.ts` still proves it)
 * but "does the REST of Passport work in Safari's engine".
 *
 * So this replaces the two functions the app calls, and only those, with a
 * stand-in that answers them faithfully. Everything downstream — the PRF
 * derivation, the HKDF, the wallet seed, the private-state key, the account
 * contract, the whole app — is the shipped code running against real answers.
 *
 * WHAT "FAITHFULLY" MEANS HERE, and where the line is. The app never touches
 * `credential.response`: it reads `rawId` and `getClientExtensionResults()`
 * and nothing else (`demo-backend/src/passkey.ts`). Nothing verifies an
 * attestation statement or an assertion signature — there is no relying-party
 * server in Passport to verify one against; the passkey's value is its PRF
 * output, not its signature. So the response is present and well-shaped but
 * its bytes are not a real signature, and that is a deliberate boundary rather
 * than an omission. What IS modelled exactly:
 *
 *   PRF          HMAC-SHA-256 over the requested salt under a per-credential
 *                key. Deterministic for the life of the credential, which is
 *                what makes a returning Passport derive the same wallet seed,
 *                and independent between credentials, which is what makes the
 *                targeted-assertion check in `assertAnsweredAsRequested` mean
 *                something.
 *   largeBlob    The specification's three-way answer, because the app reads
 *                the difference: the whole output slice ABSENT is "this
 *                platform has no largeBlob", a present slice with no blob is
 *                "supported, nothing stored", and `written: true` is a write
 *                that took. `accountBlobReadSupport` and
 *                `accountBlobWriteOutcome` decide on exactly that distinction.
 *                Read and write are exclusive, as the specification requires.
 *   residency    Credentials are discoverable. A `get` with no
 *                `allowCredentials` is answered from the store by rpId, which
 *                is the ceremony that finds a Passport on a browser that has
 *                forgotten it.
 *   exclusion    A `create` whose `excludeCredentials` names a credential the
 *                store already holds raises `InvalidStateError`, which is the
 *                only signal WebAuthn gives and the one `isExclusionConflict`
 *                reads.
 *   refusal      An empty picker and a named credential that is not there both
 *                raise `NotAllowedError`, which is what a browser does.
 *
 * WHERE THE CREDENTIALS LIVE. In Node, per browser context, reached from the
 * page through one exposed binding — NOT in `localStorage`. That is the whole
 * point: a passkey is in the platform's keychain, and Passport's returning-user
 * story is precisely that the passkey outlives the site data. A store inside
 * the page would be cleared by the very thing those journeys simulate.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { BrowserContext } from '@playwright/test';

/** How the stand-in authenticator is built. Defaults model a desktop platform. */
export interface WebAuthnStubOptions {
  /** Whether the authenticator implements largeBlob at all. Default `true`. */
  largeBlob?: boolean;
  /** Whether it implements PRF — the extension every Passport key derives from. */
  prf?: boolean;
  /**
   * Whether it evaluates a `create`-time `prf.eval` and answers with the
   * result there and then.
   *
   * DEFAULTS TO TRUE, because Chromium's virtual authenticator does — measured
   * on 2026/09/05, which answered
   * `{largeBlob:{supported:true},prf:{enabled:true,results:{first:<32 bytes>}}}`
   * to a `create`. That is not a detail: a platform that evaluates eagerly
   * derives the whole profile from the creating gesture and NEVER raises a
   * second prompt, and a platform that does not costs one more ceremony. Specs
   * count ceremonies — `onboarding.spec.ts` asserts "one prompt for the claim,
   * one for the retry" on the nose — so a stand-in that differed here would
   * make those specs mean something different on every engine but Chromium,
   * and the difference would read as a Firefox bug rather than as the harness.
   *
   * Pass `false` to model the platforms that evaluate nothing at creation —
   * Safari among them, which is why `App.tsx` puts a button between enrolment
   * and the assertion rather than firing it on a spent gesture.
   */
  prfAtCreate?: boolean;
}

/** One credential as the stand-in authenticator holds it. */
interface StoredCredential {
  /** base64url, the form `rawId` decodes to and `toBase64` re-encodes. */
  id: string;
  rpId: string;
  /** base64url of the HMAC key this credential's PRF outputs come from. */
  prfKey: string;
  /** base64url of the stored largeBlob, or `null` for a credential with none. */
  blob: string | null;
}

/** What the page asks the store to do. Mirrors the two ceremonies. */
type StubRequest =
  | {
      op: 'create';
      rpId: string;
      excludeIds: string[];
    }
  | {
      op: 'get';
      rpId: string;
      /** `null` for a discoverable assertion — no credential was named. */
      allowIds: string[] | null;
      /** base64url of a blob to write, or `null`. */
      write: string | null;
    };

type StubResponse =
  | { ok: true; id: string; prfKey: string; blob: string | null; written: boolean }
  | { ok: false; error: 'InvalidStateError' | 'NotAllowedError'; message: string };

/**
 * The handle a spec holds. Deliberately the same shape as
 * `VirtualAuthenticator` in `passkey.ts`, so `installPasskeyAuthenticator` can
 * return either without a caller knowing which engine it is on.
 */
export interface WebAuthnStubHandle {
  /** Forgets every credential — the browser equivalent of losing the device. */
  remove(): Promise<void>;
}

/** The binding the page calls. Named for what it is, and unlikely to collide. */
const BINDING = '__passportStubAuthenticator';

const b64url = (bytes: Buffer): string => bytes.toString('base64url');

/**
 * Installs the stand-in on every page of `context`, present and future.
 *
 * Must be called before the page navigates: `addInitScript` only reaches
 * documents created after it is registered, and a Passport that loaded first
 * would hold the real, unanswerable `navigator.credentials`.
 */
export async function installWebAuthnStub(
  context: BrowserContext,
  options: WebAuthnStubOptions = {},
): Promise<WebAuthnStubHandle> {
  const hasLargeBlob = options.largeBlob !== false;
  const hasPrf = options.prf !== false;
  const prfAtCreate = options.prfAtCreate !== false;

  /** The keychain. One per browser context, exactly like a real one. */
  const store = new Map<string, StoredCredential>();

  await context.exposeBinding(
    BINDING,
    (_source, request: StubRequest): StubResponse => {
      if (request.op === 'create') {
        for (const excluded of request.excludeIds) {
          const held = store.get(excluded);
          if (held && held.rpId === request.rpId) {
            return {
              ok: false,
              error: 'InvalidStateError',
              message: 'The authenticator already holds a credential named in excludeCredentials.',
            };
          }
        }
        /* A credential id that is a hash of fresh randomness: 32 bytes, the
           length a platform authenticator's ids really are, and distinct per
           credential so the targeted-assertion check has something to fail on. */
        const id = b64url(createHash('sha256').update(randomBytes(32)).digest());
        const credential: StoredCredential = {
          id,
          rpId: request.rpId,
          prfKey: b64url(randomBytes(32)),
          blob: null,
        };
        store.set(id, credential);
        return { ok: true, id, prfKey: credential.prfKey, blob: null, written: false };
      }

      /* A named credential must be one this authenticator holds; an assertion
         that names none is answered from residency, newest first — which is
         what a platform picker with one Passport on it does. */
      const candidates = [...store.values()].filter((held) => held.rpId === request.rpId);
      const found =
        request.allowIds === null
          ? candidates[candidates.length - 1]
          : candidates.find((held) => request.allowIds?.includes(held.id));
      if (!found) {
        return {
          ok: false,
          error: 'NotAllowedError',
          message:
            request.allowIds === null
              ? 'No passkey for this site was offered.'
              : 'The authenticator does not hold the requested credential.',
        };
      }
      if (request.write !== null && hasLargeBlob) {
        found.blob = request.write;
        return { ok: true, id: found.id, prfKey: found.prfKey, blob: null, written: true };
      }
      return { ok: true, id: found.id, prfKey: found.prfKey, blob: found.blob, written: false };
    },
  );

  await context.addInitScript(
    ({
      binding,
      largeBlob: supportsLargeBlob,
      prf: supportsPrf,
      prfAtCreate: eagerPrf,
    }: {
      binding: string;
      largeBlob: boolean;
      prf: boolean;
      prfAtCreate: boolean;
    }) => {
      type Ask = (request: unknown) => Promise<{
        ok: boolean;
        error?: string;
        message?: string;
        id?: string;
        prfKey?: string;
        blob?: string | null;
        written?: boolean;
      }>;
      const ask = (globalThis as unknown as Record<string, Ask>)[binding];
      if (typeof ask !== 'function') return;

      const toBytes = (value: BufferSource): Uint8Array =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(
          (value as ArrayBufferView).buffer,
          (value as ArrayBufferView).byteOffset,
          (value as ArrayBufferView).byteLength,
        );
      const encode = (bytes: Uint8Array): string => {
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      };
      const decode = (text: string): Uint8Array => {
        const padded = text.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
      };
      /** A fresh ArrayBuffer, never a view onto a longer one. */
      const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

      const fail = (name: string, message: string): DOMException => {
        try {
          return new DOMException(message, name);
        } catch {
          const error = new Error(message);
          error.name = name;
          return error as unknown as DOMException;
        }
      };

      /**
       * The PRF output: HMAC-SHA-256 over the salt under this credential's own
       * key. 32 bytes, the length a real PRF result is, and the same bytes
       * every time for the same credential and salt — which is what lets a
       * browser that has forgotten its Passport derive the same wallet back.
       */
      const evaluate = async (prfKey: string, salt: BufferSource): Promise<ArrayBuffer> => {
        const key = await crypto.subtle.importKey(
          'raw',
          buffer(decode(prfKey)),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        return crypto.subtle.sign('HMAC', key, buffer(toBytes(salt)));
      };

      interface PrfInput {
        eval?: { first?: BufferSource; second?: BufferSource };
      }
      interface LargeBlobInput {
        support?: string;
        read?: boolean;
        write?: BufferSource;
      }

      /**
       * The extension results bag, built the way the specification says a
       * client builds it — which is the part the app actually reads.
       */
      const results = async (
        prfInput: PrfInput | undefined,
        blobInput: LargeBlobInput | undefined,
        prfKey: string,
        blob: string | null,
        written: boolean,
        creating: boolean,
      ): Promise<AuthenticationExtensionsClientOutputs> => {
        const bag: AuthenticationExtensionsClientOutputs & Record<string, unknown> = {};
        if (prfInput && supportsPrf) {
          const salt = prfInput.eval?.first;
          /* On creation the extension reports that it is LIVE; whether it also
             evaluates the salt there and then is a platform choice, and the
             app handles both (`enrollWithPrf` runs one assertion when it must). */
          if (creating) {
            bag.prf = {
              enabled: true,
              ...(eagerPrf && salt ? { results: { first: await evaluate(prfKey, salt) } } : {}),
            };
          } else if (salt) {
            bag.prf = { results: { first: await evaluate(prfKey, salt) } };
          }
        }
        if (blobInput && supportsLargeBlob) {
          if (creating) bag.largeBlob = { supported: true };
          else if (blobInput.write !== undefined) bag.largeBlob = { written };
          /* Supported but empty is a PRESENT slice with no blob in it — the
             difference between "cannot hold one" and "has not got one". */
          else if (blobInput.read) bag.largeBlob = blob === null ? {} : { blob: buffer(decode(blob)) };
        }
        /* A platform with no largeBlob omits the slice ENTIRELY rather than
           answering `supported: false` on an assertion, which is the signal
           `accountBlobWriteOutcome` reads as `unsupported`. On CREATION it does
           answer, because `create` is where the app learns the capability. */
        if (creating && blobInput && !supportsLargeBlob) bag.largeBlob = { supported: false };
        return bag;
      };

      /**
       * A credential object shaped like the real one. `rawId`, `id`, `type`,
       * `authenticatorAttachment`, and `getClientExtensionResults` are what the
       * app reads; `response` is present and well-formed but its bytes are not
       * a real signature — nothing here verifies one. See the file header.
       */
      const credential = (
        id: string,
        extensions: AuthenticationExtensionsClientOutputs,
        response: Record<string, unknown>,
      ): PublicKeyCredential => {
        const raw = decode(id);
        const base: Record<string, unknown> = {
          id,
          rawId: buffer(raw),
          type: 'public-key',
          authenticatorAttachment: 'platform',
          response,
          getClientExtensionResults: () => extensions,
          toJSON: () => ({ id, type: 'public-key' }),
        };
        try {
          /* `instanceof PublicKeyCredential` then holds. The own properties
             above shadow the real accessors, which would throw on this object. */
          return Object.assign(Object.create(PublicKeyCredential.prototype), base) as PublicKeyCredential;
        } catch {
          return base as unknown as PublicKeyCredential;
        }
      };

      /** Client data as the browser would serialise it, for shape's sake. */
      const clientData = (type: string, challenge: BufferSource): ArrayBuffer =>
        new TextEncoder().encode(
          JSON.stringify({
            type,
            challenge: encode(toBytes(challenge)),
            origin: location.origin,
            crossOrigin: false,
          }),
        ).slice().buffer;

      if (!navigator.credentials) {
        Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
      }

      navigator.credentials.create = async (
        request?: CredentialCreationOptions,
      ): Promise<Credential | null> => {
        const publicKey = request?.publicKey;
        if (!publicKey) throw fail('NotSupportedError', 'Only publicKey creation is stubbed.');
        const rpId = publicKey.rp?.id ?? location.hostname;
        const answer = await ask({
          op: 'create',
          rpId,
          excludeIds: (publicKey.excludeCredentials ?? []).map((entry) =>
            encode(toBytes(entry.id)),
          ),
        });
        if (!answer.ok) throw fail(answer.error ?? 'NotAllowedError', answer.message ?? '');
        const extensions = publicKey.extensions as
          | { prf?: PrfInput; largeBlob?: LargeBlobInput }
          | undefined;
        return credential(
          answer.id as string,
          await results(
            extensions?.prf,
            extensions?.largeBlob,
            answer.prfKey as string,
            null,
            false,
            true,
          ),
          {
            clientDataJSON: clientData('webauthn.create', publicKey.challenge),
            attestationObject: new ArrayBuffer(0),
            getTransports: () => ['internal'],
            getAuthenticatorData: () => new ArrayBuffer(37),
            getPublicKey: () => null,
            getPublicKeyAlgorithm: () => -7,
          },
        );
      };

      navigator.credentials.get = async (
        request?: CredentialRequestOptions,
      ): Promise<Credential | null> => {
        const publicKey = request?.publicKey;
        if (!publicKey) throw fail('NotSupportedError', 'Only publicKey assertions are stubbed.');
        const rpId = publicKey.rpId ?? location.hostname;
        const allow = publicKey.allowCredentials;
        const extensions = publicKey.extensions as
          | { prf?: PrfInput; largeBlob?: LargeBlobInput }
          | undefined;
        const write = extensions?.largeBlob?.write;
        const answer = await ask({
          op: 'get',
          rpId,
          allowIds: allow && allow.length > 0 ? allow.map((entry) => encode(toBytes(entry.id))) : null,
          write: write ? encode(toBytes(write)) : null,
        });
        if (!answer.ok) throw fail(answer.error ?? 'NotAllowedError', answer.message ?? '');
        return credential(
          answer.id as string,
          await results(
            extensions?.prf,
            extensions?.largeBlob,
            answer.prfKey as string,
            answer.blob ?? null,
            answer.written === true,
            false,
          ),
          {
            clientDataJSON: clientData('webauthn.get', publicKey.challenge),
            authenticatorData: new ArrayBuffer(37),
            signature: new ArrayBuffer(64),
            userHandle: buffer(decode(answer.id as string)),
          },
        );
      };

      /* Both of these are `true` on a platform with a passkey in it, and both
         are read by the surfaces that decide whether to offer one at all. */
      if (typeof PublicKeyCredential === 'function') {
        PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () =>
          Promise.resolve(true);
        PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(true);
      }
    },
    { binding: BINDING, largeBlob: hasLargeBlob, prf: hasPrf, prfAtCreate },
  );

  return {
    remove(): Promise<void> {
      store.clear();
      return Promise.resolve();
    },
  };
}
