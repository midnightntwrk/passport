//! The recovery MIP's normative v1 profile over the upstream primitives.
//!
//! Everything here mirrors `contract/src/wallet/recovery.ts` bit for bit:
//! the share derivation is SHA-512 over length-prefixed fields under the
//! registered tag, wide-reduced into the BLS12-381 scalar field, and the
//! cross-implementation vectors in `tests/v1_vectors.rs` hold the two
//! implementations together.

use ff::{Field, FromUniformBytes, PrimeField};
use midnight_curves::Fq;
use sha2::{Digest, Sha512};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Registered domain-separation tags (recovery MIP §2).
pub const DST_GUARDIAN: &[u8] = b"midnight:account:recovery:guardian:v1";
pub const DST_SHARE: &[u8] = b"midnight:account:recovery:share:v1";
pub const DST_WRAP: &[u8] = b"midnight:account:recovery:wrap:v1";

/// A session identifier: 32 bytes, distinct per session (REC-4).
///
/// Typed so a session identifier cannot be confused with any other
/// 32-byte value at an API boundary — one of the upstream asks this fork
/// carries.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SessionId(pub [u8; 32]);

/// A guardian's long-term secret, held only for the duration of a
/// ceremony. The byte form zeroises on drop; the field element it derives
/// is `Copy` and cannot be reliably scrubbed (see README).
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct GuardianSecret([u8; 32]);

impl GuardianSecret {
    /// Profile A (§3): from a 32-byte authenticator PRF output.
    pub fn from_prf_output(prf: &[u8; 32]) -> Self {
        let sk = wide_reduce(&sha512_lp(&[DST_GUARDIAN, prf]));
        GuardianSecret(sk.to_repr())
    }

    /// Profile C (§3): a paper key is a uniform field element.
    pub fn from_field(sk: Fq) -> Self {
        GuardianSecret(sk.to_repr())
    }

    pub fn as_field(&self) -> Fq {
        Fq::from_repr(self.0).expect("stored repr is canonical")
    }
}

/// §4: `sigma_ij = H(DST_share, sid_i, pk_i, sk_j)`, every field
/// length-prefixed (u32 big-endian), SHA-512 wide-reduced into the field.
pub fn guardian_share_v1(session: &SessionId, account: &[u8], guardian: &GuardianSecret) -> Fq {
    wide_reduce(&sha512_lp(&[DST_SHARE, &session.0, account, &guardian.0]))
}

/// Canonical 32-byte little-endian share codec — the upstream ask for an
/// explicit serialisation instead of ad-hoc positional hex JSON.
pub fn share_to_bytes(share: Fq) -> [u8; 32] {
    share.to_repr()
}

pub fn share_from_bytes(bytes: &[u8; 32]) -> Option<Fq> {
    Fq::from_repr(*bytes).into_option()
}

/// Phi vector codec: the concatenation of canonical share encodings.
pub fn phi_to_bytes(phi: &[Fq]) -> Vec<u8> {
    phi.iter().flat_map(|f| share_to_bytes(*f)).collect()
}

pub fn phi_from_bytes(bytes: &[u8]) -> Option<Vec<Fq>> {
    if bytes.len() % 32 != 0 {
        return None;
    }
    bytes
        .chunks_exact(32)
        .map(|c| share_from_bytes(c.try_into().expect("chunk is 32 bytes")))
        .collect()
}

fn sha512_lp(fields: &[&[u8]]) -> [u8; 64] {
    let mut hasher = Sha512::new();
    for f in fields {
        hasher.update((f.len() as u32).to_be_bytes());
        hasher.update(f);
    }
    hasher.finalize().into()
}

fn wide_reduce(bytes: &[u8; 64]) -> Fq {
    Fq::from_uniform_bytes(bytes)
}

/// Uniform field element from caller-supplied randomness (the caller owns
/// the generator; the MIP requires a cryptographically secure one).
pub fn field_from_uniform(bytes: &[u8; 64]) -> Fq {
    wide_reduce(bytes)
}

#[allow(unused)]
fn _assert_field_nonzero(sk: &Fq) -> bool {
    !bool::from(sk.is_zero())
}
