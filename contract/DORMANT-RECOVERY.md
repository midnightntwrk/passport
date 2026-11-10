# Dormant recovery: bootstrap retirement

**Source correction dated 2026/11/10.** Audit finding `REC-BOOT-001`,
remediation task `REC-TASK-1`. This note describes the local implementation
and deployment consequences. It does not record a live upgrade.

## Behaviour and scope

The constructor in [`account.compact`](contracts/account.compact) stores
the initial device's salted commitment in `boot`, sets `booted = false`,
and installs a recovery public key. A valid recovery can therefore begin
before the initial device activates. Recovery from birth still requires
usable retained recovery authority; a stored recovery key alone does not
establish that its secret is available.

Previously, successful `recover_finalise` installed the authorised successor
but left an unconsumed bootstrap commitment intact. The original committed
device could then activate at the new epoch, join the successor in `devices`,
and reset `device_count` to one. Opening activation requires the committed
public key and salt, while subsequent device-authorised operations require
the corresponding private key. This is a dormant-account lifecycle defect,
not a bypass of recovery signatures or the veto window.

The corrected shared `recover_finalise` sets `booted = true` and clears
`boot`, atomically with retiring the old device set and installing the
successor. All three activation circuits already reject `booted = true`:
JubJub and secp256k1 in `account.compact`, and P-256 in
[`account-p256.compact`](contracts/account-p256.compact). Ordinary initial
activation and recovery submission remain available under their existing
conditions. A failed or premature finalisation does not consume bootstrap
authority.

