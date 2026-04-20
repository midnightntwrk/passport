# 🤖 Batch Proof Verification vs. ProtoGalaxy Folding

**Scope:** This document explains and contrasts two techniques for reducing the ZK proof verification cost (γ_txs) in Midnight: *batch verification* of independent proofs and *ProtoGalaxy proof folding*. Both attack the same bottleneck but differ fundamentally in where the computational savings land, what infrastructure they require, and how they interact with the β_txs block-size ceiling. The document is a companion to [`throughput-hypotheses.md`](throughput-hypotheses.md) and [`substrate-throughput-techniques.md`](substrate-throughput-techniques.md).

> [!NOTE]
>
> ❓🤖 **SCRUTINY — speedup figures are estimates.** The 2–5× batch verification improvement and the k× ProtoGalaxy figures are derived from the algebraic structure of KZG-based proof systems, not from benchmarks on Midnight's specific circuits. Actual speedups depend on pairing-to-MSM cost ratio, batch size k, and circuit parameters. Empirical benchmarking is required before using these figures in deployment decisions.

---

## 1. The Shared Bottleneck

Both techniques target γ_txs: the per-transaction compute cost paid by every validator on every block. In Midnight, γ_txs is dominated by Plonk/KZG proof verification (~3.43 ms for the bare verifier; higher when ZSwap, DUST, and signature operations are included — see [`throughput-constraint-comparison.md`](throughput-constraint-comparison.md) §0.5).

KZG proof verification has two primary cost components:

| Operation | Cost behaviour | Reducible? |
|-----------|---------------|------------|
| **Pairing evaluations** (bilinear map on elliptic curve points) | O(k) naïvely; the most expensive single operation | Yes — batch verification collapses to O(1) |
| **Multi-scalar multiplications (MSMs)** | O(k / log k) via Pippenger's algorithm | Partially — sub-linear but still scales |

---

## 2. Batch Verification

### 2.1 Mechanism

For k independent proofs sharing the same KZG proof system, batch verification constructs a single randomised linear combination of all k proofs and checks it with **one** pairing evaluation rather than k.

Concretely: choose random scalars r₁, r₂, …, rₖ; combine the k proof elements into one aggregate; verify the aggregate with a single pairing check. The soundness argument reduces to the hardness of the underlying KZG commitment scheme, provided the randomness is not adversarially controlled.

### 2.2 What Changes

- **Provers:** nothing. Proofs are generated and submitted to the mempool exactly as today.
- **On-chain data:** unchanged. All k proofs appear individually in the block.
- **Verifier:** the Substrate host function `ext_verify_proof` is upgraded to `ext_batch_verify_proof(proofs: Vec<PlonkProof>) -> Vec<bool>`. No WASM runtime or pallet changes.
- **Infrastructure:** none beyond the upgraded host function.

### 2.3 Savings

| Cost component | Naïve (k proofs) | Batch (k proofs) | Saving |
|----------------|-----------------|------------------|--------|
| Pairings | O(k) | O(1) | **~k× reduction** |
| MSMs | O(k) | O(k / log k) via Pippenger | Sub-linear reduction |
| Net γ_txs improvement | — | — | **~2–5× in practice** |
| β_txs (block bytes) | k proofs in block | k proofs in block | **0× — unchanged** |

The pairing savings are dramatic; MSMs are not eliminated and remain the residual cost at large k. Overall γ_txs improvement is roughly 2–5× at practical batch sizes.

### 2.4 Security Constraint

The randomised linear combination is sound only if provers cannot predict the random scalars rᵢ at the time they construct their proofs. If the randomness is derived from block data that a prover influences (e.g., their own transaction hash), a malicious prover could craft a proof that is individually invalid but passes the batch check. The randomness must come from a source unavailable to provers before the block producer closes the mempool — for example, the block producer's VRF output assigned after transaction selection. This is a weight-model and node-implementation concern, not a circuit concern.

---

## 3. ProtoGalaxy Folding

