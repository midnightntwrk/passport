//! Traceable Shamir Secret Sharing (TS)
//!
//! Implements §3 of:
//! Boneh, Partap, Rotem — "Traceable Secret Sharing: Strong Security and Efficient Constructions"
//! EPRINT 2024/405.
//!
//! Each party i receives share `(x_i, q(x_i))` where `x_i ←$ F` is random and
//! `q` is a degree-(t−1) polynomial with `q(0) = secret`.  The trace key
//! `tk = (x_1,…,x_n)` enables the Trace algorithm (§3.2, Fig. 4) to identify
//! up to `f < t` corrupted parties given black-box access to a reconstruction
//! box R with those shares hardcoded.
//!
//! Tracing uses **Guruswami-Sudan list decoding** of Reed-Solomon codes.
//! Specifically, given N oracle evaluations of the traitor polynomial
//! `h*(X) = Π_{j=1}^{f} (x_j − X)/x_j` and agreement parameter `C ≥ √(f·N)`,
//! the GS decoder returns all degree-≤f polynomials agreeing with ≥ C
//! evaluations.  The traitors' evaluation points are the roots of h*.

use rand_core::RngCore;

use crate::error::Error;
use crate::math::hash::{hash_fr, hash_poly};
use crate::math::list_decoding::guruswami_sudan;
use crate::math::polynomial::Polynomial;
use crate::secret_sharing::{SecretSharing, TraceResult, TraceableSS};

use digest::{Digest, OutputSizeUser};
use ff::{FromUniformBytes, PrimeField};

/// Domain-separation label for this scheme's hash-to-field calls, so that
/// [`crate::bottom_up::traceable_buss`] (which shares the same [`hash_poly`]/
/// [`hash_fr`] helpers) can never collide with it.
const LABEL: &[u8] = b"ARC-PLEIADES-TSS-OWF-v1";

// ── Main struct ───────────────────────────────────────────────────────────────

pub struct TracingKey<F: PrimeField>(pub Vec<F>);

pub struct Share<F: PrimeField> {
    pub x: F,
    pub y: F,
}

/// Traceable t-out-of-n Shamir secret sharing.
pub struct TraceableShamir<D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>> {
    t: usize,
    n: usize,
    f: usize,
    sec_param: usize,
    _phantom: std::marker::PhantomData<D>,
}

impl<
        F: PrimeField + FromUniformBytes<64>,
        D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>,
    > SecretSharing<F> for TraceableShamir<D>
{
    type Share = Share<F>;

    fn polynomial<R: RngCore>(&self, secret: F, rng: &mut R) -> Polynomial<F> {
        Polynomial::random_with_secret(secret, self.t - 1, rng)
    }

    fn split(&self, poly: &Polynomial<F>) -> Result<Vec<Self::Share>, Error> {
        if poly.degree() != self.t - 1 {
            return Err(Error::InvalidDegree {
                need: self.t - 1,
                got: poly.degree(),
            });
        }

        let base_randomness = hash_poly::<D, F>(LABEL, poly);

        let mut x_vals: Vec<F> = Vec::with_capacity(self.n);
        let mut counter = F::ZERO;
        while x_vals.len() < self.n {
            let x = hash_poly::<D, F>(LABEL, &Polynomial::new(vec![base_randomness, counter]));
            if x != F::ZERO && !x_vals.contains(&x) {
                x_vals.push(x);
            }
            counter += F::ONE;
        }
        let shares = x_vals
            .iter()
            .map(|&x| Share { x, y: poly.eval(x) })
            .collect();

        Ok(shares)
    }

    fn reconstruct(&self, shares: &[Self::Share]) -> Result<F, Error> {
        if shares.len() < self.t {
            return Err(Error::InsufficientShares {
                need: self.t,
                got: shares.len(),
            });
        }
        let points: Vec<(F, F)> = shares[..self.threshold()]
            .iter()
            .map(|s| (s.x, s.y))
            .collect();
        Polynomial::lagrange_at_zero(&points[..self.t])
    }
}

