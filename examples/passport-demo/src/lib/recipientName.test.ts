/**
 * Drills for the recipient field's two vocabularies.
 *
 * The classification decides which of two completely different things happens
 * next — a registry read, or a bech32m decode — so every way it can pick wrong
 * is a way of showing somebody the wrong refusal about the wrong thing. The
 * cache decides how often the registry is asked; getting that wrong is either a
 * read per keystroke or an answer that has gone stale inside one sheet.
 */

import { describe, expect, it } from 'vitest';

import {
  accountTail,
  classifyRecipientInput,
  createNameResolutionCache,
  NIGHT_SUFFIX,
} from './recipientName.js';

const ADDRESS = 'mn_addr_stagenet127xnp9uuxwhh7a8an77mxv02ypt6u09xkk63c9zvdkjsrj4mj68qg7c5ad';

describe('classifyRecipientInput', () => {
  it('reads nothing typed as nothing typed', () => {
    expect(classifyRecipientInput('')).toEqual({ kind: 'empty' });
    expect(classifyRecipientInput('   ')).toEqual({ kind: 'empty' });
  });

  it('reads a full name and a bare label as the same name', () => {
    const suffixed = classifyRecipientInput('alice.night');
    const bare = classifyRecipientInput('alice');
    expect(suffixed).toEqual({ kind: 'name', label: 'alice', domain: 'alice.night' });
    expect(bare).toEqual(suffixed);
  });

  it('forgives the case and the trailing dot people actually type', () => {
    expect(classifyRecipientInput('  ALICE.NIGHT.  ')).toEqual({
      kind: 'name',
      label: 'alice',
      domain: `alice${NIGHT_SUFFIX}`,
    });
    expect(classifyRecipientInput('Alice')).toEqual({
      kind: 'name',
      label: 'alice',
      domain: 'alice.night',
    });
  });

  it('reads a 32-byte account address as an account, with or without 0x', () => {
    /* Added 2026/09/02: a Passport can be paid at its account address as well
       as at its name, and the two go by exactly the same route. `0x` is
       forgiven because the tools that copy these bytes out disagree about
       writing it; the kept value is always the bare lowercase form a contract
       call takes. */
    const bare = 'a'.repeat(64);
    expect(classifyRecipientInput(bare)).toEqual({ kind: 'account', address: bare });
    expect(classifyRecipientInput(`0x${bare}`)).toEqual({ kind: 'account', address: bare });
    expect(classifyRecipientInput(`  0X${'AB'.repeat(32)}  `)).toEqual({
      kind: 'account',
      address: 'ab'.repeat(32),
    });
  });

  it('never reads an almost-account as an account', () => {
    /* A truncated address accepted as an account is money paid at 32 bytes
       nobody holds. One character short is not an account, and it earns the
       name rule's own refusal about length rather than a send. */
    expect(classifyRecipientInput('a'.repeat(63))).toMatchObject({ kind: 'name-invalid' });
    expect(classifyRecipientInput('a'.repeat(65))).toMatchObject({ kind: 'name-invalid' });
    // 64 characters, one of which is not hex.
    expect(classifyRecipientInput(`${'a'.repeat(63)}z`)).toMatchObject({ kind: 'name-invalid' });
  });

  it('sends every address, whole or half typed, to the codec', () => {
    // The refusals belong to the SDK, which knows why a bech32m string is bad.
    expect(classifyRecipientInput(ADDRESS)).toEqual({ kind: 'address', value: ADDRESS });
    expect(classifyRecipientInput('mn_shield-addr_stagenet1qq')).toMatchObject({
      kind: 'address',
    });
    expect(classifyRecipientInput('MN_ADDR_STAGENET1QQ')).toMatchObject({ kind: 'address' });
    // Underscored, so it cannot be a label; dotted but not `.night`, so it is
    // not one either. Both go to the codec rather than to the registry.
    expect(classifyRecipientInput('alice.eth')).toMatchObject({ kind: 'address' });
    expect(classifyRecipientInput('a.b.night.c')).toMatchObject({ kind: 'address' });
  });

  it('names the fault when a name is meant but could not be one', () => {
    expect(classifyRecipientInput('.night')).toEqual({
      kind: 'name-invalid',
      typed: '.night',
      reason: 'Type the name before .night.',
    });
    // Hyphens at either end, and anything outside the label alphabet.
    for (const typed of ['-alice.night', 'alice-.night', 'ali ce', 'alice!', 'a'.repeat(33)]) {
      expect(classifyRecipientInput(typed).kind).toBe('name-invalid');
    }
  });

  it('accepts the label shapes the registry really holds', () => {
    for (const label of ['a', '1', 'aqm', 'passport-771a3f', 'final33665', 'a'.repeat(32)]) {
      expect(classifyRecipientInput(`${label}.night`)).toMatchObject({ kind: 'name', label });
    }
  });

  it('reads a bare “mn” on the way to an address as a name, and says so', () => {
    /* Deliberate. The resolution is debounced, so it only fires if somebody
       stops there, and one wasted registry read beats a rule that guesses at
       what half-typed text is about to become. */
    expect(classifyRecipientInput('mn')).toMatchObject({ kind: 'name', label: 'mn' });
    // The moment the underscore lands it is an address again.
    expect(classifyRecipientInput('mn_')).toMatchObject({ kind: 'address' });
  });
});

describe('createNameResolutionCache', () => {
  it('answers a name it has been told about, and nothing else', () => {
    const cache = createNameResolutionCache();
    expect(cache.get('alice.night')).toBeUndefined();
    cache.set('alice.night', { found: true, domain: 'alice.night', accountAddress: 'ab'.repeat(32) });
    expect(cache.get('alice.night')).toMatchObject({ found: true });
    expect(cache.get('bob.night')).toBeUndefined();
    expect(cache.size()).toBe(1);
  });

  it('treats one name typed three ways as one question', () => {
    const cache = createNameResolutionCache();
    cache.set('Alice.Night', { found: false, reason: 'nobody holds it' });
    expect(cache.get('alice.night')).toMatchObject({ found: false });
    expect(cache.get('  ALICE.NIGHT  ')).toMatchObject({ found: false });
    expect(cache.size()).toBe(1);
  });

  it('remembers “nobody holds this” as the real answer it is', () => {
    // A miss is something the registry SAID. Not caching it would re-ask on
    // every keystroke past the one that produced it.
    const cache = createNameResolutionCache();
    cache.set('nobody.night', { found: false, reason: 'No Passport has this name.' });
    expect(cache.get('nobody.night')).toEqual({
      found: false,
      reason: 'No Passport has this name.',
    });
  });

  it('lets a later answer replace an earlier one for the same name', () => {
    const cache = createNameResolutionCache();
    cache.set('alice.night', { found: false, reason: 'not yet' });
    cache.set('alice.night', { found: true, domain: 'alice.night', accountAddress: 'cd'.repeat(32) });
    expect(cache.get('alice.night')).toMatchObject({ found: true });
    expect(cache.size()).toBe(1);
  });
});

describe('accountTail', () => {
  it('shows enough to tell two resolutions apart and far too little to copy', () => {
    expect(accountTail(`${'0'.repeat(60)}a1b2`)).toBe('…a1b2');
    expect(accountTail('7c2f4a19e6d0b83c', 6)).toBe('…d0b83c');
    // Never the address itself, however short the address happens to be.
    expect(accountTail('ab')).toBe('…ab');
  });

  it('is empty for an empty address rather than a lone ellipsis', () => {
    expect(accountTail('')).toBe('');
    expect(accountTail('   ')).toBe('');
  });
});
