# C5 · Signing primitive

**Serves:** P6.

## Outcome

The cryptographic operation by which a device authorises Passport
account operations. **Set in stone by the account-authorisation MIP,
published upstream as MIP-0013**: Schnorr on JubJub per device,
verified in-circuit, instantiating the custody MIP's (MIP-0012)
authorisation seam. Independent of MCS / threshold-Schnorr at the
cross-chain layer (which is owned upstream).

The specified shape, answering this canvas's former open question on
the in-circuit variant:

- **Challenge** — `persistentHash` over a preimage binding a
  per-circuit domain-separation tag (derived unconditionally as
  `persistentHash` of the tag zero-padded to 64 bytes), the account's
  contract address, the signature announcement, the device public key,
  the full argument list, the witness values the call will consume
  (AUTH-10 — for a spend, the approver signs over the exact qualified
  coin), a dedicated authorisation counter (`auth_nonce`, advanced
  only by seam-gated calls, so permissionless deposits cannot
  invalidate a pending signature), and the grinding nonce. A signature
  authorises exactly one call, with exactly these inputs, on exactly
  one account.
- **Challenge hash** — `persistentHash` is **SHA-256 over the
  compiler's field-aligned encoding**, not Poseidon (`transientHash`
  is the Poseidon-family one). Chosen for its cross-upgrade stability
  contract: device commitments live in ledger state, the deployed
  circuit is frozen while signers are rebuilt continually, and
  independent signers need a challenge function with a fixed public
  definition. The signer grinds a nonce until the challenge falls
  below the JubJub subgroup order (~17.5 expected hash evaluations).
- **Verification** — `s·G == R + c·pk` via `ecMulGenerator`, `ecMul`,
  `ecAdd`: native Compact built-ins, no foreign-field arithmetic.
