# Research Summary — ARC Passport

**Project:** ARC Passport (Midnight-native seedless wallet)
**Domain:** Threshold MPC signing + passkey onboarding + on-chain naming + privacy-preserving credentials on Midnight / BLS12-381 / JubJub
**Researched:** 2026/04/16
**Confidence:** MEDIUM-HIGH

---

## ⚠ CORRECTION (2026/04/16, post-research) — NEAR DOES ship FROST-on-JubJub

**The earlier "Material Correction" in this section was itself wrong.** The stack researcher relied on NEAR's README (which documents only ECDSA / EdDSA / CKD) and missed the actual code. Direct source-tree verification establishes:

- File **`near/mpc/crates/threshold-signatures/src/frost/redjubjub.rs`** exists and declares: *"A wrapper for distributed RedDSA on JubJub curve with only the Spend Authorization."*
- It re-exports `reddsa::frost::redjubjub::JubjubBlake2b512` and wires it into the same generic FROST presign / sign / DKG / key-resharing infrastructure NEAR uses for Ed25519 and ECDSA.
- Files: `redjubjub.rs` (entry, 1 KB) + `redjubjub/sign.rs` (16 KB) + `redjubjub/test.rs` (11 KB).
- `Cargo.toml` confirms `reddsa.workspace = true`.
- **Licence: MIT** (NEAR One Limited, 2025) — usable as-is, including modification.
- README states the implementation was professionally audited prior to PR#15.

**What this changes for the plan:**

1. **MVP-01 shrinks materially.** We do NOT compose `reddsa` + `frost-core` ourselves. We adopt (or fork) NEAR's `crates/threshold-signatures` and add: (a) a Poseidon-based ciphersuite alongside `JubjubBlake2b512` for in-circuit verification, (b) STD-03 domain separation, (c) any Midnight-specific challenge construction.
2. **In-circuit verification still requires Poseidon-as-H2.** Blake2b is prohibitively expensive in a Compact circuit, so off-chain signing can use `JubjubBlake2b512` but the in-circuit verifier needs a Poseidon ciphersuite variant.
3. **Phase 3 likely halves in duration** (4 weeks → ~2 weeks). The freed time accrues to Phase 7 (MVP integration) or to a stretch on MVP-07 (Byzantine harness).
4. **Formal-methods scope reduces.** The off-circuit signing protocol is largely already audited; formal methods (META-06 priority 1) focus on the Poseidon-ciphersuite delta and the in-circuit verifier, not on the entire FROST machinery.
5. **Existing `experiments/redjubjub-wallet-rs/src/schnorr.rs` (PITFALLS C3) remains a separate concern** — it's our own custom Schnorr, not NEAR's code, and should be retired in favour of the NEAR + Poseidon-adapter path.

**Action items:** PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md, and STACK.md updated 2026/04/16 to reflect this correction.

> **Historical note (kept for traceability):** the original (incorrect) correction below was based on the stack researcher's reading of NEAR's README, which documents ECDSA / EdDSA / CKD but does not mention RedJubjub support. The `reddsa.workspace = true` dependency in `Cargo.toml` was the smoking gun the researcher missed.

### Original (incorrect) correction text — for traceability only

> Both `docs/KNOWLEDGE_BASE.md` and `docs/mvp-architecture.md` contain an incorrect claim.
> Current claim: "NEAR's `threshold-signatures` crate includes a fully implemented FROST for RedDSA on the JubJub curve."
> Verified reality (NEAR/mpc v3.8.1, 2026/04/07): The NEAR crate ships FROST-Ed25519, OT-based ECDSA on secp256k1, and BLS12-381 DKG only. It does not target JubJub or RedDSA.
> Correct source: Zcash Foundation's `reddsa` crate (v0.5.1) ships RedJubjub FROST signing via its `frost` feature, backed by `frost-rerandomized` and `frost-core`. DKG must be composed from `frost-core`'s generic DKG primitives — it is not pre-wired for RedJubjub.

---

## Executive Summary

