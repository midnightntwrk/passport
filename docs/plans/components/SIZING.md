# Component sizing & skill mix

> **Status — discussion draft.** Opinionated working artefact, meant to provoke argument before we commit to anything downstream of it. Cells reflect a reading of each component canvas in this directory; they are not a contract.

Two attributes per component, both relative, both shape-not-precision:

1. **Size** — a coarse t-shirt estimate of the relative effort to close the component out. No time unit attached.
2. **Skill-mix profile** — for whatever effort the component requires, how that effort is distributed across eight skill profiles. Cells in a row sum to 1.00.

A single person can carry several profiles. The table is about *what skills are needed*, not headcount.

## How to read it

- Look down the **Size** column for the relative weight across the project.
- Read across a row for the skill mix demanded by one component.
- Look down a profile column to see which components stress that skill most.

## What this is not

- Not a workload estimate in time units. Effort is relative.
- Not a sequencing or critical-path tool — that lives in `the-plan.html` and the parallelisation map.
- Not a headcount. A 0.40 cell is 40% of the *skill demand*, not 0.4 FTE.

## Sizing anchors

| Size | Meaning |
|---|---|
| **XS** | Trivial. Default is obvious, template exists, no real open questions. |
| **S** | Small. One or two narrow open questions, implementation pattern known. |
| **M** | Medium. Several real open questions, but the shape of the answer is visible. |
| **L** | Large. Real discovery + real build. Multiple live alternatives. |
| **XL** | Workstream. Discovery dominates, decisions cascade into other components, ecosystem coordination required. |

## Profile legend

| Short | Profile | Scope |
|---|---|---|
| **Crypto** | Cryptographer | Scheme design, security proofs, primitive choice, soundness arguments. |
| **Spec** | Protocol / spec author | MIPs, CIPs, normative text, interop discipline, ecosystem coordination. |
| **Circuit** | Compact circuit engineer | Compact language, witnesses, proof-server tuning, k-bound, in-circuit verification. |
| **Contract** | Chain-side / smart-contract engineer | On-chain Compact contracts, ledger Intents, on-chain enforcement, state design. |
| **Wallet** | Wallet / TypeScript engineer | Wallet code, indexer client, dApp transport, passkey / WebAuthn, platform secure storage. |
| **DID** | Identity / DID specialist | did-core, W3C VCs, selective-disclosure semantics, credential interop. |
| **Sec** | Security / threat-model reviewer | Adversary modelling, privacy review, audit-style critique. |
| **UX** | UX / product designer | User flows (recovery, lost-device), trust prompts, voice across audiences. |

## Matrix

| Component | Size | Crypto | Spec | Circuit | Contract | Wallet | DID | Sec | UX |
|---|:-:|---:|---:|---:|---:|---:|---:|---:|---:|
| **C1** Account-custody contract | L | 0.10 | 0.15 | 0.10 | 0.45 | 0.05 | 0.00 | 0.15 | 0.00 |
| **C2** Name service | L | 0.10 | 0.20 | 0.10 | 0.35 | 0.10 | 0.05 | 0.05 | 0.05 |
| **C3** DID surface | XL | 0.10 | 0.25 | 0.15 | 0.05 | 0.05 | 0.30 | 0.05 | 0.05 |
| **C4** Asset custody model | XL | 0.30 | 0.15 | 0.15 | 0.20 | 0.05 | 0.00 | 0.15 | 0.00 |
| **C5** Signing primitive | M | 0.40 | 0.10 | 0.20 | 0.05 | 0.05 | 0.00 | 0.20 | 0.00 |
| **C6** Proof generation | L | 0.20 | 0.05 | 0.30 | 0.00 | 0.30 | 0.00 | 0.10 | 0.05 |
| **C7** Witness handling | M | 0.20 | 0.05 | 0.10 | 0.00 | 0.40 | 0.00 | 0.25 | 0.00 |
| **C8** Domain-separation registry | M | 0.40 | 0.20 | 0.15 | 0.05 | 0.00 | 0.00 | 0.20 | 0.00 |
| **C9** Device-bound authentication | M | 0.15 | 0.05 | 0.00 | 0.05 | 0.50 | 0.00 | 0.20 | 0.05 |
| **C10** Scoped grant primitive | L | 0.15 | 0.25 | 0.10 | 0.30 | 0.05 | 0.00 | 0.15 | 0.00 |
| **C11** Grant lifecycle | M | 0.05 | 0.15 | 0.10 | 0.45 | 0.05 | 0.00 | 0.15 | 0.05 |
| **C12** Chain-side enforcement | L | 0.20 | 0.10 | 0.30 | 0.20 | 0.00 | 0.00 | 0.20 | 0.00 |
| **C13** Lost-device flow | S | 0.05 | 0.10 | 0.05 | 0.10 | 0.20 | 0.00 | 0.20 | 0.30 |
| **C14** Total-loss recovery flow | L | 0.25 | 0.10 | 0.05 | 0.10 | 0.20 | 0.00 | 0.15 | 0.15 |
| **C15** Helper protocol | L | 0.20 | 0.30 | 0.00 | 0.05 | 0.20 | 0.00 | 0.20 | 0.05 |
| **C16** Wallet local storage | M | 0.10 | 0.05 | 0.00 | 0.00 | 0.55 | 0.00 | 0.25 | 0.05 |
| **C17** View-key + indexer sync | M | 0.10 | 0.20 | 0.00 | 0.05 | 0.40 | 0.00 | 0.20 | 0.05 |
| **C18** Attestation tree | M | 0.20 | 0.10 | 0.20 | 0.20 | 0.05 | 0.15 | 0.10 | 0.00 |
| **C19** Credential issuance | L | 0.10 | 0.20 | 0.05 | 0.15 | 0.10 | 0.30 | 0.10 | 0.00 |
| **C20** Selective-disclosure proof | L | 0.35 | 0.15 | 0.20 | 0.05 | 0.05 | 0.15 | 0.05 | 0.00 |
| **C21** Nullifier | S | 0.45 | 0.15 | 0.15 | 0.05 | 0.00 | 0.05 | 0.15 | 0.00 |
| **C22** Intent surface | XL | 0.10 | 0.30 | 0.05 | 0.15 | 0.25 | 0.00 | 0.05 | 0.10 |
| **C23** dApp connection protocol | L | 0.05 | 0.40 | 0.00 | 0.05 | 0.30 | 0.05 | 0.10 | 0.05 |
| **C24** Fee model | L | 0.05 | 0.20 | 0.00 | 0.20 | 0.35 | 0.00 | 0.15 | 0.05 |
| **C25** Cross-chain integration interface | XL | 0.10 | 0.40 | 0.00 | 0.10 | 0.20 | 0.05 | 0.15 | 0.00 |
| **C26** AI Agent skills | S | 0.05 | 0.30 | 0.00 | 0.00 | 0.10 | 0.05 | 0.05 | 0.45 |

