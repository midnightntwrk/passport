# Non-payment grants

In this experiment, a registry uses a caller-pinned grant to update an ACC-owned name without moving funds. On Compact 0.36.1, the in-memory Midnight ledger verified both contract proofs and applied the resolver update and grant nonce increment in one transaction.

The registry gets the owner ACC from the name record and computes the digest of the name and proposed resolver. The ACC checks the immediate caller, grant scope, expiry and grantee signature before consuming the nonce. The signature binds the account, registry, operation, arguments, issuance and nonce. Passing the signature announcement as two native fields lets the ACC reconstruct the Jubjub point internally. [Compact issue #953](https://github.com/LFDT-Minokawa/compact/issues/953#issuecomment-7147120696)

All 15 checks passed, including reuse by a second registry with its own grant. The generated circuits rejected direct and wrong-caller requests, altered arguments, replay, expired grants and revoked grants. The experiment uses a single-slot ACC fixture with fee balancing disabled. Production Passport integration and Preview admission remain untested.

## Run

Run these commands from this directory with Node.js 22 and Compact 0.36.1 installed.

```sh
npm ci
./run.sh
```

The prover reads `bls_midnight_2p13` and `bls_midnight_2p14` from `~/.cache/midnight/zk-params/`. Set `MIDNIGHT_ZK_PARAMS` for another parameter directory or `COMPACTC` for a standalone compiler.
