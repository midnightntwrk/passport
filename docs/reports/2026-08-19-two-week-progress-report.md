# Passport — progress against the 2026/07/31 two-week plan

> **Status:** progress report · 2026/08/19
> **Audience:** Hector, Nicolas, Karmel
> **Work window:** 2026/08/05–07 and 2026/08/19 (Utkarsh out of office 2026/08/08–18)
> **Evidence:** commits on `midnightntwrk/passport` branch `demo/pwa-demo`, cited
> by hash; every "verified" below names a transaction, block, or reproduced
> browser run. Live surfaces: <https://midnightpassport.com> and subdomains.
> **Companion:** [PWA risk and blockers assessment](2026-08-04-passport-pwa-risk-assessment.md).

## At a glance

| Plan item | Decision owner | Implementation status |
|---|---|---|
| §1.1 Dynamic integration path | Nicolas | **Blocked on the decision.** Intent-signing PR approved pre-vacation; nothing further is possible until artefact-holder vs signer-only is settled. Still the item blocking the most. |
| §1.2 Midnames from the PWA | — | **Done and live.** Real `.night` registrations on Preview from the PWA, first-claim activation included. |
| §2.1 dApp connector path | Nicolas | **Path 4 built as the demo bridge** (framed + popup channels, documented protocols) — explicitly a workaround, not the SDK proposal. **New:** the ClubCoin-shaped URL-callback flow now exists and is verified (below). Paths 1–3 untouched, decision still open. |
| §2.2 Private storage manager | Nicolas | Demo-grade persistence in place (wrapped-key session, sync snapshots — IndexedDB). Backup/migration approach still to decide; meeting options stand. |
| §2.3 ACC multikey | Nicolas | No change (outside this repo). |
| §2.4 SDK repo review | Nicolas | No change. |
| §3.1 Midnight City | — | Not started, per the plan's own sequencing (depends on §2.1/§2.2 decisions). |
| §3.2 ClubCoin | — | **The URL-callback flow is built and verified end to end, passkey ceremony included** — a hands-on run on 2026/08/19 went ClubCoin → Passport → Touch ID → consent → signed return, and the receiver verified the reply against the sharing Passport's own address. |

Also requested (Karmel, token-demo thread): Otrix (NMKR flow) — **not started**;
Firebase notifications for the PWA — **not started**. Both need scoping calls.

## The three observations from 2026/08/18, answered with fixes

**"midnightpassport.com creates the 3 addresses and does not deploy the ACC
contract."** Was true; the gap is now closed at the module level and proven on
chain. The account-custody contract machinery lived only in the classic
Dynamic-hosted view, localnet-only. It has been generalised to the network the
passkey wallet signs on, using the same pattern the Midnames integration
already proved (URL-served ZK artefacts, sponsored fees, real confirmation
read-back). **Verified live on 2026/08/19:** the account-custody contract
deployed on Preview from a fresh passkey-shaped wallet holding zero DUST —
contract `321e37cd63a5d77cfc6b6c5ca0221f31eea1f7ef22d4e4dd343dc56fdb20f05a`,
transaction `ff74e247…f86ef4`, block 486496, `ContractDeploy` confirmed
independently on the indexer, fee paid by the sponsor. A "Passport contract"
card in the mobile Home surfaces deploy/status; the in-browser passkey run of
that card is the one leg still needing a human hand.

**"`?demoMode=local` renders a desktop site, not the PWA."** Diagnosed and
fixed. The cause was a sticky side-effect: reaching the contract flow used to
require the classic view, which pinned `passport-experience: classic` into
localStorage — after which *every* launch, including `?demoMode=local`, landed
on the desktop dashboard. Reproduced in a headless browser with the stale pin,
then verified fixed: `?demoMode=local` now clears the pin and renders the
mobile PWA onboarding. The flag is just the localnet flavour of the same flow.

**"Too early to speak about an app hub."** Fair; the hub page is a hackathon
submission list over a JSON registry and says nothing about the integration
path, but the name over-claims while §2.1 is undecided. It can be renamed,
gated, or parked on a word.

## ClubCoin — the callback flow, built and verified

The alignment meeting's sketch — mobile browser → PWA → passkey account →
**URL callback pushing the profile back** — now exists:

- **Launch contract:** `?passportCallback=<https URL>&passportFields=<subset>&passportState=<opaque>`,
  parsed before first render and persisted across every redirect onboarding
  performs; malformed launches degrade to the normal app with a notice, never
  a redirect to an address that could not be parsed.
- **Consent:** a sheet naming the asking origin and fields; approval returns
  via `location.assign` with the reply in the **URL fragment** (it never
  reaches the receiving server's logs); denial returns `#passportError=denied`.
- **Integrity, real:** the reply is signed with the wallet's unshielded key —
  which turns out to be plain **BIP-340 Schnorr over secp256k1**, verifiable
  in any web page with no Midnight dependency — and the receiver binds the
  signing key to the shared unshielded address inside the same payload
  (`sha256(verifying key)` = the address bytes), so a signature from anyone
  else is refused.
- **Receiver example:** `examples/clubcoin-mock/` — a ClubCoin-shaped page
  proving the round trip.
- **Verified (2026/08/19, machine-run):** 21/21 protocol drills with a real
  ledger signer (tampering, replay, wrong audience, wrong state, stale clock,
  forged key, unsigned refusal); live-browser launch leg (real click → correct
  parameters); live-browser return leg (signed reply → all 8 receiver checks
  green, fragment scrubbed from history); live-browser tampered payload →
  "REPLY REFUSED… nothing was stored".
- **Human leg verified (2026/08/19):** a hands-on run with a real passkey —
  ClubCoin launch → Passport onboarding with Touch ID → consent sheet →
  signed return — ended with the receiver reporting "Verified — signed by the
  Passport that owns the address below" for `utkarsh.night`, all eight
  receiver checks green.

## Process corrections owed from the alignment call

- **Smaller PRs:** the split (PWA → demo backend → connectors, stacked) will be
  applied when this branch is broken up for review, and to new work from the
  start.
- **Node-fs artefact loading:** fixed for both contract families — Midnames
  and the account contract load ZK artefacts over URL, staged at build time.
- **Midnames team:** the alias resolver as their owned service remains open on
  their side; the demo still routes locally.

## Asks

1. **§1.1 Dynamic path** (Nicolas) — blocking Dynamic's own start for TOKEN2049.
2. **§2.1 formal path** (Nicolas) — Path 4 works for the demo; the SDK's answer
   is still needed.
3. **§2.2 backup approach** (Nicolas) — the TOKEN2049 migration story depends on it.
4. **Hub naming/parking** (Hector/Karmel) — one word and it changes.
5. **Otrix and Firebase notifications** (Karmel) — need scoping before any build.
