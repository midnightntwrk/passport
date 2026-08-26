//! MockProver-based tests for the proof-of-proof wrapper, plus an
//! end-to-end test of the complete-verification helper.
//!
//! The default suite wraps the two cheapest inner relations only (JubJub
//! Schnorr and the Poseidon preimage): the outer circuit's shape barely
//! depends on the inner relation, and few wrapped schemes keep the suite's
//! runtime sane; a SHA-256 preimage wrap is re-runnable behind
//! `#[ignore]`. Unlike
//! `tests/mock.rs`, these tests need the Filecoin SRS (see the README):
//! producing an inner proof requires real proving.
//!
//! Run with `cargo test -p p256-gate-circuit --release` (MockProver is
//! unusably slow in debug builds).

use std::sync::OnceLock;

use ff::Field;
use midnight_circuits::{
    instructions::{AssignmentInstructions, PublicInputInstructions},
    types::{AssignedNative, AssignedNativePoint},
};
use midnight_curves::JubjubExtended;
use midnight_proofs::{
    circuit::{Layouter, Value},
    dev::MockProver,
    plonk,
};
use midnight_zk_stdlib::{
    setup_pk, setup_vk, utils::plonk_api::srs_for_test, MidnightCircuit, MidnightVK, Relation,
    ZkStdLib, ZkStdLibArch,
};
use p256_gate_circuit::{
    ed25519::Ed25519Verify,
    jubjub_schnorr::JubjubSchnorrVerify,
    vectors::{
        generated_jubjub_schnorr, generated_witness_preimage, jubjub_schnorr_verify,
        witness_preimage_verify,
    },
    witness_preimage::{PoseidonPreimage, Sha256Preimage},
    wrapper::{
        prove_inner, unsupported_inner_rotations, verify_inner, verify_wrapped, wrap_inner_proof,
        ProofWrap, WrapInstance, WrapWitness,
    },
};
use rand::rngs::OsRng;

type F = p256_gate_circuit::relations::F;
type Inner = JubjubSchnorrVerify;

/// Circuit size of the wrapper over the JubJub Schnorr inner relation, as
/// reported by `optimal_k` (see `discover_wrapper_optimal_k` below to
/// re-derive it). Hard-coded because `optimal_k` synthesises the (large)
/// wrapper circuit many times; a stale value is caught by
/// `wrapper_accepts_valid_inner_proof`, which fails if the circuit no
/// longer fits.
const WRAPPER_K: u32 = 17;

/// Circuit size of the wrapper over the `Sha256Preimage` inner relation,
/// as measured by the `recursion` subcommand
/// (`evidence/recursion-witness-sha256.json`). Only used by the
/// `#[ignore]`d SHA-256 wrap test below.
const SHA256_WRAPPER_K: u32 = 18;

struct Fixture {
    wrapper: ProofWrap<Inner>,
    instance: WrapInstance<Inner>,
    witness: WrapWitness<Inner>,
    inner_vk: MidnightVK,
    inner_srs: midnight_proofs::poly::kzg::params::ParamsKZG<midnight_curves::Bls12>,
    inner_instance: <Inner as Relation>::Instance,
}

