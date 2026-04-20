# 👱🤖 Substrate Throughput Techniques: Survey and Applicability to Midnight

**Scope:** This document surveys throughput characteristics of high-performance Substrate-based blockchains and evaluates which pallets, configuration levers, and architectural techniques are applicable to Midnight. It directly complements [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md) by asking the narrower question: *within the Substrate ecosystem, what has already been tried, and what does Midnight need to do to reach 500+ TPS?*

> [!NOTE]
>
> ❓🤖**SCRUTINY — estimates require verification.** TPS figures from third-party benchmarks vary widely depending on transaction type, validator hardware, and network conditions. All numbers below should be treated as order-of-magnitude indicators. Distinguish carefully between (a) simple-token-transfer TPS, (b) smart-contract-call TPS, and (c) ZK-proof-bearing transaction TPS — these can differ by 10–100×.

---

## 1. High-Throughput Substrate Chains: Measured TPS

The table below covers chains that use Substrate (or a Substrate fork) and are noteworthy for throughput. All figures are for simple token transfers unless noted.

| Chain | Consensus | TPS (measured / claimed) | Block time | Transaction type | Notes |
|---|---|---|---|---|---|
| **Aleph Zero** | AlephBFT (DAG + BFT) | ~89,600 TPS (2021 test, 112 nodes) | ~0.4 s finality | Simple transfers | DAG allows concurrent block units; finality in <1 s; independent L1 (not a Polkadot parachain) |
| **Polkadot relay chain + parachains** | BABE + GRANDPA + Parachain consensus | 143,343 TPS aggregate ("The Spammening" 2024, ~23% of cores) | ~6 s relay; ~6 s parachain (async backing) | Simple transfers across parachains | Aggregate across many parachains; single parachain ~1,000–2,000 TPS simple transfers |
| **Acala** | AURA + GRANDPA (as parachain) | ~200 TPS | ~12 s (relay-chain bound, pre-async-backing) | DeFi ops | Single Polkadot parachain; throughput bottlenecked by relay chain slot time before async backing |
| **Moonbeam** | AURA + GRANDPA (as parachain) | ~30–60 TPS max measured; ~0.7 TPS average on mainnet | ~12 s / ~6 s (async backing) | EVM calls | EVM compatibility imposes high per-transaction weight; throughput deliberately traded for Ethereum compatibility |
| **Astar** | AURA + GRANDPA (as parachain) | ~1,000 TPS claimed for WASM contracts; mainnet ~100–500 TPS | ~6 s (async backing) | EVM + WASM contracts | Supports both EVM and WASM pallets; ZK Dapp support planned via dApp staking |

**Critical observation on Aleph Zero:** its 89,600 TPS figure was for simple transfers in a controlled test; real-world ZK-bearing transactions would be far lower. Aleph Zero's privacy protocol (LIMINAL, using Groth16 proofs) has been benchmarked separately and achieves throughput similar to Zcash-class systems — roughly 10–50 TPS for shielded transactions on current hardware. The headline TPS and the ZK-transaction TPS are different workloads on the same chain.

**No existing high-throughput Substrate chain demonstrates >50 TPS for ZK-proof-bearing transactions in a per-transaction independent-verification model.** ZK-rollups (Starknet, zkSync Era) achieve higher sequencer throughput by aggregating many transactions under a single proof — the batch/fold pattern that ProtoGalaxy provides for Midnight. The ZK verification cost (~3–10 ms per proof, independent of the chain) creates an approximate ceiling of 100–300 ZK TPS per CPU core for the per-transaction model regardless of consensus or block structure.

---

## 2. Throughput Levers Available in Substrate

### 2.1 Block Parameter Tuning (Configuration Change, No Code)

Two runtime constants directly control $\beta_\text{txs}$:

| Parameter | Midnight current | Effect of increase | Risk |
|---|---|---|---|
| `MaximumBlockLength` | 200 KB | Linear $\beta_\text{txs}$ increase up to propagation ceiling | Block diffusion time grows; see §3.2 of [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md) |
| AURA slot duration | 6 s | Shorter slot → more blocks/second → proportional TPS increase | Shorter slots tighten the diffusion window; network propagation must complete within the slot |

These are the fastest levers. A 25× block size increase (→ 5 MB) combined with a 3× slot reduction (6 s → 2 s) would multiply $\beta_\text{txs}$ by ~75× (→ ~2.5 MB/s, ~250 TPS for 10 KB ZK transactions) before either the proof-verification $\gamma_\text{txs}$ ceiling or block propagation latency bites. In practice, these cannot both be pushed to their limits simultaneously: larger blocks need more diffusion time, which sets a floor on viable slot duration.

### 2.2 Consensus Replacement

**AURA + GRANDPA (current Midnight):** AURA provides a fixed-slot single-leader block production; GRANDPA provides finality. The combination produces one block per slot (~6 s on Midnight mainnet) and finalises ~2–3 blocks behind the tip. The slot duration is a hard TPS multiplier.

**AlephBFT (used by Aleph Zero):** A DAG-based BFT protocol with a rotating committee. Key properties:
- Subsecond finality (~0.4 s in 112-node tests)
- Concurrent block "unit" production — multiple validators produce units simultaneously, which are later totally ordered
- Byzantine fault tolerance for <1/3 stake held by adversaries
- Open source (Apache 2.0 / MIT): the `aleph-bft` crate is a standalone Rust library that can be integrated into a Substrate node without rewriting the runtime

❓🤖 **SCRUTINY** — AlephBFT integration with Midnight's proof verification runtime has not been evaluated. The DAG ordering step adds a distinct latency component not present in AURA. Whether this competes with or complements ZK verification timing requires analysis.

Replacing AURA + GRANDPA with AlephBFT would not change any Midnight pallet or the ZK proof verification path. It would:
- Reduce effective block time (→ 3–5× more blocks per second)
- Reduce finality latency significantly (useful for bridges and cross-chain interactions)
- Require replacing the consensus crate, not the runtime modules

**BABE (Substrate built-in):** BABE uses VRF-based slot assignment, which adds randomness but does not improve throughput over AURA for Midnight's use case. It is not a meaningful upgrade path for TPS.

### 2.3 Polkadot Parachain Integration (Cumulus)

Converting Midnight from a standalone Substrate chain to a **Polkadot parachain** via the Cumulus framework is the most significant within-ecosystem horizontal scaling option.

