//! Bridge the independent Rust circuit executor to the localnet SDK harness.
use super::*;
use midnight_base_crypto::{hash::HashOutput, time::Timestamp};
use midnight_coin_structure::coin::{
    Commitment, ShieldedTokenType, TokenType, UnshieldedTokenType,
};

#[derive(Deserialize)]
struct Request {
    name: String,
    address: [u8; 32],
    before: State,
    after: State,
    input: AlignedValue,
    output: AlignedValue,
    witnesses: Vec<AlignedValue>,
    time: u64,
    time_error: u32,
    last_block_time: u64,
    parent_block_hash: String,
    caller: Option<Caller>,
    commitments: Vec<(String, u64)>,
    balances: Vec<(Token, String)>,
}
#[derive(Deserialize)]
struct Token {
    tag: String,
    raw: Option<String>,
}
fn hash(s: &str) -> Result<HashOutput> {
    ensure!(s.len() == 64 && s.is_ascii(), "invalid hash encoding");
    let mut bytes = [0; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)?;
    }
    Ok(HashOutput(bytes))
}
pub fn execute_request() -> Result<()> {
    let req: Request = serde_json::from_reader(std::io::stdin())?;
    ensure!(
        project_account_custody::circuits()
            .iter()
            .any(|(name, _)| *name == req.name),
        "unknown circuit"
    );
    let reference = Circuit::new(
        IrSource::load(std::fs::File::open(
            reference().join(format!("{}.zkir", req.name)),
        )?)?,
        0,
    )?;
    let bytes = std::fs::read(root().join(format!("artifacts/localnet/zkir/{}.bzkir", req.name)))?;
    let native = Circuit::new(
        midnight_serialize::tagged_deserialize(&bytes[..])?,
        bytes.len(),
    )?;
    let mut ctx = exec::context(req.before.build(), req.address);
    ctx.call_context.tblock = Timestamp::from_secs(req.time);
    ctx.call_context.tblock_err = req.time_error;
    ctx.call_context.last_block_time = Timestamp::from_secs(req.last_block_time);
    ctx.call_context.parent_block_hash = hash(&req.parent_block_hash)?;
    set_caller(&mut ctx, &req.caller)?;
    for (key, value) in req.commitments {
        ctx.call_context.com_indices = ctx
            .call_context
            .com_indices
            .insert(Commitment(hash(&key)?), value);
    }
    for (token, amount) in req.balances {
        let t = match token.tag.as_str() {
            "unshielded" => TokenType::Unshielded(UnshieldedTokenType(hash(
                token.raw.as_deref().context("missing raw token")?,
            )?)),
            "shielded" => TokenType::Shielded(ShieldedTokenType(hash(
                token.raw.as_deref().context("missing raw token")?,
            )?)),
            "dust" => TokenType::Dust,
            _ => bail!("unknown token type"),
        };
        ctx.call_context.balance = ctx.call_context.balance.insert(t, amount.parse()?);
    }
    let inputs = fields(&req.input);
    let witnesses = req.witnesses.iter().flat_map(fields).collect::<Vec<_>>();
    let call = Call::new(&inputs, &witnesses).with_comm_rand(Fr::from(42u64));
    let a = execute(&reference, &call, &ctx)?;
    let b = execute(&native, &call, &ctx)?;
    reference.check(&a.preimage)?;
    native.check(&b.preimage)?;
    ensure!(
        b.post == req.after.build() && a.post == b.post,
        "localnet state parity failed"
    );
    ensure!(a.effects == b.effects, "localnet effects parity failed");
    ensure!(
        a.run.outputs == b.run.outputs,
        "localnet return parity failed"
    );
    ensure!(
        b.run.outputs
            == fields(&req.output)
                .into_iter()
                .map(reference_zkir::ir_types::IrValue::Native)
                .collect::<Vec<_>>(),
        "SDK return parity failed"
    );
    println!("{}", serde_json::to_string(&b.ops)?);
    Ok(())
}

pub async fn keys(pairs: &BTreeMap<String, (Circuit, Circuit)>) -> Result<()> {
    use midnight_base_crypto::data_provider::{FetchMode, MidnightDataProvider, OutputMode};
    let params = MidnightDataProvider::new(FetchMode::OnDemand, OutputMode::Log, vec![])?;
    let dir = root().join("artifacts/localnet/keys");
    std::fs::create_dir_all(&dir)?;
    for (name, (_, ir)) in pairs {
        let (pk, vk) = ir.keygen(&params).await?;
        midnight_serialize::tagged_serialize(
            &pk,
            &mut std::fs::File::create(dir.join(format!("{name}.prover")))?,
        )?;
        midnight_serialize::tagged_serialize(
            &vk,
            &mut std::fs::File::create(dir.join(format!("{name}.verifier")))?,
        )?;
        eprintln!("generated {name} (k={})", ir.model().k());
    }
    package(pairs)
}

pub fn constructor() -> Result<()> {
    let state: State = serde_json::from_reader(std::io::stdin())?;
    let State::Array(groups) = &state else {
        bail!("constructor groups")
    };
    let mut cells = Vec::new();
    for group in groups {
        let State::Array(items) = group else {
            bail!("constructor group")
        };
        cells.extend(items);
    }
    ensure!(cells.len() == 25, "constructor schema");
    let aligned = |i: usize| -> Result<AlignedValue> {
        let State::Cell(v) = cells[i] else {
            bail!("constructor cell")
        };
        Ok(v.clone())
    };
    let bytes = |i: usize, n: usize| -> Result<Vec<u8>> {
        let v = aligned(i)?;
        let mut b = v.value.0[0].0.clone();
        ensure!(b.len() <= n, "constructor width");
        b.resize(n, 0);
        Ok(b)
    };
    let native = project_account_custody::constructor::initial_state(
        bytes(10, 32)?.try_into().unwrap(),
        bytes(1, 32)?.try_into().unwrap(),
        aligned(14)?,
        bytes(18, 64)?.try_into().unwrap(),
        u64::from_le_bytes(bytes(24, 8)?.try_into().unwrap()),
    );
    ensure!(native == state.build(), "constructor parity");
    println!("{}", serde_json::to_string(&native)?);
    Ok(())
}

pub fn package(pairs: &BTreeMap<String, (Circuit, Circuit)>) -> Result<()> {
    let dir = root().join("artifacts/localnet/zkir");
    std::fs::create_dir_all(&dir)?;
    for (name, (_, ir)) in pairs {
        midnight_serialize::tagged_serialize(
            &ir.proof,
            &mut std::fs::File::create(dir.join(format!("{name}.bzkir")))?,
        )?;
    }
    Ok(())
}
