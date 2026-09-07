# MN wallet key as account authoriser (BIP-340 gate)

Feasibility experiment: can a regular Midnight wallet sign an
account-contract authorisation challenge with the key it already holds,
and can that signature be verified at the account seam? Verdict and
detail in `FINDINGS.md`; probe plan and status in
`EXPERIMENT_GUIDELINE.md`.

The wallet's `signData` (ledger WASM, wallet SDK keystore, and the dApp
connector) signs BIP-340 Schnorr over secp256k1, with the message being
the SHA-256 of the signed bytes; the dApp-connector path prepends the
mandatory `midnight_signed_message:<data_size>:` prefix. The relation in
`crates/bip340-gate-circuit` verifies exactly that against the 32-byte
x-only key and the 32-byte challenge as public inputs.

## Layout

- `p1-vector.mjs`: Node harness producing the wallet-signed vectors in
  `evidence/` (runs against the pinned client set of
  `../account-custody-prototype/node_modules`; the secret key is a fixed
  fixture).
- `crates/bip340-gate-circuit`: the BIP-340 relation over midnight-zk
  (same upstream pin as `../p256-in-circuit`).
- `bin/bip340-gate-measure`: evidence harness: `vector` (independent
  RustCrypto verification), `mock` (cost model), `prove` (SRS-backed
  proving of the wallet vectors, timed, with a negative control).
- `compact-probes/`: the Compact 0.34.0 native-surface probes (P4);
  compile with `compact compile +0.34.0 --feature-zkir-v3 --skip-zk`.
- `evidence/`: committed JSON evidence.

## Run

```bash
node p1-vector.mjs                       # regenerate the wallet vectors
cargo run --release -p bip340-gate-measure -- vector
cargo run --release -p bip340-gate-measure -- mock
cargo run --release -p bip340-gate-measure -- prove --path sdk
cargo run --release -p bip340-gate-measure -- prove --path connector
```

The SRS loader defaults to `./assets` and falls back to
`../p256-in-circuit/assets`, so the two experiments share one downloaded
Filecoin SRS cache. Do not run `cargo update`: the committed `Cargo.lock`
pins `midnight-proofs` (patched via `branch = "main"`) to the same
revision as the rev-pinned crates, and the harness build fails on any
disagreement.