## Distribution at a glance

**Sizes:** 4 XL, 11 L, 8 M, 3 S, 0 XS.

- **XL (4) — workstreams.** C3, C4, C22, C25. Discovery and ecosystem coordination dominate, not build effort. Sizing is the most volatile here — once a workstream resolves, both size and mix may shift.
- **L (11) — substantial engineering with real discovery.** C1, C2, C6, C10, C12, C14, C15, C19, C20, C23, C24.
- **M (8) — bounded engineering with known patterns.** C5, C7, C8, C9, C11, C16, C17, C18.
- **S (3) — narrow surface.** C13, C21, C26 (day-1 minimum scope).

The L bucket is large because most components are real engineering with non-trivial discovery. Plausible demotions to M: C19, C24. Plausible promotions to XL: C20 (if compliance binding to C22 turns out architecturally hard), C23 (if MIP coordination becomes a quagmire).

## Profile clusters

A first scan of where each profile concentrates. Useful for thinking about who needs to be available at a given phase, not for ranking importance.

- **Crypto-dominant.** C5 (signing primitive), C8 (domain separation), C20 (selective-disclosure proof), C21 (nullifier), C4 (asset-custody scheme), C14 (recovery scheme).
- **Spec-dominant.** C23 (dApp connection — MIP-5 / MIP-7), C25 (cross-chain interface), C22 (intent surface — PRD interop), C15 (helper protocol — DeRec), C26 (AI agent skills as documentation), C3 (DID method registration).
- **Circuit-dominant.** C12 (verifier circuit), C6 (proof generation), C5, C20, C18 (attestation tree).
- **Contract-dominant.** C1 (account custody), C11 (grant lifecycle), C2 (name service), C10 (scoped grant primitive).
- **Wallet-dominant.** C16 (local storage), C9 (device-bound auth), C17 (indexer sync), C7 (witness handling pipeline), C24 (fee splitting), C23 (dApp transport).
- **DID-dominant.** C3 (the DID workstream itself), C19 (credential issuance), C18 / C20 (credential cluster).
- **Security-distributed.** Sec is the most evenly-spread column — nearly every component pulls on threat-modelling. Highest concentrations: C7, C16, C5, C11, C12, C14, C20, C21.
- **UX-dominant.** C26 (audience tone), C13 (lost-device flow), C14 (recovery flow). UX otherwise low — Passport is a protocol stack rather than a UI product, in the table's framing.

## Caveats

- **The numbers are opinionated.** Two of us would not produce identical sizes or ratios. Treat cells as the *shape* of the work, not a precise allocation.
- **Workstream components are provisional.** C3, C4, C22, C24, C25 are still in flux. Once a workstream resolves, the chosen alternative may change both size and mix. C4 is the clearest case — alternative A (contract-custody) is more crypto- and circuit-heavy than alternative B (address-custody), which would lean wallet.
- **C26 is a meta-deliverable.** Its skill mix is dominated by writing and audience design, not engineering. Don't compare its column shape to engineering components without that context.
- **External work absorbed upstream is not represented.** The MCS / threshold-Schnorr layer (C25) and the upstream Midnight Intents PRD (C22) are owned outside Passport — sizing only counts the Passport-side integration cost.

## Source

Each row is informed by the canvas next to this file (`C<n>-*.md`). Open questions, dependencies, and alternatives in those canvases drive both the size and the skill mix. If you disagree with a row, that canvas is the place to argue from.
