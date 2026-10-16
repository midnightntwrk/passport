use anyhow::{Context, Result, bail, ensure};
use midnight_base_crypto::fab::AlignedValue;
use midnight_onchain_state::state::StateValue;
use midnight_storage::{
    db::InMemoryDB,
    storage::{Array, HashMap},
};
use midnight_transient_crypto::repr::FieldRepr;
use midnight_transient_crypto::{
    curve::Fr,
    fab::ValueReprAlignedValue,
    proofs::{ParamsProverProvider, ParamsVerifier, ProofPreimage, Zkir},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::Instant,
};
#[allow(dead_code)]
mod executor;
use executor::{self as exec, Call};
use minocrab_zkir::v3::to_zkir_string;
use reference_zkir::IrSource;

fn current_ir(ir: &minocrab_zkir::v3::IrSource) -> Result<IrSource> {
    Ok(IrSource::load(to_zkir_string(ir)?.as_bytes())?)
}

mod localnet;
#[allow(dead_code)]
mod simulator;
struct Circuit {
    proof: IrSource,
    zkir_bytes: usize,
}
impl std::ops::Deref for Circuit {
    type Target = IrSource;
    fn deref(&self) -> &IrSource {
        &self.proof
    }
}
impl Circuit {
    fn new(proof: IrSource, zkir_bytes: usize) -> Result<Self> {
        Ok(Self { proof, zkir_bytes })
    }
}
fn execute(
    ir: &Circuit,
    call: &Call<'_>,
    ctx: &midnight_onchain_runtime::context::QueryContext<InMemoryDB>,
) -> Result<exec::Executed> {
    Ok(exec::execute(&ir.proof, call, ctx)?)
}

#[derive(Deserialize)]
#[serde(tag = "tag", content = "value", rename_all = "lowercase")]
enum State {
    Null,
    Cell(AlignedValue),
    Array(Vec<State>),
    Map(Vec<(AlignedValue, State)>),
}
impl State {
    fn build(&self) -> StateValue<InMemoryDB> {
        match self {
            Self::Null => StateValue::Null,
            Self::Cell(v) => StateValue::Cell(midnight_storage::arena::Sp::new(v.clone())),
            Self::Array(v) => {
                StateValue::Array(Array::from(v.iter().map(State::build).collect::<Vec<_>>()))
            }
            Self::Map(v) => {
                let mut map = HashMap::new();
                for (key, value) in v {
                    map = map.insert(key.clone(), value.build());
                }
                StateValue::Map(map)
            }
        }
    }
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    label: String,
    address: [u8; 32],
    time: u64,
    expires_at: Option<u64>,
    caller: Option<Caller>,
    restricted: bool,
    before: State,
    after: State,
    input: AlignedValue,
    output: AlignedValue,
    witnesses: Vec<AlignedValue>,
}

#[derive(Deserialize)]
struct Caller {
    tag: String,
    address: String,
}
fn set_caller(
    ctx: &mut midnight_onchain_runtime::context::QueryContext<InMemoryDB>,
    caller: &Option<Caller>,
) -> Result<()> {
    use midnight_coin_structure::coin::PublicAddress;
    ctx.call_context.caller = caller
        .as_ref()
        .map(|value| {
            let mut address = [0u8; 32];
            for (i, b) in address.iter_mut().enumerate() {
                *b = u8::from_str_radix(&value.address[i * 2..i * 2 + 2], 16)?;
            }
            Ok::<_, anyhow::Error>(if value.tag == "contract" {
                PublicAddress::Contract(midnight_coin_structure::contract::ContractAddress(
                    midnight_base_crypto::hash::HashOutput(address),
                ))
            } else {
                PublicAddress::User(midnight_coin_structure::coin::UserAddress(
                    midnight_base_crypto::hash::HashOutput(address),
                ))
            })
        })
        .transpose()?;
    Ok(())
}

