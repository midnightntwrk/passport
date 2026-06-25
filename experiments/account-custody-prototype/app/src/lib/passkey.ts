// Passkey (WebAuthn) device-secret derivation via the PRF extension.
//
// The device secret is the PRF output for a fixed, domain-separated salt —
// it never exists outside this browsing context, is re-derivable on every
// future assertion from the same authenticator, and is hardware-bound to
// the extent the authenticator is (C9 territory).
//
// Flow notes:
//   - PRF results are only guaranteed during get() (assertion), not during
//     create(), so onboarding performs create() followed by one get().
//   - Browsers require a user gesture and a secure context (localhost is
//     fine for the demo).

const PRF_SALT = new TextEncoder().encode('midnight:passport:prf:device:v0');

const RP_NAME = 'NightFi Demo';

export interface PasskeyRef {
  credentialIdB64: string;
  label: string;
}

function b64encode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bytes = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return out;
}

export async function createPasskey(label: string): Promise<PasskeyRef> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: RP_NAME, id: window.location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: label,
        displayName: label,
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      extensions: { prf: {} } as any,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('passkey creation was cancelled');

  const ext: any = cred.getClientExtensionResults();
  if (!ext?.prf?.enabled) {
    throw new Error(
      'This authenticator does not support the WebAuthn PRF extension. ' +
        'Use a platform passkey (Touch ID / Windows Hello / recent Android) or a PRF-capable security key.',
    );
  }
  return { credentialIdB64: b64encode(cred.rawId), label };
}

/**
 * Evaluate the PRF for our fixed salt — returns the 32-byte device secret.
 * When `ref` is omitted the browser offers any resident passkey for this
 * origin (used by "connect existing account" and recovery flows).
 */
export async function deriveDeviceSecret(ref?: PasskeyRef): Promise<Uint8Array> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: ref
        ? [{ type: 'public-key', id: b64decode(ref.credentialIdB64) }]
        : [],
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } } as any,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('passkey assertion was cancelled');

  const result: ArrayBuffer | undefined = (assertion.getClientExtensionResults() as any)?.prf
    ?.results?.first;
  if (!result) {
    throw new Error('Authenticator did not return a PRF result for the assertion.');
  }
  const secret = new Uint8Array(result);
  if (secret.length !== 32) throw new Error(`unexpected PRF output length ${secret.length}`);
  return secret;
}

/**
 * Dev-mode fallback for environments without WebAuthn PRF: derive the
 * device secret from a passphrase via SHA-256. Demo convenience only.
 */
export async function deriveDevModeSecret(passphrase: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`midnight:passport:devmode:v0:${passphrase}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}
