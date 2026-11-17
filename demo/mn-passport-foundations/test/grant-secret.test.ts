import { describe, expect, it } from 'vitest';
import { parseGrantSecret } from '../src/wallet/grant-secret.js';

// GrantsPanel uses this parser before ctx.reconnect, so malformed pasted
// credentials fail through ActionButton's existing error display.
describe('pasted grant secret', () => {
  it('rejects full-length credentials containing invalid or partially valid pairs', () => {
    for (const pair of ['zz', '1z', 'z1']) {
      expect(() => parseGrantSecret('ab'.repeat(15) + pair + 'cd'.repeat(16)))
        .toThrow('invalid hex encoding');
    }
  });

  it('rejects empty, short, oversized, and odd-length credentials', () => {
    for (const length of [0, 1, 31, 33]) {
      expect(() => parseGrantSecret('ab'.repeat(length))).toThrow('grant secret must be exactly 32 bytes');
    }
    expect(() => parseGrantSecret('ab'.repeat(32) + 'a')).toThrow('odd-length hex');
    expect(() => parseGrantSecret('   ')).toThrow('grant secret must be exactly 32 bytes');
  });

  it('accepts exactly 32 bytes, optional prefix, mixed case, and surrounding whitespace', () => {
    const expected = new Uint8Array(32).fill(0xab);
    expect(parseGrantSecret('ab'.repeat(32))).toEqual(expected);
    expect(parseGrantSecret(` \n0x${'aB'.repeat(32)}\t `)).toEqual(expected);
    expect(parseGrantSecret('00'.repeat(32))).toEqual(new Uint8Array(32));
  });
});
