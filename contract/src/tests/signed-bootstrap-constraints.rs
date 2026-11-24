// Included inside an isolated copy of pinned midnight-zkir. This deliberately
// bypasses production signers and JS validators, then (for MockProver checks)
// native preprocessing. It never changes constraint or verifier logic.
use crate::{
    ir::{Operand, TypedIdentifier},
    ir_types::{IrType, IrValue},
    Identifier, Instruction, IrSource, Preprocessed,
};
use group::ff::PrimeField;
use midnight_circuits::ecc::curves::CircuitCurve;
use midnight_curves::{Fq, JubjubExtended, JubjubSubgroup};
use midnight_proofs::{circuit::Value, dev::MockProver};
use midnight_zk_stdlib::MidnightCircuit;
use serde_json::{json, Value as Json};
use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};
use transient_crypto::{curve::Fr, proofs::{ProofPreimage, Zkir}};

fn check_constraints(ir: &IrSource, prep: Preprocessed) -> (bool, String, String) {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let pis = prep.pis.clone();
        let circuit = MidnightCircuit::new(ir, Value::known(pis.clone()), Value::known(prep), Some(ir.k() as u32));
        match MockProver::run(&circuit, vec![vec![], pis]) {
            Ok(prover) => match prover.verify() {
                Ok(()) => (true, "constraints".into(), "satisfied".into()),
                Err(e) => (false, "constraints".into(), format!("{e:?}")),
            },
            Err(e) => (false, "synthesis".into(), e.to_string()),
        }
    })).unwrap_or((false, "host-panic".into(), "unchecked arithmetic panicked; not a constraint-rejection result".into()))
}

fn inputs_only(ir: &IrSource, prep: &Preprocessed) -> Preprocessed {
    let mut result = prep.clone();
    result.memory.retain(|id, _| ir.inputs.iter().any(|input| &input.name == id)
        || ir.instructions.iter().any(|instruction| matches!(instruction,
            Instruction::PublicInput { output, .. } | Instruction::PrivateInput { output, .. }
            if output == id)));
    result
}

