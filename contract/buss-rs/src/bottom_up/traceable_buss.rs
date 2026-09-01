//! Traceable Bottom-Up Secret Sharing (TBUSS) with non-imputable tracing.
//!
//! Extends [`crate::BottomUpSSS`] with traceability and non-imputability, per
//! Hajra, Kar, Mukherjee, Pal — "Traceable Bottom-Up Secret Sharing and Law &
//! Order on Community Social Key Recovery", EPRINT 2025/2089.
//!
//! **Share.** Each guardian `j` picks their own random evaluation point `x_j`
//! (instead of the fixed integer `j` used by plain BUSS) together with their
//! share `σ_j`. The dealer interpolates the degree-(n−1) polynomial `q` with
//! `q(0) = secret` and `q(x_j) = σ_j` for all `n−1` guardians, publishes
//! `φ = (x_{-1}, q(x_{-1})), …` at fresh points, and computes a one-way
//! function `u_j = F(x_j)` for every guardian. `tk = vk = (u_1,…,u_{n-1})`
//! — the trace key and verification key coincide, and neither reveals the raw
//! `x_j` (non-imputability: nobody can forge an accusation without inverting `F`).
//!
//! **Trace** (§ Fig. 4, `Trace_TBUSS`, generalised to the OWF-gated setting).
//! Given `f ≤ t` corrupted guardians' leaked shares, repeatedly reconstruct
//! with fresh honest shares plus one perturbed probe point to obtain noisy
//! evaluations of the degree-`f` "traitor polynomial"
//! `h*(X) = Π_{j corrupt} (x_j − X)/x_j`. **Guruswami-Sudan list decoding** of
//! these evaluations recovers `h*` (and hence the corrupt `x_j` as its roots)
//! even when some queries are inconsistent. Because the trace key only holds
//! `u_j = F(x_j)`, roots are matched to guardians by recomputing `F` on each
//! candidate root rather than by direct comparison — this is what makes
//! tracing non-imputable.
//!
//! **`verify_trace`** checks `F(π_k) = vk[i_k]` for every accused guardian —
//! anyone holding `vk` can check a tracing proof without being able to forge one.

use digest::{Digest, OutputSizeUser};
use ff::{FromUniformBytes, PrimeField};
use rand_core::RngCore;

use super::buss::Share;
use crate::bottom_up::{lagrange_basis_at_point, BottumUpSS, TraceResult, TraceableBSS};
use crate::error::Error;
use crate::math::hash::{hash_fr, hash_poly};
use crate::math::list_decoding::guruswami_sudan;
use crate::math::polynomial::Polynomial;

/// Domain-separation label for this scheme's hash-to-field calls, so that
/// [`crate::secret_sharing::traceable_shamir`] (which shares the same
/// [`hash_poly`]/[`hash_fr`] helpers) can never collide with it. Used both to
/// derive pseudorandom evaluation points deterministically for
/// [`BottumUpSS::split`] (which has no `RngCore` parameter to draw true
/// randomness from), and as the one-way function `u_j = hash_fr(x_j)`
/// published in place of the raw evaluation point `x_j`: a tracer must
/// actually recover `x_j` (via list decoding) to accuse guardian `j` — they
/// cannot forge a proof from `vk` alone, since inverting the hash is assumed
/// hard.
const LABEL: &[u8] = b"ARC-PLEIADES-TBUSS-PHI-v1";

// ── Main struct ───────────────────────────────────────────────────────────────

/// Trace key = verification key: `n−1` one-way-function images `u_j = F(x_j)`,
/// one per guardian, in party order.
pub struct TracingKey<F: PrimeField>(pub Vec<F>);

/// Traceable, non-imputable Bottom-Up Secret Sharing.
///
/// Instantiate with the same `(t, n)` parameters as [`BottomUpSSS`], plus `f`
/// (the maximum number of corruptions [`TraceableBSS::trace`] is configured
/// to trace) and `sec_param`, used to size `num_queries`/`agreement`
/// internally inside `trace()`.
pub struct TraceableBuss<D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>> {
    t: usize,
    n: usize,
    f: usize,
    sec_param: usize,
    _phantom: std::marker::PhantomData<D>,
}