- **Keys** — per-device JubJub keypairs, mutually independent, no HD
  tree (the MIP's seedlessness invariant). Rotation is an add/remove
  ceremony; revocation totality comes from the epoch mechanism.
- **Threshold profile** — a t-of-n FROST committee registers as a
  single device entry presenting the joint public key; signature
  shares aggregate per RFC 9591 and the key is never reconstructed.
  The verifier is unchanged — the contract cannot tell one signer from
  a quorum.
- **Approval / proving separation** — the signer needs JubJub
  arithmetic and SHA-256 only (no node, prover, or contract runtime);
  the prover holds the signature, never the key, and can at most
  execute the one approved call.

Verified end-to-end across language boundaries: the TypeScript rig
(`experiments/redjubjub-wallet/`) and the pure-Rust rig
(`experiments/redjubjub-wallet-rs/`) produce interchangeable
signatures against the same deployed in-circuit verifier. The
reference implementation (`contract/`) carries this forward as
MIP-0013 conformance test 7: an independent Rust signer built on the
published ledger crates produces bit-exact challenges and accepted
signatures against the deployed standard contract.

## Dependencies

- **C4** — resolved to stateless contract custody; the custody MIP's
  seam semantics are what this primitive instantiates.
- **C8** — domain-separation registry. The MIP names its tags against
  the MPS-0027 registry: `midnight:account:device:v1` for device
  commitments and `midnight:account:auth:v1:<circuit>` for challenges.
  Ratification of the registry remains the C8 deliverable.
- **C7** — witness handling; the authorising material (signature, not
  key) is transaction witness data.
- **C6** — proof generation consumes the signature as witness.
- **C9** — device-bound auth produces / gates the key that signs.
- **C16** — wallet local storage holds the per-device key.
- **External** — `experiments/redjubjub-wallet/` and
  `redjubjub-wallet-rs/` for the verified implementation; an audited
  MIT-licensed threshold-signatures library (FROST-style RedDSA over
  JubJub with DKG) for the threshold path.

## Open questions

**Cryptographer review.** The SHA-256 Fiat–Shamir substitution (in
place of RedJubjub's BLAKE2b), challenge grinding and scalar-domain
alignment, subgroup/cofactor semantics of Compact's point operations,
and nonce-generation guidance. An explicit acceptance criterion in the
MIP's Path to Active — until it concludes, the scheme is
experimentally validated, not reviewed.

**FROST ciphersuite profiling.** JubJub with the persistentHash
challenge is a new FROST ciphersuite; its specification and a t-of-n
committee demonstration against an unmodified contract are tracked in
the MIP's Path to Active.

**Cross-curve composition.** Passport user-side stays JubJub.
Cross-chain operations rely on the upstream MCS for foreign-chain
signatures; the user signs the trade intent in JubJub, MCS handles the
foreign-chain side.

**Upstream convergence.** Two upstream twins of this primitive have
appeared and need an alignment decision. The Compact 0.33.0 standard
library ships `jubjubSchnorrVerify` and a `JubjubSchnorrSignature`
type; the ledger's transient-crypto crate now carries its own JubJub
Schnorr whose challenge is an **untagged** Poseidon `transientHash`
over the announcement, public key, and message — diverging from
MIP-0013's domain-separated, cross-upgrade-stable `persistentHash`
challenge on exactly the two grounds the MIP argues (no
domain-separation tag; a hash family that is unstable across
upgrades). To check: whether the stdlib gadget can carry the MIP's
challenge, and whether upstream will adopt the DST discipline.
Related: the wallet SDK's next major makes every signing entry point
asynchronous, citing threshold-MPC coordinators — the FROST-shaped
seam the threshold profile needs is appearing upstream. Separately,
the next ledger line adds native ECDSA-secp256k1 ledger keys, which
together with the verified maintenance-authority upgrade path meets
both preconditions of the earlier "ECDSA deferred until upgradability
and native ECDSA" ruling — worth a deliberate re-visit, not an
automatic switch.

## Failure modes

**Curve mismatch with consumer.** A consumer (e.g., dApp verifier)
expects ECDSA-secp256k1 and Jubjub Schnorr is unrecognised. *Detection:*
third-party verification fails. *Note:* MIP-0003 ledger keys are
unaffected — this primitive authenticates account operations inside
circuit logic, not transactions.

**Signing surface leak.** Implementation accidentally exposes signing API
beyond the trusted boundary. *Detection:* code review reveals callable
signing path from outside the secure boundary.

**Nonce reuse or bias.** Reusing the Schnorr nonce across two distinct
challenges reveals the device key algebraically; biased nonces admit
lattice recovery. *Mitigation:* hedged deterministic derivation
(RFC 6979-style) per the MIP; FROST nonce-commitment discipline for
threshold devices.

**Toolchain equality hazard.** compact-runtime 0.15.0 compiled `==` on
`JubjubPoint` to reference equality, silently breaking verification
off-circuit ([LFDT-Minokawa/compact#278](https://github.com/LFDT-Minokawa/compact/issues/278)).
*Mitigation:* the MIP's rejection-matrix conformance tests catch a
verifier that accepts or rejects everything; pin toolchain versions.

**`ownPublicKey()` impersonation in caller-identity-dependent
contracts.** Any contract that uses Compact's `ownPublicKey()` as the
authorisation check is bypassable — the value is wallet-supplied and
unverified. Per upstream clarification
([LFDT-Minokawa/compact#283](https://github.com/LFDT-Minokawa/compact/issues/283)),
it was never intended for authentication. Both MIP drafts prohibit it;
this primitive is the safe pattern.

## Alternatives

**A — Schnorr-on-Jubjub per device.** **Chosen — specified by the
account-authorisation MIP; v1.0 deliverable.** Validated by the
redjubjub experiments.

**B — FROST committee under user control.** Subsumed by A: the MIP's
threshold profile registers any t-of-n committee as a single device
entry; the verifier is unchanged.

**C — Per-device with periodic rotation.** Available under A via the
add/remove-device ceremonies; no protocol change.

**D — FROST-Jubjub via partner-operated MPC committee with DKG.** **MVP
model (managed signing).** A partner runs MPC nodes; user authenticates
via OAuth2-shaped flow with a passkey registered to the MPC auth
provider. DKG ensures no node ever reconstructs the user's private key.
Same verification equation as A — the contract cannot tell the
difference — but **violates P8** (the MPC operator is a required
service). The v1.0 deliverable retires this in favour of A.