ARC Passport is a Midnight-native seedless wallet whose MVP cornerstone is RedDSA-over-FROST-on-JubJub threshold signing, with a passkey-authorised OAuth-like account provider as the UX wrapper. It is the first system to combine passkey authentication, FROST threshold signing on a SNARK-friendly embedded curve, and in-circuit signature verification inside a ZK proof — meaning the signature is consumed as a private witness and never appears on chain. The production reference landscape (NEAR Chain Signatures, Lit Protocol, Web3Auth, ZenGo, Privy, Turnkey, Fireblocks) provides a rich set of architectural and operational prior art, but every surveyed system targets secp256k1 or Ed25519. The JubJub path is genuinely novel: the Zcash Foundation's `reddsa` crate provides the signing primitive; DKG, resharing, and the Poseidon challenge adapter must be built on top of it.

The recommended architecture is a five-component pipeline: (1) passkey / OS keystore on-device; (2) account provider (Rust + `webauthn-rs` + `axum` + JWT) that authenticates the user but never holds key material; (3) FROST signing network (n = 5, t = 4 for the MVP demo) that independently verifies the JWT and the user's device-signed transaction digest before contributing a partial signature; (4) Midnight proof server that consumes the aggregate Schnorr signature as a private witness and emits a Halo2 proof; (5) Midnight chain contracts for name registration and per-user wallet state. NEAR's operational model, Penumbra's Narsil structural blueprint, and Web3Auth's commit-reveal login binding are the most directly applicable prior-art references.

The principal risks are cryptographic (nonce discipline, FROST3 identifiable abort, Fiat-Shamir soundness of in-circuit verification, Poseidon domain separation), operational (the pre-MVP v8.0.2 / v8.1.0-rc.1 deserialisation blocker must be resolved before MVP-02 can demo end-to-end), and coordination (standards become shelfware without named co-authors at Lace and the Midnight Foundation; formal methods must be engaged only on stable protocols, never on exploratory work). Six features have no comparable implementation in any existing product; these are the project's strongest differentiation points and its highest-risk surface.

---

## Key Findings

### Recommended Stack

The permissive Rust path is clean and achievable. The sole production-grade crate for RedJubjub FROST signing is `reddsa` (Zcash Foundation, v0.5.1, MIT / Apache-2.0). It provides the signing primitive and the `frost-rerandomized` ZIP-312 layer; generic DKG scaffolding comes from `frost-core` (v3.0.0-rc.0). There is a version gap: `reddsa` 0.5.x still depends on `frost-core` 1.x; `frost-core` 3.0.0-rc.0 is not yet consumed by an updated `reddsa` release. The team must either stay on the transitive `frost-core` 1.x or patch/fork to advance both. This decision gates MVP-01 and should be made in week 1 of prototype work.

**Core technologies:**
- `reddsa` 0.5.1 (Zcash Foundation): RedJubjub FROST signing — the only surveyed production crate on this curve
- `frost-core` 3.0.0-rc.0 / `frost-rerandomized` 0.6.0: generic DKG scaffolding and ZIP-312 re-randomisation layer
- `jubjub` 0.10 + `midnight-curves` 0.2.0: curve arithmetic; already pinned in experiments
- `webauthn-rs` 0.5 + `axum` 0.8 + `jsonwebtoken` 9: account provider service; keeps the stack in one language
- `@simplewebauthn/browser` 13.x: FIDO-conformance-tested web client if a TS reference app is required
- Penumbra's Narsil project: architectural blueprint for the signing coordinator (not a drop-in crate)
- **Avoid:** Fireblocks `mpc-lib` (GPL-3.0); Hanko passkey server in library mode (AGPL-3.0); any GG18/GG20 ECDSA library (CVE-2023-33241)

Four components cannot be reused from any existing crate and must be implemented: (1) FROST DKG parameterised for RedJubjub; (2) Poseidon-as-H2 challenge adapter; (3) key-reshare / refresh protocol; (4) Byzantine-resilient signing coordinator. Of these, the Poseidon adapter is the novel cryptographic work that requires formal-methods and cryptographer sign-off before shipping.

### Expected Features

Six features have no comparable implementation in any surveyed product (FEATURES.md §7):

