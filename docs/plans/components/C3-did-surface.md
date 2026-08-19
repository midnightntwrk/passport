# C3 · DID surface

> **Workstream.** What Passport's canonical public DID profile is within
> the Midnight DID family, how the account name links to it, whether one
> account may maintain several DIDs for different profiles, and whether
> DID-facing behaviour is embedded in Passport or delegated to Identity
> Wallet.

**Serves:** P2 (tentative).

## Outcome

A clear position on how Passport accounts interoperate with W3C DID
standards. Specifically: what the canonical public Passport DID is, how
that DID relates to the name service (C2), whether additional
profile-specific DIDs exist per account, what the DID Document exposes
(verification methods, services, aliases), how name ownership is proven
when a DID Document links to `alice.passport.night`, and whether DID-facing
behaviour is embedded in Passport or delegated to Identity Wallet.

**Cross-chain consideration.** With P10 (Chain abstraction) in scope, a
stable public DID that resolves to the same Passport identity across
multiple chains becomes valuable. This favours a companion account-level
DID over per-device DIDs, while still allowing additional
profile-specific DIDs where users want separation.

This canvas frames the decision space, not the answer.

## Dependencies

- **C2** (Name service) — the DID may link to the name, remain separate
  from it, or coexist with multiple profile-specific DIDs controlled by
  the same account.
- **C9** (Device-bound auth) — DID Document verification methods are
  likely derived from per-device public keys, even if not all of them
  are exposed publicly.
- **C18 – C21** (credential cluster) — DIDs are paired with verifiable
  credentials; the credentials cluster's public identity primitive and
  holder-binding strategy depend on this decision.
- **C8** (Domain-separation registry) — DID-related hashes need domain
  separation if DIDs are derived on-chain.
- **External — `did:midnight` registry status (nuanced).** The
  W3C-registered method name `did:midnight` belongs to IAMX AG, who hold
  the standards-process contact. *However*, our team has subsequently
  picked up the work, rewritten the spec, and now authors the current
  version in the `midnight-did` repo. The first commit of that repo
  carried IAMX's original (registry-like, single-contract, custodial)
  design; the current version is substantially different from it. So the
  **method-name registration remains with IAMX, but the current spec is
  in our hands**. The local DID survey at
  [`docs/reference/.../credentials/did-investigation/did-midnight.md`](../../reference/machine-investigation/key-flows/credentials/did-investigation/did-midnight.md)
  evaluates IAMX's *original* design; that evaluation does not describe
  the current spec.