**What Cumulus provides:**
- **Async Backing** (deployed on Polkadot in 2024): allows a parachain to produce a block every **6 seconds** (vs. ~12 s previously) — a 2× throughput multiplier on $\beta_\text{txs}$ alone
- **Elastic Scaling** (in deployment): allows a parachain to acquire multiple relay-chain "cores", producing proportionally more blocks per relay-chain slot — a further 2–10× multiplier depending on coretime purchased
- **Shared security**: validators from the Polkadot relay chain validate parachain state transitions; Midnight would not need its own independent validator set for finality
- **XCM**: standardised cross-chain messaging; bridges to other Polkadot parachains (Acala, Moonbeam, etc.) would use a well-defined protocol

**Combined throughput estimate for Midnight as a parachain:** async backing (6 s blocks) + 5 MB block size + 10× proof folding = ❓🤖 ~750–1,000 TPS for 10 KB ZK transactions, comfortably above the 500 TPS target. This would not require changes to Midnight's ZK circuits, pallet structure, or fee model — only the consensus and finality layer changes.

**Migration cost:** significant. Becoming a Polkadot parachain requires:
- Integrating the Cumulus framework (new block authoring and finality pallets)
- Purchasing relay-chain coretime (ongoing operational cost in DOT)
- Redesigning the bridge between Midnight and Cardano/Ethereum: the current Cardano bridge (cNIGHT ↔ mNIGHT) would need to cross the Polkadot relay chain boundary
- Network migration: existing full nodes and light clients would need to understand the new finality source

This is "Option 3: Take Ideas from NEAR" territory — it is a Polkadot-flavoured form of Option 1 (re-platforming to a different ecosystem) rather than a pure Substrate-internal change.

### 2.4 Parallel Extrinsic Execution

**Status: not available in Substrate.** The Substrate `frame-executive` module processes extrinsics sequentially inside a single-threaded WASM runtime. This is the primary constraint identified in [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md) §2.9.

