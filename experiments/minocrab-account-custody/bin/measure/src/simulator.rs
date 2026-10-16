//! Adapted from Minocrab 537721a crates/minocrab-sim/src/v3.rs (MIT; see vendor/LICENSE-MIT).
//! Uses the Compact 0.35 ZKIR 3.1 backend and its value helpers, including byte operations and P256.
//! Every completed fixture is also checked by the unmodified backend.
use std::collections::BTreeMap;
use std::collections::HashMap;

use group::Group;
use midnight_base_crypto::repr::BinaryHashRepr;
use midnight_curves::{Fr as JubjubFr, JubjubSubgroup, curve25519, k256, p256};
use midnight_transient_crypto::curve::{FR_BITS, FR_BYTES_STORED, Fr};
use midnight_transient_crypto::fab::{AlignmentExt, ValueReprAlignedValue};
use midnight_transient_crypto::hash::{hash_to_curve, transient_commit, transient_hash};
use midnight_transient_crypto::proofs::{ProofPreimage, Zkir};
use reference_zkir::ir_instructions::add::add_offcircuit;
use reference_zkir::ir_instructions::constrain_eq::constrain_eq_offcircuit;
use reference_zkir::ir_instructions::ec_mul::ec_mul_offcircuit;
use reference_zkir::ir_instructions::encode::{
    decode_offcircuit, encode_offcircuit, native_to_jubjub_scalar,
};
use reference_zkir::ir_instructions::eq::test_eq_offcircuit;
use reference_zkir::ir_instructions::from_bytes::from_bytes_offcircuit as from_bytes32_offcircuit;
use reference_zkir::ir_instructions::from_coordinates::from_coordinates_offcircuit;
use reference_zkir::ir_instructions::into_coordinates::into_coordinates_offcircuit;
use reference_zkir::ir_instructions::inv::inv_offcircuit;
use reference_zkir::ir_instructions::mul::mul_offcircuit;
use reference_zkir::ir_instructions::neg::neg_offcircuit;
use reference_zkir::ir_instructions::select::select_offcircuit;
use reference_zkir::ir_instructions::to_bytes::to_bytes_offcircuit as into_bytes32_offcircuit;
use reference_zkir::{Instruction as I, IrSource};

use reference_zkir::{
    Identifier,
    ir::Operand,
    ir_types::{IrType, IrValue},
};
use sha2::Sha256;
use sha3::{Digest, Keccak256};

#[derive(Debug, thiserror::Error)]
pub enum Sim3Error {
    #[error("instruction {at} ({op}): {message}")]
    Failed {
        at: usize,
        op: &'static str,
        message: String,
    },
    /// Argument decoding failed before any instruction ran (ir_vm.rs:191-211).
    #[error("inputs: {0}")]
    Inputs(String),
    /// A transcript was not consumed exactly (ir_vm.rs:648-661).
    #[error("transcripts not fully consumed: {0}")]
    Transcript(String),
    /// Communications-commitment handling failed (ir_vm.rs:214-221, 662-681).
    #[error("communications commitment: {0}")]
    CommCommitment(String),
}

fn fail(at: usize, op: &'static str, message: impl Into<String>) -> Sim3Error {
    Sim3Error::Failed {
        at,
        op,
        message: message.into(),
    }
}

/// The result of simulating one v3 circuit run — upstream's `Preprocessed`
/// (ir_vm.rs:71-77) with `pis` kept as [`Fr`] instead of unwrapped
/// `outer::Scalar`, plus outputs and run metrics.
#[derive(Debug, Clone)]
pub struct Run3 {
    /// Full typed value memory at the end of the run, by identifier.
    pub memory: HashMap<Identifier, IrValue>,
    /// The proof-system public-input vector: `binding_input`, then (when
    /// enabled) the communications commitment, then one element per
    /// `Impact` input — zeros where the guard was off.
    pub pis: Vec<Fr>,
    /// One entry per `Impact`: `None` if taken, `Some(count)` if its guard
    /// was off and `count` zeros were substituted in `pis`.
    pub pi_skips: Vec<Option<usize>>,
    /// The preimage's binding input (always `pis[0]`).
    pub binding_input: Fr,
    /// The preimage's `(commitment, randomness)`, if any.
    pub comm_comm: Option<(Fr, Fr)>,
    /// Values produced by the `Output` terminator (circuit return values).
    pub outputs: Vec<IrValue>,
    /// Raw `Fr` elements consumed from the private transcript.
    pub consumed_private: usize,
    /// Raw `Fr` elements consumed from the public transcript outputs.
    pub consumed_public: usize,
    /// Instruction execution counts by opcode.
    pub op_counts: BTreeMap<&'static str, u32>,
    /// The `Impact` public inputs the run ACCUMULATED, in order — the
    /// preimage's `public_transcript_inputs` as the circuit computes them
    /// (guarded-off blocks contribute nothing). Under [`simulate`] this is
    /// equal to `preimage.public_transcript_inputs` by construction, since
    /// each element is checked as it accumulates; under [`Mode::Gather`] it
    /// is the run's OUTPUT — the Impact op stream the circuit asks for.
    pub public_transcript_inputs: Vec<Fr>,
    /// Instruction indices whose `Assert` failed. Always empty under
    /// [`simulate`], which returns `Err` on the first one; under
    /// [`Mode::Gather`] asserts are recorded rather than fatal, because a
    /// gather pass runs against a provisional transcript.
    pub assert_failures: Vec<usize>,
    /// Instructions that FAILED outright under [`Mode::Gather`] — a value
    /// the fixpoint has not resolved yet is not a valid value of its type.
    /// Always empty under [`simulate`]. A non-empty list means
    /// [`Run3::public_transcript_inputs`] is a prefix, not the whole
    /// transcript.
    pub walk_failures: Vec<(usize, String)>,
}

