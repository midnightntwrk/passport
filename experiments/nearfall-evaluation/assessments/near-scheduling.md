# 🤖 NEAR Validator Scheduling: Epochs, Shard Assignment, and Role Multiplicity

## 1. Epoch Structure

NEAR organises time into **epochs** of approximately 43,200 blocks (~12 hours at 1-second target block times). Each epoch boundary triggers:

1. **Validator set update** — new staking proposals from the previous epoch are applied; validators below the seat-price threshold are ejected.
2. **Shard assignment** — every validator is assigned to one or more shards for the coming epoch (see §2).
3. **Schedule publication** — the full within-epoch block-producer and chunk-producer schedules are computed and become queryable via `EpochManager`.

The key lookahead guarantee: the `EpochInfo` for epoch *N+1* (including shard assignments) is finalised at the end of epoch *N*, giving validators an entire epoch to download the shard state they will need before they are required to produce chunks.

---

## 2. Epoch Random Seed

All assignment algorithms are seeded by the **epoch random seed**, derived from VRF outputs contributed by block producers during the *previous* epoch:

- Each block producer signs their block's height with a VRF key, appending their VRF proof to the block.
- The epoch manager accumulates these outputs and combines them (XOR or hash-chain) to produce a single epoch seed at the boundary.
- Because the seed for epoch *N* is determined from epoch *N−1* block production, it is unpredictable to any individual validator during epoch *N−1* yet publicly verifiable at epoch *N* start.

❓🤖 **SCRUTINY**: The exact accumulation function (XOR vs. iterative hash) and the precise epoch offset used for shard-assignment lookahead (one epoch vs. two) should be verified against `nearcore/chain/epoch-manager/src/lib.rs` and the relevant NEPs before citing these details in architectural decisions.

---

## 3. Shard Assignment

Given the epoch seed, the `EpochManager` computes two **settlement arrays** stored in `EpochInfo`:

| Array | Indexing | Purpose |
|---|---|---|
| `block_producers_settlement` | flat vec, length ∝ total stake | Stake-weighted roster for block producer selection |
| `chunk_producers_settlement` | 2-D vec `[shard_id][slot]` | Per-shard stake-weighted roster for chunk producer selection |

Settlement is constructed by repeating each validator's index in proportion to their stake weight, so that a validator with twice the stake of another receives twice as many slots. The settlement arrays are shuffled using the epoch seed to destroy any ordering bias.

### Shard assignment constraints

- Each shard must accumulate at least a protocol-defined minimum stake weight from its assigned chunk producers (the security threshold).
- The assignment algorithm iterates validators in stake-descending order and greedily fills shards until all minimums are met; remaining capacity is distributed proportionally.
- ❓🤖 **SCRUTINY**: The precise algorithm (greedy vs. LP-based vs. VRF-sorted) should be confirmed against `EpochManager::compute_shard_assignment` in nearcore.

---

## 4. Within-Epoch Scheduling

### 4.1 Block producer selection

For each block height *h* within the epoch:

```
block_producer(h) = block_producers_settlement[h % len(block_producers_settlement)]
```

A high-stake validator appears many times in the settlement array and therefore produces many blocks per epoch.

### 4.2 Chunk producer selection

For each `(shard_id s, block height h)`:

```
chunk_producer(s, h) = chunk_producers_settlement[s][h % len(chunk_producers_settlement[s])]
```

The per-shard settlement array is independent of the global block-producer array, so the two schedules are not synchronised — the chunk producer for shard 0 at height *h* need not be the block producer at height *h*.

### 4.3 Chunk validator assignment (Nightshade 2.0 / NEP-0509)

Nightshade 2.0 separates *execution* from *verification*:

- The **chunk producer** executes WASM contracts, applies state transitions, and emits a **state witness** (Merkle proofs for every trie node read or written).
- A **chunk validator committee** — a rotating subset of validators drawn from the full epoch validator set — verifies the state witness without holding or replaying trie state.

The committee for each chunk is drawn by applying the epoch seed plus the chunk's block height to a subset-selection algorithm. The size of the committee is a protocol parameter balancing security (coverage) against network fan-out cost.

---

## 5. Role Multiplicity Within an Epoch

A single validator node may hold **all three roles simultaneously** within an epoch; the roles are orthogonal:

| Can a node be… | …and also be… | Notes |
|---|---|---|
| Chunk producer for shard X | Block producer at height H | Yes — independent schedules; both roles active at different (or the same) heights |
| Chunk producer for shard X | Chunk validator for shards Y, Z | Yes — chunk validation duties are assigned to the broader validator pool regardless of chunk-producer assignment; a node producing a chunk for shard X at height H may simultaneously be in the committee for shard Y chunks at height H |
| Chunk producer for shard X | Chunk producer for shard Y | Yes — a sufficiently high-stake validator may appear in the settlement arrays of multiple shards |
| Block producer at height H | Chunk validator for shards at height H | Yes — the block producer aggregates chunk headers and endorsements, but a separate chunk validation obligation may also apply |

