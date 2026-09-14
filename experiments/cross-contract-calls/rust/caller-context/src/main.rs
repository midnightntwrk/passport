//! caller-context: run the ledger's own `ContractCall::context(...).caller`
//! derivation on serialised transaction bytes, off-node, and print the
//! per-call caller graph (who claims whom via `ClaimedContractCallsValue`).
//!
//! This tool executes the ledger's derivation code path exactly as written at
//! tag ledger-9.1.0.0-rc.3; it is NOT a substitute for a node observing a
//! slot-6 read inside a circuit.

use std::fs;
use std::ops::Deref;
use std::process::ExitCode;

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;


use coin_structure::coin::{PublicAddress, UserAddress};
use ledger::structure::{
    ContractAction, ContractCall, Intent, PedersenDowngradeable, ProofKind, ProofMarker,
    ProofPreimageMarker, Signature, SignatureKind, StandardTransaction, Transaction,
    UnshieldedOffer,
};
use onchain_runtime::context::BlockContext;
use onchain_runtime::state::ContractState;
use serialize::{Deserializable, Serializable, Tagged, tagged_deserialize};
use storage::Storable;
use storage::db::InMemoryDB;
use storage::storage::Map;
use transient_crypto::commitment::{Pedersen, PedersenRandomness, PureGeneratorPedersen};
use transient_crypto::curve::Fr;

type D = InMemoryDB;

// ── report shape ───────────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
struct ClaimReport {
    /// Which transcript of the claiming call carries the claim.
    transcript: &'static str,
    seq: u64,
    address: String,
    ep_hash: String,
    communication_commitment: String,
    /// Index (within this intent's actions) of the call this claim matches,
    /// if any call in the intent matches on (address, ep_hash, comm).
    matches_action_index: Option<usize>,
}

#[derive(Serialize, Debug, Clone)]
struct ClaimedByReport {
    action_index: usize,
    address: String,
    entry_point: String,
    /// true when the claim sits in the claimant's guaranteed transcript.
    guaranteed: bool,
    seq: u64,
}

#[derive(Serialize, Debug, Clone)]
struct CallReport {
    action_index: usize,
    address: String,
    entry_point: String,
    ep_hash: String,
    communication_commitment: String,
    has_guaranteed_transcript: bool,
    has_fallible_transcript: bool,
    /// Claims this call's transcripts emit (what it says it called).
    claims: Vec<ClaimReport>,
    /// Every other call in the intent whose claim matches this call.
    claimed_by: Vec<ClaimedByReport>,
    /// The action index the ledger's `find_map` actually selected as the
    /// caller. `find_map` scans `intent.actions` in order and takes the first
    /// match, so this is the first entry of `claimed_by` when anything claims
    /// this call, and `None` when nothing does.
    caller_selected_by_action_index: Option<usize>,
    /// `ContractCall::context(...).caller`, rendered.
    caller: String,
}

