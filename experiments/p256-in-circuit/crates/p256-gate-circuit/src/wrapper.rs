//! Proof-of-proof wrapper: a `Relation` whose statement is "I know a valid
//! inner proof for a given inner relation, verifying key, and instance".
//!
//! This is the recursion leg of the experiment (out-of-chain proving): a
//! user device proves knowledge of a signature off-chain with the scheme its
//! hardware supports (the inner proof), and an on-chain circuit verifies
//! that proof in-circuit via midnight-zk's KZG-based PLONK
//! [`VerifierGadget`](midnight_circuits::verifier::VerifierGadget). The
//! structure follows midnight-zk's
//! `aggregation/examples/single_circuit_aggregation.rs`, simplified to a
//! single-shot wrap (no IVC folding).
//!
//! # The deferred pairing check (read this before using the wrapper)
//!
//! The in-circuit verifier re-runs the PLONK verification transcript of the
//! inner proof and produces a KZG **accumulator**: a pair of points
//! `(lhs, rhs)` that satisfies `e(lhs, [tau]_2) = e(rhs, [1]_2)` if and only
//! if the inner proof is valid. THE PAIRING ITSELF IS NOT CHECKED
//! IN-CIRCUIT. The accumulator is exposed as a public input of the outer
//! proof, and the verifier of the outer proof must:
//!
//! 1. verify the outer proof natively, and
//! 2. run [`Accumulator::check`] on the accumulator carried in the outer
//!    public inputs, against the SRS verifier parameters (`[tau]_2`) and the
//!    inner verifying key's fixed bases.
//!
//! Skipping step 2 is UNSOUND: a prover can produce a perfectly valid outer
//! proof from an invalid inner proof; the invalidity only surfaces in the
//! deferred pairing check. [`verify_wrapped`] performs both steps (plus the
//! binding of the claimed inner verifying key) as one indivisible operation;
//! always use it, never a bare `verify` on the outer proof.
//!
//! # Poseidon transcript requirement
//!
//! The in-circuit verifier hashes the Fiat-Shamir transcript with a Poseidon
//! sponge, so INNER PROOFS MUST BE GENERATED WITH THE POSEIDON TRANSCRIPT
//! ([`prove_inner`]), not with blake2b. The outer proof itself is verified
//! natively, so its transcript stays blake2b like the rest of this
//! experiment.
//!
//! # Rotation limitation of the in-circuit verifier
//!
//! The verifier gadget evaluates the inner circuit's openings only at the
//! rotations -1, 0, and 1 (its `get_point` panics with "We do not support
//! other rotations" for anything else). An inner circuit whose constraint
//! system queries a wider rotation cannot be wrapped. At the pinned
//! midnight-zk rev the only `ZkStdLib` chip with wider queries is SHA-512
//! (rotations 2 and 3), which makes Ed25519 (whose challenge hash is fixed
//! to SHA-512 by RFC 8032) structurally unwrappable; use
//! [`unsupported_inner_rotations`] to detect the condition up front.

use std::{fmt::Debug, marker::PhantomData};

use midnight_circuits::{
    hash::poseidon::PoseidonState,
    instructions::{AssignmentInstructions, PublicInputInstructions},
    types::{AssignedNative, Instantiable},
    verifier::{
        self, Accumulator, AssignedAccumulator, AssignedKZGMultiCommitment, AssignedVk,
        BlstrsEmulation, InCircuitKZG, Msm, Point,
    },
};
use midnight_curves::{Bls12, G1Projective};
use midnight_proofs::{
    circuit::{Layouter, Value},
    plonk::{self, ConstraintSystem},
    poly::{
        kzg::{
            commitment::KZGMultiCommitment,
            params::{ParamsKZG, ParamsVerifierKZG},
            KZGCommitmentScheme,
        },
        EvaluationDomain, PolynomialLabel,
    },
    transcript::{CircuitTranscript, Hashable, Sampleable, Transcript},
};
use midnight_zk_stdlib::{prove, verify, MidnightPK, MidnightVK, Relation, ZkStdLib, ZkStdLibArch};
use rand::{CryptoRng, RngCore};

use crate::relations::F;

/// The self-emulation setting of the Midnight proof system: BLS12-381 G1
/// arithmetic emulated over the BLS12-381 scalar field.
pub type S = BlstrsEmulation;

/// The pairing engine of the proof system.
pub type E = Bls12;

