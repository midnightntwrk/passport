//! Evidence and measurement harness for the BIP-340 wallet-gate experiment.
//!
//! Subcommands:
//! * `vector` — verify a wallet-produced vector (`evidence/p1-vector.json`
//!   or the connector-path variant) out-of-circuit with RustCrypto k256,
//!   the independent Rust implementation of the scheme the wallet stack
//!   signs with. Writes `evidence/rust-verify.json`.
//! * `mock` — cost model (optimal k, rows) for both relation variants,
//!   written to `evidence/cost.json`.
//! * `prove` — real SRS-backed proving of a wallet vector with timings,
//!   appended to `evidence/timings-<path>.json`.

use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::{anyhow, bail, Context, Result};
use bip340_gate_circuit::{
    connector_prefix, lift_x_even, scalar_from_be_bytes, Bip340WalletGate, DIGEST_LEN,
};
use clap::{Parser, Subcommand, ValueEnum};
use k256::schnorr::{signature::Verifier, Signature as K256Signature, VerifyingKey};
use midnight_zk_stdlib::{
    cost_model, optimal_k, prove, setup_pk, setup_vk,
    utils::plonk_api::{load_srs, SrsSource},
    verify, Relation,
};
use rand::rngs::OsRng;
use serde::Deserialize;
use serde_json::{json, Value as Json};

/// The pinned midnight-zk revision every crate in this workspace builds
/// against, derived at build time from the workspace Cargo.lock.
const MIDNIGHT_ZK_REV: &str = env!("MIDNIGHT_ZK_REV");

#[derive(Parser)]
#[command(
    name = "bip340-gate-measure",
    about = "BIP-340 wallet-gate evidence harness"
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
    /// Verify the wallet-produced vectors out-of-circuit with RustCrypto
    /// k256 (independent of the wallet stack). Writes
    /// evidence/rust-verify.json.
    Vector,
    /// Compute the cost model (optimal k, row counts) for both relation
    /// variants and write evidence/cost.json. MockProver-level, no SRS.
    Mock,
    /// Load the SRS, generate keys, and run timed proof generation and
    /// verification over a wallet vector. Appends a record to
    /// evidence/timings-<path>.json.
    Prove {
        /// Which signing path to prove.
        #[arg(long, value_enum)]
        path: PathKind,
        /// Number of timed proving runs.
        #[arg(long, default_value_t = 3)]
        runs: usize,
        /// Circuit size override (log2 rows). Defaults to the optimal k.
        #[arg(long)]
        k: Option<u32>,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum PathKind {
    /// SDK/keystore path: message = SHA-256(payload).
    Sdk,
    /// dApp-connector path: message =
    /// SHA-256("midnight_signed_message:32:" || payload).
    Connector,
}

impl PathKind {
    fn name(self) -> &'static str {
        match self {
            PathKind::Sdk => "sdk",
            PathKind::Connector => "connector",
        }
    }

    fn relation(self) -> Bip340WalletGate {
        match self {
            PathKind::Sdk => Bip340WalletGate::sdk(),
            PathKind::Connector => Bip340WalletGate::connector(),
        }
    }

    fn vector_file(self) -> &'static str {
        match self {
            PathKind::Sdk => "p1-vector.json",
            PathKind::Connector => "p1-vector-connector.json",
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    fs::create_dir_all(&cli.evidence_dir)
        .with_context(|| format!("creating {}", cli.evidence_dir.display()))?;
    match cli.command {
        Command::Vector => cmd_vector(&cli.evidence_dir),
        Command::Mock => cmd_mock(&cli.evidence_dir),
        Command::Prove { path, runs, k } => cmd_prove(&cli.evidence_dir, path, runs, k),
    }
}

// ---------------------------------------------------------------------------
// wallet vectors
// ---------------------------------------------------------------------------

/// The JSON shape `p1-vector.mjs` writes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletVector {
    challenge_hex: String,
    public_key_hex: String,
    signature_hex: String,
}

struct ParsedVector {
    payload: [u8; DIGEST_LEN],
    pk_x: [u8; DIGEST_LEN],
    r: [u8; DIGEST_LEN],
    s_bytes: [u8; DIGEST_LEN],
    signature: [u8; 64],
}

fn decode_hex_array<const N: usize>(field: &str, text: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(text.trim_start_matches("0x"))
        .with_context(|| format!("{field}: invalid hex"))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("{field}: expected {N} bytes, got {}", bytes.len()))
}