- **External — active `midnight-did` effort.** The current spec and a
  growing Compact reference implementation live in
  [`midnightntwrk/midnight-did`](https://github.com/midnightntwrk/midnight-did)
  (plus additional shielded repositories). The effort is led from
  within IOG's Midnight DID work, with months of focused development
  and prior decentralised-identity background behind it. Closing this
  workstream **runs through engagement with that effort** —
  integration, wrapping, or co-authorship — rather
  than starting from scratch. Several Compact / Midnight ledger caveats
  have already been hit and worked around inside `midnight-did`; that
  hard-won knowledge is upstream of every component touching identity,
  not only C3.
- **External — Identity Wallet (if delegated delivery is chosen).** If
  Passport delegates DID-facing behaviour, the wallet becomes a protocol
  and capability dependency for DID authentication, issuance,
  verification, callbacks, and profile selection.
- **External — NightFi demo (review pending).** A demo built jointly
  with the Midnight Foundation lives at
  [`Midnight-Passport-Demo/NightFi`](https://github.com/Midnight-Passport-Demo/NightFi),
  under what looks like an umbrella `Midnight-Passport-Demo` org for
  Foundation-coordinated demos. Sibling to the `midnight-did` effort.
  *To review:* which Passport components and promises NightFi actually
  exercises (identity / dApp connection / cross-chain / chain
  abstraction), and which surfaces are demo-tested vs. only
  spec-described. Outcome of that review may move parts of this entry
  to C23, C25, or P10.

## Open questions

**Canonical public DID.** Is the canonical Passport public DID a
companion `midnight-did` subject, or a future profile layered directly
over account custody? What does resolution look like in each case?

**Method-name negotiation.** Softer constraint than "the name is taken".
IAMX owns the W3C registry entry for `did:midnight`; our team owns the
current spec (`midnight-did` repo). Three sub-questions: (1) Can we
negotiate with IAMX to reclaim the method name, or share authorship of
the W3C-published reference? (2) If yes, do we adopt the current
`midnight-did` spec as-is or fork it? (3) If no, we pick a fresh name —
`did:passport`, `did:mn`, or `did:midnight-passport`.

**Multiple DIDs per account.** Can one Passport account maintain several
DIDs for different profiles or user preferences? If yes, which one is
the default public DID, and how are profile-specific DIDs selected?

**Name linkage and proof.** Can the account name (`alice.passport.night`
per C2's decided shape) be exposed as a stable
URI or URL and linked from the DID Document via `alsoKnownAs`? If yes,
what proves that the DID subject actually controls that name, rather
than merely asserting a link?

**DID Document content and privacy.** Which verification methods and
services are public? Which device-management details remain private? If
Passport links the name through `alsoKnownAs`, what else is mandatory
versus optional in the DID Document?

**Recovery interaction.** Does total-loss recovery (P5 / C14) preserve
the canonical public DID, or replace it? If replaced, what continuity
mechanism exists for previously-issued credentials and name linkage?

**Delivery model.** Is DID-facing behaviour embedded inside Passport or
delegated to Identity Wallet? If delegated, what protocol coordinates
authentication, issuance, verification, callbacks, and DID/profile
selection?

**VC binding model.** Which flows use explicit DID holder binding, and
which flows prefer hidden-holder binding for stronger privacy? The DID
surface should interoperate with the VC stack without forcing every
credential flow through one public identifier.

**Proof cost in Compact.** Some did-core surfaces in the current
`midnight-did` Compact examples reach **k=19**, which is slow on the
proof server. Whether the workstream resolution lives with that cost,
relocates it, or avoids it for some operations remains open. Until the
driving operation is identified, k=19 is a known cost ceiling for some
did-core-shaped circuits and a constraint on what the DID surface can
promise client-side.

## Failure modes

**DID – name divergence.** C2 (name) and C3 (DID) drift — user changes
name but DID points to old name (or vice versa). *Detection:* a
registered DID resolves to stale state; the name registry and the DID
resolver disagree on identity.

**Alias assertion mistaken for proof.** A relying party treats
`alsoKnownAs` as proof that the DID subject owns `alice.passport.night`, even
though it is only an assertion. *Detection:* DID Document contains a
name URL but the system cannot explain why that link is authoritative.

**Multi-DID profile confusion.** One account controls several DIDs, but
verifiers or user flows select the wrong one for the intended purpose.
*Detection:* profile-specific integrations fail because the presented DID
does not match the expected trust or privacy profile.

**DID-Document privacy leak.** Per-account DID Documents reveal too much
device topology — every exposed device key becomes globally readable.
*Detection:* on-chain analysis enumerates device key sets per account,
exposing more operational detail than intended.

**Delegated-wallet coupling.** If DID-facing behaviour is delegated, the
wallet becomes a hard dependency and flow orchestration breaks when the
wallet's capabilities or protocol contract drift. *Detection:* Passport
cannot complete DID auth, issuance, or verification without a specific
wallet build or callback contract.

**Recovery breaks DID continuity.** Recovery (C14) creates a new DID
despite same account identity. *Detection:* a recovered user's
previously-issued credentials reference an unresolvable or deprecated
DID; the user's continuity is preserved at the account or name level,
but not at the DID level.

## Alternatives

**A — No DID layer.** Passport uses the account name (C2,
`alice.passport.night`) as the sole identifier. VCs use the name
directly via a custom Passport-defined VC schema. Compatible with v1.0
today; punts W3C DID interop entirely.

**B — Companion `did:midnight`, embedded in Passport.** Passport adopts
a companion public `did:midnight` identifier distinct from the name.
Passport owns DID-facing behaviour directly — authentication, issuance,
verification, and DID/profile selection live inside the Passport
product boundary.

**C — Companion `did:midnight`, delegated to Identity Wallet.**
Passport adopts a companion public `did:midnight` identifier distinct
from the name, but delegates DID-facing behaviour to Identity Wallet.
Passport keeps the account and orchestration layer; the wallet owns DID
and VC lifecycle machinery.

**D — Multi-DID profile model, embedded in Passport.** One account has a
canonical public `did:midnight` plus additional profile-specific DIDs
for different privacy or integration needs. Passport owns DID lifecycle
and protocol surfaces directly.

**E — Multi-DID profile model, delegated to Identity Wallet.** One
account has a canonical public `did:midnight` plus additional
profile-specific DIDs, while Identity Wallet owns DID and VC lifecycle
behaviour and Passport coordinates with it.

**F — Defer.** Do not decide for v1.0. Track DID as a Milestone-2 concern;
ship v1.0 with no DID surface and revisit when credential interop
demands it. Cost: external VC integrations during v1.0 must use the
name directly, which they may not support.

## Readings

- **MVP (October demo):** A or C — either no Passport-owned DID layer for
  the demo, or a delegated DID surface if Identity Wallet already owns
  the user flow in time.
- **v1.0 deliverable:** B or C — companion public `did:midnight`
  separate from the name, with the delivery model made explicit. D or E
  become additive if profile-specific multiple DIDs are needed.
