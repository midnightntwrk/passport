//! Independent Rust signer for the MIP-0013 account authorisation scheme.
//!
//! Demonstrates the AUTH-4 boundary and conformance test 7: a signer that
//! reproduces the challenge construction (MIP-0013 §5) with its own hash
//! and curve stack — the ledger's Rust crates, no TypeScript, WASM, npm,
//! node, indexer, prover, or contract runtime.
//!
//! Challenge preimage (§5.1), for a gated circuit:
//!
//!   persistentHash([DST_CIRCUIT, self, sig_r, pk, ...args, auth_nonce, grind_nonce])
//!
//! where DST_CIRCUIT = persistentHash of the tag
//! "midnight:account:auth:v1:<circuit>" zero-padded to 64 bytes (the hashed
//! arm of §5.1, as the reference contract implements it). persistentHash is
//! SHA-256 over the compiler's field-aligned binary encoding: this binary
//! reproduces that encoding with the ledger's own fab machinery
//! (`AlignedValue` → `binary_repr` → `PersistentHashWriter`), mirroring the
//! element encodings the compiled contract uses:
//!
//!   Bytes<n>        → one bytes(n) atom, trailing zeros stripped
//!   ContractAddress → Bytes<32>
//!   UserAddress     → Bytes<32>
//!   JubjubPoint     → two field atoms (x, y), minimal little-endian
//!   Uint<n>         → one bytes(n/8) atom, minimal little-endian
//!
//! Protocol: one JSON request on stdin, one JSON response on stdout.
//!
//!   {"cmd":"keygen"}
//!     → {"sk":"0x…","pk":{"x":"0x…","y":"0x…"}}
//!   {"cmd":"sign","circuit":"withdraw_unshielded","sk":"0x…",
//!    "contract_address":"…64 hex…","color":"…64 hex…","amount":"500",
//!    "recipient":"…64 hex…","auth_nonce":"3"}
//!     → {"pk":{…},"sig_r":{…},"sig_s":"0x…","grind_nonce":"17",
//!        "challenge":"…64 hex…","attempts":18}
//!
//! All bigint fields are 0x-prefixed big-endian hex; raw byte strings are
//! plain hex.

use std::io::Read;

use anyhow::{anyhow, bail, Context, Result};
use ff::Field;
use group::Group;
use midnight_base_crypto::fab::{
    AlignedValue, Alignment, AlignmentAtom, AlignmentSegment, Value, ValueAtom,
};
use midnight_base_crypto::hash::PersistentHashWriter;
use midnight_base_crypto::repr::BinaryHashRepr;
use midnight_curves::{Fr as JubjubScalar, JubjubSubgroup};
use midnight_transient_crypto::curve::EmbeddedGroupAffine;
use midnight_transient_crypto::fab::ValueReprAlignedValue;
use serde::Deserialize;
use serde_json::json;

/// JubJub prime-order subgroup order r_J, little-endian (MIP-0013 §2).
const JUBJUB_R_LE: [u8; 32] = [
    0xb7, 0x2c, 0xf7, 0xd6, 0x5e, 0x0e, 0x97, 0xd0, 0x82, 0x10, 0xc8, 0xcc, 0x93, 0x20, 0x68, 0xa6,
    0x00, 0x3b, 0x34, 0x01, 0x01, 0x3b, 0x67, 0x06, 0xa9, 0xaf, 0x33, 0x65, 0xea, 0xb4, 0x7d, 0x0e,
];

// ── Field-aligned encoding elements (mirror of the compact-runtime types) ───

struct Element {
    atoms: Vec<ValueAtom>,
    alignment: Vec<AlignmentSegment>,
}

fn strip_trailing_zeros(mut v: Vec<u8>) -> Vec<u8> {
    while v.last() == Some(&0) {
        v.pop();
    }
    v
}

