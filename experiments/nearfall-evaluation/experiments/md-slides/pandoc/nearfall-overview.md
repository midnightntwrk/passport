---
title: "NEARFall: Architectural Feasibility Study"
subtitle: "Evaluating NEAR Protocol as a scalability path for Midnight 2.0"
author: Input Output
date: 2026
---

# The Problem

## Midnight's 2026 Scalability Mandate

- Current throughput: **~3 TPS** (200 KB block limit)
- Target: **500+ TPS**
- Current L2 does not roll up or work with Midnight native state
- Ledger migration required for any platform transition

**Key insight (Jon Rossie):** the TPS bottleneck is *block size*, not protocol throughput — the 500+ TPS goal may be better approached through Layer-2 rollup architecture than platform migration.

# Three Paths

## Architectural Options

| Option | Description | Cost |
|--------|-------------|------|
| **1. Port to NEAR** | Full re-platforming to the NEAR stack | Very high |
| **2. Take Software** | Extract NEAR components into Midnight | Medium–high |
| **3. Take Ideas** | Rebuild NEAR patterns natively in Substrate | Medium |

All three paths remain in scope. Option 1 reflects Charles's direction; Options 2 and 3 may offer better risk-adjusted returns.

# Roadmap

## Integration Roadmap

**Phase 1 — Now:** Current Midnight platform (Substrate/FRAME, ~3 TPS)

**Phase 2 — Layer-2 integration:**

- Starstream: browser-side UTXO VM for private transcripts
- Nightstream: post-quantum IVC proving (lattice-based)
- Paima: multi-chain rollup sequencing

**End Goal:** All components converge into a single coherent architecture, even if remaining decoupled at runtime.

# Evaluation

## Six Evaluation Pillars

1. **Full Port Cost** — risk/cost floor of complete re-platforming
2. **Component Extraction** — difficulty of decoupling `nearcore` modules
3. **Architectural Adaptation** — rebuild NEAR ideas natively in Substrate
4. **Runtime & Modularity** — Starstream / Nightstream / Paima / Kachina compatibility
5. **Migration & Interoperability** — cNIGHT ↔ mNIGHT bridges and partner DApps
6. **TPS Bottleneck Diagnosis** — how much is achievable via L2 without migration?

## Stakeholder Topics

**Scalability:** 500+ TPS rollup · rollup compatibility with native Midnight state

**Key Management:** hierarchical key derivation (Cardano, Ethereum, Solana, …) · chain abstraction

**Privacy:** TEE integration as fast privacy path

**Migration:** ledger migration strategy · bridge and DApp continuity · architectural convergence

# Timeline

## Double Diamond — 100 Days from March 12

| Diamond | Phase | Dates |
|---------|-------|-------|
| 1 | Divergent — Discover | Mar 12 – Apr 5 |
| 1 | Convergent — Define | Apr 6 – Apr 30 |
| 2 | Divergent — Develop | May 1 – May 25 |
| 2 | Convergent — Deliver | May 26 – Jun 19 |

*Today is day 16 — deep in the Discovery phase.*

# Reference

## Repository Structure and Conventions

**Directories:** `/assessments/` · `/comparisons/` · `/experiments/` · `/artifacts/` · `/background/` · `/journal/`

**Semantic markers:**

- 🧪 **HYPOTHESIS** — theory or assumption under test
- 📊 **EVIDENCE** — experimental data linked to a claim
- 🛑 **BLOCKER** — high-priority architectural hurdle
- 🏛️ **ADR** — finalised architecture decision record
- ⚠️ **RISK** — potential risk needing evaluation
- ❓ **SCRUTINY** — unverified quantitative estimate

*See `AGENTS.md` for full mission context and conventions.*
