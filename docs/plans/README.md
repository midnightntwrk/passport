# Midnight Passport — Plans

> **Reading status (2026/11/06).** This plan defines the v1.0 target.
> October 2026 references record the original MVP milestone, not verified
> delivery. For implemented scope, use [arc42](../arc42.md); for current
> publication observations, use the [standards register](MIPS.md).

The plan for **feature-complete v1.0** of Midnight Passport — what v1.0
promises, the components that deliver it, and how the original October MVP plan consumed those deliverables early.

**Current development status:** [development status and 2 November ACC update](STATUS.md)
of merged implementation, open feature PRs, upstream proposals, demo releases,
SDK work and formal-spec tickets.

**Audit follow-up:** the [remediation queue](AUDIT-REMEDIATION.md) records the
four agreed implementation priorities, their acceptance criteria, and the next
task to start immediately after each merge.

**Proposed design and validation plan:** [Account viewing key sharing and recovery](viewing-key-sharing.md)
defines the lifecycle to evaluate, contract options and acceptance criteria
for the follow-up to the merged inbox-envelope experiment. Agreed architectural
choices will be recorded in ADRs, with relevant MIP and client specification
amendments for interoperable behaviour before adoption.

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
on the cross-cutting registry. The original October 2026 plan called for an MVP built with partners to
consume those deliverables early. It remains historical delivery framing;
this index does not establish that the milestone shipped.

- **The v1.0 deliverables.** Continuous; not bounded by the demo date.
  Each deliverable carries the principled mechanism for its component —
  the "feature-complete v1.0" target — and is informed by what the MVP
  surfaces in implementation.
- **The original October MVP target.** A runnable, end-to-end demonstration
  was planned for October 2026. The plan allowed provisional mechanisms
  with a migration path to the principled specification. Delivery evidence
  and current work belong in the status record, not an expired deadline.

Where a component admits more than one mechanism, the per-component canvas
in [`components/`](components/) records both readings — the **MVP pick**
and the **v1.0 deliverable target**.

## What lives here

- [`README.md`](README.md) — this index.
- [`PROMISES.md`](PROMISES.md) — the v1.0 promises
  (P1–P10, P5′ and P11–P16 security properties) and testable invariants (I-N.M).
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
