/**
 * The signed redirect channel, verified against REAL signatures.
 *
 * The curve is not mocked. A mocked verifier proves nothing about a verifier,
 * and this is the one place in the package where being wrong means accepting a
 * forged reply — so every reply below is signed with an actual BIP-340 key,
 * and the forgeries are actual forgeries.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  PASSPORT_CALLBACK_PROTOCOL,
  PASSPORT_CALLBACK_SIGNATURE_SCHEME,
  buildPassportLaunchUrl,
  createPassportNonceLedger,
  newPassportState,
  parsePassportCallbackProfilePayload,
  parsePassportCallbackReturn,
  passportCallbackErrorMessage,
  passportUnshieldedAddressFromKey,
  readPassportCallback,
  rememberPassportState,
  takePassportState,
  toBase64Url,
  verifyPassportCallbackReply,
  verifyPassportKeyBinding,
  verifyPassportSignature,
  fromBase64Url,
  type PassportCallbackEnvelope,
} from '../src/redirect/index.js';
import { bech32m } from '@scure/base';
import { PassportProtocolError } from '../src/protocol/errors.js';
import { installFakeDom, removeFakeDom } from './domStub.js';

const AUDIENCE = 'https://doorman.example';
const SECRET_KEY = new Uint8Array(32).fill(7);
const PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(SECRET_KEY));

function signBytes(bytes: Uint8Array, key = SECRET_KEY): string {
  /* Exactly what Passport's keystore does: BIP-340 over sha256(payload). */
  return bytesToHex(schnorr.sign(sha256(bytes), key));
}

function seal(payload: object, options?: { key?: Uint8Array; unsigned?: boolean; publicKey?: string }): {
  envelope: PassportCallbackEnvelope;
  encoded: string;
} {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const encoded = toBase64Url(bytes);
  if (options?.unsigned) {
    return {
      encoded,
      envelope: {
        protocol: PASSPORT_CALLBACK_PROTOCOL,
        type: 'passport.callback.response',
        payload: encoded,
        scheme: 'none',
      },
    };
  }
  return {
    encoded,
    envelope: {
      protocol: PASSPORT_CALLBACK_PROTOCOL,
      type: 'passport.callback.response',
      payload: encoded,
      scheme: PASSPORT_CALLBACK_SIGNATURE_SCHEME,
      publicKey: options?.publicKey ?? PUBLIC_KEY,
      signature: signBytes(bytes, options?.key),
    },
  };
}

const NOW = 1_800_000_000_000;

function profilePayload(patch: Record<string, unknown> = {}) {
  return {
    protocol: PASSPORT_CALLBACK_PROTOCOL,
    type: 'passport.callback.profile',
    version: 1,
    audience: AUDIENCE,
    state: 'state-1',
    issuedAt: NOW - 4_000,
    nonce: 'nonce-1',
    fields: ['displayName', 'passportContract'],
    profile: {
      displayName: 'Alice',
      passportContract: { address: 'mn_shield_addr_stagenet1qq', network: 'stagenet' },
    },
    ...patch,
  };
}

const OPTIONS = { expectedAudience: AUDIENCE, expectedState: 'state-1', now: NOW };

describe('the launch', () => {
  it('builds a URL with the fields and the state on it', () => {
    const url = new URL(
      buildPassportLaunchUrl({
        passportOrigin: 'https://midnightpassport.example/anything',
        callbackUrl: 'https://doorman.example/return?table=7',
        fields: ['displayName', 'passportContract'],
        state: 'state-1',
      }),
    );
    expect(url.origin).toBe('https://midnightpassport.example');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('passportCallback')).toBe('https://doorman.example/return?table=7');
    expect(url.searchParams.get('passportFields')).toBe('displayName,passportContract');
    expect(url.searchParams.get('passportState')).toBe('state-1');
  });

  it('refuses a launch that says nothing about what it wants', () => {
    /* Inventing a default would silently share more than the app asked for. */
    expect(() =>
      buildPassportLaunchUrl({
        passportOrigin: 'https://p.example',
        callbackUrl: 'https://doorman.example/',
        fields: [],
        state: 's',
      }),
    ).toThrow(PassportProtocolError);
    expect(() =>
      buildPassportLaunchUrl({
        passportOrigin: 'https://p.example',
        callbackUrl: 'https://doorman.example/',
        fields: ['displayName'],
        state: 's'.repeat(257),
      }),
    ).toThrow(/at most 256/);
  });

  it('mints unguessable state tokens', () => {
    expect(newPassportState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newPassportState()).not.toBe(newPassportState());
  });
});

