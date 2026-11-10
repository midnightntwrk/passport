# Audit remediation queue

Updated: 2026/11/10. Review baseline: Passport `e0e4e0e6272399d71dfaaa7cae0689ab4e2363f3`.

This is the agreed order for four bounded improvements following the repository
audit. It tracks implementation and merge state separately. Closing a finding
requires regression evidence; it does not automatically establish a complete
[product promise](PROMISES.md) or change a historical audit rating.

## Current work and immediate successor

**Current: priority 4, multiple coins per asset.** Implementation and independent
agent review are complete on `codex/multi-coin-custody`, ready for pull-request
review. This work is based on
priority 3's merge in [#203](https://github.com/midnightntwrk/passport/pull/203)
on 2026/11/10 as `9d909ae23290608bb589d5541fc414d34cf3125b`.
The preceding priorities merged in #201 and #202, as recorded below.

**After priority 4 merges:** verify its merge on `origin/main`, record the
commit and validation evidence, and reassess the subsequent durable capture
and recovery-backfill milestone. This completes the four agreed implementation
priorities; broader custody lifecycle work remains separately scoped.

This document records the continuation instruction. It does not install a
background merge watcher or establish that any later task has started.

| Order | Work | Audit identifiers | State | Start condition |
|---|---|---|---|---|
| 1 | Reliable device reconnection | `DEV-003`, `DEV-004`; `TASK-DEV-003`, `TASK-DEV-004` | Merged in #201 | Merge `f7342f2`, 2026/11/10 |
| 2 | Check grant liveness and expiry before signing | `GRANTS-04`; `TASK-GRANTS-04` | Merged in #202 | Merge `44738ee`, 2026/11/10 |
| 3 | Consume bootstrap authority during dormant recovery | `REC-BOOT-001`; `REC-TASK-1` | Merged in #203 | Merge `9d909ae`, 2026/11/10 |
| 4 | Preserve multiple shielded coins of the same asset | `CUST-01`; `TODO-CUST-01` | Implemented; awaiting merge | Based on merged priority 3 |

## 1. Reliable device reconnection

Scope: the reference wallet's counter cache, discovery API, removal lookup,
regression tests, and usage documentation. Contract and ledger semantics stay
outside this change.

- [x] Cache state is scoped to account, epoch, authorisation arm, public key,
  and the relevant K256 envelope or P256 policy.
- [x] Same-key signing profiles can alternate without hiding each other's
  live entries.
- [x] A reused successor at counter zero works after recovery in an existing
  client, including recovery performed by another client.
- [x] A fresh client can resume bounded discovery through counters 4095, 4096,
  and a substantially higher value, including lost-device lookup.
- [x] Search exhaustion is distinguishable from proof of non-registration;
  cursor scope, progress, and stale-state behaviour are explicit.
- [x] Persisted hints are validated against ledger membership, and stale high
  hints do not prevent legal lower-counter discovery.
- [x] Targeted regressions and relevant existing checks pass, with execution
  layers and limitations recorded in the pull request.
- [x] Independent implementation review is complete.
- [x] The pull request is merged: #201, commit `f7342f297d945198fcfd7300307b63220a3dfdd9`.

Validation on 2026/11/10: fresh Compact 0.35.0 generated-runtime compilation
with key generation skipped, TypeScript build, ten reconnection tests,
22 input-validation tests, the existing offline unit suite, recovery simulator,
and grant-capability checks passed. Reconnection evidence includes real
generated-runtime account operations after restoration and recovery, with
snapshot membership fixtures for the wider boundary matrix. No fresh proof,
browser ceremony, or node admission is claimed.

## 2. Grant preflight

Scope: reject unusable grants before requesting a signature. Existing circuit
enforcement remains authoritative; preflight is not an admission guarantee.

- [x] Inactive, stale-epoch, stale-generation, expired, and insufficient-horizon
  grants cause zero signer calls.
- [x] Explicit non-expiry, clock skew, and admission margins have deliberate
  behaviour and regression coverage.
- [x] Valid grants continue to reach signing and submission.
- [x] Independent implementation review is complete.
- [x] The pull request is merged: #202, commit `44738eebe712ac5703babcac72d3e98b6d38e3c0`.

