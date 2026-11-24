# PR #216 review-fix validation

Base revision: `a38ee9694ec16cc085146085ff248fd8ef960e13`.

[Build](build.txt): TypeScript compilation passed. [Tests](tests.txt): 72 passed, with no failures or skipped tests. From `contract/`, run:

```sh
npm run build
node --import tsx --test src/tests/signed-bootstrap-offline.ts src/tests/signed-bootstrap-client.ts src/tests/signed-bootstrap-registration.ts src/tests/signed-bootstrap-resume.ts src/tests/signed-bootstrap-wave.ts src/tests/device-reconnection.ts src/tests/recovery-bootstrap.ts
```

The resume regressions cover use from another session, device enrolment/removal, recovery replacement, unavailable or incomplete history, an unexpected first device, and changes during awaited persistence. Deployment tests cover both bootstrap modes and resume of earlier mode-0 checkpoints.

[Existing-account resume](resume-existing-account.json): read-only checks against the original local node/indexer account succeeded after removing `retired` and `transactionId` from an in-memory copy of its saved record. Both `inspect()` and `activate()` completed at authorisation nonce 6, epoch 0, and device count 1. The real SDK history stream established the original installation; all 53 installed verifiers and maintenance-authority retirement were checked. No transactions or new proofs were generated, and the durable record was unchanged. The receipt includes hashes of the changed implementation and regression test.

Compact sources and proving artefacts are unchanged. Earlier native, proof, and transaction receipts remain attributed to their original revisions. The conformance runner now also checks this resume case after its device lifecycle for future full on-node runs.
