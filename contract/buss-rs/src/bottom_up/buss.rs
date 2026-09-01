//! Implementation of ANARkey <https://eprint.iacr.org/2025/551>

use digest::{Digest, OutputSizeUser};
use ff::{FromUniformBytes, PrimeField};

use crate::bottom_up::{lagrange_basis_at_point, BottumUpSS};
use crate::error::Error;
use crate::math::polynomial::Polynomial;

/// A single share: an evaluation point x and the polynomial value f(x).
///
/// Used for both guardian shares `(x = j, y = σ_j)` and public φ entries
/// `(x = -k, y = f(-k))` — the [`BottumUpSS`] trait treats them uniformly.
#[derive(Clone, Debug)]
pub struct Share<F> {
    pub x: F,
    pub y: F,
}

/// Compute a guardian's share contribution σ_{i,j} = H(owner_id ‖ guardian_sk).
///
/// In the ANARKey protocol each guardian P_j derives their share for key-owner
/// P_i deterministically from their own secret key — no extra storage needed.
/// The guardian can recompute the same σ at recovery time by calling this
/// function again with the same inputs.
///
/// The hash function `D` must produce 64 bytes (e.g. SHA-512, BLAKE2b-512).
/// The 64-byte digest is reduced to a uniformly distributed field element via
/// `FromUniformBytes<64>` (hash-and-pray style, bias < 2^{-128} for 256-bit fields).
///
/// # Example
/// ```rust,ignore
/// use sha2::Sha512;
/// let sigma = guardian_share::<Fq, Sha512>(owner_pk.as_bytes(), guardian_sk);
/// ```
pub fn guardian_share<F, D>(owner_id: &[u8], guardian_sk: F) -> F
where
    F: PrimeField + FromUniformBytes<64>,
    D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>,
{
    let sk_repr = guardian_sk.to_repr();

    let output = D::new()
        .chain_update(owner_id)
        .chain_update(sk_repr.as_ref())
        .finalize();

    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(&output);
    F::from_uniform_bytes(&bytes)
}

/// Bottom-Up Secret Sharing (BUSS) — a (t+1)-out-of-(n−1) threshold scheme
/// where each guardian independently chooses their own share, and the dealer
/// derives a short public value φ so that any t+1 guardians can reconstruct
/// the secret using φ without storing anything beyond their own key.
///
/// Construction (§5.1 of the ANARKey paper):
///
/// **Share(s, σ̃_B, B)**
/// Given the secret s and n−1 independently chosen guardian shares {σ_j}_{j∈B},
/// build the unique degree-(n−1) polynomial f satisfying:
///   - f(0) = s
///   - f(j) = σ_j  for all j ∈ B
///
/// and publish φ = (f(−1), f(−2), …, f(−(n−t−1))).
///
/// **Recon(φ, σ̃_R, R)**
/// Combine the n−t−1 public points (−k, φ[k−1]) with t+1 guardian shares
/// (j, σ_j) for j ∈ R. Together these n points uniquely determine f, so
/// Lagrange interpolation at 0 recovers s = f(0).
pub struct BottomUpSSS {
    pub t: usize,
    pub n: usize,
}

impl BottomUpSSS {
    /// Create a (t+1)-out-of-(n−1) BUSS instance.
    ///
    /// Requires n ≥ 2 and t < n−1 (so the threshold is strictly less than the
    /// number of shares).
    pub fn new(t: usize, n: usize) -> Result<Self, Error> {
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
        Ok(Self { t, n })
    }

    /// Reconstruction threshold: t+1 shares are required.
    pub fn threshold(&self) -> usize {
        self.t + 1
    }

    /// Number of guardian shares: n−1.
    pub fn num_shares(&self) -> usize {
        self.n - 1
    }

    /// Length of the public value φ: n−t−1 field elements.
    pub fn phi_len(&self) -> usize {
        self.n - self.t - 1
    }
}

// ── §8 Extension helpers ──────────────────────────────────────────────────────

/// Compute Δ = new_σ − old_σ to send to a key-owner when rotating a guardian key.
///
/// When guardian j updates their secret key from `old_sk` to `new_sk`, they call
/// this function once per key-owner (using the owner's `owner_id`) and send the
/// resulting Δ.  The owner passes it to [`BottomUpSSS::apply_key_update`].
///
/// The hash function `D` must be the same one used in the original [`guardian_share`]
/// call (e.g. SHA-512, BLAKE2b-512).
pub fn key_update_delta<F, D>(owner_id: &[u8], old_sk: F, new_sk: F) -> F
where
    F: PrimeField + FromUniformBytes<64>,
    D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>,
{
    let old_sigma = guardian_share::<F, D>(owner_id, old_sk);
    let new_sigma = guardian_share::<F, D>(owner_id, new_sk);
    new_sigma - old_sigma
}

