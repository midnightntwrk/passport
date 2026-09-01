use passport_buss::{secret_sharing::SecretSharing, Error, ShamirSecretSharing};
use ff::Field;
use midnight_curves::Fq;
use rand::thread_rng;

// ── ShamirSecretSharing ───────────────────────────────────────────────────────

#[test]
fn split_and_reconstruct_full_share_set() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 5).unwrap(); // 3-out-of-4
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split(&poly).unwrap();
    assert_eq!(shares.len(), 4);
    assert_eq!(scheme.reconstruct(&shares).unwrap(), secret);
}

#[test]
fn reconstruct_with_exactly_threshold_shares() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 5).unwrap();
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split(&poly).unwrap();
    assert_eq!(scheme.reconstruct(&shares[..3]).unwrap(), secret);
}

#[test]
fn reconstruct_with_non_contiguous_subset() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 6).unwrap(); // 3-out-of-5
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split(&poly).unwrap();
    let subset = [shares[0].clone(), shares[2].clone(), shares[4].clone()];
    assert_eq!(scheme.reconstruct(&subset).unwrap(), secret);
}

#[test]
fn insufficient_shares_returns_error() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 5).unwrap();
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split(&poly).unwrap();
    let err = scheme.reconstruct(&shares[..2]).unwrap_err();
    assert_eq!(err, Error::InsufficientShares { need: 3, got: 2 });
}

#[test]
fn threshold_one_is_trivial_secret_copy() {
    // t=0, n=2: 1-out-of-1 — each share IS the secret
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(0, 2).unwrap();
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split(&poly).unwrap();
    assert_eq!(shares.len(), 1);
    assert_eq!(scheme.reconstruct(&shares).unwrap(), secret);
}

#[test]
fn different_secrets_give_different_shares() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(1, 3).unwrap();
    let s1 = Fq::random(&mut rng);
    let s2 = Fq::random(&mut rng);
    let poly1 = scheme.polynomial(s1, &mut rng);
    let poly2 = scheme.polynomial(s2, &mut rng);
    let sh1 = scheme.split(&poly1).unwrap();
    let sh2 = scheme.split(&poly2).unwrap();
    // Shares for different secrets should (overwhelmingly) differ
    assert_ne!(sh1[0].y, sh2[0].y);
}

#[test]
fn split_rejects_wrong_degree_polynomial() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 5).unwrap(); // expects degree 2
    let wrong_poly = passport_buss::Polynomial::<Fq>::random(1, &mut rng);
    let err = scheme.split(&wrong_poly).unwrap_err();
    assert_eq!(err, Error::InvalidDegree { need: 2, got: 1 });
}

// ── Parameter validation ──────────────────────────────────────────────────────

#[test]
fn rejects_n_less_than_two() {
    assert!(ShamirSecretSharing::new(0, 1).is_err());
    assert!(ShamirSecretSharing::new(0, 0).is_err());
}

#[test]
fn rejects_t_not_less_than_n_minus_one() {
    assert!(ShamirSecretSharing::new(3, 4).is_err()); // t=3 >= n-1=3
    assert!(ShamirSecretSharing::new(4, 4).is_err()); // t=4 >= n-1=3
}

#[test]
fn accepts_valid_boundary_parameters() {
    assert!(ShamirSecretSharing::new(0, 2).is_ok()); // t=0, n-1=1 (1-of-1)
    assert!(ShamirSecretSharing::new(2, 4).is_ok()); // t=2, n-1=3 (3-of-3)
}

// ── split_fft ─────────────────────────────────────────────────────────────────

#[test]
fn split_fft_reconstructs_secret() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 5).unwrap(); // 3-out-of-4
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split_fft(&poly).unwrap();
    assert_eq!(shares.len(), 4);
    assert_eq!(scheme.reconstruct(&shares).unwrap(), secret);
}

#[test]
fn split_fft_threshold_subset() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 5).unwrap();
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split_fft(&poly).unwrap();
    // First t+1 = 3 shares trigger the iFFT fast path (k=3 is not a power of
    // two, so direct Lagrange is used; still correct either way).
    assert_eq!(scheme.reconstruct(&shares[..3]).unwrap(), secret);
}

#[test]
fn split_fft_power_of_two_threshold_uses_ifft() {
    // t+1 = 4 is a power of two and the first 4 shares are at ω^0…ω^3,
    // so lagrange_at_zero triggers the iFFT path.
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(3, 9).unwrap(); // 4-out-of-8
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split_fft(&poly).unwrap();
    assert_eq!(shares.len(), 8);
    assert_eq!(scheme.reconstruct(&shares[..4]).unwrap(), secret);
}

#[test]
fn split_fft_non_contiguous_subset() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 6).unwrap(); // 3-out-of-5
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split_fft(&poly).unwrap();
    // Shares at indices 1, 3, 4 (x = ω^1, ω^3, ω^4) — not starting at ω^0,
    // so direct Lagrange is used.
    let subset = [shares[1].clone(), shares[3].clone(), shares[4].clone()];
    assert_eq!(scheme.reconstruct(&subset).unwrap(), secret);
}

#[test]
fn split_fft_agrees_with_split_on_same_poly() {
    // Both split methods produce the same f(0) = secret when reconstructed,
    // even when fed the exact same polynomial.
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 5).unwrap();
    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares_int = scheme.split(&poly).unwrap();
    let shares_fft = scheme.split_fft(&poly).unwrap();
    assert_eq!(scheme.reconstruct(&shares_int).unwrap(), secret);
    assert_eq!(scheme.reconstruct(&shares_fft).unwrap(), secret);
}

#[test]
fn split_fft_rejects_wrong_degree_polynomial() {
    let mut rng = thread_rng();
    let scheme = ShamirSecretSharing::new(2, 5).unwrap(); // expects degree 2
    let wrong_poly = passport_buss::Polynomial::<Fq>::random(1, &mut rng);
    let err = scheme.split_fft(&wrong_poly).unwrap_err();
    assert_eq!(err, Error::InvalidDegree { need: 2, got: 1 });
}
