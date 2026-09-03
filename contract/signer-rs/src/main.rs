//! Independent Rust signer for the account authorisation seam, both arms.
//!
//! Demonstrates the AUTH-4 boundary and conformance test 7 against the two
//! co-resident arms of account.compact: a signer that reproduces each arm's
//! challenge construction with its own hash and curve stack — the ledger's
//! Rust crates for the encoding; midnight-curves for JubJub, the k256 crate
//! for secp256k1 — and no TypeScript, WASM, npm, node, indexer, prover, or
//! contract runtime.
//!
//! Arm jubjub (MIP-0013 §5). Challenge preimage (§5.1), for a gated
//! circuit:
//!
//!   persistentHash([DST_CIRCUIT, self, sig_r, pk, ...args, auth_nonce, grind_nonce])
//!
//! with DST_CIRCUIT = persistentHash of the tag
//! "midnight:account:auth:v1:<circuit>" zero-padded to 64 bytes (the hashed
//! arm of the #249 derivation). The signer grinds grind_nonce until the
//! hash, read little-endian, is strictly below the JubJub subgroup order
//! (§5.2), then emits (R, s, grind_nonce) with s = r + c·sk.
//!
//! Arm k256. Challenge preimage, for a gated circuit:
//!
//!   persistentHash([DST_CIRCUIT, self, pk_x, pk_y, ...args, auth_nonce])
//!
//! with DST_CIRCUIT over the arm-marked tag
//! "midnight:account:auth:k1:v1:<circuit>". There is no signature term (an
//! ECDSA message must not depend on its own signature) and no grinding
//! nonce (secp256k1EcdsaVerify reduces the 32-byte challenge mod the curve
//! order natively). The signature is ECDSA over the challenge as a prehash;
//! k256 emits the low-S normalised form by default and the contract accepts
//! both S forms (see the malleability note in account.compact).
//!
//! persistentHash is SHA-256 over the compiler's field-aligned binary
//! encoding: this binary reproduces that encoding with the ledger's own fab
//! machinery (`AlignedValue` → `binary_repr` → `PersistentHashWriter`),
//! mirroring the element encodings the compiled contract uses:
//!
//!   Bytes<n>        → one bytes(n) atom, trailing zeros stripped
//!   ContractAddress → Bytes<32>
//!   UserAddress     → Bytes<32>
//!   JubjubPoint     → two field atoms (x, y), minimal little-endian
//!   k256 coordinate → Bytes<32>, the little-endian encoding of the affine
//!                     coordinate (secp256k1PointX/Y(pk) as Bytes<32>) —
//!                     the byte-reverse of its SEC1 big-endian form
//!   Uint<n>         → one bytes(n/8) atom, minimal little-endian
//!
//! Protocol: one JSON request on stdin, one JSON response on stdout. Every
//! request carries the arm.
//!
//!   {"cmd":"keygen","arm":"jubjub"}
//!     → {"sk":"0x…","pk":{"x":"0x…","y":"0x…"}}
//!   {"cmd":"sign","arm":"jubjub","circuit":"withdraw_unshielded","sk":"0x…",
//!    "contract_address":"…64 hex…","color":"…64 hex…","amount":"500",
//!    "recipient":"…64 hex…","auth_nonce":"3"}
//!     → {"pk":{…},"sig_r":{…},"sig_s":"0x…","grind_nonce":"17",
//!        "challenge":"…64 hex…","attempts":18}
//!   {"cmd":"sign","arm":"k256",…same fields…}
//!     → {"pk":{…},"sig":{"r":"0x…","s":"0x…"},"challenge":"…64 hex…"}
//!
//! All bigint fields are 0x-prefixed big-endian hex; raw byte strings are
//! plain hex.

use std::io::Read;

use anyhow::{anyhow, bail, Context, Result};
use ff::Field as _;
use group::Group as _;
use k256::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
use k256::ecdsa::{Signature, SigningKey, VerifyingKey};
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