fn atom_u64(bytes: &[u8]) -> Result<u64> {
    ensure!(bytes.len() <= 8, "oversized u64");
    let mut value = [0u8; 8];
    value[..bytes.len()].copy_from_slice(bytes);
    Ok(u64::from_le_bytes(value))
}
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn reference() -> PathBuf {
    root().join("reference/contracts/managed/account/zkir")
}
fn fields(v: &AlignedValue) -> Vec<Fr> {
    ValueReprAlignedValue(v.clone()).field_vec()
}

#[derive(Serialize)]
struct Cost {
    circuit: String,
    side: String,
    k: u8,
    rows: usize,
    zkir_bytes: usize,
}

fn artifacts() -> Result<BTreeMap<String, (Circuit, Circuit)>> {
    let mut pairs = BTreeMap::new();
    let output = root().join("artifacts/minocrab");
    std::fs::create_dir_all(&output)?;
    for (name, build) in project_account_custody::circuits() {
        let native = build().ir;
        let ours = current_ir(&native)?;
        let theirs = IrSource::load(std::fs::File::open(
            reference().join(format!("{name}.zkir")),
        )?)?;
        let types = |ir: &IrSource, key: &str| -> Result<Vec<serde_json::Value>> {
            let value = serde_json::to_value(ir)?;
            Ok(value[key]
                .as_array()
                .context("missing schema")?
                .iter()
                .map(|v| v["type"].clone())
                .collect())
        };
        ensure!(
            types(&ours, "inputs")? == types(&theirs, "inputs")?,
            "{name}: input ABI mismatch"
        );
        ensure!(
            types(&ours, "outputs")? == types(&theirs, "outputs")?,
            "{name}: output ABI mismatch"
        );
        ensure!(
            ours.do_communications_commitment == theirs.do_communications_commitment,
            "{name}: communications commitment mismatch"
        );
        std::fs::write(
            output.join(format!("{name}.zkir")),
            to_zkir_string(&native)?,
        )?;
        ensure!(
            pairs
                .insert(
                    name.to_string(),
                    (
                        Circuit::new(
                            theirs,
                            std::fs::metadata(reference().join(format!("{name}.zkir")))?.len()
                                as usize
                        )?,
                        Circuit::new(ours, to_zkir_string(&native)?.len())?
                    )
                )
                .is_none(),
            "duplicate circuit {name}"
        );
    }
    let expected: BTreeSet<_> = std::fs::read_dir(reference())?
        .map(|e| e.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "zkir"))
        .map(|p| p.file_stem().unwrap().to_string_lossy().into_owned())
        .collect();
    ensure!(
        pairs.keys().cloned().collect::<BTreeSet<_>>() == expected,
        "circuit coverage mismatch"
    );
    Ok(pairs)
}

