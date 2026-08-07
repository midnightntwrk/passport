//! Test vectors for the signature relations.
//!
//! P-256 sources:
//!
//! 1. Vectors generated deterministically with the RustCrypto `p256` crate
//!    (RFC 6979 nonces, so re-generation is bit-stable).
//! 2. One NIST CAVP FIPS 186-4 ECDSA SigVer known-answer vector, copied
//!    literally.
//!
//! Recursion-leg inner relations:
//!
//! 3. An Ed25519 vector generated with `ed25519-dalek` (deterministic
//!    signing per RFC 8032, so re-generation is bit-stable) from a
//!    hardcoded secret key.
//! 4. A JubJub Schnorr vector produced by reproducing the keygen/sign logic
//!    of midnight-zk's `zk_stdlib/examples/schnorr_sig.rs` with fixed
//!    (deterministic) secret key and nonce instead of an RNG.

use ed25519_dalek::{Signer, SigningKey as Ed25519SigningKey};
use ff::PrimeField;
use group::Group;
use hex_literal::hex;
use midnight_circuits::{hash::poseidon::PoseidonChip, instructions::hash::HashCPU};
use midnight_curves::{
    p256::{affine_from_xy, Fp, Fq, P256},
    Fr as JubjubScalar, JubjubAffine, JubjubExtended as Jubjub, JubjubSubgroup,
};
use p256::{
    ecdsa::{
        signature::hazmat::{PrehashSigner, PrehashVerifier},
        Signature, SigningKey, VerifyingKey,
    },
    elliptic_curve::sec1::ToEncodedPoint,
};
use sha2::{Digest, Sha256};

use crate::{
    ed25519::ED25519_ENC_LEN,
    jubjub_schnorr::JubjubSchnorrSignature,
    relations::{AUTHENTICATOR_DATA_LEN, DIGEST_LEN, F},
};

/// A `(pk, hash, r, s)` tuple matching the instance/witness split of
/// `P256EcdsaPreHashed` (and, reshaped, `P256EcdsaPrivatePk`).
#[derive(Clone, Debug)]
pub struct PreHashedVector {
    /// The P-256 public key.
    pub pk: P256,
    /// The 32-byte SHA-256 message digest.
    pub hash: [u8; DIGEST_LEN],
    /// Signature scalar `r`.
    pub r: Fq,
    /// Signature scalar `s`.
    pub s: Fq,
}

/// A WebAuthn-shaped vector matching the instance/witness split of
/// `P256EcdsaWebAuthn`.
#[derive(Clone, Debug)]
pub struct WebAuthnVector {
    /// The P-256 public key.
    pub pk: P256,
    /// The 37-byte authenticator data (rpIdHash || flags || signCount).
    pub authenticator_data: [u8; AUTHENTICATOR_DATA_LEN],
    /// SHA-256 of the (synthetic) clientDataJSON bytes.
    pub client_data_hash: [u8; DIGEST_LEN],
    /// Signature scalar `r`.
    pub r: Fq,
    /// Signature scalar `s`.
    pub s: Fq,
}

/// Fixed secret key for the deterministically generated vectors. Test-only
/// material; never use outside this experiment.
pub const GENERATED_SK_BYTES: [u8; 32] =
    hex!("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");

/// Fixed secret key for the "wrong public key" negative vector.
pub const WRONG_SK_BYTES: [u8; 32] =
    hex!("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");

/// Fixed message for the generated pre-hashed vector.
pub const GENERATED_MESSAGE: &[u8] =
    b"P-256 in a midnight-zk circuit: passkey evidence for the MPS/MIP";

// NIST CAVP FIPS 186-4 ECDSA SigVer known-answer vector.
//
// Source: CAVP "186-4 ECDSA Test Vectors" archive (186-4ecdsatestvectors.zip),
// file SigVer.rsp, section [P-256,SHA-256], a test case with Result = P (0),
// copied literally. The test suite sanity-verifies this vector with the
// RustCrypto `p256` crate (an independent implementation) before feeding it
// to the circuit, which guards against transcription errors.
const CAVP_MSG: [u8; 128] = hex!(
    "e1130af6a38ccb412a9c8d13e15dbfc9e69a16385af3c3f1e5da954fd5e7c45f"
    "d75e2b8c36699228e92840c0562fbf3772f07e17f1add56588dd45f7450e1217"
    "ad239922dd9c32695dc71ff2424ca0dec1321aa47064a044b7fe3c2b97d03ce4"
    "70a592304c5ef21eed9f93da56bb232d1eeb0035f9bf0dfafdcc4606272b20a3"
);
const CAVP_QX: [u8; 32] = hex!("e424dc61d4bb3cb7ef4344a7f8957a0c5134e16f7a67c074f82e6e12f49abf3c");
const CAVP_QY: [u8; 32] = hex!("970eed7aa2bc48651545949de1dddaf0127e5965ac85d1243d6f60e7dfaee927");
const CAVP_R: [u8; 32] = hex!("bf96b99aa49c705c910be33142017c642ff540c76349b9dab72f981fd9347f4f");
const CAVP_S: [u8; 32] = hex!("17c55095819089c2e03b9cd415abdf12444e323075d98f31920b9e0f57ec871c");

