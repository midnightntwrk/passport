//! Guruswami-Sudan list decoding of Reed-Solomon codes.
//!
//! Used by [`crate::TraceableShamir`] (§3.2 of EPRINT 2024/405) to recover the
//! traitor polynomial h*(X) from N oracle evaluations when up to f < t shares
//! are corrupted.

use ff::PrimeField;
use rand_core::RngCore;

use super::polynomial::Polynomial;

/// Find all degree-≤k polynomials agreeing with ≥ `agreement` of the given points.
///
/// Implements the Sudan (1997) / Guruswami-Sudan (1999) list decoder:
/// 1. Solve a homogeneous linear system to find a bivariate polynomial
///    Q(X,Y) ≠ 0 with Q(x_i, y_i) = 0 for all input points.
/// 2. Factor Q(X,Y) in Y to extract candidate univariate polynomials.
/// 3. Filter by agreement.
pub fn guruswami_sudan<F: PrimeField>(
    points: &[(F, F)],
    k: usize,
    agreement: usize,
    rng: &mut impl RngCore,
) -> Vec<Polynomial<F>> {
    let n = points.len();
    if n == 0 || k == 0 {
        return vec![];
    }

    let (s, d) = gs_parameters(n, k, agreement);

    // Enumerate monomials X^a · Y^j for j=0..=s, a=0..=(d − j·k).
    let monomials: Vec<(usize, usize)> = (0..=s)
        .flat_map(|j| {
            if d < j * k {
                return vec![];
            }
            (0..=(d - j * k)).map(|a| (a, j)).collect::<Vec<_>>()
        })
        .collect();

    if monomials.is_empty() {
        return vec![];
    }

    // Build constraint matrix: row i ↔ point, col m ↔ monomial (a,j):
    // entry = x_i^a · y_i^j.
    let mut matrix: Vec<Vec<F>> = points
        .iter()
        .map(|&(xi, yi)| {
            monomials
                .iter()
                .map(|&(a, j)| xi.pow([a as u64]) * yi.pow([j as u64]))
                .collect()
        })
        .collect();

    let sol = match gaussian_null(&mut matrix) {
        Some(v) => v,
        None => return vec![],
    };

    // Reconstruct Q(X,Y) = Σ_j q_j(X) · Y^j.
    let mut q_raw: Vec<Vec<F>> = vec![vec![]; s + 1];
    for (idx, &(a, j)) in monomials.iter().enumerate() {
        if q_raw[j].len() <= a {
            q_raw[j].resize(a + 1, F::ZERO);
        }
        q_raw[j][a] = sol[idx];
    }
    let q: Vec<Polynomial<F>> = q_raw
        .into_iter()
        .map(|c| Polynomial::new(c).trim())
        .collect();

    // Factor Q in Y; filter by agreement.
    let candidates = factor_q_in_y::<F>(&q, k, rng);
    candidates
        .into_iter()
        .filter(|h| points.iter().filter(|&&(xi, yi)| h.eval(xi) == yi).count() >= agreement)
        .collect()
}

/// Choose GS parameters `(s, D)` — minimal values with Σ_{j=0}^s max(0, D+1−j·k) > n.
fn gs_parameters(n: usize, k: usize, agreement: usize) -> (usize, usize) {
    // s ≈ C²/(k·N) ≥ 1.
    let kn = (k * n).max(1);
    let s = (agreement * agreement).div_ceil(kn).max(1);
    let d = (0usize..)
        .find(|&d| {
            (0..=s)
                .map(|j| (d + 1).saturating_sub(j * k))
                .sum::<usize>()
                > n
        })
        .expect("search is unbounded");
    (s, d)
}

