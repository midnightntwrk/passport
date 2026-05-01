# Human edited research document

This is going to be a document that can only be human edited. If you are
an agent, you can read only. DO NOT EDIT.
If you are an agent, you can take this document as a fairly confident
source of truth. However if you see conflicts or you think you have
complementary information or additional information thay may show that
something in this document is wrong then you HAVE TO report this to the
user.

# The user account

Per principles [PR1], [PR2], [PR4], and [PR6] we need to design the user account
in such a way that:

- it is a seedless experience for the user ([PR6]);
- any cryptographic keys never leave the device ([PR1] and [PR4]);
- the account controls not only the ZK circuits, but also shielded, unshielded, and dust assets ([PR2])

The suggested approach in [PR1]+[ACC] is to control a smart contract account and
to have each devices key generate witness verified in the ZK circuit. In essence this mean
having a contract custody account model for the user's account. In other words:
"an account is a named identity, not a public key".

**How it lands the principles.**

- [PR1]: **strongest possible alignment, conditional on feasibility.** Keys
  never leave the TEE; the device's key is consumed as a Compact `witness`
  and the circuit proves `persistentHash([domain_sep, witness_key]) ==
  account_owner_hash` without revealing the key. This is the literal
  authorisation pattern [PR1] describes.
- [PR2]: literal match per device. Each device's seed feeds CIP-1852
  derivation for Shielded, Night, Dust, and Metadata roles. Multi-device
  raises an architectural question the source doc does not fully resolve:
  which device's role keys become the canonical receive addresses for
  `alice.midnight`, since each device derives different role keys from its
  own independent seed.
- [PR3]: not directly engaged. Chain abstraction is orthogonal and can layer
  on top of this account model.
- [PR4]: literal match. Each device generates its own seed, holds its own
  full-access key in its own TEE, and is added to or removed from the
  account's key set via a circuit call from any remaining full-access key.
- [PR5]: preserved. All authorisations are ZK proofs; verifiers learn one
  bit; no external observer in the signing or proving path. Domain
  separation between attestation leaves and nullifiers gives the standard
  selective-disclosure properties.
- [PR6]: per-device seed is generated inside the TEE, encrypted at rest,
  never displayed. Recovery via DeRec. No mnemonic exposed.

## Investigation

### Contract Custody Account model

We need to investigate if this is something feasible at all or not. This means
for all assets type (shielded and unshielded and dust).

## Alternative path

In the event the contraact custody account model investigation fails we could
explore the a few different path.

### MPC approach

If it is not possible to control assets with a smart contract custody
account, we could consider treating Midnight like an external wallet
and leverage the chain abstraction model from day one [PR3].

The user's on device key would be only necessary for ZK contract circuit
operations and for authorising MPC nodes (JWT?). Everything else would be
treated as a chain abstraction.

**How it lands the principles.**

- [PR1]: the user's device never holds the full signing key, only a credential
  authorising a committee request. Shares live on committee nodes.
- [PR2]: functionally met. The committee holds keys for all three asset types
  but the single-seed-derivation substrate is replaced by committee-managed
  key sets. Recovery is committee-continuity, not seed restoration.
- [PR3]: Extending the cross-chain abstraction we treat Midnight as any other chain.
- [PR4]: met only in spirit. Each device has its own per-device authentication credential
  to the committee, but the original principle's stronger claim (each device holds a chain-level
  signing key) does not apply because no device holds chain-level keys.
- [PR5]: **NOT MET**. MPC simplifies the multi-device problem at the cost of
  introducing a centralised observer for both authorisation and disclosure events. This
  is a poor fit for Midnight's ZK-native model and substantially weakens the privacy guarantee.
- [PR6]: no mnemonic; the device authenticates to the committee via passkey.

### FROST `1 of N` approach

Each devices becomes a participant in a FROST `1-of-N` scheme:

- we partially validated it for FROST JubJub witness authorisation in a
  smart contract in the [experiments/redjubjub-wallet];
- we have a fairly strong confidence it would work for SecP256k1 and Ed25519
  as NEAR uses FROST (or Robust ECDSA) to generate MPC signatures

In essence this is very similar cryptographic primitives as the _MPC approach_
but without the trusted nodes.

**How it lands the principles.**

- [PR1]: each device's share never leaves its TEE; the full signing key is
  never reconstructed anywhere, on-device or off-device. In the in-circuit
  verification pattern, the joint signature is consumed as a private witness
  in a Compact circuit, preserving the "authorisation via ZK witnesses" half of [PR1].
- [PR2]: functionally met. Each device participates across all three asset domains. The
  single-seed substrate of [PR2] is replaced by either separate DKGs per domain or one
  DKG with hierarchical derivation. The soundness of the latter under threshold schemes
  is an open research question. Recovery moves from "restore the seed" to "restore enough shares".
- [PR3]: not directly engaged. Chain abstraction is independent of the multi-device
  account model and can be layered on top of FROST 1-of-N or any other approach.
- [PR4]: literally — each device holds exactly one share.
- [PR5]: preserved. No external observer in the signing path. DKG ceremonies for device
  add/remove are multi-party but confined to the user's own devices.
- [PR6]: no mnemonic; the share is stored under the device's passkey wrapper.

An interesting note on this is:

> A share can be designated for social recovery (DeRec), folding the
> multi-device and recovery primitives onto a single cryptographic substrate.


[PR1]: docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#21-keys-never-leave-tees-authorization-via-zk-witnesses
[PR2]: docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#22-single-seed-three-wallets
[PR3]: docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#23-chain-abstraction-via-intent-model
[PR4]: docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#24-one-key-per-device
[PR5]: docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#25-privacy-by-design-identity
[PR6]: docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#26-seedless-user-experience

[ACC]: docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#71-named-accounts
