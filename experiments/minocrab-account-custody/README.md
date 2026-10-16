# Account custody in Minocrab

An independent Rust/Minocrab implementation of all **52 state-changing
entrypoints** of the current **`spec_version = 3` account custody reference** at
passport commit [`0d7bb0bc`](https://github.com/midnightntwrk/passport/tree/0d7bb0bc834f2d45d9fe2d84c4d022a30d648423/contract).
It reproduces the 25-field ledger and constructor, JubJub/k256/P256 device
and grant authorisation, caller-bound grants, recovery publication/submission/
veto/finalisation, shielded and unshielded custody, and encrypted inbox.
The Rust contract is written independently; it does not translate Compact IR.
The unchanged Compact contract and its signers provide the comparison oracle.
No files in the live `contract/` tree are changed.

The reference is compiled with **Compact 0.35.0** and runtime **0.20.0**.
Both implementations are checked, costed, proved, and cryptographically verified
using **ZKIR 3.1.0-rc.1**, at the backend revision bundled with that compiler.
The Minocrab frontend is pinned to `79b2add` (see "Row counts with the
Minocrab helpers" below); its older ZKIR output is
loaded through the current backend's supported legacy reader. The original
reference artifacts are consumed unchanged. Exact revisions and source hashes
are in [reference provenance](reference/provenance.json) and
[run provenance](evidence/provenance.json); all transitive versions are locked.

This remains an offline circuit experiment. Verification-key installation,
wallet transaction construction, funded transactions, and on-node conformance
are not implemented by this experiment.

## Current comparison

Minocrab lowers **`k` by one on 17 of 52 entrypoints**, with **no increases**:
10 k256 operations go from 17 to 16, and 7 P256 operations go from 18 to 17.
The other 35 retain their reference `k`. Ordinary rows decrease on 42 circuits,
increase on 8, and tie on 2. In particular, recovery submission/finalisation
use slightly more rows in Rust while retaining their reference `k`. The
[paired report](evidence/report.md) lists every circuit's `k`, rows, proof bytes,
median proving time, and median verification time. The
[raw samples](evidence/benchmark.json) also retain key-generation timings;
[static costs](evidence/costs.json) include separately labelled ZKIR JSON sizes.

All 17 circuits with improved `k` are listed below. Proving times in parentheses
are medians of three measured proofs after one warm-up, from the paired Apple M4 Max run.

| Circuit | Compact `k` (proving time) | Minocrab `k` (proving time) |
|---|---|---|
| `add_device_with_k256` | 17 (4.74 s) | 16 (2.50 s) |
| `add_device_with_p256` | 18 (9.84 s) | 17 (5.37 s) |
| `append_inbox_with_k256` | 17 (4.65 s) | 16 (2.49 s) |
| `append_inbox_with_p256` | 18 (10.68 s) | 17 (5.41 s) |
| `publish_recovery_session_with_k256` | 17 (4.72 s) | 16 (2.58 s) |
| `recover_cancel_with_k256` | 17 (4.59 s) | 16 (2.48 s) |
| `recover_cancel_with_p256` | 18 (9.53 s) | 17 (5.35 s) |
| `remove_device_with_k256` | 17 (4.60 s) | 16 (2.48 s) |
| `revoke_all_grants_with_k256` | 17 (4.53 s) | 16 (2.49 s) |
| `revoke_all_grants_with_p256` | 18 (9.45 s) | 17 (5.25 s) |
| `revoke_grant_with_k256` | 17 (4.49 s) | 16 (2.40 s) |
| `revoke_grant_with_p256` | 18 (9.33 s) | 17 (5.27 s) |
| `rotate_enc_key_with_k256` | 17 (4.51 s) | 16 (2.39 s) |
| `rotate_enc_key_with_p256` | 18 (9.28 s) | 17 (5.24 s) |
| `withdraw_unshielded_with_grant_k256` | 17 (4.78 s) | 16 (2.77 s) |
| `withdraw_unshielded_with_k256` | 17 (4.44 s) | 16 (2.36 s) |
| `withdraw_unshielded_with_p256` | 18 (8.95 s) | 17 (5.17 s) |

k256 grant unshielded withdrawal and P256 add-device have approximately 42% and
45% shorter proving times, respectively. No verification-speed improvement is
claimed for these examples. Proof sizes match across all 52 pairs.

The native implementation retains these optimisations:

1. **Reuse coordinate bytes.** Derive canonical coordinate encodings once from
   the k256/P256 point argument and reuse them in commitments and challenges
   (and k256 weak-key checks). They are not independent witnesses.
2. **Specialise grant signatures.** Spend grants require envelope zero. Keep
   that assertion and omit the unreachable k256 connector digest; device
   authorisation still supports both envelopes.
3. **Reuse shielded commitments.** Compute the sent coin commitment once and
   reuse it for self-transfers. Specialise recipient types at construction,
   retaining nullifier/self-receive claims, checked subtraction, change outputs,
   and the canonical absent-change payload.

The new recovery and caller checks preserve the reference conditions and
bindings. P256 verifies the reference's `wa-json134` WebAuthn profile in-circuit,
including canonical challenge encoding, RP/origin binding, authenticator flags,
and ECDSA. The pinned Minocrab convenience API lacks P256 argument wrappers and
`kernel.caller`; the experiment supplies typed wrappers and the public ledger
caller query. The caller is never accepted as a private witness.

These optimisations are not exclusive to Minocrab. Coordinate reuse and grant
envelope specialisation can also be expressed in Compact. Improving the live
Compact reference remains a separate work stream. This comparison measures an
optimised Rust contract against an unchanged Compact reference, both on the
same proving backend; it does not isolate the frontend's effect alone.

`k` depends on chip/table configuration and reserved rows as well as ordinary
rows. A smaller `k` targets proving cost and memory; it does not guarantee a
smaller proof or faster verification. The historical v2 results are retained in
[evidence/baseline/](evidence/baseline/) and
[evidence/historical-v2-optimised/](evidence/historical-v2-optimised/).
They use a different reference/backend and are not the current comparison.

## Row counts with the Minocrab helpers

Minocrab `79b2add` (sig-net/minocrab#17) adds `kernel::caller`, a hash
preimage builder that hashes constant domain tags off-circuit, `base64url_32`
in 62 byte splits instead of 286, and a JubJub small-order check by three
doublings. This revision uses them; arguments, ledger, disclosures and
transcripts are unchanged. Static `k` and rows from the same cost model as
[static costs](evidence/costs.json); proving times are not re-measured.
Entrypoints whose `k` moves (none rise):

| Circuit | Compact `k` | #184 `k` | this PR `k` |
|---|---|---|---|
| `append_inbox_with_jubjub` | 16 | 16 | 15 |
| `issue_grant_with_p256` | 18 | 18 | 17 |
| `publish_recovery_session_with_jubjub` | 16 | 16 | 15 |
| `publish_recovery_session_with_p256` | 18 | 18 | 17 |
| `recover_finalise` | 12 | 12 | 11 |
| `remove_device_with_jubjub` | 16 | 16 | 15 |
| `remove_device_with_p256` | 18 | 18 | 17 |
| `withdraw_shielded_to_contract_with_grant_jubjub` | 17 | 17 | 16 |
| `withdraw_shielded_to_contract_with_grant_p256` | 18 | 18 | 17 |
| `withdraw_shielded_to_contract_with_p256` | 18 | 18 | 17 |
| `withdraw_shielded_with_grant_jubjub` | 17 | 17 | 16 |
| `withdraw_shielded_with_grant_p256` | 18 | 18 | 17 |
| `withdraw_shielded_with_p256` | 18 | 18 | 17 |
| `withdraw_unshielded_with_grant_p256` | 18 | 18 | 17 |

| Total rows, 52 circuits | rows | vs this PR |
|---|---|---|
| Compact | 4,010,944 | −26.5% |
| #184 | 3,656,014 | −19.3% |
| this PR | 2,948,966 | |

## Parity evidence

[Execution evidence](evidence/equivalence.json) records **504 executions** from
the reference's generated TypeScript, replayed independently through both
circuits and Midnight's Impact VM. Post-state, return values, and kernel effects
agree; both proof preimages pass the current backend's `Zkir::check`.
Input/output ABI and communications-commitment mode match for all 52 entrypoints.
The independently constructed initial state matches every reference constructor
fixture.

Coverage includes all three owner and grantee arms; both k256 envelopes;
low/high ECDSA S forms; all accepted P256 authenticator flags (5, 13, 29);
external/self shielded sends with exact amounts and change; unrestricted and
caller-bound grants; recovery vector lengths 1, 4, and 2; cancellation and
successful delayed finalisation. It also exercises **11,886 single-slot
input/witness mutations** and **1,644 context checks** for replay, wrong-account
authorisation, caller identity/type/absence, expiry, and recovery timing bounds.
There are **57 passing Rust tests**, including disclosure declarations, the
native `k` budget, byte-encoding/P256 backend compatibility, and executor fixes.

This is differential evidence, not a formal equivalence proof or the full
on-node conformance suite. Each circuit proves its own transcript of the same
operation against the same initial state and arguments. Ledger reads can be
ordered differently; public-input vectors and verification keys need not match.
The reference's behavior is preserved rather than silently corrected.

## Measurement limits

**Complete transaction sizes are not measured:** `transaction_bytes` is `null`.
Proof bytes and ZKIR JSON bytes must not be interpreted as transaction size.
Funded transactions also carry transcripts, offers/shielded proofs, fees, and
signatures. Verification samples measure cryptographic proof verification,
excluding ledger replay, full transaction validation, and network latency.

Each pair uses a release build in separate subprocesses, alternating which
implementation runs first. Parameter loading precedes the key-generation timer.
Key generation is timed separately, then one proof warms the process and three
proofs are timed. Every verification sample is retained; the report uses medians.
Avoid concurrent CPU-heavy work. Three samples cannot establish small timing
improvements reliably.

The last successful fixture per circuit supplies its benchmark preimage.
Grant withdrawals use a restricted contract caller; shielded withdrawals use
an external recipient and exact spend. Change and self-transfer branches are
checked for parity but not separately timed. Timings from previous reference
versions are historical only.

## Reproduce

Prerequisites: Rust, Node.js/npm, Python 3, and Compact compiler `0.35.0`.
From this directory:

```sh
npm ci
npm run compile:reference
npm run fixtures
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release -p project-custody-measure
target/release/project-custody-measure compare --mutations
python3 scripts/bench.py
# Resume only with the same binary, lockfile, equivalence evidence and inputs.
python3 scripts/bench.py --resume
```

`compile:reference` checks source and generated ZKIR hashes. The benchmark
rejects stale binaries/preimages and records their hashes. Dependencies are
pinned in the Rust/npm lockfiles. Initial builds need network access. Midnight
parameters use `MIDNIGHT_PP` or the normal parameter cache and are downloaded
before timing if missing. Fixtures contain synthetic private witnesses and are
ignored by Git, as are generated circuits, preimages, keys, and build outputs.

## Layout and compatibility

- `crates/account-custody/src/`: independently authored contract and ledger.
- `reference/`: pinned Compact contracts, signers, and software authenticator.
- `scripts/fixtures.ts`: reference execution capture with synthetic accounts.
- `bin/measure/`: ABI/parity checks, costs, proving and verification measurements.
- `evidence/`: current results; subdirectories retain the two historical v2 runs.

`bin/measure/src/executor.rs` and `simulator.rs` adapt Minocrab `537721a` under
its [MIT licence](vendor/LICENSE-MIT). The executor normalises padded FAB atoms
so absent union arms decode correctly in the ledger VM. The simulator uses the
current backend's typed AST and public arithmetic helpers, adding current byte
instructions and P256 generator multiplication. Unsupported instructions fail
explicitly. Regression tests cross-check byte bounds/order and P256 multiplication
against the unmodified backend. Fixture checks and every measured proof also use
that backend, rather than relying on the simulator alone.

The ledger VM dependencies remain at Minocrab's pinned `04c9c5d`; comparison with
the current generated TypeScript checks the exercised VM effects and state.
This does not claim full compatibility with every current ledger feature.
The next end-to-end acceptance gate is funded native transaction construction
and localnet conformance, including receiving-contract composition. Only then
should full transaction sizes and validation times be populated.
