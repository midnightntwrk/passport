/**
 * The Companion link's one rule, drilled on both of the ways it can be wrong:
 * sending a reader somewhere an operator did not configure, and ignoring the
 * address an operator did.
 */

import { describe, expect, it } from 'vitest';

import { COMPANION_DEFAULT_URL, COMPANION_LABEL, companionEnabled, companionUrl } from './companionLink.js';

describe('companionUrl', () => {
  it('uses a configured https address exactly as it was given', () => {
    expect(companionUrl('https://t.me/SomeRealHandleBot')).toBe(
      'https://t.me/SomeRealHandleBot',
    );
  });

  it('trims the surrounding whitespace an environment file leaves behind', () => {
    expect(companionUrl('  https://t.me/SomeRealHandleBot\n')).toBe(
      'https://t.me/SomeRealHandleBot',
    );
  });

  it('falls back when the variable is unset', () => {
    expect(companionUrl(undefined)).toBe(COMPANION_DEFAULT_URL);
  });

  it('falls back when the value is not a string at all', () => {
    expect(companionUrl(42)).toBe(COMPANION_DEFAULT_URL);
    expect(companionUrl(null)).toBe(COMPANION_DEFAULT_URL);
  });

  it('falls back on a blank value, which is how an unset variable often arrives', () => {
    expect(companionUrl('')).toBe(COMPANION_DEFAULT_URL);
    expect(companionUrl('   ')).toBe(COMPANION_DEFAULT_URL);
  });

  it('falls back on a value no browser could open', () => {
    expect(companionUrl('t.me/NoSchemeHere')).toBe(COMPANION_DEFAULT_URL);
  });

  it('refuses a non-https scheme rather than opening it', () => {
    expect(companionUrl('http://t.me/Insecure')).toBe(COMPANION_DEFAULT_URL);
    expect(companionUrl('javascript:alert(1)')).toBe(COMPANION_DEFAULT_URL);
  });

  it('names the control the same way everywhere it appears', () => {
    expect(COMPANION_LABEL).toBe('Chat with your Midnight Companion');
  });

  it('ships a placeholder default until the real handle is issued', () => {
    expect(COMPANION_DEFAULT_URL).toBe('https://t.me/MidnightCompanionBot');
    expect(new URL(COMPANION_DEFAULT_URL).protocol).toBe('https:');
  });
});

describe('companionEnabled', () => {
  it('is off until a real https handle is configured', () => {
    expect(companionEnabled(undefined)).toBe(false);
    expect(companionEnabled('')).toBe(false);
    expect(companionEnabled('http://t.me/Nope')).toBe(false);
    expect(companionEnabled(COMPANION_DEFAULT_URL)).toBe(false);
  });
  it('is on for a configured https handle', () => {
    expect(companionEnabled('https://t.me/SomeRealHandleBot')).toBe(true);
  });
});