/// Shared one-time setup: inner keys, one Poseidon-transcript inner proof,
/// and its wrapping.
fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        // Point SRS_DIR at the workspace assets directory regardless of the
        // test binary's working directory.
        if std::env::var_os("SRS_DIR").is_none() {
            std::env::set_var(
                "SRS_DIR",
                concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets"),
            );
        }

        let relation = JubjubSchnorrVerify;
        let vector = generated_jubjub_schnorr();
        assert!(
            jubjub_schnorr_verify(&vector),
            "vector must verify out-of-circuit"
        );
        let inner_instance = (vector.pk, vector.message);

        let inner_srs = srs_for_test(&relation, None);
        let inner_vk = setup_vk(&inner_srs, &relation);
        let inner_pk = setup_pk(&relation, &inner_vk);

        // The inner proof MUST use the Poseidon transcript: the in-circuit
        // verifier hashes with a Poseidon sponge.
        let inner_proof = prove_inner(
            &inner_srs,
            &inner_pk,
            &relation,
            &inner_instance,
            vector.signature.clone(),
            OsRng,
        )
        .expect("inner proof generation should not fail");
        verify_inner::<Inner>(
            &inner_srs.verifier_params(),
            &inner_vk,
            &inner_instance,
            &inner_proof,
        )
        .expect("inner proof must verify natively under the Poseidon transcript");

        let nb_inner_pis = Inner::format_instance(&inner_instance)
            .expect("formattable instance")
            .len();
        let wrapper = ProofWrap::new(&inner_vk, nb_inner_pis);
        let (instance, witness) =
            wrap_inner_proof::<Inner>(&inner_vk, &inner_instance, &inner_proof)
                .expect("wrapping the inner proof should not fail");

        Fixture {
            wrapper,
            instance,
            witness,
            inner_vk,
            inner_srs,
            inner_instance,
        }
    })
}

/// Runs the MockProver on the wrapper for the given instance/witness pair.
fn wrapper_mock_check(
    instance: &WrapInstance<Inner>,
    witness: &WrapWitness<Inner>,
) -> Result<(), String> {
    let f = fixture();
    let public_inputs = ProofWrap::<Inner>::format_instance(instance)
        .map_err(|e| format!("format_instance failed: {e:?}"))?;
    let circuit = MidnightCircuit::new(
        &f.wrapper,
        Value::known(instance.clone()),
        Value::known(witness.clone()),
        Some(WRAPPER_K),
    );
    // Instance column 0 carries committed instances (unused here), column 1
    // the raw public inputs; this mirrors upstream's own MockProver tests.
    let prover = MockProver::run(&circuit, vec![vec![], public_inputs])
        .map_err(|e| format!("synthesis failed: {e:?}"))?;
    prover
        .verify()
        .map_err(|errors| format!("unsatisfied: {errors:?}"))
}

// (a) A valid inner proof (with its honestly derived accumulator) satisfies
// the wrapper circuit. This test also guards WRAPPER_K: it fails if the
// wrapper no longer fits at that size.
#[test]
fn wrapper_accepts_valid_inner_proof() {
    let f = fixture();
    wrapper_mock_check(&f.instance, &f.witness)
        .expect("valid inner proof must satisfy the wrapper circuit");
}

// (b) Tampered inner-proof bytes must be rejected: the in-circuit
// re-execution of the verification transcript no longer reproduces the
// accumulator claimed in the public inputs. The rejection must land in the
// constraint system: the upstream transcript gadget assigns defaults
// instead of failing on unparseable proof bytes, so a synthesis-time abort
// here would be a regression, not a rejection.
#[test]
fn wrapper_rejects_tampered_proof_bytes() {
    let f = fixture();
    let mut witness = f.witness.clone();
    let mid = witness.inner_proof.len() / 2;
    witness.inner_proof[mid] ^= 0x01;
    let err = wrapper_mock_check(&f.instance, &witness)
        .expect_err("tampered inner proof bytes must not satisfy the wrapper circuit");
    assert!(
        err.starts_with("unsatisfied"),
        "rejection must come from the constraint system, not a synthesis abort: {err}"
    );
}

// (c) An inner-instance mismatch must be rejected: the witnessed inner
// public inputs are re-exposed as outer public inputs, so a different
// claimed instance no longer matches them.
#[test]
fn wrapper_rejects_inner_instance_mismatch() {
    let f = fixture();
    let mut instance = f.instance.clone();
    instance.inner_instance.1 += F::ONE;
    let err = wrapper_mock_check(&instance, &f.witness)
        .expect_err("a mismatching inner instance must not satisfy the wrapper circuit");
    assert!(
        err.starts_with("unsatisfied"),
        "rejection must come from the constraint system, not a synthesis abort: {err}"
    );
}

