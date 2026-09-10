//! Scoped grants: identity, commitments, the scope digest, and the grant
//! challenges of the k256 grantee arm.
//!
//! Built from the published byte recipes of the scoped-grants MIP (sections
//! 4.3 to 4.5 for the derivations, 6.3 for the challenges), not from the
//! compiled contract: this module links no contract module and no
//! TypeScript, exactly as the rest of this signer does. Every preimage is a
//! concatenation of fixed-width elements hashed with SHA-256, with integers
//! little-endian at their Compact width, so the recipes are reproduced here
//! through the same field-aligned encoding the device family already uses
//! (`persistent_hash` over `Element`s) and cross-checked in the tests
//! against a by-hand plain-SHA-256 recomputation plus externally computed
//! pinned vectors.
//!
//! Element encodings used by the grant recipes:
//!
//!   Bytes<32>, Bytes<192>  one bytes(n) atom
//!   Uint<8>, Uint<64>, Uint<128>  one bytes(n/8) atom, little-endian
//!   Boolean                one bytes(1) atom, 0x01 true and 0x00 false
//!   JubjubPoint            two field atoms (x, y), so 64 preimage bytes
//!
//! The `Boolean` and `JubjubPoint` widths are the two places where the MIP
//! text and the compiled encoding had to be reconciled; see
//! `.planning/grants-e1/verify-rs.md`.

use anyhow::{anyhow, bail, Context, Result};
use k256::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
use k256::ecdsa::Signature;
use midnight_transient_crypto::curve::EmbeddedGroupAffine;
use serde::Deserialize;
use serde_json::json;

use crate::{
    bytes32_from_hex, circuit_dst, el_bytes, el_point, el_uint, envelope_digest,
    k256_point_json, k256_signing_key_from_hex, persistent_hash, pk_coords_le, Arm, Element,
};
use midnight_base_crypto::fab::{AlignmentAtom, AlignmentSegment, ValueAtom};

// ── Tag families (MIP section 14) ──────────────────────────────────────────

/// Raw 32-byte pad, used as a tuple element rather than hashed.
const TAG_ID_K1: &str = "midnight:account:grant:id:k1:v1";
const TAG_ID_V1: &str = "midnight:account:grant:id:v1";
const TAG_OBJ: &str = "midnight:account:grant:obj:v1";
const TAG_SPENT: &str = "midnight:account:grant:spent:v1";
const TAG_RP: &str = "midnight:account:grant:rp:v1";
const TAG_SCOPE: &str = "midnight:account:grant:scope:v1";
/// Off-chain, raw 32-byte pad, prefixed to the normalised `client_id` bytes.
const TAG_ORIGIN: &str = "midnight:account:grant:origin:v1";

/// The three grant operations, in the order the MIP lists them. The 64-byte
/// DST pad is a normative budget on future operation names; the longest
/// member today occupies 63 of the 64 bytes.
pub const GRANT_OPERATIONS: [&str; 3] = [
    "withdraw_unshielded",
    "withdraw_shielded",
    "withdraw_shielded_to_contract",
];

// ── Padding helpers ────────────────────────────────────────────────────────

fn pad32(tag: &str) -> Result<[u8; 32]> {
    let bytes = tag.as_bytes();
    if bytes.len() > 32 {
        bail!("grant tag longer than 32 bytes: {tag}");
    }
    let mut padded = [0u8; 32];
    padded[..bytes.len()].copy_from_slice(bytes);
    Ok(padded)
}

/// A `Boolean` in a hash tuple: one byte, `0x01` true and `0x00` false.
fn el_flag(value: bool) -> Element {
    el_uint(1, u128::from(value))
}

// ── Section 4.4: origin normalisation and origin_hash ──────────────────────

/// `origin_hash = H(pad(32, TAG_ORIGIN) || client_id_bytes)`, computed
/// off-chain over the normalised `client_id`. The `client_id` bytes are NOT
/// padded to a fixed width: the derivation lives outside any circuit, so
/// there is no Compact type to pad to, and the productions of section 4.4
/// have different lengths.
///
/// Normalisation is the caller's responsibility for browser origins (this
/// function rejects a non-ASCII byte, which section 4.4 also forbids, but
/// does not lowercase, strip a trailing slash, or punycode a host).
pub fn origin_hash(client_id: &str) -> Result<[u8; 32]> {
    if !client_id.is_ascii() {
        bail!("client_id carries a non-ASCII byte, which section 4.4 forbids");
    }
    if client_id.is_empty() {
        bail!("empty client_id");
    }
    let mut hasher = sha256_writer();
    hasher.update(&pad32(TAG_ORIGIN)?);
    hasher.update(client_id.as_bytes());
    Ok(hasher.finish())
}

// ── Section 4.3: grant identity ────────────────────────────────────────────

/// `grant_id` for the `k1` arm: 162 preimage bytes,
/// `pad(32, TAG_ID_K1) || self || x || y || u8(envelope) || origin_hash || u8(slot)`,
/// with the key as its little-endian affine coordinate bytes (section 3.4).
pub fn grant_id_k256(
    self_addr: &[u8; 32],
    pk_x_le: &[u8; 32],
    pk_y_le: &[u8; 32],
    envelope: u8,
    origin_hash: &[u8; 32],
    slot: u8,
) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &pad32(TAG_ID_K1)?),
        el_bytes(32, self_addr),
        el_bytes(32, pk_x_le),
        el_bytes(32, pk_y_le),
        el_uint(1, u128::from(envelope)),
        el_bytes(32, origin_hash),
        el_uint(1, u128::from(slot)),
    ])
}

/// `grant_id` for the `v1` (JubJub) arm: 161 preimage bytes,
/// `pad(32, TAG_ID_V1) || self || x || y || origin_hash || u8(slot)`.
///
/// The key element is 64 bytes and not the 32 the MIP text states: a
/// `JubjubPoint` in a `persistentHash` tuple encodes as two field atoms,
/// x then y, each a 32-byte little-endian integer, which is also how the
/// device family binds `pk` and `sig_r`. There is no envelope on this arm.
pub fn grant_id_jubjub(
    self_addr: &[u8; 32],
    pk: &EmbeddedGroupAffine,
    origin_hash: &[u8; 32],
    slot: u8,
) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &pad32(TAG_ID_V1)?),
        el_bytes(32, self_addr),
        el_point(pk)?,
        el_bytes(32, origin_hash),
        el_uint(1, u128::from(slot)),
    ])
}

/// The BLS12-381 scalar field modulus, which is the JubJub base field: every
/// affine coordinate of a JubJub point is a canonical residue below it,
/// little-endian.
const BLS12_381_SCALAR_MODULUS_LE: [u8; 32] = [
    0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0x5b, 0xfe, 0xff, 0x02, 0xa4, 0xbd, 0x53,
    0x05, 0xd8, 0xa1, 0x09, 0x08, 0xd8, 0x39, 0x33, 0x48, 0x7d, 0x9d, 0x29, 0x53, 0xa7, 0xed, 0x73,
];

fn below_modulus_le(le: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if le[i] != BLS12_381_SCALAR_MODULUS_LE[i] {
            return le[i] < BLS12_381_SCALAR_MODULUS_LE[i];
        }
    }
    false
}

/// One `Field` atom from a 32-byte little-endian coordinate. The ledger
/// writer reduces a `Field` atom modulo the scalar prime before writing its
/// 32 canonical little-endian bytes, so the plain-SHA-256 recipe of MIP
/// section 4.3 reproduces the compiled circuit only over canonical
/// coordinates; a value at or above the modulus is refused here rather than
/// silently reduced. The coordinates of an on-curve point are always
/// canonical, so this refuses only malformed wire input.
fn el_field_canonical(le: &[u8; 32]) -> Result<Element> {
    if !below_modulus_le(le) {
        bail!("coordinate is not a canonical BLS12-381 scalar-field element");
    }
    let mut minimal = le.to_vec();
    while minimal.last() == Some(&0) {
        minimal.pop();
    }
    Ok(Element {
        atoms: vec![ValueAtom(minimal)],
        alignment: vec![AlignmentSegment::Atom(AlignmentAtom::Field)],
    })
}

/// `grant_id` for the `v1` arm from the wire form of the key: `x || y`, each
/// a 32-byte little-endian canonical coordinate (128 hex on the wire, the
/// same shape as the `k1` and `r1` rows). This is the path a dApp that holds
/// only the wire form takes; `grant_id_jubjub` is the same recipe over a
/// curve point and the tests assert the two agree.
pub fn grant_id_jubjub_coords(
    self_addr: &[u8; 32],
    pk_x_le: &[u8; 32],
    pk_y_le: &[u8; 32],
    origin_hash: &[u8; 32],
    slot: u8,
) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &pad32(TAG_ID_V1)?),
        el_bytes(32, self_addr),
        el_field_canonical(pk_x_le)?,
        el_field_canonical(pk_y_le)?,
        el_bytes(32, origin_hash),
        el_uint(1, u128::from(slot)),
    ])
}

// ── Section 4.5: commitments and the scope digest ──────────────────────────

/// `object_commit`: 145 preimage bytes. Over a read-only grant every object
/// field is zero (issue rule 7), so the commitment is determined by
/// `scope_salt` alone.
pub fn object_commit(
    scope_salt: &[u8; 32],
    color: &[u8; 32],
    recipient_kind: u8,
    recipient: &[u8; 32],
    max_coin_value: u128,
) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &pad32(TAG_OBJ)?),
        el_bytes(32, scope_salt),
        el_bytes(32, color),
        el_uint(1, u128::from(recipient_kind)),
        el_bytes(32, recipient),
        el_uint(16, max_coin_value),
    ])
}

/// `spent_commit`: 80 preimage bytes, over the cumulative value released.
pub fn spent_commit(scope_salt: &[u8; 32], spent: u128) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &pad32(TAG_SPENT)?),
        el_bytes(32, scope_salt),
        el_uint(16, spent),
    ])
}

/// `rp_commit`: 96 preimage bytes. `rp_id_hash` is all-zero for every arm
/// but `r1`, and the commitment is written regardless so that the record
/// reveals neither the dApp host nor the arm.
pub fn rp_commit(scope_salt: &[u8; 32], rp_id_hash: &[u8; 32]) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &pad32(TAG_RP)?),
        el_bytes(32, scope_salt),
        el_bytes(32, rp_id_hash),
    ])
}

/// The plaintext scope of section 4.2, as the approver consents to it and
/// as `issue_grant` takes it.
#[derive(Clone, Debug)]
pub struct GrantScopePlain {
    pub op_withdraw_unshielded: bool,
    pub op_withdraw_shielded: bool,
    pub op_withdraw_shielded_to_contract: bool,
    pub read: bool,
    pub color: [u8; 32],
    pub recipient_kind: u8,
    pub recipient: [u8; 32],
    pub max_coin_value: u128,
    pub per_call_cap: u128,
    pub cap: u128,
    pub expires_at: u64,
    pub rp_id_hash: [u8; 32],
    pub read_pk_hash: [u8; 32],
    pub window_len: u64,
    pub window_cap: u128,
}