fn load_vector(evidence_dir: &Path, file: &str) -> Result<ParsedVector> {
    let path = evidence_dir.join(file);
    let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let vector: WalletVector = serde_json::from_str(&text)?;
    let payload = decode_hex_array::<DIGEST_LEN>("challengeHex", &vector.challenge_hex)?;
    let pk_x = decode_hex_array::<DIGEST_LEN>("publicKeyHex", &vector.public_key_hex)?;
    let signature = decode_hex_array::<64>("signatureHex", &vector.signature_hex)?;
    let r: [u8; DIGEST_LEN] = signature[..DIGEST_LEN].try_into().expect("32-byte half");
    let s_bytes: [u8; DIGEST_LEN] = signature[DIGEST_LEN..].try_into().expect("32-byte half");
    Ok(ParsedVector {
        payload,
        pk_x,
        r,
        s_bytes,
        signature,
    })
}

/// Out-of-circuit verification of one vector with RustCrypto k256: the
/// `Verifier::verify` path (which applies the same SHA-256 pre-hash the
/// signer applied) over the signed bytes for this path.
fn rust_verify_json(vector: &ParsedVector, signed_bytes: &[u8]) -> Result<Json> {
    let vk =
        VerifyingKey::from_bytes(&vector.pk_x).map_err(|e| anyhow!("x-only key rejected: {e}"))?;
    let sig = K256Signature::try_from(&vector.signature[..])
        .map_err(|e| anyhow!("signature rejected: {e}"))?;

    let accepts = vk.verify(signed_bytes, &sig).is_ok();
    let rejects_raw_message = vk.verify_raw(signed_bytes, &sig).is_err();

    // Corrupt one payload byte: verification must fail.
    let mut corrupted = signed_bytes.to_vec();
    corrupted[0] ^= 0x01;
    let rejects_corrupted = vk.verify(&corrupted, &sig).is_err();

    Ok(json!({
        "verify_over_signed_bytes": accepts,
        "rejects_unhashed_message": rejects_raw_message,
        "rejects_corrupted_payload": rejects_corrupted,
        "message_is_sha256_of_signed_bytes": accepts && rejects_raw_message,
    }))
}

fn cmd_vector(evidence_dir: &Path) -> Result<()> {
    let mut report = json!({
        "k256_version": "0.13 (workspace pin, same line midnight-curves wraps)",
        "note": "independent Rust verification of the wallet-SDK-produced vectors",
    });

    for path in [PathKind::Sdk, PathKind::Connector] {
        let file = path.vector_file();
        if !evidence_dir.join(file).exists() {
            println!("{file} not present, skipping the {} path", path.name());
            continue;
        }
        let vector = load_vector(evidence_dir, file)?;
        let signed_bytes = path.relation().signed_bytes(&vector.payload);
        let entry = rust_verify_json(&vector, &signed_bytes)?;
        println!("{}: {entry}", path.name());
        for (check, value) in entry.as_object().expect("object") {
            if value == &Json::Bool(false) {
                bail!("{}: check {check} failed", path.name());
            }
        }
        report[path.name()] = entry;
    }

    write_pretty_json(&evidence_dir.join("rust-verify.json"), &report)
}

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

fn relation_cost_json<R: Relation>(relation: &R, name: &str) -> Json {
    println!("Computing cost model for {name} (synthesises the circuit several times)...");
    let k = optimal_k(relation);
    let model = cost_model(relation, Some(k));
    println!("{name}: optimal_k = {k}, rows = {}", model.rows);
    json!({
        "optimal_k": k,
        "rows": model.rows,
        "advice_columns": model.advice_columns,
        "fixed_columns": model.fixed_columns,
        "lookups": model.lookups,
        "max_deg": model.max_deg,
        "estimated_proof_size_bytes": model.size,
    })
}

fn cmd_mock(evidence_dir: &Path) -> Result<()> {
    let cost = json!({
        "midnight_zk_rev": MIDNIGHT_ZK_REV,
        "rustc": env!("BIP340_GATE_RUSTC_VERSION"),
        "sdk": relation_cost_json(&Bip340WalletGate::sdk(), "sdk"),
        "connector": relation_cost_json(&Bip340WalletGate::connector(), "connector"),
    });
    write_pretty_json(&evidence_dir.join("cost.json"), &cost)
}

// ---------------------------------------------------------------------------
// prove
// ---------------------------------------------------------------------------

/// Points SRS loading at a directory that has the downsized Filecoin SRS
/// cache. Prefers `./assets`; falls back to the p256 experiment's cache so
/// the two experiments share one download.
fn ensure_srs_dir() {
    if env::var_os("SRS_DIR").is_none() {
        let local = Path::new("./assets");
        let shared = Path::new("../p256-in-circuit/assets");
        let dir = if local.exists() || !shared.exists() {
            local
        } else {
            shared
        };
        env::set_var("SRS_DIR", dir);
    }
    println!(
        "SRS_DIR = {}",
        env::var("SRS_DIR").unwrap_or_else(|_| "<unset>".into())
    );
}

