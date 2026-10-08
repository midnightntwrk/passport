# Passport development status — 8 October 2026

This is a targeted standards/register follow-up to the
[1 October audit](STATUS-2026-10-01.md), not a new global audit or execution run.
Canonical proposal headers and the PR states below were rechecked on 8 October.
Publication, merged implementation, accepted proof evidence and released client
integration are separate milestones.

## Standards register

| Canonical proposal | Status | Discussion / remaining work |
|---|---|---|
| [MIP-0012 — Native asset custody](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0012-native-asset-custody.md) | Proposed | Cryptographer review and independent conformance. [UBLP adopter reply](https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/240#discussioncomment-18812749) links existing index-capture evidence; await the adopter's result. |
| [MIP-0013 — Account authorisation](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0013-account-authorisation.md) | Proposed | Signature/FROST review, admissibility mapping and device-wide revocation. Hector approved the narrow ECDSA extension in [Passport #180](https://github.com/midnightntwrk/passport/pull/180), merged on 8 October; upstream submission remains. |
| [MIP-0020 — On-Demand Prover Keys from Bundled ZKIR](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0020-prover-key-regeneration.md) | Proposed; upstream #338 merged 4 October | [Discussion #345](https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/345). Supported native/WASM APIs, compatible keygen profiles, independent ZKIR/VK validation, vectors and SDK integration. Authors: **Nicolas Di Prima and Vincent Hanquez**. |
| [MIP-0021 — Domain-Separation Convention](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0021-domain-separation.md) | Proposed; upstream #331 merged 4 October | [Discussion #347](https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/347). Jay Albert's convention rejects a central registry. Passport's fixed-width zero-padding, canonical encoding, tag/data boundary, lightweight catalogue and existing-tag compatibility questions remain open. Preserve current hash bytes. |
| [MIP-0022 — Recovery Paths for Custody Accounts](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0022-account-recovery.md) | Proposed; upstream #339 merged 4 October | [Discussion #349](https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/349). Multi-session crypto review, transport, interoperability and viewing-wrap lifecycle. Authors: **Nicolas Di Prima and Raphael Toledo**. |
| [MIP-0025 — Managed Private State and Capsule Runtime](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0025-capsule-runtime.md) | Draft; upstream #334 merged 4 October | [Discussion #355](https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/355). Proposed runtime/private-state design, not a shipped storage service. |
| Custom spend logic — [upstream #335](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/335) | Open PR; MIP-0028 reserved | Not yet a published numbered document. |

[MPS-0039](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0039-lightweight-contract-interaction.md)
now names MIP-0020 in its header.
[MPS-0018](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0018-asset-custody-model.md)
now names MIP-0012, MIP-0013 and MIP-0022. Both remain Proposed.
[MPS-0040](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0040-cross-contract-call-provenance.md)
also remains Proposed; the immediate-caller consumer below does not establish
calling-circuit identity or every broader provenance requirement.

## Reference implementation and experiments

| Work | Verified publication state | Evidence boundary / next action |
|---|---|---|
| P-256 / WebAuthn [#175](https://github.com/midnightntwrk/passport/pull/175) | Merged 2 October, `45721e1` | Bounded `wa-json134` verification and real Safari account-key rotation accepted on localnet. Broader browser support, live spending and PRF remain separate. |
| Caller-bound grants [#176](https://github.com/midnightntwrk/passport/pull/176) | Merged 6 October, `26e1978` | Schema v3, `kernel.caller()` pins, earlier accepted forwarding calls and fabricated-caller proof rejection. P-256 issuance caller argument is fixed on main; this merge is not fresh combined-build/client-ABI/P-256 caller validation. |
| Viewing-key envelopes [#177](https://github.com/midnightntwrk/passport/pull/177) | Open draft, `b9e1357` | Automated device restoration/spending uses software ES256, synthetic PRF and explicit public bootstrap metadata. Angel's feedback is received and Nicolas has replied; grant-based follow-through remains. |
| Variable-length WebAuthn [#179](https://github.com/midnightntwrk/passport/pull/179) | Open for review, `cd08b4b` | Negative size/cost result: **zero proof/VK bytes saved**; rows 112,156 → 998,980 and prover keys 234,971,079 → 1,893,363,935 bytes. Software-ES256 proof evidence is not an account replacement or native variable-length SHA measurement. |
| Signing-boundary records [#180](https://github.com/midnightntwrk/passport/pull/180) | Merged 8 October, `d315208`, after Hector's approval | Small MIP-0013 extension using existing evidence; upstream submission remains. Named bounded profiles are permitted; no universal profile, common UV floor or k1 sunset is silently adopted. |

The merged baseline includes unshielded grants (#163), recovery (#165), native
key-regeneration evidence (#170), its proposal (#173), and Compact 0.35 (#174).
Preserve the **15,000-verifier-byte deployment-wave budget** and generated ZK
artifacts. This records existing evidence; no contract suite was rerun here.

Device authority, scoped-grant authority, viewing access, ciphertext delivery and
recovery remain distinct. Lace uses **owner-authorised JubJub scoped grants**.
The device-only #177 evidence does not validate that grant journey, real browser
PRF, or cross-machine/passkey-only restoration. Existing recovery retains its
separate 64-byte `recovery_wrap`; the proposed recovery-group inbox recipient is
unimplemented and untested.

## Records, client integration and next actions

- The planning site's source is reconciled with these records; Pages deployment
  follows merge to main. Demo release/build-marker observations remain dated
  [1 October](STATUS-2026-10-01.md#demo-releases-and-websites), not refreshed here.
- Review [SDK #24](https://github.com/midnightntwrk/midnight-passport-sdk/pull/24)
  next: direction/deliverables, account/key-provider boundaries, grant/read
  handover and private-state ownership. [Passport #167](https://github.com/midnightntwrk/passport/issues/167)
  remains the integration ticket. WPP evaluation remains deferred.
- Continue existing tracking: [#44](https://github.com/midnightntwrk/passport/issues/44)
  for MIP-0021 compatibility, [#51](https://github.com/midnightntwrk/passport/issues/51)
  for signing, [#62](https://github.com/midnightntwrk/passport/issues/62) for recovery,
  and [#168](https://github.com/midnightntwrk/passport/issues/168) for MIP-0020
  adoption. Publication does not close their integration/review obligations.
- Upstream canonical headers checked at
  [`eb94bc1`](https://github.com/midnightntwrk/midnight-improvement-proposals/commit/eb94bc182221cd937a84ed66a5f903b060f165ab);
  Passport main at `d315208` after #180 merged. The older audit retains its source receipts and
  scope limits; GitHub Project fields were not re-audited in this follow-up.
