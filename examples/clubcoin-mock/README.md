# URL-callback connector — the redirect round trip

A deliberately small third-party app that exercises Midnight Passport's
**URL-callback profile flow**: the redirect-based sibling of the popup profile
handshake, built for the case the popup cannot serve — a phone.

This is the generic example for that connector shape. It began life as a mock
of ClubCoin, a partner app that is no longer part of the demo, and the
directory, the package, and the on-screen branding still say "ClubCoin" —
treat that as the sample tenant's name, not as a partner integration. Nothing
in the protocol is specific to it.

On a phone the tab that opens Passport is frequently discarded before it comes
back, so it has no `Window` reference to be answered through. This contract
therefore uses a full-page redirect in both directions and holds nothing in
memory across the boundary.

## The flow

1. The user is in the app and taps **Continue with Passport**.
2. The app mints a state token, stores it in `sessionStorage`, and navigates to
   `https://midnightpassport.com/?passportCallback=…&passportFields=…&passportState=…`.
3. Passport carries those parameters through the entire onboarding — create or
   discover a passkey, open the wallet, claim a name — and shows the consent
   sheet once a session is open.
4. On **Share**, Passport redirects back with the reply in the URL **fragment**,
   signed with the wallet's unshielded key. On **Don't share** it redirects with
   `#passportError=denied`.
5. The app verifies the reply before believing any of it, then renders the
   member.

The contract is specified in
`examples/passport-demo/src/identity/callbackProtocol.ts`. The receiving half
lives in `src/passportCallback.ts` here, copied the way
`examples/passport-app-template/src/bridge/` copies Passport's postMessage
protocols.

## Why the fragment, not the query

A URL fragment is never sent to the receiving server. The shared profile
therefore does not appear in the app's access logs, in its reverse proxy's
logs, or in its analytics — only the page's own JavaScript ever sees it. A
query string would put it in all three. The page scrubs the fragment with
`history.replaceState` the moment it has read it, so the profile does not linger
in the address bar or the back stack either.

## Verification, in a page, with no Midnight dependency

Midnight's unshielded signatures turn out to be ordinary BIP-340 Schnorr over
secp256k1 applied to `sha256(message)`, and the unshielded address is
`sha256(verifyingKey)` in bech32m. So the whole check is three small pure-JS
libraries — `@noble/curves`, `@noble/hashes`, `@scure/base` — with no
WebAssembly and no wallet SDK:

| Check | What it rules out |
| --- | --- |
| BIP-340 signature over `sha256(payload)` | the fragment was edited in transit or in the address bar |
| `sha256(verifying key)` equals the shared unshielded address | a valid signature by an unrelated key over somebody else's identity |
| `audience` equals the app's own origin | a reply harvested from a different app being replayed here |
| `state` echoes the token the app sent | a reply injected into a session the app did not start |
| `issuedAt` is fresh, in both directions | an old reply found in browser history |
| `nonce` has not been seen before | the same valid reply being used twice |

Every check is rendered on the page with its verdict, which is demonstration
scaffolding: a production app keeps the checks and drops the panel.

If the Passport session had no key that could sign, the reply arrives with
`scheme: "none"` and no signature. This app refuses it by default.
`VITE_ACCEPT_UNSIGNED=1` accepts it and says so on screen; it is never
presented as verified. With the passkey wallet that ships today a live session
always has a signing key, so the unsigned branch is exercised by the drill
rather than by the app — keep it, because a receiving app must not assume the
counterparty can sign.

## Running it

```bash
# terminal 1 — Passport
npm run demo                       # from the repository root, port 5175

# terminal 2 — this app
cd examples/clubcoin-mock && npm run dev   # port 5181, fixed
```

The two origins must differ; a round trip to yourself never exercises the
audience binding. Point the app at a deployed Passport with
`VITE_PASSPORT_ORIGIN`, or from the demo configuration panel on the page.

## The drill

```bash
npm test                           # or: node scripts/roundtrip-drill.mjs
```

Bundles both halves of the contract with esbuild and runs them against each
other with a **real** Midnight signer in the middle
(`@midnight-ntwrk/ledger-v8`), verified by the pure-JS receiver. It covers the
launch rules, the signed round trip, the key binding, tampering, audience,
state, freshness, replay, and the unsigned fallback. What it cannot cover is the
WebAuthn ceremony and the onboarding navigation — those need a human with a
device.
