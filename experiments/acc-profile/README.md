# Compact Passport account benchmarks

## Measured on 24 November 2026

The signature probes verify one ECDSA signature over a prepared digest. Rotation also checks the enrolled device, applies replay protection and updates account state. The P-256 rotation verifies the signed WebAuthn data.

| Benchmark | secp256k1 | P-256 |
|---|---:|---:|
| One prehashed signature, three paired requests per curve | 3.78 s (`k=16`) | 7.47 s (`k=17`) |
| Full account key rotation, three paired requests per curve | 11.07 s (`k=17`) | 25.13 s (`k=18`) |

Passport [`df04567`](https://github.com/midnightntwrk/passport/tree/df04567236230c79377612d314ddabe43428257c), Compact 0.35.0 (ZKIR v3), Node 22.22.2, proof server 9.0.0-rc.8. Apple M4 Max, 16 cores, 64 GiB RAM, macOS 27.2.1. The ARM64 Docker VM had 8 vCPUs and 23.43 GiB RAM.

Times are arithmetic means from a local proof server on a shared host. A request includes reading the proving artifacts, sending them over loopback, and receiving the proof. Signing, key generation, wallet balancing and chain inclusion are outside the timer. Each paired comparison ran A then B three times on the warmed server. [Recorded samples, circuit rows and means](results.csv)

## Run

From the repository root, run the following with Bash, Python 3, Compact 0.35.0, Node.js 22, npm and Docker. Allow disk space for the temporary build (the account keys alone occupy about 12 GiB). The script uses the contract’s locked npm dependencies and mounts the local Midnight public parameter cache into the proof server. Set `MIDNIGHT_PP` if the cache is outside its standard location. Set `COMPACT_DIR` if the Compact release binaries are outside the standard installation.

```sh
./experiments/acc-profile/run.sh --prefixes --sharing --out /tmp/passport-benchmark
```

Use a new output directory each time. The command above produces the [results.csv](results.csv) format, per-request timings, the compiled sizes, and the per-stage row counts. Omit `--sharing` and `--prefixes` for just the baseline. To reuse existing account keys, set `ACC_KEYED_ACCOUNT` to the full `contract/contracts/managed/account` build directory. The runner checks it against freshly compiled circuit IR.

For circuit sizes alone, use Bash, Python and Compact.

```sh
./experiments/acc-profile/run.sh --sizes-only --out /tmp/passport-sizes
```

## Where the rows go

- Computing `0 × G` for the public-key identity check adds **11,651 of 40,409 rows** in the standalone secp256k1 verifier and **21,855 of 59,063** in P-256. A cheaper representation of the same identity is a target for both curves.
- In a P-256 rotation, preparing the WebAuthn digest adds **86,363 of 163,324 rows** (52.9%). Checking the ECDSA signature adds **49,275** (30.2%). These are changes in assigned rows as successive instruction groups are compiled. Per-stage elapsed time was not instrumented.

An experimental variant shares the challenge encoding and origin validation between the two supported browser formats. Each row below uses three pairs on the same signed input. The full-rotation comparison ran later, at lower host load than the cross-curve comparison above.

| P-256 workload | Assigned rows, current → shared | Proving domain, current → shared | Mean request, current → shared |
|---|---:|---:|---:|
| Standalone WebAuthn verification | 136,195 → 119,703 | `k=18` → `17` | 18.82 → 9.37 s |
| Full account key rotation | 163,324 → 137,399 | `k=18` → `18` | 17.37 → 17.24 s |

## Account circuit inventory

Each cell gives **`k` / mean seconds** from the 52-entry account sweep. The proving domain has 2<sup>k</sup> positions. All 15 signature-authorized operations per curve use `k=17` on secp256k1 and `k=18` on P-256. Initial activation checks a bootstrap commitment. Append the column suffix to the entry stem for the exported name. Each rotation has three samples in this sweep and every other circuit has two. Under varying host load the two direct P-256 unshielded withdrawal requests took 73.21 s and 19.87 s on the same fixture.

| Entry stem | `_jubjub` | `_k256` | `_p256` |
|---|---:|---:|---:|
| `activate_initial_device_with` | 14 / 3.83 | 14 / 4.79 | 14 / 4.37 |
| `add_device_with` | 15 / 8.05 | 17 / 37.90 | 18 / 46.33 |
| `append_inbox_with` | 16 / 4.44 | 17 / 12.92 | 18 / 23.58 |
| `issue_grant_with` | 16 / 5.81 | 17 / 13.53 | 18 / 24.41 |
| `publish_recovery_session_with` | 16 / 4.25 | 17 / 10.00 | 18 / 20.64 |
| `recover_cancel_with` | 15 / 2.24 | 17 / 9.83 | 18 / 20.20 |
| `remove_device_with` | 16 / 4.10 | 17 / 9.53 | 18 / 19.88 |
| `revoke_all_grants_with` | 15 / 2.26 | 17 / 9.55 | 18 / 19.54 |
| `revoke_grant_with` | 15 / 2.24 | 17 / 9.44 | 18 / 19.52 |
| `rotate_enc_key_with` | 15 / 2.06 | 17 / 8.39 | 18 / 27.19 |
| `withdraw_shielded_to_contract_with` | 16 / 4.24 | 17 / 9.72 | 18 / 19.93 |
| `withdraw_shielded_to_contract_with_grant` | 17 / 8.13 | 17 / 10.23 | 18 / 20.37 |
| `withdraw_shielded_with` | 16 / 4.23 | 17 / 9.77 | 18 / 20.03 |
| `withdraw_shielded_with_grant` | 17 / 8.07 | 17 / 9.98 | 18 / 20.35 |
| `withdraw_unshielded_with` | 15 / 5.44 | 17 / 26.79 | 18 / 46.54 |
| `withdraw_unshielded_with_grant` | 16 / 4.20 | 17 / 9.88 | 18 / 25.67 |

| Entry without a curve suffix | k | Mean seconds |
|---|---:|---:|
| `deposit_shielded` | 13 | 1.13 |
| `deposit_unshielded` | 9 | 0.19 |
| `recover_finalise` | 12 | 0.42 |
| `recover_submit` | 15 | 2.54 |
