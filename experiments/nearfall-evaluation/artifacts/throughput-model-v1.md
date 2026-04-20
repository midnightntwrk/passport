# 👱🤖 Throughput Model — Working Notes (v1)

> [!NOTE]
> 
> **Status:** Draft notes. The metric definitions are copied from [`assessments/throughput-constraint-comparison.md`](../assessments/throughput-constraint-comparison.md). The timing model and critique are exploratory and will be refined into a formal model in a later version.

---

## 1. Metric Definitions (from throughput-constraint-comparison.md §0)

### 1.1 Primary Metrics

**$\beta_\text{txs}$ — Transaction-bytes per second (T-B/s)**
The rate at which actual transaction payload bytes reach the ledger. This is the "useful" throughput from an application perspective — the bytes carrying user-authored state transitions. $\beta_\text{txs}$ excludes all block infrastructure overhead: headers, signatures, proofs of consensus, and any protocol-internal data.

**$\beta_\text{blk}$ — Block-bytes per second (BB/s)**
The total rate of block data that participants must store and propagate, including all overhead: block and chunk headers, consensus signatures, VRF proofs, erasure-coding parity shards, cross-shard receipts, state witnesses, and finality justifications. $\beta_\text{blk} \geq \beta_\text{txs}$ always; a high ratio indicates that protocol overhead dominates bandwidth and storage requirements.

**$\gamma_\text{txs}$ — Per-transaction compute-milliseconds per second (T-ms/s)**
The rate at which work that scales explicitly with transaction count is performed by validators, measured as total execution time (in milliseconds) per second of wall-clock time. This includes all operations whose aggregate cost grows proportionally with TPS: WASM contract execution, ZK proof verification, digital signature checks, nullifier set lookups, and commitment tree updates. $\gamma_\text{txs} = 1000$ ms/s means one full CPU core is consumed by per-transaction work.

**$\gamma_\text{blk}$ — Block-level processing-milliseconds per second (BL-ms/s)**
The rate at which work that does **not** scale with transaction count is performed, measured as total processing time (in milliseconds) per second of wall-clock time. This includes: consensus authority checks (AURA slot verification, GRANDPA finality signatures, BEEFY commitments), state and extrinsic root hashing, and MMR updates. $\gamma_\text{blk}$ is approximately constant regardless of TPS, representing the fixed overhead floor of block production and verification.

### 1.2 Contextual Measures

**$\Delta_\text{idle}$ — Network idle time (ms/s)**
The time per second that a validator node spends waiting on network I/O — blocked because the next block, chunk, or state witness has not yet arrived — rather than computing. Measured in ms/s for consistency with the $\gamma$ metrics. $\Delta_\text{idle}$ is the empirically observable complement of active computation: $\gamma_\text{txs} + \gamma_\text{blk} + \Delta_\text{idle}$ sums to approximately the slot budget. A high $\Delta_\text{idle}$ indicates the node is network-bound rather than compute-bound; faster hardware does not help.

**$\pi_\text{shard}$ — Shard parallelism (dimensionless)**
The number of independent compute streams executing in parallel across the network, each carrying its own $\beta_\text{txs}$, $\gamma_\text{txs}$, and $\gamma_\text{blk}$ budget. For single-chain protocols $\pi_\text{shard} = 1$; for sharded protocols aggregate throughput scales as $\pi_\text{shard} \times$ per-shard capacity. Node-level parallelism within a single shard (e.g. multi-core proof verification) can be captured by a separate $\pi_\text{core}$ factor; for current purposes $\pi_\text{shard}$ suffices.

### 1.3 Derived Ratios

**$\rho_\beta = \beta_\text{txs} / \beta_\text{blk}$ — Transaction payload fraction**
The fraction of block data occupied by actual transaction bytes. $0 < \rho_\beta \leq 1$; higher is better, indicating that most of the bandwidth cost is carrying user data rather than protocol overhead. A value of $\rho_\beta = 0.10$ means only 10% of what validators propagate and store is transaction payload.

**$\rho_\gamma = \gamma_\text{txs} / \gamma_\text{blk}$ — Per-transaction/block compute ratio**
The ratio of per-transaction compute to block-level fixed overhead. A high $\rho_\gamma$ means most node compute scales with transaction count; a low $\rho_\gamma$ means most compute is constant protocol overhead regardless of TPS. Unlike $\rho_\beta$, this ratio is not bounded by 1 — $\rho_\gamma > 1$ means per-transaction work exceeds fixed block overhead at the observed TPS. Used here as a casual indicator of the relative weight of the two compute categories.

