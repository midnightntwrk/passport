// Included inside an isolated checkout of the compiler's pinned ZKIR crate.
// Deliberately bypass both JavaScript and native preprocessing. Never patch
// constraints or verifier logic: only supply unchecked points as witnesses.
use crate::{
    ir::{Operand, TypedIdentifier},
    ir_types::{IrType, IrValue},
    Identifier, Instruction, IrSource, Preprocessed,
};
use midnight_circuits::ecc::curves::CircuitCurve;
use midnight_curves::{Fq, JubjubExtended, JubjubSubgroup};
use midnight_proofs::{circuit::Value, dev::MockProver};
use midnight_zk_stdlib::MidnightCircuit;
use serde_json::{json, Value as Json};
use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};
use transient_crypto::proofs::{ProofPreimage, Zkir};

fn run(ir: &IrSource, prep: Preprocessed) -> (bool, String) {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_inner(ir, prep))).unwrap_or((
        false,
        "host arithmetic panicked on unchecked invalid point; not a constraint-rejection result"
            .into(),
    ))
}

fn run_inner(ir: &IrSource, prep: Preprocessed) -> (bool, String) {
    let pis = prep.pis.clone();
    let k = ir.k() as u32;
    let circuit = MidnightCircuit::new(ir, Value::known(pis.clone()), Value::known(prep), Some(k));
    match MockProver::run(&circuit, vec![vec![], pis]) {
        Ok(prover) => match prover.verify() {
            Ok(()) => (true, "constraints satisfied".into()),
            Err(e) => (false, format!("unsatisfied constraints: {e:?}")),
        },
        Err(e) => (false, format!("synthesis rejected: {e}")),
    }
}

