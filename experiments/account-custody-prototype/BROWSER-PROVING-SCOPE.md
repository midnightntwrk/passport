# Browser proving: removing the proof server from the demo

**Token-demo note (2026/06/22):** the end-to-end demo now defaults to the
local Docker proof server for reliability. Browser proving remains available
behind `?prover=browser`, but it should be revalidated before using it in a
client call.

Scope drafted 2026/06/10. Companion to `DECISIONS.md`; relates to component C6
(proof generation, alternative B) and promise P8 (the user is the prover).

**Phase 0 outcome (2026/06/10): validated, faster than scoped.** Upstream
ships the prover as a wasm npm package (`@midnight-ntwrk/zkir-v2`, version
paired with `ledger-v8`; see `wasm-proving-demos/` in the midnight-ledger
repository), so no Rust port was needed. With `?prover=browser` the demo
deploys the account contract and lands `deposit_night` on localnet with
proofs computed in the tab (`app/src/lib/wasmProver.ts`; SRS slices staged by
`app/scripts/fetch-zk-params.mjs`).

**Phases 2 and 3 outcome (2026/06/10): validated the same day; the planned
Service Worker interception was unnecessary.** `WalletFacade.init` accepts a
custom `provingService`, and the wallet SDK itself ships a wasm proving
path (`makeWasmProvingService` in `wallet-sdk-capabilities/proving`, built
on the same zkir-v2 package). The demo injects a three-line ProvingService
backed by the in-tab prover, with the zswap and dust key triples staged
under `/zk-params` in the proof server's cache layout. The end-to-end check
(dev-mode onboard plus proved Night deposit) passes **with the proof-server
container stopped**: every proof in the stack (contract circuits, zswap
balancing, dust fees, and signing) is computed in the browser.

**Worker hardening (2026/06/10): done.** Proving runs in a dedicated worker
(`app/src/lib/proofWorker.ts`) so the UI stays live; key material resolves
on the main thread and is proxied per request, the same split the SDK's
`WasmProver` uses. Two pitfalls worth recording: copy preimage and proof
bytes into fresh `Uint8Array`s before `postMessage` (wasm-bindgen can hand
back views over wasm memory, and structured clone copies the entire backing
buffer), and import the zkir wasm dynamically inside the worker so a failed
or slow load is observable instead of a silent dead worker. Validated with
the proof-server container stopped.