/// Parses a P-256 scalar from 32 big-endian bytes. Returns `None` if the
/// value is not canonical (greater than or equal to the group order).
pub fn scalar_from_be_bytes(bytes: &[u8; 32]) -> Option<Fq> {
    Option::from(Fq::from_repr((*bytes).into()))
}

/// Serialises a P-256 scalar to 32 big-endian bytes.
pub fn scalar_to_be_bytes(scalar: &Fq) -> [u8; 32] {
    scalar.to_repr().into()
}

/// Parses a P-256 point from big-endian x and y coordinate bytes. Returns
/// `None` if the coordinates are non-canonical or the point is off-curve.
pub fn point_from_xy_bytes(x: &[u8; 32], y: &[u8; 32]) -> Option<P256> {
    let x = Option::<Fp>::from(Fp::from_repr((*x).into()))?;
    let y = Option::<Fp>::from(Fp::from_repr((*y).into()))?;
    affine_from_xy(x, y).map(P256::from)
}

/// Serialises a P-256 point to big-endian x and y coordinate bytes.
///
/// # Panics
///
/// If the point is the identity (which has no affine coordinates).
pub fn point_to_xy_bytes(point: &P256) -> ([u8; 32], [u8; 32]) {
    let encoded = point.to_affine().to_encoded_point(false);
    let x: [u8; 32] = (*encoded.x().expect("non-identity point")).into();
    let y: [u8; 32] = (*encoded.y().expect("non-identity point")).into();
    (x, y)
}

/// The malleated twin of a signature scalar: `n - s`. The generated vectors
/// are low-S normalised at construction, so for them this produces the
/// genuinely high-S form (for a high-S input it would produce the low-S
/// form instead).
pub fn high_s_twin(s: &Fq) -> Fq {
    -*s
}

/// Out-of-circuit sanity check of a vector with the RustCrypto `p256` crate.
pub fn rustcrypto_verify(vector: &PreHashedVector) -> bool {
    let Ok(signature) =
        Signature::from_scalars(scalar_to_be_bytes(&vector.r), scalar_to_be_bytes(&vector.s))
    else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_affine(vector.pk.to_affine()) else {
        return false;
    };
    verifying_key
        .verify_prehash(&vector.hash, &signature)
        .is_ok()
}

fn sign_prehash_deterministic(sk_bytes: &[u8; 32], hash: &[u8; DIGEST_LEN]) -> (P256, Fq, Fq) {
    let signing_key = SigningKey::from_bytes(&(*sk_bytes).into()).expect("valid test secret key");
    let signature: Signature = signing_key
        .sign_prehash(hash)
        .expect("deterministic signing should not fail");
    // RustCrypto applies no low-S policy at signing (RFC 6979 fixes the
    // nonce, not the form of s), so normalise here: the generated vectors
    // are canonically low-S and [`high_s_twin`] genuinely produces the
    // high-S form.
    let signature = signature.normalize_s().unwrap_or(signature);
    let pk = P256::from(*signing_key.verifying_key().as_affine());
    (pk, *signature.r(), *signature.s())
}

/// Deterministic RustCrypto-generated vector: RFC 6979 signature with
/// [`GENERATED_SK_BYTES`] over `SHA-256(GENERATED_MESSAGE)`, low-S
/// normalised.
pub fn generated_prehashed() -> PreHashedVector {
    let hash: [u8; DIGEST_LEN] = Sha256::digest(GENERATED_MESSAGE).into();
    let (pk, r, s) = sign_prehash_deterministic(&GENERATED_SK_BYTES, &hash);
    PreHashedVector { pk, hash, r, s }
}

/// The public key of the unrelated keypair [`WRONG_SK_BYTES`], for negative
/// tests.
pub fn wrong_pk() -> P256 {
    let signing_key =
        SigningKey::from_bytes(&WRONG_SK_BYTES.into()).expect("valid test secret key");
    P256::from(*signing_key.verifying_key().as_affine())
}

/// The NIST CAVP FIPS 186-4 SigVer P-256/SHA-256 known-answer vector
/// (Result = P). The hash is computed from the literal 128-byte CAVP
/// message.
pub fn cavp_prehashed() -> PreHashedVector {
    let hash: [u8; DIGEST_LEN] = Sha256::digest(CAVP_MSG).into();
    let pk = point_from_xy_bytes(&CAVP_QX, &CAVP_QY).expect("CAVP public key is on the curve");
    let r = scalar_from_be_bytes(&CAVP_R).expect("CAVP r is a canonical scalar");
    let s = scalar_from_be_bytes(&CAVP_S).expect("CAVP s is a canonical scalar");
    PreHashedVector { pk, hash, r, s }
}

