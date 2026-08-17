# C2 · Name service

**Serves:** P2 · P8 · P10.

**Maps to MIP:** upstream **MIP-0007 — name service registry**, adopted
as deployed. No Passport-authored name service MIP: drafting a parallel
standard would duplicate or contradict the canonical one.

## Outcome

Name ↔ account binding plus name resolution. Every account has a stable,
human-readable name (P2). Resolves to chain-native addresses for
transfers and to Passport's account anchor (C1) for protocol operations.
Cross-chain extensions via P10 / C25.

**Status 2026/07 — decided.** Passport adopts the upstream name service
as deployed (MIP-0007) rather than building its own. The Midnight
Foundation is to acquire the **`passport.night`** domain and offer its
sub-domains **free of charge, first come, first served**; Passport
account names live under it (`alice.passport.night` → account anchor).
Resolution stays authoritative on-chain via the upstream registry, so
P2's no-off-chain-database invariant holds by inheritance. What this
canvas still owns is the sub-domain layer: issuance mechanics, squat
resistance, and Foundation policy under `passport.night`.

**Adoption condition satisfied upstream.** The fit assessment's number
one condition — the baseline owner gate is a preimage commitment,
which a 1-of-n device set or a FROST committee cannot pass, so a
multi-key account could not itself own a name — is answered: MIP-0007
now carries normative **forward-looking authorisation arms**, adding
an OPTIONAL contract-owned-names arm (cross-contract authorisation;
gated on cross-contract calls being live on the network) and an
OPTIONAL ECDSA-owner arm (gated on MIP-0003 availability), with
registries tagging the arm in use and names able to move between arms
via the ownership-transfer circuits. The contract-owned arm is exactly
the shape a Passport account contract needs; until it activates, a
name is held by a device-key-controlled owner commitment and migrates
to contract ownership when the arm goes live.

## Dependencies

- **C1** — names bind to account-custody contract instances.
- **C8** — namehash domain separation is the upstream standard's
  concern once adoption replaces authorship; Passport-side tags apply
  only if a sub-domain issuance contract is added.
- **C18 – C21** — names appear in credential payloads where appropriate.
- **C25** — cross-chain resolution boundary with the upstream MCS layer.
- **External** — the deployed upstream name service (MIP-0007); the
  Midnight Foundation's acquisition of `passport.night`.

## Open questions

**Sub-domain issuance mechanics.** On-chain first-come-first-served
registration under `passport.night`, or Foundation-operated issuance?
P8 (I-8.3) requires no single named operator on the onboarding critical
path — resolution is on-chain either way, but issuance through a
Foundation service would need a substitutable or self-serve path.

**Squat resistance under free FCFS.** Free, first-come-first-served
issuance invites bulk pre-registration of common names. Rate limits,
proof-of-personhood, reclaim policy — or accept squatting at the
sub-domain layer as the price of free onboarding?

**Name shape and branding.** Earlier material used `alice.midnight`;
the decided shape is `alice.passport.night`. Normalisation and
homoglyph policy are inherited from upstream; what Passport surfaces
display (full name vs. short form) is a UX question.

**Cross-chain resolution.** With P10 in scope, names need to resolve to
addresses on multiple chains. Mechanism sits upstream (resolver surface
or MCS layer); Passport consumes it.

**Reserved names.** Within `passport.night` this is Midnight Foundation
policy; what does Passport recommend (brand protection, offensive-name
policy, dispute handling)?

**Contract-owned-arm activation.** The forward-looking arm that lets
the account contract own its name is availability-gated on
cross-contract calls, which arrive with the next toolchain generation.
Until then: which owner commitment holds Passport names (a designated
device key? a dedicated naming key?), and what the migration ceremony
to contract ownership looks like when the arm activates.

## Failure modes

**Squatting at scale.** Free FCFS pre-registration of common names.
*Detection:* high fraction of registered names go unused or are listed
for sale.

**Homoglyph attack.** Visually-similar names confuse users. *Detection:*
phishing reports of confusable names; ENSIP-15 violation tests.

**Parent-domain dependency.** Passport naming hangs off a
Foundation-held domain: acquisition falls through, terms change, or the
parent registration lapses. *Detection:* `passport.night` status
monitoring; mitigation is Foundation-level custody and renewal policy
for the parent name.

**Issuance operator on the critical path.** If sub-domain issuance runs
through a single Foundation service with no self-serve path, onboarding
inherits a required operator (P8 tension). *Detection:* onboarding
fails closed when the issuance service is down.

**Cross-chain resolution drift.** Name resolves to different addresses
on different chains in a way that breaks user expectations. *Detection:*
user-visible name resolution disagrees with what dApp uses.

## Alternatives

**A — ENS-style two-contract** (registry + resolver). Superseded — the
upstream deployed service settles the contract topology; not a Passport
build item.

**B — Single-contract name service.** Superseded, same grounds.

**C — Hybrid with off-chain CCIP-Read.** Available later through
upstream evolution; not a Passport build item.

**D — Adopt the deployed upstream name service (MIP-0007) under
`passport.night`.** **Chosen 2026/07.** Midnight Foundation acquires
`passport.night` and offers free, first-come-first-served sub-domains;
Passport builds no name service and consumes the upstream registry.
