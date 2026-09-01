use passport_buss::bottom_up::buss::Share;
use passport_buss::bottom_up::BottumUpSS;
use passport_buss::{BottomUpSSS, Error};
use ff::Field;
use midnight_curves::Fq;
use rand::thread_rng;

// ── BottomUpSSS ───────────────────────────────────────────────────────────────

#[test]
fn buss_share_and_reconstruct_with_all_guardians() {
    // t=1, n=4: polynomial degree 3, 3 guardian shares, phi has 2 public points.
    // Reconstruct with any t+1=2 guardians.
    let mut rng = thread_rng();
    let buss = BottomUpSSS::new(1, 4).unwrap();
    let secret = Fq::random(&mut rng);

    // Each guardian independently picks their share.
    let sigma_b: Vec<Share<Fq>> = (1..=buss.num_shares())
        .map(|j| Share {
            x: Fq::from(j as u64),
            y: Fq::random(&mut rng),
        })
        .collect();

    let phi = buss.split(secret, &sigma_b).unwrap();
    assert_eq!(phi.len(), buss.phi_len()); // n-t-1 = 2

    // Reconstruct with the first t+1=2 guardians.
    let recovered = buss
        .reconstruct(&phi, &sigma_b[..buss.threshold()])
        .unwrap();
    assert_eq!(recovered, secret);
}

#[test]
fn buss_reconstruct_with_non_contiguous_guardians() {
    let mut rng = thread_rng();
    let buss = BottomUpSSS::new(1, 4).unwrap(); // 2-of-3, phi len = 2
    let secret = Fq::random(&mut rng);

    let sigma_b: Vec<Share<Fq>> = (1..=buss.num_shares())
        .map(|j| Share {
            x: Fq::from(j as u64),
            y: Fq::random(&mut rng),
        })
        .collect();

    let phi = buss.split(secret, &sigma_b).unwrap();

    // Use guardians 1 and 3 (skipping 2).
    let subset = [
        Share {
            x: sigma_b[0].x,
            y: sigma_b[0].y,
        },
        Share {
            x: sigma_b[2].x,
            y: sigma_b[2].y,
        },
    ];
    let recovered = buss.reconstruct(&phi, &subset).unwrap();
    assert_eq!(recovered, secret);
}

#[test]
fn buss_any_threshold_subset_reconstructs() {
    // t=2, n=5: degree-4 poly, 4 guardian shares, phi len = 2.
    // Reconstruct with any 3 guardians.
    let mut rng = thread_rng();
    let buss = BottomUpSSS::new(2, 5).unwrap();
    let secret = Fq::random(&mut rng);

    let sigma_b: Vec<Share<Fq>> = (1..=buss.num_shares())
        .map(|j| Share {
            x: Fq::from(j as u64),
            y: Fq::random(&mut rng),
        })
        .collect();

    let phi = buss.split(secret, &sigma_b).unwrap();

    // Try three different 3-element subsets.
    for indices in [[0, 1, 2], [0, 1, 3], [1, 2, 3]] {
        let subset: Vec<Share<Fq>> = indices
            .iter()
            .map(|&i| Share {
                x: sigma_b[i].x,
                y: sigma_b[i].y,
            })
            .collect();
        assert_eq!(buss.reconstruct(&phi, &subset).unwrap(), secret);
    }
}

#[test]
fn buss_insufficient_guardians_returns_error() {
    let mut rng = thread_rng();
    let buss = BottomUpSSS::new(2, 5).unwrap(); // threshold = 3
    let secret = Fq::random(&mut rng);

    let sigma_b: Vec<Share<Fq>> = (1..=buss.num_shares())
        .map(|j| Share {
            x: Fq::from(j as u64),
            y: Fq::random(&mut rng),
        })
        .collect();
    let phi = buss.split(secret, &sigma_b).unwrap();

    let err = buss.reconstruct(&phi, &sigma_b[..2]).unwrap_err();
    assert_eq!(err, Error::InsufficientShares { need: 3, got: 2 });
}

#[test]
fn buss_wrong_share_count_returns_error() {
    let buss = BottomUpSSS::new(1, 4).unwrap(); // expects 3 shares
    let secret = Fq::from(42u64);
    let sigma_b = vec![
        Share {
            x: Fq::from(1u64),
            y: Fq::from(1u64),
        },
        Share {
            x: Fq::from(2u64),
            y: Fq::from(2u64),
        },
    ]; // only 2
    assert!(matches!(
        buss.split(secret, &sigma_b),
        Err(Error::InvalidShares)
    ));
}

#[test]
fn buss_invalid_parameters_rejected() {
    assert!(BottomUpSSS::new(0, 1).is_err()); // n < 2
    assert!(BottomUpSSS::new(3, 4).is_err()); // t >= n-1
    assert!(BottomUpSSS::new(3, 3).is_err()); // t = n-1
    assert!(BottomUpSSS::new(0, 2).is_ok()); // minimal valid: 1-of-1
    assert!(BottomUpSSS::new(1, 3).is_ok()); // 2-of-2
}

#[test]
fn buss_minimal_instance_one_of_one() {
    // t=0, n=2: phi_len = 1, threshold = 1, num_shares = 1.
    let mut rng = thread_rng();
    let buss = BottomUpSSS::new(0, 2).unwrap();
    let secret = Fq::random(&mut rng);
    let sigma_b = vec![Share {
        x: Fq::from(1u64),
        y: Fq::random(&mut rng),
    }];
    let phi = buss.split(secret, &sigma_b).unwrap();
    assert_eq!(phi.len(), 1);
    let recovered = buss.reconstruct(&phi, &sigma_b).unwrap();
    assert_eq!(recovered, secret);
}
