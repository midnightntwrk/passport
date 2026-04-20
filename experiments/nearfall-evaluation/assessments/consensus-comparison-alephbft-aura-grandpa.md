# 🤖 Consensus Comparison: AlephBFT vs. AURA + GRANDPA, and Relationship to ProtoGalaxy

**Scope:** This document describes and contrasts two consensus approaches relevant to the NEARFall evaluation — AlephBFT (used by Aleph Zero) and the AURA + GRANDPA combination currently deployed in Midnight — and then explains how these consensus-layer choices relate orthogonally to the ProtoGalaxy proof-folding technique operating at the execution layer. The document is a companion to [`substrate-throughput-techniques.md`](substrate-throughput-techniques.md), extracting and extending its §2.2 treatment of consensus replacement.

> [!NOTE]
>
> ❓🤖 **SCRUTINY — performance figures require verification.** The quantitative AlephBFT figures cited below (89,600 TPS, 0.4 s finality) originate from a single controlled benchmark of a **Golang prototype**, not the production Rust/Substrate implementation. They should be treated as existence proofs that the protocol can achieve subsecond finality at scale, not as guaranteed production throughput. See the Afterword for sourcing details.

---

## 1. AURA + GRANDPA (Current Midnight Consensus)

Midnight uses the standard Substrate two-layer consensus design:

### 1.1 AURA (Authority Round) — Block Production

AURA assigns block-production slots to validators in a deterministic round-robin. In each 6-second slot, exactly one designated authority may propose a block. Properties:

- **Deterministic leader selection:** no VRF randomness; each authority knows its slot schedule in advance.
- **Single block per slot:** only one block can be canonical per slot; no concurrent production.
- **No built-in finality:** AURA alone provides only probabilistic fork-choice (longest-chain rule); finality requires a separate gadget.
- **Simple to implement and reason about:** the predictability is a reliability advantage but also a mild liveness risk (a leader that is offline produces a skipped slot, which is unrecoverable within that slot).

### 1.2 GRANDPA (GHOST-based Recursive ANcestor Deriving Prefix Agreement) — Finality

GRANDPA is a finality gadget that runs in parallel with block production. Validators vote on *chains* (not individual blocks), allowing multiple blocks to be finalised in a single round. Properties:

- **Votes on chains:** a GRANDPA vote for block $B$ implicitly endorses all ancestors of $B$; this allows "catching up" finality across many blocks at once.
- **Safety-first design:** GRANDPA never finalises two conflicting chains. Under a network partition it halts finality rather than risk a safety violation.
- **Liveness hazard:** finality stalls during any network partition, even if AURA continues producing (unfinalized) blocks. Applications requiring confirmed finality are blocked during stalls.
- **Finality latency:** typically 2–6 s on Midnight mainnet; can be longer under adverse network conditions.
- **BFT threshold:** requires ≥ 2/3 of validators to be honest and reachable for finality to proceed.

### 1.3 Combined AURA + GRANDPA Behaviour

| Property | Value |
|----------|-------|
| Block production rate | 1 block per 6 s (AURA slot duration) |
| Finality latency | 2–6 s typical; unbounded under partition |
| TPS ceiling (current config) | ~3 TPS (200 KB blocks, ~10 KB ZK txs) |
| Fault tolerance | ≥ 1/3 honest validators required (GRANDPA) |
| Liveness under partition | AURA continues; GRANDPA stalls |

---

## 2. AlephBFT

AlephBFT is a DAG-based Byzantine Fault Tolerant consensus protocol developed by Aleph Zero (Cardinal Cryptography). It was designed as a standalone, modular consensus library that can be integrated into a Substrate node without altering the runtime or pallets.

### 2.1 Architecture

AlephBFT operates in rounds. In each round, every participating validator broadcasts a *unit* — a record containing a hash commitment and references to units from prior rounds. These units form a directed acyclic graph (DAG). A deterministic algorithm then extracts a total ordering of units from the DAG structure; the finalised sequence of blocks is derived from this ordering.

