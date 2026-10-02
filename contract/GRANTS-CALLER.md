# Caller-bound scoped grants

Compact **0.35.0** / runtime **0.20.0** exposes `kernel.caller()`.
An owner may now pin a grant to an immediate calling contract. The
account checks this itself, before its spend and grant-settlement chips,
on both grant arms and all six spend circuits. The P-256 device arm,
which landed on `main` after this work, issues grants through the same
scope digest and spends through the same gate, so it carries the caller
pin as well; the evidence below does not exercise that arm.

```ts
const scope = spendScope({
  withdrawUnshielded: true,
  color,
  cap: 100n,
  perCallCap: 10n,
  caller: contractAddressBytes, // 32 bytes; omit for unrestricted callers
});
await account.issueGrant(owner, grantId, scope, freshScopeSalt);
```

The grantee signs the same operation challenge as before. A pinned grant
must be invoked through the pinned contract; direct wallet invocation
fails. The contract caller does not replace the grantee's signature,
nonce, expiry, object openings or spend bounds. A read-only grant cannot
carry a caller pin.

## Meaning and encoding

- `kernel.caller()` is `Maybe<Either<ContractAddress, UserAddress>>`.
  Restricted grants require `some(left(contract))`; none and user
  addresses fail closed. For `A -> B -> account`, the caller is **B**.
- The address comes from the kernel, never from a caller-supplied grant
  argument. The proof binds the transcript and ledger admission checks
  that read against the real call context.
- `caller_commit = SHA-256(pad32("midnight:account:grant:caller:v1") ||
  scope_salt || contract_address_bytes)`. All-zero is the unrestricted
  sentinel; a present hash colliding with that sentinel is rejected.
- Issuance takes `caller: Maybe<ContractAddress>` after `window_cap` and
  before `scope_salt`. Absent requires an all-zero value. The scope:v2
  digest appends the 32-byte commitment, so the owner's signature binds
  the choice. TypeScript `PlainScope.caller` and Rust JSON `scope.caller`
  are optional (Rust uses hex address bytes).
- Unrestricted grants **do not read caller**. This avoids the 0.35.0
  top-level mismatch where off-chain execution reads none but balancing
  adds single-owner inputs from which the ledger derives a user address.

This authenticates the ledger's immediate **claiming contract address**,
not a browser origin, transaction root, fee payer or calling circuit.
A contract exposing arbitrary `claimContractCall` tuples can lend its
identity (the existing [P9 experiment](../experiments/cross-contract-calls/README.md)).
The caller contract's own claim policy matters; upgrading that contract
does not change its address. The restriction bit and exercised call
relationships are public, although the unused pin is salted in state.

## Compatibility

`spec_version = 3` adds `caller_commit` to `GrantScope` (196 bytes;
approximately 309 bytes per record including its map key).
`midnight:account:grant:scope:v2` hashes eighteen elements / 309 bytes.
All new issue signatures, including unrestricted grants, use that digest.
Grant identities and operation challenges retain their domains.

This is a **fresh-deployment schema**, not a maintenance upgrade of v2.
The account still has 36 circuits; its deployment keeps the
15,000-verifier-byte budget and takes seven waves on either initial arm.
The device-wide revocation issue is separate from this schema change.

## Reproduction and evidence

**2026-10-01 result: PASS.** [Conformance evidence](evidence/grants-caller/conformance.json)
records eight accepted transactions after deployment/activation, three
local refusals (direct, wrong caller, replay), and one genuinely proved
submission refused by the node. The submitted transaction hash matches
the node diagnostic: the caller read expected contract B but the actual
caller was absent (RPC error 104). Revoke/reissue with a fresh salt then
permits an unrestricted direct spend; the final account balance is 85
from a deposit of 100 and three accepted withdrawals of 5.

Offline validation passed: 127 grant regression checks, the dedicated
caller matrix, TypeScript, unit vectors, SDK/artifact smoke, recovery
simulation, cross-implementation signing and 36 Rust tests. All 36 account
circuits and the test scaffolding have generated keys; the forwarding
probe's two circuits use the encoding described below.

From `contract/` with the pinned local stack running:

```sh
npm ci
npm run compile
npm run build
npm run test:unit
npm run test:grants-offline
npm run test:grants-caller-offline
cargo test --manifest-path signer-rs/Cargo.toml
WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001 EVIDENCE_DIR=evidence/grants-caller npm run test:grants-caller
```

Set `MIDNIGHT_NODE_CONTAINER` to the local node container name to also
capture and assert the exact caller-read mismatch, correlated by submitted
transaction hash. Without it the forged-context control asserts node RPC
error 104 (guaranteed execution failure) and unchanged grant state.

- `grants-caller-offline.ts`: both grantee arms, all six spend gates,
  correct/wrong/absent/user callers, signed-policy binding, bad signature,
  replay, read-only rejection, and identical unrestricted transcripts
  under different caller contexts. Injected simulator contexts establish
  circuit predicates, not ledger authentication.
- `grants-offline.ts`: the existing grant regression suite, plus pinned
  issuance and tamper rejection on both device arms.
- `src/tests/vectors/grants-v3.json`: 36 independent Compact/TypeScript/Rust hash
  vectors plus the existing signature vectors. Historical `grants-e1.json`
  remains the scope:v1 evidence.
- `grants-caller.ts`: real JubJub-grantee unshielded spends via B and via
  A -> B, wrong/direct/replay refusals, a forged-context admission control,
  and unrestricted direct spend after revoke/reissue. The forwarding
  probe discloses all its arguments and is test scaffolding.

The account builds with ZKIR **3.1**. The test-only forwarding contract
builds with the default **2.0** encoding: Compact 0.35.0's v3 backend
panics on forwarded curve-point arguments (`cannot convert JubjubPoint
to "Native"`; likewise for `Secp256k1Point`). The composed node tests
therefore use the JubJub forwarding path; k256 and shielded caller
predicates are covered offline. The proxy remains on the same compiler,
runtime and ledger pins.
