# Proving-key regeneration from ZKIR

Feasibility experiment in two parts.

1. Is a Compact circuit's prover key a deterministic function of its ZKIR and
   the public SRS, and what does regenerating it cost?
2. Since the chain already publishes every circuit's verifier key, can a
   client build the prover key from the ZKIR and the on-chain verifier key
   alone, with no SRS, and how deterministic is key generation across runs
   and toolchain builds?

Both answers are yes, byte for byte, on all 30 circuits of the account
contract. A client that holds the ZKIR (kilobytes) and reads the verifier key
from the deployed contract can produce the prover key (up to hundreds of
megabytes) locally, and a registry of Compact contracts only needs to carry
ZKIR.

## Motivation

Any party that builds a transaction calling a circuit needs that circuit's
prover key. For the Passport account contract this includes strangers
depositing into an account, and wallets, dApps, or sponsors acting for the
owner. The compiled account contract carries 3.5 GB of prover keys against
928 KB of ZKIR. The three circuits that motivated the question:

| circuit | prover key | verifier key | ZKIR (json / binary) |
|---|---|---|---|
| `deposit_unshielded` | 436 KB | 1.3 KB | 4.7 KB / 1.5 KB |
| `deposit_shielded` | 11 MB | 2.1 KB | 5.5 KB / 1.5 KB |
| `withdraw_shielded_with_grant_k256` | 224 MB | 2.7 KB | 39 KB / 12 KB |

