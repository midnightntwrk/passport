//! MockProver-based satisfiability tests for the three P-256 ECDSA
//! relations and the recursion-leg inner relations (Ed25519, JubJub
//! Schnorr, and the two witness-preimage relations). Run with
//! `cargo test -p p256-gate-circuit --release` (MockProver is unusably
//! slow in debug builds).

use std::sync::OnceLock;

use ff::PrimeField;
use midnight_curves::p256::Fq;
use midnight_proofs::{circuit::Value, dev::MockProver};
use midnight_zk_stdlib::{optimal_k, MidnightCircuit, Relation};
use p256::elliptic_curve::scalar::IsHigh;
use p256_gate_circuit::{
    ed25519::Ed25519Verify,
    envelope::P256EcdsaWebAuthnEnvelope,
    jubjub_schnorr::JubjubSchnorrVerify,
    relations::{P256EcdsaPreHashed, P256EcdsaPrivatePk, P256EcdsaWebAuthn},
    vectors::{
        cavp_prehashed, dalek_verify_strict, generated_ed25519, generated_jubjub_schnorr,
        generated_prehashed, generated_webauthn, generated_webauthn_envelope,
        generated_witness_preimage, high_s_twin, jubjub_schnorr_verify, rustcrypto_verify,
        scalar_from_be_bytes, scalar_to_be_bytes, sign_envelope_deterministic,
        witness_preimage_verify, wrong_ed25519_pk_bytes, wrong_pk, Ed25519Vector,
        JubjubSchnorrVector, PreHashedVector, WebAuthnEnvelopeVector, WitnessPreimageVector,
        GENERATED_SK_BYTES,
    },
    witness_preimage::{PoseidonPreimage, Sha256Preimage},
};
use sha2::Digest;

/// Runs the MockProver on `relation` for the given instance/witness pair.
/// Returns `Err` if synthesis fails or any constraint is unsatisfied.
fn mock_check<R>(
    relation: &R,
    k: u32,
    instance: &R::Instance,
    witness: &R::Witness,
) -> Result<(), String>
where
    R: Relation,
{
    let public_inputs =
        R::format_instance(instance).map_err(|_| "format_instance failed".to_string())?;
    let circuit = MidnightCircuit::new(
        relation,
        Value::known(instance.clone()),
        Value::known(witness.clone()),
        Some(k),
    );
    // Instance column 0 carries committed instances (unused here), column 1
    // the raw public inputs; this mirrors upstream's own MockProver tests.
    let prover = MockProver::run(&circuit, vec![vec![], public_inputs])
        .map_err(|e| format!("synthesis failed: {e:?}"))?;
    prover
        .verify()
        .map_err(|errors| format!("unsatisfied: {errors:?}"))
}

/// The optimal circuit size is derived once per relation and reused, since
/// deriving it synthesises the circuit several times.
fn prehashed_k() -> u32 {
    static K: OnceLock<u32> = OnceLock::new();
    *K.get_or_init(|| optimal_k(&P256EcdsaPreHashed))
}

fn webauthn_k() -> u32 {
    static K: OnceLock<u32> = OnceLock::new();
    *K.get_or_init(|| optimal_k(&P256EcdsaWebAuthn))
}

fn private_pk_k() -> u32 {
    static K: OnceLock<u32> = OnceLock::new();
    *K.get_or_init(|| optimal_k(&P256EcdsaPrivatePk))
}

fn check_prehashed(vector: &PreHashedVector) -> Result<(), String> {
    mock_check(
        &P256EcdsaPreHashed,
        prehashed_k(),
        &(vector.pk, vector.hash),
        &(vector.r, vector.s),
    )
}

/// Flips the least-significant bit of a scalar's big-endian encoding. The
/// result is a canonical scalar unless the flip crosses the group order,
/// which cannot happen for our fixed vectors.
fn flip_low_bit(scalar: &Fq) -> Fq {
    let mut bytes = scalar_to_be_bytes(scalar);
    bytes[31] ^= 0x01;
    scalar_from_be_bytes(&bytes).expect("bit-flipped scalar stays canonical")
}

