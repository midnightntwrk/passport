use std::ops::{Add, Mul, Neg, Sub};

use ff::PrimeField;
use rand_core::RngCore;

use super::fft::{fft, ifft};
use crate::error::Error;

// ── Polynomial ────────────────────────────────────────────────────────────────

/// A polynomial over any `PrimeField`.
///
/// Coefficients are stored in ascending power order: `coeffs[i]` is the
/// coefficient of x^i, so `coeffs[0]` is the constant term f(0).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Polynomial<F> {
    coeffs: Vec<F>,
}

// ── Construction ──────────────────────────────────────────────────────────────

impl<F: PrimeField> Polynomial<F> {
    /// Create a polynomial from a coefficient vector (ascending power order).
    /// An empty vector is the zero polynomial.
    pub fn new(coeffs: Vec<F>) -> Self {
        Self { coeffs }
    }

    /// The zero polynomial.
    pub fn zero() -> Self {
        Self { coeffs: vec![] }
    }

    /// The constant polynomial f(x) = c.
    pub fn constant(c: F) -> Self {
        Self { coeffs: vec![c] }
    }

    /// A uniformly random polynomial of the given degree.
    pub fn random<R: RngCore>(degree: usize, rng: &mut R) -> Self {
        let coeffs = (0..=degree).map(|_| F::random(&mut *rng)).collect();
        Self { coeffs }
    }

    /// A uniformly random polynomial of the given degree whose constant term
    /// equals `secret` (i.e., f(0) = secret).
    ///
    /// This is the core constructor for Shamir Secret Sharing.
    pub fn random_with_secret<R: RngCore>(secret: F, degree: usize, rng: &mut R) -> Self {
        let mut coeffs = Vec::with_capacity(degree + 1);
        coeffs.push(secret);
        for _ in 0..degree {
            coeffs.push(F::random(&mut *rng));
        }
        Self { coeffs }
    }

    /// Recover the unique polynomial of degree < k passing through the given k
    /// points via Lagrange interpolation. O(k²) time and space.
    ///
    /// Builds the node polynomial `M(x) = Π(x − xᵢ)` once (O(k²)), then
    /// recovers each Lagrange basis polynomial `Lᵢ(x) = M(x) / (x − xᵢ)` via
    /// O(k) synthetic division instead of re-multiplying k−1 factors from
    /// scratch per point — the latter would cost O(k) per point on top of the
    /// O(k) accumulation already needed, for O(k³) overall.
    ///
    /// For Shamir reconstruction use [`Self::lagrange_at_zero`] — it avoids
    /// building the full coefficient vector.
    ///
    /// Returns `Error::DuplicateXCoordinate` if any two x-coordinates coincide.
    pub fn interpolate(points: &[(F, F)]) -> Result<Self, Error> {
        if points.is_empty() {
            return Ok(Self::zero());
        }
        let k = points.len();

        // M(x) = Π (x - x_i), built once via k multiplications by a linear
        // factor — O(k²) total, not O(k) — since `m` grows in degree each time.
        let mut m = Self::constant(F::ONE);
        for &(xi, _) in points {
            m = &m * &Self::new(vec![-xi, F::ONE]);
        }
        let m_coeffs = m.coeffs();

        let mut result = vec![F::ZERO; k];
        for &(xi, yi) in points {
            // Synthetic division: q(x) = M(x) / (x - xi), O(k). Valid because
            // xi is a root of M by construction (remainder is 0).
            let mut q = vec![F::ZERO; k];
            q[k - 1] = m_coeffs[k];
            for idx in (0..k - 1).rev() {
                q[idx] = m_coeffs[idx + 1] + xi * q[idx + 1];
            }

            // denom = q(xi) = Π_{j≠i} (xi - xj) — this is M'(xi), which
            // synthetic division gives us directly as q(xi). O(k) via Horner.
            let denom = q.iter().rev().fold(F::ZERO, |acc, &c| acc * xi + c);
            let denom_inv = Option::<F>::from(denom.invert()).ok_or(Error::DuplicateXCoordinate)?;
            let scale = yi * denom_inv;

            for (j, &c) in q.iter().enumerate() {
                result[j] += scale * c;
            }
        }

        Ok(Self::new(result))
    }