impl<D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>> TraceableBuss<D> {
    /// Create a (t+1)-out-of-(n−1) traceable BUSS instance.
    pub fn new(t: usize, n: usize, f: usize, sec_param: usize) -> Result<Self, Error> {
        if n < 2 {
            return Err(Error::InvalidParameters(format!(
                "n must be at least 2, got {n}"
            )));
        }
        if t >= n - 1 {
            return Err(Error::InvalidParameters(format!(
                "t ({t}) must be strictly less than n-1 ({})",
                n - 1
            )));
        }
        if f == 0 || f > t {
            return Err(Error::InvalidParameters("f must satisfy 0 < f <= t".into()));
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
            _phantom: std::marker::PhantomData,
        })
    }

    pub fn threshold(&self) -> usize {
        self.t + 1
    }

    pub fn num_shares(&self) -> usize {
        self.n - 1
    }

    pub fn phi_len(&self) -> usize {
        self.n - self.t - 1
    }
}

// ── BottumUpSS / TraceableBSS trait impls ──────────────────────────────────────

impl<
        F: PrimeField + FromUniformBytes<64>,
        D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>,
    > BottumUpSS<F> for TraceableBuss<D>
{
    type Share = Share<F>;

    /// Build `q(0) = secret`, `q(x_j) = σ_j` from the `n−1` guardian shares
    /// (each at its own random `x_j`), then evaluate it at `phi_len()` fresh
    /// points to produce φ.
    ///
    /// This has no `RngCore` parameter, so φ's evaluation points are derived
    /// by hashing `q`'s coefficients instead of sampling true randomness —
    /// the same technique [`crate::secret_sharing::traceable_shamir`] uses to
    /// derive its party x-coordinates. Checked for collisions against the
    /// guardian x's and against each other; an actual collision is as
    /// astronomically unlikely as any other duplicate-x case in this crate.
    fn split(&self, secret: F, shares: &[Self::Share]) -> Result<Vec<Self::Share>, Error> {
        if shares.len() != self.num_shares() {
            return Err(Error::InvalidParameters(format!(
                "expected {} guardian shares, got {}",
                self.num_shares(),
                shares.len()
            )));
        }
        let guardian_xs: Vec<F> = shares.iter().map(|s| s.x).collect();
        for (i, &xi) in guardian_xs.iter().enumerate() {
            if xi == F::ZERO {
                return Err(Error::InvalidParameters(
                    "guardian evaluation point x_j must be nonzero".into(),
                ));
            }
            if guardian_xs[i + 1..].contains(&xi) {
                return Err(Error::DuplicateXCoordinate);
            }
        }

        let mut points: Vec<(F, F)> = Vec::with_capacity(self.n);
        points.push((F::ZERO, secret));
        points.extend(shares.iter().map(|s| (s.x, s.y)));
        let q = Polynomial::interpolate(&points)?;

        let base = hash_poly::<D, F>(LABEL, &q);
        let mut phi: Vec<Share<F>> = Vec::with_capacity(self.phi_len());
        let mut counter = F::ZERO;
        while phi.len() < self.phi_len() {
            let x = hash_poly::<D, F>(LABEL, &Polynomial::new(vec![base, counter]));
            counter += F::ONE;
            if x == F::ZERO || guardian_xs.contains(&x) || phi.iter().any(|s| s.x == x) {
                continue;
            }
            phi.push(Share { x, y: q.eval(x) });
        }
        Ok(phi)
    }

    /// Reconstruct the secret from φ (`public_shares`) and at least `t+1`
    /// guardian shares.
    fn reconstruct(
        &self,
        public_shares: &[Self::Share],
        shares: &[Self::Share],
    ) -> Result<F, Error> {
        if public_shares.len() != self.phi_len() {
            return Err(Error::InvalidParameters(format!(
                "expected {} public shares, got {}",
                self.phi_len(),
                public_shares.len()
            )));
        }
        if shares.len() < self.threshold() {
            return Err(Error::InsufficientShares {
                need: self.threshold(),
                got: shares.len(),
            });
        }
        let mut points: Vec<(F, F)> = public_shares.iter().map(|s| (s.x, s.y)).collect();
        points.extend(shares[..self.threshold()].iter().map(|s| (s.x, s.y)));
        Polynomial::lagrange_at_zero(&points)
    }

    /// Shift φ in-place by Δ·L_{j,X} so `f(0)` is unchanged and `f(j)` moves by Δ.
    fn update_public_shares(
        &self,
        guardian_index: F,
        all_guardian_indices: &[F],
        delta: F,
        public_shares: &mut [Self::Share],
    ) -> Result<(), Error> {
        if public_shares.len() != self.phi_len() {
            return Err(Error::InvalidParameters(format!(
                "expected {} public shares, got {}",
                self.phi_len(),
                public_shares.len()
            )));
        }
        if !all_guardian_indices.contains(&guardian_index) {
            return Err(Error::InvalidParameters(
                "guardian_index not found in all_guardian_indices".into(),
            ));
        }
        for ps in public_shares.iter_mut() {
            let l = lagrange_basis_at_point(guardian_index, all_guardian_indices, ps.x)?;
            ps.y += delta * l;
        }
        Ok(())
    }
}

