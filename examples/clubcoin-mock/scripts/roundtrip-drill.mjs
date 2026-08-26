/* ===========================================================================
 * The URL-callback round trip, drilled in Node
 * ===========================================================================
 *
 * Run:  node examples/clubcoin-mock/scripts/roundtrip-drill.mjs
 *   or: npm test  (from examples/clubcoin-mock)
 *
 * WHAT THIS IS FOR. The contract has two independent implementations — the
 * writer in `examples/passport-demo/src/identity/callbackProtocol.ts` and the
 * receiver in `examples/clubcoin-mock/src/passportCallback.ts` — and the whole
 * design rests on them agreeing about BYTES. A drill that exercised only one
 * side would prove nothing about the thing most likely to break.
 *
 * So both are bundled with esbuild (they are TypeScript; Node is not) and run
 * against each other, with a REAL Midnight signer in the middle:
 * `@midnight-ntwrk/ledger-v8` produces the signature exactly as
 * `unshieldedKeystore.signData` does in the browser, and the receiver verifies
 * it with `@noble/curves` and `@scure/base` alone. If those two ever disagree
 * about the pre-hash, the curve, or the address derivation, this fails.
 *
 * WHAT IT CANNOT COVER: the WebAuthn ceremony and the onboarding navigation.
 * Those need a human with a device — see the report accompanying this change.
 * ========================================================================= */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';