### 1.4 Constraint Relationships

$$\beta_\text{blk} \geq \beta_\text{txs} \quad \Leftrightarrow \quad \rho_\beta \leq 1$$

$$\gamma_\text{txs} + \gamma_\text{blk} + \Delta_\text{idle} \leq \frac{1000\ \text{ms}}{T_\text{block}} \quad \text{(compute and idle time fit within the slot budget)}$$

$$\beta_\text{txs} \leq \frac{(B_\text{max} - B_\text{overhead}) \times \pi_\text{shard}}{T_\text{block}}$$

---

## 2. Proposed Timing Model

To connect the per-block byte and compute metrics to network propagation, a slot can be decomposed as follows.

Let:
- $\Delta_\text{slt}$ — time between slots (slot duration)
- $\Delta_\text{diff}$ — time "reserved" for block diffusion (network propagation of the block to all validators)
- $\Delta_\text{ver}$ — time "expected" for block-level fixed overhead (consensus authority checks, state root computation, MMR updates, etc. — work that scales with block count but **not** with transaction count; maps to $\gamma_\text{blk}$)

The simple model partitions the slot:

$$\Delta_\text{slt} = \Delta_\text{diff} + \Delta_\text{ver}$$

The **verification duty cycle** is then defined as:

$$\rho_\Delta = \frac{\Delta_\text{ver}}{\Delta_\text{slt}}$$

$\rho_\Delta \in (0, 1]$; a high duty cycle means most of the slot is available for block-level fixed overhead processing (large $\gamma_\text{blk}$ budget), leaving less margin for propagation. Note that per-transaction work ($\gamma_\text{txs}$, e.g. ZK proof verification) is not captured in $\Delta_\text{ver}$ — it belongs in $\Delta_\text{prod}$, the missing third term (see §3.3). The connection between $\Delta_\text{ver}$ and $\gamma_\text{blk}$ is approximately:

$$\gamma_\text{blk} \approx \rho_\Delta \times \frac{1000\ \text{ms}}{T_\text{block}}$$

The remaining fraction $(1 - \rho_\Delta)$ corresponds to $\Delta_\text{diff}$, which in this model is the upper bound on $\Delta_\text{idle}$: the time the node must wait for data before it can begin verifying. The slot budget identity therefore becomes:

$$\gamma_\text{txs} + \gamma_\text{blk} + \Delta_\text{idle} = \frac{1000\ \text{ms}}{T_\text{block}}$$

where $\Delta_\text{idle} \leq (1 - \rho_\Delta) \times 1000\ \text{ms} / T_\text{block}$. The slack is consumed by the production phase ($\Delta_\text{prod}$, see §3.3) and by pipelining effects (§3.4). In multi-shard architectures the per-shard budget scales by $\pi_\text{shard}$, but $\Delta_\text{idle}$ per shard is not reduced — each shard's validators still wait for their chunk's data independently.

---

## 3. Critique of the Proposed Model

### 3.1 Strengths

- The slot decomposition is intuitive and directly connects to the $\gamma_\text{blk}$ metric already in the framework.
- $\rho_\Delta$ is a useful dimensionless parameter that captures the propagation/verification trade-off as a single number.
- The model fits single-chain, single-producer protocols (Midnight/AURA, Cardano/Praos) cleanly and with minimal assumptions. Midnight is a particularly good fit: AURA's deterministic slot assignment (authority rotating round-robin) means the block producer identity is known one slot in advance, eliminating VRF-based slot probability calculations and allowing the slot budget to be treated as a fixed, fully-allocated window. The single chain with no shard hierarchy means $\pi_\text{shard} = 1$ and $\Delta_\text{slt}$ is unambiguous, unlike NEAR (§3.6).

### 3.2 Block Size Couples $\Delta_\text{diff}$ to $\beta_\text{blk}$

The model treats $\Delta_\text{diff}$ as a fixed reservation, but in any real network:

$$\Delta_\text{diff} \approx h \cdot \left(\frac{B_\text{block}}{W} + \ell\right)$$

