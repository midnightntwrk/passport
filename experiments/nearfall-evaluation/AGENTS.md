# Architectural Intelligence Guide

## Project: Architectural Evaluation of NEAR for MidnightOS (NEARFall)

This document serves as the primary context to interpret the contents of this repository. It defines the strategic urgency and technical boundaries of the "NEARFall" feasibility study.

## 🎯 Mission Objective

Conduct a comparative feasibility study to evaluate three architectural paths for Midnight's 2026 scalability and usability mandates:

1. **Port to NEAR:** Full re-platforming to the NEAR Protocol stack (acknowledged as highly costly).
2. **Take Software from NEAR:** Extracting and integrating specific NEAR components into the current architecture.
3. **Take Ideas from NEAR:** Adopting NEAR's architectural patterns natively within the existing Substrate framework.

**Scope Boundary:** This project ("NEARFall" or "Midnight 2.0") focuses on a comparative feasibility analysis of re-platforming versus component integration versus architectural adaptation. The "Intents" project led by Alan is a separate, sibling effort; this repo focuses on the underlying infrastructure that enables such high-level applications.

**Scope Qualifier (Background 6, 2026-03-20):** The organizational mandate for Option 1 is narrower than initially framed — it reflects Charles's personal direction rather than broad organizational consensus. Additionally, NEAR's networking layer has been assessed as architecturally similar to Ouroboros, with Midnight's TPS bottleneck identified as **block size** rather than protocol throughput (Jon Rossie). This suggests the 500+ TPS goal may be better approached through Layer-2 rollup architecture than platform migration. These observations are course corrections to the weighting of the three options, not a narrowing of scope — significant opportunities may still exist across all three paths.

### Integration Roadmap Strategy:

- **Phase 1 (Starting Point):** The current Midnight platform (v1 / Substrate).
- **Phase 2:** Layer-2 technologies (Starstream, Nightstream, Paima, etc.).
- **End Goal:** Ensure all these technologies ultimately converge into a single, coherent architecture (even if components remain decoupled).

### Stakeholder-Requested Topics

Specific topics requested or suggested for evaluation, drawn from stakeholder input (primarily Charles and project leads):