    /// Evaluate the Lagrange interpolant through the given points at x = 0.
    ///
    /// Two paths depending on the x-coordinates:
    ///
    /// **iFFT path — O(k log k):** when the k points are at exactly the k-th
    /// roots of unity in order (`ω⁰, ω¹, …, ω^{k-1}` with k a power of two),
    /// iFFT recovers the polynomial coefficients and `coeffs[0] = f(0)` is
    /// returned directly. This is the natural companion to [`Self::eval_fft`].
    ///
    /// **Direct Lagrange — O(k²):** for arbitrary evaluation points (e.g.,
    /// integers 1, 2, …, k as in standard Shamir SSS).
    ///
    /// Returns `Error::DuplicateXCoordinate` if any two x-coordinates coincide.
    pub fn lagrange_at_zero(points: &[(F, F)]) -> Result<F, Error> {
        let k = points.len();
        // iFFT fast path: x-coordinates are ω^0, ω^1, …, ω^{k-1} in order.
        if k >= 2 && k.is_power_of_two() && points[0].0 == F::ONE {
            let omega = points[1].0;
            if omega != F::ONE {
                let mut expected = F::ONE;
                let roots_ok = points.iter().all(|(x, _)| {
                    let ok = *x == expected;
                    expected *= omega;
                    ok
                });
                if roots_ok && expected == F::ONE {
                    let mut evals: Vec<F> = points.iter().map(|(_, y)| *y).collect();
                    ifft(&mut evals);
                    return Ok(evals[0]);
                }
            }
        }
        // Direct O(k²) Lagrange.
        let mut secret = F::ZERO;
        for i in 0..k {
            let (xi, yi) = points[i];
            let mut num = F::ONE;
            let mut den = F::ONE;
            for (j, &(xj, _)) in points.iter().enumerate().take(k) {
                if i == j {
                    continue;
                }
                num *= -xj;
                den *= xi - xj;
            }
            let inv = Option::<F>::from(den.invert()).ok_or(Error::DuplicateXCoordinate)?;
            secret += yi * num * inv;
        }
        Ok(secret)
    }

    // ── Properties ────────────────────────────────────────────────────────────

    /// Degree of the polynomial. Returns 0 for both constant and zero polynomials.
    pub fn degree(&self) -> usize {
        self.coeffs.len().saturating_sub(1)
    }

    /// Number of stored coefficients (`degree + 1` for non-zero, 0 for zero polynomial).
    pub fn len(&self) -> usize {
        self.coeffs.len()
    }

    /// Returns `true` if this polynomial has no coefficients (equivalent to [`is_zero`](Self::is_zero)).
    pub fn is_empty(&self) -> bool {
        self.coeffs.is_empty()
    }

    /// Returns `true` if this is the zero polynomial.
    pub fn is_zero(&self) -> bool {
        self.coeffs.is_empty() || self.coeffs.iter().all(|c| *c == F::ZERO)
    }

    /// Access the underlying coefficient slice (ascending power order).
    pub fn coeffs(&self) -> &[F] {
        &self.coeffs
    }

    /// Remove trailing zero coefficients.
    pub fn trim(mut self) -> Self {
        while self.coeffs.last() == Some(&F::ZERO) {
            self.coeffs.pop();
        }
        self
    }

    // ── Evaluation ────────────────────────────────────────────────────────────

    /// Evaluate at `x` using Horner's method. O(degree).
    pub fn eval(&self, x: F) -> F {
        if self.coeffs.is_empty() {
            return F::ZERO;
        }
        let mut acc = self.coeffs[self.coeffs.len() - 1];
        for c in self.coeffs[..self.coeffs.len() - 1].iter().rev() {
            acc = acc * x + *c;
        }
        acc
    }

    /// Evaluate at all n-th roots of unity using FFT. O(n log n).
    ///
    /// The domain size n is the next power of two ≥ `self.len()`, minimum 2.
    /// The polynomial is zero-extended to fill the domain.
    ///
    /// Returns `(evals, log_n)` where `evals[k] = f(ω^k)` and
    /// `ω = root_of_unity(log_n)`.
    pub fn eval_fft(&self) -> (Vec<F>, u32) {
        let n = self.coeffs.len().next_power_of_two().max(2);
        let log_n = n.trailing_zeros();
        let mut a = vec![F::ZERO; n];
        a[..self.coeffs.len()].copy_from_slice(&self.coeffs);
        fft(&mut a);
        (a, log_n)
    }