where $h$ is gossip hop count, $W$ is inter-node bandwidth, and $\ell$ is per-hop latency. Increasing $B_\text{block}$ to raise $\beta_\text{txs}$ simultaneously increases $\Delta_\text{diff}$, which squeezes $\Delta_\text{ver}$ (and $\rho_\Delta$) within the fixed $\Delta_\text{slt}$. The two terms in the partition are not independent — the partition is itself a function of the design choices being optimised. This coupling is exactly what makes block size increases for Midnight hit a bandwidth ceiling: beyond ~5 MB blocks, $\Delta_\text{diff}$ grows faster than $\beta_\text{txs}$ improves.

For Midnight specifically, with $h = 3$, $W = 100$ Mbps, and $\ell = 100$ ms, the estimated diffusion time for a 5 MB block is $\Delta_\text{diff} \approx 700$ ms (see [`substrate-throughput-techniques.md` §5.1](../assessments/substrate-throughput-techniques.md)). At a 2 s slot this drives $\rho_\Delta \approx 0.65$, consuming 35% of the slot on propagation alone and leaving only ~1,300 ms for fixed overhead, production, and pipelining slack combined. The two-term model makes this coupling invisible by treating $\Delta_\text{diff}$ as a free parameter, not a function of $B_\text{block}$. Note also that this estimate assumes validators have TCP slow-start-after-idle disabled and appropriate socket buffer sizes (Appendix A of [`throughput-constraint-comparison.md`](../assessments/throughput-constraint-comparison.md)); without these, the effective $\Delta_\text{diff}$ at 5 MB is substantially higher (~700 ms additional for the congestion-window ramp-up alone). Switching the transport layer to QUIC (Appendix A of [`substrate-throughput-techniques.md`](../assessments/substrate-throughput-techniques.md)) would structurally remove the slow-start penalty, reducing $\Delta_\text{diff}$ and partially restoring $\rho_\Delta$.

### 3.3 Block Production Is a Missing Third Term

The slot budget is consumed by three activities, not two:

$$\Delta_\text{slt} = \Delta_\text{prod} + \Delta_\text{diff} + \Delta_\text{ver}$$

$\Delta_\text{prod}$ is the time the block producer spends executing transactions and building the new state root. For NEAR, this is the chunk production time (WASM execution + trie writes — the $\gamma_\text{txs}$ component). For Midnight, contract execution is client-side, but the block producer still applies public transcripts to state and runs the Plonk verifier for each included transaction. Omitting $\Delta_\text{prod}$ either conflates production cost into $\Delta_\text{ver}$ or silently assumes it is zero, which is only safe for the verifier-side analysis.

For Midnight, the omission is nearly valid at current scale but grows with TPS. At 3.3 TPS (current): $\Delta_\text{prod} \approx 3.3 \times 3.43\ \text{ms} \approx 11\ \text{ms}$ per 6 s block — 0.2% of the slot, genuinely negligible. At the $\gamma_\text{txs}$ ceiling without folding (49 TPS): $\Delta_\text{prod} \approx 49 \times 3.43\ \text{ms} \approx 168\ \text{ms}$ per block — 2.8% of a 6 s slot, still small. With 10× ProtoGalaxy folding and 2 s slots targeting ~500 TPS: $\Delta_\text{prod} \approx 500 \times 0.343\ \text{ms} \approx 171\ \text{ms}$ per block — 8.6% of the 2 s slot, now non-trivial. The two-term model's error grows as slot time shrinks and proof folding increases throughput; the missing $\Delta_\text{prod}$ term becomes a meaningful overestimate of the remaining $\rho_\Delta$ budget at the high-TPS operating points this study targets.

### 3.4 The Sequential Assumption Is Violated by Pipelining

In practice, diffusion and verification overlap: nodes begin verifying a block as the first bytes arrive (streaming verification), and the next block producer begins building on an unfinalized tip. Cardano's Praos protocol formalises $\Delta$ (the diffusion bound) as a *worst-case security parameter* — an upper bound on the time any honest node can be ignorant of a newly minted block — not as a phase that must complete before verification begins. The additive model is conservative; actual latency tolerance is better modelled by the security parameter analysis of the underlying consensus protocol, not a deterministic time budget.

