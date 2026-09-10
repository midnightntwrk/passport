//! The whole-envelope WebAuthn relation: every check a relying party
//! performs on a passkey assertion, performed inside the circuit.
//!
//! [`crate::relations::P256EcdsaWebAuthn`] verifies the signature over the
//! envelope but takes `SHA-256(clientDataJSON)` as a public input, so the
//! challenge, ceremony-type, and rpIdHash bindings are checked by whoever
//! consumes the proof. [`P256EcdsaWebAuthnEnvelope`] moves those checks
//! in-circuit: `clientDataJSON` and `authenticatorData` become witnesses,
//! and the public interface shrinks to exactly what an account contract
//! knows — the public key, the expected rpIdHash, and the 32-byte challenge.
//! The proof alone then states "this passkey authorised exactly this
//! challenge for this relying party".
//!
//! In-circuit constraints, in order:
//!
//! 1. `clientDataJSON` starts with the fixed 36-byte prefix
//!    `{"type":"webauthn.get","challenge":"` — which pins the ceremony type
//!    (a create-ceremony attestation signs the same envelope shape, so
//!    without this a registration could pass as an assertion) and the
//!    position of the challenge member. The WebAuthn Level 3 serialisation
//!    algorithm emits `type` then `challenge` first, in exactly this form.
//! 2. Bytes 36..79 equal the base64url encoding (43 characters, unpadded)
//!    of the public challenge, and byte 79 is the closing quote. The
//!    encoding is a deterministic public function of the public challenge,
//!    so it is expanded natively in [`Relation::format_instance`] — the
//!    verifier derives the expected characters itself; the prover cannot
//!    substitute them.
//! 3. `authenticatorData[0..32]` equals the public rpIdHash.
//! 4. The flags byte has the user-present bit set (and, if the relation is
//!    built with `require_user_verification`, the user-verified bit too).
//! 5. `SHA-256(clientDataJSON)` is computed in-circuit, then the signed
//!    message `SHA-256(authenticatorData || clientDataHash)`, then the
//!    ECDSA P-256 verification — the same body as the other relations.
//!
//! The `clientDataJSON` byte length is a structural parameter of the
//! relation (SHA-256 over a fixed-length slice), so the verifying key is
//! specific to one length. Real lengths vary only with the origin string
//! and per-browser extras (Chrome appends `"crossOrigin":false`), so a
//! deployment pins one length per supported client shape — or graduates to
//! the stdlib's variable-length SHA-256 gadget (`sha2_256_varlen`), whose
//! chunk alignment makes the payload offset depend on the length and is
//! left as the follow-up measurement.

use midnight_circuits::{
    instructions::{
        AssertionInstructions, AssignmentInstructions, DecompositionInstructions,
        PublicInputInstructions,
    },
    types::{AssignedByte, Instantiable},
};
use midnight_curves::p256::{Fq as P256Scalar, P256};
use midnight_proofs::{
    circuit::{Layouter, Value},
    plonk::Error,
};
use midnight_zk_stdlib::{Relation, ZkStdLib, ZkStdLibArch};

use crate::relations::{
    assign_public_bytes, bytes_as_public_input, digest_to_scalar, ecdsa_assert_valid,
    AssignedPoint, AUTHENTICATOR_DATA_LEN, DIGEST_LEN, F,
};

/// The fixed prefix of an assertion's `clientDataJSON`: the WebAuthn Level 3
/// serialisation emits the `type` and `challenge` members first, in this
/// exact byte form.
pub const CLIENT_DATA_PREFIX: &[u8; 36] = br#"{"type":"webauthn.get","challenge":""#;

/// Length of the base64url encoding (unpadded) of a 32-byte challenge.
pub const CHALLENGE_B64_LEN: usize = 43;

/// The smallest `clientDataJSON` the relation accepts: prefix, encoded
/// challenge, closing quote. (Real client data continues with the origin
/// member and the closing brace; the tail is committed by the hash but
/// carries no further constraints.)
pub const MIN_CLIENT_DATA_LEN: usize = CLIENT_DATA_PREFIX.len() + CHALLENGE_B64_LEN + 1;

/// The user-present bit of the `authenticatorData` flags byte.
const FLAG_USER_PRESENT: usize = 0;
/// The user-verified bit of the `authenticatorData` flags byte.
const FLAG_USER_VERIFIED: usize = 2;

