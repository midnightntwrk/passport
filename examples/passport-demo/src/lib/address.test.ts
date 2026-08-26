/**
 * Drill for the address display helper.
 *
 * One function, one rule worth holding it to: a value too short to elide is
 * returned untouched rather than padded, so a malformed address stays visibly
 * malformed instead of being disguised as a well-formed one.
 */

import { describe, expect, it } from 'vitest';

import { compactAddress } from './address.js';

const ACCOUNT = '7c2f4a19e6d0b83c5194fe2a77bb0c61d8a3e94f20cb5d7e8f16a0b3c4d5e6f7';
const STAGENET_WALLET =
  'mn_addr_stagenet127xnp9uuxwhh7a8an77mxv02ypt6u09xkk63c9zvdkjsrj4mj68qg7c5ad';

describe('compactAddress', () => {
  it('elides the middle of a contract address and of a bech32m address', () => {
    expect(compactAddress(ACCOUNT)).toBe('7c2f4a19e...4d5e6f7');
    expect(compactAddress(STAGENET_WALLET)).toBe('mn_addr_s...qg7c5ad');
  });

  it('leaves a value shorter than the two windows exactly as it found it', () => {
    expect(compactAddress('abc')).toBe('abc');
    expect(compactAddress('')).toBe('');
    // 17 characters: still short. 18 is the first that elides.
    expect(compactAddress('a'.repeat(17))).toBe('a'.repeat(17));
    expect(compactAddress('a'.repeat(18))).toBe('aaaaaaaaa...aaaaaaa');
  });
});
