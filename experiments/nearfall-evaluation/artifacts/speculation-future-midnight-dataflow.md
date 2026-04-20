# 👱🤖 Speculative: Future Midnight Data Flow with Starstream, Nightstream, and Paima

**Date:** 2026-04-07
**Based on:** [`assessments/starstream-nightstream.md`](../assessments/starstream-nightstream.md), [`assessments/paima-on-midnight.md`](../assessments/paima-on-midnight.md)

---

> [!WARNING]
>
> **This document is speculative.** It describes an envisioned future architecture, not the current state of Midnight. Two hard blockers prevent any of the Starstream/Nightstream integration from being runnable today:
>
> - 🛑 **Starstream has no blockchain integration** — no WASM ABI for UTXO interaction, no VM pallet, no mockchain runner. It is a compiler only.
> - 🛑 **Nightstream has no finalizer** — without it, Nightstream emits matrix evaluation obligations that cannot be compressed into a blockchain-verifiable proof.
>
> Additionally, the **`neo-midnight-bridge`** — the adapter crate that translates Nightstream's Goldilocks-field IVC output into a Midnight-native BLS12-381 proof — **existed but was removed on 2026-03-28** when the `neo-fold` stack it depended on was deprecated in favour of `neo-fold-next`. It was a real, working proof-of-concept (PRs #74 and #80, merged January–February 2026, authored by Nico Arqueros/dcSpark), confirmed to work against Midnight's actual BLS12-381 SRS. Its removal was a dependency-cleanup measure, not a technical rejection. Whether a successor bridge targeting `neo-fold-next` will be built is unknown. A further uncertainty: the current Nightstream system architecture document indicates Spartan/FRI — not PLONK/KZG — as the intended outer proof, which would make a BLS12-381 PLONK bridge unnecessary. The IOG paper IACR ePrint 2025/695 ("Efficient Foreign-Field Arithmetic in PLONK") provides the mathematical foundation for the approach.
>
> The only runnable version of Paima on Midnight today is **Approach 1** (public layer only): a Compact contract + Midnight funnel, no ZK-proven execution, no Starstream, no Nightstream.

---

## Paima Integration Approaches

Paima can integrate with Midnight at three levels of ambition, defined in [`assessments/paima-on-midnight.md`](../assessments/paima-on-midnight.md):

**Approach 1 — Public layer only** *(tractable now, weeks of work)*
Write a Compact contract that accepts encoded Paima inputs as public data and orders them on-chain. Write a Midnight funnel that reads Midnight's GraphQL indexer and maps UTXO/intent events to Paima's unified input format. Midnight's privacy layer is entirely unused.

**Approach 2 — Selective ZK attestations** *(hard)*
Extend Approach 1 so that some Paima inputs are ZK-attested facts about shielded Midnight state (e.g., "this player owns at least N tokens of type T"). The Paima state machine accepts these attestations as trusted inputs. Requires defining an attestation interface between Midnight's ZK layer and Paima's state machine — no existing Paima funnel does this.

**Approach 3 — ZK-proven execution, Midnight as DA/settlement** *(blocked — research scale)*
Use Midnight's unshielded layer purely for input ordering and data availability. Run the Paima state machine off-chain, then submit a ZK proof of correct execution to a Midnight contract for settlement. This is the pattern described in the data flow below — and it is contingent on Nightstream's finalizer being complete and `neo-midnight-bridge` being production-ready. Blocked on two open infrastructure problems in sequence.

The **practical near-term recommendation** is Approach 1 extended toward Approach 2. Approach 3 is a longer-term research goal.

---

## How the Three Items Relate

**Starstream and Nightstream are a coupled pair** from the same organisation (LFDT-Nightstream), designed as a unified execution/proving stack:

- **Starstream** — the execution layer. Compiles `.star` programs (Rust-like, coroutine-based) to WASM and runs them client-side to produce an execution trace.
- **Nightstream** — the proving layer. Takes the execution trace and proves it correct via lattice-based IVC (incrementally verifiable computation), chunk by chunk.

They are on **Midnight's own R&D roadmap** as intended future replacements:

| Layer | Current | Roadmap (R&D) |
|---|---|---|
| Contract language / VM | Compact + Impact VM | Starstream (+ EVM) |
| ZK proof system | Plonk/KZG (BLS12-381) | Nightstream |

**Paima** is different — it is an external rollup/game-engine framework that uses Midnight as an L1 settlement and data-availability layer. It is the only near-term connection point to Midnight among the three. Starstream and Nightstream have no current connection to NEAR.

---

## What Stays and What Changes in the Transition

| Component | Survives the transition? | Notes |
|---|---|---|
| ZSwap (nullifier set, commitment tree) | ✅ Yes | Explicitly unchanged in the roadmap |
| Midnight.js provider architecture | ✅ Largely | Starstream slots in where `contract.js` runs today |
| Kachina model (public/private transcripts, local execution) | ✅ Yes | Preserved; Starstream runs client-side like Compact |
| PLONK/BLS12-381 on-chain verifier | ✅ Yes (in neo-midnight-bridge design) | See below |
| Compact contract logic | ❌ No | Requires rewrite in Starstream |
| Impact VM | ❌ No (for new txs) | Retained for historical block verification |
| Private state / witnesses | ❌ No | Witness format is circuit-specific; migration tooling needed |
| Existing PLONK proofs | ❌ No | Not verifiable by Nightstream verifier |