#[test]
fn passport_signed_bootstrap_constraints() {
    let root = PathBuf::from(std::env::var("PASSPORT_CONTRACT_ROOT").unwrap());
    let evidence = root.join("evidence/signed-bootstrap");
    let manifest: Json = serde_json::from_slice(&fs::read(evidence.join("runtime-preimage.json")).unwrap()).unwrap();
    let ir = IrSource::load(fs::File::open(root.join("contracts/managed/account/zkir/activate_initial_passkey.zkir")).unwrap()).unwrap();
    let preimage: ProofPreimage = serialize::tagged_deserialize(
        fs::read(evidence.join("preimages/activate_initial_passkey.bin")).unwrap().as_slice()).unwrap();
    let prep = ir.preprocess(&preimage).expect("valid signed bootstrap must preprocess");
    let mut rows = vec![];
    let (accepted, stage, detail) = check_constraints(&ir, prep.clone());
    println!("full signed activation valid control: {accepted}, k={}", ir.k());
    rows.push(json!({"boundary":"full signed activation", "input":"valid two-signature control", "accepted":accepted, "stage":stage, "detail":detail, "k":ir.k()}));
    assert!(accepted, "valid full signed bootstrap: {detail}");

    // Locate inputs by their native type, checking the exact raw packing before
    // mutations. Q and R are the only Jubjub inputs of the activation ABI.
    let mut raw_offset = 0;
    let mut points = vec![];
    let mut passkey_offset = None;
    for input in &ir.inputs {
        if input.val_t == IrType::JubjubPoint {
            points.push((input.clone(), raw_offset));
        }
        if input.val_t == IrType::Secp256r1Point {
            assert!(passkey_offset.is_none(), "one passkey point is expected");
            passkey_offset = Some(raw_offset);
        }
        raw_offset += input.val_t.encoded_len();
    }
    assert_eq!(points.len(), 2, "activation must have exactly Q and R");
    for ((input, offset), label) in points.iter().zip(["Q", "R"]) {
        let IrValue::JubjubPoint(valid) = prep.memory[&input.name] else { panic!("point type mismatch") };
        let (x, y) = JubjubExtended::from(valid).coordinates().unwrap();
        assert_eq!(&preimage.inputs[*offset..*offset + 2], &[Fr(x), Fr(y)], "point packing changed");
        let vectors = [
            ("valid subgroup", valid, true),
            ("identity", JubjubSubgroup::from_raw_unchecked(Fq::from(0), Fq::from(1)), true),
            ("order-two", JubjubSubgroup::from_raw_unchecked(Fq::from(0), -Fq::from(1)), false),
            ("mixed torsion", JubjubSubgroup::from_raw_unchecked(-x, -y), false),
            ("off-curve", JubjubSubgroup::from_raw_unchecked(Fq::from(0), Fq::from(0)), false),
            ("altered x+2", JubjubSubgroup::from_raw_unchecked(x + Fq::from(2), y), false),
        ];
        for (name, point, subgroup) in vectors {
            let (px, py) = JubjubExtended::from(point).coordinates().unwrap();
            let mut raw = preimage.clone();
            raw.inputs[*offset..*offset + 2].copy_from_slice(&[Fr(px), Fr(py)]);
            let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ir.preprocess(&raw)));
            let (accepted, detail) = match attempt {
                Ok(Ok(_)) => (true, "accepted".to_owned()),
                Ok(Err(e)) => (false, e.to_string()),
                Err(_) => (false, "native preprocessing panic".to_owned()),
            };
            // Preprocessing evaluates assertions as well as decoding points;
            // the identity therefore fails the full activation despite being
            // a valid subgroup member at the native primitive boundary below.
            rows.push(json!({"boundary":format!("raw activation input/{label}"), "input":name, "stage":"native preprocessing", "accepted":accepted, "detail":detail}));
            println!("raw {label}/{name}: {accepted}");
            assert_eq!(accepted, name == "valid subgroup", "raw {label}/{name}: {detail}");

            // A bounded projection of the actual input's native point gadget
            // binds its resulting coordinates back to the supplied coordinates.
            // Without that binding, cofactor assignment can normalize a mixed
            // torsion witness into a legitimate prime-order point. Both hashes
            // and curve operations in the compiled contract use the assigned
            // point, so this projection is distinct from full-circuit mutation.
            let raw_x = Identifier("raw_x".into());
            let raw_y = Identifier("raw_y".into());
            let out_x = Identifier("out_x".into());
            let out_y = Identifier("out_y".into());
            let projection = IrSource {
                version: ir.version.clone(),
                inputs: vec![input.clone(),
                    TypedIdentifier { name: raw_x.clone(), val_t: IrType::Native },
                    TypedIdentifier { name: raw_y.clone(), val_t: IrType::Native }],
                outputs: vec![], do_communications_commitment: false,
                instructions: Arc::new(vec![
                    Instruction::IntoCoordinates { point: Operand::Variable(input.name.clone()), outputs: (out_x.clone(), out_y.clone()) },
                    Instruction::ConstrainEq { a: Operand::Variable(out_x), b: Operand::Variable(raw_x.clone()) },
                    Instruction::ConstrainEq { a: Operand::Variable(out_y), b: Operand::Variable(raw_y.clone()) },
                ]),
            };
            let unchecked = Preprocessed {
                memory: HashMap::from([
                    (input.name.clone(), IrValue::JubjubPoint(point)),
                    (raw_x, IrValue::Native(Fr(px))), (raw_y, IrValue::Native(Fr(py))),
                ]),
                pis: vec![Fq::from(0)], pi_skips: vec![], binding_input: Fq::from(0), comm_comm: None,
            };
            let (accepted, stage, detail) = check_constraints(&projection, unchecked);
            println!("assignment projection {label}/{name}: {accepted}, {stage}");
            rows.push(json!({"boundary":format!("coordinate-bound native assignment/{label}"), "input":name, "stage":stage, "accepted":accepted, "detail":detail}));
            assert_eq!(accepted, subgroup, "native point assignment {label}/{name}: {detail}");
            // An unchecked off-curve internal representation can panic before
            // constraints exist. Record that boundary as untested, not as a
            // proof rejection; its raw-input decoding is tested separately.
        }
    }

    // Foreign-point decoding is reached directly, without the JS canonical
    // scalar/point constructors. Five fields encode P-256's shifted coordinate
    // limbs and identity flag; the valid preimage is the packing control.
    let offset = passkey_offset.expect("missing P-256 input");
    let valid = preimage.inputs[offset..offset + 5].to_vec();
    let mut flagged = valid.clone(); flagged[4] = Fr(Fq::from(1));
    let mut nonboolean = valid.clone(); nonboolean[4] = Fr(Fq::from(2));
    let mut oversized = valid.clone();
    oversized[0] = Fr(Fq::from_str_vartime("6277101735386680763835789423207666416102355444464034512896").unwrap());
    for (name, fields, expected) in [
        ("valid key", valid, true),
        ("identity flag with ordinary coordinates", flagged, false),
        ("nonboolean identity flag", nonboolean, false),
        ("off-curve (1,1)", vec![Fr(Fq::from(0)); 5], false),
        ("oversized low coordinate limb", oversized, false),
    ] {
        let mut raw = preimage.clone();
        raw.inputs[offset..offset + 5].copy_from_slice(&fields);
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ir.preprocess(&raw)));
        let (accepted, detail) = match attempt {
            Ok(Ok(_)) => (true, "accepted".to_owned()),
            Ok(Err(e)) => (false, e.to_string()),
            Err(_) => (false, "native preprocessing panic".to_owned()),
        };
        rows.push(json!({"boundary":"raw activation input/P-256", "input":name, "stage":"native preprocessing", "accepted":accepted, "detail":detail}));
        println!("raw P-256/{name}: {accepted}");
        assert_eq!(accepted, expected, "raw P-256 {name}: {detail}");
    }

    // s+r_J is the same Schnorr response after a scalar cast; rejecting it
    // demonstrates the added canonical range constraint independently of the
    // Schnorr equation. Inject it into preprocessed inputs, bypassing every
    // host range guard, and discard cached derived values before synthesis.
    let response = Fq::from_str_vartime(manifest["responseScalar"].as_str().unwrap()).unwrap();
    let response_inputs: Vec<_> = ir.inputs.iter().filter(|input|
        prep.memory.get(&input.name) == Some(&IrValue::Native(Fr(response)))).collect();
    assert_eq!(response_inputs.len(), 1, "response scalar must identify a unique native input");
    let order = Fq::from_str_vartime("6554484396890773809930967563523245729705921265872317281365359162392183254199").unwrap();
    // Project the actual compiler-emitted range-check instructions verbatim.
    // This isolates range enforcement from signatures, hashes and communication
    // commitments, with no replacement constraints or handwritten comparator.
    let start = ir.instructions.iter().position(|instruction| matches!(instruction,
        Instruction::DivModPowerOfTwo { val: Operand::Variable(id), bits: 248, .. }
        if id == &response_inputs[0].name)).expect("response encoding instruction changed");
    let end = start + ir.instructions[start..].iter().position(|instruction|
        matches!(instruction, Instruction::Assert { .. })).expect("missing response range assert");
    let range = IrSource {
        version: ir.version.clone(), inputs: vec![response_inputs[0].clone()], outputs: vec![],
        do_communications_commitment: false,
        instructions: Arc::new(ir.instructions[start..=end].to_vec()),
    };
    for (name, scalar, expected) in [
        ("zero", Fq::from(0), true), ("r_J-1", order - Fq::from(1), true),
        ("r_J", order, false), ("s+r_J", response + order, false),
    ] {
        let raw = Preprocessed {
            memory: HashMap::from([(response_inputs[0].name.clone(), IrValue::Native(Fr(scalar)))]),
            pis: vec![Fq::from(0)], pi_skips: vec![], binding_input: Fq::from(0), comm_comm: None,
        };
        let (accepted, stage, detail) = check_constraints(&range, raw);
        println!("compiled response range/{name}: {accepted}, {stage}");
        rows.push(json!({"boundary":"compiled response-range subgraph", "input":name, "stage":stage, "accepted":accepted, "detail":detail}));
        assert_eq!(accepted, expected, "compiled range {name}: {detail}");
        assert_eq!(stage, "constraints", "must exercise actual range constraints: {detail}");
    }
    for (name, scalar) in [("s+r_J", response + order), ("r_J", order)] {
        let mut malicious = inputs_only(&ir, &prep);
        malicious.memory.insert(response_inputs[0].name.clone(), IrValue::Native(Fr(scalar)));
        let (accepted, stage, detail) = check_constraints(&ir, malicious);
        println!("full signed activation unchecked response/{name}: {accepted}, {stage}");
        rows.push(json!({"boundary":"full signed activation unchecked response", "input":name, "stage":stage, "accepted":accepted, "detail":detail}));
        assert!(!accepted, "noncanonical response accepted: {name}");
    }
    fs::write(evidence.join("constraints.json"), serde_json::to_string_pretty(&json!({
        "completed":true, "zkirRevision":"e82d81d25aabcc5f5092e2bd559083487f577914", "k":ir.k(),
        "scope":"Actual compiled signed activation valid control and unchecked scalar inputs; raw native input mutations bypass JavaScript; coordinate-bound native point assignment projection bypasses preprocessing. MockProver only, not arbitrary advice-cell injection or full cryptographic proofs. Projection results are not full-contract malformed-witness results.",
        "untestedBoundaries":["arbitrary advice-cell corruption", "unchecked P-256 internal witnesses", "all possible noncanonical SHA challenge witnesses", "point projection rows labelled host-panic do not exercise constraints"],
        "rows":rows
    })).unwrap() + "\n").unwrap();
}
