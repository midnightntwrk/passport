# Local-network validation

The fresh run on **2026-10-16**, after integrating contributor PR #185 and
regenerating every key with Minocrab `79b2add`, **passed**: **112 successful
indexed transactions, all 52 native entrypoints, and three native accounts**. The
read-back audit passed for every transaction and installed verifier key. It also
confirmed the recovered account has device epoch 1, one device and no pending
recovery, and matched the forged-caller rejection to the node's ledger-read
mismatch diagnostic. Evidence is in [`../evidence/localnet.json`](../evidence/localnet.json).

This run used the normal command, with fresh accounts and no suite restarts.
The source, executable, IR and verifier-key hashes captured before the run still
matched after the audit. The earlier pre-helper development run, including its
two failed suite attempts and successful retries, is retained in
[`../evidence/before-minocrab-helpers/`](../evidence/before-minocrab-helpers/).
The final gate requires all 52 entrypoints to be accepted and independently
audited. The normal command below starts new accounts and exits on the first
suite failure.

This harness deploys the independently written Minocrab account to the reference's
ledger-9 local network and checks indexed transaction results. It reuses the
reference ABI encoding, signers, witness provider, Zswap bookkeeping, wallet,
and budgeted deployment helpers. The account's constructor state, circuit
execution transcripts and installed verifier keys come from the Rust port.
The callee module advertises the native verifier-key fingerprints, so dynamic
contract calls retain the runtime's implementation-identity check.

For every native call, Rust executes both IRs against the same live state and
context and checks their resulting state, outputs and effects. The SDK uses the
native transcript to assemble the transaction and the Minocrab keys to prove it.
The resulting transaction is balanced with the local genesis wallet, submitted,
and checked for `SUCCESS` through the indexer. This is an SDK adapter for the
experiment, not a standalone production Minocrab wallet implementation.

For receiving-contract composition, `compose.ts` executes both independent root
calls at the same block and uses the public ledger API to assemble their two
native proofs and one shielded offer. The high-level SDK rejects an outgoing
contract coin while assembling the first root, before a separately built
receiver can claim it. The helper supports only guaranteed, full-coin transfers
with no change, minting, unshielded effects or nested calls. It asserts the
matching nullifier/send/receive claims before proving; the node checks the whole
transaction. Partial spends and self-transfers remain offline parity coverage.

From the repository root, install and compile the unchanged reference tooling:

```sh
cd contract
npm ci
npm run compile
```

Start the reference compose files with a separate project name. Create
`contract/infra/.env` as described in the reference README before starting:

```sh
cd contract/infra
docker compose -p minocrab-account-custody -f docker-compose.yml -f docker-compose.macos.yml up -d
```

From `experiments/minocrab-account-custody`, follow the parent README's reference
compilation and fixture steps, then run:

```sh
cargo build --release -p project-custody-measure
target/release/project-custody-measure localnet-keys
node ../../contract/node_modules/tsx/dist/cli.mjs localnet/offline.ts
node ../../contract/node_modules/tsx/dist/cli.mjs localnet/check.ts
node ../../contract/node_modules/tsx/dist/cli.mjs localnet/run.ts
node ../../contract/node_modules/tsx/dist/cli.mjs localnet/audit.ts
```

`localnet-keys` generates all 52 key pairs and packages tagged binary ZKIR for
the proof server. `localnet-package` can regenerate binary IR without keygen.
The benchmark's JSON ZKIR is not the HTTP proof protocol's binary IR payload.
The run defaults to the documented local genesis seed ending in `01`;
`WALLET_SEED` overrides it. It uses the local endpoints at ports 9944, 8088 and
6300 and writes private wallet state to the ignored local database directory.

The full run requires every native entrypoint to appear in an accepted
transaction before it can mark the evidence `passed`. It exercises bootstrap
under each credential arm; device lifecycle; funded shielded and unshielded
spends; grant issuance, spends and revocation; receiving-contract composition
and onward spending; caller-bound grants through one and two forwarding hops;
and recovery publication, veto, finalisation and successor control.

`evidence/localnet.json` is a journal: a `running` or `failed` file is partial
progress, not a successful validation. It records submitted transaction sizes,
identifiers, block heights, circuit coverage and checks. Those transaction bytes
include funding and transaction structure and are distinct from the parent
benchmark's isolated proof sizes. They are not a paired Compact/Minocrab size
comparison. Constructor and execution parity checks use the unchanged Compact
reference locally; native proof validity and ledger acceptance are checked by
the local network.

The final audit independently downloads and decodes each indexed transaction,
checks its hash and byte count, rebuilds the 52-entrypoint coverage from those
bytes, and compares all installed verifier keys with the native artifacts. It
also records Docker image digests and source/artifact hashes. Docker must remain
available when running the audit.

The indexer can return several commitment positions for a shielded deposit.
Some belong to wallet change and are pruned from the account's tree. The pinned
ledger-v9 SDK can trap in `ZswapInput.newContractOwned` for such a position.
The harness records this specific pre-submission error and tries the next
candidate; proof failures can also reject incorrect candidates. Node submission
errors are not retried with a different witness.

For harness development, `localnet/run.ts --retry-suite` retains live test
accounts and successful stage results after a suite failure. Updating
`artifacts/localnet/retry` reloads `suite.ts`. Failed attempts remain in the
journal; this is not a restart from a fresh chain. The default run fails and
exits immediately. Private signing material is never written to the journal.
