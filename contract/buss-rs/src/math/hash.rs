//! Shared hash-to-field helpers for the traceable schemes.
//!
//! Both [`crate::secret_sharing::traceable_shamir`] and
//! [`crate::bottom_up::traceable_buss`] need to derive field elements
//! deterministically from a hash — for OWF-style tracing keys, and to sample
//! x-coordinates via a hash chain where no `RngCore` is available (e.g.
//! [`crate::bottom_up::BottumUpSS::split`]). Each caller passes its own
//! `label` for domain separation between schemes.

use digest::{Digest, OutputSizeUser};
use ff::{FromUniformBytes, PrimeField};

use super::polynomial::Polynomial;

/// Hash a polynomial's coefficients, under a caller-chosen domain-separation
/// `label`, down to a single field element.
pub(crate) fn hash_poly<D, F>(label: &[u8], poly: &Polynomial<F>) -> F
where
    F: PrimeField + FromUniformBytes<64>,
    D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>,
{
    let mut hasher = D::new();
    hasher.update(label);
    for coeff in poly.coeffs().iter() {
        hasher.update(coeff.to_repr().as_ref());
    }
    let output = hasher.finalize();

    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(&output);
    F::from_uniform_bytes(&bytes)
}

/// Hash a single field element, under a caller-chosen domain-separation
/// `label`, down to another field element.
pub(crate) fn hash_fr<D, F>(label: &[u8], x: F) -> F
where
    F: PrimeField + FromUniformBytes<64>,
    D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>,
{
    let output = D::new()
        .chain_update(label)
        .chain_update(x.to_repr().as_ref())
        .finalize();

    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(&output);
    F::from_uniform_bytes(&bytes)
}