#[derive(Serialize, Debug, Clone)]
struct OfferReport {
    inputs: usize,
    distinct_owners: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
struct IntentReport {
    segment: u16,
    actions: usize,
    deploys: usize,
    maintenance_updates: usize,
    guaranteed_unshielded_offer: Option<OfferReport>,
    fallible_unshielded_offer: Option<OfferReport>,
    calls: Vec<CallReport>,
    /// Mechanical observations about this intent's claim graph, phrased
    /// against the checks in `ledger/src/verify.rs::effects_check`. These are
    /// observations of the bytes, not verdicts: this tool does not run
    /// `well_formed`, so an entry here is only a prediction of what that check
    /// would say, and a probe must still record the stage at which the
    /// transaction is actually refused.
    anomalies: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
struct Report {
    input_file: String,
    input_encoding: &'static str,
    input_bytes: usize,
    /// The tag header found in the bytes (`midnight:<tag>:`), as text.
    header_tag: Option<String>,
    /// The concrete `Transaction<S, P, B, D>` that deserialised.
    deserialised_as: String,
    /// Every candidate tried, in order, with its outcome.
    attempts: Vec<Attempt>,
    transaction_kind: &'static str,
    network_id: Option<String>,
    intents: Vec<IntentReport>,
}

#[derive(Serialize, Debug, Clone)]
struct Attempt {
    candidate: String,
    ok: bool,
    error: Option<String>,
}

// ── rendering helpers ──────────────────────────────────────────────────────

fn hex32(h: &base_crypto::hash::HashOutput) -> String {
    hex::encode(h.0)
}

fn fr_hex(fr: &Fr) -> String {
    // Little-endian canonical bytes, as `Fr::serialize` writes them.
    hex::encode(fr.as_le_bytes())
}

fn entry_point_name(ep: &onchain_runtime::state::EntryPointBuf) -> String {
    match std::str::from_utf8(&ep.0) {
        Ok(s) if !s.is_empty() && s.chars().all(|c| !c.is_control()) => s.to_string(),
        _ => format!("0x{}", hex::encode(&ep.0)),
    }
}

fn render_caller(c: &Option<PublicAddress>) -> String {
    match c {
        None => "None".to_string(),
        Some(PublicAddress::Contract(a)) => format!("Contract({})", hex32(&a.0)),
        Some(PublicAddress::User(UserAddress(h))) => format!("User({})", hex32(h)),
    }
}

// ── analysis ───────────────────────────────────────────────────────────────

fn offer_report<S: SignatureKind<D>>(offer: &UnshieldedOffer<S, D>) -> OfferReport {
    let mut owners: Vec<String> = offer
        .inputs
        .iter()
        .map(|i| hex32(&UserAddress::from(i.owner.clone()).0))
        .collect();
    let inputs = owners.len();
    owners.sort();
    owners.dedup();
    OfferReport {
        inputs,
        distinct_owners: owners,
    }
}

fn call_claims<P: ProofKind<D>>(call: &ContractCall<P, D>) -> Vec<(&'static str, u64, String, String, Fr, coin_structure::contract::ContractAddress, base_crypto::hash::HashOutput)> {
    let mut out = Vec::new();
    for (t, label) in call
        .guaranteed_transcript
        .iter()
        .map(|t| (t, "guaranteed"))
        .chain(call.fallible_transcript.iter().map(|t| (t, "fallible")))
    {
        for claim in t.deref().effects.claimed_contract_calls.iter() {
            let (seq, addr, ep, comm) = claim.deref().deref().into_inner();
            out.push((label, seq, hex32(&addr.0), hex32(&ep), comm, addr, ep));
        }
    }
    out
}

fn analyse_intent<S, P, B>(segment: u16, intent: &Intent<S, P, B, D>) -> IntentReport
where
    S: SignatureKind<D>,
    P: ProofKind<D>,
    B: Storable<D> + PedersenDowngradeable<D> + Serializable + Clone,
    UnshieldedOffer<S, D>: Clone,
{
    // The ledger derives the caller against the proof- and signature-erased
    // intent (Intent<(), (), Pedersen, D>); mirror that exactly.
    let erased: Intent<(), (), Pedersen, D> = intent.erase_proofs().erase_signatures();
    let block = BlockContext::default();

    let actions: Vec<&ContractAction<P, D>> = intent.actions.iter_deref().collect();
    let calls: Vec<(usize, &ContractCall<P, D>)> = actions
        .iter()
        .enumerate()
        .filter_map(|(i, a)| match a {
            ContractAction::Call(c) => Some((i, &**c)),
            _ => None,
        })
        .collect();
    let deploys = actions
        .iter()
        .filter(|a| matches!(a, ContractAction::Deploy(_)))
        .count();
    let maintenance_updates = actions
        .iter()
        .filter(|a| matches!(a, ContractAction::Maintain(_)))
        .count();

    let mut call_reports = Vec::new();
    for (i, call) in &calls {
        let claims = call_claims(call)
            .into_iter()
            .map(|(transcript, seq, address, ep_hash, comm, addr, ep)| ClaimReport {
                transcript,
                seq,
                address,
                ep_hash,
                communication_commitment: fr_hex(&comm),
                matches_action_index: calls
                    .iter()
                    .find(|(_, c)| {
                        c.address == addr
                            && c.entry_point.ep_hash() == ep
                            && c.communication_commitment == comm
                    })
                    .map(|(j, _)| *j),
            })
            .collect();

        // Action order, so the first entry is the one the ledger's `find_map`
        // over `intent.actions` selects. `calls` is built by enumerating the
        // actions in order, so this iteration is in action order too. Self is
        // deliberately not excluded: the ledger does not exclude it either.
        let claimed_by: Vec<ClaimedByReport> = calls
            .iter()
            .filter_map(|(j, other)| {
                other.calls_with_seq(call).map(|(guaranteed, seq)| ClaimedByReport {
                    action_index: *j,
                    address: hex32(&other.address.0),
                    entry_point: entry_point_name(&other.entry_point),
                    guaranteed,
                    seq,
                })
            })
            .collect();
        let caller_selected_by_action_index = claimed_by.first().map(|c| c.action_index);

        let ctx = (*call).clone().context(
            &block,
            &erased,
            ContractState::<D>::default(),
            &Map::new(),
        );

        call_reports.push(CallReport {
            action_index: *i,
            address: hex32(&call.address.0),
            entry_point: entry_point_name(&call.entry_point),
            ep_hash: hex32(&call.entry_point.ep_hash()),
            communication_commitment: fr_hex(&call.communication_commitment),
            has_guaranteed_transcript: call.guaranteed_transcript.is_some(),
            has_fallible_transcript: call.fallible_transcript.is_some(),
            claims,
            claimed_by,
            caller_selected_by_action_index,
            caller: render_caller(&ctx.caller),
        });
    }

    let anomalies = claim_anomalies(&call_reports);

    IntentReport {
        segment,
        actions: actions.len(),
        deploys,
        maintenance_updates,
        guaranteed_unshielded_offer: intent
            .guaranteed_unshielded_offer
            .as_ref()
            .map(|o| offer_report(o.deref())),
        fallible_unshielded_offer: intent
            .fallible_unshielded_offer
            .as_ref()
            .map(|o| offer_report(o.deref())),
        calls: call_reports,
        anomalies,
    }
}

/// Mechanical observations about a claim graph, in the vocabulary of
/// `effects_check` (ledger/src/verify.rs:1431). Observations only: this tool
/// does not run `well_formed`.
fn claim_anomalies(calls: &[CallReport]) -> Vec<String> {
    let mut out = Vec::new();
    for c in calls {
        if c.claimed_by.len() > 1 {
            let who: Vec<String> = c
                .claimed_by
                .iter()
                .map(|b| format!("#{}", b.action_index))
                .collect();
            out.push(format!(
                "call #{} is claimed by {} calls ({}); effects_check enforces claim uniqueness per segment (verify.rs:1610-1631), and the caller derivation takes the first in action order, #{}",
                c.action_index,
                c.claimed_by.len(),
                who.join(", "),
                c.claimed_by[0].action_index
            ));
        }
        if c.claimed_by.iter().any(|b| b.action_index == c.action_index) {
            out.push(format!(
                "call #{} claims itself (its own transcript emits a claim matching its own (address, ep_hash, comm))",
                c.action_index
            ));
        }
        for (i, cl) in c.claims.iter().enumerate() {
            if cl.matches_action_index.is_none() {
                out.push(format!(
                    "call #{} claim [{}] ({} transcript, seq {}) matches no call in this intent; effects_check requires every claim to match a real call in the segment (verify.rs:1633-1653)",
                    c.action_index, i, cl.transcript, cl.seq
                ));
            }
        }
    }
    out
}

fn analyse_tx<S, P, B>(tx: &Transaction<S, P, B, D>) -> (&'static str, Option<String>, Vec<IntentReport>)
where
    S: SignatureKind<D>,
    P: ProofKind<D>,
    B: Storable<D> + PedersenDowngradeable<D> + Serializable + Clone,
    UnshieldedOffer<S, D>: Clone,
{
    match tx {
        Transaction::Standard(stx) => {
            let StandardTransaction {
                network_id, intents, ..
            } = stx;
            let mut reports: Vec<IntentReport> = intents
                .iter()
                .map(|sp| {
                    let segment: u16 = *sp.deref().0.deref();
                    let intent = sp.deref().1.deref();
                    analyse_intent(segment, intent)
                })
                .collect();
            reports.sort_by_key(|r| r.segment);
            ("standard", Some(network_id.clone()), reports)
        }
        Transaction::ClaimRewards(_) => ("claim-rewards", None, Vec::new()),
    }
}

// ── deserialisation candidates ─────────────────────────────────────────────

fn try_candidate<T>(bytes: &[u8]) -> std::io::Result<T>
where
    T: Deserializable + Tagged,
{
    tagged_deserialize::<T>(&mut &bytes[..])
}

macro_rules! candidate {
    ($bytes:expr, $attempts:expr, $name:literal, $ty:ty) => {{
        let candidate_name = format!("{} = {}", $name, <$ty as Tagged>::tag());
        match try_candidate::<$ty>($bytes) {
            Ok(tx) => {
                $attempts.push(Attempt {
                    candidate: candidate_name.clone(),
                    ok: true,
                    error: None,
                });
                let (kind, network_id, intents) = analyse_tx(&tx);
                Some((candidate_name, kind, network_id, intents))
            }
            Err(e) => {
                $attempts.push(Attempt {
                    candidate: candidate_name,
                    ok: false,
                    error: Some(e.to_string()),
                });
                None
            }
        }
    }};
}

fn deserialise_any(
    bytes: &[u8],
    attempts: &mut Vec<Attempt>,
) -> Option<(String, &'static str, Option<String>, Vec<IntentReport>)> {
    // Order mirrors what the TypeScript binding produces most often:
    //   1. the unproven transaction midnight-js hands to proveTx
    //      (Transaction<SignatureEnabled, PreProof, PreBinding>);
    //   2. the proven but unbound transaction proveTx returns;
    //   3. the finalized (bound) transaction the wallet submits;
    // then the remaining wasm-binding variants, then the erased forms.
    let r = candidate!(bytes, attempts, "Transaction<Signature, ProofPreimageMarker, PedersenRandomness, InMemoryDB>",
        Transaction<Signature, ProofPreimageMarker, PedersenRandomness, D>);
    if r.is_some() { return r; }
    let r = candidate!(bytes, attempts, "Transaction<Signature, ProofMarker, PedersenRandomness, InMemoryDB>",
        Transaction<Signature, ProofMarker, PedersenRandomness, D>);
    if r.is_some() { return r; }
    let r = candidate!(bytes, attempts, "Transaction<Signature, ProofMarker, PureGeneratorPedersen, InMemoryDB>",
        Transaction<Signature, ProofMarker, PureGeneratorPedersen, D>);
    if r.is_some() { return r; }
    let r = candidate!(bytes, attempts, "Transaction<Signature, ProofPreimageMarker, PureGeneratorPedersen, InMemoryDB>",
        Transaction<Signature, ProofPreimageMarker, PureGeneratorPedersen, D>);
    if r.is_some() { return r; }
    let r = candidate!(bytes, attempts, "Transaction<(), ProofPreimageMarker, PedersenRandomness, InMemoryDB>",
        Transaction<(), ProofPreimageMarker, PedersenRandomness, D>);
    if r.is_some() { return r; }
    let r = candidate!(bytes, attempts, "Transaction<(), ProofMarker, PedersenRandomness, InMemoryDB>",
        Transaction<(), ProofMarker, PedersenRandomness, D>);
    if r.is_some() { return r; }
    let r = candidate!(bytes, attempts, "Transaction<(), ProofMarker, PureGeneratorPedersen, InMemoryDB>",
        Transaction<(), ProofMarker, PureGeneratorPedersen, D>);
    if r.is_some() { return r; }
    let r = candidate!(bytes, attempts, "Transaction<(), ProofPreimageMarker, PureGeneratorPedersen, InMemoryDB>",
        Transaction<(), ProofPreimageMarker, PureGeneratorPedersen, D>);
    if r.is_some() { return r; }
    let r = candidate!(bytes, attempts, "Transaction<Signature, (), Pedersen, InMemoryDB>",
        Transaction<Signature, (), Pedersen, D>);
    if r.is_some() { return r; }
    candidate!(bytes, attempts, "Transaction<(), (), Pedersen, InMemoryDB>",
        Transaction<(), (), Pedersen, D>)
}

// ── input handling ─────────────────────────────────────────────────────────

fn load_input(path: &str) -> Result<(Vec<u8>, &'static str)> {
    let raw = fs::read(path).with_context(|| format!("reading {path}"))?;
    // Hex text: every non-whitespace byte is a hex digit (optional 0x prefix).
    if let Ok(text) = std::str::from_utf8(&raw) {
        let compact: String = text.split_whitespace().collect();
        let compact = compact.strip_prefix("0x").unwrap_or(&compact);
        if !compact.is_empty() && compact.len() % 2 == 0 && compact.chars().all(|c| c.is_ascii_hexdigit()) {
            if let Ok(bytes) = hex::decode(compact) {
                return Ok((bytes, "hex-text"));
            }
        }
    }
    Ok((raw, "raw-bytes"))
}

/// The `midnight:<tag>:` header as text, if the bytes start with one.
fn peek_header(bytes: &[u8]) -> Option<String> {
    const GLOBAL: &[u8] = b"midnight:";
    if !bytes.starts_with(GLOBAL) {
        return None;
    }
    let rest = &bytes[GLOBAL.len()..];
    // The tag ends at the first ':' that is not inside the type-argument
    // parentheses (tags may nest parentheses; colons do not appear inside).
    let end = rest.iter().position(|&b| b == b':')?;
    let tag = std::str::from_utf8(&rest[..end]).ok()?;
    if tag.len() > 4096 || tag.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(tag.to_string())
}

// ── text output ────────────────────────────────────────────────────────────

fn print_text(r: &Report) {
    println!("caller-context: ledger-9.1.0.0-rc.3 ContractCall::context(...).caller, off-node");
    println!("input: {} ({}, {} bytes)", r.input_file, r.input_encoding, r.input_bytes);
    println!("header tag: {}", r.header_tag.as_deref().unwrap_or("<none>"));
    println!("deserialised as: {}", r.deserialised_as);
    for a in &r.attempts {
        println!("  {} {}{}", if a.ok { "ok  " } else { "fail" }, a.candidate,
            a.error.as_ref().map(|e| format!(" :: {e}")).unwrap_or_default());
    }
    println!("transaction kind: {}{}", r.transaction_kind,
        r.network_id.as_ref().map(|n| format!(" (network {n})")).unwrap_or_default());
    for it in &r.intents {
        println!();
        println!("intent segment {} — {} action(s): {} call(s), {} deploy(s), {} maintenance update(s)",
            it.segment, it.actions, it.calls.len(), it.deploys, it.maintenance_updates);
        for (label, o) in [("guaranteed", &it.guaranteed_unshielded_offer), ("fallible", &it.fallible_unshielded_offer)] {
            match o {
                None => println!("  {label} unshielded offer: none"),
                Some(o) => println!("  {label} unshielded offer: {} input(s), distinct owners {:?}", o.inputs, o.distinct_owners),
            }
        }
        for c in &it.calls {
            println!();
            println!("  call #{} {}::{}", c.action_index, c.address, c.entry_point);
            println!("    ep_hash                  {}", c.ep_hash);
            println!("    communication_commitment {}", c.communication_commitment);
            println!("    transcripts              guaranteed={} fallible={}", c.has_guaranteed_transcript, c.has_fallible_transcript);
            if c.claims.is_empty() {
                println!("    claims (emits)           none");
            } else {
                println!("    claims (emits)");
                for cl in &c.claims {
                    println!("      [{}] seq={} addr={} ep_hash={} comm={} -> matches call #{}",
                        cl.transcript, cl.seq, cl.address, cl.ep_hash, cl.communication_commitment,
                        cl.matches_action_index.map(|i| i.to_string()).unwrap_or_else(|| "none".into()));
                }
            }
            if c.claimed_by.is_empty() {
                println!("    claimed by               none");
            } else {
                for cb in &c.claimed_by {
                    println!("    claimed by               call #{} {}::{} ({} transcript, seq {})",
                        cb.action_index, cb.address, cb.entry_point,
                        if cb.guaranteed { "guaranteed" } else { "fallible" }, cb.seq);
                }
            }
            println!("    context().caller         {}{}", c.caller,
                c.caller_selected_by_action_index
                    .map(|i| format!(" (selected by call #{i})"))
                    .unwrap_or_default());
        }
        if !it.anomalies.is_empty() {
            println!();
            println!("  claim-graph observations (not verdicts; well_formed is not run here)");
            for a in &it.anomalies {
                println!("    - {a}");
            }
        }
    }
}

// ── main ───────────────────────────────────────────────────────────────────

fn run() -> Result<Report> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .ok_or_else(|| anyhow!("usage: caller-context <path> [--json]"))?
        .clone();

    let (bytes, encoding) = load_input(&path)?;
    let header_tag = peek_header(&bytes);
    let mut attempts = Vec::new();
    let Some((deserialised_as, kind, network_id, intents)) = deserialise_any(&bytes, &mut attempts) else {
        let mut msg = format!(
            "no candidate Transaction<S, P, B, InMemoryDB> deserialised {} bytes (header tag: {})",
            bytes.len(),
            header_tag.as_deref().unwrap_or("<none>")
        );
        for a in &attempts {
            msg.push_str(&format!("\n  {} :: {}", a.candidate, a.error.as_deref().unwrap_or("")));
        }
        bail!(msg);
    };
    Ok(Report {
        input_file: path,
        input_encoding: encoding,
        input_bytes: bytes.len(),
        header_tag,
        deserialised_as,
        attempts,
        transaction_kind: kind,
        network_id,
        intents,
    })
}

fn main() -> ExitCode {
    let json = std::env::args().any(|a| a == "--json");
    match run() {
        Ok(report) => {
            if json {
                println!("{}", serde_json::to_string_pretty(&report).expect("report serialises"));
            } else {
                print_text(&report);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            if json {
                println!("{}", serde_json::json!({ "error": e.to_string() }));
            } else {
                eprintln!("error: {e}");
            }
            ExitCode::FAILURE
        }
    }
}

// ── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(matches: Option<usize>) -> ClaimReport {
        ClaimReport {
            transcript: "guaranteed",
            seq: 0,
            address: "aa".into(),
            ep_hash: "bb".into(),
            communication_commitment: "cc".into(),
            matches_action_index: matches,
        }
    }

