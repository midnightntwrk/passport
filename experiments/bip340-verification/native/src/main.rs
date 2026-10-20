//! Verify the probe's captured proofs with the native cryptographic verifier.
//! This deliberately supports only this probe's unconditional public transcript,
//! checking that shape before constructing its public statement.
use std::{env, error::Error, fs, io::Cursor, path::Path, time::Instant};

use midnight_serialize::{Deserializable, Tagged, tagged_deserialize};
use midnight_transient_crypto::{
    curve::Fr,
    proofs::{PARAMS_VERIFIER, Proof, ProofPreimage, VerifierKey},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const REVISION: &str = "e5da67016d143db7822bbcd79eb1dd4ca198cb07";

fn fingerprint(bytes: &[u8]) -> Value {
    json!({"bytes": bytes.len(), "sha256": format!("{:x}", Sha256::digest(bytes))})
}

fn read_tagged<T: Deserializable + Tagged>(bytes: &[u8]) -> Result<T> {
    let mut cursor = Cursor::new(bytes);
    let result = tagged_deserialize(&mut cursor)?;
    if cursor.position() != bytes.len() as u64 {
        return Err("trailing bytes in tagged artefact".into());
    }
    Ok(result)
}

fn decimal_fr(text: &str) -> Result<Fr> {
    if text.is_empty() {
        return Err("empty binding scalar".into());
    }
    let mut bytes = [0u8; 32];
    for digit in text.bytes() {
        if !digit.is_ascii_digit() {
            return Err("invalid decimal binding scalar".into());
        }
        let mut carry = (digit - b'0') as u16;
        for byte in &mut bytes {
            let value = (*byte as u16) * 10 + carry;
            *byte = value as u8;
            carry = value >> 8;
        }
        if carry != 0 {
            return Err("binding scalar overflow".into());
        }
    }
    Fr::from_le_bytes(&bytes).ok_or_else(|| "noncanonical binding scalar".into())
}

fn verify_capture(directory: &Path, name: &str) -> Result<Value> {
    let metadata_bytes = fs::read(directory.join(format!("{name}.json")))?;
    let metadata: Value = serde_json::from_slice(&metadata_bytes)?;
    if metadata["circuit"] != name {
        return Err("capture circuit name mismatch".into());
    }
    let preimage_bytes = fs::read(directory.join(format!("{name}.preimage")))?;
    let proof_bytes = fs::read(directory.join(format!("{name}.proof")))?;
    if metadata["preimageSha256"] != fingerprint(&preimage_bytes)["sha256"]
        || metadata["proofSha256"] != fingerprint(&proof_bytes)["sha256"]
    {
        return Err("capture digest mismatch".into());
    }
    let vk_bytes = fs::read(
        metadata["verifierKey"]
            .as_str()
            .ok_or("missing verifier key")?,
    )?;
    let ir_path = Path::new(metadata["ir"].as_str().ok_or("missing binary ZKIR")?);
    let binary_ir_bytes = fs::read(ir_path)?;
    let ir_bytes = fs::read(ir_path.with_extension("zkir"))?;
    let ir: Value = serde_json::from_slice(&ir_bytes)?;
    let instructions = ir["instructions"]
        .as_array()
        .ok_or("missing instructions")?;
    let impacts: Vec<_> = instructions
        .iter()
        .filter(|value| value["op"] == "impact")
        .collect();
    // With no guarded-off impacts or public transcript reads, the native ZKIR
    // statement is binding || communications commitment || transcript inputs.
    // Refuse other shapes instead of guessing how to interleave their fields.
    if ir["version"] != json!({"major": 3, "minor": 1})
        || ir["do_communications_commitment"] != true
        || ir["outputs"] != json!([])
        || impacts.len() != 3
        || impacts.iter().any(|value| value["guard"] != "0x01")
        || impacts
            .iter()
            .map(|value| value["inputs"].as_array().map(Vec::len))
            .collect::<Vec<_>>()
            != vec![Some(5), Some(6), Some(1)]
        || instructions
            .iter()
            .any(|value| value["op"] == "public_input")
    {
        return Err("unsupported probe public-input shape".into());
    }
    if impacts[0]["inputs"] != json!(["0x10", "0x01", "0x01", "0x01", "0x00"])
        || impacts[1]["inputs"]
            .as_array()
            .ok_or("missing write operands")?[..4]
            != json!(["0x11", "0x01", "0x01", "0x20"]).as_array().unwrap()[..]
        || impacts[2]["inputs"] != json!(["0x91"])
    {
        return Err("unsupported probe ledger-write shape".into());
    }
    let preimage: ProofPreimage = read_tagged(&preimage_bytes)?;
    if preimage.public_transcript_inputs.len() != 12
        || !preimage.public_transcript_outputs.is_empty()
    {
        return Err("unexpected public transcript size".into());
    }
    let vk: VerifierKey = read_tagged(&vk_bytes)?;
    // /prove returns a tagged ProofVersioned envelope, whose known variants
    // contain the same Proof byte vector. Decode that wrapper explicitly.
    let prefix = b"midnight:proof-versioned:";
    if !proof_bytes.starts_with(prefix) || !matches!(proof_bytes.get(prefix.len()), Some(1 | 2)) {
        return Err("unsupported proof envelope".into());
    }
    let mut body = &proof_bytes[prefix.len() + 1..];
    let proof = Proof::deserialize(&mut body, 0)?;
    if !body.is_empty() {
        return Err("trailing proof bytes".into());
    }
    // The proving API overwrites this field with its transaction binding.
    let binding = decimal_fr(metadata["binding"].as_str().ok_or("missing binding")?)?;
    let commitment = preimage
        .communications_commitment
        .ok_or("missing communications commitment")?
        .0;
    let mut statement = vec![binding, commitment];
    statement.extend_from_slice(&preimage.public_transcript_inputs);
    let started = Instant::now();
    vk.verify(&PARAMS_VERIFIER, &proof, statement.iter().copied())
        .map_err(|error| format!("{name}: valid proof rejected: {error}"))?;
    let verification_milliseconds = started.elapsed().as_secs_f64() * 1000.0;

    let mut controls = Vec::new();
    // The final two operands of the second impact are the accepted hash limbs.
    for (index, label) in [(12, "changed accepted hash"), (0, "changed binding")] {
        let mut altered = statement.clone();
        altered[index] = altered[index] + Fr::from(1u64);
        let error = vk
            .verify(&PARAMS_VERIFIER, &proof, altered.iter().copied())
            .err()
            .ok_or("altered public input accepted")?;
        controls.push(json!({"name": label, "publicInputIndex": index,
            "result": "REJECTED", "reason": error.to_string()}));
    }
    Ok(json!({
        "circuit": name, "result": "PASS", "publicInputs": statement.len(),
        "verificationMilliseconds": verification_milliseconds, "negativeControls": controls,
        "artefacts": {
            "captureMetadata": fingerprint(&metadata_bytes), "preimage": fingerprint(&preimage_bytes),
            "proof": fingerprint(&proof_bytes), "verifierKey": fingerprint(&vk_bytes),
            "binaryZkir": fingerprint(&binary_ir_bytes), "jsonZkir": fingerprint(&ir_bytes)
        }
    }))
}

fn main() -> Result<()> {
    let directory = env::args()
        .nth(1)
        .ok_or("usage: bip340-proof-verify PROOF_ARTIFACT_DIRECTORY")?;
    let checks = ["verify_32", "verify_0", "verify_100"]
        .iter()
        .map(|name| verify_capture(Path::new(&directory), name))
        .collect::<Result<Vec<_>>>()?;
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sources = ["src/main.rs", "Cargo.toml", "Cargo.lock"]
        .iter()
        .map(|path| {
            Ok((
                path.to_string(),
                fingerprint(&fs::read(manifest.join(path))?),
            ))
        })
        .collect::<Result<serde_json::Map<String, Value>>>()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "result": "PASS",
            "evidenceLayer": "Native VerifierKey::verify with embedded verifier parameters; each original proof accepted, altered accepted hash and binding rejected",
            "dependency": {"repository": "https://github.com/midnightntwrk/midnight-ledger", "revision": REVISION},
            "sources": sources, "checks": checks
        }))?
    );
    Ok(())
}