/// Public instance of the wrapper relation.
///
/// Everything here is (re-)exposed as public inputs of the outer proof, in
/// this order: the inner verifying key's `transcript_repr`, the inner public
/// inputs, and the (collapsed) accumulator.
#[derive(Clone)]
pub struct WrapInstance<R: Relation> {
    /// `transcript_repr` of the inner verifying key: a hash binding the
    /// outer proof to the exact inner circuit being verified.
    pub inner_vk_repr: F,
    /// The inner relation's instance, re-exposed by the outer circuit.
    pub inner_instance: R::Instance,
    /// The collapsed KZG accumulator of the inner-proof verification. Its
    /// pairing invariant is checked by [`verify_wrapped`], NOT in-circuit.
    pub acc: Accumulator<S>,
}

/// Private witness of the wrapper relation: the inner instance (whose
/// re-exposure as outer public inputs is enforced by the circuit) and the
/// inner proof bytes.
#[derive(Clone)]
pub struct WrapWitness<R: Relation> {
    /// The inner relation's instance.
    pub inner_instance: R::Instance,
    /// The Poseidon-transcript inner proof.
    pub inner_proof: Vec<u8>,
}

/// The wrapper relation: verifies one inner proof of `R` in-circuit.
///
/// Parameterised at construction (off-circuit) by the inner relation's
/// verifying key, from which the inner evaluation domain and constraint
/// system are taken.
#[derive(Clone)]
pub struct ProofWrap<R: Relation> {
    inner_domain: EvaluationDomain<F>,
    inner_cs: ConstraintSystem<F>,
    nb_inner_public_inputs: usize,
    _inner: PhantomData<R>,
}

impl<R: Relation> ProofWrap<R> {
    /// Builds the wrapper for inner proofs under the given verifying key.
    ///
    /// `nb_inner_public_inputs` is the length of
    /// `R::format_instance(instance)` for the (fixed-shape) instances of
    /// `R`; it must be known circuit-shape time, before any concrete
    /// instance exists.
    pub fn new(inner_vk: &MidnightVK, nb_inner_public_inputs: usize) -> Self {
        ProofWrap {
            inner_domain: inner_vk.vk().get_domain().clone(),
            inner_cs: inner_vk.vk().cs().clone(),
            nb_inner_public_inputs,
            _inner: PhantomData,
        }
    }
}

impl<R> Relation for ProofWrap<R>
where
    R: Relation,
    R::Error: Debug,
{
    type Instance = WrapInstance<R>;

    type Witness = WrapWitness<R>;

    type Error = R::Error;

    fn format_instance(instance: &Self::Instance) -> Result<Vec<F>, R::Error> {
        Ok([
            AssignedNative::<F>::as_public_input(&instance.inner_vk_repr),
            R::format_instance(&instance.inner_instance)?,
            AssignedAccumulator::<S>::as_public_input(&instance.acc),
        ]
        .concat())
    }

    fn circuit(
        &self,
        std_lib: &ZkStdLib,
        layouter: &mut impl Layouter<F>,
        instance: Value<Self::Instance>,
        witness: Value<Self::Witness>,
    ) -> Result<(), R::Error> {
        let verifier_gadget = std_lib.verifier();

        // 1. The inner verifying key, bound by its transcript_repr, which is
        //    constrained as the first public input.
        let inner_vk: AssignedVk<S, InCircuitKZG<S>> = verifier_gadget.assign_vk_as_public_input(
            layouter,
            &self.inner_domain,
            &self.inner_cs,
            instance.map(|i| i.inner_vk_repr),
        )?;

        // 2. The inner public inputs, witnessed and re-exposed as outer
        //    public inputs (the public-input constraint enforces equality
        //    with the instance's copy).
        let inner_pis: Vec<AssignedNative<F>> = std_lib.assign_many(
            layouter,
            &witness
                .as_ref()
                .map(|w| R::format_instance(&w.inner_instance).expect("formattable inner instance"))
                .transpose_vec(self.nb_inner_public_inputs),
        )?;
        inner_pis
            .iter()
            .try_for_each(|pi| std_lib.constrain_as_public_input(layouter, pi))?;

        // 3. The inner circuit's committed-instance column is unused: a
        //    fixed commitment to the zero polynomial (the identity point),
        //    exactly matching the native side's
        //    `KZGMultiCommitment::commitment_to_zero`.
        let instance_com = AssignedKZGMultiCommitment::<S>::commitment_to_zero(
            layouter,
            std_lib.bls12_381(),
            PolynomialLabel::CommittedInstance(0),
        )?;

        // 4. Re-run the PLONK verification transcript of the inner proof
        //    in-circuit. The result is an accumulator whose pairing check is
        //    DEFERRED to the native side (see the module docs).
        let mut acc = verifier_gadget.prepare(
            layouter,
            &inner_vk,
            &[instance_com],
            &[&inner_pis],
            witness.map(|w| w.inner_proof),
        )?;

        // 5. Collapse the accumulator's variable part to one point per side
        //    and constrain it as the trailing public inputs of the outer
        //    proof, where [`verify_wrapped`] picks it up.
        acc.collapse(
            layouter,
            std_lib.bls12_381(),
            std_lib.bls12_381().scalar_field_chip(),
        )?;
        verifier_gadget.constrain_as_public_input(layouter, &acc)?;
        Ok(())
    }

    fn used_chips(&self) -> ZkStdLibArch {
        // The verifier gadget is only built when both bls12_381 and poseidon
        // are enabled.
        ZkStdLibArch {
            bls12_381: true,
            poseidon: true,
            nr_pow2range_cols: 4,
            ..ZkStdLibArch::default()
        }
    }

    fn write_relation<W: std::io::Write>(&self, _writer: &mut W) -> std::io::Result<()> {
        unimplemented!("ProofWrap serialisation is not needed for this experiment")
    }

    fn read_relation<Rd: std::io::Read>(_reader: &mut Rd) -> std::io::Result<Self> {
        unimplemented!("ProofWrap serialisation is not needed for this experiment")
    }
}