/// A second inner relation with the SAME SHAPE as [`JubjubSchnorrVerify`]:
/// identical `used_chips` arch (hence an identical constraint system),
/// identical instance encoding, and keys built at the same k (hence an
/// identical domain), but different circuit content, so its verifying key
/// has different fixed-column commitments and a different `transcript_repr`.
///
/// `ProofWrap` is parameterised only by the inner domain and constraint
/// system, so the wrapper circuit (and the outer verifying key) over either
/// inner circuit is the same; only step (b) of `verify_wrapped` (the
/// inner-vk binding) can tell their wraps apart.
#[derive(Clone, Debug, Default)]
struct AltSameShapeInner;

impl Relation for AltSameShapeInner {
    type Instance = <JubjubSchnorrVerify as Relation>::Instance;

    type Witness = ();

    type Error = plonk::Error;

    fn format_instance(instance: &Self::Instance) -> Result<Vec<F>, plonk::Error> {
        JubjubSchnorrVerify::format_instance(instance)
    }

    fn circuit(
        &self,
        std_lib: &ZkStdLib,
        layouter: &mut impl Layouter<F>,
        instance: Value<Self::Instance>,
        _witness: Value<Self::Witness>,
    ) -> Result<(), plonk::Error> {
        // The same public inputs as JubjubSchnorrVerify (point + message)...
        let (pk_val, m_val) = instance.unzip();
        let _pk: AssignedNativePoint<JubjubExtended> =
            std_lib.jubjub().assign_as_public_input(layouter, pk_val)?;
        let _message: AssignedNative<F> = std_lib.assign_as_public_input(layouter, m_val)?;
        // ...but different circuit content (a fixed constant instead of the
        // Schnorr verification logic).
        let _c: AssignedNative<F> = std_lib.assign_fixed(layouter, F::from(0x416c74))?;
        Ok(())
    }

    fn used_chips(&self) -> ZkStdLibArch {
        JubjubSchnorrVerify.used_chips()
    }

    fn write_relation<W: std::io::Write>(&self, _writer: &mut W) -> std::io::Result<()> {
        Ok(())
    }

    fn read_relation<Rd: std::io::Read>(_reader: &mut Rd) -> std::io::Result<Self> {
        Ok(AltSameShapeInner)
    }
}