impl<
        F: PrimeField + FromUniformBytes<64>,
        D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>,
    > TraceableSS<F> for TraceableShamir<D>
{
    type TracingSecretKey = TracingKey<F>;
    type TracingPublicKey = TracingKey<F>;
    type TracingProof = F;

    fn compute_tracing_keys(
        &self,
        poly: &Polynomial<F>,
    ) -> Result<(Self::TracingSecretKey, Self::TracingPublicKey), Error> {
        if poly.degree() != self.t - 1 {
            return Err(Error::InvalidDegree {
                need: self.t - 1,
                got: poly.degree(),
            });
        }
        let base_randomness = hash_poly::<D, F>(LABEL, poly);

        let mut x_vals: Vec<F> = Vec::with_capacity(self.n);
        let mut hashed_vals: Vec<F> = Vec::with_capacity(self.n);
        let mut counter = F::ZERO;
        while x_vals.len() < self.n {
            let x = hash_poly::<D, F>(LABEL, &Polynomial::new(vec![base_randomness, counter]));
            if x != F::ZERO && !x_vals.contains(&x) {
                let hashed_x = hash_fr::<D, F>(LABEL, x);
                x_vals.push(x);
                hashed_vals.push(hashed_x);
            }
            counter += F::ONE;
        }
        Ok((TracingKey(hashed_vals.clone()), TracingKey(hashed_vals)))
    }

    fn trace<R: RngCore>(
        &self,
        tk: &Self::TracingSecretKey,
        corrupted_shares: &[Self::Share],
        rng: &mut R,
    ) -> TraceResult<Self::TracingProof> {
        let f = corrupted_shares.len();
        if f == 0 || f > self.f {
            return Err(Error::InvalidParameters(
                "#corrupted shares must be smaller than f and greater than 0".into(),
            ));
        }
        if tk.0.len() != self.n {
            return Err(Error::InvalidParameters(format!(
                "tk length {} ≠ n = {}",
                tk.0.len(),
                self.n
            )));
        }

        let num_queries = 4 * self.f * self.sec_param;
        let agreement = ((self.f * num_queries) as f64).sqrt().ceil() as usize;

        // Number of fresh "honest" shares per query (parties f+1,…,t−1).
        let n_fresh = self.t - f - 1;

        let mut gs_pts: Vec<(F, F)> = Vec::new();

        for _ in 0..num_queries {
            // (a) Sample t−f−1 fresh random shares (x_{ℓ,i}, y_{ℓ,i}) ←$ F².
            let mut fresh: Vec<(F, F)> = Vec::with_capacity(n_fresh);
            for _ in 0..n_fresh {
                let x = F::random(&mut *rng);
                let y = F::random(&mut *rng);
                fresh.push((x, y));
            }
            let x = F::random(&mut *rng);
            let y = F::random(&mut *rng);
            let delta = F::random(&mut *rng);

            // Reconstructing secret on [corrupted_shares, fresh, (x, y)]
            fresh.push((x, y));
            let mut shares_first: Vec<Share<F>> = corrupted_shares
                .iter()
                .map(|s| Share { x: s.x, y: s.y })
                .collect();
            shares_first.extend(fresh.clone().into_iter().map(|p| Share { x: p.0, y: p.1 }));
            let s_single = match self.reconstruct(&shares_first) {
                Ok(v) => v,
                Err(_) => return Err(Error::TracingError("Oracle error".to_string())),
            };

            // Reconstructing secret on [corrupted_shares, fresh, (x, y + delta)]
            fresh.pop();
            fresh.push((x, y + delta));
            let mut shares_second: Vec<Share<F>> = corrupted_shares
                .iter()
                .map(|s| Share { x: s.x, y: s.y })
                .collect();
            shares_second.extend(fresh.clone().into_iter().map(|p| Share { x: p.0, y: p.1 }));
            fresh.pop();
            let s_second = match self.reconstruct(&shares_second) {
                Ok(v) => v,
                Err(_) => return Err(Error::TracingError("Oracle error".to_string())),
            };

            // If returned secrets are equal, delta is 0, or x in fresh, terminate.
            if s_single.eq(&s_second)
                || delta.is_zero_vartime()
                || fresh.iter().any(|x_li| x_li.0.eq(&x))
            {
                return Err(Error::TracingError("Query error".to_string()));
            }

            // z_ℓ = δ / (s'−s) · Π_{i} x_{fresh,i} / (x_{fresh,i} − x'_ℓ)
            let z_l = {
                let diff = s_second - s_single;
                let inv = diff.invert().unwrap();
                fresh.into_iter().fold(delta * inv, |acc, point| {
                    let diff = point.0 - x;
                    let inv = diff.invert().unwrap();
                    acc * point.0 * inv
                })
            };

            gs_pts.push((x, z_l));
        }

        if gs_pts.len() < agreement {
            return Err(Error::TracingError(format!(
                "collected only {} valid evaluations; need ≥ {} (agreement C)",
                gs_pts.len(),
                agreement
            )));
        }

        // Step 3: Guruswami-Sudan list decoding on the N pairs (x'_ℓ, z_ℓ).
        let candidates = guruswami_sudan::<F>(&gs_pts, f, agreement, rng);

        if candidates.is_empty() {
            return Err(Error::TracingError(
                "GS decoder returned empty list; oracle may be ill-formed".into(),
            ));
        }

        // Steps 4–5: filter candidates, match roots to parties.
        for h in &candidates {
            let roots = match h.roots(rng) {
                Ok(r) => r,
                Err(_) => continue,
            };
            // All roots must appear in tk, otherwise we pass to the next candidate polynomial
            if roots.clone().into_iter().any(|r| {
                let hashed_root = hash_fr::<D, F>(LABEL, r);
                !tk.0.contains(&hashed_root)
            }) {
                continue;
            }
            // For the first successful candidate, we find the position in the tk its roots corresponds to and returns the positions as traitors and roots as proofs.
            let indices_roots: Vec<(usize, F)> = roots
                .into_iter()
                .map(|r| {
                    let pos =
                        tk.0.iter()
                            .position(|x| {
                                let hashed_root = hash_fr::<D, F>(LABEL, r);
                                hashed_root.eq(x)
                            })
                            .unwrap();
                    (pos, r)
                })
                .collect();
            let (indices, roots) = indices_roots.into_iter().unzip();
            return Ok(Some((indices, roots)));
        }

        Ok(None)
    }

    fn verify_trace(
        &self,
        traitors: &[usize],
        proofs: &[Self::TracingProof],
        vk: &Self::TracingPublicKey,
    ) -> Result<(), Error> {
        if traitors.len() != proofs.len() {
            return Err(Error::TracingVerificationError(format!(
                "Got {} indices and {} proofs",
                traitors.len(),
                proofs.len()
            )));
        }
        for (&idx, &w) in traitors.iter().zip(proofs.iter()) {
            if idx >= vk.0.len() {
                return Err(Error::TracingVerificationError("Invalid index".into()));
            }
            let hashed_proof = hash_fr::<D, F>(LABEL, w);
            if vk.0[idx] != hashed_proof {
                return Err(Error::TracingVerificationError(format!(
                    "Invalid proof for index #{}",
                    idx
                )));
            }
        }
        Ok(())
    }
}

