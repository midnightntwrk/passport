# Reference regression CI

Implementation dated 2026/11/11, addressing `TODO-CI-01`. This change is stacked
on [PR #207](https://github.com/midnightntwrk/passport/pull/207), which has not
merged at the time of writing. Its viewing-recovery tests are part of this CI
baseline. Retarget and rebase after that dependency merges.

## What runs

| Lane | Trigger | Evidence and limits |
|---|---|---|
| **Reference regression** | Every pull request, pushes to `main`, merge groups, and manual dispatch | Fresh generated runtimes, one freshly generated SDK fixture key, TypeScript, seven remediation suites, existing offline checks, and locked Rust tests. No proof or node-admission claim. |
| **Reference proof and localnet** | Weekly on Monday at 04:23 UTC, manual dispatch, and pull requests changing its CI helpers or selected fixtures | Complete fresh reference keys, deployment-artefact checks, native-prover controls, and a three-process JubJub recovery journey on a fresh localnet. This is a bounded integration tier, not the full conformance matrix. |

The fast workflow has no path or target-branch filter. This keeps its check
available for stacked pull requests and for a future required-check policy.
The heavy workflow is deliberately separate and must not be configured as a
required pull-request check, because its path filter can prevent a run.
Scheduled and manual activation require the workflow on the default branch;
the CI-file pull-request trigger permits validation before merge.

## Pins and clean inputs

- Node.js **22.22.2**, with npm **10.9.7** in that distribution.
- Compact **0.35.0**, from the Linux x86_64 release archive, verified against
  the SHA-256 in `scripts/ci-install-compact.sh`.
- Rust **1.98.1**, with `--locked` signer and BUSS crate commands.
- npm installation from `package-lock.json`, with `--ignore-scripts` and no
  restored `node_modules`, generated output, or key cache.
- GitHub Actions pinned to complete commit hashes.
- Node, indexer, and proof-server images pinned to manifest digests in
  [`infra/docker-compose.ci.yml`](infra/docker-compose.ci.yml).

The runner uses `ubuntu-24.04`. That image and its system packages are ambient
infrastructure, not an immutable operating-system build. The evidence records
available tool and source identities. Standard hosted-runner disk capacity is
insufficient for the approximately 12 GiB reference artefact set plus services.
The heavy workflow removes only the unused Android and .NET SDK directories
on its ephemeral GitHub-hosted Linux VM, then requires at least 26 GiB free.
This cleanup is not part of the local reproduction helper.

The compiler and proof server can fetch public parameters from upstream on a
cold run. Their availability is an additional dependency; the pinned software
performs its parameter-integrity checks. This CI does not claim a fully offline
or hermetic build, or independently audit the parameter ceremony.

Each compile removes only the six named generated reference module directories,
then regenerates them from the checkout. The caller probe retains the compiler
flags already specified by `package.json`. The fast lane uses `--skip-zk`, then
generates `withdraw_shielded_with_jubjub` keys from the freshly generated ZKIR:
the unchanged durable-change SDK test needs a real verifier to assemble its
unproven transaction. This one key is not a complete deployable key bundle.

## Failure and evidence handling

`scripts/ci-run.mjs` records command arguments, timestamps, exit status, timeout,
and completion checks. TAP suites must report positive test counts with no
failures, skipped tests, cancellations, or TODOs. Cargo must execute tests with
no failures or ignored cases. Script suites have explicit completion markers.
The runner rejects a zero-exit command that produces no expected test evidence.
Both workflows first run twelve isolated subprocess controls for the runner,
including empty output, skipped tests, duplicate summaries, and timeouts.
The deterministic grant vectors are checked for changes before native checks
consume them.

Both workflows retain evidence for 14 days, including failed runs. Manifests
include source, lockfile, compiler, generated runtime, ZKIR, and key hashes.
Pull-request head, base, and checked-out merge identities are distinct fields.
Hashes bind evidence to a run; they do not prove independently reproducible
proving-key bytes or establish consensus conformance.

The localnet helper refuses existing project volumes, containers, or the
reference private-state database. It starts the indexer only after node block
production, verifies a matching indexed block, and captures service identities.
Every child has a timeout; the complete job has a 120-minute bound. Cleanup
removes only this run's containers, network, volumes, and temporary private
profiles. A fallback cleanup step also runs after failure or cancellation.

The public localnet receipt contains the deployed address, genesis identity,
all installed account verifier hashes with asserted byte equality, and ten
selected journey transaction receipts. Each identifier, successful result, and
node/indexer block hash is checked. Deployment, maintenance, and funding create
additional transactions outside those ten retained journey receipts.

Only public receipts, command status records, and the native-control log are
published from the localnet run. Guardian shares, vault keys, private profiles,
LevelDB, and raw fixture/service output are kept outside the upload directory
and removed. The fixture uses public development funding and local software
guardian shares. External guardian authentication, P-256 proving, real-browser
compatibility, and the complete localnet suite remain outside this lane.

## Reproduction

Use a fresh checkout, an empty evidence directory outside the checkout, the
pinned compiler on `PATH`, and the pinned Node and Rust versions. Linux x86_64
users can run the installer with a new absolute `COMPACT_DIR`. On other hosts,
install the same compiler version for that platform and record its identity.
Run from `contract/`:

```sh
export CI_EVIDENCE_DIR=/private/tmp/passport-reference-evidence
node scripts/ci-evidence.mjs initial started
npm ci --ignore-scripts --no-audit --no-fund
npm run ci:compile
npm run build
npm run ci:reference
node scripts/ci-evidence.mjs final success
```

The final status above must reflect the preceding commands' actual outcome.
For the heavy tier, use a separate fresh checkout/evidence directory, run
`bash scripts/ci-compile-reference.sh keyed`, build, and run
`node --import tsx src/tests/toolchain-offline.ts`. Set `CI_LANE=localnet` and a
unique `CI_COMPOSE_PROJECT=passport-ci-<run-id>` before
`node scripts/ci-localnet.mjs`. Docker must be running and ports 9944, 8088,
and 6300 must be available. Do not reuse the fast lane's partial key bundle.

## Merge enforcement and remaining acceptance

A read-only check on 2026/11/11 found main's required contexts were `scan` and
`DCO`. The separate active ruleset did not add reference test requirements.
This implementation does not change repository protection settings.

After the workflow is merged and its final check name is established, an
administrator must add **Reference regression** to the required checks if it
is to block merging. Retain existing review, signature, and status requirements.
Demonstrating a failing source invariant makes this workflow fail; it does not
by itself demonstrate required-check enforcement. `TODO-CI-01` remains open
for that separate configuration and enforcement evidence.

Current validation and dependency state are recorded in the
[remediation queue](../docs/plans/AUDIT-REMEDIATION.md).
