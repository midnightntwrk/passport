# 🤖 Throughput Improvement Hypotheses: Isolated and Combined Quantification

**Scope:** This document separately quantifies the TPS contribution of six identified throughput techniques applicable to Midnight within its existing Substrate architecture, then analyses their combined ceiling. It is a companion to [`substrate-throughput-techniques.md`](substrate-throughput-techniques.md) (which surveys techniques and risks) and [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md) (which defines the metric framework). Where the survey document asks *what techniques exist and what are their risks*, this document asks *how much does each one move the TPS number, in isolation and in combination?*

> [!NOTE]
>
> ❓🤖 **SCRUTINY — all TPS figures are order-of-magnitude estimates.** They are derived from protocol parameter analysis and the numbers established in the companion assessments, not from instrumented benchmarks on a live Midnight network. Treat every figure as a hypothesis to be validated, not a measured result.

---

## 1. Baseline and Binding Ceilings

**Midnight baseline:** ~3 TPS — 200 KB `MaximumBlockLength`, 6 s AURA slot, ~10 KB ZK transaction size (~20 ZK txs per block).

Two independent ceilings govern throughput. Each technique moves one or both:

| Ceiling | Formula | Current value | Binding? |
|---------|---------|---------------|----------|
| **β_txs** (block bytes) | `MaximumBlockLength` ÷ tx size ÷ slot time | **~3.3 TPS** | ✅ Yes — binding constraint |
| **γ_txs** (proof compute) | compute budget ÷ per-tx cost | **~49 TPS** (see note) | ❌ No — slack headroom |

> ❓🤖 **SCRUTINY — γ_txs ceiling derivation.** The ~49 TPS figure is taken from [`substrate-throughput-techniques.md`](substrate-throughput-techniques.md) §4.1, which uses a ~500 ms/s compute budget and an implied ~10 ms per-tx cost (proof verification + ZSwap operations + signature checks, excluding DUST overhead). [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md) §0.5 separately gives ~3.43 ms/tx for the bare Plonk/KZG verifier. The difference (3.43 ms vs ~10 ms) likely reflects overhead from ZSwap and other per-transaction operations that are not captured by the proof verification alone. The DUST overlay (rehearsal model) would add further per-tx cost and lower the ceiling further. These figures require empirical measurement before being used in deployment decisions.

Because β_txs (at 3.3 TPS) is far below γ_txs (at ~49 TPS), the chain is **block-size limited, not compute-limited** at the current operating point. This has a critical implication for how each technique's impact should be assessed: *a technique that raises the compute ceiling has no immediate effect unless block size is also increased.*

---

## 2. Isolated Quantification

Each technique is assessed holding all other parameters at the baseline unless noted.

### 2.1 Block Size Increase (200 KB → 5 MB)

**Mechanism:** Raises β_txs ceiling proportionally. 25× block size increase → 25× β_txs ceiling.

**Direct effect:** β_txs ceiling rises from 3.3 TPS to ~83 TPS. However, at this operating point the γ_txs ceiling (~49 TPS) becomes the new binding constraint before the full β_txs potential is reached.

| Block size | β_txs ceiling | γ_txs ceiling | Effective TPS (min of both) |
|-----------|--------------|--------------|----------------------------|
| 200 KB (current) | 3.3 TPS | ~49 TPS | **3.3 TPS** (β_txs limited) |
| 1 MB | 16.7 TPS | ~49 TPS | **16.7 TPS** (β_txs limited) |
| 5 MB | 83 TPS | ~49 TPS | **~49 TPS** (γ_txs becomes limiting) |
| 5 MB + ProtoGalaxy | 83 TPS | ~490 TPS | **~83 TPS** (β_txs limited again) |

**Isolated TPS: ~49 TPS (~15×).** The block size increase is effective up to ~14.7 MB (the block size at which β_txs = 49 TPS at 6 s slots), beyond which only ProtoGalaxy folding can unlock further gains.

Block diffusion check at 5 MB (100 Mbps, 3 hops): Δ_diff ≈ 700 ms = 12% of 6 s slot. Safe at 6 s; marginal at 2 s slots (35%). See [`substrate-throughput-techniques.md`](substrate-throughput-techniques.md) §5.1 for the full risk analysis.

