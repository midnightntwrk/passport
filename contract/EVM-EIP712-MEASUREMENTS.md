# `evm_eip712` measurements

Measured 2026-10-18 (`issue_grant_with_evm_eip712`: 2026-10-20). Compact 0.35.0 (`--feature-zkir-v3`), midnight-zkir 3.1.0-rc.1, runtime 0.20.0, ledger 9; proof server midnightntwrk/proof-server:9.0.0-rc.8 on the reference localnet (node 2.1.0-rc.4).

## Per circuit

| Circuit | k | Rows | Prover key (MiB) | Verifier key (bytes) | Proving time, median (s) | Observations | Min / max (s) |
|---|---:|---:|---:|---:|---:|---:|---|
| `activate_initial_device_with_evm_eip712` | 15 | 17,139 | 68.0 | 3,321 | 2.8 | 7 | 2.7 / 3.6 |
| `revoke_all_grants_with_evm_eip712` | 16 | 62,470 | 136.0 | 3,321 | 7.6 | 2 | 7.6 / 7.6 |
| `recover_cancel_with_evm_eip712` | 16 | 63,172 | 142.0 | 3,465 | 5.9 | 4 | 5.8 / 7.2 |
| `rotate_enc_key_with_evm_eip712` | 17 | 60,921 | 272.0 | 3,321 | 9.9 | 9 | 9.7 / 13.5 |
| `append_inbox_with_evm_eip712` | 17 | 69,778 | 272.0 | 3,321 | 13.5 | 2 | 13.5 / 13.5 |
| `withdraw_unshielded_with_evm_eip712` | 17 | 73,202 | 272.1 | 3,321 | 13.1 | 10 | 10.5 / 15.1 |
| `publish_recovery_session_with_evm_eip712` | 17 | 76,557 | 284.0 | 3,465 | 10.7 | 9 | 10.4 / 14.8 |
| `withdraw_shielded_with_evm_eip712` | 17 | 95,892 | 272.1 | 3,321 | 14.0 | 3 | 10.7 / 14.1 |
| `withdraw_unshielded_with_grant_evm_eip712` | 17 | 99,268 | 272.2 | 3,321 | 10.7 | 22 | 10.4 / 15.6 |
| `withdraw_shielded_to_contract_with_evm_eip712` | 17 | 101,595 | 272.1 | 3,321 | 14.6 | 3 | 11.5 / 15.2 |
| `add_device_with_evm_eip712` | 18 | 133,169 | 608.1 | 3,705 | 26.1 | 18 | 24.8 / 35.5 |
| `withdraw_shielded_with_grant_evm_eip712` | 18 | 133,618 | 544.2 | 3,321 | 24.4 | 30 | 22.9 / 34.4 |
| `revoke_grant_with_evm_eip712` | 18 | 137,452 | 608.1 | 3,705 | 26.6 | 6 | 25.9 / 38.4 |
| `withdraw_shielded_to_contract_with_grant_evm_eip712` | 18 | 139,321 | 544.2 | 3,321 | 24.1 | 29 | 23.0 / 33.3 |
| `remove_device_with_evm_eip712` | 18 | 142,161 | 608.1 | 3,705 | 27.2 | 9 | 25.9 / 37.3 |
| `issue_grant_with_evm_eip712` | 18 | 189,595 | 608.1 | 3,705 | 28.0 | 43 | 23.5 / 43.5 |

All 16 circuits are at k ≤ 18. Their verifier keys total 54,960 bytes; with `evm_eip712` registered in `ARMS`, `planWaves` packs the 68-circuit roster into waves of at most 15,000 verifier bytes each (`evidence/evm-eip712/full-roster-deploy.json`).

**Scope of the timings.** Each observation is the wall time of one `/prove` request to the proof server, recorded by the test harness (`src/tests/constraint-negative.ts`) during the constraint-level suite (`npm run test:evm_eip712`): the honest calls and the positive controls that precede the negatives, against local account states. It includes the upload of the prover key with the request and the proof server's key loading; it excludes signing, local execution, balancing and inclusion. Requests whose verifier key differs from the measured build are excluded. These are observations, not a latency distribution.

**Hardware.** Apple M4 Max, 16 logical CPUs, 48 GiB host RAM (darwin/arm64). Proving in Docker: aarch64, 12 CPUs, no container memory limit (the Docker VM has 30.1 GiB).

**Memory.** A k 18 proof needs the proof server's resident memory plus the proof's own. On this VM (30.1 GiB, no container limit), a proof server that has proved many k 18 circuits holds most of the VM, and the next k 18 proof can exceed it; the suite therefore starts each section from a freshly restarted proof server, and a request that finds the server gone is retried once after a restart (no such restart in the measured runs). `docker stats`, sampled once a minute during the measured runs of 2026-10-18 (328 samples), peaks at 20.7 GiB. This is an operating note, not a minimum-memory requirement. The proof server image has no `cat`, so the container's `memory.peak` is not read.

**Evidence.** [Circuit sizes, key hashes and timings](evidence/evm-eip712/circuit-sizes.json); [the prover suite's cases and refusing layers](evidence/evm-eip712/prover-suite.json).
