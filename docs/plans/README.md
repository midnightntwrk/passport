# Midnight Passport — Plans

The plan for **feature-complete v1.0** of Midnight Passport — what v1.0
promises, the components that deliver it, and how the two-track delivery
shape converges into one body of code.

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
[`PRINCIPLES.md`](PRINCIPLES.md) applies to v1.0 in full.

## Delivery shape: one body of code, two tracks

v1.0 is delivered by two parallel, **symbiotic** tracks. They are not
separate deliverables — both feed the same feature-complete v1.0.

- **Track 1 — Demo.** Hard date October 2026. A runnable, end-to-end
  demonstration. Track 1 borrows from Track 2's findings and may pick the
  simplest workable mechanism for a given component (the "make it run by
  October" path).
- **Track 2 — Spec.** Specs, standards, prototypes, formal methods.
  Continuous; not bounded by the demo date. Track 2 carries the principled
  alternative for each component (the "feature-complete v1.0" path) and is
  informed by what Track 1 surfaces in implementation.

Where a component admits more than one mechanism, the per-component canvas
in [`components/`](components/) records both readings — the
"track-1 candidate" (Demo) and the "track-2 target" (Spec).

## What lives here

- [`README.md`](README.md) — this index.
- [`PRINCIPLES.md`](PRINCIPLES.md) — the ten v1.0 user-facing promises
  (P1 – P10) and their testable invariants (I-N.M).
- [`components/`](components/) — per-component canvases (C1 – C25). Each
  component carries its outcome, dependencies, open questions, failure
  modes, and alternatives, plus its track readings where they apply.
- [`archive/`](archive/) — the Plan A vs Plan B fork that framed the
  project from 2026/04/21 until 2026/04/30, preserved verbatim. Superseded
  by the converged v1.0; see the archive's own [README](archive/README.md).

## Where to start reading

- **Evaluating coherence.** Read [`PRINCIPLES.md`](PRINCIPLES.md) end to
  end, then skim [`components/README.md`](components/README.md) to confirm
  the component inventory covers what the principles demand.
- **Looking at a specific surface.** Go straight to the relevant canvas in
  [`components/`](components/). The component README maps every component
  to the principles it serves.
- **Onboarding to the project.** Start with the repo-level
  [`docs/passport-plan.md`](../passport-plan.md) for the project overview
  and audience framing, then return here for the v1.0 detail.

## Related reference (in this repo)

- [`docs/PRINCIPLES.md`](../PRINCIPLES.md) — the six inherited
  secure-onboarding principles. Antecedent for the ten v1.0 promises;
  see the Lineage section of `PRINCIPLES.md` here.
- [`docs/FEATURES.md`](../FEATURES.md) — demo-mappable feature list.
- [`docs/MIPS.md`](../MIPS.md) — the MIP pipeline Midnight Passport
  produces.
- [`docs/RESEARCH.md`](../RESEARCH.md) — accumulated research; cited where
  it bears on a question.
- [`docs/secure-onboarding-design.pdf`](../secure-onboarding-design.pdf) —
  the upstream secure-onboarding design document (PDF).
- [`docs/reference/machine-investigation/key-flows/secure-onboarding-design.md`](../reference/machine-investigation/key-flows/secure-onboarding-design.md)
  — the source-of-truth for the inherited principles, maintained upstream.