    /// Recover polynomial coefficients from evaluations at n-th roots of unity.
    ///
    /// The inverse of [`Self::eval_fft`]. Input length must be a power of two.
    /// Trailing zeros from zero-padding are preserved; call [`Self::trim`] to
    /// remove them.
    pub fn from_evals_fft(evals: &[F]) -> Self {
        let mut a = evals.to_vec();
        ifft(&mut a);
        Self::new(a)
    }

    // ── Division, GCD, and root-finding ──────────────────────────────────────

    /// Polynomial long division: returns `(quotient, remainder)` such that
    /// `self = quotient * divisor + remainder`.
    ///
    /// # Panics
    /// Panics if `divisor` is the zero polynomial.
    pub fn div_rem(&self, divisor: &Self) -> (Self, Self) {
        let b = divisor.clone().trim();
        if b.is_zero() {
            panic!("div_rem: divisor is zero");
        }
        let deg_b = b.coeffs.len() - 1;
        let lc_inv = Option::<F>::from(b.coeffs[deg_b].invert()).expect("leading coeff nonzero");
        let mut r = self.clone().trim();
        let mut q_coeffs: Vec<F> = Vec::new();
        while r.coeffs.len() > deg_b {
            let deg_r = r.coeffs.len() - 1;
            let coeff = r.coeffs[deg_r] * lc_inv;
            let shift = deg_r - deg_b;
            if q_coeffs.len() <= shift {
                q_coeffs.resize(shift + 1, F::ZERO);
            }
            q_coeffs[shift] = coeff;
            for j in 0..=deg_b {
                r.coeffs[shift + j] -= coeff * b.coeffs[j];
            }
            r = r.trim();
        }
        (Self::new(q_coeffs), r)
    }

    /// Monic GCD via the Euclidean algorithm.
    pub fn gcd(a: Self, b: Self) -> Self {
        let mut a = a.trim();
        let mut b = b.trim();
        while !b.is_zero() {
            let (_, rem) = a.div_rem(&b);
            a = b;
            b = rem;
        }
        if let Some(&lc) = a.coeffs.last() {
            if let Some(inv) = Option::<F>::from(lc.invert()) {
                for c in a.coeffs.iter_mut() {
                    *c *= inv;
                }
            }
        }
        a
    }

    /// Fast exponentiation: `self^exp mod modulus`, where `exp_bits` is MSB-first.
    pub fn pow_mod(&self, exp_bits: &[bool], modulus: &Self) -> Self {
        let mut result = Self::constant(F::ONE);
        for &bit in exp_bits {
            result = (&result * &result).div_rem(modulus).1;
            if bit {
                result = (&result * self).div_rem(modulus).1;
            }
        }
        result
    }

    /// Find all roots of this polynomial in F via Cantor–Zassenhaus equal-degree
    /// factorisation.
    ///
    /// Assumes all irreducible factors are linear (all roots lie in the base
    /// field).  Returns `Err(())` if factorisation fails after many attempts
    /// (extremely unlikely over a large prime field such as BLS12-381 Fq).
    #[allow(clippy::result_unit_err)]
    pub fn roots<R: RngCore>(&self, rng: &mut R) -> Result<Vec<F>, ()> {
        let g = self.clone().trim();
        let deg = g.degree();
        if g.is_zero() || deg == 0 {
            return Ok(vec![]);
        }
        if deg == 1 {
            let inv = Option::<F>::from(g.coeffs[1].invert()).ok_or(())?;
            return Ok(vec![-g.coeffs[0] * inv]);
        }
        // Bits of (p−1)/2: clear the LSB of p (always 1) and drop the trailing zero.
        let exp_bits = {
            let mut bits = field_char_bits::<F>();
            let n = bits.len();
            bits[n - 1] = false;
            bits.pop();
            bits
        };
        for _ in 0..128 {
            let a = F::random(&mut *rng);
            let base = Self::new(vec![a, F::ONE]);
            let w = base.pow_mod(&exp_bits, &g);
            let w1 = (w - Self::constant(F::ONE)).trim();
            let h1 = Self::gcd(g.clone(), w1);
            let dh1 = h1.degree();
            if h1.is_zero() || dh1 == 0 || dh1 == deg {
                continue;
            }
            let (h2, _) = g.div_rem(&h1);
            let mut roots = h1.roots(rng)?;
            roots.extend(h2.roots(rng)?);
            return Ok(roots);
        }
        Err(())
    }
}