// ── §8 Extension: Cold Wallets ────────────────────────────────────────────────

/// Construct the canonical message that a cold wallet signs to derive σ_{i,j}.
///
/// Per §8 (Cold wallets), instead of hashing the raw secret key, the guardian's
/// cold wallet signs a deterministic message so the raw sk is never exposed in
/// host memory.  This function encodes `(b"Rec", owner_id, guardian_index)` in a
/// length-prefixed, collision-free format.  Both backup and recovery **must** sign
/// the identical message — identical `(owner_id, guardian_index)` inputs always
/// produce the same bytes.
///
/// # Format
/// ```text
/// b"Rec" ‖ len(owner_id) as u32 BE ‖ owner_id ‖ guardian_index as u64 BE
/// ```
pub fn cold_wallet_message(owner_id: &[u8], guardian_index: usize) -> Vec<u8> {
    const TAG: &[u8] = b"Rec";
    let id_len = (owner_id.len() as u32).to_be_bytes();
    let j_bytes = (guardian_index as u64).to_be_bytes();

    let mut msg = Vec::with_capacity(TAG.len() + 4 + owner_id.len() + 8);
    msg.extend_from_slice(TAG);
    msg.extend_from_slice(&id_len);
    msg.extend_from_slice(owner_id);
    msg.extend_from_slice(&j_bytes);
    msg
}

/// Derive a guardian share from a cold-wallet deterministic signature.
///
/// Per §8 (Cold wallets), the guardian's cold wallet signs the message produced
/// by [`cold_wallet_message`] with a deterministic algorithm (RFC 6979 ECDSA,
/// BIP-340 Schnorr, …) to get ξ_{i,j}, then this function maps that signature
/// to a field element via `σ_{i,j} = H(ξ_{i,j})`.
///
/// This replaces [`guardian_share`] for cold-wallet signers: the raw secret key
/// is never loaded into host memory — only the signature bytes are passed here.
///
/// The output is a uniformly distributed field element (bias < 2^{-128} for
/// 256-bit fields), compatible with the same BUSS `share`/`reconstruct` API.
pub fn guardian_share_from_sig<F, D>(sig_bytes: &[u8]) -> F
where
    F: PrimeField + FromUniformBytes<64>,
    D: Digest + OutputSizeUser<OutputSize = digest::consts::U64>,
{
    let output = D::new().chain_update(sig_bytes).finalize();
    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(&output);
    F::from_uniform_bytes(&bytes)
}

// ── BottumUpSS trait impl ───────────────────────────────────────────────────────

impl<F: PrimeField + FromUniformBytes<64>> BottumUpSS<F> for BottomUpSSS {
    type Share = Share<F>;

    /// Evaluate f at −1, …, −(n−t−1) to produce the public value φ.
    fn split(&self, secret: F, shares: &[Self::Share]) -> Result<Vec<Self::Share>, Error> {
        if shares.len() != self.n - 1 {
            return Err(Error::InvalidShares);
        }

        // Assert there is no point at 0
        let mut evals: Vec<(F, F)> = shares.iter().map(|s| (s.x, s.y)).collect();
        if evals.iter().any(|s| s.0.is_zero_vartime()) {
            return Err(Error::InvalidShares);
        }

        // Add point (0, sk) and interpolate to get polynomial
        evals.push((F::ZERO, secret));
        let poly = Polynomial::interpolate(&evals).unwrap();

        let phi = (1..=self.phi_len())
            .map(|k| {
                let x = -F::from(k as u64);
                Share { x, y: poly.eval(x) }
            })
            .collect();
        Ok(phi)
    }

