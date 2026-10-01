# P-256 / WebAuthn measurements

Measured 2026-10-01T11:09:03.133Z. Compact 0.35.0, midnight-zkir 3.1.0-rc.1; runtime 0.20.0, ledger 9.

## Comparable circuits

| Circuit | k | Rows | Prover key (MiB) | First (s) | Repeat 1 / 2 (s) | Repeat mean (s) |
|---|---:|---:|---:|---:|---:|---:|
| Native P-256 verifier | 17 | 59,063 | 164.01 | 10.775 | 9.370 / 9.286 | 9.328 |
| Profiled WebAuthn verifier | 17 | 112,156 | 224.09 | 13.992 | 11.982 / 11.974 | 11.978 |
| Account rotation — JubJub | 15 | 26,764 | 47.01 | 2.989 | 2.568 / 2.529 | 2.548 |
| Account rotation — k256 | 17 | 61,754 | 224.01 | 13.094 | 11.102 / 11.025 | 11.063 |
| Account rotation — P-256/WebAuthn | 18 | 129,832 | 448.09 | 26.754 | 22.140 / 22.070 | 22.105 |

**Scope.** The first two rows are standalone verifier-cost probes with a public digest/challenge output. The account rows measure the same `rotate_enc_key` operation with enrolment, rolling entry and nonce checks. The WebAuthn rows use profile `wa-json134` (134-byte JSON, 21-byte origin, 37-byte authenticator data, UP+UV). They are not general variable-length WebAuthn measurements.

**Timing.** Sequential `ProvingProvider.prove` wall time, including artifact lookup/load and local HTTP transfer; excluding signing, circuit execution/check, wallet balancing and inclusion. The first observation and two repeats are reported separately. No claim of OS/server cold-cache behaviour; key generation is excluded. These are three observations, not a latency distribution.

**Hardware.** Apple M4 Max, 16 logical CPUs, 64 GiB host RAM (darwin/arm64). Native compiler/key generation on the host; proving in Docker: aarch64 8 CPUs 25159827456 memoryBytes.

**Memory.** The first full-account proof OOM-killed the proof server in the approximately 8 GiB Docker VM ([failure evidence](evidence/p256-webauthn/prover-8gib-oom.json)). The measured run uses a 24 GiB VM. Container lifetime memory peak: not available. This is not an exact minimum-memory requirement.

**Evidence.** [Circuit sizes and exact key/ZKIR hashes](evidence/p256-webauthn/circuit-sizes.json); [proving samples, image identity and accepted transactions](evidence/p256-webauthn/conformance-and-proving.json). Account calls use an OpenSSL software authenticator; the two verifier probes prove the captured real high-S WebAuthn assertion. Negative assertions abort during local building. These results are separate from the earlier custom Rust proof-stack experiment.

## Full account inventory

All 52 circuits are compiled on the same stack. Sizes below are exact uncompressed bytes. A dash in other reports must not be interpreted as a measured proving time: only the comparison above has repeated timings.

