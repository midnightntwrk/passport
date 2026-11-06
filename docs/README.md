# Midnight Passport documentation

Start with [the architecture reference](arc42.md). It describes the system,
distinguishes the v1.0 target from this checkout's implementation, and links
to the detailed sources. It is maintained as an architectural index; protocol
requirements and experiment results stay with their owners below.

## Where each kind of information belongs

| Question | Authoritative source for that question |
|---|---|
| What is Passport, and how do its parts fit together? | [arc42](arc42.md) |
| What does v1.0 promise, including its security properties? | [Promises and invariants](plans/PROMISES.md) |
| Which components deliver those promises, and what decisions remain? | [Component inventory and canvases](plans/components/README.md) |
| Why was a decision made? | [ADRs](adrs/), with evidence linked from each decision |
| Which MIPs/MPSs do we author or adopt, and where are they now? | [Standards register](plans/MIPS.md); upstream documents own their normative text and lifecycle |
| Which local files are drafts or old copies? | [Local standards index](mps-mip/README.md) |
| What is the current development status? | [Dated status record](plans/STATUS.md), including the 2 November ACC update |
| What does this checkout actually implement? | [Reference contract](../contract/README.md), its source, tests, and dated evidence |
| How does a runtime scenario work? | [Protocol flows](protocol-flows/README.md), labelled with their implementation scope |
| How do I run a demo? | [Demo index](../demo/README.md); demos have separate contracts and limitations |
| What evidence informed the design? | [Experiments](../experiments/), [research](../research/README.md), and [dated technical facts](KNOWLEDGE_BASE.md) |
| What was the original vision? | [Inherited principles](PRINCIPLES.md), [design PDF](secure-onboarding-design.pdf), and [human research notes](RESEARCH.md) |
| What was superseded? | [Plan archive](plans/archive/README.md) and [site archive](../site/archive/) |
| What can stakeholders browse? | [Public site](../site/index.html); a presentation of these sources |

Authority is scoped. A published proposal specifies intended behaviour; source
and evidence establish implemented behaviour. If they differ, record the gap
instead of treating either as proof of conformance. A research note, diagram,
or site summary cannot override the protocol or establish implementation.

## Historical and externally maintained material

- `docs/reference/` and `experiments/nearfall-evaluation/` are upstream-owned
  subtrees. Their documents describe their own projects and dates; updates use
  the subtree process in the [repository README](../README.md).
- `research/`, `docs/PRINCIPLES.md`, and `docs/RESEARCH.md` retain the reasoning
  behind earlier designs. In particular, early threshold-service, DeRec, and
  single-seed designs are not the current account-contract architecture.
  `RESEARCH.md` explicitly reserves edits to humans. Consult current
  requirements and architecture when historical designs differ.
- Local standards files are either historical copies, canonical pointers, or
  working drafts, as labelled in the local standards index. Historical copies
  are not synchronised mirrors; use upstream for normative interpretation.
- Untracked drafts, `tmp/`, and private planning directories are working
  material, not publishable evidence. Do not make a committed document depend
  on their presence.

## Maintaining the reference

For a change to protocol, architecture, or implementation, update the owning
source first, then the affected arc42 section, component canvas, runtime flow,
and public-site summary. Update the standards register when a document is
numbered or changes status; link the canonical file and date the observation.
Keep publication status separate from implementation and test coverage.

Label observations as **target**, **local implementation**, **dated evidence**,
or **historical** when readers might otherwise confuse them. A past milestone
is not evidence that a demo shipped. A passing simulator run is not a node run,
and a reference implementation is not an audit or a production deployment.

Before completing an update, check relative links and anchors, compare changed
claims with source/evidence, and run `node site/check.js` if site data or pages
changed. Record validation results in the pull request; keep lasting evidence
limits in the architecture reference and the relevant source documents.