1. **Passkey-authorised threshold signing on a SNARK-friendly embedded curve (FROST-on-JubJub with in-circuit verification)** — partially validated in `experiments/redjubjub-wallet*`; FROST threshold ceremony not yet tested end-to-end (MVP-01 / MVP-02)
2. **Privacy-aware name resolution with per-record privacy tiers enforced by the resolver** — no existing naming system (ENS, NEAR, Lens, SNS) has this (MVP-04 / ECO-02)
3. **Nullifier unlinkability to credential leaf via domain separation** — World ID has per-action nullifiers but only for a single credential type; Midnight's multi-credential construction is novel (ECO-02)
4. **Async `proofId` / `proofProgress` / `cancelProof` events integrated into CAIP-25 scope semantics** — no existing wallet standard treats a wallet as a long-running proof coordinator (ECO-01)
5. **Credential survival across seed recovery without re-verification** — every surveyed MPC wallet (ZenGo, Web3Auth, NEAR FastAuth) requires at least partial re-verification after recovery (DEC-02)
6. **Institutional-TEE DeRec helper with auditable release policy** — DeRec Alliance draft pattern, zero deployed implementations (deferred; explicitly Out of Scope for MVP)

**Must have (table stakes for MVP):**
- Passkey / WebAuthn onboarding with no seed phrase shown
- OAuth / email as secondary authenticator and recovery factor
- QR as the primary cross-device channel, with deep link / NFC / manual code as alternatives
- Provider-sponsored first transaction (DUST abstraction)
- Named account `alice.midnight` via commit-reveal Compact registrar
- Three-wallet derivation (shielded / Night / DUST)
- Checkpoint-resume onboarding
- Device-addition ceremony via QR between two devices

**Should have (Milestone 2 differentiators):**
- Full MCP dApp-wallet connection protocol (CAIP-25 + EIP-6963 shape + async proof coordination) — ECO-01
- Privacy-preserving credential standard (attestation trees, domain-separated nullifiers, multi-issuer) — ECO-02
- Multi-key account model (key-set Merkle root in Compact circuit) — ECO-03
- Privacy-aware name resolution (shielded-address ZK gate) — Milestone 2 additive

**Defer to Milestone 3+:**
- On-device key custody (Stream B — TEE wrapping on iOS / Android / laptop)
- DeRec-based social recovery (depends on Stream B)
- Chain abstraction via MPC chain signatures
- Full CCIP-Read wildcard subdomain support for org-issued names

**Anti-features (explicitly do not copy):**
- Showing seed phrases during onboarding
- Custodial-by-default without a published self-custody migration path
- Silent scope escalation after initial connect (`enable()` grants full API)
- Single-address connection (ambiguous on a multi-address-type chain)
- Synchronous signing assumption (18–21s proof generation is incompatible with sync UX)

### Architecture Approach

The canonical architecture is a five-component pipeline where the signature is a witness, never a public value. Three invariants must be maintained throughout: (1) the signature crosses only device ↔ signing-network and device ↔ proof-server boundaries, never reaching the chain; (2) the signing network is policy-enforcing — each node independently verifies the JWT and the device-signed transaction digest before contributing a partial signature; (3) DUST sponsorship is the account provider's responsibility, not the signing nodes'. The production prior-art cluster (NEAR 8-node, Lit 7-node, Web3Auth 5–9-node) justifies the recommended MVP committee of n = 5, t = 4 (see ARCHITECTURE.md §4.1).

**Committee size recommendation: n = 5, t = 4 for the MVP demo.** Prior-art rationale: 5 nodes is enough to demonstrate Byzantine threshold visibly (take one down mid-demo, it still signs), operation of 5 nodes is one person's job, and the n = 5 / t = 4 configuration is comparably sized to ZenGo-adjacent and Web3Auth's smaller tier. For production (outside MVP-07 scope), follow NEAR's 8-node / Lit's 7-node sizing.

