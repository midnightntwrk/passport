# Passport — PWA risk and blockers assessment

**Date:** 2026/08/04
**Author:** Utkarsh Varma
**Scope:** `examples/passport-demo`, `demo-backend`, on branch `demo/pwa-demo` (`af10bc1`) of the separate implementation repository
**Purpose:** the check-in of 2026/07/27, at which Hector asked for the blockers that follow from the design decisions rather than a confirmation that the decisions work.

A note on citations. `§1.1`, `§2.1`, and `§2.2` below refer to the decision
sections of Hector's planning document, which is not held in this repository.
They are not `docs/PRINCIPLES.md`'s `§ 2.1` and `§ 2.2`, which point at the
secure-onboarding design and are written with a space.

---

## Summary

The PWA demo is in better shape than this document will make it sound, and that is
deliberate: a risk assessment whose conclusion is "on track" is worth nothing. The
build is green, the passkey ceremony is real, the private-state encryption is real,
the indexer client is real and measured against the live preview endpoint, and the
consented profile handshake completes end to end between two separate origins. None
of that is at risk.

What is at risk is a set of things that were decided before anyone had written the
code that would have to honour them. One of those decisions — the full-screen iframe
path — cannot be delivered as described, not because it is hard but because the
browser's same-origin policy forbids it. Two more are blocked on a named person
making a call. Two are blocked upstream on Dynamic and on the Midnight indexer's
public API. One, the network the demo will actually run on, has no owner at all,
which is the quietest and most dangerous item in the list.

The honest posture is this: **the demo can be made to look complete on the schedule
we have, and several of the things it will appear to do it will not actually be
doing.** That is acceptable for a demo, and Hector has already said as much. It stops
being acceptable the moment a decision made for the demo is carried forward into the
architecture by inertia. This document exists so that each of those carry-forwards is
a deliberate choice.

### How to read the classifications

Three different things get called "blockers", and conflating them is how a plan goes
wrong. They are separated throughout.

**Impossible.** A platform or protocol property forbids it. No amount of engineering
time changes the answer; only changing the requirement does. There is exactly one of
these, and it is the headline.

**Blocked on a decision.** The engineering is tractable, but somebody has to choose,
and until they do the work cannot start. These are the ones that quietly consume
calendar time while looking like they are in progress.

**Not built yet.** Ordinary remaining work with a known shape. These are listed for
completeness and are the least interesting items here.

---

## The blockers

| # | Item | Class | Severity | Decision owner |
|---|---|---|---|---|
| 1 | Cross-origin injection of `window.midnight.*` into a framed dApp | **Impossible** | Critical — invalidates the stated appeal of Path 4 | §2.1, Hector's planning document |
| 2 | Private state is IndexedDB-only, with no backup or sync | Blocked on a decision | Critical — a lost Passport is an unrecoverable Passport | §2.2, Nicolas |
| 3 | WebAuthn PRF requirement, `rpId` binding, and non-discoverable sign-in | Part impossible, part not built | High — `rpId` is irreversible after first enrolment | Passport, but the `rpId` needs a domain decision now |
| 4 | Dynamic as the sole signer; two round trips per contract transaction | Blocked upstream | Critical — blocks C1 on any real network | §1.1, with Dynamic |
| 5 | No per-address transaction query in the indexer's HTTP API | Blocked upstream | Medium — the feature works, its guarantees do not | Midnight indexer team |
| 6 | Target network (preview vs. stagenet) undecided and undocumented | Blocked on a decision | High — silently gates items 4 and 5 | **Nobody. This is the gap.** |
| 7 | Demo/production honesty boundary | Not built (by design) | Medium — risk is carry-forward, not the demo itself | Passport, per item |
| 8 | One 4,129-line commit rather than the stacked PRs requested | Process | Medium — repeat of a raised concern | Passport |

---

## 1. Cross-origin injection is impossible, and Path 4 depends on it

**Class: impossible. This does not become possible with more time.**

The planning document proposes "Path 4 — Full screen Iframe on PWA: The PWA renders a
full screen iframe where the dApp is rendered and the necessary data is injected", and
records Path 4 as the short-term preference. The word doing the work is *injected*.