/// Bytes<N>: one bytes(N) atom, trailing zeros stripped (CompactTypeBytes).
fn el_bytes(length: u32, data: &[u8]) -> Element {
    Element {
        atoms: vec![ValueAtom(strip_trailing_zeros(data.to_vec()))],
        alignment: vec![AlignmentSegment::Atom(AlignmentAtom::Bytes { length })],
    }
}

/// Uint<8·N>: one bytes(N) atom, minimal little-endian
/// (CompactTypeUnsignedInteger's toValue is the field encoding).
fn el_uint(byte_length: u32, value: u128) -> Element {
    Element {
        atoms: vec![ValueAtom(strip_trailing_zeros(
            value.to_le_bytes().to_vec(),
        ))],
        alignment: vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: byte_length,
        })],
    }
}

/// JubjubPoint: two field atoms (x, y), minimal little-endian
/// (CompactTypeJubjubPoint).
fn el_point(p: &EmbeddedGroupAffine) -> Result<Element> {
    let x = p.x().ok_or_else(|| anyhow!("point at infinity"))?;
    let y = p.y().ok_or_else(|| anyhow!("point at infinity"))?;
    Ok(Element {
        atoms: vec![
            ValueAtom(strip_trailing_zeros(x.as_le_bytes())),
            ValueAtom(strip_trailing_zeros(y.as_le_bytes())),
        ],
        alignment: vec![
            AlignmentSegment::Atom(AlignmentAtom::Field),
            AlignmentSegment::Atom(AlignmentAtom::Field),
        ],
    })
}

/// persistentHash over a tuple of elements: SHA-256 of the field-aligned
/// binary encoding — the exact code path of onchain-runtime's
/// `persistentHash(alignment, value)`.
fn persistent_hash(elements: &[Element]) -> Result<[u8; 32]> {
    let value = Value(elements.iter().flat_map(|e| e.atoms.clone()).collect());
    let alignment = Alignment(elements.iter().flat_map(|e| e.alignment.clone()).collect());
    let aligned =
        AlignedValue::new(value, alignment).ok_or_else(|| anyhow!("invalid alignment"))?;
    let mut hasher = PersistentHashWriter::default();
    ValueReprAlignedValue(aligned).binary_repr(&mut hasher);
    Ok(hasher.finalize().0)
}

/// DST_CIRCUIT: persistentHash of the tag zero-padded to 64 bytes.
fn circuit_dst(circuit: &str) -> Result<[u8; 32]> {
    let tag = format!("midnight:account:auth:v1:{circuit}");
    if tag.len() > 64 {
        bail!("circuit tag longer than 64 bytes: {tag}");
    }
    let mut padded = [0u8; 64];
    padded[..tag.len()].copy_from_slice(tag.as_bytes());
    persistent_hash(&[el_bytes(64, &padded)])
}

// ── Scalars and points ──────────────────────────────────────────────────────

fn hash_below_r(hash_le: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        match hash_le[i].cmp(&JUBJUB_R_LE[i]) {
            std::cmp::Ordering::Less => return true,
            std::cmp::Ordering::Greater => return false,
            std::cmp::Ordering::Equal => continue,
        }
    }
    false
}

fn scalar_from_hex(hex_be: &str) -> Result<JubjubScalar> {
    let clean = hex_be.trim_start_matches("0x");
    let bytes = hex::decode(format!("{:0>64}", clean)).context("bad scalar hex")?;
    let mut le: [u8; 32] = bytes.as_slice().try_into().context("scalar not 32 bytes")?;
    le.reverse();
    let scalar: Option<JubjubScalar> = JubjubScalar::from_bytes(&le).into();
    scalar.ok_or_else(|| anyhow!("scalar out of range"))
}

fn scalar_to_hex(s: &JubjubScalar) -> String {
    let mut b = s.to_bytes();
    b.reverse();
    format!("0x{}", hex::encode(b))
}