**Major components:**
1. **Passkey / OS keystore** — WebAuthn credential per device; authenticates the user to the account provider; never holds Midnight key material
2. **Account provider** — user_id ↔ passkey(s) mapping; JWT issuance; device-addition ceremony; recovery orchestration; DUST sponsorship vouchers; zero key material by construction
3. **FROST signing network** (n = 5, t = 4 for MVP) — JubJub key share per user; DKG / signing / reshare; per-user policy (JWT introspection + device-signed transaction digest); ROAST-style coordinator
4. **Midnight proof server** — Halo2 prover; consumes signature as private witness; emits proof
5. **On-chain contracts** — name registry (Compact, commit-reveal) + per-user wallet contract (owner_pk, tx_count, balances)

**Recommended build order (ARCHITECTURE.md §10):** single-process FROST-on-JubJub with Poseidon challenge (extends `experiments/redjubjub-wallet-rs/`) → threshold n=3 in-process test → DKG ceremony → HTTP coordinator → JWT introspection + stub account provider → per-user policy → real account provider → end-to-end demo. Items 1–6 are the critical path for weekly demos.

### Critical Pitfalls

The full list is 25 pitfalls across cryptographic, protocol, UX, operational, standards, and regulatory categories (PITFALLS.md). The five highest-impact items:

1. **FROST1 / FROST2 non-identifiable abort (C1)** — a malicious signer or coordinator can equivocate on signing-set commitments, causing honest nodes to abort without identifying the cheater. Prevention: specify FROST3 with identifiable abort in MVP-01; bind the full sorted signing-set into the challenge hash `c`; commission a Byzantine-sim test. Formal-methods priority 2.

2. **Schnorr nonce biasing / reuse (C3)** — `experiments/redjubjub-wallet-rs/src/schnorr.rs` exposes `sign_with_nonce` in the public API, creating a nonce-reuse foot-gun. Prevention: mandate hedged deterministic nonces (RFC 6979 / FROST3 nonce-pair discipline); move `sign_with_nonce` behind `#[cfg(test)]` immediately; commission a scoped audit of `midnight-curves 0.2.0` scalar sampling. Formal-methods priority 3.

3. **Fiat-Shamir "Frozen Heart" in in-circuit verification (C6)** — if the Schnorr challenge `c` inside the Compact circuit omits any public parameter, an attacker can reuse a valid signature across contexts. Prevention: write a "what's in the challenge" table in the MVP-02 spec covering every public input; add a differential test that alters one public input and verifies the proof fails. Formal-methods priority 1.

4. **Account-provider custodial classification (C11)** — regulators (MiCA CASP, BitLicense) may interpret the account provider's JWT-gating of the signing committee as effective custody, even though the provider holds no key material. Prevention: FROST nodes must require the device-signed transaction digest independent of the JWT, so the provider can deny but not forge signatures; obtain legal review before any public MVP demo.

5. **Poseidon domain-separator reuse / collision (C5)** — all challenge hashes, nullifier hashes, name-commit hashes, and analytics counters share `persistentHash` (Poseidon). Without explicit domain prefixes, cross-protocol signature replay becomes plausible. Prevention: publish a domain-separation registry (proposed as new cross-cutting requirement STD-A) before MVP-01 is frozen; every `persistentHash` call must begin with a 6+ byte prefix.

---

## Implications for Roadmap

### Formal-Methods Priority Queue

Given the 10× slowdown of the formal-methods team, the following ordered queue is the actionable output of PITFALLS.md. Hand off each item only when stable for ≥ 2 weeks with a reference implementation and test vectors:

| Priority | Target | Requirement | Hand-off criteria |
|----------|--------|-------------|-------------------|
| 1 | Schnorr-in-circuit verification (Fiat-Shamir soundness) | MVP-02 | Spec + reference circuit + 10+ test vectors stable ≥ 2 weeks |
| 2 | FROST3 signing protocol with identifiable abort | MVP-01 | NEAR-library port validated; protocol doc frozen |
| 3 | Nonce discipline and domain separation | MVP-01, STD-A | Domain-separation registry published |
| 4 | Account-provider authority boundary | MVP-03 | MVP-03 API contract stable |
| 5 | QR channel binding | MVP-05 | MVP-05 spec text stable |
| 6 (post-MVP) | Re-sharing soundness | MVP-07 | Re-sharing protocol stable |
| 7 (Milestone 2) | Credential unlinkability under revocation | ECO-02 | ECO-02 draft stable |