🧪 **HYPOTHESIS 1:** Increasing `MaximumBlockLength` to 5 MB with no other changes achieves ~49 TPS on a live Midnight node, with compute (not block diffusion) as the new bottleneck. Falsifiable by: (a) measuring actual validator γ_txs under load, (b) measuring Δ_diff for 5 MB blocks on the preprod network.

---

### 2.2 Shorter AURA Slot Time (6 s → 2 s or 3 s)

**Mechanism:** Raises β_txs ceiling in inverse proportion to slot duration. Does not affect γ_txs (compute ms per second is independent of slot duration).

| Slot time | β_txs multiplier | Effective TPS (200 KB blocks) | Propagation risk |
|-----------|-----------------|------------------------------|------------------|
| 6 s (current) | 1× | 3.3 TPS | Baseline |
| 3 s | 2× | 6.7 TPS | Low (200 KB: Δ_diff ≈ 316 ms = 10% of slot) |
| 2 s | 3× | 10 TPS | Low-moderate (200 KB: 16% of slot) |

**Isolated TPS: ~3× ≈ 10 TPS (6 s → 2 s); ~2× ≈ 6.7 TPS (6 s → 3 s).** At current 200 KB blocks, compute headroom is ample (10 TPS × ~10 ms = 100 ms/s, well below 500 ms/s budget).

The slot time and block size levers interact: reducing slot time without reducing block size is safe at 200 KB; reducing slot time *while* increasing block size requires the diffusion analysis in §2.3.

🧪 **HYPOTHESIS 2:** Reducing AURA slot time to 2 s with 200 KB blocks achieves ~10 TPS with no block diffusion or compute issues. The result is a conservative 3× improvement requiring only a configuration change.

---

### 2.3 Combined Block Size + Slot Time (Without ProtoGalaxy)

Combining both parameter changes creates a compounded risk surface. The γ_txs ceiling is still the binding constraint at large block sizes.

| (Block size, Slot time) | β_txs ceiling | Effective TPS | Δ_diff / slot | Safety |
|------------------------|--------------|--------------|--------------|--------|
| (5 MB, 6 s) | 83 TPS | ~49 TPS (γ_txs limited) | 12% | Safe |
| (5 MB, 3 s) | 167 TPS | ~49 TPS (γ_txs limited) | 23% | Safe |
| (5 MB, 2 s) | 250 TPS | ~49 TPS (γ_txs limited) | 35% | Marginal |

Without ProtoGalaxy, the compute ceiling caps both combinations at ~49 TPS regardless of block size or slot time above the ~14.7 MB threshold. Slot time reduction below 6 s provides no throughput benefit once the γ_txs ceiling is reached.

---

### 2.4 TCP Tuning (`tcp_slow_start_after_idle=0`, BBR Congestion Control)

**Mechanism:** The TCP slow-start-after-idle mechanism resets the congestion window (CWND) to ~10 MSS after any idle period on the connection. At 5 MB blocks this causes a ~700 ms propagation penalty on the first block of each burst — equivalent to a full lost slot at 2 s. `tcp_slow_start_after_idle=0` disables the reset; BBR improves throughput on congested links.

**Direct TPS impact in steady state:** Near zero. When blocks are produced consistently, the connection is never idle and slow-start does not trigger.

**Failure mode prevented:** Occasional ~30–50% throughput halving after any quiet period (low mempool, midnight maintenance windows, etc.), where the first resumed block fails to propagate within the slot.

> ❓🤖 **SCRUTINY:** The 700 ms estimate is from the diffusion model in [`throughput-constraint-comparison.md`](substrate-throughput-techniques.md) Appendix A, derived analytically. Actual impact depends on validator topology and connection idle patterns. Empirical measurement on the live network is needed.

**Isolated TPS: <5% steady-state improvement. Primary value: reliability.** Prevents sporadic throughput collapse; not a multiplier.

---

### 2.5 QUIC Instead of TCP (via litep2p)

**Mechanism:** QUIC structurally eliminates slow-start-after-idle (initial CWND = 32 MSS regardless of connection history). It also eliminates TCP head-of-line blocking: GRANDPA vote messages are no longer delayed by concurrent 5 MB block downloads on the same connection. Independent streams allow consensus messages and block gossip to proceed in parallel.

Additional benefit: the litep2p networking architecture (which enables QUIC) achieves 2.78× CPU reduction vs the legacy libp2p backend, independently of the transport protocol.