A page cannot write to a cross-origin document's JavaScript context. Reading or
writing `iframe.contentWindow.midnight` across an origin boundary throws a
`SecurityError`; there is no flag, no header, and no sandbox attribute that grants it,
because granting it would defeat the same-origin policy for every site on the web. The
Midnight dApp connector convention is for a dApp to poll its **own** `window` object
for an injected provider. A dApp framed inside Passport polls the window Passport
cannot touch, finds nothing, and reports no wallet — forever.

The consequence is precise and worth stating plainly: **Path 4 cannot deliver "existing
dApps work with zero integration".** That property was the entire reason to prefer it.
Whatever else Path 4 is worth, it is not worth that.

What *is* possible is a cooperating protocol over `postMessage`, and that is what the
implementation does. `examples/passport-demo/src/screens/AppBrowser.tsx:22-29` states
the boundary in the source rather than papering over it. Passport frames the dApp,
posts a `ready` message carrying a request id and nonce on load
(`AppBrowser.tsx:226-234`), and accepts inbound requests only when both the message
source is that exact frame and the origin matches the registry entry
(`AppBrowser.tsx:193-224`). The schemas and parsers are in
`demo-backend/src/profileProtocol.ts`, and the exposed field set is deliberately three
public items — display name, Passport contract address with its network, and public
receiving addresses (`profileProtocol.ts:3-9`).

That works. It is demonstrably real: the Atlas example dApp on a separate origin
completes the handshake. But it requires the dApp to implement the protocol, which is
per-dApp integration work — exactly the cost Path 4 was chosen to avoid. **Path 4's
cost profile is therefore not what §2.1 assumed when it was decided.** It should be
re-costed against the alternatives with that correction in hand, not defended.

There is a second, independent problem with framing. Many dApps will refuse to load
inside any frame at all, via `X-Frame-Options: DENY` or a CSP `frame-ancestors`
directive. **Whether a frame was refused is not observable from JavaScript** — the load
event fires either way and the document is cross-origin, so nothing can be inspected.
The implementation does the only honest thing available: a six-second timer that raises
a "this app may refuse to load inside Passport" notice unless the frame has proved it
is alive by speaking the protocol, plus an always-available "open in a new tab" escape
(`AppBrowser.tsx:31-32`, `159-165`, `236-239`, `321`). That is a heuristic, and it will
sometimes be wrong in both directions on a slow connection.

A third detail matters for security review. The frame is sandboxed
`allow-scripts allow-same-origin allow-forms allow-popups` (`AppBrowser.tsx:363`).
`allow-same-origin` is needed so the framed app retains a nameable origin for the
consent sheet, but on a document served from Passport's *own* origin that same flag
lifts the sandbox entirely — the "app" would inherit Passport's IndexedDB and could
forge a profile request that passes the origin check. The code therefore refuses to
frame any same-origin entry outright (`AppBrowser.tsx:148-157`). That refusal is load
bearing and must survive any future refactor of the registry.

**What would resolve this.** Accept that framing requires dApp cooperation and re-cost
§2.1 accordingly; or drop framing and use a top-level opener protocol, which the
codebase already supports through the same message shapes; or pursue a browser
extension, which is the only shipping mechanism that genuinely injects into a
third-party page. What will not resolve it is more engineering against Path 4 as
written.

## 2. Private state is IndexedDB-only, and an evicted Passport is a lost Passport

**Class: blocked on a decision. Owner: Nicolas, decision §2.2.**

Everything durable is in IndexedDB. The encrypted private-state envelopes live in the
`private-state` object store (`demo-backend/src/privateState.ts:60-117`), sealed with
AES-GCM under a key derived from the passkey PRF output
(`privateState.ts:119-145`, `demo-backend/src/passkey.ts:49-65`). The public profile —
including the passkey `credentialId` that sign-in requires — lives in a sibling store
in the same database (`examples/passport-demo/src/publicProfile.ts:3-4`, `31-44`).

There is no backup. There is no sync. There is no export. If the database goes, the
Passport goes, and with it the device secret, the recovery secret, the C1 record, and
every grant secret (`examples/passport-demo/src/App.tsx:114-131`).