/// How [`simulate_with`] treats the preimage's public halves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The reference semantics: every transcript is checked and consumed
    /// exactly, a failed assert aborts. This is [`simulate`].
    Verify,
    /// The executor's pass (`v3::exec`): `public_transcript_outputs` is a
    /// PROVISIONAL guess — short reads yield zeros, `Impact` inputs are
    /// accumulated rather than checked, the two public halves need not be
    /// consumed exactly, and a failed assert is recorded, not fatal. The
    /// private transcript and the arguments are still exact.
    Gather,
}

/// Opcode name of a v3 instruction (for metrics and error messages).
pub fn op_name(ins: &I) -> &'static str {
    match ins {
        I::Add { .. } => "add",
        I::Assert { .. } => "assert",
        I::Bytes32FromLowHigh { .. } => "bytes32_from_low_high",
        I::Bytes32IntoLowHigh { .. } => "bytes32_into_low_high",
        I::CondSelect { .. } => "cond_select",
        I::ConstrainBits { .. } => "constrain_bits",
        I::ConstrainEq { .. } => "constrain_eq",
        I::ConstrainToBoolean { .. } => "constrain_to_boolean",
        I::Copy { .. } => "copy",
        I::DivModPowerOfTwo { .. } => "div_mod_power_of_two",
        I::EcMul { .. } => "ec_mul",
        I::EcMulGenerator { .. } => "ec_mul_generator",
        I::Encode { .. } => "encode",
        I::FromBytes32 { .. } => "from_bytes32",
        I::FromCoordinates { .. } => "from_coordinates",
        I::HashToCurve { .. } => "hash_to_curve",
        I::Impact { .. } => "impact",
        I::IntoBytes32 { .. } => "into_bytes32",
        I::IntoCoordinates { .. } => "into_coordinates",
        I::Inv { .. } => "inv",
        I::JubjubScalarFromNative { .. } => "jubjub_scalar_from_native",
        I::Keccak256 { .. } => "keccak256",
        I::LessThan { .. } => "less_than",
        I::Mul { .. } => "mul",
        I::Neg { .. } => "neg",
        I::Not { .. } => "not",
        I::Output { .. } => "output",
        I::PersistentHash { .. } => "persistent_hash",
        I::PrivateInput { .. } => "private_input",
        I::PublicInput { .. } => "public_input",
        I::ReconstituteField { .. } => "reconstitute_field",
        I::ReverseBytes { .. } => "reverse_bytes",
        I::TestEq { .. } => "test_eq",
        I::TransientHash { .. } => "transient_hash",
        I::ToBytes { .. } => "to_bytes",
        I::FromBytes { .. } => "from_bytes",
        I::BytesIntoNatives { .. } => "bytes_into_natives",
        I::BytesFromNatives { .. } => "bytes_from_natives",
        _ => "unsupported",
    }
}

/// Runtime type of a value — mirror of the `pub(crate)`
/// `IrValue::get_type` (ir_types.rs:161-180).
fn ir_type_of(value: &IrValue) -> IrType {
    match value {
        IrValue::Native(_) => IrType::Native,
        IrValue::Bool(_) => IrType::Bool,
        IrValue::Byte(_) => IrType::Byte,
        IrValue::Bytes(bs) => IrType::Bytes(bs.len() as u32),
        IrValue::JubjubPoint(_) => IrType::JubjubPoint,
        IrValue::JubjubScalar(_) => IrType::JubjubScalar,
        IrValue::Secp256k1Point(_) => IrType::Secp256k1Point,
        IrValue::Secp256k1Base(_) => IrType::Secp256k1Base,
        IrValue::Secp256k1Scalar(_) => IrType::Secp256k1Scalar,
        IrValue::Secp256r1Point(_) => IrType::Secp256r1Point,
        IrValue::Secp256r1Base(_) => IrType::Secp256r1Base,
        IrValue::Secp256r1Scalar(_) => IrType::Secp256r1Scalar,
        IrValue::Curve25519Point(_) => IrType::Curve25519Point,
        IrValue::Curve25519Base(_) => IrType::Curve25519Base,
        IrValue::Curve25519Scalar(_) => IrType::Curve25519Scalar,
    }
}

/// Default (zero/identity) value of a type, produced by guarded-off
/// transcript reads — mirror of the `pub(crate)` `IrValue::default`
/// (ir_types.rs:182-203).
fn default_ir_value(val_t: &IrType) -> IrValue {
    match val_t {
        IrType::Native => IrValue::Native(Fr::default()),
        IrType::Bool => IrValue::Bool(false),
        IrType::Byte => IrValue::Byte(0),
        IrType::Bytes(n) => IrValue::Bytes(vec![0; *n as usize]),
        IrType::JubjubPoint => IrValue::JubjubPoint(JubjubSubgroup::default()),
        IrType::JubjubScalar => IrValue::JubjubScalar(JubjubFr::default()),
        IrType::Secp256k1Point => IrValue::Secp256k1Point(k256::K256::default()),
        IrType::Secp256k1Base => IrValue::Secp256k1Base(k256::Fp::default()),
        IrType::Secp256k1Scalar => IrValue::Secp256k1Scalar(k256::Fq::default()),
        IrType::Secp256r1Point => IrValue::Secp256r1Point(p256::P256::default()),
        IrType::Secp256r1Base => IrValue::Secp256r1Base(p256::Fp::default()),
        IrType::Secp256r1Scalar => IrValue::Secp256r1Scalar(p256::Fq::default()),
        IrType::Curve25519Point => {
            IrValue::Curve25519Point(curve25519::Curve25519Subgroup::default())
        }
        IrType::Curve25519Base => IrValue::Curve25519Base(curve25519::Fp::default()),
        IrType::Curve25519Scalar => IrValue::Curve25519Scalar(curve25519::Scalar::default()),
    }
}

/// One circuit argument: `TypedIdentifier`'s fields are `pub(crate)`
/// upstream, so recover them through its serde form (`{"name", "type"}`),
/// the same trick `minocrab_ir::v3::typed_identifier` uses to build them.
#[derive(serde::Deserialize)]
struct InputSchema {
    name: Identifier,
    #[serde(rename = "type")]
    val_t: IrType,
}

