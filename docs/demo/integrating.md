# Integrating with Passport

*Last revised 2026/09/02.*

This is what a partner app has to do to work with Passport, and — just as
importantly — what it must not assume. The reference implementation is
[`examples/doorman`](../../examples/doorman): a small app served on its own
origin that detects Passport, asks who is at the door, and asks for one
payment. Everything below is in that app, and nothing in that app is outside
this document.

The shape of the relationship is short: **your app asks, Passport decides, the
user is the one who decides inside Passport.** Your app never receives an
approval, never holds anything of the user's, and never learns anything the
user did not agree to hand over. If you find yourself wanting a call that
skips the user, the answer is no — nothing that spends or that signs is ever
promptless.

## 1. Install

```
npm install @midnight-passport/connect
```

React is an optional peer dependency, and only the React entry point needs it.

Serve your app on **its own origin**. Passport is a separate origin by design:
there is no injected provider, no `window.midnight.*`, and no same-origin
shortcut, because a partner app on another origin cannot be given one without
weakening the same-origin policy. Everything crosses a boundary, in the open,
in messages you can read.

## 2. The three entry points

The package has three, and which ones you import decides what you ship.

| Entry point | What it is | What it costs |
| --- | --- | --- |
| `@midnight-passport/connect` | The wire protocols, the client, and the two `postMessage` transports. | Nothing. No curves, no hashes, no React, no Midnight SDK, no WebAssembly. |
| `@midnight-passport/connect/react` | `<PassportProvider>` and three hooks. | React, which you already have. |
| `@midnight-passport/connect/redirect` | The signed redirect channel, for the flows that cannot use a window. | Three pure-JavaScript crypto libraries, quarantined here so an app that never uses the channel never pays for them. |

They are separate on purpose, and the package is side-effect free, so a bundler
can prove the ones you did not import away.

## 3. The three calls

`createPassport({ origin })` gives you a client. Under React, put
`<PassportProvider origin="…">` at the root instead — it owns exactly one
client for the life of the tree, because a second client means a second
message listener and two windows both claiming to be Passport.

Name the Passport origin explicitly. A mistyped origin is a silent failure: a
message sent to the wrong origin is never delivered and never answered.

### `detect()`

Is a Passport there? The answer has three states, and the SDK refuses to
launder the third into a boolean:

- `present: true` — a Passport answered the handshake.
- `present: false` — nothing answered within the detection window.
- `present: 'unknown'` — the app is not framed, so the only way to find out is
  to open a window, and that costs a user gesture. Ask, and find out then.

### `requestProfile(fields)`

The two fields are `displayName` and `passportContract`. Passport shows the
user what you asked for, the user chooses, and the reply tells you which
fields were withheld. An approval can be partial; treat a missing field as an
ordinary outcome, not an error.

### `requestPayment(intent)`

One `recipientAddress`, one `amount` in atomic units as a base-10 string or a
`bigint` (never a float), and one `purpose` string that the user will read on
the consent sheet. Write the purpose for the person approving it, not for your
logs.

Passport opens its consent sheet, the user decides, and you get back either
`status: 'submitted'` with a reference, or a refusal. Under React the hooks —
`usePassport`, `usePassportProfile`, and `usePassportPayment` — wrap exactly
these three calls with the twenty lines of `useState` every integrating app
was otherwise writing around them.

`usePassport` also hands you the message transcript. It is not decoration:
watching the request id and nonce be minted, echoed, and matched teaches the
security model faster than any diagram.

## 4. Telling a refusal from a breakdown

Every failure carries a `source`, and the distinction is the whole point.

- `source: 'passport'` — Passport answered. The user declined, or Passport
  would not act. Show the user a **decision**.
- `source: 'local'` — nothing was ever sent, and no Passport was involved: the
  browser blocked the pop-up, the window closed, the budget elapsed, or the
  request your app built was not a valid one. Show the user a **problem with
  the page**.

A timeout is not a decline. If the answer is `timed-out` or `passport-closed`,
nothing is known about the outcome, and saying otherwise to a user who may
have just paid is the worst thing an integration can do.

## 5. The redirect channel

A pop-up is not always available — a phone that has just followed a QR code is
the usual case, and a discarded window there means a payment that cannot
complete. For those flows, `@midnight-passport/connect/redirect` replaces the
window with a round trip through the address bar.

- `buildPassportLaunchUrl({ passportOrigin, callbackUrl, fields, state })` and
  `buildPassportTxLaunchUrl({ …, recipientAddress, amount, purpose })` build
  the URL you send the user to. Both validate the request at the call site: an
  amount that is not positive atomic units, or a purpose longer than the
  consent sheet can show, is your bug and you hear about it immediately rather
  than three redirects later.
- `newPassportState()` and `rememberPassportState()` / `takePassportState()`
  mint and hold the state token that ties the reply to the launch.
- `readPassportCallback()` and `readPassportTxCallback()` read the signed reply
  out of the fragment on your callback page, verify it, and scrub it from the
  address bar. The scrub matters: the reply lives in the user's history, and
  without it a reload or the back button re-presents the same reply to the same
  app. `createPassportNonceLedger()` catches the case where somebody pastes the
  URL back in by hand.

The reply is signed, so your callback page can check that it came from the
Passport it launched — which is the only reason a redirect channel is safe to
offer at all.

## 6. What Passport will refuse

Four refusals are worth designing for before you meet them.

**A request it cannot read.** Passport does not answer an unreadable request
with silence. It replies `invalid-request` (or `invalid_request` on the profile
protocol), bound to the exchange, so your app learns what happened instead of
watching a three-minute spinner. Nothing was signed.

**A protocol revision it does not implement.** If your app speaks a newer
revision than the Passport in front of it, the reply is `version-mismatch`
(`version_mismatch` on the profile protocol). Handle it as its own case and say
so: "update Passport" is actionable, "something went wrong" is not.

**A second consent sheet.** One launch, one exchange, one answer. A re-send of
the same request id and nonce is the *same* request, not a new one, and it is
ignored rather than answered twice — a second answer to a question already
answered would let the opener see two outcomes for one decision. Do not retry
by re-sending; mint a new exchange, and expect the user to be asked again.

**Anything the user did not agree to.** There is no promptless spend and no
promptless signature, at any tier of integration, for any partner. An app that
needs one has a design problem, not an integration problem.

## 7. The reference

[`examples/doorman`](../../examples/doorman) is the working version of this
document: its own origin, its own port, the workspace link to the package, the
three calls in order, and every refusal above given a sentence a user can act
on. Its `README.md` covers how to run it and how the package is resolved
without a build.
