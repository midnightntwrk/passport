// Hex helpers — platform-neutral (no node:buffer) so the same code runs in
// Node integration tests and the Vite demo app.

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Left-aligned 32-byte buffer, zero-padded on the right — matches the
// hexToBytes32 recipe the contract-custody-feasibility tests used for
// token colours and user addresses.
export function hexToBytes32(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  const out = new Uint8Array(32);
  out.set(bytes.subarray(0, Math.min(32, bytes.length)));
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function randomBytes32(): Uint8Array {
  const out = new Uint8Array(32);
  globalThis.crypto.getRandomValues(out);
  return out;
}
