# Second PR #216 review-fix validation

The review targeted `6802395`. [validation.json](validation.json) records the base revision and changed source hashes.

- [TypeScript build](build.txt): passed.
- [Combined regressions](tests.txt): 83 passed, none failed or skipped. These cover bootstrap, deployment waves, device reconnection, and recovery.
- [Final wave tests](wave-tests.txt): 14 passed after increasing the delayed-visibility test grace period. These overlap the combined suite. Four selected new wave regressions also failed against an isolated copy of `6802395`, confirming the original failures.
- [Source-archive capture test](capture-test.txt): passed. Actual capture-producing tests run without `.git`; default execution preserves existing captures, while `WRITE_EVIDENCE=1` writes to the chosen directory and records absent Git provenance as `null`.
- [Python runner tests](runner-tests.txt): four passed under `python3 -B -O`; the same checks also passed with `PYTHONOPTIMIZE=1`. Stale inputs, unsafe archive members, and unexpected lock metadata raise explicitly.

From `contract/`, reproduce with:

```sh
npm run build
node --import tsx --test src/tests/signed-bootstrap-offline.ts src/tests/signed-bootstrap-client.ts src/tests/signed-bootstrap-registration.ts src/tests/signed-bootstrap-resume.ts src/tests/signed-bootstrap-wave.ts src/tests/device-reconnection.ts src/tests/recovery-bootstrap.ts
npm run test:signed-bootstrap-evidence
npm run test:signed-bootstrap-runner
```

The new evidence-tool checks are included in `ci:reference`. The historical independent vectors and runtime-preimage receipt remain byte-for-byte unchanged after normal execution. Captured personal checkout/home prefixes were redacted from 161 lines in 48 existing files, preserving all other capture bytes.

Deployment regressions use the real SDK transaction assembly with mocked submission/indexer transport. Provider regressions use real generated account transitions and execute the next signed account operation. These are not new local-node transactions or proof measurements. Compact sources remain unchanged; original proof and native-constraint receipts retain their original source attribution.
