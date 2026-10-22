//! Verify captured proofs against an embedded, reviewed build identity and
//! independently reconstruct this probe's complete expected ledger transcript.
//! The manifest pins artefacts; it does not establish compiler correctness.
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
const TRUSTED_BUILD: &[u8] = include_bytes!("../trusted-build.json");
const CASES: [(&str, usize, usize); 3] = [
    ("verify_32", 0, 32),
    ("verify_0", 15, 0),
    ("verify_100", 18, 100),
];

fn fingerprint(bytes: &[u8]) -> Value {
    json!({"bytes": bytes.len(), "sha256": format!("{:x}", Sha256::digest(bytes))})
}

fn experiment_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("native crate has an experiment parent")
}

fn check_fingerprint(bytes: &[u8], pin: &Value) -> Result<()> {
    if pin["bytes"].as_u64() != Some(bytes.len() as u64)
        || pin["sha256"] != fingerprint(bytes)["sha256"]
    {
        return Err(format!("trusted build digest mismatch: {}", pin["path"]).into());
    }
    Ok(())
}

fn read_pinned(root: &Path, pin: &Value) -> Result<Vec<u8>> {
    let path = Path::new(
        pin["path"]
            .as_str()
            .ok_or("missing trusted artefact path")?,
    );
    if path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("trusted artefact path must be relative without traversal".into());
    }
    let bytes = fs::read(root.join(path))?;
    check_fingerprint(&bytes, pin)?;
    Ok(bytes)
}

fn check_capture_path(capture_path: &str, expected_path: &Path) -> Result<()> {
    if fs::canonicalize(capture_path)? != fs::canonicalize(expected_path)? {
        return Err("capture artefact path differs from fixed trusted build path".into());
    }
    Ok(())
}

fn trusted_fixture(root: &Path, manifest: &Value) -> Result<Vec<u8>> {
    if manifest["schemaVersion"] != 1 {
        return Err("unsupported trusted manifest version".into());
    }
    for pin in manifest["sources"]
        .as_array()
        .ok_or("missing trusted sources")?
    {
        read_pinned(root, pin)?;
    }
    read_pinned(root, &manifest["fixture"])
}

fn hex_bytes(text: &str) -> Result<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid fixture hexadecimal bytes".into());
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).map_err(Into::into))
        .collect()
}

fn fixture_commitment(csv: &[u8], index: usize, message_bytes: usize) -> Result<[u8; 32]> {
    let mut lines = std::str::from_utf8(csv)?.lines();
    if lines.next()
        != Some(
            "index,secret key,public key,aux_rand,message,signature,verification result,comment",
        )
    {
        return Err("unexpected official fixture header".into());
    }
    let rows: Vec<_> = lines.collect();
    if rows.len() != 19 {
        return Err("unexpected official fixture count".into());
    }
    let fields: Vec<_> = rows
        .get(index)
        .ok_or("missing official fixture")?
        .split(',')
        .collect();
    if fields.len() != 8 || fields[0].parse::<usize>()? != index || fields[6] != "TRUE" {
        return Err("unexpected official positive fixture".into());
    }
    let public_key = hex_bytes(fields[2])?;
    let message = hex_bytes(fields[4])?;
    let signature = hex_bytes(fields[5])?;
    if public_key.len() != 32 || message.len() != message_bytes || signature.len() != 64 {
        return Err("unexpected official fixture lengths".into());
    }
    // Compact persistentHash of this fixed-width bytes tuple is SHA-256 of
    // pk || message || signature, without lengths or another message prehash.
    let mut digest = Sha256::new();
    digest.update(public_key);
    digest.update(message);
    digest.update(signature);
    Ok(digest.finalize().into())
}

fn expected_transcript(hash: &[u8; 32]) -> Vec<Fr> {
    let mut fields: Vec<_> = [0x10u64, 1, 1, 1, 0, 0x11, 1, 1, 0x20]
        .into_iter()
        .map(Fr::from)
        .collect();
    // Midnight Bytes<32> uses the final byte first, then a 31-byte LE limb.
    fields.push(Fr::from(u64::from(hash[31])));
    fields.push(Fr::from_le_bytes(&hash[..31]).expect("31 bytes fit in the field"));
    fields.push(Fr::from(0x91u64));
    fields
}