Origin storage is best-effort by default, and it goes for mundane reasons: storage
pressure eviction, the user clearing site data, private browsing, uninstalling an
installed PWA, or a profile reset. On iOS, Safari caps script-writable storage after
seven days without user interaction; installed home-screen web apps keep their own
counter rather than being exempt from the rule, which is precisely the situation of a
conference attendee who installs Passport on a Tuesday and does not open it again.

The demo asks for durability — `navigator.storage.persist()` is called immediately
after key creation (`examples/passport-demo/src/pwa.tsx:27-35`, called from
`App.tsx:681`). That call is **a request, not a guarantee**. Chromium grants it on
heuristics such as installation and engagement; other engines answer differently; and
explicit site-data deletion wins in every engine regardless of the answer. Nothing in
the code treats the result as a promise, and nothing should.

The acquisition consequence is the one that matters for TOKEN2049. If the point of the
event is to onboard users who later move to mainnet, then **users whose browser
evicted their state cannot be migrated, and we will not know how many there were.**
A demo that acquires users into a store that silently forgets them is worse than a
demo that acquires none, because the loss is invisible.

The options discussed, assessed honestly:

*Passkey `largeBlob`.* Attractive because it rides the credential the user already has
and syncs through the platform's own keychain. The ceiling is the problem: the
specification only obliges an authenticator supporting the extension to store about a
kilobyte, and practical ceilings sit near two. The demo's current state — two 32-byte
secrets, a small C1 record, and a short list of grants — fits comfortably today. It
does not stay fitting: the grant list grows without bound, and general Midnight
contract private state (witnesses, coin secrets, Merkle material) has no small bound at
all. `largeBlob` is a plausible home for a *root secret* from which state is rebuilt.
It is not a home for private state.

*Encrypted backup to Google Drive or iCloud.* Solves durability and cross-device, and
introduces a dependency on two vendors plus a key-management story that has to survive
the user losing the passkey. Note that `docs/demo/blockers.md:9` in the implementation
repository currently records the opposite policy — "Local encrypted storage only; no
Drive/Apple blob sync" — pending Foundation security review. That is a decision, not a
technical finding, and it is the decision §2.2 has to revisit.

*Bitwarden or another password manager.* Same shape as the cloud option with a
different trust anchor and a much smaller install base among the people we would meet
at a conference.

**What would resolve this.** A written §2.2 decision naming the mechanism, the ceiling
it has to fit, and what happens when the passkey itself is lost. Until it exists, the
UI must not invite users to place value under Passport control, and the demo should say
out loud that state is device-local.

## 3. Passkey constraints: PRF is mandatory, `rpId` is irreversible, sign-in is not discoverable

**Class: mixed. The PRF dependency is a hard platform constraint; the `rpId` choice is a
decision that must be made before anyone enrols; the discoverable-credential path is
simply not built.**

Enrolment requires the WebAuthn PRF extension and fails closed without it. The code
throws with an explicit message when the authenticator does not report `prf.enabled`
(`demo-backend/src/passkey.ts:125-129`), and the PRF output is turned straight into a
non-exportable AES key through HKDF (`passkey.ts:49-65`, `160-169`). Failing closed is
the correct behaviour — there is no safe fallback, because the alternative is deriving
the state key from something weaker. But it does mean some authenticator, browser, and
OS combinations simply cannot create a Passport. Safari gained PRF in version 18;
older platforms and several external security keys do not have it. **We do not yet have
a tested device matrix**, and the feasibility report already lists physical-device
testing as not executed (`docs/demo/pwa-feasibility-report.md:34`).

Passkeys bind to a relying-party identifier, which defaults to the page's hostname
(`passkey.ts:90-95`) and is stored alongside the credential (`passkey.ts:130`,
`153`). A credential enrolled on a preview or staging hostname **does not work** on the
production hostname. This is not a bug to be fixed later; it is the point of the
mechanism. It follows that **the canonical `rpId` must be chosen before the first user
enrols**, and that any demo run on a throwaway domain produces Passports that cannot be
carried to production. If TOKEN2049 users are meant to be migratable, this decision has
to precede the event, not follow it.