// (a) A valid RustCrypto-generated vector satisfies P256EcdsaPreHashed, and
// so does the NIST CAVP known-answer vector.
#[test]
fn prehashed_accepts_valid_signature() {
    let vector = generated_prehashed();
    assert!(
        rustcrypto_verify(&vector),
        "vector must verify out-of-circuit"
    );
    check_prehashed(&vector).expect("valid generated vector must satisfy the circuit");
}

#[test]
fn prehashed_accepts_cavp_known_answer_vector() {
    let vector = cavp_prehashed();
    assert!(
        rustcrypto_verify(&vector),
        "CAVP vector must verify out-of-circuit (guards against transcription errors)"
    );
    check_prehashed(&vector).expect("CAVP vector must satisfy the circuit");
}

// (b) A flipped bit in r must be rejected.
#[test]
fn prehashed_rejects_flipped_r() {
    let mut vector = generated_prehashed();
    vector.r = flip_low_bit(&vector.r);
    assert!(
        check_prehashed(&vector).is_err(),
        "tampered r must not satisfy the circuit"
    );
}

// (c) A flipped bit in s must be rejected.
#[test]
fn prehashed_rejects_flipped_s() {
    let mut vector = generated_prehashed();
    vector.s = flip_low_bit(&vector.s);
    assert!(
        check_prehashed(&vector).is_err(),
        "tampered s must not satisfy the circuit"
    );
}

// (d) A signature under a different public key must be rejected.
#[test]
fn prehashed_rejects_wrong_public_key() {
    let mut vector = generated_prehashed();
    vector.pk = wrong_pk();
    assert!(
        check_prehashed(&vector).is_err(),
        "wrong pk must not satisfy the circuit"
    );
}

// (e) A different message hash must be rejected.
#[test]
fn prehashed_rejects_wrong_hash() {
    let mut vector = generated_prehashed();
    vector.hash[0] ^= 0xff;
    assert!(
        check_prehashed(&vector).is_err(),
        "wrong hash must not satisfy the circuit"
    );
}

// (f) The high-S malleated twin (r, n - s) of a valid signature ALSO
// satisfies the circuit. This is not a bug: textbook ECDSA (SEC 1,
// section 4.1.4) accepts both signatures, because (r, s) and (r, n - s)
// yield R and -R, which share the same x-coordinate. We assert the twin
// passes to document the malleability explicitly: a Compact-level P-256
// verifier (and any replay-protection scheme built on signature uniqueness)
// must decide on a low-S normalisation policy, which is exactly the
// discussion this datapoint feeds in the MIP.
#[test]
fn prehashed_accepts_high_s_twin_documenting_malleability() {
    let mut vector = generated_prehashed();
    vector.s = high_s_twin(&vector.s);
    // Guard the labelling: the generated vector is low-S normalised, so the
    // twin must be the genuinely high-S form.
    let twin = Option::<p256::Scalar>::from(p256::Scalar::from_repr(
        scalar_to_be_bytes(&vector.s).into(),
    ))
    .expect("twin scalar is canonical");
    assert!(
        bool::from(twin.is_high()),
        "the twin of a low-S signature must be high-S"
    );
    check_prehashed(&vector).expect("high-S twin satisfies textbook ECDSA, hence the circuit");
}

// (g) A valid WebAuthn-shaped vector satisfies P256EcdsaWebAuthn.
#[test]
fn webauthn_accepts_valid_assertion() {
    let vector = generated_webauthn();
    mock_check(
        &P256EcdsaWebAuthn,
        webauthn_k(),
        &(
            vector.pk,
            vector.authenticator_data,
            vector.client_data_hash,
        ),
        &(vector.r, vector.s),
    )
    .expect("valid WebAuthn vector must satisfy the circuit");
}

// (h) A valid vector satisfies P256EcdsaPrivatePk (public key as witness).
#[test]
fn private_pk_accepts_valid_signature() {
    let vector = generated_prehashed();
    mock_check(
        &P256EcdsaPrivatePk,
        private_pk_k(),
        &vector.hash,
        &(vector.pk, vector.r, vector.s),
    )
    .expect("valid vector must satisfy the private-pk circuit");
}

