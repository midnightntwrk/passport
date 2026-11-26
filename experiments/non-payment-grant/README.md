# Non-payment grants

In this experiment, a registry uses a caller-pinned grant to update an ACC-owned name without moving funds. On Compact 0.36.1, the in-memory Midnight ledger verified both contract proofs and applied the resolver update and grant nonce increment in one transaction.

The registry hashes the name and proposed resolver, then calls its recorded owner ACC. The signature binds a deployer-chosen tag, ACC, registry, operation, arguments, grant issuance, and nonce. The probe encodes the local ledger’s name as UTF-8, accepts up to 32 bytes, and zero-pads shorter tags. Compact 0.36.1 exposes no network ID to the circuit, so deployments on different networks can choose the same tag. [Compact kernel reference](https://github.com/LFDT-Minokawa/compact/blob/compactc-v0.36.1/doc/ledger-adt.mdx#kernel)

The holder issues one grant with a set of allowed immediate callers. The fixture accepts one required contract address and one optional address for a parent or second contract. Reissuing replaces the whole set. All members share the grant’s expiry, revocation, and nonce. Each signature binds the address that will actually call the ACC.

| Route | Required audience member |
| --- | --- |
| Parent → ACC, or child → parent → ACC | Parent |
| Parent → child → ACC | Child |
| Child → ACC | Child |

The holder explicitly trusts every listed address, including its circuits after maintenance. The calling contract binds the signed request to its action. The probe uses a public set to demonstrate routing on a non-payment action. Applying the same rule to transfers would require extending the spend grant’s current single-caller commitment and preserving the existing withdrawal limits. [Scoped-grant caller restriction](../../docs/mps-mip/mips/mip-xxxx-scoped-grants.md#621-immediate-contract-caller-restriction)

The registry passes the signature announcement as two fields. For both the grantee key and announcement, the ACC checks the Jubjub curve equation, excludes the identity, and requires prime-order subgroup membership. The main probe checks the explicit rejections for off-curve points, the identity, and order-two points. Each mixed-order diagnostic runs in a fresh Node process and ends when the pinned WASM decoder traps inside `ecMul`. These two inputs never reach the failing branch of the Compact subgroup assertion. That branch has no negative test. ZKIR also constrains subgroup membership when proving. [ZKIR 3.2.1](https://github.com/midnightntwrk/midnight-zkir/blob/7a51b3385bbf4bce3604df87a7c70867c9ab43c0/zkir/src/ir_instructions/from_coordinates.rs#L89-L99) · [Subgroup constraint](https://docs.rs/midnight-circuits/7.3.0/src/midnight_circuits/ecc/native/edwards_chip.rs.html#786-800)

**Ledger checks.** Against the same starting state, the ledger rejects a proven update at the grant’s expiry second and accepts it one second earlier. Both times are within the transaction lifetime. The fixture uses zero seconds of block-time tolerance (`secondsSinceEpochErr = 0`) and supplies the same timestamp to verification and application. A live node can advance its admission clock relative to wall time. [Passport expiry semantics](../../docs/mps-mip/mips/mip-xxxx-scoped-grants.md#L2237-L2243) The probe also checks the caller recorded for both parent-direct and child-relayed authorisations under the same grant. A separate transaction calls the ACC twice and consumes two successive nonces.

**Runtime checks.** The generated JavaScript rejects direct, user-address, and wrong-contract callers. It also rejects invalid points, a mismatched deployment tag, altered requests, replay, and inactive grants before proof generation. The user-address test supplies that context explicitly. Fee balancing is disabled in the local ledger. Production Passport integration and Preview admission remain untested.

## Run

From this directory, run `npm test` with Node.js 22 and Compact 0.36.1 installed. It installs the locked dependencies, compiles both contracts, and runs the probe. Calling `./run.sh` directly performs the same steps.

The prover reads `bls_midnight_2p9`, `bls_midnight_2p13`, and `bls_midnight_2p14` from `~/.cache/midnight/zk-params/`. Set `MIDNIGHT_ZK_PARAMS` for another parameter directory. Set `COMPACTC` to the executable path only (paths with spaces work). Leave it unset to use `compact compile +0.36.1`.