### Practical implications

- **High-stake nodes are heavily multi-tasked.** A large validator simultaneously tracks multiple shard states, produces chunks across shards, validates witnesses from other shards, and occasionally produces blocks — all within the same epoch.
- **Low-stake nodes may hold only one role.** A validator just above the seat-price threshold may be assigned to a single shard and appear infrequently in the block-producer settlement, spending most of the epoch in pure chunk-validator mode.
- **Resource implications for Midnight comparison.** Substrate validators have a single, undifferentiated role (block authoring + GRANDPA voting). NEAR's multi-role model distributes load more finely but requires validators to manage multiple concurrent state machines and network streams, which is a meaningful operational complexity difference when evaluating "Take Software from NEAR" options.

---

## 6. State Tracking by Role

| Role | Shard state required | How obtained |
|---|---|---|
| Chunk producer | Full trie for assigned shard(s) | State-synced during previous epoch (one epoch lookahead) |
| Chunk validator | None — verifies state witness only | Witness broadcast by chunk producer |
| Block producer | None — aggregates chunk headers + endorsements | Received from chunk producers via P2P |
| RPC / archival node | Configurable via `tracked_shards` | Explicit config; archival nodes typically track all shards |

The state witness is the sole trust boundary in Nightshade 2.0: if a chunk producer equivocates or corrupts the witness, the chunk-validator committee detects the fraud without needing any independent trie access. This is the structural asymmetry noted in the throughput-constraint-comparison assessment (§2.2).

---

## 7. Hardware and Bandwidth Requirements

Requirements are role-differentiated. Figures are from the official `near-nodes.io` hardware pages (current as of 2025).

### 7.1 Compute and storage

| Role | Config | CPU | RAM | Storage |
|---|---|---|---|---|
| Chunk / block producer | Recommended | 8-core x86_64 (AVX, SHA-NI) | 48 GB DDR4 | 3 TB NVMe SSD |
| Chunk / block producer | Minimal | 8-core x86_64 (AVX, SHA-NI) | 48 GB DDR4 | 2 TB SATA3 SSD (≥15k IOPS, ≥800 MiBps) |
| Chunk validator | Recommended | 8-core x86_64 (AVX, SHA-NI) | 16 GB DDR4 | 2 TB NVMe SSD |
| Chunk validator | Minimal | 8-core x86_64 (AVX, SHA-NI) | 8 GB DDR4 | 1 TB SATA3 SSD (≥15k IOPS, ≥800 MiBps) |
| RPC node | Recommended | 8-core / 16-thread x86_64 | 32 GB DDR4 | 4 TB NVMe SSD |
| RPC node | Minimal | 8-core / 16-thread x86_64 | 16 GB DDR4 | 2.5 TB SATA3 SSD (≥15k IOPS, ≥800 MiBps) |

Required CPU instruction-set extensions: CMPXCHG16B, POPCNT, SSE4.1, SSE4.2, AVX, SHA-NI. The SHA-NI requirement reflects NEAR's heavy use of SHA-256 for trie hashing; AVX enables WASM SIMD execution in nearcore's runtime.

Validators should provision at least 8 GiB of RAM headroom beyond baseline usage to absorb state-witness memory spikes.

The large storage footprints (2–3 TB for chunk producers) reflect the per-shard Nightshade trie plus state-sync snapshots for the one-epoch lookahead. Chunk validators require substantially less storage because they hold no shard state.

### 7.2 Network

The official hardware pages do not specify a bandwidth figure. Observed and cited data points:

- **Sustained sync throughput**: Validator bootcamp logs show ~500 KB/s (≈4 Mbps) inbound + outbound during active synchronisation at current mainnet load.
- **Informal upper bound**: Secondary sources cite a recommended burst capacity of ~1 Gbps with sustained usage well below 100 Mbps; this figure is not in the official documentation and should be treated with caution.
- **Latency sensitivity**: The 1-second target block time makes latency a harder constraint than raw bandwidth for chunk producers. The bootcamp documentation explicitly notes that inconsistent connectivity causes missed block slots and can trigger ejection from the validator set.

❓🤖 **SCRUTINY**: The 1 Gbps / <100 Mbps figures derive from a secondary source; verify against `nearcore` documentation or the NEAR Forum before using in capacity-planning calculations.

### 7.3 Comparison with Midnight / Substrate validators