import { signData, signatureVerifyingKey, addressFromKey } from '@midnight-ntwrk/ledger-v8';
import { UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/curves/utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * Bundles one TypeScript module into a self-contained ESM file Node can
 * import. `packages: 'bundle'` (esbuild's default) inlines `@noble` and
 * `@scure`, so the output runs from a temporary directory with no
 * `node_modules` beside it.
 */
async function bundle(entry, outDir, name) {
  const outfile = path.join(outDir, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

const outDir = await mkdtemp(path.join(tmpdir(), 'passport-callback-drill-'));
/* A package marker, so the bundles are loaded as ESM regardless of extension
   handling in whatever Node is running this. */
await writeFile(path.join(outDir, 'package.json'), '{"type":"module"}');

const passport = await bundle(
  path.join(repoRoot, 'examples/passport-demo/src/identity/callbackProtocol.ts'),
  outDir,
  'passport',
);
const receiver = await bundle(
  path.join(repoRoot, 'examples/clubcoin-mock/src/passportCallback.ts'),
  outDir,
  'receiver',
);

/* ---------------------------------------------------------------------------
 * A real Midnight signer, standing in for `wallet.keys.unshieldedKeystore`
 * ------------------------------------------------------------------------ */

const NETWORK_ID = 'undeployed';
const secretKey = Buffer.alloc(32, 11).toString('hex');
const verifyingKey = signatureVerifyingKey(secretKey);
const unshieldedAddress = UnshieldedAddress.codec
  .encode(NETWORK_ID, new UnshieldedAddress(Buffer.from(addressFromKey(verifyingKey), 'hex')))
  .asString();

/** Structurally what `callbackConsent.tsx` builds from the live keystore. */
const signer = {
  publicKey: verifyingKey,
  sign: (bytes) => signData(secretKey, bytes),
};

const PASSPORT_ORIGIN = 'https://midnightpassport.com';
const CLUB_ORIGIN = 'https://clubcoin.example';
const CLUB_CALLBACK = `${CLUB_ORIGIN}/return`;
const STATE = 'club-state-token-01';

function launchSearch(overrides = {}) {
  const parameters = new URLSearchParams({
    passportCallback: CLUB_CALLBACK,
    passportFields: 'displayName,midnightAddresses',
    passportState: STATE,
    ...overrides,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) parameters.delete(key);
  }
  return `?${parameters.toString()}`;
}

function okLaunch(search = launchSearch()) {
  const parse = passport.parsePassportCallbackLaunch(search);
  assert.equal(parse.kind, 'ok', `expected a valid launch, got ${JSON.stringify(parse)}`);
  return parse.launch;
}

const PROFILE_SOURCE = {
  displayName: 'alice.night',
  passportContract: { address: '0200deadbeef', network: 'undeployed' },
  midnightAddresses: { unshielded: unshieldedAddress, shielded: 'mn_shield-addr_undeployed1qqq' },
};

/** Everything Passport does between "Share" being tapped and `location.assign`. */
function approve(launch, { now, profileSource = PROFILE_SOURCE, withSigner = true } = {}) {
  const profile = passport.selectPassportCallbackProfile(launch.fields, {
    displayName: profileSource.displayName ?? null,
    passportContract: profileSource.passportContract ?? null,
    midnightAddresses: profileSource.midnightAddresses ?? null,
  });
  const built = passport.buildPassportCallbackPayload({ launch, profile, now });
  const envelope = passport.sealPassportCallbackResponse(
    built.encoded,
    built.bytes,
    withSigner ? signer : null,
  );
  return { href: passport.passportCallbackSuccessUrl(launch, envelope), built, envelope };
}

/** Everything ClubCoin does on arrival, up to the verdict. */
function receive(href, options = {}) {
  const url = new URL(href);
  const arrival = receiver.parsePassportCallbackReturn(url.hash);
  assert.equal(arrival.kind, 'response', `expected a response fragment, got ${arrival.kind}`);
  return receiver.verifyPassportCallbackReply(arrival.envelope, {
    expectedAudience: CLUB_ORIGIN,
    expectedState: STATE,
    ...options,
  });
}

/* ---------------------------------------------------------------------------
 * 1. The launch contract
 * ------------------------------------------------------------------------ */

test('a well-formed launch parses, and the origin is derived from the callback', () => {
  const launch = okLaunch();
  assert.equal(launch.callbackUrl, CLUB_CALLBACK);
  assert.equal(launch.callbackOrigin, CLUB_ORIGIN);
  assert.deepEqual([...launch.fields], ['displayName', 'midnightAddresses']);
  assert.equal(launch.state, STATE);
});

test('http is refused, except on loopback for development', () => {
  assert.equal(
    passport.parsePassportCallbackLaunch(
      launchSearch({ passportCallback: 'http://clubcoin.example/return' }),
    ).problem,
    'callback-insecure',
  );
  for (const host of ['localhost:5181', '127.0.0.1:5181', '[::1]:5181']) {
    assert.equal(
      passport.parsePassportCallbackLaunch(
        launchSearch({ passportCallback: `http://${host}/` }),
      ).kind,
      'ok',
      host,
    );
  }
});

test('a relative, credentialled, over-long, or fragment-bearing callback is refused', () => {
  const cases = {
    '/return': 'callback-unparsable',
    'https://user:pw@clubcoin.example/': 'callback-has-credentials',
    'https://clubcoin.example/#already': 'callback-has-fragment',
    [`https://clubcoin.example/${'x'.repeat(2100)}`]: 'callback-too-long',
  };
  for (const [callback, problem] of Object.entries(cases)) {
    const parse = passport.parsePassportCallbackLaunch(launchSearch({ passportCallback: callback }));
    assert.equal(parse.kind, 'malformed', callback);
    assert.equal(parse.problem, problem, callback);
  }
});

test('the field list must be present and inside the profile vocabulary', () => {
  assert.equal(
    passport.parsePassportCallbackLaunch(launchSearch({ passportFields: null })).problem,
    'fields-missing',
  );
  assert.equal(
    passport.parsePassportCallbackLaunch(launchSearch({ passportFields: '  ' })).problem,
    'fields-missing',
  );
  /* A list that is non-empty as a STRING but empty once split and trimmed.
     It used to survive parsing and produce a signed reply with no fields —
     which every receiver refuses — so it is rejected at the launch instead. */
  assert.equal(
    passport.parsePassportCallbackLaunch(launchSearch({ passportFields: ',' })).problem,
    'fields-missing',
  );
  assert.equal(
    passport.parsePassportCallbackLaunch(launchSearch({ passportFields: ' , ' })).problem,
    'fields-missing',
  );
  const unknown = passport.parsePassportCallbackLaunch(
    launchSearch({ passportFields: 'displayName,privateState' }),
  );
  assert.equal(unknown.problem, 'fields-unknown');
  /* Named, so the developer who mistyped it can see which one. */
  assert.match(unknown.message, /privateState/);
});

test('duplicate fields collapse and the order follows the vocabulary', () => {
  const launch = okLaunch(
    launchSearch({ passportFields: 'midnightAddresses,displayName,midnightAddresses' }),
  );
  assert.deepEqual([...launch.fields], ['displayName', 'midnightAddresses']);
});

test('a state token over 256 characters is refused, and an absent one is allowed', () => {
  assert.equal(
    passport.parsePassportCallbackLaunch(launchSearch({ passportState: 'x'.repeat(257) })).problem,
    'state-too-long',
  );
  assert.equal(passport.parsePassportCallbackLaunch(launchSearch({ passportState: null })).launch.state, null);
});

test('no passportCallback at all is not a callback launch', () => {
  assert.equal(passport.parsePassportCallbackLaunch('?demoMode=local').kind, 'absent');
});

/* ---------------------------------------------------------------------------
 * 2. The signed round trip
 * ------------------------------------------------------------------------ */

test('a real Midnight signature survives the fragment and verifies in pure JS', () => {
  const launch = okLaunch();
  const { href, envelope } = approve(launch);

  assert.equal(envelope.scheme, 'bip340-schnorr-secp256k1-sha256');
  assert.equal(envelope.publicKey, verifyingKey);
  assert.equal(envelope.signature.length, 128);

  /* The reply is in the FRAGMENT and nowhere else. This is the property the
     whole design turns on: a fragment never reaches ClubCoin's server. */
  const url = new URL(href);
  assert.equal(url.origin + url.pathname, CLUB_CALLBACK);
  assert.equal(url.search, '');
  assert.match(url.hash, /^#passportResponse=/);

  const verdict = receive(href);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.signed, true);
  assert.equal(verdict.payload.audience, CLUB_ORIGIN);
  assert.equal(verdict.payload.state, STATE);
  assert.equal(verdict.payload.profile.displayName, 'alice.night');
  assert.equal(verdict.payload.profile.midnightAddresses.unshielded, unshieldedAddress);
  /* Only what was asked for. `passportContract` was in the source and NOT in
     the field list, so it must not have travelled. */
  assert.equal(verdict.payload.profile.passportContract, undefined);
  assert.ok(verdict.checks.every((check) => check.ok));
});

test('the SDK signer and the pure-JS verifier agree on the pre-hash', () => {
  const message = new TextEncoder().encode('a payload standing in for the envelope');
  const signature = signData(secretKey, message);
  /* sha256 first — this is the fact the receiver is built on. */
  assert.equal(
    schnorr.verify(hexToBytes(signature), sha256(message), hexToBytes(verifyingKey)),
    true,
  );
  /* And the raw message is NOT what was signed, so a verifier that forgets the
     pre-hash fails closed rather than silently accepting. */
  assert.equal(schnorr.verify(hexToBytes(signature), message, hexToBytes(verifyingKey)), false);
});

test('the signing key is bound to the unshielded address inside the payload', () => {
  assert.equal(receiver.verifyPassportKeyBinding(verifyingKey, unshieldedAddress), true);

  /* A different key over the same address must fail: without this check a
     signature proves only that somebody signed something. */
  const otherKey = signatureVerifyingKey(Buffer.alloc(32, 12).toString('hex'));
  assert.equal(receiver.verifyPassportKeyBinding(otherKey, unshieldedAddress), false);

  /* And it must fail end to end, not merely in the helper. */
  const launch = okLaunch();
  const { built } = approve(launch);
  const impostorSecret = Buffer.alloc(32, 12).toString('hex');
  const forged = passport.sealPassportCallbackResponse(built.encoded, built.bytes, {
    publicKey: otherKey,
    sign: (bytes) => signData(impostorSecret, bytes),
  });
  const verdict = receiver.verifyPassportCallbackReply(forged, {
    expectedAudience: CLUB_ORIGIN,
    expectedState: STATE,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /does not own the shared address/);
});

test('a tampered payload fails, even though the fragment is still well formed', () => {
  const launch = okLaunch();
  const { href } = approve(launch);
  const arrival = receiver.parsePassportCallbackReturn(new URL(href).hash);

  const bytes = receiver.fromBase64Url(arrival.envelope.payload);
  const text = new TextDecoder().decode(bytes).replace('alice.night', 'mallory.nite');
  assert.notEqual(text, new TextDecoder().decode(bytes));
  const tampered = {
    ...arrival.envelope,
    payload: receiver.toBase64Url(new TextEncoder().encode(text)),
  };

  const verdict = receiver.verifyPassportCallbackReply(tampered, {
    expectedAudience: CLUB_ORIGIN,
    expectedState: STATE,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /signature does not match/);
});

/* ---------------------------------------------------------------------------
 * 3. The bindings that hold without cryptography
 * ------------------------------------------------------------------------ */

test('a reply issued for another origin is refused', () => {
  const other = okLaunch(launchSearch({ passportCallback: 'https://evil.example/return' }));
  const { href } = approve(other);
  /* ClubCoin fishes the fragment out of a reply meant for someone else. */
  const fragment = new URL(href).hash;
  const arrival = receiver.parsePassportCallbackReturn(fragment);
  const verdict = receiver.verifyPassportCallbackReply(arrival.envelope, {
    expectedAudience: CLUB_ORIGIN,
    expectedState: STATE,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /different origin/);
});

test('a reply that does not echo the state is refused', () => {
  const verdict = receive(approve(okLaunch()).href, { expectedState: 'a-different-token' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /echo the state/);
});

test('a stale or future-dated reply is refused', () => {
  const launch = okLaunch();
  const stale = approve(launch, { now: Date.now() - 10 * 60_000 });
  assert.match(receive(stale.href).reason, /too old/);

  const future = approve(launch, { now: Date.now() + 10 * 60_000 });
  assert.match(receive(future.href).reason, /dated in the future/);
});

test('a replayed reply is refused on second sight', () => {
  const { href, built } = approve(okLaunch());
  const first = receive(href);
  assert.equal(first.ok, true);
  const second = receive(href, { seenNonce: (nonce) => nonce === built.payload.nonce });
  assert.equal(second.ok, false);
  assert.match(second.reason, /already been used/);
});

/* ---------------------------------------------------------------------------
 * 4. The honest fallback, and the refusal path
 * ------------------------------------------------------------------------ */

test('an unsigned reply is refused by default and accepted only when asked for', () => {
  const { href } = approve(okLaunch(), { withSigner: false });
  const arrival = receiver.parsePassportCallbackReturn(new URL(href).hash);
  assert.equal(arrival.envelope.scheme, 'none');
  /* Not dressed up: no key and no signature ride along. */
  assert.equal(arrival.envelope.publicKey, undefined);
  assert.equal(arrival.envelope.signature, undefined);

  const refused = receive(href);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /unsigned/);

  const accepted = receive(href, { requireSignature: false });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.signed, false, 'an accepted unsigned reply must not report itself as signed');
});

test('a signer that throws produces an honestly unsigned reply, not a dead end', () => {
  const launch = okLaunch();
  const profile = passport.selectPassportCallbackProfile(launch.fields, {
    displayName: 'alice.night',
    passportContract: null,
    midnightAddresses: PROFILE_SOURCE.midnightAddresses,
  });
  const built = passport.buildPassportCallbackPayload({ launch, profile });
  const envelope = passport.sealPassportCallbackResponse(built.encoded, built.bytes, {
    publicKey: verifyingKey,
    sign: () => {
      throw new Error('keystore closed');
    },
  });
  assert.equal(envelope.scheme, 'none');
});

test('declining redirects with an unauthenticated error and the state echoed in the clear', () => {
  const launch = okLaunch();
  const href = passport.passportCallbackErrorUrl(launch, 'denied');
  const url = new URL(href);
  assert.equal(url.origin + url.pathname, CLUB_CALLBACK);
  const arrival = receiver.parsePassportCallbackReturn(url.hash);
  assert.equal(arrival.kind, 'error');
  assert.equal(arrival.code, 'denied');
  assert.equal(arrival.state, STATE);
});

test('the callback URL keeps its own query and gains only a fragment', () => {
  const launch = okLaunch(
    launchSearch({ passportCallback: 'https://clubcoin.example/return?plan=gold' }),
  );
  const { href } = approve(launch);
  const url = new URL(href);
  assert.equal(url.search, '?plan=gold');
  assert.match(url.hash, /^#passportResponse=/);
});

/* ---------------------------------------------------------------------------
 * 5. The two implementations agree
 * ------------------------------------------------------------------------ */

test("Passport's own verifier and ClubCoin's copy reach the same verdict", () => {
  const { href, envelope } = approve(okLaunch());
  const mine = passport.verifyPassportCallbackResponse(envelope, {
    expectedAudience: CLUB_ORIGIN,
    expectedState: STATE,
    verify: (publicKey, bytes, signature) =>
      schnorr.verify(hexToBytes(signature), sha256(bytes), hexToBytes(publicKey)),
  });
  const theirs = receive(href);
  assert.equal(mine.ok, true, mine.reason);
  assert.equal(theirs.ok, true, theirs.reason);
  assert.deepEqual(mine.payload, theirs.payload);
});

test('base64url survives every byte, in both implementations', () => {
  const bytes = new Uint8Array(256).map((_, index) => index);
  const encoded = passport.toBase64Url(bytes);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'no padding and no + or / in a URL fragment');
  assert.deepEqual([...receiver.fromBase64Url(encoded)], [...bytes]);
  assert.deepEqual([...passport.fromBase64Url(receiver.toBase64Url(bytes))], [...bytes]);
  assert.equal(receiver.fromBase64Url('not base64!'), null);
});
