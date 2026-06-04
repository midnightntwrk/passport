# ADR 0001 — Domain-separation registry

**Status:** Accepted (2026/06/02)

## Context

C8 is Midnight Passport's cross-cutting domain-separation surface: every
`persistentHash`/`transientHash` use site needs a domain prefix so that hashes
computed in different contexts cannot collide. What was open was not the
*technique* but whether Passport should standardise it, and in what form — the
canvas debated a central markdown registry (A), compile-time enforcement in the
Compact toolchain (B), and a hybrid (C). An inventory of the shipped ledger and
the Compact standard library (`experiments/domain-separation-inventory/`)
settled the framing: domain separation is already practised but **unregistered
and inconsistent** — ~28 tagged hash use sites, ~25 distinct tags, two prefix
schemes in code (`midnight:`, `mdn:`) plus a third (`ni`) in the canonical
wallet specification, only four tags hoisted to a constant, at least two
untagged sites, zero tags declared in any specification or MIP, and a
spec↔code↔diagram disagreement on the coin-public-key and key-derivation
separators. The surface is therefore net-new as a *standard*, not as a
technique.

## Decision

We adopt alternative **A — "Central registry (markdown + audit)"**.
Compile-time enforcement (alternative C, the hybrid) is a later, optional
convergence; B is subsumed into C.

The rationale, as committed at component-start: *A is the lowest-cost start,
aligned with the demo's mechanism, and sufficient to make the
existing-but-implicit practice explicit and auditable. Compile-time enforcement
(C) is a later enhancement, added if registry discipline alone proves leaky.*

The standardisation vehicle is a solution-agnostic MPS
(`docs/mps-mip/mps/mps-domain-separation.md`) that frames the gap and recommends the
registry MIP; the A-versus-C choice lives in this ADR and in that MIP, never in
the MPS. The inventory's `INVENTORY.md` is the first draft of the registry.

## Consequences

### Positive
- The inventory already *is* the registry's first draft — finalising A is
  largely curating it.
- Converts a scattered, implicit practice into an explicit, auditable, citable
  artefact, and gives third-party Compact authors something to conform to.
- Surfaces the spec↔code↔diagram divergence as a concrete, fixable defect
  rather than latent risk.
- Lowest-cost, demo-aligned, and portable to the upstream MPS/MIP.

### Negative
- A registry alone does not *enforce*: it cannot catch a missing prefix (e.g.
  `UserAddress`) or structurally prevent a new collision — the canvas's
  "Missing prefix" and "Domain collision" failure modes persist until
  enforcement (C) lands.
- The registry's own query surface can become a participation-pattern oracle
  (the canvas's "Registry query as oracle" failure mode); its interface must be
  write-only / lookup-by-full-path.
- Reconciling the existing divergence may be a migration or hard fork if domain
  separators are frozen at network deployment (open; raised upstream).

### Neutral
- Authoring runs through an upstream MPS, so it is not unilaterally Passport's:
  it needs a named Midnight Foundation / ledger co-author and an editor-assigned
  number, and its timeline tracks upstream uptake.
- Cryptographer review remains a pending external dependency before the
  registry MIP can ratify.

## References

- Component canvas: [`docs/plans/components/C8-domain-separation-registry.md`](../plans/components/C8-domain-separation-registry.md)
- Experiment: [`experiments/domain-separation-inventory/`](../../experiments/domain-separation-inventory/) (`INVENTORY.md`, `FINDINGS.md`)
- Problem statement: [`docs/mps-mip/mps/mps-domain-separation.md`](../mps-mip/mps/mps-domain-separation.md)
- Related arc42 sections: §8 (Crosscutting Concepts), §11 (Risks and Technical Debt).
- Pipeline: `STD-03` in [`docs/plans/MIPS.md`](../plans/MIPS.md).