fn point_json(p: &EmbeddedGroupAffine) -> Result<serde_json::Value> {
    let x = p.x().ok_or_else(|| anyhow!("point at infinity"))?;
    let y = p.y().ok_or_else(|| anyhow!("point at infinity"))?;
    let to_hex = |f: midnight_transient_crypto::curve::Fr| {
        let mut b = f.as_le_bytes();
        b.reverse();
        format!("0x{}", hex::encode(b))
    };
    Ok(json!({ "x": to_hex(x), "y": to_hex(y) }))
}

fn bytes32_from_hex(s: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(s.trim_start_matches("0x")).context("bad hex")?;
    bytes.as_slice().try_into().context("expected 32 bytes")
}

// ── Requests ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
enum Request {
    Keygen,
    Sign(SignRequest),
}

#[derive(Deserialize)]
struct SignRequest {
    circuit: String,
    sk: String,
    contract_address: String,
    color: String,
    amount: String,
    recipient: String,
    auth_nonce: String,
}

fn main() -> Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input).context("invalid request JSON")?;

    let response = match request {
        Request::Keygen => {
            let sk = JubjubScalar::random(&mut rand::rngs::OsRng);
            let pk = EmbeddedGroupAffine(JubjubSubgroup::generator() * sk);
            json!({ "sk": scalar_to_hex(&sk), "pk": point_json(&pk)? })
        }
        Request::Sign(req) => sign(&req)?,
    };
    println!("{response}");
    Ok(())
}

fn sign(req: &SignRequest) -> Result<serde_json::Value> {
    if req.circuit != "withdraw_unshielded" {
        bail!("this reference signer implements the withdraw_unshielded challenge only");
    }
    let sk = scalar_from_hex(&req.sk)?;
    let pk = EmbeddedGroupAffine(JubjubSubgroup::generator() * sk);
    let contract_address = bytes32_from_hex(&req.contract_address)?;
    let color = bytes32_from_hex(&req.color)?;
    let recipient = bytes32_from_hex(&req.recipient)?;
    let amount: u128 = req.amount.parse().context("bad amount")?;
    let auth_nonce: u64 = req.auth_nonce.parse().context("bad auth_nonce")?;

    let dst = circuit_dst(&req.circuit)?;

    // §5.3: fresh nonce scalar, R = r·G, then grind the challenge (§5.2).
    let r = JubjubScalar::random(&mut rand::rngs::OsRng);
    let sig_r = EmbeddedGroupAffine(JubjubSubgroup::generator() * r);

    let mut grind_nonce: u64 = 0;
    let challenge_bytes = loop {
        let h = persistent_hash(&[
            el_bytes(32, &dst),
            el_bytes(32, &contract_address),
            el_point(&sig_r)?,
            el_point(&pk)?,
            el_bytes(32, &color),
            el_uint(16, amount),
            el_bytes(32, &recipient),
            el_uint(8, u128::from(auth_nonce)),
            el_uint(8, u128::from(grind_nonce)),
        ])?;
        if hash_below_r(&h) {
            break h;
        }
        grind_nonce += 1;
        anyhow::ensure!(grind_nonce < 10_000, "grinding did not converge");
    };

    let c: Option<JubjubScalar> = JubjubScalar::from_bytes(&challenge_bytes).into();
    let c = c.ok_or_else(|| anyhow!("ground challenge not a scalar"))?;
    let s = r + c * sk;

    // Local verification of the §4 equation before emitting.
    let lhs = JubjubSubgroup::generator() * s;
    let pk_sub: JubjubSubgroup = pk.0;
    let rhs = sig_r.0 + pk_sub * c;
    anyhow::ensure!(lhs == rhs, "self-verification failed");

    Ok(json!({
        "pk": point_json(&pk)?,
        "sig_r": point_json(&sig_r)?,
        "sig_s": scalar_to_hex(&s),
        "grind_nonce": grind_nonce.to_string(),
        "challenge": hex::encode(challenge_bytes),
        "attempts": grind_nonce + 1,
    }))
}
