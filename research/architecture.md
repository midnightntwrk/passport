# Architecture Research — Threshold / MPC Signing Networks

**Domain:** Threshold / MPC signing networks fronted by account providers, feeding a ZK-proof pipeline and an on-chain registry
**Researched:** 2026/04/16
**Confidence:** MEDIUM–HIGH (specific committee sizes and protocol choices corroborated by official docs and source code; ops detail on some vendors thin)

---

## 1. Why This Document Exists

The MVP cornerstone (see `docs/mvp-architecture.md`) is a **threshold Schnorr network — RedDSA over FROST on JubJub** — sitting behind an OAuth-like account provider, with the emitted signature consumed as a witness inside a Midnight Compact circuit (never published on chain).

That description resembles several production systems. This document surveys them so that the Midnight Passport roadmap makes deliberate choices — committee size, threshold, transport, re-share cadence, recovery — grounded in prior art rather than inherited by accident. It also names **what cannot be reused**: the JubJub / Halo2 / Compact / ZK-witness combination is unusual, and at least one component must be built from scratch regardless.

**Scope:** architecture only — component boundaries, topology, lifecycle, incident landscape. Curve, proof-system, and feature choices are covered in `STACK.md` and `FEATURES.md`.

---

## 2. Reference Networks — Side-by-Side

### 2.1 Summary Matrix

| System | Committee size | Threshold | Curves / scheme | Shape | Key lifecycle | Notes for us |
|---|---|---|---|---|---|---|
| **NEAR Chain Signatures (v1.signer)** | **8 nodes (mainnet)** | threshold undocumented in public docs; governed by smart-contract vote | **secp256k1** (OT-based ECDSA, robust ECDSA), **Ed25519** (FROST), **BLS12-381** (confidential key derivation only) | t-of-n on a single aggregate key per path | DKG once, deterministic derivation per path, **resharing via on-chain vote** | The closest prior art we have. FROST-on-JubJub (RedDSA) is **not** in the upstream crate — this is the gap we must fill. |
| **Lit Protocol (Naga / V1)** | **7 node operators** (Dec 2025 genesis DKG) | "more than 2/3 must respond" | ECDSA (primary), Schnorr (incl. ZK variants), EdDSA; BLS12-381 on the Chronicle rollup only | t-of-n producing PKPs (Programmable Key Pairs) with on-chain access-control conditions | Stake-weighted operator selection; V0 (Datil) shuts down Feb 2026 → hard cutover | Useful for the **access-control / policy** model. Not useful for JubJub. |
| **Web3Auth / Torus** | **5 or 9 nodes typical** (t-of-n; 3/5 example in docs) | t = ⌈2n/3⌉ typically | secp256k1, Ed25519, GG19/GG20, DKLS19, BLS (planned) | **Share-based**: ShareA on device, ShareB on infra, ShareC user-input/recovery | OAuth login → SessionRequest (commit-reveal against front-running) → derive signing key | **Closest to our OAuth-like UX.** Study the commit-reveal login binding. |
| **dWallet / Ika (2PC-MPC)** | "Hundreds of nodes" (Sui-resident) | 2/3 of the network **plus the user** (the user device is one of two parties) | ECDSA (secp256k1) | **2PC-MPC**: user-device is party 1; network emulates party 2 | User cryptographically required for every signature | Architecture answer if we ever want *non-custodial* signing without abandoning a network — the user's passkey device participates directly. |
| **ZenGo / Gotham** | **2 (fixed)** | 2-of-2 | ECDSA (Lindell17 originally; now patched variants) | 1 share on phone + 1 share on ZenGo server | Recovery via email + cloud recovery file + 3D FaceLock (three factors) | **Smallest viable committee.** Good reference for the recovery-server / account-provider boundary. |
| **Fireblocks (MPC-CMP)** | n-of-n institutional; typical quorum **≥ 3 endpoints** signs a transaction | Configured per workspace via Policy Engine | secp256k1 (primary); MPC-CMP protocol | Policy Engine inside SGX + distributed MPC endpoints; **each endpoint independently validates policy before signing** | Re-sharing supported; policy rules signed by admin quorum, encrypted inside SGX | Reference for **policy enforcement** and **per-endpoint attestation**. |
| **Silence Labs — Silent Shard (DKLS23)** | Configurable 2-of-2 to t-of-n | configurable | ECDSA DKLS23 (3-round signing; state-of-the-art) | Mobile-first: phones/edge devices can be nodes | Libraries, not a hosted network | Candidate *library* if we later need DKLS23. Not JubJub. |
| **Turnkey** | Each keystore runs inside an **AWS Nitro Enclave**; root quorum for admin | Configured `rootQuorum` (userIDs + threshold) | Multiple (HSM-style) | **Enclave-per-keystore**, not classical MPC: each key lives in an attested enclave; the *control plane* is quorum-governed | Key shards encrypted inside enclaves before persistence; only authorised enclaves can decrypt | Reference for **enclave-first design** as an alternative / complement to MPC. |
| **Ledger Recover** | 3 custodians (Ledger, Coincover, EscrowTech) — **not an online signing network** | 2-of-3 Pedersen VSS | Seed-phrase recovery (not transaction signing) | HSMs at each custodian; orchestrator ties them together | One-shot recovery, not routine signing | Reference for **social / federated recovery** with an identity-gated release. |
| **Coinbase WaaS** | MPC-based (no longer HSM-only) | Commercial, details not public | secp256k1 | Cloud-hosted; was vulnerable to the Lindell17 abort bug in 2023 (patched) | — | Reference for **wallet-as-a-service** UX; also a cautionary tale on implementation pitfalls. |