// (i) r = 0 must be rejected: this exercises the explicit r != 0 assertion,
// the one stated hardening over the upstream template.
#[test]
fn prehashed_rejects_zero_r() {
    let mut vector = generated_prehashed();
    vector.r = Fq::ZERO;
    assert!(
        check_prehashed(&vector).is_err(),
        "r = 0 must not satisfy the circuit"
    );
}

// (j) s = 0 must be rejected: both the explicit s != 0 assertion and the
// s^{-1} computation (an in-circuit division by zero) make the relation
// unprovable.
#[test]
fn prehashed_rejects_zero_s() {
    let mut vector = generated_prehashed();
    vector.s = Fq::ZERO;
    assert!(
        check_prehashed(&vector).is_err(),
        "s = 0 must not satisfy the circuit"
    );
}

// (k) Tampered authenticator data must be rejected: the in-circuit SHA-256
// binds the signature to the exact authenticator_data bytes.
#[test]
fn webauthn_rejects_tampered_authenticator_data() {
    let mut vector = generated_webauthn();
    vector.authenticator_data[32] ^= 0x01; // flip the UP flag bit
    assert!(
        mock_check(
            &P256EcdsaWebAuthn,
            webauthn_k(),
            &(
                vector.pk,
                vector.authenticator_data,
                vector.client_data_hash,
            ),
            &(vector.r, vector.s),
        )
        .is_err(),
        "tampered authenticator data must not satisfy the circuit"
    );
}

// (l) A different public hash must be rejected by P256EcdsaPrivatePk even
// though the key is a free witness: the witnessed signature no longer
// matches the hash.
#[test]
fn private_pk_rejects_wrong_hash() {
    let vector = generated_prehashed();
    let mut hash = vector.hash;
    hash[0] ^= 0xff;
    assert!(
        mock_check(
            &P256EcdsaPrivatePk,
            private_pk_k(),
            &hash,
            &(vector.pk, vector.r, vector.s),
        )
        .is_err(),
        "wrong hash must not satisfy the private-pk circuit"
    );
}

// ---------------------------------------------------------------------------
// Whole-envelope relation (P256EcdsaWebAuthnEnvelope)
// ---------------------------------------------------------------------------

/// The envelope relation for the generated vector's clientDataJSON length,
/// with user verification required (the vector's flags carry UV).
fn envelope_relation() -> P256EcdsaWebAuthnEnvelope {
    let vector = generated_webauthn_envelope();
    P256EcdsaWebAuthnEnvelope::new(vector.client_data_json.len(), true)
}

fn envelope_k() -> u32 {
    static K: OnceLock<u32> = OnceLock::new();
    *K.get_or_init(|| optimal_k(&envelope_relation()))
}

fn check_envelope(vector: &WebAuthnEnvelopeVector) -> Result<(), String> {
    mock_check(
        &envelope_relation(),
        envelope_k(),
        &(vector.pk, vector.rp_id_hash, vector.challenge),
        &(
            vector.client_data_json.clone(),
            vector.authenticator_data,
            vector.r,
            vector.s,
        ),
    )
}

// (m) A valid whole-envelope vector satisfies the relation: prefix,
// challenge encoding, rpIdHash, flags, both hashes, and the signature all
// verified in-circuit.
#[test]
fn envelope_accepts_valid_assertion() {
    let vector = generated_webauthn_envelope();
    check_envelope(&vector).expect("valid whole-envelope vector must satisfy the circuit");
}

// (n) A different public challenge must be rejected even though the
// witnessed envelope is genuinely signed: the challenge binding is the
// constraint that fails, not the signature.
#[test]
fn envelope_rejects_wrong_challenge() {
    let mut vector = generated_webauthn_envelope();
    vector.challenge[0] ^= 0x01;
    assert!(
        check_envelope(&vector).is_err(),
        "a different challenge must not satisfy the circuit"
    );
}

// (o) A tampered ceremony type must be rejected even when the tampered
// envelope is RE-SIGNED (so the signature constraint alone would pass):
// this isolates the fixed-prefix check, which is what stops a
// create-ceremony attestation passing as an assertion.
#[test]
fn envelope_rejects_tampered_ceremony_type() {
    let mut vector = generated_webauthn_envelope();
    // {"type":"webauthn.get" -> {"type":"webauthn.gew" (same length).
    vector.client_data_json[20] = b'w';
    let (pk, r, s) = sign_envelope_deterministic(
        &GENERATED_SK_BYTES,
        &vector.authenticator_data,
        &vector.client_data_json,
    );
    vector.pk = pk;
    vector.r = r;
    vector.s = s;
    assert!(
        check_envelope(&vector).is_err(),
        "a tampered ceremony type must not satisfy the circuit even re-signed"
    );
}