// (d) End-to-end test of the complete-verification helper, including the
// soundness-critical scenario the helper exists for: an INVALID inner proof
// can still be wrapped into a NATIVELY VALID outer proof; only the deferred
// accumulator pairing check catches it. One test function so the outer
// setup cost is paid once.
#[test]
fn complete_verification_helper_end_to_end() {
    let f = fixture();
    let outer_srs = srs_for_test(&f.wrapper, Some(WRAPPER_K));
    let outer_vk = setup_vk(&outer_srs, &f.wrapper);
    let outer_pk = setup_pk(&f.wrapper, &outer_vk);

    // Honest wrap: the complete verification passes.
    let outer_proof = midnight_zk_stdlib::prove::<_, blake2b_simd::State>(
        &outer_srs,
        &outer_pk,
        &f.wrapper,
        &f.instance,
        f.witness.clone(),
        OsRng,
    )
    .expect("outer proof generation should not fail");
    verify_wrapped(
        &outer_srs.verifier_params(),
        &outer_vk,
        &f.inner_vk,
        &f.instance,
        &outer_proof,
    )
    .expect("complete verification of an honest wrap must pass");

    // Malicious wrap: tamper the inner proof, re-derive the accumulator
    // from the TAMPERED transcript (as a malicious prover would), and
    // produce an outer proof. The outer circuit is satisfied (it only
    // re-runs the transcript), so the outer proof verifies natively; the
    // deferred pairing check is what rejects it.
    let mut bad_inner_proof = f.witness.inner_proof.clone();
    let mid = bad_inner_proof.len() / 2;
    bad_inner_proof[mid] ^= 0x01;
    let (bad_instance, bad_witness) =
        wrap_inner_proof::<Inner>(&f.inner_vk, &f.inner_instance, &bad_inner_proof)
            .expect("a tampered but parseable inner proof still wraps");
    let bad_outer_proof = midnight_zk_stdlib::prove::<_, blake2b_simd::State>(
        &outer_srs,
        &outer_pk,
        &f.wrapper,
        &bad_instance,
        bad_witness,
        OsRng,
    )
    .expect("the outer proof over an invalid inner proof still proves");

    // A bare native verify accepts it: this is exactly why verify_wrapped
    // must be the only entry point.
    midnight_zk_stdlib::verify::<ProofWrap<Inner>, blake2b_simd::State>(
        &outer_srs.verifier_params(),
        &outer_vk,
        &bad_instance,
        None,
        &bad_outer_proof,
    )
    .expect("the bare native verify accepts the outer proof (deferred check not run)");

    // The complete verification rejects it in the pairing-check step.
    assert!(
        verify_wrapped(
            &outer_srs.verifier_params(),
            &outer_vk,
            &f.inner_vk,
            &bad_instance,
            &bad_outer_proof,
        )
        .is_err(),
        "the deferred accumulator pairing check must reject an invalid inner proof"
    );

    // An instance whose claimed inner-vk repr does not match the outer proof
    // is rejected. Note this lands in step (a): inner_vk_repr is the first
    // outer public input, so the native verification already fails. Step (b)
    // itself is isolated below.
    let mut mismatched = f.instance.clone();
    mismatched.inner_vk_repr += F::ONE;
    assert!(
        verify_wrapped(
            &outer_srs.verifier_params(),
            &outer_vk,
            &f.inner_vk,
            &mismatched,
            &outer_proof,
        )
        .is_err(),
        "a mismatching inner vk binding must be rejected"
    );

    // Step (b) isolation: an honest wrap of a DIFFERENT inner circuit with
    // the same shape yields an outer proof that is natively valid under the
    // SAME outer vk (step (a) passes) and whose accumulator is honest, so
    // only the inner-vk binding of step (b) can reject it when the caller
    // expects the original inner circuit. The error variant is asserted:
    // a rejection that fell through to the pairing check would be Opening,
    // and a deleted step (b) would therefore fail this test.
    let alt = AltSameShapeInner;
    let alt_vk = setup_vk(&f.inner_srs, &alt);
    assert_ne!(
        alt_vk.vk().transcript_repr(),
        f.inner_vk.vk().transcript_repr(),
        "the alt inner circuit must have a different vk transcript_repr"
    );
    let alt_pk = setup_pk(&alt, &alt_vk);
    let alt_inner_proof = prove_inner(&f.inner_srs, &alt_pk, &alt, &f.inner_instance, (), OsRng)
        .expect("alt inner proof generation should not fail");
    let (alt_instance, alt_witness) =
        wrap_inner_proof::<Inner>(&alt_vk, &f.inner_instance, &alt_inner_proof)
            .expect("wrapping the alt inner proof should not fail");
    let alt_outer_proof = midnight_zk_stdlib::prove::<_, blake2b_simd::State>(
        &outer_srs,
        &outer_pk,
        &f.wrapper,
        &alt_instance,
        alt_witness,
        OsRng,
    )
    .expect("the wrapper (built from the original inner vk) proves the alt wrap");
    // Sanity: the alt wrap is honest, so its complete verification against
    // the alt vk passes; steps (a) and (c) hold for this instance.
    verify_wrapped(
        &outer_srs.verifier_params(),
        &outer_vk,
        &alt_vk,
        &alt_instance,
        &alt_outer_proof,
    )
    .expect("complete verification of the alt wrap against the alt vk must pass");
    // Against the caller's EXPECTED inner vk, step (b) must reject.
    let err = verify_wrapped(
        &outer_srs.verifier_params(),
        &outer_vk,
        &f.inner_vk,
        &alt_instance,
        &alt_outer_proof,
    )
    .expect_err("a wrap of a different same-shape inner circuit must be rejected");
    assert!(
        matches!(err, plonk::Error::InvalidInstances),
        "the rejection must come from the inner-vk binding (step (b)): {err:?}"
    );

    // The inner SRS and the outer SRS share [tau]_2 (both are downsizings
    // of the same Filecoin SRS); assert the assumption verify_wrapped
    // documents.
    assert_eq!(
        f.inner_srs.verifier_params().s_g2(),
        outer_srs.verifier_params().s_g2(),
        "inner and outer SRS must share the same tau"
    );
}