Sign-in currently requires a credential this browser already knows about. The
assertion always passes a non-empty `allowCredentials` built from the stored
`credentialId` (`passkey.ts:143-154`), and that id comes from the IndexedDB profile
record (`publicProfile.ts:59-61`, consumed at `App.tsx:639-647`). Enrolment does
request a resident key (`passkey.ts:110`), so the credential *is* discoverable at the
authenticator — but the client never exercises that, so a passkey synced to a fresh
device or a fresh browser profile cannot sign in. Combined with item 2, this means
clearing site data is indistinguishable from having no Passport at all, even when the
passkey survived. Adding a discoverable-credential path (empty `allowCredentials`, with
the user handle resolving the account) is ordinary work and would remove one of the two
ways to lose an account.

Finally, derived keys are cached for thirty seconds and then dropped
(`passkey.ts:76-77`, `165`). That is a defensible security posture, but it means a
burst of storage operations spanning more than half a minute re-prompts for biometrics
mid-flow. On a slow mobile proof or a multi-step deployment this will read as the app
asking for a fingerprint at random.

**What would resolve this.** Name the production hostname now and enrol nothing
anywhere else; publish a supported browser and authenticator matrix from real devices;
add the discoverable-credential sign-in path; and re-examine the thirty-second window
against the actual timings of the longest flow.

## 4. Dynamic is the only signer, and the signer-only path costs two round trips

**Class: blocked upstream. Decision §1.1.**

