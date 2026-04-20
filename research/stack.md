# Stack Research — Seedless Wallet with MPC/Threshold Signing on Midnight

**Domain:** Seedless wallet + threshold (FROST) signing + passkey onboarding, targeting Midnight's BLS12-381 / JubJub ZK stack
**Researched:** 2026/04/16
**Researcher:** GSD project researcher
**Overall confidence:** MEDIUM-HIGH (crate versions, licences, and maintenance dates verified from upstream; product architecture claims drawn from vendor documentation)

---

## ⚠ POST-RESEARCH CORRECTION (2026/04/16) — NEAR DOES ship FROST-on-JubJub

The original research below relied on NEAR's README and missed the actual code. **Direct source-tree verification establishes the opposite of the original §6 Corrections finding:**

- **`near/mpc/crates/threshold-signatures/src/frost/redjubjub.rs`** exists.
- It declares: *"A wrapper for distributed RedDSA on JubJub curve with only the Spend Authorization."*
- It re-exports `reddsa::frost::redjubjub::JubjubBlake2b512` and wires it into NEAR's generic FROST presign / sign / DKG / key-resharing infrastructure (the same machinery used for Ed25519 and ECDSA).
- Files: `redjubjub.rs` (entry) + `redjubjub/sign.rs` (16 KB) + `redjubjub/test.rs` (11 KB).
- `Cargo.toml` confirms `reddsa.workspace = true`. Other deps: `frost-core`, `frost-ed25519`, `frost-secp256k1`.
- **Licence: MIT** (NEAR One Limited, 2025) — usable as-is, including modification.
- README states the implementation was professionally audited prior to PR#15 (the README does not mention RedJubjub support; this is an undocumented capability in the existing audited code).

**Implications for the rest of this document**: §3 ("What does not exist for JubJub today"), §6 (Corrections) and the §1 TL;DR are partially superseded — DKG, presign, signing, key resharing, and a participant communication channel for JubJub-FROST DO exist in the NEAR crate and are MIT-licensed. The remaining gap is a Poseidon-based ciphersuite for in-circuit verification (Blake2b is too expensive in a Compact circuit). All other §1-§5 content (other libraries, comparisons, version pinning between `reddsa` and `frost-core`) remains accurate.

The prose below is preserved for traceability. Treat it as historical context, not current guidance.

---

## TL;DR for partners

> **Superseded by the post-research correction above.** Original TL;DR retained:

- **There is one directly-reusable FROST-on-JubJub crate** — `reddsa` (Zcash Foundation, v0.5.1) with the `frost` feature gated by `frost-rerandomized`. It handles **signing**. It does not include DKG.
- **There is no directly-reusable JubJub DKG** in any production-grade library surveyed. Penumbra has FROST-on-decaf377 (a different BLS12-381-embedded curve) with its own DKG (`frost377`). NEAR's `threshold-signatures` deliberately excludes JubJub.
- **The KNOWLEDGE_BASE.md claim that NEAR's crate "includes a fully implemented FROST for RedDSA on the JubJub curve"** is not supported by the current `near/mpc` repository: the active crate ships FROST-Ed25519 and OT/Robust ECDSA, not RedJubjub. See §6 Corrections.
- **Threshold ECDSA has several production libraries** (Coinbase `cb-mpc`, Fireblocks `mpc-lib`, Silence Labs `silent-shard-dkls23-ll`, ZenGo `multi-party-ecdsa`). None are relevant for Midnight because ECDSA verification in a BLS12-381 SNARK is prohibitive.
- **Passkey UX stack is mature** across iOS (`AuthenticationServices`), Android (Jetpack `Credentials`), web (`SimpleWebAuthn`), and Rust servers (`webauthn-rs`). No novel work required.
- **Account-provider pattern is a commodity** (NEAR FastAuth, Privy, Web3Auth, Magic, Turnkey, Dynamic) with a consistent shape: passkey/social → idToken → JWT → threshold/enclave signing. No single open-source reference implementation.

---

## 1. What we can reuse directly

### 1.1 Cryptographic primitives (MVP-01 cornerstone)

