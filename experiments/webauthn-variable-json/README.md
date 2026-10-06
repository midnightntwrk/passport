# Negative result: witness-assisted variable-length WebAuthn

**Outcome: no size or byte savings over the previous `wa-json134` verifier.**
The measured proof stays **6,364 bytes** and the verifier key stays **2,745 bytes**:
**zero bytes saved in either case**. Circuit rows rise from 112,156 to 998,980
(8.9×), and the prover key grows from 234,971,079 to 1,893,363,935 bytes (8.1×).
This is an experiment record, **not a recommended replacement or account upgrade**.

| Comparison with the previous fixed-profile verifier | Previous | Best measured experiment | Result |
|---|---:|---:|---|
| Proof bytes | 6,364 | 6,364 | **0 bytes saved** |
| Verifier-key bytes | 2,745 | 2,745 | **0 bytes saved** |
| Prover-key bytes | 234,971,079 | 1,893,363,935 | **8.1× larger** |
| Circuit rows | 112,156 | 998,980 | **8.9× more** |
| Recorded proof request time | ~12 s (repeats) | 171–202 s (single samples) | Much higher observed cost; not a controlled timing comparison |

No transaction-byte saving is established: the new 7,022-byte laboratory
transactions omit fee balancing and are not comparable to funded node submissions.
The new server memory high-water mark is 24.50 GB including cache; the old run has
no equivalent peak measurement. Exact receipts and the decision are indexed in
`contract/evidence/webauthn-variable-json/assessment.json`.

[Visual explainer: data flow, byte boundaries, JSON modes, state and costs](explainer.html)
(self-contained HTML with interactive illustrations).

Correctness evidence still matters: the isolated probe passes **14/14 execution groups**
and real 140-/256-byte proofs pass ledger verification in memory.
[Findings, costs and evidence boundaries](FINDINGS.md).
[Internal optimization details](OPTIMIZATION.md): the 3.77 → 1.89 GB reduction is
relative to the first, even more expensive variable-length prototype. It is
**not a saving against the previous fixed-profile implementation**.
Base: Passport main `45721e1d322357ef99a2786a3ba27d64382527d8`, Compact 0.35.0,
runtime 0.20.0, ZKIR v3.

The functional question is whether a witness can help validate variable-length signed
`clientDataJSON` without trusting an off-chain JSON parser. The witness parses
the JSON and supplies origin/length advice; the circuit checks that advice
against the raw bytes and an enrolled key/RP/origin policy commitment.
That bounded flexibility works, but moving parsing into a witness does not remove
the circuit checks or produce smaller proofs. The hand-built variable-length SHA
constraints dominate the added cost. Functional PASS does not reverse the negative
size/cost conclusion.

The generated probe implements SHA-256 of **exactly the supplied length**, up
to 256 bytes, using five statically allocated compression blocks. SHA padding,
length selection and every witness-assisted word decomposition are constrained.
Unused input capacity must be zero, but it is not part of the signed message.
The final hash is used in the existing native P-256 verification relation.
The `WebAuthn<21>` import reuses only its challenge-base64 and ES256 helpers;
the old fixed-origin policy and fixed-template JSON hash are not called.

Two explicitly selected verification modes share one entry point:

- **Strict:** the current four-field envelope, with origin length 1–96 rather
  than exactly 21. Full byte shape is constrained.
- **Limited:** the same-origin branch of WebAuthn's Limited Verification
  Algorithm (§5.8.1.2), accepting `}` or `,` after the required fields and hashing
  the complete remainder. This is not a proof of arbitrary JSON syntax. The
  witness's additional `JSON.parse` check is not a cryptographic guarantee.

https://www.w3.org/TR/webauthn-3/#clientdatajson-verification

That algorithm is standardized; `wa-json134` is our previous implementation's
label. The new probe is still bounded and same-origin only, not a claim of full
WebAuthn or unrestricted-length JSON conformance.

## Why the witness cannot decide validity

`inspect_json(data, length)` runs TypeScript outside the proof. A hostile prover
can replace it, including any `JSON.parse` call or `valid: true` result. Its
outputs here are just an origin buffer, origin length and prefix length. The
circuit checks them against the constructor's policy commitment, required JSON
bytes, constructor-pinned expected challenge, boundaries and complete signed hash.

The SHA witness `split_word(value)` supplies 32 Boolean bits and a four-bit
carry. The circuit proves `value = word(bits) + carry * 2^32`. This implements
modular addition without trusting a witness-supplied digest. The bounded values
are far below the native field modulus, so field wraparound cannot satisfy a
false decomposition. Five compression blocks are evaluated, with the correct
state selected from the constrained byte length. The optimized Compact version
defers reductions of intermediate sums, saving 640 decompositions per call.
It does not yet use the upstream native variable-length hash gadget.