impl GrantScopePlain {
    /// A read-only scope, which issue rule 7 requires to carry all-zero
    /// object fields and zero caps. Part of the recipe surface rather than
    /// of the wire protocol, which takes the fields individually.
    #[allow(dead_code)]
    pub fn read_only(read_pk_hash: [u8; 32]) -> Self {
        Self {
            op_withdraw_unshielded: false,
            op_withdraw_shielded: false,
            op_withdraw_shielded_to_contract: false,
            read: true,
            color: [0u8; 32],
            recipient_kind: 0,
            recipient: [0u8; 32],
            max_coin_value: 0,
            per_call_cap: 0,
            cap: 0,
            expires_at: 0,
            rp_id_hash: [0u8; 32],
            read_pk_hash,
            window_len: 0,
            window_cap: 0,
        }
    }
}

/// `scope_digest`: seventeen elements, 277 preimage bytes. This is the
/// single element through which the `issue_grant` device challenge binds
/// the whole plaintext scope, so the four flags enter as single bytes and
/// every reserved field is hashed at its declared width.
pub fn scope_digest(scope_salt: &[u8; 32], scope: &GrantScopePlain) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &pad32(TAG_SCOPE)?),
        el_bytes(32, scope_salt),
        el_flag(scope.op_withdraw_unshielded),
        el_flag(scope.op_withdraw_shielded),
        el_flag(scope.op_withdraw_shielded_to_contract),
        el_flag(scope.read),
        el_bytes(32, &scope.color),
        el_uint(1, u128::from(scope.recipient_kind)),
        el_bytes(32, &scope.recipient),
        el_uint(16, scope.max_coin_value),
        el_uint(16, scope.per_call_cap),
        el_uint(16, scope.cap),
        el_uint(8, u128::from(scope.expires_at)),
        el_bytes(32, &scope.rp_id_hash),
        el_bytes(32, &scope.read_pk_hash),
        el_uint(8, u128::from(scope.window_len)),
        el_uint(16, scope.window_cap),
    ])
}

// ── Section 6.3: grant challenge preimages, k1 grantee arm ─────────────────

/// `DST = H(pad(64, "midnight:account:grant:auth:<marker>v1:<operation>"))`,
/// with the marker `k1:` for this arm and empty for `v1`. The pad is
/// hashed, matching the amended derivation of the authorisation MIP
/// section 5.1, unlike the identity and commitment tags, which are raw
/// 32-byte pads used as tuple elements.
pub fn grant_dst(marker: &str, operation: &str) -> Result<[u8; 32]> {
    if !GRANT_OPERATIONS.contains(&operation) {
        bail!("unknown grant operation {operation}");
    }
    let tag = format!("midnight:account:grant:auth:{marker}v1:{operation}");
    if tag.len() > 64 {
        bail!("grant challenge tag longer than 64 bytes: {tag}");
    }
    let mut padded = [0u8; 64];
    padded[..tag.len()].copy_from_slice(tag.as_bytes());
    persistent_hash(&[el_bytes(64, &padded)])
}

/// The head of every k1 grant challenge:
/// `DST || self || x || y || grant_id || u64(issued_at)`. There is no
/// signature material on an ECDSA arm (SIG-3) and no grinding nonce.
#[derive(Clone, Debug)]
pub struct GrantCallHead {
    pub self_addr: [u8; 32],
    pub pk_x_le: [u8; 32],
    pub pk_y_le: [u8; 32],
    pub grant_id: [u8; 32],
    /// `auth_nonce` as advanced by the issuing call, read from the record.
    pub issued_at: u64,
    /// The record's `nonce`, read from the record, hashed last.
    pub record_nonce: u64,
}

/// The `QualifiedShieldedCoinInfo` the shielded twins consume, flattened
/// into the challenge in declaration order (AUTH-10).
#[derive(Clone, Debug)]
pub struct QualifiedCoin {
    pub nonce: [u8; 32],
    pub color: [u8; 32],
    pub value: u128,
    pub mt_index: u64,
}

fn head_elements(head: &GrantCallHead, dst: &[u8; 32]) -> Vec<Element> {
    vec![
        el_bytes(32, dst),
        el_bytes(32, &head.self_addr),
        el_bytes(32, &head.pk_x_le),
        el_bytes(32, &head.pk_y_le),
        el_bytes(32, &head.grant_id),
        el_uint(8, u128::from(head.issued_at)),
    ]
}

/// `challenge_withdraw_unshielded_with_grant_k256`: ten elements, 256
/// preimage bytes. The operation arguments follow in declaration order
/// (`color`, `amount`, `recipient`) and there is no witness value, because
/// the unshielded chip consumes the `color` argument itself.
pub fn challenge_withdraw_unshielded_with_grant_k256(
    head: &GrantCallHead,
    color: &[u8; 32],
    amount: u128,
    recipient: &[u8; 32],
) -> Result<[u8; 32]> {
    let dst = grant_dst("k1:", "withdraw_unshielded")?;
    let mut elements = head_elements(head, &dst);
    elements.push(el_bytes(32, color));
    elements.push(el_uint(16, amount));
    elements.push(el_bytes(32, recipient));
    elements.push(el_uint(8, u128::from(head.record_nonce)));
    persistent_hash(&elements)
}

/// The shielded grant challenge: thirteen declared elements (the qualified
/// coin is one struct member and flattens into four atoms), 568 preimage
/// bytes. The operation arguments are `recipient`, `color`, `amount`,
/// `change_entry`, `enc_pk`, then the coin actually consumed, then the
/// record's `nonce`.
///
/// `operation` selects the DST only, so this covers
/// `withdraw_shielded_to_contract` unchanged: the two twins differ in the
/// Compact type of `recipient` (a `ZswapCoinPublicKey` against a
/// `ContractAddress`), and both encode as the struct's `bytes` field.
// The argument list mirrors the circuit's own, in declaration order, which
// is what makes the preimage auditable against section 6.3; grouping them
// into a struct would hide the order the recipe fixes.
#[allow(clippy::too_many_arguments)]
pub fn challenge_withdraw_shielded_with_grant_k256(
    operation: &str,
    head: &GrantCallHead,
    recipient: &[u8; 32],
    color: &[u8; 32],
    amount: u128,
    change_entry: &[u8; 192],
    enc_pk: &[u8; 32],
    coin: &QualifiedCoin,
) -> Result<[u8; 32]> {
    if operation == "withdraw_unshielded" {
        bail!("withdraw_unshielded is not a shielded grant twin");
    }
    let dst = grant_dst("k1:", operation)?;
    let mut elements = head_elements(head, &dst);
    elements.push(el_bytes(32, recipient));
    elements.push(el_bytes(32, color));
    elements.push(el_uint(16, amount));
    elements.push(el_bytes(192, change_entry));
    elements.push(el_bytes(32, enc_pk));
    elements.push(el_bytes(32, &coin.nonce));
    elements.push(el_bytes(32, &coin.color));
    elements.push(el_uint(16, coin.value));
    elements.push(el_uint(8, u128::from(coin.mt_index)));
    elements.push(el_uint(8, u128::from(head.record_nonce)));
    persistent_hash(&elements)
}

// ── Section 6.1: the lifecycle challenges on the k256 device arm ──────────
//
// Device-gated, so they live in the existing device tag family
// (`midnight:account:auth:k1:v1:<circuit>`, hashed from a 64-byte pad by
// `circuit_dst`) and take the existing k256 device preimage shape:
// `DST || self || x || y || ...args || u64(auth_nonce)`. The whole plaintext
// scope enters `issue_grant` through the single `scope_digest` element.

/// `challenge_issue_grant_with_k256`: seven elements, 200 preimage bytes,
/// argument list `[grant_id, scope_digest]`.
pub fn challenge_issue_grant_k256(
    self_addr: &[u8; 32],
    pk_x_le: &[u8; 32],
    pk_y_le: &[u8; 32],
    grant_id: &[u8; 32],
    scope_digest: &[u8; 32],
    auth_nonce: u64,
) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &circuit_dst(&Arm::K256, "issue_grant")?),
        el_bytes(32, self_addr),
        el_bytes(32, pk_x_le),
        el_bytes(32, pk_y_le),
        el_bytes(32, grant_id),
        el_bytes(32, scope_digest),
        el_uint(8, u128::from(auth_nonce)),
    ])
}

/// `challenge_revoke_grant_with_k256`: six elements, 168 preimage bytes.
pub fn challenge_revoke_grant_k256(
    self_addr: &[u8; 32],
    pk_x_le: &[u8; 32],
    pk_y_le: &[u8; 32],
    grant_id: &[u8; 32],
    auth_nonce: u64,
) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &circuit_dst(&Arm::K256, "revoke_grant")?),
        el_bytes(32, self_addr),
        el_bytes(32, pk_x_le),
        el_bytes(32, pk_y_le),
        el_bytes(32, grant_id),
        el_uint(8, u128::from(auth_nonce)),
    ])
}

/// `challenge_revoke_all_grants_with_k256`: five elements, 136 preimage
/// bytes; no argument beyond the seam's own.
pub fn challenge_revoke_all_grants_k256(
    self_addr: &[u8; 32],
    pk_x_le: &[u8; 32],
    pk_y_le: &[u8; 32],
    auth_nonce: u64,
) -> Result<[u8; 32]> {
    persistent_hash(&[
        el_bytes(32, &circuit_dst(&Arm::K256, "revoke_all_grants")?),
        el_bytes(32, self_addr),
        el_bytes(32, pk_x_le),
        el_bytes(32, pk_y_le),
        el_uint(8, u128::from(auth_nonce)),
    ])
}

// ── The sign_grant request path ────────────────────────────────────────────

/// `{"cmd":"sign_grant","arm":"k256", ...}`: one grant call signed by a
/// grantee key on the k256 arm. The signature covers
/// `envelope_digest(envelope, challenge)`, never the challenge itself.
#[derive(Deserialize)]
pub struct GrantSignRequest {
    /// Optional and only ever `"k256"`: the jubjub grantee arm is not
    /// implemented here.
    #[serde(default)]
    pub arm: Option<String>,
    /// `withdraw_unshielded`, `withdraw_shielded`, or
    /// `withdraw_shielded_to_contract`.
    pub circuit: String,
    pub sk: String,
    /// The k256 envelope id fixed for this grantee at issuance: `0` no
    /// prefix, `1` the dApp-connector `signData` prefix. Note that an
    /// envelope-1 grantee is restricted to `read` scopes by section 3.2, so
    /// a withdraw signed under envelope 1 is a negative vector rather than
    /// a conforming call.
    #[serde(default)]
    pub envelope: u8,
    /// The account's contract address, 64 hex.
    pub contract_address: String,
    /// The normalised `client_id`; `origin_hash` is derived from it. Exactly
    /// one of `client_id` and `origin_hash` is given.
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub origin_hash: Option<String>,
    pub slot: u8,
    /// The record's `issued_at`, read from chain state, decimal.
    pub issued_at: String,
    /// The record's `nonce`, read from chain state, decimal.
    pub grant_nonce: String,
    pub color: String,
    pub amount: String,
    pub recipient: String,
    /// Shielded twins only: 384 hex.
    #[serde(default)]
    pub change_entry: Option<String>,
    /// Shielded twins only: the value of the `enc_key` cell the grantee
    /// encrypted `change_entry` to.
    #[serde(default)]
    pub enc_pk: Option<String>,
    /// Shielded twins only: the qualified coin the call will consume.
    #[serde(default)]
    pub coin: Option<QualifiedCoinJson>,
}

