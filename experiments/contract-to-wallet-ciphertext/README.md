# contract-to-wallet-ciphertext

Can a smart contract pay an ordinary wallet in shielded value, such that the
wallet finds the coin by itself?

A shielded output carries **ownership** (a commitment to the recipient's
`CoinPublicKey`) and **discoverability** (a ciphertext of the coin's opening,
sealed to the recipient's separate `EncryptionPublicKey`) as two independent
things. A Compact circuit holds only the `CoinPublicKey`, so the contract
cannot seal that ciphertext. This experiment tests whether the party who
**executes** the circuit can seal it instead, in the same transaction.

The brief, with the interpretation grid fixed in advance, is in
[`EXPERIMENT_GUIDELINE.md`](EXPERIMENT_GUIDELINE.md). Results are in
[`FINDINGS.md`](FINDINGS.md), regenerated from `evidence/*.json`.

## Running it

Prerequisites: Docker, Node.js 22+, `compact` on `PATH`, `openssl`.

```sh
./run-all.sh            # compile, bring up the devnet, run every probe
./run-all.sh --fresh    # reset chain state first
./run-all.sh --tests p2 # one probe
```

P1 needs no chain. P2 and P3 need the local devnet and both genesis-funded
seeds (`WALLET_SEED`, `WALLET_SEED_SECONDARY` — `run-all.sh` sources
`infra/.env`, created from `.env.example` on first run).

## Layout

```
contracts/vault.compact   the minimal vault: deposit, and two send circuits
                          differing only in what they disclose to the caller
src/wallet/vault.ts       the client — builds the send through the explicit
                          call path so the executor can supply the
                          recipient's encryption key
src/tests/p1-*.ts         the platform's own account of the mechanism
src/tests/p2-*.ts         the headline: three arms, one variable
src/tests/p3-*.ts         spendability and secrecy of the result
evidence/                 one JSON file per probe
```

## What the vault deliberately omits

- **Authentication.** Device auth is proven in the account-custody reference
  implementation; here it would only add variables.
- **An encrypted inbox.** The inbox is the application-layer discovery
  channel this experiment is testing an alternative to. Including it would
  beg the question.

## Reading the result

The recipient is a genuinely separate wallet, with its own seed and its own
wallet process, told nothing out of band. It is asked only what its own scan
found. That separation is load-bearing: the SDK resolves the **caller's own**
encryption key automatically, so a contract paying its own operator would
pass trivially and prove nothing.