/// DST_CIRCUIT: persistentHash of the arm's tag zero-padded to 64 bytes.
fn circuit_dst(arm: &Arm, circuit: &str) -> Result<[u8; 32]> {
    let tag = match arm {
        Arm::Jubjub => format!("midnight:account:auth:v1:{circuit}"),
        Arm::K256 => format!("midnight:account:auth:k1:v1:{circuit}"),
    };
    if tag.len() > 64 {
        bail!("circuit tag longer than 64 bytes: {tag}");
    }
    let mut padded = [0u8; 64];
    padded[..tag.len()].copy_from_slice(tag.as_bytes());
    persistent_hash(&[el_bytes(64, &padded)])
}

// ── Arm jubjub: scalars and points ──────────────────────────────────────────

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

fn jubjub_scalar_from_hex(hex_be: &str) -> Result<JubjubScalar> {
    let clean = hex_be.trim_start_matches("0x");
    let bytes = hex::decode(format!("{:0>64}", clean)).context("bad scalar hex")?;
    let mut le: [u8; 32] = bytes.as_slice().try_into().context("scalar not 32 bytes")?;
    le.reverse();
    let scalar: Option<JubjubScalar> = JubjubScalar::from_bytes(&le).into();
    scalar.ok_or_else(|| anyhow!("scalar out of range"))
}

fn jubjub_scalar_to_hex(s: &JubjubScalar) -> String {
    let mut b = s.to_bytes();
    b.reverse();
    format!("0x{}", hex::encode(b))
}

fn jubjub_point_json(p: &EmbeddedGroupAffine) -> Result<serde_json::Value> {
    let x = p.x().ok_or_else(|| anyhow!("point at infinity"))?;
    let y = p.y().ok_or_else(|| anyhow!("point at infinity"))?;
    let to_hex = |f: midnight_transient_crypto::curve::Fr| {
        let mut b = f.as_le_bytes();
        b.reverse();
        format!("0x{}", hex::encode(b))
    };
    Ok(json!({ "x": to_hex(x), "y": to_hex(y) }))
}

// ── Arm k256: keys and coordinates ──────────────────────────────────────────

/// The two Bytes<32> coordinate encodings the contract binds the key as:
/// little-endian affine x and y, i.e. the byte-reverse of the SEC1
/// big-endian coordinates (in-circuit: secp256k1PointX/Y(pk) as Bytes<32>).
fn pk_coords_le(vk: &VerifyingKey) -> Result<([u8; 32], [u8; 32])> {
    let point = vk.to_encoded_point(false);
    let x = point.x().ok_or_else(|| anyhow!("point at infinity"))?;
    let y = point.y().ok_or_else(|| anyhow!("point at infinity"))?;
    let mut x_le: [u8; 32] = (*x).into();
    let mut y_le: [u8; 32] = (*y).into();
    x_le.reverse();
    y_le.reverse();
    Ok((x_le, y_le))
}

fn k256_signing_key_from_hex(hex_be: &str) -> Result<SigningKey> {
    let clean = hex_be.trim_start_matches("0x");
    let bytes = hex::decode(format!("{:0>64}", clean)).context("bad scalar hex")?;
    SigningKey::from_slice(&bytes).map_err(|_| anyhow!("scalar out of range"))
}

fn k256_point_json(vk: &VerifyingKey) -> Result<serde_json::Value> {
    let point = vk.to_encoded_point(false);
    let x = point.x().ok_or_else(|| anyhow!("point at infinity"))?;
    let y = point.y().ok_or_else(|| anyhow!("point at infinity"))?;
    Ok(json!({
        "x": format!("0x{}", hex::encode(x)),
        "y": format!("0x{}", hex::encode(y)),
    }))
}

fn bytes32_from_hex(s: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(s.trim_start_matches("0x")).context("bad hex")?;
    bytes.as_slice().try_into().context("expected 32 bytes")
}