describe('the return, off the fragment', () => {
  it('reads a signed reply, an error, an absence, and every malformation', () => {
    const { envelope } = seal(profilePayload());
    const fragment = `#passportResponse=${toBase64Url(
      new TextEncoder().encode(JSON.stringify(envelope)),
    )}`;
    expect(parsePassportCallbackReturn(fragment)).toEqual({ kind: 'response', envelope });
    expect(parsePassportCallbackReturn('passportError=denied&passportState=s')).toEqual({
      kind: 'error',
      code: 'denied',
      state: 's',
    });
    expect(parsePassportCallbackReturn('#passportError=denied')).toMatchObject({ state: null });
    expect(parsePassportCallbackReturn('')).toEqual({ kind: 'absent' });
    expect(parsePassportCallbackReturn('#passportResponse=not!base64url')).toMatchObject({
      kind: 'malformed',
      reason: expect.stringContaining('base64url'),
    });
  });

  it('names each malformation rather than saying only that something failed', () => {
    const wrap = (value: unknown) =>
      `#passportResponse=${toBase64Url(new TextEncoder().encode(JSON.stringify(value)))}`;
    expect(parsePassportCallbackReturn(`#passportResponse=${toBase64Url(new TextEncoder().encode('{'))}`))
      .toMatchObject({ reason: 'the reply is not JSON' });
    expect(parsePassportCallbackReturn(wrap([1]))).toMatchObject({
      reason: 'the reply is not an object',
    });
    expect(parsePassportCallbackReturn(wrap({ protocol: 'org.evil/v1' }))).toMatchObject({
      reason: 'the reply is not this protocol',
    });
    expect(
      parsePassportCallbackReturn(wrap({ protocol: PASSPORT_CALLBACK_PROTOCOL, type: 'nope' })),
    ).toMatchObject({ reason: 'the reply is not a response' });
    expect(
      parsePassportCallbackReturn(
        wrap({ protocol: PASSPORT_CALLBACK_PROTOCOL, type: 'passport.callback.response' }),
      ),
    ).toMatchObject({ reason: 'the reply carries no payload' });
    expect(
      parsePassportCallbackReturn(
        wrap({
          protocol: PASSPORT_CALLBACK_PROTOCOL,
          type: 'passport.callback.response',
          payload: 'x',
          scheme: 'ed25519',
        }),
      ),
    ).toMatchObject({ reason: expect.stringContaining('cannot check') });
    expect(
      parsePassportCallbackReturn(
        wrap({
          protocol: PASSPORT_CALLBACK_PROTOCOL,
          type: 'passport.callback.response',
          payload: 'x',
          scheme: PASSPORT_CALLBACK_SIGNATURE_SCHEME,
          publicKey: 'short',
          signature: 'short',
        }),
      ),
    ).toMatchObject({ reason: 'the signature or key is malformed' });
  });

  it('accepts a stated downgrade to unsigned as a shape, and leaves the decision to the verifier', () => {
    const { envelope } = seal(profilePayload(), { unsigned: true });
    const parsed = parsePassportCallbackReturn(
      `#passportResponse=${toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)))}`,
    );
    expect(parsed).toMatchObject({ kind: 'response' });
    expect(parsed.kind === 'response' && parsed.envelope.scheme).toBe('none');
  });
});