The audit's pinned upstream standards revision,
`02fce36cfa44541305310dc25fd38f399dbe8d92`, requires finalisation to leave
the authorised successor as the sole active device in
[MIP-0013 §8 and AUTH-6](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/02fce36cfa44541305310dc25fd38f399dbe8d92/mips/mip-0013-account-authorisation.md#8-recovery-seam)
and [MIP-0022 §6 and REC-8](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/02fce36cfa44541305310dc25fd38f399dbe8d92/mips/mip-0022-account-recovery.md#6-the-recovery-operation).
Consuming outstanding bootstrap authority closes a later path for
reintroducing the original device without fresh authorised enrolment. This
is a scoped implementation correction, not a claim of full MIP conformance.

This changes two existing ledger cells during finalisation. It does not
change the ledger layout, circuit arguments, device-entry derivation,
recovery signature challenge, or signature recipes. The implementation
keeps `spec_version = 3` and `recovery_version = 1`: the former is used by
the client's scoped-grant capability gate, while the latter describes the
published recovery artefact set read by
[`recovery-gate.ts`](src/wallet/recovery-gate.ts). Neither value identifies
whether the corrected verifier is installed. The private package's
`0.1.0` version is not an on-chain correction marker either. No version
bump is required by those existing code paths for this correction; a
release must still identify its corrected source and generated artefacts.

## Existing deployments

A source merge, rebuilt client, or new local key file does **not** update an
installed verifier or rewrite existing ledger state.

| Deployment or state | Required handling |
|---|---|
| Fresh deployment | Generate and validate corrected artefacts, install the complete intended roster, and record the actual verifier identities and maintenance policy. The corrected finalisation consumes outstanding bootstrap authority. |
| Existing deployment with compatible ledger layout and usable maintenance authority | A reviewed, signed verifier replacement can install corrected finalisation logic without a ledger-schema migration. Inspect existing state separately; replacement does not execute the circuit. |
| Existing deployment with retired maintenance authority | The reference retirement policy leaves an empty committee at threshold one. It cannot authorise a verifier replacement. Adoption requires migration to a corrected deployment; asset transfer and successor authority must be planned for the account's actual state. |
| Recovery already finalised while dormant, bootstrap still unconsumed | Updating the verifier leaves the stale `boot` and `booted` cells unchanged. Assess an explicitly authorised recovery through the corrected circuit, or a reviewed migration/repair strategy. The original birth recovery secret is not automatically sufficient: finalisation rotates `recovery_pk` and clears `recovery_phi_len`. |
| Original bootstrap already activated after recovery | The flag can now look consumed even though an unwanted device entry was inserted. Inspect authority, membership, and transaction history. Merely clearing bootstrap state cannot retire that entry; use a reviewed full recovery or migration strategy with the necessary current authority. |
| Initial activation completed before recovery | This dormant-bootstrap sequence does not apply because activation already consumed the commitment. This fact alone does not establish the deployed verifier revision or broader account security. |

The reference [`wave-deploy.ts`](src/wallet/wave-deploy.ts) retires maintenance
authority by default. With `retireAuthority: false`, an authority remains a
custody boundary: it can replace verification logic. The historical
[`auth-coinless.ts`](src/tests/auth-coinless.ts) controls demonstrate the
required **`VerifierKeyRemove` followed by `VerifierKeyInsert` in the same
signed update**, using the current authority counter. A bare insert is not
a replacement. The deployment wave helper installs missing operations;
it is not a ready-made update command for existing accounts. Its pinned
SDK compatibility caveat also applies, as described in the
[deployment documentation](README.md#the-maintenance-authority-sits-above-the-seam-so-the-last-wave-retires-it).

Before selecting a repair, retain a consistent state snapshot and record
the installed operation keys, maintenance authority, `boot`, `booted`,
`device_epoch`, pending recovery fields, `device_count`, and actual `devices`
membership. Compare the set itself with its count and expected authorised
entries. Under this source's transitions, `booted = false` with an advanced
epoch is an indicator of unconsumed bootstrap after recovery. Conversely,
`booted = true`, an empty commitment, or a matching count alone cannot rule
out past bootstrap reactivation. Entries are opaque commitments, so history
and known credentials may be needed to establish who can authorise.

Do not activate the original bootstrap as a repair: that is the vulnerable
transition. No automatic state repair or migration tool is supplied here.

## Artefacts and release validation

Changing the finalisation relation requires matching generated runtime,
ZKIR, proving key, verifier key, and integrity metadata. Old finalisation
keys cannot establish that the corrected relation is installed. The minimum
release work is:

1. Build from the reviewed source revision using the pinned toolchain and
   lockfile. Regenerate the changed `recover_finalise` proof artefacts and
   compare all emitted artefacts, rather than assuming that only one file
   changed. A clean `npm run compile` from `contract/` is the repository's
   documented full-generation path. `npm run compile:ecc` uses `--skip-zk`
   and does not generate proving/verifier keys.
2. Keep the generated manifest, runtime, ZKIR, and keys consistent, with
   integrity checks enabled. Record source and artefact hashes. Recompute
   deployment/maintenance wave sizes from the resulting verifier keys;
   previous byte sizes and wave counts are historical measurements.
3. Run `npm run test:recovery-bootstrap` against freshly generated runtime,
   then load the generated artefacts and check deployment planning
   with `npm run test:toolchain-offline`. That command is an offline
   artefact/deployment-construction check, not proof or node validation.
4. Before release or live replacement, obtain fresh proof and node evidence
   for dormant recovery and successor operation, with delayed activation
   refused for every initial arm. Record the exact installed verifier and
   post-finalisation state. For a maintenance upgrade, also exercise and
   verify the replacement on a disposable deployment with the same authority
   policy and compatible ledger shape before applying the reviewed plan.

The existing [2026/10/23 recovery evidence](GRANTS-COMPLETION.md#recovery-and-grant-lifecycle-on-node)
validates the earlier atomic device-set reset. It predates this bootstrap
correction and cannot establish proof or node acceptance of the changed
finalisation relation. Historical verifier-replacement controls establish
the mechanism on their recorded stack, not completion of this upgrade.

## Validation of this correction

Local checks completed on **2026/11/10**, starting from Passport
`44738eebe712ac5703babcac72d3e98b6d38e3c0` plus this correction:

- Fresh Compact 0.35.0 compilation with `--feature-zkir-v3 --skip-zk`
  generated the corrected runtime. The
  [bootstrap regression suite](src/tests/recovery-bootstrap.ts) passed all
  **20 tests**. It covers all three initial arms and both secp256k1 envelopes,
  delayed activation, successor authority/enrolment, exact membership/count,
  premature-finalisation rollback, activation/cancellation interleavings,
  activation/finalisation interleavings, and later recovery. The same suite
  against the pre-fix runtime passed 16 tests and failed the four dormant
  recovery profiles. The TypeScript build, existing recovery simulator, and
  P-256 offline suite also passed. These are generated-runtime/client checks,
  not proof or node acceptance.
- All **52 textual ZKIR files** were compared between pre-fix and corrected
  builds; only `recover_finalise` changed. The bundled ZKIR 3.1.0-rc.1 tool
  successfully generated proving and verifier keys for that corrected
  circuit. Both pre-fix and corrected circuits used `k = 12`; reported rows
  increased from 2,365 to 2,398. The corrected verifier is 1,593 bytes and
  the proving key is 4,201,843 bytes. Equal verifier size does not mean equal
  verifier identity.

| Recorded item | SHA-256 |
|---|---|
| Corrected `contracts/account.compact` | `1aebd2759b968f464ef17e35293794c77924693bf707ac5b9fee1ad0582ece0c` |
| Corrected `recover_finalise` verifier key | `ac5d09dead257d9b865eedffcae9bc3eae91f2ec874183972c81acb2ceaeb114` |
| Corrected `recover_finalise` proving key | `8ade38e6dfc57bf40311635cd77c412e18477240bb25599a336f80a9615f691b` |

This was single-circuit key generation. A complete generated key roster and
integrity manifest were not produced or validated for this correction. No
fresh full proof, node admission, maintenance replacement, state repair, or
live deployment was performed. The release-validation steps above remain
necessary before deployment.