### Pre-MVP Blocker

**The v8.0.2 / v8.1.0-rc.1 deserialisation issue must be resolved before MVP-02 can demo end-to-end.** `experiments/redjubjub-wallet-rs/` uses `midnight-ledger` at v8.1.0-rc.1; the devnet proof server expects v8.0.2 format; transaction submission fails with deserialisation errors (PITFALLS.md §O1). Resolution options: (a) downgrade to v8.0.2 format; (b) negotiate a "v8.x API frozen for MVP" commitment from the Midnight team; (c) maintain the existing workaround while waiting for upstream resolution. Add to META-07 as an immediate action item.

### Cross-Cutting New Requirement: STD-A

**STD-A (domain-separation registry) should be added to the META-01 scope lock as a prerequisite to MVP-01.** All five of the following requirements hash through `persistentHash`: MVP-01 (signing challenge), MVP-04 (name commit-reveal), ECO-02 (credential nullifiers), STD-02 (address derivation), and future analytics counters. Without a version-tagged registry of domain prefixes, cross-protocol collisions are a latent risk from day one. The registry is a 1–2 page document — it costs one day to draft and prevents a class of attacks permanently.

### Standards Governance Prerequisite: MIP-0

**MIP-0 (governance process for MIPs) must exist before MIP-1 ships.** Per PITFALLS.md §M5, adopting CIP mechanics without CIP governance produces documents no one can formally accept or reject. The options are: (a) adopt CIP governance literally; (b) design a minimal Midnight-specific process with explicit editors; (c) fork CIP mechanics into a Midnight Foundation process. This choice must be made in META-01 and communicated to the Midnight Foundation before ECO-01 is drafted. Every MIP draft must carry a named external co-author (Lace or Midnight Foundation) before publication.

### MVP-07 Deserves More Investment

MVP-07 is currently scoped as "explicitly not production-grade ops." Research identifies three sub-problems that, if deferred entirely, will produce a demo that cannot honestly be described as a working threshold network:

- **Byzantine test harness** — at least 3 Byzantine scenarios (malicious dealer, slow node, equivocating signer) must run in CI before the end-of-June demo.
- **Geographic / provider diversity** — the 5-node committee must span ≥ 2 cloud providers or ≥ 2 geographic regions from week 4 of prototype work.
- **Proof-server redundancy** — at least 2 proof servers running; one must be killable mid-demo without breaking the flow (proof generation, not signing, is the first bottleneck per ARCHITECTURE.md §9).

### Suggested Phase Structure

#### Phase 1 — Cryptographic Foundation (Week 1–4, MVP-01 + STD-A + pre-MVP corrections)

**Rationale:** Everything downstream depends on a working, correctly-specified FROST-on-JubJub implementation. Pre-MVP corrections (KNOWLEDGE_BASE.md, `mvp-architecture.md`, `schnorr.rs` `sign_with_nonce` remediation) and the v8.0.2 / v8.1.0-rc.1 blocker must be resolved in the same sprint.

**Delivers:** FROST3 DKG + signing + reshare spec (MVP-01); Poseidon challenge adapter; n=5 in-process signing test; domain-separation registry (STD-A); corrected knowledge base.

**Pitfalls addressed:** C1 (FROST equivocation), C2 (Pedersen DKG length check), C3 (nonce discipline), C5 (domain separation), O1 (version mismatch blocker).

**Research flag:** Cryptographer review required on Poseidon-as-H2. This is the only component with no direct prior art. If Poseidon-as-RO is deemed inadequate, the fallback is Blake2b inside the circuit. Reserve a decision point in week 2.

#### Phase 2 — In-Circuit Verification + Account Provider (Week 3–6, MVP-02 + MVP-03)

**Rationale:** MVP-02 is the claim that makes this project unique. The account provider is required for MVP-02 to function end-to-end. These can overlap: proof-server integration is the critical path for MVP-02; the account provider is primarily an HTTP service.

