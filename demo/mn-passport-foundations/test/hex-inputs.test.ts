import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, hexToBytes32 } from '../src/wallet/hex.js';

describe('hex input validation', () => {
  it('rejects invalid digits, partially valid pairs, whitespace, and separators', () => {
    for (const value of ['zz', '1z', 'z1', 'aa bb0', 'aa:bb0', '0xgg', '0\n', '\n\n', '00\n\n']) {
      expect(() => hexToBytes(value)).toThrow('invalid hex encoding');
    }
    expect(() => hexToBytes('abc')).toThrow('odd-length hex');
  });

  it('does not echo malformed input in errors', () => {
    for (const value of ['ab'.repeat(31) + 'zz', 'ab'.repeat(31) + 'a']) {
      let caught: unknown;
      try {
        hexToBytes(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).not.toContain(value);
    }
  });

  it('preserves valid mixed case, prefix, empty input, and byte round trips', () => {
    expect(hexToBytes('0xAa01fF')).toEqual(new Uint8Array([0xaa, 1, 0xff]));
    expect(hexToBytes('')).toEqual(new Uint8Array());
    expect(hexToBytes('0x')).toEqual(new Uint8Array());
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('right-pads short values and preserves exactly 32 bytes', () => {
    const expected = new Uint8Array(32);
    expected[0] = 6;
    expect(hexToBytes32('06')).toEqual(expected);
    expect(hexToBytes32('')).toEqual(new Uint8Array(32));
    expect(hexToBytes32('ab'.repeat(32))).toEqual(new Uint8Array(32).fill(0xab));
  });

  it('rejects extra bytes and validates malformed suffixes beyond byte 32', () => {
    expect(() => hexToBytes32('ab'.repeat(32) + 'cd')).toThrow('longer than 32 bytes');
    expect(() => hexToBytes32('ab'.repeat(32) + 'zz')).toThrow('invalid hex encoding');
  });
});
