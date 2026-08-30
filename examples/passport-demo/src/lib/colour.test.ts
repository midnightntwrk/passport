/**
 * Drills for the token-colour helpers.
 *
 * Small, and worth drilling for one reason: a colour that is normalised too
 * loosely makes Passport show one token's balance under another token's name.
 * The strictness is the behaviour, so the tests are mostly about what is
 * REFUSED.
 */

import { describe, expect, it } from 'vitest';

import {
  describeColour,
  describeColours,
  MUSD_COLOUR_HEX,
  NIGHT_COLOUR_HEX,
  normalisedColourHex,
  shortColour,
  sortTokenHoldings,
} from './colour.js';

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

describe('describeColour', () => {
  it('names the two colours Passport knows without asking anybody', () => {
    expect(describeColour(NIGHT_COLOUR_HEX)).toEqual({
      symbol: 'NIGHT',
      name: 'native token',
      decimals: 6,
      known: true,
    });
    expect(describeColour(MUSD_COLOUR_HEX)).toEqual({
      symbol: 'mUSD',
      name: 'stablecoin',
      decimals: 0,
      known: true,
    });
  });

  it('lets the sponsor outrank the table for its own asset', () => {
    /* The sponsor mints it, so it is the only authority on what it is called —
       and a build pointed at a different sponsor must not show that sponsor's
       asset under this one's ticker. */
    const sponsored = { colourHex: 'ab'.repeat(32), symbol: 'demoUSD' };
    expect(describeColour('ab'.repeat(32), sponsored)).toMatchObject({
      symbol: 'demoUSD',
      known: true,
    });
    // And it names only ITS colour: everything else falls through as before.
    expect(describeColour(MUSD_COLOUR_HEX, sponsored)).toMatchObject({ symbol: 'mUSD' });
    expect(describeColour('cd'.repeat(32), sponsored).known).toBe(false);
  });

  it('reads a sponsor colour in any of the shapes /status can send it', () => {
    expect(
      describeColour(MUSD_COLOUR_HEX, {
        colourHex: `0x${MUSD_COLOUR_HEX.toUpperCase()}`,
        symbol: 'sponsorUSD',
      }),
    ).toMatchObject({ symbol: 'sponsorUSD' });
  });

  it('gives an unnameable colour four characters and a subtitle, never 64', () => {
    const identity = describeColour('a1b2'.repeat(16));
    expect(identity).toEqual({
      symbol: 'Token · a1b2…',
      name: shortColour('a1b2'.repeat(16)),
      decimals: 0,
      known: false,
    });
    expect(identity.symbol).not.toContain('a1b2a1b2a1b2');
    expect(identity.name.length).toBeLessThan(64);
  });

  it('still answers for a colour that is not well formed at all', () => {
    // Nothing on a screen may depend on a value being a valid colour: the
    // alternative to an answer here is a blank row with a balance beside it.
    expect(describeColour('  NOTACOLOUR  ').known).toBe(false);
    expect(describeColour('  NOTACOLOUR  ').symbol).toBe('Token · nota…');
  });
});

describe('sortTokenHoldings', () => {
  const night = { colourHex: NIGHT_COLOUR_HEX, amount: 1n };
  const musd = { colourHex: MUSD_COLOUR_HEX, amount: 5n };
  const alpha = { colourHex: 'aa'.repeat(32), amount: 2n };
  const beta = { colourHex: 'bb'.repeat(32), amount: 900n };
  const gamma = { colourHex: 'cc'.repeat(32), amount: 40n };

  it('puts NIGHT first, then the named, then the unnamed by balance', () => {
    const sorted = sortTokenHoldings([gamma, musd, beta, night, alpha]);
    expect(sorted.map((held) => held.colourHex)).toEqual([
      night.colourHex,
      musd.colourHex,
      beta.colourHex,
      gamma.colourHex,
      alpha.colourHex,
    ]);
  });

  it('orders named colours alphabetically, which is the only order a reader can predict', () => {
    const sponsored = { colourHex: 'aa'.repeat(32), symbol: 'aUSD' };
    const sorted = sortTokenHoldings([musd, alpha], sponsored);
    expect(sorted.map((held) => held.colourHex)).toEqual([alpha.colourHex, musd.colourHex]);
  });

  it('is a total order, so the same balances never reshuffle between renders', () => {
    const tie = { colourHex: 'de'.repeat(32), amount: 40n };
    const first = sortTokenHoldings([gamma, tie]);
    const second = sortTokenHoldings([tie, gamma]);
    expect(first.map((held) => held.colourHex)).toEqual(second.map((held) => held.colourHex));
    // Equal balances, so the colour breaks it: `cc…` before `de…`.
    expect(first[0].colourHex).toBe(gamma.colourHex);
  });

  it('breaks a tie between two named colours on the colour itself', () => {
    /* Two colours the sponsor named identically. Contrived, and the point is
       that the comparator still returns a stable answer rather than 0. */
    const sponsored = { colourHex: 'aa'.repeat(32), symbol: 'mUSD' };
    const sorted = sortTokenHoldings([musd, alpha], sponsored);
    expect(sorted.map((held) => held.colourHex)).toEqual([musd.colourHex, alpha.colourHex]);
  });

  it('leaves an empty list empty and a single holding alone', () => {
    expect(sortTokenHoldings([])).toEqual([]);
    expect(sortTokenHoldings([beta])).toEqual([beta]);
  });
});