Remaining hardening, not blocking the demo: per-circuit progress and timing
capture, multithreaded proving (upstream's `zkir-mt` demo), and contributing
real-circuit rows to the benchmark corpus.

## Goal

Replace the localnet proof server in the account-custody demo with a prover
that runs entirely in the browser, so every proof (contract circuits and
transaction balancing) is generated on the user's device. End state: the
`infra/` compose file runs node and indexer only, and the demo's proving dock
truthfully says the proof was made in this browser.

Non-goals: production hardening, mobile targets, multi-threaded proving
(stretch only), and forks of the wallet SDK or midnight-js (we prefer
adapters and request interception over forks).

## Evidence

We now know everything required to call this plumbing rather than research:

1. **The seam is two methods.** midnight-js proves a transaction with
   `unprovenTx.prove(provingProvider, CostModel.initialCostModel())`, where
   `ProvingProvider` is `{ check(preimage, keyLocation), prove(preimage,
   keyLocation, bindingInput?) }`. The shipped `httpClientProofProvider` is a
   thin adapter over an HTTP POST; a drop-in replacement needs nothing else.
2. **Key material already flows client-side.** For contract circuits the
   browser fetches prover key, verifier key, and zkir from `/zk` and embeds
   them in the proving payload (`createProvingPayload`). The server is
   stateless per request for contract circuits.
3. **System-circuit material is public and small.** The proof-server image
   (8.0.3, 98 MB) bakes in no key material. At startup it downloads and
   verifies SRS slices (`bls_midnight_2p9..2p16`, 24 MB total) plus the
   zswap prover keys (18.7 MB) and dust spend key (2.1 MB) from a public
   S3 bucket. A browser prover can stage exactly the same verified files.
4. **The proving engine already runs on wasm32.** The
   arc-midnight-proof-benchmarks corpus proves with midnight-curves 0.2,
   midnight-proofs 0.7, midnight-circuits 6, and midnight-zk-stdlib 1
   (crates.io) single-threaded in Chromium, Firefox, and Safari: roughly
   3.5 s at k=12, 12 s at k=14, and 44 s at k=16 on an M-series laptop.
5. **Our circuits are small.** Account-contract prover keys are 0.15 to
   0.55 MB for the Night, grant, device, and recovery circuits and 19.5 MB
   for the shielded ones; the faucet mint key is 5 MB; the zswap spend key
   is 10.5 MB. Nothing approaches the corpus ceiling.
6. **Latency stays in the same order of magnitude.** Measured end-to-end
   calls on localnet take 25 to 40 s with native proving; proving is a minor
   fraction of that. Browser proving adds seconds for the Night and grant
   circuits and tens of seconds for the shielded path.

## Architecture target

```
React app ── ActionButton ──► midnight-js ──► proofProvider (ours)
                                                  │ ProvingProvider calls
                                                  ▼
                                        Web Worker: wasm prover
                                        (payload parse → zkir exec →
                                         synthesize → PLONK/KZG prove)
                                                  ▲
Wallet SDK ── provingServerUrl ──► Service Worker fetch intercept
                                   (same-origin /local-prove/*)

Param staging: SRS slices + zswap/dust keys fetched once from the public
bucket (or a dev-server mirror, as /zk does today) and cached per origin.
```

## Phases

**Phase 0 (gate): wasm32 build of the payload prove path.** Build a minimal
crate against the midnight-ledger 8.0.3 workspace (the version must match
`@midnight-ntwrk/ledger-v8` in the app, not the bench pins) exposing
`prove(payload) -> proof`. Validate byte-compatibility: a payload produced by
`createProvingPayload` in the browser yields a proof the localnet node
accepts, identical in effect to the native server's output. Kill criteria:
ledger dependencies that cannot target wasm32 within the budget, or output
mismatch on identical payloads. Budget: 3 to 5 days.

**Phase 1: contract circuits proved in the browser.** Worker plus JS adapter
implementing `ProvingProvider`; our `proofProvider` swaps the HTTP client for
the worker. The proving dock gains true progress (the prover is ours, so
build, prove, and submit phases become real events, per circuit). The wallet
keeps using the proof server for balancing; the demo labels which proofs were
browser-made. Budget: 3 to 5 days.

**Phase 2: balancing proofs in the browser.** Point the wallet's
`provingServerUrl` at our own origin and intercept with a Service Worker that
routes to the same wasm prover; stage the zswap and dust keys plus SRS
(45 MB, cached once). Validate dust and zswap proofs against localnet. If the
interception fights the SDK, the fallback is to request an upstream
`ProvingProvider` injection point and keep the proof server for balancing in
the interim. Budget: 3 to 5 days.

**Phase 3: retire the service.** Remove the proof-server container from
`infra/` compose, keep `scripts/smoke.mjs` and `scripts/e2e-devmode.mjs`
green against the serverless stack, and record before-and-after timings (a
real-circuit family for the benchmark corpus falls out of this for free).
Budget: 1 to 2 days.

## Asset budget (cached once per origin)

| Asset | Size |
| --- | --- |
| SRS slices k=9..16 | 24 MB |
| zswap prover keys (spend, output, sign) | 18.7 MB |
| Dust spend prover key | 2.1 MB |
| Account circuits, Night/grant/device/recovery path | 0.6 MB |
| Account circuits, shielded path | 58.5 MB |
| Faucet mint | 5 MB |
| **Worst case total** | **≈ 109 MB** |
| **Night-only demo path** | **≈ 50 MB** |

## Risks

- **Version skew.** The payload format belongs to ledger 8.0.3; the wasm
  prover must build from that workspace's dependency set. Pin and assert.
- **Memory.** The corpus completes k=16 in all three engines within the
  wasm32 ceiling; our largest circuits sit well below. Low risk.
- **Engine variance.** The corpus recorded sporadic errors on one Safari
  machine; the demo targets Chromium first, others best-effort.
- **Bucket CORS.** If the public bucket rejects browser fetches, mirror the
  files through the dev server exactly as `/zk` mirrors contract keys.
- **Phase 0 overrun.** Bounded by the kill criteria. The fallback position
  (Phase 1 only) still demonstrates the user-is-the-prover posture for every
  custody circuit, with the server retained solely for balancing.

## What this buys

- C6 alternative B moves from open question to working evidence: an
  end-to-end browser-proved wallet flow on localnet.
- P8 (no hosted prover sees user data) is demonstrated rather than asserted.
- A reusable wasm prover artefact, and real-circuit rows for the proof
  benchmark corpus.
