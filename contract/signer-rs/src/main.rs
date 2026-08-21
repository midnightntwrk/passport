//! Independent Rust signer for the account authorisation seam, ECDSA arm.
//!
//! Demonstrates the AUTH-4 boundary and conformance test 7 against the
//! ECDSA-secp256k1 instantiation of the MIP-0012 §4 seam (the k1-arm
//! variant of account.compact): a signer that reproduces the challenge
//! construction with its own hash and curve stack — the ledger's Rust
//! crates for the encoding, the k256 crate for the curve — and no
//! TypeScript, WASM, npm, node, indexer, prover, or contract runtime.
//!
//! Challenge preimage (see account.compact), for a gated circuit:
//!
//!   persistentHash([DST_CIRCUIT, self, pk_x, pk_y, ...args, auth_nonce])
//!
//! where DST_CIRCUIT = persistentHash of the arm-marked tag
//! "midnight:account:auth:k1:v1:<circuit>" zero-padded to 64 bytes (the
//! hashed arm of the #249 derivation, as the reference contract implements
//! it). There is no signature term (an ECDSA message must not depend on
//! its own signature) and no grinding nonce (secp256k1EcdsaVerify reduces
//! the 32-byte challenge mod the curve order natively). persistentHash is
//! SHA-256 over the compiler's field-aligned binary encoding: this binary
//! reproduces that encoding with the ledger's own fab machinery
//! (`AlignedValue` → `binary_repr` → `PersistentHashWriter`), mirroring the
//! element encodings the compiled contract uses:
//!
//!   Bytes<n>        → one bytes(n) atom, trailing zeros stripped
//!   ContractAddress → Bytes<32>
//!   UserAddress     → Bytes<32>
//!   pk coordinate   → Bytes<32>, the little-endian encoding of the affine
//!                     coordinate (secp256k1PointX/Y(pk) as Bytes<32>) —
//!                     the byte-reverse of its SEC1 big-endian form
//!   Uint<n>         → one bytes(n/8) atom, minimal little-endian
//!
//! The signature is ECDSA over secp256k1 on the 32-byte challenge as a
//! prehash: k256 interprets the digest as a big-endian integer and reduces
//! it mod n, exactly as the in-circuit secp256k1EcdsaVerify does. k256
//! emits the low-S normalised form by default; the contract's verifier
//! accepts low-S and high-S alike (see the malleability note in
//! account.compact), so no renormalisation is applied here.
//!
//! Protocol: one JSON request on stdin, one JSON response on stdout.
//!
//!   {"cmd":"keygen"}
//!     → {"sk":"0x…","pk":{"x":"0x…","y":"0x…"}}
//!   {"cmd":"sign","circuit":"withdraw_unshielded","sk":"0x…",
//!    "contract_address":"…64 hex…","color":"…64 hex…","amount":"500",
//!    "recipient":"…64 hex…","auth_nonce":"3"}
//!     → {"pk":{…},"sig":{"r":"0x…","s":"0x…"},"challenge":"…64 hex…"}
//!
//! All bigint fields are 0x-prefixed big-endian hex; raw byte strings are
//! plain hex.

use std::io::Read;

use anyhow::{anyhow, bail, Context, Result};
use k256::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
use k256::ecdsa::{Signature, SigningKey, VerifyingKey};
use midnight_base_crypto::fab::{
    AlignedValue, Alignment, AlignmentAtom, AlignmentSegment, Value, ValueAtom,
};
use midnight_base_crypto::hash::PersistentHashWriter;
use midnight_base_crypto::repr::BinaryHashRepr;
use midnight_transient_crypto::fab::ValueReprAlignedValue;
use serde::Deserialize;
use serde_json::json;

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

/// DST_CIRCUIT: persistentHash of the arm-marked tag zero-padded to 64
/// bytes.
fn circuit_dst(circuit: &str) -> Result<[u8; 32]> {
    let tag = format!("midnight:account:auth:k1:v1:{circuit}");
    if tag.len() > 64 {
        bail!("circuit tag longer than 64 bytes: {tag}");
    }
    let mut padded = [0u8; 64];
    padded[..tag.len()].copy_from_slice(tag.as_bytes());
    persistent_hash(&[el_bytes(64, &padded)])
}