Validation on 2026/11/10: all 30 preflight tests and the TypeScript build
passed. The matrix covers all three signing arms and spending twins, zero-sign
refusals, separate wall-clock/head-time and timing-budget checks, post-sign
changes, single-attempt dispatch, and a generated-runtime finite grant journey.
Existing grant, caller, capability, P-256, and recovery simulator checks passed.
Circuit-negative fixtures retain raw authorisation paths. No fresh proof,
browser ceremony, or node admission is claimed.

Callers must choose `expiresAt` explicitly. Finite high-level operations need a
fresh node-head reader and measured timing budgets; high-level issuance and
spending make one submission attempt. The [reference guide](../../contract/README.md#grant-preflight-and-explicit-expiry)
describes the migration and the raw API's remaining retry behaviour.

## 3. Dormant recovery bootstrap

Scope: recovery finalisation consumes outstanding original activation authority.
A small source edit still requires verifier regeneration and a deployment or
migration compatibility decision.

- [x] All three bootstrap arms reject delayed original activation after
  recovery, before and after a successor operation.
- [x] The successor can operate and enrol another device; actual membership
  agrees with the device count.
- [x] Cancellation, activation during pending recovery, and later epochs have
  explicit tests.
- [x] Existing deployments and retired maintenance authority have explicit
  [deployment and migration guidance](../../contract/DORMANT-RECOVERY.md).
- [x] Independent source and regression review is complete.
- [x] The pull request is merged: #203, commit `9d909ae23290608bb589d5541fc414d34cf3125b`.

Validation on 2026/11/10: the new generated-runtime matrix passes all 20
cases after a fresh Compact 0.35.0 compilation. The baseline fails the four
dormant-activation cases, covering JubJub, both K256 envelopes, and P256;
the other 16 lifecycle controls pass. The TypeScript build, existing recovery
simulator, and P256 offline checks pass. Independent review repeats all 20
new cases successfully. Among 52 textual ZKIR circuits, only `recover_finalise`
changes; its new proving and verifier keys generate successfully with the
bundled ZKIR 3.1.0-rc.1 tool.

This is a source correction with runtime and targeted key-generation evidence.
It does not establish a complete release artefact set, fresh proof or node
acceptance, a live verifier replacement, or repair of previously affected
state. The deployment note records those release and migration requirements.

## 4. Multiple coins per asset

Scope: private client storage, selection, witness binding, removal, migration,
and recovery deduplication.

- [x] Two independent same-colour deposits remain available; spending either
  retains the other.
- [x] The signed input is exactly the coin selected by the witness.
- [x] Consumed coins are removed individually, recovered duplicates are
  deduplicated, and locally known spent/live state is preserved.
- [x] Existing one-slot private stores migrate without discarding retained descriptions.
- [x] Independent source and regression review is complete.
- [ ] The pull request is merged, with its merge commit recorded here.

Validation on 2026/11/10: 55 dedicated tests and the TypeScript build pass.
The matrix includes actual generated-runtime deposit/spend journeys alongside
signer/witness and transport fixtures, all signing arms and shielded recipient
twins, migration/restart, exact selection, spent replay, asynchronous mutation,
retry binding, and finite-grant timing. Relevant existing wallet and recovery
regressions pass. The baseline overwrite was reproduced before implementation.
See the [multi-coin guide](../../contract/MULTI-COIN.md) for API migration and
validation boundaries.

No Compact source or proof artefact changes are needed for this client fix.
Generated-runtime execution does not establish chain membership, fresh proof,
or node acceptance. Locally retained spent markers do not replace chain
validation (`CUST-03`), and descriptions already overwritten by the old format
cannot be reconstructed by store migration alone.

## Subsequent milestone

After these four priorities, reassess durable change capture and recovery
backfill (`CUST-02`, `TODO-CUST-02`). Its target is a receive, spend, restart,
and recover journey with interruption tests and an idempotent journal.
It depends on the multi-coin model and remains outside the current change.

Reference-contract CI is a parallel assurance recommendation (`TODO-CI-01`).
This queue does not claim that a required merge gate already exists.
