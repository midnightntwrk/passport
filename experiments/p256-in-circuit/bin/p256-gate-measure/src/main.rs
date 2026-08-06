//! Evidence and measurement harness for the P-256 in-circuit experiment.
//!
//! Subcommands:
//! * `vectors` — regenerate `evidence/vectors.json`.
//! * `mock` — cost model (optimal k, rows, columns) per relation, written to
//!   `evidence/cost.json`.
//! * `prove` — real SRS-backed proving runs with timings, appended to
//!   `evidence/timings-<relation>.json`.
//! * `passkey` — verify a real WebAuthn assertion (exported as JSON) both
//!   out-of-circuit and in-circuit.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    time::Instant,
};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use clap::{Parser, Subcommand, ValueEnum};
use midnight_zk_stdlib::{
    cost_model, optimal_k, prove, setup_pk, setup_vk,
    utils::plonk_api::{load_srs, SrsSource},
    verify, Relation,
};
use p256::{
    ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey},
    elliptic_curve::scalar::IsHigh,
};
use p256_gate_circuit::{
    relations::{
        P256EcdsaPreHashed, P256EcdsaPrivatePk, P256EcdsaWebAuthn, AUTHENTICATOR_DATA_LEN,
    },
    vectors::{
        cavp_prehashed, generated_prehashed, generated_webauthn, high_s_twin, point_from_xy_bytes,
        point_to_xy_bytes, scalar_from_be_bytes, scalar_to_be_bytes, wrong_pk, PreHashedVector,
        GENERATED_MESSAGE,
    },
};
use rand::rngs::OsRng;
use serde::Deserialize;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};

/// The pinned midnight-zk revision every crate in this workspace builds
/// against, derived at build time from the workspace Cargo.lock (see
/// build.rs, which also asserts all midnight crates agree on one revision).
const MIDNIGHT_ZK_REV: &str = env!("MIDNIGHT_ZK_REV");

