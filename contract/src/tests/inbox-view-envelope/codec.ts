// Experimental owner-reader envelope. No Compact changes; NOT a standard.
// One opaque 192-byte inbox slot carries a viewing secret plus the public
// ES256 registration key needed to restore a signing client. Signing itself
// remains inside WebAuthn. PRF outputs/private recipient keys never go on-chain.
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes, validateP256Key, type P256PublicKey } from '../../wallet/webauthn.js';

export const ENVELOPE_SIZE = 192;
export const ENVELOPE_VERSION = 0xe1; // experimental namespace, not allocated by a MIP
export const ENVELOPE_SUITE = 1;
export const LAYOUT = [
  ['version', 0, 1], ['suite', 1, 1], ['recipient tag', 2, 32],
  ['ephemeral X25519 public key', 34, 32], ['AES-GCM nonce', 66, 12],
  ['AES-GCM tag', 78, 16], ['encrypted viewing secret', 94, 32],
  ['encrypted public ES256 x/y coordinates', 126, 64], ['zero padding', 190, 2],
] as const;
export interface Context { network: string; account: Uint8Array; rpId: string; origin: string }
const text = (s: string) => new TextEncoder().encode(s);
export const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const random = (n = 32) => crypto.getRandomValues(new Uint8Array(n));
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
function requireLength(b: Uint8Array, n: number) {
  if (b.length !== n) throw new Error(`expected ${n} bytes, received ${b.length}`);
}
export function contextBytes(c: Context): Uint8Array {
  requireLength(c.account, 32);
  if (!c.network || !c.rpId || new URL(c.origin).origin !== c.origin) throw new Error('invalid envelope context');
  return text(JSON.stringify(['passport:experimental:view-envelope:v1', c.network, hex(c.account), c.rpId, c.origin]));
}
// This is the input supplied to the WebAuthn PRF extension. WebAuthn performs
// its own PRF domain processing; callers pass this input, not a pre-hashed
// emulation of the authenticator's hmac-secret internals.
export const prfInput = (c: Context) => sha256(concat(text('passport:experimental:reader-prf:v1'), contextBytes(c)));
export function readerFromPrf(output: Uint8Array, c: Context) {
  requireLength(output, 32);
  const secretKey = hkdf(sha256, output, sha256(contextBytes(c)), text('passport:experimental:reader-key:v1'), 32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}
export const recipientTag = (publicKey: Uint8Array, c: Context) => {
  requireLength(publicKey, 32);
  return sha256(concat(text('passport:experimental:reader-id:v1'), contextBytes(c), publicKey));
};
export const viewPublicKey = (secret: Uint8Array) => { requireLength(secret, 32); return x25519.getPublicKey(secret); };
const wrapKey = (secret: Uint8Array, publicKey: Uint8Array, c: Context) =>
  hkdf(sha256, x25519.getSharedSecret(secret, publicKey), sha256(contextBytes(c)), text('passport:experimental:view-wrap:v1'), 32);
const aad = (entry: Uint8Array, c: Context) => concat(contextBytes(c), entry.slice(0, 78), entry.slice(190));
const coordinate = (n: bigint) => {
  if (n < 0n || n >= 1n << 256n) throw new Error('invalid coordinate');
  return Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * (31 - i))) & 255n));
};
const integer = (b: Uint8Array) => b.reduce((n, v) => (n << 8n) | BigInt(v), 0n);

export async function sealViewEnvelope(c: Context, readerPublicKey: Uint8Array,
  viewSecret: Uint8Array, signingKey: P256PublicKey): Promise<Uint8Array> {
  requireLength(viewSecret, 32); requireLength(readerPublicKey, 32); validateP256Key(signingKey);
  // Reject noncanonical recipient encodings, rather than accepting aliases.
  const u = [...readerPublicKey].reverse().reduce((n, v) => (n << 8n) | BigInt(v), 0n);
  if (u >= (1n << 255n) - 19n) throw new Error('noncanonical X25519 recipient');
  const ephemeral = random(), entry = new Uint8Array(ENVELOPE_SIZE);
  entry[0] = ENVELOPE_VERSION; entry[1] = ENVELOPE_SUITE;
  entry.set(recipientTag(readerPublicKey, c), 2);
  entry.set(x25519.getPublicKey(ephemeral), 34); entry.set(random(12), 66);
  const keyBytes = wrapKey(ephemeral, readerPublicKey, c); ephemeral.fill(0);
  const key = await crypto.subtle.importKey('raw', new Uint8Array(keyBytes), 'AES-GCM', false, ['encrypt']);
  keyBytes.fill(0);
  const plaintext = concat(viewSecret, coordinate(signingKey.x), coordinate(signingKey.y));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM',
    iv: entry.slice(66, 78), additionalData: new Uint8Array(aad(entry, c)), tagLength: 128 }, key, plaintext));
  plaintext.fill(0);
  entry.set(encrypted.slice(0, 96), 94); entry.set(encrypted.slice(96), 78);
  return entry;
}

export async function openViewEnvelope(c: Context, readerSecret: Uint8Array, entry: Uint8Array,
  currentViewPublicKey: Uint8Array): Promise<{ viewSecret: Uint8Array; signingKey: P256PublicKey } | null> {
  requireLength(readerSecret, 32); requireLength(currentViewPublicKey, 32);
  if (entry.length !== ENVELOPE_SIZE || entry[0] !== ENVELOPE_VERSION || entry[1] !== ENVELOPE_SUITE ||
      entry[190] !== 0 || entry[191] !== 0 ||
      !equalBytes(entry.slice(2, 34), recipientTag(x25519.getPublicKey(readerSecret), c))) return null;
  try {
    const keyBytes = wrapKey(readerSecret, entry.slice(34, 66), c);
    const key = await crypto.subtle.importKey('raw', new Uint8Array(keyBytes), 'AES-GCM', false, ['decrypt']);
    keyBytes.fill(0);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM',
      iv: entry.slice(66, 78), additionalData: new Uint8Array(aad(entry, c)), tagLength: 128 }, key,
    concat(entry.slice(94, 190), entry.slice(78, 94))));
    const viewSecret = plaintext.slice(0, 32);
    const signingKey = { x: integer(plaintext.slice(32, 64)), y: integer(plaintext.slice(64, 96)), identity: false };
    plaintext.fill(0);
    if (!equalBytes(viewPublicKey(viewSecret), currentViewPublicKey)) { viewSecret.fill(0); return null; }
    validateP256Key(signingKey);
    // A fresh assertion under this key must ALSO be verified before using it
    // as the selected credential's registration key. Anyone can encrypt to
    // readerPublicKey; AEAD alone does not authenticate the publisher.
    return { viewSecret, signingKey };
  } catch { return null; }
}

export async function findCurrentEnvelope(c: Context, readerSecret: Uint8Array,
  entries: Iterable<Uint8Array>, currentViewPublicKey: Uint8Array) {
  for (const entry of entries) {
    const result = await openViewEnvelope(c, readerSecret, entry, currentViewPublicKey);
    if (result) return result;
  }
  throw new Error('no current viewing envelope for this reader');
}