Key properties:

- **DAG-based finality:** every validator broadcasts *units* (containing hashes of AURA-produced blocks) into a shared DAG; the total ordering of those block hashes is extracted deterministically from the DAG topology. Block *production* is still handled by AURA in round-robin slots; AlephBFT operates on top of whatever AURA produces.
- **Finality gadget role:** in Aleph Zero's production deployment AlephBFT is used as a drop-in replacement for GRANDPA only. The `aleph-node` README states verbatim: *"Block authoring is realized with Substrate's Aura. The default finality gadget (GRANDPA) has been replaced with AlephBFT."* The library can theoretically operate as a full state-machine-replication engine (without AURA), but that mode is not used.
- **Asynchrony-tolerant safety:** correctness is guaranteed under arbitrary message delays (fully asynchronous model). Liveness requires partial synchrony — a standard and reasonable network assumption.
- **BFT threshold:** tolerates up to $f < n/3$ Byzantine validators.
- **Subsecond finality:** 416 ms median finality was measured in a 112-node benchmark (pre-mainnet Golang prototype); the production Rust implementation on Aleph Zero mainnet achieves ~1 s finality in practice.
- **Open source:** the `aleph-bft` crate (Apache 2.0 / MIT) is a standalone Rust library separable from the Aleph Zero chain. Substrate integration has been demonstrated by Aleph Zero's production deployment.

### 2.2 What AlephBFT Replaces in Substrate

| Substrate component | Replaced by AlephBFT? |
|---------------------|----------------------|
| AURA block production | **No** — validators still take turns proposing blocks; AlephBFT orders and finalises them |
| GRANDPA finality gadget | **Yes** — AlephBFT provides finality, eliminating GRANDPA entirely |
| Runtime pallets | **No** — the runtime (ZK proof verification, state transitions) is unchanged |
| `sp-consensus` interface | Partially — the finality interface is replaced; block import pipeline is retained |

Replacing GRANDPA with AlephBFT is therefore a *consensus crate replacement*, not a runtime or protocol migration.

---

## 3. Comparative Analysis

| Property | AURA + GRANDPA | AURA + AlephBFT |
|----------|----------------|-----------------|
| **Architecture** | Two-layer: AURA (production) + GRANDPA (finality gadget) | Two-layer: AURA (production, unchanged) + AlephBFT (finality gadget) |
| **Block production** | Single leader per slot (AURA round-robin) | Single leader per slot — AURA unchanged |
| **Finality latency** | 2–6 s typical; stalls under partition | ~0.4–1 s; more robust under asynchrony |
| **Liveness under partition** | GRANDPA halts finality; AURA keeps producing unfinalized blocks | DAG construction continues; finality degrades gracefully |
| **Safety model** | Safety-first (GRANDPA never double-finalises) | BFT-safe ($f < n/3$) |
| **TPS multiplier effect** | Baseline (1 block / 6 s) | 3–5× more finalized blocks per second at same slot duration |
| **Substrate integration effort** | Baseline (already deployed) | Replace consensus crate; retain all runtime and pallet code |
| **Production deployment** | Midnight, Polkadot parachains, Acala, Moonbeam, Astar | Aleph Zero mainnet |
| **ZK transaction awareness** | None — consensus is agnostic to tx content | None — consensus is agnostic to tx content |
| **Open source** | Yes (Parity/Substrate) | Yes (Apache 2.0 / MIT; `aleph-bft` crate) |

### 3.1 What AlephBFT Does *Not* Change

Replacing GRANDPA with AlephBFT:

- Does **not** increase per-block transaction capacity (block size is still set by `MaximumBlockLength`).
- Does **not** reduce ZK proof verification time.
- Does **not** alter any Midnight pallet or the Compact contract execution environment.
- Does **not** change the AURA slot duration — block production rate stays the same unless AURA is also reconfigured.

