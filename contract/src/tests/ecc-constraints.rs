// Included as a test module INSIDE an isolated, pinned midnight-zkir checkout.
// This permits calling pub(crate) preprocessing without changing library logic.
use crate::IrSource;
use group::ff::PrimeField;
use midnight_curves::{Bls12, Fq};
use midnight_proofs::poly::kzg::params::ParamsKZG;
use midnight_proofs::{circuit::Value, dev::MockProver};
use midnight_zk_stdlib::MidnightCircuit;
use serde_json::{Value as Json, json};
use std::{fs, path::PathBuf};
use transient_crypto::{
    curve::Fr,
    proofs::{ProofPreimage, TranscriptHash, Zkir},
};

#[test]
fn passport_compiled_contract_inputs() {
    let contract = PathBuf::from(std::env::var("PASSPORT_CONTRACT_ROOT").unwrap());
    let evidence = contract.join("evidence/ecc-validation");
    let runtime: Json =
        serde_json::from_slice(&fs::read(evidence.join("runtime.json")).unwrap()).unwrap();
    assert_eq!(
        runtime["completed"], true,
        "runtime suite did not finish successfully"
    );
    let mut results = vec![];
    let mut failures = vec![];
    let full_proofs = std::env::var("PASSPORT_ECC_FULL_PROOFS").as_deref() == Ok("1");
    let mut proof_setup = None;
    for row in runtime["rows"].as_array().unwrap() {
        let Some(file) = row["preimage"].as_str() else {
            continue;
        };
        let name = row["circuit"].as_str().unwrap();
        let ir = IrSource::load(
            fs::File::open(contract.join(format!("contracts/managed/account/zkir/{name}.zkir")))
                .unwrap(),
        )
        .unwrap();
        let bytes = fs::read(evidence.join(file)).unwrap();
        let preimage: ProofPreimage = serialize::tagged_deserialize(bytes.as_slice()).unwrap();
        let boundary = row["boundary"].as_str().unwrap();
        let input = row["input"].as_str().unwrap();
        // Bypass every JavaScript point validator by replacing the raw native
        // input fields in a valid compiled-bootstrap preimage. The valid vector
        // must reproduce its original bytes before testing malformed vectors.
        if boundary.starts_with("bootstrap/") && input == "valid subgroup key" {
            let arm = boundary.strip_prefix("bootstrap/").unwrap();
            let vectors = runtime["rawBootstrapVectors"][arm].as_array().unwrap();
            for vector in vectors {
                let fields: Vec<Fr> = vector["encoded"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| Fr(Fq::from_str_vartime(n.as_str().unwrap()).unwrap()))
                    .collect();
                let valid = vector["input"] == "valid subgroup key";
                if valid {
                    assert_eq!(
                        &preimage.inputs[..fields.len()],
                        fields.as_slice(),
                        "raw point packing mismatch"
                    );
                }
                let mut raw = preimage.clone();
                raw.inputs[..fields.len()].copy_from_slice(&fields);
                let attempt =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ir.preprocess(&raw)));
                let (accepted, error) = match attempt {
                    Ok(Ok(_)) => (true, None),
                    Ok(Err(e)) => (false, Some(e.to_string())),
                    Err(_) => (false, Some("native preprocessing panicked".to_owned())),
                };
                results.push(json!({"boundary": format!("raw-bootstrap/{arm}"), "input": vector["input"],
                    "circuit": name, "stage": "raw-input-preprocessing", "accepted": accepted, "error": error}));
                if accepted != valid {
                    failures.push(format!(
                        "raw input {arm}: {}: expected {valid}, got {accepted}",
                        vector["input"]
                    ));
                }
            }
        }
        let expected = !(input == "altered x+2, same y"
            && boundary != "device/enrol commitment"
            && boundary != "grant/issue committed jubjub key");
        let prep = ir.preprocess(&preimage);
        let accepted = prep.is_ok();
        let error = prep.as_ref().err().map(|e| e.to_string());
        println!(
            "{} preprocessing: {boundary}: {input} {error:?}",
            if accepted { "ACCEPT" } else { "REJECT" }
        );
        results.push(
            json!({ "boundary": boundary, "input": input, "circuit": name,
            "stage": "zkir-preprocessing", "accepted": accepted, "error": error }),
        );
        if accepted != expected {
            failures.push(format!(
                "preprocessing {boundary}: {input}: expected {expected}, got {accepted}"
            ));
        }
        if !expected
            && !error
                .as_deref()
                .unwrap_or("")
                .contains("not in canonical form")
        {
            failures.push(format!(
                "unexpected rejection reason: {boundary}: {input}: {error:?}"
            ));
        }
        // Check constraints for representative valid controls and the identity-R
        // finding. Other accepted rows above run native preprocessing only.
        if accepted
            && ((boundary == "bootstrap/jubjub" && input == "valid subgroup key")
                || boundary == "signature/announcement"
                || boundary == "signature/grant announcement"
                || boundary == "signature/recovery announcement")
        {
            let prep = prep.unwrap();
            let for_proof = prep.clone();
            let pis = prep.pis.clone();
            let k = ir.k() as u32;
            let circuit =
                MidnightCircuit::new(&ir, Value::known(pis.clone()), Value::known(prep), Some(k));
            let result = MockProver::run(&circuit, vec![vec![], pis]).and_then(|prover| {
                prover
                    .verify()
                    .map_err(|e| midnight_proofs::plonk::Error::Synthesis(format!("{e:?}")))
            });
            let accepted = result.is_ok();
            println!(
                "{} constraints: {boundary}: {input}, k={k}",
                if accepted { "ACCEPT" } else { "REJECT" }
            );
            results.push(
                json!({ "boundary": boundary, "input": input, "circuit": name,
                "stage": "mock-prover-constraints", "accepted": accepted, "k": k,
                "error": result.err().map(|e| e.to_string()) }),
            );
            if !accepted {
                failures.push(format!("constraint control rejected: {boundary}: {input}"));
            }
            if full_proofs && boundary == "signature/announcement" {
                // Local, test-only KZG setup. No production parameters or keys.
                let (params, vk, pk) = proof_setup.get_or_insert_with(|| {
                    let params = ParamsKZG::<Bls12>::unsafe_setup(k, rand::rngs::OsRng);
                    let vk = midnight_zk_stdlib::setup_vk(&params, &ir);
                    let pk = midnight_zk_stdlib::setup_pk(&ir, &vk);
                    (params, vk, pk)
                });
                let proof = midnight_zk_stdlib::prove::<IrSource, TranscriptHash>(
                    params,
                    pk,
                    &ir,
                    &for_proof.pis,
                    for_proof.clone(),
                    rand::rngs::OsRng,
                )
                .unwrap();
                let verified = midnight_zk_stdlib::verify::<IrSource, TranscriptHash>(
                    &params.verifier_params(),
                    vk,
                    &for_proof.pis,
                    None,
                    &proof,
                )
                .is_ok();
                results.push(
                    json!({"boundary": boundary, "input": input, "circuit": name,
                    "stage": "local-test-proof-verification", "accepted": verified}),
                );
                if !verified {
                    failures.push(format!("local proof failed: {input}"));
                }
                let mut damaged = proof.clone();
                damaged[0] ^= 1;
                let accepted = midnight_zk_stdlib::verify::<IrSource, TranscriptHash>(
                    &params.verifier_params(),
                    vk,
                    &for_proof.pis,
                    None,
                    &damaged,
                )
                .is_ok();
                results.push(json!({"boundary": boundary, "input": format!("damaged proof: {input}"),
                    "circuit": name, "stage": "local-test-proof-verification", "accepted": accepted}));
                if accepted {
                    failures.push(format!("damaged local proof accepted: {input}"));
                }
            }
        }
    }
    assert!(
        !results.is_empty(),
        "no preimages; run npm run test:ecc first"
    );
    assert_eq!(
        results
            .iter()
            .filter(|row| row["stage"] == "mock-prover-constraints")
            .count(),
        9,
        "missing valid/identity-announcement constraint controls"
    );
    fs::write(evidence.join("constraints.json"), serde_json::to_string_pretty(&json!({
        "scope": "Native ZKIR preprocessing, marked MockProver checks, and optionally local proofs using test-only KZG parameters. No production proof or node submission.",
        "fullProofsRequested": full_proofs,
        "zkir_revision": "e82d81d25aabcc5f5092e2bd559083487f577914",
        "runtimeGeneratedSha256": runtime["generatedSha256"], "runtimeRows": runtime["rows"].as_array().unwrap().len(),
        "rows": results,
    })).unwrap() + "\n").unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
