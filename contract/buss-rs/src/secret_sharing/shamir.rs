use ff::{FromUniformBytes, PrimeField};
use rand_core::RngCore;

use super::SecretSharing;
use crate::error::Error;
use crate::math::fft::{fft, root_of_unity};
use crate::math::polynomial::Polynomial;

/// A single share: the evaluation point x and the polynomial value f(x).
#[derive(Clone, Debug)]
pub struct Share<F> {
    pub x: F,
    pub y: F,
}

/// (t+1)-out-of-(n-1) Shamir Secret Sharing over any `PrimeField`.
///
/// Generates a random degree-t polynomial f with f(0) = secret, then
/// distributes n-1 shares. Any t+1 shares suffice to reconstruct the secret
/// via Lagrange interpolation at x = 0; t or fewer shares are
/// information-theoretically independent of the secret.
///
/// `n` counts the whole community, not just the share recipients — the same
/// convention [`crate::bottom_up::buss`] uses, where the secret's own owner
/// occupies the conceptual x = 0 point and the other n-1 parties (guardians)
/// receive the actual shares. Shamir has no owner/guardian structure of its
/// own; it adopts this phrasing purely so `new(t, n)` means the same thing
/// across every scheme in this crate.
pub struct ShamirSecretSharing {
    /// Polynomial degree. Reconstruction requires t+1 shares.
    pub t: usize,
    /// Total-shares parameter. Distributes n-1 shares.
    pub n: usize,
}

impl<F: PrimeField + FromUniformBytes<64>> SecretSharing<F> for ShamirSecretSharing {
    type Share = Share<F>;

    fn polynomial<R: RngCore>(&self, secret: F, rng: &mut R) -> Polynomial<F> {
        Polynomial::random_with_secret(secret, self.t, rng)
    }

    fn split(&self, poly: &Polynomial<F>) -> Result<Vec<Share<F>>, Error> {
        if poly.degree() != self.t {
            return Err(Error::InvalidDegree {
                need: self.t,
                got: poly.degree(),
            });
        }

        let shares = (1..=self.num_shares())
            .map(|i| {
                let x = F::from(i as u64);
                Share { x, y: poly.eval(x) }
            })
            .collect();

        Ok(shares)
    }

    fn reconstruct(&self, shares: &[Share<F>]) -> Result<F, Error> {
        let need = self.threshold();
        if shares.len() < need {
            return Err(Error::InsufficientShares {
                need,
                got: shares.len(),
            });
        }
        let points: Vec<(F, F)> = shares[..need].iter().map(|s| (s.x, s.y)).collect();
        Polynomial::lagrange_at_zero(&points)
    }
}

impl ShamirSecretSharing {
    /// Create a (t+1)-out-of-(n-1) scheme.
    ///
    /// Constraints: n ≥ 2 and t < n-1.
    pub fn new(t: usize, n: usize) -> Result<Self, Error> {
        if n < 2 {
            return Err(Error::InvalidParameters("n must be >= 2".into()));
        }
        if t >= n - 1 {
            return Err(Error::InvalidParameters(format!(
                "t ({t}) must be < n-1 ({}); otherwise reconstruction is trivially impossible",
                n - 1
            )));
        }
        Ok(Self { t, n })
    }

    /// Reconstruction threshold: t+1 shares are required.
    pub fn threshold(&self) -> usize {
        self.t + 1
    }

    /// Number of shares distributed: n-1.
    pub fn num_shares(&self) -> usize {
        self.n - 1
    }

    /// Split `secret` into n-1 shares using FFT evaluation at roots of unity.
    ///
    /// Evaluation points are ω^0, ω^1, …, ω^{n-2} where ω is the primitive
    /// m-th root of unity in F and m is the next power of two ≥ n-1.
    ///
    /// This is O(m log m) instead of O(t · (n-1)) for the Horner-based
    /// [`SecretSharing::split`], which matters when n ≫ t.
    ///
    /// Reconstruction via [`SecretSharing::reconstruct`] works unchanged.
    pub fn split_fft<F: PrimeField>(&self, poly: &Polynomial<F>) -> Result<Vec<Share<F>>, Error> {
        if poly.degree() != self.t {
            return Err(Error::InvalidDegree {
                need: self.t,
                got: poly.degree(),
            });
        }

        // Domain size: next power of two that fits at least n-1 evaluation points.
        let m = self.num_shares().next_power_of_two().max(2);
        let log_m = m.trailing_zeros();
        let omega = root_of_unity::<F>(log_m);

        // Pad coefficient vector to domain size and run forward FFT.
        let mut padded_poly = vec![F::ZERO; m];
        padded_poly[..poly.len()].copy_from_slice(poly.coeffs());
        // Compute the evaluations in-place of the polynomial at the m-th roots of unity.
        fft(&mut padded_poly);

        // Keep the first n-1 evaluations; share i: x = ω^i, y = f(ω^i).
        let mut x = F::ONE;
        let shares = padded_poly
            .into_iter()
            .take(self.num_shares())
            .map(|y| {
                let share = Share { x, y };
                x *= omega;
                share
            })
            .collect();

        Ok(shares)
    }
}