fn check_transcript(preimage: &ProofPreimage, expected: &[Fr], name: &str) -> Result<()> {
    if preimage.key_location.0 != name
        || preimage.public_transcript_inputs != expected
        || !preimage.public_transcript_outputs.is_empty()
    {
        return Err("capture does not match the complete expected fixture transcript".into());
    }
    Ok(())
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
    if text.is_empty() || (text.len() > 1 && text.starts_with('0')) {
        return Err("noncanonical decimal binding scalar".into());
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

fn capture_metadata(bytes: &[u8], name: &str) -> Result<Value> {
    let metadata: Value = serde_json::from_slice(bytes)?;
    let fields = [
        "circuit",
        "binding",
        "verifierKey",
        "ir",
        "preimageSha256",
        "proofSha256",
    ];
    let object = metadata
        .as_object()
        .ok_or("capture metadata must be an object")?;
    if object.len() != fields.len()
        || fields
            .iter()
            .any(|key| !object.get(*key).is_some_and(Value::is_string))
        || metadata["circuit"] != name
    {
        return Err("unexpected capture metadata fields or circuit".into());
    }
    decimal_fr(metadata["binding"].as_str().unwrap())?;
    for key in ["preimageSha256", "proofSha256"] {
        let digest = metadata[key].as_str().unwrap();
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid capture digest".into());
        }
    }
    Ok(metadata)
}

fn check_ir(ir_bytes: &[u8]) -> Result<()> {
    let ir: Value = serde_json::from_slice(ir_bytes)?;
    let instructions = ir["instructions"]
        .as_array()
        .ok_or("missing instructions")?;
    let impacts: Vec<_> = instructions
        .iter()
        .filter(|value| value["op"] == "impact")
        .collect();
    // No guarded-off impacts or transcript reads: native public statement is
    // binding || communications commitment || the complete ledger transcript.
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
    Ok(())
}

fn verify_capture(
    root: &Path,
    directory: &Path,
    manifest: &Value,
    fixture: &[u8],
    case: (&str, usize, usize),
) -> Result<Value> {
    let (name, index, message_bytes) = case;
    let trusted = &manifest["circuits"][name];
    if trusted["fixtureIndex"] != index || trusted["messageBytes"] != message_bytes {
        return Err("unexpected trusted fixture mapping".into());
    }
    let metadata_bytes = fs::read(directory.join(format!("{name}.json")))?;
    let metadata = capture_metadata(&metadata_bytes, name)?;
    for (capture_key, trusted_key) in [("verifierKey", "verifierKey"), ("ir", "binaryZkir")] {
        check_capture_path(
            metadata[capture_key].as_str().unwrap(),
            &root.join(
                trusted[trusted_key]["path"]
                    .as_str()
                    .ok_or("missing trusted artefact path")?,
            ),
        )?;
    }
    // These paths and digests come from the embedded manifest, never a capture.
    let vk_bytes = read_pinned(root, &trusted["verifierKey"])?;
    let binary_ir_bytes = read_pinned(root, &trusted["binaryZkir"])?;
    let ir_bytes = read_pinned(root, &trusted["jsonZkir"])?;
    check_ir(&ir_bytes)?;
    let expected_hash = fixture_commitment(fixture, index, message_bytes)?;
    let expected = expected_transcript(&expected_hash);
    let preimage_bytes = fs::read(directory.join(format!("{name}.preimage")))?;
    let proof_bytes = fs::read(directory.join(format!("{name}.proof")))?;
    if metadata["preimageSha256"] != fingerprint(&preimage_bytes)["sha256"]
        || metadata["proofSha256"] != fingerprint(&proof_bytes)["sha256"]
    {
        return Err("capture digest mismatch".into());
    }
    let preimage: ProofPreimage = read_tagged(&preimage_bytes)?;
    check_transcript(&preimage, &expected, name)?;
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
    // The API overwrites binding_input with this transaction binding. It is
    // authenticated by the proof, but no independent transaction is checked.
    let binding = decimal_fr(metadata["binding"].as_str().unwrap())?;
    let commitment = preimage
        .communications_commitment
        .ok_or("missing communications commitment")?
        .0;
    let mut statement = vec![binding, commitment];
    statement.extend_from_slice(&expected);
    let started = Instant::now();
    vk.verify(&PARAMS_VERIFIER, &proof, statement.iter().copied())
        .map_err(|error| format!("{name}: valid proof rejected: {error}"))?;
    let verification_milliseconds = started.elapsed().as_secs_f64() * 1000.0;

    let mut controls = Vec::new();
    for (index, label) in [(12, "changed accepted hash"), (0, "changed binding")] {
        let mut altered = statement.clone();
        altered[index] = altered[index] + Fr::from(1u64);
        let error = vk
            .verify(&PARAMS_VERIFIER, &proof, altered.iter().copied())
            .err()
            .ok_or("altered public input accepted")?;
        controls.push(json!({"name": label, "publicInputIndex": index, "result": "REJECTED", "reason": error.to_string()}));
    }
    Ok(json!({
        "circuit": name, "result": "PASS", "publicInputs": statement.len(),
        "officialFixtureIndex": index, "expectedAcceptedSha256": expected_hash.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        "verificationMilliseconds": verification_milliseconds, "negativeControls": controls,
        "artefacts": {
            "captureMetadata": fingerprint(&metadata_bytes), "preimage": fingerprint(&preimage_bytes),
            "proof": fingerprint(&proof_bytes), "verifierKey": fingerprint(&vk_bytes),
            "binaryZkir": fingerprint(&binary_ir_bytes), "jsonZkir": fingerprint(&ir_bytes)
        }
    }))
}

fn main() -> Result<()> {
    let mut arguments = env::args().skip(1);
    let directory = arguments
        .next()
        .ok_or("usage: bip340-proof-verify PROOF_ARTIFACT_DIRECTORY")?;
    if arguments.next().is_some() {
        return Err("usage: bip340-proof-verify PROOF_ARTIFACT_DIRECTORY".into());
    }
    let manifest: Value = serde_json::from_slice(TRUSTED_BUILD)?;
    let root = experiment_root();
    let fixture = trusted_fixture(root, &manifest)?;
    let checks = CASES
        .into_iter()
        .map(|case| verify_capture(root, Path::new(&directory), &manifest, &fixture, case))
        .collect::<Result<Vec<_>>>()?;
    let native = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sources = ["src/main.rs", "Cargo.toml", "Cargo.lock"]
        .iter()
        .map(|path| Ok((path.to_string(), fingerprint(&fs::read(native.join(path))?))))
        .collect::<Result<serde_json::Map<String, Value>>>()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "result": "PASS",
            "evidenceLayer": "Native VerifierKey::verify with embedded verifier parameters and reviewed build manifest; complete public transcript independently reconstructed from pinned official fixtures; each proof accepted, altered accepted hash and binding rejected",
            "limitation": "Build pins establish reviewed artefact identity, not compiler correctness or independent reproducibility. Binding and communications commitment come from the capture and are authenticated by the proof; no independent transaction or node admission is checked.",
            "dependency": {"repository": "https://github.com/midnightntwrk/midnight-ledger", "revision": REVISION},
            "trustedBuildManifest": fingerprint(TRUSTED_BUILD), "trustedFixture": manifest["fixture"],
            "trustedSources": manifest["sources"], "sources": sources, "checks": checks
        }))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn manifest() -> Value {
        serde_json::from_slice(TRUSTED_BUILD).unwrap()
    }

    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let path = env::temp_dir().join(format!(
                "bip340-native-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn reconstructs_pinned_official_fixture_commitments() {
        let fixture = trusted_fixture(experiment_root(), &manifest()).unwrap();
        let expected = [
            "9e80a537204775ce5415f9cafce42a4fc506404477da9f0a1a9c3b10b7e9381c",
            "5e36dcd99d6d2e01612a6b9cfbf03aa399b48d44e4f3ad12f64558cb83bfa631",
            "20fb63d257fb1d9edb73bcbd0979c65b830245f72c3dcc7a8f2dbc0e965c794d",
        ];
        for ((_, index, length), hash) in CASES.into_iter().zip(expected) {
            assert_eq!(
                fixture_commitment(&fixture, index, length)
                    .unwrap()
                    .to_vec(),
                hex_bytes(hash).unwrap()
            );
        }
        assert!(fixture_commitment(&fixture, 0, 0).is_err());
        assert!(fixture_commitment(&fixture, 5, 32).is_err());
    }

    #[test]
    fn rejects_modified_source_and_official_fixture_bytes() {
        let manifest = manifest();
        for pin in manifest["sources"]
            .as_array()
            .unwrap()
            .iter()
            .chain(std::iter::once(&manifest["fixture"]))
        {
            let mut bytes = read_pinned(experiment_root(), pin).unwrap();
            bytes[0] ^= 1;
            assert!(check_fingerprint(&bytes, pin).is_err());
        }
    }

    #[test]
    fn rejects_substituted_key_and_ir_even_at_the_expected_path() {
        let root = Temp::new();
        for name in ["verifierKey", "binaryZkir", "jsonZkir"] {
            let pin = &manifest()["circuits"]["verify_32"][name];
            let path = root.0.join(pin["path"].as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, vec![0u8; pin["bytes"].as_u64().unwrap() as usize]).unwrap();
            assert!(read_pinned(&root.0, pin).is_err());
        }
    }

    #[test]
    fn rejects_capture_selected_artefacts_and_path_traversal() {
        let root = Temp::new();
        let trusted = root.0.join("trusted");
        let substitute = root.0.join("substitute");
        fs::write(&trusted, b"identical bytes").unwrap();
        fs::write(&substitute, b"identical bytes").unwrap();
        assert!(check_capture_path(trusted.to_str().unwrap(), &trusted).is_ok());
        assert!(check_capture_path(substitute.to_str().unwrap(), &trusted).is_err());
        assert!(read_pinned(&root.0, &json!({"path":"../trusted"})).is_err());
    }

    #[test]
    fn rejects_every_wrong_transcript_operand_and_wrong_fixture_commitment() {
        let fixture = trusted_fixture(experiment_root(), &manifest()).unwrap();
        let hash = fixture_commitment(&fixture, 0, 32).unwrap();
        let expected = expected_transcript(&hash);
        let mut preimage = ProofPreimage {
            inputs: Vec::new(),
            private_transcript: Vec::new(),
            public_transcript_inputs: expected.clone(),
            public_transcript_outputs: Vec::new(),
            binding_input: Fr::from(0u64),
            communications_commitment: None,
            key_location: midnight_transient_crypto::proofs::KeyLocation("verify_32".into()),
        };
        assert!(check_transcript(&preimage, &expected, "verify_32").is_ok());
        for index in 0..expected.len() {
            preimage.public_transcript_inputs = expected.clone();
            preimage.public_transcript_inputs[index] = expected[index] + Fr::from(1u64);
            assert!(check_transcript(&preimage, &expected, "verify_32").is_err());
        }
        preimage.public_transcript_inputs = expected.clone();
        let mut wrong_hash = hash;
        wrong_hash[0] ^= 1;
        assert!(
            check_transcript(&preimage, &expected_transcript(&wrong_hash), "verify_32").is_err()
        );
        assert!(check_transcript(&preimage, &expected, "verify_0").is_err());
        preimage.public_transcript_outputs.push(Fr::from(0u64));
        assert!(check_transcript(&preimage, &expected, "verify_32").is_err());
    }

    #[test]
    fn rejects_malformed_metadata() {
        let valid = json!({"circuit":"verify_32", "binding":"0", "verifierKey":"key", "ir":"ir", "preimageSha256":"a".repeat(64), "proofSha256":"b".repeat(64)});
        let parse =
            |value: &Value| capture_metadata(&serde_json::to_vec(value).unwrap(), "verify_32");
        assert!(parse(&valid).is_ok());
        for key in valid.as_object().unwrap().keys() {
            let mut value = valid.clone();
            value.as_object_mut().unwrap().remove(key);
            assert!(parse(&value).is_err());
            value = valid.clone();
            value[key] = json!(4);
            assert!(parse(&value).is_err());
        }
        for (key, bad) in [
            ("binding", "01"),
            ("binding", "-1"),
            ("binding", ""),
            ("binding", "1x"),
            ("proofSha256", "not a digest"),
            ("circuit", "verify_100"),
        ] {
            let mut value = valid.clone();
            value[key] = json!(bad);
            assert!(parse(&value).is_err());
        }
        let mut extra = valid.clone();
        extra["trustedManifest"] = json!("attacker.json");
        assert!(parse(&extra).is_err());
        assert!(capture_metadata(b"{", "verify_32").is_err());
        assert!(parse(&json!([])).is_err());
        assert!(decimal_fr(&"9".repeat(90)).is_err());
        assert!(
            decimal_fr(
                "52435875175126190479447740508185965837690552500527637822603658699938581184513"
            )
            .is_err()
        );
    }
}