**Direct TPS impact:** Modest on well-provisioned datacenter links with low packet loss (where TCP+BBR already performs near-optimally): **~5–10% improvement** in effective propagation efficiency. Higher on variable-quality or congested links.

**Enabling effect:** QUIC's larger initial CWND and stream independence allow the (5 MB, 2 s) operating point to be approached with less propagation risk, and ensure that GRANDPA messages are not crowded out during large-block propagation.

**Isolated TPS: ~5–10%.** The primary contribution is reliability and enabling other improvements to be pushed further, not a direct throughput multiplier.

QUIC is opt-in via a configuration flag in Substrate nodes running litep2p (the default backend since `polkadot-sdk stable2503`). The engineering cost of enabling it is near zero; the main prerequisite is confirming the Midnight production build's litep2p version. See [`substrate-throughput-techniques.md`](substrate-throughput-techniques.md) §A for the full enablement paths.

---

### 2.6 AlephBFT Instead of GRANDPA

**Mechanism:** AlephBFT replaces GRANDPA as the finality gadget. AURA block production is **unchanged**: one block per slot at the same slot duration. Raw transaction throughput — transactions included in blocks per second — is therefore unaffected.

**Isolated raw TPS improvement: 0×.**

What improves is **finality latency**. GRANDPA finalises 2–3 blocks in arrears at typical load (~12–18 s at 6 s slots) and can stall indefinitely under a network partition. AlephBFT finalises in ~1 s on Aleph Zero mainnet.

| Metric | GRANDPA (current) | AlephBFT |
|--------|-------------------|----------|
| Raw TPS | Baseline | **0× change** |
| Finality latency (typical) | ~12–18 s | **~1 s (~12–18× improvement)** |
| Finality under partition | Stalls indefinitely | Degrades gracefully |
| Unfinalized block window | 2–3 blocks | ~0–1 blocks |

**Isolated TPS: 0×. Finality latency: ~12–18× improvement.**

Secondary throughput effect: with near-zero finality lag, shorter AURA slot times (e.g., 2 s) are safer to operate because the "unfinalized window" stays small even at high block rates. However, the TPS gain from this shorter slot time belongs to technique 2.2, not to AlephBFT itself.

🧪 **HYPOTHESIS 3:** Deploying AlephBFT alongside a 5 MB block size increase achieves ~49 TPS with ~1 s finality — a substantial UX improvement for bridges and DeFi applications without any change to Midnight's ZK circuits, pallets, or fee model.

---

### 2.7 ProtoGalaxy Proof Folding (~10×)

**Mechanism:** ProtoGalaxy (Eagen & Gabizon, IACR ePrint 2023/1106) folds $k$ ZK proof instances into one combined proof of the same fixed size. Verification cost is paid once for $k$ transactions rather than $k$ times, raising the γ_txs ceiling by a factor of $k$.

**At baseline (3 TPS, 200 KB blocks):** γ_txs = 3 TPS × ~10 ms/tx ≈ 30 ms/s — far below the ~500 ms/s ceiling. The compute ceiling is not binding; ProtoGalaxy does not remove the bottleneck.

**Isolated TPS: ~0× from current baseline.** The β_txs ceiling (block size) is the binding constraint. Raising the γ_txs ceiling from ~49 TPS to ~490 TPS has no effect while β_txs = 3.3 TPS.

**Enabling effect:** ProtoGalaxy is essential to prevent the compute ceiling from capping the block size benefit at ~49 TPS. Without it, expanding to 5 MB blocks hits γ_txs at ~49 TPS. With 10× folding, the full 83 TPS β_txs potential of 5 MB blocks is reachable.

| Scenario | β_txs ceiling | γ_txs ceiling | Effective TPS |
|----------|--------------|--------------|--------------|
| Baseline | 3.3 TPS | ~49 TPS | 3.3 TPS |
| 5 MB blocks, no folding | 83 TPS | ~49 TPS | **~49 TPS** (compute limited) |
| 5 MB blocks + 10× folding | 83 TPS | ~490 TPS | **~83 TPS** (block limited) |
| 5 MB + 2 s slots + 10× folding | 250 TPS | ~490 TPS | **~250 TPS** (block limited) |
| 5 MB + 3 s slots + 10× folding | 167 TPS | ~490 TPS | **~167 TPS** (block limited) |

