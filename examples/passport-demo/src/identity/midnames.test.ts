/**
 * Drills for the Midnames read side — the half of `./midnames.ts` that decides
 * something without a chain.
 *
 * WHAT IS DRILLED, AND WHY THESE
 * ------------------------------
 * Everything else in that module is a registry read: `checkAliasAvailability`,
 * `resolveAliasTarget`, and the snapshot cache behind them all go to a
 * network's own indexer, and a mocked indexer proves nothing about a registry.
 * Those are drilled against stagenet by `e2e/stagenet.live.spec.ts`, which
 * claims a real name and reads it back.
 *
 * What IS drilled here is the part that is wrong SILENTLY:
 *
 *   1. `normalizePassportAlias`, because it is the only gate between what a
 *      user types and what gets registered, permanently, on a public registry;
 *   2. `aliasCostAtomicNight`, because it is measured in UTF-8 BYTES the way
 *      the contract measures it, and a length taken in JavaScript characters
 *      quotes the wrong price for any non-ASCII label;
 *   3. `decodeDomainTarget`, because reading `.left.bytes` unconditionally — as
 *      this module did until 2026/08/19 — reports 32 zero bytes for every
 *      wallet-targeted name, which is a wrong answer that looks like an
 *      answer; and
 *   4. `deriveMidnamesOwnerKey`, because an owner key that is off by a byte
 *      registers a name to somebody who is not this Passport.
 *
 * The owner key is checked against Node's own `createHash`, which is what the
 * Node integration this derivation must match uses. Nothing is asserted
 * against a value this file made up.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/identity`.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MIDNAMES_INDEXER_URLS,
  MIDNAMES_TLD,
  MIDNAMES_TLD_ADDRESSES,
  RESERVED_ALIASES,
  aliasCostAtomicNight,
  aliasDomain,
  decodeDomainTarget,
  deriveMidnamesOwnerKey,
  formatNight,
  invalidateAliasRegistry,
  normalizePassportAlias,
  suggestAliasAlternatives,
} from './midnames.js';
import type { MidnamesLedger } from './midnames.js';

/** Builds the nested `Either` a leaf's `DOMAIN_TARGET` really is. */
function domainTarget(
  kind: 'contract' | 'shielded' | 'wallet',
  bytes: Uint8Array,
): MidnamesLedger['DOMAIN_TARGET'] {
  const zeros = new Uint8Array(32);
  return {
    is_left: kind === 'contract',
    left: { bytes: kind === 'contract' ? bytes : zeros },
    right: {
      is_left: kind === 'shielded',
      left: { bytes: kind === 'shielded' ? bytes : zeros },
      right: { bytes: kind === 'wallet' ? bytes : zeros },
    },
  };
}

const TARGET_BYTES = Uint8Array.from({ length: 32 }, (_unused, index) => index + 1);
const TARGET_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';

describe('formatNight', () => {
  it('quotes atomic NIGHT on the six-decimal scale the wallet surfaces use', () => {
    expect(formatNight(0n)).toBe('0');
    expect(formatNight(1n)).toBe('0.000001');
    expect(formatNight(1_000_000n)).toBe('1');
    expect(formatNight(2_000n)).toBe('0.002');
    expect(formatNight(1_234_567n)).toBe('1.234567');
    // Trailing zeros go; the whole part never does.
    expect(formatNight(1_500_000n)).toBe('1.5');
    expect(formatNight(10_000_000n)).toBe('10');
  });

  it('keeps the sign on a negative amount rather than losing it', () => {
    expect(formatNight(-1n)).toBe('-0.000001');
    expect(formatNight(-1_500_000n)).toBe('-1.5');
  });
});

describe('aliasDomain and the TLD', () => {
  it('puts every label under `.night`', () => {
    expect(MIDNAMES_TLD).toBe('night');
    expect(aliasDomain('alice')).toBe('alice.night');
  });
});

