# Midnight Passport — Plans

The plan for **feature-complete v1.0** of Midnight Passport — what v1.0
promises, the components that deliver it, and how the October MVP
consumes those deliverables early.

## What v1.0 is

Feature-complete Midnight Passport — the user-facing identity and wallet
layer for the Midnight network, covering passkey-rooted onboarding,
human-readable account names, multi-device accounts, lost-device and
total-loss recovery, scoped grants, privacy-preserving credentials, and
cross-chain operation through integration with upstream solver and
threshold-signature work.

v1.0 is the **destination**, not a release date. What ships first, what
follows, and what depends on upstream work elsewhere in the ecosystem is a
delivery question, recorded separately. Every promise on
[`PROMISES.md`](PROMISES.md) applies to v1.0 in full.

## Delivery shape: v1.0 deliverables and the October MVP

Feature-complete v1.0 is a body of deliverables — specs, MIPs,
formal-methods sign-off on critical components, and cryptographer reviews
on the cross-cutting registry. The October 2026 demo is an MVP that
consumes those deliverables early, built with partners.

- **The v1.0 deliverables.** Continuous; not bounded by the demo date.
  Each deliverable carries the principled mechanism for its component —
  the "feature-complete v1.0" target — and is informed by what the MVP
  surfaces in implementation.
- **The October MVP.** Hard date October 2026. A runnable, end-to-end
  demonstration that consumes deliverables as they firm up. Where a
  deliverable is not yet mature, the MVP picks the simplest workable
  mechanism (the "make it run by October" path) and records a migration
  plan back to the principled spec.

Where a component admits more than one mechanism, the per-component canvas
in [`components/`](components/) records both readings — the **MVP pick**
and the **v1.0 deliverable target**.

## What lives here

- [`README.md`](README.md) — this index.
- [`PROMISES.md`](PROMISES.md) — the ten v1.0 user-facing promises
  (P1 – P10) and their testable invariants (I-N.M).
- [`components/`](components/) — per-component canvases (C1 – C26). Each
  component carries its outcome, dependencies, open questions, failure
  modes, and alternatives, plus its track readings where they apply.
- [`archive/`](archive/) — the Plan A vs Plan B fork that framed the
  project from 2026/04/21 until 2026/04/30, preserved verbatim. Superseded
  by the converged v1.0; see the archive's own [README](archive/README.md).

## Where to start reading

- **Evaluating coherence.** Read [`PROMISES.md`](PROMISES.md) end to end,
  then skim [`components/README.md`](components/README.md) to confirm the
  component inventory covers what the promises demand.
- **Looking at a specific surface.** Go straight to the relevant canvas in
  [`components/`](components/). The component README maps every component
  to the promises it serves.
## Related reference (in this repo)

- [`docs/PRINCIPLES.md`](../PRINCIPLES.md) — the six inherited
  secure-onboarding principles. Antecedent for the ten v1.0 promises;
  see the Lineage section of `PROMISES.md` here.
- [`MIPS.md`](MIPS.md) — the MIP pipeline Midnight Passport produces.
- [`docs/RESEARCH.md`](../RESEARCH.md) — accumulated research; cited where
  it bears on a question.
- [`docs/secure-onboarding-design.pdf`](../secure-onboarding-design.pdf) —
  the upstream secure-onboarding design document (PDF).
- [`docs/reference/machine-investigation/key-flows/secure-onboarding-design.md`](../reference/machine-investigation/key-flows/secure-onboarding-design.md)
  — the source-of-truth for the inherited principles, maintained upstream.
