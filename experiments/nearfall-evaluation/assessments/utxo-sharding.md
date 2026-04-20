# 🤖 Sharding in UTXO-Based Blockchains: Approaches, Strengths, and Weaknesses

**Scope:** This document surveys the major approaches to sharding UTXO-based blockchains, covering academic proposals, production systems, and the specific constraints that apply to ZK-UTXO chains such as Midnight. It is motivated by the question of whether L1 sharding is a viable throughput path for Midnight, and concludes that proof folding is a more appropriate lever given Midnight's ZK architecture.

> [!NOTE]
>
> ❓🤖 **SCRUTINY — production TPS figures are from published sources and project documentation; they have not been independently benchmarked.** The Alephium BlockFlow claim (~20,000 TPS) and the OmniLedger/Kronos security properties are taken from the cited papers and should be verified against current implementations before use in architectural decisions.

---

## 1. The Core Challenge Specific to UTXO

In an account model, a transaction mutates a single account's state — shard assignment is simply "which shard owns this account." In UTXO, a transaction *consumes* inputs from potentially any prior output and *creates* new outputs assigned to recipient addresses. If an input UTXO lives in shard A and the recipient address belongs to shard B, the transaction spans two shards and must be atomic: either both the input is destroyed and the output is created, or neither happens.

Getting this atomicity right without a global coordinator is the central problem of UTXO sharding. It does not arise in the same form in account-model sharding (such as NEAR's Nightshade), where cross-shard transactions are asynchronous receipts that trigger state mutations in the destination shard without requiring backward acknowledgement to the source.

---

## 2. Major Approaches

### 2.1 Two-Phase Commit (OmniLedger / Kronos Pattern)

**Mechanism:**

1. The input shard *locks* the UTXO, making it unspendable by any other transaction, and issues a proof-of-lock.
2. The output shard creates the new UTXO only after verifying the proof-of-lock.
3. Both shards acknowledge completion; the lock is released.
4. If either shard fails within a timeout, the lock expires and the UTXO is returned to spendable state.

**Strengths:**
- Provably atomic; the security properties are formally analysed in OmniLedger (2018) and Kronos (NDSS 2025).
- General — applicable to any UTXO chain regardless of script language.

**Weaknesses:**
- Two inter-shard round-trips per cross-shard transaction; latency is proportional to inter-shard RTT.
- Liveness depends on both shards being available simultaneously; a slow or partitioned output shard blocks input shard liveness.
- Vulnerable to replay attacks (Byzcuit, Sonnino et al.): a transaction accepted by the input shard can be replayed in the output shard unless shard IDs and sequence numbers are embedded in the transaction hash.

---

### 2.2 Address-Group / Input-Output Sharding

**Mechanism:** Addresses are pre-assigned to one of G groups. Transactions are routed to the shard responsible for the (input-group, output-group) pair. With G groups there are G² possible transaction shards. Transactions whose inputs and outputs share the same group are entirely intra-shard.

**Strengths:**
- Reduces cross-shard traffic when address usage is naturally clustered (e.g. enterprise deployments with well-known counterparties).
- Simple routing logic.

**Weaknesses:**
- G² shard explosion becomes unmanageable at large G.
- Address group assignment is static; hot spots develop as usage patterns shift and cannot be corrected without reassigning addresses.
- Uneven load distribution has no clean dynamic mitigation.

---

### 2.3 Alephium BlockFlow (Production UTXO Sharding)

**Mechanism:** The only significant production UTXO sharding system as of 2026. Addresses are assigned to one of G groups (G = 4 on mainnet). Each (from-group, to-group) pair has its own blockchain — G² = 16 chains. Each chain is a standard eUTXO ledger. Cross-group transactions are coordinated by DAG dependency ordering: a block in chain (A→B) must reference the most recent blocks from all chains (A→\*) and (\*→B), establishing causal ordering that prevents double-spends without a two-phase locking protocol.

**Strengths:**
- No explicit locking or two-phase commit — the DAG dependency ordering *is* the coordination mechanism.
- Single-step cross-group UX; the user submits one transaction, not two.
- ~20,000 TPS on mainnet with 4 groups.
- The eUTXO model makes dependency tracking tractable.

**Weaknesses:**
- G² chains means quadratically more chains as G increases; fork resolution overhead grows with G².
- G is currently fixed at 4; dynamic resharding is theoretically possible but not deployed.
- Load imbalance between groups has no clean mitigation without address reassignment.

---

### 2.4 Parallel Execution (Intra-Shard, Not True Sharding)

**Mechanism:** Within a single chain, UTXOs that share no inputs are fully independent and can be verified in parallel across CPU cores. A dependency graph identifies conflicting transactions and serialises only those; non-conflicting transactions execute simultaneously.

**Strengths:**
- Zero cross-shard complexity — there is one consensus and one global UTXO set.
- Native to the UTXO model: transaction independence is a first-class property.
- Directly applicable to Midnight: ZK proofs for independent transactions can be verified on separate cores.

**Weaknesses:**
- Throughput is bounded by total hardware capacity of a single validator set.
- Does not address block-size or propagation constraints — the β_txs ceiling is unchanged.

---

### 2.5 State Channels / Hydra (L2, Not L1 Sharding)

**Mechanism:** A subset of the UTXO state is moved off-chain into a multi-party state channel. Participants transact within the channel at arbitrary speed; only the opening and closing transactions touch L1. Cardano's Hydra Head protocol is *isomorphic* — the Head runs the same eUTXO/Plutus rules as the main chain. Multiple Heads scale linearly.

**Strengths:**
- No L1 changes required; composability within a Head is identical to mainnet.
- Linear scalability: each additional Head adds independent throughput capacity.
- Finality within a Head is instant (unanimous consent of participants).

**Weaknesses:**
- All participants must be online and cooperative; a single offline party stalls or closes the Head.
- Liquidity is fragmented across Heads; cross-Head transactions require L1 settlement.
- Not useful for open public transaction flows — requires a known, bounded participant set.

---

### 2.6 Stateless Validation with State Witnesses (Transferable Idea from NEAR)

**Mechanism:** NEAR's Nightshade 2.0 (NEP-0509) has chunk producers emit a *state witness* — Merkle proofs for every state element read or written — alongside each chunk. Validators verify the witness without storing the full shard state. The concept transfers to UTXO: a block producer could include UTXO inclusion proofs for every input spent, enabling validators to verify the block without maintaining the full UTXO set.

**Strengths:**
- Reduces per-validator storage requirements dramatically.
- Enables larger, more decentralised validator sets.
- Orthogonal to the sharding question — applicable to a single-shard chain.

**Weaknesses:**
- State witnesses are large: every input requires a Merkle proof against the UTXO commitment tree.
- Bandwidth increases substantially; the block producer bears significant witness-generation overhead.
- Not yet deployed on any production UTXO chain.

---

## 3. Cross-Shard Double-Spend Prevention: The Key Security Property

All UTXO sharding schemes must address the same core security requirement: an input UTXO must not be spendable in more than one transaction, even across shards. The principal mechanisms are:

| Mechanism | How it prevents double-spend | Risk |
|-----------|------------------------------|------|
| **Two-phase lock** | Input locked before output created; timeout reverts | Lock can be exploited by slow/adversarial output shard |
| **DAG causal ordering** (BlockFlow) | Cross-shard blocks must reference prior blocks from both groups | Requires all G² chains to make progress |
| **Replay-attack prevention** (Byzcuit) | Shard IDs and sequence numbers embedded in tx hash | Must be enforced by all shards |
| **State witness** | Validators verify UTXO inclusion proof in block | Block producer must include proofs honestly |

---

## 4. Specific Constraints for ZK-UTXO Chains

Midnight adds a dimension that makes L1 sharding harder than for plain UTXO chains: **ZK proof verification is atomic and indivisible.** A Plonk/KZG proof must be verified in full before the transaction can be accepted; it cannot be split across shards or partially verified. This means:

- Sharding multiplies the *number of transactions* processed system-wide, but does not reduce the *per-transaction verification burden* on any individual shard's validators.
- In a plain UTXO chain, sharding reduces each validator's work because each shard handles a fraction of the UTXO set and signature checks. In Midnight, each shard's validators must each verify each ZK proof in full — the γ_txs cost per shard is unchanged.
- The parallel execution approach (§2.4) applies within a shard and does reduce total verification time on multi-core hardware, but this is intra-node parallelism, not sharding.

**The implication:** for Midnight, proof folding (ProtoGalaxy) is a more appropriate scaling lever than L1 sharding. Folding reduces the per-transaction ZK verification cost globally — a 10× fold factor reduces γ_txs by 10× for all validators simultaneously — whereas sharding distributes an undiminished cost across more validators without reducing it.

---

## 5. Comparison Table

| Approach | Atomicity mechanism | Cross-shard latency | Composability | Production example | Applicable to Midnight? |
|---|---|---|---|---|---|
| Two-phase commit | Lock → proof-of-lock → create | 2 inter-shard RTTs | Poor | OmniLedger / Kronos (academic) | Theoretically, but adds coordination overhead without reducing ZK cost |
| BlockFlow (Alephium) | DAG causal ordering | 0 explicit rounds | Good (single-step) | Alephium mainnet | Not directly — requires address-group assignment architecture |
| Address-group sharding | Shard routing + two-phase | Varies | Moderate | Research prototypes | Not directly |
| Parallel execution | None needed (intra-shard) | N/A | Excellent | Most UTXO chains | ✅ Already applicable within a single Midnight chain |
| State channels / Hydra | L1 settlement on open/close | L1 finality on open/close | Excellent within channel | Cardano (testnet) | ✅ Applicable as L2 (Midnight City pattern) |
| Stateless validation | Merkle witness per input | N/A (single chain) | Excellent | NEAR (account model) | Transferable idea; reduces validator storage but not ZK cost |

---

## 6. Conclusion for Midnight

Native L1 UTXO sharding is not the appropriate throughput path for Midnight in the near to medium term, for three reasons:

1. **ZK proof verification is not divisible by sharding.** Unlike signature checks, a Plonk/KZG proof cannot be partitioned; every shard's validators pay the full verification cost.
2. **The binding constraint is block size, not validator count.** At current parameters, Midnight is β_txs limited (block propagation), not γ_txs limited (compute). Sharding addresses the compute side; the propagation side requires block-parameter changes.
3. **Proof folding dominates.** ProtoGalaxy 10× folding reduces the per-transaction ZK cost for all validators simultaneously, which is strictly better than sharding at constant hardware cost.

The sharding concepts most relevant to Midnight's roadmap are:

- **Parallel execution** (§2.4) — immediately applicable for multi-core ZK proof verification within a single node.
- **State channels / Hydra** (§2.5) — the Midnight City L2 pattern for high-frequency workloads.
- **Stateless validation** (§2.6) — a longer-term option to reduce validator storage requirements as the UTXO commitment tree grows.

---

## Sources

1. **OmniLedger** — Kokoris-Kogias, E. et al. "OmniLedger: A Secure, Scale-Out, Decentralized Ledger via Sharding." IEEE S&P 2018. [eprint.iacr.org/2017/406](https://eprint.iacr.org/2017/406.pdf).
2. **Kronos** — "Kronos: A Secure and Generic Sharding Blockchain Consensus." NDSS 2025. [ndss-symposium.org](https://www.ndss-symposium.org/wp-content/uploads/2025-472-paper.pdf). Also [eprint.iacr.org/2024/206](https://eprint.iacr.org/2024/206.pdf).
3. **Byzcuit / Replay Attacks** — Sonnino, A. et al. "Replay Attacks and Defenses Against Cross-shard Consensus in Sharded Distributed Ledgers." [sonnino.com/papers/byzcuit.pdf](https://sonnino.com/papers/byzcuit.pdf).
4. **SoK: Sharding on Blockchain** — [eprint.iacr.org/2019/1178](https://eprint.iacr.org/2019/1178.pdf).
5. **SoK: Public Blockchain Sharding** — [par.nsf.gov/servlets/purl/10525134](https://par.nsf.gov/servlets/purl/10525134).
6. **Alephium BlockFlow** — "An introduction to Blockflow: Alephium's sharding algorithm." [medium.com/@alephium](https://medium.com/@alephium/an-introduction-to-blockflow-alephiums-sharding-algorithm-bbbf318c3402).
7. **eUTXO Sharding Security Analysis** — Bournemouth University. "Security Analysis of Blockchain Layer-one Sharding based Extended-UTxO Model." [eprints.bournemouth.ac.uk/38824](https://eprints.bournemouth.ac.uk/38824/1/Springer_Lecture_Notes_in_Computer_Science-3%20(1).pdf).
8. **Cardano Hydra** — [hydra.family/head-protocol](https://hydra.family/head-protocol/docs/dev/scalability). The isomorphic eUTXO state channel protocol.
9. **NEAR NEP-0509 Stateless Validation** — [github.com/near/NEPs](https://github.com/near/NEPs/blob/master/neps/nep-0509.md). The state witness design transferable to UTXO chains.
10. **[`throughput-hypotheses.md`](throughput-hypotheses.md)** — §2.7 (ProtoGalaxy as ceiling unlocker). Internal.
11. **[`batching-vs-folding.md`](batching-vs-folding.md)** — ProtoGalaxy vs batch verification comparison. Internal.
12. **[`substrate-throughput-techniques.md`](substrate-throughput-techniques.md)** — §2 (throughput levers available in Substrate). Internal.
