# Midnight Passport — Plans Index

> **Date:** 2026/04/21
> **Status:** Two paths under evaluation following the 2026/04/21 stakeholder call

The Midnight Passport MVP can land via one of two architectural paths.
Both honour the six secure-onboarding design principles; they differ
in the custody model, in the breadth of the support matrix at MVP,
and in when account recovery and native multi-device arrive.

The pivot is a **custody-vs-recoverability** trade-off — not a
complexity-vs-simplicity one.

## The two plans

- **[Plan A — decentralised but limited](./archive/plan-A-decentralised-but-limited/README.md)** *(archived 2026/04/30 — superseded by scope expansion and track split; see [archive/](./archive/README.md))*
- **[Plan B — slow but universal](./archive/plan-B-slow-but-universal/README.md)** *(archived 2026/04/30 — superseded by scope expansion and track split; see [archive/](./archive/README.md))*

## Side-by-side comparison

| Dimension | Plan A — decentralised but limited | Plan B — slow but universal |
|---|---|---|
| Custody model | User's passkey is the signing root; all crypto in the browser | FROST n=5 / t=4 threshold committee operated by a single trust party |
| Browser / OS support matrix at MVP | Limited: Browser A × {OS-1, OS-2} — **product-owner-deferred decision**, working recommendation not locked | Universal |
| Account recovery at MVP | None — passkey loss loses the account | Yes — federation-mediated recovery by design |
| Multi-device at MVP | None — strictly one device one account; genuine multi-device is a near-term post-MVP priority (gates recovery) | Yes |
| MPC-node dependency | None | Required — single-operator federation to build |
| Decentralised from Day 1 | Yes | No (centralised operator until Milestone 2 federation) |
| Formal-methods priority-1 target | Name-registry commit-reveal with ENSIP-15 normalisation enforced in-circuit | In-circuit threshold (FROST) verification |
| Platform passkey sync | Apple iCloud Keychain / Google Password Manager — convenient for the user who has enabled it; not a substitute for Passport multi-device; not relied on in the product design | n/a |
| Reversibility | Plan B work is reusable as Milestone 2 input | Plan A surface stays reusable if we ever flip back |

## Further reading

- `.planning/research/PLAN-A-vs-PLAN-B-analysis.md` — detailed
  trade-off analysis (internal planning workspace).
- `.planning/design/PLAN-A-architecture.md` — Plan A design-layer
  specification (internal planning workspace).
- `../passport-plan.md` — project overview, plan-agnostic.
