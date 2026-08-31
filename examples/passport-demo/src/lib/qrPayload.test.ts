import { describe, expect, it } from 'vitest';

import { encodeReceivePayload, normalisedAccountHex, parseQrPayload } from './qrPayload.js';

/* A real preview unshielded address, as the drills produce them. */
const ADDR = 'mn_addr_preview1x5wntqr8xxgmpj09n3f38rjegx70apzrqzeldefvzmzuga3k9xqqdqu8vk';

/* A 64-hex account address, the shape `resolverTargetHex` carries. */
const ACCOUNT = 'ab'.repeat(32);

describe('normalisedAccountHex', () => {
  // The rule BOTH sides of the cross-check go through. A leading `0x` on one
  // side and not the other would otherwise read as a disagreement.
  it('accepts exactly 32 bytes of hex, in any case, with or without 0x', () => {
    expect(normalisedAccountHex(ACCOUNT)).toBe(ACCOUNT);
    expect(normalisedAccountHex(`  0X${ACCOUNT.toUpperCase()}  `)).toBe(ACCOUNT);
  });

  it('refuses anything else, including nothing at all', () => {
    expect(normalisedAccountHex(null)).toBeNull();
    expect(normalisedAccountHex(undefined)).toBeNull();
    expect(normalisedAccountHex('')).toBeNull();
    expect(normalisedAccountHex(ACCOUNT.slice(1))).toBeNull();
    expect(normalisedAccountHex(`${ACCOUNT.slice(0, 63)}z`)).toBeNull();
  });
});

describe('encodeReceivePayload', () => {
  it('draws the name and the account in the agreed form', () => {
    expect(encodeReceivePayload({ domain: 'alice.night', accountAddress: ACCOUNT })).toBe(
      `midnight:alice.night?account=${ACCOUNT}`,
    );
  });

  it('normalises the name it was handed rather than trusting its case', () => {
    // A record written by an older build, or a bare label said out loud.
    expect(encodeReceivePayload({ domain: 'Alice.NIGHT', accountAddress: ACCOUNT })).toBe(
      `midnight:alice.night?account=${ACCOUNT}`,
    );
    expect(encodeReceivePayload({ domain: 'alice', accountAddress: null })).toBe(
      'midnight:alice.night',
    );
  });

  it('drops an account that is not 32 bytes of hex', () => {
    expect(encodeReceivePayload({ domain: 'alice.night', accountAddress: 'deadbeef' })).toBe(
      'midnight:alice.night',
    );
    expect(encodeReceivePayload({ domain: 'alice.night', accountAddress: undefined })).toBe(
      'midnight:alice.night',
    );
  });

  it('forgives an 0x prefix on the account', () => {
    expect(encodeReceivePayload({ domain: 'alice.night', accountAddress: `0x${ACCOUNT}` })).toBe(
      `midnight:alice.night?account=${ACCOUNT}`,
    );
  });

  it('draws nothing without a name', () => {
    // A code carrying only an account is one no Passport scanner can act on,
    // so Receive shows the address row alone rather than an unscannable square.
    expect(encodeReceivePayload({ domain: null, accountAddress: ACCOUNT })).toBeNull();
    expect(encodeReceivePayload({ domain: '', accountAddress: ACCOUNT })).toBeNull();
    expect(encodeReceivePayload({ domain: '-nope-', accountAddress: ACCOUNT })).toBeNull();
  });
});

describe('encodeReceivePayload → parseQrPayload', () => {
  it('round-trips the name and the account exactly', () => {
    const payload = encodeReceivePayload({ domain: 'alice.night', accountAddress: ACCOUNT });
    expect(parseQrPayload(payload!)).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: ACCOUNT,
    });
  });

  it('round-trips through an all-upper scan, as QR alphanumeric mode produces', () => {
    const payload = encodeReceivePayload({ domain: 'alice.night', accountAddress: ACCOUNT })!;
    expect(parseQrPayload(payload.toUpperCase())).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: ACCOUNT,
    });
  });

  it('round-trips a name with no account behind it yet', () => {
    const payload = encodeReceivePayload({ domain: 'alice.night', accountAddress: null })!;
    expect(parseQrPayload(payload)).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: null,
    });
  });
});

