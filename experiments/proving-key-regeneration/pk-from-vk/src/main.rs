//! Build a prover key from a ZKIR and a verifier key, with no SRS.
//!
//! Upstream key generation is `vk = setup_vk(srs, ir); pk = setup_pk(ir, &vk)`
//! (zkir-v3 `IrSource::keygen`). This binary runs only the second step,
//! taking the verifier key from a file: either compactc's tagged
//! `keys/<circuit>.verifier`, or the bytes a deployed contract holds on chain
//! in `ContractOperation.verifierKey` (the probe in
//! `contract/src/tests/probe-onchain-vk.ts` shows the two are identical). It
//! writes the prover key in the same tagged format as `keys/<circuit>.prover`
//! so the two can be compared byte for byte.
//!
//! Controls:
//!   --srs <params>        also run setup_vk from this SRS file and report
//!                         whether the fresh verifier key equals the input
//!                         and whether the prover key it yields equals ours
//!   --roundtrip <prover>  read this compactc prover key, re-encode it, and
//!                         compare the re-encoded raw key with ours (tells a
//!                         serialisation difference from a key difference)
//!
//!   pk-from-vk <circuit.zkir|.bzkir> <verifier-key> <out.prover>
//!              [--srs <params>] [--roundtrip <prover>]
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::time::Instant;

use anyhow::{Context, Result, anyhow};
use midnight_proofs::utils::SerdeFormat;
use midnight_serialize::{tagged_deserialize, tagged_serialize};
use midnight_transient_crypto::proofs::{ParamsProver, ProverKey, VerifierKey, Zkir};
use midnight_zk_stdlib::{MidnightVK, setup_pk, setup_vk};
use midnight_zkir_v3::IrSource;
use sha2::{Digest, Sha256};

fn sha16(b: &[u8]) -> String {
    Sha256::digest(b).iter().take(8).map(|x| format!("{x:02x}")).collect()
}

fn read_all(path: &str) -> Result<Vec<u8>> {
    let mut v = Vec::new();
    File::open(path).with_context(|| path.to_string())?.read_to_end(&mut v)?;
    Ok(v)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        return Err(anyhow!(
            "usage: pk-from-vk <circuit.zkir|.bzkir> <verifier-key> <out.prover> [--srs <params>] [--roundtrip <prover>]"
        ));
    }

    // 1. The relation: the ZKIR, from compactc's JSON or binary form.
    let ir = if args[1].ends_with(".bzkir") {
        IrSource::load_ir_from_tagged(BufReader::new(File::open(&args[1])?))
    } else {
        IrSource::load(File::open(&args[1])?)
    }
    .context("loading ZKIR")?;

    // 2. The verifier key, in the tagged form both compactc and the chain use.
    let vk_bytes = read_all(&args[2])?;
    let vk: VerifierKey = tagged_deserialize(&mut &vk_bytes[..]).context("tagged verifier key")?;
    let inner = vk.original_bytes();
    let mut slice: &[u8] = &inner;
    let vk = MidnightVK::read(&mut slice, SerdeFormat::Processed)
        .map_err(|e| anyhow!("MidnightVK::read: {e}"))?;
    if !slice.is_empty() {
        return Err(anyhow!("trailing bytes after verifier key"));
    }
    println!("ir k={}  vk k={}  vk bytes={} (inner {})", ir.k(), vk.k(), vk_bytes.len(), inner.len());

    // 3. setup_pk(relation, vk): no SRS.
    let t0 = Instant::now();
    let pk = setup_pk(&ir, &vk);
    let dt = t0.elapsed();
    let mut raw_ours = Vec::new();
    IrSource::write_raw_pk(&mut raw_ours, &pk)?;

    // 4. Serialise exactly as the toolchain does (tagged ProverKey).
    let tagged: ProverKey<IrSource> = ProverKey::from_raw(pk);
    let mut out = Vec::new();
    tagged_serialize(&tagged, &mut out)?;
    File::create(&args[3])?.write_all(&out)?;
    println!("setup_pk(ir, vk): {:.2} s", dt.as_secs_f64());
    println!("ours:      tagged {} bytes sha {}   raw sha {}", out.len(), sha16(&out), sha16(&raw_ours));

    // Control A: the full path, setup_vk from the SRS then setup_pk.
    if let Some(params_path) = flag(&args, "--srs") {
        let params = ParamsProver::read(&mut BufReader::new(File::open(&params_path)?))
            .map_err(|e| anyhow!("ParamsProver::read: {e}"))?;
        let t0 = Instant::now();
        let fresh_vk = setup_vk(params.as_ref(), &ir);
        let dt_vk = t0.elapsed();
        let mut fresh_inner = Vec::new();
        fresh_vk.write(&mut fresh_inner, SerdeFormat::Processed)?;
        let t0 = Instant::now();
        let fresh_pk = setup_pk(&ir, &fresh_vk);
        let dt_pk = t0.elapsed();
        let mut raw_fresh = Vec::new();
        IrSource::write_raw_pk(&mut raw_fresh, &fresh_pk)?;
        let tagged: ProverKey<IrSource> = ProverKey::from_raw(fresh_pk);
        let mut out_fresh = Vec::new();
        tagged_serialize(&tagged, &mut out_fresh)?;
        println!(
            "control --srs: setup_vk {:.2} s, setup_pk {:.2} s; fresh vk == input vk: {}; fresh pk tagged sha {} (== ours: {}), raw sha {} (== ours: {})",
            dt_vk.as_secs_f64(),
            dt_pk.as_secs_f64(),
            fresh_inner == inner,
            sha16(&out_fresh),
            out_fresh == out,
            sha16(&raw_fresh),
            raw_fresh == raw_ours
        );
    }

    // Control B: re-encode the compactc prover key after reading it.
    if let Some(pk_path) = flag(&args, "--roundtrip") {
        let file = read_all(&pk_path)?;
        let theirs: ProverKey<IrSource> =
            tagged_deserialize(&mut &file[..]).context("tagged compactc prover key")?;
        let t0 = Instant::now();
        let init = theirs.init().map_err(|e| anyhow!("init: {e}"))?;
        let dt = t0.elapsed();
        let mut raw_rt = Vec::new();
        IrSource::write_raw_pk(&mut raw_rt, &init)?;
        let diff_tagged = file.iter().zip(out.iter()).filter(|(a, b)| a != b).count()
            + file.len().abs_diff(out.len());
        println!(
            "control --roundtrip: compactc file {} bytes sha {} (differs from ours in {} bytes); read {:.2} s; re-encoded raw sha {} (== ours raw: {})",
            file.len(),
            sha16(&file),
            diff_tagged,
            dt.as_secs_f64(),
            sha16(&raw_rt),
            raw_rt == raw_ours
        );
    }
    Ok(())
}
