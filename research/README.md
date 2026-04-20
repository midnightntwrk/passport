# Research notes

This directory collects the background research carried out for Midnight Passport. It is not a set of requirements or a specification; it is the landscape survey that informed the plan — what exists in the ecosystem, what the cryptographic and protocol hazards are, what prior art we borrow from, and where the gaps lie.

## Reading order

For someone new to the project, the shortest path is:

1. **[`summary.md`](./summary.md)** — the synthesis. Start here. Covers the overall stance: what we adopt, what we build, what we explicitly avoid.
2. **[`stack.md`](./stack.md)** — the technology and library landscape for threshold signing on JubJub, including which crates to depend on and which decisions remain open.
3. **[`architecture.md`](./architecture.md)** — side-by-side comparison of reference threshold-MPC networks (NEAR, Lit, Web3Auth, Fireblocks, dWallet, ZenGo) and the architectural lessons each one gives us.
4. **[`features.md`](./features.md)** — feature-level ecosystem reconnaissance: onboarding UX, naming, account models, recovery, credentials, dApp-wallet connection.
5. **[`pitfalls.md`](./pitfalls.md)** — the risk catalogue: cryptographic, protocol, operational, regulatory, and UX pitfalls, each with a specific mitigation.

## What this is *not*

- **Not the plan.** The plan is in [`../docs/delivery-plan.html`](../docs/delivery-plan.html). If research and plan conflict, the plan is authoritative.
- **Not a specification.** Protocol, API, and data-format specifications are published as Midnight Improvement Proposals (MIPs) when the team drafts them.
- **Not a living document.** Each file is dated. When the context changes materially, the document is updated with a dated correction note rather than silent rewriting — so that earlier decisions remain readable against the evidence available at the time.

## Internal identifiers

Some of the research notes reference short internal identifiers used in the team's private planning (for example `STD-01`, `MVP-01`, `ECO-02`). These are informal shorthand. They refer to:

- **STD-*** — standards the project plans to draft as MIPs (key derivation, address format, domain separators, etc.).
- **MVP-*** — MVP-scope components (threshold signer, in-circuit verifier, account provider, and so on).
- **ECO-*** — higher-priority ecosystem standards (dApp-wallet connection protocol, privacy-preserving credentials).
- **META-*** — cross-cutting process items (stakeholder onboarding narrative, formal-methods engagement plan).
- **DEC-*** — requirement decisions recorded in the team's internal decision log.

Where an identifier appears without context, it is safe to read it as "a named future work item" and continue. If you need the precise definition, ask the project lead.

## Provenance and confidence

Each file has a header that states the research date and the researcher's confidence level. Sources are cited inline. Where a finding was later verified or corrected, the correction is appended at the top of the relevant section so that the original reasoning is preserved.