### On the PLONK/BLS12-381 verifier

A critical architectural point: as currently designed via neo-midnight-bridge, the **Midnight on-chain verifier does not change**. It still verifies a PLONK/BLS12-381 KZG proof — the same as today. What changes is the off-chain pipeline that *generates* that proof:

- **Today:** Compact → ZKIR → PLONK/BLS12-381 proof
- **Future:** Starstream trace → Nightstream IVC → neo-midnight-bridge (Neo verifier as PLONK circuit) → PLONK/BLS12-381 proof

The Midnight node never sees Nightstream directly. neo-midnight-bridge is the permanent adapter, not a temporary shim — unless Midnight eventually replaces its on-chain verifier entirely (which would be a much more disruptive migration).

---

## Envisioned Data Flow: Paima Approach 3 on Future Midnight

This describes the full vision: Paima state machines written in Starstream, proved by Nightstream, settled on Midnight L1.

### Phase 1 — Development (offline)

```
Developer writes .star source files
        │
        ▼
[Starstream compiler]
        │
        ▼
.wasm module  ←── compiled state machine
```

**Artifacts:** `.star` source, `.wasm` module
**Components:** Starstream compiler only

---

### Phase 2 — Input submission (user → L1)

```
User submits game action
        │
        ▼
[Paima L2 Compact contract on Midnight L1]
        │ records + orders inputs as public state
        ▼
Ordered input log  ←── publicly visible on-chain
```

**Artifacts:** raw user inputs (plaintext — sequencer sees them), ordered input log
**Components:** Midnight.js, Midnight L1 node, Midnight GraphQL indexer

> ⚠️ **Residual privacy tension:** Paima requires a publicly ordered input log. A sequencer must see inputs in plaintext at submission time. Private Paima inputs would require a commit-then-reveal protocol that does not yet exist in Paima.

---

### Phase 3 — Input ingestion (off-chain)

```
[Paima funnel]  ←── reads Midnight GraphQL indexer
        │ maps UTXO/intent events to Paima's unified input format
        ▼
Normalised input batch
```

**Artifacts:** normalised input batch
**Components:** Paima funnel (modelled on Carp/Cardano pattern), Midnight GraphQL indexer

---

### Phase 4 — State machine execution (off-chain, client-side)

```
[Starstream WASM runtime]
  inputs: .wasm module + normalised input batch + current public state
        │
        ├──▶ public transcript    ←── goes on-chain
        ├──▶ private transcript   ←── stays local, never leaves device
        └──▶ execution trace      ←── fed to Nightstream prover
```

**Artifacts:**
- `.wasm` module (read), current state (read via indexer)
- Public transcript, private transcript, execution trace (all produced)

**Components:** Starstream WASM runtime, Midnight GraphQL indexer (for current state)

---

### Phase 5 — IVC proving (off-chain)

```
[Nightstream IVC prover]
  input: execution trace (chunked)
        │
        ├── per chunk: build_shard_witness()
        │       → witness per chunk  (Goldilocks field, large, transient)
        ├── per chunk: fold_shard_prove()
        │       → per-chunk fold proof
        ├── fold_shard_verify()
        │       → ShardObligations {main, val}  (ME obligations, Goldilocks field)
        └── [Finalizer — 🛑 WIP, not yet implemented]
                → single compact Nightstream proof
```

**Artifacts:** execution trace (consumed), per-chunk witnesses, per-chunk fold proofs, ShardObligations / ME obligations, single compact Nightstream proof
**Components:** Nightstream IVC prover (neo-ajtai, neo-ccs, neo-fold, neo-math, neo-reductions)

---

### Phase 6 — Proof wrapping (off-chain)

```
[neo-midnight-bridge]  ←── existed Jan–Mar 2026; removed 2026-03-28; successor unknown
  input: ME obligations (Goldilocks field)
        │
        ├── k_field + goldilocks: Goldilocks arithmetic as PLONK witnesses
        ├── relations + sumcheck: Neo verification steps as PLONK constraints
        ├── bundle_verifier:      verify complete Neo FoldRun bundle
        └── fs:                   Fiat-Shamir challenges (Blake2b)
        │
[midnight-circuits / midnight-proofs]
        │ generates KZG proof over BLS12-381
        ▼
Single Midnight-native BLS12-381 proof (~5 KB)
```

**Artifacts:** ME obligations (consumed), PLONK witnesses encoding Neo verification (intermediate, expensive — Goldilocks arithmetic in BLS12-381 constraints, validated as working but not benchmarked at scale), BLS12-381 KZG proof (produced)
**Components:** neo-midnight-bridge, midnight-circuits, midnight-proofs, midnight-curves

