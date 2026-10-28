# `evm_k256` measurements

Historical baseline measured 2026-10-24, before the key-text selector. The four changed circuits have new mock-compile results below; their old key sizes and proving times do not describe the updated circuits. **Sizes**: k and rows by `zkir-v3 mock-compile` of each circuit's `.zkir`, and the proof server's `/k` agrees for all 16; the key sizes are those of `compact compile +0.35.0 --feature-zkir-v3`. **Proving times**: the constraint-level suite's run on the same keys (below). Compact 0.35.0 (`--feature-zkir-v3`), midnight-zkir 3.1.0-rc.1, runtime 0.20.0, ledger 9; proof server midnightntwrk/proof-server:9.0.0-rc.8 on the reference localnet (node 2.1.0-rc.4).

## Key-text selector confirmation (2026-10-28)

Fresh Compact 0.35.0 `--feature-zkir-v3 --skip-zk` compilation at source commit `1389706`, followed by `zkir-v3 mock-compile` on each of the four changed account circuits. These are mock-compile rows and k only: no keys were built, no proof server `/k` was called, and no proving time was measured. All other 64 account `.zkir` files are byte-identical to the baseline. All four changed circuits remain at k ≤ 18; `add_device` and `revoke_grant` move from k 17 to k 18.

| Circuit | Before rows | Before k | After rows (mock) | After k (mock) |
|---|---:|---:|---:|---:|
| `add_device_with_evm_k256` | 126,449 | 17 | 140,297 | 18 |
| `issue_grant_with_evm_k256` | 181,201 | 18 | 196,719 | 18 |
| `remove_device_with_evm_k256` | 133,771 | 18 | 149,289 | 18 |
| `revoke_grant_with_evm_k256` | 130,788 | 17 | 144,576 | 18 |

The pure key-text probe exercises all three forms without a registered kind for the additional forms. Existing approval digests are unchanged. New proving/verifier keys are needed for these four circuits when deploying this source; the baseline keyed sizes and proving timings below are historical observations only.

## Historical baseline per circuit

| Circuit | k | Rows | Prover key (MiB) | Verifier key (bytes) | Proving time, median (s) | Observations | Min / max (s) |
|---|---:|---:|---:|---:|---:|---:|---|
| `activate_initial_device_with_evm_k256` | 15 | 17,953 | 68.0 | 3,321 | 2.9 | 12 | 2.6 / 3.6 |
| `revoke_all_grants_with_evm_k256` | 16 | 54,033 | 136.0 | 3,321 | 6.2 | 7 | 5.3 / 6.7 |
| `recover_cancel_with_evm_k256` | 16 | 54,735 | 142.0 | 3,465 | 5.6 | 13 | 5.3 / 6.8 |
| `rotate_enc_key_with_evm_k256` | 16 | 58,281 | 136.0 | 3,321 | 5.7 | 22 | 5.4 / 9.0 |
| `append_inbox_with_evm_k256` | 17 | 61,333 | 272.0 | 3,321 | 11.9 | 7 | 9.8 / 12.8 |
| `withdraw_unshielded_with_evm_k256` | 17 | 64,757 | 272.1 | 3,321 | 9.9 | 18 | 9.4 / 12.5 |
| `publish_recovery_session_with_evm_k256` | 17 | 68,112 | 284.0 | 3,465 | 10.7 | 27 | 10.3 / 13.5 |
| `withdraw_shielded_with_evm_k256` | 17 | 87,447 | 272.1 | 3,321 | 12.0 | 11 | 10.2 / 13.7 |
| `withdraw_unshielded_with_grant_evm_k256` | 17 | 90,823 | 272.1 | 3,321 | 10.5 | 32 | 10.3 / 13.2 |
| `withdraw_shielded_to_contract_with_evm_k256` | 17 | 93,150 | 272.1 | 3,321 | 10.6 | 9 | 10.4 / 13.6 |
| `add_device_with_evm_k256` | 17 | 126,449 | 304.1 | 3,705 | 12.7 | 32 | 12.1 / 18.2 |
| `withdraw_shielded_with_grant_evm_k256` | 17 | 126,817 | 272.2 | 3,321 | 11.8 | 34 | 11.4 / 14.5 |
| `revoke_grant_with_evm_k256` | 17 | 130,788 | 304.1 | 3,705 | 13.1 | 14 | 12.6 / 16.8 |
| `withdraw_shielded_to_contract_with_grant_evm_k256` | 18 | 130,923 | 544.2 | 3,321 | 20.4 | 33 | 19.7 / 26.9 |
| `remove_device_with_evm_k256` | 18 | 133,771 | 608.1 | 3,705 | 22.6 | 24 | 21.5 / 31.4 |
| `issue_grant_with_evm_k256` | 18 | 181,201 | 608.1 | 3,705 | 23.8 | 47 | 22.8 / 31.0 |

All 16 circuits are at k ≤ 18 (k 18: three; the largest, `issue_grant_with_evm_k256`, at 181,201 rows). Their verifier keys total 54,960 bytes; with `evm_k256` registered in the client's arm registry (`ARM_REGISTRY` in `src/wallet/signer.ts`, from which `ARMS` follows), `planWaves` packs the 68-circuit roster into waves of at most 15,000 verifier bytes each (`evidence/evm-k256/full-roster-deploy.json`).

**Scope of the timings.** Each observation is the wall time of one `/prove` request to the proof server, recorded by the test harness (`src/tests/constraint-negative.ts`) during the constraint-level suite (`npm run test:evm_k256`): the honest calls and the positive controls that precede the negatives, against local account states. It includes the upload of the prover key with the request and the proof server's key loading; it excludes signing, local execution, balancing and inclusion. Every request named the verifier key of the measured build. These are observations, not a latency distribution.

**Hardware.** Apple M4 Max, 16 logical CPUs, 48 GiB host RAM (darwin/arm64). Proving in Docker: aarch64, 12 CPUs, no container memory limit (the Docker VM has 30.1 GiB); the proof server ran one worker, and nothing else ran in Docker beside the local stack and the suite during the measured runs.

**Memory.** A k 18 proof needs the proof server's resident memory plus the proof's own. On this VM (30.1 GiB, no container limit), a proof server that has proved many k 18 circuits holds most of the VM, and the next k 18 proof can exceed it; the suite therefore starts each section from a freshly restarted proof server, and the harness retries a request that never reached it (no such retry in the measured runs). `docker stats`, sampled once a minute during the measured runs of 2026-10-24 (135 samples), peaks at 17.2 GiB. This is an operating note, not a minimum-memory requirement. The proof server image has no `cat`, so the container's `memory.peak` is not read.

**Evidence.** [Circuit sizes, key hashes and timings of the 2026-10-24 measurement](evidence/evm-k256/circuit-sizes.json); [the prover suite's cases and refusing layers](evidence/evm-k256/prover-suite.json).