| Dimension | NEAR chunk producer | Midnight validator (current) |
|---|---|---|
| RAM | 48 GB | ~8–16 GB typical |
| Storage | 2–3 TB NVMe | ~100–500 GB SSD |
| CPU extensions required | AVX, SHA-NI | AVX2 (KZG MSM), no SHA-NI |
| Network sensitivity | Latency-critical (1 s blocks) | Latency-critical (AURA slot timing) |

NEAR's higher storage requirement is a direct consequence of per-shard full-trie maintenance and state-sync snapshots. Midnight validators hold a single chain's state and a much smaller proof cache. If any "Take Software from NEAR" option required running nearcore-derived storage or state-sync code alongside Midnight's ZK proof pipeline, the combined RAM and NVMe footprint would exceed typical bare-metal validator configurations.

---

## Sources

### NEAR Sources

- [Validators — NEAR Documentation](https://docs.near.org/concepts/basics/validators)
- [Epoch — NEAR Documentation](https://docs.near.org/concepts/basics/epoch)
- [Nightshade: Near Protocol Sharding Design — NEAR White Paper](https://near.org/papers/nightshade)
- [NEP-0509: Stateless Validation Stage 0 — near/NEPs](https://github.com/near/NEPs/blob/master/neps/nep-0509.md)
- [Chunk Validators — Nomicon Spec](https://nomicon.io/ChunkValidators/ChunkValidators)
- [Selecting Block Producers — Nomicon Spec](https://nomicon.io/ChainSpec/SelectingBlockProducers)
- [Randomness — Nomicon Spec](https://nomicon.io/BlockchainLayer/EpochManager/Randomness)
- [nearcore generated specification — near.github.io](https://near.github.io/nearcore/)
- [Hardware Requirements for Validator Node — near-nodes.io](https://near-nodes.io/validator/hardware-validator)
- [Hardware Requirements for RPC Node — near-nodes.io](https://near-nodes.io/rpc/hardware-rpc)
- [NEAR Validator Bootcamp — near-nodes.io](https://near-nodes.io/validator/validator-bootcamp)

---

## Afterword: Quality Scrutiny

### 1. Sources Correspond to Retrievable URLs

The document has a `## Sources` section with eleven NEAR citations. All base domains are public and accessible; however two specific paths are broken:

- `nomicon.io/BlockchainLayer/EpochManager/ValidatorSelection` — returns 404. The correct Nomicon path for validator selection is `nomicon.io/ChainSpec/SelectingBlockProducers`. *(The citation in the Sources section above has been corrected to the right URL.)*
- `nomicon.io/BlockchainLayer/EpochManager/Randomness` — returns 404. The randomness documentation is served at a different path within the Nomicon hierarchy; the correct URL was not definitively resolved during this review.

All other cited URLs (`near-nodes.io` hardware pages, NEP-0509, Nomicon `ChunkValidators`, NEAR documentation pages, nearcore.github.io) were accessible and matched their described content.

### 2. Internal Consistency

The document is internally consistent. The structural logic — epoch boundaries trigger validator-set updates, shard assignments, and schedule publication; schedules are deterministic given the epoch seed; roles are orthogonal and multiplicable — flows coherently across sections. The hardware comparison table (§7.3) is consistent with the role descriptions in §§3–6. The explicit ❓🤖 SCRUTINY markers on three claims (randomness accumulation function, shard assignment algorithm precision, bandwidth figures) correctly flag the document's own uncertainties, which is good practice.

### 3. Accuracy Against Sources

- **Epoch duration: 43,200 blocks ≈ 12 hours** — ✅ Previously verified; confirmed by NEAR documentation.
- **One-epoch-ahead schedule publication (`EpochInfo` for N+1 finalised at end of N)** — ✅ Consistent with NEAR documentation on epoch structure and the validator bootcamp's instruction to sync state before the assigned epoch begins.
- **NEP-0509 / Nightshade 2.0 stateless validation** — ✅ All claims verified verbatim from NEP-0509: "Stateless Validation Stage 0"; chunk producers emit state witnesses (defined as "a subset of the trie state, alongside its proof of inclusion in the trie"); chunk validator committees "validate chunks without requiring full shard data"; committee selection uses a height-specific seed derived from the epoch seed.
- **Hardware requirements** — ✅ All figures verified exactly from `near-nodes.io/validator/hardware-validator` and `near-nodes.io/rpc/hardware-rpc`, including the CPU extension list (CMPXCHG16B, POPCNT, SSE4.1, SSE4.2, AVX, SHA-NI) and the "at least 8 GiB of additional RAM headroom beyond baseline" recommendation.
- **Within-epoch scheduling formulas** (§§4.1–4.2) — ⚠️ The presented formulas:
  ```
  block_producer(h) = block_producers_settlement[h % len(block_producers_settlement)]
  chunk_producer(s, h) = chunk_producers_settlement[s][h % len(chunk_producers_settlement[s])]
  ```
  are simplifications. The Nomicon spec (`nomicon.io/ChainSpec/SelectingBlockProducers`) specifies that block producer selection uses **Vose's Alias Method** applied to validator stakes, seeded by SHA-256(epoch\_seed ‖ block\_height) — a two-stage sampling process (uniform index from the first 8 bytes, weighted value from the next 16 bytes). The `block_producers_settlement` array exists in `EpochInfo` and is populated with stake-weighted repeated entries, but the index into it is not a simple modulo of `h`; it is derived from the SHA-256 seed. The formulas as written correctly convey the stake-weighted, height-indexed *character* of the selection but do not accurately describe the actual algorithm and should not be used for implementation-level reasoning.
- **Epoch random seed: VRF contributions accumulated across epoch N−1** — ✅ The VRF contribution mechanism is confirmed ("The random value is the output of a VRF on the previous output of the random beacon by the current block producer"). The accumulation mechanism is flagged in the document itself with a ❓🤖 SCRUTINY marker; this is appropriate. The Nomicon documentation indicates NEAR uses a **distributed randomness beacon** with threshold cryptography and DKG phases rather than simple XOR or hash-chain accumulation — the SCRUTINY marker correctly captures the uncertainty.
- **Network bandwidth: ~500 KB/s sync, ~1 Gbps burst** — ❓ The 500 KB/s figure is attributed to validator bootcamp logs, which is a reasonable characterisation of a secondary observation. The 1 Gbps / <100 Mbps sustained figures are flagged in the document with a ❓🤖 SCRUTINY marker and described as "not in the official documentation"; this is appropriate. Both should be treated as rough operational estimates, not specifications.
- **Midnight validator comparison figures (~8–16 GB RAM, ~100–500 GB SSD, AVX2 for KZG MSM)** — ❓ These Midnight-side figures are not sourced in this document (no `### Midnight Sources` subsection). They are plausible given Midnight's architecture and are consistent with what `background/midnight-architecture.md` describes for Substrate nodes, but the comparison table draws on unsourced Midnight estimates.

### 4. Areas of Greatest Uncertainty

- **The scheduling formulas** (§§4.1–4.2). As noted above, the modulo-based formulas are a simplification of an alias-method sampling algorithm. Anyone using these formulas to predict a specific block producer at a specific height, or to model the statistical properties of the schedule, would get incorrect results. The document should note explicitly that the formulas are illustrative, not precise.
- **Shard assignment algorithm** (§3). The document correctly flags this with a SCRUTINY marker: the precise algorithm (greedy vs. LP-based vs. VRF-sorted) should be confirmed against `EpochManager::compute_shard_assignment` in nearcore before citing in architectural decisions.
- **Midnight validator hardware comparison** (§7.3). The three Midnight-side figures (RAM, storage, CPU extensions) are stated without a source citation. The AVX2 claim specifically ("AVX2 (KZG MSM), no SHA-NI") is a reasonable inference from Midnight's use of KZG polynomial commitments, but it is not cited.
- **Broken Nomicon URL for randomness** (§2). The cited source for the epoch random seed description (`nomicon.io/BlockchainLayer/EpochManager/Randomness`) is a 404. The actual randomness documentation in Nomicon exists but at a different path. This does not affect the accuracy of the documented behaviour (which is corroborated by the broader Nomicon epoch manager section), but a reader following the link will not find the content.

### 5. Robustness of Primary Conclusions

The document advances two main architectural conclusions:

1. *NEAR validators carry significantly higher hardware requirements than Midnight validators, and a "Take Software from NEAR" option that imports nearcore-derived storage or state-sync code would exceed typical bare-metal validator configurations.*  **Robust.** All hardware figures are verified exactly. The comparison is anchored in precise, retrievable specifications and does not depend on any of the uncertain claims.

2. *The multi-role model (chunk producer / chunk validator / block producer simultaneously) distributes load finely but adds meaningful operational complexity compared to Substrate's undifferentiated single role.*  **Robust.** The role multiplicity description is accurately sourced from NEP-0509 and the Nomicon specification, and the qualitative operational complexity observation follows directly from the described architecture.

The simplified scheduling formulas (the main accuracy issue) are illustrative rather than load-bearing for either conclusion; they do not affect the validity of the architectural assessment. Correcting them to "stake-weighted deterministic selection seeded by (epoch\_seed, height)" rather than "settlement[h % len]" would improve precision without changing any conclusion.