### 3.1 Mechanism

ProtoGalaxy (Eagen & Gabizon, IACR ePrint 2023/1106) is an *incrementally verifiable computation (IVC) folding scheme*. Rather than verifying k proofs together at verification time, it *collapses* k statement–witness pairs into a single new statement–witness pair of the same relation *before* any proof reaches the chain.

Steps:

1. An **aggregator** collects k ZK transactions (each with its own proof) from the mempool.
2. It computes "error terms" and "cross terms" — polynomial combinations encoding all k circuit constraints simultaneously.
3. Using a random challenge, it folds them into one **accumulated instance**: a single statement–witness pair satisfying the same relation as all k originals.
4. It generates a single standard proof for this accumulated instance.
5. One proof is submitted to the block producer; the validator verifies it at the cost of **one** proof.

### 3.2 What Changes

- **Provers:** unchanged — transactions are submitted to the mempool as normal individual proofs.
- **Aggregator:** a new component in the transaction lifecycle, sitting between the mempool and the block producer.
- **On-chain data:** one folded proof replaces k individual proofs — **k× reduction in proof bytes per block**.
- **Verifier:** verifies one proof at standard single-proof cost — no host function changes needed.
- **Circuit:** the folding relation must be explicitly designed for Midnight's specific circuits; this is non-trivial work.

### 3.3 Savings

| Cost component | Naïve (k proofs) | ProtoGalaxy (k proofs folded) | Saving |
|----------------|-----------------|-------------------------------|--------|
| Pairings (verifier) | O(k) | O(1) — one proof | **~k× reduction** |
| MSMs (verifier) | O(k) | O(1) — one proof | **~k× reduction** |
| Net γ_txs improvement | — | — | **~k× (full amortisation)** |
| β_txs (block bytes) | k proof bytes | ~1 proof's bytes | **~k× reduction** |
| Aggregator cost | 0 | O(k) — offloaded to aggregator | New prover-side cost |

Unlike batch verification, ProtoGalaxy addresses **both** the γ_txs and β_txs ceilings simultaneously. This is the critical distinction: at 5 MB blocks and ~10 KB proofs, ~500 ZK transactions could fit in one block — but batch verification still places all 500 proofs on-chain and still pays O(k / log k) MSMs; ProtoGalaxy places one proof on-chain and pays O(1) MSMs.

### 3.4 Constraints and Risks

**Circuit homogeneity:** ProtoGalaxy folds proofs from the *same* circuit. Midnight uses multiple circuits — ZSwap offers, DUST spends, ContractCall proofs — and proofs across different circuit types cannot be naïvely folded together. In a mixed-transaction block the effective fold factor k is limited by same-circuit transaction density, which at current low TPS may be well below 10.

**Aggregator as a new single point of failure:** if the aggregator is unavailable or slow, transactions queue indefinitely. Fallback to single-proof submission is architecturally required; its interaction with the fee model (folded proofs are cheaper per transaction than individual proofs) needs explicit design. A decentralised aggregator requires its own incentive and ordering protocol.

🛑 **BLOCKER:** ProtoGalaxy deployment requires a formal security analysis of the specific Midnight circuit compositions to be folded. The soundness of ProtoGalaxy itself (Eagen & Gabizon, 2023) does not automatically extend to arbitrary circuit compositions. This audit does not yet exist and is a hard prerequisite.

---

## 4. Comparison

| Property | Batch verification | ProtoGalaxy folding |
|----------|--------------------|---------------------|
| **γ_txs saving** | ~2–5× (pairings collapse; MSMs sub-linear) | **~k× (full amortisation)** |
| **β_txs saving** | **0×** (all k proofs still in block) | **~k×** (one proof in block) |
| **Prover changes** | None | None (provers submit to aggregator as before) |
| **New infrastructure** | None | Aggregator service |
| **Verifier changes** | Upgraded host function | None required |
| **Circuit changes** | None | Folding relation design + audit |
| **Security concern** | Batch randomness must be unpredictable to provers | ProtoGalaxy soundness audit per circuit composition |
| **Circuit homogeneity required** | No — can batch proofs of different circuits if pairing-compatible | Yes — same circuit per fold |
| **Implementation complexity** | Low–Medium | High |
| **Status for Midnight** | Not yet implemented | 🛑 Blocked on audit |

