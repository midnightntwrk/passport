# Variable-length WebAuthn — negative experiment result

## Outcome and decision

**Negative result for size/byte savings and proving efficiency, compared with the
previous fixed-profile `wa-json134` verifier.** Recorded 6 October 2026 from the
1 October fixed-profile and 5 October variable-length measurements.

- **Proof: 6,364 → 6,364 bytes; 0 bytes saved.**
- **Verifier key: 2,745 → 2,745 bytes; 0 bytes saved.**
- **Prover key: 234,971,079 → 1,893,363,935 bytes; 8.1× larger.**
- **Circuit: 112,156 → 998,980 rows; 8.9× more.**
- Recorded proof requests increase from ~12 s on fixed-profile repeats to
  171–202 s on the two new samples. These are not controlled timing comparisons.
- No transaction-byte saving is established by the fee-unbalanced laboratory
  transactions. The fixed run has no comparable memory high-water measurement.

**Decision: retain this as a negative experiment, not an account replacement or
size optimization.** The input flexibility and correctness tests succeed; the
size/cost objective does not. Witness-side parsing still needs circuit-enforced
binding, and the hand-built variable-length SHA circuit is expensive.

Comparison sources: `contract/evidence/p256-webauthn/circuit-sizes.json`,
`contract/evidence/p256-webauthn/conformance-and-proving.json`,
`contract/P256-MEASUREMENTS.md`, and the receipts under
`contract/evidence/webauthn-variable-json/`. `assessment.json` indexes this decision.

## Question and construction

Can the caller supply a JSON byte buffer and a length, use a witness to parse it,
and still have the contract enforce that it is the signed WebAuthn client data?

**Functional result (not an efficiency success):** bounded variable-length verification works in the compiled Compact
runtime. The optimized build has a clean **14/14 full-suite PASS**, including all
five SHA groups and all nine WebAuthn groups. Full key generation succeeded.
Real proofs for **140-byte strict** and **256-byte limited** JSON passed ledger-v9
cryptographic verification and were applied in an in-memory ledger.

The experiment uses one fixed-size circuit for client-data lengths up to **256
bytes**, with an enrolled origin of **1–96 bytes**. A witness supplies origin and
prefix-length advice. The circuit checks this against an enrolled policy and the
signed byte buffer, computes variable-length SHA-256, then invokes the existing
native P-256 verifier. There is no separate verifying key for each input length.

The witness itself is untrusted. Its JSON parser is a convenience; proof security
comes from circuit constraints. In particular, the circuit hashes exactly the
claimed length, checks bounds, constructs SHA padding and selects the correct
compression state. Capacity-padding zero bytes are not hashed unless included
in the actual length.

## Build and cost evidence

Full Compact 0.35.0 / ZKIR-v3 compilation and key generation completed.
Strict TypeScript checking passes. The recorded measurements are in
`contract/evidence/webauthn-variable-json/circuit-sizes.json`.

| Probe | Rows | k | Prover-key bytes | Verifier-key bytes |
|---|---:|---:|---:|---:|
| Existing fixed `wa-json134` reference | 112,156 | 17 | 234,971,079 | 2,745 |
| Initial bounded raw SHA-256 | 972,563 | 20 | 921,888,348 | 1,353 |
| Initial bounded WebAuthn verifier | 1,118,544 | 21 | 3,774,377,857 | 2,745 |
| **Optimized bounded raw SHA-256** | **852,999** | **20** | **919,921,781** | **1,353** |
| **Optimized bounded WebAuthn verifier** | **998,980** | **20** | **1,893,363,935** | **2,745** |

The new verifier key fits the **15,000-verifier-byte single-wave budget** in
isolation. This is not an account deployment-wave plan. The proving side is
substantially larger: approximately 8.9 times the rows and 8.1 times the prover-key
bytes of the fixed reference. This comparison also includes the new policy-state
and variable-position checks; it is not a pure SHA-only cost delta.

The selected Compact optimization uses conditional bit operations and avoids
decomposing unused intermediate sums. It has **10.7% fewer rows and a 49.8% smaller
prover key** than the initial variable-length experiment only. These internal
reductions do **not** represent savings over the prior fixed-profile verifier.
It still evaluates all five maximum
compression blocks. [Optimization trials and bounds](OPTIMIZATION.md) explain
why the deferred reductions preserve SHA-256 and where native compiler support
could improve the result further. Initial artifacts and evidence are preserved
under the `baseline` paths documented there.

## Verification modes and interpretation

- **Strict mode:** checks the entire four-field serialization, allowing varying
  origin lengths. Additional fields, reordered fields and whitespace variations
  remain outside this restricted mode.
- **Limited mode:** implements the same-origin branch of WebAuthn's standard
  Limited Verification Algorithm. It checks type, challenge, origin,
  `crossOrigin:false`, and the following `}`/`,` boundary. It hashes the full
  remaining message, but does not prove the JSON syntax of that remainder.

https://www.w3.org/TR/webauthn-3/#clientdatajson-verification

An honest JSON witness rejects a malformed remainder; a forged witness can bypass
that host-side check. The limited verifier is specified to check only the prefix
and boundary. The adversarial test suite explicitly distinguishes this behavior
from strict full-envelope validation. A success in limited mode must not be
described as proof that `JSON.parse` accepted arbitrary input.