🛑 **BLOCKER:** ProtoGalaxy folding requires a formal security analysis of the specific Midnight circuit compositions to be folded. This audit does not yet exist. Deployment is blocked on this review. See [`substrate-throughput-techniques.md`](substrate-throughput-techniques.md) §5.4.

Additional constraint: ProtoGalaxy folds proofs from the *same* circuit. In a mixed-transaction block (ZSwap offers, DUST spends, ContractCall proofs), the effective fold factor $k$ may be well below 10 due to circuit-type fragmentation. The ~10× multiplier assumes sufficient same-circuit transaction density.

---

## 3. Combined Analysis

### 3.1 Additive and Multiplicative Structure

The six techniques fall into three functional roles:

| Role | Techniques | Effect |
|------|-----------|--------|
| **Direct multipliers** | Block size, Slot time | Move the β_txs ceiling; each multiplies TPS independently |
| **Unlock ceiling** | ProtoGalaxy | Raises γ_txs ceiling; essential prerequisite for large β_txs gains |
| **Reliability enablers** | TCP tuning, QUIC | Ensure the aggressive operating point is stable; small direct TPS gain |
| **Latency improvement** | AlephBFT | Improves finality latency, not throughput; 0× raw TPS |

Block size and slot time multiply: a 25× block size increase combined with a 3× slot reduction gives ~75× β_txs improvement (with caveats on diffusion safety). ProtoGalaxy is a prerequisite to prevent γ_txs from capping this below ~49 TPS. TCP/QUIC improve the propagation margin that makes large blocks at short slots viable.

### 3.2 Recommended Packages

❓🤖 **SCRUTINY** — all TPS figures below are derived estimates, not measured results. Block diffusion times assume median validator bandwidth of 100 Mbps and 3 gossip hops.

**Conservative package (near-term, minimal risk):**

> 5 MB blocks + 3 s AURA slots + TCP tuning

- β_txs ceiling: ~167 TPS
- γ_txs at this rate (no folding): 167 × ~10 ms = 1,670 ms/s — exceeds budget
- **Actual TPS: ~49 TPS** — compute limited without ProtoGalaxy
- Propagation: Δ_diff ≈ 700 ms = 23% of 3 s slot. Safe.
- All changes are parameter or configuration adjustments; no code changes required.

**Target package (requires ProtoGalaxy audit clearance):**

> 5 MB blocks + 3 s AURA slots + ProtoGalaxy 10× + TCP/QUIC tuning

- β_txs ceiling: ~167 TPS
- γ_txs with folding: 167 × ~1 ms = 167 ms/s. Well within budget.
- **Actual TPS: ~167 TPS** — block-size limited.
- Propagation: 23% of slot. Safe.
- Requires: ProtoGalaxy security audit ✅, aggregator design and deployment.

**Aggressive package (requires network measurement first):**

> 5 MB blocks + 2 s AURA slots + ProtoGalaxy 10× + QUIC

- β_txs ceiling: ~250 TPS
- γ_txs with folding: 250 × ~1 ms = 250 ms/s. Within budget.
- **Actual TPS: ~250 TPS** — block-size limited.
- Propagation: Δ_diff ≈ 700 ms = 35% of 2 s slot. **Marginal** — tail validators at 20–30 Mbps would be excluded.
- Requires: network measurement on actual Midnight validator topology before deployment.

🧪 **HYPOTHESIS 4 (target package):** The combination of 5 MB blocks, 3 s AURA slots, and 10× ProtoGalaxy folding achieves ~167 TPS on Midnight within the existing Substrate architecture, without any change to ZK circuits, pallets, or the NEAR platform. Falsifiable by: (a) measuring actual Δ_diff for 5 MB blocks on the preprod network, (b) benchmarking ProtoGalaxy aggregation latency for Midnight's specific circuits, (c) validating that the γ_txs ceiling with folding stays below 500 ms/s at 167 TPS.

### 3.3 AlephBFT's Place in the Combined Picture

AlephBFT can be deployed alongside any of the three packages above. It does not change TPS but improves:

