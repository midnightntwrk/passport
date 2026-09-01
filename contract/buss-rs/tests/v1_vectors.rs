// Cross-implementation vectors (recovery MIP, Testing): the TypeScript
// implementation in contract/src/wallet/recovery.ts and this crate must
// derive identical guardian secrets and shares for identical inputs. The
// constants below were produced by the TypeScript side; recovery-offline
// asserts the same values there.

use passport_buss::bottom_up::BottumUpSS;
use passport_buss::v1::{
    guardian_share_v1, share_from_bytes, share_to_bytes, GuardianSecret, SessionId,
};
use passport_buss::BottomUpSSS;

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

const PRF: [u8; 32] = [0x11; 32];
const ACCOUNT: [u8; 32] = [0x22; 32];
const SID: [u8; 32] = [0x33; 32];

const GUARDIAN_SECRET_REPR: &str =
    "3ca3592cdd6ab2c6e2d451cbd96fedaf2ed95c58f1ad60e56bb6876ea4ebb617";
const SIGMA_REPR: &str = "3ca7810ce096e24ff66e0e0bdd1389a8a9a837b4fa0a21f3720e4eb71e366c07";

#[test]
fn guardian_secret_matches_typescript() {
    let guardian = GuardianSecret::from_prf_output(&PRF);
    assert_eq!(
        share_to_bytes(guardian.as_field()),
        hex32(GUARDIAN_SECRET_REPR),
        "Profile A guardian secret diverges from the TypeScript implementation"
    );
}

#[test]
fn share_derivation_matches_typescript() {
    let guardian = GuardianSecret::from_prf_output(&PRF);
    let sigma = guardian_share_v1(&SessionId(SID), &ACCOUNT, &guardian);
    assert_eq!(
        share_to_bytes(sigma),
        hex32(SIGMA_REPR),
        "v1 share derivation diverges from the TypeScript implementation"
    );
}

#[test]
fn share_codec_round_trips() {
    let guardian = GuardianSecret::from_prf_output(&PRF);
    let sigma = guardian_share_v1(&SessionId(SID), &ACCOUNT, &guardian);
    let bytes = share_to_bytes(sigma);
    assert_eq!(share_from_bytes(&bytes), Some(sigma));
    // A non-canonical encoding is rejected, not reduced.
    assert_eq!(share_from_bytes(&[0xff; 32]), None);
}

#[test]
fn v1_shares_reconstruct_through_upstream_buss() {
    use ff::Field;
    use midnight_curves::Fq;

    // Three guardians at threshold two (upstream counts the dealer:
    // n' = 4, t = 1, phi_len = 2), shares derived per the v1 profile.
    let sid = SessionId(SID);
    let guardians: Vec<GuardianSecret> = (0u8..3)
        .map(|i| GuardianSecret::from_prf_output(&[i + 1; 32]))
        .collect();
    let shares: Vec<passport_buss::bottom_up::buss::Share<Fq>> = guardians
        .iter()
        .enumerate()
        .map(|(i, g)| passport_buss::bottom_up::buss::Share {
            x: Fq::from((i + 1) as u64),
            y: guardian_share_v1(&sid, &ACCOUNT, g),
        })
        .collect();

    let secret = Fq::from(123456789u64);
    let buss = BottomUpSSS::new(1, 4).unwrap();
    let phi = buss.split(secret, &shares).unwrap();
    assert_eq!(phi.len(), 2, "|phi| = n - t");

    let quorum = vec![shares[0].clone(), shares[2].clone()];
    let recovered = buss.reconstruct(&phi, &quorum).unwrap();
    assert_eq!(recovered, secret);
    assert!(bool::from(recovered.is_zero()) == false);
}