const B64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url (unpadded) encoding of a 32-byte challenge: 43 characters.
/// Hand-rolled so the circuit crate needs no encoding dependency; the test
/// suite pins it against the captured browser vector.
pub fn base64url_encode_challenge(challenge: &[u8; DIGEST_LEN]) -> [u8; CHALLENGE_B64_LEN] {
    let mut out = [0u8; CHALLENGE_B64_LEN];
    let mut o = 0;
    for chunk in challenge.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out[o] = B64URL_ALPHABET[(triple >> 18) as usize & 0x3f];
        o += 1;
        out[o] = B64URL_ALPHABET[(triple >> 12) as usize & 0x3f];
        o += 1;
        if chunk.len() > 1 {
            out[o] = B64URL_ALPHABET[(triple >> 6) as usize & 0x3f];
            o += 1;
        }
        if chunk.len() > 2 {
            out[o] = B64URL_ALPHABET[triple as usize & 0x3f];
            o += 1;
        }
    }
    debug_assert_eq!(o, CHALLENGE_B64_LEN);
    out
}

/// ECDSA over P-256 with the whole WebAuthn envelope verified in-circuit.
///
/// Instance: `(public key, 32-byte rpIdHash, 32-byte challenge)`. Witness:
/// `(clientDataJSON bytes, 37-byte authenticator data, r, s)`.
#[derive(Clone, Debug)]
pub struct P256EcdsaWebAuthnEnvelope {
    client_data_len: usize,
    require_user_verification: bool,
}

impl P256EcdsaWebAuthnEnvelope {
    /// Builds the relation for a fixed `clientDataJSON` byte length.
    ///
    /// # Panics
    ///
    /// If `client_data_len` is below [`MIN_CLIENT_DATA_LEN`].
    pub fn new(client_data_len: usize, require_user_verification: bool) -> Self {
        assert!(
            client_data_len >= MIN_CLIENT_DATA_LEN,
            "clientDataJSON must be at least {MIN_CLIENT_DATA_LEN} bytes \
             (prefix + encoded challenge + closing quote), got {client_data_len}"
        );
        P256EcdsaWebAuthnEnvelope {
            client_data_len,
            require_user_verification,
        }
    }

    /// The structural `clientDataJSON` byte length this relation verifies.
    pub fn client_data_len(&self) -> usize {
        self.client_data_len
    }

    /// Asserts that bit `index` of the flags byte (`authenticatorData[32]`)
    /// is set.
    fn assert_flag_bit(
        std_lib: &ZkStdLib,
        layouter: &mut impl Layouter<F>,
        flags: &AssignedByte<F>,
        index: usize,
    ) -> Result<(), Error> {
        let bits = std_lib.assigned_to_be_bits(layouter, &flags.clone().into(), Some(8), true)?;
        // Big-endian bit order: bit `index` sits at position `7 - index`.
        std_lib.assert_equal_to_fixed(layouter, &bits[7 - index], true)
    }
}

impl Relation for P256EcdsaWebAuthnEnvelope {
    type Instance = (P256, [u8; DIGEST_LEN], [u8; DIGEST_LEN]);

    type Witness = (
        Vec<u8>,
        [u8; AUTHENTICATOR_DATA_LEN],
        P256Scalar,
        P256Scalar,
    );

    type Error = Error;

    fn format_instance((pk, rp_id_hash, challenge): &Self::Instance) -> Result<Vec<F>, Error> {
        Ok([
            AssignedPoint::as_public_input(pk),
            bytes_as_public_input(rp_id_hash),
            bytes_as_public_input(&base64url_encode_challenge(challenge)),
        ]
        .into_iter()
        .flatten()
        .collect())
    }

