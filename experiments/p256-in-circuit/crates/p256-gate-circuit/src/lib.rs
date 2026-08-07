//! NIST P-256 (secp256r1) ECDSA verification inside a midnight-zk circuit.
//!
//! Feasibility evidence for an MPS/MIP proposing first-class P-256 support in
//! Compact. The motivating use case is passkey device authentication
//! (WebAuthn, Secure Enclave, Android Keystore): those authenticators sign
//! with P-256 ECDSA over SHA-256, so a custody contract that wants to verify
//! a passkey assertion needs P-256 verification inside the proof system.
//!
//! Three [`midnight_zk_stdlib::Relation`] implementations are provided:
//!
//! * [`relations::P256EcdsaPreHashed`]: public key and 32-byte message hash
//!   are public inputs; the signature `(r, s)` is the witness.
//! * [`relations::P256EcdsaWebAuthn`]: same, except the hash is computed
//!   in-circuit with SHA-256 over `authenticator_data || client_data_hash`,
//!   exactly the byte string a WebAuthn authenticator signs when no
//!   extensions are present.
//! * [`relations::P256EcdsaPrivatePk`]: only the message hash is public; the
//!   public key itself is part of the witness (privacy variant: the verifying
//!   key set stays private).
//!
//! All three verify textbook ECDSA (SEC 1, version 2.0, section 4.1.4):
//! either of `(r, s)` and `(r, n - s)` satisfies the relation. This
//! malleability is documented by an explicit test and feeds the low-S policy
//! discussion in the MIP.
//!
//! # Recursion leg
//!
//! The crate additionally measures out-of-chain proving: a device proves
//! knowledge of a signature off-chain with the scheme its hardware supports
//! (the inner proof), and an on-chain circuit verifies that proof
//! in-circuit. Two further inner relations cover the other device schemes:
//!
//! * [`ed25519::Ed25519Verify`]: Ed25519 (RFC 8032) verification, ported
//!   from midnight-zk's `cardano_signature.rs` example.
//! * [`jubjub_schnorr::JubjubSchnorrVerify`]: Schnorr over the native
//!   embedded curve JubJub with a Poseidon challenge, ported from
//!   midnight-zk's `schnorr_sig.rs` example (the MIP-0013 device scheme).
//!
//! [`wrapper::ProofWrap`] is the outer relation that verifies an inner
//! proof in-circuit; [`wrapper::verify_wrapped`] is the ONLY sound way to
//! verify a wrapped proof (the in-circuit verifier defers the final KZG
//! pairing check to the native side; see the `wrapper` module docs).

pub mod ed25519;
pub mod jubjub_schnorr;
pub mod relations;
pub mod vectors;
pub mod wrapper;