For Midnight, however, streaming verification is structurally limited by the nature of ZK proofs. A Plonk/KZG proof is an atomic cryptographic object — the pairing check that constitutes verification requires the entire proof to be present before any meaningful work can begin. Unlike a block of UTXO transactions where signature checks can proceed on each transaction as it arrives, Midnight's per-transaction ZK proofs cannot be partially verified. This means the pipelining benefit in §3.4 applies to $\Delta_\text{ver}$ ($\gamma_\text{blk}$: AURA slot check, state root, GRANDPA) but not to $\Delta_\text{prod}$ ($\gamma_\text{txs}$: per-proof verification). The sequential model is therefore a closer approximation to Midnight's reality than to chains with divisible verification work, and the additive conservatism of the two-term model understates this structural constraint rather than overstating it. AURA's deterministic slot assignment does provide one real pipelining opportunity: the next block producer is known one slot ahead, allowing it to begin mempool preparation and state prefetching while the current block is still propagating.

### 3.5 $\Delta_\text{diff}$ Is a Probabilistic Bound, Not a Deterministic Allocation

A reserved slot window implies the protocol guarantees diffusion completes within that window. Real p2p gossip does not provide this guarantee deterministically. Protocols cope in two ways: (a) set $\Delta_\text{diff}$ conservatively large enough that diffusion succeeds with overwhelming probability (sacrificing $\rho_\Delta$), or (b) tolerate occasional diffusion failures and handle them via fork choice rules. The distinction matters for security analysis: $\rho_\Delta$ is not a pure efficiency parameter but is entangled with the honest-majority threshold of the consensus protocol.

For Midnight, the probabilistic nature of $\Delta_\text{diff}$ has a second-order consequence through GRANDPA. GRANDPA finalises a block only after collecting votes from more than 2/3 of weighted validators. Validators that have not yet received the block — because their personal $\Delta_\text{diff}$ exceeded the slot window — cannot cast a GRANDPA vote for it. An overrun of $\Delta_\text{diff}$ therefore does not merely produce a fork or empty slot; it delays the GRANDPA finality round, extending the uncertainty window for every block currently awaiting finalisation. At 5 MB blocks with a heterogeneous validator set, validators at the 10th percentile of bandwidth (~20–30 Mbps) face $\Delta_\text{diff} \approx 2$–$3$ s — longer than a 2 s slot — causing them to systematically lag one block behind and withhold their GRANDPA votes from the current round. The model's single scalar $\rho_\Delta$ does not represent this distribution; it implicitly assumes all validators share the same $\Delta_\text{diff}$, which is false in any geographically distributed validator set.

### 3.6 NEAR's Two-Level Structure Makes "Slot Time" Ill-Defined Here

NEAR has both a chunk slot (~600 ms, per-shard) and a block aggregation step (~1 s). Chunk producers, chunk validators, and block producers each have different effective $\Delta_\text{slt}$, $\Delta_\text{diff}$, and $\Delta_\text{ver}$. The model fits single-chain, single-producer protocols naturally; applying it to NEAR requires choosing which level of the hierarchy to model, and the answer differs for chunk validation vs. block aggregation.

Midnight sits at the opposite extreme from NEAR in this regard: a single chain, a single block producer per slot, and a single unambiguous $\Delta_\text{slt}$ (the AURA slot duration). The model applies cleanly to Midnight's production timing. However, Midnight introduces its own two-timescale subtlety through GRANDPA: AURA defines $\Delta_\text{slt}$ for block *production*, but GRANDPA finalises blocks 2–3 production slots behind the tip, operating on a separate round-trip timescale. The two-term model describes when a block is produced and propagated but says nothing about when it is *finalised*. For applications that wait for finality (bridges, settlement layers, the cNIGHT ↔ mNIGHT bridge), the relevant latency is not $\Delta_\text{slt}$ but $\Delta_\text{slt} \times$(finality lag in blocks), which is not represented in $\rho_\Delta$. At higher TPS with shorter slots, the count of unfinalized blocks at any moment increases, amplifying this gap between production timing and finality timing.

### 3.7 $\Delta_\text{prod}$ Conflates Structurally Different Costs

Under the three-term model (§3.3), $\Delta_\text{prod}$ captures all per-transaction production work, but the cost structure of this term differs fundamentally between the two chains. For NEAR, $\Delta_\text{prod}$ is dominated by WASM execution (Turing-complete re-execution at near-native speed) interleaved with trie reads (RocksDB random access), with chunk validators also re-executing WASM against a state witness rather than full trie state. For Midnight, $\Delta_\text{prod}$ is dominated by Plonk/KZG proof verification (~3.43 ms per transaction) — a fixed-cost cryptographic operation rather than Turing-complete execution; the computational complexity of the contract is entirely in the prover (client-side), not the verifier (validator-side).