A [GitHub discussion](https://github.com/paritytech/substrate/discussions/11253) from 2022 explored the design space. The proposed approach — a thread-pool executor with upfront read-write set declaration (similar to Solana's account model) — was deprioritised in favour of parachain-based horizontal scaling. No pallet or crate implements this as of mid-2025.

**Partial path for Midnight:** because Midnight's contract execution is entirely client-side (validators only verify proofs), the relevant parallelism is **proof verification across independent transactions**, not general transaction execution. This is a narrower problem:

- A custom Substrate **host function** `ext_batch_verify_plonk(proofs: Vec<PlonkProof>) -> Vec<bool>` could verify multiple proofs in parallel using `rayon` thread pools or GPU offloading — outside the WASM sandbox
- This would require changes to the Substrate node implementation (Rust code), not to the WASM runtime or any pallet
- The WASM runtime would call a single batched host function and await a single result; no changes to the sequential execution model are needed from the runtime's perspective

This is architecturally cleaner for Midnight than for general Substrate chains, precisely because the expensive per-transaction work (proof verification) is already isolated in a host function.

### 2.5 ZK Proof Verification in the Substrate Ecosystem

Several ZK verification implementations exist in the Substrate ecosystem:

| Implementation | Form | Proof system | Where it runs | Compared to Midnight |
|---|---|---|---|---|
| **Midnight's existing verifier** | Native Substrate host function (`proof_verify` in `cost-model.md`) | Plonk/KZG on BLS12-381 | Substrate host side (native Rust, outside WASM sandbox) | **Current baseline** |
| **pallet-plonk** (Astar) | Substrate runtime pallet | PLONK on BLS12-381 | WASM sandbox (inside runtime) | Slower than Midnight's host function; ZK verify in WASM incurs interpreter/JIT overhead on top of the cryptographic cost |
| **zkVerify** (`pallet-fflonk-verifier`, etc.) | Standalone Substrate chain + modular verifier pallets | fflonk, Groth16, PLONK, UltraPlonk, Risc0 | WASM sandbox per pallet | Designed as a proof-verification-as-a-service chain, not embedded in a L1 runtime |
| **Batch host function (proposed)** | Native Substrate host function (not yet implemented) | Any | Substrate host side, multi-threaded | Would improve Midnight's throughput ceiling |

🏛️ **ADR implication:** Midnight's existing architecture — ZK proof verification as a native host function rather than a pallet — is already the optimal Substrate approach. Adding an external ZK pallet (pallet-plonk, zkVerify-style) would be slower, not faster. The only improvement available within Substrate is upgrading the host function itself: batching, GPU offloading, or parallelism via rayon.

---

## 3. Sharding in Substrate

**There is no Substrate pallet or framework for sharding a single Substrate chain.** This finding is unambiguous across all available documentation and the Substrate GitHub issue tracker.

The Substrate ecosystem's answer to horizontal scaling is the **Polkadot parachain model**: multiple independent Substrate chains (each with its own state and block production) share security through the relay chain. This is application-level partitioning (different chains for different user populations or use cases), not protocol-level sharding within a single chain.

For Midnight specifically, the following parachain-based partitioning patterns have analogues in the Polkadot ecosystem:

| Pattern | Polkadot mechanism | Midnight implication |
|---|---|---|
| **User-space sharding** | Multiple Midnight parachain instances with XCM bridges between them | Each instance handles a subset of users/contracts; cross-instance calls use XCM; complex user experience |
| **L2 rollup** | Rollup chain posts state commitments to Midnight as L1 | Paima/Nightstream pattern; Midnight stays as L1 settlement; L2 achieves high TPS independently (see [paima-on-midnight.md](paima-on-midnight.md)) |
| **Elastic Scaling** | Single Midnight parachain buys multiple relay-chain cores | Single logical chain, multiple parallel block streams; transparent to users; requires Cumulus integration |

The L2 rollup pattern is the closest Substrate-native analogue to NEAR's native sharding. It decouples L2 throughput from L1 block size and does not require any changes to Midnight's runtime pallets.

---

## 4. Applicability to Midnight

The table below scores each technique against three criteria: **impact on $\beta_\text{txs}$** (does it raise the 500+ TPS ceiling?), **compatibility with Midnight's ZK architecture**, and **integration cost** (relative effort).

| Technique | Impact on $\beta_\text{txs}$ | ZK-compatible? | Integration cost | Verdict |
|---|---|---|---|---|
| **Block size increase** (parameter) | ~~3–25× | Yes | Trivial (runtime constant) | Immediate win; already identified in assessment |
| **Shorter AURA slot time** (parameter) | ~~2–3× | Yes | Low (parameter + network analysis) | Multiplies the block-size gain; should be evaluated jointly |
| **ZK proof aggregation** (ProtoGalaxy) | ~10× on compute ceiling | Yes (ZK-native) | High (circuit changes + aggregator deployment) | Identified in existing assessment; high ROI but non-trivial |
| **Batch proof verification host function** | ~N× on compute ceiling (N = core count) | Yes (ZK-native, native Rust only) | Medium (node implementation, no runtime pallet changes) | Architecturally clean for Midnight; not yet implemented anywhere in Substrate ecosystem |
| **AlephBFT consensus** | ~3–5× (slot time reduction) | Yes (consensus-layer only) | Medium–High (replace AURA + GRANDPA; no runtime changes needed) | Strong combination with block size increase; open-source code available; finality latency benefit independent of TPS |
| **Polkadot parachain (Cumulus + Async Backing + Elastic Scaling)** | ~10–30× (combined) | Yes (runtime unchanged) | High (ecosystem commitment: coretime cost, bridge migration, finality redesign) | Most powerful single lever within Substrate; effectively "Option 3 via Polkadot" for the NEARFall framing |
| **L2 rollup (Paima/Nightstream)** | L1-decoupled | Yes (settlement only) | High (separate chain, sequencer, bridge) | Identified in existing assessment; orthogonal to on-chain TPS |
| **Parallel extrinsic execution pallet** | Potentially large | N/A | N/A (does not exist) | Not available; not expected in near term |
| **Substrate chain sharding pallet** | Potentially large | N/A | N/A (does not exist) | Not available |
| **External ZK pallet (pallet-plonk, zkVerify)** | Negative (slower) | Inferior to current | — | Do not adopt; Midnight's native host function is faster |

### 4.1 The Fastest Path to 500+ TPS Within Current Architecture

Combining the two no-code-change levers:
- Block size 200 KB → 5 MB (25×)
- AURA slot time 6 s → 2 s (3×)

yields $\beta_\text{txs} \approx 75 \times 33\ \text{KB/s} \approx 2.5\ \text{MB/s}$, corresponding to **~250 TPS** for 10 KB ZK transactions. The $\gamma_\text{txs}$ ceiling (§2.2 of [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md)) then becomes the binding constraint at ~49 TPS per proof (without DUST), which means **10× proof folding is required alongside the parameter changes** to avoid the $\gamma_\text{txs}$ ceiling becoming binding before 500 TPS.

The combined package — 5 MB blocks + 2 s slots + 10× ProtoGalaxy folding — would yield:
- $\beta_\text{txs} \approx 2.5\ \text{MB/s}$, ceiling at **~250 TPS** for 10 KB transactions
- $\gamma_\text{txs} \approx \text{TPS} \times 0.343\ \text{ms/tx} \approx 86\ \text{ms/s}$ at 250 TPS (well within the ~500 ms/s slot budget at 2 s slots)

❓🤖 **SCRUTINY** — the 2 s slot time assumes block propagation (diffusion of a 5 MB block) completes comfortably within the slot on a real validator network. At 100 Mbps inter-validator bandwidth, 5 MB transmission takes ~400 ms; with 3 gossip hops × 50 ms latency = ~150 ms additional. Total diffusion estimate: ~550 ms — over 25% of a 2 s slot. A 3 s slot may be safer than 2 s for 5 MB blocks. Further analysis against §3.2 of [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md) is needed.

### 4.2 The Boundary of Pallet-Addressable Changes

The honest answer to "can we add/switch a pallet to get 500 TPS?" is **no** — not as a single pallet addition. The binding constraints are:

1. The block byte budget (addressed by a runtime constant, not a pallet)
2. The single-threaded sequential execution model (no pallet available; requires either Cumulus elastic scaling or a native host function extension)
3. ZK proof verification throughput (addressed by proof aggregation in circuits, not a pallet)

The one near-term pallet-adjacent change worth exploring is upgrading the ZK proof verification **host function** to support batched parallel verification. This would be a change to the Substrate node (native Rust), not the WASM runtime, and could unlock multi-core proof verification without any change to pallet interfaces or the existing proof system.

### 4.3 AlephBFT as a Near-Term Consensus Upgrade

Of the higher-integration options, AlephBFT stands out because it:
- Is a **pure consensus-layer replacement** — the runtime, pallets, ZK circuits, ZSwap, and DUST logic are entirely unchanged
- Provides subsecond finality, which is independently valuable for the cNIGHT ↔ mNIGHT bridge latency
- Has production-validated open-source code (Apache 2.0) from a privacy-focused chain (Aleph Zero uses shielded pools via Groth16 proofs)
- Does not require joining the Polkadot ecosystem or purchasing coretime

🧪 **HYPOTHESIS**: Replacing AURA+GRANDPA with AlephBFT and simultaneously increasing the block size to 5 MB would achieve ~250 TPS with ~1 s finality — substantially improving both throughput and user experience without changes to any Midnight-specific pallet or ZK circuit. Validating this would require integrating the `aleph-bft` crate into a Midnight test node and benchmarking block diffusion at 5 MB block sizes.

---

## 5. Liveness and Security Risks of Throughput Techniques

Each lever in §4 introduces failure modes beyond the simple question of whether throughput increases. This section catalogues the liveness and safety risks for the techniques most directly applicable to Midnight.

**Definitions used here:**
- **Liveness risk**: a condition under which valid transactions fail to be included in blocks in a timely way — empty slots, stalled chains, indefinitely queued transactions.
- **Safety risk**: a condition under which an invalid state transition could be accepted as final — a forged proof passes verification, an equivocating block is finalised, or a protocol bug is exploitable.
- **Centralisation pressure**: conditions that make it increasingly advantageous or necessary to be a well-resourced validator, eroding the decentralisation assumption that underpins both safety and censorship resistance.

### 5.1 Block Size Increase

**Liveness — block diffusion coupling.** $\Delta_\text{diff}$ grows approximately as:

$$\Delta_\text{diff} \approx h \cdot \left(\frac{B_\text{block}}{W} + \ell\right)$$

where $h$ is the gossip hop count, $W$ is inter-validator bandwidth, and $\ell$ is per-hop latency. For a global Midnight validator set (assume $h = 3$, $W = 100\ \text{Mbps}$, $\ell = 100\ \text{ms}$):

| Block size | Transmission time | Total $\Delta_\text{diff}$ est. | At 6 s slot | At 2 s slot |
|---|---|---|---|---|
| 200 KB (current) | ~16 ms | ~316 ms | 5% of slot | 16% of slot |
| 1 MB | ~80 ms | ~380 ms | 6% of slot | 19% of slot |
| 5 MB | ~400 ms | ~700 ms | 12% of slot | 35% of slot |
| 10 MB | ~800 ms | ~1,100 ms | 18% of slot | 55% of slot |

❓🤖 **SCRUTINY** — these are rough order-of-magnitude estimates. The actual diffusion time depends on the specific Midnight validator topology, connection quality, and gossip fan-out. Empirical measurement on the live network is required before committing to any specific parameter combination.

Once $\Delta_\text{diff}$ exceeds the slot duration, validators cannot verify a block before the next producer's slot begins. In AURA, the next producer will either build on an unverified tip (accepting a possible invalid block) or skip the slot (creating an empty block and halving instantaneous throughput). Sustained diffusion failures produce a cascade of empty slots, compressing effective $\beta_\text{txs}$ well below the theoretical ceiling. **A 5 MB block at a 6 s slot is likely safe; at a 2 s slot it is marginal and requires network measurement before deployment.**

**Liveness — bandwidth heterogeneity.** Validators with below-median bandwidth will consistently receive blocks late. In AURA's single-leader model this translates directly to forks: the slow validator produces a competing block on a stale tip, contributing to a higher orphan rate. This penalises slow validators economically and creates selection pressure for well-connected nodes.

**Safety — data availability.** Substrate's full-node model requires every validator to download the entire block before verifying it. There is no erasure-coding scheme (unlike NEAR's state witness distribution or Polkadot's availability cores) to allow partial verification. A validator that has not received a block cannot vote on it in GRANDPA, delaying finalisation. A block that is finalized by the first-to-receive validators before laggards catch up is safe only if the first-to-receive set already represents >2/3 of stake — this is guaranteed by GRANDPA's requirements but implies the finality lag (in blocks) grows with diffusion variance.

**Safety — DoS amplification.** Larger maximum block size enlarges the attack surface for transaction-stuffing DoS: an adversary fills blocks with cheap-to-submit but expensive-to-propagate data. Midnight's weight-based fee model charges $\beta_\text{txs}$ bytes and proof-verification compute, which significantly reduces this risk compared to chains without ZK fees — but the propagation bandwidth cost is not yet directly metered. A validator with 10 Mbps upstream bandwidth faces roughly 5× the propagation cost of one with 50 Mbps, and neither is charged for this asymmetry.

**Centralisation pressure.** Both effects above — bandwidth heterogeneity and DoS amplification — push toward a validator set dominated by data-centre nodes with high-bandwidth symmetric connections. This is acceptable as an engineering trade-off but should be made explicitly rather than discovered after deployment.

### 5.2 Slot Time Reduction

**Liveness — the diffusion window narrows.** Reducing AURA slot time from 6 s to 2 s does not change $\Delta_\text{diff}$; it reduces the budget within which diffusion must complete. For a fixed block size, the fraction of the slot consumed by propagation triples. This is the critical coupling identified in §3.2 of [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md): $\Delta_\text{diff}(B_\text{block})$ and $\Delta_\text{slt}$ are not independent design parameters. Reducing slot time without a corresponding reduction in block size tightens the propagation margin; reducing slot time *and* increasing block size simultaneously (as §4.1 proposes) requires that the combined operating point remains safe, which the table in §5.1 shows is borderline at (5 MB, 2 s).

**Liveness — GRANDPA finality lag.** GRANDPA finalises in arrears: it runs a separate BFT vote on the chain tip and converges on a finalised block that may be several blocks behind the production tip. The number of unfinalized blocks in the "uncertainty window" scales approximately with the finality round trip time divided by slot duration. Shorter slots increase the count of unfinalized blocks at any given moment, though wall-clock finalisation latency may not change. For the Cardano bridge (cNIGHT ↔ mNIGHT), which presumably waits for GRANDPA finality before releasing funds, this matters: the bridge operator sees more blocks per second and must process GRANDPA justifications at a higher rate.

**Safety — fork rate.** In any single-leader protocol, the probability of a fork in a given slot is roughly proportional to the fraction of validators who have *not* received the previous block before their slot begins. Shorter slots raise this probability. GRANDPA resolves forks safely (it never finalises two conflicting blocks) but at the cost of temporarily stalling finalisation when forks occur. A high fork rate under load is not a safety failure but it degrades the effective throughput and the reliability of the user-visible confirmation time.

**Safety — nothing-at-stake window.** With 2 s slots, a validator whose block is not immediately propagated has a narrow window during which two competing blocks exist. Honest validators follow the longest chain; malicious validators could attempt to extend both. GRANDPA's finality prevents this from becoming a safety issue, but the brief fork window adds complexity to light-client and bridge implementations that may assume a simpler chain model.

### 5.3 Combined Block Size + Slot Time (The §4.1 Package)

The simultaneous application of both levers produces a compounded risk surface that is not simply the sum of §5.1 and §5.2.

**The safe operating envelope.** A rough necessary condition for liveness is $\Delta_\text{diff}(B_\text{block}) < \alpha \cdot \Delta_\text{slt}$ for some safety fraction $\alpha < 1$ (commonly $\alpha \approx 0.5$–$0.7$ in production Substrate deployments). For the proposed (5 MB, 2 s) operating point with the estimates in §5.1: $\Delta_\text{diff} \approx 700\ \text{ms}$, $\alpha \cdot \Delta_\text{slt} = 0.5 \times 2000\ \text{ms} = 1000\ \text{ms}$. The point is within the envelope but with limited margin. **A (5 MB, 3 s) operating point gives $\Delta_\text{diff}/\Delta_\text{slt} \approx 23\%$, well within the safe zone, and still achieves ~167 TPS (6× current) before proof folding.** This is a more conservative and immediately deployable target.

⚠️ **RISK — bandwidth tail risk.** The estimates above assume median validator bandwidth. Validators at the 10th percentile of bandwidth (perhaps 20–30 Mbps rather than 100 Mbps) would see $\Delta_\text{diff} \approx 2,000$–$3,300\ \text{ms}$ for a 5 MB block — longer than the 2 s slot. Such validators would be systematically excluded from participation, reducing decentralisation and potentially triggering consensus instability if enough stake is held by slow nodes. The validator hardware requirements should be explicitly specified alongside any block size change.

### 5.4 ZK Proof Folding (ProtoGalaxy)

**Liveness — aggregator as a new critical dependency.** ProtoGalaxy folding requires a component that accumulates $k$ transactions, folds their proofs into one, and submits the aggregated transaction to the block producer. This aggregator is a new participant in the transaction lifecycle that does not exist in the current Midnight architecture. Its failure modes are:
- **Aggregator unavailability**: if the aggregator goes offline or is slow, transactions queue indefinitely. A fallback to single-proof submission mode is architecturally necessary but complicates the fee model (the folded proof is cheaper per transaction; the single-proof fallback is not).
- **Batching latency / fill threshold**: if the aggregator waits for $k = 10$ proofs before submitting, low-traffic periods see per-transaction latency increase by up to $k$ times the average inter-transaction interval. A timeout mechanism is needed; setting it correctly is a product decision.
- **Aggregator censorship**: a centralised aggregator can selectively drop transactions from the fold. A decentralised aggregator requires its own incentive and ordering protocol.

**Liveness — circuit-type fragmentation.** ProtoGalaxy folds proofs from the *same* circuit. Midnight uses multiple circuits: one per `ContractCall` circuit type, one for ZSwap offers, one for DUST spends. Proofs from different circuits cannot be naively folded together. In a mixed-transaction block, the achievable fold factor is limited by the count of same-circuit transactions per block. At current ~20 transactions per block with diverse circuit types, the effective fold factor may be well below $k = 10$ in practice.

**Safety — soundness of the folding scheme.** ProtoGalaxy (Eagen & Gabizon, 2023; IACR ePrint 2023/1106) is a recent IVC construction. Its soundness argument reduces to the hardness of the underlying KZG commitment scheme and polynomial IOP security, but the *composition* — folding a batch of separately-submitted Midnight proofs — has not been independently audited in this deployment context. A bug in the folding relation (e.g., in the cross-term computation) could allow an adversary to construct a valid-looking aggregated proof that includes one or more invalid inner proofs.

🛑 **BLOCKER** — before deploying ProtoGalaxy folding in production, a formal security analysis of the specific Midnight circuit compositions that will be folded is required. This is distinct from the soundness of ProtoGalaxy itself.

**Safety — proof size.** The aggregated proof in IVC schemes is not necessarily smaller than individual proofs. Depending on the scheme, the folded proof may be similar in size to a single proof (verification key grows with $k$) or larger, partially offsetting the $\beta_\text{txs}$ gain. This must be measured, not assumed.

### 5.5 Batch Proof Verification (Native Host Function)

**Liveness — thread contention with networking.** Multi-threaded proof verification (e.g., via `rayon`) runs inside the Substrate node process and shares CPU cores with the network stack, the state trie writer, GRANDPA vote processing, and other node operations. Under a full batch of proofs, verification threads can starve networking threads, delaying block propagation to peers. This is a subtle liveness risk: the node finishes verifying the block but broadcasts it late, causing other validators to miss the diffusion window — exactly the failure mode described in §5.1.

Mitigation: reserve a fraction of CPU cores (e.g., one networking thread) as non-preemptable by proof verification. This requires careful threading configuration and reduces the effective parallel verification speedup.

**Safety — batch verification correctness.** KZG-based batch verification uses a randomised multi-proof check: rather than verifying $N$ pairings independently, a single randomised linear combination is checked. This is sound under the same assumptions as individual KZG verification (the $k$-SDH assumption), provided the randomness is not adversarially controlled. If the randomness source is predictable (e.g., derived from block data visible to the submitter), a malicious proof submitter could craft proofs that appear valid in a batch check but are individually invalid. **The randomness for batch verification must be drawn from a source that proof submitters cannot predict at submission time** — e.g., a VRF output computed by the block producer after all transactions are selected.

**Safety — weight accounting.** If the batch host function verifies $N$ proofs at cost $C_\text{batch} < N \times C_\text{single}$, but the runtime weight model charges each proof $C_\text{single}$, the effective compute budget is over-estimated and the block weight ceiling is artificially low. Conversely, if batch efficiency leads to charging $C_\text{batch}/N$ per proof, the weight model must prevent a spam attack where an adversary submits many proofs in a single block to exhaust CPU while paying minimal fees. Weight calibration for the batch function requires a dedicated benchmarking pass.

### 5.6 Summary Risk Table

| Technique | Primary liveness risk | Primary safety risk | Centralisation pressure |
|---|---|---|---|
| **Block size increase** | Diffusion failure at large sizes / short slots; empty slots | DoS amplification; no native erasure coding | High (favours high-bandwidth validators) |
| **Shorter slot time** | Tightened diffusion window; higher fork rate; increased GRANDPA lag | Higher steady-state fork exposure; bridge confirmation complexity | Moderate (faster finality round-trips require low-latency nodes) |
| **(5 MB, 2 s) combined** | Marginal $\Delta_\text{diff}/\Delta_\text{slt}$ ratio; tail validators excluded | Compounded fork + diffusion risks | High — consider (5 MB, 3 s) as safer initial target |
| **ProtoGalaxy folding** | Aggregator as new SPF; batching latency at low load; circuit fragmentation | Folding-relation soundness; independent audit required | Low (aggregator can be decentralised) |
| **Batch proof verification** | Thread contention with networking under full load | Batch randomness must be unpredictable to submitters; weight model re-calibration required | Low (purely internal to the node) |
| **AlephBFT consensus** | DAG round failure if committee members offline; new integration risk | <1/3 adversarial threshold; newer codebase | Moderate (rotating committee, similar to AURA) |

---

## Appendix A: QUIC / UDP Transport as a Network-Layer Throughput Lever

This appendix evaluates whether replacing TCP with QUIC (or enabling it alongside TCP) could reduce block propagation latency for Midnight nodes, and what engineering effort is required to do so.

### A.1 Status in the Substrate Ecosystem

No Substrate-based chain is confirmed using QUIC as a production default transport. The relevant developments are:

**rust-libp2p QUIC (`libp2p-quic` crate):** Went stable in 2023 (v0.9.2), now at v0.13.0 (June 2025), based on the `quinn` crate (RFC 9000, QUIC v1 only). An old Substrate PR (#11514) to wire it into `sc-network` was abandoned before merge and was superseded by the litep2p path.

**litep2p:** Parity's ground-up networking rewrite, libp2p-protocol-compatible but independently implemented. It natively supports TCP, QUIC, WebRTC, and WebSocket. As of `polkadot-sdk stable2503` (March 2025), litep2p is the **default network backend** for all Polkadot SDK nodes, with the previous libp2p backend selectable via `--network-backend libp2p`. The IOG partner-chains project adopted litep2p as its default in v1.8.0. Within litep2p, however, **TCP remains the default transport**; QUIC is opt-in by advertising a `/udp/<port>/quic-v1` listen address.

**NEAR Protocol:** Uses TCP exclusively. Its p2p stack is a custom implementation (not libp2p), using Borsh serialisation over `TcpStream`. The only UDP protocol in NEAR is `discv5` for peer discovery, not data transport.

### A.2 Benefits for Blockchain Gossip

| Property | TCP + Yamux (current Midnight) | QUIC (via litep2p) |
|---|---|---|
| **Head-of-line blocking** | All streams stall on any packet loss — GRANDPA votes, block bodies, and tx gossip share one ordered byte stream | Streams are independent; a lost packet blocks only the affected stream |
| **Handshake latency** | 2.5 RTT (TCP + TLS 1.3) | 1 RTT new connection; 0-RTT resumption for recently-seen peers |
| **Slow start after idle** | `tcp_slow_start_after_idle` resets CWND to ~10 MSS; ~700 ms penalty at 5 MB (see Appendix A of [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md)) | Quinn defaults to 32 MSS initial CWND + pacing; the slow-start-after-idle failure mode does not exist structurally |
| **Stream multiplexing** | Yamux over a single TCP connection; HoL blocking means large block transfer delays GRANDPA messages | Native independent streams; GRANDPA votes on stream A are unaffected by a concurrent 5 MB block download on stream B |
| **NAT traversal / connection migration** | DCUtR hole punching via relay; breaks on IP change | QUIC connection migration via connection IDs; survives IP changes (relevant for mobile light clients) |
| **UDP kernel offload** | Full kernel offload (ACK, congestion control, checksum) | All ACKs/congestion control in user space; slight CPU overhead per packet on low-loss datacenter links |

The slow-start point is particularly relevant to Midnight. The `tcp_slow_start_after_idle = 0` fix documented in Appendix A of [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md) addresses the symptom; QUIC removes the underlying cause structurally.

### A.3 Enabling QUIC for Midnight

Three paths exist in increasing order of engineering effort:

**Path A — Configuration change (zero code, available today).** If Midnight nodes are running `polkadot-sdk stable2503` or later with the litep2p backend active, add a UDP listen address to the node launch arguments:

```
--listen-addr /ip4/0.0.0.0/udp/30333/quic-v1
```

Nodes that do not support QUIC fall back to TCP automatically. No code changes, no circuit changes, no pallet changes. This requires confirming that the Midnight production build uses the litep2p backend (the default since stable2503; verify by checking for absence of `--network-backend libp2p`).

**Path B — Dependency update (low engineering effort).** If Midnight's build predates the litep2p default promotion, update the polkadot-sdk dependency to stable2503 or later, then apply Path A. The main risk is polkadot-sdk API churn; the partner-chains project performs regular polkadot-sdk version bumps as a normal cadence activity.

**Path C — libp2p backend QUIC integration (significant engineering, not recommended).** If the litep2p backend is not usable for Midnight-specific reasons, integrating `libp2p-quic` into `sc-network` directly would require several weeks of engineering and is unnecessary given litep2p's production status.

### A.4 Risks and Caveats

**litep2p authority discovery latency (⚠️ RISK).** As of late 2024, litep2p's authority discovery was observed to be slower than libp2p's — approximately 30 minutes to reach 95% of peers versus ~5 minutes. Parity has been actively addressing this. This issue affects all transports within litep2p (TCP and QUIC equally) and should be verified as resolved in litep2p v0.13.2 (current as of March 2026) before committing to the litep2p backend for production.

**Raw throughput on low-loss datacenter links.** QUIC runs entirely in user space, adding CPU overhead per packet compared to TCP with kernel offload. On well-provisioned datacenter links (low packet loss, symmetric bandwidth), raw throughput improvement over tuned TCP with BBR is modest. The gains are primarily in latency, stream isolation, and the idle-connection reconnect case.

**Production benchmarks are sparse.** Lighthouse (Ethereum consensus client) added QUIC in v4.5.0, reporting "significant gains in latency and throughput," but has not published quantified production statistics. Synthetic benchmarks from the litep2p project show a 2.78× CPU reduction vs libp2p (TCP transport, not QUIC), suggesting the litep2p architecture itself is the larger gain even before QUIC.

### A.5 Bottom Line

🧪 **HYPOTHESIS** — QUIC is not a capability gap for Midnight. litep2p (the default Substrate networking backend since stable2503, also adopted in IOG partner-chains v1.8.0) already supports QUIC as an opt-in transport. Enabling it for Midnight nodes is primarily an operational and configuration decision rather than an engineering project. The highest near-term value is at 5 MB block sizes, where QUIC's larger initial CWND and stream-independence properties directly address the two weakest points of the TCP-tuning approach (slow-start-after-idle and GRANDPA vote delays under concurrent block transfer). This hypothesis requires verification against the actual Midnight production build's polkadot-sdk version and litep2p configuration, and against litep2p v0.13.2 authority discovery performance.

---

## Sources

### General Sources

- [Substrate Transaction Weights and Fees — Polkadot Docs](https://docs.substrate.io/build/tx-weights-fees/)
- [Substrate Consensus Mechanisms — Polkadot Docs](https://docs.substrate.io/learn/consensus/)
- [Parallel Transaction Execution in Substrate (GitHub Discussion #11253)](https://github.com/paritytech/substrate/discussions/11253)
- [Polkadot Elastic Scaling — Polkadot Wiki](https://wiki.polkadot.com/learn/learn-elastic-scaling/)
- [Async Backing: 10× Throughput for Parachains — Polkadot Blog](https://polkadot.com/blog/the-way-to-a-10x-throughput-lift-on-parachains/)
- [Polkadot "The Spammening" Key Metrics](https://polkadot.com/key-metrics/)
- [Moonbeam Performance Metrics — Chainspect](https://chainspect.app/chain/moonbeam)
- [Astar Network Performance — Chainspect](https://chainspect.app/chain/astar)

### Aleph Zero Sources

- [AlephBFT Consensus Documentation — Aleph Zero Docs](https://docs.alephzero.org/aleph-zero/explore/alephbft-consensus)
- [Why We're Building on Substrate — Aleph Zero Blog](https://alephzero.org/blog/substrate-aleph-zero-consensus)
- [Understanding TPS — Aleph Zero Blog](https://alephzero.org/blog/understanding-tps-key-measure-of-blockchain-speed)

### ZK in Substrate Sources

- [ZK-SNARKs with Substrate Part 3: Pallet Implementation — Bright Inventions](https://brightinventions.pl/blog/zk-snarks-with-substrate-part-3-pallet-implementation/)
- [zkVerify GitHub Repository](https://github.com/zkVerify/zkVerify)
- [pallet-plonk Documentation — Astar Network](https://astarnetwork.github.io/plonk/)

### QUIC and Substrate Networking Sources

- [libp2p-quic CHANGELOG — rust-libp2p](https://github.com/libp2p/rust-libp2p/blob/master/transports/quic/CHANGELOG.md)
- [polkadot-sdk QUIC tracking issue #536 — paritytech/polkadot-sdk](https://github.com/paritytech/polkadot-sdk/issues/536)
- [paritytech/litep2p — GitHub](https://github.com/paritytech/litep2p)
- [litep2p Network Backend Updates — Polkadot Forum](https://forum.polkadot.network/t/litep2p-network-backend-updates/9973)
- [QUIC in libp2p — libp2p Docs](https://libp2p.io/docs/quic/)
- [libp2p 2025 Annual Report](https://libp2p.io/reports/annual-reports/2025/)
- [QUIC Networking — Sigma Prime (Lighthouse)](https://blog.sigmaprime.io/quic-networking.html)
- [p2p QUIC — Marten Seemann](https://seemann.io/posts/2024-10-26---p2p-quic/)
- [NEAR network architecture — nearcore docs](https://near.github.io/nearcore/architecture/network)

### Midnight Sources

- [throughput-constraint-comparison.md](throughput-constraint-comparison.md) (this repository)
- [paima-on-midnight.md](paima-on-midnight.md) (this repository)
- [midnight-architecture.md](../background/midnight-architecture.md) (internal)

---

## Afterword: Quality Scrutiny

### 1. Sources Correspond to Retrievable URLs

The document has a well-structured four-section `## Sources` appendix. Spot-checks reveal several dead links and accessibility issues:

- **`polkadot.com/key-metrics/`** (The Spammening) — 🔴 404 Not Found. The data is now canonically at `polkadot.com/spammening/` (also currently 404 when fetched directly) and at the Polkadot Wiki Elastic Scaling page, which was accessible and confirms the Spammening figures.
- **`polkadot.com/blog/the-way-to-a-10x-throughput-lift-on-parachains/`** — 🔴 404 Not Found. The Async Backing claims are verifiable through the Polkadot Wiki (`wiki.polkadot.network/docs/learn-async-backing`) and a press release that remain accessible.
- **`alephzero.org/blog/understanding-tps-key-measure-of-blockchain-speed`** — 🔴 403 Forbidden. Aleph Zero figures are corroborated by the official Aleph Zero docs at `docs.alephzero.org/aleph-zero/explore/about-aleph-zero`.
- **`alephzero.org/blog/substrate-aleph-zero-consensus`** — 🔴 403 Forbidden. Same corroboration path applies.
- **`github.com/paritytech/substrate/discussions/11253`** — ✅ Accessible. Discussion dated April 20, 2022; content confirmed.
- **`astarnetwork.github.io/plonk/`** — ✅ Accessible. pallet-plonk confirmed.
- **Polkadot Forum litep2p thread** — ✅ Accessible at the cited URL.
- **Sigma Prime Lighthouse QUIC post** — ✅ Accessible.

Three of the four most important chain-performance sources are currently unreachable via the cited URLs. The claims they support are still verifiable through alternative URLs, but the cited links should be updated.

### 2. Internal Consistency

The document is internally consistent within its technical argument. The diffusion safety analysis in §5.1–5.3 is tightly self-referential, the risk tables accurately summarise the body text, and the QUIC appendix correctly cross-references the TCP slow-start discussion in `throughput-constraint-comparison.md`.

One notable internal tension: §2.3 states Async Backing produces "a block every **2 seconds**" and bases its combined TPS estimate on that figure. §4.1 independently derives 250 TPS from a 25× block size increase and a 3× slot reduction (6 s → 2 s via AURA tuning). These are actually the same assumption — 2 s blocks — but they are presented as different mechanisms (parachain async backing vs. AURA slot reduction). See §3 for the accuracy issue with the 2 s figure itself.

### 3. Accuracy Against Sources

- **Aleph Zero 89,600 TPS (2021 test, 112 nodes)** — ✅ Figure and node count confirmed by the official Aleph Zero docs. The year 2021 is consistent with the pre-mainnet timeline (mainnet launched November 2021) but cannot be independently verified from the currently-accessible sources. ⚠️ **Caveat missing from the document:** the official Aleph Zero documentation explicitly states this benchmark used a **Golang prototype**, not the production Rust/Substrate implementation, and notes the integration may yield lower figures. This is a material omission for a claim used to anchor AlephBFT's performance argument.

- **"The Spammening" 143,343 TPS (~23% of cores)** — ✅ Figures confirmed exactly (23 out of 100 cores; 143,343 TPS; 6.3 s average block time; 16.5 s finality). ⚠️ **Unacknowledged context:** this test ran on **Kusama** (Polkadot's canary testnet), not on the Polkadot mainnet. The document presents it under the "Polkadot relay chain + parachains" row without mentioning this distinction.

- **Async Backing produces blocks every "2 seconds"** — 🛑 **Inaccurate.** Async Backing, as deployed (May 2024), reduces parachain block time from 12 s to **6 seconds**, not 2 seconds. The Polkadot Wiki states: "parablocks are included every 6 seconds because backing of parablock N+1 and inclusion of parablock N can happen on the same relay chain block." A 2-second block time is a separate roadmap item (GitHub issue paritytech/polkadot-sdk#6495, "Two Fast To Block") that has not been deployed. This affects the stated reasoning in §2.3 (see §4 below for impact on the TPS estimate).

- **AlephBFT subsecond finality (~0.4 s, 112 nodes)** — ✅ Confirmed: 416 ms in the 112-node AWS test. The Golang prototype caveat applies here too (same test).

- **"ProtoGalaxy (Pearson et al., 2023)"** — 🛑 **Wrong author.** The correct authors are **Liam Eagen and Ariel Gabizon** (IACR ePrint 2023/1106). No author named Pearson appears on the paper. The year 2023 is correct; the venue is IACR ePrint (preprint, not a peer-reviewed proceedings). The "Pearson et al." attribution is a recurring error across several documents in this repository and is flagged as unverified in the `midnight-to-near-mapping.md` Afterword.

- **litep2p "default network backend for all Polkadot SDK nodes" in "polkadot-sdk stable2503 (March 2025)"** — ⚠️ **Two inaccuracies.** (a) The stable2503 release was published on **April 8, 2025**, not March 2025 (the "2503" refers to the development sprint cycle, not the release month). (b) The stable2503 release notes state the change was to make litep2p the default backend **in Kusama**, not universally for all Polkadot SDK nodes. The claim overstates the deployment scope.

- **Authority discovery latency: "~30 minutes to reach 95% of peers versus ~5 minutes"** — ⚠️ **Understates the problem.** The GitHub issue (paritytech/polkadot-sdk#7077) is titled "5m vs 1h" — libp2p reaches 95% of peers in ~5 minutes while litep2p required approximately **60 minutes**, not 30. The document's "~30 minutes" figure is inconsistent with the issue tracker.

- **Authority discovery "resolved in litep2p v0.13.2"** — ⚠️ **Inaccurate.** The fix was merged in early 2025 and referenced litep2p v0.9.x at the time of resolution. litep2p v0.13.2 (released March 2, 2026) is a hotfix for a ping protocol panic in debug builds plus WebRTC improvements — it has no connection to the authority discovery fix. The correct statement is that the issue was resolved in the v0.9.x era, not in v0.13.2.

- **libp2p-quic "v0.13.0 (June 2025)"** — ✅ Version confirmed. Date is consistent with the "released ~9 months ago" inference from crates.io metadata (as of March 2026) but is not directly verifiable from the CHANGELOG, which contains no dates.

- **"Lighthouse added QUIC in v4.5.0" / "significant gains" / no "quantified production statistics"** — ✅ All three sub-claims confirmed verbatim from the Sigma Prime blog post.

- **litep2p 2.78× CPU reduction** — ✅ Confirmed figure from the Polkadot Forum post (September 2024, litep2p v0.7 benchmark by the litep2p author). ⚠️ This is a first-party benchmark by Parity's own team, not independently replicated.

- **NEAR "uses TCP exclusively" / "only UDP protocol is discv5"** — TCP confirmed. The discv5/UDP claim is not verifiable from the cited nearcore docs page, which is silent on UDP and peer discovery protocol specifics.

- **Batch KZG randomness safety** — ✅ The technical claim (randomised linear combination, adversarial randomness → valid-batch/invalid-individual) is well-founded. The gnark GHSA-7p92-x423-vwj6 security advisory provides direct real-world validation of this exact attack class.

### 4. Areas of Greatest Uncertainty

1. **Impact of Async Backing block time error on §2.3 TPS estimate.** The document states "async backing (2 s blocks)" but the correct deployed figure is 6 s. With 6 s blocks, 5 MB block size, and 10× proof folding: (5,000 KB / 10 KB) × 10 / 6 s ≈ **833 TPS**. This falls within the document's stated "~750–1,000 TPS" range, so the conclusion that parachain integration reaches 500+ TPS is still supported numerically. However, the stated *reasoning* (2 s blocks as an input to the estimate) is wrong, and the document's table entry "~2 seconds" in §2.3 should be corrected to "~6 seconds." If a future reader re-derives the estimate from the corrected block time they will get ~833 TPS rather than ~2,500 TPS (the value implied by the document's own 2s assumption used elsewhere in §4.1).

2. **Aleph Zero production performance.** The 89,600 TPS and 0.4 s finality figures both come from the same Golang prototype benchmark. Neither figure is confirmed for the production Rust/Substrate deployment. The AlephBFT assessment in §2.2 and §4.3 treats these as applicable production performance targets, which they may not be.

3. **litep2p authority discovery status.** The document treats this as resolved in v0.13.2, but the fix is in v0.9.x and v0.13.2 addresses a different bug. The current state of the authority discovery issue on the live Midnight or partner-chains network is unconfirmed.

4. **ProtoGalaxy author attribution.** "Pearson et al." is wrong and is a repeated error across this repository. The correct citation is Eagen & Gabizon (IACR ePrint 2023/1106). This does not affect any technical conclusion but erodes citation credibility.

5. **NEAR discv5 claim.** The assertion that discv5 is the only UDP protocol in NEAR is not verifiable from the cited source. It may be correct (discv5 is a common peer discovery choice) but is unconfirmed.

### 5. Robustness of Primary Conclusions

1. *No existing Substrate chain demonstrates >50 TPS for ZK-proof-bearing transactions in a per-transaction independent-verification model.* **Robust.** This is consistent with the ZK verification overhead analysis and is not contradicted by any figure in the survey. ZK-rollups (Starknet, zkSync Era) exceed this threshold via batch proof aggregation — the same pattern ProtoGalaxy provides for Midnight — and are not counterexamples to this claim.

2. *Block size increase + shorter slot time is the fastest path to higher TPS within current Midnight architecture.* **Robust.** The mathematical derivation is correct and independent of the Async Backing block time error.

3. *The safe operating point is (5 MB, 3 s) rather than (5 MB, 2 s).* **Robust.** The diffusion analysis is self-consistent and the recommendation is appropriately conservative.

4. *Midnight as a Polkadot parachain (Async Backing + Elastic Scaling) could reach 500+ TPS.* **Mostly robust, with a notation error.** The TPS estimate (~833 TPS for 6 s blocks) still supports the conclusion. However, the document states the block time as 2 s rather than 6 s throughout §2.3. This should be corrected to avoid the stated reasoning contradicting the deployed specification.

5. *Batch proof verification host function is the cleanest throughput path within Substrate.* **Robust.** Correctly identifies that Midnight's client-side execution model isolates the expensive work in a host function — a genuine architectural advantage over general Substrate chains.

6. *QUIC is not a capability gap and is available via litep2p opt-in.* **Mostly robust, with corrections.** The core conclusion is correct (QUIC is available for Midnight nodes via litep2p). The specific claims about stable2503 scope (should be "Kusama, with broader rollout ongoing" rather than "all SDK nodes") and authority discovery resolution (v0.9.x, not v0.13.2) should be corrected, but they do not change the practical recommendation.

7. *AlephBFT is a pure consensus-layer replacement with production-validated code.* **Moderately robust.** The architectural claim (no pallet or ZK circuit changes required) is correct. The performance figures (89,600 TPS, 0.4 s finality) come from a Golang prototype whose production Rust equivalent has not been benchmarked at comparable scale — a caveat the document omits.
