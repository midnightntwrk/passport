# Midnight Passport — MIPs Pipeline

The Midnight Improvement Proposals (MIPs) that Midnight Passport must produce.
Midnight has no formal improvement-proposal process yet; the Passport MIPs
are both the vehicle for interoperability and the forcing function that
creates that process.

The MIPs are the central body of v1.0 deliverables. The October MVP
consumes them as they firm up — MVP-window MIPs are the ones the MVP
build depends on; post-MVP MIPs continue toward feature-complete v1.0
after the October demo.

Every MIP ships with a **named external co-author** — unilateral drafts
become shelfware. The adoption narrative tracks who that co-author is
for each MIP.

Last updated: 2026/05/20.

---

## Pipeline at a glance

| MIP | Pipeline ID | Title | When |
|-----|-------------|-------|------|
| **MIP-8** | STD-06 | Name service registry | MVP-window |
| **MIP-3** | STD-04 | Multi-key account | Post-MVP |
| **MIP-4** | STD-05 | Recovery paths | Post-MVP |
| **MIP-5** | ECO-01 | dApp ↔ Wallet Connection Protocol | Post-MVP |
| **MIP-6** | ECO-02 | Privacy-preserving credentials | Post-MVP |
| **MIP-7** | ECO-03 | DecentralisedAuth | Post-MVP |

A cross-cutting prerequisite ships alongside the MIPs:

- **STD-03** — Domain-separation registry. Every `persistentHash` use
  site gets a prefix. Cryptographer-reviewed; required before
  credentials, signing, and naming can be ratified. Now framed by
  [`mps/mps-domain-separation.md`](../mps/mps-domain-separation.md) and
  decided in [ADR-0001](../adrs/0001-domain-separation-registry.md)
  (central registry; enforcement deferred); evidenced by
  `experiments/domain-separation-inventory/`.

---

## MVP-window MIPs

### Key derivation & address format — adopted upstream, not Passport-authored

The HD derivation tree (`m / 44' / 2400' / account' / role / index`, the role
table, and coin type **2400**) and the `mn_addr` Bech32m address format are
already specified in Midnight's WalletEngine Specification (ADR-0017 / 0019 /
0020, Proposal 0013), and **MIP-0003 (ECDSA support)** extends them. Passport
**adopts** these rather than drafting parallel standards — ARC's contribution is
reviewing and strengthening MIP-0003 directly
([discussion #129](https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/129)).
The one derivation concern *not* covered upstream — deriving the account root
from a WebAuthn passkey (PRF → seed) — lives in
[C9 — Device-bound authentication](components/C9-device-bound-authentication.md)
and can graduate to its own MIP if it needs to become a standard.

---

### MIP-8 · STD-06 — Name service registry

**Scope.** On-chain registry binding human-readable names (`alice.midnight`)
to Passport account anchors, with a resolver surface for chain-native
addresses and a hook for cross-chain resolution (P10 / C25). Includes
namehash construction (domain-separated via STD-03), ENSIP-15-aligned
normalisation, and an anti-squatting policy. The registry / resolver
split-vs-single question, the anti-squat mechanism, and the cross-chain
resolution shape remain open in the C2 canvas and resolve inside this MIP.

ARC's role on this MIP is **co-author / reviewer** — primary authorship
sits with the Midnight Foundation and a name service provider engaged
for the registry implementation.

**Maps to component.** [C2 — Name service](components/C2-name-service.md).

---

## Post-MVP MIPs

### MIP-3 · STD-04 — Multi-key account

**Scope.** On-chain multi-device contract — the authorisation surface that
allows a single Passport account to be controlled by multiple per-device
keys, with explicit add / rotate / revoke ceremonies.

**Maps to component.** [C1 — Account-custody contract](components/C1-account-custody-contract.md).

---

### MIP-4 · STD-05 — Recovery paths

**Scope.** The recovery surface: social recovery via DeRec helpers, plus
an encrypted-blob backup path for users without a social graph.

**Maps to component.** [C14 — Total-loss recovery flow](components/C14-total-loss-recovery-flow.md).

---

### MIP-5 · ECO-01 — dApp ↔ Wallet Connection Protocol

**Scope.** The CIP-30 equivalent for Midnight. CAIP-25-shaped, with privacy
scopes and an asynchronous proof lifecycle. This is what the wider
ecosystem builds against.

**Maps to component.** [C23 — dApp connection protocol](components/C23-dapp-connection-protocol.md).

---

### MIP-6 · ECO-02 — Privacy-preserving credentials

**Scope.** Attestation-tree domain separators, nullifier construction, and
multi-issuer support for privacy-preserving verifiable credentials.

**Maps to component.** [C20 — Selective-disclosure proof](components/C20-selective-disclosure-proof.md).

---

### MIP-7 · ECO-03 — DecentralisedAuth

**Scope.** Privacy-preserving dApp sign-in protocol — the
"sign-in-with-Passport" primitive that does not leak the user's address or
identity to the dApp by default. Sister protocol to MIP-5: MIP-5 covers
connection, MIP-7 covers authentication.

**Maps to component.** [C23 — dApp connection protocol](components/C23-dapp-connection-protocol.md).

---

## Process notes

- Each MIP opens as a pull request against the Midnight Improvement
  Proposals repository.
- Each MIP names its external co-author at draft time. If no co-author can
  be named, the MIP is not yet ready to start.
- MVP-window MIPs are the contract for adoption: if the Foundation and
  partner wallets cannot consume them, the MVP has not landed.