    fn claimant(action_index: usize) -> ClaimedByReport {
        ClaimedByReport {
            action_index,
            address: "aa".into(),
            entry_point: "ep".into(),
            guaranteed: true,
            seq: 0,
        }
    }

    fn call(action_index: usize, claims: Vec<ClaimReport>, claimed_by: Vec<ClaimedByReport>) -> CallReport {
        let caller_selected_by_action_index = claimed_by.first().map(|c| c.action_index);
        CallReport {
            action_index,
            address: "aa".into(),
            entry_point: "ep".into(),
            ep_hash: "bb".into(),
            communication_commitment: "cc".into(),
            has_guaranteed_transcript: true,
            has_fallible_transcript: false,
            claims,
            claimed_by,
            caller_selected_by_action_index,
            caller: "None".into(),
        }
    }

    /// The shape P8 observes: one root call claiming two sub-calls, every
    /// claim matched, nothing claimed twice. No anomalies.
    #[test]
    fn well_formed_forest_has_no_anomalies() {
        let calls = vec![
            call(0, vec![claim(Some(1)), claim(Some(2))], vec![]),
            call(1, vec![], vec![claimant(0)]),
            call(2, vec![], vec![claimant(0)]),
        ];
        assert!(claim_anomalies(&calls).is_empty());
    }

