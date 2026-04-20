# 🤖 Throughput Prospects: Midnight vs NEAR

Assessment of the relative TPS prospects for Midnight and NEAR, based on Midnight's ledger cost model and published NEAR benchmarks.

**Midnight's binding constraint is block size, not proof verification compute.**

From [`cost-model.md`](https://github.com/midnightntwrk/midnight-ledger/tree/main/spec) in the ledger spec:

| Resource | Limit per block |
|----------|----------------|
| Block size | 200,000 bytes (200 KB) |
| Compute budget (single-threaded) | 1 second |
| Proof verification | ~3.4 ms constant + ~3.4 μs/unit |

At a ~6-second AURA slot time:
- **Compute ceiling**: 1,000 ms ÷ 3.4 ms/proof ≈ 294 proofs/block → ~49 TPS
- **Block size ceiling**: 200 KB ÷ ~10 KB per ZK transaction → ~20 txs/block → ~3.3 TPS

Block size is the binding constraint. This confirms Jon Rossie's diagnosis (Background 6): the bottleneck is block size, not the consensus protocol. Switching to NEAR's networking does not address this. The path to 500+ TPS on Midnight's current architecture requires some combination of:
1. **Block size increase** — a 25× increase (200 KB → 5 MB) yields ~80 TPS before block propagation becomes the new limit.
2. **ZK proof aggregation via folding** (ProtoGalaxy k-folding, referenced in the NearFall Technical Specification) — folding k proofs reduces per-transaction on-chain proof size by ~k×, relaxing the byte constraint proportionally.
3. **L2 rollup** — batches many transactions into a single L1 block entry, decoupling L2 TPS from L1 block size entirely.

The combination of (1) + (2) likely reaches 500+ TPS without changing the consensus architecture.

**NEAR's throughput scales horizontally with shard count but degrades significantly for ZK-heavy workloads.**

Published figures (December 2025 benchmark, Nightshade 2.0):

| Metric | Value |
|--------|-------|
| Mainnet actual (9 shards, real workload) | ~63–80 TPS |
| Testnet peak | ~4,135 TPS |
| Benchmark peak (70 shards, Dec 2025) | ~1,000,000 TPS |
| Block time | ~600 ms |
| Finality | ~1.2 s |

The 1M TPS benchmark used **native token transfers only** (~200–300 bytes each). A Midnight-style ZK transaction with a KZG/Plonk proof is ~5–15 KB — roughly 50× larger. Scaling the benchmark accordingly:
- Per-shard ZK TPS (bandwidth-bound): ~280 TPS/shard
- Compute check: 3.4 ms/proof → ~300 proofs/second/shard — consistent with bandwidth estimate
- **9 shards → ~2,500 TPS** for ZK-heavy workload at current mainnet shard count
- **70 shards → ~19,000 TPS** at benchmark shard count

NEAR's key architectural advantage is that ZK TPS scales approximately linearly with shard count. Midnight's single-chain architecture has no equivalent lever.

**Summary comparison:**

| Dimension | Midnight now | Midnight (folding + larger blocks) | NEAR ZK (9 shards) | NEAR ZK (70 shards) |
|-----------|-------------|-------------------------------------|---------------------|----------------------|
| TPS | ~3 | ~500+ | ~2,500 est. | ~19,000 est. |
| Binding constraint | Block size (200 KB) | Block propagation bandwidth | Per-shard proof verification | Shard coordination overhead |
| Scaling lever | None without architecture change | Folding batch size | Add shards | Add shards |
| ZK-native | Yes | Yes | No (requires embedding) | No |

**Key takeaways:**
- The near-term path to 500+ TPS for Midnight is block size + ZK proof folding, not platform migration. This is achievable within the existing Substrate architecture.
- NEAR's 1M TPS headline is not representative of ZK-heavy workloads. For Midnight-style transactions, NEAR at 9 shards is estimated at ~2,500 TPS — still far above current Midnight, but 400× below the headline claim.
- NEAR's structural advantage is horizontal scaling: adding shards increases ZK TPS proportionally. Midnight requires sharding (a fundamental change) to match this.
- 🧪**HYPOTHESIS**: Midnight's TPS ceiling is well-modelled as `(block_size_bytes / avg_zk_tx_bytes) / block_time_seconds × folding_factor`. Validating this model against actual measurements is a concrete near-term experiment.
- No rigorous public benchmark exists for Midnight's ZK transaction throughput. The ~1,000 TPS marketing target is unvalidated.

**Sources:**
- [Midnight ledger cost model](https://github.com/midnightntwrk/midnight-ledger/tree/main/spec)
- [NEAR 1M TPS benchmark](https://cryptobriefing.com/near-protocol-1-million-tps-milestone/)
- [NEAR Protocol statistics 2026](https://coinlaw.io/near-protocol-statistics/)
- [NEAR 1M TPS detail](https://bitcoinethereumnews.com/tech/near-protocol-achieves-1-million-transactions-per-second-in-major-scalability-milestone/)
- [ZK rollup performance bottlenecks](https://arxiv.org/html/2503.22709v1)

---

## Afterword: Quality Scrutiny

### 1. Sources Correspond to Retrievable URLs

- **`cost-model.md`** is accessible via `https://raw.githubusercontent.com/midnightntwrk/midnight-ledger/main/spec/cost-model.md`. All three core Midnight figures are present verbatim: `block_usage: 200_000`, `compute_time: 1 * SECOND`, `proof_verification_time_constant: 3_382 * MICROSECOND`, `proof_verification_time_linear: 3_352 * NANOSECOND`. The source link in the document points to the directory rather than the file; a direct link to `cost-model.md` would be more precise.
- **Crypto Briefing** and **Bitcoin Ethereum News** articles are accessible and confirm that NEAR achieved 1,000,000 TPS in a benchmark test enabled by Nightshade 2.0. However, neither article provides the specific technical parameters cited in the document (70 shards, 200–300 bytes per transaction, December 2025 date). These parameters appear to come from a primary NEAR technical report or press release that is not cited.
- **CoinLaw.io** is accessible but the numerical content (63–80 mainnet TPS, 4,135 testnet peak, 9 shards, 600 ms block time, 1.2 s finality) could not be extracted from the page. These figures are specific enough to require a primary citation; the page may display them dynamically.
- **arXiv 2503.22709v1** is accessible. It covers ZK rollup performance for Groth16 but does not provide the 5–15 KB proof size figure cited in the document. This paper therefore does not serve as a source for that specific claim.

### 2. Internal Consistency

- The document is arithmetically self-consistent throughout. The Midnight ceilings (49 TPS compute, 3.3 TPS block-size) correctly derive from the spec constants. The NEAR ZK derivation (1M TPS ÷ 50× size factor ÷ 70 shards ≈ 280 TPS/shard; 9 shards × 280 ≈ 2,500 TPS) is internally consistent.
- The document uses "~10 KB per ZK transaction" for the Midnight block-size ceiling and "~5–15 KB" for the NEAR scaling adjustment. These are compatible (10 KB is the midpoint), but the sensitivity range is not discussed: at 5 KB, the Midnight block-size ceiling rises to ~6.7 TPS, not 3.3 TPS; the conclusion that block size is the binding constraint still holds either way.
- The compute ceiling for Midnight (49 TPS) and the per-shard NEAR compute estimate (300 proofs/second) both use the same 3.4 ms figure from Midnight's cost model. This is noted below as a cross-application assumption.
- The "Key correction" in the throughput ranking section of `midnight-to-near-mapping.md` (that H and E relocate TPS rather than solve it) is consistent with the present document's treatment of L2 rollup as a separate option.

### 3. Accuracy Against Sources

- **Block size 200 KB, compute budget 1 s, proof verification ~3.4 ms constant + ~3.4 μs/unit** — ✅ All verified verbatim in `cost-model.md`. The "~3.4 μs/unit" converts correctly from `3_352 * NANOSECOND`.
- **NEAR 1M TPS benchmark (December 2025, 70 shards, native token transfers, 200–300 bytes)** — ⚠️ The headline figure is confirmed. The specific parameters (shard count 70, transaction size 200–300 bytes, December 2025) are not present in any cited source. These are plausible for a Nightshade 2.0 benchmark but require a primary technical citation.
- **NEAR mainnet 63–80 TPS, testnet 4,135 TPS, 9 shards, 600 ms block time, 1.2 s finality** — ❓ The CoinLaw.io page is the sole cited source and its numerical content could not be extracted. Each of these five figures warrants independent verification against NEAR's own explorer or documentation.
- **ZK transaction size ~5–15 KB** — ❓ Not found in the arXiv paper cited. Midnight's own documentation (this repository's `midnight-pallets.md` assessment) states "typically 1–2 KB" for a single Midnight proof blob; the present document uses 5–15 KB as the bandwidth cost of a full ZK *transaction* (which may include the proof, public inputs, and calldata). The distinction is not explained and the 5–15 KB range is unverified.
- **"Scaling the benchmark accordingly"** — ❓🤖 The scaling from 1M TPS at small transfers to ~280 TPS/shard for ZK workloads assumes the benchmark is *bandwidth-bound*. If the original benchmark is compute-bound at native token transfer speed, the ZK TPS estimate would be lower by an additional compute-overhead factor. No evidence is provided that bandwidth was the limiting resource in the 1M TPS test.
- **Applying the 3.4 ms Midnight figure to NEAR compute** — ❓🤖 The document states "3.4 ms/proof → ~300 proofs/second/shard" as a "compute check" for NEAR. The 3.4 ms figure is Midnight's native (likely Rust/x86) verifier speed. NEAR executes smart contract logic in WASM; WASM overhead for cryptographic operations is typically 5–100× slower than native code. Running a Plonk/KZG verifier in NEAR WASM would likely hit the 300 TGas per-transaction limit before completing, as noted in other repository assessments. The "consistent with bandwidth estimate" claim therefore overstates confidence in the NEAR ZK TPS figure.

### 4. Areas of Greatest Uncertainty

- **NEAR benchmark technical parameters.** The 70-shard, 200–300-byte characterisation of the 1M TPS benchmark is not traceable to any cited source. If the benchmark used a different shard count or transaction size, the NEAR ZK scaling estimate changes proportionally.
- **NEAR current mainnet shard count (9).** NEAR's shard count is a dynamic protocol parameter that has changed during Nightshade 2.0 deployment. "9 shards" is plausible but unconfirmed by any directly readable source here. If the figure is closer to 4–6 (earlier Nightshade deployments), the "~2,500 TPS" estimate falls to ~1,100–1,700 TPS.
- **ZK proof transaction size (5–15 KB vs. 1–2 KB).** This repository elsewhere describes Midnight proof blobs as 1–2 KB. The 5–15 KB range likely includes additional transaction payload (public inputs, contract call data), but the composition is not broken down. The choice of midpoint (10 KB) for the Midnight block-size ceiling, and the full 5–15 KB range for NEAR, should both be cited or measured.
- **WASM overhead for ZK verification on NEAR.** Applying Midnight's native-speed 3.4 ms figure to NEAR WASM computation is the single most consequential unverified assumption. If the WASM penalty is even 10×, the per-shard compute ceiling falls from ~300 to ~30 proofs/second, making compute (not bandwidth) the binding constraint for NEAR ZK — which changes the architectural conclusion from "bandwidth-bound, scales linearly with shards" to "compute-bound, scales with WASM optimisation."
- **ProtoGalaxy k-folding as a path to 500+ TPS.** The document cites this as part of the route to 500+ TPS but does not acknowledge the 🛑 BLOCKER documented in other repository assessments (security analysis not yet complete for Midnight circuit compositions).

### 5. Robustness of Primary Conclusions

The document advances four main conclusions:

1. *Midnight's binding constraint is block size, not compute.* **Robust.** Verified directly from `cost-model.md`: the block-size ceiling (3.3 TPS) is ~15× tighter than the compute ceiling (49 TPS) regardless of which ZK transaction size assumption is used (5–15 KB).

2. *500+ TPS for Midnight requires block size increase + ZK proof folding, achievable within Substrate.* **Moderately robust.** The arithmetic is sound given the verified cost model. The caveat is the ProtoGalaxy BLOCKER noted above; the statement "likely reaches 500+ TPS" should carry a qualifier.

3. *NEAR's 1M TPS headline is not representative of ZK-heavy workloads.* **Robust.** The qualitative argument (native token transfers are ~50× smaller than ZK transactions) is sound regardless of the exact benchmark parameters. Even if the scaling factor is 20× rather than 50×, the headline is still materially misleading for Midnight-style workloads.

4. *NEAR at 9 shards supports ~2,500 TPS for ZK-heavy workload.* **Fragile.** This estimate depends on three unverified inputs simultaneously: the 70-shard benchmark characterisation, the 9-shard mainnet figure, and the assumption that the benchmark was bandwidth-bound with Midnight-speed ZK verification. If the WASM compute overhead is 10×, this estimate falls to ~250 TPS at 9 shards — comparable to Midnight with block-size + folding rather than far above it. This conclusion should carry a prominent ❓🤖 SCRUTINY marker.