impl<
        F: PrimeField + FromUniformBytes<64>,
        D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>,
    > TraceableBSS<F> for TraceableBuss<D>
{
    type TracingSecretKey = TracingKey<F>;
    type TracingPublicKey = TracingKey<F>;
    type TracingProof = F;

    fn compute_tracing_keys(
        &self,
        shares: &[Self::Share],
    ) -> Result<(Self::TracingSecretKey, Self::TracingPublicKey), Error> {
        if shares.len() != self.num_shares() {
            return Err(Error::InvalidParameters(format!(
                "expected {} guardian shares, got {}",
                self.num_shares(),
                shares.len()
            )));
        }
        let vk: Vec<F> = shares.iter().map(|s| hash_fr::<D, F>(LABEL, s.x)).collect();
        Ok((TracingKey(vk.clone()), TracingKey(vk)))
    }

    /// Identify `f ≤ self.f` corrupted guardians given their leaked shares.
    ///
    /// `corrupted_shares` are the `f` shares held by the corrupted guardians;
    /// each query reconstructs on `corrupted_shares` plus freshly sampled
    /// shares plus one δ-shifted probe point to obtain a noisy evaluation of
    /// the traitor polynomial `h*`. `num_queries`/`agreement` are derived
    /// from `self.f`/`self.sec_param` fixed at construction.
    ///
    /// Returns `Ok(None)` if no candidate traitor polynomial matches `tk`.
    fn trace<R: RngCore>(
        &self,
        tk: &Self::TracingSecretKey,
        public_shares: &[Self::Share],
        corrupted_shares: &[Self::Share],
        rng: &mut R,
    ) -> TraceResult<Self::TracingProof> {
        let t = self.t;
        let f = corrupted_shares.len();
        if f == 0 || f > t {
            return Err(Error::InvalidParameters("f must satisfy 0 < f <= t".into()));
        }
        if public_shares.len() != self.phi_len() {
            return Err(Error::InvalidParameters(format!(
                "expected phi of length {}, got {}",
                self.phi_len(),
                public_shares.len()
            )));
        }
        if tk.0.len() != self.num_shares() {
            return Err(Error::InvalidParameters(format!(
                "expected vk of length {}, got {}",
                self.num_shares(),
                tk.0.len()
            )));
        }

        // h_φ(x) = Π_{(x_{-i}, _) ∈ φ} (x_{-i} - x) / x_{-i}.
        let h_phi = |x: F| -> Result<F, Error> {
            let mut val = F::ONE;
            for s in public_shares {
                let xn_inv = Option::<F>::from(s.x.invert()).ok_or_else(|| {
                    Error::InvalidParameters("φ contains a zero evaluation point".into())
                })?;
                val *= (s.x - x) * xn_inv;
            }
            Ok(val)
        };

        let num_queries = 4 * self.f * self.sec_param;
        let agreement = ((self.f * num_queries) as f64).sqrt().ceil() as usize;

        // Number of fresh "honest" shares per query: shares_first/second need
        // f (corrupt) + n_fresh + 1 (probe) = threshold() = t+1 total points.
        let n_fresh = t - f;

        let mut gs_pts: Vec<(F, F)> = Vec::new();

        for _ in 0..num_queries {
            // Sample t-f fresh random shares (x_{ℓ,i}, σ_{ℓ,i}) ←$ F².
            let mut fresh: Vec<Share<F>> = Vec::with_capacity(n_fresh);
            for _ in 0..n_fresh {
                let x = F::random(&mut *rng);
                let y = F::random(&mut *rng);
                fresh.push(Share { x, y });
            }
            let x = F::random(&mut *rng);
            let y = F::random(&mut *rng);
            let delta = F::random(&mut *rng);

            // Reconstructing secret on [corrupted_shares, fresh, (x, y)]
            fresh.push(Share { x, y });
            let mut shares_first: Vec<Share<F>> = corrupted_shares
                .iter()
                .map(|s| Share { x: s.x, y: s.y })
                .collect();
            shares_first.extend(fresh.iter().map(|s| Share { x: s.x, y: s.y }));
            let s_single = match self.reconstruct(public_shares, &shares_first) {
                Ok(v) => v,
                Err(_) => return Err(Error::TracingError("Oracle error".into())),
            };

            // Reconstructing secret on [corrupted_shares, fresh, (x, y + delta)]
            fresh.pop();
            fresh.push(Share { x, y: y + delta });
            let mut shares_second: Vec<Share<F>> = corrupted_shares
                .iter()
                .map(|s| Share { x: s.x, y: s.y })
                .collect();
            shares_second.extend(fresh.iter().map(|s| Share { x: s.x, y: s.y }));
            fresh.pop();
            let s_second = match self.reconstruct(public_shares, &shares_second) {
                Ok(v) => v,
                Err(_) => return Err(Error::TracingError("Oracle error".into())),
            };

            let h_val = h_phi(x).unwrap();

            // If returned secrets are equal, delta is 0, or x in fresh, terminate.
            if s_single.eq(&s_second)
                || delta.is_zero_vartime()
                || fresh.iter().any(|s| s.x.eq(&x))
                || h_val.is_zero_vartime()
            {
                return Err(Error::TracingError("Query error".into()));
            }

            // z = δ / ((s'-s) · h_φ(x)) · Π_fresh x_{ℓ,i}/(x_{ℓ,i}-x) evaluates h*(x).
            let weighted_diff_inv = (h_val * (s_second - s_single)).invert().unwrap();
            let z = fresh.into_iter().fold(delta * weighted_diff_inv, |acc, s| {
                let inv = (s.x - x).invert().unwrap();
                acc * s.x * inv
            });

            gs_pts.push((x, z));
        }

        if gs_pts.len() < agreement {
            return Err(Error::TracingError(format!(
                "collected only {} valid evaluations; need >= {} (agreement C)",
                gs_pts.len(),
                agreement
            )));
        }

        // Guruswami-Sudan list decoding on the M pairs (x'_ℓ, z_ℓ).
        let candidates = guruswami_sudan::<F>(&gs_pts, f, agreement, rng);

        if candidates.is_empty() {
            return Err(Error::TracingError(
                "GS decoder returned empty list; oracle may be ill-formed".into(),
            ));
        }

        // Filter candidates by matching each root's OWF image against tk,
        // and take the first fully-matching candidate.
        for h in &candidates {
            let roots = match h.roots(rng) {
                Ok(r) if !r.is_empty() => r,
                _ => continue,
            };

            let mut matched: Vec<(usize, F)> = Vec::with_capacity(roots.len());
            let mut ok = true;
            for &r in &roots {
                let u = hash_fr::<D, F>(LABEL, r);
                match tk.0.iter().position(|&uk| uk == u) {
                    Some(pos) => matched.push((pos, r)),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }

            let (indices, witness): (Vec<usize>, Vec<F>) = matched.into_iter().unzip();
            return Ok(Some((indices, witness)));
        }

        Ok(None)
    }

    /// `Verify(vk, I, π)`: check `F(π_k) = vk[i_k]` for every accused guardian.
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
            if vk.0[idx] != hash_fr::<D, F>(LABEL, w) {
                return Err(Error::TracingVerificationError(format!(
                    "Invalid proof for index #{}",
                    idx
                )));
            }
        }
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ff::Field;
    use midnight_curves::Fq;
    use sha2::Sha512;

    fn rng() -> impl RngCore {
        rand::thread_rng()
    }

    fn distinct_nonzero(n: usize, rng: &mut impl RngCore) -> Vec<Fq> {
        let mut v = Vec::with_capacity(n);
        while v.len() < n {
            let x = Fq::random(&mut *rng);
            if x != Fq::ZERO && !v.contains(&x) {
                v.push(x);
            }
        }
        v
    }

    fn guardian_shares(n: usize, rng: &mut impl RngCore) -> Vec<Share<Fq>> {
        distinct_nonzero(n, rng)
            .into_iter()
            .map(|x| Share {
                x,
                y: Fq::random(&mut *rng),
            })
            .collect()
    }

    // ── Split / Reconstruct ───────────────────────────────────────────────────

    #[test]
    fn split_and_reconstruct_roundtrip() {
        let mut rng = rng();
        let tbuss = TraceableBuss::<Sha512>::new(2, 5, 1, 4).unwrap(); // threshold=3, shares=4, phi_len=2
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(4, &mut rng);

        let phi = tbuss.split(secret, &shares).unwrap();
        assert_eq!(phi.len(), 2);

        let recovered = tbuss.reconstruct(&phi, &shares[..3]).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn reconstruct_with_any_threshold_subset() {
        let mut rng = rng();
        let tbuss = TraceableBuss::<Sha512>::new(1, 4, 1, 4).unwrap(); // threshold=2, shares=3, phi_len=2
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(3, &mut rng);

        let phi = tbuss.split(secret, &shares).unwrap();

        for i in 0..3 {
            for j in (i + 1)..3 {
                let subset = [
                    Share {
                        x: shares[i].x,
                        y: shares[i].y,
                    },
                    Share {
                        x: shares[j].x,
                        y: shares[j].y,
                    },
                ];
                let recovered = tbuss.reconstruct(&phi, &subset).unwrap();
                assert_eq!(recovered, secret, "failed with guardians ({i},{j})");
            }
        }
    }

    #[test]
    fn reconstruct_below_threshold_errors() {
        let mut rng = rng();
        let tbuss = TraceableBuss::<Sha512>::new(1, 3, 1, 4).unwrap(); // threshold=2
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(2, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();
        let err = tbuss.reconstruct(&phi, &shares[..1]);
        assert!(matches!(err, Err(Error::InsufficientShares { .. })));
    }

    #[test]
    fn split_wrong_guardian_count_errors() {
        let mut rng = rng();
        let tbuss = TraceableBuss::<Sha512>::new(1, 4, 1, 4).unwrap(); // expects 3 guardians
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(2, &mut rng);
        let err = tbuss.split(secret, &shares);
        assert!(matches!(err, Err(Error::InvalidParameters(_))));
    }

    #[test]
    fn split_duplicate_x_errors() {
        let mut rng = rng();
        let tbuss = TraceableBuss::<Sha512>::new(1, 3, 1, 4).unwrap(); // expects 2 guardians
        let secret = Fq::random(&mut rng);
        let x = Fq::random(&mut rng);
        let shares = vec![
            Share {
                x,
                y: Fq::random(&mut rng),
            },
            Share {
                x,
                y: Fq::random(&mut rng),
            },
        ];
        let err = tbuss.split(secret, &shares);
        assert!(matches!(err, Err(Error::DuplicateXCoordinate)));
    }

    // ── Trace / verify_trace ──────────────────────────────────────────────────

    #[test]
    fn trace_perfect_box_identifies_single_corrupt_guardian() {
        let mut rng = rng();
        // t=1, n=3: f=t=1, so n_fresh = 0 — only the probe is supplied per query.
        let tbuss = TraceableBuss::<Sha512>::new(1, 3, 1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(2, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();
        let (tk, vk) = tbuss.compute_tracing_keys(&shares).unwrap();

        // Guardian at index 0 is corrupt.
        let corrupted = [Share {
            x: shares[0].x,
            y: shares[0].y,
        }];
        let (indices, proofs) = tbuss
            .trace(&tk, &phi, &corrupted, &mut rng)
            .unwrap()
            .expect("should find the corrupt guardian");

        assert_eq!(indices, vec![0]);
        assert_eq!(proofs, vec![shares[0].x]);
        tbuss.verify_trace(&indices, &proofs, &vk).unwrap();
    }

    #[test]
    fn trace_imperfect_box_identifies_single_corrupt_guardian() {
        let mut rng = rng();
        // t=3, n=6: threshold=4, shares=5, phi_len=2. f=1 -> n_fresh = t-f = 2.
        let tbuss = TraceableBuss::<Sha512>::new(3, 6, 1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(5, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();
        let (tk, vk) = tbuss.compute_tracing_keys(&shares).unwrap();

        // Guardian at index 2 is corrupt.
        let corrupted = [Share {
            x: shares[2].x,
            y: shares[2].y,
        }];
        let (indices, proofs) = tbuss
            .trace(&tk, &phi, &corrupted, &mut rng)
            .unwrap()
            .expect("should find the corrupt guardian");

        assert_eq!(indices, vec![2]);
        assert_eq!(proofs, vec![shares[2].x]);
        tbuss.verify_trace(&indices, &proofs, &vk).unwrap();
    }

    #[test]
    fn trace_imperfect_box_identifies_two_corrupt_guardians() {
        let mut rng = rng();
        // t=4, n=7: threshold=5, shares=6, phi_len=2. f=2 -> n_fresh = t-f = 2.
        let tbuss = TraceableBuss::<Sha512>::new(4, 7, 2, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(6, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();
        let (tk, vk) = tbuss.compute_tracing_keys(&shares).unwrap();

        // Guardians at indices 0 and 4 are corrupt.
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
        let (indices, proofs) = tbuss
            .trace(&tk, &phi, &corrupted, &mut rng)
            .unwrap()
            .expect("should find the corrupt guardians");

        // Don't sort: `proofs` is positionally paired with `indices`.
        assert_eq!(indices.len(), 2);
        assert!(indices.contains(&0));
        assert!(indices.contains(&4));
        tbuss.verify_trace(&indices, &proofs, &vk).unwrap();
    }

    #[test]
    fn trace_invalid_f_errors() {
        let mut rng = rng();
        let tbuss = TraceableBuss::<Sha512>::new(2, 5, 1, 4).unwrap(); // t=2
        let phi = vec![
            Share {
                x: Fq::ONE,
                y: Fq::ONE,
            },
            Share {
                x: Fq::from(2u64),
                y: Fq::ONE,
            },
        ];
        let tk = TracingKey(vec![Fq::ONE; 4]);

        let no_corrupted: [Share<Fq>; 0] = [];
        let err = tbuss.trace(&tk, &phi, &no_corrupted, &mut rng);
        assert!(matches!(err, Err(Error::InvalidParameters(_))));

        let too_many_corrupted = [
            Share {
                x: Fq::ONE,
                y: Fq::ONE,
            },
            Share {
                x: Fq::ONE,
                y: Fq::ONE,
            },
            Share {
                x: Fq::ONE,
                y: Fq::ONE,
            },
        ];
        let err2 = tbuss.trace(&tk, &phi, &too_many_corrupted, &mut rng);
        assert!(matches!(err2, Err(Error::InvalidParameters(_))));
    }

    #[test]
    fn verify_trace_wrong_witness_fails() {
        let mut rng = rng();
        let tbuss = TraceableBuss::<Sha512>::new(1, 3, 1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(2, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();
        let (tk, vk) = tbuss.compute_tracing_keys(&shares).unwrap();

        let corrupted = [Share {
            x: shares[0].x,
            y: shares[0].y,
        }];
        let (indices, _) = tbuss
            .trace(&tk, &phi, &corrupted, &mut rng)
            .unwrap()
            .expect("should find the corrupt guardian");

        let fake_witness = vec![Fq::random(&mut rng)];
        let err = tbuss.verify_trace(&indices, &fake_witness, &vk);
        assert!(matches!(err, Err(Error::TracingVerificationError(_))));
    }

    #[test]
    fn verify_trace_mismatched_lengths_fails() {
        let mut rng = rng();
        let tbuss = TraceableBuss::<Sha512>::new(1, 3, 1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(2, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();
        let (tk, vk) = tbuss.compute_tracing_keys(&shares).unwrap();

        let corrupted = [Share {
            x: shares[0].x,
            y: shares[0].y,
        }];
        let (indices, _proofs) = tbuss
            .trace(&tk, &phi, &corrupted, &mut rng)
            .unwrap()
            .expect("should find the corrupt guardian");

        let err = tbuss.verify_trace(&indices, &[], &vk);
        assert!(matches!(err, Err(Error::TracingVerificationError(_))));
    }
}
