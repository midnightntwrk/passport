# Kredz Credit Credentials Prior Art — ARC Passport

**Domain:** Attestation tree (C18), credential issuance (C19), selective-disclosure proof (C20), and cross-chain integration (C25) on Midnight
**Researched:** 2026/08/25
**Confidence:** MEDIUM — reviewed from the published Compact source (`kredz_score_profile.compact`) and project documentation; the Midnight contract is compiled and deployed on Preprod, but the wider project is multi-chain and in active development.

---

## 0. How to read this document

This note is a case study of [Kredz](https://github.com/zkos-labs/kredz), a
privacy-preserving credit-identity protocol, as prior art for the credential
cluster (C18–C20) and cross-chain linking (C25). The relevant artefact is its
Midnight Compact contract,
`kredz-midnight/contracts/kredz_score_profile.compact` (five circuits),
compiled and deployed on Midnight Preprod and driven through a real 1AM
wallet. The project also ships Solidity (Base), Anchor (Solana), and DAML
(Canton) components, but those are portability ports and out of scope for
this note — the identity and credential logic lives on Midnight.

## 1. What the contract holds

The contract uses a single-attestor trust model: an `attestorSecret()`
witness proves the caller is the authorised scoring engine. Per user (a
`Bytes<32>` `user_pubkey`), the ledger holds:

- `score_hashes: Map<Bytes<32>, Bytes<32>>` — the credit score stored only
  as `persistentHash<ScoreData>({score, salt})`; the score and salt are
  private witnesses and never touch the chain;
- `tiers: Map<Bytes<32>, Uint<8>>` — a coarse privacy tier (0–2), the only
  score-derived value disclosed by default;
- `evm_linked` / `solana_linked` — a user's foreign-chain address recorded
  against their Midnight identity;
- `attestor_key` / `attestor_nonce` — a domain-separated, rotating attestor
  key, `persistentHash(["kredz:attestor:v1", secret, persistentHash(nonce)])`,
  so each transaction uses a fresh key.

The five circuits are `attest_score`, `prove_tier`, `prove_score_hash`,
`link_evm`, and `link_solana`.

## 2. C18 — Attestation tree (leaf construction)

**Attribute-as-commitment leaf.** `makeScoreHash` computes
`persistentHash<ScoreData>({score, salt})` — the exact shape C18's Outcome
calls a leaf (`persistentHash([domain_separator, …])`), with struct-typed
hashing providing implicit domain separation. The score is anchored on-chain
only as this commitment.

**Not a tree.** Kredz stores leaves in a flat per-user `Map`, not a Merkle
tree, so it does not exercise C18's depth/width, update, or concurrency
questions. Its value is as a worked example of the *leaf* and *domain
separation* concerns only.

## 3. C19 — Credential issuance

**Single-attestor issuance (Alternative A).** `attest_score` is gated on the
witness-derived `attestor_key`, so exactly one issuer — the scoring engine —
may contribute credentials: the permissioned, single-issuer model C19 lists
as Alternative A.

**Issuance privacy.** The attestation transaction discloses only the
`user_pubkey`, the tier, and the score commitment; the score and salt are
witnesses. A chain observer learns that an attestation exists, not the score.

**Not addressed.** No issuer-reputation surface, no rotation or delegation
of the attestor beyond the nonce, and no multi-issuer model.

## 4. C20 — Selective-disclosure proof

**Threshold and tier disclosure.** `prove_tier(user_pubkey)` returns only the
tier (0–2), never the score. `prove_score_hash(user_pubkey, score, salt)`
returns only a boolean "does this score match the committed hash". This is a
working Compact instance of C20's core primitive — the verifier learns a
predicate (tier, or exact-match) without learning the attribute value.

**Predicate expressiveness.** Demonstrates set-membership (tier) and
commitment-opening (hash equality). Range proofs, custom predicates, and
non-interactive presentation remain open.

## 5. C25 — Cross-chain integration interface

**Identity linking from within the Midnight contract.** `link_evm` and
`link_solana` record a user's `Bytes<20>` EVM address or `Bytes<32>` Solana
address against their Midnight `user_pubkey` in the Compact contract, gated
on the attestor key. This is a concrete, working example of the
Passport-side half of C25's "cross-chain identity continuity" question: one
Midnight identity resolving to pre-registered foreign-chain addresses.

**Not addressed.** Linking is attestor-gated and one-directional (Midnight →
foreign), and does not touch C25's solver/MCS hand-off, compliance binding,
or settlement notification — those remain upstream.

## 6. Observations

1. **Selective disclosure of a threshold is already working in Compact** —
   `prove_tier` is the shape C20 needs, and it keeps the exact score private.
2. **Single-attestor is the lowest-friction C19 model** — a useful baseline
   even though Passport will need more than one issuer.
3. **Cross-chain identity linking is exercised inside a Midnight contract** —
   a concrete C25 data point that predates the upstream PRD stabilising.