**Delivers:** Compact circuit consuming FROST aggregate signature as private witness (MVP-02); account provider with passkey registration, JWT issuance, device-addition ceremony, stub recovery (MVP-03); end-to-end signing → proving → chain submission demo (pending O1 blocker resolved).

**Pitfalls addressed:** C6 (Fiat-Shamir — write "what's in the challenge" table before implementation), C10 (passkey / curve mismatch framing), C11 (account-provider authority boundary — FROST nodes must reject JWT-only requests).

**Research flag:** No novel research needed. Primary risk is the v8 version blocker. Formal-methods hand-off for priority-1 (in-circuit verification) happens at the end of this phase.

#### Phase 3 — Named Accounts + Onboarding Flow (Week 5–8, MVP-04 + MVP-05 + MVP-06 + STD-01 + STD-02)

**Rationale:** Named accounts require the address format standard (STD-02) and key derivation standard (STD-01) to be stable first. The onboarding flow (MVP-05) and UX spec (MVP-06) depend on the account provider (Phase 2) and the name registry (MVP-04) both existing.

**Delivers:** Compact name-registry contract with commit-reveal, ENSIP-15 normalisation, rate limiting, multi-address resolution (MVP-04); QR → ECDH → DKG → name registration → first airdrop end-to-end flow spec (MVP-05); UX spec covering at least three recovery scenarios (MVP-06); key derivation MIP draft (STD-01); address format MIP draft (STD-02).

**Pitfalls addressed:** C5 (domain separation in name-commit — STD-A must be complete first), C12 (QR channel binding), C13 (homoglyph squatting — ENSIP-15 in the Compact circuit, not only client-side), C15 (GDPR — names → public keys only), C18 (recovery sad path — ≥ 3 scenarios), C19 (device-add rate limiting and visual confirmation).

**Research flag:** ENSIP-15 and commit-reveal are well-documented from ENS prior art. Privacy-aware resolution tier is deferred to Milestone 2.

#### Phase 4 — Operational Model + Standards Governance (Week 7–10, MVP-07 + META-01 through META-07 + MIP-0)

**Rationale:** MVP-07 must be in place before the June demo. Meta-planning deliverables should be drafted alongside Phase 1–3 work, not after.

**Delivers:** n=5, t=4 committee across ≥ 2 providers; Byzantine test harness (≥ 3 scenarios in CI); re-sharing exercise; proof-server redundancy (≥ 2 servers); delegation plan (META-02); weekly-demo contract (META-03); stakeholder onboarding narrative (META-04); formal-methods engagement plan with stability criteria (META-06); MIP-0 governance document; STD-A finalised.

**Pitfalls addressed:** C1 (Byzantine sim in CI), C9 (re-sharing cadence documented and exercised), C16 (committee ≥ 2 providers), C17 (proof-server redundancy), C20 (demo-drive development — "what doesn't work yet" slide from week 1), M1 (named co-author per MIP), M2 (formal methods on stable protocols only), M5 (MIP-0 before MIP-1).

**Research flag:** No novel research needed for ops. NEAR's model is the direct reference.

#### Phase 5 — Ecosystem Standards (Milestone 2, ECO-01 through ECO-04)

**Rationale:** The dApp-wallet connection protocol (ECO-01), credential standard (ECO-02), multi-key account (ECO-03), and onboarding SDK (ECO-04) require the MVP prototype to exist as a reference implementation. Drafting them before the prototype is validated produces unverifiable specifications.

**Delivers:** Draft MIPs for connection protocol, credential standard, multi-key account, onboarding SDK; named co-authors at Lace and Midnight Foundation for each.

**Pitfalls addressed:** C7 (nullifier collisions — 256-bit nullifiers, full-width domain tags, World-ID-style context isolation), C14 (revocation linkability — universal accumulators or anonymised fetches; no tails-file pattern), M1 (co-author required before publication), M3 (specs must constrain, not describe), M4 (CAIP namespace drift — coordinate registration before ECO-01 ships).