- **Scalability:**
	- [x] 500+ TPS roll-up architecture to replace the current 3 TPS L2 — urgent 2026 priority ([Background 2](./journal/project-increment-1.md#background-2))
	- [x] Roll-up compatibility with Midnight native state — current L2 does not roll up or work with Midnight native state ([Background 2](./journal/project-increment-1.md#background-2))
- **Key Management and Chain Abstraction:**
	- [x] Hierarchical key derivation for multi-chain addresses — derive keys for Cardano, Ethereum, Solana, etc. from a single root key ([Background 6](./journal/project-increment-1.md#background-6))
	- [x] Chain abstraction — chain-agnostic transaction surface as a design pattern ([Background 6](./journal/project-increment-1.md#background-6))
- **Privacy and TEE:**
	- [x] TEE integration as a fast privacy path — "cheat codes" to add privacy quickly without full ZK ([Background 6](./journal/project-increment-1.md#background-6))
- **Layer-2 Technologies:**
	- [x] Starstream — browser-side VM and language for private transcripts ([Background 0](./journal/project-increment-1.md#background-0)/[3](./journal/project-increment-1.md#background-3))
	- [x] Nightstream — lattice-based crypto for provable WASM components ([Background 0](./journal/project-increment-1.md#background-0)/[3](./journal/project-increment-1.md#background-3))
	- [x] Paima — multi-chain roll-up mechanism ([Background 0](./journal/project-increment-1.md#background-0)/[3](./journal/project-increment-1.md#background-3))
- **Migration and Interoperability:**
	- [ ] Ledger migration strategy — without moving the ledger, network migration is not possible ([Background 2](./journal/project-increment-1.md#background-2))
	- [ ] Bridge and partner DApp continuity — cNIGHT ↔ mNIGHT and existing integrations must survive any platform transition ([Background 2](./journal/project-increment-1.md#background-2))
	- [ ] Convergence of all Layer-2 and platform work into a single coherent architecture ([Background 3](./journal/project-increment-1.md#background-3))

### Key Evaluation Pillars:

1. **Full Port Feasibility & Cost:** Establishing the cost floor and risk profile of a full re-platforming — the "major surgery" of a monolithic-to-modular transition, ledger migration, and total Substrate replacement — as a baseline against which Options 2 and 3 are weighed.

2. **Component Extraction ("Take Software"):** Assessing the technical difficulty of decoupling NEAR's tightly integrated monolithic codebase (`nearcore`) to use isolated components within Midnight OS without a full platform migration.

3. **Architectural Adaptation ("Take Ideas"):** Assessing whether building NEAR-inspired mechanisms natively in Substrate is a faster and safer route to achieving the 500+ TPS goal than the other options.

4. **Runtime & Modularity Compatibility:** Verifying if Midnight OS components (**Starstream, Nightstream, Paima**) and the **Impact interpreter** / **Kachina model** can be supported under any of the three NEAR-inspired paths.

5. **Migration & Interoperability:** Ensuring existing Cardano bridges (cNIGHT ↔ mNIGHT) and partner DApps remain functional during the transition (e.g., via **Chain Signatures (MCS)**).

6. **TPS Bottleneck Diagnosis:** Determining how much of the 500+ TPS mandate is achievable through Layer-2 rollup approaches (Paima, Nightstream) without platform migration, using the current Substrate block-size constraint as the baseline. This informs the cost-benefit case for all three options.

## 📂 Repository Blueprint

- `/artifacts/`: Miscellaneous notes and work products.
- `/assessments/`: Technical deep-dives into NEAR components and Midnight OS integration points. Every assessment must include a `## Sources` section at the end with entries in `[Title — Publisher/Context](URL)` format; use `Title — Publisher/Context (internal)` for internal documents without public URLs, with the repository-relative path in parentheses. Split the sources section into named subsections (e.g., `### General Sources`, `### NEAR Sources`, `### Midnight Sources`) when the source base spans multiple distinct domains.

  **Quality-assessment Afterword:** Only add an `## Afterword: Quality Scrutiny` section when explicitly asked to do so. When asked, append it after all existing content and structure it as five subsections:
  1. **Sources correspond to retrievable URLs** — attempt to fetch each cited URL; note which are accessible, which redirect, and which are unreachable or require authentication.
  2. **Internal consistency** — verify that the document's claims do not contradict one another, that terminology is used uniformly, and that conclusions follow from the stated evidence.
  3. **Accuracy against sources** — for each factual claim, identify the source sentence or structure it relies on; flag paraphrases presented as direct quotations, omitted qualifications, and claims that go beyond what the sources state.
  4. **Areas of greatest uncertainty** — list claims that are unsourced, rely on a single source, depend on internal cross-references, or involve design-intent attributions that could not be independently verified.
  5. **Robustness of primary conclusions** — assess whether the main conclusions survive the uncertainties identified above; note if any uncertainty is load-bearing (i.e., resolving it differently would overturn a conclusion).
- `/background/`: **[PRIVATE/PROPRIETARY]** Centralized storage for reference materials, internal roadmaps, and sensitive communications.
- `/comparisons/`: Benchmarking NEAR against Substrate and other candidate stacks.
- `/experiments/`: Code spikes testing NEAR's SDK, Nightstream verification, or roll-up logic.
- `/journal/`: 100-day logs, each representing a "project increment" (e.g., `project-increment-1.md`). Entries are in **reverse-chronological order**: when inserting a new entry, add it as the first H3 under today's H2 section. Horizontal rules (`---`) are used **only** to separate date sections (H2 headings); never use a horizontal rule within a journal entry. **Weekly summary entries** use a short bulleted list: aim for 5–7 bullets maximum. Each bullet names a *topic or activity area* worked on (not an individual implementation step), written at a level a non-specialist could understand — omit jargon, sub-points, and implementation details. Include non-technical activities such as stakeholder outreach and executive documents. Check completed items from any "Plan for the week" list as a source. Write in neutral tone without asserting conclusions, and without links to other documents.

## 📝 Conventions

The following semantic markers are used throughout this repository:

- 🧪**HYPOTHESIS**: Denotes a theory or technical assumption we are about to test.
- 📊**EVIDENCE**: Links specific experimental data or benchmark results to a claim.
- 🛑**BLOCKER**: High-priority technical hurdles requiring architectural resolution.
- 🏛️**ADR**: (Architecture Decision Record) Formal markers for finalized design choices.
- 🛡️**SPEC**: Specific requirements unique to MidnightOS that NEAR must satisfy.
- ⚠️**RISK**: Potential risk needing consideration and evaluation.
- ❓**SCRUTINY**: Marks quantitative estimates or analytical conclusions produced by a human that have not yet been empirically verified and should be treated with caution before use in decisions.
- ❓🤖**SCRUTINY**: Marks quantitative estimates or analytical conclusions produced by LLM-assisted reasoning that require particular scrutiny — numbers and logic may be internally consistent but are unverified against measurements or authoritative sources.

Provenance markers are used for journal entries and other notes:
- 🤖 were generated by an LLM, but reviewed by a human.
- 👱🤖 drafted by human and collaboratively refined by LLM.
- 🤖👱 drafted by LLM and collaboratively refined by human.
- Unmarked entries were solely drafted by a human.

The provenance marker on an assessment document is propagated to its journal summary entry: the journal H3 heading should carry the same marker as the assessment's H1 title (e.g., an assessment titled `# 🤖👱 …` produces a journal entry `### 🤖👱 …`).

## ⏳ Timeline

Each hundred-day iteration is a **double diamond** in the sense of design thinking, comprising two back-to-back discover–define cycles:

| Diamond        | Phase      | Days   | Dates           | Focus                                           |
| -------------- | ---------- | ------ | --------------- | ----------------------------------------------- |
| 1 — Foundation | Divergent  | 1–25   | Mar 12 – Apr 5  | Broad exploration: generate hypotheses          |
| 1 — Foundation | Convergent | 26–50  | Apr 6 – Apr 30  | Hypothesis testing: converge on recommendations |
| 2 — Refinement | Divergent  | 51–75  | May 1 – May 25  | Refined exploration: regenerate hypotheses      |
| 2 — Refinement | Convergent | 76–100 | May 26 – Jun 19 | Hypothesis testing: converge on recommendations |

## 🤖 Persona & Analysis Instructions

When analyzing this repository, LLM assistants should:

1. **Assume a Senior Systems Architect Role:** Prioritize trade-offs, technical debt, and "The No Free Lunch" principle.

2. **Risk-Centric Analysis:** Perform comparative trade-off analysis between the three options. Weigh the "massive technical risk" of a full Substrate replacement against the integration complexity of extracting NEAR software or the development overhead of rebuilding NEAR's ideas from scratch.

3. **Traceability:** Link 🧪 **HYPOTHESIS** found in a journal section to code in `/experiments/` and the resulting 📊 **EVIDENCE**.

## 💬 Useful Prompts

- **Status summary:** "Summarize the last 10 journal entries. List new 🛑 BLOCKER items or 🏛️ ADR entries."
- **Migration status:** "What is the current thinking on the ledger migration strategy based on the background documents and journals?"
- **Rollup requirements:** "What are the identified requirements for the 500+ TPS roll-up architecture?"

## Instructions specific to particular LLMs

- *Claude*, please read [CLAUDE.md](./CLAUDE.md) for additional instructions.
- *Gemini*, please read [GEMINI.md](./GEMINI.md) for additional instructions.