// ── Keys and coordinates ────────────────────────────────────────────────────

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

fn signing_key_from_hex(hex_be: &str) -> Result<SigningKey> {
    let clean = hex_be.trim_start_matches("0x");
    let bytes = hex::decode(format!("{:0>64}", clean)).context("bad scalar hex")?;
    SigningKey::from_slice(&bytes).map_err(|_| anyhow!("scalar out of range"))
}

fn point_json(vk: &VerifyingKey) -> Result<serde_json::Value> {
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
            let sk = SigningKey::random(&mut rand::rngs::OsRng);
            json!({
                "sk": format!("0x{}", hex::encode(sk.to_bytes())),
                "pk": point_json(sk.verifying_key())?,
            })
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
    let sk = signing_key_from_hex(&req.sk)?;
    let vk = sk.verifying_key();
    let (pk_x, pk_y) = pk_coords_le(vk)?;
    let contract_address = bytes32_from_hex(&req.contract_address)?;
    let color = bytes32_from_hex(&req.color)?;
    let recipient = bytes32_from_hex(&req.recipient)?;
    let amount: u128 = req.amount.parse().context("bad amount")?;
    let auth_nonce: u64 = req.auth_nonce.parse().context("bad auth_nonce")?;

    let dst = circuit_dst(&req.circuit)?;

    // The challenge is a plain digest: no signature commitment, no
    // grinding. The key is bound as its little-endian coordinate bytes and
    // auth_nonce comes last.
    let challenge = persistent_hash(&[
        el_bytes(32, &dst),
        el_bytes(32, &contract_address),
        el_bytes(32, &pk_x),
        el_bytes(32, &pk_y),
        el_bytes(32, &color),
        el_uint(16, amount),
        el_bytes(32, &recipient),
        el_uint(8, u128::from(auth_nonce)),
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
        "pk": point_json(vk)?,
        "sig": {
            "r": format!("0x{}", hex::encode(sig_r)),
            "s": format!("0x{}", hex::encode(sig_s)),
        },
        "challenge": hex::encode(challenge),
    }))
}

// ── By-hand oracle checks ───────────────────────────────────────────────────
//
// Every preimage of this arm is a tuple of Bytes atoms (the key is bound as
// coordinate bytes, so no Field atoms appear). For such tuples the
// field-aligned binary encoding reduces to each element zero-padded to its
// declared length, concatenated in order — so the tests recompute the DST,
// the device entry, and the challenge as plain SHA-256 over that
// concatenation, independently of the fab machinery, and pin the sk = 1
// public key against the SEC1 generator constants.

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
        let sk = signing_key_from_hex("0x01").unwrap();
        let (x_le, y_le) = pk_coords_le(sk.verifying_key()).unwrap();
        assert_eq!(x_le, coord_le(GX_BE));
        assert_eq!(y_le, coord_le(GY_BE));
    }

    #[test]
    fn dst_is_sha256_of_the_padded_tag() {
        let by_hand = sha256_concat(&[pad_to(
            64,
            b"midnight:account:auth:k1:v1:withdraw_unshielded",
        )]);
        assert_eq!(circuit_dst("withdraw_unshielded").unwrap(), by_hand);
    }

    #[test]
    fn device_entry_matches_the_by_hand_derivation() {
        // derive_device_entry(self, pk, epoch, counter) for the sk = 1 key:
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
    fn challenge_matches_the_by_hand_derivation_and_the_signature_verifies() {
        let sk = signing_key_from_hex("0x01").unwrap();
        let vk = sk.verifying_key();
        let (x_le, y_le) = pk_coords_le(vk).unwrap();
        let contract_address = [0x22u8; 32];
        let color = [0u8; 32];
        let recipient = [0x33u8; 32];
        let amount: u128 = 500;
        let auth_nonce: u64 = 3;

        let dst = circuit_dst("withdraw_unshielded").unwrap();
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
}
