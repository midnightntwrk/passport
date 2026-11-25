# Non-payment grants

In this experiment, a registry uses a caller-pinned grant to update an ACC-owned name without moving funds. On Compact 0.36.1, the in-memory Midnight ledger verified both contract proofs and applied the resolver update and grant nonce increment in one transaction.

The registry hashes the name and proposed resolver, then calls its recorded owner ACC. The signed challenge binds the deployment network tag, ACC, registry, operation, arguments, grant issuance, and nonce. Deployment supplies the ledger network ID to the ACC constructor. The fixture has one grant slot. Issuing a grant to a second registry replaces the first registry’s grant.

The registry passes the Jubjub announcement as two fields. The Compact JavaScript constructor only packages those coordinates, so the ACC explicitly checks the curve equation and rejects the identity. ZKIR’s `from_coordinates` constrains the supplied coordinates to the prime-order subgroup when proving. [Runtime constructor](https://unpkg.com/@midnight-ntwrk/compact-runtime@0.21.0/dist/built-ins.js) · [ZKIR 3.2.1](https://github.com/midnightntwrk/midnight-zkir/blob/7a51b3385bbf4bce3604df87a7c70867c9ab43c0/zkir/src/ir_instructions/from_coordinates.rs#L89-L99) · [Subgroup constraint](https://docs.rs/midnight-circuits/7.3.0/src/midnight_circuits/ecc/native/edwards_chip.rs.html#786-800)

**Ledger checks.** The probe submits the same signed, proven update against the same starting state at two block times within its transaction lifetime. The ledger rejects it after grant expiry and applies it before expiry. A second transaction calls the same ACC twice and consumes two successive nonces.

**Runtime checks.** The generated JavaScript rejects direct, user-address and wrong-contract callers, malformed announcements, altered requests, replay, and inactive grants before proof generation. The user-address test supplies that context explicitly. Fee balancing is disabled in the local ledger. Production Passport integration and Preview admission remain untested.

## Run

Run these commands from this directory with Node.js 22 and Compact 0.36.1 installed.

```sh
npm ci
./run.sh
```

The prover reads `bls_midnight_2p13` and `bls_midnight_2p14` from `~/.cache/midnight/zk-params/`. Set `MIDNIGHT_ZK_PARAMS` for another parameter directory or `COMPACTC` for a standalone compiler.