fn input_schema(ir: &IrSource) -> Result<Vec<InputSchema>, Sim3Error> {
    ir.inputs
        .iter()
        .map(|ti| {
            serde_json::to_value(ti)
                .and_then(serde_json::from_value)
                .map_err(|e| Sim3Error::Inputs(format!("cannot read input schema: {e}")))
        })
        .collect()
}

// --- operand resolution (ir_vm.rs:227-278) ---------------------------------------

fn get(
    memory: &HashMap<Identifier, IrValue>,
    id: &Identifier,
    at: usize,
    op: &'static str,
) -> Result<IrValue, Sim3Error> {
    memory
        .get(id)
        .cloned()
        .ok_or_else(|| fail(at, op, format!("variable not found: {id:?}")))
}

fn operand(
    memory: &HashMap<Identifier, IrValue>,
    o: &Operand,
    at: usize,
    op: &'static str,
) -> Result<IrValue, Sim3Error> {
    match o {
        Operand::Variable(id) => get(memory, id, at, op),
        Operand::Immediate(imm) => Ok(IrValue::Native(*imm)),
    }
}

fn operand_fr(
    memory: &HashMap<Identifier, IrValue>,
    o: &Operand,
    at: usize,
    op: &'static str,
) -> Result<Fr, Sim3Error> {
    operand(memory, o, at, op)?
        .try_into()
        .map_err(|e| fail(at, op, format!("{e}")))
}

fn operand_bool(
    memory: &HashMap<Identifier, IrValue>,
    o: &Operand,
    at: usize,
    op: &'static str,
) -> Result<bool, Sim3Error> {
    let val = operand_fr(memory, o, at, op)?;
    if val == 0.into() {
        Ok(false)
    } else if val == 1.into() {
        Ok(true)
    } else {
        Err(fail(at, op, format!("expected boolean, found: {val:?}")))
    }
}

fn bits_of(val: Fr) -> Vec<bool> {
    val.as_le_bytes()
        .into_iter()
        .flat_map(|byte| {
            [0x01u8, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]
                .into_iter()
                .map(move |mask| byte & mask != 0)
        })
        .collect()
}

fn operand_bits(
    memory: &HashMap<Identifier, IrValue>,
    o: &Operand,
    constrain: Option<u32>,
    at: usize,
    op: &'static str,
) -> Result<Vec<bool>, Sim3Error> {
    let val = operand_fr(memory, o, at, op)?;
    let mut bits = bits_of(val);
    if let Some(n) = constrain {
        if n as usize >= FR_BITS {
            return Err(fail(at, op, "excessive bit bound"));
        }
        if bits[n as usize..].iter().any(|b| *b) {
            return Err(fail(
                at,
                op,
                format!("bit bound failed: {val:?} is not {n}-bit"),
            ));
        }
        bits.truncate(n as usize);
    }
    Ok(bits)
}

fn from_bits(bits: impl DoubleEndedIterator<Item = bool>) -> Fr {
    bits.rev().fold(Fr::from(0u64), |acc, bit| {
        acc * Fr::from(2u64) + Fr::from(bit as u64)
    })
}

/// Read `width` raw elements from a transcript, or fail. Upstream slices
/// unchecked (`&transcript[i..i + w]`, ir_vm.rs:359, 378) and therefore
/// *panics* on exhaustion; this is the one place the port surfaces an error
/// instead — same rejection, no panic.
fn take_raw<'t>(
    transcript: &'t [Fr],
    idx: usize,
    width: usize,
    at: usize,
    op: &'static str,
    what: &str,
) -> Result<&'t [Fr], Sim3Error> {
    transcript
        .get(idx..idx + width)
        .ok_or_else(|| fail(at, op, format!("ran out of {what}")))
}