### 2.2 Observations

- **Consumer-facing networks cluster around 7–9 nodes.** NEAR mainnet runs 8; Lit Naga runs 7; Web3Auth documents 9-node production clusters. Smaller than typical BFT chains; large enough to tolerate several faults.
- **Small committees exist and ship at scale.** ZenGo's 2-of-2 has served millions of users. 2-of-2 is not "less decentralised" per se — it trades network-federation for **user-plus-provider** split, with recovery added via an orthogonal mechanism (3FA).
- **Thresholds are almost always ⌈2n/3⌉ or looser.** Exact "f faults tolerated" is rarely advertised in user docs; the assumption is the standard BFT bound.
- **Only Zcash and NEAR implement RedDSA on JubJub** (and NEAR's support is thin — see §6). We will likely vendor Zcash's `frost-rerandomized` for the JubJub ciphersuite and wrap it for our purposes.

---

## 3. Canonical Architecture (our project)

### 3.1 System Overview (MVP)

```
┌──────────────────────── USER DEVICE ────────────────────────────────────────┐
│                                                                              │
│   ┌──────────────┐   WebAuthn     ┌───────────────────┐                     │
│   │  Passkey     │ ◄────────────► │  Account provider │                     │
│   │ (OS keystore)│   challenge    │   (OAuth-like)    │                     │
│   └───────┬──────┘                └────────┬──────────┘                     │
│           │                                 │ issues JWT                     │
│           │ signed JWT + tx params          │ binds passkey → user_id        │
│           ▼                                 ▼                                │
│   ┌──────────────────┐            ┌──────────────────────────────────────┐  │
│   │  Transaction      │   JWT     │          ACCOUNT PROVIDER            │  │
│   │  composer         │───────────│  • Registration / passkey verify     │  │
│   │  (ts/browser)     │           │  • JWT (short-lived; session-scoped) │  │
│   │                   │           │  • Device-addition ceremony (QR)     │  │
│   └─────────┬─────────┘           │  • Recovery (rebind device → account)│  │
│             │                     │  • Billing / DUST sponsorship tickets│  │
│             │ tx challenge +      └────────────────────┬─────────────────┘  │
│             │ JWT                                      │ JWT introspection  │
└─────────────┼──────────────────────────────────────────┼────────────────────┘
              │                                          │
              ▼                                          ▼
┌─────── SIGNING NETWORK (FROST/RedDSA on JubJub) ─────────────────────────────┐
│                                                                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│   │ Signer 1 │◄──►│ Signer 2 │◄──►│ Signer 3 │◄──►│ Signer 4 │  … Signer N  │
│   │ share_1  │    │ share_2  │    │ share_3  │    │ share_4  │              │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘              │
│                                                                              │
│   Each signer:                                                               │
│     • verifies JWT against account provider (JWKS)                           │
│     • checks the tx challenge fields (token, amount, recipient, tx_count,    │
│       nonce) against per-user policy                                         │
│     • contributes a FROST partial signature                                  │
│     • ROAST-style coordinator (or one signer acting in that role) aggregates │
│                                                                              │
│   Output: a single RedDSA/JubJub Schnorr signature (s, R)                    │
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     │ signature bytes (never on chain)
                                     ▼
┌─────────── PROOF SERVER ───────────────────────────────────────────────────┐
│  Midnight proof server (external; stateless from user's POV)                │
│  • consumes the signature as a private witness                              │
│  • runs the Compact circuit with `ecMulGenerator`, `ecMul`, `ecAdd` to      │
│    verify s·G == R + c·PK on JubJub                                         │
│  • emits the Halo2 proof                                                    │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │ proof + public tx
                                     ▼
┌─────────── MIDNIGHT CHAIN ──────────────────────────────────────────────────┐
│  • Name registry contract (name → account public key)                       │
│  • Per-user wallet contract (owner_pk, tx_count, balances)                  │
│  • Verifier accepts proof; releases tokens / transitions state              │
│  • DUST fees paid by either user or sponsored via account-provider ticket   │
└─────────────────────────────────────────────────────────────────────────────┘
```

Three invariants fall out of this picture:

1. **The signature is a witness, not a public value.** It crosses only the device ↔ signing-network and device ↔ proof-server boundaries. It never reaches the chain.
2. **The signing network is policy-enforcing, not a dumb oracle.** Each node independently verifies the JWT and the challenge contents — the account provider and the signing network jointly enforce authorisation, and neither alone is sufficient (critical for the regulatory posture called out in `PROJECT.md`).
3. **DUST sponsorship sits with the account provider, not with the signing nodes.** The signing network produces a signature; it does not submit transactions. The device decides where the transaction goes and who pays.

### 3.2 Component Responsibilities

| Component | Owns | Does not own |
|---|---|---|
| **Passkey / OS keystore** | WebAuthn credential per device; signs account-provider challenges | Midnight keys; JubJub math; DUST |
| **Account provider** | user_id ↔ passkey(s); JWT issuance; device ceremony; recovery orchestration; DUST sponsorship vouchers | Midnight private keys (by construction — it has zero key material) |
| **Signing network** | JubJub key share per user; FROST DKG / signing / reshare; per-user policy (rate limits, max-amount, recipient allowlists if any) | Proof generation; chain submission; user identity (derived from JWT) |
| **Proof server** | Halo2 prover; circuit execution | The signature (received transiently); keys |
| **Name registry (on-chain)** | name → public key mapping; commit-reveal registration | Any off-chain identity |
| **Wallet contract (on-chain)** | Per-user balances + tx_count + owner_pk | Multi-key logic *(not in MVP; Stream A adds this)* |

### 3.3 Trust Boundaries (who trusts whom, for what)

- **Device ↔ Account provider:** the user trusts the provider to bind their passkey correctly to their identity. Compromise = adversary can impersonate the user **to the signing network**, but still cannot forge a signature against a different `tx_count` / recipient because the Schnorr challenge hash is bound to transaction parameters. This is the key security argument for the MVP's "federated custodial, but constrained" model.
- **Account provider ↔ Signing network:** the provider trusts the signing network not to sign arbitrarily (hence per-node policy checks); the signing network trusts the provider to have verified a passkey before issuing the JWT (hence JWT introspection + JWKS rotation).
- **Signing nodes ↔ each other:** standard BFT assumption — fewer than `n − t` nodes are byzantine. We recommend **t = ⌈2n/3⌉** (aligns with NEAR, Lit, Web3Auth; §4.1).
- **Device ↔ Proof server:** the device trusts the proof server to produce a valid proof over the inputs it was given. If the proof server lies, the proof will fail verification on chain — failure is detectable. Therefore low-trust.
- **Chain verifier ↔ everything above it:** trust **nothing but the proof**.

---

## 4. Protocol Lifecycle

### 4.1 Choosing a committee size and threshold

| n | t (⌈2n/3⌉+1) | Fault tolerance | Comparable deployments |
|---|---|---|---|
| 3 | 3 | 0 byzantine, 0 offline — fragile | Demos only |
| **5** | **4** | 1 byzantine + 0 offline, or 0 byzantine + 1 offline | ZenGo-adjacent; Web3Auth's smaller tier |
| **7** | **5** | 2 byzantine or offline (mix) | **Lit Naga V1 (live)** |
| **8** | **6** | 2 byzantine or offline | **NEAR mainnet (live)** |
| 9 | 7 | 2 | Web3Auth's 9-node cluster |
| 13 | 9 | 4 | Large enterprise |

**Recommendation for MVP demo network:** **n = 5, t = 4.** Rationale: we ship a working demo in weeks, not months; 5 is enough to demonstrate the Byzantine threshold visibly (take one down mid-demo, it still signs); operations of 5 nodes is still one person's job. For the eventual production network (outside `PROJECT.md` scope but relevant for the MVP design) we would follow NEAR's 8-node / Lit's 7-node sizing.

For the threshold, **⌈2n/3⌉ + 1** is the common choice for BFT resilience. NEAR's precise threshold isn't advertised in the public docs; Lit explicitly uses "more than 2/3". We see no reason to deviate.

### 4.2 DKG (Distributed Key Generation)

All surveyed networks use Pedersen-style VSS as the DKG primitive:

- **Zcash FROST reference** uses PedPoP (Pedersen proof-of-possession). `ZcashFoundation/frost` exposes this directly for JubJub and Pallas.
- **NEAR** uses a FROST-based DKG as a shared primitive across all three signature schemes (ECDSA, EdDSA, confidential BLS).
- **Lit** does "DKG across the Lit network"; protocol details proprietary.

**Round count:** Pedersen-style DKG is **2 rounds** (commitment + opening + share distribution). FROST signing is **2 rounds** (preprocessing + sign). Together: **4 rounds on new account creation, 2 rounds per signature**.

**Failure mode to design for:** one node dropping mid-ceremony. The usual handling is **complaint → restart**: if a node sees inconsistent openings, it broadcasts a complaint, and the ceremony aborts cleanly with no key produced. For the MVP we treat DKG failures as "user retries account creation in 5 seconds" — this is acceptable because DKG is rare (once per account).

**Pitfall to avoid:** running DKG synchronously in the user-facing path. Lit, NEAR, and Web3Auth all run DKG **pre-ceremony-style** and provision the key material into the user's session. We should follow — the user should not be looking at a spinner while five nodes exchange commitments.

### 4.3 Signing (per transaction)

**FROST3 (the latest variant, 2-round, security-proven)** is the right target. The core flow:

1. Device hashes the transaction parameters into a challenge `c = persistentHash(sig_R, owner_pk, token, amount, recipient, tx_count, nonce)` (this is already what our `experiments/redjubjub-wallet` does — critical, **do not regress**).
2. Device sends `c`, along with JWT, to the signing network's coordinator endpoint.
3. Coordinator polls ≥ t signers; each signer independently:
   - verifies JWT signature & expiry against the account provider's JWKS,
   - checks transaction parameters against per-user policy,
   - returns a preprocessing nonce commitment (round 1).
4. Coordinator aggregates commitments into a group commitment `R`, rebroadcasts.
5. Signers produce partial `z_i`, coordinator aggregates into `s = Σ z_i`.
6. Coordinator returns `(R, s)` to the device.
7. Device passes `(R, s)` as witness to the proof server.

**ROAST wrapper, strongly recommended.** FROST signing can be disrupted by a single malicious signer abandoning the round. ROAST (Ruffing et al., ACM CCS 2022) wraps FROST so that a quorum of honest signers always completes in the presence of disruptors. The cost is a slightly more complex coordinator. Arch Network and others already do this. For our MVP we should design the coordinator interface so that ROAST can be plugged in later (i.e. do not build it in to the signing nodes — keep the coordinator separate).

### 4.4 Re-sharing

Re-sharing refreshes shares without changing the public key. Three cadences to consider:

| Cadence | Rationale | Downside |
|---|---|---|
| **Never** | Simplest. | Compromise is permanent. |
| **Epoch-based (weekly / monthly)** | Periodic refresh limits the exposure window | Windows of availability loss during reshare |
| **On-demand (after operator change)** | Adds/removes a node cleanly | Operationally heavy if operators churn |

**Prior art:** NEAR does **on-demand resharing** via an on-chain vote (`vote_new_parameters`). Web3Auth's model does not publicly advertise a schedule but supports resharing. Our `docs/reference/machine-investigation/.../secure-onboarding-design.md` references **epoch-based resharing** in the DeRec context (Stream B, post-MVP).

**Recommendation for MVP:** **on-demand resharing, no fixed schedule.** Keep the capability in the signing-nodes crate from day one (NEAR's `threshold-signatures` gives this for free in the Ed25519 / ECDSA paths, and the Zcash reference has `frost-rerandomized` which supports resharing-equivalent operations). Do not ship the scheduler; document the manual procedure and exercise it once before the public demo.

### 4.5 Recovery

Recovery means **binding a new device's passkey to the same signing-network key**, after the original device is lost.

Three models in prior art:

| Model | Example | Fit for MVP |
|---|---|---|
| **Provider-mediated, identity-gated** | ZenGo (3D FaceLock + email + cloud recovery file) | **Good fit.** The account provider is the root of trust; the signing network is agnostic. |
| **Social / Shamir** | Ledger Recover (3 custodians, 2-of-3), DeRec (3-of-5) | Overkill for MVP; no signing-network component. **Target for Stream B.** |
| **Self-custody with mnemonic escape** | Every hardware wallet | Contradicts the seedless UX goal. Explicitly out of scope. |

**Recommendation:** the account provider holds the "identity truth" (who is `alice`?) via passkey + recovery email + optionally a recovery code. On recovery, the provider issues a JWT for the existing user_id bound to the new device's passkey. The signing network never learns the recovery happened — from its perspective, the user is signing as always.

**Risk:** the account provider becomes the recovery-authority. If it is compromised, an adversary can bind their own passkey to any account and drain it. Mitigation: (i) rate-limit recovery, (ii) add a mandatory delay window (e.g. 24 h) between recovery request and first signature, (iii) optionally layer DeRec on top for stream B. **This delay is the single most important UX/security lever in the MVP.**

### 4.6 Key Rotation and Node Revocation

- **Rotating operators in:** run a reshare including the new node's share; the old shares become stale.
- **Rotating operators out:** run a reshare excluding the departed node; if the node is malicious, treat its remaining share as compromised and consider the key "one strike against threshold" until the next reshare.
- **Revoking a user:** in the MVP, "revoke" means the account provider stops issuing JWTs for that user. The key shares remain but are unreachable. For true key deletion, the nodes delete the shares — irreversible.
- **Chain-side verification survives all of this,** because the wallet contract only checks Schnorr verification against the registered public key; the chain doesn't care which operators produced the signature.

---

## 5. Integration Boundaries (our specific architecture)

### 5.1 Data-flow diagram — transaction

```
 USER                ACCOUNT              SIGNING               PROOF               MIDNIGHT
 DEVICE              PROVIDER             NETWORK               SERVER              CHAIN
   │                    │                    │                    │                    │
   │ 1. passkey auth    │                    │                    │                    │
   │───────────────────►│                    │                    │                    │
   │◄─── JWT(user_id)───│                    │                    │                    │
   │                    │                    │                    │                    │
   │ 2. build tx                              │                    │                    │
   │    compute c = H(R?, pk, token, amt, to, tx_count, nonce)     │                    │
   │                                          │                    │                    │
   │ 3. sign_request(c, JWT)                  │                    │                    │
   │────────────────────────────────────────►│                    │                    │
   │                        4. JWKS verify ◄─│                    │                    │
   │                        5. policy check   │                    │                    │
   │                        6. FROST rounds (2)                    │                    │
   │◄────── signature (R, s) ────────────────│                    │                    │
   │                                                               │                    │
   │ 7. prove(tx, witness=(R,s))                                   │                    │
   │──────────────────────────────────────────────────────────────►│                    │
   │                                                               │ 8. run circuit:    │
   │                                                               │    s·G == R+c·pk   │
   │◄────────────────────── proof π ──────────────────────────────│                    │
   │                                                                                    │
   │ 9. submit(tx, π)                                                                   │
   │───────────────────────────────────────────────────────────────────────────────────►│
   │                                                                                    │
   │                                                                10. verify π, apply │
   │◄────────────────────────── tx included ───────────────────────────────────────────│
```

### 5.2 Integration Points

| Boundary | Protocol | Confidentiality | Integrity | Notes |
|---|---|---|---|---|
| Device ↔ Account provider | HTTPS + WebAuthn | TLS | WebAuthn attestation | Standard OAuth-like flow |
| Device ↔ Signing network | HTTPS + mTLS (recommended) | TLS | JWT binds to user_id; challenge `c` binds to tx fields | **Coordinator-based**: device talks to one endpoint, not N |
| Signer ↔ Signer | QUIC or libp2p | TLS | Per-node keypair for authentication | NEAR uses libp2p-style; Lit proprietary |
| Device ↔ Proof server | HTTPS | TLS; witness is private | Proof server can lie ⇒ bad proof ⇒ chain rejects | Low trust |
| Any → Chain | SCALE-encoded extrinsic | Public | Halo2 proof | Standard Midnight pipeline |

### 5.3 What the Account Provider Holds (and — critically — what it does not)

**Holds:**
- `user_id ↔ passkey_pubkey(s)` mapping
- Optional `user_id ↔ email` for recovery
- JWT-signing key (rotated via JWKS)
- DUST-sponsorship tickets (opaque tokens redeemable by the device at fee time)

**Does not hold:**
- Any part of the user's JubJub key (not even an encrypted share)
- The user's on-chain wallet contract address (device derives this from the public key returned by the signing network)
- Transaction history (the chain is the source of truth; the provider can optionally index, but we recommend against it for privacy)

**Why this matters:** the provider is **custodial in the authentication sense, not in the key-holding sense**. This is the subtle but decisive boundary between "Web2 UX" and "centralised custody". Compromise of the provider means adversary can impersonate users to the signing network (bad) but cannot steal funds without also defeating the signing-network threshold (worse, but much harder). Regulatory framing should lean on this distinction.

### 5.4 DUST Fees / Gas Sponsorship

Midnight's DUST is not gas-exempted the way NEAR's chain signatures are subsidised by the protocol. Someone has to pay DUST. Options:

1. **Provider pays (MVP recommendation)** — account provider issues a ticket; device presents it; a sponsor wallet pays DUST on submission. User experience: no DUST required, ever.
2. **User pays** — user holds DUST; buys it somewhere. User experience: "where do I get DUST?" — unacceptable for onboarding.
3. **Rollup / meta-tx** — batch transactions; a relayer pays on chain. Possible but adds infra; defer.

Option 1 is the only viable choice if we want the stated seedless UX. Cost: bounded by user activity and covered from an operational budget. This is in scope of MVP-07 ("signing-network operational model for the MVP demo") but not part of the signing network itself — **we must not entangle DUST sponsorship with the signing protocol**.

---

## 6. What Cannot Be Reused — The JubJub / Midnight-Specific Gap

This is the section that turns "integrate the NEAR crate" into "six months of work". The roadmap should flag these explicitly.

### 6.1 FROST-RedDSA on JubJub is niche

| Thing | State of open-source support |
|---|---|
| FROST on Ed25519 | Mature. Zcash Foundation, NEAR, Taurus. Production-grade. |
| FROST on secp256k1 (ECDSA variants) | Mature. NEAR, Silence Labs, Fireblocks. |
| FROST on Pallas (Zcash Orchard) | Mature. Zcash Foundation ships it. |
| **FROST-rerandomized on JubJub (RedDSA for Sapling)** | **Exists in `ZcashFoundation/frost` but is behind a non-default feature; the Sapling SpendAuthSig variant.** |
| FROST with Midnight's Poseidon challenge hash | **Does not exist.** Every reference uses BLAKE2b or RIPEMD. We must adapt. |
| FROST with the exact scalar-field check order our Compact circuit does | **Does not exist.** Our `s·G == R + c·pk` is standard, but the nonce-retry loop to ensure `c < JUBJUB_R` is Midnight-specific. |
| Threshold re-sharing on JubJub | Implied by `frost-rerandomized` but untested at network scale. |

**Our actual integration work:**

1. Take `ZcashFoundation/frost` as the baseline crypto crate.
2. Swap the challenge hash: from BLAKE2b-personal to Midnight's `persistentHash` (Poseidon). This is a few lines but security-critical — must be reviewed by the cryptographer.
3. Wrap the 2-round FROST signing API behind a coordinator-HTTP service.
4. Build the JWT-introspection + per-user-policy layer around it.
5. Package DKG / sign / reshare as a single daemon (Rust).
6. Stand up N instances and a minimal gossip transport.

Of these, step 2 is the one we cannot copy-paste from anywhere. Steps 3–6 can follow NEAR's project structure (it has these shapes already, just not on JubJub).

### 6.2 In-circuit verification is not someone else's problem

None of the surveyed networks verifies the resulting signature **inside a ZK circuit**. They all return the signature to a client which either publishes it on chain or hands it off. Our circuit verification (`experiments/redjubjub-wallet/`) is already the most novel piece of this project. There is no reference we can crib.

This implies:
- The signing network **must not** do anything exotic with nonces / domain separators / challenge construction — because whatever it does, our Compact circuit must do identically. **Keep the signing side dumb and well-specified.**
- A mismatch (e.g. nonce-retry logic on the signing side differing from circuit side) is silent and catastrophic: signatures verify off-chain but fail in-circuit. We must build a conformance harness.

### 6.3 Compact runtime's JubjubPoint equality bug

Already captured in `docs/KNOWLEDGE_BASE.md` and `docs/mvp-architecture.md`. Relevant here because it imposes a **post-compile patch step** in the build pipeline — the signing-network side is unaffected, but the proof-server side must ship the patch or the withdraw circuit fails. The architecture must tolerate this being fixed upstream between now and MVP.

### 6.4 Halo2 / Compact constraints on challenge binding

Our Schnorr challenge includes the transaction parameters. Expanding the challenge (e.g. to add "signature expiry" or "max-fee") costs circuit constraints. The signing network can cheaply add any field it wants; the circuit pays in constraints. **Binding decisions live on the circuit side first** — do not let the signing-network team pick fields independently.

---

## 7. Failure Modes Observed in Production

### 7.1 BitForge (August 2023) — Lindell17 abort handling — CVE-2023-33242

- **What:** Fireblocks researchers found that multiple production 2-of-2 ECDSA wallets (ZenGo, Coinbase WaaS, Binance's library) leaked one bit of the private key per failed signing attempt. After ~256 deliberate aborts, the adversary reconstructs the full key.
- **Root cause:** implementations deviated from the Lindell17 paper's abort handling. Aborts were logged but the protocol did not rotate shares or halt the session.
- **Mitigation:** all affected vendors patched under 90-day responsible disclosure. No exploits in the wild (as reported).
- **Lesson for us:** **test the abort paths.** Schnorr/FROST is simpler than Lindell17 ECDSA and does not have the exact same bit-leak, but analogous "partial signature reveals something about the share" issues have been raised for FROST variants. We should ensure our implementation comes from a reviewed reference (Zcash's) and not a hand-rolled port.

### 7.2 BitForge (August 2023) — GG18 / GG20 flaws — CVE-2023-33241

- **What:** Full-key extraction against multiple GG18/GG20 implementations.
- **Root cause:** implementation bugs across vendors.
- **Lesson:** we are choosing **FROST/Schnorr** rather than ECDSA TSS specifically because the protocol surface is smaller. The Lindell/GG family has a decade of CVEs; FROST is narrower. This is an architecture-level win we should document.

### 7.3 FROST2 security regression — formal analysis (2022)

- **What:** the FROST2 optimisation loses the strongest unforgeability property (TS-SUF-3). The paper (Crites–Komlo–Maller 2022) documents this with proof hierarchies.
- **Root cause:** FROST2 pre-aggregates commitments, which trades security strength for a round.
- **Lesson:** use **FROST3** (the follow-up, provably secure for both trusted-dealer and DKG setups under OMDL/AOMDL). Zcash's `frost` crate is aligned with FROST3-level assumptions. Do not use FROST2 or naïve FROST1 in production.

### 7.4 Lit Protocol V0 → V1 cutover

- **What:** Lit V0 (Datil) shuts down Feb 2026; V1 (Naga) is the replacement.
- **Root cause (observational):** architectural migration, not incident; but the hard cutover date implies legacy-key holders must migrate.
- **Lesson:** **version the network parameters.** Publish an on-chain "current signing-network version" pointer so the device can pick the right committee. Don't hard-code committee endpoints in SDKs.

### 7.5 Implementation-bug class: nonce reuse

- **What:** common failure mode for Schnorr-style schemes across many projects. Deterministic-but-broken RNGs on embedded devices, or incorrect derandomisation (RFC 6979 mistakes) repeatedly surface as key-extraction attacks.
- **Mitigation in our design:** the nonce-retry loop already documented in `experiments/redjubjub-wallet/` ensures `c < JUBJUB_R` but does **not** address the underlying RNG quality. Signing nodes must use a tested CSPRNG and ideally sample nonces inside a TEE. Budget at least one round of review on this specifically.

### 7.6 NEAR MPC TEE integration

- **What:** NEAR's MPC nodes can run inside TEEs (SGX / TDX-style), documented but not mandatory.
- **Lesson:** TEE integration is *an available axis*. For our MVP we explicitly do not target it (MVP-07 scopes out production-grade ops). For production, TEE per node is the next step, mirroring NEAR.

### 7.7 ZenGo's 3FA recovery-server compromise risk

- **What:** the "Recovery File + email + 3D FaceLock" tri-factor is strong, but each factor relies on ZenGo's infrastructure (email, the face model, the escrow). A sophisticated adversary with access to ZenGo's ops could simulate 2 factors and spoof the third.
- **Lesson:** the recovery mechanism is the attack surface an adversary cares about. Applied to us: **recovery rate-limit + mandatory delay** is the single most important security lever.

---

## 8. Anti-Patterns to Avoid

### 8.1 "The account provider holds the keys"

**What people do:** turn the OAuth-like provider into a custodian that also signs.
**Why it's wrong:** collapses the two boundaries (authentication, signing) into one, which destroys the main security argument of the design.
**Do this instead:** keep the provider key-ignorant. It authorises; the network signs. These are separate services with different operators.

### 8.2 "Just verify the JWT at the edge"

**What people do:** put JWT validation in a load balancer / API gateway in front of the signing network, then have the nodes trust the header.
**Why it's wrong:** edge compromise = total compromise. Each node must independently verify.
**Do this instead:** each signer runs JWKS introspection. Accept the latency cost (JWKS is cached; it's negligible).

### 8.3 "DKG per signature"

**What people do:** re-run DKG on every signing request for freshness.
**Why it's wrong:** DKG is heavy; it's 2 rounds + commitments + openings. Doing it per signature would add seconds to every transaction.
**Do this instead:** DKG once per account (at registration). Re-share on-demand. Sign with FROST (2 rounds).

### 8.4 "Let the device pick the signer subset"

**What people do:** device requests `t` specific nodes to sign.
**Why it's wrong:** exposes signer selection to adversarial choice; complicates policy enforcement.
**Do this instead:** device talks to a **coordinator** (which could be one of the signers, or a separate process). Coordinator picks the subset based on availability.

### 8.5 "Bind the signature to nothing"

**What people do:** sign a raw message hash without domain separation or transaction-field binding.
**Why it's wrong:** enables replay. An attacker can capture a signature and replay it against a different transaction.
**Do this instead:** bind the Schnorr challenge to **all relevant transaction fields plus a monotonic counter**. We already do this in `experiments/redjubjub-wallet/`. **This is non-negotiable.**

### 8.6 "Same policy on every node"

**What people do:** all signers apply identical policy checks (rate limit, max amount, etc).
**Why it's wrong:** operator diversity is the point. If all signers run the same policy engine, a bug in that engine lets `t` identical bugs authorise fraud.
**Do this instead:** diverse policy implementations, or at minimum, **policy from a signed, versioned, chain-anchored config** so every signer loads the same rules but the rules themselves are auditable.

### 8.7 "Skip the coordinator round because it's latency"

**What people do:** allow optimistic aggregation — combine partial signatures as they arrive without the preprocessing round.
**Why it's wrong:** this is the **FROST2 regression** (§7.3). Saves a round; loses TS-SUF-3.
**Do this instead:** use FROST3's 2-round signing. The latency is in the tens of milliseconds over LAN; negligible.

---

## 9. Scaling Considerations

| Scale | Architecture Adjustments |
|---|---|
| **Demo (1–10 users, weekly demos to partners)** | n=5 signers on one cloud VPC; single coordinator; synthetic account provider; proof server shared | — |
| **Beta (100–1,000 users)** | n=5 signers across 3 geographies; coordinator pair with failover; real account provider with HA database; dedicated proof-server fleet | First bottleneck: proof-server capacity (Halo2 is heavy). Add workers. |
| **Production (10k+ users)** | n=7 or 9 signers, diverse operators; SLO contract with each; per-user policy shards; indexer for tx history; dashboards | Second bottleneck: account-provider auth throughput. Standard web scaling. |
| **Network (100k+ users)** | Rotate signing-network members in and out (MVP supports this via reshare); observability stack; incident-response playbook | Operations is the hard part, not cryptography. |

**First bottleneck we will hit:** the proof server, not the signing network. FROST signing is milliseconds; Halo2 proving is seconds. The architecture must assume **proof generation is the slow step** and pipeline accordingly (e.g. the device can start the proof locally as soon as the signature arrives; the signing network can pre-warm its next DKG if it ever ships multi-account-per-user).

---

## 10. Recommended Build Order

Ordered by dependency; each item blocks the next.

1. **FROST-RedDSA-on-JubJub with Poseidon challenge** — port from `ZcashFoundation/frost`, swap the hash. Single-process, single-signer. Verifies against the existing Compact circuit. *(Extends `experiments/redjubjub-wallet-rs`.)*
2. **Threshold signing (t-of-n), coordinator-based** — spawn n=3 in-process signers; implement FROST3 2-round signing; produce one valid signature. Pure Rust test.
3. **DKG ceremony** — same crate; run a pre-session DKG, persist shares to disk. No networking yet.
4. **HTTP/gRPC coordinator** — wrap the signing nodes; one port per node. Exercise with a Rust client that mimics the device.
5. **JWT introspection + JWKS** — add to the node; stand up a stub account provider that issues JWTs for a hard-coded user list.
6. **Per-user policy** — tx_count monotonicity, max-amount, optional recipient allow-list.
7. **ROAST coordinator wrapper** — deferred; sanity-test without it first.
8. **Real account provider** — passkey registration, device-addition QR ceremony, recovery.
9. **End-to-end: device → account provider → signing network → proof server → devnet** — the demo.
10. **Re-sharing exercise** — rotate one node out, one node in; confirm the public key is unchanged and signatures still verify.

**Items 1–6 are the critical path** for the weekly demos. Items 7–10 are "before external partners see it" but not before internal demos.

**What can be stubbed on day 1:**
- The account provider can start as a hard-coded `user_id → passkey_pubkey` JSON file served by a tiny Axum server.
- JWT signing can use HS256 with a shared secret for dev; swap to RS256/ECDSA later.
- Recovery flow can be a CLI command for the demo.
- DUST sponsorship can be a hard-coded sponsor account with a fixed float.

**What cannot be stubbed:**
- The FROST-on-JubJub math (this is the project).
- The challenge-binding to transaction parameters (silent correctness bug otherwise).
- The chain-side circuit verification (this is the MVP's entire claim).

---

## 11. Reference Diagrams Worth Copying

| Source | What to copy | Citation |
|---|---|---|
| NEAR docs — Chain Signatures page | Single-contract signing request flow: device → contract → off-chain MPC → contract → device | https://docs.near.org/chain-abstraction/chain-signatures |
| Zcash FROST blog | FROST round structure, DKG ceremony | https://zfnd.org/frost/ |
| Web3Auth MPC Architecture | Session-request with commit-reveal for OAuth login binding | https://web3auth.io/docs/infrastructure/mpc-architecture |
| Fireblocks MPC-CMP blog | Per-endpoint independent policy validation before signing | https://www.fireblocks.com/blog/pushing-mpc-wallet-signing-speeds-8x-with-mpc-cmp-9 |
| ZenGo / Gotham-city README | 2-of-2 DKG and signing protocol between phone and server | https://github.com/ZenGo-X/gotham-city |
| dWallet / Ika 2PC-MPC doc | User-device-as-party architecture for future self-custody | https://github.com/dwallet-labs/ika/blob/main/docs/docs/core-concepts/cryptography/2pc-mpc.md |
| Ledger Recover whitepaper | Three-custodian, identity-gated recovery model | https://www.ledger.com/blog/announcing-the-ledger-recover-cryptographic-protocol-white-paper |
| ROAST paper | Robust asynchronous wrapper for FROST | https://eprint.iacr.org/2022/550 |

---

## 12. Open Questions (for partner conversations)

1. **Which operator set for the demo signing network?** We need 5 servers run by 5 (ideally different) people, each with a key. Candidates: IOG internal, Midnight Foundation, Lace, two external. This is a **META-02 delegation** decision.
2. **Do we adopt NEAR's v1.signer-style on-chain signer contract?** It would route signature requests through the chain instead of a direct HTTP endpoint. Heavier but more auditable. **Recommend: no for MVP, yes to consider for v2.**
3. **Where does the challenge-construction specification live?** In MIP-7 (FROST MIP) or in MIP-2 (address format) or both? **Recommend: MIP-7 fully specifies challenge construction; circuit-side is a reference implementation inside the Midnight platform**.
4. **Does Midnight's proof server support user-supplied witnesses in production today?** If not, MVP-01 blocks on platform work.
5. **Can we run the demo without TEEs on the signing nodes?** Yes for MVP (operator trust is acknowledged). Revisit for production (NEAR's TEE integration is the model).

---

## 13. Sources

**Official docs / source code (high confidence):**
- NEAR Chain Signatures — https://docs.near.org/chain-abstraction/chain-signatures
- NEAR MPC GitHub — https://github.com/near/mpc
- NEAR threshold-signatures crate — https://github.com/near/threshold-signatures
- Zcash Foundation FROST — https://zfnd.org/frost/ and https://github.com/ZcashFoundation/frost
- ZIP 312 (Zcash shielded multisig with FROST) — https://zips.z.cash/zip-0312 *(referenced; not read directly)*
- Ledger Recover white paper — https://www.ledger.com/blog/announcing-the-ledger-recover-cryptographic-protocol-white-paper
- Lit Protocol V1 announcement — https://spark.litprotocol.com/v1-live/
- Web3Auth MPC Architecture — https://web3auth.io/docs/infrastructure/mpc-architecture
- Fireblocks MPC-CMP — https://www.fireblocks.com/blog/pushing-mpc-wallet-signing-speeds-8x-with-mpc-cmp-9
- Fireblocks BitForge — https://www.fireblocks.com/blog/bitforge-fireblocks-researchers-uncover-vulnerabilities-in-over-15-major-wallet-providers
- ZenGo Gotham City — https://github.com/ZenGo-X/gotham-city
- dWallet / Ika — https://github.com/dwallet-labs/ika
- Silence Labs Silent Shard DKLS23 — https://github.com/silence-laboratories/silent-shard-dkls23-ll
- Turnkey Architecture — https://whitepaper.turnkey.com/architecture

**Academic (high confidence):**
- FROST (Komlo–Goldberg 2020) — https://eprint.iacr.org/2020/852
- Stronger Security for Non-Interactive Threshold Signatures (Crites–Komlo–Maller 2022) — https://eprint.iacr.org/2022/833
- ROAST (Ruffing et al. 2022) — https://eprint.iacr.org/2022/550
- Re-Randomized FROST (Gouvêa–Komlo 2024) — https://eprint.iacr.org/2024/436
- Practical Key-Extraction Attacks in Leading MPC Wallets (Makriyannis 2023) — https://eprint.iacr.org/2023/1234
- RFC 9591 (FROST) — https://datatracker.ietf.org/doc/rfc9591/

**Medium confidence (blog posts, Medium articles):**
- NEAR Chain Signatures Medium post — https://medium.com/nearprotocol/a-first-look-at-chain-signatures-cross-chain-without-bridges-81c8421d153c
- ZenGo security overview — https://zengo.com/security/

**Project-internal:**
- `docs/mvp-architecture.md` — FROST-on-JubJub MVP design
- `docs/passport-plan.md` — three-step path to decentralisation
- `docs/KNOWLEDGE_BASE.md` — verified cryptographic facts (BLS vs Schnorr, JubJub vs Ed25519 in-circuit)
- `experiments/redjubjub-wallet/` and `experiments/redjubjub-wallet-rs/` — working JubJub Schnorr in Compact

---

*Architecture research for: threshold / MPC signing networks — Midnight Passport MVP*
*Researched: 2026/04/16*