These two cases are structurally different: NEAR's $\Delta_\text{prod}$ scales with contract complexity and instruction count (Turing-complete re-execution); Midnight's $\Delta_\text{prod}$ is approximately constant per proof regardless of contract complexity (fixed-cost verification). A single $\Delta_\text{prod}$ term in the slot budget does not capture this distinction — it obscures the fact that NEAR's per-transaction cost is workload-dependent while Midnight's is nearly workload-independent (modulo the number of public inputs per proof).

By contrast, $\Delta_\text{ver}$ ($\gamma_\text{blk}$) is structurally similar for both chains — a small constant per block for consensus authority checks and state root computation, approximately independent of transaction count and workload type. $\rho_\Delta$ therefore captures the propagation/fixed-overhead trade-off cleanly, but says nothing about the per-transaction cost structure embedded in $\Delta_\text{prod}$.

---

## 4. Toward a Revised Model

A natural extension that addresses critiques 3.2 and 3.3 is:

$$\beta_\text{txs} = \frac{\rho_\beta \cdot B_\text{block}}{\Delta_\text{slt}} = \frac{\rho_\beta \cdot B_\text{block}}{\Delta_\text{prod}(B_\text{block}) + \Delta_\text{diff}(B_\text{block}) + \Delta_\text{ver}(B_\text{block})}$$

This makes explicit that $\beta_\text{txs}$ is not linear in $B_\text{block}$ once each term's dependence on block size is accounted for — the common failure mode of naive block-size scaling arguments. The three-term denominator maps cleanly onto the full metric framework:

| Slot term | Drives | Notes |
|---|---|---|
| $\Delta_\text{prod}$ | $\gamma_\text{txs}$ | Per-transaction work: WASM execution + trie writes (NEAR); ZK proof verification per transaction (Midnight) |
| $\Delta_\text{diff}$ | $\Delta_\text{idle}$, $\beta_\text{blk}$ | Waiting for data; $\Delta_\text{diff}(B_\text{block})$ couples byte and time budgets |
| $\Delta_\text{ver}$ | $\gamma_\text{blk}$ | Block-level fixed overhead: consensus sig checks, state root, MMR; approximately constant per block |

The $\pi_\text{shard}$ factor enters at the network level, not the per-slot level: $\pi_\text{shard}$ parallel slots each run their own $(\Delta_\text{prod}, \Delta_\text{diff}, \Delta_\text{ver})$ budget, so aggregate $\beta_\text{txs}^\text{total} = \pi_\text{shard} \cdot \beta_\text{txs}^\text{per-shard}$. Crucially, $\Delta_\text{idle}$ per shard is not reduced by adding shards — it reflects the latency each shard's validators face independently.

Open questions for the next version of this model:
- How to handle pipelining between $\Delta_\text{prod}$, $\Delta_\text{diff}$, and $\Delta_\text{ver}$ (critique §3.4)
- Whether $\rho_\Delta$ has a natural security lower bound (minimum safe diffusion fraction)
- How to extend the single-chain model to NEAR's two-level chunk/block hierarchy (critique §3.6)
- Empirical calibration of $\Delta_\text{diff}(B_\text{block})$ and $\Delta_\text{idle}$ for both Midnight and NEAR
- Whether $\pi_\text{core}$ (intra-node parallelism, e.g. batched proof verification on GPU) warrants a separate term alongside $\pi_\text{shard}$

---

## 5. Prospects for a Formal Constraint Model

### 5.1 The Core Reduces to a Quadratic

Substituting $\text{TPS} = \beta_\text{txs} / s_\text{tx}$ into the three-term slot identity and using $T_\text{block} = \rho_\beta B_\text{block} / \beta_\text{txs}$ yields a quadratic in $\beta_\text{txs}$. Let:

- $a = c_\text{proof} / (s_\text{tx} \cdot k_\text{fold})$ — the $\Delta_\text{prod}$ coefficient (proof cost per byte of throughput)
- $d = h(B_\text{block}/W + \ell) + c_\text{blk}$ — the network and fixed overhead sum ($\Delta_\text{diff} + \Delta_\text{ver}$), independent of $\beta_\text{txs}$

