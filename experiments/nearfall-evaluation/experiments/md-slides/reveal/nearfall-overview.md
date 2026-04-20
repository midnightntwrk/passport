---
title: "NEARFall"
subtitle: "Architectural Feasibility Study for Midnight"
author: Input Output
date: 2026
theme: black
transition: slide
slideNumber: true
history: true
---

# The Problem

## Midnight's 2026 Mandate

Current state:

- Throughput: **~3 TPS** (200 KB block limit)
- Target: **500+ TPS**
- Current L2 does not roll up or work with Midnight native state
- Any platform transition requires ledger migration

. . .

> **Key insight (Jon Rossie):** the bottleneck is *block size*, not protocol
> throughput — 500+ TPS may be better approached via Layer-2 rollup
> than platform migration.

::: notes
Jon Rossie's diagnosis is the most important scope qualifier in the project.
It shifts the weight away from Option 1 (full port) toward Options 2 and 3.
:::

# Three Paths

## Architectural Options

| Option | Description | Cost |
|--------|-------------|------|
| **1. Port to NEAR** | Full re-platforming | Very high |
| **2. Take Software** | Extract NEAR components | Medium–high |
| **3. Take Ideas** | Rebuild NEAR patterns in Substrate | Medium |

. . .

All three remain in scope. Option 1 reflects Charles's direction;
Options 2 and 3 may offer better risk-adjusted returns.

::: notes
Emphasise that this is a comparative feasibility study — we are not
committed to any option. The cost column is preliminary.
:::

# Roadmap

## Integration Roadmap

**Phase 1 — Now**

Midnight v1 on Substrate (~3 TPS)

. . .

**Phase 2 — Layer-2**

- **Starstream**: browser-side UTXO VM for private transcripts
- **Nightstream**: post-quantum IVC proving (lattice-based)
- **Paima**: multi-chain rollup sequencing

. . .

**End Goal**

Single coherent architecture — components may remain decoupled at runtime.

# Evaluation Pillars

## Six Pillars

1. Full port cost — risk/cost floor {.fragment}
2. Component extraction — decoupling `nearcore` {.fragment}
3. Architectural adaptation — rebuild ideas in Substrate {.fragment}
4. Runtime & modularity — Starstream / Nightstream / Paima / Kachina {.fragment}
5. Migration & interoperability — bridges and partner DApps {.fragment}
6. TPS bottleneck diagnosis — how much via L2 without migration? {.fragment}

::: notes
Pillar 6 is the most important for scoping Options 2 and 3.
The answer determines whether a full port is even necessary.
:::

# Stakeholder Topics

## Scalability & Key Management

**Scalability**

- 500+ TPS rollup architecture
- Rollup compatibility with Midnight native state

**Key Management & Chain Abstraction**

- Hierarchical key derivation across Cardano, Ethereum, Solana, …
- Chain-agnostic transaction surface

## Privacy, Migration & Convergence

**Privacy**

- TEE integration as a fast privacy path ("cheat codes")

**Migration**

- Ledger migration strategy
- Bridge and DApp continuity (cNIGHT ↔ mNIGHT)
- Convergence of all Layer-2 and platform work

# Timeline

## Double Diamond — 100 Days

| Diamond | Phase | Dates |
|---------|-------|-------|
| 1 | Divergent — **Discover** | Mar 12 – Apr 5 |
| 1 | Convergent — **Define** | Apr 6 – Apr 30 |
| 2 | Divergent — **Develop** | May 1 – May 25 |
| 2 | Convergent — **Deliver** | May 26 – Jun 19 |

. . .

*Today is day 16 — deep in the Discovery phase.*

# Reference

## Repository & Conventions

**Directories:** `/assessments/` · `/comparisons/` · `/experiments/`
`/artifacts/` · `/background/` · `/journal/`

**Markers:** 🧪 HYPOTHESIS · 📊 EVIDENCE · 🛑 BLOCKER · 🏛️ ADR · ⚠️ RISK · ❓ SCRUTINY

*See `AGENTS.md` for full mission context.*