/// THE DIFFERENTIAL COMPARATOR — call-compatibility of two artifacts on one
/// preimage, the criterion every `*differential*` suite gates on
/// (VERIFICATION.md §3(c), notes/ledger-abi.org §6):
///
/// 1. the typed interface — input types in order, and the outputs;
/// 2. the PI stream — identical `pis` and `pi_skips` from this simulator on
///    both artifacts;
/// 3. upstream agreement — Midnight's own `IrSource::check` accepts both and
///    reports the same `pi_skips` this simulator computed, so a simulator bug
///    cannot hide behind the comparison it performs.
///
/// It lives here, once, because the external review (§3.8) found eleven
/// copies of it across the test crates and one that had drifted weaker (the
/// opt fork's dropped the schema check and `theirs.check`). One body is what
/// a third-party pass will call to ship its own proof of preservation (M24
/// point 3) — the harness as public API starts with this function.
pub fn assert_call_compatible(ours: &IrSource, theirs: &IrSource, pi: &ProofPreimage) {
    let types = |ir: &IrSource| {
        serde_json::to_value(&ir.inputs)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|ti| ti["type"].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(types(ours), types(theirs), "input schemas differ");
    assert_eq!(ours.outputs, theirs.outputs, "output schemas differ");

    let our_run = simulate(ours, pi).expect("our artifact accepts");
    let their_run = simulate(theirs, pi).expect("the other artifact accepts");
    assert_eq!(our_run.pi_skips, their_run.pi_skips, "pi_skips differ");
    assert_eq!(our_run.pis, their_run.pis, "PI vectors differ");

    assert_eq!(
        ours.check(pi).expect("upstream accepts ours"),
        our_run.pi_skips
    );
    assert_eq!(
        theirs.check(pi).expect("upstream accepts theirs"),
        their_run.pi_skips
    );
}

/// Simulate one run of `ir` against a complete proof preimage, mirroring
/// `IrSource::preprocess` (ir_vm.rs:185-691) instruction for instruction.
///
/// `preimage.inputs` is the circuit's *encoded* argument list: each argument
/// occupies `IrType::encoded_len` consecutive raw `Fr` elements.
pub fn simulate(ir: &IrSource, preimage: &ProofPreimage) -> Result<Run3, Sim3Error> {
    simulate_with(ir, preimage, Mode::Verify)
}

/// [`simulate`], with the treatment of the public transcript halves chosen
/// by `mode` — the one walk both the verifier and the executor run, so the
/// two cannot drift.
pub fn simulate_with(
    ir: &IrSource,
    preimage: &ProofPreimage,
    mode: Mode,
) -> Result<Run3, Sim3Error> {
    let gather = mode == Mode::Gather;
    let mut memory: HashMap<Identifier, IrValue> = HashMap::new();
    let mut public_transcript_inputs: Vec<Fr> = Vec::new();
    let mut assert_failures: Vec<usize> = Vec::new();
    let mut walk_failures: Vec<(usize, String)> = Vec::new();
    let mut transcript_truncated = false;

    // Decode the flattened argument list per the input schema (ir_vm.rs:191-211).
    let mut idx = 0usize;
    for input in input_schema(ir)? {
        let w = input.val_t.encoded_len();
        if idx + w > preimage.inputs.len() {
            return Err(Sim3Error::Inputs(format!(
                "not enough raw inputs: ran out at index {idx} while decoding {:?}",
                input.name
            )));
        }
        let value = decode_offcircuit(&preimage.inputs[idx..idx + w], &input.val_t)
            .map_err(|e| Sim3Error::Inputs(format!("{e}")))?;
        memory.insert(input.name, value);
        idx += w;
    }
    if idx != preimage.inputs.len() {
        return Err(Sim3Error::Inputs(format!(
            "expected {idx} raw inputs, received {}",
            preimage.inputs.len()
        )));
    }

    // The PI vector opens with the binding input, then (when enabled) the
    // communications commitment (ir_vm.rs:213-221).
    let mut pis: Vec<Fr> = vec![preimage.binding_input];
    if ir.do_communications_commitment {
        // Under `Mode::Gather` the commitment spans the circuit's OUTPUTS,
        // which this pass is still computing; the executor fills it in once
        // they are known, so an absent one is not an error here.
        match preimage.communications_commitment {
            Some((c, _)) => pis.push(c),
            None if gather => pis.push(Fr::from(0u64)),
            None => {
                return Err(Sim3Error::CommCommitment(
                    "expected communications commitment".into(),
                ));
            }
        }
    }
    let mut pi_skips: Vec<Option<usize>> = Vec::new();
    let mut public_transcript_inputs_idx = 0usize;
    let mut public_transcript_outputs_idx = 0usize;
    let mut private_transcript_idx = 0usize;
    let mut outputs: Vec<IrValue> = Vec::new();
    let mut op_counts: BTreeMap<&'static str, u32> = BTreeMap::new();

    for (at, ins) in ir.instructions.iter().enumerate() {
        let op = op_name(ins);
        *op_counts.entry(op).or_default() += 1;
        // Under `Mode::Gather` every value in flight may be provisional —
        // a read the fixpoint has not resolved yet — so an instruction can
        // fail on garbage that the next round replaces. Such a failure is
        // RECORDED and the walk goes on, but nothing further is appended to
        // the transcript: what has accumulated so far is a correct PREFIX
        // (op emission depends only on earlier reads), and a prefix is
        // exactly what the fixpoint needs to make progress. Under
        // `Mode::Verify` the closure's first `Err` is the function's.
        let mut step = || -> Result<(), Sim3Error> {
            match ins {
                // ir_vm.rs:287-299
                I::Encode { input, outputs } => {
                    let val = operand(&memory, input, at, op)?;
                    let encoded = encode_offcircuit(&val);
                    if encoded.len() != outputs.len() {
                        return Err(fail(
                            at,
                            op,
                            format!(
                                "unexpected output length of encode instruction: {:?}",
                                ir_type_of(&val)
                            ),
                        ));
                    }
                    for (out_id, enc_val) in outputs.iter().zip(encoded) {
                        memory.insert(out_id.clone(), enc_val);
                    }
                }
                // ir_vm.rs:300-321 — typed arithmetic via zkir-v3's own helpers.
                I::Add { a, b, output } => {
                    let a = operand(&memory, a, at, op)?;
                    let b = operand(&memory, b, at, op)?;
                    let result =
                        add_offcircuit(&a, &b).map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), result);
                }
                I::Mul { a, b, output } => {
                    let a = operand(&memory, a, at, op)?;
                    let b = operand(&memory, b, at, op)?;
                    let result =
                        mul_offcircuit(&a, &b).map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), result);
                }
                I::Neg { a, output } => {
                    let a = operand(&memory, a, at, op)?;
                    let result = neg_offcircuit(&a).map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), result);
                }
                I::Inv { a, output } => {
                    let a = operand(&memory, a, at, op)?;
                    let result = inv_offcircuit(&a).map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), result);
                }
                // ir_vm.rs:322-325
                I::Not { a, output } => {
                    let result =
                        IrValue::Native(Fr::from(!operand_bool(&memory, a, at, op)? as u64));
                    memory.insert(output.clone(), result);
                }
                // ir_vm.rs:326-330
                I::ConstrainEq { a, b } => {
                    let a = operand(&memory, a, at, op)?;
                    let b = operand(&memory, b, at, op)?;
                    constrain_eq_offcircuit(&a, &b).map_err(|e| fail(at, op, format!("{e}")))?;
                }
                // ir_vm.rs:331-336
                I::CondSelect { bit, a, b, output } => {
                    let bit_val = operand_bool(&memory, bit, at, op)?;
                    let a_val = operand(&memory, a, at, op)?;
                    let b_val = operand(&memory, b, at, op)?;
                    let result = select_offcircuit(bit_val, &a_val, &b_val)
                        .map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), result);
                }
                // ir_vm.rs:337-341
                I::Assert { cond } => {
                    if !operand_bool(&memory, cond, at, op)? {
                        if !gather {
                            return Err(fail(at, op, "failed direct assertion"));
                        }
                        // A circuit that rejects has NO transcript past the
                        // rejection: everything after a failed assert is
                        // unconstrained, and emitting it would put values in
                        // the op stream that no state could justify. Recording
                        // the index and truncating leaves a prefix the fixpoint
                        // can still settle on, and a settled run whose first
                        // failure is an assert is a REJECTION, not an error.
                        assert_failures.push(at);
                        transcript_truncated = true;
                    }
                }
                // ir_vm.rs:342-347
                I::TestEq { a, b, output } => {
                    let a = operand(&memory, a, at, op)?;
                    let b = operand(&memory, b, at, op)?;
                    let result =
                        test_eq_offcircuit(&a, &b).map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), IrValue::Native(Fr::from(result as u64)));
                }
                // ir_vm.rs:348-366 — a guarded-off read yields the type's
                // default and consumes nothing.
                I::PublicInput {
                    guard,
                    val_t,
                    output,
                } => {
                    let val = match guard {
                        Some(guard) if !operand_bool(&memory, guard, at, op)? => {
                            default_ir_value(val_t)
                        }
                        _ => {
                            let w = val_t.encoded_len();
                            // Under `Mode::Gather` the outputs half is the
                            // provisional guess the fixpoint is refining; a
                            // read past its end reads zeros (the value the
                            // NEXT iteration replaces), rather than failing.
                            let padded: Vec<Fr>;
                            let raw = if gather
                                && public_transcript_outputs_idx + w
                                    > preimage.public_transcript_outputs.len()
                            {
                                padded = (0..w)
                                    .map(|i| {
                                        preimage
                                            .public_transcript_outputs
                                            .get(public_transcript_outputs_idx + i)
                                            .copied()
                                            .unwrap_or_else(|| Fr::from(0u64))
                                    })
                                    .collect();
                                &padded[..]
                            } else {
                                take_raw(
                                    &preimage.public_transcript_outputs,
                                    public_transcript_outputs_idx,
                                    w,
                                    at,
                                    op,
                                    "public transcript outputs",
                                )?
                            };
                            public_transcript_outputs_idx += w;
                            match decode_offcircuit(raw, val_t) {
                                Ok(v) => v,
                                // A provisional guess is not a valid value of
                                // every type — five zeros are not a curve
                                // point. Under `Mode::Gather` the type's
                                // default stands in until the round that reads
                                // the real one.
                                Err(_) if gather => default_ir_value(val_t),
                                Err(e) => return Err(fail(at, op, format!("{e}"))),
                            }
                        }
                    };
                    memory.insert(output.clone(), val);
                }
                // ir_vm.rs:367-386
                I::PrivateInput {
                    guard,
                    val_t,
                    output,
                } => {
                    let val = match guard {
                        Some(guard) if !operand_bool(&memory, guard, at, op)? => {
                            default_ir_value(val_t)
                        }
                        _ => {
                            let w = val_t.encoded_len();
                            let raw = take_raw(
                                &preimage.private_transcript,
                                private_transcript_idx,
                                w,
                                at,
                                op,
                                "private transcript",
                            )?;
                            private_transcript_idx += w;
                            decode_offcircuit(raw, val_t)
                                .map_err(|e| fail(at, op, format!("{e}")))?
                        }
                    };
                    memory.insert(output.clone(), val);
                }
                // ir_vm.rs:387-390
                I::Copy { val, output } => {
                    let val = operand(&memory, val, at, op)?;
                    memory.insert(output.clone(), val);
                }
                // ir_vm.rs:391
                I::ConstrainToBoolean { val } => {
                    operand_bool(&memory, val, at, op)?;
                }
                // ir_vm.rs:392-394
                I::ConstrainBits { val, bits } => {
                    operand_bits(&memory, val, Some(*bits), at, op)?;
                }
                // ir_vm.rs:395-411
                I::DivModPowerOfTwo { val, bits, outputs } => {
                    if outputs.len() != 2 {
                        return Err(fail(at, op, "DivModPowerOfTwo requires exactly 2 outputs"));
                    }
                    if *bits as usize > FR_BYTES_STORED * 8 {
                        return Err(fail(at, op, "excessive bit count"));
                    }
                    let val_bits = operand_bits(&memory, val, None, at, op)?;
                    memory.insert(
                        outputs[0].clone(),
                        IrValue::Native(from_bits(val_bits[*bits as usize..].iter().copied())),
                    );
                    memory.insert(
                        outputs[1].clone(),
                        IrValue::Native(from_bits(val_bits[..*bits as usize].iter().copied())),
                    );
                }
                // ir_vm.rs:412-453
                I::ReconstituteField {
                    divisor,
                    modulus,
                    bits,
                    output,
                } => {
                    if *bits as usize > FR_BYTES_STORED * 8 {
                        return Err(fail(at, op, "excessive bit count"));
                    }
                    let max_bits = bits_of(Fr::from(-1i64));
                    let modulus_bits = operand_bits(&memory, modulus, Some(*bits), at, op)?;
                    let divisor_bits =
                        operand_bits(&memory, divisor, Some(FR_BITS as u32 - *bits), at, op)?;
                    let cmp = modulus_bits
                        .iter()
                        .chain(divisor_bits.iter())
                        .rev()
                        .zip(max_bits[..FR_BITS].iter().rev())
                        .map(|(ab, max)| ab.cmp(max))
                        .fold(std::cmp::Ordering::Equal, |prefix, local| {
                            if prefix.is_eq() { local } else { prefix }
                        });
                    if cmp.is_gt() {
                        return Err(fail(at, op, "reconstituted element overflows field"));
                    }
                    let power = (0..*bits).fold(Fr::from(1u64), |acc, _| Fr::from(2u64) * acc);
                    let modulus = operand_fr(&memory, modulus, at, op)?;
                    let divisor = operand_fr(&memory, divisor, at, op)?;
                    memory.insert(output.clone(), IrValue::Native(power * divisor + modulus));
                }
                // ir_vm.rs:454-462
                I::LessThan { a, b, bits, output } => {
                    let a = from_bits(operand_bits(&memory, a, Some(*bits), at, op)?.into_iter());
                    let b = from_bits(operand_bits(&memory, b, Some(*bits), at, op)?.into_iter());
                    memory.insert(output.clone(), IrValue::Native(Fr::from((a < b) as u64)));
                }
                // ir_vm.rs:463-467 — reduction mod the Jubjub scalar order.
                I::JubjubScalarFromNative { native, output } => {
                    let x = operand_fr(&memory, native, at, op)?;
                    memory.insert(
                        output.clone(),
                        IrValue::JubjubScalar(native_to_jubjub_scalar(&x)),
                    );
                }
                // ir_vm.rs:468-477
                I::TransientHash { inputs, output } => {
                    let vals = inputs
                        .iter()
                        .map(|i| operand_fr(&memory, i, at, op))
                        .collect::<Result<Vec<Fr>, _>>()?;
                    memory.insert(output.clone(), IrValue::Native(transient_hash(&vals)));
                }
                // ir_vm.rs:478-506 — SHA-256 / Keccak-256 over the FAB-aligned
                // byte encoding of native inputs; result is Bytes<32>.
                I::PersistentHash {
                    alignment,
                    inputs,
                    output,
                }
                | I::Keccak256 {
                    alignment,
                    inputs,
                    output,
                } => {
                    let inputs = inputs
                        .iter()
                        .map(|i| operand_fr(&memory, i, at, op))
                        .collect::<Result<Vec<Fr>, _>>()?;
                    let value = alignment.parse_field_repr(&inputs).ok_or_else(|| {
                        fail(
                            at,
                            op,
                            format!("inputs did not match alignment: {inputs:?}"),
                        )
                    })?;
                    let mut repr = Vec::new();
                    ValueReprAlignedValue(value).binary_repr(&mut repr);
                    let hash_output: [u8; 32] = match ins {
                        I::PersistentHash { .. } => Sha256::digest(&repr).into(),
                        _ => Keccak256::digest(&repr).into(),
                    };
                    memory.insert(output.clone(), IrValue::Bytes(hash_output.to_vec()));
                }
                // ir_vm.rs:507-543 — v3's public-input block. A guarded-off
                // Impact still pushes `count` *zeros* into the PI vector
                // (matching the in-circuit `select(guard, x, 0)`) and records
                // the skip; a taken one pushes the values and checks them
                // against the preimage's declared public transcript inputs.
                I::Impact { guard, inputs } => {
                    let count = inputs.len();
                    if !operand_bool(&memory, guard, at, op)? {
                        for _ in inputs {
                            pis.push(Fr::from(0u64));
                        }
                        pi_skips.push(Some(count));
                    } else {
                        // Resolve every input BEFORE publishing any: an op is
                        // one Impact instruction, and half an op in the
                        // transcript would not decode. (Verify mode never gets
                        // here with an unresolvable operand.)
                        let values = inputs
                            .iter()
                            .map(|input| operand_fr(&memory, input, at, op))
                            .collect::<Result<Vec<Fr>, _>>()?;
                        for x in values {
                            pis.push(x);
                            if !transcript_truncated {
                                public_transcript_inputs.push(x);
                            }
                            public_transcript_inputs_idx += 1;
                        }
                        pi_skips.push(None);
                        // Under `Mode::Gather` there is nothing to check
                        // against: the accumulated values ARE the transcript.
                        for i in 0..if gather { 0 } else { count } {
                            let idx = public_transcript_inputs_idx - count + i;
                            let expected = preimage.public_transcript_inputs.get(idx).copied();
                            let computed = Some(pis[pis.len() - count + i]);
                            if expected != computed {
                                return Err(fail(
                                    at,
                                    op,
                                    format!(
                                        "public transcript input mismatch for input {idx}; \
                                     expected: {expected:?}, computed: {computed:?}"
                                    ),
                                ));
                            }
                        }
                    }
                }
                // ir_vm.rs:544-552
                I::HashToCurve { inputs, output } => {
                    let vals = inputs
                        .iter()
                        .map(|i| operand_fr(&memory, i, at, op))
                        .collect::<Result<Vec<Fr>, _>>()?;
                    memory.insert(output.clone(), IrValue::JubjubPoint(hash_to_curve(&vals).0));
                }
                // ir_vm.rs:553-558
                I::EcMul { a, scalar, output } => {
                    let p = operand(&memory, a, at, op)?;
                    let s = operand(&memory, scalar, at, op)?;
                    let r = ec_mul_offcircuit(&p, &s).map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), r);
                }
                // ir_vm.rs:559-568
                I::EcMulGenerator { scalar, output } => {
                    let s = operand(&memory, scalar, at, op)?;
                    let p = match ir_type_of(&s) {
                        IrType::JubjubScalar => IrValue::JubjubPoint(JubjubSubgroup::generator()),
                        IrType::Secp256k1Scalar => IrValue::Secp256k1Point(k256::K256::generator()),
                        IrType::Secp256r1Scalar => IrValue::Secp256r1Point(p256::P256::generator()),
                        t => {
                            return Err(fail(
                                at,
                                op,
                                format!("unsupported EcMulGenerator for scalar of type {t:?}"),
                            ));
                        }
                    };
                    let r = ec_mul_offcircuit(&p, &s).map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), r);
                }
                // ir_vm.rs:569-574
                I::IntoCoordinates { point, outputs } => {
                    let p = operand(&memory, point, at, op)?;
                    let coordinates = into_coordinates_offcircuit(&p)
                        .map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(outputs.0.clone(), coordinates.0);
                    memory.insert(outputs.1.clone(), coordinates.1);
                }
                // ir_vm.rs:575-580
                I::FromCoordinates { inputs, output } => {
                    let x = operand(&memory, &inputs.0, at, op)?;
                    let y = operand(&memory, &inputs.1, at, op)?;
                    let p = from_coordinates_offcircuit(&x, &y)
                        .map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), p);
                }
                // ir_vm.rs:581-585
                I::IntoBytes32 { input, output } | I::ToBytes { input, output } => {
                    let x = operand(&memory, input, at, op)?;
                    let bytes =
                        into_bytes32_offcircuit(&x).map_err(|e| fail(at, op, format!("{e}")))?;
                    if matches!(ins, I::IntoBytes32 { .. }) {
                        bytes32(bytes.clone()).map_err(|e| fail(at, op, format!("{e}")))?;
                    }
                    memory.insert(output.clone(), bytes);
                }
                // ir_vm.rs:586-595
                I::FromBytes32 {
                    val_t,
                    bytes,
                    output,
                }
                | I::FromBytes {
                    val_t,
                    bytes,
                    output,
                } => {
                    let bytes = operand(&memory, bytes, at, op)?;
                    let bytes: Vec<u8> = if matches!(ins, I::FromBytes32 { .. }) {
                        bytes32(bytes)
                            .map_err(|e| fail(at, op, format!("{e}")))?
                            .to_vec()
                    } else {
                        bytes.try_into().map_err(|e| fail(at, op, format!("{e}")))?
                    };
                    let x = from_bytes32_offcircuit(val_t, &bytes)
                        .map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), x);
                }
                // ir_vm.rs:596-601
                I::ReverseBytes { bytes, output } => {
                    let bytes = operand(&memory, bytes, at, op)?;
                    let mut bytes: [u8; 32] =
                        bytes32(bytes).map_err(|e| fail(at, op, format!("{e}")))?;
                    bytes.reverse();
                    memory.insert(output.clone(), IrValue::Bytes(bytes.to_vec()));
                }
                // ir_vm.rs:602-610 — low = first 31 bytes LE, high = last byte.
                I::Bytes32IntoLowHigh { bytes, outputs } => {
                    let bytes = operand(&memory, bytes, at, op)?;
                    let mut bytes: [u8; 32] =
                        bytes32(bytes).map_err(|e| fail(at, op, format!("{e}")))?;
                    let high = IrValue::Native(Fr::from(bytes[31] as u64));
                    bytes[31] = 0;
                    let low = from_bytes32_offcircuit(&IrType::Native, &bytes)
                        .map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(outputs.0.clone(), low);
                    memory.insert(outputs.1.clone(), high);
                }
                // ir_vm.rs:611-624
                I::Bytes32FromLowHigh { inputs, output } => {
                    let low = operand(&memory, &inputs.0, at, op)?;
                    let high = operand(&memory, &inputs.1, at, op)?;
                    let bytes_low: [u8; 32] = into_bytes32_offcircuit(&low)
                        .and_then(bytes32)
                        .map_err(|e| fail(at, op, format!("{e}")))?;
                    let bytes_high: [u8; 32] = into_bytes32_offcircuit(&high)
                        .and_then(bytes32)
                        .map_err(|e| fail(at, op, format!("{e}")))?;
                    if bytes_low[31] != 0 || bytes_high[1..].iter().any(|b| *b != 0) {
                        return Err(fail(
                            at,
                            op,
                            "Bytes32FromLowHigh: low operand must fit in 31 bytes (be less than \
                         2^248) and high operand must fit in a single byte (be less than 256)",
                        ));
                    }
                    let mut out_bytes = bytes_low;
                    out_bytes[31] = bytes_high[0];
                    memory.insert(output.clone(), IrValue::Bytes(out_bytes.to_vec()));
                }
                I::BytesIntoNatives { bytes, outputs } => {
                    let value = operand(&memory, bytes, at, op)?;
                    if !matches!(value, IrValue::Bytes(_)) {
                        return Err(fail(at, op, "expected bytes"));
                    }
                    let encoded = encode_offcircuit(&value);
                    if encoded.len() != outputs.len() {
                        return Err(fail(at, op, "byte limb count mismatch"));
                    }
                    for (id, value) in outputs.iter().zip(encoded) {
                        memory.insert(id.clone(), value);
                    }
                }
                I::BytesFromNatives {
                    inputs,
                    len,
                    output,
                } => {
                    if *len == 0
                        || *len > reference_zkir::ir_types::MAX_BYTES_LEN
                        || inputs.len() != (*len as usize).div_ceil(31)
                    {
                        return Err(fail(at, op, "invalid byte length or limb count"));
                    }
                    let encoded = inputs
                        .iter()
                        .map(|v| operand_fr(&memory, v, at, op))
                        .collect::<Result<Vec<_>, _>>()?;
                    let value = decode_offcircuit(&encoded, &IrType::Bytes(*len))
                        .map_err(|e| fail(at, op, format!("{e}")))?;
                    memory.insert(output.clone(), value);
                }
                // ir_vm.rs:625-644 — outputs are type-checked against the
                // circuit's output signature.
                I::Output { vals } => {
                    if vals.len() != ir.outputs.len() {
                        return Err(fail(
                            at,
                            op,
                            format!(
                                "Output: signature declares {} return values but instruction has {}",
                                ir.outputs.len(),
                                vals.len()
                            ),
                        ));
                    }
                    for (i, (val, expected_t)) in vals.iter().zip(ir.outputs.iter()).enumerate() {
                        let value = operand(&memory, val, at, op)?;
                        if ir_type_of(&value) != *expected_t {
                            return Err(fail(
                                at,
                                op,
                                format!(
                                    "Output position {i}: signature declares {expected_t:?} but \
                                 operand has runtime type {:?}",
                                    ir_type_of(&value)
                                ),
                            ));
                        }
                        outputs.push(value);
                    }
                }
                _ => return Err(fail(at, op, "unsupported ZKIR instruction")),
            }
            Ok(())
        };
        match step() {
            Ok(()) => {}
            Err(e) if gather => {
                walk_failures.push((at, e.to_string()));
                transcript_truncated = true;
            }
            Err(e) => return Err(e),
        }
    }

    // Every transcript must be consumed exactly (ir_vm.rs:648-661). Under
    // `Mode::Gather` only the private half is exact: the public halves are
    // the run's own output and its provisional input.
    let public_halves_consumed = gather
        || (preimage.public_transcript_inputs.len() == public_transcript_inputs_idx
            && preimage.public_transcript_outputs.len() == public_transcript_outputs_idx);
    if !public_halves_consumed || preimage.private_transcript.len() != private_transcript_idx {
        return Err(Sim3Error::Transcript(format!(
            "public inputs {}/{}, public outputs {}/{}, private {}/{}",
            public_transcript_inputs_idx,
            preimage.public_transcript_inputs.len(),
            public_transcript_outputs_idx,
            preimage.public_transcript_outputs.len(),
            private_transcript_idx,
            preimage.private_transcript.len(),
        )));
    }

    // Communications commitment: transient_commit over the *raw* preimage
    // inputs followed by the encoded outputs (ir_vm.rs:662-681). (The
    // in-circuit twin at ir_vm.rs:1184-1199 rebuilds the same list from
    // memory, skipping absent inputs — off-circuit every declared input was
    // decoded into memory above, so the lists coincide.)
    if ir.do_communications_commitment && !gather {
        let comm_comm = preimage.communications_commitment.ok_or_else(|| {
            Sim3Error::CommCommitment("expected communications randomness".into())
        })?;
        let mut comm_comm_inputs: Vec<Fr> = Vec::new();
        comm_comm_inputs.extend(preimage.inputs.iter());
        for value in outputs.iter() {
            for ir_val in encode_offcircuit(value) {
                comm_comm_inputs.push(
                    ir_val
                        .try_into()
                        .map_err(|e| Sim3Error::CommCommitment(format!("{e}")))?,
                );
            }
        }
        if comm_comm.0 != transient_commit(&comm_comm_inputs[..], comm_comm.1) {
            return Err(Sim3Error::CommCommitment(
                "communications commitment mismatch".into(),
            ));
        }
    }

    Ok(Run3 {
        memory,
        pis,
        pi_skips,
        binding_input: preimage.binding_input,
        comm_comm: preimage.communications_commitment,
        outputs,
        consumed_private: private_transcript_idx,
        consumed_public: public_transcript_outputs_idx,
        op_counts,
        public_transcript_inputs,
        assert_failures,
        walk_failures,
    })
}

