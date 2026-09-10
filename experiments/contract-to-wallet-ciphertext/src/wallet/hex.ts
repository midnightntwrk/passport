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

/**
 * Bare lower-case hex from whatever representation a value arrives in.
 * Coin fields cross several boundaries here (compact-runtime, the wallet
 * SDK, the ledger) and each hands back a different shape for the same 32
 * bytes: raw bytes, a hex string, an array, or a `{ bytes }` wrapper.
 */
export function anyToHex(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.replace(/^0x/, '').toLowerCase();
  if (v instanceof Uint8Array) return bytesToHex(v);
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return bytesToHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (Array.isArray(v)) return bytesToHex(Uint8Array.from(v as number[]));
  if (typeof v === 'object' && 'bytes' in (v as any)) return anyToHex((v as any).bytes);
  return String(v).replace(/^0x/, '').toLowerCase();
}

/** Describe a value's runtime shape, for evidence when a boundary surprises us. */
export function describeShape(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return `string(${v.length})`;
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (typeof v === 'object') return `object{${Object.keys(v as object).join(',')}}`;
  return typeof v;
}

export function randomBytes32(): Uint8Array {
  const out = new Uint8Array(32);
  globalThis.crypto.getRandomValues(out);
  return out;
}