describe('the crypto', () => {
  it('verifies a real signature and refuses a real forgery', () => {
    const bytes = new TextEncoder().encode('anything');
    expect(verifyPassportSignature(PUBLIC_KEY, bytes, signBytes(bytes))).toBe(true);
    const other = new Uint8Array(32).fill(9);
    expect(verifyPassportSignature(PUBLIC_KEY, bytes, signBytes(bytes, other))).toBe(false);
  });

  it('refuses base64url that is the right alphabet and the wrong length', () => {
    /* The alphabet check passes and `atob` still throws: five characters
       cannot be re-padded into a whole number of base64 quartets. */
    expect(fromBase64Url('AAAAA')).toBeNull();
    expect(fromBase64Url('')).toBeNull();
    expect(fromBase64Url('has spaces')).toBeNull();
    expect(fromBase64Url(toBase64Url(new Uint8Array([1, 2, 3])))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('refuses an address whose data cannot be unpacked into bytes', () => {
    /* Right encoding, right prefix, and a word count that leaves non-zero
       padding — `fromWords` refuses it, and so must the binding. */
    expect(verifyPassportKeyBinding(PUBLIC_KEY, bech32m.encode('mn_addr', [31], 512))).toBe(false);
  });

  it('derives the address a verifying key controls, and binds one to it', () => {
    const address = passportUnshieldedAddressFromKey(PUBLIC_KEY);
    expect(address.startsWith('mn_addr1')).toBe(true);
    expect(verifyPassportKeyBinding(PUBLIC_KEY, address)).toBe(true);

    const networked = passportUnshieldedAddressFromKey(PUBLIC_KEY, 'stagenet');
    expect(networked.startsWith('mn_addr_stagenet1')).toBe(true);
    expect(verifyPassportKeyBinding(PUBLIC_KEY, networked)).toBe(true);

    const stranger = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(9)));
    expect(verifyPassportKeyBinding(stranger, address)).toBe(false);
  });

  it('refuses anything that is not a Midnight unshielded address', () => {
    expect(verifyPassportKeyBinding(PUBLIC_KEY, 'not-bech32m')).toBe(false);
    /* Right encoding, wrong human-readable part: an address whose type is not
       `addr` is not one this check may pass. */
    expect(
      verifyPassportKeyBinding(
        PUBLIC_KEY,
        bech32m.encode('mn_shield', bech32m.toWords(sha256(hexToBytes(PUBLIC_KEY))), 512),
      ),
    ).toBe(false);
    /* Right prefix, wrong payload length: 16 bytes where 32 are required. */
    expect(
      verifyPassportKeyBinding(
        PUBLIC_KEY,
        bech32m.encode('mn_addr', bech32m.toWords(new Uint8Array(16)), 512),
      ),
    ).toBe(false);
    /* A key that is not hex at all cannot be hashed. */
    expect(verifyPassportKeyBinding('zz', passportUnshieldedAddressFromKey(PUBLIC_KEY))).toBe(false);
  });
});

describe('the verification walk', () => {
  it('accepts a good reply and shows its work', () => {
    const { envelope } = seal(profilePayload());
    const verdict = verifyPassportCallbackReply(envelope, OPTIONS);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.signed).toBe(true);
    expect(verdict.ok && verdict.payload.profile.displayName).toBe('Alice');
    expect(verdict.checks.every((check) => check.ok)).toBe(true);
    expect(verdict.checks.map((check) => check.label)).toEqual([
      'Payload decodes as base64url',
      'BIP-340 signature over sha256(payload)',
      'Payload is a well-formed reply',
      'Audience is this app',
      'State echoes what was sent',
      'Issued recently',
      'Nonce not seen before',
      'Signing key is the Passport this app already knows',
    ]);
    expect(verdict.signerKey).toBe(PUBLIC_KEY);
  });

  it('stops at the first failure, and never claims to have checked what it skipped', () => {
    const { envelope } = seal(profilePayload());
    const tampered = { ...envelope, payload: toBase64Url(new TextEncoder().encode('{"a":1}')) };
    const verdict = verifyPassportCallbackReply(tampered, OPTIONS);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/signature does not match/);
    expect(verdict.checks).toHaveLength(2);
    expect(verdict.checks.at(-1)!.ok).toBe(false);
  });

  it('refuses a reply for a different origin', () => {
    const { envelope } = seal(profilePayload({ audience: 'https://evil.example' }));
    const verdict = verifyPassportCallbackReply(envelope, OPTIONS);
    expect(verdict.ok === false && verdict.reason).toMatch(/different origin/);
  });

  it('refuses a reply that does not echo the state that was sent', () => {
    const { envelope } = seal(profilePayload({ state: 'somebody-elses' }));
    expect(verifyPassportCallbackReply(envelope, OPTIONS).ok).toBe(false);
    /* And the mirror: a reply with no state at all when one was sent. */
    const { envelope: bare } = seal(profilePayload({ state: undefined }));
    expect(verifyPassportCallbackReply(bare, OPTIONS).ok).toBe(false);
    /* A launch that genuinely sent no state accepts a reply with none. */
    expect(
      verifyPassportCallbackReply(bare, { ...OPTIONS, expectedState: null }).ok,
    ).toBe(true);
  });

  it('refuses a stale reply and a reply dated in the future', () => {
    const stale = seal(profilePayload({ issuedAt: NOW - 6 * 60_000 }));
    const verdict = verifyPassportCallbackReply(stale.envelope, OPTIONS);
    expect(verdict.ok === false && verdict.reason).toBe('the reply is too old');

    const future = seal(profilePayload({ issuedAt: NOW + 5 * 60_000 }));
    const ahead = verifyPassportCallbackReply(future.envelope, OPTIONS);
    expect(ahead.ok === false && ahead.reason).toBe('the reply is dated in the future');

    /* A minute of forward tolerance absorbs ordinary clock skew. */
    const skewed = seal(profilePayload({ issuedAt: NOW + 30_000 }));
    expect(verifyPassportCallbackReply(skewed.envelope, OPTIONS).ok).toBe(true);
    /* And the window is configurable for a receiver that wants a tighter one. */
    expect(
      verifyPassportCallbackReply(seal(profilePayload({ issuedAt: NOW - 4_000 })).envelope, {
        ...OPTIONS,
        maxAgeMs: 1_000,
      }).ok,
    ).toBe(false);
  });

  it('reads the clock itself when the caller does not pin one', () => {
    /* Production callers pass no `now`. A reply issued a moment ago against
       the real clock must still verify. */
    const { envelope } = seal(profilePayload({ issuedAt: Date.now() - 1_000 }));
    expect(
      verifyPassportCallbackReply(envelope, {
        expectedAudience: AUDIENCE,
        expectedState: 'state-1',
      }).ok,
    ).toBe(true);
  });

  it('refuses a nonce it has already accepted', () => {
    const { envelope } = seal(profilePayload());
    const verdict = verifyPassportCallbackReply(envelope, {
      ...OPTIONS,
      seenNonce: (nonce) => nonce === 'nonce-1',
    });
    expect(verdict.ok === false && verdict.reason).toMatch(/already been used/);
  });

  it('refuses an unsigned reply unless the app said it would accept one', () => {
    const { envelope } = seal(profilePayload(), { unsigned: true });
    const refused = verifyPassportCallbackReply(envelope, OPTIONS);
    expect(refused.ok === false && refused.reason).toMatch(/unsigned/);

    const accepted = verifyPassportCallbackReply(envelope, {
      ...OPTIONS,
      requireSignature: false,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.ok && accepted.signed).toBe(false);
    expect(accepted.checks.at(-1)!.detail).toMatch(/unsigned/);
    expect(accepted.signerKey).toBeUndefined();
  });

  it('refuses a reply that claims a signature it does not carry', () => {
    const { envelope } = seal(profilePayload());
    const verdict = verifyPassportCallbackReply(
      { ...envelope, publicKey: undefined },
      OPTIONS,
    );
    expect(verdict.ok === false && verdict.reason).toMatch(/claims a signature/);
  });

  it('reports a key the curve cannot even parse as a failed check, not a crash', () => {
    const { envelope } = seal(profilePayload());
    const verdict = verifyPassportCallbackReply({ ...envelope, publicKey: 'zz'.repeat(32) }, OPTIONS);
    expect(verdict.ok === false && verdict.reason).toMatch(/could not be checked/);
  });

  it('refuses a payload that is not base64url, and one that is not JSON', () => {
    const notBase64 = verifyPassportCallbackReply(
      { ...seal(profilePayload()).envelope, payload: 'not!base64url', scheme: 'none' },
      { ...OPTIONS, requireSignature: false },
    );
    expect(notBase64.ok === false && notBase64.reason).toMatch(/not base64url/);

    const notJson = verifyPassportCallbackReply(
      {
        protocol: PASSPORT_CALLBACK_PROTOCOL,
        type: 'passport.callback.response',
        payload: toBase64Url(new TextEncoder().encode('{')),
        scheme: 'none',
      },
      { ...OPTIONS, requireSignature: false },
    );
    expect(notJson.ok === false && notJson.reason).toMatch(/not JSON/);
  });

  it('refuses every malformed payload shape', () => {
    for (const patch of [
      { protocol: 'org.evil/v1' },
      { type: 'passport.callback.tx' },
      { version: 2 },
      { version: '1' },
      { version: 1.5 },
      { audience: '' },
      { issuedAt: 'now' },
      { nonce: '' },
      { state: 42 },
      { fields: [] },
      { fields: ['displayName', 'midnightAddresses'] },
      { fields: 'displayName' },
      { profile: 'Alice' },
      { profile: { displayName: 'n'.repeat(257) } },
      { profile: { displayName: 42 } },
      { profile: { passportContract: 'x' } },
      { profile: { passportContract: { address: 'a'.repeat(513), network: 'stagenet' } } },
      { profile: { passportContract: { address: 'a', network: 'n'.repeat(257) } } },
      { profile: { passportContract: { address: 'a' } } },
    ]) {
      const { envelope } = seal(profilePayload(patch), { unsigned: true });
      const verdict = verifyPassportCallbackReply(envelope, {
        ...OPTIONS,
        requireSignature: false,
      });
      expect(verdict.ok, JSON.stringify(patch)).toBe(false);
    }
    expect(parsePassportCallbackProfilePayload('nope')).toBeNull();
  });

  it('binds the key to a Passport this app has met before', () => {
    const known = passportUnshieldedAddressFromKey(PUBLIC_KEY);
    const { envelope } = seal(profilePayload());
    const matched = verifyPassportCallbackReply(envelope, {
      ...OPTIONS,
      expectedSignerAddress: known,
    });
    expect(matched.ok).toBe(true);
    expect(matched.checks.at(-1)).toMatchObject({
      label: 'Signing key is the Passport this app already knows',
      ok: true,
    });

    const stranger = passportUnshieldedAddressFromKey(
      bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(9))),
    );
    const mismatched = verifyPassportCallbackReply(envelope, {
      ...OPTIONS,
      expectedSignerAddress: stranger,
    });
    expect(mismatched.ok === false && mismatched.reason).toMatch(/different Passport/);
  });

  it('says plainly that a first visit had nothing to bind to', () => {
    const { envelope } = seal(profilePayload());
    const verdict = verifyPassportCallbackReply(envelope, OPTIONS);
    expect(verdict.checks.at(-1)!.detail).toMatch(/first visit/);
  });
});

