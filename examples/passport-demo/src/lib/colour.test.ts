/**
 * Drills for the token-colour helpers.
 *
 * Small, and worth drilling for one reason: a colour that is normalised too
 * loosely makes Passport show one token's balance under another token's name.
 * The strictness is the behaviour, so the tests are mostly about what is
 * REFUSED.
 */

import { describe, expect, it } from 'vitest';

import { normalisedColourHex, shortColour } from './colour.js';

const NIGHT = '0'.repeat(64);
const MUSD = '9f3b'.repeat(16);

describe('normalisedColourHex', () => {
  it('accepts the three shapes the app really receives', () => {
    // The ledger's own form.
    expect(normalisedColourHex(MUSD)).toBe(MUSD);
    // Build configuration, pasted with a prefix and stray whitespace.
    expect(normalisedColourHex(`  0x${MUSD.toUpperCase()}  `)).toBe(MUSD);
    // The all-zero NIGHT colour is a colour like any other.
    expect(normalisedColourHex(NIGHT)).toBe(NIGHT);
  });

  it('refuses anything that is not exactly 32 bytes of hex', () => {
    // A short value is a misconfiguration, not an abbreviation: padding it
    // would silently relabel a balance.
    expect(normalisedColourHex(MUSD.slice(0, 63))).toBeNull();
    expect(normalisedColourHex(`${MUSD}a`)).toBeNull();
    expect(normalisedColourHex('z'.repeat(64))).toBeNull();
    expect(normalisedColourHex('0x')).toBeNull();
  });

  it('reads absent, empty, and null as “no colour”', () => {
    expect(normalisedColourHex(null)).toBeNull();
    expect(normalisedColourHex(undefined)).toBeNull();
    expect(normalisedColourHex('')).toBeNull();
  });
});

describe('shortColour', () => {
  it('elides a full colour and leaves a short one visibly short', () => {
    expect(shortColour(MUSD)).toBe(`${MUSD.slice(0, 10)}…${MUSD.slice(-6)}`);
    expect(shortColour('9f3b9f3b9f3b9f3b')).toBe('9f3b9f3b9f3b9f3b');
    // Exactly at the boundary, nothing is elided.
    expect(shortColour('a'.repeat(18))).toBe('a'.repeat(18));
    expect(shortColour('a'.repeat(19))).toContain('…');
  });
});