describe('normalizePassportAlias', () => {
  it('lower-cases, trims, and strips a typed `.night` suffix', () => {
    expect(normalizePassportAlias('  Alice  ')).toBe('alice');
    expect(normalizePassportAlias('Alice.night')).toBe('alice');
    expect(normalizePassportAlias('alice.night.')).toBe('alice');
    expect(normalizePassportAlias('alice...')).toBe('alice');
  });

  it('accepts the shape the registry accepts, hyphens interior only', () => {
    expect(normalizePassportAlias('a')).toBe('a');
    expect(normalizePassportAlias('a-b')).toBe('a-b');
    expect(normalizePassportAlias('a1-b2-c3')).toBe('a1-b2-c3');
    expect(normalizePassportAlias('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('refuses everything the registry would, with a sentence the UI can show', () => {
    for (const bad of ['', '-alice', 'alice-', 'a_b', 'a b', 'ålice', 'a'.repeat(33), '.night']) {
      expect(() => normalizePassportAlias(bad)).toThrow(
        /Names are 1–32 characters: lowercase letters, numbers, and hyphens inside\./,
      );
    }
  });

  it('refuses the reserved names before any network call', () => {
    // `midnight.night` reading as an official account is exactly the confusion
    // this list prevents.
    for (const reserved of RESERVED_ALIASES) {
      expect(() => normalizePassportAlias(reserved)).toThrow(
        new RegExp(`"${reserved}" is reserved`),
      );
    }
    expect(RESERVED_ALIASES).toContain('admin');
  });
});

describe('aliasCostAtomicNight', () => {
  it('reads the deployed TLD’s own three price bands', () => {
    // COST_SHORT / COST_MED / COST_LONG, read off chain 2026/08/05.
    expect(aliasCostAtomicNight('a')).toBe(600n);
    expect(aliasCostAtomicNight('abc')).toBe(600n);
    expect(aliasCostAtomicNight('abcd')).toBe(140n);
    expect(aliasCostAtomicNight('abcde')).toBe(10n);
    expect(aliasCostAtomicNight('a'.repeat(32))).toBe(10n);
  });

  it('measures UTF-8 bytes, as the contract measures them', () => {
    /* Three JavaScript characters, but nine bytes — so it is a LONG name and
       costs 10, not 600. A length taken in characters would quote 600. */
    expect('日本語'.length).toBe(3);
    expect(aliasCostAtomicNight('日本語')).toBe(10n);
  });
});

describe('decodeDomainTarget', () => {
  it('reads the contract branch, which is the one an account name uses', () => {
    expect(decodeDomainTarget(domainTarget('contract', TARGET_BYTES))).toEqual({
      kind: 'contract',
      hex: TARGET_HEX,
    });
  });

  it('reads the two wallet-shaped branches without confusing them', () => {
    /* Reading `.left.bytes` unconditionally reported 32 zero bytes for both of
       these until 2026/08/19 — a wrong answer that looked like an answer. */
    expect(decodeDomainTarget(domainTarget('shielded', TARGET_BYTES))).toEqual({
      kind: 'shielded',
      hex: TARGET_HEX,
    });
    expect(decodeDomainTarget(domainTarget('wallet', TARGET_BYTES))).toEqual({
      kind: 'wallet',
      hex: TARGET_HEX,
    });
  });

  it('never reports the unselected branches’ zero bytes as a target', () => {
    for (const kind of ['contract', 'shielded', 'wallet'] as const) {
      expect(decodeDomainTarget(domainTarget(kind, TARGET_BYTES)).hex).not.toBe('00'.repeat(32));
    }
  });
});

describe('deriveMidnamesOwnerKey', () => {
  it('matches the Node integration’s digest, byte for byte', async () => {
    const secret = Uint8Array.from({ length: 32 }, (_unused, index) => index * 7);
    const payload = Buffer.alloc(64);
    payload.write('midnight.domains', 0, 'utf8');
    payload.set(secret, 32);
    const expected = createHash('sha256').update(payload).digest('hex');

    const derived = await deriveMidnamesOwnerKey(secret);
    expect(derived).toHaveLength(32);
    expect(Buffer.from(derived).toString('hex')).toBe(expected);
  });

  it('refuses a secret that is not 32 bytes rather than padding it', async () => {
    await expect(deriveMidnamesOwnerKey(new Uint8Array(31))).rejects.toThrow(
      /must be 32 bytes, received 31/,
    );
    await expect(deriveMidnamesOwnerKey(new Uint8Array(33))).rejects.toThrow(/received 33/);
  });
});

describe('suggestAliasAlternatives', () => {
  it('offers only labels that are themselves claimable', () => {
    expect(suggestAliasAlternatives('alice')).toEqual([
      'alice2',
      'alice-mn',
      'alice-night',
      'myalice',
      'alice01',
    ]);
  });

  it('drops a trailing hyphen before building on the name', () => {
    // `alice--mn` would be fine, but `alice-` with a suffix that starts on a
    // hyphen would not; the base is trimmed first.
    expect(suggestAliasAlternatives('alice-')).toEqual([
      'alice2',
      'alice-mn',
      'alice-night',
      'myalice',
      'alice01',
    ]);
  });

  it('filters out candidates that would overrun 32 bytes', () => {
    const long = 'a'.repeat(30);
    const suggestions = suggestAliasAlternatives(long);
    expect(suggestions).toContain(`${long}2`);
    // `<30>-night` is 36 characters, and `my<30>` is 32 — one fits, one does not.
    expect(suggestions).not.toContain(`${long}-night`);
    expect(suggestions).toContain(`my${long}`);
    for (const suggestion of suggestions) {
      expect(() => normalizePassportAlias(suggestion)).not.toThrow();
    }
  });
});

describe('the per-network tables', () => {
  it('names a TLD address and an indexer for every network it knows', () => {
    for (const network of ['stagenet', 'preview', 'preprod', 'mainnet'] as const) {
      expect(MIDNAMES_TLD_ADDRESSES[network]).toMatch(/^[0-9a-f]{64}$/);
      expect(MIDNAMES_INDEXER_URLS[network]).toMatch(/^https:\/\/.+\/api\/v4\/graphql$/);
    }
  });

  it('drops one network’s cached registry snapshot, or all of them', () => {
    // Nothing to assert but that it is safe to call: the cache is private, and
    // the next read is a network read either way.
    expect(() => invalidateAliasRegistry('stagenet')).not.toThrow();
    expect(() => invalidateAliasRegistry()).not.toThrow();
  });
});
