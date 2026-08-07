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
- `crates/p256-gate-circuit` also carries the recursion leg (see the
  dedicated section below): two further inner relations
  (`Ed25519Verify`, ported from midnight-zk's `cardano_signature.rs`
  example, and `JubjubSchnorrVerify`, ported from its `schnorr_sig.rs`
  example), the witness-preimage relations `PoseidonPreimage` and
  `Sha256Preimage` (knowledge of a 32-byte hash preimage, the cheapest
  realistic device statement), the proof-of-proof wrapper `ProofWrap<R>`,
  and the complete-verification helper `verify_wrapped`.
- `bin/p256-gate-measure`: evidence harness (`vectors`, `mock`, `prove`,
  `passkey`, `recursion` subcommands) writing JSON to `evidence/`.
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

The recursion-leg tests (`tests/mock.rs` additions and `tests/wrapper.rs`)
additionally check: valid Ed25519 and JubJub Schnorr vectors are accepted
and tampered ones rejected; the witness-preimage relations accept their
valid vector and reject a flipped secret byte and a wrong commitment (in
the constraint system, not as a synthesis abort); the wrapper accepts a
valid inner proof and rejects tampered proof bytes and a mismatching inner
instance; and, end-to-end, that an invalid inner proof can still yield a
natively valid outer proof which only the deferred pairing check rejects
(the reason `verify_wrapped` exists). A further test pins the rotation
diagnosis: the Ed25519 inner circuit is unwrappable at the pinned rev (see
the recursion results section), while both witness-preimage circuits pass
the rotation guard. Unlike the P-256 mock tests, `tests/wrapper.rs`
needs the SRS below, because producing an inner proof requires real
proving; the default suite wraps the two cheapest inner relations only
(JubJub Schnorr and the Poseidon preimage) to keep the suite fast, with a
re-runnable SHA-256 preimage wrap behind `#[ignore]`.

## SRS (needed for `prove`, `passkey`, `recursion`, and `tests/wrapper.rs`)

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

cargo run --release -p p256-gate-measure -- recursion --scheme p256-prehashed --runs 3
cargo run --release -p p256-gate-measure -- recursion --scheme ed25519 --runs 3
cargo run --release -p p256-gate-measure -- recursion --scheme jubjub-schnorr --runs 3
cargo run --release -p p256-gate-measure -- recursion --scheme witness-poseidon --runs 3
cargo run --release -p p256-gate-measure -- recursion --scheme witness-sha256 --runs 3
```

The `passkey` subcommand consumes a real WebAuthn assertion exported as JSON
(format `p256-gate-webauthn-v1`: credential id, public key coordinates, DER
signature, raw authenticator data, clientDataJSON, and the 32-byte
challenge), sanity-verifies it with RustCrypto (recording whether the
authenticator emitted a high-S signature, the malleability datapoint),
checks the challenge, ceremony type (`webauthn.get`), and rpIdHash bindings
(`--rp-id` defaults to `localhost`, matching the capture harness), and then
proves it in-circuit.

## Recursion: verifying a proof inside the circuit

The measurements above verify the signature directly in the on-chain
circuit. The recursion leg measures the alternative shape, out-of-chain
proving: the user's device proves knowledge of a signature off-chain, in an
INNER proof, using whatever scheme its hardware supports (P-256 ECDSA from
a passkey, Ed25519, or Schnorr over JubJub, the MIP-0013 device scheme);
the on-chain circuit then verifies that proof in-circuit. The witness (the
signature) never leaves the device; the chain sees only a proof of a proof.
The question this leg answers is how much more expensive in-circuit proof
verification is compared with verifying the signature directly in the
outer circuit.

The inner statement does not have to be a signature at all. The cheapest
realistic device statement is a witness preimage: the account stores a
hash commitment, the device proves knowledge of the 32-byte secret behind
it, and the outer proof has the same size and verification cost for every
wrappable scheme. The `witness-poseidon` and `witness-sha256` schemes
measure this case with the two commitment hashes that matter (Poseidon,
the proof system's native hash, and SHA-256, the persistentHash commitment
shape Midnight contracts already use for preimage authorisation). The
commitment is deterministic and unsalted, so it is binding but hiding only
for an unguessable secret: the secret MUST be uniformly random 32 bytes
(as a device-held secret is); a public commitment to a lower-entropy
preimage could be brute-forced offline, and would need a salted variant,
`H(w, salt)`, instead.

The wrapper (`ProofWrap<R>` in `crates/p256-gate-circuit/src/wrapper.rs`)
follows midnight-zk's `aggregation/examples/single_circuit_aggregation.rs`,
simplified to a single-shot wrap with no IVC folding. Its public instance
is the inner verifying key's `transcript_repr`, the inner public inputs
(re-exposed), and a KZG accumulator; its witness is the inner instance and
the inner proof bytes. Because the inner verifying key's `transcript_repr`
is a public input of the outer proof (and the outer circuit itself varies
with the inner circuit's shape: k = 17 for the JubJub Schnorr and Poseidon
preimage wraps, k = 18 for the P-256 and SHA-256 preimage wraps), an
observer of a wrapped proof can tell which inner circuit was used. Hiding
the scheme would require witnessing the verifying key and proving its
membership of an approved set, which this experiment does not implement.

**Deferred pairing check.** The in-circuit verifier re-runs the PLONK
verification transcript of the inner proof but does NOT perform the final
KZG pairing check; it instead outputs an accumulator, a pair of points
that satisfies the pairing invariant exactly when the inner proof is
valid, and the outer circuit exposes it as public inputs. A verifier of a
wrapped proof must therefore (a) verify the outer proof natively, and
(b) run the accumulator's pairing check against the SRS and the inner
verifying key's fixed bases. Skipping (b) is unsound: an invalid inner
proof still yields a natively valid outer proof (the test suite
demonstrates this end-to-end). This is why the library exposes exactly one
complete-verification entry point, `verify_wrapped`, which performs the
native verify, the inner-verifying-key binding, and the pairing check as
one indivisible operation returning a single `Result`.

**Poseidon transcript.** The in-circuit verifier hashes the Fiat-Shamir
transcript with a Poseidon sponge, so inner proofs must be generated with
the Poseidon transcript (`prove_inner`), not blake2b. The `prove`
subcommand keeps blake2b for the direct measurements above; the
`recursion` subcommand re-measures the direct baseline under Poseidon so
the direct-vs-wrapped comparison is fair. The outer proof itself is
verified natively and stays on blake2b.

### Recursion results

Measured 2026/08/07, three prove runs per leg (medians shown), same
environment as the direct results below. Raw numbers, including setup
times and the timed inner proof of the wrapped leg, are in
`evidence/recursion-<scheme>.json`
(`cargo run --release -p p256-gate-measure -- recursion --scheme <s> --runs 3`).

| Scheme | Direct k | Direct prove | Inner prove (device) | Wrapped outer k | Wrapped outer prove | Outer proof | Complete verify | Premium |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p256-prehashed` | 15 | 0.499 s | 0.495 s | 18 | 4.915 s | 5,056 B | 3 ms | 9.9× |
| `ed25519` | 16 | 0.853 s | n/a | unwrappable | unwrappable | n/a | n/a | n/a |
| `jubjub-schnorr` | 11 | 0.076 s | 0.079 s | 17 | 2.748 s | 5,056 B | 3 ms | 36.2× |
| `witness-poseidon` | 9 | 0.018 s | 0.018 s | 17 | 2.809 s | 5,056 B | 3 ms | 156.1× |
| `witness-sha256` | 13 | 0.087 s | 0.089 s | 18 | 5.010 s | 5,056 B | 3 ms | 57.6× |

