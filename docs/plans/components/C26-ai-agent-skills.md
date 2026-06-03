# C26 · AI Agent skills

> **Meta-deliverable.** Not a protocol or wallet surface; a Claude-style
> agent rules and skills package that ships alongside Passport. Built
> and maintained on the fly from day 1, so context accumulates through
> the project rather than being reconstructed at the end.

**Serves:** every audience touching Passport (meta — sustains
discoverability and integration of every other component, rather than
serving a specific promise).

## Outcome

A set of Claude-style agent rules and skills, packaged for distribution,
that lower the threshold for people to engage with Passport.

- **End-users** get help understanding seedless onboarding, multi-device,
  recovery, and selective-disclosure flows in plain language.
- **dApp / wallet developers** get help integrating C23 (dApp
  connection), the grant primitives (C10 – C12), and the credential
  surfaces (C18 – C21) — pattern recipes derived from the canvases.
- **Project managers** get help reasoning about phase dependencies,
  parallelisation, trade-offs in flight, and the workstream gates.

The point of starting from day 1 is that the rules and skills accumulate
context as the project moves rather than being authored retroactively
when canvases have already drifted out of working memory.

This canvas frames the decision space, not the answer.

## Dependencies

- **`docs/plans/components/*.md`** — source material for developer- and
  PM-facing skills.
- **`docs/plans/PROMISES.md`** — source material for end-user-facing
  skills.
- **`docs/plans/MIPS.md`** — source for the more formal developer
  surfaces.
- **`docs/plans/components/README.md`** — the inventory and CAKE
  vocabulary anchor; foundational for every audience.
- **External — Claude Code skills format** (`.claude/skills/*` layout
  and the Claude Agent SDK skills shape).
- **External — IOG brand guidelines**
  (`.claude/rules/IOG_BRAND_GUIDELINES.md`) — communication tone for any
  user-facing skill output.

## Open questions

**Audience boundary.** Three audiences (end-user, developer, PM) — do
they share a single skills package with audience-specific entry points,
or three separately versioned packages?

**Distribution shape.** Claude Code plugin, loose markdown files
published in a public repo, both? Distribution shapes the maintenance
burden as much as the audience boundary does.

**Maintenance discipline.** Skills go stale fast as canvases evolve.
What's the update cadence — derive automatically from canvases on each
docs commit, or hand-maintain with a periodic refresh?

**Source-of-truth coupling.** Should the skills *embed* canvas content
or *link to* it? Embed = stable distribution, drift risk; link = always
fresh, but requires the canvases to be public.

**Day-1 buildable scope.** What's the minimum viable skill set that's
useful from day 1 — a single "Passport overview" skill, or one per
audience? The day-1 ask is about getting feedback flowing, not shipping
a polished package.

**Internal vs public.** A PM-facing skill that summarises this repo is
trivially possible. Does it ship to PMs outside IOG, or stay internal —
and what does the internal / external boundary look like for the other
two audiences?

**Voice across audiences.** End-user skills want plain, encouraging
tone; PM skills want analytical with judgement; dev skills want precise.
Same voice or three voices?

**Workstream-pending markers.** With five workstreams (C3, C4, C22, C24,
C25) live, parts of the planning surface are still in flux. How does a
skill represent open workstreams without leading the user to assume
they're decided?

## Failure modes

**Skill drift.** Canvases evolve; skills don't. Users get stale advice.
*Detection:* sample query against the skill returns information
contradicting the live canvas. *Mitigation:* automate skill regeneration
from canvases, or assign explicit ownership for refresh cadence.

**Audience confusion.** A single skill tries to serve all three
audiences and serves none well. *Detection:* end-user feedback citing
overly technical responses; developer feedback citing lack of detail.
*Mitigation:* split early, or use audience-detection routing.

**Branding misfire.** Skill output uses tone or terminology that clashes
with IOG brand guidelines or Midnight Foundation comms. *Detection:*
cross-team review flags voice or terminology mismatches. *Mitigation:*
every skill carries the brand-guidelines reference in its loaded
context.

**Premature commitment.** Skills shipped too early codify
soon-to-change architecture (workstream resolutions in flight).
*Detection:* a workstream resolves and the skill needs reshaping rather
than refreshing. *Mitigation:* explicit "workstream-pending" markers in
skill content for unresolved questions.

**Confidential context leakage.** A PM-facing skill summarises planning
context that includes pre-decisional or stakeholder-political content.
*Detection:* skill output cites material that should have stayed in
`.planning/`. *Mitigation:* skill source-of-truth excludes
`.planning/` and `.serena/` by construction.

## Alternatives

**A — Single multi-audience skill.** One package, audience routing on
entry. Lowest maintenance burden; risk of muddled tone.

**B — Three audience-specific skills.** End-user, developer, and PM
skills shipped separately. Cleanest tone separation; highest
maintenance.

**C — Two skills (technical / non-technical).** Technical skill for
devs and PMs combined; non-technical for end-users. Compromise on tone
separation and maintenance.

**D — Skills derived from canvases at build time.** A pipeline reads
`docs/plans/` and emits skills automatically. Highest fidelity, highest
infrastructure cost.

**E — Defer.** Don't build skills as a v1.0 by-product; revisit
post-v1.0 when canvases stabilise. Cost: misses the day-1
context-accumulation opportunity that motivated this canvas in the
first place.

## Readings

- **Day 1 / on-the-fly:** A or C — start with one or two skills that
  work today, accept some tone compromise, refine as audiences give
  feedback.
- **v1.0+ deliverable:** B or D — three skills (or auto-generated from
  canvases) once the audiences are validated and the maintenance
  discipline is clear.

## Surfaces in motion

Components mid-flight whose skills and docs the AI-skills work should
treat as not-yet-settled.

- *(none currently)*

## Covered surfaces

Finalised components with an ADR — eligible for skill coverage.

- **C8** — Domain-separation registry · ADR 0001 · [canvas](C8-domain-separation-registry.md) · audiences eligible: dev, PM
