# Domain-Separation Inventory — Experiment

This experiment produces the canonical inventory of every hash
domain-separation use site across Midnight's Compact standard library
and the `midnight-ledger` Rust source: for each site, the primitive
used, the domain tag it carries (or its absence), and how that tag is
formed. It is the evidence base for **C8 — Domain-separation registry**
([`docs/plans/components/C8-domain-separation-registry.md`](../../docs/plans/components/C8-domain-separation-registry.md))
and the problem statement (MPS) C8 will produce.

It is a strict static-analysis pass: every entry is backed by a
`file:line` reference into pinned upstream source — no theoretical
analysis, no inferred tags.

## Status

**Run 2026/06/02.** `INVENTORY.md` (the canonical table), `FINDINGS.md` (the
verdict), and `run-all.sh` (the reproducible scanner) are populated. Verdict:
domain separation is applied but **unregistered and inconsistent** — two
prefix schemes in code, a third in the canonical spec, ~25 distinct tags, only
4 hoisted to a const, ≥2 untagged sites, and 0 tags declared in any spec/MIP.
See `FINDINGS.md`.

## Why this matters

C8 is pursuing **alternative A — a central registry (markdown + audit)**
of every domain prefix, with compile-time enforcement (C) as a later
convergence, and the delivery target is a standalone MPS. Before a
registry can be written — or an MPS can argue the gap is real — we need
the actual numbers: how many hash use sites exist, how many carry a
domain tag, how many schemes coexist, and how many are untagged.

A prior recon found the discipline is applied by hand with literal tags
(`"mdn:cc"`, `b"midnight:zswap-cn[v1]"`, …), ~21 distinct tags on the
ledger side, two coexisting prefix schemes (`midnight:` vs `mdn:`), at
least one untagged site (`UserAddress`), and no central enumeration in
code or docs. This experiment turns that spot-check into a complete,
reproducible inventory — which doubles as the **first draft of the
alternative-A registry**.

## Where to start reading

| File | Purpose |
|------|---------|
| `EXPERIMENT_GUIDELINE.md` | The brief — goal, scan passes (S1–S5), sources, deliverables, acceptance |
| `INVENTORY.md` | The canonical table: every hash use site, its tag, and classification |
| `FINDINGS.md` | The verdict — applied but unregistered and inconsistent — with the counts |
| `run-all.sh` | The reproducible scanner (ripgrep); regenerates the raw enumeration |

## Method at-a-glance (when running)

Static scan of two pinned sources — the Compact `.compact` standard
library (`midnightntwrk/compactc`, commit `0e76dafa`; cross-checked
against installed `0.10.6`) and the `midnightntwrk/midnight-ledger` Rust
workspace (`v8.0.2`, commit `dfb450d`, base-crypto `1.0.0`). For every
`persistent_hash` / `transient_hash` / `persistent_commit` /
`transient_commit` use site, extract the domain tag (the literal
prepended to the SHA-256 preimage, the Poseidon opening, or a
`domain_sep` struct field) or mark it UNTAGGED, then classify scheme,
padding, versioning, and whether the tag is declared in any
architecture/spec/MIP document. Output is `INVENTORY.md` plus summary
statistics. See `EXPERIMENT_GUIDELINE.md` for the full pass list.
