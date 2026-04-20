# Mapping Midnight State into NEAR Accounts

Analysis of options for representing Midnight's ledger state within NEAR's account model, with rankings by throughput and storage volume. Extracted from journal entries of 2026-03-19 and 2026-03-20.

---

## 👱🤖 Mapping Midnight state into NEAR accounts

Several options for mapping Midnight's state (unshielded UTxOs, shielded commitments, nullifier set, ZK proofs, and contract state) into NEAR's account model, ranging from finest- to coarsest-grained account granularity.

**Option A — One account per unshielded UTXO**
Each unshielded UTXO is a NEAR sub-account (e.g., `utxo-<hash>.midnight.near`) holding the value as storage state. Spending creates a receipt to a recipient account and triggers `DeleteAccount`, recovering the storage deposit. Parallelism is high since independent UTXOs live on independent shards. The main tension: NEAR accounts require pre-initialization (storage staking deposit must precede the UTXO's creation), which complicates the UTXO creation flow.

**Option B — One account per shielded note (commitment)**
Each ZSwap commitment gets its own account. The account holds only the commitment hash; the underlying coin data stays off-chain with the owner. Nullification = `DeleteAccount`. The storage deposit returns to the spender, creating a natural economic incentive to spend. Privacy concern: account creation events are visible on-chain, leaking the note-issuance pattern even if contents are hidden.

**Option C — Nullifier set sharded across accounts by prefix**
The nullifier set is partitioned by the leading bits of the nullifier value, one NEAR account per partition. Double-spend checks are parallelizable across shards. A single transaction's nullifiers likely hit distinct partitions (good) but a spend-and-verify within one transaction still requires cross-shard receipt coordination (one block of latency per hop).

**Option D — Commitment tree partitioned by subtree, with a root aggregator account**
The Merkle commitment tree is split into subtrees, each managed by a separate account that handles insertions and serves inclusion proofs for its subtree. A root-aggregator account holds only the tree root and is updated by receipts from subtree accounts at each epoch or batch boundary. This maps naturally to NEAR's sharded storage and allows parallel insertions.

**Option E — Whole UTxO/nullifier set as a single account, updated by validity proof**
One global-state account holds a succinct accumulator or ZK proof representing the entire UTxO set and nullifier set. Transaction batches are processed off-chain and submitted as a state-transition proof; the account verifies the proof and updates its root. This is essentially a ZK rollup with NEAR as the data-availability and settlement layer. Constraint: the proof verifier must fit within 300 TGas per update, which is the same open question as Option 1 in the modularity comparison.

**Option F — Separate accounts for commitment tree, nullifier set, and proof log**
Three purpose-built accounts: `commitments.midnight.near` (append-only commitment tree), `nullifiers.midnight.near` (nullifier set with membership proofs), and `proofs.midnight.near` (log of submitted ZK proofs for auditability or challenge-response). Contract logic on each account enforces its own invariants. Cross-account state consistency is coordinated via NEAR receipts within a single transaction batch. Simpler than Option E (no validity proof needed on-chain), but larger on-chain footprint and no ZK compression of the state.

**Option G — Per-contract accounts mirroring Midnight's contract model**
Each deployed Midnight contract maps to one NEAR account. The account stores the public contract state as NEAR key-value storage and the contract's verification logic as WASM. Private state remains off-chain as in the Kachina model. A registry account (`contracts.midnight.near`) tracks deployed contract addresses. This is the most natural mapping for Option 1 (full port) but requires solving the 300 TGas ZK verification constraint for every contract call.

**Option H — Epoch snapshot accounts**
Rather than mapping live state, Midnight state is checkpointed periodically: one NEAR account per epoch holds the state root (commitment tree root + nullifier set root) and an aggregated validity proof for all transactions in that epoch. Old epoch accounts can be pruned by validators; archival accounts retain the full history. This is a rollup-style design where NEAR provides settlement and DA, not execution.

The options split along two key axes:

| | Fine-grained (A–D) | Coarse-grained (E–H) |
|---|---|---|
| **Parallelism** | High (shards naturally) | Low (single or few accounts) |
| **ZK pressure** | Low (no on-chain proof needed) | High (proof must fit 300 TGas) |
| **Privacy** | Leaks metadata (account events) | Better (state opaque in proof) |
| **Storage cost** | Scales with UTXO count | Bounded or batched |

Options C/D (sharded nullifier/commitment structures) and Option H (epoch snapshot rollup) seem most architecturally promising given NEAR's strengths.

---

## 🤖👱 Throughput ranking of Midnight-state-to-NEAR-account mappings

The eight mapping options ranked by the throughput (TPS) they would support, assuming the gas limit on a forked NEAR is adjustable. Gas remains relevant as a proxy for absolute computational cost. The table explicitly notes where an option relocates the TPS problem rather than solving it.

| Rank | Option | On-chain TPS ceiling | Where the work goes | Key reasoning |
|------|--------|---------------------|---------------------|---------------|
| 1 | **A — Per-UTXO account** | High | NEAR shard validators (existing infrastructure) | Maximum parallelism using NEAR's native sharding. No ZK verification cost per operation. Scales horizontally with shard count using infrastructure that already provides liveness and validator accountability. Friction: pre-initialization requirement per UTXO creation adds coordination overhead. |
| 2 | **B — Per-note account** | High | NEAR shard validators (existing infrastructure) | Same parallelism story as A applied to the shielded layer. Independent notes on independent shards process concurrently. |
| 3 | **H — Epoch snapshot rollup** | Very low (one proof per epoch) | Off-chain sequencer/prover ⚠️ | Low on-chain cost, but the 500+ TPS problem is pushed entirely into a bespoke off-chain sequencer and prover that must itself handle the full transaction volume, order transactions, verify individual ZK proofs, and fold them into an epoch proof. Liveness, censorship resistance, and fault tolerance of this sequencer are not provided by NEAR and must be designed separately. |
| 4 | **E — Single account + validity proof** | Low (one proof per batch) | Off-chain sequencer/prover ⚠️ | Same off-chain sequencer dependency as H with more frequent, smaller batches. Offers a tunable latency/throughput tradeoff but does not escape the sequencer complexity. |
| 5 | **C — Sharded nullifier set** | Moderate–high | NEAR shard validators (existing infrastructure) | Good parallelism for double-spend checks. Degrades when a single transaction spans multiple nullifier partitions, since each cross-shard check adds a block of receipt latency. |
| 6 | **D — Partitioned commitment tree** | Moderate | NEAR shard validators, with bottleneck | Parallel insertions into subtrees are efficient, but the root-aggregator account is a serial chokepoint: every subtree must eventually funnel updates through it, capping sustained throughput. |
| 7 | **F — Three-account split** | Low–moderate | NEAR shard validators (existing infrastructure) | Every transaction requires 2–3 cross-account receipt hops. No ZK compression to offset the coordination cost. Latency accumulates with transaction complexity. |
| 8 | **G — Per-contract account** | Lowest | NEAR shard validators | Full ZK verification fires on every individual contract call with no batching. The absolute computational cost per transaction is the highest of all options and cannot be amortized away. |

**Key correction from an earlier version of this ranking:** H and E were initially ranked first and second on the basis of low *on-chain* resource cost per transaction. This was misleading: the on-chain cost is low because the TPS problem is relocated to an off-chain sequencer/prover stack that must itself handle 500+ TPS, plus proof aggregation (ProtoStar/ProtoGalaxy folding), plus sequencer liveness guarantees. A and B achieve high throughput through NEAR's native sharding infrastructure, which already provides the required liveness and accountability properties, at the cost of a lower theoretical ceiling.

---

## 🤖👱 Storage volume ranking of Midnight-state-to-NEAR-account mappings

The eight mapping options ranked by on-chain storage volume, motivated by concern about NEAR's snapshot overhead. NEAR takes approximately 12 full state-trie snapshots per day at epoch boundaries; this snapshot cost — not transaction history — already accounts for 108–113 TB of NEAR's ~118 TB archival total (~20 KB of snapshot overhead per transaction vs. ~1–2 KB for the transaction itself). The critical metric is therefore how much state sits in the trie at each epoch boundary, multiplied by snapshot frequency and retention period.

An additional constraint specific to ZSwap/Midnight: commitment trees and nullifier sets grow **monotonically** — commitments cannot be deleted (required for Merkle membership proofs) and nullifiers cannot be deleted (required for double-spend prevention). Any option that stores either on-chain faces structurally unbounded storage growth.

| Rank | Option | On-chain storage growth | Where overflow goes | Key reasoning |
|------|--------|------------------------|---------------------|---------------|
| 1 (worst) | **B — Per-note account** | Unbounded, fast | Nothing — all on-chain | One account per live shielded note. Notes in ZSwap tend to be long-lived; the live note set compounds quickly at high TPS. Each epoch snapshot captures every live note account. Account count × epoch frequency × retention period drives the dominant cost. Deleting accounts on nullification helps current-state cost but does not reduce historical snapshot archives. |
| 2 | **A — Per-UTXO account** | Unbounded, moderate | Nothing — all on-chain | Same structure as B but for unshielded UTXOs, which cycle faster (typically spent in hours or days rather than weeks). The live UTXO set is smaller than the live note set at comparable TPS, but still potentially millions of accounts at 500+ TPS. Same snapshot amplification applies. |
| 3 | **F — Three-account split** | Unbounded, maximum raw volume | Nothing — all on-chain | Stores all commitments + all nullifiers + all proofs in three accounts without ZK compression. The fewest accounts of any high-storage option, so per-account trie overhead is minimal, but the raw data volume per account is the largest of all options and grows without bound. Each epoch snapshot captures the full accumulated dataset. |
| 4 | **C — Sharded nullifier set** | Unbounded, moderate | Nothing — all on-chain | Fixed account count (bounded by prefix length), but state per account grows monotonically with every transaction. At 500 TPS for one year, total nullifier data reaches ~1 TB; each of the ~4,380 annual epoch snapshots captures the current cumulative total, producing PB-scale snapshot archives over multi-year operation. |
| 5 | **D — Partitioned commitment tree** | Unbounded, moderate | Nothing — all on-chain | Same structure as C but for commitments. Fixed subtree account count, monotonically growing commitment data per subtree. Root aggregator account is small but each subtree account grows without bound. Combined with C, a complete system using both would match Option F in total data volume. |
| 6 | **G — Per-contract account** | Bounded by ecosystem size | Nothing — all on-chain | One account per deployed contract; state bounded by contract logic, not transaction volume. Contract WASM bytecode (~hundreds of KB per contract) contributes to snapshot cost but does not grow with throughput. Snapshot overhead scales with dApp ecosystem growth, not transaction rate — a qualitatively different and more manageable growth curve. |
| 7 | **E — Single account + validity proof** | Near-zero on-chain | Off-chain sequencer/prover ⚠️ | One account storing the current state root and latest validity proof (~1–2 KB total). Epoch snapshots capture only this tiny account. However, the full commitment tree and nullifier set still exist off-chain; total system storage is similar to the options above, just outside NEAR's snapshot mechanism. |
| 8 (best) | **H — Epoch snapshot rollup** | Near-zero on-chain, prunable | Off-chain sequencer/prover ⚠️ | One small account per epoch (~1 KB: two 32-byte roots + proof). Old epoch accounts can be pruned by non-archival validators; with standard five-epoch garbage collection, on-chain state stays nearly constant regardless of transaction history. The full commitment and nullifier history still exists off-chain. Lowest on-chain snapshot burden of all options. |

**Key tension mirroring the TPS ranking:** E and H minimise NEAR's snapshot overhead by moving all substantive state off-chain, but this pushes the storage problem — and its associated infrastructure, indexing, and archival incentive questions — onto a bespoke off-chain system. The options that use NEAR's native account model (A–D, F, G) keep state on-chain but directly inherit and amplify NEAR's existing snapshot cost structure, which is already the dominant factor in NEAR's ~118 TB archival footprint.

## Sources

- [NEAR gas and transaction limits](https://docs.near.org/protocol/gas)
- [NEAR epoch and validator schedule](https://docs.near.org/protocol/network/epoch)
- [NEAR data flow — cross-shard receipt routing](https://docs.near.org/concepts/data-flow/near-data-flow)
- Journal entries 2026-03-19 and 2026-03-20 — internal analysis extracting these mapping options
- Journal entry 2026-03-17 — internal LLM-assisted storage volume estimates (see Afterword §3 for caveats)

---

## Afterword: Quality Scrutiny

### 1. Sources Correspond to Retrievable URLs

- **The document contains no `## Sources` section**, violating the AGENTS.md convention.
- The document states its content was "extracted from journal entries of 2026-03-19 and 2026-03-20." Those journal entries are internal and not independently retrievable; they form the only traceable lineage for most claims. The NEAR storage figures (§3 below) trace further back to a journal entry of 2026-03-17 attributed to LLM analysis with no primary citation.
- The NEAR documentation URLs used to verify claims during this scrutiny (`https://docs.near.org/concepts/protocol/gas`, `/protocol/network/epoch`, `/concepts/data-flow/near-data-flow`) have migrated; the originals return 404. The current equivalents are at `https://near-docs.io/protocol/gas` and `https://docs.near.org/protocol/network/epoch`. The claims were verified through these current URLs, not through documents cited in the assessment.
- ProtoStar/ProtoGalaxy appear in other repository assessments attributed to "Pearson et al., 2023" — no citation is provided in this document.

### 2. Internal Consistency

- The three sections (options catalogue, TPS ranking, storage ranking) are mutually consistent: options are the same set in each section and the reasoning is applied uniformly.
- The throughput ranking's correction note (*"H and E were initially ranked first and second… this was misleading"*) is transparent and well-reasoned; the correction is internally coherent.
- The storage ranking correctly identifies that a UTXO/commitment/nullifier monotonic-growth constraint cuts across all fine-grained options (A–D, F) in the same way, and the logic is applied consistently.
- The 4,380 annual epoch snapshots figure is arithmetically consistent with the "12 snapshots/day" figure (12 × 365 = 4,380), so the storage arithmetic is internally self-consistent, but both numbers stand or fall together (see §3).

### 3. Accuracy Against Sources

- **300 TGas maximum per transaction** — ✅ Verified. NEAR documentation confirms the 300 TGas hard limit, associated with approximately 300 ms execution time at one block per second.
- **"One block of latency per hop" for cross-shard receipts** — ✅ Verified. NEAR documentation confirms that each cross-shard receipt hop requires the previous shard's chunk to be included in a block before the receipt can be routed to the receiving shard.
- **NEAR epoch duration** — ✅ Verified. NEAR mainnet and testnet both run epochs of 43,200 blocks, ideally lasting ~12 hours (approximately 2 epochs per day).
- **"~12 full state-trie snapshots per day across 6 shards"** — ❓ Partially verified. The 2-epochs/day figure is confirmed. The "6 shards" multiplier is unconfirmed: NEAR mainnet has been running with 4 shards, and the shard count is a dynamic configuration variable that has changed over time. If the correct figure is 4 shards × 2 epochs/day = 8 snapshots/day, then the 4,380 annual epoch snapshots figure falls to ~2,920, and all storage volume calculations derived from it are overstated by roughly one-third.
- **"~118 TB archival total" and "108–113 TB is snapshot overhead"** — ❓ Unverified. These figures originate in the 2026-03-17 journal entry's LLM-produced storage analysis, which carries no primary source citation and no ❓🤖 SCRUTINY marker. The figures appear to be derived calculations (total archival size minus estimated transaction data), not direct measurements from NEAR's archival node operators. They should be treated as rough-order-of-magnitude estimates rather than authoritative numbers.
- **"~20 KB of snapshot overhead per transaction vs. ~1–2 KB for the transaction itself"** — ❓ Derived. This figure is calculated from the unverified 118 TB total and an estimated 5.25 billion total NEAR transactions, giving ~22 KB/tx total. The consistency of the arithmetic is verifiable; whether the input figures are accurate is not.
- **"500 TPS for one year, total nullifier data reaches ~1 TB" (Option C)** — ❓ Rough calculation. At 500 TPS with 2 nullifiers per transaction at 32 bytes each: 500 × 2 × 32 × 31,536,000 ≈ 1 TB. The arithmetic is plausible, but the 2-nullifiers-per-transaction assumption and 32-byte nullifier size are not cited.
- **"~1 KB: two 32-byte roots + proof" (Option H epoch account)** — ❓ Unsourced. The two Merkle roots at 32 bytes each are plausible, but the claim that the validity proof fits in the remaining ~900 bytes is optimistic for most deployed proof systems. The Midnight proof server is described elsewhere in the repository as generating "1–2 KB" proofs for a *single transaction*, not for an aggregated epoch proof, which would be expected to be equal or larger.
- **"ZSwap notes tend to be long-lived"** — ❓ Characterization without citation. Note lifetime in ZSwap is usage-dependent and no data is provided to substantiate this claim, which is load-bearing for the Option B ranking (ranked worst for storage partly on this basis).

### 4. Areas of Greatest Uncertainty

- **NEAR shard count.** The 12-snapshots/day figure rests on the assumption of 6 active shards. This is unconfirmed and affects every storage volume estimate in the ranking section.
- **The NEAR archival storage figures (118 TB, 108–113 TB snapshot portion).** These are LLM-generated estimates from March 2026 with no primary source. They have since been propagated into this and other assessments without acquiring citations or SCRUTINY markers. They are the foundation of the storage ranking's quantitative framing.
- **Validity proof size for an epoch aggregate (Option H).** The "~1 KB" account size claim requires that an aggregated epoch proof is compact; no proof system benchmarks or Midnight-specific proof aggregation schemes are cited.
- **ZSwap note longevity.** The statement that notes "tend to be long-lived" is unsubstantiated. If users sweep notes frequently, Option B's ranking improves considerably.
- **ProtoStar/ProtoGalaxy feasibility for Midnight circuits.** Mentioned as the solution for off-chain proof aggregation (Options H and E), these are cited with a 🛑 BLOCKER in other assessments but only as a passing reference here, with no acknowledgment of the open security questions.
- **The "naturally NEAR-like" pre-initialization friction for Options A and B.** The document notes "NEAR accounts require pre-initialization" as "the main tension" but does not analyse whether this is solvable, how costly it is, or whether it creates a meaningful throughput ceiling. This is left as a qualitative remark.

### 5. Robustness of Primary Conclusions

The document's two primary conclusions are:

1. *Options A and B rank highest for throughput by exploiting NEAR's native horizontal sharding.*
2. *Options H and E minimise on-chain storage but shift complexity to a bespoke off-chain sequencer/prover; Options C/D and H are most architecturally promising overall.*

Both are **robust with respect to the uncertainties**. The throughput ranking relies on verified NEAR properties (300 TGas limit, one-block cross-shard latency, horizontal sharding). The architectural insight that ZK-compression options move cost off-chain rather than eliminate it is a logical consequence of the design, not dependent on any quantitative claim.

The storage ranking is where the unverified figures are most load-bearing: if the shard count is 4 rather than 6, the absolute storage numbers fall by ~33%, but the *ordering* of options does not change — the relative penalties of monotonic on-chain growth still favour E and H for storage. The rankings are ordinal, not cardinal, and the ordinal results are robust to the numerical uncertainty.

The one conclusion that is qualitatively load-bearing: the Option B "Rank 1 worst for storage" verdict depends in part on ZSwap notes being long-lived. If notes cycle quickly, B's storage penalty shrinks materially, and it would move up the ranking given its throughput advantage. This is the single claim where an empirical finding could change a conclusion.
