use passport_buss::bottom_up::buss::Share;
use passport_buss::bottom_up::BottumUpSS;
use passport_buss::{guardian_share, key_update_delta, BottomUpSSS};
use ff::Field;
use midnight_curves::Fq;
use rand::thread_rng;
use sha2::Sha512;

fn main() {
    let mut rng = thread_rng();

    // ── Setup ─────────────────────────────────────────────────────────────────
    // Community of 5 parties: P_1 (key-owner) + P_2..P_5 (guardians).
    // n=5, t=1 → polynomial degree 4, threshold=2, phi_len=3.
    let t = 1usize;
    let n = 5usize;
    let buss = BottomUpSSS::new(t, n).unwrap();

    println!(
        "BUSS ({t}+1)-out-of-({n}−1)  |  threshold={}, shares={}, phi_len={}",
        buss.threshold(),
        buss.num_shares(),
        buss.phi_len(),
    );

    let secret_keys: Vec<Fq> = (0..n).map(|_| Fq::random(&mut rng)).collect();
    let owner_sk = secret_keys[0];
    let owner_id: &[u8] = b"owner-public-key-p1";
    let guardian_js: Vec<usize> = (1..n).collect(); // [1, 2, 3, 4]
    let guardian_xs: Vec<Fq> = guardian_js.iter().map(|&j| Fq::from(j as u64)).collect();

    // ── Backup ────────────────────────────────────────────────────────────────
    // Each guardian j computes σ_j = H(owner_id ‖ sk_j) and sends it to the
    // owner. The owner builds φ = (f(-1), …, f(-phi_len)) and publishes it.
    let sigma_b: Vec<Share<Fq>> = guardian_js
        .iter()
        .zip(&guardian_xs)
        .map(|(&j, &x)| Share {
            x,
            y: guardian_share::<Fq, Sha512>(owner_id, secret_keys[j]),
        })
        .collect();

    let mut phi = buss.split(owner_sk, &sigma_b).unwrap();

    println!("\nBackup:");
    println!("  Owner secret:   [hidden]");
    println!("  Guardians:      {} σ values collected", sigma_b.len());
    println!("  Public φ:       {} field elements published", phi.len());

    // ── Recovery (original keys) ───────────────────────────────────────────────
    // Any t+1 = 2 guardians suffice. Guardians 2 and 4 help.
    let sigma_r: Vec<Share<Fq>> = [2usize, 4]
        .iter()
        .map(|&j| Share {
            x: Fq::from(j as u64),
            y: guardian_share::<Fq, Sha512>(owner_id, secret_keys[j]),
        })
        .collect();

    let recovered = buss.reconstruct(&phi, &sigma_r).unwrap();
    assert_eq!(owner_sk, recovered);
    println!("\nRecovery (guardians 2 and 4, original keys):  OK");

    // ── Key Update: guardian 3 rotates their key ───────────────────────────────
    // Guardian 3 generates a new secret key and notifies the owner by sending
    // Δ = new_σ − old_σ. The owner updates φ in-place without re-running
    // the full backup protocol and without ever seeing guardian 3's raw key.
    println!("\n── Key Update (guardian 3 rotates secret key) ──────────────────────────");

    let new_key_g3 = Fq::random(&mut rng);

    let delta_g3 = key_update_delta::<Fq, Sha512>(owner_id, secret_keys[3], new_key_g3);
    println!("  Guardian 3 computed Δ = new_σ − old_σ and sent it to the owner.");

    buss.update_public_shares(Fq::from(3u64), &guardian_xs, delta_g3, &mut phi)
        .unwrap();
    println!("  Owner applied Δ to φ.  φ now encodes guardian 3's new share.");

    // ── Recovery after key update ─────────────────────────────────────────────
    // Guardians 2 and 3 help. Guardian 3 re-derives σ from their NEW key.
    println!("\nRecovery after key update (guardians 2 and 3, new key for 3):");

    let sigma_post: Vec<Share<Fq>> = vec![
        Share {
            x: Fq::from(2u64),
            y: guardian_share::<Fq, Sha512>(owner_id, secret_keys[2]),
        }, // unchanged
        Share {
            x: Fq::from(3u64),
            y: guardian_share::<Fq, Sha512>(owner_id, new_key_g3),
        }, // new key
    ];
    let recovered_post = buss.reconstruct(&phi, &sigma_post).unwrap();
    assert_eq!(owner_sk, recovered_post);
    println!("  Reconstructed secret key → OK  (secret unchanged)");

    // Guardian 3's old key no longer works for recovery.
    println!("\nRecovery attempt with guardian 3's OLD key (should fail):");
    let sigma_stale: Vec<Share<Fq>> = vec![
        Share {
            x: Fq::from(2u64),
            y: guardian_share::<Fq, Sha512>(owner_id, secret_keys[2]),
        },
        Share {
            x: Fq::from(3u64),
            y: guardian_share::<Fq, Sha512>(owner_id, secret_keys[3]),
        }, // stale
    ];
    let wrong = buss.reconstruct(&phi, &sigma_stale).unwrap();
    assert_ne!(owner_sk, wrong);
    println!("  Recovered value ≠ secret  → stale key correctly produces wrong output");

    // Any other t+1 subset still works with their original keys.
    println!("\nRecovery with guardians 1 and 4 (unaffected by update):");
    let sigma_other: Vec<Share<Fq>> = vec![
        Share {
            x: Fq::from(1u64),
            y: guardian_share::<Fq, Sha512>(owner_id, secret_keys[1]),
        },
        Share {
            x: Fq::from(4u64),
            y: guardian_share::<Fq, Sha512>(owner_id, secret_keys[4]),
        },
    ];
    let recovered_other = buss.reconstruct(&phi, &sigma_other).unwrap();
    assert_eq!(owner_sk, recovered_other);
    println!("  Reconstructed secret key → OK");

    // ── Multiple key updates ───────────────────────────────────────────────────
    // Guardian 1 also rotates their key. Each update is independent and
    // requires only a single Δ message — no fresh backup round needed.
    println!("\n── Second Key Update (guardian 1 also rotates) ─────────────────────────");

    let new_key_g1 = Fq::random(&mut rng);
    let delta_g1 = key_update_delta::<Fq, Sha512>(owner_id, secret_keys[1], new_key_g1);
    buss.update_public_shares(Fq::from(1u64), &guardian_xs, delta_g1, &mut phi)
        .unwrap();
    println!("  Owner applied Δ for guardian 1 to φ.");

    let sigma_both_new: Vec<Share<Fq>> = vec![
        Share {
            x: Fq::from(1u64),
            y: guardian_share::<Fq, Sha512>(owner_id, new_key_g1),
        },
        Share {
            x: Fq::from(3u64),
            y: guardian_share::<Fq, Sha512>(owner_id, new_key_g3),
        },
    ];
    let recovered_final = buss.reconstruct(&phi, &sigma_both_new).unwrap();
    assert_eq!(owner_sk, recovered_final);
    println!("  Recovery with both updated guardians (1 and 3):  OK  (secret still unchanged)");

    // ── Below-threshold fails as expected ─────────────────────────────────────
    println!("\nRecovery with only 1 guardian (below threshold):");
    let err = buss.reconstruct(&phi, &sigma_both_new[..1]).unwrap_err();
    println!("  → {err}");
}