| Circuit | k | Rows | Prover bytes | Verifier bytes |
|---|---:|---:|---:|---:|
| `activate_initial_device_with_jubjub` | 14 | 13447 | 24648297 | 2313 |
| `activate_initial_device_with_k256` | 14 | 14129 | 29368305 | 2745 |
| `activate_initial_device_with_p256` | 14 | 15342 | 29368076 | 2745 |
| `add_device_with_jubjub` | 15 | 26819 | 49291628 | 2313 |
| `add_device_with_k256` | 17 | 61809 | 234893509 | 2745 |
| `add_device_with_p256` | 18 | 129887 | 469855382 | 2745 |
| `append_inbox_with_jubjub` | 16 | 32838 | 98574819 | 2313 |
| `append_inbox_with_k256` | 17 | 67836 | 234893639 | 2745 |
| `append_inbox_with_p256` | 18 | 135914 | 469855622 | 2745 |
| `deposit_shielded` | 13 | 6506 | 11278212 | 2121 |
| `deposit_unshielded` | 9 | 331 | 446790 | 1353 |
| `issue_grant_with_jubjub` | 16 | 52285 | 98579753 | 2313 |
| `issue_grant_with_k256` | 17 | 87277 | 234898677 | 2745 |
| `issue_grant_with_p256` | 18 | 155355 | 469860871 | 2745 |
| `publish_recovery_session_with_jubjub` | 16 | 36491 | 98577629 | 2313 |
| `publish_recovery_session_with_k256` | 17 | 72217 | 247479764 | 2889 |
| `publish_recovery_session_with_p256` | 18 | 140296 | 495024744 | 2889 |
| `recover_cancel_with_jubjub` | 15 | 27029 | 49292003 | 2313 |
| `recover_cancel_with_k256` | 17 | 62383 | 247477110 | 2889 |
| `recover_cancel_with_p256` | 18 | 130460 | 495021935 | 2889 |
| `recover_finalise` | 12 | 2352 | 4201447 | 1593 |
| `recover_submit` | 15 | 30436 | 49293353 | 2313 |
| `remove_device_with_jubjub` | 16 | 32776 | 98575409 | 2313 |
| `remove_device_with_k256` | 17 | 68314 | 234894405 | 2745 |
| `remove_device_with_p256` | 18 | 138266 | 469856388 | 2745 |
| `revoke_all_grants_with_jubjub` | 15 | 26692 | 49291293 | 2313 |
| `revoke_all_grants_with_k256` | 17 | 61682 | 234893165 | 2745 |
| `revoke_all_grants_with_p256` | 18 | 129759 | 469855068 | 2745 |
| `revoke_grant_with_jubjub` | 15 | 26914 | 49292391 | 2313 |
| `revoke_grant_with_k256` | 17 | 61904 | 234894334 | 2745 |
| `revoke_grant_with_p256` | 18 | 129982 | 469856309 | 2745 |
| `rotate_enc_key_with_jubjub` | 15 | 26764 | 49291116 | 2313 |
| `rotate_enc_key_with_k256` | 17 | 61754 | 234892984 | 2745 |
| `rotate_enc_key_with_p256` | 18 | 129832 | 469854852 | 2745 |
| `withdraw_shielded_to_contract_with_grant_jubjub` | 17 | 71757 | 197146593 | 2313 |
| `withdraw_shielded_to_contract_with_grant_k256` | 17 | 106223 | 234899216 | 2745 |
| `withdraw_shielded_to_contract_with_grant_p256` | 18 | 176220 | 469861954 | 2745 |
| `withdraw_shielded_to_contract_with_jubjub` | 16 | 55792 | 98576810 | 2313 |
| `withdraw_shielded_to_contract_with_k256` | 17 | 88939 | 234895726 | 2745 |
| `withdraw_shielded_to_contract_with_p256` | 18 | 157018 | 469857793 | 2745 |
| `withdraw_shielded_with_grant_jubjub` | 17 | 66054 | 197146073 | 2313 |
| `withdraw_shielded_with_grant_k256` | 17 | 100520 | 234898697 | 2745 |
| `withdraw_shielded_with_grant_p256` | 18 | 170517 | 469861412 | 2745 |
| `withdraw_shielded_with_jubjub` | 16 | 50089 | 98576303 | 2313 |
| `withdraw_shielded_with_k256` | 17 | 83236 | 234895206 | 2745 |
| `withdraw_shielded_with_p256` | 18 | 151315 | 469857250 | 2745 |
| `withdraw_unshielded_with_grant_jubjub` | 16 | 38546 | 98577592 | 2313 |
| `withdraw_unshielded_with_grant_k256` | 17 | 73002 | 234896357 | 2745 |
| `withdraw_unshielded_with_grant_p256` | 18 | 142999 | 469858905 | 2745 |
| `withdraw_unshielded_with_jubjub` | 15 | 28920 | 49292614 | 2313 |
| `withdraw_unshielded_with_k256` | 17 | 63907 | 234894504 | 2745 |
| `withdraw_unshielded_with_p256` | 18 | 131986 | 469856466 | 2745 |

## Reproduce

```sh
npm run compile
npm run measure:p256
EVIDENCE_DIR=evidence/p256-webauthn MIDNIGHT_PROOF_CONTAINER=<container> npm run test:p256
npm run report:p256
```

Configure `WALLET_SEED` and the standalone stack as in [README.md](README.md). See [WEBAUTHN.md](WEBAUTHN.md) for the profile, enrolment and specification deltas.