fn cmd_prove(evidence_dir: &Path, path: PathKind, runs: usize, k: Option<u32>) -> Result<()> {
    ensure_srs_dir();
    let relation = path.relation();
    let vector = load_vector(evidence_dir, path.vector_file())?;

    // Independent out-of-circuit check before spending proving time.
    let signed_bytes = relation.signed_bytes(&vector.payload);
    let rust_checks = rust_verify_json(&vector, &signed_bytes)?;
    if rust_checks["message_is_sha256_of_signed_bytes"] != Json::Bool(true) {
        bail!("vector failed the out-of-circuit k256 verification");
    }

    let instance = (vector.pk_x, vector.payload);
    let pk_point =
        lift_x_even(&vector.pk_x).ok_or_else(|| anyhow!("public key does not lift to a point"))?;
    let s = scalar_from_be_bytes(&vector.s_bytes)
        .ok_or_else(|| anyhow!("signature s is not a canonical scalar"))?;
    let witness = (pk_point, vector.r, s);

    let k = k.unwrap_or_else(|| optimal_k(&relation));
    let cs_degree = cost_model(&relation, Some(k)).max_deg;

    let start = Instant::now();
    let srs = load_srs(SrsSource::Filecoin, k, cs_degree);
    let srs_load_ms = start.elapsed().as_millis();
    println!("SRS loaded (k = {k}) in {srs_load_ms} ms");

    let start = Instant::now();
    let vk = setup_vk(&srs, &relation);
    let setup_vk_ms = start.elapsed().as_millis();
    println!("vk generated in {setup_vk_ms} ms");

    let start = Instant::now();
    let pk = setup_pk(&relation, &vk);
    let setup_pk_ms = start.elapsed().as_millis();
    println!("pk generated in {setup_pk_ms} ms");

    let mut prove_ms = Vec::with_capacity(runs);
    let mut proof = Vec::new();
    for run in 0..runs {
        let start = Instant::now();
        proof = prove::<_, blake2b_simd::State>(&srs, &pk, &relation, &instance, witness, OsRng)
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
    verify::<Bip340WalletGate, blake2b_simd::State>(
        &srs.verifier_params(),
        &vk,
        &instance,
        None,
        &proof,
    )
    .map_err(|e| anyhow!("proof verification failed: {e:?}"))?;
    let verify_ms = start.elapsed().as_millis();
    println!("proof verified in {verify_ms} ms");

    // Negative control: the proof must not verify under a different payload.
    let mut wrong_instance = instance;
    wrong_instance.1[0] ^= 0x01;
    let wrong_rejected = verify::<Bip340WalletGate, blake2b_simd::State>(
        &srs.verifier_params(),
        &vk,
        &wrong_instance,
        None,
        &proof,
    )
    .is_err();
    if !wrong_rejected {
        bail!("negative control failed: proof verified under a corrupted payload");
    }
    println!("negative control: corrupted payload rejected");

    let record = json!({
        "midnight_zk_rev": MIDNIGHT_ZK_REV,
        "rustc": env!("BIP340_GATE_RUSTC_VERSION"),
        "path": path.name(),
        "prefix_ascii": String::from_utf8_lossy(&connector_prefix(DIGEST_LEN)),
        "prefix_applied": matches!(path, PathKind::Connector),
        "instance_public_input_elements":
            Bip340WalletGate::format_instance(&instance).map(|v| v.len()).ok(),
        "rust_checks": rust_checks,
        "k": k,
        "srs_load_ms": srs_load_ms,
        "setup_vk_ms": setup_vk_ms,
        "setup_pk_ms": setup_pk_ms,
        "prove_ms": prove_ms,
        "verify_ms": verify_ms,
        "proof_bytes": proof.len(),
        "negative_control_rejected": wrong_rejected,
    });
    append_record(
        &evidence_dir.join(format!("timings-{}.json", path.name())),
        record,
    )
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

fn write_pretty_json(path: &Path, value: &Json) -> Result<()> {
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))
        .with_context(|| format!("writing {}", path.display()))?;
    println!("wrote {}", path.display());
    Ok(())
}

fn append_record(path: &Path, record: Json) -> Result<()> {
    let mut records: Vec<Json> = match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)?,
        Err(_) => Vec::new(),
    };
    records.push(record);
    write_pretty_json(path, &Json::Array(records))
}