// ── Arithmetic operators ──────────────────────────────────────────────────────

impl<F: PrimeField> Neg for Polynomial<F> {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(self.coeffs.into_iter().map(|c| -c).collect())
    }
}

impl<F: PrimeField> Neg for &Polynomial<F> {
    type Output = Polynomial<F>;
    fn neg(self) -> Polynomial<F> {
        Polynomial::new(self.coeffs.iter().map(|c| -*c).collect())
    }
}

impl<F: PrimeField> Add<&Polynomial<F>> for &Polynomial<F> {
    type Output = Polynomial<F>;
    fn add(self, rhs: &Polynomial<F>) -> Polynomial<F> {
        let len = self.coeffs.len().max(rhs.coeffs.len());
        let mut coeffs = vec![F::ZERO; len];
        for (i, &c) in self.coeffs.iter().enumerate() {
            coeffs[i] += c;
        }
        for (i, &c) in rhs.coeffs.iter().enumerate() {
            coeffs[i] += c;
        }
        Polynomial::new(coeffs)
    }
}

impl<F: PrimeField> Add for Polynomial<F> {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        &self + &rhs
    }
}

impl<F: PrimeField> Sub<&Polynomial<F>> for &Polynomial<F> {
    type Output = Polynomial<F>;
    fn sub(self, rhs: &Polynomial<F>) -> Polynomial<F> {
        let len = self.coeffs.len().max(rhs.coeffs.len());
        let mut coeffs = vec![F::ZERO; len];
        for (i, &c) in self.coeffs.iter().enumerate() {
            coeffs[i] += c;
        }
        for (i, &c) in rhs.coeffs.iter().enumerate() {
            coeffs[i] -= c;
        }
        Polynomial::new(coeffs)
    }
}

impl<F: PrimeField> Sub for Polynomial<F> {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        &self - &rhs
    }
}

impl<F: PrimeField> Mul<F> for &Polynomial<F> {
    type Output = Polynomial<F>;
    fn mul(self, scalar: F) -> Polynomial<F> {
        Polynomial::new(self.coeffs.iter().map(|&c| c * scalar).collect())
    }
}

impl<F: PrimeField> Mul<F> for Polynomial<F> {
    type Output = Self;
    fn mul(self, scalar: F) -> Self {
        &self * scalar
    }
}

impl<F: PrimeField> Mul<&Polynomial<F>> for &Polynomial<F> {
    type Output = Polynomial<F>;
    fn mul(self, rhs: &Polynomial<F>) -> Polynomial<F> {
        if self.coeffs.is_empty() || rhs.coeffs.is_empty() {
            return Polynomial::zero();
        }
        let n = self.coeffs.len() + rhs.coeffs.len() - 1;
        let mut coeffs = vec![F::ZERO; n];
        for (i, &a) in self.coeffs.iter().enumerate() {
            for (j, &b) in rhs.coeffs.iter().enumerate() {
                coeffs[i + j] += a * b;
            }
        }
        Polynomial::new(coeffs)
    }
}

impl<F: PrimeField> Mul for Polynomial<F> {
    type Output = Self;
    fn mul(self, rhs: Self) -> Self {
        &self * &rhs
    }
}