#[derive(Parser)]
#[command(
    name = "p256-gate-measure",
    about = "P-256 in-circuit evidence harness"
)]
struct Cli {
    /// Directory the evidence JSON files are written to.
    #[arg(long, default_value = "evidence")]
    evidence_dir: PathBuf,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Regenerate evidence/vectors.json (valid, negative, and high-S
    /// reference vectors, hex encoded).
    Vectors,
    /// Compute the cost model (optimal k, row counts) for each relation and
    /// write evidence/cost.json. MockProver-level, no SRS needed.
    Mock,
    /// Load the SRS, generate keys, and run timed proof generation and
    /// verification. Appends a record to evidence/timings-<relation>.json.
    Prove {
        /// Which relation to prove.
        #[arg(long, value_enum)]
        relation: RelationKind,
        /// Number of timed proving runs.
        #[arg(long, default_value_t = 3)]
        runs: usize,
        /// Circuit size override (log2 of the number of rows). Defaults to
        /// the relation's optimal k.
        #[arg(long)]
        k: Option<u32>,
    },
    /// Check a real WebAuthn assertion (JSON export) out-of-circuit and then
    /// in-circuit with a real proof. Writes evidence/passkey-run.json.
    Passkey {
        /// Path to a p256-gate-webauthn-v1 JSON file.
        #[arg(long)]
        input: PathBuf,
        /// Expected relying-party identifier: the rpIdHash in
        /// authenticatorData must equal its SHA-256 (the capture harness
        /// registers the credential under "localhost").
        #[arg(long, default_value = "localhost")]
        rp_id: String,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum RelationKind {
    Prehashed,
    Webauthn,
    Privatepk,
}

impl RelationKind {
    fn name(self) -> &'static str {
        match self {
            RelationKind::Prehashed => "prehashed",
            RelationKind::Webauthn => "webauthn",
            RelationKind::Privatepk => "privatepk",
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    fs::create_dir_all(&cli.evidence_dir)
        .with_context(|| format!("creating evidence dir {}", cli.evidence_dir.display()))?;

    match cli.command {
        Command::Vectors => cmd_vectors(&cli.evidence_dir),
        Command::Mock => cmd_mock(&cli.evidence_dir),
        Command::Prove { relation, runs, k } => cmd_prove(&cli.evidence_dir, relation, runs, k),
        Command::Passkey { input, rp_id } => cmd_passkey(&cli.evidence_dir, &input, &rp_id),
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn write_pretty_json(path: &Path, value: &Json) -> Result<()> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    fs::write(path, text).with_context(|| format!("writing {}", path.display()))?;
    println!("Wrote {}", path.display());
    Ok(())
}

fn prehashed_json(vector: &PreHashedVector, expected: &str, note: &str) -> Json {
    let (pk_x, pk_y) = point_to_xy_bytes(&vector.pk);
    json!({
        "pk_x_hex": hex::encode(pk_x),
        "pk_y_hex": hex::encode(pk_y),
        "hash_hex": hex::encode(vector.hash),
        "r_hex": hex::encode(scalar_to_be_bytes(&vector.r)),
        "s_hex": hex::encode(scalar_to_be_bytes(&vector.s)),
        "expected": expected,
        "note": note,
    })
}

/// Ensures `SRS_DIR` is set, defaulting to `./assets` (where the README's
/// curl command drops the Filecoin SRS file).
fn ensure_srs_dir() {
    if env::var_os("SRS_DIR").is_none() {
        env::set_var("SRS_DIR", "./assets");
    }
    println!(
        "SRS_DIR = {}",
        env::var("SRS_DIR").unwrap_or_else(|_| "<unset>".into())
    );
}

fn sysctl_string(key: &str) -> Option<String> {
    let output = ProcessCommand::new("sysctl")
        .args(["-n", key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn environment_json() -> Json {
    json!({
        "cpu": sysctl_string("machdep.cpu.brand_string"),
        "memory_bytes": sysctl_string("hw.memsize"),
        "os": env::consts::OS,
        "arch": env::consts::ARCH,
        "rustc": env!("P256_GATE_RUSTC_VERSION"),
        "midnight_zk_rev": MIDNIGHT_ZK_REV,
    })
}

/// UTC timestamp for evidence records (RFC 3339, second resolution), so
/// records appended across sessions can be dated and ordered.
fn utc_timestamp() -> Option<String> {
    let output = ProcessCommand::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// vectors
// ---------------------------------------------------------------------------

fn cmd_vectors(evidence_dir: &Path) -> Result<()> {
    let valid = generated_prehashed();
    let cavp = cavp_prehashed();
    let webauthn = generated_webauthn();

    let mut flipped_r = valid.clone();
    flipped_r.r = flip_low_bit(&flipped_r.r)?;
    let mut flipped_s = valid.clone();
    flipped_s.s = flip_low_bit(&flipped_s.s)?;
    let mut wrong_key = valid.clone();
    wrong_key.pk = wrong_pk();
    let mut wrong_hash = valid.clone();
    wrong_hash.hash[0] ^= 0xff;
    let mut high_s = valid.clone();
    high_s.s = high_s_twin(&high_s.s);

    let (wa_pk_x, wa_pk_y) = point_to_xy_bytes(&webauthn.pk);
    let vectors = json!({
        "format": "p256-gate-vectors-v1",
        "midnight_zk_rev": MIDNIGHT_ZK_REV,
        "generated_valid": {
            "message_hex": hex::encode(GENERATED_MESSAGE),
            "vector": prehashed_json(&valid, "pass",
                "RFC 6979 deterministic signature generated with the RustCrypto p256 crate, \
                 low-S normalised"),
        },
        "cavp_sigver_p256_sha256": prehashed_json(&cavp, "pass",
            "NIST CAVP FIPS 186-4 SigVer.rsp [P-256,SHA-256], Result = P case; \
             cross-checked with RustCrypto p256 before use"),
        "negative_flipped_r": prehashed_json(&flipped_r, "fail", "low bit of r flipped"),
        "negative_flipped_s": prehashed_json(&flipped_s, "fail", "low bit of s flipped"),
        "negative_wrong_pk": prehashed_json(&wrong_key, "fail", "public key of an unrelated keypair"),
        "negative_wrong_hash": prehashed_json(&wrong_hash, "fail", "first hash byte inverted"),
        "high_s_twin": prehashed_json(&high_s, "pass",
            "(r, n - s) twin of generated_valid (which is low-S), hence the high-S form; passes \
             by design, documenting ECDSA malleability for the low-S policy discussion"),
        "webauthn": {
            "pk_x_hex": hex::encode(wa_pk_x),
            "pk_y_hex": hex::encode(wa_pk_y),
            "authenticator_data_hex": hex::encode(webauthn.authenticator_data),
            "client_data_hash_hex": hex::encode(webauthn.client_data_hash),
            "r_hex": hex::encode(scalar_to_be_bytes(&webauthn.r)),
            "s_hex": hex::encode(scalar_to_be_bytes(&webauthn.s)),
            "expected": "pass",
            "note": "signature over SHA-256(authenticator_data || client_data_hash)",
        },
    });

    write_pretty_json(&evidence_dir.join("vectors.json"), &vectors)
}

fn flip_low_bit(scalar: &midnight_curves::p256::Fq) -> Result<midnight_curves::p256::Fq> {
    let mut bytes = scalar_to_be_bytes(scalar);
    bytes[31] ^= 0x01;
    scalar_from_be_bytes(&bytes).ok_or_else(|| anyhow!("bit-flipped scalar is non-canonical"))
}

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

fn relation_cost_json<R: Relation>(relation: &R, name: &str) -> Json {
    println!("Computing cost model for {name} (this synthesises the circuit several times)...");
    let k = optimal_k(relation);
    let model = cost_model(relation, Some(k));
    let entry = json!({
        "optimal_k": k,
        "rows": model.rows,
        "table_rows": model.table_rows,
        "nb_unusable_rows": model.nb_unusable_rows,
        "max_deg": model.max_deg,
        "advice_columns": model.advice_columns,
        "fixed_columns": model.fixed_columns,
        "lookups": model.lookups,
        "permutations": model.permutations,
        "column_queries": model.column_queries,
        "point_sets": model.point_sets,
        "estimated_proof_size_bytes": model.size,
    });
    println!("{name}: optimal_k = {k}, rows = {}", model.rows);
    entry
}

fn cmd_mock(evidence_dir: &Path) -> Result<()> {
    let cost = json!({
        "midnight_zk_rev": MIDNIGHT_ZK_REV,
        "environment": environment_json(),
        "prehashed": relation_cost_json(&P256EcdsaPreHashed, "prehashed"),
        "webauthn": relation_cost_json(&P256EcdsaWebAuthn, "webauthn"),
        "privatepk": relation_cost_json(&P256EcdsaPrivatePk, "privatepk"),
    });
    write_pretty_json(&evidence_dir.join("cost.json"), &cost)
}

// ---------------------------------------------------------------------------
// prove
// ---------------------------------------------------------------------------

struct ProveReport {
    k: u32,
    srs_load_ms: u128,
    setup_vk_ms: u128,
    setup_pk_ms: u128,
    prove_ms: Vec<u128>,
    verify_ms: u128,
    proof_bytes: usize,
}

fn timed_prove_runs<R>(
    relation: &R,
    instance: &R::Instance,
    witness: &R::Witness,
    runs: usize,
    k: Option<u32>,
) -> Result<ProveReport>
where
    R: Relation,
    R::Error: std::fmt::Debug,
{
    // Resolve the circuit size and constraint-system degree before starting
    // the SRS timer: with `k = None`, `optimal_k` synthesises the circuit
    // repeatedly via the cost model, which would otherwise dominate and
    // misattribute the "SRS load" measurement.
    let k = k.unwrap_or_else(|| optimal_k(relation));
    let cs_degree = cost_model(relation, Some(k)).max_deg;

    // Note: the first run for a given k reads the full 2p19 SRS file,
    // downsizes it, and caches the downsized copy; later runs read only the
    // small cached file. Both are genuine SRS-loading work.
    let start = Instant::now();
    let srs = load_srs(SrsSource::Filecoin, k, cs_degree);
    let srs_load_ms = start.elapsed().as_millis();
    println!("SRS loaded (k = {k}) in {srs_load_ms} ms");

    let start = Instant::now();
    let vk = setup_vk(&srs, relation);
    let setup_vk_ms = start.elapsed().as_millis();
    println!("vk generated in {setup_vk_ms} ms");

    let start = Instant::now();
    let pk = setup_pk(relation, &vk);
    let setup_pk_ms = start.elapsed().as_millis();
    println!("pk generated in {setup_pk_ms} ms");

    let mut prove_ms = Vec::with_capacity(runs);
    let mut proof = Vec::new();
    for run in 0..runs {
        let start = Instant::now();
        proof =
            prove::<R, blake2b_simd::State>(&srs, &pk, relation, instance, witness.clone(), OsRng)
                .map_err(|e| anyhow!("proof generation failed: {e:?}"))?;
        let elapsed = start.elapsed().as_millis();
        println!(
            "run {}: proof generated in {elapsed} ms ({} bytes)",
            run + 1,
            proof.len()
        );
        prove_ms.push(elapsed);
    }

    let start = Instant::now();
    verify::<R, blake2b_simd::State>(&srs.verifier_params(), &vk, instance, None, &proof)
        .map_err(|e| anyhow!("proof verification failed: {e:?}"))?;
    let verify_ms = start.elapsed().as_millis();
    println!("proof verified in {verify_ms} ms");

    Ok(ProveReport {
        k: u32::from(vk.k()),
        srs_load_ms,
        setup_vk_ms,
        setup_pk_ms,
        prove_ms,
        verify_ms,
        proof_bytes: proof.len(),
    })
}

fn append_timing_record(evidence_dir: &Path, relation: RelationKind, record: Json) -> Result<()> {
    let path = evidence_dir.join(format!("timings-{}.json", relation.name()));
    let mut records: Vec<Json> = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .with_context(|| format!("{} is not a JSON array", path.display()))?,
        Err(_) => Vec::new(),
    };
    records.push(record);
    write_pretty_json(&path, &Json::Array(records))
}

fn cmd_prove(
    evidence_dir: &Path,
    relation: RelationKind,
    runs: usize,
    k: Option<u32>,
) -> Result<()> {
    ensure_srs_dir();

    let report = match relation {
        RelationKind::Prehashed => {
            let vector = generated_prehashed();
            timed_prove_runs(
                &P256EcdsaPreHashed,
                &(vector.pk, vector.hash),
                &(vector.r, vector.s),
                runs,
                k,
            )?
        }
        RelationKind::Webauthn => {
            let vector = generated_webauthn();
            timed_prove_runs(
                &P256EcdsaWebAuthn,
                &(
                    vector.pk,
                    vector.authenticator_data,
                    vector.client_data_hash,
                ),
                &(vector.r, vector.s),
                runs,
                k,
            )?
        }
        RelationKind::Privatepk => {
            let vector = generated_prehashed();
            timed_prove_runs(
                &P256EcdsaPrivatePk,
                &vector.hash,
                &(vector.pk, vector.r, vector.s),
                runs,
                k,
            )?
        }
    };

    let record = json!({
        "timestamp_utc": utc_timestamp(),
        "relation": relation.name(),
        "k": report.k,
        "k_override": k,
        "runs": runs,
        "srs_load_ms": report.srs_load_ms,
        "setup_vk_ms": report.setup_vk_ms,
        "setup_pk_ms": report.setup_pk_ms,
        "prove_ms": report.prove_ms,
        "verify_ms": report.verify_ms,
        "proof_bytes": report.proof_bytes,
        "environment": environment_json(),
    });
    append_timing_record(evidence_dir, relation, record)
}

// ---------------------------------------------------------------------------
// passkey
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PasskeyInput {
    format: String,
    credential_id_b64url: String,
    pk_x_hex: String,
    pk_y_hex: String,
    signature_der_hex: String,
    authenticator_data_hex: String,
    client_data_json_b64url: String,
    challenge_hex: String,
}

fn decode_hex_array<const N: usize>(field: &str, text: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(text).with_context(|| format!("{field}: invalid hex"))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("{field}: expected {N} bytes, got {}", bytes.len()))
}

fn decode_b64url(field: &str, text: &str) -> Result<Vec<u8>> {
    let no_pad = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let padded = base64::engine::general_purpose::URL_SAFE;
    no_pad
        .decode(text)
        .or_else(|_| padded.decode(text))
        .with_context(|| format!("{field}: invalid base64url"))
}

fn cmd_passkey(evidence_dir: &Path, input_path: &Path, rp_id: &str) -> Result<()> {
    let text = fs::read_to_string(input_path)
        .with_context(|| format!("reading {}", input_path.display()))?;
    let input: PasskeyInput = serde_json::from_str(&text).context("parsing passkey input JSON")?;
    if input.format != "p256-gate-webauthn-v1" {
        bail!("unsupported input format {:?}", input.format);
    }

    // Decode all fields.
    let pk_x: [u8; 32] = decode_hex_array("pk_x_hex", &input.pk_x_hex)?;
    let pk_y: [u8; 32] = decode_hex_array("pk_y_hex", &input.pk_y_hex)?;
    let signature_der =
        hex::decode(&input.signature_der_hex).context("signature_der_hex: invalid hex")?;
    let authenticator_data = hex::decode(&input.authenticator_data_hex)
        .context("authenticator_data_hex: invalid hex")?;
    let client_data_json =
        decode_b64url("client_data_json_b64url", &input.client_data_json_b64url)?;
    let challenge: [u8; 32] = decode_hex_array("challenge_hex", &input.challenge_hex)?;

    // Parse the DER ECDSA-Sig-Value into (r, s).
    let signature =
        Signature::from_der(&signature_der).map_err(|e| anyhow!("parsing DER signature: {e}"))?;

    // Whether the authenticator emitted a high-S signature is the
    // malleability datapoint for the MIP's low-S policy discussion. It must
    // be read off s directly: RustCrypto's verifier accepts both s and
    // n - s, so a verification round-trip cannot detect the form.
    let authenticator_emitted_high_s = bool::from(signature.s().is_high());
    println!(
        "authenticator emitted a {}-S signature",
        if authenticator_emitted_high_s {
            "high"
        } else {
            "low"
        }
    );

    // Recompute the hashes the authenticator signed.
    let client_data_hash: [u8; 32] = Sha256::digest(&client_data_json).into();
    let mut signed_bytes = authenticator_data.clone();
    signed_bytes.extend_from_slice(&client_data_hash);
    let message_hash: [u8; 32] = Sha256::digest(&signed_bytes).into();

    // Sanity-verify with RustCrypto before going anywhere near the circuit.
    let encoded_point =
        p256::EncodedPoint::from_affine_coordinates(&pk_x.into(), &pk_y.into(), false);
    let verifying_key = VerifyingKey::from_encoded_point(&encoded_point)
        .map_err(|e| anyhow!("public key is not a valid P-256 point: {e}"))?;

    // RustCrypto's verifier accepts both S forms, so no normalisation
    // fallback is needed (or would ever fire).
    verifying_key
        .verify_prehash(&message_hash, &signature)
        .map_err(|_| anyhow!("signature failed RustCrypto verification"))?;
    println!("RustCrypto verification succeeded with the signature as returned");

    // The challenge must appear, base64url encoded, as the clientDataJSON
    // "challenge" member.
    let client_data: Json =
        serde_json::from_slice(&client_data_json).context("clientDataJSON is not valid JSON")?;
    let expected_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(challenge);
    let found_challenge = client_data
        .get("challenge")
        .and_then(Json::as_str)
        .ok_or_else(|| anyhow!("clientDataJSON has no string \"challenge\" member"))?;
    if found_challenge != expected_challenge {
        bail!("challenge mismatch: clientDataJSON has {found_challenge:?}, expected {expected_challenge:?}");
    }
    println!("challenge matches clientDataJSON");

    // The ceremony type must be an assertion: a create-ceremony (packed
    // attestation) signature also covers authenticatorData ||
    // clientDataHash, so without this check a registration could pass as an
    // assertion.
    let found_type = client_data
        .get("type")
        .and_then(Json::as_str)
        .ok_or_else(|| anyhow!("clientDataJSON has no string \"type\" member"))?;
    if found_type != "webauthn.get" {
        bail!("clientDataJSON type is {found_type:?}, expected \"webauthn.get\"");
    }
    println!("clientDataJSON type is webauthn.get");

    // The rpIdHash (first 32 bytes of authenticatorData) must be the
    // SHA-256 of the expected relying-party identifier, or the assertion
    // was made for a different relying party.
    if authenticator_data.len() < 32 {
        bail!(
            "authenticator data is {} bytes, shorter than the 32-byte rpIdHash",
            authenticator_data.len()
        );
    }
    let expected_rp_id_hash: [u8; 32] = Sha256::digest(rp_id.as_bytes()).into();
    if authenticator_data[..32] != expected_rp_id_hash {
        bail!(
            "rpIdHash mismatch: authenticatorData carries {}, expected SHA-256({rp_id:?}) = {}",
            hex::encode(&authenticator_data[..32]),
            hex::encode(expected_rp_id_hash),
        );
    }
    println!("rpIdHash matches SHA-256({rp_id:?})");

    // Convert to circuit types.
    let pk = point_from_xy_bytes(&pk_x, &pk_y)
        .ok_or_else(|| anyhow!("public key rejected by midnight-curves"))?;
    let r = *signature.r();
    let s = *signature.s();

    // In-circuit check with a real proof.
    ensure_srs_dir();
    let (relation_name, report) = if authenticator_data.len() == AUTHENTICATOR_DATA_LEN {
        let auth_data: [u8; AUTHENTICATOR_DATA_LEN] = authenticator_data
            .as_slice()
            .try_into()
            .expect("length checked");
        println!("authenticator data is 37 bytes; using P256EcdsaWebAuthn (in-circuit SHA-256)");
        (
            "webauthn",
            timed_prove_runs(
                &P256EcdsaWebAuthn,
                &(pk, auth_data, client_data_hash),
                &(r, s),
                1,
                None,
            )?,
        )
    } else {
        println!(
            "authenticator data is {} bytes (extensions present?); falling back to P256EcdsaPreHashed",
            authenticator_data.len()
        );
        (
            "prehashed",
            timed_prove_runs(&P256EcdsaPreHashed, &(pk, message_hash), &(r, s), 1, None)?,
        )
    };

    let record = json!({
        "timestamp_utc": utc_timestamp(),
        "format": input.format,
        "credential_id_b64url": input.credential_id_b64url,
        "pk_x_hex": hex::encode(pk_x),
        "pk_y_hex": hex::encode(pk_y),
        "authenticator_data_hex": hex::encode(&authenticator_data),
        "client_data_hash_hex": hex::encode(client_data_hash),
        "message_hash_hex": hex::encode(message_hash),
        "r_hex": hex::encode(scalar_to_be_bytes(&r)),
        "s_hex": hex::encode(scalar_to_be_bytes(&s)),
        "authenticator_emitted_high_s": authenticator_emitted_high_s,
        "challenge_hex": hex::encode(challenge),
        "challenge_found_in_client_data": true,
        "client_data_type_verified": true,
        "rp_id": rp_id,
        "rp_id_hash_verified": true,
        "relation": relation_name,
        "k": report.k,
        "srs_load_ms": report.srs_load_ms,
        "setup_vk_ms": report.setup_vk_ms,
        "setup_pk_ms": report.setup_pk_ms,
        "prove_ms": report.prove_ms,
        "verify_ms": report.verify_ms,
        "proof_bytes": report.proof_bytes,
        "outcome": "verified in-circuit",
        "environment": environment_json(),
    });
    write_pretty_json(&evidence_dir.join("passkey-run.json"), &record)
}