/// Reduced-row-echelon Gaussian elimination; returns a non-trivial null vector.
#[allow(clippy::needless_range_loop)]
fn gaussian_null<F: PrimeField>(matrix: &mut [Vec<F>]) -> Option<Vec<F>> {
    let nrows = matrix.len();
    if nrows == 0 {
        return None;
    }
    let ncols = matrix[0].len();
    if ncols == 0 {
        return None;
    }

    let mut pivot_of_row: Vec<Option<usize>> = vec![None; nrows];
    let mut row_of_col: Vec<Option<usize>> = vec![None; ncols];
    let mut next_pr = 0usize;

    for col in 0..ncols {
        if next_pr >= nrows {
            break;
        }
        let found = (next_pr..nrows).find(|&r| matrix[r][col] != F::ZERO);
        if let Some(p) = found {
            matrix.swap(next_pr, p);
            let inv = Option::<F>::from(matrix[next_pr][col].invert()).unwrap();
            for c in 0..ncols {
                matrix[next_pr][c] *= inv;
            }
            for r in 0..nrows {
                if r != next_pr && matrix[r][col] != F::ZERO {
                    let fac = matrix[r][col];
                    for c in 0..ncols {
                        let v = matrix[next_pr][c] * fac;
                        matrix[r][c] -= v;
                    }
                }
            }
            pivot_of_row[next_pr] = Some(col);
            row_of_col[col] = Some(next_pr);
            next_pr += 1;
        }
    }

    let free_col = (0..ncols).find(|&c| row_of_col[c].is_none())?;
    let mut sol = vec![F::ZERO; ncols];
    sol[free_col] = F::ONE;
    for r in 0..next_pr {
        if let Some(pc) = pivot_of_row[r] {
            sol[pc] = -matrix[r][free_col];
        }
    }
    Some(sol)
}