// ── Requests ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Arm {
    Jubjub,
    K256,
}

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
enum Request {
    Keygen { arm: Arm },
    Sign(SignRequest),
}

#[derive(Deserialize)]
struct SignRequest {
    arm: Arm,
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
        Request::Keygen { arm: Arm::Jubjub } => {
            let sk = JubjubScalar::random(&mut rand::rngs::OsRng);
            let pk = EmbeddedGroupAffine(JubjubSubgroup::generator() * sk);
            json!({ "sk": jubjub_scalar_to_hex(&sk), "pk": jubjub_point_json(&pk)? })
        }
        Request::Keygen { arm: Arm::K256 } => {
            let sk = SigningKey::random(&mut rand::rngs::OsRng);
            json!({
                "sk": format!("0x{}", hex::encode(sk.to_bytes())),
                "pk": k256_point_json(sk.verifying_key())?,
            })
        }
        Request::Sign(req) => match req.arm {
            Arm::Jubjub => sign_jubjub(&req)?,
            Arm::K256 => sign_k256(&req)?,
        },
    };
    println!("{response}");
    Ok(())
}

struct CallParams {
    contract_address: [u8; 32],
    color: [u8; 32],
    recipient: [u8; 32],
    amount: u128,
    auth_nonce: u64,
}

fn call_params(req: &SignRequest) -> Result<CallParams> {
    if req.circuit != "withdraw_unshielded" {
        bail!("this reference signer implements the withdraw_unshielded challenge only");
    }
    Ok(CallParams {
        contract_address: bytes32_from_hex(&req.contract_address)?,
        color: bytes32_from_hex(&req.color)?,
        recipient: bytes32_from_hex(&req.recipient)?,
        amount: req.amount.parse().context("bad amount")?,
        auth_nonce: req.auth_nonce.parse().context("bad auth_nonce")?,
    })
}

fn sign_jubjub(req: &SignRequest) -> Result<serde_json::Value> {
    let p = call_params(req)?;
    let sk = jubjub_scalar_from_hex(&req.sk)?;
    let pk = EmbeddedGroupAffine(JubjubSubgroup::generator() * sk);
    let dst = circuit_dst(&Arm::Jubjub, &req.circuit)?;

    // §5.3: fresh nonce scalar, R = r·G, then grind the challenge (§5.2).
    let r = JubjubScalar::random(&mut rand::rngs::OsRng);
    let sig_r = EmbeddedGroupAffine(JubjubSubgroup::generator() * r);

    let mut grind_nonce: u64 = 0;
    let challenge_bytes = loop {
        let h = persistent_hash(&[
            el_bytes(32, &dst),
            el_bytes(32, &p.contract_address),
            el_point(&sig_r)?,
            el_point(&pk)?,
            el_bytes(32, &p.color),
            el_uint(16, p.amount),
            el_bytes(32, &p.recipient),
            el_uint(8, u128::from(p.auth_nonce)),
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
        "pk": jubjub_point_json(&pk)?,
        "sig_r": jubjub_point_json(&sig_r)?,
        "sig_s": jubjub_scalar_to_hex(&s),
        "grind_nonce": grind_nonce.to_string(),
        "challenge": hex::encode(challenge_bytes),
        "attempts": grind_nonce + 1,
    }))
}