| Crate | Version | Publisher | Licence | Last release | Curve / role | Confidence |
|---|---|---|---|---|---|---|
| [`reddsa`](https://crates.io/crates/reddsa) | **0.5.1** | ZcashFoundation | MIT OR Apache-2.0 | 2024/07/12 | RedJubjub + RedPallas signing; optional `frost` feature | HIGH |
| [`frost-core`](https://crates.io/crates/frost-core) | **3.0.0-rc.0** | ZcashFoundation | MIT OR Apache-2.0 | 2025/01/28 | Generic FROST + trusted-dealer + DKG scaffolding | HIGH |
| [`frost-rerandomized`](https://crates.io/crates/frost-rerandomized) | **0.6.0** (2.2.0 on docs.rs) | ZcashFoundation | MIT OR Apache-2.0 | tracks frost-core | ZIP-312 re-randomized FROST, what `reddsa` plugs into | HIGH |
| [`jubjub`](https://crates.io/crates/jubjub) | **0.10.0** | zkcrypto | MIT OR Apache-2.0 | stable line | JubJub curve arithmetic (already in our PoC) | HIGH |
| [`midnight-curves`](https://crates.io/crates/midnight-curves) | 0.2.0 | Midnight Foundation | as published | — | Midnight-specific JubJub tweaks; already pinned in experiments | MEDIUM (platform-locked) |

**Why this stack:** `reddsa` is the *only* surveyed production Rust crate that wires RedDSA-on-JubJub into a FROST ciphersuite via `frost-rerandomized`. The 0.5.0 release (2024/03/09) was explicitly titled "added Pallas and Jubjub ciphersuites with FROST support"; 0.5.1 bumped `frost-rerandomized` to 0.6.0 and tightened NAF arithmetic. It has been partially audited (Zcash Foundation's FROST workspace was audited by NCC at v0.6.0 of `frost-core`; `reddsa`'s FROST mode inherits from that audit).

**Caveats — this is exactly where formal-methods effort belongs (per META-06):**
- `reddsa`'s 0.5.x line is still marked "pre-release" on GitHub.
- ZIP-312 (re-randomized FROST) is itself still draft.
- `reddsa`'s FROST does **not** include DKG out of the box — it uses `frost-rerandomized` which inherits from `frost-core`'s generic DKG traits. We must parameterise `frost-core`'s DKG with our `RandomizedCiphersuite` (the RedJubjub one exported by `reddsa`). This is reimplementation work, not glue.
- No `reddsa` adapter exists for Midnight's Poseidon challenge hash. Our `experiments/redjubjub-wallet*` already uses Midnight's `persistentHash`; integrating FROST will require composing `frost-core` with a custom hash trait.

### 1.2 Passkey / WebAuthn (account-provider front door)

| Layer | Library | Version | Licence | Notes | Confidence |
|---|---|---|---|---|---|
| Web client | [`@simplewebauthn/browser`](https://simplewebauthn.dev/) | 13.x (2025) | MIT | FIDO conformance-tested; standard pick | HIGH |
| Node server | [`@simplewebauthn/server`](https://simplewebauthn.dev/docs/packages/server/) | 13.x (2025) | MIT | Pairs 1:1 with the browser package | HIGH |
| Rust server | [`webauthn-rs`](https://github.com/kanidm/webauthn-rs) | 0.5.x | MPL-2.0 | SUSE-audited; used by Kanidm in production | HIGH |
| iOS | `AuthenticationServices.ASAuthorizationPlatformPublicKeyCredentialProvider` | iOS 16+ | Apple SDK | Passkeys in iCloud Keychain; P-256 only | HIGH |
| Android | `androidx.credentials` (Jetpack Credential Manager) | 1.3.x+ | Apache-2.0 | Unified API across passkeys + passwords; Android 14+ for third-party PM | HIGH |
| Full drop-in | [`teamhanko/hanko`](https://github.com/teamhanko/hanko) passkey-server | current | AGPL-3.0 (self-host) / proprietary (cloud) | Go + Rust client; FIDO-certified; OSS alternative to Auth0 for passkeys | MEDIUM |

**Recommendation (MVP-03 account provider):** Rust account-provider service using `webauthn-rs` + `axum` + JWT (`jsonwebtoken` or `biscuit`). The signing network itself is already Rust; keeping one language stack reduces friction. `SimpleWebAuthn` only enters if a TS reference app is demanded.

### 1.3 Supporting libraries already in our codebase

Everything in the tech-stack catalogue stays. Additions specifically for the threshold signing pieces:

```toml
# In the signing-node crate of the prototype repo:
reddsa = { version = "0.5.1", features = ["frost"] }
frost-core = "3.0.0-rc.0"        # if we need to pin/upgrade beyond reddsa's transitive
frost-rerandomized = "0.6.0"
jubjub = "0.10"                  # already pinned in experiments
subtle = "2.6"                   # constant-time (already in stack)
zeroize = "1.8"                  # already in stack
rand_chacha = "0.3"              # already in stack; ChaCha20 CSPRNG for nonces

# Account provider crate:
webauthn-rs = "0.5"
axum = "0.8"                     # or actix-web to match proof-server
jsonwebtoken = "9"
tower-http = "0.6"               # CORS, compression
```

### 1.4 Development & ops tooling

| Tool | Purpose | Notes |
|---|---|---|
| `cargo-nextest` | Faster test runner (already in compact-upstream) | Required for cross-crate integration tests of DKG |
| `wiremock` | HTTP mocking for account-provider tests | Already pinned |
| `criterion` + `pprof` | Bench signing latency, flame-graph Poseidon hot spots | Already pinned |
| `axoupdater` | CLI self-update (Compact pattern) | Applicable to any end-user tooling we ship |

---

## 2. What we must reimplement — and why

This is the list that actually matters for partner conversations and for scoping the prototype.

| Component | Why no reuse | Estimated shape | Confidence in necessity |
|---|---|---|---|
| **FROST DKG for RedJubjub** | `reddsa` ships signing, not DKG. `frost-core` has generic DKG but no published ciphersuite targeting RedJubjub. NEAR's `threshold-signatures` excludes JubJub. | Parameterise `frost-core::keys::dkg` with `reddsa::frost::redjubjub::RedJubjubBlake2b512` (or a Poseidon-hash variant). ~400 lines + serialisation + property tests. | HIGH |
| **Poseidon challenge adapter** | FROST ciphersuites hash the challenge with Blake2b-512 (RedJubjub) or SHA-512 (Ed25519). Our Compact circuit uses Poseidon (`persistentHash`) — the whole premise of in-circuit verification. | Implement a custom `Ciphersuite` whose `H2` is Poseidon over Midnight's Fr, with the nonce-retry loop from `experiments/redjubjub-wallet/`. | HIGH |
| **Key-reshare / refresh protocol** | Proactive secret sharing (APSS) exists in the literature but no production crate is aligned with FROST-RedJubjub. NEAR's crate has reshare + refresh for secp256k1/Ed25519 only; Gotham (ZenGo) has rotation for their 2-of-2 ECDSA. | Implement a reshare ceremony on top of our DKG; model it on NEAR's architecture (committee re-election + new shares, old shares zeroised). MVP can defer this to weekly manual reshare; production must do it proactively (weekly or daily — see §5). | HIGH |
| **Byzantine-resilient signing coordinator** | FROST-3 assumes a coordinator. ROAST is robust but assumes asynchronous model. None of the libraries (Zcash, Penumbra, NEAR) expose a pluggable "coordinator with t-of-n liveness under f Byzantine nodes" abstraction. | Build a thin coordinator service (Rust + tokio) that orchestrates round-1 nonce commitments and round-2 shares. Penumbra's `narsil` is a reference architecture (not drop-in code). | MEDIUM |
| **Account-provider OAuth-like API** | Every vendor has one (NEAR FastAuth, Privy, Magic, Turnkey, Dynamic). None is OSS as a reusable service. | Standard JWT + passkey + device-addition flow; 1–2 k LoC Rust service. MVP-03 scope. | HIGH |
| **Name-registry Compact contract** | No on-chain name registry on Midnight. Closest analogues: ENS (EVM), Cardano Handle (NFT model). | Compact contract with commit-reveal + Merkle root of name→key entries. MVP-04. | HIGH |

---

## 3. What has no good analogue (novel work requiring formal methods)

Flag these for the formal-methods team per META-06; they are the parts where no published protocol matches our constraints.

| Gap | Why novel | First-order mitigation |
|---|---|---|
| **Poseidon-as-H2 in FROST ciphersuite** | FROST specs (RFC 9591, ZIP-312) fix the hash choice per ciphersuite. Using Poseidon in H2 instead of Blake2b changes the security model — Poseidon's indifferentiability proof is weaker than Blake2b's random-oracle model. | Treat this as a **new ciphersuite** requiring its own audit. Document exactly which FROST proof we are relying on (one-more discrete log in JubJub, plus Poseidon-as-RO assumption). Give this to formal methods first. |
| **In-circuit FROST aggregate-signature verification** | Published Schnorr-in-SNARK circuits exist (Zcash Sapling's Spend circuit verifies RedJubjub). FROST aggregate verification is identical on-curve to a single Schnorr verification, so in-circuit this is a free win — BUT the *setup* (coordinator+participants producing a valid aggregate) is what must be watertight. | Our `experiments/redjubjub-wallet*` already verifies single-signer Schnorr in Compact. Prove that FROST aggregate signatures are indistinguishable at the verifier boundary. Partial-signature verification (optional, for slashing) is extra circuit work. |
| **JWT-to-sign-request binding** | No standard crypto binding between a WebAuthn assertion, a JWT, and a signature request. Risks: signature-reuse across users, JWT replay, signing-request substitution. | Bind the JWT subject to the user's JubJub public key in the account-provider DB; bind the signing request body into the JWT's `cnf` (confirmation claim, RFC 7800); reject reuse via a monotonic counter (same idea as our PoC's `tx_count`). Not novel per se, but must be spelled out in MVP-03. |
| **Multi-device devices-to-one-key topology (MVP)** | Every vendor surveyed gives each device *its own share* (or its own key pair, in Stream A). We instead give each device a passkey-authenticated JWT against a single distributed key. Recovery is "re-bind a new device" at the account provider, not "rotate shares". | Spell out the trust assumption: if the account provider is compromised, a new device can be bound. Mitigation is the same as any OAuth IdP — defence in depth, anomaly detection, and the migration path to Stream A. |

---

## 4. Comparison table — reference seedless-wallet / MPC products

| Product | Curves signed | Protocol | Where key material lives | Recovery | OSS status | Directly reusable for Midnight? |
|---|---|---|---|---|---|---|
| **NEAR MPC / Chain Signatures** ([`near/mpc`](https://github.com/near/mpc)) | secp256k1, Ed25519 (BLS12-381 DKG only) | OT-ECDSA (Cait-Sith-derived), Robust ECDSA (DJNPO20), FROST-Ed25519 | Distributed (8-node committee); DKG shared across schemes | Account re-bind + committee re-election | Apache-2.0 / MIT (MIT per repo); active (v3.8.1 released 2026/04/07) | **No** — JubJub/RedDSA path not implemented. Architecture is the best blueprint we have. |
| **NEAR FastAuth** (deprecated; Auth0+MPC successor in progress) | secp256k1 (NEAR account key) | Passkey + OAuth (Auth0) + MPC relayer | Distributed; passkey-derived | Email+passkey recovery | Partially OSS | **No** (NEAR-specific account model); **yes** as a UX blueprint for MVP-03 |
| **Privy** | secp256k1, Ed25519 | Shamir 2-of-3 (device + TEE + recovery) inside AWS Nitro Enclaves | Device share in browser; TEE share in Privy's infra; user recovery share | Recovery share (seed / password / passkey) | Open-source SSS library only; infra proprietary | **No** (closed infra); SSS library (`shamir-secret-sharing`, MIT) is usable but wrong trust model for us |
| **Web3Auth / tKey** ([`MetaMask/tkey`](https://github.com/MetaMask/tkey)) | secp256k1, Ed25519 | Shamir 2-of-n → TSS (GG20/CMP for ECDSA, FROST for Ed25519) in Core Kit | Shares across device / cloud / "Auth Network" (Torus) nodes | 2-of-n factor keys | Apache-2.0 (MetaMask fork); active | **No** (protocol targets wrong curves); useful as UX reference |
| **Turnkey** | secp256k1, Ed25519, others | Single-key inside AWS Nitro Enclave (not MPC) + programmable policies | TEE-wrapped inside Turnkey infra; root key never exits | Policy-enforced re-auth | Proprietary | **No** (custodial enclave model ≠ our threshold architecture) |
| **Magic / DKMS** | secp256k1, Ed25519 | Delegated key mgmt in client iframe + HSM; "Split KMS" uses Shamir | Iframe-isolated client key; HSM-stored shares | Email/OAuth-driven recovery ceremony | Proprietary | **No** (closed); useful as UX reference |
| **Dynamic.xyz** | secp256k1 (DKLs19), Ed25519 (FROST), Taproot/BIP-340 (FROST) | TSS-MPC (User + Server + optional Relay shares) | User share on device; Server share in TEE | Passkey-authenticated recovery of user share | Proprietary | **No** (closed); useful as UX reference |
| **Coinbase WaaS / CDP** | secp256k1 (GG variants + CMP), Ed25519 | MPC 2-of-2 (client + server) inside AWS Nitro Enclaves | User device + Coinbase enclave | Self-custody backup ciphertext on device | [`coinbase/cb-mpc`](https://github.com/coinbase/cb-mpc) MIT, C++ | **No** for Midnight curves; good C++ reference for CMP/ECDSA |
| **ZenGo / Gotham** ([`ZenGo-X/multi-party-ecdsa`](https://github.com/ZenGo-X/multi-party-ecdsa)) | secp256k1 | 2-of-2 ECDSA (Lindell17), share rotation & derivation | Client + server | Share-rotation + encrypted backup | MIT; limited maintenance on Gotham | **No** — ECDSA-only, wrong curve for our SNARK |
| **Fireblocks** ([`fireblocks/mpc-lib`](https://github.com/fireblocks/mpc-lib)) | secp256k1, STARK | MPC-CMP (online + offline), EdDSA | Inside Fireblocks' SaaS; MPC-CMP OSS as reference C++ | Institutional recovery flows | GPL-3.0 | **No** — GPL would taint our stack; wrong curves |
| **Silence Labs / Sodot** ([`silence-laboratories/silent-shard-dkls23-ll`](https://github.com/silence-laboratories/silent-shard-dkls23-ll)) | secp256k1 | DKLs23 threshold ECDSA | Distributed across user parties | App-dependent | Source-available (LICENSE.md in repo; verify before use) | **No** — ECDSA-only. DKLs23 is state-of-the-art for ECDSA but not our scheme. |
| **Lit Protocol** | secp256k1 ECDSA today; adding FROST (Ed25519, Sr25519, BIP-340) on the 2025 roadmap; BLS for encryption | Threshold DKG (>2/3); PKPs bound to Lit Actions | Distributed across Lit nodes | Auth-method-based re-auth | Proprietary node code; SDK OSS | **No** for Midnight curves; useful precedent for "threshold signing-as-a-service" posture |
| **Ledger Recover** | N/A (BIP-39 entropy, not signing) | Pedersen VSS (2-of-3) across three HSM custodians | Encrypted fragments in three HSM custodians (Ledger, Coincover, EscrowTech) | ID-verified recovery ceremony | Proprietary | **No** — different problem (seed backup, not seedless signing). Relevant only as a DeRec-style reference for DEC-02. |
| **Penumbra / Narsil** ([`penumbra-zone/frost377`](https://github.com/penumbra-zone/frost377)) | decaf377 (BLS12-377-embedded) | FROST on decaf377 (custom) | Distributed "Narsil shards" | Validator operator | Apache-2.0 | **Reference only** — different curve (decaf377 ≠ JubJub) but almost identical architecture. **Best architectural blueprint we have**. |

**Confidence:** HIGH on library names, licences, curves; MEDIUM on production-readiness of each (drawn from vendor marketing + OSS repo activity, not independent review).

---

## 5. DKG / reshare protocol practices in production

| System | DKG protocol | Reshare cadence | Byzantine model |
|---|---|---|---|
| NEAR MPC | Shared FROST-based DKG (same for all schemes) | Committee re-election on epoch boundaries | >2/3 honest |
| Fireblocks MPC-CMP | CMP key generation | "Proactive security" key refresh (customer-configured) | ≥2/3 honest for t-of-n |
| Coinbase WaaS | 2-of-2 DKG | Per-policy refresh | 1-of-2 assumes one party honest |
| Penumbra Narsil | FROST DKG on decaf377 | Manual reshare on custody change | t-of-n (threshold configurable) |
| ZenGo Gotham | 2-of-2 DKG (Lindell17) | Share rotation on demand | 1-of-2 |

**Implication for MVP-07 (operational model):** The academically-clean answer is "proactive reshare every epoch" (weekly is the production norm; NEAR does monthly). MVP can defer proactive reshare and document a monthly manual reshare as the testnet ops posture (explicitly labelled not-production-grade). Production posture — which is out of scope per PROJECT.md — must be weekly + slashing.

---

## 6. Corrections to existing repo documents

The following claims in our knowledge base should be revised once this research is accepted:

### 6.1 `docs/KNOWLEDGE_BASE.md` — "NEAR `threshold-signatures` Crate" entry

**Current claim (verified 2026/04/10):**
> "Supports ECDSA (secp256k1), EdDSA/FROST (Ed25519), RedDSA/FROST (JubJub), and BLS12-381 (DKG only, signing hashes unimplemented)."

**What the current NEAR repo (`near/mpc`, release v3.8.1, 2026/04/07) actually ships:**
- OT-based ECDSA on secp256k1 (Cait-Sith-derived)
- Robust ECDSA on secp256k1 (DJNPO20)
- EdDSA/FROST on Ed25519 (wraps Zcash's `frost-ed25519`)
- Confidential Key Derivation on BLS12-381 (DKG only, no signing)

**What it does not ship:** RedDSA/FROST on JubJub. Two possible explanations:
1. The claim was made against an older experimental branch of `near/threshold-signatures` that has since been rewritten.
2. The claim conflated Zcash Foundation's `reddsa` crate (which *does* ship RedJubjub FROST) with NEAR's fork.

### 6.2 `docs/mvp-architecture.md` — "Existing tooling" note

**Current claim:**
> "NEAR's `threshold-signatures` crate includes a fully implemented FROST for RedDSA on the JubJub curve, along with DKG, key reshare, and key refresh protocols."

**Corrected claim:**
> "Zcash Foundation's `reddsa` crate (v0.5.1) ships RedJubjub FROST signing via the `frost` feature, backed by `frost-rerandomized` and `frost-core`. DKG must be composed from `frost-core`'s generic DKG primitives (not wired up for RedJubjub out of the box). Key reshare / refresh must be implemented. NEAR's `near/mpc` crate shares DKG architecture across schemes but does not target JubJub."

**Action for the team:** Update the project requirements at the next planning sync and log the evidence.

---

## 7. Licensing implications

The permissive Rust path is clean:

- `reddsa`, `frost-core`, `frost-rerandomized`, `jubjub`, `webauthn-rs` — all MIT / Apache-2.0 / MPL-2.0.
- `midnight-curves` ships with Midnight's licence terms — verify before external distribution.

The GPL-tainted options are unsafe:

- **Fireblocks `mpc-lib`** is GPL-3.0 and must not be linked into any Passport crate we intend to distribute permissively.
- **AGPL-3.0** covers Hanko's self-hosted passkey-server. AGPL is fine for a service but bars embedding Hanko code into a distributed library.

**Action:** Keep all MPV cryptographic code in a crate isolated from GPL/AGPL dependencies. Document licence-compatibility at the Cargo.toml level.

---

## 8. Installation (prototype repo)

```bash
# Rust toolchain — matches current experiments
rustup install 1.88.0
rustup default 1.88.0

# Rust deps added to the prototype workspace
cargo add reddsa --features frost       # RedJubjub FROST signing
cargo add frost-core@3.0.0-rc.0         # Generic DKG scaffolding
cargo add frost-rerandomized@0.6.0      # ZIP-312 layer

# Account provider
cargo add axum                         # HTTP
cargo add webauthn-rs                  # passkey / FIDO2
cargo add jsonwebtoken                 # JWT
cargo add tower-http --features cors

# Existing toolchain
cargo add jubjub@0.10
cargo add subtle zeroize rand_chacha
cargo add tokio --features full
cargo add tracing tracing-subscriber
```

---

## 9. Alternatives considered

| Area | Recommended | Alternative | When to use the alternative |
|---|---|---|---|
| FROST library | `reddsa + frost-rerandomized + frost-core` (Zcash) | Fork `ironfish_reddsa` (Iron Fish's fork of `reddsa`) | Only if upstream `reddsa` stalls. Iron Fish's fork ships FROST with different defaults; would add rebase cost. |
| Signature curve | RedDSA on JubJub (via `reddsa`) | decaf377 (Penumbra) | If Midnight Foundation switched to decaf377. **Do not** use decaf377 — it is not Midnight's native embedded curve. |
| Account-provider framework | Rust + `axum` + `webauthn-rs` | Go + Hanko passkey-server | If the Midnight Foundation prefers Go; AGPL licence implications apply. |
| Passkey client on web | `@simplewebauthn/browser` | `passkey-authenticator` (direct `navigator.credentials`) | Never for production — `SimpleWebAuthn` handles attestation-format parsing we must not reinvent. |
| Threshold ECDSA (for future Stream-C chain abstraction) | Coinbase `cb-mpc` (CMP + DKLs23-compatible primitives) | Fireblocks `mpc-lib` | Never — GPL-3.0. |
| DKG | `frost-core::keys::dkg` parameterised with RedJubjub | Pedersen DKG from scratch | Never — independent implementation doubles the audit burden. |

---

## 10. What NOT to use

| Avoid | Specific problem | Use instead |
|---|---|---|
| **Fireblocks `mpc-lib`** | GPL-3.0 — would force Passport to become GPL | Coinbase `cb-mpc` (MIT, same class of protocol) |
| **BLS12-381 signature scheme (not the curve) inside Compact** | Pairing verification is catastrophically expensive in-circuit | Schnorr/FROST on JubJub — the whole point of the MVP |
| **FROST on Ed25519** for Midnight transactions | Different prime field than BLS12-381 Fr; non-native arithmetic in-circuit is hundreds of constraints per field op | RedDSA on JubJub |
| **GG18 / GG20 ECDSA libraries** | CVE-2023-33241 Paillier vulnerability; Fireblocks explicitly urges migration to MPC-CMP | CMP (`cb-mpc` or `fireblocks/mpc-lib` if GPL is acceptable) |
| **DKLs19** | Superseded; 5 rounds vs DKLs23's 3 | DKLs23 (`silent-shard-dkls23-ll`) |
| **Rolling our own WebAuthn** | Attestation-format parsing, FIDO conformance, policy CBOR — years of traps | `webauthn-rs` or `SimpleWebAuthn` |
| **`rand` ≥ 0.9.0** | Breaks `proptest` ≤ 1.6 (already noted in our stack) | `rand` 0.8.x |

---

## 11. Version compatibility matrix

| Package A | Compatible with | Notes |
|---|---|---|
| `reddsa` 0.5.1 | `frost-rerandomized` ^0.6.0 | Directly pinned |
| `frost-rerandomized` 0.6.x | `frost-core` 1.x (reddsa still on this) | frost-core 3.0.0-rc.0 (Jan 2025) bumps — **will require reddsa update** |
| `frost-core` 3.0.0-rc.0 | `reddsa` (not yet updated to match) | **Gap**: we must either stay on reddsa 0.5.x's transitive frost-core (1.x) or fork/patch to move everyone forward. Raise as a decision item. |
| `jubjub` 0.10 | `midnight-curves` 0.2.0 | Already validated in experiments |
| `reddsa` 0.5.x | `pasta_curves` 0.5, `group` 0.13, `jubjub` 0.10 | Fixed at 0.5.0 release |
| Midnight proof server 8.0.2 | `midnight-ledger` 8.1.0-rc.1 | **Known incompatibility** — see the known-issues log §Known Bugs |

---

## 12. Confidence assessment per recommendation

| Recommendation | Confidence | What would change it |
|---|---|---|
| Use `reddsa` 0.5.1 for RedJubjub FROST signing | **HIGH** | If the Zcash Foundation abandoned `reddsa`, or if Midnight Foundation defined an incompatible alternative (e.g. a native Midnight FROST crate). |
| Compose DKG from `frost-core::keys::dkg` | **HIGH** | If Midnight Foundation released an audited DKG, we would switch. |
| Use Poseidon as H2 in our FROST ciphersuite | **MEDIUM** | Cryptographer review (Jesus Diaz Vico) must sign off. If Poseidon-as-RO is deemed inadequate, we fall back to Blake2b inside the circuit — expensive but validated. |
| Account-provider: Rust + `webauthn-rs` + `axum` | **HIGH** | If Midnight Foundation already has a preferred Go/TS stack. |
| Penumbra's Narsil as architectural blueprint | **MEDIUM** | If a closer blueprint emerges (unlikely; we surveyed exhaustively). |
| NEAR MPC operational model (monthly reshare, >2/3 honest) for MVP-07 | **MEDIUM** | Depends on Byzantine-model review by Jesus Diaz Vico. |

---

## 13. Sources (grouped by confidence)

### HIGH confidence (official docs / release pages / source repos)

- FROST workspace (ZcashFoundation): https://github.com/ZcashFoundation/frost — v3.0.0-rc.0, 2025/01/28
- `frost-core` crate: https://crates.io/crates/frost-core
- `reddsa` crate: https://crates.io/crates/reddsa — v0.5.1, 2024/07/12
- `reddsa` docs: https://docs.rs/reddsa/latest/reddsa/
- `reddsa` releases: https://github.com/ZcashFoundation/reddsa/releases
- NEAR MPC: https://github.com/near/mpc — v3.8.1, 2026/04/07 (MIT)
- NEAR threshold-signatures (archived): https://github.com/near/threshold-signatures — moved to `near/mpc`
- NEAR Chain Signatures docs: https://docs.near.org/chain-abstraction/chain-signatures
- `jubjub` crate: https://github.com/zkcrypto/jubjub
- `midnight-curves` crate: https://crates.io/crates/midnight-curves
- RFC 9591 FROST: https://datatracker.ietf.org/doc/rfc9591/
- ZIP-312 re-randomized FROST: https://eprint.iacr.org/2024/436.pdf (Gouvêa & Komlo, 2024)
- SimpleWebAuthn: https://simplewebauthn.dev/
- Apple ASAuthorizationPlatformPublicKeyCredentialProvider: https://developer.apple.com/documentation/authenticationservices/asauthorizationplatformpublickeycredentialprovider
- Android Credential Manager: https://developer.android.com/identity/sign-in/credential-manager
- `webauthn-rs`: https://github.com/kanidm/webauthn-rs
- Penumbra `frost377`: https://github.com/penumbra-zone/frost377
- ZenGo `multi-party-ecdsa` / `gotham-city`: https://github.com/ZenGo-X/
- Fireblocks `mpc-lib`: https://github.com/fireblocks/mpc-lib (GPL-3.0)
- Coinbase `cb-mpc`: https://github.com/coinbase/cb-mpc (MIT)
- Silence Labs `silent-shard-dkls23-ll`: https://github.com/silence-laboratories/silent-shard-dkls23-ll
- Web3Auth MPC Core Kit: https://web3auth.io/docs/sdk/mpc-core-kit/mpc-core-kit-js
- Hanko: https://github.com/teamhanko/hanko

### MEDIUM confidence (vendor marketing / architecture summaries)

- Privy architecture: https://docs.privy.io/security/wallet-infrastructure/architecture
- Privy SSS blog: https://privy.io/blog/shamir-secret-sharing-deep-dive
- Turnkey enclave docs: https://docs.turnkey.com/security/enclave-secure-channels
- Magic DKMS: https://magic.link/docs/wallets/enterprise-features/generalized-dkms
- Dynamic TSS-MPC: https://www.dynamic.xyz/blog/introducing-dynamic-embedded-wallets-with-tss-mpc
- Coinbase WaaS whitepaper: https://www.coinbase.com/blog/digital-asset-management-with-mpc-whitepaper
- Lit Protocol 2025 roadmap: https://spark.litprotocol.com/2025-cryptography-roadmap/
- Ledger Recover: https://www.ledger.com/blog/part-1-genesis-of-ledger-recover-self-custody-without-compromise
- NEAR FastAuth (deprecated status): https://docs.near.org/chain-abstraction/fastauth-sdk

### LOW confidence — single source, unverified

- FROST2 / FROST3 / ROAST theoretical comparison (flagged for cryptographer review): ROAST paper — https://eprint.iacr.org/2022/550.pdf
- Proactive secret sharing production cadence (inferred from multiple vendor posts, not a single authoritative source)

---

*Stack research for: seedless-wallet / threshold-signing / passkey onboarding on Midnight*
*Researched: 2026/04/16*
*Consumed by: roadmap creation (MVP-01 cornerstone, MVP-02 in-circuit verification, MVP-03 account provider, MVP-07 operational model) and partner conversations (Midnight Foundation, Lace, formal-methods team)*