describe('the receiver’s bookkeeping', () => {
  afterEach(removeFakeDom);

  function signedFragment(): string {
    const { envelope } = seal(profilePayload());
    return `#passportResponse=${toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)))}`;
  }

  it('remembers a state token and consumes it on the way back', () => {
    installFakeDom();
    rememberPassportState('doorman', 'state-1');
    expect(takePassportState('doorman')).toBe('state-1');
    /* Consumed: a token answers exactly one launch, so the back button cannot
       re-verify a reply that has already been used. */
    expect(takePassportState('doorman')).toBeNull();
  });

  it('survives storage operations that throw as well as an accessor that does', () => {
    /* Two different failures with the same right answer: an accessor that
       throws (Safari, private mode) and an operation that throws (a full
       quota). Neither may take the flow down. */
    installFakeDom({ storageOperationsThrow: true });
    expect(() => rememberPassportState('doorman', 'state-1')).not.toThrow();
    expect(takePassportState('doorman')).toBeNull();
  });

  it('survives a browser that refuses storage rather than dying on the phone', () => {
    /* Safari in private mode throws on the accessor itself, and this flow
       exists FOR a phone — a version of it that died there would be useless. */
    installFakeDom({ sessionStorageThrows: true });
    expect(() => rememberPassportState('doorman', 'state-1')).not.toThrow();
    expect(takePassportState('doorman')).toBeNull();
    removeFakeDom();
    expect(() => rememberPassportState('doorman', 'state-1')).not.toThrow();
    expect(takePassportState('doorman')).toBeNull();
  });

  it('records nonces across sessions and refuses one twice', () => {
    installFakeDom();
    const ledger = createPassportNonceLedger({ key: 'test.nonces', limit: 3 });
    expect(ledger.seen('a')).toBe(false);
    ledger.record('a');
    expect(ledger.seen('a')).toBe(true);
    /* Bounded, and the oldest goes first. */
    ledger.record('b');
    ledger.record('c');
    ledger.record('d');
    expect(ledger.seen('a')).toBe(false);
    expect(ledger.seen('d')).toBe(true);
    /* Recording the same nonce twice does not consume two slots. */
    ledger.record('d');
    expect(ledger.seen('b')).toBe(true);
  });

  it('degrades to "nothing seen" rather than throwing when the ledger is unusable', () => {
    installFakeDom();
    window.localStorage.setItem('broken.nonces', 'not json');
    const ledger = createPassportNonceLedger({ key: 'broken.nonces' });
    expect(ledger.seen('a')).toBe(false);
    window.localStorage.setItem('broken.nonces', '{"not":"an array"}');
    expect(ledger.seen('a')).toBe(false);
    ledger.record('a');
    expect(ledger.seen('a')).toBe(true);
    /* The default key exists and is empty on a fresh page. */
    expect(createPassportNonceLedger().seen('never-recorded')).toBe(false);

    /* And with no storage at all: nothing is remembered, nothing throws. The
       signature, audience, state, and freshness checks all still hold; only
       the once-per-window guarantee is lost. */
    removeFakeDom();
    const blind = createPassportNonceLedger();
    expect(() => blind.record('a')).not.toThrow();
    expect(blind.seen('a')).toBe(false);

    installFakeDom({ localStorageThrows: true });
    const refused = createPassportNonceLedger();
    expect(() => refused.record('a')).not.toThrow();
    expect(refused.seen('a')).toBe(false);
  });

  it('reads a reply out of the current fragment and scrubs the address bar', () => {
    const fragment = signedFragment();
    const dom = installFakeDom({ href: `https://doorman.example/return?table=7${fragment}` });
    expect(dom.location.hash).not.toBe('');

    expect(readPassportCallback()).toMatchObject({ kind: 'response' });
    /* Scrubbed, so a reload does nothing rather than re-running the flow, and
       the app's own query string survives. */
    expect(dom.location.hash).toBe('');
    expect(dom.location.search).toBe('?table=7');

    /* An absent reply leaves the URL alone — there is nothing to scrub. */
    expect(readPassportCallback()).toEqual({ kind: 'absent' });
    /* And a caller that wants the fragment kept says so. */
    dom.navigate(`/return${fragment}`);
    expect(readPassportCallback({ hash: fragment, scrub: false })).toMatchObject({
      kind: 'response',
    });
    expect(dom.location.hash).not.toBe('');
  });

  it('still returns the reply when the address bar cannot be scrubbed', () => {
    const fragment = signedFragment();
    const dom = installFakeDom({
      href: `https://doorman.example/return${fragment}`,
      replaceStateThrows: true,
    });
    expect(readPassportCallback()).toMatchObject({ kind: 'response' });
    /* The reply is already in memory; all that is lost is the tidy URL. */
    expect(dom.location.hash).not.toBe('');
  });

  it('reads nothing, and scrubs nothing, where there is no window at all', () => {
    removeFakeDom();
    expect(readPassportCallback()).toEqual({ kind: 'absent' });
    expect(readPassportCallback({ hash: signedFragment() })).toMatchObject({ kind: 'response' });
  });

  it('reuses the SDK’s own sentences for an unauthenticated refusal', () => {
    expect(passportCallbackErrorMessage('denied')).toMatch(/declined/);
    expect(passportCallbackErrorMessage('profile_unavailable')).toMatch(/no profile/);
  });
});