---

## 5. How They Compose

The two techniques are complementary rather than alternatives. ProtoGalaxy reduces k proofs to one per circuit type; batch verification can then combine the small number of remaining folded proofs from different circuit types:

```
k_A transactions (circuit A) → [ProtoGalaxy] → 1 folded proof (A)
k_B transactions (circuit B) → [ProtoGalaxy] → 1 folded proof (B)
                                                        ↓
                               [batch verify A + B together] → 1 pairing check
```

In this pipeline batch verification contributes marginal additional saving on top of ProtoGalaxy (combining 2–5 folded proofs rather than hundreds of individual ones). The dominant saving is from ProtoGalaxy.

Batch verification is most valuable as a **near-term partial improvement** before ProtoGalaxy is audit-cleared: it can be deployed without new infrastructure or circuit changes, and it partially relieves γ_txs even while β_txs remains the binding constraint at current block sizes.

---

## 6. Implications for Midnight

| Technique | β_txs impact | γ_txs impact | Prerequisite | Near-term? |
|-----------|-------------|-------------|-------------|-----------|
| Batch verification | None | ~2–5× | Batch host function + safe randomness source | ✅ Yes — no audit required |
| ProtoGalaxy folding | ~k× | ~k× | Aggregator + circuit design + security audit | ❌ Blocked |
| Combined | ~k× | > k× | Both of the above | After ProtoGalaxy unblocked |

Batch verification is the lower-risk nearer-term lever. It is a pure verifier-side optimisation — no changes to provers, circuits, or on-chain data formats — and it provides a meaningful γ_txs improvement that becomes relevant once block sizes increase past the current 200 KB. It does not, however, unlock the β_txs ceiling: all individual proofs still occupy block space. ProtoGalaxy is required to achieve the ~10× combined improvement in both ceilings that the [`throughput-hypotheses.md`](throughput-hypotheses.md) target packages depend on.

---

## Sources

1. **ProtoGalaxy** — Eagen, L. & Gabizon, A. "ProtoGalaxy: Efficient ProtoStar-style folding of multiple instances." IACR ePrint 2023/1106. [eprint.iacr.org/2023/1106](https://eprint.iacr.org/2023/1106).
2. **KZG batch verification** — Kate, A., Zaverucha, G. & Goldberg, I. "Constant-size commitments to polynomials and their applications." ASIACRYPT 2010. [iacr.org/archive/asiacrypt2010/6477178/6477178.pdf](https://iacr.org/archive/asiacrypt2010/6477178/6477178.pdf). The batch opening technique is the standard KZG multi-point opening construction.
3. **Pippenger's MSM algorithm** — Pippenger, N. "On the evaluation of powers and related problems." FOCS 1976. The O(k / log k) MSM cost is the standard reference.
4. **gnark batch verification advisory (GHSA-7p92-x423-vwj6)** — Real-world example of a batch verification soundness failure caused by adversarially predictable randomness. Cited in [`substrate-throughput-techniques.md`](substrate-throughput-techniques.md) §5.5.
5. **[`throughput-hypotheses.md`](throughput-hypotheses.md)** — §2.7 (ProtoGalaxy isolated quantification), §3.1 (combined ceiling analysis). Internal.
6. **[`substrate-throughput-techniques.md`](substrate-throughput-techniques.md)** — §5.4 (ProtoGalaxy risks), §5.5 (batch verification risks). Internal.
7. **[`throughput-constraint-comparison.md`](throughput-constraint-comparison.md)** — §0.5 (3.43 ms/tx ZK verification baseline). Internal.
