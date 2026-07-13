# C6 · Proof generation

**Serves:** P6 · P8.

## Outcome

Client-side ZK proof generation. The user is the prover, the node is the
verifier. No hosted prover holds user data.

**Status 2026/07 — decided, with the promoted path validated.**
Alternative B (browser WASM) is what Passport promotes, and it is no
longer a bet: the account-custody prototype runs the full stack in the
tab (`experiments/account-custody-prototype/`,
`BROWSER-PROVING-SCOPE.md`, validated 2026/06/10). Upstream ships the
prover as a WASM npm package (`@midnight-ntwrk/zkir-v2`, paired with
`ledger-v8`), so no port was needed; with the proof-server container
**stopped**, the end-to-end check passes with every proof in the stack
— contract circuits, zswap balancing, dust fees, and signing — computed
in the browser, in a dedicated Web Worker so the UI stays live. P8's
"the user is the prover" is demonstrated rather than asserted.

For users or integrators who cannot or do not want to prove locally,
the ecosystem carries a fallback: the Midnight Foundation has a
third-party provider offering proof generation as a service. Under the
account-authorisation MIP the trust cost of that path is bounded — the
delegate receives a one-call signature and the circuit's witnesses,
never a device key, so the worst it can do is execute or withhold the
approved call (MIP-3B R5/S6; the trust framing is MPS-0004's subject).
The hosted path sees spend witnesses (e.g. coin descriptions), so it is
bounded, not blind; the promoted path remains on-device.

Measured envelope (prototype evidence): ~3.5 s at k=12, ~12 s at k=14,
~44 s at k=16 single-threaded on an M-series laptop across Chromium,
Firefox, and Safari; account circuits sit well below the corpus
ceiling. Assets cached once per origin: ≈50 MB for the Night-only path,
≈109 MB worst case including the shielded circuits.

## Dependencies

- **C7** — witnesses pass through to proof generation; with MIP-3B the
  device credential never enters (the signature does).
- **C5** — the signature is a proving input, produced off-stack.
- **C16** — wallet storage holds private state used as witness.
- **External** — upstream `zkir-v2` WASM prover (version-paired with
  the ledger); public SRS and system-circuit key buckets; the Midnight
  Foundation's third-party proving provider for the hosted fallback.

## Open questions

**Mobile targets.** The browser validation scoped out mobile; iOS and
Android WebView / native proving envelopes (memory, throughput) still
need their own measurements.

**Proving UX at scale.** Per-circuit progress and timing capture, and
multithreaded proving (upstream's `zkir-mt`) remain as hardening;
whether the shielded path's tens of seconds needs pre-computation or
progress UI is a product call.

**Asset staging on constrained networks.** The ≈50–109 MB once-per-origin
key and SRS budget is fine on broadband; policy for metered or slow
connections (lazy staging, path-specific bundles) is open.

**Hosted-fallback substitutability.** P8 (I-8.2) requires at least two
independent providers or documented self-hosting for any ancillary
service. One Foundation-endorsed provider is a start, not the finish;
the self-host path (the standard proof server) should stay documented.

**Engine variance.** The corpus recorded sporadic errors on one Safari
machine; Chromium-first, others best-effort — acceptance criteria per
browser still to set.

## Failure modes

**Browser-side proof too slow.** User abandonment due to wait time.
*Detection:* time-to-first-proof telemetry. *Bound:* the measured
envelope above; the shielded path is the watch item.

**Silent hosted routing.** A code path routes proving to the hosted
provider without the user's knowledge (P8 violation in spirit even
with bounded trust). *Detection:* any default configuration sending
witnesses across a network boundary without explicit opt-in.

**Memory exhaustion.** Large circuits exceed mobile-device memory.
*Detection:* proof generation crashes on supported target devices.

**Version skew.** The WASM prover must build from the same ledger
workspace version the payload format belongs to; a mismatch produces
rejected proofs. *Detection:* pin-and-assert at build time (the
prototype pins `zkir-v2` to `ledger-v8`).

**Key-staging failure.** The public bucket rejects browser fetches
(CORS) or is unavailable; proving cannot start. *Detection:* staging
telemetry; *mitigation:* same-origin mirror, as the prototype's dev
server does.

## Alternatives

**A — Local Rust proof server.** Retired as the default; remains the
documented self-host path and the development harness.

**B — Browser WASM.** **Chosen and validated — the promoted path.**
Full-stack in-tab proving demonstrated on localnet with the proof
server removed (2026/06/10).

**C — Hybrid.** Subsumed: the Worker architecture already covers small
and large circuits; a native sidecar returns only if mobile
measurements demand it.

**D — Hosted third-party provider (Midnight Foundation ecosystem).**
Fallback, not promoted: bounded trust under MIP-3B (signature-not-key
witness), but the provider sees spend witnesses; subject to the
substitutability requirement (I-8.2) and MPS-0004's trust analysis.
