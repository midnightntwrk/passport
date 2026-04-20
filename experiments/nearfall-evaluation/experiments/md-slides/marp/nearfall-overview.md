---
marp: true
title: "NEARFall: Architectural Feasibility Study"
theme: default
paginate: true
---

<!-- _class: lead -->

# NEARFall
## Architectural Feasibility Study for Midnight

*Evaluating NEAR Protocol as a scalability path for Midnight 2.0*

---

## The Problem

Midnight faces a **2026 scalability mandate**:

- Current throughput: **~3 TPS** (200 KB block limit)
- Target: **500+ TPS**
- Current L2 does not roll up or work with Midnight native state
- Ledger migration required for any platform transition

> Jon Rossie: the TPS bottleneck is **block size**, not protocol throughput.
> The 500+ TPS goal may be better approached through **Layer-2 rollup architecture**.

---

## Three Architectural Paths

| Option | Description | Cost |
|--------|-------------|------|
| **1. Port to NEAR** | Full re-platforming to the NEAR stack | Very high |
| **2. Take Software** | Extract NEAR components into Midnight | Medium–high |
| **3. Take Ideas** | Rebuild NEAR patterns natively in Substrate | Medium |

All three paths remain in scope. Option 1 reflects Charles's direction; Options 2 and 3 may offer better risk-adjusted returns.

---

## Integration Roadmap

```
Phase 1 (Now)          Phase 2 (L2)            End Goal
─────────────────      ─────────────────────   ──────────────────────
Midnight v1            Starstream              Single coherent
(Substrate)       ──►  Nightstream        ──►  architecture
                       Paima
```

- **Phase 1**: Current Midnight platform (Substrate/FRAME)
- **Phase 2**: Layer-2 technologies integrating privacy + throughput
- **End Goal**: All components converge — even if remaining decoupled

---

## Six Evaluation Pillars

1. **Full Port Cost** — establish the risk/cost floor of complete re-platforming
2. **Component Extraction** — difficulty of decoupling `nearcore` modules
3. **Architectural Adaptation** — rebuild NEAR ideas natively in Substrate
4. **Runtime & Modularity** — Starstream / Nightstream / Paima / Kachina compatibility
5. **Migration & Interoperability** — cNIGHT ↔ mNIGHT bridges and partner DApps
6. **TPS Bottleneck Diagnosis** — how much is achievable via L2 without migration?

---

## Stakeholder Topics

**Scalability**
- 500+ TPS rollup architecture · rollup compatibility with Midnight native state

**Key Management & Chain Abstraction**
- Hierarchical key derivation across Cardano, Ethereum, Solana, …
- Chain-agnostic transaction surface

**Privacy & TEE**
- TEE integration as a fast privacy path ("cheat codes")

**Migration & Interoperability**
- Ledger migration strategy · bridge and DApp continuity · architectural convergence

---

## Layer-2 Technologies Under Evaluation

| Technology | Role |
|------------|------|
| **Starstream** | Browser-side UTXO VM and language for private transcripts |
| **Nightstream** | Lattice-based IVC proving system (post-quantum) |
| **Paima** | Multi-chain rollup sequencing and settlement |

Together these form the core of the **MidnightOS vision**: decentralised WASM apps delivered to the browser with ZK-proven integrity.

---

## Timeline: Double Diamond

| Diamond | Phase | Days | Dates |
|---------|-------|------|-------|
| 1 | Divergent — Discover | 1–25 | Mar 12 – Apr 5 |
| 1 | Convergent — Define | 26–50 | Apr 6 – Apr 30 |
| 2 | Divergent — Develop | 51–75 | May 1 – May 25 |
| 2 | Convergent — Deliver | 76–100 | May 26 – Jun 19 |

*Today is day 16 — deep in the Discovery phase.*

---

<!-- _class: lead -->

## Repository

`/assessments/` · `/comparisons/` · `/experiments/`
`/artifacts/` · `/background/` · `/journal/`

**Conventions:** 🧪 HYPOTHESIS · 📊 EVIDENCE · 🛑 BLOCKER · 🏛️ ADR · ⚠️ RISK · ❓ SCRUTINY

*See `AGENTS.md` for full conventions and mission context.*