Neither npm nor a git repository is a fit for the prover keys, and a dApp
handed a contract address has no way to discover which keys it needs or to
check that what it downloaded matches the deployed contract. The same
problem is reported upstream by an ecosystem team with 10.4 GB of keys
(midnightntwrk/servicedesk#203); midnight-ledger PR #770 answers the
transport half by letting the proof server load key bundles from disk.

## How keys are made upstream

In transient-crypto and zkir-v3 (midnight-ledger), key generation is

```
vk = setup_vk(srs_k, ir)      // the SRS enters here, and only here
pk = setup_pk(ir, &vk)        // no SRS
```

so the prover key is a function of the relation (the ZKIR) and the verifier
key, and the verifier key is a function of the ZKIR and the SRS at the `k`
the toolchain chose for the circuit. The `.prover` file written by compactc
is the tagged serialisation of that prover key (uncompressed on the ledger-9
line; ledger-8 gzip-compressed it). The `.verifier` file is the tagged
serialisation of the verifier key, and it is what a deployment puts on chain.

## Part 1: regeneration from ZKIR and SRS

`run.sh` takes a compiled (managed) contract directory, runs the toolchain's
`zkir-v3 compile <ir> <prover> <verifier>` on every `zkir/*.zkir`, times each
run with peak resident memory, and compares the output against the
`keys/*.prover` and `keys/*.verifier` that `compactc` produced, byte for byte.

```bash
./run.sh ../../contract/contracts/managed/account
```

Results (2026/09/22, Apple M-series, `results-account-2026-09-22.txt`): all
30 circuits, k from 9 to 17, reproduce **both keys byte-identically**. The
CLI cost includes reading the SRS and writing the key file:

| k | rows | prover key | `zkir compile` | peak memory |
|---|---|---|---|---|
| 9 | 311 | 0.4 MB | 0.03 s | 20 MB |
| 13 | 6 484 | 11 MB | 0.4 s | 110 MB |
| 15 | 26 771 | 47 MB | 2.3 s | 0.46 GB |
| 16 | 58 897 | 112 MB | 6.0 s | 1.2 GB |
| 17 | 78 604 to 91 865 | 224 MB | 8.0 to 9.4 s | 2.3 to 2.4 GB |

The SRS a client must hold is 25 MB at k=17 and 50 MB at k=18, and is
already required for proving.

## Part 2: the on-chain verifier key as the input

### The on-chain bytes are the file bytes

`contract/src/tests/probe-onchain-vk.ts` deploys the account contract on a
localnet (three waves, 30 circuits), reads every `ContractOperation.verifierKey`
back from contract state, and compares it with `keys/<circuit>.verifier`.
All 30 are identical (`onchain/onchain-vk-summary.json`; the bytes are kept
in `onchain/*.verifier.onchain`). A client therefore reads the verifier key
from the indexer in exactly the form `setup_pk` needs.

### Prover key from ZKIR plus on-chain verifier key

`pk-from-vk/` is a small Rust binary over the upstream crates that runs only
the second step: load the ZKIR, load a verifier key (file or on-chain bytes,
same format), `setup_pk`, and write the prover key in compactc's tagged
format. Two controls run alongside: `--srs` performs the full `setup_vk` then
`setup_pk` path in the same binary, and `--roundtrip` reads compactc's prover
key and re-encodes it, to tell a serialisation difference from a key
difference.

```bash
cd pk-from-vk && cargo build --release
./target/release/pk-from-vk ../../../contract/contracts/managed/account/zkir/deposit_shielded.zkir \
    ../onchain/deposit_shielded.verifier.onchain /tmp/deposit_shielded.prover \
    --srs ~/.cache/midnight/zk-params/bls_midnight_2p13 \
    --roundtrip ../../../contract/contracts/managed/account/keys/deposit_shielded.prover
```

Results (2026/09/23, `results-pk-from-onchain-vk-2026-09-23.txt`): for all
30 circuits the prover key built from the on-chain verifier key is
**byte-identical** to compactc's, and both controls agree. `setup_pk` alone
is far cheaper than the CLI figures above, which are dominated by the SRS
read, `setup_vk`, and writing the file:

| k | `setup_pk` (no SRS) | `setup_vk` (control) |
|---|---|---|
| 9 | 0.01 s | 0.02 s |
| 13 | 0.04 s | 0.08 s |
| 16 | 0.33 to 0.47 s | |
| 17 | 0.72 to 1.35 s | 1.24 s |

A proof was then attempted on the localnet with the derived
`deposit_unshielded` key swapped in (`probe-vk-derived-pk.ts`). The client's
artifact-integrity check passed (the key hashes to the manifest value, being
identical), the proof server proved the call, and the node rejected the
transaction at admission with custom error 231, the known unshielded-deposit
rejection on this node build that is unrelated to the proof. With identical
bytes the on-node run adds nothing to `cmp`, so it was not pursued further.

### Determinism

`determinism.sh` keys the same ZKIR repeatedly and through different zkir
builds, comparing the file and (when compressed) the decompressed key
(`results-determinism-2026-09-23.txt`, builds in `binaries.txt`):

- three consecutive runs of the compactc 0.33.0-rc.2 `zkir-v3`: identical;
- the `zkir-v3` binaries bundled with compactc 0.33.0-rc.2, 0.34.0-rc.0,
  and 0.34.0 (all report 3.0.0-rc.2, all three are different builds):
  identical;
- `zkir-v3` 3.0.0 built locally from the midnight-ledger `ledger-9` head
  (e5da670, midnight-zk-stdlib 2.3.5, midnight-proofs 0.8.2,
  midnight-circuits 7.2.4): identical, at k=13 and k=17.

One negative result sharpens what "toolchain version" means. `pk-from-vk`
pinned to midnight-ledger 57b0d0a, the last revision whose zkir-v3 crate is
versioned 3.0.0-rc.2 with the crate versions from its own lock file
(zk-stdlib 2.3.3, proofs 0.8.1, circuits 7.2.2), produced prover keys that
differ from compactc's in 6 to 624 bytes, a **different verifier key** for
the k=17 secp256k1 circuit, and could not deserialise compactc's prover key
(`Invalid Operand variant tag`). The binary compactc bundles as "3.0.0-rc.2"
is newer than that revision. Re-pinned to e5da670, everything matches. Key
identity is therefore a property of the exact zkir and midnight-zk crate
revisions, not of the version string.

## What this establishes

1. **Determinism.** Prover and verifier keys are pure functions of the ZKIR
   and the SRS, stable across repeated runs and across the toolchain builds
   in circulation. Distributing the ZKIR distributes the keys.
2. **The chain supplies the verifier key.** A client needs only the ZKIR
   and the deployed verifier key to build the prover key, with no SRS at that
   step and in about a second at k=17. The SRS is still needed to prove.
3. **Mismatch fails safe.** A ZKIR that does not match the on-chain
   verifier key yields a prover key whose proofs the node rejects, since
   verification runs against that same key. Nothing can be forged. To catch
   the mismatch before proving, run `setup_vk` from the SRS and compare.
4. **The client already pins key hashes.** midnight-js verifies every
   `keys/*.prover` against `compiler/contract-manifest.json` before proving
   (`ZkArtifactIntegrityError` otherwise). A regenerated key must be
   byte-identical or the manifest must be regenerated with it; the same
   manifest is what midnight-ledger PR #770 loads server-side.

## What this does not establish

- **Browser regeneration.** The `@midnight-ntwrk/zkir-v2` WASM package that
  midnight-js proves with links `midnight-proofs` `keygen.rs` and its
  `KeyMaterialProvider` already fetches the SRS per `k`, but the JavaScript
  API exposes `prove`, `check`, and `jsonIrToBinary` only. No keygen entry
  point, and no `zkir-v3` npm package. Peak memory at k=17 is 2.3 GB for the
  full CLI path; `setup_pk` alone was not measured for memory.
- **Proof-server acceptance** of ZKIR-only key material was not tested.
  PR #770 reads `.prover` files from disk and requires them in the manifest.
- **Cross-version stability going forward.** Every build tested here is on
  the ledger-9 line. A future zkir or midnight-zk release may change the key
  for the same ZKIR; the on-chain verifier key detects that but does not
  repair it.

## Implication for the registry question

A registry of Compact contracts does not have to be a large-object store.
Per contract address it needs, per circuit: the ZKIR (kilobytes) and the
exact zkir and midnight-zk crate revisions that keyed it. The verifier key is
already on chain, and the prover key becomes a client-side cache built from
the two in about a second. The remaining engineering asks are upstream: a
keygen export in the zkir WASM binding, and a proof-server mode that derives
keys from ZKIR instead of reading `.prover` files.

## Layout

| Path | What |
|---|---|
| `run.sh` | Part 1: regenerate every key from ZKIR with the toolchain's `zkir-v3`, time it, diff. |
| `results-account-2026-09-22.txt` | Part 1 results, 30 circuits. |
| `determinism.sh`, `binaries.txt`, `results-determinism-2026-09-23.txt` | Repeated runs and four zkir builds on two circuits. |
| `onchain/` | Verifier keys read back from the deployed contract, plus the comparison summary. |
| `pk-from-vk/` | Rust binary: `setup_pk` from ZKIR and a verifier key, with the two controls. |
| `results-pk-from-onchain-vk-2026-09-23.txt` | Part 2 results, 30 circuits from on-chain keys. |
| `../../contract/src/tests/probe-onchain-vk.ts` | Deploys and reads the verifier keys back (`npm run probe:onchain-vk`). |
| `../../contract/src/tests/probe-vk-derived-pk.ts` | Proves a public call with a swapped-in prover key (`npm run probe:vk-derived-pk -- <address>`). |