impl<D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>> TraceableShamir<D> {
    /// Create a t-out-of-n traceable Shamir instance.
    pub fn new(t: usize, n: usize, f: usize, sec_param: usize) -> Result<Self, Error> {
        if t == 0 || t > n {
            return Err(Error::InvalidParameters(
                "threshold t must satisfy 1 ≤ t ≤ n".into(),
            ));
        }
        if f == 0 || f >= t {
            return Err(Error::InvalidParameters(
                "number of traitors f must satisfy 0 < f < t".into(),
            ));
        }
        if sec_param == 0 {
            return Err(Error::InvalidParameters(
                "Security parameter cannot be null".into(),
            ));
        }
        Ok(Self {
            t,
            n,
            f,
            sec_param,
            _phantom: std::marker::PhantomData::<D>,
        })
    }

    pub fn threshold(&self) -> usize {
        self.t
    }
    pub fn num_parties(&self) -> usize {
        self.n
    }
}
// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::list_decoding::guruswami_sudan;
    use ff::Field;
    use midnight_curves::Fq;
    use sha2::Sha512;

    fn rng() -> impl RngCore {
        rand::thread_rng()
    }

    // ── Split / Reconstruct ───────────────────────────────────────────────────

    #[test]
    fn split_and_reconstruct_roundtrip() {
        let mut rng = rng();
        let ts = TraceableShamir::<Sha512>::new(3, 5, 1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();
        assert_eq!(shares.len(), 5);

        let recovered = ts.reconstruct(&shares[..3]).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn reconstruct_with_insufficient_shares_fails() {
        let mut rng = rng();
        let ts = TraceableShamir::<Sha512>::new(2, 4, 1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();

        assert!(matches!(
            ts.reconstruct(&shares[..1]),
            Err(Error::InsufficientShares { .. })
        ));
    }

    // ── Trace / verify_trace ──────────────────────────────────────────────────

    #[test]
    fn trace_identifies_corrupt_party() {
        let mut rng = rng();
        let ts = TraceableShamir::<Sha512>::new(3, 5, 1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();
        let (tk_secret, tk_public) = ts.compute_tracing_keys(&poly).unwrap();

        // Party 0 is corrupt.
        let corrupted = [Share {
            x: shares[0].x,
            y: shares[0].y,
        }];
        // Fully-qualified: `TraceableShamir` also has an inherent `trace` (the
        // old oracle-based one below), which would otherwise shadow this call.
        let (indices, proofs) = <TraceableShamir<Sha512> as TraceableSS<Fq>>::trace(
            &ts, &tk_secret, &corrupted, &mut rng,
        )
        .unwrap()
        .expect("should find the corrupt party");

        assert_eq!(indices, vec![0]);
        ts.verify_trace(&indices, &proofs, &tk_public).unwrap();
    }

    // ── GS decoder unit test ──────────────────────────────────────────────────

    #[test]
    fn gs_decoder_recovers_exact_polynomial() {
        let mut rng = rng();
        // h*(X) = (a − X)/a for a known root a.
        // This is the f=1 traitor polynomial.
        let a = Fq::random(&mut rng);
        let a_inv = Option::<Fq>::from(a.invert()).unwrap();
        // h*(X) = 1 − X/a = 1 + (−a_inv)·X.
        let h_true = vec![Fq::ONE, -a_inv];

        // Generate N=30 exact evaluations.
        let n_pts = 30usize;
        let points: Vec<(Fq, Fq)> = {
            let mut pts = Vec::with_capacity(n_pts);
            let mut seen = Vec::new();
            while pts.len() < n_pts {
                let x = Fq::random(&mut rng);
                if x == Fq::ZERO || seen.contains(&x) {
                    continue;
                }
                seen.push(x);
                // h*(x) = 1 − x/a
                let y = Fq::ONE - x * a_inv;
                pts.push((x, y));
            }
            pts
        };

        let agreement = 25; // ≥ √(1·30) ≈ 5.5
        let candidates = guruswami_sudan::<Fq>(&points, 1, agreement, &mut rng);

        assert!(!candidates.is_empty(), "GS returned empty list");
        // One of the candidates must equal h_true.
        let h_true_poly = Polynomial::new(h_true.clone()).trim();
        let found = candidates.iter().any(|h| h == &h_true_poly);
        assert!(found, "GS did not recover the correct polynomial");
    }

    #[test]
    fn gs_decoder_handles_noise() {
        let mut rng = rng();
        // Same as above but corrupt 5 out of 30 evaluations.
        let a = Fq::random(&mut rng);
        let a_inv = Option::<Fq>::from(a.invert()).unwrap();
        let h_true = vec![Fq::ONE, -a_inv];

        let n_pts = 30usize;
        let agreement = 22; // 30 − 5 correct = 25 ≥ agreement=22
        let mut points: Vec<(Fq, Fq)> = {
            let mut pts = Vec::with_capacity(n_pts);
            let mut seen = Vec::new();
            while pts.len() < n_pts {
                let x = Fq::random(&mut rng);
                if x == Fq::ZERO || seen.contains(&x) {
                    continue;
                }
                seen.push(x);
                let y = Fq::ONE - x * a_inv;
                pts.push((x, y));
            }
            pts
        };
        // Corrupt 5 evaluations.
        for pt in points[..5].iter_mut() {
            pt.1 = Fq::random(&mut rng);
        }

        let candidates = guruswami_sudan::<Fq>(&points, 1, agreement, &mut rng);
        let h_true_poly = Polynomial::new(h_true.clone()).trim();
        let found = candidates.iter().any(|h| h == &h_true_poly);
        assert!(found, "GS with noise did not recover h*");
    }

    // ── Trace (direct corrupted-shares input, trait-based trace) ─────────────

    #[test]
    fn trace_t2_f1_identifies_corrupt_party() {
        let mut rng = rng();
        let ts = TraceableShamir::<Sha512>::new(2, 3, 1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();
        let (tk_secret, tk_public) = ts.compute_tracing_keys(&poly).unwrap();

        // Party 0 is corrupt.
        let corrupted = [Share {
            x: shares[0].x,
            y: shares[0].y,
        }];
        let (indices, proofs) = <TraceableShamir<Sha512> as TraceableSS<Fq>>::trace(
            &ts, &tk_secret, &corrupted, &mut rng,
        )
        .unwrap()
        .expect("should find the corrupt party");

        assert_eq!(indices, vec![0]);
        ts.verify_trace(&indices, &proofs, &tk_public).unwrap();
    }

    #[test]
    fn trace_t3_f1_identifies_corrupt_party() {
        let mut rng = rng();
        let ts = TraceableShamir::<Sha512>::new(3, 5, 1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();
        let (tk_secret, tk_public) = ts.compute_tracing_keys(&poly).unwrap();

        // Party 2 is corrupt.
        let corrupted = [Share {
            x: shares[2].x,
            y: shares[2].y,
        }];
        let (indices, proofs) = <TraceableShamir<Sha512> as TraceableSS<Fq>>::trace(
            &ts, &tk_secret, &corrupted, &mut rng,
        )
        .unwrap()
        .expect("should find the corrupt party");

        assert_eq!(indices, vec![2]);
        ts.verify_trace(&indices, &proofs, &tk_public).unwrap();
    }

    #[test]
    fn trace_t3_f2_identifies_two_corrupt_parties() {
        let mut rng = rng();
        let ts = TraceableShamir::<Sha512>::new(3, 5, 2, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();
        let (tk_secret, tk_public) = ts.compute_tracing_keys(&poly).unwrap();

        // Parties 1 and 3 are corrupt.
        let corrupted = [
            Share {
                x: shares[1].x,
                y: shares[1].y,
            },
            Share {
                x: shares[3].x,
                y: shares[3].y,
            },
        ];
        let (indices, proofs) = <TraceableShamir<Sha512> as TraceableSS<Fq>>::trace(
            &ts, &tk_secret, &corrupted, &mut rng,
        )
        .unwrap()
        .expect("should find the corrupt parties");

        assert_eq!(indices.len(), 2);
        assert!(indices.contains(&1));
        assert!(indices.contains(&3));
        ts.verify_trace(&indices, &proofs, &tk_public).unwrap();
    }

    #[test]
    fn trace_t4_f2_non_contiguous() {
        let mut rng = rng();
        let ts = TraceableShamir::<Sha512>::new(4, 6, 2, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();
        let (tk_secret, tk_public) = ts.compute_tracing_keys(&poly).unwrap();

        // Parties 0 and 4 are corrupt.
        let corrupted = [
            Share {
                x: shares[0].x,
                y: shares[0].y,
            },
            Share {
                x: shares[4].x,
                y: shares[4].y,
            },
        ];
        let (indices, proofs) = <TraceableShamir<Sha512> as TraceableSS<Fq>>::trace(
            &ts, &tk_secret, &corrupted, &mut rng,
        )
        .unwrap()
        .expect("should find the corrupt parties");

        assert_eq!(indices.len(), 2);
        assert!(indices.contains(&0));
        assert!(indices.contains(&4));
        ts.verify_trace(&indices, &proofs, &tk_public).unwrap();
    }
}
