import { describe, it, expect } from 'vitest';
import { split, reconstruct } from '../src/wallet/shamir.js';
import { randomBytes32, bytesToHex } from '../src/wallet/hex.js';

describe('Shamir 2-of-3 over GF(256)', () => {
  it('reconstructs from every pair of shares', () => {
    for (let round = 0; round < 10; round++) {
      const secret = randomBytes32();
      const shares = split(secret, 2, 3);
      const pairs = [
        [shares[0], shares[1]],
        [shares[0], shares[2]],
        [shares[1], shares[2]],
      ];
      for (const pair of pairs) {
        expect(bytesToHex(reconstruct(pair))).toBe(bytesToHex(secret));
      }
    }
  });

  it('reconstructs from all three shares', () => {
    const secret = randomBytes32();
    const shares = split(secret, 2, 3);
    expect(bytesToHex(reconstruct(shares))).toBe(bytesToHex(secret));
  });

  it('rejects duplicate share indices', () => {
    const secret = randomBytes32();
    const shares = split(secret, 2, 3);
    expect(() => reconstruct([shares[0], shares[0]])).toThrow(/duplicate/);
  });

  it('a single share does not equal the secret', () => {
    const secret = randomBytes32();
    const shares = split(secret, 2, 3);
    for (const share of shares) {
      expect(bytesToHex(share.value)).not.toBe(bytesToHex(secret));
    }
  });
});
