# C8 · Domain-separation registry

**Serves:** P6 · P9.

## Outcome

Cross-cutting hash-prefix discipline: every `persistentHash` use site
gets a 6+ byte domain prefix. Prerequisite to credentials, signing, and
naming. The registry ships alongside the standards pipeline.

## Dependencies

- **C2** — namehashes use domain separators.
- **C18 – C21** — attestation construction and nullifier construction
  use distinct prefixes.
- **C6 · C7** — proof inputs carry domain separators.
- **External** — cryptographer review (pending; gates the registry MIP).
- **External** — upstream reconciliation of the spec↔code↔diagram separator
  divergence (raised with the Midnight Foundation).

## Open questions

### Resolved

**Centralised registry vs per-protocol prefixes.** Resolved by
[ADR-0001](../../adrs/0001-domain-separation-registry.md): a central
registry (alternative A), with compile-time enforcement (C) deferred. The
inventory at `experiments/domain-separation-inventory/` is its first draft.

### Residual

**Versioning.** Does a domain separator get versioned? If we update a
circuit, does the prefix change? Carried into the MPS, alongside whether
separators are frozen at network deployment.

**Audit timing.** When does the registry get a cryptographer sign-off?
What's the cadence post-v1.0? Cryptographer review gates the registry MIP
(external dependency).

**Registry interface and query surface.** The registry must be readable
enough to serve as the canonical source of truth for prefixes, but a
bulk-queryable or probe-friendly interface may itself become a
usage-pattern oracle. Where does the registry live (markdown document,
on-chain contract, both), and what queries does it expose? Now MPS Goal 7
and Open Question 8.

**Scheme reconciliation.** The inventory found two prefix schemes in code
(`midnight:`, `mdn:`) and a third (`ni`) in the wallet specification, which
disagree on the coin-PK and key-derivation separators. Reconciling onto one
canonical scheme may be a migration if separators are frozen at deployment.
Raised upstream.

## Failure modes

**Domain collision.** Two protocols use the same prefix. *Detection:*
protocol audit; differential test that hashes are equivalent up to
prefix.

**Missing prefix.** A `persistentHash` use site lacks a prefix.
*Detection:* code review or static analysis flagging un-prefixed hash
calls.

**Registry query as oracle.** The registry exposes a query interface
that lets external observers correlate identifiers with domains —
either by listing keys / accounts per domain or by accepting
existence-test probes ("is X associated with domain Y?"). The registry
then leaks participation patterns even when individual hashes don't.
*Detection:* the registry interface admits prefix → identifiers
lookups, or scoped existence tests, beyond what protocol participants
strictly need. *Mitigation:* scope read access — write-only public
surface, lookup by full path only, no enumeration — or accept the leak
as a benign v1.0 trade-off if the threat model permits.

## Alternatives

**A — Central registry (markdown + audit).**

**B — Compile-time enforcement** (Compact tooling rejects un-prefixed
hashes).

**C — Hybrid** (both, with compile-time checking what the registry
declares).

## Readings

**v1.0 direction** — alternative **A** (central registry, markdown + audit)
selected; compile-time enforcement (**C**) deferred as a later convergence.
Recorded in [ADR-0001](../../adrs/0001-domain-separation-registry.md), and
standardised via a solution-agnostic MPS
([`docs/mps-mip/mps/mps-domain-separation.md`](../../mps-mip/mps/mps-domain-separation.md)),
evidenced by `experiments/domain-separation-inventory/` (the inventory
doubles as the registry's first draft). Decided 2026/06/02.