    fn circuit(
        &self,
        std_lib: &ZkStdLib,
        layouter: &mut impl Layouter<F>,
        instance: Value<Self::Instance>,
        witness: Value<Self::Witness>,
    ) -> Result<(), Error> {
        let curve = std_lib.p256();
        let scalar_chip = curve.scalar_field_chip();

        // Public inputs: pk, rpIdHash, and the base64url expansion of the
        // challenge (a deterministic public function of the instance,
        // expanded natively on both the prover and verifier side).
        let pk = curve.assign_as_public_input(layouter, instance.as_ref().map(|(pk, _, _)| *pk))?;
        let rp_id_hash =
            assign_public_bytes(std_lib, layouter, instance.as_ref().map(|(_, rp, _)| *rp))?;
        let challenge_chars = assign_public_bytes(
            std_lib,
            layouter,
            instance.map(|(_, _, challenge)| base64url_encode_challenge(&challenge)),
        )?;

        // Witnesses: the client data, the authenticator data, the signature.
        let json_values = witness
            .as_ref()
            .map(|(json, _, _, _)| json.clone())
            .transpose_vec(self.client_data_len);
        let client_data: Vec<AssignedByte<F>> = std_lib.assign_many(layouter, &json_values)?;
        let auth_values = witness.as_ref().map(|(_, auth, _, _)| *auth);
        let auth_data: Vec<AssignedByte<F>> =
            std_lib.assign_many(layouter, &auth_values.transpose_array())?;
        let r = scalar_chip.assign(layouter, witness.as_ref().map(|(_, _, r, _)| *r))?;
        let s = scalar_chip.assign(layouter, witness.map(|(_, _, _, s)| s))?;

        // 1. Fixed prefix: pins the ceremony type and the challenge position.
        for (byte, expected) in client_data.iter().zip(CLIENT_DATA_PREFIX.iter()) {
            std_lib.assert_equal_to_fixed(layouter, byte, *expected)?;
        }

        // 2. The challenge member equals the public encoding, quote-closed.
        let challenge_slice =
            &client_data[CLIENT_DATA_PREFIX.len()..CLIENT_DATA_PREFIX.len() + CHALLENGE_B64_LEN];
        for (byte, expected) in challenge_slice.iter().zip(challenge_chars.iter()) {
            std_lib.assert_equal(layouter, byte, expected)?;
        }
        std_lib.assert_equal_to_fixed(
            layouter,
            &client_data[CLIENT_DATA_PREFIX.len() + CHALLENGE_B64_LEN],
            b'"',
        )?;

        // 3. The assertion was made for the expected relying party.
        for (byte, expected) in auth_data[..32].iter().zip(rp_id_hash.iter()) {
            std_lib.assert_equal(layouter, byte, expected)?;
        }

        // 4. Flags policy: user presence always; user verification when the
        //    relation demands it.
        Self::assert_flag_bit(std_lib, layouter, &auth_data[32], FLAG_USER_PRESENT)?;
        if self.require_user_verification {
            Self::assert_flag_bit(std_lib, layouter, &auth_data[32], FLAG_USER_VERIFIED)?;
        }

        // 5. The signed message, both hashes in-circuit, then ECDSA.
        let client_data_hash = std_lib.sha2_256(layouter, &client_data)?;
        let signed_bytes: Vec<AssignedByte<F>> = auth_data
            .iter()
            .cloned()
            .chain(client_data_hash.iter().cloned())
            .collect();
        let digest = std_lib.sha2_256(layouter, &signed_bytes)?;
        let z = digest_to_scalar(std_lib, layouter, &digest)?;
        ecdsa_assert_valid(std_lib, layouter, &pk, &z, &r, &s)
    }

    fn used_chips(&self) -> ZkStdLibArch {
        ZkStdLibArch {
            p256: true,
            sha2_256: true,
            nr_pow2range_cols: 4,
            ..ZkStdLibArch::default()
        }
    }

    fn write_relation<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        let len = u32::try_from(self.client_data_len).expect("client data length fits in a u32");
        writer.write_all(&len.to_le_bytes())?;
        writer.write_all(&[u8::from(self.require_user_verification)])
    }

    fn read_relation<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut len_bytes = [0u8; 4];
        reader.read_exact(&mut len_bytes)?;
        let mut uv_byte = [0u8; 1];
        reader.read_exact(&mut uv_byte)?;
        Ok(P256EcdsaWebAuthnEnvelope::new(
            u32::from_le_bytes(len_bytes) as usize,
            uv_byte[0] != 0,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The captured browser vector (webauthn/vector.json) is the known-answer
    /// test: its clientDataJSON carries the base64url form of its challenge.
    #[test]
    fn base64url_matches_captured_vector() {
        let challenge =
            hex_literal::hex!("b60dc9041277df0829d3352cc198467aff7f79c0a705d51ed095c3022a5b57e6");
        let expected = b"tg3JBBJ33wgp0zUswZhGev9_ecCnBdUe0JXDAipbV-Y";
        assert_eq!(&base64url_encode_challenge(&challenge), expected);
    }

    #[test]
    fn base64url_alphabet_edges() {
        // All-zero and all-ones challenges exercise both alphabet ends and
        // the trailing 4-bit group.
        assert_eq!(
            &base64url_encode_challenge(&[0u8; 32]),
            b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
        assert_eq!(
            &base64url_encode_challenge(&[0xffu8; 32]),
            b"__________________________________________8"
        );
    }

    #[test]
    fn prefix_is_36_bytes() {
        assert_eq!(CLIENT_DATA_PREFIX.len(), 36);
        assert_eq!(MIN_CLIENT_DATA_LEN, 80);
    }
}
