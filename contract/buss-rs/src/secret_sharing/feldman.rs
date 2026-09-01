use std::marker::PhantomData;

use ff::{Field, FromUniformBytes};
use group::Group;
use rand_core::RngCore;

use crate::error::Error;
use crate::math::polynomial::Polynomial;
use crate::secret_sharing::{SecretSharing, VerifiableSS};

/// Feldman Verifiable Secret Sharing over any prime-order group.
///
/// The type parameter `G` is the commitment group (e.g. `G1Projective` for
/// BLS12-381). The scalar field `G::Scalar` is automatically used for the
/// underlying Shamir scheme: shares are `(x, f(x))` in `G::Scalar`, and
/// commitments are `C_j = a_j · G` in `G`.
///
/// The `group::Group` trait provides everything needed: `generator()`,
/// `identity()`, scalar multiplication `G * G::Scalar`, and equality.
/// Any `PrimeCurve` (or other `Group` impl) works.
pub struct FeldmanVSS<G: Group> {
    /// Polynomial degree. Reconstruction requires t+1 shares.
    pub t: usize,
    /// Total-shares parameter. Distributes n-1 shares.
    pub n: usize,
    _phantom: PhantomData<G>,
}

/// Contrary to Shamir Secret Sharing, Feldman VSS shares are chosen at random evaluation points.
pub struct Share<F: Field> {
    pub x: F,
    pub y: F,
}

impl<G: Group> SecretSharing<G::Scalar> for FeldmanVSS<G>
where
    G::Scalar: FromUniformBytes<64>,
{
    type Share = Share<G::Scalar>;

    fn polynomial<R: RngCore>(&self, secret: G::Scalar, rng: &mut R) -> Polynomial<G::Scalar> {
        Polynomial::random_with_secret(secret, self.t, rng)
    }

    fn split(&self, poly: &Polynomial<G::Scalar>) -> Result<Vec<Self::Share>, Error> {
        if poly.degree() != self.t {
            return Err(Error::InvalidDegree {
                need: self.t,
                got: poly.degree(),
            });
        }
        let poly = (1..=self.num_shares())
            .map(|i| {
                let x = G::Scalar::from(i as u64);
                Share { x, y: poly.eval(x) }
            })
            .collect();
        Ok(poly)
    }

    fn reconstruct(&self, shares: &[Self::Share]) -> Result<G::Scalar, Error> {
        if shares.len() < self.threshold() {
            return Err(Error::InsufficientShares {
                need: self.threshold(),
                got: shares.len(),
            });
        }
        let points: Vec<(G::Scalar, G::Scalar)> = shares[..self.threshold()]
            .iter()
            .map(|s| (s.x, s.y))
            .collect();
        Polynomial::lagrange_at_zero(&points)
    }
}

impl<G: Group> VerifiableSS<G::Scalar> for FeldmanVSS<G>
where
    G::Scalar: FromUniformBytes<64>,
{
    type VerificationKey = Vec<G>;

    fn compute_verification_key(
        &self,
        poly: &Polynomial<G::Scalar>,
    ) -> Result<Self::VerificationKey, Error> {
        if poly.degree() != self.t {
            return Err(Error::InvalidDegree {
                need: self.t,
                got: poly.degree(),
            });
        }

        let g = G::generator();
        let vk = poly
            .coeffs()
            .iter()
            .map(|&coeff| g * coeff)
            .collect::<Vec<G>>();

        Ok(vk)
    }

    fn verify_share(&self, share: &Self::Share, vk: &Self::VerificationKey) -> Result<(), Error> {
        if vk.len() != self.t + 1 {
            return Err(Error::InvalidDegree {
                need: self.t,
                got: vk.len().saturating_sub(1),
            });
        }

        let g = G::generator();
        let lhs = g * share.y;

        // Evaluate commitment polynomial at share.x: Σ C_j · x^j
        let mut rhs = G::identity();
        let mut xpow = G::Scalar::ONE;
        for &c in vk {
            rhs += c * xpow;
            xpow *= share.x;
        }
        if lhs == rhs {
            Ok(())
        } else {
            Err(Error::VerificationFailed)
        }
    }
}

impl<G: Group> FeldmanVSS<G> {
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
        Ok(Self {
            t,
            n,
            _phantom: PhantomData,
        })
    }

    /// Reconstruction threshold: t+1 shares are required.
    pub fn threshold(&self) -> usize {
        self.t + 1
    }

    /// Number of shares distributed: n-1.
    pub fn num_shares(&self) -> usize {
        self.n - 1
    }
}
