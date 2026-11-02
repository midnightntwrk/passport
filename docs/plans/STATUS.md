# Passport development status — 19 October 2026

This refresh reconciles the MIP publications and their account, signing,
recovery and integration dependencies. The release/demo/SDK observations in
the historical audit below retain their 1 October observation date. Standards
were checked on 17 October; this follow-up records the 19 October merge of #177.

## ACC validation update — 2 November 2026

The [contract README](../../contract/README.md) consolidates the current ACC
source, review boundaries, known issues and evidence. Its 23 October validation
record supersedes this page's 19 October recovery caveat: a full account
with the atomic device-set reset completed two recoveries on-node, and its
source hashes match the current baseline. That run used matching cached
keys after textual ZKIR comparison; clean key regeneration and the expanded
adversarial retirement matrix are not implied. Individual-device revocation
remains defective and separate from recovery-wide retirement.

The combined account also has 23 October P-256 unshielded-grant evidence;
successful P-256 forwarded/shielded grant calls remain outside that run.
The scoped-grants Draft completed Passport review in #195 and is ready for
upstream Draft submission, with its evidence links now pinned to Passport
commits. No
canonical submission was found on 2 November. These updates do not change
the dated release/demo/SDK observations below or certify production readiness.
The table below is retained as the 19 October snapshot, not the latest ACC
validation register.

## Standards and evidence

| Record | Verified status | Remaining work |
|---|---|---|
| [MIP-0030](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0030-ecdsa-account-authorisation.md) | **Draft**, published via [#374](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/374) on 16 October | Complete typed recipes/vectors; common UV policy and all-verifier policy binding; key/scalar enforcement mapping; cryptographic review; MIP-0021 compatibility. No k1 sunset policy. |
| [MIP-0013](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0013-account-authorisation.md) / [MIP-0022](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0022-account-recovery.md) | **Proposed**; [#385](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/385) merged 15 October, requiring atomic retirement of every prior device entry at recovery finalisation | Expanded retirement cases, including future epochs, differing counters, pending-phase enrolment, all supported schemes, later epoch changes and successor operation/enrolment. Individual-device removal remains separate (erratum 8). |
| [Recovery reset #183](https://github.com/midnightntwrk/passport/pull/183) | Merged as `0d7bb0b`; Compact 0.35 compilation with key generation skipped and simulator passed | Regenerated keys, proof/node validation and deployment-wave sizing. Earlier on-node recovery receipts predate this fix. Existing accounts need verifier maintenance or migration; a merge does not alter deployed state. |
| [MIP-0020](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0020-prover-key-regeneration.md) | **Proposed**, #338 merged; authors Nicolas Di Prima and Vincent Hanquez | Supported SDK/WASM APIs, compatible keygen profiles, conformance vectors and integration. |
| [MIP-0021](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0021-domain-separation.md) | **Proposed**, #331 merged; convention rejects a central registry | Reconcile zero padding, tag syntax and existing Passport bytes explicitly through review; no silent cryptographic migration. |
| Recovery standard | MIP-0022 published via #339; authors Nicolas Di Prima and Raphael Toledo | Multi-session crypto memo, guardian transport/liveness, interoperability, successor-key validation and viewing-wrap freshness/rotation. |
| P-256 / caller-bound grants | Passport [#175](https://github.com/midnightntwrk/passport/pull/175) and [#176](https://github.com/midnightntwrk/passport/pull/176) merged | Fresh combined-build/client-ABI/P-256 caller validation remains separate. Preserve the 15,000-verifier-byte budget per deployment/maintenance wave. |

Native P-256 exists in Compact 0.35. `wa-json134` and one live Safari account-key
rotation are bounded evidence, not general WebAuthn/browser or PRF coverage.
The variable-length experiment #179 remains open and records no proof/VK-size
saving. #177 merged on 19 October as `fc7c240`. Its 17 October localnet run
passed both fresh-client restores/spends, offline-reader rotation, live-coin
backfill and exclusion. The recovery-group envelope remains unimplemented/unvalidated.
Real-browser PRF, reader onboarding, interrupted rotation and SDK integration
remain follow-ups; this merge contributes an experiment, not a product release.

## Issue follow-through

All 89 repository issues and their available discussions were inspected for
these changes. **28 affected issue descriptions were updated and read back**;
all open/closed states were preserved and the other 61 issues were unchanged.
Affected descriptions are reconciled with canonical links and
explicit remaining work; unrelated work and historical comments retain their
scope. Publication alone does not close acceptance, integration or audit work.

- Signing: #11 / #51; passkey clients and support matrix: #15 / #48.
- Account/recovery enforcement: #7 / #47 / #73; recovery rules and coordination:
  #19 / #71 / #72; total-loss and helpers: #20 / #21 / #62.
- Audit and formal model: #18 / #36 / #67; SDK adoption and deployment artefacts:
  #116 / #167; viewing-state integration: #23.
- Tag compatibility: #14 / #44; regeneration: #168.
- Closed publication #61 remains closed; its canonical record includes #385.

## Historical audit — 1 October 2026

The [1 October audit](STATUS-2026-10-01.md) is retained unchanged as a dated
snapshot. Its open-PR, submission and release observations are superseded by
the current register above where applicable.
