# CLAUDE.md

You are an AGENT working for the Advanced Research and Creativity (ARC) department at Input Output Global (IOG). You are assisting the researchers and engineers — they are experts in their domain. Respond concisely.

## Project

**Midnight Passport — Planning Workspace**

This repository is the planning and knowledge-gathering workspace for Midnight Passport, the user-facing identity and wallet layer for the Midnight network (`alice.midnight` names, passkey onboarding, multi-device, privacy-preserving credentials). We produce architecture, protocol drafts, research, and decision records here. The working prototype lives in a separate repository and evolves against the standards defined in this one.

**Audience:** internal IOG ARC, the Midnight Foundation, partner wallet and dApp developers, and the wider standards community (MIPs, and where relevant CIPs).

**Core value:** produce a coordinated plan — scope, sequencing, delegation, decision records — that lets a small team deliver demonstrable weekly progress toward a Midnight Passport MVP, and ultimately a set of MIPs and CIPs the wider ecosystem can adopt.

## Constraints

- **Timeline (hard):** MVP target is end of June 2026. After June, 90-day cadence for major milestones.
- **Timeline (soft, firm):** demonstrable progress every week. The weekly commit is the contract; the June MVP is the aspiration. If a week's intended deliverable slips, show the next thing that works rather than a broken thing.
- **Ecosystem dependency:** protocols we draft must be adoptable by the Midnight Foundation, Lace, and third-party wallets. Unilateral design produces shelfware.
- **Prototype lives elsewhere:** decisions and specs must be portable to a separate repository. Over-specifying implementation details risks rework; under-specifying risks the prototype team free-styling.
- **Research vs. specification balance:** every standard we draft is backed by evidence — an experiment, an upstream extraction, or a cryptographer review. Speculative specs do not compel adoption.

## Repository layout

- `docs/` — plan and design documents. `docs/the-plan.html` and `docs/delivery-plan.html` are the stakeholder-facing artefacts.
- `research/` — background research informing the plan.
- `experiments/` — cryptographic validation experiments (TypeScript and Rust).
- `docs/reference/` — git subtree from `https://github.com/LFDT-Nightstream/MVE-Planning.git`.
- `experiments/nearfall-evaluation/` — git subtree from `git@github.com:input-output-hk/arc-nearfall-evaluation.git`.
- `.planning/` — internal planning notes, **gitignored**. Never committed.

## Experiments

Both experiments validate Schnorr-verification-in-a-Compact-circuit end-to-end on Midnight devnet. They produce identical signatures across the language boundary, so the signing boundary is client-agnostic.

- `experiments/redjubjub-wallet/` — TypeScript client and signer.
- `experiments/redjubjub-wallet-rs/` — Rust client and verifier.

Build artefacts (`node_modules/`, `target/`) are gitignored.

## Key conventions

- British English. Oxford comma. Date format `YYYY/MM/DD`.
- Prefer "colour" not "color", "centre" not "center".
- See `.claude/rules/` for the full conventions reference, including Rust style and the IOG brand guidelines.

## What not to do

- Do not commit anything under `.planning/` or `.serena/`.
- Do not reintroduce stakeholder-political framing into any committed document. That content lives in `.planning/` for internal use only.
- Do not treat `docs/reference/` or `experiments/nearfall-evaluation/` as ours to edit — they are maintained upstream. Use `git subtree pull` to update.