fn sign_k256(req: &SignRequest) -> Result<serde_json::Value> {
    let p = call_params(req)?;
    let sk = k256_signing_key_from_hex(&req.sk)?;
    let vk = sk.verifying_key();
    let (pk_x, pk_y) = pk_coords_le(vk)?;
    let dst = circuit_dst(&Arm::K256, &req.circuit)?;

    // The challenge is a plain digest: no signature commitment, no
    // grinding. The key is bound as its little-endian coordinate bytes and
    // auth_nonce comes last.
    let challenge = persistent_hash(&[
        el_bytes(32, &dst),
        el_bytes(32, &p.contract_address),
        el_bytes(32, &pk_x),
        el_bytes(32, &pk_y),
        el_bytes(32, &p.color),
        el_uint(16, p.amount),
        el_bytes(32, &p.recipient),
        el_uint(8, u128::from(p.auth_nonce)),
    ])?;

    // ECDSA over the challenge as a prehash (RFC 6979 deterministic nonce).
    // k256 emits the low-S normalised form; the contract's verifier accepts
    // either form, so the signature travels as produced.
    let sig: Signature = sk.sign_prehash(&challenge).map_err(|_| anyhow!("signing failed"))?;

    // Local verification before emitting (k256's verifier, which insists on
    // the low-S form its signer produces).
    vk.verify_prehash(&challenge, &sig)
        .map_err(|_| anyhow!("self-verification failed"))?;

    let (sig_r, sig_s) = sig.split_bytes();
    Ok(json!({
        "pk": k256_point_json(vk)?,
        "sig": {
            "r": format!("0x{}", hex::encode(sig_r)),
            "s": format!("0x{}", hex::encode(sig_s)),
        },
        "challenge": hex::encode(challenge),
    }))
}