/// Pins the rotation diagnosis: the in-circuit verifier evaluates openings
/// only at rotations -1, 0, and 1, and Ed25519's challenge hash is SHA-512
/// (RFC 8032), whose chip queries rotations 2 and 3. An Ed25519 inner
/// circuit is therefore unwrappable at the pinned midnight-zk rev, while
/// the JubJub Schnorr fixture stays wrappable. If an upstream update lifts
/// the limitation, this test fails and the recursion matrix should be
/// re-measured with the Ed25519 wrapped leg enabled.
#[test]
fn ed25519_inner_circuit_is_unwrappable_wide_rotations() {
    let f = fixture();
    assert_eq!(
        unsupported_inner_rotations(&f.inner_vk),
        Vec::<i32>::new(),
        "the JubJub Schnorr inner circuit must stay wrappable"
    );

    let ed_srs = srs_for_test(&Ed25519Verify, None);
    let ed_vk = setup_vk(&ed_srs, &Ed25519Verify);
    assert_eq!(
        unsupported_inner_rotations(&ed_vk),
        vec![2, 3],
        "the SHA-512 chip's wide rotations should be the only obstruction"
    );
}

/// The wrapper accepts a valid PoseidonPreimage inner proof: the cheapest
/// device statement (knowledge of a 32-byte hash preimage) wraps at the
/// same outer size as the JubJub Schnorr fixture (the `recursion`
/// subcommand's `witness-poseidon` run confirms optimal k = 17 for this
/// inner relation too). Complements the rotation guard below with a full
/// MockProver pass; the timed end-to-end wrapped run lives in the
/// `recursion` subcommand.
#[test]
fn wrapper_accepts_valid_poseidon_preimage_inner_proof() {
    // Reuse the fixture for its SRS_DIR side effect.
    let _ = fixture();

    let relation = PoseidonPreimage;
    let vector = generated_witness_preimage();
    assert!(
        witness_preimage_verify(&vector),
        "vector must verify out-of-circuit"
    );
    let inner_instance = vector.poseidon_commitment;

    let inner_srs = srs_for_test(&relation, None);
    let inner_vk = setup_vk(&inner_srs, &relation);
    let inner_pk = setup_pk(&relation, &inner_vk);
    let inner_proof = prove_inner(
        &inner_srs,
        &inner_pk,
        &relation,
        &inner_instance,
        vector.secret,
        OsRng,
    )
    .expect("inner proof generation should not fail");

    let nb_inner_pis = PoseidonPreimage::format_instance(&inner_instance)
        .expect("formattable instance")
        .len();
    let wrapper = ProofWrap::<PoseidonPreimage>::new(&inner_vk, nb_inner_pis);
    let (instance, witness) =
        wrap_inner_proof::<PoseidonPreimage>(&inner_vk, &inner_instance, &inner_proof)
            .expect("wrapping the inner proof should not fail");

    let public_inputs =
        ProofWrap::<PoseidonPreimage>::format_instance(&instance).expect("formattable instance");
    let circuit = MidnightCircuit::new(
        &wrapper,
        Value::known(instance),
        Value::known(witness),
        Some(WRAPPER_K),
    );
    // Instance column 0 carries committed instances (unused here), column 1
    // the raw public inputs; this mirrors upstream's own MockProver tests.
    let prover = MockProver::run(&circuit, vec![vec![], public_inputs])
        .expect("wrapper synthesis should not fail");
    prover
        .verify()
        .expect("a valid preimage inner proof must satisfy the wrapper circuit");
}

