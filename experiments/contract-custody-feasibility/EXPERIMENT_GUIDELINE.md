# Experiment Brief — Contract Custody Feasibility on Midnight v1

**Date scoped:** 2026/04/27
**Owner:** _to be assigned_
**Target location:** `experiments/contract-custody-feasibility/`

---

## Goal

Empirically determine, on the latest Midnight v1 SDK and devnet node, whether
a Compact smart contract can act as a **custody address** for all three asset
types — shielded (Zswap), unshielded (Night), and Dust — and whether a
contract can **pay the Dust fees of a transaction** from a contract-held Dust
balance.

The deliverable is a strict, reproducible statement of what works, what fails,
and what only partially works on v1 today. No theoretical analysis — every
finding must be backed by a transaction hash or a specific node error code.

## Why this matters

The Midnight Passport account model proposed in
[`secure-onboarding-design.md` § 7](../../docs/reference/machine-investigation/key-flows/secure-onboarding-design.md)
assumes contract custody of all three asset types. A prior investigation
documented ledger errors 168 and 186 as blockers on older SDK versions
(`developer-guide.md` § 4370–4435 and § 5260–5340). The Midnight Foundation
CTO confirmed on 2026/04/27 that **error 186 has been fixed in the past
month**; the status of error 168 was not confirmed. This experiment closes
that gap. The result determines whether the principle-perfect contract-custody
account model is viable on v1, or whether we must commit to a cryptographic
alternative (e.g. FROST t≥2 with a PIN factor) for the post-MVP multi-device
milestone.

## In scope — test cases

Each test must produce either a successful transaction hash plus on-chain
state delta, or a specific node error code plus the captured response.

### Unshielded (Night)

1. `receiveUnshielded` — user wallet deposits Night into a contract.
   *Previously failed with error 168 on SDK ≤ 3.2.0; status on latest SDK
   unknown.*
2. `sendUnshielded` → `ContractAddress` — contract sends Night to another
   contract. *Previously failed with error 186; CTO-confirmed fixed.* Verify
   and document.
3. `sendUnshielded` → `UserAddress` — contract sends Night to a user. *Known
   to work since `midnight-js-contracts` v3.2.0; rerun as a regression check.*
4. End-to-end round trip — user → contract A → contract B → user. Should
   succeed iff (1) and (2) both pass.

### Shielded (Zswap)

1. `mintShieldedToken` → `kernel.self()` — contract mints shielded tokens to
   itself. *Known to work.*
2. `sendImmediateShielded` from contract → user, atomic mint+send within a
   single circuit. *Known to work.*
3. **Cross-transaction shielded custody** — contract holds shielded tokens
   for one or more blocks, then sends in a later transaction.
   *Previously failed with "Merkle tree not rehashed"; verify whether the
   Zswap protocol now supports this.*
4. **`receiveShielded`** — user sends shielded tokens to a contract.
   *Previously **untested** on devnet. This is the most critical net-new
   test in the entire experiment.*

### Dust

1. **Contract-held Dust balance and self-payment.** Can a contract hold a
   Dust balance and use it to pay the fees of a transaction it executes?
   - Verify whether `getDustBalance` (or equivalent) recognises a contract
     address.
   - Test paying the Dust fee for a contract-initiated transaction from the
     contract's own Dust balance, not from the originating wallet.
2. **Contract as paymaster for user transactions.** Can a contract sponsor a
   user's transaction by paying the Dust fee on the user's behalf?
   - Test whether the transaction structure permits a separate fee branch
     signed by the contract's Dust key, distinct from the user's
     authorisation branch, and whether the node accepts such a transaction.

## Out of scope

- FROST, threshold signatures, or any multi-device account model.
- Cross-chain operations.
- Production-grade contract design. Minimal contracts that exercise the
  operations are sufficient.
- Performance benchmarking, except where an operation is so slow it is
  effectively unusable.

## Setup

- **Language**: TypeScript only. No full Rust client library exposes the v1
  Zswap and contract-balance APIs needed. The existing
  [`../redjubjub-wallet-rs/`](../redjubjub-wallet-rs/) is scoped to Schnorr
  verification and does not cover this surface.
- **Reference TS infrastructure**: copy the local devnet harness from
  [`../redjubjub-wallet/`](../redjubjub-wallet/). Reuse the devnet docker
  config, the TypeScript package layout, and the build/run scripts. Strip
  out the redjubjub-specific application code; keep only the devnet harness.
- **SDK**: latest published `@midnight-ntwrk/midnight-js-*` packages at the
  date the experiment is run. Pin exact versions in `FINDINGS.md`.
- **Node**: latest stable Midnight devnet node image. Pin the exact version.
- **Compact contracts**: write the minimum contracts needed. A single test
  contract exposing circuits for each test case — `deposit_unshielded`,
  `send_unshielded_to_user`, `send_unshielded_to_contract`,
  `mint_and_send_shielded`, `receive_shielded`, plus the Dust variants —
  is sufficient.

## Deliverables

1. **`experiments/contract-custody-feasibility/`** — the experiment
   directory with the devnet harness, the Compact test contract(s), and the
   TypeScript test runner.
2. **`experiments/contract-custody-feasibility/FINDINGS.md`** with:
   - **Header**: SDK package versions, node version, date the experiment
     was run, devnet commit/tag.
   - **Per-test-case results table**:
     `test name | status (PASS / FAIL / PARTIAL) | tx hash or error code | one-line note`.
   - **Per-asset-type summary**: a short paragraph each for Unshielded,
     Shielded, and Dust.
   - **Verdict** — exactly one of:
     - *Feasible for all three asset types; contract custody is viable on v1.*
     - *Feasible for {list}; not feasible for {list}.*
     - *Not feasible for any asset type.*
   - **Implications for the Passport account model** — one paragraph stating
     which alternative path is on the table given the result, feeding back
     into [`RESEARCH.md`](../../RESEARCH.md).
3. **`experiments/contract-custody-feasibility/evidence/`** — per-test JSON
   files capturing the request, response, transaction hash (or error code +
   node response), and relevant node logs.
4. **Reproducibility**: a single command (e.g. `pnpm test` or `./run-all.sh`)
   that brings up the local devnet, runs every test, and writes the
   evidence files. Anyone with the pinned SDK installed must be able to
   reproduce the findings end-to-end on a clean checkout.

## Acceptance criteria

- Every test case in the In Scope list has a definitive result backed by an
  evidence file.
- The verdict in `FINDINGS.md` is one of the three above, justified by the
  per-test results.
- The reproducibility command runs end-to-end on a fresh checkout.
- SDK and node versions are pinned and documented.

## References

- [`RESEARCH.md`](../../RESEARCH.md) — the architectural context this
  experiment feeds back into.
- [`secure-onboarding-design.md` § 7](../../docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#7-account-model)
  — the account model that depends on contract custody.
- [`developer-guide.md` § 4370–4435](../../docs/reference/machine-investigation/midnight-v1-documentation/developer-guide.md)
  — prior error 186 investigation (now reportedly fixed).
- [`developer-guide.md` § 5260–5340](../../docs/reference/machine-investigation/midnight-v1-documentation/developer-guide.md)
  — prior shielded-lifecycle investigation, including the Merkle-rehash
  constraint.
- [`../redjubjub-wallet/`](../redjubjub-wallet/) — TypeScript devnet
  infrastructure to copy.
- Midnight Foundation CTO communication, 2026/04/27: *"186 was a (somewhat
  famous) bug that was fixed last month. I forgot what happened with 168."*
