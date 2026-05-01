# C3 · DID surface

> **Workstream.** Whether `alice.midnight` is itself the DID, whether DID
> is a separate identifier layer, and what DID method (if any) Passport
> defines.

**Serves:** P2 (tentative).

## Outcome

A clear position on whether and how Passport accounts interoperate with
W3C DID standards. Specifically: what DID method (if any) Passport
defines, how that method relates to the name service (C2), what the DID
Document exposes (verification methods, services, aliases), and how
external systems consume Passport identifiers via DID-shaped APIs.

**Cross-chain consideration.** With P10 (Chain abstraction) in scope, a
DID that resolves to the same Passport identity across multiple chains
becomes valuable. This shifts the trade-off: alternative B (DID == name)
gets cheaper because one identifier handle works across all chains the
user transacts on, with cross-chain resolution mediated by the upstream
MCS layer rather than by per-chain DID documents. Alternative E
(`did:key` per device) becomes harder because cross-chain identity at the
per-device-key level breaks the "single account identifier" goal in
I-10.1.

This canvas frames the decision space, not the answer.

## Dependencies

- **C2** (Name service) — the DID may *be* the name, *include* the name,
  or be entirely separate.
- **C9** (Device-bound auth) — DID Document verification methods are
  likely the per-device public keys.
- **C18 – C21** (credential cluster) — DIDs are typically paired with
  verifiable credentials; the credentials cluster's identity primitive
  depends on this decision.
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

## Open questions

**Does Passport define a DID method at all?** Or do we operate without a
DID layer and only adopt one when an external integration demands it?

**Method-name negotiation.** Softer constraint than "the name is taken".
IAMX owns the W3C registry entry for `did:midnight`; our team owns the
current spec (`midnight-did` repo). Three sub-questions: (1) Can we
negotiate with IAMX to reclaim the method name, or share authorship of
the W3C-published reference? (2) If yes, do we adopt the current
`midnight-did` spec as-is or fork it? (3) If no, we pick a fresh name —
`did:passport`, `did:mn`, or `did:midnight-passport`.

**Identifier shape.** What does the method-specific identifier look like?
Name-based (`did:passport:alice`)? Public-key-based (`did:key`-style)?
UUID? Hash of the account-custody contract address? Each shape has
different stability, privacy, and resolution properties.

**DID Document content.** Verification methods (per-device public keys),
services (Passport API endpoints), `alsoKnownAs` linking to the
human-readable name, key controllers? What's mandatory and what's
optional?

**Resolution model.** Chain query, off-chain resolver service, both, or
`did:web`-shaped over an HTTP endpoint?

**DID Document privacy.** DID Documents are typically public. If
Passport's DID Document lists per-device verification methods, the device
topology of every account becomes globally enumerable. Tension with
attribute-privacy expectations even if not strictly violating P9.

**Update lifecycle.** How do device additions and revocations (C13)
propagate to the DID Document? Same-block update? Eventual consistency
with chain state?

**Recovery interaction.** Does total-loss recovery (P5 / C14) preserve
the DID, or replace it? If replaced, previously-issued credentials
reference an unresolvable DID — significant interop hazard.

**VC integration target.** Which verifiable-credential standards are we
targeting (W3C VC Data Model 1.1 vs 2.0; JWT-VC vs LD-VC; BBS+, ZK-SNARK
selective disclosure)? The DID method has to be compatible with the
chosen VC stack.

## Failure modes

**DID – name divergence.** C2 (name) and C3 (DID) drift — user changes
name but DID points to old name (or vice versa). *Detection:* a
registered DID resolves to stale state; the name registry and the DID
resolver disagree on identity.

**Method-name negotiation breaks down.** We want `did:midnight` for
ecosystem coherence but cannot reach an arrangement with IAMX over the
W3C registry. *Detection:* the W3C registry continues pointing to IAMX's
spec while the team's current spec sits in `midnight-did` without
authoritative recognition; external resolvers can't disambiguate the two
intended interpretations. *Mitigation:* fall back to a Passport-specific
method name (`did:passport`, etc.).

**DID-Document privacy leak.** Per-account DID Documents reveal device
topology — every device public key becomes globally readable. *Detection:*
on-chain analysis enumerates device key sets per account, exposing how
many devices each user has.

**VC interop assumption breaks.** A target VC ecosystem requires a
specific DID method or signature suite Passport doesn't support.
*Detection:* a candidate VC issuer can't issue against Passport accounts;
a candidate verifier can't verify a Passport-issued VC.

**Standardisation lag.** Passport-defined DID method takes too long to
publish through W3C / DIF / Cheqd registries; ecosystem can't consume it.
*Detection:* external verifiers reject `did:<method>:...` resolutions
because no published spec exists.

**Recovery breaks DID.** Recovery (C14) creates a new DID despite same
account identity. *Detection:* a recovered user's previously-issued
credentials reference an unresolvable DID; the user's identity continuity
(I-5.3) is preserved at the name level but not at the DID level.

## Alternatives

**A — No DID layer.** Passport uses `alice.midnight` (C2) as the sole
identifier. VCs use the name directly via a custom Passport-defined VC
schema. Compatible with v1.0 today; punts W3C DID interop entirely.

**B — DID == name.** Define a Passport-specific DID method whose
identifier *is* the name. Method name is either `did:midnight` (subject to
IAMX coordination on the W3C registry — feasible because our team holds
the current spec) or a fresh name (`did:passport`, `did:mn`) if
coordination can't be reached. Adopting the current `midnight-did` spec
as the starting point shortens the path. DID Document is derived from
chain state — verification methods are registered device public keys,
services are Passport endpoints, `alsoKnownAs` includes the
human-readable name. One identity, two presentations.

**C — DID separate from name.** Passport accounts have both a name (C2)
and a DID. The DID is a stable opaque identifier — UUID, public key, or
hash; the name is a human-readable alias. DID Document includes the name
as `alsoKnownAs`. More W3C-idiomatic; weaker tie between presentations.

**D — Adapter only.** Passport's primary identifier is `alice.midnight`;
an adapter layer presents accounts as DIDs to external systems but
doesn't change the internal model. Method could be `did:web`
(HTTP-resolvable) over a Passport-hosted endpoint, with no on-chain DID
Document. Lowest commitment; weakest decentralisation story.

**E — Inherit `did:key` per device.** No account-level DID. Each device's
public key is a `did:key:...`. Verifiers resolve the device key as the
DID; Passport's account anchor (C1) is referenced via a `service` entry.
No name-registry dependency on the DID side; cleanest cryptographic
story; but identity becomes per-device, not per-account.

**F — Defer.** Don't decide for v1.0. Track DID as a Milestone-2 concern;
ship v1.0 with no DID surface and revisit when credential interop demands
it. Cost: external VC integrations during v1.0 must use the name
directly, which they may not support.

## Track readings

- **Track 1 (Demo):** A or F — no DID layer for the demo. Parks the
  question; the demo uses `alice.midnight` directly.
- **Track 2 (Spec / v1.0):** B (DID == name), with method-name
  coordination as the live sub-question. Adopting the current
  `midnight-did` spec as the starting point shortens the path.