**Research flag:** ECO-02 credential revocation likely needs a dedicated research sub-phase. The unlinkability-under-revocation problem is a formal privacy property with no ready-made crate-level solution; formal-methods hand-off priority 7.

#### Phase 6 — Decentralisation Path (Milestone 3+, DEC-01 through DEC-03)

**Rationale:** On-device cryptography (DEC-01), DeRec social recovery (DEC-02), and social account linking (DEC-03) all depend on Phase 5 standards being stable.

**Delivers:** TEE design refresh for iOS / Android / desktop (DEC-01); DeRec (3,5) social recovery with ML-KEM-768 share transport (DEC-02); social account linking design (DEC-03).

**Research flag:** DEC-01 requires a dedicated research phase — iOS Secure Enclave curve support, Android StrongBox variance, and cross-platform TEE attestation are not yet exhaustively surveyed. DEC-02 has a well-defined protocol specification (derecalliance.org); implementation is the main work.

### Phase Ordering Rationale

- Cryptographic foundation first: the signing protocol is on the critical path for everything.
- In-circuit verification second: this is the project's unique claim. If it cannot be demonstrated before June, the MVP collapses.
- Named accounts third: they depend on address format / key derivation standards and on the account provider.
- Operational model in parallel from week 1: Byzantine test harness cannot be left to week 8.
- Ecosystem standards after the prototype exists: MIPs without reference implementations do not compel adoption.

### Research Flags

Phases needing deeper research:
- **Phase 1 (Poseidon-as-H2 adapter):** no published ciphersuite targets Poseidon in H2; cryptographer sign-off required.
- **Phase 5 (ECO-02 credential revocation):** unlinkability under revocation is a formal privacy property with no ready-made solution; dedicated research sub-phase required.
- **Phase 6 (DEC-01 on-device crypto):** iOS / Android / desktop TEE capabilities for BLS12-381 material are not yet exhaustively surveyed.

Phases with standard patterns (minimal research needed):
- **Phase 2 (in-circuit Schnorr verification):** established in `experiments/redjubjub-wallet*`; primary risk is the v8 version blocker, not research.
- **Phase 3 (name registry):** commit-reveal + ENSIP-15 normalisation are well-documented from ENS prior art.
- **Phase 4 (operational model):** NEAR's model is the direct reference; no novel research needed.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | `reddsa`, `frost-core`, `webauthn-rs` verified from official crates.io and GitHub; licences confirmed; version compatibility gap (`frost-core` 1.x vs 3.x) is identified and manageable |
| Features | HIGH | Each product anchored to current official documentation; six differentiators corroborated against exhaustive ecosystem survey |
| Architecture | MEDIUM-HIGH | Committee sizes and protocol choices corroborated by official docs and source code; ops details on some vendors thin; Poseidon-as-H2 has no architectural precedent |
| Pitfalls | HIGH | Cryptographic pitfalls backed by disclosed CVEs and eprint papers; regulatory interpretation is MEDIUM (evolving MiCA / BitLicense landscape) |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Poseidon-as-H2 security model:** cryptographer review required before MVP-01 is frozen. If Poseidon-as-RO is rejected, fallback to Blake2b inside the circuit. Reserve a decision point in Phase 1 week 2.
- ~~**`midnight-curves` 0.2.0 side-channel posture:** marked "not audited" by its authors. A scoped side-channel review of `JubjubSubgroup::Mul` and `Fr::{Add, Mul, Inv}` is a Phase 1 dependency for the signing-node ops posture.~~ **Withdrawn 2026/04/16:** source-tree review of `midnightntwrk/midnight-zk` at the `midnight-curves-v0.2.0` tag confirmed the JubJub `Fr` implementation uses the standard Rust `subtle` constant-time primitives (`Choice`, `ConditionallySelectable`, `ConstantTimeEq`, `CtOption`) throughout. No scoped review required. See PITFALLS.md C4 status note for the detail.
- **`frost-core` version gap:** decide in week 1 whether to stay on `reddsa`'s transitive `frost-core` 1.x or patch/fork to advance to 3.0.0-rc.0. This gates DKG implementation.
- **CAIP namespace registration:** who registers `midnight` in ChainAgnostic/namespaces, and when, is not yet decided. Must be resolved before ECO-01 ships (PITFALLS.md §M4).
- **MIP-0 governance:** the standards process for MIPs is an open question in `docs/passport-plan.md`. Must be resolved before MIP-1 ships. Engage Midnight Foundation before ECO-01.
- **Legal review of account-provider authority boundary:** obtain before any public MVP demo, not after (PITFALLS.md §C11). Route through IOG legal; tag as META-03 action item.
- **v8.0.2 / v8.1.0-rc.1 deserialisation blocker:** immediate; must be resolved before MVP-02 demo. Escalate to Midnight Foundation via the platform contact.

