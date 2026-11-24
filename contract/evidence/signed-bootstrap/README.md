# Signed-bootstrap evidence — Passport #213

This directory keeps the evidence needed to assess the [temporary Jubjub bootstrap amendment](../../../docs/mps-mip/mips/mip-0013-temporary-jubjub-bootstrap-amendment.md). Test logs, command dumps, review snapshots, compiler ABI dumps, and duplicate journals are generated artefacts, not committed evidence.

| File | Purpose |
| --- | --- |
| [independent-vectors.json](independent-vectors.json) | Independent typed-hash and signature vectors, with compiler/runtime and source provenance. |
| [constraints.json](constraints.json) | Native backend results, enforcing stages, tested inputs, and explicit untested boundaries. |
| [native-runtime-preimage.json](native-runtime-preimage.json) | Original input fingerprint receipt matched by `constraints.json`'s `runtimeEvidenceSha256`. |
| [circuit-sizes.json](circuit-sizes.json) | All 53 keyed circuits, dimensions, key hashes, compiler/runtime versions, and 216 verified manifest entries. |
| [on-node-summary.json](on-node-summary.json) | Source/artefact provenance, nine proof samples, ten accepted transactions, and coverage limits from the successful local-node run. |
| [environment.json](environment.json) | Host resources, tool-binary hashes, and container-image identities for those measurements. |

The captures are historical: the implementation was `c24b1e9`, and the successful node run used `9e14998` with the non-native faucet fixture. Each file retains its exact source attribution. The node summary omits the duplicated compiler ABI and records the original receipt's hash and Git location; it is a derived summary, not a new run. The native receipt is preserved byte-for-byte. Later client/tooling fixes are covered by the reproducible tests below, not by relabelling old proofs.

## Coverage and limits

| Requirement | Reproducible check or retained evidence |
| --- | --- |
| B01 — address before passkey, exact installation | [Runtime tests](../../src/tests/signed-bootstrap-offline.ts), [client tests](../../src/tests/signed-bootstrap-client.ts), and node summary. |
| B02 — malformed temporary authority and scalars | Runtime negatives and native results, including canonical scalar aliases and native point boundaries. |
| B03 — target, policy, and intent binding | Runtime substitutions and imported-approval checks in the client tests. |
| B04 — WebAuthn proof of possession | Runtime tests cover supported JSON shapes, flags, lengths, signatures, and GREASE selection. |
| B05 — domain/replay separation | Runtime/client checks of account, network, checkpoint, and operation domains. Identical-context cloned networks remain outside the guarantee. |
| B06 — mode/version separation | Runtime constructor and activation checks; legacy vectors remain version-specific. |
| B07 — one-time activation | Runtime state checks and [resume regressions](../../src/tests/signed-bootstrap-resume.ts), including competing or ambiguously confirmed submissions. |
| B08 — intervening deposits | Runtime state preservation and the accepted node flow. |
| B09 — recovery ordering | Runtime recovery matrix; node flow covers pending recovery and veto, not every finalisation ordering. |
| B10 — private keys absent from proof inputs | Runtime preimage assertions and modified-request rejection. This does not claim a physical authenticator or unrestricted malicious-witness audit. |
| B11 — interrupted onboarding | [Registration](../../src/tests/signed-bootstrap-registration.ts), resume, and [deployment-wave tests](../../src/tests/signed-bootstrap-wave.ts); node flow covers checkpoint and retained-approval recovery. Browser transport is mocked. |
| B12 — independent vectors | Independent vector file and its pinned provenance. Public fixed test scalars are not production nonce guidance. |
| B13 — keyed proofs and on-node flow | Circuit inventory, node summary, and environment capture. Custody, device lifecycle, and recovery veto are exercised with a software authenticator. |

Native results contain 17 constraint-stage rows, 17 preprocessing rows, and two unchecked off-curve host-panic cases. Preprocessing refusal is not constraint rejection; coordinate-bound projections do not establish rejection of every malformed full-contract witness. See the report's scope and untested boundaries. These checks are bounded evidence, not a formal soundness proof.

Activation measured **k=18 and 193,751 rows**. One accepted activation proof took **29.320 seconds** and contained **6,460 bytes**, including provider lookup/loading and local HTTP transfer, excluding signing, wallet balancing, and inclusion. This is one observation, not a latency distribution. The successful flow used a faucet-issued non-native asset; ledger limits were unchanged.

## Reproduce

Use the pinned toolchain and dependencies in the [reference README](../../README.md). From `contract/`, run:

```sh
npm run ci:compile
npm run build
npm run test:signed-bootstrap-offline
npm run test:signed-bootstrap-evidence
npm run test:signed-bootstrap-measure
npm run test:signed-bootstrap-runner
```

`ci:reference` includes these offline/tooling checks and the wider reference regressions. `test:signed-bootstrap-keyed` needs real generated verifier keys; the localnet workflow runs it before the proof flow. Test source is authoritative; repeated TAP/build transcripts are not retained here.

Normal offline tests do not write captures. For fresh native inputs, use `WRITE_EVIDENCE=1 EVIDENCE_DIR=/tmp/passport-bootstrap-evidence npm run test:signed-bootstrap-offline`, then give the same directory to `scripts/run-signed-bootstrap-constraints.py`. Capture requires all four local Compact sources, generated runtime JS, and activation ZKIR. Current validation rejects incomplete historical manifests; regenerate inputs instead of reusing the preserved native snapshot.

For real proof measurements, generate keys with `npm run compile`, start the local stack, and run `test:signed-bootstrap` and `measure:signed-bootstrap` with a separate `EVIDENCE_DIR`. Relative evidence paths resolve from `contract/`; absolute paths are unchanged. Raw receipts, logs, preimages, onboarding records, and CI artefacts are ignored by Git. Refresh the curated files deliberately when their measured behaviour changes.
