# Agent DID Registry Prior Art — ARC Passport

**Domain:** DID surface (C3), credential issuance (C19), and selective-disclosure proof (C20) on Midnight
**Researched:** 2026/08/25
**Confidence:** MEDIUM — reviewed from the published Compact source and README; the repository is explicitly research-grade and not hardened for production.

---

## 0. How to read this document

This note is a case study of one working Midnight-native implementation —
the [Midnight Agent DID Manager](https://github.com/mzf11125/midnight-agent-did-manager) —
as prior art for the open C3 (DID surface) workstream and the credential
cluster (C19 issuance, C20 selective disclosure). It records what the
implementation commits to and which open canvas question each property
bears on, and flags where the implementation does *not* address a
question — evidence that the question remains open rather than settled.

The project is a React + Vite application and a local Node/Postgres
service that connects to Midnight Preprod/Preview through a real 1AM
wallet and drives a Compact DID registry of record
(`contracts/did_registry.compact`, v0.3.5). Its stated purpose is DID
issuance and selective-disclosure Verifiable Credentials for AI agents.
It is research-grade, not production.

## 1. What the registry holds

Per agent (a `Bytes<32>` key), the contract keeps:

- `status_by_agent` — a lifecycle status: none / pending issuance /
  active / revoked / pending update / pending revocation;
- `did_commitments`, `document_commitments`, `proof_commitments` — the
  DID, its document, and its proof material, each held as a `Bytes<32>`
  commitment rather than plaintext;
- `request_commitments`, `update_request_commitments`,
  `revocation_request_commitments` — lifecycle requests, also committed;
- `organization_labels` / `organization_disclosures` — an optional
  organisation label with an explicit disclosure flag (0 or 1).

The lifecycle is six circuits — `request_did`, `issue_did`, `update_did`,
`revoke_did`, plus `request_update` and `request_revoke`. Issuance is
permissioned: `issue_did` reconstructs the issuer key from an
`issuerSecret()` witness as
`persistentHash(["midnight:did:issuer:v1", secret, nonce])` and asserts it
equals the `issuer_service` ledger entry before acting.

## 2. C3 — DID surface

**Delivery model.** The registry is *holder-facing*: the DID is requested,
updated, and revoked by the agent or its operator through a small set of
request/issue/update/revoke circuits, with an issuer service gating
issuance. This is a concrete data point for C3's delivery-model question
(embedded in Passport versus delegated): it shows a DID surface that lives
outside any wallet product and is driven by a minimal registry contract,
with W3C-aligned resolution performed against that registry.

**DID Document content and privacy.** Resolution is W3C-aligned and
credentials are JWT VCs, but the on-chain registry stores only `Bytes<32>`
commitments — the DID document and VC content are disclosed by the holder,
not published on-chain. This bears directly on C3's DID-Document
content/privacy question: the chain never carries plaintext document
material, so there is no on-chain device-topology or attribute surface to
leak.

**Not addressed.** The registry does not exercise a fresh DID method name
(it is registry-backed rather than a method spec), does not link a
human-readable name with proof of control, does not define a multi-profile
DID model, and does not reason about recovery continuity. These C3
questions remain open — the implementation's silence is evidence for the
canvas, not against it.

## 3. C19 — Credential issuance

**Issuer onboarding.** A single `issuer_service` key, set at construction
and checked on every `issue_did`, is a permissioned, single-issuer model —
C19 Alternative A by construction, with no governance-gated or
permissionless onboarding.

**Issuance privacy.** Because request and issue state are commitments
rather than plaintext, the issuance transaction does not reveal the DID or
document content to chain observers. This addresses C19's issuance-privacy
question directly.

**Revocation.** `revoke_did` (and the pending `request_revoke` arm) gives a
revocation path decoupled from issuance — the shape C19's issuer-revocation
question points at.

**Not addressed.** There is no issuer-reputation or browsing surface: the
user does not choose among issuers.

## 4. C20 — Selective-disclosure proof

**Commitment-based holder-side selective disclosure.** Every
identity-bearing ledger is a commitment, and the `organization_disclosures`
flag lets the holder choose whether an organisation label is public. The
holder discloses DID document and VC content off-chain, backed by the
on-chain commitments. This is a working, Compact-native instance of C20
Alternative A (Compact-circuit proofs of membership) with the disclosure
decision moved to the holder side.

**Predicate expressiveness.** The registry demonstrates
set-membership-plus-optional-label disclosure; it does not implement
range, equality, or custom predicates, so C20's predicate-expressiveness
question stays open beyond that point.

**Proof size and cost.** The registry stores fixed-width `Bytes<32>`
commitments and runs the lifecycle as six small circuits, which keeps
per-operation cost low compared with the k=19 did-core-shaped circuits C3's
canvas records as a ceiling. No measured proof-size figure is published, so
this is a structural observation, not a benchmark.

## 5. Observations

1. **Commitment-based selective disclosure is a working Compact path** for
   C20 Alternative A — it holds commitments on-chain and lets the holder
   disclose, avoiding did-core's k=19 cost ceiling.
2. **A holder-facing, self-managing registry is a viable C3 delivery
   model**, independent of any wallet product.
3. **Name linkage and recovery continuity remain genuinely open.** The
   registry addresses neither, confirming those two C3 questions are the
   least informed by existing ecosystem work.
