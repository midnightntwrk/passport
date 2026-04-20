//! Schnorr signature operations on the JubJub curve using midnight-curves.
//!
//! This module implements the same Schnorr scheme as the Compact contract:
//!   s*G == R + c*owner_pk
//!
//! All curve operations use the `midnight_curves` types directly — the same
//! types that the midnight-ledger proof system uses in-circuit.

use ff::Field;
use group::Group;
use midnight_curves::{Fr as EmbeddedFr, JubjubSubgroup};
use rand::rngs::OsRng;

/// A Schnorr signer holding a JubJub secret key.
pub struct SchnorrSigner {
    sk: EmbeddedFr,
    pk: JubjubSubgroup,
}

impl SchnorrSigner {
    /// Generate a random key pair.
    pub fn random() -> Self {
        let sk = EmbeddedFr::random(&mut OsRng);
        let pk = JubjubSubgroup::generator() * sk;
        Self { sk, pk }
    }

    /// Create a signer from an existing secret key scalar.
    pub fn from_scalar(sk: EmbeddedFr) -> Self {
        let pk = JubjubSubgroup::generator() * sk;
        Self { sk, pk }
    }

    /// Return the public key point.
    pub fn public_key(&self) -> JubjubSubgroup {
        self.pk
    }

    /// Produce a Schnorr signature (R, s) for a given challenge scalar c.
    ///
    /// In the full protocol the challenge c is derived from:
    ///   c = persistentHash(R, pk, color, amount, recipient, tx_count, nonce)
    ///
    /// This function takes c as input (already computed) and returns (R, s)
    /// where:
    ///   r = random nonce scalar
    ///   R = r * G
    ///   s = r + c * sk   (mod JubJub order)
    pub fn sign(&self, challenge: &EmbeddedFr) -> (JubjubSubgroup, EmbeddedFr) {
        let r = EmbeddedFr::random(&mut OsRng);
        let big_r = JubjubSubgroup::generator() * r;
        let s = r + (*challenge * self.sk);
        (big_r, s)
    }

    /// Sign with a given nonce (for deterministic testing).
    pub fn sign_with_nonce(
        &self,
        challenge: &EmbeddedFr,
        r: &EmbeddedFr,
    ) -> (JubjubSubgroup, EmbeddedFr) {
        let big_r = JubjubSubgroup::generator() * *r;
        let s = *r + (*challenge * self.sk);
        (big_r, s)
    }
}

/// Verify a Schnorr signature: s*G == R + c*pk
pub fn verify(
    pk: &JubjubSubgroup,
    challenge: &EmbeddedFr,
    sig_r: &JubjubSubgroup,
    sig_s: &EmbeddedFr,
) -> bool {
    let lhs = JubjubSubgroup::generator() * *sig_s;
    let rhs = *sig_r + (*pk * *challenge);
    lhs == rhs
}

/// Generate a random JubJub scalar (for testing).
pub fn random_jubjub_scalar() -> EmbeddedFr {
    EmbeddedFr::random(&mut OsRng)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify() {
        let signer = SchnorrSigner::random();
        let challenge = random_jubjub_scalar();
        let (sig_r, sig_s) = signer.sign(&challenge);
        assert!(verify(&signer.public_key(), &challenge, &sig_r, &sig_s));
    }

    #[test]
    fn wrong_challenge_fails() {
        let signer = SchnorrSigner::random();
        let challenge = random_jubjub_scalar();
        let wrong_challenge = random_jubjub_scalar();
        let (sig_r, sig_s) = signer.sign(&challenge);
        assert!(!verify(
            &signer.public_key(),
            &wrong_challenge,
            &sig_r,
            &sig_s
        ));
    }

    #[test]
    fn wrong_key_fails() {
        let signer = SchnorrSigner::random();
        let other = SchnorrSigner::random();
        let challenge = random_jubjub_scalar();
        let (sig_r, sig_s) = signer.sign(&challenge);
        assert!(!verify(&other.public_key(), &challenge, &sig_r, &sig_s));
    }

    #[test]
    fn deterministic_nonce() {
        let signer = SchnorrSigner::random();
        let challenge = random_jubjub_scalar();
        let r = random_jubjub_scalar();
        let (sig_r1, sig_s1) = signer.sign_with_nonce(&challenge, &r);
        let (sig_r2, sig_s2) = signer.sign_with_nonce(&challenge, &r);
        assert_eq!(sig_r1, sig_r2);
        assert_eq!(sig_s1, sig_s2);
        assert!(verify(&signer.public_key(), &challenge, &sig_r1, &sig_s1));
    }
}