/// Deterministic WebAuthn-shaped vector.
///
/// The authenticator data is 37 bytes: `SHA-256("p256-gate.example")` as
/// rpIdHash, flags 0x05 (user present + user verified), sign count 1. The
/// client data hash is the SHA-256 of a synthetic clientDataJSON byte
/// string. The signature is over
/// `SHA-256(authenticator_data || client_data_hash)`, exactly what a
/// WebAuthn authenticator signs when no extensions are present.
pub fn generated_webauthn() -> WebAuthnVector {
    let rp_id_hash: [u8; 32] = Sha256::digest(b"p256-gate.example").into();
    let mut authenticator_data = [0u8; AUTHENTICATOR_DATA_LEN];
    authenticator_data[..32].copy_from_slice(&rp_id_hash);
    authenticator_data[32] = 0x05;
    authenticator_data[33..].copy_from_slice(&1u32.to_be_bytes());

    let client_data_json: &[u8] = br#"{"type":"webauthn.get","challenge":"cDI1Ni1nYXRlLWNoYWxsZW5nZQ","origin":"https://p256-gate.example"}"#;
    let client_data_hash: [u8; DIGEST_LEN] = Sha256::digest(client_data_json).into();

    let mut signed_bytes = Vec::with_capacity(AUTHENTICATOR_DATA_LEN + DIGEST_LEN);
    signed_bytes.extend_from_slice(&authenticator_data);
    signed_bytes.extend_from_slice(&client_data_hash);
    let hash: [u8; DIGEST_LEN] = Sha256::digest(&signed_bytes).into();

    let (pk, r, s) = sign_prehash_deterministic(&GENERATED_SK_BYTES, &hash);
    WebAuthnVector {
        pk,
        authenticator_data,
        client_data_hash,
        r,
        s,
    }
}

// ---------------------------------------------------------------------------
// Ed25519 (recursion-leg inner relation)
// ---------------------------------------------------------------------------

/// An Ed25519 vector matching the instance/witness split of
/// `Ed25519Verify`.
#[derive(Clone, Debug)]
pub struct Ed25519Vector {
    /// The compressed public key `A`.
    pub pk_bytes: [u8; ED25519_ENC_LEN],
    /// The 32-byte message.
    pub message: [u8; DIGEST_LEN],
    /// The compressed nonce commitment `R` (first half of the signature).
    pub r_bytes: [u8; ED25519_ENC_LEN],
    /// The response scalar `s` bytes (second half of the signature).
    pub s_bytes: [u8; ED25519_ENC_LEN],
}

/// Fixed Ed25519 secret key for the deterministically generated vector.
/// Test-only material; never use outside this experiment.
pub const ED25519_SK_BYTES: [u8; 32] =
    hex!("4041424344454647484942aa4c4d4e4f505152535455565758595a5b5c5d5e5f");

/// Fixed message string; the vector signs its SHA-256 digest (the relation
/// takes a 32-byte message).
pub const ED25519_MESSAGE: &[u8] =
    b"Ed25519 in a midnight-zk circuit: recursion-leg inner relation";

/// Fixed Ed25519 secret key for the "wrong public key" negative vector.
pub const ED25519_WRONG_SK_BYTES: [u8; 32] =
    hex!("606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f");

/// The compressed public key of the unrelated keypair
/// [`ED25519_WRONG_SK_BYTES`], for negative tests. Being a genuine dalek
/// public key, it decompresses without panicking off-circuit.
pub fn wrong_ed25519_pk_bytes() -> [u8; ED25519_ENC_LEN] {
    Ed25519SigningKey::from_bytes(&ED25519_WRONG_SK_BYTES)
        .verifying_key()
        .to_bytes()
}

/// Deterministic ed25519-dalek vector: RFC 8032 signature with
/// [`ED25519_SK_BYTES`] over `SHA-256(ED25519_MESSAGE)`.
pub fn generated_ed25519() -> Ed25519Vector {
    let message: [u8; DIGEST_LEN] = Sha256::digest(ED25519_MESSAGE).into();
    let signing_key = Ed25519SigningKey::from_bytes(&ED25519_SK_BYTES);
    let signature = signing_key.sign(&message);
    Ed25519Vector {
        pk_bytes: signing_key.verifying_key().to_bytes(),
        message,
        r_bytes: *signature.r_bytes(),
        s_bytes: *signature.s_bytes(),
    }
}

