# Experiment: Schnorr Wallet (RedJubJub on Midnight)

## Purpose

This experiment answers the critical question for the ARC Passport MVP:
**can a JubJub Schnorr signature be verified inside a Midnight Compact
circuit, and can a contract hold and release tokens gated by that
signature?**

If this works, it proves that a FROST threshold signing network on JubJub
can authorise Midnight transactions — the core mechanism of the passport
architecture.

## What It Demonstrates

1. **In-circuit Schnorr verification** — the Compact contract verifies
   `s*G == R + c*owner_pk` using `ecMulGenerator`, `ecMul`, and `ecAdd`
2. **Contract-held unshielded tokens** — the contract receives and sends
   unshielded tokens via `receiveUnshielded`/`sendUnshielded`
3. **Replay protection** — a monotonic `tx_count` is bound into every
   Schnorr challenge
4. **Rust CLI signer** — a dedicated Rust binary (`signer/`) computes
   Schnorr signatures over withdrawal parameters using the JubJub curve
5. **Nonce-retry pattern** — iterates until the hash challenge is a
   valid JubJub scalar (< JUBJUB_R, ~17 iterations expected)

## Prerequisites

- Docker (for the local Midnight devnet)
- Node.js >= 22
- `compact` compiler on PATH (must match runtime 0.15.0)
- Rust toolchain (`cargo`)
- `openssl` (for `.env` secret generation)

## Quick Start

The `test-e2e.sh` script handles everything: prerequisite checks,
dependency installation, contract compilation, Rust signer build, devnet
startup, and the full end-to-end workflow.

```bash
./test-e2e.sh           # run the full e2e test
./test-e2e.sh --fresh   # reset chain state first
```

## Individual Steps

If you prefer to run steps manually, the workflow is:

### Deploy the contract

```bash
npm run deploy
```

Deploys the schnorr-wallet contract to the local devnet and writes
`deployment.json`.

### Register an owner key

```bash
npm run register
```

Generates a random JubJub scalar (or loads from `wallet-key.json`),
computes the public key `pk = sk*G` in-circuit, and stores it on-chain.

> **Keep `wallet-key.json` secret** — it contains your private scalar.

### Deposit tokens

```bash
npm run deposit
```

Sends unshielded tokens from your wallet into the contract. Anyone can
deposit.

### Withdraw tokens (Schnorr-authorised)

```bash
npm run withdraw
```

Computes a Schnorr signature over the withdrawal parameters using the
Rust CLI signer (`signer/target/debug/schnorr-signer`) and the private
scalar from `wallet-key.json`, submits the signature to the contract,
and the contract verifies it in-circuit before releasing funds.

### Read contract state

```bash
npm run contract-state
```

Displays the current `owner_pk`, `registered` flag, and `tx_count`.

## How The Schnorr Signature Works

The contract uses a "Midnight-flavoured Schnorr" scheme — standard
Schnorr verification but with `persistentHash` (Poseidon) instead of
Blake2b for the challenge hash. This keeps all operations native to
Midnight's SNARK.

### Signing (Rust CLI, off-chain)

1. Generate random nonce scalar `r` (in JubJub field)
2. Compute nonce point `R = r*G`
3. Find `nonce` such that `persistentHash(R, pk, color, amount,
   recipient, tx_count, nonce)` < JUBJUB_R (~17 tries)
4. Compute challenge `c` = that hash value
5. Compute response `s = (r + c * sk) mod JUBJUB_R`

### Verification (Compact circuit, on-chain)

```compact
const h = persistentHash([sig_r, owner_pk, color, amount, recipient, tx_count, nonce]);
const c: Field = h as Field;
assert(ecMulGenerator(sig_s) == ecAdd(sig_r, ecMul(owner_pk, c)), "invalid signature");
```

### Why This Is Compatible With FROST

The signer only needs:
- The private scalar `sk` (or threshold shares of it)
- Access to JubJub curve operations and Poseidon hashing

A FROST threshold network would replace step 5 with a distributed
signing protocol where each node computes a partial response from its
key share. The verification equation is identical — the contract does
not know or care whether the signature was produced by one signer or
a threshold of signers.

## Relationship to ARC Passport

This experiment validates the core cryptographic mechanism described in
`docs/mvp-architecture.md`. If the contract successfully verifies
signatures and gates token withdrawals, the path from here to the full
MVP is:

1. Replace the local scalar with a FROST DKG key
2. Replace the single-signer Rust CLI with a threshold signing protocol
3. Add a name registry (`username.midnight` -> contract address)
4. Add passkey authentication in front of the signing network

## Known Limitations

- **Unshielded tokens only** — shielded tokens are key-bound
  (`ZswapCoinPublicKey`), not contract-bound
- **Single owner** — production would use a key-set Merkle root for
  multi-device support
- **Midnight-flavoured Schnorr** — not standard RedJubJub (uses
  `persistentHash` instead of Blake2b). This is fine because we control
  both signer and verifier.
- **Nonce-retry** — ~17 iterations to find a valid challenge. Fast in
  Rust, potentially slow on constrained hardware.
- **JubJubPoint equality bug** — compact-runtime 0.15.0 compiles `==`
  on JubjubPoint to JavaScript `===` (reference equality). The build
  step patches the generated JS to use structural equality comparison.
  See `scripts/patch-point-eq.js` and
  [LFDT-Minokawa/compact#278](https://github.com/LFDT-Minokawa/compact/issues/278).
