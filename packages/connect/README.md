# `@midnight-passport/connect`

This package is an **extraction**, not a new thing. The Passport protocol
already existed and already worked — it was just spread across a package called
`demo-backend`, two vendored copies under `examples/*/src/bridge/`, a receiver
library sitting inside an example app, and about four hundred lines of
hand-written transport in each dApp that spoke it. All of that is one canonical
copy now, here, and the module graph is what keeps it that way: `demo-backend`
imports the protocol back from this package, so a second copy cannot exist
without somebody deleting an import.

Apache-2.0. ESM-only. `sideEffects: false`.

---

## Install

```sh
npm install @midnight-passport/connect
```

## Three entry points

| Entry | Runtime dependencies | What is in it |
| --- | --- | --- |
| `@midnight-passport/connect` | **none** | the wire protocols, the client, and the iframe and pop-up transports |
| `@midnight-passport/connect/redirect` | `@noble/curves`, `@noble/hashes`, `@scure/base` | the signed full-page-redirect channel and its verifier |
| `@midnight-passport/connect/react` | `react` (peer) | `PassportProvider`, `usePassport`, `usePassportProfile`, `usePassportPayment` |

The crypto is quarantined behind `./redirect` on purpose: a dApp that never
uses the redirect channel never pays for a curve implementation. All three
libraries are pure JavaScript — no WebAssembly, no Midnight SDK — which is the
whole reason a Midnight identity can be verified inside an ordinary web page.

## Three calls

```ts
import { createPassport } from '@midnight-passport/connect';

const passport = createPassport({ origin: 'https://midnightpassport.com' });

// 1. Who is this?
const who = await passport.requestProfile(['displayName']);
if (who.approved) greet(who.profile.displayName);
else show(who.message);            // never a bare error code

// 2. Pay for something.
const paid = await passport.requestPayment({
  recipientAddress: OPERATOR_ADDRESS,
  amount: '100000',                // atomic NIGHT; 1 NIGHT = 1,000,000
  purpose: 'Cover charge',
});
if (paid.status === 'submitted') {
  showTicket(paid.txId, paid.sponsored);   // the badge ONLY when true
}

// 3. Say what you granted. Framed only, unauthenticated, and it says so.
await passport.reportIncentive({ id: 'doorman:entry', label: 'Door entry' });
```

Every result is a discriminated union carrying a rendered `message`, so no app
ever has to keep its own map from error codes to English.

## What this package will not pretend

- **There is no injected provider.** A dApp on another origin cannot receive
  `window.midnight.*`; the same-origin policy forbids it and Passport
  deliberately does not weaken it. So `detect()` returns `present: 'unknown'`
  in pop-up mode and says why. Render the button, let the user press it, and
  handle `popup-blocked`.
- **Consent is partial.** An approved profile may carry fewer fields than you
  asked for. `result.withheld` names what did not arrive.
- **`submitted` means at the node, not final.** No confirmation depth is
  reported by anything in this protocol.
- **Sponsorship is best-effort.** Render "network fee covered" for
  `sponsored === true` and for nothing else.
- **`reportIncentive` is unauthenticated by construction.** The app asserts it
  granted something and Passport records the assertion verbatim.

## What changed in the extraction

Five things that would have embarrassed a public SDK, each fixed as a protocol
change with a test:

1. **A version field.** The revision used to be fused into the protocol string
   and a mismatch was a silent drop — indistinguishable from Passport being
   absent, or from your own message being malformed. Every message now carries
   a numeric `version`, every parser returns a typed result, and Passport
   replies `version_mismatch` instead of saying nothing.
2. **`midnightAddresses` is off the wire.** The three engine addresses were
   ruled a signing detail no dApp has a legitimate use for — offering them
   invited an app to pay an address the account cannot see.
   `passportContract.address` is the identity.
3. **Presence detection.** `detect()` is honest in pop-up mode and, in a frame,
   sends a `passport.profile.hello` and waits a bounded time for a typed
   `not-present` rather than hanging.
4. **One error taxonomy.** `PassportErrorCode` covers both protocols, with
   guards, replacing the inline literals and the per-app sentence maps.
5. **The redirect channel can pay.** `passportTxCallback` gives the phone path
   a QR code lands on a way to complete a payment, with the same audience,
   state, freshness, and replay checks as the profile exchange, plus an echo of
   the intent inside the signed bytes.

## The reference integration

`examples/doorman` in this repository is one page, three acts, each a real call
into this package: sign in with a name and no address, pay a cover charge
through the pop-up, and verify a signed redirect reply in the browser with its
whole check trail on screen. `docs/demo/integrating.md` is the ten-minute
version.
