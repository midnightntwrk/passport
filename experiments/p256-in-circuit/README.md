# P-256 ECDSA verification inside a midnight-zk circuit

Feasibility experiment: verify a NIST P-256 (secp256r1) ECDSA signature
inside a zk circuit using midnight-zk, the proof system behind Midnight
mainnet (halo2-style PLONK, KZG over BLS12-381).

## Why

Passkeys (WebAuthn), the Apple Secure Enclave, and the Android Keystore all
sign with P-256 ECDSA over SHA-256, and none of them will ever export a seed
or sign with another curve. If a Midnight custody contract wants to be
controlled by the keys users already carry in their platform authenticators,
the proof system has to verify P-256 signatures in-circuit. midnight-zk
already ships a P-256 foreign-arithmetic chip; this experiment exercises it
end-to-end (including the WebAuthn message construction with in-circuit
SHA-256) and measures the cost, as evidence for an upcoming MPS/MIP proposing
first-class P-256 support in Compact.

## What is here

- `crates/p256-gate-circuit`: three `Relation` implementations over the
  BLS12-381 scalar field, ported from midnight-zk's
  `zk_stdlib/examples/ethereum_signature.rs` (secp256k1 + Keccak) to P-256 +
  SHA-256:
  - `P256EcdsaPreHashed`: public key and message hash public, `(r, s)`
    witness.
  - `P256EcdsaWebAuthn`: hash computed in-circuit as
    `SHA-256(authenticator_data || client_data_hash)`, the exact byte string
    a WebAuthn authenticator signs when no extensions are present.
  - `P256EcdsaPrivatePk`: the public key is a witness (still constrained
    on-curve); only the message hash is public.
- `bin/p256-gate-measure`: evidence harness (`vectors`, `mock`, `prove`,
  `passkey` subcommands) writing JSON to `evidence/`.
- `webauthn/`: a local capture page (`python3 serve.py`, then
  `http://localhost:8973`) that creates a platform passkey and exports a
  real WebAuthn assertion as `vector.json` for the `passkey` subcommand.

Pinned upstream: midnight-zk at revision
`cd2c27b2659de157409a9b96dba0dbaf1218f00b` (git dependency plus
`[patch.crates-io]` so exactly one copy of each midnight crate is built).

## Build and test

```sh
cd experiments/p256-in-circuit

cargo build --release
cargo test -p p256-gate-circuit --release   # MockProver; no SRS needed
```

The test suite checks: the valid generated vector and a NIST CAVP FIPS 186-4
SigVer known-answer vector satisfy the circuit; flipped `r`, flipped `s`,
zero `r`, zero `s`, wrong public key, and wrong hash are all rejected; the
high-S malleated twin `(r, n - s)` of the (low-S normalised) valid signature
also satisfies the circuit (documented ECDSA malleability, feeding the low-S
policy discussion in the MIP); the WebAuthn-shaped and private-pk variants
accept their valid vectors and reject tampered authenticator data and a
wrong hash respectively.

## SRS (only needed for `prove` and `passkey`)

```sh
mkdir -p assets
curl -L -o assets/bls_filecoin_2p19 https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/bls_filecoin_2p19
```

`SRS_DIR` defaults to `./assets`; the harness downsizes the 2^19 file to the
circuit's k automatically (and caches the downsized copy next to it).

## Measure

```sh
cargo run --release -p p256-gate-measure -- vectors
cargo run --release -p p256-gate-measure -- mock
cargo run --release -p p256-gate-measure -- prove --relation prehashed --runs 3
cargo run --release -p p256-gate-measure -- prove --relation webauthn --runs 3
cargo run --release -p p256-gate-measure -- prove --relation privatepk --runs 3
cargo run --release -p p256-gate-measure -- passkey --input <export.json>
```

The `passkey` subcommand consumes a real WebAuthn assertion exported as JSON
(format `p256-gate-webauthn-v1`: credential id, public key coordinates, DER
signature, raw authenticator data, clientDataJSON, and the 32-byte
challenge), sanity-verifies it with RustCrypto (recording whether the
authenticator emitted a high-S signature, the malleability datapoint),
checks the challenge, ceremony type (`webauthn.get`), and rpIdHash bindings
(`--rp-id` defaults to `localhost`, matching the capture harness), and then
proves it in-circuit.

## Results

Measured 2026/08/06, three prove runs per relation at the optimal k
reported by the cost model (median shown).

| Relation | k | Rows | Setup vk | Setup pk | Prove (median) | Verify | Proof size |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `P256EcdsaPreHashed` | 15 | 28,953 | 402 ms | 229 ms | 0.479 s | 1 ms | 3,664 B |
| `P256EcdsaWebAuthn` | 15 | 32,686 | 416 ms | 256 ms | 0.542 s | 2 ms | 4,064 B |
| `P256EcdsaPrivatePk` | 15 | 28,951 | 400 ms | 231 ms | 0.493 s | 1 ms | 3,664 B |

For context, the upstream secp256k1 + Keccak example
(`zk_stdlib/examples/ethereum_signature.rs`) runs at k = 15 on this same
stack, so P-256 + SHA-256 verification lands at the same circuit size as
the curve midnight-zk already showcases.

Environment: Apple M4 Max, 64 GiB RAM, macOS (aarch64), rustc 1.90.0,
midnight-zk rev `cd2c27b2659de157409a9b96dba0dbaf1218f00b`. Raw numbers in
`evidence/cost.json` and `evidence/timings-*.json`.

### Real passkey run

`evidence/passkey-run.json` records an end-to-end run against a genuine
WebAuthn assertion from an Apple platform authenticator (flags `0x1d`:
user present, user verified, backup eligible, and backed up), captured with
the `webauthn/` harness and committed as `webauthn/vector.json`. The
assertion verified in-circuit through `P256EcdsaWebAuthn` at k = 15 in
544 ms (4,064 byte proof, 2 ms verification), with the challenge, ceremony
type, and rpIdHash bindings all checked. Notably, the authenticator emitted
a high-S signature; raw ECDSA accepts both forms, so any low-S-only policy
in a future standard would require client-side normalisation to remain
compatible with real platform authenticators. The credential is a
throwaway scoped to `localhost`.
