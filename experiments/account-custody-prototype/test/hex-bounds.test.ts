// hexToBytes32 must be fail-closed on oversized input: silently dropping
// everything past 32 bytes has no defence if a caller's length assumption
// changes later (for example an SDK output growing a prefix). Zero-padding
// short values stays — that is the helper's documented contract, used for
// token colours like '01'.

import { describe, it, expect } from 'vitest';
import { hexToBytes32 } from '../src/wallet/hex.js';

describe('hexToBytes32 length bounds', () => {
  it('rejects input longer than 32 bytes instead of truncating', () => {
    expect(() => hexToBytes32('ab'.repeat(33))).toThrow(/longer than 32 bytes/);
  });

  it('rejects a 33-byte value that shares a 32-byte prefix with a valid one', () => {
    const valid = 'cd'.repeat(32);
    expect(hexToBytes32(valid)).toHaveLength(32);
    expect(() => hexToBytes32(valid + 'ee')).toThrow(/longer than 32 bytes/);
  });

  it('still zero-pads short values on the right', () => {
    const out = hexToBytes32('01');
    expect(out).toHaveLength(32);
    expect(out[0]).toBe(1);
    expect(out.slice(1).every((b) => b === 0)).toBe(true);
  });

  it('accepts exactly 32 bytes unchanged', () => {
    const out = hexToBytes32('ff'.repeat(32));
    expect(out.every((b) => b === 0xff)).toBe(true);
  });
});
