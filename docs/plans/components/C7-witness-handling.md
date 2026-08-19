# C7 · Witness handling

**Serves:** P6.

## Outcome

The pipeline by which key material flows from secure storage (C16) into
proof generation (C6) without leaking outside the trusted boundary. The
interaction point between P6 (key non-exfiltration) and the cryptographic
stack.

**Status 2026/07:** the account-authorisation MIP materially shrinks
this boundary for account operations. The witness the prover consumes
is a one-call Schnorr *signature*, never the device key: proof
generation cannot exfiltrate a credential it never receives (the MIP's
non-exfiltration invariant, with a conformance audit enumerating every
gated call's proving inputs). Witness discipline here now centres on
the remaining secrets that do enter proofs — shielded coin
descriptions on the spend path, and any preimage-style credentials in
legacy or prototype flows.

## Dependencies

- **C5** — signs over witness commitments.
- **C6** — consumes witnesses.
- **C16** — source of key material.
- **C8** — domain-separated witness construction.

## Open questions

**Local IPC vs in-process (settled by consequence).** C6's decision —
browser in-process WASM proving in a dedicated Web Worker as the
promoted path, the local proof server retired to a self-host and
development harness — answers this for the browser: witnesses stay
in-process and never cross an IPC boundary. Alternative C below is the
de facto shape; the remaining per-platform question is native apps.

**Zeroisation discipline.** Design doc says "immediately after
derivation". Does the runtime guarantee this, or is it client-side
discipline?

**`mlock` enforcement.** Design doc references `mlock` to prevent
page-out to swap. Does v1.0 enforce on every supported platform, or
best-effort?

## Failure modes

**Witness crosses network.** A code path inadvertently transmits a
witness over a network boundary. *Detection:* network capture or code
review.

**Memory page-out.** OS pages witness-containing memory to disk.
*Detection:* swap analysis on shipped builds.

**Zeroisation skipped on error.** Exception path skips zeroisation; key
material lingers. *Detection:* fuzz-test triggered errors leaving
identifiable patterns in memory.

## Alternatives

**A — Local IPC to proof server** (design doc default).

**B — In-process proof generation** (no IPC; tighter coupling).

**C — Per-platform** (browser uses in-process WASM; native uses IPC).
**Chosen by consequence of C6's browser-proving decision.**