/// Extract all degree-≤k factors h(X) such that Q(X, h(X)) ≡ 0 via evaluation.
///
/// Picks k+1 random evaluation points, finds Y-roots of Q at each, then
/// searches all root combinations by DFS, interpolates h, and spot-checks.
fn factor_q_in_y<F: PrimeField>(
    q: &[Polynomial<F>],
    k: usize,
    rng: &mut impl RngCore,
) -> Vec<Polynomial<F>> {
    if q.is_empty() {
        return vec![];
    }

    // k+1 distinct nonzero evaluation points for interpolating h.
    let mut eval_pts: Vec<F> = Vec::with_capacity(k + 1);
    while eval_pts.len() < k + 1 {
        let c = F::random(&mut *rng);
        if c != F::ZERO && !eval_pts.contains(&c) {
            eval_pts.push(c);
        }
    }

    // For each eval point, find roots of Q(c, Y) (univariate in Y).
    let roots_at: Vec<Vec<F>> = eval_pts
        .iter()
        .map(|&c| {
            let y_coeffs: Vec<F> = q.iter().map(|qj| qj.eval(c)).collect();
            Polynomial::new(y_coeffs).roots(rng).unwrap_or_default()
        })
        .collect();

    // Extra points for verifying Q(X, h(X)) = 0.
    let mut verify_pts: Vec<F> = Vec::with_capacity(6);
    while verify_pts.len() < 6 {
        let c = F::random(&mut *rng);
        if c != F::ZERO && !eval_pts.contains(&c) && !verify_pts.contains(&c) {
            verify_pts.push(c);
        }
    }

    // DFS over root combinations (one root per eval point).
    let mut found: Vec<Polynomial<F>> = Vec::new();
    let mut stack: Vec<Vec<(F, F)>> = vec![vec![]];

    while let Some(partial) = stack.pop() {
        let depth = partial.len();

        if depth == k + 1 {
            let h = match Polynomial::interpolate(&partial) {
                Ok(p) => p.trim(),
                Err(_) => continue,
            };

            // Verify Q(c, h(c)) = 0 for each extra point.
            let ok = verify_pts.iter().all(|&c| {
                let hval = h.eval(c);
                q.iter().enumerate().fold(F::ZERO, |acc, (j, qj)| {
                    acc + qj.eval(c) * hval.pow([j as u64])
                }) == F::ZERO
            });

            if ok && !found.contains(&h) {
                found.push(h);
            }
            continue;
        }

        if roots_at[depth].is_empty() {
            continue;
        }
        for &r in roots_at[depth].iter().rev() {
            let mut np = partial.clone();
            np.push((eval_pts[depth], r));
            stack.push(np);
        }
    }

    found
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::polynomial::Polynomial;
    use ff::Field;
    use midnight_curves::Fq;
    use rand::thread_rng;

    fn rng() -> impl RngCore {
        thread_rng()
    }

    /// Evaluate a polynomial given as a coefficient slice.
    fn eval(coeffs: &[Fq], x: Fq) -> Fq {
        Polynomial::new(coeffs.to_vec()).eval(x)
    }

    fn sample_points(coeffs: &[Fq], n: usize, rng: &mut impl RngCore) -> Vec<(Fq, Fq)> {
        let mut pts = Vec::with_capacity(n);
        let mut seen = Vec::new();
        while pts.len() < n {
            let x = Fq::random(&mut *rng);
            if x == Fq::ZERO || seen.contains(&x) {
                continue;
            }
            seen.push(x);
            pts.push((x, eval(coeffs, x)));
        }
        pts
    }

    // ── Edge cases ────────────────────────────────────────────────────────────

    #[test]
    fn empty_points_returns_empty() {
        let mut rng = rng();
        let result = guruswami_sudan::<Fq>(&[], 1, 1, &mut rng);
        assert!(result.is_empty());
    }

    #[test]
    fn k_zero_returns_empty() {
        let mut rng = rng();
        let pts = vec![(Fq::ONE, Fq::ONE)];
        let result = guruswami_sudan::<Fq>(&pts, 0, 1, &mut rng);
        assert!(result.is_empty());
    }

    #[test]
    fn agreement_exceeds_points_returns_empty() {
        let mut rng = rng();
        // agreement > n → no polynomial can agree with more points than exist
        let pts = sample_points(&[Fq::from(3u64), Fq::ONE], 5, &mut rng);
        let result = guruswami_sudan::<Fq>(&pts, 1, 10, &mut rng);
        assert!(result.is_empty());
    }

    // ── Exact recovery (no noise) ─────────────────────────────────────────────

    #[test]
    fn recovers_constant_polynomial() {
        let mut rng = rng();
        let c = Fq::from(42u64);
        let pts = sample_points(&[c], 20, &mut rng);
        let candidates = guruswami_sudan::<Fq>(&pts, 1, 15, &mut rng);
        let target = Polynomial::new(vec![c]).trim();
        assert!(
            candidates.iter().any(|h| h == &target),
            "constant polynomial not recovered"
        );
    }

    #[test]
    fn recovers_linear_polynomial_exact() {
        let mut rng = rng();
        // h(X) = 5 + 3X
        let coeffs = [Fq::from(5u64), Fq::from(3u64)];
        let pts = sample_points(&coeffs, 25, &mut rng);
        let candidates = guruswami_sudan::<Fq>(&pts, 1, 20, &mut rng);
        let target = Polynomial::new(coeffs.to_vec()).trim();
        assert!(
            candidates.iter().any(|h| h == &target),
            "linear polynomial not recovered"
        );
    }

    #[test]
    fn recovers_degree_2_polynomial_exact() {
        let mut rng = rng();
        // h(X) = 1 + 2X + 3X²
        let coeffs = [Fq::from(1u64), Fq::from(2u64), Fq::from(3u64)];
        let pts = sample_points(&coeffs, 30, &mut rng);
        let candidates = guruswami_sudan::<Fq>(&pts, 2, 25, &mut rng);
        let target = Polynomial::new(coeffs.to_vec()).trim();
        assert!(
            candidates.iter().any(|h| h == &target),
            "degree-2 polynomial not recovered"
        );
    }

    // ── Recovery under noise ──────────────────────────────────────────────────

    #[test]
    fn recovers_despite_corrupted_points() {
        let mut rng = rng();
        let coeffs = [Fq::from(7u64), Fq::from(11u64)];
        let mut pts = sample_points(&coeffs, 30, &mut rng);
        // Corrupt 6 out of 30 evaluations.
        for pt in pts[..6].iter_mut() {
            pt.1 = Fq::random(&mut rng);
        }
        // 24 correct out of 30; agreement=20 < 24.
        let candidates = guruswami_sudan::<Fq>(&pts, 1, 20, &mut rng);
        let target = Polynomial::new(coeffs.to_vec()).trim();
        assert!(
            candidates.iter().any(|h| h == &target),
            "polynomial not recovered under noise"
        );
    }

    // ── List property ─────────────────────────────────────────────────────────

    #[test]
    fn all_returned_polynomials_meet_agreement() {
        let mut rng = rng();
        let coeffs = [Fq::from(2u64), Fq::from(5u64)];
        let pts = sample_points(&coeffs, 25, &mut rng);
        let agreement = 18;
        let candidates = guruswami_sudan::<Fq>(&pts, 1, agreement, &mut rng);
        for h in &candidates {
            let count = pts.iter().filter(|&&(x, y)| h.eval(x) == y).count();
            assert!(
                count >= agreement,
                "candidate h has only {count} agreements, need {agreement}"
            );
        }
    }

    #[test]
    fn no_duplicates_in_output() {
        let mut rng = rng();
        let coeffs = [Fq::ONE, Fq::from(2u64)];
        let pts = sample_points(&coeffs, 25, &mut rng);
        let candidates = guruswami_sudan::<Fq>(&pts, 1, 18, &mut rng);
        for i in 0..candidates.len() {
            for j in (i + 1)..candidates.len() {
                assert_ne!(
                    candidates[i], candidates[j],
                    "duplicate candidate at ({i},{j})"
                );
            }
        }
    }
}
