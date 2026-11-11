# Audit remediation queue

Updated: 2026/11/11. Review baseline: Passport `e0e4e0e6272399d71dfaaa7cae0689ab4e2363f3`.

This is the agreed order for four bounded improvements following the repository
audit. It tracks implementation and merge state separately. Closing a finding
requires regression evidence; it does not automatically establish a complete
[product promise](PROMISES.md) or change a historical audit rating.

## Current work and immediate successor

**Current: pinned reference regression CI, TODO-CI-01.** The user authorised
starting this milestone before [#207](https://github.com/midnightntwrk/passport/pull/207)
merges. CI work is stacked on its head `3b2f6ed4c70d117f3595a25cc763e09f9879a738`
on `codex/pinned-reference-ci`; PR #207 remains a dependency.

**Awaiting merge: restore and persist current viewing capability, REC-WRAP-001
and REC-WALLET-001.** Chain-verified holdings reconstruction merged in
[#206](https://github.com/midnightntwrk/passport/pull/206),
`617f2569eee0147b6e26597b34f270a0ff117abf`, verified against `origin/main` on
2026/11/11. This implementation starts from that merge on
`codex/current-viewing-recovery`. Implementation, independent review, and targeted
validation are complete in [#207](https://github.com/midnightntwrk/passport/pull/207),
awaiting merge.

**After #207 merges:** verify its merge, then rebase and retarget the dependent
CI pull request onto `main`. Required-check enforcement is a separate acceptance
step after the workflow exists on `main`. Compromised-credential
containment, partial transaction-outcome repair, production-scale discovery,
and complete guardian transport remain separate open work.

This document records the continuation instruction. It does not install a
background merge watcher or establish that any later task has started.

| Order | Work | Audit identifiers | State | Start condition |
|---|---|---|---|---|
| 1 | Reliable device reconnection | `DEV-003`, `DEV-004`; `TASK-DEV-003`, `TASK-DEV-004` | Merged in #201 | Merge `f7342f2`, 2026/11/10 |
| 2 | Check grant liveness and expiry before signing | `GRANTS-04`; `TASK-GRANTS-04` | Merged in #202 | Merge `44738ee`, 2026/11/10 |
| 3 | Consume bootstrap authority during dormant recovery | `REC-BOOT-001`; `REC-TASK-1` | Merged in #203 | Merge `9d909ae`, 2026/11/10 |
| 4 | Preserve multiple shielded coins of the same asset | `CUST-01`; `TODO-CUST-01` | Merged in #204 | Merge `277a8e3`, 2026/11/10 |
| 5 | Durable change capture and recovery backfill | `CUST-02`; `TODO-CUST-02` | Merged in #205 | Merge `c87933d`, 2026/11/11 |
| 6 | Chain-verified holdings reconstruction | `CUST-03`; `TODO-CUST-03` | Merged in #206 | Merge `617f256`, 2026/11/11 |
| 7 | Restore and persist current viewing capability | `REC-WRAP-001`; `REC-WALLET-001` | Implemented and validated in #207; awaiting merge | Based on merged priority 6 |
| 8 | Pinned reference regression and proof/localnet CI | `TODO-CI-01` | Implemented in #208; checks and dependency notes below | Stacked on #207 with user authorisation |

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
- [x] The pull request is merged: #204, commit `277a8e345873348d5e1b1c6a6416c2ce0e857894`.

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

## 5. Durable change capture and recovery backfill

Scope: opt-in reference-client journalling, encrypted durable Node storage,
stable private-state reopening, exact outcome reconciliation, actual commitment
qualification, and idempotent owner backfill or grant adoption. See the
[implementation guide](../../contract/DURABLE-CHANGE.md).

- [x] Save the exact input, operation, predicted change, and all final transaction
  identifiers before permitting submission.
- [x] Distinguish complete, partial, rejected, and unknown outcomes after restart.
- [x] Retain uncertainty after lost acknowledgements and avoid automatic resubmission.
- [x] Adopt confirmed change without discarding siblings or resurrecting later-spent coins.
- [x] Backfill owner change and adopt grant entries without duplicate append.
- [x] Separate recorded ciphertext from verified decryptable recovery.
- [x] Provide encrypted atomic storage with acknowledged file and directory flushes.
- [x] State single-process concurrency and the remaining total-loss gap before backfill.
- [x] Complete the interruption matrix, existing regressions, independent review,
  and three-process localnet recovery journey; record exact outcomes here.
- [x] Merge the pull request: #205, commit `c87933d5eb0b893ac907dfe86a76be462cdfeaf7`.

The localnet journey injects lost acknowledgements after actual spend and append
submissions, reopens the journal in fresh processes, and later spends the
recovered change while preserving a same-colour sibling. Transport fixtures and
generated-runtime checks are reported separately from live proof and node
evidence. No fresh Compact compilation is required because circuits are unchanged.

Validation on 2026/11/11: all 93 dedicated durable-recovery tests passed,
including 22 before/after journal-write interruption cuts, generated-runtime
recovery, the actual SDK preparation boundary, receipt controls, and encrypted
storage reopening in a fresh process. The TypeScript build, all 137 existing
multi-coin/reconnection/preflight/bootstrap/input-validation tests, all 127
offline grant tests, and the existing unit, recovery, capability, caller, and
P256 offline checks passed. Two separate live-prover controls passed, including
rejection of a wrong occupied commitment position through the production adapter.

All four fresh-process localnet phases passed: lost spend acknowledgement,
lost owner-backfill acknowledgement, restart and later change spend, and grant
change publication without duplicate append. Seven indexed successful
transactions were cross-checked against node block hashes. This reused the
pinned full keyed artefacts generated on 2026/11/10, with no new key-generation
claim. It is targeted custody evidence, not a rerun of the entire localnet
matrix or complete MIP conformance.

Reference-contract CI is a parallel assurance recommendation (`TODO-CI-01`).
This queue does not claim that a required merge gate already exists.


## 6. Chain-verified holdings reconstruction

Scope: viewing-only candidate discovery, actual commitment qualification,
authoritative applied-nullifier observation at an indexed and finalised block,
explicit coverage and bounded continuation, and optional guarded store updates.
See the [implementation guide](../../contract/CHAIN-RECOVERY.md).

- [x] Reconstruct several same-colour holdings without a device signature or
  submitted trial spend.
- [x] Require a checked commitment witness and completed finite nullifier history
  before declaring a coin live; verify receipts before declaring it spent.
- [x] Exclude authenticated arbitrary descriptions, duplicates, and externally
  spent coins from verified subtotals.
- [x] Preserve unknown states, incomplete coverage, sibling holdings, and local
  spent tombstones. Bind both inbox and coin continuations to one chain snapshot.
- [x] Keep uncertain and partial journal reservations quarantined.
- [x] Complete targeted regressions, independent review, and fresh-process
  localnet validation; record evidence and limitations.
- [x] Merge the pull request: #206, commit `617f2569eee0147b6e26597b34f270a0ff117abf`.

A complete candidate pass is not proof of a complete account balance. Lost owner
change that was never backfilled, with its local description and journal also
lost, cannot be reconstructed from a commitment alone. This API consumes viewing
keys; it does not yet restore or validate recovery-wrap contents.

Validation on 2026/11/11: all 169 dedicated recovery tests, 230 existing wallet
and custody regression tests, the TypeScript build, and both existing live-prover
qualification controls passed. The four fresh-process localnet phases passed:
provision two same-colour deposits and owner change, reconstruct with viewing
capability alone, spend recovered change from another client, and reconstruct
again. The verified subtotal fell from 700 to 200. Spent originals and change
were excluded, duplicate descriptions added no value, and an authenticated
invented description stayed unknown. Both recovery phases rejected an invented
description at a real occupied commitment index through the actual prover. The
final phase also verified continuation with one commitment position per call.
Seven successful transaction receipts were cross-checked against node block hashes.

The first live attempt exposed an integration gap: the pinned generated account
does not emit the optional contract receive/mint logs. Recovery now falls back
to bounded candidate retry through the pinned block's exclusive commitment-tree
boundary. This is tested, but its worst-case work scales with the global tree.
Optimising discovery through emitted events or complete indexed account history,
and measuring recovery at production scale, remain follow-up work. Partial
transaction repair remains open; current viewing-key restoration is addressed
by priority 7 below.

The live run reused the pinned full keyed artefacts generated on 2026/11/10.
There was no circuit change or new key generation. Controlled SDK transport
fixtures, native-ledger tests, actual prover checks, and node acceptance evidence
are separate validation layers. This is targeted custody evidence, not the full
localnet matrix or complete MIP conformance.


## 7. Current viewing capability and guardian backup

Scope: indexed guardian reconstruction, current-key validation, acknowledged
persistent storage, private-profile merging, stale/unknown/absent backup status,
and verified fresh full-roster session publication. See the
[implementation guide](../../contract/VIEWING-RECOVERY.md).

- [x] Refuse a successfully decrypted key that does not match current `enc_key`.
- [x] Require an explicit persistent vault and read back the exact scoped key
  before private-profile publication or a persistence acknowledgement.
- [x] Preserve existing holdings and metadata; support a fresh-profile reload.
- [x] Expose stale, unknown, and absent backup outcomes separately from current
  viewing capability and pending authority recovery.
- [x] Refuse unavailable/invalid guardian input and reused or partial fresh sessions.
- [x] Recheck key, artefact, and pending context around persistence and publication.
- [x] Complete independent review, regression tests, and a fresh-process localnet
  guardian restore, restart, successor spend, and renewed backup journey.
- [x] Open [#207](https://github.com/midnightntwrk/passport/pull/207).
- [ ] Merge #207 and record its merge commit.

Validation on 2026/11/11: 93 new helper, account/generated-runtime, and real
filesystem-vault tests passed, alongside 399 prior wallet/custody/reconstruction
regressions, recovery offline and simulator checks, and the TypeScript build.
The final new suite includes a status-read race recheck added after the broader
regression run. A generated-runtime journey proves the important incomplete
outcome: a live device can rotate encryption during pending recovery, authority
finalisation can succeed, and the client still reports stale viewing and refuses
the obsolete vault key.

All three fresh-process localnet phases passed. Provisioning exercised stale
wrap refusal and unavailable-roster refusal. Two indexed paper-key-derived
shares then restored and persisted the current key into an empty profile,
reconstructing 800 without submitting a transaction. Another fresh process
loaded only the vault, finalised authority recovery, reported the consumed
backup as absent, spent 100, backfilled change, preserved the same-colour sibling,
and verified 700 before publishing a fresh full-roster session. Ten successful
transaction receipts were cross-checked against node block hashes.

This is targeted localnet evidence using pinned keyed artefacts generated on
2026/11/10, with no circuit change, new key generation, or full localnet-matrix
rerun. The initial provision phase preceded the final status-read recheck;
restoration and finalisation used the final product sources, and each phase
records its source hashes. The isolated services are stopped with volumes retained.
The canonical MIP-0022 comparison uses upstream
`4a85a87b4e4c5d59ee88a5786a8ecb11f5dc5c6f`.

The caller authenticates guardian exchanges and configures the network/provider
and vault-key policy. The reference helper does not add a browser ceremony or
prevent an external rotation during pending recovery. A current viewing key
cannot imply a complete reconstructed balance or repair lost change descriptions.

## 8. Pinned reference regression and proof/localnet CI

Scope: clean pinned installation, fresh generation, TypeScript, all seven recent
remediation suites, relevant offline/native tests, a separate bounded proof and
recovery journey, and retained evidence. See the
[CI guide](../../contract/REFERENCE-CI.md).

- [x] Define a pull-request regression check without path or target-branch filters.
- [x] Pin compiler archives, dependency resolution, actions, and localnet images.
- [x] Reject failed, empty, skipped, or incomplete test execution.
- [x] Separate generated-runtime evidence from complete key generation and
  proof/node acceptance.
- [x] Record exact installed verifiers and transaction identities in live evidence.
- [x] Pass clean local compilation, build, and all 27 regression commands.
- [x] Demonstrate a deliberately broken source invariant failing on GitHub.
- [x] Complete independent source review and open dependent
  [#208](https://github.com/midnightntwrk/passport/pull/208).
- [ ] Verify #207's merge, then rebase and retarget this implementation onto main.
- [ ] Merge this workflow and separately configure/verify the required check.

The implementation uses Sol for workflow/helpers, Astra for independent review,
and Luna for test-inventory extraction. The primary agent owns integration,
the heavy lane, live execution, documentation, and evidence reconciliation.
The main branch protection read on 2026/11/11 required only `scan` and `DCO`;
the new regression job is not yet a merge requirement.

Validation on 2026/11/11: the clean local lane passed 492 TAP cases, 45 native
Rust cases, and the additional script checks. Twelve subprocess controls test
the runner's failure, empty-output, duplicate-summary, skip, and timeout
behaviour. A separate local harness run reused the previously generated keys;
its three recovery phases, two prover controls, ten selected receipts, and
52 installed-verifier comparisons passed, with cleanup verified. That run
validates orchestration and assertions, not fresh key generation.

The first hosted fast lane
[passed](https://github.com/midnightntwrk/passport/actions/runs/43041255349).
The disposable source mutation in
[#209](https://github.com/midnightntwrk/passport/pull/209) removed bootstrap
consumption and made four dormant-recovery cases fail across all initial
profiles, producing a
[failed regression job](https://github.com/midnightntwrk/passport/actions/runs/43041370895).
Its defect is confined to the disposable control branch and must never merge.
The control is restored and closed after its evidence is retained.

Use [#208's current checks](https://github.com/midnightntwrk/passport/pull/208/checks)
and their retained artefacts for final-head hosted results, including complete
fresh generation and the heavy journey. A historical pass does not certify a
later head. The initial workflow-context error and separate Opengrep findings
were retained and corrected: runner paths are set in execution steps, TAP
parsing uses a fixed expression, and only the fixed loopback prover version
request has a rule-specific exception with redirects disabled.
