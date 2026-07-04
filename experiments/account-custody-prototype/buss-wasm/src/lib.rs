//! BUSS (ANARKey, EPRINT 2025/551) bindings for the account-custody prototype.
//!
//! Thin wasm-bindgen wrapper over the Pleiades library. All field elements
//! cross the JS boundary as hex strings of the canonical 32-byte `to_repr`
//! encoding of the BLS12-381 scalar field (`midnight_curves::Fq`).
//!
//! Session-identifier discipline (the load-bearing rule from the paper's
//! Remark 6.1): every published backup MUST use a fresh `session_id`. The
//! TypeScript side derives it as
//! `"midnight:passport:recovery:buss:v0" ‖ contract_address ‖ session_nonce`
//! with a fresh random 32-byte nonce per backup, and stores the nonce in the
//! contract so a recovering party can rebuild the identifier from public
//! state alone.
//!
//! The `core` module is plain Rust (String errors) so it tests natively; the
//! `#[wasm_bindgen]` exports are thin wrappers converting to `JsError`.

use wasm_bindgen::prelude::*;

mod core {
    use ff::{FromUniformBytes, PrimeField};
    use midnight_curves::Fq;
    use pleiades::{guardian_share, BottomUpSSS};
    use serde::{Deserialize, Serialize};
    use sha2::Sha512;

    pub fn fq_to_hex(f: &Fq) -> String {
        hex::encode(f.to_repr().as_ref())
    }

    pub fn fq_from_hex(s: &str) -> Result<Fq, String> {
        let bytes = hex::decode(s.trim().trim_start_matches("0x"))
            .map_err(|e| format!("invalid hex: {e}"))?;
        let mut repr = <Fq as PrimeField>::Repr::default();
        if bytes.len() != repr.as_ref().len() {
            return Err(format!(
                "expected {} bytes, got {}",
                repr.as_ref().len(),
                bytes.len()
            ));
        }
        repr.as_mut().copy_from_slice(&bytes);
        Option::<Fq>::from(Fq::from_repr(repr))
            .ok_or_else(|| "bytes are not a canonical field element".to_string())
    }

    /// A guardian share as exchanged with JS: 1-based index plus σ as hex.
    #[derive(Serialize, Deserialize)]
    pub struct SigmaEntry {
        pub index: usize,
        pub sigma: String,
    }

    fn parse_sigmas(sigmas_json: &str) -> Result<Vec<(usize, Fq)>, String> {
        let raw: Vec<SigmaEntry> =
            serde_json::from_str(sigmas_json).map_err(|e| format!("bad sigmas JSON: {e}"))?;
        raw.iter()
            .map(|e| Ok((e.index, fq_from_hex(&e.sigma)?)))
            .collect()
    }

    pub fn field_from_seed(seed: &[u8]) -> Result<String, String> {
        if seed.len() < 64 {
            return Err("seed must be at least 64 bytes".to_string());
        }
        let mut bytes = [0u8; 64];
        bytes.copy_from_slice(&seed[..64]);
        Ok(fq_to_hex(&Fq::from_uniform_bytes(&bytes)))
    }

    pub fn guardian_sigma(session_id: &[u8], guardian_sk_hex: &str) -> Result<String, String> {
        let sk = fq_from_hex(guardian_sk_hex)?;
        Ok(fq_to_hex(&guardian_share::<Fq, Sha512>(session_id, sk)))
    }

    /// Derive a guardian key from long-lived secret material:
    /// SHA-512(tag ‖ secret) mapped to a field element. Byte-identical to the
    /// former node:crypto derivation, so it runs the same in Node and browser.
    pub fn guardian_key(tag: &[u8], secret: &[u8]) -> String {
        use sha2::Digest;
        let digest = Sha512::new()
            .chain_update(tag)
            .chain_update(secret)
            .finalize();
        let mut bytes = [0u8; 64];
        bytes.copy_from_slice(&digest);
        fq_to_hex(&Fq::from_uniform_bytes(&bytes))
    }

    pub fn buss_share(
        secret_hex: &str,
        sigmas_json: &str,
        t: usize,
        n: usize,
    ) -> Result<String, String> {
        let secret = fq_from_hex(secret_hex)?;
        let sigmas = parse_sigmas(sigmas_json)?;
        let buss = BottomUpSSS::new(t, n).map_err(|e| e.to_string())?;
        let phi = buss.share(secret, &sigmas).map_err(|e| e.to_string())?;
        let phi_hex: Vec<String> = phi.iter().map(fq_to_hex).collect();
        serde_json::to_string(&phi_hex).map_err(|e| e.to_string())
    }

    pub fn buss_reconstruct(
        phi_json: &str,
        sigmas_json: &str,
        t: usize,
        n: usize,
    ) -> Result<String, String> {
        let phi_hex: Vec<String> =
            serde_json::from_str(phi_json).map_err(|e| format!("bad phi JSON: {e}"))?;
        let phi: Vec<Fq> = phi_hex
            .iter()
            .map(|h| fq_from_hex(h))
            .collect::<Result<_, _>>()?;
        let sigmas = parse_sigmas(sigmas_json)?;
        let buss = BottomUpSSS::new(t, n).map_err(|e| e.to_string())?;
        let secret = buss.reconstruct(&phi, &sigmas).map_err(|e| e.to_string())?;
        Ok(fq_to_hex(&secret))
    }
}

// ── Exported API (wasm) ───────────────────────────────────────────────────────

/// Map at least 64 uniformly random bytes to a uniformly distributed field
/// element, returned as hex. Used for the recovery secret, paper-guardian
/// keys, and (via a hash) the passport guardian key.
#[wasm_bindgen]
pub fn field_from_seed(seed: &[u8]) -> Result<String, JsError> {
    core::field_from_seed(seed).map_err(|e| JsError::new(&e))
}