Both modes still require 37-byte authenticator data, UP+UV and no authenticator
extensions. The circuit enforces unescaped printable ASCII origin bytes matching
enrolled policy. The probe does not implement registration, URL canonicalization
or RP-domain eligibility checks, nor a general JSON string-escape implementation.

## Execution validation

**Current build:** `contract/evidence/webauthn-variable-json/offline.json` records
a complete optimized run passing **14/14 groups**, with source digests matching
the measured build. It checks every hash length 0–256 and all the WebAuthn cases
listed below. The following paragraphs describe the preserved initial history.

The first compiled-runtime run passed:

- Every SHA-256 length **0–256**, compared with independent Node/OpenSSL hashing.
- All-zero inputs and one-/two-block padding transitions through the capacity.
- Rejection of out-of-bounds lengths, dirty buffer tails, and forged SHA bit/carry hints.
- Strict WebAuthn assertions with client lengths **127, 134, 140, 182 and 209**
  (origin lengths **14, 21, 27, 69 and 96**), under the same compiled circuit.
- Replay of the existing captured Safari 134-byte assertion.

That run is preserved as `contract/evidence/webauthn-variable-json/baseline/initial-run.json`.
Its overall status is FAIL because the next test expected a policy error, while
the contract correctly rejected a longer forged origin earlier as truncated data.
The test was corrected to use a same-length wrong origin and match each intended
constraint. The circuit and SHA witness logic were unchanged. The corrected
WebAuthn suite passed **all nine groups**, recorded in
`contract/evidence/webauthn-variable-json/baseline/offline-webauthn.json`:

- Valid varying-origin assertions and the captured Safari assertion.
- Malicious origin/prefix advice; re-signed wrong challenge, origin, type,
  cross-origin flag, duplicate member and strict-envelope mutations.
- Claimed-length/signature binding; RP hash, flags and signature failures.
- Additional fields through lengths **183, 184, 191, 192, 247, 248, 255 and 256**.
- Signed suffix integrity and the intentionally unenforced arbitrary-suffix
  syntax boundary of limited verification.

Source-digest checks confirm identical Compact code and witness helper across
the two receipts. The initial FAIL receipt remains visible; it is not relabelled
as a full-suite PASS. A later full rerun hit its 120-second command timeout before
the first exhaustive group completed and produced no final receipt; the earlier
completed SHA groups supply that coverage. Execution timings vary substantially
between runs and are not a benchmark of proving or browser performance.

## Real proofs and resources

`contract/evidence/webauthn-variable-json/proofs.json` records two actual proofs,
both verified by ledger-v9 `wellFormed` with contract/native-proof and signature
verification enabled, then successfully applied in memory. The same compiled
`verify_webauthn` key was used for both lengths and modes.

| Signed JSON | Mode | Proof bytes | Lab transaction bytes | `/prove` round-trip | `wellFormed` |
|---|---|---:|---:|---:|---:|
| 140 bytes | Strict | 6,364 | 7,022 | 201.62 s | 3.19 ms |
| 256 bytes | Limited | 6,364 | 7,022 | 171.02 s | 7.47 ms |

These are **single samples**, not a length-performance comparison. The round-trip
includes streaming a roughly 1.91 GB request, key decoding and proving. The first
sample also fetched k=20 public parameters and overlapped local execution tests
and measurements. Fees were not balanced in the laboratory ledger; transaction
sizes therefore do not predict funded node-submission sizes. Both assertions
were signed with Node/OpenSSL software ES256.

`transcript-checks.json` additionally records a valid captured Safari assertion
accepted by the ZKIR evaluator and **five forged raw transcripts** rejected with
`Failed direct assertion`: SHA bit, SHA carry, origin, prefix length and input
length. These mutations bypass the generated JavaScript checks. They establish
circuit-evaluator rejection, not separate negative-proof-generation samples.

`proof-resources.json` records the dedicated server's cgroup high-water mark:
**24,503,861,248 bytes (24.50 GB / 22.82 GiB)**, including cache across its lifetime.
This is not a per-proof process-RSS measurement. Host: Apple M4 Max, 64 GiB RAM;
Docker: 8 CPUs, 25,159,827,456 bytes available. No container OOM kill occurred.
The server used one proof worker; its HTTP frontend has its own worker pool.

**Practical conclusion: negative.** Bounded variable-length verification is
feasible and the Compact version proves correctly, but it saves no proof or
verifier-key bytes and substantially increases prover-key size, circuit size and
observed proving time. The internal optimization does not make this a better
replacement for the fixed verifier. Preserve the experiment as evidence of that
tradeoff; any native-gadget work is a separate, unmeasured research direction.

## Boundaries and separate future research

- Native bounded variable-length hashing through the compiler, runtime and IR
  could be evaluated separately. No savings from that route were measured here.
- Node-accepted, funded transaction evidence is absent for this probe. The proof
  evidence above is local cryptographic verification.
- New browser interactions with other origin lengths/extra client fields are absent. The
  existing Safari vector is available for replay; new sizes use software ES256.
- Decide supported limits, strict versus standard-limited verification, and
  required JSON semantics before amending normative MIP text.
- Device and **grant** integration would require challenge/replay binding,
  RP/origin policy and versioned commitments; this negative-result experiment
  does not recommend that integration. The probe has no custody or grant authority and no replay protection; its
  `hash_bytes` endpoint is deliberately a separate raw-hash benchmark.
