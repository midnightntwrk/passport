# Midnight Passport — MIPs Pipeline

The Midnight Improvement Proposals (MIPs) that Midnight Passport
produces or adopts. Midnight's improvement-proposal process is live:
problem statements (MPS) and proposals (MIP) move through the
MIP-0001 lifecycle in the
[midnightntwrk/midnight-improvement-proposals](https://github.com/midnightntwrk/midnight-improvement-proposals)
repository, with editor-assigned numbers and weekly review sessions.
Passport works through that process: problems are framed as MPSs,
standards land as MIPs, and every normative claim is backed by
evidence in this workspace (an experiment, a reference
implementation, or a cryptographer review).

The MIPs are the central body of v1.0 deliverables. The October MVP
consumes them as they firm up — the account keystone is already
published upstream and implemented; the remaining MIPs continue toward
feature-complete v1.0.

Each MIP names an external co-author or committed external reviewer —
unilateral drafts become shelfware. The adoption narrative tracks who
that counterpart is for each MIP.

Last updated: 2026/08/17.

---

## Published upstream (Passport-authored; upstream copy is canonical)

| Upstream ID | Title | Status | Component |
|---|---|---|---|
| **MPS-0018** | Multi-key Account Custody for Midnight-Native Assets | Proposed | C1 · C4 |
| **MPS-0027** | Domain Separation for Midnight Hash Constructions | Proposed | C8 |
| **MIP-0012** | Contract Custody of Midnight-Native Assets | Proposed | C4 · C1 |
| **MIP-0013** | Multi-key Account Authorisation for Custody Contracts | Proposed | C1 · C5 |

MIP-0012 and MIP-0013 are the two building blocks of the multi-key
account keystone MPS-0018 recommends. Implementing them surfaced three
errata — the direct-transfer return signature, the unconditional DST
derivation, and the post-deploy bootstrap — all proposed and merged
upstream, so the published texts match what the reference
implementation (`contract/`) exercises. The direct
contract-to-contract validation also restated the payment-mode section
upstream: one-hop counterparty-private routing and linking-accepted
direct transfer are both normative.

**Path to Active for the keystone pair.** Cryptographer review of the
signature scheme (an explicit acceptance criterion), the FROST
ciphersuite specification with a t-of-n committee demonstration, a
second independent implementation, and ecosystem review in the
upstream discussion venues.

## Adopted upstream (not Passport-authored)

### Key derivation & address format — MIP-0003 (Accepted)

The HD derivation tree (`m / 44' / 2400' / account' / role / index`,
the role table, and coin type **2400**) and the `mn_addr` Bech32m
address format are specified in Midnight's WalletEngine Specification,
extended by **MIP-0003 (ECDSA support)**, now Accepted upstream.
Passport **adopts** these rather than drafting parallel standards; the
ARC review that strengthened MIP-0003 concluded when the proposal was
accepted. The one derivation concern *not* covered upstream — deriving
the device key from a WebAuthn passkey (PRF → JubJub scalar) — lives
in [C9](components/C9-device-bound-authentication.md) and is a
candidate MIP of its own (below).

### Name service — MIP-0007 (Proposed; adopted, with our amendment merged)

Passport adopts the deployed upstream name service (MIP-0007,
addressing the Accepted MPS-0012 on human-readable aliasing) rather
than authoring a parallel standard. The fit assessment's number-one
condition is satisfied: MIP-0007 now carries normative
**forward-looking authorisation arms** — contract-owned names via
cross-contract authorisation (the arm a multi-key account contract
needs) and ECDSA owners, both availability-gated. The contract-owned
arm's mechanism is no longer hypothetical:
`experiments/cross-contract-calls` validated seam-gated account
circuits driven through the call boundary and atomic value transfer
across it on the ledger-9 toolchain (2026/09/03); the remaining gate
is a public network on that ledger. What remains
Passport-side is the `passport.night` sub-domain layer: issuance
mechanics, squat resistance, and Foundation policy. See
[C2](components/C2-name-service.md).

### Chain identifiers — MIP-0008 (Draft)

CAIP-2 network identifiers of the `midnight:mainnet` style. Passport
surfaces that need a chain identifier follow it.

---

## In the pipeline (Passport-authored, not yet filed)

### Recovery paths — building block three

**Scope.** Total-loss recovery behind the account standard's recovery
seam, whose interface MIP-0013 fixes (epoch bump, single fresh
device). Mechanism decided: BUSS / ANARKey stateless guardians plus
paper keys (ePrint 2025/551), implemented in the account-custody
prototype (shared guardian wire formats across CLI and app). The MIP
specifies the construction, the guardian protocol and wire formats,
the paper-key format, and parameters, with DeRec and encrypted-blob
backup as substitutable profiles behind the same seam. The upstream
recovery slot is unclaimed; no other recovery MPS or MIP has been
filed.

**Maps to components.** [C14](components/C14-total-loss-recovery-flow.md) ·
[C15](components/C15-helper-protocol.md) ·
[C13](components/C13-lost-device-flow.md).

### Domain-separation registry

**Scope.** The registry MPS-0027 motivates: every `persistentHash` use
site gets a domain prefix, recorded centrally (ADR-0001: central
registry, compile-time enforcement deferred). The custody and
account-authorisation MIPs already name their tags against the future
registry (`midnight:custody:inbox:v1`, `midnight:account:device:v1`,
`midnight:account:auth:v1:*`, `midnight:account:boot:v1`).
Cryptographer review gates ratification. Evidence:
`experiments/domain-separation-inventory/`. The case has sharpened:
upstream code now ships an untagged JubJub Schnorr challenge, and the
unpublished `persistentHash` byte framing has been raised as a gap by
others in the upstream venues.

**Maps to component.** [C8](components/C8-domain-separation-registry.md).

### dApp ↔ Wallet Connection Protocol

**Scope.** The connection surface third-party dApps build against —
Open Wallet Standard is the chosen direction, with CAIP-25, EIP-6963,
and WalletConnect v2 as underlying transport and discovery layers, and
privacy scopes plus an asynchronous proof lifecycle on top.

**Maps to component.** [C23](components/C23-dapp-connection-protocol.md).

### DecentralisedAuth (sign-in)

**Scope.** Privacy-preserving dApp sign-in — the "sign-in-with-Passport"
primitive that does not leak the user's address or identity to the dApp
by default. Sister protocol to the connection MIP: connection covers
capability grants, this covers authentication.

**Maps to component.** [C23](components/C23-dapp-connection-protocol.md).

### Privacy-preserving credentials

**Scope.** Attestation-tree domain separators, nullifier construction,
and multi-issuer support for privacy-preserving verifiable
credentials.

**Maps to component.** [C20](components/C20-selective-disclosure-proof.md)
(with C18 · C19 · C21).

### Candidate MIPs

- **Passkey-derived device keys** — the PRF → JubJub scalar
  derivation, domain-separated under the registry; graduates from C9
  if it needs to become a standard for cross-wallet portability.
- **Scoped-grant extension** — MIP-0013 deliberately reserves scoped
  grants as a successor extension behind the same authorisation seam;
  C10 – C12 own the schema it will carry.
- **secp256r1 (P-256) signature verification** — the upstream
  signature-verification MPS family stops at RSA and secp256k1, and
  the proof system now carries a first-class P-256 chip; the slot is
  unclaimed and Passport holds the passkey-gate evidence.

---

## Process notes

- Problems are filed as MPSs, standards as MIPs, per the upstream
  MIP-0001 lifecycle: Draft status on entry, editor-assigned numbers,
  and the MPS header's Proposed Solutions field linking the MIPs that
  address it.
- Local working copies live in [`docs/mps-mip/`](../mps-mip/); once a
  document merges upstream, the upstream copy is canonical.
- Each MIP names its external co-author or committed reviewer at
  draft time. If none can be named, the MIP is not yet ready to
  start.
- Earlier internal pipeline labels map to the upstream register as
  follows: MIP-3A → MIP-0012, MIP-3B → MIP-0013, STD-03 → the
  domain-separation registry (MPS-0027 lineage), MIP-4 → recovery
  paths, MIP-5 / MIP-7 → connection and sign-in, MIP-6 → credentials,
  MIP-8 / STD-06 → superseded by the MIP-0007 adoption.
