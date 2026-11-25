# Non-payment grants

In this experiment, a registry uses a caller-pinned grant to update an ACC-owned name without moving funds. On Compact 0.36.1, the in-memory Midnight ledger verified both contract proofs and applied the resolver update and grant nonce increment in one transaction.

The registry hashes the name and proposed resolver, then calls its recorded owner ACC. The signature binds a deployer-chosen tag, ACC, registry, operation, arguments, grant issuance, and nonce. The probe uses the local ledger’s name as the tag. Compact 0.36.1 exposes no network ID to the circuit, so deployments on different networks can choose the same tag. [Compact kernel reference](https://github.com/LFDT-Minokawa/compact/blob/compactc-v0.36.1/doc/ledger-adt.mdx#kernel)

The grant trusts the pinned registry address. Any circuit at that address, including one added through maintenance, can present a previously signed request while its nonce is current. The registry is responsible for binding that request to the intended action. Issuing a grant to a second registry replaces the first grant in the fixture’s single slot.

The registry passes the signature announcement as two fields. For both the grantee key and announcement, the ACC checks the Jubjub curve equation, excludes the identity, and requires prime-order subgroup membership. The probe covers off-curve, identity, order-two, and mixed-order inputs for both. The pinned runtime traps when its native decoder receives the mixed-order test point. ZKIR also constrains subgroup membership when proving. [ZKIR 3.2.1](https://github.com/midnightntwrk/midnight-zkir/blob/7a51b3385bbf4bce3604df87a7c70867c9ab43c0/zkir/src/ir_instructions/from_coordinates.rs#L89-L99) · [Subgroup constraint](https://docs.rs/midnight-circuits/7.3.0/src/midnight_circuits/ecc/native/edwards_chip.rs.html#786-800)

**Ledger checks.** Against the same starting state, the ledger rejects a proven update at the grant’s expiry second and accepts it one second earlier. Both times are within the transaction lifetime. A separate transaction calls the ACC twice and consumes two successive nonces.

**Runtime checks.** The generated JavaScript rejects direct, user-address, and wrong-contract callers. It also rejects invalid points, a mismatched deployment tag, altered requests, replay, and inactive grants before proof generation. The user-address test supplies that context explicitly. Fee balancing is disabled in the local ledger. Production Passport integration and Preview admission remain untested.

## Run

From this directory, run `npm test` with Node.js 22 and Compact 0.36.1 installed. It installs the locked dependencies, compiles both contracts, and runs the probe. Calling `./run.sh` directly performs the same steps.

The prover reads `bls_midnight_2p13` and `bls_midnight_2p14` from `~/.cache/midnight/zk-params/`. Set `MIDNIGHT_ZK_PARAMS` for another parameter directory or `COMPACTC` for a standalone compiler.
