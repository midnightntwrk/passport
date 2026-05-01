# Midnight Passport — MIPs Pipeline

The Midnight Improvement Proposals (MIPs) that Midnight Passport must produce.
Midnight has no formal improvement-proposal process yet; the Passport MIPs
are both the vehicle for interoperability and the forcing function that
creates that process.

Every MIP ships with a **named external co-author** — unilateral drafts
become shelfware. The adoption narrative (META-04) tracks who that
co-author is for each MIP.

Last updated: 2026/04/27.

---

## Pipeline at a glance

| MIP | Track ID | Title | Window |
|-----|----------|-------|--------|
| **MIP-1** | STD-01 | Key derivation paths | MVP (by June 2026) |
| **MIP-2** | STD-02 | Address format | MVP (by June 2026) |
| **MIP-3** | STD-04 | Multi-key account | Post-MVP near-term |
| **MIP-4** | STD-05 | Recovery paths | Milestone 3 |
| **MIP-5** | ECO-01 | dApp ↔ Wallet Connection Protocol | Milestone 2+ |
| **MIP-6** | ECO-02 | Privacy-preserving credentials | Milestone 2+ |
| **MIP-7** | ECO-03 | DecentralisedAuth | Milestone 2 |

Two prerequisite items are not MIPs but ship alongside them:

- **STD-03** — Domain-separation registry (cross-cutting, Phase 2). Every
  `persistentHash` use site gets a prefix.
- **MVP-08** — Client-signing specification and browser × OS support matrix
  (Phase 3' internal spec).

---

## MVP-window MIPs (by end of June 2026)

### MIP-1 · STD-01 — Key derivation paths

**Scope.** CIP-1852-aligned key derivation paths for Midnight, using coin
type **2400**. Defines the derivation tree from a single root through to
the three wallet roles (Shielded · Night · Dust).

**Notes.** OWS-aligned. Can run in parallel with Phase 3' (the client-side
signing spec).

**Maps to feature.** #2 — Key derivation in-wallet.

---

### MIP-2 · STD-02 — Address format

**Scope.** Bech32m-encoded addresses with the `mn_` human-readable prefix,
specified across all three wallet roles (Shielded, Night, Dust).

**Notes.** Runs in parallel with Phase 5 (the account provider plus name
registry).

**Maps to feature.** #2 — Key derivation in-wallet (consumer of the
addresses); #5 — Account name service (registry resolves names to these
addresses).

---

## Post-MVP near-term MIPs

### MIP-3 · STD-04 — Multi-key account

**Scope.** On-chain multi-device contract — the authorisation surface that
allows a single Passport account to be controlled by multiple per-device
keys, with explicit add/rotate/revoke ceremonies.

**Notes.** Gates recovery. Until this ships, account loss is possible and
must be stated to the user (R4). This is the contract side of feature #7
(authorisation key management) and the foundation for feature #8
(multi-device).

**Maps to features.** #7 — Authorisation key management; #8 — DeRec and
multi-device account.

---

## Milestone 2 and 3 MIPs

### MIP-4 · STD-05 — Recovery paths

**Scope.** The recovery surface: social recovery via DeRec helpers, plus an
encrypted-blob backup path for users without a social graph.

**Notes.** OWS-aligned. Milestone 3.

**Maps to feature.** #8 — DeRec and multi-device account.

---

### MIP-5 · ECO-01 — dApp ↔ Wallet Connection Protocol

**Scope.** The CIP-30 equivalent for Midnight. CAIP-25-shaped, with privacy
scopes and an asynchronous proof lifecycle. This is what the wider
ecosystem builds against.

**Notes.** Milestone 2+. The protocol the rest of the ecosystem depends on
to integrate Passport.

**Maps to feature.** #9 — API for third-party app authorisation access.

---

### MIP-6 · ECO-02 — Privacy-preserving credentials

**Scope.** Attestation-tree domain separators, nullifier construction, and
multi-issuer support for privacy-preserving verifiable credentials.

**Notes.** Milestone 2+. The standard underpinning principle 5
(privacy-by-design identity).

**Maps to feature.** Not in the current feature list — surfaces as a
Milestone 3 extension.

---

### MIP-7 · ECO-03 — DecentralisedAuth

**Scope.** Privacy-preserving dApp sign-in protocol — the
"sign-in-with-Passport" primitive that does not leak the user's address or
identity to the dApp by default.

**Notes.** Milestone 2.

**Maps to feature.** #9 — API for third-party app authorisation access
(sister protocol to MIP-5; MIP-5 covers connection, MIP-7 covers
authentication).

---

## Process notes

- Each MIP opens as a pull request against the Midnight Improvement
  Proposals repository.
- Each MIP names its external co-author at draft time. If no co-author can
  be named, the MIP is not yet ready to start.
- MVP-window MIPs (MIP-1, MIP-2) are the contract for adoption: if the
  Foundation, Lace, and partner wallets cannot consume them, the MVP has
  not landed.
