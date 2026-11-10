# Audit remediation queue

Updated: 2026/11/10. Review baseline: Passport `e0e4e0e6272399d71dfaaa7cae0689ab4e2363f3`.

This is the agreed order for four bounded improvements following the repository
audit. It tracks implementation and merge state separately. Closing a finding
requires regression evidence; it does not automatically establish a complete
[product promise](PROMISES.md) or change a historical audit rating.

## Current work and immediate successor

**Current: priority 1, reliable reconnection.** Implementation and independent
agent review are complete on `codex/reliable-reconnection`. The change is ready
for pull-request review and is not yet merged.

**Immediately after priority 1 merges: start priority 2, grant preflight.**
Verify the merge commit on `origin/main`, mark priority 1 as merged with its
pull request and validation evidence, and create the next branch from that
updated baseline. Do not treat an open or merely approved pull request as a
merge. Continue in the order below, carrying the next item into each hand-off.

This document records the continuation instruction. It does not install a
background merge watcher or establish that any later task has started.

| Order | Work | Audit identifiers | State | Start condition |
|---|---|---|---|---|
| 1 | Reliable device reconnection | `DEV-003`, `DEV-004`; `TASK-DEV-003`, `TASK-DEV-004` | Implemented; awaiting merge | Authorised on 2026/11/10 |
| 2 | Check grant liveness and expiry before signing | `GRANTS-04`; `TASK-GRANTS-04` | Next | Start immediately after priority 1 merges |
| 3 | Consume bootstrap authority during dormant recovery | `REC-BOOT-001`; `REC-TASK-1` | Queued | Priority 2 merged |
| 4 | Preserve multiple shielded coins of the same asset | `CUST-01`; `TODO-CUST-01` | Queued | Priority 3 merged |

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
- [ ] The pull request is merged, with its merge commit recorded here.

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

- [ ] Inactive, stale-epoch, stale-generation, expired, and insufficient-horizon
  grants cause zero signer calls.
- [ ] Explicit non-expiry, clock skew, and admission margins have deliberate
  behaviour and regression coverage.
- [ ] Valid grants continue to reach signing and submission.
- [ ] Independent review is complete, and the pull request is merged.

## 3. Dormant recovery bootstrap

Scope: recovery finalisation consumes outstanding original activation authority.
A small source edit still requires verifier regeneration and a deployment or
migration compatibility decision.

- [ ] All three bootstrap arms reject delayed original activation after
  recovery, before and after a successor operation.
- [ ] The successor can operate and enrol another device; actual membership
  agrees with the device count.
- [ ] Cancellation, activation during pending recovery, and later epochs have
  explicit tests.
- [ ] Existing deployments and retired maintenance authority are addressed.
- [ ] Independent review is complete, and the pull request is merged.

## 4. Multiple coins per asset

Scope: private client storage, selection, witness binding, removal, migration,
and recovery deduplication.

- [ ] Two independent same-colour deposits remain available; spending either
  retains the other.
- [ ] The signed input is exactly the coin selected by the witness.
- [ ] Consumed coins are removed individually, recovered duplicates are
  deduplicated, and spent/live state is preserved.
- [ ] Existing one-slot private stores migrate without discarding descriptions.
- [ ] Independent review is complete, and the pull request is merged.

## Subsequent milestone

After these four priorities, reassess durable change capture and recovery
backfill (`CUST-02`, `TODO-CUST-02`). Its target is a receive, spend, restart,
and recover journey with interruption tests and an idempotent journal.
It depends on the multi-coin model and remains outside the current change.

Reference-contract CI is a parallel assurance recommendation (`TODO-CI-01`).
This queue does not claim that a required merge gate already exists.
