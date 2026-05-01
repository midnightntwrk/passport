# C22 · Intent surface

> **Workstream.** What abstraction does Passport present over the ledger
> Intent and the upstream trade-intent layers?

**Serves:** principle tagging carried in the workstream itself; bears on
P7, P8, P10.

## Outcome

A clear position on Passport's wallet-side intent surface: how the
user-facing **trade intent** (declarative — "I want Y of B for X of A") is
translated into the **ledger `Intent` struct** that the user authorises by
signing, what the wallet UI presents to the user before signing, and what
shape the dApp connection protocol (C23) passes between dApps and the
wallet.

The native intent layer is no longer an open question. Midnight's ledger
has the `Intent` struct natively; Shielded Technologies has the
higher-level PRD trade-intent format. Passport's job is to be the
wallet-side bridge between the user's declarative trade intent and the
ledger Intent that authorises it.

## Dependencies

- **Ledger `Intent` struct** (Midnight protocol primitive). Carries
  `guaranteed_unshielded_offer`, `fallible_unshielded_offer`, `actions`,
  `dust_actions`, `ttl`, `binding_commitment`. Unshielded side authorised
  by signatures; shielded side authorised by ZK proofs over the bound
  `ZswapOffer`. Defined upstream — Passport does not redesign it.
- **PRD trade intent** (upstream — Midnight Intents PRD). Declarative
  high-level format the solver fills. Adopting it verbatim is one
  alternative; defining a Passport translation is another.
- **Upstream Intent Escrow Contract** (Compact) — orchestrates
  trade-intent lifecycle on-chain.
- **C5** (Signing primitive) — Schnorr-on-Jubjub for the unshielded
  authorisation; ZK proofs (via C6) for the shielded side.
- **C7** (Witness handling) — `binding_commitment` cryptographically ties
  the unshielded Intent and the shielded ZswapOffer; witnesses pass
  through to proof generation.
- **C10 · C11 · C12** (Scoped grants + lifecycle + enforcement) — grants
  must compose with the ledger Intent's authorisation surface.
- **C20** (Selective-disclosure proof) — Passport's compliance
  contribution; needs to bind to the trade intent the user signs.
- **C23** (dApp connection protocol) — carries trade intents (or ledger
  Intents) between dApp and wallet via CAIP-25-shaped methods.
- **C25** (Cross-chain integration interface) — the boundary at which
  trade intents flow into the upstream solver / MCS layer.

## Open questions

**Trade-intent format — Passport-defined or upstream-conformant?** The
PRD defines a declarative trade-intent format. Does Passport adopt it
verbatim, contribute to it, or define a Passport-side wrapper that
translates to PRD format at the wallet / solver boundary? Verbatim
minimises divergence; a wrapper allows wallet-UX-driven extensions and
protects against PRD churn.

**What does the wallet UI present at signing time?** Three reasonable
surfaces: (a) the declarative trade intent ("send 100 NIGHT to alice");
(b) a description of the resulting ledger Intent (segments, dust_actions,
contract actions); (c) hybrid, with the declarative summary plus an
expandable Intent fingerprint. Each has different transparency /
usability trade-offs.

**Compliance proof binding.** Selective-disclosure proofs (C20) are
Passport's deliverable. How do they bind cryptographically to the trade
intent — by sharing the same `binding_commitment`, by a separate proof
carried alongside, or by inclusion in the Intent's `actions`? Affects
whether the same compliance proof can be replayed against unrelated
intents.

**Multi-segment user experience.** The ledger allows multiple Intents per
Transaction (segment-keyed). Does Passport's wallet UX expose multi-Intent
transactions to the user — "swap and stake in one approval" — or
constrain to single-Intent per signing for simplicity?

