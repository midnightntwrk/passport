<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logos/Full%20Logo/Input%20Output_Full%20Logo_RGB_White.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/logos/Full%20Logo/Input%20Output_Full%20Logo_RGB_Black.png">
    <img alt="Input Output" src="assets/logos/Full%20Logo/Input%20Output_Full%20Logo_RGB_Black.png" width="300">
  </picture>
</p>

# Midnight Passport

**Advanced Research and Creativity (ARC)** — Input Output Global

Midnight Passport is the user-facing identity and wallet layer for the Midnight network. The goal: a user scans a QR code and lands on a fully functional account — named, authenticated, ready to transact — without ever seeing a seed phrase, an address, or a gas-token purchase screen.

This repository holds the plan, the research that backs it, the reference material we build from, and the early experiments that de-risk the cryptographic foundations. The prototype codebase tracking the plan lives in a separate repository.

## What to read first

| If you are… | Read |
|---|---|
| A stakeholder wanting the plan | [`docs/the-plan.html`](docs/the-plan.html) (visual) · [`docs/delivery-plan.html`](docs/delivery-plan.html) (prose) |
| A developer joining the team | [`research/README.md`](research/README.md), then [`docs/mvp-architecture.md`](docs/mvp-architecture.md) |
| A partner evaluating the proposal | [`docs/passport-plan.md`](docs/passport-plan.md) |
| Looking for the design vision | [`docs/secure-onboarding-design.pdf`](docs/secure-onboarding-design.pdf) |

## Repository structure

```
arc-passport/
├── docs/
│   ├── the-plan.html            Visual stakeholder pre-read
│   ├── delivery-plan.html       Written delivery specification
│   ├── passport-plan.md         High-level plan summary
│   ├── mvp-architecture.md      MVP architecture reasoning
│   ├── KNOWLEDGE_BASE.md        Working knowledge base
│   ├── secure-onboarding-design.pdf   Vision document (source)
│   └── reference/               Subtree — reference material from upstream
├── research/                    Background research informing the plan
│   ├── stack.md · architecture.md · features.md · pitfalls.md · summary.md
├── experiments/                 Cryptographic experiments
│   ├── redjubjub-wallet/        Schnorr-in-Compact-circuit validation (TypeScript)
│   ├── redjubjub-wallet-rs/     Schnorr-in-Compact-circuit validation (Rust)
│   └── nearfall-evaluation/     Subtree — Midnight-related evaluation archive
```

## Reference material

`docs/reference/` and `experiments/nearfall-evaluation/` are git subtrees sourced from remote repositories. They are kept in the tree so that context is always at hand, but they are maintained upstream. To update a subtree:

```sh
git subtree pull --prefix=docs/reference https://github.com/LFDT-Nightstream/MVE-Planning.git main --squash
git subtree pull --prefix=experiments/nearfall-evaluation git@github.com:input-output-hk/arc-nearfall-evaluation.git main --squash
```

## Licence

This project is licensed under the Apache License 2.0 — see the [LICENCE](LICENCE) file.

---

Copyright © 2026 Input Output Global, Inc.