    /// Reconstruct the secret from φ (`public_shares`) and at least t+1
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
        points.extend(shares.iter().map(|s| (s.x, s.y)));
        Polynomial::lagrange_at_zero(&points)
    }

    /// Shift φ in-place by Δ·L_{j,X} so `f(0)` is unchanged and `f(j)` moves
    /// by Δ — the trait-level equivalent of [`BottomUpSSS::apply_key_update`],
    /// operating on `Share<F>` (whose `.x` already carries each φ entry's
    /// evaluation point) instead of a bare `phi: &mut [F]`.
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ff::Field;
    use midnight_curves::Fq;
    use sha2::Sha512;

    fn rng() -> impl rand_core::RngCore {
        rand::thread_rng()
    }

    // ── BottumUpSS trait ──────────────────────────────────────────────────────

    #[test]
    fn trait_split_and_reconstruct_roundtrip() {
        let mut rng = rng();
        let buss = BottomUpSSS::new(1, 4).unwrap(); // t=1, n=4: 3 guardian shares, phi_len=2

        let secret = Fq::random(&mut rng);
        let guardian_shares: Vec<Share<Fq>> = (1..=buss.num_shares())
            .map(|j| Share {
                x: Fq::from(j as u64),
                y: Fq::random(&mut rng),
            })
            .collect();

        let phi = buss.split(secret, &guardian_shares).unwrap();
        assert_eq!(phi.len(), buss.phi_len());

        let recovered = buss.reconstruct(&phi, &guardian_shares).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn trait_split_rejects_wrong_guardian_count() {
        let mut rng = rng();
        let buss = BottomUpSSS::new(1, 4).unwrap(); // expects 3 guardian shares
        let secret = Fq::random(&mut rng);
        let too_few = vec![Share {
            x: Fq::ONE,
            y: Fq::random(&mut rng),
        }];
        let err = buss.split(secret, &too_few).unwrap_err();
        assert_eq!(err, Error::InvalidShares);
    }

    #[test]
    fn trait_split_rejects_zero_x_guardian_share() {
        let mut rng = rng();
        let buss = BottomUpSSS::new(1, 4).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = vec![
            Share {
                x: Fq::ZERO,
                y: Fq::random(&mut rng),
            }, // collides with the secret's own point
            Share {
                x: Fq::from(2u64),
                y: Fq::random(&mut rng),
            },
            Share {
                x: Fq::from(3u64),
                y: Fq::random(&mut rng),
            },
        ];
        let err = buss.split(secret, &shares).unwrap_err();
        assert_eq!(err, Error::InvalidShares);
    }

    #[test]
    fn trait_update_public_shares_preserves_secret() {
        let mut rng = rng();
        let buss = BottomUpSSS::new(1, 4).unwrap();

        let secret = Fq::random(&mut rng);
        let indices: Vec<Fq> = (1..=buss.num_shares())
            .map(|j| Fq::from(j as u64))
            .collect();
        let mut guardian_shares: Vec<Share<Fq>> = indices
            .iter()
            .map(|&x| Share {
                x,
                y: Fq::random(&mut rng),
            })
            .collect();

        let mut phi = buss.split(secret, &guardian_shares).unwrap();

        // Guardian at indices[1] rotates their share.
        let old_sigma = guardian_shares[1].y;
        let new_sigma = Fq::random(&mut rng);
        let delta = new_sigma - old_sigma;
        buss.update_public_shares(indices[1], &indices, delta, &mut phi)
            .unwrap();
        guardian_shares[1].y = new_sigma;

        let recovered = buss.reconstruct(&phi, &guardian_shares).unwrap();
        assert_eq!(
            recovered, secret,
            "secret must be unchanged after key update"
        );
    }

    // ── Key Update ────────────────────────────────────────────────────────────

    #[test]
    fn key_update_preserves_secret_and_shifts_share() {
        let mut rng = rng();
        let owner_id = b"alice";
        let buss = BottomUpSSS::new(1, 4).unwrap(); // t=1, n=4 → 3 shares, phi_len=2

        let secret = Fq::random(&mut rng);
        let g_keys: Vec<Fq> = (0..3).map(|_| Fq::random(&mut rng)).collect();
        let indices: Vec<Fq> = vec![Fq::from(1u64), Fq::from(2u64), Fq::from(3u64)];

        let guardian_shares: Vec<Share<Fq>> = indices
            .iter()
            .zip(&g_keys)
            .map(|(&x, &sk)| Share {
                x,
                y: guardian_share::<Fq, Sha512>(owner_id, sk),
            })
            .collect();

        let mut phi = buss.split(secret, &guardian_shares).unwrap();

        // Guardian 2 (indices[1]) rotates their key.
        let new_key = Fq::random(&mut rng);
        let delta = key_update_delta::<Fq, Sha512>(owner_id, g_keys[1], new_key);
        buss.update_public_shares(indices[1], &indices, delta, &mut phi)
            .unwrap();

        // Recovery with the NEW share for guardian 2 and old share for guardian 1.
        let sigma_r = vec![
            Share {
                x: indices[0],
                y: guardian_share::<Fq, Sha512>(owner_id, g_keys[0]),
            },
            Share {
                x: indices[1],
                y: guardian_share::<Fq, Sha512>(owner_id, new_key),
            },
        ];
        let recovered = buss.reconstruct(&phi, &sigma_r).unwrap();
        assert_eq!(
            recovered, secret,
            "secret must be unchanged after key update"
        );
    }

    #[test]
    fn key_update_delta_zero_when_key_unchanged() {
        let sk = Fq::from(42u64);
        let delta = key_update_delta::<Fq, Sha512>(b"owner", sk, sk);
        assert_eq!(delta, Fq::ZERO);
    }

    #[test]
    fn update_public_shares_wrong_phi_length_errors() {
        let buss = BottomUpSSS::new(1, 3).unwrap(); // phi_len = 1
        let mut phi = vec![
            Share {
                x: -Fq::ONE,
                y: Fq::ONE,
            },
            Share {
                x: -Fq::from(2u64),
                y: Fq::ONE,
            },
        ]; // wrong: length 2
        let err = buss.update_public_shares(Fq::ONE, &[Fq::ONE, Fq::from(2u64)], Fq::ONE, &mut phi);
        assert!(matches!(err, Err(Error::InvalidParameters(_))));
    }

    #[test]
    fn update_public_shares_unknown_guardian_errors() {
        let buss = BottomUpSSS::new(1, 3).unwrap(); // phi_len = 1
        let mut phi = vec![Share {
            x: -Fq::ONE,
            y: Fq::ONE,
        }];
        let err = buss.update_public_shares(
            Fq::from(5u64),
            &[Fq::ONE, Fq::from(2u64)],
            Fq::ONE,
            &mut phi,
        );
        assert!(matches!(err, Err(Error::InvalidParameters(_))));
    }

    // ── Cold Wallets ──────────────────────────────────────────────────────────

    #[test]
    fn cold_wallet_message_is_deterministic() {
        let m1 = cold_wallet_message(b"owner1", 3);
        let m2 = cold_wallet_message(b"owner1", 3);
        assert_eq!(m1, m2);
    }

    #[test]
    fn cold_wallet_message_differs_by_owner() {
        assert_ne!(
            cold_wallet_message(b"alice", 1),
            cold_wallet_message(b"bob", 1)
        );
    }

    #[test]
    fn cold_wallet_message_differs_by_index() {
        assert_ne!(
            cold_wallet_message(b"alice", 1),
            cold_wallet_message(b"alice", 2)
        );
    }

    #[test]
    fn cold_wallet_message_no_prefix_collision() {
        // b"owner" ‖ index=1  vs  b"owne" ‖ index with shifted bytes
        // The u32 length prefix makes these unambiguous.
        assert_ne!(
            cold_wallet_message(b"owner", 1),
            cold_wallet_message(b"owne", 0x72_00_00_00_01)
        );
    }

    #[test]
    fn guardian_share_from_sig_is_deterministic() {
        let sig = b"some_deterministic_signature_bytes";
        let s1 = guardian_share_from_sig::<Fq, Sha512>(sig);
        let s2 = guardian_share_from_sig::<Fq, Sha512>(sig);
        assert_eq!(s1, s2);
    }

    #[test]
    fn guardian_share_from_sig_differs_for_different_sigs() {
        let s1 = guardian_share_from_sig::<Fq, Sha512>(b"sig_for_owner_alice_guardian_1");
        let s2 = guardian_share_from_sig::<Fq, Sha512>(b"sig_for_owner_alice_guardian_2");
        assert_ne!(s1, s2);
    }

    #[test]
    fn cold_wallet_buss_roundtrip() {
        // Simulate a BUSS roundtrip where guardian shares come from cold-wallet sigs.
        let mut rng = rng();
        let buss = BottomUpSSS::new(1, 3).unwrap(); // 2 shares, threshold 2
        let owner_id = b"bob";
        let secret = Fq::random(&mut rng);

        // Guardians sign the canonical message and derive σ from the signature.
        // (Here we simulate the signature bytes directly; in practice the cold
        // wallet would produce them via ECDSA / Schnorr.)
        let fake_sigs: Vec<Vec<u8>> = (1usize..=2)
            .map(|j| {
                let msg = cold_wallet_message(owner_id, j);
                // Simulate a deterministic signature: H(sk_j ‖ msg) where sk_j is
                // represented as a fixed test vector.
                let sk_j_bytes = [j as u8; 32];
                let mut sig = Vec::new();
                sig.extend_from_slice(&sk_j_bytes);
                sig.extend_from_slice(&msg);
                sig
            })
            .collect();

        let guardian_shares: Vec<Share<Fq>> = fake_sigs
            .iter()
            .enumerate()
            .map(|(i, sig)| Share {
                x: Fq::from((i + 1) as u64),
                y: guardian_share_from_sig::<Fq, Sha512>(sig),
            })
            .collect();

        let phi = buss.split(secret, &guardian_shares).unwrap();

        // Recovery: both guardians re-derive σ from their signature.
        let sigma_r: Vec<Share<Fq>> = fake_sigs
            .iter()
            .enumerate()
            .map(|(i, sig)| Share {
                x: Fq::from((i + 1) as u64),
                y: guardian_share_from_sig::<Fq, Sha512>(sig),
            })
            .collect();

        let recovered = buss.reconstruct(&phi, &sigma_r).unwrap();
        assert_eq!(recovered, secret);
    }
}