#[derive(Deserialize)]
pub struct QualifiedCoinJson {
    pub nonce: String,
    pub color: String,
    pub value: String,
    pub mt_index: String,
}

fn bytes_n_from_hex<const N: usize>(s: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(s.trim_start_matches("0x")).context("bad hex")?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("expected {N} bytes, got {}", bytes.len()))
}

pub fn sign_grant(req: &GrantSignRequest) -> Result<serde_json::Value> {
    match req.arm.as_deref() {
        None | Some("k256") => {}
        Some(other) => bail!("the grantee arm {other} is not implemented in this signer"),
    }
    let sk = k256_signing_key_from_hex(&req.sk)?;
    let vk = sk.verifying_key();
    let (pk_x_le, pk_y_le) = pk_coords_le(vk)?;
    let self_addr = bytes32_from_hex(&req.contract_address)?;

    let origin = match (&req.client_id, &req.origin_hash) {
        (Some(id), None) => origin_hash(id)?,
        (None, Some(h)) => bytes32_from_hex(h)?,
        _ => bail!("give exactly one of client_id and origin_hash"),
    };

    let grant_id = grant_id_k256(
        &self_addr,
        &pk_x_le,
        &pk_y_le,
        req.envelope,
        &origin,
        req.slot,
    )?;

    let head = GrantCallHead {
        self_addr,
        pk_x_le,
        pk_y_le,
        grant_id,
        issued_at: req.issued_at.parse().context("bad issued_at")?,
        record_nonce: req.grant_nonce.parse().context("bad grant_nonce")?,
    };

    let color = bytes32_from_hex(&req.color)?;
    let amount: u128 = req.amount.parse().context("bad amount")?;
    let recipient = bytes32_from_hex(&req.recipient)?;

    let challenge = if req.circuit == "withdraw_unshielded" {
        challenge_withdraw_unshielded_with_grant_k256(&head, &color, amount, &recipient)?
    } else {
        let change_entry: [u8; 192] = bytes_n_from_hex(
            req.change_entry
                .as_deref()
                .ok_or_else(|| anyhow!("a shielded grant twin needs change_entry"))?,
        )?;
        let enc_pk = bytes32_from_hex(
            req.enc_pk
                .as_deref()
                .ok_or_else(|| anyhow!("a shielded grant twin needs enc_pk"))?,
        )?;
        let coin_json = req
            .coin
            .as_ref()
            .ok_or_else(|| anyhow!("a shielded grant twin needs the qualified coin"))?;
        let coin = QualifiedCoin {
            nonce: bytes32_from_hex(&coin_json.nonce)?,
            color: bytes32_from_hex(&coin_json.color)?,
            value: coin_json.value.parse().context("bad coin value")?,
            mt_index: coin_json.mt_index.parse().context("bad coin mt_index")?,
        };
        challenge_withdraw_shielded_with_grant_k256(
            &req.circuit,
            &head,
            &recipient,
            &color,
            amount,
            &change_entry,
            &enc_pk,
            &coin,
        )?
    };

    // The signature covers the envelope digest, exactly as on the device
    // arm: the grant challenge is the inner 32-byte payload.
    let digest = envelope_digest(req.envelope, &challenge)?;
    let sig: Signature = sk
        .sign_prehash(&digest)
        .map_err(|_| anyhow!("signing failed"))?;
    vk.verify_prehash(&digest, &sig)
        .map_err(|_| anyhow!("self-verification failed"))?;

    let (sig_r, sig_s) = sig.split_bytes();
    Ok(json!({
        "arm": "k256",
        "circuit": req.circuit,
        "pk": k256_point_json(vk)?,
        "origin_hash": hex::encode(origin),
        "grant_id": hex::encode(grant_id),
        "challenge": hex::encode(challenge),
        "digest": hex::encode(digest),
        "envelope": req.envelope,
        "sig": {
            "r": format!("0x{}", hex::encode(sig_r)),
            "s": format!("0x{}", hex::encode(sig_s)),
        },
    }))
}

// ── The derive_grant request path ──────────────────────────────────────────

/// `{"cmd":"derive_grant", ...}`: every issuance-side derivation of
/// sections 4.3 to 4.5 over one plaintext scope, which is what an
/// authoriser computes before it asks a device to sign `issue_grant` and
/// what the cross-implementation vectors of Testing item 5 compare against
/// the compiled pure circuits.
#[derive(Deserialize)]
pub struct DeriveGrantRequest {
    /// `k256` (the default) or `jubjub`, selecting the identity recipe.
    #[serde(default)]
    pub arm: Option<String>,
    /// The grantee signing key, from which the public key is derived.
    pub sk: String,
    /// The k1 envelope id; absent from the `v1` identity preimage.
    #[serde(default)]
    pub envelope: u8,
    pub contract_address: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub origin_hash: Option<String>,
    pub slot: u8,
    pub scope_salt: String,
    pub scope: ScopeJson,
    /// The cumulative value released so far, for a second `spent_commit`
    /// beside the issue-time one at zero.
    #[serde(default)]
    pub spent: Option<String>,
    /// Optional: the k256 device key that will sign the lifecycle calls,
    /// with the `auth_nonce` the device seam will read. When given, the
    /// three lifecycle challenges of section 6.1 (`issue_grant` over
    /// `[grant_id, scope_digest]`, `revoke_grant` over `[grant_id]`,
    /// `revoke_all_grants`) are emitted at that nonce, which is what the
    /// authoriser hands the device to sign.
    #[serde(default)]
    pub device: Option<DeviceJson>,
}

#[derive(Deserialize)]
pub struct DeviceJson {
    /// The k256 device signing key (the lifecycle circuits are device-gated
    /// on the k256 device arm in this stage).
    pub sk: String,
    /// The account's `auth_nonce` as the device seam will read it.
    pub auth_nonce: String,
}

/// The plaintext scope of section 4.2 on the wire. Feature strings map to
/// the four Booleans per section 5.2; this path takes the Booleans.
#[derive(Deserialize)]
pub struct ScopeJson {
    #[serde(default)]
    pub op_withdraw_unshielded: bool,
    #[serde(default)]
    pub op_withdraw_shielded: bool,
    #[serde(default)]
    pub op_withdraw_shielded_to_contract: bool,
    #[serde(default)]
    pub read: bool,
    pub color: String,
    pub recipient_kind: u8,
    pub recipient: String,
    pub max_coin_value: String,
    pub per_call_cap: String,
    pub cap: String,
    pub expires_at: String,
    pub rp_id_hash: String,
    pub read_pk_hash: String,
    #[serde(default)]
    pub window_len: String,
    #[serde(default)]
    pub window_cap: String,
}

fn parse_reserved(value: &str) -> Result<u128> {
    if value.is_empty() {
        return Ok(0);
    }
    value.parse().context("bad reserved window field")
}

pub fn derive_grant(req: &DeriveGrantRequest) -> Result<serde_json::Value> {
    let self_addr = bytes32_from_hex(&req.contract_address)?;
    let scope_salt = bytes32_from_hex(&req.scope_salt)?;
    let origin = match (&req.client_id, &req.origin_hash) {
        (Some(id), None) => origin_hash(id)?,
        (None, Some(h)) => bytes32_from_hex(h)?,
        _ => bail!("give exactly one of client_id and origin_hash"),
    };

    let scope = GrantScopePlain {
        op_withdraw_unshielded: req.scope.op_withdraw_unshielded,
        op_withdraw_shielded: req.scope.op_withdraw_shielded,
        op_withdraw_shielded_to_contract: req.scope.op_withdraw_shielded_to_contract,
        read: req.scope.read,
        color: bytes32_from_hex(&req.scope.color)?,
        recipient_kind: req.scope.recipient_kind,
        recipient: bytes32_from_hex(&req.scope.recipient)?,
        max_coin_value: req.scope.max_coin_value.parse().context("bad max_coin_value")?,
        per_call_cap: req.scope.per_call_cap.parse().context("bad per_call_cap")?,
        cap: req.scope.cap.parse().context("bad cap")?,
        expires_at: req.scope.expires_at.parse().context("bad expires_at")?,
        rp_id_hash: bytes32_from_hex(&req.scope.rp_id_hash)?,
        read_pk_hash: bytes32_from_hex(&req.scope.read_pk_hash)?,
        window_len: u64::try_from(parse_reserved(&req.scope.window_len)?)
            .context("window_len exceeds Uint<64>")?,
        window_cap: parse_reserved(&req.scope.window_cap)?,
    };

    let (arm, grant_id, pk_json) = match req.arm.as_deref() {
        None | Some("k256") => {
            let sk = k256_signing_key_from_hex(&req.sk)?;
            let vk = sk.verifying_key();
            let (x_le, y_le) = pk_coords_le(vk)?;
            (
                "k256",
                grant_id_k256(&self_addr, &x_le, &y_le, req.envelope, &origin, req.slot)?,
                k256_point_json(vk)?,
            )
        }
        Some("jubjub") => {
            let sk = crate::jubjub_scalar_from_hex(&req.sk)?;
            let pk = EmbeddedGroupAffine(
                <midnight_curves::JubjubSubgroup as group::Group>::generator() * sk,
            );
            // The identity over the point and over its wire form (x || y,
            // canonical little-endian coordinates) are one recipe; both are
            // computed and must agree.
            let x: [u8; 32] = pk
                .x()
                .ok_or_else(|| anyhow!("point at infinity"))?
                .as_le_bytes()
                .try_into()
                .map_err(|_| anyhow!("coordinate width"))?;
            let y: [u8; 32] = pk
                .y()
                .ok_or_else(|| anyhow!("point at infinity"))?
                .as_le_bytes()
                .try_into()
                .map_err(|_| anyhow!("coordinate width"))?;
            let over_point = grant_id_jubjub(&self_addr, &pk, &origin, req.slot)?;
            let over_wire = grant_id_jubjub_coords(&self_addr, &x, &y, &origin, req.slot)?;
            if over_point != over_wire {
                bail!("v1 grant_id over the point and over its wire form disagree");
            }
            ("jubjub", over_point, crate::jubjub_point_json(&pk)?)
        }
        Some(other) => bail!("unknown grantee arm {other}"),
    };

    let mut out = json!({
        "arm": arm,
        "pk": pk_json,
        "origin_hash": hex::encode(origin),
        "grant_id": hex::encode(grant_id),
        "object_commit": hex::encode(object_commit(
            &scope_salt,
            &scope.color,
            scope.recipient_kind,
            &scope.recipient,
            scope.max_coin_value,
        )?),
        "spent_commit_at_issue": hex::encode(spent_commit(&scope_salt, 0)?),
        "rp_commit": hex::encode(rp_commit(&scope_salt, &scope.rp_id_hash)?),
        "scope_digest": hex::encode(scope_digest(&scope_salt, &scope)?),
    });
    if let Some(spent) = &req.spent {
        let spent: u128 = spent.parse().context("bad spent")?;
        out["spent_commit"] = json!(hex::encode(spent_commit(&scope_salt, spent)?));
    }
    // The three grant DSTs, so a caller can pin the challenge tags without
    // building a whole call.
    let marker = if arm == "k256" { "k1:" } else { "" };
    let mut dsts = serde_json::Map::new();
    for op in GRANT_OPERATIONS {
        dsts.insert(op.to_string(), json!(hex::encode(grant_dst(marker, op)?)));
    }
    out["grant_dsts"] = serde_json::Value::Object(dsts);

    // The lifecycle challenges the device signs, on the k256 device arm.
    if let Some(device) = &req.device {
        let device_sk = k256_signing_key_from_hex(&device.sk)?;
        let device_vk = device_sk.verifying_key();
        let (dx, dy) = pk_coords_le(device_vk)?;
        let auth_nonce: u64 = device.auth_nonce.parse().context("bad auth_nonce")?;
        let sd = scope_digest(&scope_salt, &scope)?;
        out["device_pk"] = k256_point_json(device_vk)?;
        out["lifecycle_challenges"] = json!({
            "auth_nonce": auth_nonce,
            "issue_grant": hex::encode(challenge_issue_grant_k256(
                &self_addr, &dx, &dy, &grant_id, &sd, auth_nonce,
            )?),
            "revoke_grant": hex::encode(challenge_revoke_grant_k256(
                &self_addr, &dx, &dy, &grant_id, auth_nonce,
            )?),
            "revoke_all_grants": hex::encode(challenge_revoke_all_grants_k256(
                &self_addr, &dx, &dy, auth_nonce,
            )?),
        });
    }
    Ok(out)
}