- **Bridge latency:** cNIGHT ↔ mNIGHT confirmation time drops from ~12–18 s to ~1 s.
- **DeFi UX:** applications waiting for finality before acting see near-instant confirmation.
- **Safety margin for shorter slots:** the near-zero unfinalized window at 2–3 s slots reduces the number of concurrent unfinalized blocks, simplifying light-client and bridge implementations.

Adding AlephBFT to the target package yields **~167 TPS with ~1 s finality**.

### 3.4 Summary Table

| Technique | Isolated TPS from 3 TPS baseline | Primary mechanism | Role |
|-----------|----------------------------------|------------------|------|
| Block size → 5 MB | **~15× ≈ 49 TPS** | β_txs ↑25×; γ_txs becomes limiting | Direct multiplier |
| Slot time → 3 s | **~2× ≈ 6.7 TPS** | β_txs ↑2×; safe diffusion margin | Direct multiplier |
| Slot time → 2 s | **~3× ≈ 10 TPS** | β_txs ↑3×; marginal diffusion at 5 MB | Direct multiplier |
| TCP tuning | **<5% steady-state** | Prevents idle-period degradation | Reliability enabler |
| QUIC | **~5–10%** | Removes slow-start structurally; CPU reduction | Reliability enabler |
| AlephBFT | **0× raw TPS; ~12–18× finality latency** | GRANDPA replacement; AURA unchanged | Latency improvement |
| ProtoGalaxy | **~0× at baseline; unlocks compute ceiling** | γ_txs ↑10×; prerequisite for large-block gains | Ceiling unlocker |
| **Target package** (5 MB + 3 s + ProtoGalaxy) | **~50× ≈ 167 TPS** | Both ceilings addressed | Combined |
| **Aggressive package** (5 MB + 2 s + ProtoGalaxy) | **~75× ≈ 250 TPS** | Marginal diffusion safety | Combined |

---

## 4. Open Questions and Next Experiments

The following measurements are required to validate or falsify the hypotheses above:

1. **Actual ZK transaction size on preprod.** The ~10 KB/tx assumption drives the β_txs calculations. If actual transactions are larger (e.g., 20–50 KB), TPS ceilings scale proportionally downward.
2. **Δ_diff for 5 MB blocks on the live Midnight preprod network.** The 700 ms estimate assumes 100 Mbps median bandwidth; actual validator hardware and topology may differ significantly.
3. **Per-transaction compute cost (γ_txs) under load.** The ~10 ms/tx and ~3.43 ms/tx figures are from different source documents and should be reconciled. The DUST rehearsal model adds overhead whose magnitude is unquantified here.
4. **ProtoGalaxy effective fold factor $k$ for Midnight's circuit mix.** If ZSwap offers, DUST spends, and ContractCall proofs cannot be folded across circuit types, the effective $k$ in a production block may be 2–4× rather than 10×.
5. **AlephBFT integration benchmarks.** The `aleph-bft` crate integration into a Midnight test node would validate the finality latency improvement and identify any interaction with ZK proof verification timing.

---

## Sources

1. **[`substrate-throughput-techniques.md`](substrate-throughput-techniques.md)** — §2 (throughput levers), §4 (applicability to Midnight, including the 49 TPS γ_txs ceiling and the 0.343 ms/tx post-folding figure), §5 (risks), §A (QUIC). Internal.
2. **[`throughput-constraint-comparison.md`](throughput-constraint-comparison.md)** — §0 (metric definitions and relationships), §0.5 (3.43 ms/tx ZK verification cost), §2 (Midnight-specific constraints). Internal.
3. **[`artifacts/throughput-model-v1.md`](../artifacts/throughput-model-v1.md)** — formal definitions of β_txs, γ_txs, and the ceiling framework. Internal.
4. **[`consensus-comparison-alephbft-aura-grandpa.md`](consensus-comparison-alephbft-aura-grandpa.md)** — AlephBFT finality latency figures and the AURA-unchanged result. Internal.
5. **ProtoGalaxy** — Eagen, L. & Gabizon, A. "ProtoGalaxy: Efficient ProtoStar-style folding of multiple instances." IACR ePrint 2023/1106. [eprint.iacr.org/2023/1106](https://eprint.iacr.org/2023/1106).
6. **aleph-node README** — [github.com/Cardinal-Cryptography/aleph-node](https://github.com/Cardinal-Cryptography/aleph-node). Source for "Block authoring is realized with Substrate's Aura."