---

## Sources

### Primary (HIGH confidence — official docs / source code)
- ZcashFoundation/frost — https://github.com/ZcashFoundation/frost (v3.0.0-rc.0, 2025/01/28)
- `reddsa` crate — https://crates.io/crates/reddsa (v0.5.1, 2024/07/12)
- NEAR/mpc — https://github.com/near/mpc (v3.8.1, 2026/04/07; corrects the KNOWLEDGE_BASE.md claim)
- RFC 9591 FROST — https://datatracker.ietf.org/doc/rfc9591/
- ZIP-312 re-randomized FROST — https://eprint.iacr.org/2024/436.pdf
- Trail of Bits "Breaking the shared key in threshold signature schemes" (2024/02/20) — Pitfall C2 source
- Fireblocks BitForge CVE-2023-33241 (2023/08/09) — Pitfall C1 / C3 source
- Trail of Bits "Frozen Heart" (2022/04/13) — Pitfall C6 source
- NEAR Chain Signatures — https://docs.near.org/chain-abstraction/chain-signatures
- `webauthn-rs` — https://github.com/kanidm/webauthn-rs
- SimpleWebAuthn — https://simplewebauthn.dev/
- Penumbra `frost377` — https://github.com/penumbra-zone/frost377

### Secondary (MEDIUM confidence — vendor docs / architecture summaries)
- Privy architecture — https://docs.privy.io/security/wallet-infrastructure/architecture
- Web3Auth MPC Architecture — https://web3auth.io/docs/infrastructure/mpc-architecture
- Lit Protocol V1 announcement — https://spark.litprotocol.com/v1-live/
- Dynamic TSS-MPC blog — https://www.dynamic.xyz/blog/introducing-dynamic-embedded-wallets-with-tss-mpc
- Turnkey architecture — https://whitepaper.turnkey.com/architecture
- ZenGo security overview — https://zengo.com/mpc-wallet/
- DeRec Alliance protocol — https://derecalliance.org/

### Tertiary (academic — HIGH confidence on content, may not reflect latest implementation)
- FROST — Komlo and Goldberg, eprint 2020/852
- ROAST — Ruffing et al., eprint 2022/550
- Re-Randomized FROST — Gouvea and Komlo, eprint 2024/436
- "A Formal Security Analysis of Hyperledger AnonCreds" — eprint 2025/694 (Pitfall C14 source)
- "Biased Nonce Sense" — Breitner and Heninger, eprint 2019/023 (Pitfall C3 source)
- LadderLeak — eprint 2020/615 (Pitfall C3 source)
- CMS Law, "Safeguarding the digital vault: custody and administration of crypto-assets under MiCA" (Pitfall C11 source)

### Internal references
- `docs/KNOWLEDGE_BASE.md` — verified technical facts (correction required; see Material Correction section)
- `docs/mvp-architecture.md` — FROST-on-JubJub MVP design (correction required; see Material Correction section)
- `docs/passport-plan.md` — three-step decentralisation path
- `docs/reference/machine-investigation/key-flows/secure-onboarding-design.md` — the wishlist
- the project requirements — requirement IDs
- the known-issues log — known bugs including v8.0.2 / v8.1.0-rc.1 mismatch
- `experiments/redjubjub-wallet/` and `experiments/redjubjub-wallet-rs/` — validated JubJub Schnorr in Compact

---

*Research completed: 2026/04/16*
*Ready for roadmap: yes*