Then:

$$a \cdot \beta_\text{txs}^2 + d \cdot \beta_\text{txs} - \rho_\beta B_\text{block} = 0$$

The positive root gives the achievable throughput in closed form:

$$\boxed{\beta_\text{txs} = \frac{-d + \sqrt{d^2 + 4a\rho_\beta B_\text{block}}}{2a}}$$

This is an exact expression for $\beta_\text{txs}$ as a function of design parameters $(B_\text{block},\, k_\text{fold})$ and empirical parameters $(W,\, h,\, \ell,\, c_\text{proof},\, s_\text{tx})$; a spreadsheet suffices for single-point evaluation. The two limiting cases are illuminating:

- When $d \gg a \cdot \beta_\text{txs}$ (network-dominated): $\beta_\text{txs} \approx \rho_\beta B_\text{block} / d$ — throughput is set entirely by block size and diffusion time, independent of proof cost. Increasing $k_\text{fold}$ has no effect.
- When $a \cdot \beta_\text{txs} \gg d$ (compute-dominated): $\beta_\text{txs} \approx \sqrt{\rho_\beta B_\text{block} / a}$ — throughput scales as $\sqrt{k_\text{fold}}$. Doubling the block size gives $\sqrt{2}$ more throughput, not $2\times$.

A constraint solver or numerical optimizer adds value for three tasks the closed form cannot address: multi-objective optimisation (maximise $\beta_\text{txs}$, minimise finality lag, subject to security and safety constraints simultaneously), feasibility sweeps over ranges of the empirical parameters, and sensitivity analysis of $\beta_\text{txs}$ to each parameter at a given operating point.

### 5.2 TCP/QUIC Does Not Break the Model

The $\Delta_\text{diff}$ term is well-approximated by a linear bandwidth-delay product:

$$\Delta_\text{diff} = h\!\left(\frac{B_\text{block}}{W} + \ell\right) + \delta_\text{cwnd}$$

where $\delta_\text{cwnd} = 0$ for QUIC or properly tuned TCP (`tcp_slow_start_after_idle = 0`, BBR + FQ), and $\delta_\text{cwnd} \approx 700$ ms at 5 MB blocks on default Linux (the congestion-window ramp-up penalty from §3.2). This is a binary correction to a linear term, not a structural non-linearity. Once TCP is tuned, the $\Delta_\text{diff}$ formula for QUIC and TCP is identical and the correction vanishes from the model.

For 5 MB blocks where $B_\text{block}/W \approx 400$ ms at 100 Mbps (many round-trip windows), the initial CWND difference between QUIC (~32 MSS) and tuned TCP is less than 5% of $\Delta_\text{diff}$ — negligible in the model. QUIC's structural advantages for Midnight — stream-independence isolating GRANDPA messages from concurrent block transfers, and the structural elimination of the slow-start cause — affect finality latency and operational robustness rather than $\beta_\text{txs}$ directly. They belong in a separate finality model, not this throughput equation.

### 5.3 Parameters for an Actionable Model

Ten quantities fully determine the Midnight design space:

| Role | Parameter | Symbol | Midnight value / range |
|---|---|---|---|
| Decision | Block size | $B_\text{block}$ | 200 KB → 5 MB |
| Decision | Slot time | $T_\text{block}$ | 6 s → 2–3 s |
| Decision | ProtoGalaxy fold factor | $k_\text{fold}$ | 1 → 10 |
| Empirical | 67th-percentile validator bandwidth | $W_{p67}$ | ~30–100 Mbps |
| Empirical | Gossip hop count | $h$ | ~3 |
| Empirical | Per-hop propagation latency | $\ell$ | 50–100 ms |
| Empirical | Proof verification cost | $c_\text{proof}$ | ~3.43 ms |
| Empirical | Average transaction size | $s_\text{tx}$ | ~10 KB |
| Empirical | Block-level fixed overhead | $c_\text{blk}$ | ~5 ms/block |
| Security | Max diffusion fraction of slot | $\alpha$ | 0.35–0.50 |

The bandwidth parameter is $W_{p67}$ rather than the median: GRANDPA requires >2/3 of stake-weighted validators to receive the block within the slot, making the 67th-percentile bandwidth the effective capacity floor for finality. Using median bandwidth would overestimate the safe operating envelope.

