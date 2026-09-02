/**
 * base64url, hand-rolled rather than borrowed so the module runs unchanged in
 * a browser, in a receiver's page, and in a bare Node drill. `btoa`/`atob` are
 * the one base64 primitive all three share.
 *
 * The envelope is double-encoded — the payload travels as its own base64url
 * string INSIDE the envelope JSON — and that is not redundancy. The signature
 * covers bytes, so a receiver has to reproduce the signed bytes exactly.
 * Re-serialising a parsed object cannot do that without a canonical JSON form,
 * and canonical JSON is a well-known source of quiet verification failures:
 * key order, number formatting, escaping. Transmitting the bytes as bytes
 * removes the problem entirely — what was signed is what arrives, and the
 * receiver verifies before it parses anything.
 */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  /* Re-padded explicitly: `atob` is forgiving about padding in the browsers
     that matter, but "the browsers that matter" is not a contract. */
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 16 random bytes, base64url. Unguessable, and short enough for a URL. */
export function randomBase64Url(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}