> ⚠️ **Outer proof uncertainty:** The current Nightstream system architecture document describes Spartan/FRI — not PLONK/KZG — as the final compression layer. If Spartan/FRI is adopted as the outer proof, this entire phase changes: the BLS12-381 PLONK bridge would be replaced by a Spartan/FRI verifier, and Midnight's on-chain verifier would need to be updated accordingly. The PLONK/BLS12-381 path described here reflects the architecture of the removed `neo-midnight-bridge` crate, which may or may not represent the team's current intent.

---

### Phase 7 — Transaction submission and L1 settlement

```
[Midnight.js]
  inputs: BLS12-381 proof + public transcript + ZSwap coin selection
        │
        ▼
Signed Midnight transaction
        │
[Midnight L1 node]
  ├── verifies BLS12-381 proof
  ├── applies public transcript → updates contract public state
  ├── ZSwap: appends nullifiers + new commitments
  └── emits indexer events
```

**Artifacts:** BLS12-381 proof (verified), public transcript (applied to on-chain state), DUST fee (consumed), nullifiers and commitments (appended, permanent)
**Components:** Midnight.js, Midnight L1 node, ZSwap, Midnight GraphQL indexer

---

### Phase 8 — Client finalisation

```
[Client / wallet]
  ├── receives indexer events
  └── reconciles private transcript against on-chain commitment tree
      → updated local private state
```

**Artifacts:** private transcript (reconciled), local private state
**Components:** Midnight.js PrivateStateProvider, local wallet storage

---

## Artifact × Component Matrix

| Artifact | Starstream compiler | Starstream runtime | Nightstream prover | neo-midnight-bridge ❓ | Midnight.js | Midnight L1 node | Paima funnel | Indexer |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `.star` source | read | | | | | | | |
| `.wasm` module | produce | execute | | | | | | |
| Ordered inputs | | | | | | store | produce | emit |
| Execution trace | | produce | read | | | | | |
| Public transcript | | produce | | | attach | apply | | |
| Private transcript | | produce | | | reconcile | | | |
| Per-chunk witnesses | | | produce/consume | | | | | |
| ME obligations | | | produce | read | | | | |
| PLONK witnesses (bridge) | | | | produce/consume | | | | |
| BLS12-381 proof | | | | produce | attach | verify | | |
| Public contract state | | read | | | | update | | emit |
| Nullifier set | | | | | | update | | |
| Commitment tree | | | | | | update | | |
| Private state (local) | | | | | reconcile | | | |

---

## Contract Migration: Compact → Starstream

Old Compact contracts cannot be automatically migrated to Starstream. The gap is a fundamental change in computational model:

| | Compact (current) | Starstream (future) |
|---|---|---|
| Compilation target | ZKIR (arithmetic circuit constraints) | WASM (execution trace) |
| Proof model | Fixed-size circuit, statically bounded | IVC — unbounded, chunked |
| Private state format | Tied to ZKIR witness layout | Tied to WASM memory/trace |

**What survives:** public on-chain contract state (readable by a rewritten Starstream contract), ZSwap commitments/nullifiers, Midnight.js provider layer.
**What requires rewriting:** all contract logic (Compact → Starstream `.star`), private state migration tooling (per-contract).
**Node-level:** the Impact VM and PLONK/BLS12-381 verifier must be retained permanently for historical block verification, becoming a maintained legacy layer.

---

## Sources

- [`assessments/starstream-nightstream.md`](../assessments/starstream-nightstream.md)
- [`assessments/paima-on-midnight.md`](../assessments/paima-on-midnight.md)
- [LFDT-Nightstream/Starstream — GitHub](https://github.com/LFDT-Nightstream/Starstream)
- [LFDT-Nightstream/Nightstream — GitHub](https://github.com/LFDT-Nightstream/Nightstream)
- [Neo: Lattice-based folding scheme for CCS — IACR ePrint 2025/294](https://eprint.iacr.org/2025/294)
- [Neo and SuperNeo — IACR ePrint 2026/242](https://eprint.iacr.org/2026/242)
- [Twist and Shout: memory checking arguments — IACR ePrint 2025/105](https://eprint.iacr.org/2025/105)
- [Efficient Foreign-Field Arithmetic in PLONK — IACR ePrint 2025/695](https://eprint.iacr.org/2025/695) (IOG/Midnight; mathematical foundation for the bridge approach)
- [LFDT-Nightstream/Nightstream PR #74: Midnight Bridge](https://github.com/LFDT-Nightstream/Nightstream/pull/74)
- [LFDT-Nightstream/Nightstream PR #80: neo-midnight-bridge KZG params](https://github.com/LFDT-Nightstream/Nightstream/pull/80)
- [midnight-proofs on crates.io](https://crates.io/crates/midnight-proofs)
- [midnight-zk-stdlib on crates.io](https://crates.io/crates/midnight-zk-stdlib)
- [midnightntwrk/midnight-zk — GitHub](https://github.com/midnightntwrk/midnight-zk/)
- [Midnight Roadmap — internal (`background/roadmap.md`)](../background/roadmap.md)
- [Paima Engine documentation](https://docs.paimastudios.com/)
