/**
 * The hex guard `contractRuntime` and the step verifier both depend on.
 *
 * There are two copies of `hexToBytes` — this module's and the step
 * verifier's in `src/verify/indexer.ts` — and they are deliberately NOT
 * merged: `verify/` stays free of the identity graph, so a reviewer can run
 * the verifier without pulling the wallet in behind it. They are otherwise
 * identical, so both are held to the same guard here and a change to one is a
 * change to both.
 */

import { describe, expect, it } from 'vitest';
import { hexToBytes } from './contractRuntime.js';
import { hexToBytes as verifierHexToBytes } from '../verify/indexer.js';

describe.each([
  ['identity/contractRuntime', hexToBytes],
  ['verify/indexer', verifierHexToBytes],
])('hexToBytes (%s)', (_name, hexToBytes) => {
  it('reads a hex string, with or without the 0x prefix', () => {
    expect(Array.from(hexToBytes('00ff10'))).toEqual([0, 255, 16]);
    expect(Array.from(hexToBytes('0x00ff10'))).toEqual([0, 255, 16]);
    expect(Array.from(hexToBytes('00FF10'))).toEqual([0, 255, 16]);
    expect(Array.from(hexToBytes(''))).toEqual([]);
  });

  it('refuses anything that is not hex, naming the input', () => {
    /* `parseInt` reads `zz` as NaN — stored as byte 0 — and `1g` as 1, so a
       corrupt identifier used to pass as bytes and be used as one. */
    expect(() => hexToBytes('zz')).toThrow(/zz/);
    expect(() => hexToBytes('0x1g')).toThrow(/0x1g/);
    expect(() => hexToBytes('00 ff')).toThrow();
    expect(() => hexToBytes('abc')).toThrow(/Odd-length/);
  });
});