    /// P9's two-claimant control: a call that is both a genuine sub-call of
    /// one contract and claimed by another. The uniqueness observation must
    /// fire and must name the action-order winner.
    #[test]
    fn two_claimants_on_one_call_is_flagged() {
        let calls = vec![
            call(0, vec![claim(Some(2))], vec![]),
            call(1, vec![claim(Some(2))], vec![]),
            call(2, vec![], vec![claimant(0), claimant(1)]),
        ];
        let a = claim_anomalies(&calls);
        assert_eq!(a.len(), 1, "expected exactly one anomaly, got {a:?}");
        assert!(a[0].contains("claimed by 2 calls"), "{}", a[0]);
        assert!(a[0].contains("#0, #1"), "{}", a[0]);
        assert!(a[0].contains("first in action order, #0"), "{}", a[0]);
        // The ledger's find_map takes the first match in action order.
        assert_eq!(calls[2].caller_selected_by_action_index, Some(0));
    }

    /// P9's wrong-comm control: a claim matching no call in the intent.
    #[test]
    fn unmatched_claim_is_flagged() {
        let calls = vec![call(0, vec![claim(None)], vec![])];
        let a = claim_anomalies(&calls);
        assert_eq!(a.len(), 1, "{a:?}");
        assert!(a[0].contains("matches no call in this intent"), "{}", a[0]);
    }

    /// The ledger does not exclude self from the caller search, so a
    /// self-claim is representable and must be reported rather than hidden.
    #[test]
    fn self_claim_is_flagged() {
        let calls = vec![call(0, vec![claim(Some(0))], vec![claimant(0)])];
        let a = claim_anomalies(&calls);
        assert_eq!(a.len(), 1, "{a:?}");
        assert!(a[0].contains("claims itself"), "{}", a[0]);
    }
}
