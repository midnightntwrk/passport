# BIP-340 signature verification experiment

[`bip340.compact`](contracts/bip340.compact) is a prototype
signature verifier using Compact 0.35.0's native secp256k1 operations.
It verifies the **exact message bytes** according to
[BIP-340](https://github.com/bitcoin/bips/blob/130b8e0fa7f30fa45532f080b87b8db27a79e46e/bip-0340.mediawiki).
It adds no prehash, wallet envelope, enrolment, recovery, or ACC authorisation
arm. All code, dependencies, tests, and evidence are isolated in this experiment;
`contract/` is unchanged.

This supersedes the Compact 0.34 group-operation limitation recorded in the
earlier [wallet gate experiment](../bip340-wallet-gate/FINDINGS.md). The earlier
Rust relation and its measurements remain separate evidence.

## Decision: retain the experiment, defer Passport integration

**Accepted 2026/10/22.** Passport does not adopt BIP-340 authorisation at this
stage, including for scoped grants. We do not expect a proving-speed benefit
over the existing k256 (secp256k1 ECDSA) and P-256 paths large enough to justify
another signature scheme and its integration, review, deployment, and
maintenance costs.

We retain this experiment, its tests, and its evidence in
[PR #190](https://github.com/midnightntwrk/passport/pull/190) for future reference.
The proposed ACC integration in
[PR #191](https://github.com/midnightntwrk/passport/pull/191) is withdrawn;
its [implementation and measurements](https://github.com/midnightntwrk/passport/blob/2b0f594c346c69058e9b8293d3b77a85bf7510fe/contract/BIP340-GRANTS.md)
remain historical evidence, not supported Passport functionality.

The experiment establishes feasibility and records local costs. These results
are not a controlled, like-for-like latency comparison with k256 or P-256 and
do not establish a worthwhile speed advantage. The current reason for
deferral is insufficient additional value, rather than missing Compact curve
operations.

Revisit this decision if a concrete BIP-340 interoperability requirement
emerges or repeatable benchmarks of equivalent complete ACC operations show a
worthwhile improvement on the same toolchain and hardware. Any adoption still
requires the separate design, review, and validation described below.

## Experimental API

```compact
include "bip340";
import Bip340;

// publicKey: Bytes<32>, message: Bytes<32>, signature: Bytes<64>
assert(verifyBip340<32>(publicKey, message, signature), "invalid signature");
```

The message length is a compile-time parameter. The probe exercises 0, 1, 17,
32, and 100 bytes, covering every message length in the official test vectors.
`Bytes<32>` public keys and `Bytes<64>` signatures use BIP-340's big-endian
encoding. Inputs are not padded or truncated.

Callers must supply the `bip340LiftX` witness, which returns the full even-Y
secp256k1 point for the x-only public key, or the identity for an unliftable
key. A reference implementation is in the
[test witnesses](src/witnesses.ts); it throws for an
unliftable key instead of returning the identity.
This witness performs no trusted signature verification. The circuit checks
the point's canonical x bytes, even Y, and nonidentity status, and native curve
operations constrain curve membership.

The helper checks:

1. The public key is its canonical, non-identity even-Y lift.
2. Signature `s` is canonical and below the group order. A modular cast alone
   would be insufficient, so its byte encoding must round-trip.
3. The challenge is
   `int(SHA256(tagHash || tagHash || r || publicKey || message)) mod n`,
   where `tagHash = SHA256("BIP0340/challenge")`.
4. `R = sG - eP` is nonidentity, has even Y, and has canonical x bytes equal to
   signature `r`. This comparison also rejects `r >= p`.

Zero `r` or `s` are not blanket-rejected. Only the BIP-340 rules decide
acceptance. Byte reversal is explicit because Compact's foreign-field casts
use little-endian encodings.

**Always assert the returned Boolean.** Invalid inputs or witnesses may abort,
not merely return `false`. In particular, native point validation and the
compiled coordinate-access constraints can reject identity or malformed
points. This is a verification guard, not a total predicate for proving that
arbitrary signatures are invalid.

## Reproduce

From `experiments/bip340-verification/`, with Compact 0.35.0 and Node.js 22
or later installed:

```sh
npm ci
npm run compile:js
npm run check
npm run test
npm run test:harness
npm run test:native
```

The JavaScript run tests generated circuit execution. To generate keys, check
the actual proof constraints, produce proofs, and measure the circuit:

```sh
npm run compile
docker compose up -d
npm run prove
npm run measure
npm run --silent verify:native > evidence/native-verification.json
docker compose down
```

The native tests and verification need Rust (validated with 1.98.1). Dependencies
are pinned in `native/Cargo.lock`; verification uses embedded public parameters
and does not need the proving key or a wallet. The native verifier checks the
captures against the reviewed build pins described below. Do not regenerate
those pins automatically to make a differing build pass.

The server listens only on localhost port 6391. The proof harness uses public
test fixtures and an in-memory ledger. It needs no wallet, funds, node, or
indexer. Generated contract artefacts and proving keys are ignored by Git.

Compose pins the proof-server image by its immutable repository digest.
Before proving, the harness checks the running container's image identity and
loopback port through the local Docker daemon, and records these observations
separately from the requested image pin. It finds the Compose service by
default; set `PROOF_SERVER_CONTAINER` to use an existing matching container.
This is local provenance evidence, not remote attestation.

Both `/prove` and `/check` responses are capped at 1 MiB. The complete proof
request has a 25-minute deadline; constraint checks retain their two-minute
deadline. Limits also apply to chunked responses, and failures cancel the
response and upload where applicable.

The [BIP-340 regression workflow](../../.github/workflows/bip340-experiment.yml)
rebuilds with the pinned Compact 0.35.0 release, runs the circuit and harness
tests, generates fresh proofs, and requires native verification against the
committed build pins. Native tests cover source, fixture, artefact, metadata,
and public-statement substitution. CI uploads fresh evidence separately from
the historical reports committed here.

## Evidence and limits

The official vectors are pinned and vendored with provenance alongside the
tests. They include valid signatures, invalid curve points, noncanonical
encodings, odd-Y R, infinity R, changed messages, and variable-length messages.
Additional tests exercise malicious lift witnesses and malformed input sizes.

Recorded validation:

- 40 generated-JavaScript tests pass, including all 19 official vectors.
- The original ZKIR accepts all nine positive vectors and rejects all ten
  negative vectors. Negative assignments bypass the JavaScript verification
  result and recompute the probe's public commitment.
- Raw unrelated, odd-Y, and identity lift witnesses are rejected by ZKIR
  checks. An off-curve witness is rejected separately by native point decoding.
- Real proofs for 0-, 32-, and 100-byte messages are generated by the proof
  server and applied in an in-memory ledger.

The pinned ledger WASM build omits its native `proof-verifying` feature.
Its `wellFormed` verification flags therefore do not establish cryptographic
proof verification. The in-memory application results are structural checks;
cryptographic verification must use the native verifier described below.

See [proof evidence](evidence/proofs.json) and
[circuit measurements](evidence/circuit-sizes.json) for
source hashes, tool versions, individual results, and timings.

The [native verifier](native/src/main.rs) calls `VerifierKey::verify` directly.
It checks all three captured proofs and requires rejection when either the
accepted-hash public input or the transaction binding changes. Its
[evidence](evidence/native-verification.json) fingerprints
the exact proofs, keys, captures, and native sources. The harness deliberately
supports only this probe's unconditional public-transcript shape and rejects
other shapes; it is not a general Compact proof-verification tool.

The verifier embeds [trusted-build.json](native/trusted-build.json), which pins
the reviewed Compact sources, official fixture file, and each proof case's
verification key and JSON/binary ZKIR. Captures cannot select a different
manifest or artefact path. It independently computes
`SHA256(publicKey || message || signature)` from official vectors 0, 15, and
18, then checks the complete expected ledger transcript before verifying the
proof. It does not accept a capture's claimed output as the expected result.

These pins record the reviewed build identity. They do not prove compiler
correctness or establish trust independently of the reviewed repository and
verifier binary. The transaction binding and communications commitment still
come from the capture and are authenticated by the proof; the harness does
not independently validate a transaction, its witnesses, or node admission.

The 32-byte probe has **108,457 rows at k=17**, a **234,917,690-byte proving
key** (about 224 MiB), and a **2,745-byte verifier key**. The three measured
proofs are each **6,364 bytes**. The final local proof requests took
12.5–12.6 seconds on an Apple M4 Max host with a Docker proof server and four Rayon
threads. This includes streaming the approximately 224 MiB key to the local
server, so it is not an isolated cryptographic proving-time measurement.
These are single samples per message length, not a latency distribution or
browser benchmark.

The probe records `SHA256(publicKey || message || signature)` on success.
Its measurements include that public-output bookkeeping as well as signature
verification. It is a conformance and cost probe, not an account authorisation
endpoint. Applications remain responsible for constructing and binding the
message, selecting trusted keys, and applying their own replay policy.

## Adoption criteria

This experiment establishes feasibility, conformance against the test vectors,
and local proof cost. It is not part of the ACC reference implementation.
It does not approve the wider custody implementation: complete device
revocation remains unresolved in [#192](https://github.com/midnightntwrk/passport/issues/192),
corrected recovery validation is tracked in [#73](https://github.com/midnightntwrk/passport/issues/73),
and deployment trust checks are tracked in [#193](https://github.com/midnightntwrk/passport/issues/193)
alongside artefact provenance in [#116](https://github.com/midnightntwrk/passport/issues/116).
Before proposing promotion into `contract/`, a separate change should:

- Revisit the deferral decision above with a concrete use case or evidence of
  a worthwhile comparative proving benefit.
- Obtain independent cryptographic review of the circuit, witness constraints,
  and negative tests.
- Decide whether the measured proving and key costs are acceptable for the
  intended signature-verification use.
- Define the supported verifier API, failure behaviour, and regression checks.

Any later ACC authorisation integration needs its own design, review, and
complete on-node validation, including successful custody operations. This
experiment defines no production account-key, message-binding, or replay
policy.