fn bytes32(value: IrValue) -> anyhow::Result<[u8; 32]> {
    let bytes: Vec<u8> = value.try_into()?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("expected 32 bytes"))
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    use serde_json::json;
    fn check(instructions: serde_json::Value, inputs: Vec<Fr>, expected: bool) -> Run3 {
        let source = json!({"version":{"major":3,"minor":1},"do_communications_commitment":false,
            "inputs":[{"name":"%lo","type":"Scalar<BLS12-381>"},{"name":"%hi","type":"Scalar<BLS12-381>"}],"outputs":[],"instructions":instructions});
        let ir = IrSource::load(serde_json::to_vec(&source).unwrap().as_slice()).unwrap();
        let preimage = ProofPreimage {
            inputs,
            private_transcript: vec![],
            public_transcript_inputs: vec![],
            public_transcript_outputs: vec![],
            binding_input: Fr::from(0u64),
            communications_commitment: None,
            key_location: crate::executor::Call::new(&[], &[]).key_location,
        };
        let run = simulate(&ir, &preimage);
        assert_eq!(run.is_ok(), expected, "simulator: {run:?}");
        assert_eq!(ir.check(&preimage).is_ok(), expected, "backend disagrees");
        run.unwrap_or_else(|_| simulate_with(&ir, &preimage, Mode::Gather).unwrap())
    }
    #[test]
    fn current_byte_packing_matches_backend_and_rejects_overflow() {
        let instructions = json!([
            {"op":"bytes_from_natives","inputs":["%lo","%hi"],"len":32,"output":"%bytes"},
            {"op":"bytes_into_natives","bytes":"%bytes","outputs":["%a","%b"]},
            {"op":"constrain_eq","a":"%lo","b":"%a"},{"op":"constrain_eq","a":"%hi","b":"%b"},
            {"op":"output","vals":[]}]);
        for (lo, hi, ok) in [(0, 0, true), (0x1234, 255, true), (0, 256, false)] {
            let run = check(instructions.clone(), vec![Fr::from(lo), Fr::from(hi)], ok);
            if ok {
                let value = run
                    .memory
                    .iter()
                    .find(|(id, _)| serde_json::to_value(id).unwrap() == "%bytes")
                    .unwrap()
                    .1;
                let bytes: Vec<u8> = value.clone().try_into().unwrap();
                assert_eq!(bytes[0], lo as u8);
                assert_eq!(bytes[1], (lo >> 8) as u8);
                assert_eq!(bytes[31], hi as u8);
            }
        }
        let overflow =
            Fr::from_le_bytes(&[0u8; 31].into_iter().chain([1]).collect::<Vec<_>>()).unwrap();
        check(instructions, vec![overflow, Fr::from(0u64)], false);
    }
    #[test]
    fn current_p256_generator_and_byte_roundtrip_match_backend() {
        let instructions = json!([
            {"op":"to_bytes","input":"%lo","output":"%bytes"},
            {"op":"from_bytes","type":"Scalar<Secp256r1>","bytes":"%bytes","output":"%scalar"},
            {"op":"ec_mul_generator","scalar":"%scalar","output":"%point"},
            {"op":"output","vals":[]}]);
        for scalar in [0u64, 1, 7] {
            let run = check(
                instructions.clone(),
                vec![Fr::from(scalar), Fr::from(0u64)],
                true,
            );
            let point = run
                .memory
                .iter()
                .find(|(id, _)| serde_json::to_value(id).unwrap() == "%point")
                .unwrap()
                .1;
            assert_eq!(
                *point,
                IrValue::Secp256r1Point(p256::P256::generator() * p256::Fq::from(scalar))
            );
        }
    }
}
