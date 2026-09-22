# Proving-key regeneration from ZKIR

Feasibility experiment: is a Compact circuit's prover key a deterministic
function of its ZKIR and the public SRS, and what does regenerating it cost?
If yes, a client that holds the ZKIR (kilobytes) can produce the prover key
(up to hundreds of megabytes) at first use instead of downloading it, and a
registry of Compact contracts only needs to carry ZKIR and verifier keys.

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
check that what it downloaded matches the deployed contract.

## Method

`run.sh` takes a compiled (managed) contract directory, runs the toolchain's
`zkir-v3 compile <ir> <prover> <verifier>` on every `zkir/*.zkir`, times each
run with peak resident memory, and compares the output against the
`keys/*.prover` and `keys/*.verifier` that `compactc` produced, byte for byte.

```bash
./run.sh ../../contract/contracts/managed/account
```

The account contract was compiled with `compact compile +0.33.0-rc.2
--feature-zkir-v3`, so the matching `zkir-v3` (midnight-zkir-v3 3.0.0-rc.2) is
used. The SRS files (`~/.cache/midnight/zk-params/bls_midnight_2p<k>`) were
already cached; they are the same parameters any prover fetches.

## Results (2026/09/22, Apple M-series, native)

Full table in `results-account-2026-09-22.txt`: 30 circuits, k from 9 to 17. Every prover key and every
verifier key of the account contract regenerates **byte-identically** from
its ZKIR. Representative costs:

| k | rows | prover key | regeneration | peak memory |
|---|---|---|---|---|
| 9 | 311 | 0.4 MB | 0.03 s | 20 MB |
| 13 | 6 484 | 11 MB | 0.4 s | 110 MB |
| 15 | 26 771 | 47 MB | 2.3 s | 0.46 GB |
| 16 | 58 897 | 112 MB | 6.0 s | 1.2 GB |
| 17 | 78 604 to 91 865 | 224 MB | 8.0 to 9.4 s | 2.3 to 2.4 GB |

The SRS a client must hold is 25 MB at k=17 and 50 MB at k=18, and is
already required for proving, so it is not an added cost of regeneration.

## What this establishes

1. **Determinism.** Prover and verifier keys are pure functions of ZKIR and
   SRS for this toolchain. Distributing the ZKIR distributes the keys.
2. **Integrity for free.** The verifier key is deployed on chain. A client
   that regenerates both keys from a ZKIR can compare its verifier key with
   the on-chain one; a match means the ZKIR, and therefore the prover key,
   corresponds to the deployed circuit. No trusted key server is needed.
3. **Cost.** Native regeneration is seconds, once per circuit per toolchain
   version, and cacheable. Memory at k=17 (2.3 GB) is the constraint to
   watch for browser clients.

## What this does not establish

- **Browser regeneration.** `@midnight-ntwrk/zkir-v2` (the WASM prover used
  by midnight-js) links `midnight-proofs` `keygen.rs` and its
  `KeyMaterialProvider` already fetches the SRS per `k`, but the JavaScript
  API exposes `prove`, `check`, and `jsonIrToBinary` only. There is no
  keygen entry point and no `zkir-v3` npm package. Regenerating in a wallet
  today requires either a proof server or an upstream export.
- **Proof-server acceptance.** Whether the proof server can be handed ZKIR
  only and derive the keys itself was not tested.
- **Cross-version stability.** Keys were regenerated with the same toolchain
  that compiled the contract. A different `zkir` version may produce a
  different key for the same ZKIR; the on-chain verifier-key check above
  detects this but does not repair it.

## Implication for the registry question

A registry of Compact contracts does not have to be a large-object store.
Per contract address it needs, per circuit: the ZKIR (kilobytes), the
verifier key (kilobytes, also on chain), and the toolchain version that
produced them. Prover keys become a client-side cache. The remaining
engineering asks are upstream: a keygen export in the zkir WASM binding, and
a proof-server mode that accepts ZKIR-only key material.