/// Same full MockProver pass for a `Sha256Preimage` inner proof.
/// `#[ignore]`d by default like `discover_wrapper_optimal_k`: its wrap
/// needs outer k = 18 (one step above the JubJub Schnorr and Poseidon
/// preimage wraps), which would roughly double the suite's runtime; the
/// timed end-to-end wrapped run lives in the `recursion` subcommand. Run
/// with `cargo test -p p256-gate-circuit --release -- --ignored`.
#[test]
#[ignore]
fn wrapper_accepts_valid_sha256_preimage_inner_proof() {
    // Reuse the fixture for its SRS_DIR side effect.
    let _ = fixture();

    let relation = Sha256Preimage;
    let vector = generated_witness_preimage();
    assert!(
        witness_preimage_verify(&vector),
        "vector must verify out-of-circuit"
    );
    let inner_instance = vector.sha256_digest;

    let inner_srs = srs_for_test(&relation, None);
    let inner_vk = setup_vk(&inner_srs, &relation);
    let inner_pk = setup_pk(&relation, &inner_vk);
    let inner_proof = prove_inner(
        &inner_srs,
        &inner_pk,
        &relation,
        &inner_instance,
        vector.secret,
        OsRng,
    )
    .expect("inner proof generation should not fail");

    let nb_inner_pis = Sha256Preimage::format_instance(&inner_instance)
        .expect("formattable instance")
        .len();
    let wrapper = ProofWrap::<Sha256Preimage>::new(&inner_vk, nb_inner_pis);
    let (instance, witness) =
        wrap_inner_proof::<Sha256Preimage>(&inner_vk, &inner_instance, &inner_proof)
            .expect("wrapping the inner proof should not fail");

    let public_inputs =
        ProofWrap::<Sha256Preimage>::format_instance(&instance).expect("formattable instance");
    let circuit = MidnightCircuit::new(
        &wrapper,
        Value::known(instance),
        Value::known(witness),
        Some(SHA256_WRAPPER_K),
    );
    // Instance column 0 carries committed instances (unused here), column 1
    // the raw public inputs; this mirrors upstream's own MockProver tests.
    let prover = MockProver::run(&circuit, vec![vec![], public_inputs])
        .expect("wrapper synthesis should not fail");
    prover
        .verify()
        .expect("a valid preimage inner proof must satisfy the wrapper circuit");
}

/// Pins the wrappability of the witness-preimage inner circuits: neither
/// the Poseidon chip nor the SHA-256 chip queries rotations outside -1, 0,
/// and 1 (the upstream aggregation example wraps a sha2_256 circuit, and
/// the IVC wraps Poseidon-bearing circuits), so both relations must pass
/// the rotation guard. The end-to-end wrapped measurement lives in the
/// `recursion` subcommand (`--scheme witness-poseidon` and
/// `--scheme witness-sha256`), keeping this suite fast.
#[test]
fn witness_preimage_inner_circuits_are_wrappable() {
    // Reuse the fixture for its SRS_DIR side effect.
    let _ = fixture();

    let poseidon_srs = srs_for_test(&PoseidonPreimage, None);
    let poseidon_vk = setup_vk(&poseidon_srs, &PoseidonPreimage);
    assert_eq!(
        unsupported_inner_rotations(&poseidon_vk),
        Vec::<i32>::new(),
        "the PoseidonPreimage inner circuit must be wrappable"
    );

    let sha_srs = srs_for_test(&Sha256Preimage, None);
    let sha_vk = setup_vk(&sha_srs, &Sha256Preimage);
    assert_eq!(
        unsupported_inner_rotations(&sha_vk),
        Vec::<i32>::new(),
        "the Sha256Preimage inner circuit must be wrappable"
    );
}

/// Re-derives WRAPPER_K. Ignored by default: `optimal_k` synthesises the
/// wrapper circuit for every candidate k. Run with
/// `cargo test -p p256-gate-circuit --release -- --ignored --nocapture`.
#[test]
#[ignore]
fn discover_wrapper_optimal_k() {
    let f = fixture();
    let k = midnight_zk_stdlib::optimal_k(&f.wrapper);
    println!("wrapper over jubjub-schnorr: optimal_k = {k}");
    assert_eq!(k, WRAPPER_K, "update WRAPPER_K to match");
}