describe('sortTokenHoldings, on input a caller should not send but might', () => {
  it('sorts a malformed colour rather than throwing over it', () => {
    // Nothing on a screen may depend on a colour being well formed. A holding
    // whose colour did not survive whatever produced it is still a holding.
    const sorted = sortTokenHoldings([
      { colourHex: 'NOTACOLOUR', amount: 1n },
      { colourHex: NIGHT_COLOUR_HEX, amount: 2n },
    ]);
    expect(sorted.map((held) => held.colourHex)).toEqual(['0'.repeat(64), 'NOTACOLOUR']);
  });

  it('keeps two identical colours side by side instead of swapping them for ever', () => {
    const twin = { colourHex: 'ee'.repeat(32), amount: 7n };
    const sorted = sortTokenHoldings([{ ...twin }, { ...twin }]);
    expect(sorted).toHaveLength(2);
    expect(sorted.every((held) => held.colourHex === twin.colourHex)).toBe(true);
  });
});

describe('describeColours', () => {
  it('leaves a screenful of distinct symbols exactly as they were', () => {
    const described = describeColours([NIGHT_COLOUR_HEX, MUSD_COLOUR_HEX, 'ab'.repeat(32)]);
    expect(described.map((identity) => identity.symbol)).toEqual([
      'NIGHT',
      'mUSD',
      'Token · abab…',
    ]);
  });

  it('separates two different colours a deployment has given the same ticker', () => {
    /* Real, and the configuration that produces it: the sponsor names ITS
       colour over /status, and it need not be the one the table knows. Two rows
       both reading "mUSD" and holding different money is the defect. */
    const sponsored = { colourHex: 'aa'.repeat(32), symbol: 'mUSD' };
    const described = describeColours([MUSD_COLOUR_HEX, 'aa'.repeat(32)], sponsored);
    expect(described.map((identity) => identity.symbol)).toEqual([
      'mUSD · 1a29…',
      'mUSD · aaaa…',
    ]);
  });

  it('pays for the disambiguation only where it is needed', () => {
    const sponsored = { colourHex: 'aa'.repeat(32), symbol: 'mUSD' };
    const described = describeColours(
      [NIGHT_COLOUR_HEX, MUSD_COLOUR_HEX, 'aa'.repeat(32)],
      sponsored,
    );
    // NIGHT is unique, so it keeps its bare ticker.
    expect(described[0].symbol).toBe('NIGHT');
    expect(described[1].symbol).toContain('·');
    expect(described[2].symbol).toContain('·');
  });

  it('separates two unnameable colours that share the same first four characters', () => {
    const described = describeColours([`abcd${'0'.repeat(60)}`, `abcd${'1'.repeat(60)}`]);
    // Both read `Token · abcd…`, so both are qualified — with the same four
    // characters, which is honest: they really are that similar, and the
    // subtitle beneath carries the tail that tells them apart.
    expect(described[0].symbol).toBe(described[1].symbol);
    expect(described[0].name).not.toBe(described[1].name);
  });

  it('is empty for an empty screen', () => {
    expect(describeColours([])).toEqual([]);
  });
});

describe('describeColours, on input a caller should not send but might', () => {
  it('leaves two malformed colours alone rather than qualifying them twice', () => {
    /* Both read `Token · nota…` already. Appending the same four characters
       again would produce `Token · nota… · nota…`; the subtitle beneath is what
       still tells them apart. */
    const described = describeColours(['  NOTACOLOUR-ONE ', 'NOTACOLOUR-TWO']);
    expect(described[0].symbol).toBe('Token · nota…');
    expect(described[1].symbol).toBe('Token · nota…');
    expect(described[0].name).not.toBe(described[1].name);
  });
});