"Direct" is the inner relation proved under the Poseidon transcript;
"inner prove (device)" is the off-chain, on-device proving cost: the time
the user's device pays to produce the very inner proof the wrapped leg
consumes (one Poseidon-transcript prove of the inner relation, so it
tracks the direct column); "wrapped outer" is the proof that verifies one
such inner proof in-circuit; "complete verify" is the native outer
verification plus the deferred accumulator pairing check
(`verify_wrapped`, both steps timed as one); "premium" is the
wrapped-to-direct proving-time ratio. The measured premium is roughly a
factor of ten for P-256 (0.499 s direct against 4.915 s wrapped) and a
factor of thirty-six for JubJub Schnorr (0.076 s direct against 2.748 s
wrapped), because the outer circuit's size is dominated by the in-circuit
verifier itself rather than by the inner relation. The witness-preimage
rows sharpen the point: the Poseidon preimage proves directly in 18 ms
(and on the device side an inner proof costs the same 18 ms), yet its
wrap still costs 2.8 s. The wrapped cost varies with the inner circuit's
constraint-system structure (columns, lookups, and public inputs), not
with the inner statement's semantic complexity, which is why the SHA-256
preimage wrap lands at k = 18 like P-256 while the Poseidon preimage wrap
stays at k = 17 like JubJub Schnorr.

**Ed25519 cannot be wrapped at the pinned rev.** The in-circuit verifier
evaluates the inner circuit's openings only at the rotations -1, 0, and 1
(`circuits/src/verifier/verifier_gadget.rs` panics with "We do not support
other rotations" for anything else), and the SHA-512 chip queries
rotations 2 and 3. RFC 8032 fixes the Ed25519 challenge hash to SHA-512,
so an Ed25519 inner circuit is structurally unwrappable until the verifier
gadget supports wider rotations upstream. The harness detects the
condition (`unsupported_inner_rotations` in `wrapper.rs`), records it in
`evidence/recursion-ed25519.json` next to the direct measurements, and a
test pins the diagnosis so an upstream fix is noticed. SHA-256 is not
affected: its chip stays within the supported rotations, which is why the
P-256 relations wrap fine.

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