/// Returns the rotations queried by the inner circuit that the in-circuit
/// verifier cannot evaluate, sorted and deduplicated. An empty result means
/// the inner circuit is wrappable by [`ProofWrap`]; a non-empty one means
/// the verifier gadget would panic during synthesis of the wrapper (see the
/// module docs on the rotation limitation).
pub fn unsupported_inner_rotations(inner_vk: &MidnightVK) -> Vec<i32> {
    let cs = inner_vk.vk().cs();
    let mut rotations: Vec<i32> = (cs.advice_queries().iter().map(|(_, rot)| rot.0))
        .chain(cs.instance_queries().iter().map(|(_, rot)| rot.0))
        .chain(cs.fixed_queries().iter().map(|(_, rot)| rot.0))
        .filter(|rot| !(-1..=1).contains(rot))
        .collect();
    rotations.sort_unstable();
    rotations.dedup();
    rotations
}

/// Produces an inner proof with the POSEIDON Fiat-Shamir transcript, the
/// only transcript the in-circuit verifier can re-run. Inner proofs
/// generated with blake2b cannot be wrapped.
pub fn prove_inner<R: Relation>(
    srs: &ParamsKZG<E>,
    pk: &MidnightPK<R>,
    relation: &R,
    instance: &R::Instance,
    witness: R::Witness,
    rng: impl RngCore + CryptoRng,
) -> Result<Vec<u8>, R::Error> {
    prove::<R, PoseidonState<F>>(srs, pk, relation, instance, witness, rng)
}

/// Natively verifies an inner proof produced by [`prove_inner`] (Poseidon
/// transcript). This is the fair "direct" baseline when comparing against
/// the wrapped path.
pub fn verify_inner<R: Relation>(
    params_verifier: &ParamsVerifierKZG<E>,
    vk: &MidnightVK,
    instance: &R::Instance,
    proof: &[u8],
) -> Result<(), R::Error> {
    verify::<R, PoseidonState<F>>(params_verifier, vk, instance, None, proof)
}

