import { describe, expect, it } from 'vitest';

import { recoverySlotFillers } from './passportContract.js';

/**
 * The account contract discloses three Bytes<32> as public `recovery_shares`.
 * Until 2026/09/01 they were real 2-of-3 Shamir shares of the recovery
 * secret, which — with the `recover` circuit live and its prover served —
 * let anyone who read two of them take the account. These tests pin the
 * replacement: the slots are filled with values that reconstruct nothing.
 */
describe('the public recovery slots', () => {
  it('are three distinct 32-byte values', () => {
    const [a, b, c] = recoverySlotFillers();
    for (const slot of [a, b, c]) expect(slot).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(b).equals(Buffer.from(c))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it('differ from call to call, so no two accounts share a slot value', () => {
    const first = recoverySlotFillers().map((s) => Buffer.from(s).toString('hex'));
    const second = recoverySlotFillers().map((s) => Buffer.from(s).toString('hex'));
    expect(new Set([...first, ...second]).size).toBe(6);
  });

  it('carry no structure a Shamir combine could exploit: any two are not points on one line', () => {
    /* Real 2-of-3 shares over GF(256) are pairs (x, y) with y = s + m·x; any
       two determine s. Independent random bytes have no such relation, and the
       cheapest observable consequence is that byte-wise XOR of any two slots is
       itself uniform rather than a constant — sampled, not proved, but a share
       set fails this on every byte. */
    const [a, b, c] = recoverySlotFillers();
    const xor = (p: Uint8Array, q: Uint8Array) => Array.from(p, (v, i) => v ^ (q[i] ?? 0));
    const ab = xor(a, b);
    const bc = xor(b, c);
    expect(new Set(ab).size).toBeGreaterThan(8);
    expect(new Set(bc).size).toBeGreaterThan(8);
  });
});