// (p) An assertion made for a different relying party must be rejected:
// the witnessed authenticatorData is internally consistent and the
// signature over it is valid, but its rpIdHash differs from the public
// expectation.
#[test]
fn envelope_rejects_wrong_relying_party() {
    let mut vector = generated_webauthn_envelope();
    vector.rp_id_hash = sha2::Sha256::digest(b"other.example").into();
    assert!(
        check_envelope(&vector).is_err(),
        "an assertion for a different relying party must not satisfy the circuit"
    );
}

// (q) Flags without user verification must be rejected by a relation built
// with require_user_verification, even re-signed: the flag-bit constraint
// is what fails.
#[test]
fn envelope_rejects_missing_user_verification() {
    let mut vector = generated_webauthn_envelope();
    vector.authenticator_data[32] = 0x01; // user present only
    let (pk, r, s) = sign_envelope_deterministic(
        &GENERATED_SK_BYTES,
        &vector.authenticator_data,
        &vector.client_data_json,
    );
    vector.pk = pk;
    vector.r = r;
    vector.s = s;
    assert!(
        check_envelope(&vector).is_err(),
        "flags without UV must not satisfy a require-UV relation"
    );
}

// (r) A flipped signature scalar must be rejected: the ECDSA body is the
// same as the other relations'.
#[test]
fn envelope_rejects_flipped_s() {
    let mut vector = generated_webauthn_envelope();
    vector.s = flip_low_bit(&vector.s);
    assert!(
        check_envelope(&vector).is_err(),
        "a flipped s must not satisfy the circuit"
    );
}

// (s) The high-S malleated twin (r, n - s) ALSO satisfies the whole-envelope
// relation: the envelope checks constrain the message, not the signature
// form, and the shared ECDSA body accepts both per SEC 1. Documented here
// for the same reason as (f) — the real Apple assertion in
// webauthn/vector.json is itself high-S, so a low-S-only policy at the
// standard level would need client-side normalisation.
#[test]
fn envelope_accepts_high_s_twin_documenting_malleability() {
    let mut vector = generated_webauthn_envelope();
    vector.s = high_s_twin(&vector.s);
    // Guard the labelling: the generated vector is low-S normalised, so the
    // twin must be the genuinely high-S form.
    let twin = Option::<p256::Scalar>::from(p256::Scalar::from_repr(
        scalar_to_be_bytes(&vector.s).into(),
    ))
    .expect("twin scalar is canonical");
    assert!(
        bool::from(twin.is_high()),
        "the twin of a low-S signature must be high-S"
    );
    check_envelope(&vector)
        .expect("the high-S twin satisfies textbook ECDSA, hence the whole-envelope circuit");
}

// ---------------------------------------------------------------------------
// Recursion-leg inner relations
// ---------------------------------------------------------------------------

fn ed25519_k() -> u32 {
    static K: OnceLock<u32> = OnceLock::new();
    *K.get_or_init(|| optimal_k(&Ed25519Verify))
}

fn jubjub_schnorr_k() -> u32 {
    static K: OnceLock<u32> = OnceLock::new();
    *K.get_or_init(|| optimal_k(&JubjubSchnorrVerify))
}

fn check_ed25519(vector: &Ed25519Vector) -> Result<(), String> {
    mock_check(
        &Ed25519Verify,
        ed25519_k(),
        &(vector.pk_bytes, vector.message),
        &(vector.r_bytes, vector.s_bytes),
    )
}

fn check_jubjub_schnorr(vector: &JubjubSchnorrVector) -> Result<(), String> {
    mock_check(
        &JubjubSchnorrVerify,
        jubjub_schnorr_k(),
        &(vector.pk, vector.message),
        &vector.signature,
    )
}

