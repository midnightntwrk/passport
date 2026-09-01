use passport_buss::secret_sharing::{SecretSharing, VerifiableSS};
use passport_buss::{Error, FeldmanVSS};
use ff::Field;
use midnight_curves::{Fq, G1Projective};
use rand::thread_rng;

#[test]
fn feldman_split_verify_and_reconstruct() {
    let mut rng = thread_rng();
    let vss = FeldmanVSS::<G1Projective>::new(2, 5).unwrap(); // 3-out-of-4
    let secret = Fq::random(&mut rng);

    let poly = vss.polynomial(secret, &mut rng);
    let shares = vss.split(&poly).unwrap();
    let vk = vss.compute_verification_key(&poly).unwrap();

    assert_eq!(shares.len(), 4);
    assert_eq!(vk.len(), 3); // t+1 commitments

    for share in &shares {
        assert!(
            vss.verify_share(share, &vk).is_ok(),
            "valid share must verify"
        );
    }

    let recovered = vss.reconstruct(&shares[..vss.threshold()]).unwrap();
    assert_eq!(recovered, secret);
}

#[test]
fn feldman_tampered_share_fails_verification() {
    let mut rng = thread_rng();
    let vss = FeldmanVSS::<G1Projective>::new(2, 5).unwrap();
    let secret = Fq::random(&mut rng);

    let poly = vss.polynomial(secret, &mut rng);
    let mut shares = vss.split(&poly).unwrap();
    let vk = vss.compute_verification_key(&poly).unwrap();

    shares[0].y += Fq::ONE; // corrupt the share value
    assert_eq!(
        vss.verify_share(&shares[0], &vk),
        Err(Error::VerificationFailed)
    );
}
