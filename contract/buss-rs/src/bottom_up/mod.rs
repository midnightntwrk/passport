use ff::{FromUniformBytes, PrimeField};
use rand_core::RngCore;

use crate::error::Error;

pub mod buss;
pub mod traceable_buss;

/// Common interface for non-traceable (t+1)-out-of-(n-1) bottom up secret sharing schemes.
pub trait BottumUpSS<F: PrimeField + FromUniformBytes<64>> {
    /// A single party's share.
    type Share;

    /// Compute n-t public shares from the polynomial the guardian shares.
    fn split(&self, secret: F, shares: &[Self::Share]) -> Result<Vec<Self::Share>, Error>;

    /// Reconstruct the secret from at least t+1 shares.
    fn reconstruct(
        &self,
        public_shares: &[Self::Share],
        shares: &[Self::Share],
    ) -> Result<F, Error>;

    /// Update public shares when a guardian update their keys.
    fn update_public_shares(
        &self,
        guardian_index: F,
        all_guardian_indices: &[F],
        delta: F,
        public_shares: &mut [Self::Share],
    ) -> Result<(), Error>;
}

pub trait VerifiableBSS<F: PrimeField + FromUniformBytes<64>>: BottumUpSS<F> {
    type VerificationKey;

    fn compute_verification_key(
        &self,
        shares: &[Self::Share],
    ) -> Result<Self::VerificationKey, Error>;

    fn verify_share(&self, share: &Self::Share, vk: &Self::VerificationKey) -> Result<(), Error>;
}

/// Result of [`TraceableBSS::trace`]: `Ok(Some((traitor_indices, proofs)))` if
/// tracing succeeded, `Ok(None)` if no candidate matched the trace key.
pub type TraceResult<P> = Result<Option<(Vec<usize>, Vec<P>)>, Error>;

pub trait TraceableBSS<F: PrimeField + FromUniformBytes<64>>: BottumUpSS<F> {
    type TracingSecretKey;
    type TracingPublicKey;
    type TracingProof;

    fn compute_tracing_keys(
        &self,
        shares: &[Self::Share],
    ) -> Result<(Self::TracingSecretKey, Self::TracingPublicKey), Error>;

    /// Identify corrupted parties given their leaked shares.
    ///
    /// `corrupted_shares` are the `f` shares held by the corrupted parties;
    /// each query reconstructs on `corrupted_shares` plus freshly sampled
    /// shares to probe which of the original parties they belong to.
    fn trace<R: RngCore>(
        &self,
        tk: &Self::TracingSecretKey,
        public_shares: &[Self::Share],
        corrupted_shares: &[Self::Share],
        rng: &mut R,
    ) -> TraceResult<Self::TracingProof>;

    fn verify_trace(
        &self,
        traitors: &[usize],
        proofs: &[Self::TracingProof],
        vk: &Self::TracingPublicKey,
    ) -> Result<(), Error>;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/// Evaluate the Lagrange basis polynomial L_{j,X}(x) at a single point.
///
/// X = {0} ∪ B (the full BUSS interpolation set including the secret at 0).
/// L_{j,X} equals 1 at j, 0 at every other point in X (including 0), so
/// adding Δ · L_{j,X} to f leaves f(0) = s intact and shifts f(j) by Δ.
///
/// Explicitly: L_{j,X}(x) = (x / j) · ∏_{k ∈ B, k ≠ j} (x − k) / (j − k)
///
/// Shared by [`buss`] and [`traceable_buss`], both of which shift a published
/// public value in place when a guardian rotates their key.
pub(crate) fn lagrange_basis_at_point<F: PrimeField>(
    xj: F,
    guardian_xs: &[F],
    x: F,
) -> Result<F, Error> {
    let xj_inv = Option::<F>::from(xj.invert())
        .ok_or_else(|| Error::InvalidParameters("guardian_index j must be nonzero".into()))?;

    // Factor for the interpolation point at 0: (x − 0) / (j − 0) = x / j
    let mut result = x * xj_inv;

    // Factors for all other guardians k ∈ B \ {j}
    for &xk in guardian_xs {
        if xk == xj {
            continue;
        }
        let den = xj - xk;
        let den_inv = Option::<F>::from(den.invert()).ok_or(Error::DuplicateXCoordinate)?;
        result *= (x - xk) * den_inv;
    }

    Ok(result)
}