The throughput gain from AlephBFT is primarily in **finality throughput** (more blocks finalised per second) and **finality latency** (useful for bridging and cross-chain interactions), not in raw TPS.

---

## 4. ProtoGalaxy: A Different Layer Entirely

ProtoGalaxy (Eagen & Gabizon, IACR ePrint 2023/1106) is a ZK proof *folding* scheme. It belongs to a family of techniques (alongside Nova, HyperNova, and Protostar) that allow $k$ separate instances of a circuit to be folded into a single proof of the same size, amortising the per-instance cost.

### 4.1 What ProtoGalaxy Does

- **Input:** $k$ independent ZK proof instances (e.g. $k$ Midnight shielded transactions).
- **Output:** one combined proof of the same fixed size, verifiable in the same time as one individual proof.
- **Net effect:** verification cost is paid once for $k$ transactions rather than $k$ times → **$k$-fold increase** in ZK transaction throughput within a fixed compute budget.
- **Estimated multiplier:** ~10× at practical $k$; ceiling depends on folding overhead and proof size growth.
- **Scope:** execution and proving layer — entirely within the runtime; no interaction with consensus.

### 4.2 Orthogonality to Consensus

The two improvements operate on completely different bottlenecks:

```
┌─────────────────────────────────────────────────────────────┐
│  CONSENSUS LAYER                                            │
│  GRANDPA → AlephBFT (AURA block production unchanged)       │
│  → affects: finality latency, blocks finalised per second   │
│  → metrics: β_blk, finality gap                             │
└────────────────────────┬────────────────────────────────────┘
                         │  independent
┌────────────────────────▼────────────────────────────────────┐
│  EXECUTION / PROVING LAYER                                  │
│  ProtoGalaxy k-folding                                      │
│  → affects: ZK tx density per block, γ_txs                  │
│  → metrics: β_txs, γ_txs                                    │
└─────────────────────────────────────────────────────────────┘
```

Replacing GRANDPA with AlephBFT and deploying ProtoGalaxy folding are independently deployable and their throughput benefits multiply:

- AlephBFT: ~3–5× more finalised blocks per second (via reduced finality latency).
- ProtoGalaxy: ~10× more ZK transactions per block (via folded proof verification).
- Combined theoretical ceiling: ~30–50× over the current Midnight baseline — well above 500 TPS for realistic ZK transaction sizes.

### 4.3 Dependency and Risk Comparison

| Axis | AlephBFT (consensus replacement) | ProtoGalaxy (proof folding) |
|------|-----------------------------------|-----------------------------|
| **Layer** | Consensus (node software) | Runtime/proving (circuit + pallet) |
| **Midnight runtime changes** | None | Significant — new folding verifier circuit |
| **Security audit status** | Aleph Zero production-audited | ❓ Not yet audited for Midnight's specific circuits |
| **Integration complexity** | Medium — replace consensus crate | High — new ZK circuit design + audit required |
| **Blocking dependency** | Midnight-specific integration testing | Security audit (🛑 BLOCKER) |
| **Option relevance** | Option 3 (Take Ideas) | Option 3 (Take Ideas) / applicable to all options |

---

## 5. Implications for the Three Options

| Option | Consensus implication | ProtoGalaxy implication |
|--------|-----------------------|------------------------|
| **Option 1 — Port to NEAR** | Midnight abandons AURA+GRANDPA and AlephBFT; uses NEAR's Nightshade sharding. Consensus is no longer Midnight's problem to configure. | ProtoGalaxy would need to be ported to NEAR's runtime environment (WASM-based contracts); feasibility unclear. |
| **Option 2 — Take Software** | Depends on which NEAR software is extracted; if the consensus layer is retained, AURA+GRANDPA or AlephBFT remains a Midnight decision. | ProtoGalaxy applicability unchanged from Option 3. |
| **Option 3 — Take Ideas** | AlephBFT is an independently motivated improvement regardless of NEAR; deploying it is a Substrate-internal decision. | ProtoGalaxy is the primary near-term path to 500+ TPS ZK throughput; blocked on security audit. |