**Guaranteed-vs-fallible visibility.** Segment 0 (guaranteed) carries
dust fees and always executes; fallible segments roll back independently.
Does the wallet UI surface this segmentation, or hide it? Hidden risks
user confusion if a fallible segment fails (e.g., they paid dust but the
swap didn't go through).

**dApp interchange format.** What flows through C23 — a PRD-style
declarative trade intent, a Passport wrapper, or a partially-constructed
ledger Intent? Affects third-party dApp integration ergonomics.

**PMR (Private Message Relay) substitutability.** The upstream encrypted
relay is the channel between user and solver. P8 requires substitutability
— what does "another PMR" look like, and is the wallet free to use any
conforming relay?

**Replay protection sufficiency.** The ledger Intent's `ttl` and Zswap
binding handle replay at the protocol layer. Does Passport need any
wallet-side replay discipline beyond what the Intent struct already
provides?

## Failure modes

**Trade-intent format diverges from upstream PRD.** Passport adopts a
wallet-specific format the solver network can't consume. *Detection:*
user-built trade intents fail to find solver matches; or solver-built
ledger Intents don't reflect what the user intended.

**UI abstraction leak.** The wallet's declarative summary doesn't match
the underlying ledger Intent — extra contract actions, surprising
`dust_actions`, segment confusion. *Detection:* on-chain operation differs
from the user's understanding; comparing user-visible description to
actual Intent reveals undisclosed effects.

**Compliance proof not bound to intent.** Selective-disclosure proofs
travel separately from the trade intent and can be replayed against
different intents. *Detection:* the same compliance proof attaches to
multiple unrelated trade intents and is accepted by verifiers.

**PMR becomes a single point of dependency.** v1.0 ships using one PMR
operator without a substitutable interface. *Detection:* the wallet has
no fallback PMR configured, and no published spec for an alternative.

**Multi-segment confusion.** Users don't understand the guaranteed /
fallible split — they think "all-or-nothing" when in fact segment 0
always executes. *Detection:* user reports of unexpected dust deductions
on otherwise-failed transactions.

**Format churn upstream.** Upstream changes the ledger Intent struct or
PRD trade-intent format; Passport's wallet construction code breaks.
*Detection:* protocol release notes flag breaking changes; Passport tests
fail.

**Scope mismatch between grant and enforcement.** Grants (C10) are scoped
at one abstraction level; chain-side enforcement (C12) operates at a
different level (e.g., over ledger Intent shape). *Detection:* a grant
the user thought they made fails to authorise an operation, or authorises
one they didn't intend.

## Alternatives

**A — Trade intent as primary user-facing object.** The wallet UI
presents the declarative trade intent ("I want X for Y"); the user signs
an authorisation that translates to a ledger Intent. The Intent is shown
as expandable detail for power users. dApp connection protocol passes
trade intents. **Aligns with CAKE Applications-Layer semantics; aligns
with the upstream PRD.**

**B — Ledger Intent as primary user-facing object.** The wallet UI
presents the resulting ledger Intent (with descriptive overlays); the
user signs the Intent directly. dApps pass ledger Intents through the
connection protocol. Tightest cryptographic precision; lowest
abstraction-leak risk; weakest UX for declarative use cases.

**C — Hybrid by audience.** Wallet UI presents trade intents (alt A);
dApp connection protocol passes ledger Intents (alt B). Different
abstraction levels per consumer; doubles maintenance surface but matches
each audience's needs.

**D — Adopt upstream PRD format verbatim.** Passport contributes no new
trade-intent format; uses the PRD's directly. Lowest divergence risk;
least Passport ownership of the user-facing language. May constrain
wallet UX if the PRD format isn't optimised for end-user presentation.

**E — Consume upstream wallet SDK.** If Shielded Technologies ships a
wallet integration SDK, Passport consumes it rather than building its own
intent layer. Lowest effort; least Passport differentiation; depends on
SDK availability and licensing.

## Track readings

- **Track 1 (Demo):** D (adopt upstream PRD verbatim) — lowest divergence
  risk for a demo; the wallet-side UX is whatever the PRD format permits.
- **Track 2 (Spec / v1.0):** A (Passport-defined trade intent as primary
  user-facing object) — full UX ownership; the wallet's declarative
  summary is independent of upstream PRD churn.