Strict mode proves the entire supported four-field JSON serialization. Limited
mode checks the standard's required prefix and `}`/`,` boundary; unknown trailing
data is signed and hashed but not syntax-checked by the circuit. An explicit test
uses a lying JSON witness and a software-signed malformed suffix to demonstrate
this boundary. Do not count the honest witness's parser as an enforced check.

Authenticator data remains 37 bytes, UP+UV required, no authenticator extensions.
The probe does not add recovery, device/grant integration or replay protection.
Origin policy is fixed by the probe constructor; it is not chosen by the witness.
Registration, URL canonicalization and RP-domain eligibility are outside this
probe; its policy commitment binds the provided key, RP hash and exact origin.

```sh
node experiments/webauthn-variable-json/generate.mjs
cd contract
npm ci
compact compile +0.35.0 --feature-zkir-v3 contracts/probe-webauthn-variable.compact contracts/managed/probe-webauthn-variable
npm run check:webauthn-variable
npm run test:webauthn-variable
npm run measure:webauthn-variable
```

The output directory is dedicated to this experiment. Existing account and
`wa-json134` artifacts and evidence remain the comparison baseline.
Experiment TypeScript uses its own configuration; the standard contract build
does not require this probe's generated bindings or keys.

`npm run compile:webauthn-variable` regenerates and compiles just this probe.
Tests compare every hash input length 0–256 against Node/OpenSSL, stress SHA
padding boundaries, substitute malicious witnesses, and re-sign invalid client
data so structural checks are tested independently of signature integrity.
The existing captured Safari assertion is replayed; other lengths are generated
by a software ES256 signer, not new browser interoperability observations.

Evidence is written under `contract/evidence/webauthn-variable-json/`:

- `offline.json`: a full execution's results and source digests.
- `offline-sha256.json` / `offline-webauthn.json`: targeted suite receipts when
  running `npm run test:webauthn-variable -- sha256` or `-- webauthn`.
- `baseline/initial-run.json`: preserved first run. All five SHA groups and two WebAuthn
  groups passed, then the harness expected a policy error where a longer forged
  origin was rejected earlier as truncated data. The test now uses a same-length
  wrong origin and checks each expected error precisely. The circuit was unchanged.
- `circuit-sizes.json`: actual generated key/IR sizes and mock-compiled row count.
- `verify.preimage` (ignored): a sample for a separate proof-server run.
- `baseline/`: immutable copies of the initial receipts and source snapshots.
- `optimization-trials.json`: measured alternatives, including rejected rewrites.
- `proofs.json`: real-proof test result, with the exact verification evidence layer.
- `proof-resources.json`: dedicated proof-server resource high-water mark.
- `transcript-checks.json`: five forged raw transcripts rejected by actual ZKIR
  assertions, bypassing generated JavaScript checks.
- `assessment.json`: negative experiment outcome against the previous fixed-profile
  verifier, with exact byte comparisons and receipt references.

## Real-proof reproduction

From the repository root, with Docker running and the probe compiled:

```sh
docker compose -f experiments/webauthn-variable-json/docker-compose.yml up -d
cd contract
npm run prove:webauthn-variable
npm run check:webauthn-transcripts
npm run resources:webauthn-variable
```

The harness generates software ES256 assertions at 140 bytes (strict) and 256
bytes (limited), checks the compiled ZKIR, generates real proofs, then invokes
ledger-v9 `wellFormed` with contract-proof verification enabled and applies each
transaction in memory. Fee balancing is disabled for the isolated ledger. This
is a distinct layer from node acceptance or live-browser approval.

The dedicated local server is configured for one worker. Prover-key uploads are
streamed to avoid multi-gigabyte JS/WASM copies. Sample unproven/proven transaction
files are ignored; receipts contain sizes, hashes and timings. The proof server
downloads public parameters when necessary. Use a long command timeout for both
the proof run and the exhaustive execution sweep.

Capture resources **before** stopping the dedicated container:

```sh
docker compose -f experiments/webauthn-variable-json/docker-compose.yml down
```

Run that final command from the repository root. The cgroup high-water mark is
for the server's lifetime, including cache and all its checks/proofs; it is not a
per-proof process-RSS measurement. The first test harness mismatch is retained
in the baseline receipts as historical evidence, not a current result.

Measured proof round trips were **201.62 s and 171.02 s**, producing **6,364-byte
proofs**. The container's lifetime memory peak was **24.50 GB including cache**.
These single samples demonstrate feasibility and identify the remaining proving
cost; they are not a controlled latency benchmark or node-acceptance claim.
**Recorded conclusion: no size/byte win; substantially worse proving cost.**
