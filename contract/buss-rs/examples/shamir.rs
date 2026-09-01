use passport_buss::{secret_sharing::SecretSharing, ShamirSecretSharing};
use ff::Field;
use midnight_curves::Fq;
// use passport_buss::{FeldmanVSS, ShamirSecretSharing, secret_sharing::SecretSharing};
use rand::thread_rng;

fn main() {
    let mut rng = thread_rng();

    // ── Shamir SSS ────────────────────────────────────────────────────────────
    // (t+1)-out-of-(n-1): t=2, n=5  →  3-out-of-4
    let t = 2;
    let n = 5;
    let scheme = ShamirSecretSharing::new(t, n).unwrap();
    println!(
        "Shamir ({t}+1)-out-of-({n}-1)  |  threshold={}, shares={}",
        scheme.threshold(),
        scheme.num_shares()
    );

    let secret = Fq::random(&mut rng);
    let poly = scheme.polynomial(secret, &mut rng);
    let shares = scheme.split(&poly).unwrap();

    // Reconstruct with exactly threshold shares
    let recovered = scheme.reconstruct(&shares[..scheme.threshold()]).unwrap();
    assert_eq!(secret, recovered, "secret mismatch");
    println!(
        "  split → {} shares, reconstruct with {} → OK",
        shares.len(),
        scheme.threshold()
    );

    // Any subset of threshold shares works
    let subset = [shares[0].clone(), shares[2].clone(), shares[3].clone()];
    let recovered2 = scheme.reconstruct(&subset).unwrap();
    assert_eq!(secret, recovered2);
    println!("  non-contiguous subset (indices 0,2,3) → OK");

    // Fewer than threshold shares should fail
    let err = scheme
        .reconstruct(&shares[..scheme.threshold() - 1])
        .unwrap_err();
    println!("  {t} shares (below threshold) → {err}");
}