// ── A minimal SHA-256 writer for the one off-chain, unpadded derivation ────
//
// `origin_hash` prefixes a raw 32-byte pad to a variable-length ASCII
// string, so it has no Compact type and cannot go through the field-aligned
// encoding: a Bytes<N> atom would pad the client_id to N. The ledger's
// PersistentHashWriter is the same SHA-256, so it is reused directly rather
// than pulling a second hash crate into the binary target.

struct Sha256Writer(midnight_base_crypto::hash::PersistentHashWriter);

fn sha256_writer() -> Sha256Writer {
    Sha256Writer(midnight_base_crypto::hash::PersistentHashWriter::default())
}

impl Sha256Writer {
    fn update(&mut self, data: &[u8]) {
        use std::io::Write as _;
        self.0.write_all(data).expect("hash writer never fails");
    }

    fn finish(self) -> [u8; 32] {
        self.0.finalize().0
    }
}

// ── By-hand oracle checks and pinned vectors ───────────────────────────────
//
// Every grant preimage of the k1 arm is a tuple of Bytes and Uint atoms, so
// the field-aligned encoding reduces to each element zero-padded to its
// declared width and concatenated in order. The tests therefore recompute
// each derivation as plain SHA-256 over that concatenation, independently of
// the fab machinery, and pin the result against vectors computed outside
// this crate (`python3 .planning/grants-e1/grant-vectors.py`, recorded
// beside `verify-rs.md`), so a joint drift of both code paths still fails.
//
// Fixtures, chosen to match the ones the TypeScript side uses: pk = G (the
// sk = 1 key), self = 0x11 * 32, scope_salt = 0x22 * 32, slots 0 and 1, and
// origin_hash over "https://bank.example".

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const GX_BE: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const GY_BE: &str = "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

    const SELF: [u8; 32] = [0x11; 32];
    const SALT: [u8; 32] = [0x22; 32];
    const RECIPIENT: [u8; 32] = [0x33; 32];
    const COLOR: [u8; 32] = [0x44; 32];
    const READ_PK_HASH: [u8; 32] = [0x55; 32];
    const CHANGE_ENTRY: [u8; 192] = [0x66; 192];
    const ENC_PK: [u8; 32] = [0x77; 32];
    const COIN_NONCE: [u8; 32] = [0x88; 32];

    const CLIENT_ID: &str = "https://bank.example";

    const ISSUED_AT: u64 = 7;
    const RECORD_NONCE: u64 = 1;
    const AMOUNT: u128 = 500;
    const COIN_VALUE: u128 = 900_000;
    const COIN_MT_INDEX: u64 = 42;

    const RECIPIENT_KIND: u8 = 1;
    const MAX_COIN_VALUE: u128 = 1_000_000;
    const PER_CALL_CAP: u128 = 250_000;
    const CAP: u128 = 750_000;
    const EXPIRES_AT: u64 = 1_800_000_000;

    fn pad_to(width: usize, data: &[u8]) -> Vec<u8> {
        let mut v = data.to_vec();
        assert!(v.len() <= width);
        v.resize(width, 0);
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

    fn pk_le() -> ([u8; 32], [u8; 32]) {
        (coord_le(GX_BE), coord_le(GY_BE))
    }

    fn u16le(v: u128) -> Vec<u8> {
        v.to_le_bytes().to_vec()
    }

    fn u8le(v: u64) -> Vec<u8> {
        v.to_le_bytes().to_vec()
    }

    fn origin() -> [u8; 32] {
        origin_hash(CLIENT_ID).unwrap()
    }

    fn spend_scope() -> GrantScopePlain {
        GrantScopePlain {
            op_withdraw_unshielded: true,
            op_withdraw_shielded: true,
            op_withdraw_shielded_to_contract: false,
            read: true,
            color: COLOR,
            recipient_kind: RECIPIENT_KIND,
            recipient: RECIPIENT,
            max_coin_value: MAX_COIN_VALUE,
            per_call_cap: PER_CALL_CAP,
            cap: CAP,
            expires_at: EXPIRES_AT,
            rp_id_hash: [0u8; 32],
            read_pk_hash: READ_PK_HASH,
            window_len: 0,
            window_cap: 0,
        }
    }

    #[test]
    fn origin_hash_prefixes_an_unpadded_client_id() {
        let by_hand = sha256_concat(&[
            pad_to(32, b"midnight:account:grant:origin:v1"),
            CLIENT_ID.as_bytes().to_vec(),
        ]);
        assert_eq!(origin(), by_hand);
        assert_eq!(
            hex::encode(origin()),
            "5847018b6d2663a49e27bd119ba50c0d0fdb9ceec83f6dddcf4ae3be648dc780"
        );
        // Section 4.4 admits no non-ASCII byte, so an internationalised
        // host reaches this derivation already in punycode.
        assert!(origin_hash("https://bänk.example").is_err());
        assert!(origin_hash("").is_err());
        // The tag occupies exactly the 32-byte pad.
        assert_eq!("midnight:account:grant:origin:v1".len(), 32);
    }

    #[test]
    fn grant_id_k1_matches_the_by_hand_derivation_over_both_envelopes_and_slots() {
        let (x_le, y_le) = pk_le();
        for (envelope, slot, pinned) in [
            (0u8, 0u8, "78a01a6cfc96f71a02acaca1c3d94b1d6734c40be79d34775e757809b91b78c5"),
            (1u8, 0u8, "e055abd25d81ee7b8b41cf18477bddd594c6b3ac44fa13065d94668b207badde"),
            (0u8, 1u8, "51081f6e0f2816b7e7a7afe8da50ea112bd953b1e12d90f19b74cc42d528dead"),
            (1u8, 1u8, "2e5d554a8c7e5df7ab1f88ddd80c72469d3448d11df94ef07bfd58c7ef520a7e"),
        ] {
            let via_fab =
                grant_id_k256(&SELF, &x_le, &y_le, envelope, &origin(), slot).unwrap();
            let parts = [
                pad_to(32, b"midnight:account:grant:id:k1:v1"),
                SELF.to_vec(),
                x_le.to_vec(),
                y_le.to_vec(),
                vec![envelope],
                origin().to_vec(),
                vec![slot],
            ];
            // 162 preimage bytes, exactly as the MIP's width column states.
            assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 162);
            assert_eq!(via_fab, sha256_concat(&parts));
            assert_eq!(hex::encode(via_fab), pinned, "envelope {envelope} slot {slot}");
        }
    }

    #[test]
    fn grant_id_k1_separates_key_origin_slot_and_envelope() {
        let (x_le, y_le) = pk_le();
        let base = grant_id_k256(&SELF, &x_le, &y_le, 0, &origin(), 0).unwrap();
        let other_origin = origin_hash("https://bank.example:8443").unwrap();
        assert_ne!(base, grant_id_k256(&SELF, &x_le, &y_le, 1, &origin(), 0).unwrap());
        assert_ne!(base, grant_id_k256(&SELF, &x_le, &y_le, 0, &origin(), 1).unwrap());
        assert_ne!(
            base,
            grant_id_k256(&SELF, &x_le, &y_le, 0, &other_origin, 0).unwrap()
        );
        assert_ne!(base, grant_id_k256(&SALT, &x_le, &y_le, 0, &origin(), 0).unwrap());
        assert_ne!(base, grant_id_k256(&SELF, &y_le, &x_le, 0, &origin(), 0).unwrap());
    }

    /// A `Field` atom's binary representation, which is what fixes the
    /// 64-byte JubJub key element: `value_atom_as_field` reduces the atom
    /// modulo the BLS12-381 scalar prime and writes the canonical
    /// representative as exactly 32 little-endian bytes. The atom itself
    /// must arrive minimal (trailing zeros stripped) or the aligned value
    /// is rejected outright.
    fn el_field(le_bytes: &[u8; 32]) -> Element {
        let mut minimal = le_bytes.to_vec();
        while minimal.last() == Some(&0) {
            minimal.pop();
        }
        Element {
            atoms: vec![midnight_base_crypto::fab::ValueAtom(minimal)],
            alignment: vec![midnight_base_crypto::fab::AlignmentSegment::Atom(
                midnight_base_crypto::fab::AlignmentAtom::Field,
            )],
        }
    }

    #[test]
    fn a_field_atom_is_thirty_two_little_endian_bytes() {
        let mut five = [0u8; 32];
        five[0] = 5;
        assert_eq!(
            persistent_hash(&[el_field(&five)]).unwrap(),
            sha256_concat(&[five.to_vec()])
        );
        // A value at or above the modulus is REDUCED before it is written,
        // so a synthetic coordinate must stay below it to be a vector.
        let over = [0x99u8; 32];
        assert_ne!(
            persistent_hash(&[el_field(&over)]).unwrap(),
            sha256_concat(&[over.to_vec()])
        );
    }

    #[test]
    fn grant_id_v1_binds_a_sixty_four_byte_key_element() {
        // The JubJub key element is two field atoms, so the preimage is 161
        // bytes and not the 129 the MIP text states. Pinned over a
        // synthetic (x, y) pair, which is what fixes the width; both
        // coordinates sit below the scalar modulus, so each is written as
        // its full 32 little-endian bytes.
        let x: [u8; 32] = {
            let mut v = [0x99u8; 32];
            v[31] = 0x12;
            v
        };
        let y: [u8; 32] = {
            let mut v = [0xAAu8; 32];
            v[31] = 0x34;
            v
        };
        for (slot, pinned) in [
            (0u8, "c0e233c0984076b1bb2ed5ee078895bbefa6ec9ee1a6f1f8b664c289407f024b"),
            (1u8, "d13e2a28c592b1be3d49b784ed45b4becf7c18bd0b2c222843a23dcab8bf9974"),
        ] {
            let via_fab = persistent_hash(&[
                el_bytes(32, &pad_to(32, b"midnight:account:grant:id:v1")),
                el_bytes(32, &SELF),
                el_field(&x),
                el_field(&y),
                el_bytes(32, &origin()),
                el_uint(1, u128::from(slot)),
            ])
            .unwrap();
            let parts = [
                pad_to(32, b"midnight:account:grant:id:v1"),
                SELF.to_vec(),
                x.to_vec(),
                y.to_vec(),
                origin().to_vec(),
                vec![slot],
            ];
            assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 161);
            assert_eq!(via_fab, sha256_concat(&parts));
            assert_eq!(hex::encode(via_fab), pinned, "slot {slot}");
        }
    }

    #[test]
    fn grant_id_v1_over_a_real_point_matches_the_by_hand_derivation() {
        use group::Group as _;
        use midnight_curves::{Fr as JubjubScalar, JubjubSubgroup};
        let sk = JubjubScalar::from(5u64);
        let pk = EmbeddedGroupAffine(JubjubSubgroup::generator() * sk);
        let x: [u8; 32] = pk.x().unwrap().as_le_bytes().try_into().unwrap();
        let y: [u8; 32] = pk.y().unwrap().as_le_bytes().try_into().unwrap();
        // The coordinates of [5]G, so that the pinned identities below rest
        // on curve data rather than on a synthetic pair.
        assert_eq!(
            hex::encode(x),
            "7f384d6b3130c69d1a83d4f068e399e66445c55424196d07c8a99888d458c865"
        );
        assert_eq!(
            hex::encode(y),
            "76291dc83cbd77fc4e28e612d0dd26d6b0fa040a4d651ad8c1c6e25419b1e639"
        );
        for (slot, pinned) in [
            (0u8, "bdf326f496bb41198c764d8b2b25a3895d41b89d025d19159cc4150aeced384d"),
            (1u8, "b51cea4deb5a20886a9ec0bb9292ec1255107f6b06c0e5a7a5ee4c0b2248ecb8"),
        ] {
            let via_fab = grant_id_jubjub(&SELF, &pk, &origin(), slot).unwrap();
            let parts = [
                pad_to(32, b"midnight:account:grant:id:v1"),
                SELF.to_vec(),
                x.to_vec(),
                y.to_vec(),
                origin().to_vec(),
                vec![slot],
            ];
            assert_eq!(via_fab, sha256_concat(&parts));
            assert_eq!(hex::encode(via_fab), pinned, "slot {slot}");
        }
    }

    #[test]
    fn grant_id_v1_does_not_reject_the_jubjub_identity() {
        use group::Group as _;
        use midnight_curves::JubjubSubgroup;
        // The JubJub identity is the ordinary affine point (0, 1), so it
        // carries coordinates and derives an identity like any other point.
        // Nothing in the identity recipe rejects it: the [8]pk != O guard of
        // section 3.3 is the ONLY rejection, and an implementation that
        // lifts this derivation without the guard admits a key that
        // authorises with no secret.
        let identity = EmbeddedGroupAffine(JubjubSubgroup::identity());
        assert_eq!(hex::encode(identity.x().unwrap().as_le_bytes()), "00".repeat(32));
        let mut one = [0u8; 32];
        one[0] = 1;
        assert_eq!(identity.y().unwrap().as_le_bytes(), one.to_vec());
        let id = grant_id_jubjub(&SELF, &identity, &origin(), 0).unwrap();
        assert_eq!(
            id,
            sha256_concat(&[
                pad_to(32, b"midnight:account:grant:id:v1"),
                SELF.to_vec(),
                vec![0u8; 32],
                one.to_vec(),
                origin().to_vec(),
                vec![0u8],
            ])
        );
        assert_eq!(
            hex::encode(id),
            "64de12ffba15ac106daa3f69dddd76962099cd1ffe7750d718e5fbadbcddd36e"
        );
    }

    #[test]
    fn object_commit_matches_the_by_hand_derivation_pinned_and_read_only() {
        let via_fab =
            object_commit(&SALT, &COLOR, RECIPIENT_KIND, &RECIPIENT, MAX_COIN_VALUE).unwrap();
        let parts = [
            pad_to(32, b"midnight:account:grant:obj:v1"),
            SALT.to_vec(),
            COLOR.to_vec(),
            vec![RECIPIENT_KIND],
            RECIPIENT.to_vec(),
            u16le(MAX_COIN_VALUE),
        ];
        assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 145);
        assert_eq!(via_fab, sha256_concat(&parts));
        assert_eq!(
            hex::encode(via_fab),
            "ba9f6b1467398fd51dc82444e43bb284fff931fad517202eb9e9cbca08d4ba6c"
        );

        // Issue rule 7: a read-only grant carries all-zero object fields,
        // so the commitment is determined by scope_salt alone.
        let read_only = object_commit(&SALT, &[0u8; 32], 0, &[0u8; 32], 0).unwrap();
        assert_eq!(
            read_only,
            sha256_concat(&[
                pad_to(32, b"midnight:account:grant:obj:v1"),
                SALT.to_vec(),
                vec![0u8; 32],
                vec![0u8],
                vec![0u8; 32],
                vec![0u8; 16],
            ])
        );
        assert_eq!(
            hex::encode(read_only),
            "592b75aaccbe67f2bc72cb1bd21074a4d340f7cf1df6469171047e2032d0183c"
        );
    }

    #[test]
    fn spent_commit_matches_the_by_hand_derivation_at_zero_and_after_a_call() {
        for (spent, pinned) in [
            (0u128, "dab069416750cc667e22bff8ee7692711dd013951096456a30886ee7f546455c"),
            (200u128, "fd25f634ad76002a01eee4c1298bf8e15f2d06936deef5373f311396a26332bb"),
        ] {
            let via_fab = spent_commit(&SALT, spent).unwrap();
            let parts = [
                pad_to(32, b"midnight:account:grant:spent:v1"),
                SALT.to_vec(),
                u16le(spent),
            ];
            assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 80);
            assert_eq!(via_fab, sha256_concat(&parts));
            assert_eq!(hex::encode(via_fab), pinned, "spent {spent}");
        }
    }

    #[test]
    fn rp_commit_matches_the_by_hand_derivation_for_an_r1_and_a_non_r1_grant() {
        // Non-r1 grants commit to an all-zero rp_id_hash, so the record
        // reveals neither the host nor the arm.
        let zero = rp_commit(&SALT, &[0u8; 32]).unwrap();
        assert_eq!(
            zero,
            sha256_concat(&[
                pad_to(32, b"midnight:account:grant:rp:v1"),
                SALT.to_vec(),
                vec![0u8; 32],
            ])
        );
        assert_eq!(
            hex::encode(zero),
            "f8862c6c81c8e4a8654c365502bae5feb06221c260ff64fcf2dd62ed6145f55f"
        );

        // An r1 grant commits to SHA-256 of the dApp host, bare.
        let rp_id_hash: [u8; 32] = sha256_concat(&[b"bank.example".to_vec()]);
        assert_eq!(
            hex::encode(rp_id_hash),
            "05be55af508c5555d806d5bd5490f5e21dab9a101b88367f8d1d063f8c3bfc3f"
        );
        let r1 = rp_commit(&SALT, &rp_id_hash).unwrap();
        let parts = [
            pad_to(32, b"midnight:account:grant:rp:v1"),
            SALT.to_vec(),
            rp_id_hash.to_vec(),
        ];
        assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 96);
        assert_eq!(r1, sha256_concat(&parts));
        assert_eq!(
            hex::encode(r1),
            "f9f28fe85ebd4dec192a938ddbdd2537979b5b1a04d39a0a22566de249e56f19"
        );
        assert_ne!(zero, r1);
    }

    #[test]
    fn scope_digest_matches_the_by_hand_derivation_with_flags_as_single_bytes() {
        let scope = spend_scope();
        let via_fab = scope_digest(&SALT, &scope).unwrap();
        let parts = [
            pad_to(32, b"midnight:account:grant:scope:v1"),
            SALT.to_vec(),
            vec![0x01],
            vec![0x01],
            vec![0x00],
            vec![0x01],
            COLOR.to_vec(),
            vec![RECIPIENT_KIND],
            RECIPIENT.to_vec(),
            u16le(MAX_COIN_VALUE),
            u16le(PER_CALL_CAP),
            u16le(CAP),
            u8le(EXPIRES_AT),
            vec![0u8; 32],
            READ_PK_HASH.to_vec(),
            u8le(0),
            u16le(0),
        ];
        // Seventeen elements, 277 preimage bytes.
        assert_eq!(parts.len(), 17);
        assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 277);
        assert_eq!(via_fab, sha256_concat(&parts));
        assert_eq!(
            hex::encode(via_fab),
            "9c314030d3312495526ec32b9e6e32544486716e063662b891cb1515f9859089"
        );

        let read_only = scope_digest(&SALT, &GrantScopePlain::read_only(READ_PK_HASH)).unwrap();
        assert_eq!(
            hex::encode(read_only),
            "221d585f16e8aa25be1644bd38d577d32f03b1709d99fb1bfb5b7e5b9b98ce33"
        );

        let mut all_flags = spend_scope();
        all_flags.op_withdraw_shielded_to_contract = true;
        all_flags.rp_id_hash = sha256_concat(&[b"bank.example".to_vec()]);
        assert_eq!(
            hex::encode(scope_digest(&SALT, &all_flags).unwrap()),
            "2343559d2e91ff6a9a3e76bcfae275007dcf0ef39a404b2101f3944ec309741c"
        );
    }

    #[test]
    fn scope_digest_separates_every_flag_pattern() {
        let mut seen = std::collections::BTreeSet::new();
        for bits in 0u8..16 {
            let mut scope = spend_scope();
            scope.op_withdraw_unshielded = bits & 1 != 0;
            scope.op_withdraw_shielded = bits & 2 != 0;
            scope.op_withdraw_shielded_to_contract = bits & 4 != 0;
            scope.read = bits & 8 != 0;
            assert!(seen.insert(scope_digest(&SALT, &scope).unwrap()));
        }
        assert_eq!(seen.len(), 16);
    }

    #[test]
    fn grant_challenge_dsts_are_hashed_from_a_sixty_four_byte_pad() {
        for (operation, pinned) in [
            (
                "withdraw_unshielded",
                "8a111557ca841ea1d7f2fa91587e43efbc539d51d55646c7f4a0ece9db26ef68",
            ),
            (
                "withdraw_shielded",
                "c72a77bb12353e6620ca854f692abbf852218e12e058e5bf900554a833842156",
            ),
            (
                "withdraw_shielded_to_contract",
                "572ef9a44cfd4a55f852b12ee7834d82a1f2e00d798e148ed9e806afaedeb7f4",
            ),
        ] {
            let tag = format!("midnight:account:grant:auth:k1:v1:{operation}");
            let via_fab = grant_dst("k1:", operation).unwrap();
            assert_eq!(via_fab, sha256_concat(&[pad_to(64, tag.as_bytes())]));
            assert_eq!(hex::encode(via_fab), pinned, "{operation}");
            // The 64-byte pad is a normative budget on operation names.
            assert!(tag.len() <= 64, "{tag} is {} bytes", tag.len());
        }
        // The longest registered member occupies 63 of the 64 bytes.
        assert_eq!(
            "midnight:account:grant:auth:k1:v1:withdraw_shielded_to_contract".len(),
            63
        );
        assert!(grant_dst("k1:", "rotate_enc_key").is_err());
        // The v1 marker is empty, and its tags are shorter still.
        assert_ne!(
            grant_dst("", "withdraw_unshielded").unwrap(),
            grant_dst("k1:", "withdraw_unshielded").unwrap()
        );
    }

    fn head() -> GrantCallHead {
        let (pk_x_le, pk_y_le) = pk_le();
        let grant_id = grant_id_k256(&SELF, &pk_x_le, &pk_y_le, 0, &origin(), 0).unwrap();
        GrantCallHead {
            self_addr: SELF,
            pk_x_le,
            pk_y_le,
            grant_id,
            issued_at: ISSUED_AT,
            record_nonce: RECORD_NONCE,
        }
    }

    #[test]
    fn unshielded_grant_challenge_matches_the_by_hand_derivation() {
        let h = head();
        let via_fab =
            challenge_withdraw_unshielded_with_grant_k256(&h, &COLOR, AMOUNT, &RECIPIENT)
                .unwrap();
        let parts = [
            grant_dst("k1:", "withdraw_unshielded").unwrap().to_vec(),
            SELF.to_vec(),
            h.pk_x_le.to_vec(),
            h.pk_y_le.to_vec(),
            h.grant_id.to_vec(),
            u8le(ISSUED_AT),
            COLOR.to_vec(),
            u16le(AMOUNT),
            RECIPIENT.to_vec(),
            u8le(RECORD_NONCE),
        ];
        // Ten elements, 256 preimage bytes, no witness value and no
        // signature material.
        assert_eq!(parts.len(), 10);
        assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 256);
        assert_eq!(via_fab, sha256_concat(&parts));
        assert_eq!(
            hex::encode(via_fab),
            "4ad304905a091873c874fc5c14186382a540011ea489cbd52a0a14cec74648fa"
        );
    }

    #[test]
    fn shielded_grant_challenge_matches_the_by_hand_derivation() {
        let h = head();
        let coin = QualifiedCoin {
            nonce: COIN_NONCE,
            color: COLOR,
            value: COIN_VALUE,
            mt_index: COIN_MT_INDEX,
        };
        let via_fab = challenge_withdraw_shielded_with_grant_k256(
            "withdraw_shielded",
            &h,
            &RECIPIENT,
            &COLOR,
            AMOUNT,
            &CHANGE_ENTRY,
            &ENC_PK,
            &coin,
        )
        .unwrap();
        let parts = [
            grant_dst("k1:", "withdraw_shielded").unwrap().to_vec(),
            SELF.to_vec(),
            h.pk_x_le.to_vec(),
            h.pk_y_le.to_vec(),
            h.grant_id.to_vec(),
            u8le(ISSUED_AT),
            RECIPIENT.to_vec(),
            COLOR.to_vec(),
            u16le(AMOUNT),
            CHANGE_ENTRY.to_vec(),
            ENC_PK.to_vec(),
            COIN_NONCE.to_vec(),
            COLOR.to_vec(),
            u16le(COIN_VALUE),
            u8le(COIN_MT_INDEX),
            u8le(RECORD_NONCE),
        ];
        // Thirteen declared elements: the qualified coin is one struct
        // member and flattens into four atoms, so sixteen atoms and 568
        // preimage bytes.
        assert_eq!(parts.len(), 16);
        assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 568);
        assert_eq!(via_fab, sha256_concat(&parts));
        assert_eq!(
            hex::encode(via_fab),
            "748b3a10f93659d7ef04c74dfd2864c6ddf22b40fd5723e06bb73ffb87afe774"
        );

        // The DST is the only difference to the to-contract twin.
        let to_contract = challenge_withdraw_shielded_with_grant_k256(
            "withdraw_shielded_to_contract",
            &h,
            &RECIPIENT,
            &COLOR,
            AMOUNT,
            &CHANGE_ENTRY,
            &ENC_PK,
            &coin,
        )
        .unwrap();
        assert_ne!(via_fab, to_contract);
        assert!(challenge_withdraw_shielded_with_grant_k256(
            "withdraw_unshielded",
            &h,
            &RECIPIENT,
            &COLOR,
            AMOUNT,
            &CHANGE_ENTRY,
            &ENC_PK,
            &coin,
        )
        .is_err());
    }

    #[test]
    fn every_challenge_input_changes_the_challenge() {
        let h = head();
        let base =
            challenge_withdraw_unshielded_with_grant_k256(&h, &COLOR, AMOUNT, &RECIPIENT).unwrap();
        // GR-5: the record's nonce is bound, so an identical resubmission
        // signs a different challenge.
        let mut next = h.clone();
        next.record_nonce = RECORD_NONCE + 1;
        assert_ne!(
            base,
            challenge_withdraw_unshielded_with_grant_k256(&next, &COLOR, AMOUNT, &RECIPIENT)
                .unwrap()
        );
        // GR-6: issued_at isolates incarnations of the same grant_id.
        let mut reissued = h.clone();
        reissued.issued_at = ISSUED_AT + 1;
        assert_ne!(
            base,
            challenge_withdraw_unshielded_with_grant_k256(&reissued, &COLOR, AMOUNT, &RECIPIENT)
                .unwrap()
        );
        // GR-4: every operation argument is covered.
        assert_ne!(
            base,
            challenge_withdraw_unshielded_with_grant_k256(&h, &RECIPIENT, AMOUNT, &RECIPIENT)
                .unwrap()
        );
        assert_ne!(
            base,
            challenge_withdraw_unshielded_with_grant_k256(&h, &COLOR, AMOUNT + 1, &RECIPIENT)
                .unwrap()
        );
        assert_ne!(
            base,
            challenge_withdraw_unshielded_with_grant_k256(&h, &COLOR, AMOUNT, &COLOR).unwrap()
        );
        // A foreign grant_id, which is what a wrong envelope or slot
        // produces, changes the challenge as well as the membership lookup.
        let mut foreign = h.clone();
        foreign.grant_id = [0u8; 32];
        assert_ne!(
            base,
            challenge_withdraw_unshielded_with_grant_k256(&foreign, &COLOR, AMOUNT, &RECIPIENT)
                .unwrap()
        );
    }

    #[test]
    fn shielded_witness_values_are_bound_element_by_element() {
        let h = head();
        let coin = QualifiedCoin {
            nonce: COIN_NONCE,
            color: COLOR,
            value: COIN_VALUE,
            mt_index: COIN_MT_INDEX,
        };
        let sign = |c: &QualifiedCoin, change: &[u8; 192], enc: &[u8; 32]| {
            challenge_withdraw_shielded_with_grant_k256(
                "withdraw_shielded",
                &h,
                &RECIPIENT,
                &COLOR,
                AMOUNT,
                change,
                enc,
                c,
            )
            .unwrap()
        };
        let base = sign(&coin, &CHANGE_ENTRY, &ENC_PK);
        for mutated in [
            QualifiedCoin { nonce: [0x89; 32], ..coin.clone() },
            QualifiedCoin { color: [0x45; 32], ..coin.clone() },
            QualifiedCoin { value: COIN_VALUE + 1, ..coin.clone() },
            QualifiedCoin { mt_index: COIN_MT_INDEX + 1, ..coin.clone() },
        ] {
            assert_ne!(base, sign(&mutated, &CHANGE_ENTRY, &ENC_PK));
        }
        let mut other_change = CHANGE_ENTRY;
        other_change[191] = 0x67;
        assert_ne!(base, sign(&coin, &other_change, &ENC_PK));
        assert_ne!(base, sign(&coin, &CHANGE_ENTRY, &[0x78; 32]));
    }

    #[test]
    fn sign_grant_signs_the_envelope_digest_of_the_grant_challenge() {
        // The envelope is bound into `grant_id` as well as into the signed
        // message, so the two envelopes are NOT two wrappings of one
        // challenge: an envelope-1 grantee has a different grant_id and
        // therefore a different challenge. Both legs are pinned.
        //
        // Note that section 3.2 restricts an envelope-1 grantee to `read`
        // scopes, so the envelope-1 rows here are recipe vectors rather
        // than conforming calls.
        for (envelope, circuit, pinned_challenge, pinned_digest) in [
            (
                0u8,
                "withdraw_unshielded",
                "4ad304905a091873c874fc5c14186382a540011ea489cbd52a0a14cec74648fa",
                "98bb58eaefa10fa8d537498252726513f69ce7c9fe35dabb48bed264b084cae7",
            ),
            (
                1u8,
                "withdraw_unshielded",
                "023e0a0b2ec71d294da683f31214592e009a9213ecc1e21901cc224d73c018b5",
                "de768bec443624b137f0a636f6d56b0dd189a2d8a23e9525ba61e3f35f6f6fc3",
            ),
            (
                0u8,
                "withdraw_shielded",
                "748b3a10f93659d7ef04c74dfd2864c6ddf22b40fd5723e06bb73ffb87afe774",
                "f88c2a896688da182663d87a08e513f4f696477cf916ebddc7bc2acc84a70b05",
            ),
            (
                1u8,
                "withdraw_shielded",
                "0afce0cbe3a5146e6edb9f35b5d6faad961a3dcb0a86d1ee70ceeea26a73476a",
                "f95eb669a14bca6f9984972fc688a6ae972cf65361f52108e6c01e03acee04a1",
            ),
        ] {
            let req = GrantSignRequest {
                arm: Some("k256".into()),
                circuit: circuit.into(),
                sk: "0x01".into(),
                envelope,
                contract_address: hex::encode(SELF),
                client_id: Some(CLIENT_ID.into()),
                origin_hash: None,
                slot: 0,
                issued_at: ISSUED_AT.to_string(),
                grant_nonce: RECORD_NONCE.to_string(),
                color: hex::encode(COLOR),
                amount: AMOUNT.to_string(),
                recipient: hex::encode(RECIPIENT),
                change_entry: Some(hex::encode(CHANGE_ENTRY)),
                enc_pk: Some(hex::encode(ENC_PK)),
                coin: Some(QualifiedCoinJson {
                    nonce: hex::encode(COIN_NONCE),
                    color: hex::encode(COLOR),
                    value: COIN_VALUE.to_string(),
                    mt_index: COIN_MT_INDEX.to_string(),
                }),
            };
            let out = sign_grant(&req).unwrap();
            let challenge = out["challenge"].as_str().unwrap().to_string();
            let digest = out["digest"].as_str().unwrap().to_string();
            let label = format!("{circuit} envelope {envelope}");
            assert_eq!(challenge, pinned_challenge, "{label}");
            assert_eq!(digest, pinned_digest, "{label}");

            // The envelope wraps the challenge and never replaces it.
            let challenge_bytes: [u8; 32] =
                hex::decode(&challenge).unwrap().try_into().unwrap();
            let expected = if envelope == 0 {
                sha256_concat(&[challenge_bytes.to_vec()])
            } else {
                sha256_concat(&[
                    b"midnight_signed_message:32:".to_vec(),
                    challenge_bytes.to_vec(),
                ])
            };
            assert_eq!(hex::decode(&digest).unwrap(), expected.to_vec(), "{label}");

            // grant_id is recomputed from the presented key, with the
            // envelope bound into it.
            let (x_le, y_le) = pk_le();
            assert_eq!(
                out["grant_id"].as_str().unwrap(),
                hex::encode(grant_id_k256(&SELF, &x_le, &y_le, envelope, &origin(), 0).unwrap()),
                "{label}"
            );

            // The emitted signature verifies over the digest, not over the
            // challenge.
            let sig = Signature::from_scalars(
                <[u8; 32]>::try_from(
                    hex::decode(out["sig"]["r"].as_str().unwrap().trim_start_matches("0x"))
                        .unwrap(),
                )
                .unwrap(),
                <[u8; 32]>::try_from(
                    hex::decode(out["sig"]["s"].as_str().unwrap().trim_start_matches("0x"))
                        .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
            let vk = *k256_signing_key_from_hex("0x01").unwrap().verifying_key();
            let digest_bytes: [u8; 32] = hex::decode(&digest).unwrap().try_into().unwrap();
            assert!(vk.verify_prehash(&digest_bytes, &sig).is_ok(), "{label}");
            assert!(vk.verify_prehash(&challenge_bytes, &sig).is_err(), "{label}");
        }
    }

    #[test]
    fn sign_grant_refuses_incomplete_and_unsupported_requests() {
        let base = || GrantSignRequest {
            arm: Some("k256".into()),
            circuit: "withdraw_shielded".into(),
            sk: "0x01".into(),
            envelope: 0,
            contract_address: hex::encode(SELF),
            client_id: Some(CLIENT_ID.into()),
            origin_hash: None,
            slot: 0,
            issued_at: ISSUED_AT.to_string(),
            grant_nonce: RECORD_NONCE.to_string(),
            color: hex::encode(COLOR),
            amount: AMOUNT.to_string(),
            recipient: hex::encode(RECIPIENT),
            change_entry: None,
            enc_pk: None,
            coin: None,
        };
        // A shielded twin needs the change entry, enc_pk, and the coin.
        assert!(sign_grant(&base()).is_err());
        // The jubjub grantee arm is stage-two work.
        let mut jubjub = base();
        jubjub.arm = Some("jubjub".into());
        assert!(sign_grant(&jubjub).is_err());
        // An unknown envelope id aborts, as it does in the circuit.
        let mut bad_envelope = base();
        bad_envelope.circuit = "withdraw_unshielded".into();
        bad_envelope.envelope = 2;
        assert!(sign_grant(&bad_envelope).is_err());
        // Exactly one of client_id and origin_hash.
        let mut both = base();
        both.circuit = "withdraw_unshielded".into();
        both.origin_hash = Some(hex::encode([0u8; 32]));
        assert!(sign_grant(&both).is_err());
        let mut neither = base();
        neither.circuit = "withdraw_unshielded".into();
        neither.client_id = None;
        assert!(sign_grant(&neither).is_err());
        // origin_hash given directly is accepted.
        let mut direct = base();
        direct.circuit = "withdraw_unshielded".into();
        direct.client_id = None;
        direct.origin_hash = Some(hex::encode(origin()));
        let out = sign_grant(&direct).unwrap();
        assert_eq!(
            out["challenge"].as_str().unwrap(),
            "4ad304905a091873c874fc5c14186382a540011ea489cbd52a0a14cec74648fa"
        );
    }

    #[test]
    fn derive_grant_emits_the_lifecycle_challenges_and_the_v1_identity_over_both_paths() {
        let scope = ScopeJson {
            op_withdraw_unshielded: true,
            op_withdraw_shielded: true,
            op_withdraw_shielded_to_contract: false,
            read: true,
            color: hex::encode(COLOR),
            recipient_kind: RECIPIENT_KIND,
            recipient: hex::encode(RECIPIENT),
            max_coin_value: MAX_COIN_VALUE.to_string(),
            per_call_cap: PER_CALL_CAP.to_string(),
            cap: CAP.to_string(),
            expires_at: EXPIRES_AT.to_string(),
            rp_id_hash: hex::encode([0u8; 32]),
            read_pk_hash: hex::encode(READ_PK_HASH),
            window_len: String::new(),
            window_cap: String::new(),
        };
        // k256 grantee (sk = 1), k256 device (sk = 2), auth_nonce 7.
        let req = DeriveGrantRequest {
            arm: Some("k256".into()),
            sk: "0x01".into(),
            envelope: 0,
            contract_address: hex::encode(SELF),
            client_id: Some(CLIENT_ID.into()),
            origin_hash: None,
            slot: 0,
            scope_salt: hex::encode(SALT),
            scope,
            spent: Some("200".into()),
            device: Some(DeviceJson {
                sk: "0x02".into(),
                auth_nonce: "7".into(),
            }),
        };
        let out = derive_grant(&req).unwrap();
        let (x_le, y_le) = pk_le();
        let gid = grant_id_k256(&SELF, &x_le, &y_le, 0, &origin(), 0).unwrap();
        assert_eq!(out["grant_id"].as_str().unwrap(), hex::encode(gid));
        let sd = scope_digest(&SALT, &spend_scope()).unwrap();
        assert_eq!(out["scope_digest"].as_str().unwrap(), hex::encode(sd));
        assert_eq!(
            out["spent_commit"].as_str().unwrap(),
            hex::encode(spent_commit(&SALT, 200).unwrap())
        );
        let device_vk = *k256_signing_key_from_hex("0x02").unwrap().verifying_key();
        let (dx, dy) = pk_coords_le(&device_vk).unwrap();
        let lc = &out["lifecycle_challenges"];
        assert_eq!(lc["auth_nonce"].as_u64().unwrap(), 7);
        assert_eq!(
            lc["issue_grant"].as_str().unwrap(),
            hex::encode(challenge_issue_grant_k256(&SELF, &dx, &dy, &gid, &sd, 7).unwrap())
        );
        assert_eq!(
            lc["revoke_grant"].as_str().unwrap(),
            hex::encode(challenge_revoke_grant_k256(&SELF, &dx, &dy, &gid, 7).unwrap())
        );
        assert_eq!(
            lc["revoke_all_grants"].as_str().unwrap(),
            hex::encode(challenge_revoke_all_grants_k256(&SELF, &dx, &dy, 7).unwrap())
        );

        // The jubjub grantee arm: [5]G, pinned identity, both paths agree
        // inside derive_grant.
        let mut v1 = DeriveGrantRequest {
            arm: Some("jubjub".into()),
            sk: "0x05".into(),
            envelope: 0,
            contract_address: hex::encode(SELF),
            client_id: Some(CLIENT_ID.into()),
            origin_hash: None,
            slot: 0,
            scope_salt: hex::encode(SALT),
            scope: ScopeJson {
                op_withdraw_unshielded: true,
                op_withdraw_shielded: true,
                op_withdraw_shielded_to_contract: false,
                read: true,
                color: hex::encode(COLOR),
                recipient_kind: RECIPIENT_KIND,
                recipient: hex::encode(RECIPIENT),
                max_coin_value: MAX_COIN_VALUE.to_string(),
                per_call_cap: PER_CALL_CAP.to_string(),
                cap: CAP.to_string(),
                expires_at: EXPIRES_AT.to_string(),
                rp_id_hash: hex::encode([0u8; 32]),
                read_pk_hash: hex::encode(READ_PK_HASH),
                window_len: String::new(),
                window_cap: String::new(),
            },
            spent: None,
            device: None,
        };
        let out = derive_grant(&v1).unwrap();
        assert_eq!(
            out["grant_id"].as_str().unwrap(),
            "bdf326f496bb41198c764d8b2b25a3895d41b89d025d19159cc4150aeced384d"
        );
        assert!(out.get("lifecycle_challenges").is_none());
        v1.slot = 1;
        assert_eq!(
            derive_grant(&v1).unwrap()["grant_id"].as_str().unwrap(),
            "b51cea4deb5a20886a9ec0bb9292ec1255107f6b06c0e5a7a5ee4c0b2248ecb8"
        );
    }

    #[test]
    fn lifecycle_challenges_match_the_by_hand_derivation_in_the_device_family() {
        let (x_le, y_le) = pk_le();
        let gid = grant_id_k256(&SELF, &x_le, &y_le, 0, &origin(), 0).unwrap();
        let sd = scope_digest(&SALT, &spend_scope()).unwrap();
        let dst = |circuit: &str| {
            sha256_concat(&[pad_to(
                64,
                format!("midnight:account:auth:k1:v1:{circuit}").as_bytes(),
            )])
        };

        let issue = challenge_issue_grant_k256(&SELF, &x_le, &y_le, &gid, &sd, 1).unwrap();
        let parts = [
            dst("issue_grant").to_vec(),
            SELF.to_vec(),
            x_le.to_vec(),
            y_le.to_vec(),
            gid.to_vec(),
            sd.to_vec(),
            u8le(1),
        ];
        assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 200);
        assert_eq!(issue, sha256_concat(&parts));

        let revoke = challenge_revoke_grant_k256(&SELF, &x_le, &y_le, &gid, 2).unwrap();
        let parts = [
            dst("revoke_grant").to_vec(),
            SELF.to_vec(),
            x_le.to_vec(),
            y_le.to_vec(),
            gid.to_vec(),
            u8le(2),
        ];
        assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 168);
        assert_eq!(revoke, sha256_concat(&parts));

        let revoke_all = challenge_revoke_all_grants_k256(&SELF, &x_le, &y_le, 3).unwrap();
        let parts = [
            dst("revoke_all_grants").to_vec(),
            SELF.to_vec(),
            x_le.to_vec(),
            y_le.to_vec(),
            u8le(3),
        ];
        assert_eq!(parts.iter().map(Vec::len).sum::<usize>(), 136);
        assert_eq!(revoke_all, sha256_concat(&parts));

        // The three families are disjoint from one another and from the
        // grantee family over the same key (AUTH-3).
        let head = GrantCallHead {
            self_addr: SELF,
            pk_x_le: x_le,
            pk_y_le: y_le,
            grant_id: gid,
            issued_at: 1,
            record_nonce: 1,
        };
        let grantee =
            challenge_withdraw_unshielded_with_grant_k256(&head, &COLOR, AMOUNT, &RECIPIENT)
                .unwrap();
        let all = [issue, revoke, revoke_all, grantee];
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i], all[j]);
            }
        }
    }

    #[test]
    fn grant_id_v1_from_wire_coordinates_agrees_with_the_point_path() {
        use group::Group as _;
        use midnight_curves::{Fr as JubjubScalar, JubjubSubgroup};
        for sk in [1u64, 5, 12345] {
            let pk = EmbeddedGroupAffine(JubjubSubgroup::generator() * JubjubScalar::from(sk));
            let x: [u8; 32] = pk.x().unwrap().as_le_bytes().try_into().unwrap();
            let y: [u8; 32] = pk.y().unwrap().as_le_bytes().try_into().unwrap();
            for slot in [0u8, 1] {
                assert_eq!(
                    grant_id_jubjub_coords(&SELF, &x, &y, &origin(), slot).unwrap(),
                    grant_id_jubjub(&SELF, &pk, &origin(), slot).unwrap(),
                    "sk {sk} slot {slot}"
                );
            }
        }
        // The identity (0, 1) is a well-formed pair of canonical coordinates
        // and is refused by section 3.3 only, never by the identity recipe.
        let mut one = [0u8; 32];
        one[0] = 1;
        assert_eq!(
            hex::encode(grant_id_jubjub_coords(&SELF, &[0u8; 32], &one, &origin(), 0).unwrap()),
            "64de12ffba15ac106daa3f69dddd76962099cd1ffe7750d718e5fbadbcddd36e"
        );
        // A coordinate at or above the modulus is not a wire form of any
        // point and is refused rather than reduced.
        assert!(grant_id_jubjub_coords(&SELF, &[0x99u8; 32], &one, &origin(), 0).is_err());
        assert!(
            grant_id_jubjub_coords(&SELF, &BLS12_381_SCALAR_MODULUS_LE, &one, &origin(), 0)
                .is_err()
        );
        let mut modulus_minus_one = BLS12_381_SCALAR_MODULUS_LE;
        modulus_minus_one[0] = 0;
        assert!(
            grant_id_jubjub_coords(&SELF, &modulus_minus_one, &one, &origin(), 0).is_ok()
        );
    }

    /// The cross-implementation vector file the TypeScript suite writes
    /// (`npm run test:unit`, section `[grant]`) is recomputed here from its
    /// own arguments through this crate's independent recipe implementation.
    /// Every vector in the file was pinned against the compiled pure circuit,
    /// so agreement here closes the triangle: pure circuit, TypeScript
    /// by-hand recipe, Rust recipe.
    #[test]
    fn typescript_vectors_reproduce_from_their_own_arguments() {
        use k256::elliptic_curve::PrimeField as _;
        use serde_json::Value;

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/tests/vectors/grants-e1.json"
        );
        let text = std::fs::read_to_string(path)
            .expect("src/tests/vectors/grants-e1.json is written by `npm run test:unit`");
        let doc: Value = serde_json::from_str(&text).unwrap();

        let h32 = |v: &Value| -> [u8; 32] {
            hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap()
        };
        let uint = |v: &Value| -> u128 { v.as_str().unwrap().parse().unwrap() };
        let small = |v: &Value| -> u8 { u8::try_from(v.as_u64().unwrap()).unwrap() };
        let flag = |v: &Value| -> bool { v.as_bool().unwrap() };

        // The file records the k1 and v1 keys it used; both are sk = 1.
        let (gx, gy) = pk_le();
        assert_eq!(h32(&doc["fixtures"]["pk_k1"]["x_le"]), gx);
        assert_eq!(h32(&doc["fixtures"]["pk_k1"]["y_le"]), gy);
        {
            use group::Group as _;
            use midnight_curves::JubjubSubgroup;
            let g = EmbeddedGroupAffine(JubjubSubgroup::generator());
            let x: [u8; 32] = g.x().unwrap().as_le_bytes().try_into().unwrap();
            let y: [u8; 32] = g.y().unwrap().as_le_bytes().try_into().unwrap();
            assert_eq!(h32(&doc["fixtures"]["pk_v1"]["x_le"]), x);
            assert_eq!(h32(&doc["fixtures"]["pk_v1"]["y_le"]), y);
        }
        assert_eq!(
            origin_hash(doc["fixtures"]["origin"].as_str().unwrap()).unwrap(),
            h32(&doc["fixtures"]["origin_hash"])
        );

        let head = |a: &Value| GrantCallHead {
            self_addr: h32(&a["self"]),
            pk_x_le: h32(&a["pk_x"]),
            pk_y_le: h32(&a["pk_y"]),
            grant_id: h32(&a["grant_id"]),
            issued_at: uint(&a["issued_at"]) as u64,
            record_nonce: uint(&a["nonce"]) as u64,
        };

        let mut reproduced = 0usize;
        for vector in doc["vectors"].as_array().unwrap() {
            let a = &vector["args"];
            let circuit = vector["circuit"].as_str().unwrap();
            let label = format!("{circuit} {}", vector["name"].as_str().unwrap());
            let want = h32(&vector["digest"]);

            // The file is internally consistent: the published preimage has
            // the published length and hashes to the published digest.
            let preimage = hex::decode(vector["preimage"].as_str().unwrap()).unwrap();
            assert_eq!(
                preimage.len(),
                usize::try_from(vector["preimage_len"].as_u64().unwrap()).unwrap(),
                "{label}"
            );
            assert_eq!(sha256_concat(&[preimage]), want, "{label}: preimage");

            let got = match circuit {
                "derive_grant_id_with_k256" => grant_id_k256(
                    &h32(&a["self"]),
                    &h32(&a["pk_x"]),
                    &h32(&a["pk_y"]),
                    small(&a["envelope"]),
                    &h32(&a["origin_hash"]),
                    small(&a["slot"]),
                ),
                "derive_grant_id_with_jubjub" => grant_id_jubjub_coords(
                    &h32(&a["self"]),
                    &h32(&a["pk_x"]),
                    &h32(&a["pk_y"]),
                    &h32(&a["origin_hash"]),
                    small(&a["slot"]),
                ),
                "derive_grant_object_commit" => object_commit(
                    &h32(&a["scope_salt"]),
                    &h32(&a["color"]),
                    small(&a["recipient_kind"]),
                    &h32(&a["recipient"]),
                    uint(&a["max_coin_value"]),
                ),
                "derive_grant_spent_commit" => {
                    spent_commit(&h32(&a["scope_salt"]), uint(&a["spent"]))
                }
                "derive_grant_rp_commit" => {
                    rp_commit(&h32(&a["scope_salt"]), &h32(&a["rp_id_hash"]))
                }
                "derive_grant_scope_digest" => scope_digest(
                    &h32(&a["scope_salt"]),
                    &GrantScopePlain {
                        op_withdraw_unshielded: flag(&a["op_withdraw_unshielded"]),
                        op_withdraw_shielded: flag(&a["op_withdraw_shielded"]),
                        op_withdraw_shielded_to_contract: flag(
                            &a["op_withdraw_shielded_to_contract"],
                        ),
                        read: flag(&a["read"]),
                        color: h32(&a["color"]),
                        recipient_kind: small(&a["recipient_kind"]),
                        recipient: h32(&a["recipient"]),
                        max_coin_value: uint(&a["max_coin_value"]),
                        per_call_cap: uint(&a["per_call_cap"]),
                        cap: uint(&a["cap"]),
                        expires_at: uint(&a["expires_at"]) as u64,
                        rp_id_hash: h32(&a["rp_id_hash"]),
                        read_pk_hash: h32(&a["read_pk_hash"]),
                        window_len: uint(&a["window_len"]) as u64,
                        window_cap: uint(&a["window_cap"]),
                    },
                ),
                "challenge_withdraw_unshielded_with_grant_k256" => {
                    challenge_withdraw_unshielded_with_grant_k256(
                        &head(a),
                        &h32(&a["color"]),
                        uint(&a["amount"]),
                        &h32(&a["recipient"]),
                    )
                }
                "challenge_withdraw_shielded_with_grant_k256" => {
                    let change_entry: [u8; 192] = hex::decode(a["change_entry"].as_str().unwrap())
                        .unwrap()
                        .try_into()
                        .unwrap();
                    let coin = QualifiedCoin {
                        nonce: h32(&a["coin"]["nonce"]),
                        color: h32(&a["coin"]["color"]),
                        value: uint(&a["coin"]["value"]),
                        mt_index: uint(&a["coin"]["mt_index"]) as u64,
                    };
                    challenge_withdraw_shielded_with_grant_k256(
                        "withdraw_shielded",
                        &head(a),
                        &h32(&a["recipient"]),
                        &h32(&a["color"]),
                        uint(&a["amount"]),
                        &change_entry,
                        &h32(&a["enc_pk"]),
                        &coin,
                    )
                }
                "challenge_issue_grant_with_k256" => challenge_issue_grant_k256(
                    &h32(&a["self"]),
                    &h32(&a["pk_x"]),
                    &h32(&a["pk_y"]),
                    &h32(&a["grant_id"]),
                    &h32(&a["scope_digest"]),
                    uint(&a["auth_nonce"]) as u64,
                ),
                "challenge_revoke_grant_with_k256" => challenge_revoke_grant_k256(
                    &h32(&a["self"]),
                    &h32(&a["pk_x"]),
                    &h32(&a["pk_y"]),
                    &h32(&a["grant_id"]),
                    uint(&a["auth_nonce"]) as u64,
                ),
                "challenge_revoke_all_grants_with_k256" => challenge_revoke_all_grants_k256(
                    &h32(&a["self"]),
                    &h32(&a["pk_x"]),
                    &h32(&a["pk_y"]),
                    uint(&a["auth_nonce"]) as u64,
                ),
                "envelope_digest" => envelope_digest(small(&a["envelope"]), &h32(&a["challenge"])),
                other => panic!("no recipe for {other}"),
            }
            .unwrap();
            assert_eq!(got, want, "{label}");
            reproduced += 1;
        }
        assert_eq!(reproduced, 27, "every published vector has a recipe here");

        // The pinned signatures: deterministic RFC 6979 under sk = 1 over
        // the envelope digest of the pinned unshielded grant challenge, in
        // the section 3.4 wire form (r || s, each 32 bytes little-endian).
        // Both S forms verify (SIG-4).
        let sk = k256_signing_key_from_hex("0x01").unwrap();
        let vk = *sk.verifying_key();
        let mut signatures = 0usize;
        for pinned in doc["signatures"].as_array().unwrap() {
            assert_eq!(pinned["sk"].as_str().unwrap(), "1");
            let envelope = small(&pinned["envelope"]);
            let challenge = h32(&pinned["challenge"]);
            let digest = h32(&pinned["signed_digest"]);
            assert_eq!(envelope_digest(envelope, &challenge).unwrap(), digest);

            let wire = hex::decode(pinned["sig_le"].as_str().unwrap()).unwrap();
            assert_eq!(wire.len(), 64);
            let mut r_be: [u8; 32] = wire[..32].try_into().unwrap();
            let mut s_be: [u8; 32] = wire[32..].try_into().unwrap();
            r_be.reverse();
            s_be.reverse();
            let sig = Signature::from_scalars(r_be, s_be).unwrap();
            assert!(vk.verify_prehash(&digest, &sig).is_ok(), "envelope {envelope}");

            // Both stacks derive the RFC 6979 nonce and normalise to low-S,
            // so the Rust signature over the same digest is byte-identical.
            let ours: Signature = sk.sign_prehash(&digest).unwrap();
            assert_eq!(ours, sig, "envelope {envelope}: deterministic signature");

            // The high-S twin, (r, n - s), is the same signature under the
            // contract's rule (both S forms accepted, SIG-4). The k256
            // crate's verifier enforces low-S and refuses the twin as
            // presented, so a Rust verifier implementing SIG-4 MUST
            // normalise S before verifying; asserted here in that form.
            let s_scalar = k256::Scalar::from_repr(s_be.into()).unwrap();
            let high = Signature::from_scalars(r_be, (-s_scalar).to_repr()).unwrap();
            assert!(
                vk.verify_prehash(&digest, &high).is_err(),
                "envelope {envelope}: the k256 crate refuses high-S as presented"
            );
            let normalised = high.normalize_s().expect("the twin really is high-S");
            assert_eq!(normalised, sig, "envelope {envelope}: normalising the twin gives back (r, s)");
            assert!(vk.verify_prehash(&digest, &normalised).is_ok(), "envelope {envelope}: high-S");
            signatures += 1;
        }
        assert_eq!(signatures, 2);
    }
}