Dynamic today exposes no supported API for proving or finalising an arbitrary Compact
transaction. That was established by reading the shipped connector rather than the
documentation, and is recorded in
[`2026-07-27-dynamic-transaction-signing.md`](./2026-07-27-dynamic-transaction-signing.md),
and tracked as [#101](https://github.com/midnightntwrk/passport/issues/101).
The demo behaves accordingly: `authorizeAndSubmitDynamicCompactTransaction` refuses any
connector that is not the Dynamic embedded wallet, refuses any network other than
preview, and routes through the capability-gated proof provider rather than the
transfer-only `signTransaction`
(`examples/passport-demo/src/dynamic.ts:94-130`). The transfer path is explicitly not a
fallback — the comment at `dynamic.ts:86-93` says so, and the UI states the reason on
screen instead of simulating success (`App.tsx:1511`, `App.tsx:2235`). **The demo fails
closed. It does not mock a grant.** That is the right call and should not be softened
under time pressure.

The shape of the signer-only path, as Hector described it, is two round trips per
contract transaction: the client sends the intent, Dynamic signs it, the demo executes
the circuit and builds the preimage, the preimage goes back to Dynamic, Dynamic goes to
BCW, and control returns to the demo to balance and broadcast. Hector's own assessment
was that this is "a terrible experience... but it's the way it works at the moment."
That is an accurate description of the mechanism and a poor description of a product.
Passport's position should be that the target is parity with what a user experiences on
Solana or Ethereum — one approval, one wait, one result — and that anything else is a
transitional state with an expiry date rather than an architecture.

The published alternative avoids the second trip: a single `balance-and-finalize` call
in which the client sends a call-proved unbound transaction and receives a finalised
one, with the input digest echoed so the user's approval binds to the exact broadcast
bytes. The full contract and its behavioural requirements are already written down in
the 2026/07/27 report and are ready to hand to Dynamic.

The other alternative — Dynamic holding the account-custody contract artefacts and
running the whole flow itself — should be understood as **architecturally
disqualifying, not merely inconvenient**. Composing with another contract requires the
artefacts of every contract in the composition, and Dynamic will not host third-party
artefacts. Choosing that path trades the round trip for the permanent loss of contract
composability, which is most of what Midnight is for.

Two further risks belong in the record. First, **concentration**: Passport currently has
one signer partner, and every C1 capability is gated on that partner's roadmap. There
is no second implementation, no abstraction boundary being exercised by a second
provider, and no fallback if the timeline slips. Second, this is not a one-way
dependency — the same gap is reported to be blocking Dynamic's own TOKEN2049 work,
which means both sides are waiting and neither is unblocked by waiting harder.

**What would resolve this.** Confirmation from Dynamic of the API contract already
published, with a date. Before that, the cheap experiment named in the 2026/07/27
report: push one call-proved Passport transaction through the existing
`signTransaction` on preview with a DUST-funded wallet and record exactly what comes
back. It either unblocks this immediately or produces a concrete error to put in front
of Dynamic, and it takes minutes — once someone has preview or stagenet access, which
is item 6.

## 5. The indexer cannot answer "this account's transactions" over HTTP

**Class: blocked upstream, with a working mitigation. The feature exists; its
guarantees are narrower than a "recent transactions" list implies.**

This was verified live against `https://indexer.preview.midnight.network/api/v4/graphql`
on 2026/08/04, by introspection and by opening real sockets. The findings, all
reproducible:

The `Query` type exposes thirty-eight fields, and none of them lists transactions for an
address. `transactions(offset: TransactionOffset!)` looks like a listing field and is
not one: `TransactionOffset` accepts only `hash` or `identifier`, so it is a point
lookup that requires you to already know the transaction you are asking about. The
remainder of the query surface is blocks, contract actions and events, DUST and Zswap
Merkle updates, and a long tail of stake-pool, epoch, and bridge analytics.

Per-address history exists **only** as a WebSocket subscription:
`unshieldedTransactions(address: UnshieldedAddress!, transactionId: Int)`. The endpoint
is the HTTP URL with `/ws` appended — the bare path refuses the upgrade with HTTP 405,
which was confirmed directly today. The protocol is `graphql-transport-ws`. The first
frame is always an `UnshieldedTransactionsProgress` carrying the highest transaction id
relevant to that address, after which history replays in ascending order. **The server
never sends a `complete` frame** — it stays open for live traffic — so the client needs
an idle-timer terminator to finish, which is exactly what
`examples/passport-demo/src/lib/indexerTx.ts:137`, `365-368` implements. Without that,
an account with no history would hang until the hard ceiling. Measured on preview, a
335-transaction address replayed fully in about 1.7 seconds against a 10-second budget
(`indexerTx.ts:135`).

The HTTP fallback walks blocks backwards with aliased `block(offset: { height })`
selections (`indexerTx.ts:178-201`). It is bounded by a server-side complexity limit —
ten aliases per request pass, twenty are rejected — and by a load balancer that returns
a bare 403 on bodies around 15 KB. More importantly, **it is chain-wide**. It returns
whatever anybody transacted in the window, and it therefore cannot establish that an
account has no history. Preview is nearly empty: a scan of 1,200 consecutive blocks
found a single transaction. A hundred-block walk will return nothing for almost any
account, and that nothing means nothing.

The implementation handles this correctly rather than hiding it. Every result carries a
`scope`, and the caller refuses to render a chain-scoped result as the user's own
activity — it reports the per-address view as unavailable instead
(`indexerTx.ts:102-116`, `648-691`; `App.tsx:602-630`). The reasoning is written out at
`indexerTx.ts:63-82`. This is the behaviour to preserve; the risk is a future change
that quietly turns an empty chain walk into "no transactions yet".

One further limit is structural rather than an API gap. Shielded activity is not
attributable to a user by a third party — that is the design working. The indexer does
expose `shieldedTransactions(sessionId:)`, but it requires a viewing-key session that
the demo does not establish, and the Dynamic embedded wallet holds those keys. So the
list Passport shows is **unshielded only**, and "recent transactions" can never be a
complete account of what a user did. The screen should not imply otherwise.

**What would resolve this.** A per-address transaction query in the indexer's HTTP API,
or an explicit statement from the indexer team that the subscription is the intended
mechanism — in which case the idle-timer workaround should be documented as supported
rather than discovered. Independently, a viewing-key session path would make shielded
history available to the user's own client.

## 6. Nobody owns the network the demo runs on

**Class: blocked on a decision, with no named owner. This is the item most likely to
surprise us.**

The demo is wired to preview. The explorer and indexer constants are preview
(`App.tsx:154-157`), the indexer default in `.env.example` is preview, and the Compact
approval path rejects any wallet whose address is not on preview
(`dynamic.ts:104-106`). Meanwhile the working assumption from the check-in is that the
demo will likely run on **stagenet**, and both parties expressed doubt that stagenet
would be promoted.

Nothing has been decided. Nothing has been written down. Access has been an outstanding
ask since at least 2026/07/27 and is still outstanding
([`2026-07-27-passport-ticket-status.md`](./2026-07-27-passport-ticket-status.md), asks).

This matters more than it looks, because it silently gates other items. The cheap
Dynamic experiment in item 4 needs a DUST-funded wallet on whichever network we are
targeting. The indexer findings in item 5 were measured on preview and its emptiness is
a preview property — stagenet block density, complexity limits, and load-balancer
behaviour are all unverified. The `rpId` decision in item 3 is entangled with the domain
the demo is served from. Every one of those is a small task that becomes a scramble if
the network changes late.

**What would resolve this.** A named owner and a one-paragraph decision record: which
network, who grants access, by when, and what happens if it is not promoted. This is the
cheapest item in the document and the one with the worst ratio of cost to consequence.

## 7. What the demo shows that is not the real thing

**Class: not built, by design.** Hector's framing — "demo will cut corners, will not be
production ready" — is right, and none of what follows is a criticism of the demo. The
standing position holds: the demo runs on preview or testnet only, it is not going to
mainnet, it is not the final product, it is not audited, and what it does do is real
rather than mocked. The risk is carry-forward: a corner cut for a conference becoming
an assumption in the architecture because nobody wrote down that it was a corner. The
four items below are the corners.

*The custody deposit is a localnet path, not a Dynamic one.* The NIGHT and shielded
deposit controls call real `deposit_night` and `deposit_shielded` circuits, but only
under `demoMode=local` against a disposable localnet — every entry point in
`examples/passport-demo/src/localC1.ts` throws outside that mode
(`localC1.ts:218-224`), and the deployment records itself with network `undeployed`
(`localC1.ts:144-145`). On preview the same action is blocked, because the piece it
needs is the missing Dynamic capability from item 4. The shielded deposit therefore
stands in for an account-custody-contract call that cannot yet be made. The demo says so
on screen; a slide deck will not.

*Midnames routing is a prototype registry.* Alias registration is localnet-only
(`localC1.ts:218-236`) and writes `handle -> account` without proving control of the
nominated C1 account. The implementation repository already records this and assigns the
authorisation, anti-squatting, and rebinding policy to the Foundation
(`docs/demo/blockers.md:6`). Pending the Midnames team owning the alias resolver, every
`alice.night` in the demo should be described as a mock.

*Sig.Network settlement is deliberately disabled on a version mismatch.* The public Sig
release targets Ledger v9 and ZKIR v3; the C1 prototype targets Ledger v8 and ZKIR v2.
The demo pins `@midnight-ntwrk/ledger-v8` 8.0.3 and `@midnight-ntwrk/zkir-v2` 2.1.0.
This is recorded as externally blocked in the implementation repository's validation log
and requires a coordinated contract and provider port, not a configuration change.

*There is no Content-Security-Policy.* `examples/passport-demo/index.html` ships no CSP
meta tag, and there is no `vercel.json`, `_headers`, or equivalent header configuration
anywhere in the repository. The in-app browser's own origin check
(`AppBrowser.tsx:148-157`) and the registry's https-only URL filter
(`lib/registry.ts:89-99`) are therefore **the only controls over what can be framed**.
The feasibility report already names XSS as the highest web-client risk precisely
because encrypted state is decrypted in the page for authorised operations
(`docs/demo/pwa-feasibility-report.md:196-199`). A `frame-src` allowlist and a strict
`script-src` are small, and their absence is not.

Two adjacent items belong in the same list. Grant secrets are real and encrypted in
Passport, but the consent protocol only shares profile fields — no labelled external app
can spend anything, and none should be described as able to. And recovery exists as
prototype commitments protected by the Passport key, not as a recovery product.

## 8. One large commit, when stacked PRs were asked for

**Class: process.**

Hector asked for the work to arrive as small stacked pull requests: the PWA against
main, the demo backend against the PWA, then the connectors, then the separate-origin
profile client. What exists is a single commit of 4,129 insertions across sixteen files,
including three new screens, a 695-line indexer client, and roughly 1,360 lines of CSS.

The review problem is not hypothetical and not new — it is the same concern Hector has
already raised once. A change of this size cannot be reviewed at the level of individual
decisions, so the decisions that most need a second opinion (the iframe sandbox flags,
the consent sheet's refusal semantics, the indexer's scope guarantees) get the least
scrutiny. Re-splitting after the fact is cheap now and gets steadily more expensive.

---

## What is genuinely working

So the picture is calibrated rather than alarming, here is what has been verified rather
than asserted. Everything below was re-run or re-measured on 2026/08/04.

The **production build is clean** — `tsc --noEmit` and the Vite build both pass — and
the PWA structural checks pass at **41 of 41**, covering manifest identity, icon set,
service-worker install, activation, fetch and update handlers, release-versioned caches,
the cross-origin and same-origin-API cache bypasses, the explicit offline navigation
fallback, the absence of any background transaction or proof queue, and the persistent-
storage request.

The **demo-backend test suites pass at 10 of 10** across the private-state, profile
protocol, and passkey files, covering encrypt/decrypt round trips, scope isolation,
wrong-key rejection, malformed envelope versions, absent WebAuthn, and the absence of
plaintext persistence.

The **passkey ceremony is real**. PRF is requested at enrolment and verified, the output
becomes a non-exportable AES-GCM key through HKDF with domain-separated salts, keys are
scoped per app and account, the plaintext PRF buffer is zeroed after use
(`passkey.ts:163-169`), and nothing is written outside the encrypted envelope.

The **indexer client is real and measured**. Every claim in its header comment
(`indexerTx.ts:1-82`) was independently reconfirmed today against the live preview
endpoint: the 38-field query surface, `TransactionOffset` accepting only `hash` or
`identifier`, the subscription's existence and argument shape, and the 405 on the bare
WebSocket path against a successful upgrade on `/ws`. The scope-provenance design is
the strongest thing in the codebase and should be treated as the template for how
Passport reports uncertainty.

The **1AM registry integration works** with an 8-second timeout, a 10-minute
`sessionStorage` cache, https-only URL validation on untrusted third-party entries, and
a built-in fallback list whose every entry is marked `stale: true` so the UI can say what
it is showing (`lib/registry.ts`).

The **consented profile handshake completes end to end** between two genuinely separate
origins, with opt-in per-field consent that starts unticked on every request, refusal of
a second request arriving mid-decision, and a reply bound to the request id and nonce
the app itself sent.

None of this is at risk from anything in this document. All of it is worth keeping
whatever §2.1 decides.

### Not covered by this assessment

**No physical device has been tested.** Every result above comes from a desktop
Chromium session, a Node process, and the live preview indexer. The iOS, iPadOS,
and Android matrices — install, relaunch, OAuth return in standalone mode, platform
passkey PRF, process termination, storage eviction, and reinstall — remain
unexecuted, and they are where items 2 and 3 will actually be decided.

**No live Dynamic run against a contract call.** Item 4 is established by reading the
shipped connector and by the capability probe failing closed, not by a transaction.
The one experiment that would settle it has not been run, because it needs network
access nobody has yet granted (item 6).

**No stagenet measurement of anything.** The indexer numbers, the complexity limits,
and the block-density observation are preview properties.

**Cost, scheduling, and staffing are out of scope.** This document says what will not
work and who has to decide; it does not estimate how long the resolutions take.

---

## Asks

1. **§2.1 re-cost, given that injection is impossible.** Path 4 cannot deliver zero-
   integration dApp support. The choice is between a cooperating protocol with per-dApp
   work, a top-level opener flow, or an extension. Someone should make it explicitly.
2. **§2.2 decision from Nicolas**, naming the backup mechanism and its size ceiling, and
   saying what happens when the passkey is lost.
3. **An owner and a date for the network decision.** Preview or stagenet, who grants
   access, and the fallback if stagenet is not promoted.
4. **The canonical `rpId`**, before any user enrols anywhere.
5. **From Dynamic:** confirmation of the published `balance-and-finalize` contract and a
   timeline. Before that, run the one-transaction `signTransaction` experiment — it needs
   only network access and a DUST-funded wallet.
6. **Re-split the PWA work into the stacked PRs originally requested**, while it is still
   cheap.
