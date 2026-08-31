import { describe, expect, it } from 'vitest';

import { extractMidnightAddress } from './qrScan.js';

/* A real preview unshielded address, as the drills produce them. */
const ADDR = 'mn_addr_preview1x5wntqr8xxgmpj09n3f38rjegx70apzrqzeldefvzmzuga3k9xqqdqu8vk';

describe('extractMidnightAddress', () => {
  it('passes a bare address through', () => {
    expect(extractMidnightAddress(ADDR)).toBe(ADDR);
  });

  it('trims surrounding whitespace', () => {
    expect(extractMidnightAddress(`  ${ADDR}\n`)).toBe(ADDR);
  });

  it('lower-cases an all-upper payload, as QR alphanumeric mode produces', () => {
    expect(extractMidnightAddress(ADDR.toUpperCase())).toBe(ADDR);
  });

  it('leaves mixed case alone for the validator to refuse', () => {
    // bech32m forbids mixed case; the plausibility gate must not "fix" it.
    const mixed = `mn_addr_preview1X${ADDR.slice(17)}`;
    expect(extractMidnightAddress(mixed)).toBeNull();
  });

  it('unwraps a midnight: URI', () => {
    expect(extractMidnightAddress(`midnight:${ADDR}`)).toBe(ADDR);
  });

  it('unwraps midnight:// and drops query parameters uninterpreted', () => {
    expect(extractMidnightAddress(`midnight://${ADDR}?amount=5`)).toBe(ADDR);
    expect(extractMidnightAddress(`midnight:${ADDR}#note`)).toBe(ADDR);
  });

  it('unwraps an upper-cased URI payload', () => {
    expect(extractMidnightAddress(`MIDNIGHT:${ADDR.toUpperCase()}`)).toBe(ADDR);
  });

  it('keeps scanning on other URI schemes', () => {
    expect(extractMidnightAddress(`https://example.com/${ADDR}`)).toBeNull();
    expect(extractMidnightAddress('mailto:someone@example.com')).toBeNull();
  });

  it('keeps scanning on arbitrary text and empty reads', () => {
    expect(extractMidnightAddress('')).toBeNull();
    expect(extractMidnightAddress('   ')).toBeNull();
    expect(extractMidnightAddress('WIFI:T:WPA;S:cafe;P:secret;;')).toBeNull();
    expect(extractMidnightAddress('hello world')).toBeNull();
  });

  it('passes other mn_ kinds through for the validator to name', () => {
    // A shielded or dust address is plausible here; the recipient validator is
    // the one that says "not an unshielded one" in its own words.
    const shielded = 'mn_shield-addr_preview1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    expect(extractMidnightAddress(shielded)).toBe(shielded);
  });

  it('refuses an mn_ fragment with no separator or data', () => {
    expect(extractMidnightAddress('mn_addr_preview')).toBeNull();
    expect(extractMidnightAddress('mn_')).toBeNull();
  });

  it('reports no address for a code that carried a name', () => {
    // A Passport Receive code is a NAME payload. Asking this function for an
    // address in it must come back empty rather than inventing one; the caller
    // that wants the name asks `parseQrPayload` directly.
    expect(extractMidnightAddress('midnight:alice.night')).toBeNull();
    expect(extractMidnightAddress('alice.night')).toBeNull();
  });
});