describe('parseQrPayload — names', () => {
  it('reads a bare name, with or without the suffix', () => {
    expect(parseQrPayload('alice.night')).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: null,
    });
    expect(parseQrPayload('alice')).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: null,
    });
  });

  it('drops an account query value that is not 64 hex', () => {
    // A malformed cross-check is no worse than an absent one: the registry
    // answers what the name pays either way.
    expect(parseQrPayload('midnight:alice.night?account=deadbeef')).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: null,
    });
    expect(parseQrPayload(`midnight:alice.night?account=${ACCOUNT}ff`)).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: null,
    });
  });

  it('ignores every parameter except the account', () => {
    // An `amount=` hint prefilled would be a payment-request feature this demo
    // has not built, and half-honouring it is worse than ignoring it.
    expect(parseQrPayload(`midnight:alice.night?amount=5&account=${ACCOUNT}&memo=hi`)).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: ACCOUNT,
    });
  });

  it('keeps a fragment out of the query it reads', () => {
    expect(parseQrPayload(`midnight:alice.night?account=${ACCOUNT}#note`)).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: ACCOUNT,
    });
    expect(parseQrPayload(`midnight:alice.night#note?account=${ACCOUNT}`)).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: null,
    });
  });

  it('unwraps midnight:// before the name', () => {
    expect(parseQrPayload('midnight://alice.night')).toEqual({
      kind: 'name',
      domain: 'alice.night',
      accountHex: null,
    });
  });

  it('refuses a label the registry could never hold', () => {
    expect(parseQrPayload('-alice.night')).toBeNull();
    expect(parseQrPayload('midnight:?account=' + ACCOUNT)).toBeNull();
  });
});

describe('parseQrPayload — addresses', () => {
  it('reads a bare address', () => {
    expect(parseQrPayload(ADDR)).toEqual({ kind: 'address', address: ADDR });
  });

  it('trims surrounding whitespace', () => {
    expect(parseQrPayload(`  ${ADDR}\n`)).toEqual({ kind: 'address', address: ADDR });
  });

  it('lower-cases an all-upper payload', () => {
    expect(parseQrPayload(ADDR.toUpperCase())).toEqual({ kind: 'address', address: ADDR });
  });

  it('leaves mixed case alone for the validator to refuse', () => {
    // bech32m forbids mixed case; the plausibility gate must not "fix" it, and
    // an address is never read as a name because no label may hold `_`.
    expect(parseQrPayload(`mn_addr_preview1X${ADDR.slice(17)}`)).toBeNull();
  });

  it('unwraps a midnight: URI, with or without the slashes', () => {
    expect(parseQrPayload(`midnight:${ADDR}`)).toEqual({ kind: 'address', address: ADDR });
    expect(parseQrPayload(`midnight://${ADDR}?amount=5`)).toEqual({ kind: 'address', address: ADDR });
  });

  it('reads other mn_ kinds, for the validator to name', () => {
    const shielded = 'mn_shield-addr_preview1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    expect(parseQrPayload(shielded)).toEqual({ kind: 'address', address: shielded });
  });
});

describe('parseQrPayload — everything else keeps the camera scanning', () => {
  it('refuses other URI schemes', () => {
    expect(parseQrPayload(`https://example.com/${ADDR}`)).toBeNull();
    expect(parseQrPayload('mailto:someone@example.com')).toBeNull();
  });

  it('refuses arbitrary text, Wi-Fi configs, and empty reads', () => {
    expect(parseQrPayload('')).toBeNull();
    expect(parseQrPayload('   ')).toBeNull();
    expect(parseQrPayload('WIFI:T:WPA;S:cafe;P:secret;;')).toBeNull();
    expect(parseQrPayload('hello world')).toBeNull();
  });

  it('refuses an mn_ fragment with no separator or data', () => {
    expect(parseQrPayload('mn_addr_preview')).toBeNull();
    expect(parseQrPayload('mn_')).toBeNull();
  });
});
