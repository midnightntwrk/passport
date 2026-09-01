use ff::PrimeField;
use midnight_curves::fft::best_fft;

/// Returns a primitive 2^`log_n`-th root of unity in `F`.
///
/// # Panics
/// Panics if `log_n` is 0 or greater than `F::S`.
pub fn root_of_unity<F: PrimeField>(log_n: u32) -> F {
    assert!(log_n >= 1, "log_n must be at least 1 (n ≥ 2)");
    assert!(
        log_n <= F::S,
        "log_n ({log_n}) exceeds field's 2-adic valuation ({})",
        F::S
    );
    let mut omega = F::ROOT_OF_UNITY;
    for _ in 0..(F::S - log_n) {
        omega = omega.square();
    }
    omega
}

/// In-place forward FFT (coefficient form → evaluation form).
///
/// On return, `a[k] = f(ω^k)` where `f` is the polynomial whose coefficients
/// were `a[0], a[1], …, a[n−1]` and `ω = root_of_unity(log n)`.
///
/// # Panics
/// Panics if `a.len()` is not a power of two, is less than 2, or exceeds 2^32.
pub fn fft<F: PrimeField>(a: &mut [F]) {
    let n = a.len();
    assert!(n >= 2, "fft: length must be at least 2");
    let log_n = n.trailing_zeros();
    assert_eq!(n, 1 << log_n, "fft: length must be a power of two, got {n}");
    best_fft(a, root_of_unity::<F>(log_n), log_n);
}

/// In-place inverse FFT (evaluation form → coefficient form).
///
/// Undoes [`fft`]: given evaluations `a[k] = f(ω^k)`, recovers polynomial
/// coefficients in place and divides each element by n.
///
/// # Panics
/// Panics if `a.len()` is not a power of two, is less than 2, or exceeds 2^32.
pub fn ifft<F: PrimeField>(a: &mut [F]) {
    let n = a.len();
    assert!(n >= 2, "ifft: length must be at least 2");
    let log_n = n.trailing_zeros();
    assert_eq!(
        n,
        1 << log_n,
        "ifft: length must be a power of two, got {n}"
    );
    let omega_inv = Option::<F>::from(root_of_unity::<F>(log_n).invert())
        .expect("root of unity is always invertible");
    best_fft(a, omega_inv, log_n);
    let n_inv =
        Option::<F>::from(F::from(n as u64).invert()).expect("n = 2^log_n is invertible in F");
    for x in a.iter_mut() {
        *x *= n_inv;
    }
}