// ── By-hand oracle checks ───────────────────────────────────────────────────
//
// Every preimage of the k256 arm is a tuple of Bytes atoms (the key is
// bound as coordinate bytes, so no Field atoms appear). For such tuples the
// field-aligned binary encoding reduces to each element zero-padded to its
// declared length, concatenated in order — so the tests recompute the DST,
// the device entry, and the challenge as plain SHA-256 over that
// concatenation, independently of the fab machinery, and pin the sk = 1
// public key against the SEC1 generator constants. The jubjub arm's
// preimages carry Field atoms (point coordinates), so only its DST (a pure
// Bytes tuple) has a by-hand oracle; its end-to-end challenge equality is
// covered by crossimpl-offline against the compiled contract.

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const GX_BE: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const GY_BE: &str = "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

    fn pad_to(length: usize, data: &[u8]) -> Vec<u8> {
        let mut v = data.to_vec();
        assert!(v.len() <= length);
        v.resize(length, 0);
        v
    }

    fn sha256_concat(parts: &[Vec<u8>]) -> [u8; 32] {
        let mut hasher = Sha256::new();
        for part in parts {
            hasher.update(part);
        }
        hasher.finalize().into()
    }

    fn coord_le(hex_be: &str) -> [u8; 32] {
        let mut b: [u8; 32] = hex::decode(hex_be).unwrap().try_into().unwrap();
        b.reverse();
        b
    }

    #[test]
    fn generator_coordinates_for_sk_one() {
        let sk = k256_signing_key_from_hex("0x01").unwrap();
        let (x_le, y_le) = pk_coords_le(sk.verifying_key()).unwrap();
        assert_eq!(x_le, coord_le(GX_BE));
        assert_eq!(y_le, coord_le(GY_BE));
    }

    #[test]
    fn dst_is_sha256_of_the_padded_tag_for_both_arms() {
        let k256_by_hand = sha256_concat(&[pad_to(
            64,
            b"midnight:account:auth:k1:v1:withdraw_unshielded",
        )]);
        assert_eq!(
            circuit_dst(&Arm::K256, "withdraw_unshielded").unwrap(),
            k256_by_hand
        );
        let jubjub_by_hand = sha256_concat(&[pad_to(
            64,
            b"midnight:account:auth:v1:withdraw_unshielded",
        )]);
        assert_eq!(
            circuit_dst(&Arm::Jubjub, "withdraw_unshielded").unwrap(),
            jubjub_by_hand
        );
    }

    #[test]
    fn k256_device_entry_matches_the_by_hand_derivation() {
        // derive_device_entry_with_k256(self, pk, epoch, counter) for the
        // sk = 1 key:
        // [DST_DEVICE(32), self(32), x_le(32), y_le(32), epoch(4), counter(8)].
        let self_addr = [0x11u8; 32];
        let (x_le, y_le) = (coord_le(GX_BE), coord_le(GY_BE));
        let via_fab = persistent_hash(&[
            el_bytes(32, &pad_to(32, b"midnight:account:device:k1:v1")),
            el_bytes(32, &self_addr),
            el_bytes(32, &x_le),
            el_bytes(32, &y_le),
            el_uint(4, 0),
            el_uint(8, 0),
        ])
        .unwrap();
        let by_hand = sha256_concat(&[
            pad_to(32, b"midnight:account:device:k1:v1"),
            self_addr.to_vec(),
            x_le.to_vec(),
            y_le.to_vec(),
            vec![0u8; 4],
            vec![0u8; 8],
        ]);
        assert_eq!(via_fab, by_hand);
        // Vector recomputed externally (Python hashlib over the same
        // concatenation), pinning the encoding against joint drift.
        assert_eq!(
            hex::encode(via_fab),
            "f03ab3c9483be2397f3cadb399a72e8e451a73d96bcde3bba3039a9605530840"
        );
    }

    #[test]
    fn k256_challenge_matches_the_by_hand_derivation_and_the_signature_verifies() {
        let sk = k256_signing_key_from_hex("0x01").unwrap();
        let vk = sk.verifying_key();
        let (x_le, y_le) = pk_coords_le(vk).unwrap();
        let contract_address = [0x22u8; 32];
        let color = [0u8; 32];
        let recipient = [0x33u8; 32];
        let amount: u128 = 500;
        let auth_nonce: u64 = 3;

        let dst = circuit_dst(&Arm::K256, "withdraw_unshielded").unwrap();
        let via_fab = persistent_hash(&[
            el_bytes(32, &dst),
            el_bytes(32, &contract_address),
            el_bytes(32, &x_le),
            el_bytes(32, &y_le),
            el_bytes(32, &color),
            el_uint(16, amount),
            el_bytes(32, &recipient),
            el_uint(8, u128::from(auth_nonce)),
        ])
        .unwrap();
        let by_hand = sha256_concat(&[
            dst.to_vec(),
            contract_address.to_vec(),
            x_le.to_vec(),
            y_le.to_vec(),
            color.to_vec(),
            amount.to_le_bytes().to_vec(),
            recipient.to_vec(),
            auth_nonce.to_le_bytes().to_vec(),
        ]);
        assert_eq!(via_fab, by_hand);
        // Vector recomputed externally (Python hashlib over the same
        // concatenation), pinning the encoding against joint drift.
        assert_eq!(
            hex::encode(via_fab),
            "c2f2a3cdfd003b74b8f9aae21018d3d0a6a0abfd5a2eb5bc070c45b8b521d7b8"
        );

        let sig: Signature = sk.sign_prehash(&via_fab).unwrap();
        assert!(vk.verify_prehash(&via_fab, &sig).is_ok());
    }

    #[test]
    fn jubjub_signature_selfverifies_over_a_ground_challenge() {
        // End-to-end sanity of the jubjub signing flow with a fixed sk;
        // challenge bit-exactness against the compiled contract is
        // crossimpl-offline's job.
        let req = SignRequest {
            arm: Arm::Jubjub,
            circuit: "withdraw_unshielded".into(),
            sk: "0x05".into(),
            contract_address: hex::encode([0x22u8; 32]),
            color: hex::encode([0u8; 32]),
            amount: "500".into(),
            recipient: hex::encode([0x33u8; 32]),
            auth_nonce: "3".into(),
        };
        let out = sign_jubjub(&req).unwrap();
        assert!(out.get("sig_s").is_some());
        assert!(out.get("grind_nonce").is_some());
        let challenge = out.get("challenge").unwrap().as_str().unwrap();
        let challenge_bytes: [u8; 32] =
            hex::decode(challenge).unwrap().try_into().unwrap();
        assert!(hash_below_r(&challenge_bytes));
    }
}
