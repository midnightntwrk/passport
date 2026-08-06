//! Test vectors for the P-256 ECDSA relations.
//!
//! Two sources:
//!
//! 1. Vectors generated deterministically with the RustCrypto `p256` crate
//!    (RFC 6979 nonces, so re-generation is bit-stable).
//! 2. One NIST CAVP FIPS 186-4 ECDSA SigVer known-answer vector, copied
//!    literally.

use ff::PrimeField;
use hex_literal::hex;
use midnight_curves::p256::{affine_from_xy, Fp, Fq, P256};
use p256::{
    ecdsa::{
        signature::hazmat::{PrehashSigner, PrehashVerifier},
        Signature, SigningKey, VerifyingKey,
    },
    elliptic_curve::sec1::ToEncodedPoint,
};
use sha2::{Digest, Sha256};

use crate::relations::{AUTHENTICATOR_DATA_LEN, DIGEST_LEN};

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
