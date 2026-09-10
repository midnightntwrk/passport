// hexToBytes must reject malformed hex rather than miscode it: parseInt
// coerces a non-hex pair to NaN, which a Uint8Array stores as 0, so a typo
// in a pasted secret (guardian σ, grant secret, device secret) used to
// substitute a valid-looking byte instead of erroring.

import { describe, it, expect } from 'vitest';
import { hexToBytes, bytesToHex } from '../src/wallet/hex.js';

describe('hexToBytes strict digit validation', () => {
  it('rejects non-hex characters instead of coercing them to zero', () => {
    expect(() => hexToBytes('zz11')).toThrow(/invalid hex character/);
  });

  it('rejects a single mistyped character anywhere in the string', () => {
    expect(() => hexToBytes('aabbccdg')).toThrow(/invalid hex character/);
    expect(() => hexToBytes('g0aabbcc')).toThrow(/invalid hex character/);
  });

  it('rejects whitespace and separators', () => {
    expect(() => hexToBytes('aa  bb')).toThrow(/invalid hex character/);
    expect(() => hexToBytes('aa:bb1')).toThrow(/invalid hex character/);
  });

  it('still rejects odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd-length hex/);
  });

  it('accepts mixed case, a 0x prefix, and the empty string', () => {
    expect(hexToBytes('AaBbCc')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    expect(hexToBytes('0xff00')).toEqual(new Uint8Array([0xff, 0x00]));
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('round-trips through bytesToHex', () => {
    const bytes = new Uint8Array([0, 1, 0x7f, 0x80, 0xff]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });
});