/// Out-of-circuit sanity check of an Ed25519 vector with ed25519-dalek's
/// `verify_strict`. Both check the same cofactorless equation, but the
/// acceptance sets are not identical: `verify_strict` additionally rejects
/// small-order `R` and `A` (the circuit's prime-subgroup check admits the
/// identity), and the circuit additionally enforces canonical encodings.
/// They agree on all honestly generated dalek vectors, which is what this
/// guard checks.
pub fn dalek_verify_strict(vector: &Ed25519Vector) -> bool {
    let Ok(verifying_key) = ed25519_dalek::VerifyingKey::from_bytes(&vector.pk_bytes) else {
        return false;
    };
    let mut sig_bytes = [0u8; 64];
    sig_bytes[..32].copy_from_slice(&vector.r_bytes);
    sig_bytes[32..].copy_from_slice(&vector.s_bytes);
    let signature = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    verifying_key
        .verify_strict(&vector.message, &signature)
        .is_ok()
}

// ---------------------------------------------------------------------------
// JubJub Schnorr (recursion-leg inner relation)
// ---------------------------------------------------------------------------

/// A JubJub Schnorr vector matching the instance/witness split of
/// `JubjubSchnorrVerify`.
#[derive(Clone, Debug)]
pub struct JubjubSchnorrVector {
    /// The public key `pk = sk * G`.
    pub pk: JubjubSubgroup,
    /// The message, a native field element.
    pub message: F,
    /// The signature `(s, e_bytes)`.
    pub signature: JubjubSchnorrSignature,
}

/// Fixed 64-byte expansion of the JubJub Schnorr secret key (reduced into
/// the scalar field with `from_bytes_wide`). Test-only material.
const JUBJUB_SK_WIDE: [u8; 64] = hex!(
    "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf"
    "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf"
);

/// Fixed 64-byte expansion of the signing nonce `k`. A fixed nonce is safe
/// here because the key signs exactly one message, ever.
const JUBJUB_NONCE_WIDE: [u8; 64] = hex!(
    "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f"
    "303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f"
);

/// Fixed message field element.
const JUBJUB_MESSAGE: u64 = 0x7061737370407274; // "passp@rt"

/// Affine coordinates of a JubJub subgroup point, as in the upstream
/// example.
fn jubjub_coords(point: &JubjubSubgroup) -> (F, F) {
    let point: &Jubjub = point.into();
    let point: JubjubAffine = point.into();
    (point.get_u(), point.get_v())
}

/// Reduces 32 challenge bytes into the JubJub scalar field, as in the
/// upstream example's sign and verify.
fn jubjub_challenge_scalar(e_bytes: &[u8; 32]) -> JubjubScalar {
    let mut buff = [0u8; 64];
    buff[..32].copy_from_slice(e_bytes);
    JubjubScalar::from_bytes_wide(&buff)
}

/// Deterministic JubJub Schnorr vector, signed with the upstream example's
/// logic: `R = k * G`, `e_bytes = Poseidon(pk.x, pk.y, R.x, R.y, m)` in LE
/// bytes, `s = k - e * sk`.
pub fn generated_jubjub_schnorr() -> JubjubSchnorrVector {
    let sk = JubjubScalar::from_bytes_wide(&JUBJUB_SK_WIDE);
    let k = JubjubScalar::from_bytes_wide(&JUBJUB_NONCE_WIDE);
    let message = F::from(JUBJUB_MESSAGE);

    let pk = JubjubSubgroup::generator() * sk;
    let r = JubjubSubgroup::generator() * k;

    let (rx, ry) = jubjub_coords(&r);
    let (pkx, pky) = jubjub_coords(&pk);

    let h = <PoseidonChip<F> as HashCPU<F, F>>::hash(&[pkx, pky, rx, ry, message]);
    let e_bytes = h.to_bytes_le();

    let s = k - jubjub_challenge_scalar(&e_bytes) * sk;

    JubjubSchnorrVector {
        pk,
        message,
        signature: JubjubSchnorrSignature { s, e_bytes },
    }
}

/// Out-of-circuit verification of a JubJub Schnorr vector, ported from the
/// upstream example's `verify`.
pub fn jubjub_schnorr_verify(vector: &JubjubSchnorrVector) -> bool {
    let e = jubjub_challenge_scalar(&vector.signature.e_bytes);

    // 1. R' = s * G + e * pk.
    let rv = JubjubSubgroup::generator() * vector.signature.s + vector.pk * e;

    let (rx, ry) = jubjub_coords(&rv);
    let (pkx, pky) = jubjub_coords(&vector.pk);

    // 2. e' = Poseidon(pk.x, pk.y, R'.x, R'.y, m).
    let h = <PoseidonChip<F> as HashCPU<F, F>>::hash(&[pkx, pky, rx, ry, vector.message]);

    h.to_bytes_le() == vector.signature.e_bytes
}
