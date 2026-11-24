# Third PR #216 review-fix validation

Base revision: `f522b5a`. [validation.json](validation.json) records changed source hashes and the checks below.

- [TypeScript build](build.txt): passed.
- [Combined regressions](combined.txt): 102 passed, none failed or skipped. They cover bootstrap, deployment waves, receipt directories, device reconnection, and recovery.
- [Source-archive capture check](archive.txt): passed; ordinary offline execution still preserves committed captures.
- Four selected account regressions and three selected deployment regressions fail against isolated copies of the `f522b5a` implementations.
- The P-256 report generator renders 52 and 53 circuits from isolated capture fixtures, deriving the count from the input data. The historical measurement table remains labelled as the earlier 52-circuit capture; the current roster has 53.

From `contract/`, reproduce with:

```sh
npm run build
node --import tsx --test src/tests/signed-bootstrap-offline.ts src/tests/signed-bootstrap-client.ts src/tests/signed-bootstrap-registration.ts src/tests/signed-bootstrap-resume.ts src/tests/signed-bootstrap-evidence-directory.ts src/tests/signed-bootstrap-wave.ts src/tests/device-reconnection.ts src/tests/recovery-bootstrap.ts
npm run test:signed-bootstrap-evidence
```

The account regressions execute real generated state transitions: accepted activation with a lost reply, relayer-first activation, intervening account use, an unexpected installed device, recovery replacement, and a genuine dormant failure. Verified success does not invent a missing transaction ID. Registration tests hold real software-backed browser trial assertions open to check that approval cannot overlap them; external retention must pass network, deployment, and dormant-state checks.

Deployment tests use actual SDK constructor/submission assembly with mocked transport. Non-checkpointed wave-1 failures leave prior private state and signing keys untouched; successful deployment persists before maintenance. Checkpointed interruption still retains its recovery material before submission. Receipt tests cover both success and failure with default, relative, and absolute destinations.

Compact changes add commas to comments only. Non-comment code and line counts are unchanged; the validation file records the code hashes. No new proofs or local-node transactions were generated. Earlier native, proof, and transaction evidence keeps its original source attribution.
