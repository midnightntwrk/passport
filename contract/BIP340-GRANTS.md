# BIP-340 scoped grants

The `bip340` arm verifies BIP-340 Schnorr signatures over secp256k1 for
**scoped grant withdrawals only**. It builds on the verifier experiment in
[PR #190](https://github.com/midnightntwrk/passport/pull/190).

Existing owner arms issue, revoke and revoke all grants. BIP-340 has no
bootstrap, device entry, owner operation, grant-management or recovery
authorisation circuit. A grant never installs a device. The owner type
`Arm` remains `jubjub | k256 | p256`; the separate `GrantArm` adds `bip340`.

This is an authorisation boundary, not a ban on reusing private-key material.
An owner could independently enrol a secp256k1 ECDSA device using the same
underlying scalar. Possession of a BIP-340 grant alone does not create that
device entry or grant its privileges.

## Contract surface

The only mutable BIP-340 exports are:

- `withdraw_unshielded_with_grant_bip340`
- `withdraw_shielded_with_grant_bip340`
- `withdraw_shielded_to_contract_with_grant_bip340`

They reuse the existing custody operations and scope checks: operation flags,
token colour, recipient and caller restrictions, per-call and cumulative
caps, expiry, revocation, generation and recovery epoch. Shielded withdrawals
also enforce the consumed coin's value bound and the live encryption key.
Successful calls update their grant's nonce and spent commitment, the custody
state and round. They do not change owner or recovery authority.

The ledger schema remains `spec_version = 3`. The existing `GrantRecord`
stores no signature-scheme field. Its key commits to the scheme instead:

```text
grant_id = SHA256(pad32("midnight:account:grant:id:b1:v1")
                  || account || x_only_public_key || origin_hash || slot)
```

The public key is 32 big-endian bytes; the signature is the 64-byte BIP-340
`r || s` encoding. The untrusted `bip340LiftX` witness supplies the even-Y
curve point. The circuit constrains its canonical x coordinate, parity and
nonidentity, so the signed public key uniquely determines the accepted lift.
Invalid signatures or malformed witnesses abort the call.

The compiled witness interface now includes `bip340LiftX`. The existing
`makeWitnesses()` helper supplies it; custom witness providers must implement
it when updating to this contract build.

## Signed message

The signer signs the **exact 32-byte ACC challenge**, without an additional
prehash or wallet envelope. Each operation uses
`midnight:account:grant:auth:b1:v1:<operation>`, padded to 64 bytes and hashed
to form its domain tag. The challenge binds the tag, account address,
x-only public key, grant ID, issuance counter, operation arguments and the
grant's current nonce. Shielded challenges additionally bind the actual
held coin, change entry and encryption key.

The `b1` tag distinguishes this profile from existing ECDSA and JubJub
grants while fitting the existing fixed-width tag encoding. It is not the
connector's reserved `schnorr_bip340` envelope profile. There is no connector
integration. `origin_hash` namespaces a grant; it does not attest the site
that requested a signature. A signing service must authorise the request
rather than expose the grant key as an unrestricted signing service.

`Bip340Grantee`, `bip340GrantChallenges` and `grantAuthArgs` provide the local
signing and encoding helpers. Existing owner-signed `issue_grant_with_*`
circuits accept the derived grant ID and scope without new issuance APIs.
The three new verifier keys are installed in the grant maintenance phase;
they are never part of the initial owner roster.

## Validation

From `contract/`, after installing dependencies and compiling:

```sh
npm run test:bip340-grants-offline
npm run test:grants-offline
npm run test:grants-caller-offline
npm run test:toolchain-offline
npm run measure:bip340-grants
```

The offline suite exercises generated ACC execution, including successful
unshielded withdrawal, unchanged owner/recovery state, scope and replay
rejections, recovery invalidation and shielded checks before custody sends.
It does not execute successful shielded transfers.

With the local proof server on `127.0.0.1:6391`:

```sh
npm run prove:bip340-grants
```

The proof harness uses simulated owner issuance and funding, then checks and
proves the actual unshielded grant circuit. The original ZKIR must also
reject a forged signature assignment. Proof-server generation includes its
verification step. This is not node admission or independent native proof
verification; the experiment's native verifier supports only its own probe.

[Circuit measurements](evidence/bip340-grants/circuit-sizes.json) cover the
complete ACC operations, rather than the standalone verifier probe:

| Operation | Rows | k |
|---|---:|---:|
| Unshielded withdrawal | 135,326 | 18 |
| Shielded withdrawal | 162,823 | 18 |
| Shielded withdrawal to a contract | 168,546 | 18 |

Each proving key is approximately 448 MiB; each verifier key is 2,745 bytes.
This increase over the experiment must be considered in the deployment and
proving budget. [Proof evidence](evidence/bip340-grants/proofs.json) records
the actual unshielded proof and negative checks, with source and artefact
hashes. Independent cryptographic review and end-to-end node coverage,
including successful shielded withdrawals, remain necessary before adoption.