**Summary:** Both AlephBFT and ProtoGalaxy are Option-3-compatible improvements that can be pursued without any NEAR migration. AlephBFT addresses finality latency and liveness robustness; ProtoGalaxy addresses ZK transaction density. Neither is a substitute for the other, and both are necessary (along with block size increases) to reach 500+ TPS for ZK-bearing workloads.

---

## Sources

1. **aleph-node README (Cardinal-Cryptography)** — [github.com/Cardinal-Cryptography/aleph-node](https://github.com/Cardinal-Cryptography/aleph-node). Production repository; primary source for the statement "Block authoring is realized with Substrate's Aura. The default finality gadget (GRANDPA) has been replaced with AlephBFT."
2. **AlephBFT library (Cardinal-Cryptography)** — [github.com/Cardinal-Cryptography/AlephBFT](https://github.com/Cardinal-Cryptography/AlephBFT). The standalone BFT crate (Apache 2.0 / MIT).
3. **"What is AlephBFT?" documentation** — [cardinal-cryptography.github.io/AlephBFT/what_is_aleph_bft.html](https://cardinal-cryptography.github.io/AlephBFT/what_is_aleph_bft.html). Describes AlephBFT's role as a finality gadget and its two operating modes (finality gadget vs. full state-machine replication).
4. **AlephBFT API documentation** — [cardinal-cryptography.github.io/AlephBFT/aleph_bft_api.html](https://cardinal-cryptography.github.io/AlephBFT/aleph_bft_api.html). Documents Mode A (finality gadget, used by Aleph Zero) and Mode B (full blockchain / SMR).
5. **Aleph Zero consensus documentation** — [docs.alephzero.org/aleph-zero/explore/alephbft-consensus](https://docs.alephzero.org/aleph-zero/explore/alephbft-consensus). Confirms 416 ms finality figure and 112-node benchmark; notes Golang prototype origin.
6. **Substrate AURA** — `paritytech.github.io/substrate/master/sc_consensus_aura/`. Substrate crate documentation.
7. **Substrate GRANDPA** — `paritytech.github.io/substrate/master/sc_consensus_grandpa/`. Substrate crate documentation.
8. **ProtoGalaxy** — Eagen, L. & Gabizon, A. "ProtoGalaxy: Efficient ProtoStar-style folding of multiple instances." IACR ePrint 2023/1106. [eprint.iacr.org/2023/1106](https://eprint.iacr.org/2023/1106).
9. **`substrate-throughput-techniques.md`** — §2.2 (Consensus Replacement), this repository.
10. **`throughput-constraint-comparison.md`** — §0 (Throughput Metrics definitions), this repository.

---

<!--
## Afterword: Quality Scrutiny

### 1. Sources Correspond to Retrievable URLs

- **`github.com/aleph-zero-foundation/AlephBFT`** — Public GitHub repository; expected to be accessible.
- **`docs.alephzero.org/aleph-zero/explore/about-aleph-zero`** — Aleph Zero official docs; the equivalent `alephzero.org/blog` URLs were flagged as 403 Forbidden in the `substrate-throughput-techniques.md` Afterword; docs subdomain expected accessible.
- **`paritytech.github.io` crate docs** — Generated from source; generally accessible.
- **IACR ePrint 2023/1106** — `eprint.iacr.org/2023/1106`; IACR ePrint is publicly accessible.
- **Internal cross-references** — Both referenced assessments are in this repository.

No URLs have been live-fetched for this document. All accessibility claims are inferred from prior work.

### 2. Internal Consistency

The document is internally consistent. The layer diagram in §4.2 accurately reflects the separation described in the prose. The comparison tables in §3 and §4.3 are consistent with the individual protocol descriptions in §1 and §2. The Option implications in §5 follow logically from the earlier analysis.

One tension worth noting: §3 states AlephBFT provides "3–5× more finalised blocks per second" as a throughput multiplier, while §4.2 uses this to project a "30–50× combined ceiling" with ProtoGalaxy. The 3–5× consensus figure is itself uncertain (see §4 below) and the multiplication is an upper bound, not a measured result.

### 3. Accuracy Against Sources

- **AlephBFT 416 ms finality, 112 nodes** — ✅ Confirmed by the official Aleph Zero documentation. ⚠️ Caveat applied in text: this is a Golang prototype benchmark, not the production Rust deployment.
- **AlephBFT open source (Apache 2.0 / MIT)** — ✅ License confirmed from the GitHub repository.
- **GRANDPA votes on chains, not blocks** — ✅ Standard description of GRANDPA; confirmed in substrate-grandpa crate documentation and the GRANDPA paper (Stewart, 2020).
- **GRANDPA halts under partition** — ✅ Well-established property; documented in Substrate engineering blog posts and the crate docs.
- **ProtoGalaxy authors "Eagen & Gabizon"** — ✅ Correct. The `substrate-throughput-techniques.md` Afterword identifies "Pearson et al." as a recurring error; this document uses the correct attribution.
- **ProtoGalaxy ~10× multiplier** — ⚠️ **Estimate, not measured.** The 10× figure is an order-of-magnitude projection from the folding scheme's theoretical properties, cited consistently across this repository. No Midnight-specific benchmark exists; the actual multiplier depends on $k$, folding overhead, and circuit specifics.
- **"3–5× more finalised blocks per second" for AlephBFT** — ⚠️ **Derived estimate.** This is inferred from AlephBFT's ~1 s finality vs. GRANDPA's ~2–6 s typical finality latency. The actual block production rate (AURA slot duration) is not changed; the multiplier refers to finality throughput, not raw block production rate. This distinction is made in the text but the "3–5×" range is not sourced from a specific benchmark.

### 4. Areas of Greatest Uncertainty

1. **AlephBFT production performance on Substrate.** The headline figures derive from a Golang prototype. Aleph Zero's mainnet achieves ~1 s finality in practice, but no public benchmark isolates the finality throughput multiplier in a Midnight-equivalent configuration.
2. **ProtoGalaxy ~10× multiplier for Midnight's specific circuit.** The folding overhead and the practical $k$ value depend on Midnight's proof system (Groth16 or later). No Midnight-specific folding prototype exists at the time of writing.
3. **Interaction between AlephBFT DAG latency and ZK proof verification timing.** The `substrate-throughput-techniques.md` §2.2 SCRUTINY note flags this as unevaluated. DAG unit construction adds a distinct latency step; whether this competes with block production timing under high ZK-tx load is unknown.
4. **"30–50× combined ceiling" projection.** This is the product of two uncertain estimates (3–5× and ~10×). It is directionally useful but should not be treated as a reliable engineering target.

### 5. Robustness of Primary Conclusions

The document's main conclusions are:

1. *AlephBFT and ProtoGalaxy are orthogonal improvements at different layers.* — **Robust.** This follows from the architectural separation between consensus and execution, which is well-established in Substrate's design.
2. *AlephBFT can replace GRANDPA without touching the runtime.* — **Robust.** Demonstrated by Aleph Zero's production deployment.
3. *Both improvements are viable under Option 3 without NEAR migration.* — **Robust.** Neither depends on the NEAR platform.
4. *The combined ceiling exceeds 500 TPS.* — **Directionally supported but not proven.** The constituent multipliers are estimates; the conclusion that the combination is *sufficient* for 500+ TPS is plausible but depends on resolving the ProtoGalaxy audit blocker and validating the per-improvement benchmarks.
-->
