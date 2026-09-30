# caller-context

Runs the ledger's own `ContractCall::context(...).caller` derivation on
serialised transaction bytes, off-node, and prints the resulting caller graph:
for every contract call in every intent, which other call claims it, and what
`caller` resolves to.

Built for probes P8 (caller derivation) and P9 (voluntary lending) of the
cross-contract-calls experiment.

## What it is not

This tool runs the ledger's derivation code off-node, on bytes. It is **not** a
substitute for a node observing a slot-6 read. Compact has no reader for
context slot 6, so no circuit can witness the derived caller today; what this
tool establishes is what the ledger computes and marshals into that slot, not
what a contract can see. A claim about node behaviour still needs a node.

Two further deviations from the on-chain path are deliberate and do not affect
`caller`:

- `ContractState::default()` is passed instead of the live contract state.
  `context()` reads only `state.balance` from it, and `caller` does not depend
  on the balance. The `balance` field of the resulting context is therefore
  empty and is not reported.
- `BlockContext::default()` and an empty `com_indices` map are passed. Neither
  participates in the caller derivation.

The tool does not run `well_formed`, so it never refuses a transaction. Where
the claim graph looks like something `effects_check` would reject, it says so
under "claim-graph observations", citing the check. Those are observations of
the bytes, not verdicts: a probe must still record the stage at which a
transaction is actually refused.

## Pin

Dependency of record: the `midnight-ledger` repository at git tag
`ledger-9.1.0.0-rc.3`, commit `4823b5351b17cc49e30f19760dbd30a73cf95e22`,
the same tag the experiment's `@midnightntwrk/ledger-v9` 1.0.0-rc.3 binding is
built from.

There is no path dependency and no local build accelerator. `Cargo.toml`
carries the git tag pin directly, and `Cargo.lock` resolves every
`midnight-*` crate to that tag. The one exception is
`midnight-transient-crypto` 2.x, which the ledger crate depends on for legacy
verifier keys and which is not published on crates.io at the version required;
the three `[patch.crates-io]` entries reproduce the upstream workspace's own
patches against git tags, and are part of the pin rather than a local
convenience.

`midnight-ledger-v9` is taken with `default-features = false`, which drops
`proof-verifying`, as the wasm binding does. Proofs then deserialise as opaque
bytes, which is all this tool needs.

## Build

```sh
cargo build --release
```

The ledger workspace pulls a heavy ZK dependency graph, so expect the first
build to take tens of minutes; that figure is an expectation, not a
measurement, because the cold build was not timed. Once the graph is
compiled, a change to `src/main.rs` rebuilds in about 30 seconds (measured).
The harness does not build the tool: P8 and P9 look for
`target/release/caller-context` and write a `BLOCKED` verdict with this build
instruction when it is absent.

```sh
cargo test --release
```

covers the claim-graph observation logic on synthetic inputs (a claim matching
no call, and one call claimed by two others). P9's control arms a and b
exercise the same two shapes on real, proven, submitted transactions, which
the node refused as `RealCallsSubsetCheckFailure` and
`ClaimedCallsUniquenessFailure`; see `../../evidence/p9-node-rejections.txt`.
The tool has no observation arm for the sequencing rule (claimant after the
claimed call), so P9's control c shows an empty observation list on bytes the
node refused as `CallSequencingViolation`.

## Run

```sh
caller-context <path> [--json]
```

`<path>` is a file holding a serialised ledger `Transaction`, as either hex
text (whitespace and a leading `0x` are tolerated) or raw bytes. The encoding
is detected and reported.

The concrete `Transaction<S, P, B, D>` type parameters are not recorded in the
bytes beyond the tag header, so the tool tries candidates in order and reports
which succeeded along with every failure. The three that the TypeScript API
actually produces, in the order a probe meets them, are:

| Stage | Type | Tag |
|---|---|---|
| unproven | `Transaction<Signature, ProofPreimageMarker, PedersenRandomness, InMemoryDB>` | `transaction[v12](signature[v2],proof-preimage,embedded-fr[v1])` |
| proven | `Transaction<Signature, ProofMarker, PedersenRandomness, InMemoryDB>` | `transaction[v12](signature[v2],proof,embedded-fr[v1])` |
| balanced | `Transaction<Signature, ProofMarker, PureGeneratorPedersen, InMemoryDB>` | `transaction[v12](signature[v2],proof,pedersen-schnorr[v1])` |

Seven further candidates (the proof-preimage/pedersen-schnorr cross, the
signature-erased forms, and the fully erased `Transaction<(), (), Pedersen>`)
are tried after those and have not yet been needed.

`--json` emits the same report as a JSON object, for `writeEvidence()` to
embed.

## Reading the output

Per call the tool prints the address, entry point name and `ep_hash`, the
`communication_commitment`, which transcripts are present, the claims the
call's own transcripts emit, every call that claims it, and `caller`.

`caller` is annotated with the action index the ledger's `find_map` selected.
`find_map` scans `intent.actions` in order and takes the first match, so when
more than one call claims the same callee, the first in action order wins.
Self is not excluded from that search, in the tool or in the ledger.

Commitments are rendered here as the padded 32 bytes, little-endian, as `Fr`
serialises. The TypeScript API renders the same value as a one-byte tag
followed by the **minimal** little-endian value bytes, with trailing zero
bytes trimmed. A full-width value is therefore 33 bytes with tag `0x73`, so
`7312917583c2…` there is `12917583c2…` here; a value whose high byte is zero
is shorter, and a 31-byte value has been observed as 32 bytes with tag `0x6f`.
Comparisons across the two views must be of values rather than of renderings:
drop the TypeScript tag byte, then trim trailing zero bytes on both sides. P8
does exactly that, in `canonicalTsFr` and `canonicalRustFr`.

## Verified

On the four P8 captures in `../../evidence/`, all four stages deserialise, and
in every one of them the two sub-calls resolve to `Contract(<Caller address>)`
while the root `write_then_read` call, in an intent with no unshielded inputs,
resolves to `None`. The offline capture carries its own contract pair
(rebuilt on every run), the other three the live pair. The commitments and
entry-point hashes agree with the TypeScript view recorded in
`p8-caller-derivation.json`. On the nine P9 captures the tool resolves the
claimed root `set` call to `Contract(<Lender>)` wherever the claim matches
(main arm, control b, control c) and to `None` where it does not (control a);
for the balanced captures of the accepted transactions, the bytes analysed
are byte-identical to the transactions the indexer holds in blocks 963 (P8)
and 1105 (P9).

The derivation mirrors the ledger's own call site: `semantics.rs:1098` builds
`intent.erase_proofs().erase_signatures()` and `semantics.rs:1439` passes it to
`context()`, which is exactly what `analyse_intent` does.