/// Prepares an inner proof for wrapping: re-runs the PLONK verification
/// transcript off-circuit (Poseidon transcript), turns the resulting dual
/// MSM into a collapsed [`Accumulator`], and packages the wrapper's
/// instance/witness pair.
///
/// This does NOT check the inner proof's pairing invariant; an invalid (but
/// parseable) inner proof yields an accumulator that fails
/// [`Accumulator::check`], which [`verify_wrapped`] catches after the outer
/// proof is generated. Callers who want to fail early can run
/// [`verify_inner`] first.
pub fn wrap_inner_proof<R: Relation>(
    inner_vk: &MidnightVK,
    inner_instance: &R::Instance,
    inner_proof: &[u8],
) -> Result<(WrapInstance<R>, WrapWitness<R>), R::Error> {
    let inner_pis = R::format_instance(inner_instance)?;

    let mut transcript = CircuitTranscript::<PoseidonState<F>>::init_from_bytes(inner_proof);
    let dual_msm = plonk::prepare::<F, KZGCommitmentScheme<E>, CircuitTranscript<PoseidonState<F>>>(
        inner_vk.vk(),
        &[KZGMultiCommitment::commitment_to_zero(
            PolynomialLabel::CommittedInstance(0),
        )],
        &[&inner_pis],
        &mut transcript,
    )?;

    let fixed_bases = verifier::fixed_bases::<S>(inner_vk.vk());
    let mut acc = Accumulator::<S>::from_dual_msm(dual_msm, &fixed_bases);
    acc.collapse();

    Ok((
        WrapInstance {
            inner_vk_repr: inner_vk.vk().transcript_repr(),
            inner_instance: inner_instance.clone(),
            acc,
        },
        WrapWitness {
            inner_instance: inner_instance.clone(),
            inner_proof: inner_proof.to_vec(),
        },
    ))
}

/// COMPLETE verification of a wrapped proof. This single function performs
/// all three steps that soundness requires:
///
/// (a) native verification of the outer proof against the outer public
///     inputs derived from `instance` (blake2b transcript);
/// (b) binding of the claimed inner verifying key: `instance.inner_vk_repr`
///     (just verified as an outer public input) must equal the
///     `transcript_repr` of the `inner_vk` whose fixed bases are used in
///     step (c);
/// (c) the DEFERRED KZG PAIRING CHECK: [`Accumulator::check`] on the
///     accumulator carried in the outer public inputs, against the SRS
///     verifier parameters (`[tau]_2`) and the inner verifying key's fixed
///     bases.
///
/// Step (c) is the pairing check the outer circuit deliberately defers;
/// SKIPPING IT IS UNSOUND (an outer proof can be valid for an invalid inner
/// proof). Never verify the outer proof with a bare `verify` call.
///
/// `params_verifier` must belong to the SRS family both proofs were
/// generated under (the KZG verifier parameters carry only `[tau]_2`, which
/// is independent of the circuit size, so inner and outer share them).
pub fn verify_wrapped<R>(
    params_verifier: &ParamsVerifierKZG<E>,
    outer_vk: &MidnightVK,
    inner_vk: &MidnightVK,
    instance: &WrapInstance<R>,
    outer_proof: &[u8],
) -> Result<(), R::Error>
where
    R: Relation,
    R::Error: Debug,
    G1Projective: Hashable<blake2b_simd::State>,
    F: Hashable<blake2b_simd::State> + Sampleable<blake2b_simd::State>,
{
    // (a) Native verification of the outer proof. This pins the accumulator
    // (and the re-exposed inner instance) to the outer public inputs.
    verify::<ProofWrap<R>, blake2b_simd::State>(
        params_verifier,
        outer_vk,
        instance,
        None,
        outer_proof,
    )?;

    // (b) The fixed bases used below must come from the same verifying key
    // the outer circuit verified against.
    if instance.inner_vk_repr != inner_vk.vk().transcript_repr() {
        return Err(plonk::Error::InvalidInstances.into());
    }

    // (c) The deferred pairing check on the accumulator reconstructed from
    // the outer public inputs.
    //
    // Guard first: the outer public inputs pin the accumulator's VALUES but
    // not its label metadata (the flat encoding carries no labels), and
    // `Accumulator::check` PANICS on fixed-base scalar labels absent from
    // the fixed-bases map. Reject such a malformed instance as an error
    // instead; every other label manipulation fails closed in (a) or in the
    // pairing check below.
    let fixed_bases = verifier::fixed_bases::<S>(inner_vk.vk());
    let labels_resolvable = |msm: &Msm<S>| {
        (msm.bases().iter().zip(msm.labels()))
            .all(|(base, label)| !matches!(base, Point::Fixed) || fixed_bases.contains_key(&label))
    };
    if !labels_resolvable(&instance.acc.lhs()) || !labels_resolvable(&instance.acc.rhs()) {
        return Err(plonk::Error::InvalidInstances.into());
    }
    if !instance.acc.check(params_verifier, &fixed_bases) {
        return Err(plonk::Error::Opening.into());
    }

    Ok(())
}
