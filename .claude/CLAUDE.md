# CLAUDE.md

You are an AGENT working for the Advanced Research and Creativity (ARC) department at Input Output Global (IOG). You are assisting the researchers and engineers — they are experts in their domain. Respond concisely.

## Project

**Midnight Passport — Architecture, Standards, and Reference Implementation**

This repository contains architecture, protocol drafts, research, decision records, the reference implementation (`contract/`), demos (`demo/`), and experiments for Midnight Passport. Start with `docs/arc42.md`; `docs/README.md` defines documentation ownership, and `docs/plans/MIPS.md` is the standards register. Published upstream standards are canonical; local code and dated evidence establish this checkout's implemented scope.

**Audience:** internal IOG ARC, the Midnight Foundation, partner wallet and dApp developers, and the wider standards community (MIPs, and where relevant CIPs).

**Core value:** produce a coordinated plan — scope, parallelisation map, delegation, decision records — that identifies what can be built simultaneously across teams (or sequenced by a single team), records evidence against the original October 2026 demo target, and ultimately produces a set of MIPs and CIPs the wider ecosystem can adopt.

## Constraints

- **Timeline:** October 2026 was the recorded public-demo target; this checkout does not establish its delivery outcome. Feature-complete v1.0 has no release date recorded here.
- **Weekly cadence:** demonstrable progress every week remains the preferred rhythm but is no longer a hard contract. If a week's intended deliverable slips, show the next thing that works rather than a broken thing.
- **Ecosystem dependency:** protocols we draft must be adoptable by the Midnight Foundation and partner wallets. Unilateral design produces shelfware.
- **Implementation boundaries:** distinguish the reference contract, prototype, and demo. Do not infer conformance or delivery from a proposal, canvas, or past milestone.
- **Research vs. specification balance:** every standard we draft is backed by evidence — an experiment, an upstream extraction, or a cryptographer review. Speculative specs do not compel adoption.

## Repository layout

- `site/` — static web artefacts deployed to GitHub Pages. Five pages: `index.html` (landing: pitch, status, role routing), `demo.html` (how it works + the October demo), `standards.html` (MIP register and implementer path), `architecture.html`, and `plan.html` (working surface: promises, canvases, dependencies, parallelisation). `site/check.js` gates the deploy on link/anchor/data integrity. Earlier artefacts (plan pages, the onboarding mockup) live in `site/archive/`; retired URLs keep redirect stubs. Uses `../assets/logos/…` so it still renders locally.
- `docs/` — plan and design documents in prose (markdown and PDF).
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
- Prefer "colour" not "color", "centre" not "center" in prose; retain exact protocol terms such as `color`.
- See `.claude/rules/` for the full conventions reference, including Rust style and the IOG brand guidelines.

## What not to do

- Do not commit anything under `.planning/` or `.serena/`.
- Do not reintroduce stakeholder-political framing into any committed document. That content lives in `.planning/` for internal use only.
- Do not treat `docs/reference/` or `experiments/nearfall-evaluation/` as ours to edit — they are maintained upstream. Use `git subtree pull` to update.