// (m) A valid ed25519-dalek vector satisfies Ed25519Verify.
#[test]
fn ed25519_accepts_valid_signature() {
    let vector = generated_ed25519();
    assert!(
        dalek_verify_strict(&vector),
        "vector must verify out-of-circuit (cofactorless; agrees with the circuit on honest vectors)"
    );
    check_ed25519(&vector).expect("valid Ed25519 vector must satisfy the circuit");
}

// (n) A flipped signature bit must be rejected. The flip lands in s (the
// second signature half): tampering R would panic in the off-circuit
// decompression of the reference vector rather than exercise the circuit.
#[test]
fn ed25519_rejects_flipped_signature_bit() {
    let mut vector = generated_ed25519();
    vector.s_bytes[0] ^= 0x01;
    assert!(
        check_ed25519(&vector).is_err(),
        "tampered s must not satisfy the circuit"
    );
}

// (o) A different message must be rejected: the in-circuit SHA-512 binds
// the signature to the exact message bytes.
#[test]
fn ed25519_rejects_wrong_message() {
    let mut vector = generated_ed25519();
    vector.message[0] ^= 0xff;
    assert!(
        check_ed25519(&vector).is_err(),
        "wrong message must not satisfy the circuit"
    );
}

// (o2) A non-canonical response scalar encoding must be rejected. The
// witness is the LE encoding of s + L, which still fits in 32 bytes
// (L is about 2^252), leaves the group equation R = s * B - h * A satisfied
// modulo L, and touches no decompression hint, so exactly and only the
// in-circuit canonicity constraint (s < L) rejects it. This pins the ported
// canonicity assertion: dropping it would otherwise leave the suite green
// while the circuit accepted the malleable twin s + L of every signature.
#[test]
fn ed25519_rejects_noncanonical_s() {
    // L = 2^252 + 27742317777372353535851937790883648493, little-endian.
    const ED25519_L_LE: [u8; 32] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde,
        0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x10,
    ];
    let mut vector = generated_ed25519();
    // s_bytes := LE(s + L), by byte-wise little-endian addition.
    let mut carry = 0u16;
    for (s_byte, l_byte) in vector.s_bytes.iter_mut().zip(ED25519_L_LE) {
        let sum = u16::from(*s_byte) + u16::from(l_byte) + carry;
        *s_byte = sum as u8;
        carry = sum >> 8;
    }
    assert_eq!(carry, 0, "s + L must fit in 32 bytes");
    let err = check_ed25519(&vector).expect_err("non-canonical s must not satisfy the circuit");
    assert!(
        err.starts_with("unsatisfied"),
        "rejection must come from the canonicity constraint, not a synthesis abort: {err}"
    );
}

// (o3) A signature under a different public key must be rejected (the
// Ed25519 analogue of prehashed_rejects_wrong_public_key): the instance pk
// is swapped for another genuine dalek key, so both decompressions succeed
// and the group equation is what fails.
#[test]
fn ed25519_rejects_wrong_public_key() {
    let mut vector = generated_ed25519();
    vector.pk_bytes = wrong_ed25519_pk_bytes();
    assert!(
        check_ed25519(&vector).is_err(),
        "wrong pk must not satisfy the circuit"
    );
}

// (p) A valid JubJub Schnorr vector satisfies JubjubSchnorrVerify.
#[test]
fn jubjub_schnorr_accepts_valid_signature() {
    let vector = generated_jubjub_schnorr();
    assert!(
        jubjub_schnorr_verify(&vector),
        "vector must verify out-of-circuit"
    );
    check_jubjub_schnorr(&vector).expect("valid Schnorr vector must satisfy the circuit");
}

// (q) A tampered response scalar must be rejected: R' = s * G + e * pk no
// longer hashes to the witnessed challenge.
#[test]
fn jubjub_schnorr_rejects_tampered_response() {
    let mut vector = generated_jubjub_schnorr();
    vector.signature.s = -vector.signature.s;
    assert!(
        check_jubjub_schnorr(&vector).is_err(),
        "tampered s must not satisfy the circuit"
    );
}

