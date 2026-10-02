# Passport development status — 1 October 2026

Passport has a working reference account contract, published custody and
authorisation standards, and a released demo. P-256 passkey authorisation,
caller-bound grants and viewing-key envelopes have new executable evidence
in **open PRs**. SDK integration, interoperability, cryptographic review and
formal assurance remain active work.

This is a dated reconciliation of GitHub issues, PRs, release records and
public websites. “Merged”, “demonstrated”, “submitted upstream” and
“released” refer to different milestones. MIP-0012 and MIP-0013 remain
**Proposed**, not Active.

## Reference implementation and experiments

| Work | Observed status | Next action |
|---|---|---|
| Compact 0.35 upgrade | [#174](https://github.com/midnightntwrk/passport/pull/174) merged; main `2e3c7ac`. Runtime 0.20, ledger 9, ZKIR 3.1; SDK dependencies still RCs. Offline regression suites and coinless on-node authorisation passed. | Retain the **15,000-verifier-byte budget for every deployment wave**, including deployment. Full custody/grants/recovery on-node suites were not all rerun for this maintenance change. |
| Unshielded grant twins | [#163](https://github.com/midnightntwrk/passport/pull/163) merged. Both arms exercised; resource limits and funding-path qualifications recorded in [GRANTS-E3](../../contract/GRANTS-E3.md). | Carry the measured limits into integration and deployment planning. |
| Recovery | [#165](https://github.com/midnightntwrk/passport/pull/165) merged: solution draft, reference contract tranche and delegation-safe, two-phase signature gate. | Multi-session crypto memo, wallet/guardian transport, interoperability vectors and viewing-wrap lifecycle. |
| Prover-key regeneration | Native feasibility [#170](https://github.com/midnightntwrk/passport/pull/170) and solution draft [#173](https://github.com/midnightntwrk/passport/pull/173) merged. | Supported SDK/WASM APIs, compatible keygen profiles, validation vectors and client integration. |
| P-256 / profiled WebAuthn | [#175](https://github.com/midnightntwrk/passport/pull/175) open, review required, five checks passing at this snapshot. Real Safari passkey approved an account-key rotation accepted on localnet; automated account-call measurements use software ES256 fixtures. | Review the bounded `wa-json134` profile and integrate after approval. General WebAuthn compatibility, live spending and PRF support remain separate. |
| Caller-bound grants | [#176](https://github.com/midnightntwrk/passport/pull/176) open, review required, five checks passing. Optional immediate-contract pin using `kernel.caller()`; accepted forwarding calls and a fabricated-caller proof refused at node admission. | Review schema v3 and migration. Reconcile P-256 grant issuance with this schema when integrating #175 and #176. |
| Viewing-key sharing | [Draft #177](https://github.com/midnightntwrk/passport/pull/177), stacked on #175. Complete automated localnet PASS: two fresh-private-state restores and accepted shielded spends, rotation while B is offline, live-coin backfill and exclusion from a later generation. | Nicolas's initial review and iteration: authority roles, bootstrap, reader-roster trust, PRF and recovery. Wider discussion follows that review. |

The viewing-key experiment stores **192 bytes per reader per viewing-key
generation** in the existing inbox, without Compact changes. Five measured
appends used 10,919–10,958-byte transactions, 6,364-byte contract proofs and
21.97–22.63 seconds of contract proving. These are localnet observations,
not browser timings or physical database allocation costs. See the
[frozen results](https://github.com/midnightntwrk/passport/blob/b888825a2a906dee3db513a1d275b9f553743114/contract/evidence/inbox-view-envelope/RESULTS.md).

That run uses software ES256 credentials and synthetic PRF outputs, separate
empty private-state providers in one process, shared public infrastructure,
and explicit public account/network/RP/origin metadata. It does not establish
account discovery from a passkey alone or cross-machine passkey sync. Real
Safari **signing** in #175 does not establish real **PRF** support in #177.
Viewing access does not grant signing authority; excluding a reader from
future envelopes cannot erase secrets it already learned.

**Authority clarification:** A and B are ACC devices in the experiment.
Lace connects to the ACC as a **dApp/grantee**, using its own key under an
account-authorised scoped grant; it is not the user's ACC device-key
provider. Viewing-key delivery is separately authorised. The device
restore/spend evidence does not demonstrate a Lace connection or a
grant-based reader journey. #177 is for Nicolas's review before wider
involvement.

The proposed recovery-group inbox recipient is documented in #177, but is
**unimplemented and untested**. Existing recovery uses a separate 64-byte
`recovery_wrap`; its freshness, session binding and successor lifecycle
remain distinct from the tested passkey-reader envelopes.

## Standards register

| Item | Status on 1 October | Remaining work |
|---|---|---|
| [MIP-0012](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0012-native-asset-custody.md), [MIP-0013](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0013-account-authorisation.md) | Published upstream, Proposed | Cryptographer review, FROST profile/demonstration, second implementation, authorisation corrections and ecosystem review. |
| [MPS-0039](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0039-lightweight-contract-interaction.md) | Published, Proposed | Prover-key delivery solution and integration. |
| [MPS-0040](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0040-cross-contract-call-provenance.md) | Published, Proposed | Compact 0.35 now exposes immediate caller identity; #176 validates a consumer. Broader provenance and calling-circuit identity are not established by that result. |
| [Domain separation #331](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/331) | Open upstream proposal; feedback posted | Byte-exact encoding, catalogue/source of truth, transient-hash scope and compatibility with Passport tags. C8 remains open. |
| [Prover-key regeneration #338](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/338) | **Submitted upstream**, open Draft-status document; Hector submitted on behalf of Nicolas | Maintainer review, validation/conformance and supported APIs. Authors remain **Nicolas Di Prima and Vincent Hanquez**. |
| [Recovery #339](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/339) | **Submitted upstream**, open Draft-status document; Hector submitted on behalf of Nicolas | Crypto memo, transport/interoperability and review of the integration. |
| Signature schemes, scoped grants | Drafts merged in Passport; no corresponding upstream submission found in this audit | Scheme/envelope review, editor decisions, authorisation amendments and migration. |

The upstream #338/#339 submissions supersede the earlier “awaiting Hector's
submission URL” queue entry. Their submission is not upstream acceptance.
The account-authorisation correction package still needs the validation map
across encoding, on-curve, subgroup and non-identity checks, plus a
device-wide revocation remedy. Earlier weak-key observations are tied to
their recorded toolchain; compiler/runtime checks are not by themselves a
complete accepted-proof admissibility map.

## Demo releases and websites

| Surface | Observation |
|---|---|
| [Planning site](https://midnightntwrk.github.io/passport/site/) | Live page was still dated **17 September** before this refresh. Source is `site/`; deployment follows a merge to main. |
| [Demo release v5.2](https://github.com/midnightntwrk/passport-demo/releases/tag/v5.2) | Latest release, 29 September; commit `d343acf`, build prefix `362ee84c`. Adds installation guidance across browsers and includes v5.1 fixes. |
| [Staging](https://staging.midnightpassport.com) and [production](https://midnightpassport.com) | Both responded; both `/sw.js` files exposed `BUILD_ID = '362ee84c685ebb8b'` on 1 October. This matches the v5.2 prefix. The release notes still say production stays on v5.0 (`3f535f5c`): deployment provenance needs reconciliation. |
| [v5.2 release workflow](https://github.com/midnightntwrk/passport-demo/actions/runs/36601633455) | Failed at “Resolve the Vercel project for this target”; build/test/deploy steps were skipped. A matching public build marker does not establish a successful promotion through this workflow. |

Follow-up filed as [demo #125](https://github.com/midnightntwrk/passport-demo/issues/125):
reconcile the intended/actual releases, promotion evidence and workflow
configuration.

The release history includes fresh-device recovery, viewing-key persistence
with sign-in metadata, chain-derived activity and per-payment passkey
approval ([demo #111–#114](https://github.com/midnightntwrk/passport-demo/pulls?q=is%3Apr+is%3Amerged)).
Those demo flows do not establish deployment of reference PRs #175–#177.
HTTP/build-marker checks in this audit are not a new end-to-end demo run.

Open demo work includes push notifications
([#123](https://github.com/midnightntwrk/passport-demo/pull/123): off until
configured, real delivery untested), provider-recovery UX (#121), the
stagenet app builder (#120), and bridge PRs #26–#28/#31 with failing
typecheck/unit checks. PWA/E2E checks are skipped on #120/#121/#123; they
must not be counted as passing release evidence. Dependency PR #124 also
has a failing scan. The original six-phase calendar and managed-signing
picks are planning history, not the current deployed configuration.

## SDK, identity and formal specification

- **SDK:** [#24](https://github.com/midnightntwrk/midnight-passport-sdk/pull/24)
  is an open realignment/deliverables proposal, not an accepted or shipped
  SDK architecture. [Passport #167](https://github.com/midnightntwrk/passport/issues/167)
  remains the integration ticket. Review account/key-provider boundaries,
  grant/read handover and private-state ownership (#166/#58) against the
  new evidence. WPP evaluation is deferred in the current work queue.
- **DID / credentials:** [#142](https://github.com/midnightntwrk/passport/pull/142)
  has changes requested; [#171](https://github.com/midnightntwrk/passport/issues/171)
  tracks the example repository/use case with Hector and Yurii. Prior-art
  review and an example are not a completed Passport DID integration.
- **Formal specification:**
  [the Agda repository](https://github.com/input-output-hk/arc-passport-formal-spec)
  has eight open issues (#1, #2, #4–#9), no open PRs and no assigned issue
  owners at this snapshot. They cover model/channel alignment, routing,
  property maturity, finalized-ledger semantics, value preservation,
  adversary/leakage ports and the categorical-crypto foundation.
  [Passport #169](https://github.com/midnightntwrk/passport/pull/169) has
  changes requested. Agree the next stated/proved/instantiated milestone
  with Andre; there is no basis to report formal sign-off as complete.

## Ticket reconciliation and next actions

| Existing tickets | Current interpretation / next action |
|---|---|
| #7 / #47 / #73 — account contract | Recovery contract dependency now has merged #165; retain client integration, admissibility and device-revocation follow-ups. |
| #11 / #15 / #48 / #51 — signing and passkeys | Link open #175 and its real Safari evidence; retain profile review, browser/PRF matrix and SDK integration. |
| #16 / #18 / #67 — grants and enforcement | Merged reference evidence plus open caller extension #176; formal audit, client ceremony and editor rulings remain. |
| #20 / #21 / #62 — recovery | Merged reference tranche and upstream #339; transport, interoperability and crypto memo remain. |
| #23 / #58 / #167 — viewing and private state | Review draft #177 internally first; distinguish devices from dApp/grantees and readers, then settle bootstrap and lifecycle follow-ups. |
| #44 — domain separation | Follow upstream #331 and unresolved review points. |
| #168 — proving-key registry | Track MPS-0039 and #338; the merged solution regenerates from bundled ZKIR and chain VKs, without requiring a registry. |
| #36 / #67 — formal work | Align with formal-spec issues #4–#9 and #169's requested revisions. |
| #114 — push notifications | Implementation proposal is demo #123; real configured delivery remains untested. |
| #61 — multi-key MIP publication | Closed as completed in this refresh: MIP-0013 is published as Proposed. Acceptance and amendments continue under the account/signing tickets and upstream standard. |
| #87 / #91, demo #34 / #35, #107 | Confirm disposition/owner acceptance against the separate formal repository, chosen recovery path and released demo documentation before closing stale work. |

Integrate approved feature PRs individually. #175 and #176 are separate
builds from the maintenance base; whichever lands second needs schema/ABI
reconciliation. #177 is stacked on #175. This status refresh does not merge
those implementations.

### Audit coverage

Dated evidence/remaining-work comments were published on Passport
[#47](https://github.com/midnightntwrk/passport/issues/47#issuecomment-5940253252),
[#51](https://github.com/midnightntwrk/passport/issues/51#issuecomment-5940253256),
[#18](https://github.com/midnightntwrk/passport/issues/18#issuecomment-5940253281),
[#62](https://github.com/midnightntwrk/passport/issues/62#issuecomment-5940253526),
[#23](https://github.com/midnightntwrk/passport/issues/23#issuecomment-5940253534),
[#167](https://github.com/midnightntwrk/passport/issues/167#issuecomment-5940253588),
[#168](https://github.com/midnightntwrk/passport/issues/168#issuecomment-5940253863),
[#44](https://github.com/midnightntwrk/passport/issues/44#issuecomment-5940253885),
[#36](https://github.com/midnightntwrk/passport/issues/36#issuecomment-5940253947),
[#114](https://github.com/midnightntwrk/passport/issues/114#issuecomment-5940254209),
and formal-spec
[#1](https://github.com/input-output-hk/arc-passport-formal-spec/issues/1#issuecomment-5940254232)/
[#2](https://github.com/input-output-hk/arc-passport-formal-spec/issues/2#issuecomment-5940254358).

At collection time, before publishing this refresh: Passport **69 issues /
7 PRs**, demo **3 / 16**, SDK **1 / 4**, formal-spec **8 / 0**, all open.
After ticket reconciliation, Passport has 68 open issues (#61 closed) and
the demo has 4 (#125 added). The inventory includes older tickets; an open ticket is not proof that its
implementation is absent. Current PRs, issue bodies/comments, upstream
canonical headers, release notes and public web responses were checked.
GitHub Project boards could not be read: the current token lacks
`read:project`. Board fields and private/off-GitHub tickets remain to be
reconciled by someone with that access.