/// Compute a guardian's share σ = H(session_id ‖ guardian_sk).
///
/// Stateless: the guardian recomputes the identical value at backup and at
/// recovery time from their own key plus the public session identifier.
#[wasm_bindgen]
pub fn guardian_sigma(session_id: &[u8], guardian_sk_hex: &str) -> Result<String, JsError> {
    core::guardian_sigma(session_id, guardian_sk_hex).map_err(|e| JsError::new(&e))
}

/// Derive a guardian key from long-lived secret material (e.g. a passport's
/// device secret): SHA-512(tag ‖ secret) mapped to a field element.
#[wasm_bindgen]
pub fn guardian_key(tag: &[u8], secret: &[u8]) -> String {
    core::guardian_key(tag, secret)
}

/// Owner-side backup: from the secret and ALL n−1 guardian σ values, compute
/// the public vector φ (n−t−1 hex-encoded field elements, as a JSON array).
///
/// `sigmas_json`: JSON array of `{index, sigma}` covering every guardian,
/// indices 1-based and distinct. Threshold for recovery is t+1.
#[wasm_bindgen]
pub fn buss_share(
    secret_hex: &str,
    sigmas_json: &str,
    t: usize,
    n: usize,
) -> Result<String, JsError> {
    core::buss_share(secret_hex, sigmas_json, t, n).map_err(|e| JsError::new(&e))
}

/// Recovery: from the public vector φ and any t+1 guardian σ values,
/// reconstruct the secret (returned as hex).
#[wasm_bindgen]
pub fn buss_reconstruct(
    phi_json: &str,
    sigmas_json: &str,
    t: usize,
    n: usize,
) -> Result<String, JsError> {
    core::buss_reconstruct(phi_json, sigmas_json, t, n).map_err(|e| JsError::new(&e))
}

// ── Tests (native) ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::core::*;

    fn seed(byte: u8) -> Vec<u8> {
        vec![byte; 64]
    }

    #[test]
    fn round_trip_mixed_quorum() {
        // 3 guardians (1 passport + 2 paper), threshold 2: t=1, n=4, phi_len=2.
        let (t, n) = (1usize, 4usize);
        let session = b"midnight:passport:recovery:buss:v0|addr|nonce";

        let secret = field_from_seed(&seed(1)).unwrap();
        let sks: Vec<String> = (2u8..5)
            .map(|b| field_from_seed(&seed(b)).unwrap())
            .collect();

        let sigmas: Vec<SigmaEntry> = sks
            .iter()
            .enumerate()
            .map(|(i, sk)| SigmaEntry {
                index: i + 1,
                sigma: guardian_sigma(session, sk).unwrap(),
            })
            .collect();
        let sigmas_json = serde_json::to_string(&sigmas).unwrap();

        let phi_json = buss_share(&secret, &sigmas_json, t, n).unwrap();
        let phi: Vec<String> = serde_json::from_str(&phi_json).unwrap();
        assert_eq!(phi.len(), n - t - 1);

        // Recover with guardians 1 and 3 (a t+1 subset), σ recomputed fresh.
        let subset: Vec<SigmaEntry> = [1usize, 3]
            .iter()
            .map(|&j| SigmaEntry {
                index: j,
                sigma: guardian_sigma(session, &sks[j - 1]).unwrap(),
            })
            .collect();
        let recovered =
            buss_reconstruct(&phi_json, &serde_json::to_string(&subset).unwrap(), t, n).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn wrong_session_id_fails_reconstruction() {
        let (t, n) = (1usize, 4usize);
        let secret = field_from_seed(&seed(9)).unwrap();
        let sks: Vec<String> = (10u8..13)
            .map(|b| field_from_seed(&seed(b)).unwrap())
            .collect();

        let sigmas: Vec<SigmaEntry> = sks
            .iter()
            .enumerate()
            .map(|(i, sk)| SigmaEntry {
                index: i + 1,
                sigma: guardian_sigma(b"session-A", sk).unwrap(),
            })
            .collect();
        let phi_json = buss_share(&secret, &serde_json::to_string(&sigmas).unwrap(), t, n).unwrap();

        // σ derived under a different session id must not reconstruct.
        let stale: Vec<SigmaEntry> = [1usize, 2]
            .iter()
            .map(|&j| SigmaEntry {
                index: j,
                sigma: guardian_sigma(b"session-B", &sks[j - 1]).unwrap(),
            })
            .collect();
        let recovered =
            buss_reconstruct(&phi_json, &serde_json::to_string(&stale).unwrap(), t, n).unwrap();
        assert_ne!(recovered, secret);
    }

    #[test]
    fn below_threshold_errors() {
        let (t, n) = (1usize, 4usize);
        let secret = field_from_seed(&seed(20)).unwrap();
        let sks: Vec<String> = (21u8..24)
            .map(|b| field_from_seed(&seed(b)).unwrap())
            .collect();
        let sigmas: Vec<SigmaEntry> = sks
            .iter()
            .enumerate()
            .map(|(i, sk)| SigmaEntry {
                index: i + 1,
                sigma: guardian_sigma(b"s", sk).unwrap(),
            })
            .collect();
        let phi_json = buss_share(&secret, &serde_json::to_string(&sigmas).unwrap(), t, n).unwrap();
        let one: Vec<SigmaEntry> = vec![SigmaEntry {
            index: 1,
            sigma: guardian_sigma(b"s", &sks[0]).unwrap(),
        }];
        assert!(buss_reconstruct(&phi_json, &serde_json::to_string(&one).unwrap(), t, n).is_err());
    }
}
