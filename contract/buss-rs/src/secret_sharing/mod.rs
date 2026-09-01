use ff::{FromUniformBytes, PrimeField};
use rand_core::RngCore;

use crate::{error::Error, Polynomial};

pub mod feldman;
pub mod shamir;
pub mod traceable_shamir;

/// Common interface for non-traceable (t+1)-out-of-(n-1) secret sharing schemes.
///
/// Implemented by [`crate::ShamirSecretSharing`] and [`crate::FeldmanVSS`].
pub trait SecretSharing<F: PrimeField + FromUniformBytes<64>> {
    /// A single party's share.
    type Share;

    /// Compute a random degree-t polynomial f with f(0) = secret.
    fn polynomial<R: RngCore>(&self, secret: F, rng: &mut R) -> Polynomial<F>;

    /// Compute n shares from the polynomial f.
    fn split(&self, poly: &Polynomial<F>) -> Result<Vec<Self::Share>, Error>;

    /// Reconstruct the secret from at least t+1 shares.
    fn reconstruct(&self, shares: &[Self::Share]) -> Result<F, Error>;
}

pub trait VerifiableSS<F: PrimeField + FromUniformBytes<64>>: SecretSharing<F> {
    type VerificationKey;

    fn compute_verification_key(
        &self,
        poly: &Polynomial<F>,
    ) -> Result<Self::VerificationKey, Error>;

    fn verify_share(&self, share: &Self::Share, vk: &Self::VerificationKey) -> Result<(), Error>;
}

/// Result of [`TraceableSS::trace`]: `Ok(Some((traitor_indices, proofs)))` if
/// tracing succeeded, `Ok(None)` if no candidate matched the trace key.
pub type TraceResult<P> = Result<Option<(Vec<usize>, Vec<P>)>, Error>;

pub trait TraceableSS<F: PrimeField + FromUniformBytes<64>>: SecretSharing<F> {
    type TracingSecretKey;
    type TracingPublicKey;
    type TracingProof;

    fn compute_tracing_keys(
        &self,
        poly: &Polynomial<F>,
    ) -> Result<(Self::TracingSecretKey, Self::TracingPublicKey), Error>;

    /// Identify corrupted parties given their leaked shares.
    ///
    /// `corrupted_shares` are the `f` shares held by the corrupted parties;
    /// each query reconstructs on `corrupted_shares` plus freshly sampled
    /// shares to probe which of the original parties they belong to.
    fn trace<R: RngCore>(
        &self,
        tk: &Self::TracingSecretKey,
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