### 5.4 Design Space Questions the Model Answers

With these ten quantities the model directly resolves the primary design-space questions:

**Which constraint binds?** The transition from $\Delta_\text{diff}$-dominated to $\Delta_\text{prod}$-dominated throughput is visible in the quadratic coefficients: when $d \gg a \cdot \beta_\text{txs}$, the network is the bottleneck; when $a \cdot \beta_\text{txs} \gg d$, proof verification is. Without folding, the transition occurs at ~49 TPS; with 10× folding it shifts beyond the byte ceiling.

**Is (5 MB, 2 s) safe?** Compute $\Delta_\text{diff}/T_\text{block} = 700/2000 = 35\%$ and compare against $\alpha$. The point is on the boundary at $\alpha = 0.35$; (5 MB, 3 s) gives $\approx 23\%$, safely within the envelope.

**What $k_\text{fold}$ is required at a target TPS?** Invert the quadratic: solve for $k_\text{fold}$ such that $a(k_\text{fold}) \cdot \beta_\text{target}^2 + d \cdot \beta_\text{target} = \rho_\beta B_\text{block}$. This is closed-form.

**How sensitive is $\beta_\text{txs}$ to validator bandwidth?** Differentiate the closed form with respect to $W$ at the operating point. Sensitivity is highest in the $\Delta_\text{diff}$-dominated regime and nearly zero in the $\Delta_\text{prod}$-dominated regime — folding reduces bandwidth sensitivity as a side effect.

**What does GRANDPA finality cost?** Extend with $T_\text{finality} = T_\text{block} \times n_\text{lag}$, where $n_\text{lag}$ is blocks behind tip at steady state. Shorter slots reduce per-block latency but increase $n_\text{lag}$ (more unfinalized blocks accumulate per GRANDPA round trip), so $T_\text{finality}$ may be non-monotone in $T_\text{block}$ — a non-obvious trade-off the model makes explicit.

### 5.5 Accuracy Limitations

The model is adequate for design-space exploration at the level of precision required here but has four bounded sources of error:

1. **Single-percentile bandwidth**: Collapsing the validator bandwidth distribution to $W_{p67}$ loses tail behaviour. The 10th-percentile validator at 20–30 Mbps faces $\Delta_\text{diff} \approx 2$–3 s at 5 MB — a finality stall that a single-$W$ model cannot represent. A two-parameter model ($W_{p67}$ for throughput, $W_{p10}$ for finality stall risk) would capture this.

2. **$\Delta_\text{prod}$ error growth**: As shown in §3.3, the missing $\Delta_\text{prod}$ term in the two-term model grows from 0.2% of the slot at current TPS to 8.6% at (500 TPS, 2 s, 10× folding). The quadratic in §5.1 incorporates $\Delta_\text{prod}$ directly and avoids this error entirely.

3. **Empirical calibration of $h$, $W_{p67}$, $\ell$**: These are assumed from typical validator network assumptions, not measured on the live Midnight network. A 2× error in $W_{p67}$ propagates as a ~2× error in $\Delta_\text{diff}$ at large block sizes. Network measurement is the highest-value empirical task for improving model accuracy; without it, the model gives order-of-magnitude guidance, not engineering tolerances.

4. **Proof-aggregation overhead**: The model assumes a folded proof costs the same to verify as a single proof ($c_\text{proof}$ is constant in $k_\text{fold}$). For IVC schemes the verification key grows with $k_\text{fold}$, adding a sub-linear cost $c_\text{fold}(k)$ to $\Delta_\text{prod}$. This should be measured before committing to large fold factors.

### 5.6 Verdict

🧪 **HYPOTHESIS**: The three-term slot model with $\Delta_\text{diff} = h(B/W + \ell) + \delta_\text{cwnd}$ is sufficient accuracy for Midnight throughput design-space exploration. The model yields a closed-form $\beta_\text{txs}$ as a function of ten well-defined parameters; a constraint solver adds value for multi-objective optimisation and sensitivity sweeps but is not required for the primary feasibility questions. TCP/QUIC transport details do not make the model intractably complex — they reduce to a single binary correction term ($\delta_\text{cwnd}$) that is zero under either QUIC or properly tuned TCP. The dominant source of model uncertainty is the unmeasured distribution of validator bandwidth, which is an empirical question answerable by instrumenting the live Midnight network, not a modelling difficulty.