#[test]
fn passport_malicious_witnesses() {
    let root = PathBuf::from(std::env::var("PASSPORT_CONTRACT_ROOT").unwrap());
    let evidence = root.join("evidence/ecc-validation");
    let runtime: Json =
        serde_json::from_slice(&fs::read(evidence.join("runtime.json")).unwrap()).unwrap();
    let row = runtime["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["boundary"] == "bootstrap/jubjub" && r["input"] == "valid subgroup key")
        .unwrap();
    let ir = IrSource::load(
        fs::File::open(root.join(format!(
            "contracts/managed/account/zkir/{}.zkir",
            row["circuit"].as_str().unwrap()
        )))
        .unwrap(),
    )
    .unwrap();
    let preimage: ProofPreimage = serialize::tagged_deserialize(
        fs::read(evidence.join(row["preimage"].as_str().unwrap()))
            .unwrap()
            .as_slice(),
    )
    .unwrap();
    let prep = ir.preprocess(&preimage).unwrap();
    let input = ir.inputs[0].clone();
    let IrValue::JubjubPoint(valid) = prep.memory[&input.name] else {
        panic!("expected typed Jubjub input")
    };
    let (x, y) = JubjubExtended::from(valid).coordinates().unwrap();
    let vectors = [
        ("valid subgroup", valid, true),
        (
            "identity",
            JubjubSubgroup::from_raw_unchecked(Fq::from(0), Fq::from(1)),
            true,
        ),
        (
            "order-two",
            JubjubSubgroup::from_raw_unchecked(Fq::from(0), -Fq::from(1)),
            false,
        ),
        (
            "mixed torsion",
            JubjubSubgroup::from_raw_unchecked(-x, -y),
            false,
        ),
        (
            "off-curve (0,0)",
            JubjubSubgroup::from_raw_unchecked(Fq::from(0), Fq::from(0)),
            false,
        ),
        (
            "altered x+2 same y",
            JubjubSubgroup::from_raw_unchecked(x + Fq::from(2), y),
            false,
        ),
    ];
    // Coordinate-bound assignment projection isolates this compiled input's
    // point gadget from account hashes and assertions. Identity is a subgroup
    // member and is expected to pass this primitive, unlike the account gate.
    let raw_x = Identifier("raw_x".into());
    let raw_y = Identifier("raw_y".into());
    let assigned_x = Identifier("assigned_x".into());
    let assigned_y = Identifier("assigned_y".into());
    let projection = IrSource {
        version: ir.version.clone(),
        inputs: vec![
            input.clone(),
            TypedIdentifier {
                name: raw_x.clone(),
                val_t: IrType::Native,
            },
            TypedIdentifier {
                name: raw_y.clone(),
                val_t: IrType::Native,
            },
        ],
        outputs: vec![],
        do_communications_commitment: false,
        instructions: Arc::new(vec![
            Instruction::IntoCoordinates {
                point: Operand::Variable(input.name.clone()),
                outputs: (assigned_x.clone(), assigned_y.clone()),
            },
            Instruction::ConstrainEq {
                a: Operand::Variable(assigned_x),
                b: Operand::Variable(raw_x.clone()),
            },
            Instruction::ConstrainEq {
                a: Operand::Variable(assigned_y),
                b: Operand::Variable(raw_y.clone()),
            },
        ]),
    };
    let mut rows = vec![];
    for (name, point, expected) in vectors {
        let (px, py) = JubjubExtended::from(point).coordinates().unwrap();
        let raw = Preprocessed {
            memory: HashMap::from([
                (input.name.clone(), IrValue::JubjubPoint(point)),
                (
                    raw_x.clone(),
                    IrValue::Native(transient_crypto::curve::Fr(px)),
                ),
                (
                    raw_y.clone(),
                    IrValue::Native(transient_crypto::curve::Fr(py)),
                ),
            ]),
            pis: vec![Fq::from(0)],
            pi_skips: vec![],
            binding_input: Fq::from(0),
            comm_comm: None,
        };
        let (accepted, error) = run(&projection, raw);
        println!("assignment projection: {name}: {accepted}: {error}");
        rows.push(
            json!({"boundary":"compiled input assignment projection", "input":name,
            "accepted":accepted,"expectedAccepted":expected,"detail":error}),
        );
        assert_eq!(accepted, expected, "input assignment: {name}: {error}");
        // Keep public commitments fixed. Remove cached computed values;
        // public-input consistency guards can still reject during synthesis,
        // which is reported separately from unsatisfied constraints.
        let mut malicious = prep.clone();
        malicious.memory.retain(|id, _| ir.inputs.iter().any(|i| &i.name == id)
            || ir.instructions.iter().any(|ins| matches!(ins,
                crate::Instruction::PublicInput { output, .. } | crate::Instruction::PrivateInput { output, .. }
                if output == id)));
        malicious
            .memory
            .insert(input.name.clone(), IrValue::JubjubPoint(point));
        // Assignment first computes [8]([8]^-1 P). Mixed torsion therefore
        // becomes the original prime-order point; its original coordinates
        // still fail the isolated coordinate-binding check above.
        let expected = name == "valid subgroup" || name == "mixed torsion";
        let (accepted, error) = run(&ir, malicious);
        println!("compiled bootstrap: {name}: {accepted}: {error}");
        rows.push(
            json!({"boundary":"compiled bootstrap with fixed public commitments", "input":name,
            "accepted":accepted,"expectedAccepted":expected,"detail":error}),
        );
        assert_eq!(accepted, expected, "compiled bootstrap: {name}: {error}");
    }
    fs::write(evidence.join("malicious-witnesses.json"), serde_json::to_string_pretty(&json!({
        "completed":true,"zkirRevision":"e82d81d25aabcc5f5092e2bd559083487f577914",
        "runtimeGeneratedSha256":runtime["generatedSha256"],
        "scope":"Unchecked typed Jubjub input witnesses bypass preprocessing. Coordinate-bound assignment projection plus actual compiled bootstrap with fixed public commitments. MockProver only; not arbitrary Halo2 advice-cell injection or full proofs. Host panics are not constraint rejection.",
        "rows":rows
    })).unwrap()+"\n").unwrap();
}