fn sha256(bytes: &[u8]) -> String {
    midnight_base_crypto::hash::persistent_hash(bytes)
        .0
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn compare(pairs: &BTreeMap<String, (Circuit, Circuit)>, mutations: bool) -> Result<()> {
    let evidence = root().join("evidence/equivalence.json");
    if evidence.exists() {
        std::fs::remove_file(&evidence)?;
    }
    let mut input_sha256 = BTreeMap::new();
    for name in pairs.keys() {
        for directory in [
            "reference/contracts/managed/account/zkir",
            "artifacts/minocrab",
        ] {
            let path = format!("{directory}/{name}.zkir");
            input_sha256.insert(path.clone(), sha256(&std::fs::read(root().join(&path))?));
        }
    }
    let filenames: Vec<String> =
        serde_json::from_slice(&std::fs::read(root().join("fixtures/private/index.json"))?)?;
    let files: Vec<_> = filenames
        .into_iter()
        .map(|name| root().join("fixtures/private").join(name))
        .collect();
    ensure!(!files.is_empty(), "no fixtures: run npm run fixtures first");
    let mut covered = BTreeSet::new();
    let mut cases = Vec::new();
    let mut mutation_count = 0;
    let mut context_checks = 0;
    for file in files {
        let f: Fixture = serde_json::from_slice(&std::fs::read(&file)?)?;
        let (theirs, ours) = pairs.get(&f.name).context("fixture circuit missing")?;
        if f.name.starts_with("activate_initial_device") {
            let State::Array(initial) = &f.before else {
                bail!("initial state is not an array")
            };
            let initial: Vec<_> = initial
                .iter()
                .flat_map(|s| match s {
                    State::Array(v) => v.iter().collect::<Vec<_>>(),
                    _ => vec![s],
                })
                .collect();
            let extract = |index: usize| -> Result<[u8; 32]> {
                let State::Cell(value) = &initial[index] else {
                    bail!("expected constructor cell")
                };
                let bytes = &value.value.0[0].0;
                ensure!(bytes.len() <= 32, "oversized constructor value");
                let mut out = [0u8; 32];
                out[..bytes.len()].copy_from_slice(bytes);
                Ok(out)
            };
            let State::Cell(pk) = initial[14] else {
                bail!("missing recovery key")
            };
            let State::Cell(wrap) = initial[18] else {
                bail!("missing recovery wrap")
            };
            let mut wrap_bytes = [0u8; 64];
            let raw = &wrap.value.0[0].0;
            wrap_bytes[..raw.len()].copy_from_slice(raw);
            let veto = u64::from_le_bytes(extract(24)?[..8].try_into()?);
            ensure!(
                project_account_custody::constructor::initial_state(
                    extract(10)?,
                    extract(1)?,
                    pk.clone(),
                    wrap_bytes,
                    veto
                ) == f.before.build(),
                "constructor state differs"
            );
        }
        let inputs = fields(&f.input);
        let witnesses: Vec<_> = f.witnesses.iter().flat_map(fields).collect();
        let mut ctx = exec::context(f.before.build(), f.address);
        ctx.call_context.tblock = midnight_base_crypto::time::Timestamp::from_secs(f.time);
        set_caller(&mut ctx, &f.caller)?;
        let call = Call::new(&inputs, &witnesses).with_comm_rand(Fr::from(42u64));
        let a = execute(theirs, &call, &ctx).with_context(|| format!("{} compactc", f.label))?;
        let b = execute(ours, &call, &ctx).with_context(|| format!("{} minocrab", f.label))?;
        ensure!(
            a.post == f.after.build(),
            "{}: reference VM != captured TS post-state",
            f.label
        );
        ensure!(a.post == b.post, "{}: different post-state", f.label);
        ensure!(
            a.effects == b.effects,
            "{}: different kernel effects",
            f.label
        );
        ensure!(
            a.run.outputs == b.run.outputs,
            "{}: different outputs",
            f.label
        );
        ensure!(
            a.run.outputs
                == fields(&f.output)
                    .into_iter()
                    .map(reference_zkir::ir_types::IrValue::Native)
                    .collect::<Vec<_>>(),
            "{}: reference output != captured output",
            f.label
        );
        theirs
            .check(&a.preimage)
            .with_context(|| format!("{} compactc proof check", f.label))?;
        ours.check(&b.preimage)
            .with_context(|| format!("{} minocrab proof check", f.label))?;
        if mutations {
            // Reuse the exact authorisation against the resulting state.
            let mut replay_ctx = exec::context(f.after.build(), f.address);
            replay_ctx.call_context.tblock = ctx.call_context.tblock;
            replay_ctx.call_context.caller = ctx.call_context.caller;
            let x = execute(theirs, &call, &replay_ctx);
            let y = execute(ours, &call, &replay_ctx);
            ensure!(
                x.is_ok() == y.is_ok(),
                "{}: replay acceptance differs",
                f.label
            );
            if f.name.contains("_with_") || f.name.starts_with("recover_") {
                ensure!(
                    x.is_err() && y.is_err(),
                    "{}: authorisation replay accepted",
                    f.label
                );
            }
            context_checks += 1;
            if (f.name.contains("_with_") && !f.name.starts_with("activate_"))
                || f.name == "recover_submit"
            {
                let mut address = f.address;
                address[0] ^= 1;
                let mut wrong_account = exec::context(f.before.build(), address);
                wrong_account.call_context.tblock = ctx.call_context.tblock;
                wrong_account.call_context.caller = ctx.call_context.caller;
                ensure!(
                    execute(theirs, &call, &wrong_account).is_err()
                        && execute(ours, &call, &wrong_account).is_err(),
                    "{}: wrong-account authorisation accepted",
                    f.label
                );
                context_checks += 1;
            }
            if let Some(expiry) = f.expires_at {
                for (time, should_accept) in [(expiry - 1, true), (expiry, false)] {
                    let mut at_expiry = exec::context(f.before.build(), f.address);
                    at_expiry.call_context.caller = ctx.call_context.caller;
                    at_expiry.call_context.tblock =
                        midnight_base_crypto::time::Timestamp::from_secs(time);
                    let x = execute(theirs, &call, &at_expiry);
                    let y = execute(ours, &call, &at_expiry);
                    ensure!(
                        x.is_ok() == should_accept && y.is_ok() == should_accept,
                        "{}: expiry boundary differs at {time}: reference={:?}, minocrab={:?}",
                        f.label,
                        x.as_ref().err(),
                        y.as_ref().err()
                    );
                    if let (Ok(x), Ok(y)) = (x, y) {
                        ensure!(
                            x.post == y.post
                                && x.effects == y.effects
                                && x.run.outputs == y.run.outputs,
                            "{}: expiry boundary outcomes differ",
                            f.label
                        );
                        theirs.check(&x.preimage)?;
                        ours.check(&y.preimage)?;
                    }
                    context_checks += 1;
                }
            }
            if f.name.contains("_with_grant_") {
                for caller in [
                    None,
                    Some(Caller {
                        tag: "user".into(),
                        address: "2d".repeat(32),
                    }),
                    Some(Caller {
                        tag: "contract".into(),
                        address: "2e".repeat(32),
                    }),
                ] {
                    let mut changed = ctx.clone();
                    set_caller(&mut changed, &caller)?;
                    let x = execute(theirs, &call, &changed);
                    let y = execute(ours, &call, &changed);
                    ensure!(
                        x.is_ok() == !f.restricted && y.is_ok() == !f.restricted,
                        "{}: caller restriction differs: reference={:?}, native={:?}",
                        f.label,
                        x.as_ref().err(),
                        y.as_ref().err()
                    );
                    if let (Ok(x), Ok(y)) = (x, y) {
                        ensure!(
                            x.post == y.post
                                && x.effects == y.effects
                                && x.run.outputs == y.run.outputs,
                            "caller outcomes differ"
                        );
                        theirs.check(&x.preimage)?;
                        ours.check(&y.preimage)?;
                    }
                    context_checks += 1;
                }
            }
            if f.name == "recover_submit" || f.name == "recover_finalise" {
                let deadline = if f.name == "recover_submit" {
                    atom_u64(&f.input.value.0[6].0)?
                } else {
                    let State::Array(groups) = &f.before else {
                        bail!("expected state array")
                    };
                    let State::Array(tail) = &groups[1] else {
                        bail!("expected ledger group")
                    };
                    let State::Cell(value) = &tail[13] else {
                        bail!("expected deadline")
                    };
                    atom_u64(&value.value.0[0].0)?
                };
                for time in [deadline - 1, deadline, deadline + 1] {
                    let mut changed = ctx.clone();
                    changed.call_context.tblock =
                        midnight_base_crypto::time::Timestamp::from_secs(time);
                    let expected = if f.name == "recover_submit" {
                        time <= deadline
                    } else {
                        time >= deadline
                    };
                    let x = execute(theirs, &call, &changed);
                    let y = execute(ours, &call, &changed);
                    ensure!(
                        x.is_ok() == expected && y.is_ok() == expected,
                        "{}: recovery time boundary at {time} differs: reference={:?}, native={:?}",
                        f.label,
                        x.as_ref().err(),
                        y.as_ref().err()
                    );
                    if let (Ok(x), Ok(y)) = (x, y) {
                        ensure!(
                            x.post == y.post
                                && x.effects == y.effects
                                && x.run.outputs == y.run.outputs,
                            "recovery boundary outcomes differ"
                        );
                        theirs.check(&x.preimage)?;
                        ours.check(&y.preimage)?;
                    }
                    context_checks += 1;
                }
            }
            for slot in 0..inputs.len() + witnesses.len() {
                let mut changed_inputs = inputs.clone();
                let mut changed_witnesses = witnesses.clone();
                if slot < inputs.len() {
                    changed_inputs[slot] = changed_inputs[slot] + Fr::from(1u64);
                } else {
                    changed_witnesses[slot - inputs.len()] =
                        changed_witnesses[slot - inputs.len()] + Fr::from(1u64);
                }
                let changed =
                    Call::new(&changed_inputs, &changed_witnesses).with_comm_rand(Fr::from(42u64));
                let x = execute(theirs, &changed, &ctx);
                let y = execute(ours, &changed, &ctx);
                ensure!(
                    x.is_ok() == y.is_ok(),
                    "{}: acceptance differs after changing input/witness slot {slot}: reference={:?}, minocrab={:?}",
                    f.label,
                    x.as_ref().err(),
                    y.as_ref().err()
                );
                if let (Ok(x), Ok(y)) = (x, y) {
                    ensure!(
                        x.post == y.post
                            && x.effects == y.effects
                            && x.run.outputs == y.run.outputs,
                        "{}: accepted mutation {slot} differs",
                        f.label
                    );
                    theirs.check(&x.preimage)?;
                    ours.check(&y.preimage)?;
                }
                mutation_count += 1;
            }
        }
        // Each side has its own valid transcript: the native port can reorder reads.
        // No fixture from the candidate is accepted as evidence for the reference.
        for (side, executed) in [("compactc", &a), ("minocrab", &b)] {
            let path = root().join(format!("artifacts/preimages/{side}"));
            std::fs::create_dir_all(&path)?;
            let mut bytes = Vec::new();
            midnight_serialize::tagged_serialize(&executed.preimage, &mut bytes)?;
            input_sha256.insert(
                format!("artifacts/preimages/{side}/{}.preimage", f.name),
                sha256(&bytes),
            );
            std::fs::write(path.join(format!("{}.preimage", f.name)), bytes)?;
        }
        covered.insert(f.name.clone());
        cases.push(serde_json::json!({"file": file.file_name().unwrap().to_string_lossy(), "circuit": f.name, "label": f.label, "post_state_equal": true, "effects_equal": true, "outputs_equal": true}));
        eprintln!("PASS {}", f.label);
    }
    ensure!(
        covered == pairs.keys().cloned().collect(),
        "not every circuit has execution evidence"
    );
    std::fs::create_dir_all(root().join("evidence"))?;
    std::fs::write(
        root().join("evidence/equivalence.json"),
        serde_json::to_vec_pretty(
            &serde_json::json!({"cases": cases, "input_and_witness_mutations": mutation_count, "context_checks": context_checks, "input_sha256": input_sha256, "binary_sha256": sha256(&std::fs::read(std::env::current_exe()?)?)}),
        )?,
    )?;
    Ok(())
}

#[derive(Serialize)]
struct Measurement {
    circuit: String,
    side: String,
    k: u8,
    rows: usize,
    keygen_s: f64,
    prove_s: Vec<f64>,
    verify_s: Vec<f64>,
    proof_bytes: usize,
    transaction_bytes: Option<usize>,
}

async fn measure(ir: &IrSource, name: &str, side: &str, iters: usize) -> Result<Measurement> {
    use midnight_base_crypto::data_provider::{FetchMode, MidnightDataProvider, OutputMode};
    ensure!(iters > 0, "iterations must be positive");
    let path = root().join(format!("artifacts/preimages/{side}/{name}.preimage"));
    let bytes = std::fs::read(&path).context("run compare before proving")?;
    let pi: ProofPreimage = midnight_serialize::tagged_deserialize(&bytes[..])?;
    ir.check(&pi)?;
    let params = MidnightDataProvider::new(FetchMode::OnDemand, OutputMode::Log, vec![])?;
    let model = ir.model();
    params.get_params(model.k()).await?;
    let t = Instant::now();
    let (pk, vk) = ir.keygen(&params).await?;
    let keygen_s = t.elapsed().as_secs_f64();
    let cache = std::env::var_os("MIDNIGHT_PP")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("XDG_CACHE_HOME").map(|p| PathBuf::from(p).join("midnight/zk-params"))
        })
        .or_else(|| {
            std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".cache/midnight/zk-params"))
        })
        .context("no parameter cache path")?;
    let verifier = ParamsVerifier::read(std::io::BufReader::new(std::fs::File::open(
        cache.join(format!("bls_midnight_2p{}", model.k())),
    )?))?;
    let mut prove_s = Vec::new();
    let mut verify_s = Vec::new();
    let mut proof_bytes = 0;
    // One untimed warm-up, then independently timed proofs and verification.
    for i in 0..=iters {
        let t = Instant::now();
        let (proof, pis, _) = ir
            .prove(rand::rngs::OsRng, &params, pk.clone(), &pi)
            .await?;
        let prove = t.elapsed().as_secs_f64();
        let t = Instant::now();
        vk.verify(&verifier, &proof, pis.iter().copied())?;
        let verify = t.elapsed().as_secs_f64();
        if i > 0 {
            prove_s.push(prove);
            verify_s.push(verify);
        }
        proof_bytes = proof.0.len();
    }
    Ok(Measurement {
        circuit: name.into(),
        side: side.into(),
        k: model.k(),
        rows: model.rows(),
        keygen_s,
        prove_s,
        verify_s,
        proof_bytes,
        transaction_bytes: None,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("localnet-execute") => return localnet::execute_request(),
        Some("localnet-constructor") => return localnet::constructor(),
        _ => (),
    }
    let pairs = artifacts()?;
    match args.first().map(String::as_str) {
        Some("localnet-package") => localnet::package(&pairs),
        Some("localnet-keys") => localnet::keys(&pairs).await,
        Some("compare") => compare(&pairs, args.iter().any(|a| a == "--mutations")),
        Some("costs") => {
            let mut rows = Vec::new();
            for (name, (theirs, ours)) in &pairs {
                for (side, ir) in [("compactc", theirs), ("minocrab", ours)] {
                    let m = ir.model();
                    rows.push(Cost {
                        circuit: name.clone(),
                        side: side.into(),
                        k: m.k(),
                        rows: m.rows(),
                        zkir_bytes: ir.zkir_bytes,
                    });
                }
            }
            println!("{}", serde_json::to_string_pretty(&rows)?);
            Ok(())
        }
        Some("measure") if args.len() >= 3 => {
            let (a, b) = pairs.get(&args[1]).context("unknown circuit")?;
            let ir = match args[2].as_str() {
                "compactc" => a,
                "minocrab" => b,
                _ => bail!("unknown side"),
            };
            let iters = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(3);
            let m = measure(ir, &args[1], &args[2], iters).await?;
            println!("{}", serde_json::to_string_pretty(&m)?);
            Ok(())
        }
        _ => bail!(
            "usage: project-custody-measure compare | costs | measure CIRCUIT compactc|minocrab [ITERATIONS] | localnet-keys | localnet-package | localnet-execute | localnet-constructor"
        ),
    }
}
