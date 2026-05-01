# Archived plans

This directory holds the Plan A vs Plan B fork that framed Midnight Passport
between 2026/04/21 and 2026/04/30. Both documents are preserved verbatim for
historical reference. **Neither reflects the current direction.**

## Why these are archived

Two events on 2026/04/30 superseded the fork:

1. **Scope expansion.** Cross-chain returned to v1.0 (feature-complete) scope,
   CAKE was adopted as the framework of reference, and the principles surface
   was re-derived as ten user-facing promises (P1 – P10) with explicit
   invariants. The earlier six-principle frame still informs v1.0 but is no
   longer the unit of planning.
2. **Track split.** The hard timeline shifted from end-of-June 2026 to
   October 2026, and delivery split into two parallel, *symbiotic* tracks —
   Track 1 (demo) and Track 2 (spec / standards / formal methods). They are
   not separate deliverables: one body of code, both tracks feeding the same
   feature-complete v1.0.

The custody-vs-recoverability fork that Plan A and Plan B turned on no longer
applies. The project does not choose between the two; it converges them, plus
more, into a single v1.0.

## What lives here

- [`plan-A-decentralised-but-limited/`](plan-A-decentralised-but-limited/README.md)
  — passkey-rooted, browser-bound, no recovery at MVP. Was the working primary
  at archive time.
- [`plan-B-slow-but-universal/`](plan-B-slow-but-universal/README.md) — FROST
  *n*=5 / *t*=4 federation, universal device matrix, recovery-by-design.

## Where to look now

- [`../README.md`](../README.md) — current converged v1.0 overview.
- [`../PRINCIPLES.md`](../PRINCIPLES.md) — v1.0 user-facing promises and
  invariants.
- [`../components/`](../components/) — per-component canvases (C1 – C25).