/// Parse `F::MODULUS` (a hex string) into MSB-first bits of p, leading zeros stripped.
fn field_char_bits<F: PrimeField>() -> Vec<bool> {
    let hex = F::MODULUS
        .strip_prefix("0x")
        .or_else(|| F::MODULUS.strip_prefix("0X"))
        .unwrap_or(F::MODULUS);
    let mut bits = Vec::with_capacity(hex.len() * 4);
    let mut started = false;
    for ch in hex.chars() {
        let nibble =
            u8::from_str_radix(&ch.to_string(), 16).expect("F::MODULUS contains non-hex char");
        for b in (0..4u8).rev() {
            let bit = (nibble >> b) & 1 != 0;
            if bit {
                started = true;
            }
            if started {
                bits.push(bit);
            }
        }
    }
    bits
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::fft::root_of_unity;
    use ff::Field;
    use midnight_curves::Fq;
    use rand::thread_rng;

    fn rng() -> impl RngCore {
        thread_rng()
    }

    fn random_coeffs(degree: usize) -> Vec<Fq> {
        let mut rng = thread_rng();
        (0..=degree).map(|_| Fq::random(&mut rng)).collect()
    }

    // ── Construction ──────────────────────────────────────────────────────────

    #[test]
    fn constant_term_equals_secret() {
        let mut rng = rng();
        let secret = Fq::random(&mut rng);
        let poly = Polynomial::random_with_secret(secret, 3, &mut rng);
        assert_eq!(poly.coeffs()[0], secret);
        assert_eq!(poly.degree(), 3);
        assert_eq!(poly.len(), 4);
    }

    #[test]
    fn eval_at_zero_returns_constant_term() {
        let mut rng = rng();
        let secret = Fq::random(&mut rng);
        let poly = Polynomial::random_with_secret(secret, 4, &mut rng);
        assert_eq!(poly.eval(Fq::ZERO), secret);
    }

    // ── root_of_unity ─────────────────────────────────────────────────────────

    #[test]
    fn root_of_unity_has_correct_order() {
        for log_n in 1u32..=8 {
            let omega: Fq = root_of_unity(log_n);
            let n = 1u64 << log_n;
            assert_eq!(omega.pow_vartime([n, 0, 0, 0]), Fq::ONE, "log_n={log_n}");
            assert_eq!(
                omega.pow_vartime([n / 2, 0, 0, 0]),
                -Fq::ONE,
                "log_n={log_n}"
            );
        }
    }

    // ── Horner evaluation ─────────────────────────────────────────────────────

    #[test]
    fn horner_linear_polynomial() {
        let p = Polynomial::new(vec![Fq::from(2u64), Fq::from(3u64)]);
        assert_eq!(p.eval(Fq::from(5u64)), Fq::from(17u64));
    }

    #[test]
    fn horner_constant_polynomial() {
        let c = Fq::from(42u64);
        let p = Polynomial::constant(c);
        for x in [Fq::ZERO, Fq::ONE, Fq::from(99u64)] {
            assert_eq!(p.eval(x), c);
        }
    }

    #[test]
    fn horner_zero_polynomial() {
        assert_eq!(Polynomial::<Fq>::zero().eval(Fq::from(7u64)), Fq::ZERO);
    }

    // ── FFT / iFFT ────────────────────────────────────────────────────────────

    #[test]
    fn fft_ifft_roundtrip() {
        let coeffs = random_coeffs(7);
        let poly = Polynomial::new(coeffs.clone());
        let (evals, _) = poly.eval_fft();
        let recovered = Polynomial::from_evals_fft(&evals);
        for (a, b) in coeffs.iter().zip(recovered.coeffs().iter()) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn fft_ifft_roundtrip_non_power_of_two_input() {
        let coeffs = random_coeffs(5); // 6 coefficients → padded to 8
        let poly = Polynomial::new(coeffs.clone());
        let (evals, _) = poly.eval_fft();
        assert_eq!(evals.len(), 8);
        let recovered = Polynomial::from_evals_fft(&evals);
        for (a, b) in coeffs.iter().zip(recovered.coeffs().iter()) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn fft_eval_matches_horner() {
        let mut rng = rng();
        let poly = Polynomial::<Fq>::random(5, &mut rng);
        let (evals, log_n) = poly.eval_fft();
        let omega: Fq = root_of_unity(log_n);
        let mut x = Fq::ONE;
        for &y_fft in &evals {
            assert_eq!(poly.eval(x), y_fft);
            x *= omega;
        }
    }

    #[test]
    fn fft_constant_polynomial() {
        let mut rng = rng();
        let c = Fq::random(&mut rng);
        let (evals, _) = Polynomial::constant(c).eval_fft();
        for y in &evals {
            assert_eq!(*y, c);
        }
    }

    #[test]
    fn from_evals_fft_roundtrip() {
        let mut rng = rng();
        let poly = Polynomial::<Fq>::random(7, &mut rng);
        let (evals, _) = poly.eval_fft();
        let recovered = Polynomial::from_evals_fft(&evals).trim();
        assert_eq!(poly, recovered);
    }

    // ── Lagrange interpolation ────────────────────────────────────────────────

    #[test]
    fn lagrange_at_zero_recovers_secret() {
        let mut rng = rng();
        let secret = Fq::random(&mut rng);
        let poly = Polynomial::random_with_secret(secret, 3, &mut rng);
        let points: Vec<(Fq, Fq)> = (1u64..=4)
            .map(|i| {
                let x = Fq::from(i);
                (x, poly.eval(x))
            })
            .collect();
        assert_eq!(Polynomial::lagrange_at_zero(&points).unwrap(), secret);
    }

    #[test]
    fn lagrange_at_zero_uses_ifft_for_root_of_unity_points() {
        let mut rng = rng();
        let secret = Fq::random(&mut rng);
        let poly = Polynomial::random_with_secret(secret, 3, &mut rng);
        let omega: Fq = root_of_unity(2); // 4-th root of unity → 4 points
        let mut x = Fq::ONE;
        let points: Vec<(Fq, Fq)> = (0..4)
            .map(|_| {
                let p = (x, poly.eval(x));
                x *= omega;
                p
            })
            .collect();
        assert_eq!(Polynomial::lagrange_at_zero(&points).unwrap(), secret);
    }

    #[test]
    fn lagrange_at_zero_fft_and_direct_agree() {
        let mut rng = rng();
        let secret = Fq::random(&mut rng);
        let poly = Polynomial::random_with_secret(secret, 3, &mut rng);
        let omega: Fq = root_of_unity(2);

        let mut x = Fq::ONE;
        let rou_points: Vec<(Fq, Fq)> = (0..4)
            .map(|_| {
                let p = (x, poly.eval(x));
                x *= omega;
                p
            })
            .collect();
        let int_points: Vec<(Fq, Fq)> = (1u64..=4)
            .map(|i| {
                let xi = Fq::from(i);
                (xi, poly.eval(xi))
            })
            .collect();

        assert_eq!(Polynomial::lagrange_at_zero(&rou_points).unwrap(), secret);
        assert_eq!(Polynomial::lagrange_at_zero(&int_points).unwrap(), secret);
    }

    #[test]
    fn lagrange_duplicate_x_returns_error() {
        let points = vec![(Fq::ONE, Fq::ZERO), (Fq::ONE, Fq::ONE)];
        assert!(matches!(
            Polynomial::lagrange_at_zero(&points),
            Err(Error::DuplicateXCoordinate)
        ));
    }

    #[test]
    fn interpolate_recovers_polynomial() {
        let mut rng = rng();
        let poly = Polynomial::<Fq>::random(3, &mut rng);
        let points: Vec<(Fq, Fq)> = (1u64..=4)
            .map(|i| {
                let x = Fq::from(i);
                (x, poly.eval(x))
            })
            .collect();
        assert_eq!(Polynomial::interpolate(&points).unwrap().trim(), poly);
    }

    #[test]
    fn interpolate_single_point() {
        let c = Fq::from(7u64);
        let recovered = Polynomial::interpolate(&[(Fq::ONE, c)]).unwrap();
        assert_eq!(recovered.eval(Fq::ONE), c);
    }

    // ── Arithmetic operators ──────────────────────────────────────────────────

    #[test]
    fn add_polynomials() {
        let p1 = Polynomial::new(vec![Fq::from(1u64), Fq::from(2u64)]);
        let p2 = Polynomial::new(vec![Fq::from(3u64), Fq::from(4u64)]);
        assert_eq!((&p1 + &p2).coeffs(), &[Fq::from(4u64), Fq::from(6u64)]);
    }

    #[test]
    fn sub_polynomials() {
        let p1 = Polynomial::new(vec![Fq::from(5u64), Fq::from(3u64)]);
        let p2 = Polynomial::new(vec![Fq::from(2u64), Fq::from(4u64)]);
        let diff = &p1 - &p2;
        assert_eq!(diff.coeffs()[0], Fq::from(3u64));
        assert_eq!(diff.coeffs()[1], -Fq::ONE);
    }

    #[test]
    fn add_different_degrees() {
        let p1 = Polynomial::new(vec![Fq::from(1u64), Fq::from(2u64), Fq::from(3u64)]);
        let p2 = Polynomial::constant(Fq::from(10u64));
        assert_eq!(
            (&p1 + &p2).coeffs(),
            &[Fq::from(11u64), Fq::from(2u64), Fq::from(3u64)]
        );
    }

    #[test]
    fn scalar_mul() {
        let p = Polynomial::new(vec![Fq::from(2u64), Fq::ONE]);
        assert_eq!(
            (p * Fq::from(3u64)).coeffs(),
            &[Fq::from(6u64), Fq::from(3u64)]
        );
    }

    #[test]
    fn polynomial_mul() {
        let p1 = Polynomial::new(vec![Fq::ONE, Fq::ONE]);
        let p2 = Polynomial::new(vec![Fq::ONE, -Fq::ONE]);
        let product = (&p1 * &p2).trim();
        assert_eq!(product.coeffs()[0], Fq::ONE);
        assert_eq!(product.coeffs()[1], Fq::ZERO);
        assert_eq!(product.coeffs()[2], -Fq::ONE);
    }

    #[test]
    fn neg_polynomial() {
        let p = Polynomial::new(vec![Fq::ONE, Fq::from(2u64)]);
        assert_eq!((-&p).eval(Fq::ONE), -(Fq::ONE + Fq::from(2u64)));
    }

    #[test]
    fn trim_removes_trailing_zeros() {
        let p = Polynomial::new(vec![Fq::ONE, Fq::ZERO, Fq::ZERO]);
        let trimmed = p.trim();
        assert_eq!(trimmed.coeffs(), &[Fq::ONE]);
        assert_eq!(trimmed.degree(), 0);
    }

    // ── Root finding ──────────────────────────────────────────────────────────

    #[test]
    fn poly_roots_degree_one() {
        let mut rng = rng();
        // g(X) = 3 + 2X → root = -3/2
        let a0 = Fq::from(3u64);
        let a1 = Fq::from(2u64);
        let roots = Polynomial::new(vec![a0, a1]).roots(&mut rng).unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0], -a0 * Option::<Fq>::from(a1.invert()).unwrap());
    }

    #[test]
    fn poly_roots_degree_two() {
        let mut rng = rng();
        // g(X) = (X − r1)(X − r2) = r1*r2 − (r1+r2)X + X²
        let r1 = Fq::from(7u64);
        let r2 = Fq::from(13u64);
        let a0 = r1 * r2;
        let a1 = -(r1 + r2);
        let a2 = Fq::ONE;
        let mut roots = Polynomial::new(vec![a0, a1, a2]).roots(&mut rng).unwrap();
        roots.sort_by_key(|r| {
            let bytes = r.to_repr();
            bytes.as_ref().to_vec()
        });
        let mut expected = vec![r1, r2];
        expected.sort_by_key(|r| {
            let bytes = r.to_repr();
            bytes.as_ref().to_vec()
        });
        assert_eq!(roots, expected);
    }

    #[test]
    fn poly_roots_degree_three() {
        let mut rng = rng();
        let r1 = Fq::from(5u64);
        let r2 = Fq::from(17u64);
        let r3 = Fq::from(31u64);
        // (X − 5)(X − 17)(X − 31)
        let p1 = Polynomial::new(vec![-r1, Fq::ONE]);
        let p2 = Polynomial::new(vec![-r2, Fq::ONE]);
        let p3 = Polynomial::new(vec![-r3, Fq::ONE]);
        let g = (&(&p1 * &p2) * &p3).trim();
        let mut roots = g.roots(&mut rng).unwrap();
        roots.sort_by_key(|r| {
            let bytes = r.to_repr();
            bytes.as_ref().to_vec()
        });
        let mut expected = vec![r1, r2, r3];
        expected.sort_by_key(|r| {
            let bytes = r.to_repr();
            bytes.as_ref().to_vec()
        });
        assert_eq!(roots, expected);
    }
}
