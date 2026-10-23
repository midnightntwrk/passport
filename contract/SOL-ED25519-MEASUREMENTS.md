# `sol_ed25519` measurements

Measured 2026-10-18 (`issue_grant_with_sol_ed25519`: 2026-10-20). Compact 0.35.0 (`--feature-zkir-v3`), midnight-zkir 3.1.0-rc.1, runtime 0.20.0, ledger 9; proof server midnightntwrk/proof-server:9.0.0-rc.8 on the reference localnet (node 2.1.0-rc.4). Format `sol v1` as frozen in `src/tests/vectors/sol-ed25519-messages-v1.json`.

## Per circuit

| Circuit | k | Rows | Signed message (bytes) | SHA-512 blocks of R ‖ A ‖ message | Prover key (MiB) | Verifier key (bytes) | Proving time, median (s) | Observations | Min / max (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `activate_initial_device_with_sol_ed25519` | 14 | 15,867 | — (no signature) | — | 27.0 | 2,649 | 1.4 | 8 | 1.2 / 2.0 |
| `revoke_all_grants_with_sol_ed25519` | 17 | 98,508 | 369 | 4 | 276.1 | 3,369 | 11.6 | 3 | 11.1 / 15.7 |
| `recover_cancel_with_sol_ed25519` | 17 | 99,221 | 371 | 4 | 288.1 | 3,513 | 9.3 | 9 | 8.8 / 14.5 |
| `rotate_enc_key_with_sol_ed25519` | 17 | 104,783 | 491 | 5 | 276.1 | 3,369 | 10.5 | 30 | 8.9 / 18.4 |
| `withdraw_unshielded_with_sol_ed25519` | 17 | 120,676 | 600 | 6 | 276.3 | 3,369 | 9.7 | 16 | 7.6 / 14.5 |
| `append_inbox_with_sol_ed25519` | 17 | 125,094 | 813 | 7 | 276.2 | 3,369 | 10.8 | 4 | 9.3 / 12.4 |
| `withdraw_unshielded_with_grant_sol_ed25519` | 18 | 138,800 | 726 | 7 | 552.3 | 3,369 | 19.9 | 25 | 16.4 / 35.8 |
| `publish_recovery_session_with_sol_ed25519` | 18 | 145,355 | 1,230 | 11 | 576.3 | 3,513 | 20.4 | 19 | 17.8 / 27.2 |
| `withdraw_shielded_with_sol_ed25519` | 18 | 148,645 | 841 | 8 | 552.3 | 3,369 | 20.7 | 9 | 17.0 / 26.9 |
| `add_device_with_sol_ed25519` | 18 | 151,230 | 685 | 6 | 552.3 | 3,369 | 19.7 | 36 | 15.2 / 33.7 |
| `withdraw_shielded_to_contract_with_sol_ed25519` | 18 | 154,282 | 851 | 8 | 552.3 | 3,369 | 18.7 | 8 | 17.9 / 25.8 |
| `revoke_grant_with_sol_ed25519` | 18 | 154,732 | 730 | 7 | 552.3 | 3,369 | 23.2 | 3 | 20.0 / 28.7 |
| `remove_device_with_sol_ed25519` | 18 | 160,477 | 761 | 7 | 552.3 | 3,369 | 18.2 | 15 | 16.8 / 26.1 |
| `withdraw_shielded_with_grant_sol_ed25519` | 18 | 203,307 | 1,566 | 13 | 552.5 | 3,369 | 20.0 | 22 | 16.0 / 30.5 |
| `withdraw_shielded_to_contract_with_grant_sol_ed25519` | 18 | 209,058 | 1,576 | 13 | 552.5 | 3,369 | 21.4 | 23 | 18.8 / 26.3 |
| `issue_grant_with_sol_ed25519` | 18 | 228,858 | 1,690 | 14 | 552.5 | 3,369 | 15.2 | 46 | 15.0 / 20.0 |

All 16 circuits are at k ≤ 18; the widest is `issue_grant_with_sol_ed25519` (228,858 rows, 33,286 below 2^18). Their verifier keys total 53,472 bytes; with `sol_ed25519` registered in `ARMS`, `planWaves` packs the 68-circuit roster into waves of at most 15,000 verifier bytes each (`evidence/sol-ed25519/full-roster-deploy.json`).

**Scope of the timings.** Each observation is the wall time of one `/prove` request to the proof server for the circuit's own key, recorded by the test harness (`src/tests/constraint-negative.ts`) during the constraint-level suite (`npm run test:sol-ed25519`): the honest calls and the positive controls that precede the negatives, against local account states. It includes the upload of the prover key with the request and the proof server's key loading; it excludes signing, local execution, the Zswap proofs of a shielded transaction, balancing and inclusion. Requests whose verifier key differs from the measured build are excluded. The host was not idle during the run (other builds and test runs shared its CPUs), so a time can include that load. These are observations, not a latency distribution. One request whose first attempt the proof server did not survive was sent again after a restart; its time is excluded (`excludedRetried` in the evidence).

**Hardware.** Apple M4 Max, 16 logical CPUs, 48 GiB host RAM (darwin/arm64). Proving in Docker: aarch64, 12 CPUs, no container memory limit (the Docker VM has 30.1 GiB).

**Memory.** A proof server that proves many distinct k 18 circuits grows to about 17 GiB resident, with peaks above 22 GiB, and is then killed by the Docker VM's out-of-memory handling (30.1 GiB VM, no container memory limit). The suite restarts the proof server before each section (each grantee twin of `grantee-scope` on its own). In the run of record the server was killed during a `/prove` once (`readability`); the test runner restarted it and sent that request again, which was answered. A server that proves many k 18 circuits should be restarted between runs or given more memory; this is an operating note, not a minimum-memory requirement. The proof server image has no `cat`, so the container's `memory.peak` is not available.

**Evidence.** [Circuit sizes, key hashes and timings](evidence/sol-ed25519/circuit-sizes.json); [the prover suite's cases and refusing layers](evidence/sol-ed25519/prover-suite.json).