// (r) A tampered challenge byte must be rejected by the in-circuit byte
// comparison against the recomputed Poseidon challenge.
#[test]
fn jubjub_schnorr_rejects_tampered_challenge() {
    let mut vector = generated_jubjub_schnorr();
    vector.signature.e_bytes[0] ^= 0x01;
    assert!(
        check_jubjub_schnorr(&vector).is_err(),
        "tampered e_bytes must not satisfy the circuit"
    );
}

// ---------------------------------------------------------------------------
// Witness-preimage inner relations
// ---------------------------------------------------------------------------

fn poseidon_preimage_k() -> u32 {
    static K: OnceLock<u32> = OnceLock::new();
    *K.get_or_init(|| optimal_k(&PoseidonPreimage))
}

fn sha256_preimage_k() -> u32 {
    static K: OnceLock<u32> = OnceLock::new();
    *K.get_or_init(|| optimal_k(&Sha256Preimage))
}

fn check_poseidon_preimage(vector: &WitnessPreimageVector) -> Result<(), String> {
    mock_check(
        &PoseidonPreimage,
        poseidon_preimage_k(),
        &vector.poseidon_commitment,
        &vector.secret,
    )
}

fn check_sha256_preimage(vector: &WitnessPreimageVector) -> Result<(), String> {
    mock_check(
        &Sha256Preimage,
        sha256_preimage_k(),
        &vector.sha256_digest,
        &vector.secret,
    )
}

// (s) A valid witness-preimage vector satisfies PoseidonPreimage.
#[test]
fn poseidon_preimage_accepts_valid_vector() {
    let vector = generated_witness_preimage();
    assert!(
        witness_preimage_verify(&vector),
        "vector must verify out-of-circuit"
    );
    check_poseidon_preimage(&vector).expect("valid preimage vector must satisfy the circuit");
}

// (t) A flipped secret byte must be rejected: the packed halves change, so
// the recomputed Poseidon commitment no longer matches the public one.
#[test]
fn poseidon_preimage_rejects_flipped_secret_byte() {
    let mut vector = generated_witness_preimage();
    vector.secret[0] ^= 0x01;
    let err = check_poseidon_preimage(&vector)
        .expect_err("a flipped secret byte must not satisfy the circuit");
    assert!(
        err.starts_with("unsatisfied"),
        "rejection must come from the constraint system, not a synthesis abort: {err}"
    );
}

// (u) A wrong public commitment must be rejected: the constrained Poseidon
// output no longer matches the instance value.
#[test]
fn poseidon_preimage_rejects_wrong_commitment() {
    let mut vector = generated_witness_preimage();
    vector.poseidon_commitment += p256_gate_circuit::relations::F::from(1);
    let err = check_poseidon_preimage(&vector)
        .expect_err("a wrong commitment must not satisfy the circuit");
    assert!(
        err.starts_with("unsatisfied"),
        "rejection must come from the constraint system, not a synthesis abort: {err}"
    );
}

// (v) A valid witness-preimage vector satisfies Sha256Preimage.
#[test]
fn sha256_preimage_accepts_valid_vector() {
    let vector = generated_witness_preimage();
    assert!(
        witness_preimage_verify(&vector),
        "vector must verify out-of-circuit"
    );
    check_sha256_preimage(&vector).expect("valid preimage vector must satisfy the circuit");
}

// (w) A flipped secret byte must be rejected: the in-circuit SHA-256 of the
// tampered secret no longer matches the public digest.
#[test]
fn sha256_preimage_rejects_flipped_secret_byte() {
    let mut vector = generated_witness_preimage();
    vector.secret[0] ^= 0x01;
    let err = check_sha256_preimage(&vector)
        .expect_err("a flipped secret byte must not satisfy the circuit");
    assert!(
        err.starts_with("unsatisfied"),
        "rejection must come from the constraint system, not a synthesis abort: {err}"
    );
}

// (x) A wrong public digest must be rejected: the constrained digest bytes
// no longer match the instance values.
#[test]
fn sha256_preimage_rejects_wrong_digest() {
    let mut vector = generated_witness_preimage();
    vector.sha256_digest[0] ^= 0xff;
    let err =
        check_sha256_preimage(&vector).expect_err("a wrong digest must not satisfy the circuit");
    assert!(
        err.starts_with("unsatisfied"),
        "rejection must come from the constraint system, not a synthesis abort: {err}"
    );
}
