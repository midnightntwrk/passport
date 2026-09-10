//! Ed25519 (RFC 8032) signature verification `Relation`, ported from
//! midnight-zk's `zk_stdlib/examples/cardano_signature.rs` to this
//! experiment's house pattern, with the message fixed at 32 bytes.
//!
//! The verification criteria match the upstream example (which follows
//! libsodium's ref10 `crypto_sign_open`):
//!
//! * cofactorless (strict) verification equation `R = s * B - h * A`, with
//!   `h = SHA-512(R_bytes || A_bytes || M) mod L` computed in-circuit;
//! * in-circuit canonicity checks for the bytes of `s`, `R`, and `A`;
//! * in-circuit subgroup checks for `R` and `A`.
//!
//! This is one of the "inner" relations of the recursion leg: a device that
//! can only produce Ed25519 signatures proves knowledge of one off-chain,
//! and the wrapper relation (see [`crate::wrapper`]) verifies that proof
//! in-circuit.

use group::Group;
use midnight_circuits::{
    instructions::{
        ArithInstructions, AssertionInstructions, AssignmentInstructions, CanonicityInstructions,
        DecompositionInstructions, EccInstructions, FieldInstructions,
    },
    types::{AssignedBit, AssignedByte},
};
use midnight_curves::curve25519::Curve25519Subgroup;
use midnight_proofs::{
    circuit::{Layouter, Value},
    plonk::Error,
};
use midnight_zk_stdlib::{Relation, ZkStdLib, ZkStdLibArch};

use crate::relations::{assign_public_bytes, bytes_as_public_input, DIGEST_LEN, F};

/// Length in bytes of a compressed Edwards point or an Ed25519 scalar.
pub const ED25519_ENC_LEN: usize = 32;

/// Off-circuit decompression of little-endian compressed Edwards bytes.
///
/// # Panics
///
/// If the bytes are not the compression of a point on the curve, or the
/// point is outside the prime-order subgroup. Reference vectors produced by
/// ed25519-dalek always satisfy both (`A = a * B` and `R = r * B`).
fn decompress_bytes(bytes: &[u8; ED25519_ENC_LEN]) -> Curve25519Subgroup {
    let compressed = midnight_curves::curve25519::CompressedEdwardsY(*bytes);
    let edwards = compressed
        .decompress()
        .expect("y coordinate of curve25519 point");
    Curve25519Subgroup::from_edwards(edwards).expect("curve25519 subgroup point")
}

/// In-circuit conversion of assigned bytes to little-endian assigned bits.
fn assigned_bytes_to_le_bits(
    std_lib: &ZkStdLib,
    layouter: &mut impl Layouter<F>,
    bytes: &[AssignedByte<F>],
) -> Result<Vec<AssignedBit<F>>, Error> {
    let bits = bytes
        .iter()
        .map(|byte| std_lib.assigned_to_le_bits(layouter, &byte.clone().into(), Some(8), false))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect();
    Ok(bits)
}

/// Ed25519 signature verification with a 32-byte message.
///
/// Instance: `(A_bytes, 32-byte message)`, where `A_bytes` is the compressed
/// public key. Witness: `(R_bytes, s_bytes)`, the two halves of the 64-byte
/// signature.
#[derive(Clone, Debug, Default)]
pub struct Ed25519Verify;

impl Relation for Ed25519Verify {
    type Instance = ([u8; ED25519_ENC_LEN], [u8; DIGEST_LEN]);

    type Witness = ([u8; ED25519_ENC_LEN], [u8; ED25519_ENC_LEN]);

    type Error = Error;

    fn format_instance((pk_bytes, msg): &Self::Instance) -> Result<Vec<F>, Error> {
        Ok(
            [bytes_as_public_input(pk_bytes), bytes_as_public_input(msg)]
                .into_iter()
                .flatten()
                .collect(),
        )
    }

    fn circuit(
        &self,
        std_lib: &ZkStdLib,
        layouter: &mut impl Layouter<F>,
        instance: Value<Self::Instance>,
        witness: Value<Self::Witness>,
    ) -> Result<(), Error> {
        let curve = std_lib.curve25519();
        let scalar_chip = curve.scalar_field_chip();

        // Assign the compressed bytes of A as public inputs and decompress
        // them in-circuit (canonicity and subgroup checked by the chip).
        let a_bytes: [AssignedByte<F>; ED25519_ENC_LEN] =
            assign_public_bytes(std_lib, layouter, instance.map(|(a_bytes, _)| a_bytes))?
                .try_into()
                .expect("exactly 32 bytes");
        let a = curve.from_canonical_compressed_bytes(
            layouter,
            &a_bytes,
            instance.map(|(a_bytes, _)| decompress_bytes(&a_bytes)),
        )?;

        // Assign the message bytes M as public inputs.
        let m_bytes = assign_public_bytes(std_lib, layouter, instance.map(|(_, msg)| msg))?;

        // Witness the bytes of s and enforce canonicity (s < L) in-circuit.
        let s_bytes: Vec<AssignedByte<F>> =
            std_lib.assign_many(layouter, &witness.map(|(_, s)| s).transpose_array())?;
        let s_bits = assigned_bytes_to_le_bits(std_lib, layouter, &s_bytes)?;
        let s_is_canonical =
            scalar_chip.le_bits_lower_than(layouter, &s_bits, scalar_chip.order())?;
        scalar_chip.assert_equal_to_fixed(layouter, &s_is_canonical, true)?;
        let s = scalar_chip.assigned_from_le_bits(layouter, &s_bits)?;

        // Witness the compressed bytes of R and decompress them in-circuit.
        let r_bytes: [AssignedByte<F>; ED25519_ENC_LEN] = std_lib
            .assign_many(layouter, &witness.map(|(r, _)| r).transpose_array())?
            .try_into()
            .expect("exactly 32 bytes");
        let r = curve.from_canonical_compressed_bytes(
            layouter,
            &r_bytes,
            witness.map(|(r, _)| decompress_bytes(&r)),
        )?;

        // h = SHA-512(R_bytes || A_bytes || M), reduced into the scalar field.
        let sha_input = (r_bytes.into_iter())
            .chain(a_bytes)
            .chain(m_bytes)
            .collect::<Vec<_>>();
        let h_bytes = std_lib.sha2_512(layouter, &sha_input)?;
        let h = scalar_chip.assigned_from_le_bytes(layouter, &h_bytes)?;

        // R = s * B - h * A.
        let b = curve.assign_fixed(layouter, Curve25519Subgroup::generator())?;
        let neg_h = scalar_chip.neg(layouter, &h)?;
        let rhs = curve.msm(layouter, &[s, neg_h], &[b, a])?;

        curve.assert_equal(layouter, &r, &rhs)
    }

    fn used_chips(&self) -> ZkStdLibArch {
        ZkStdLibArch {
            curve25519: true,
            sha2_512: true,
            nr_pow2range_cols: 4,
            ..ZkStdLibArch::default()
        }
    }

    fn write_relation<W: std::io::Write>(&self, _writer: &mut W) -> std::io::Result<()> {
        Ok(())
    }

    fn read_relation<R: std::io::Read>(_reader: &mut R) -> std::io::Result<Self> {
        Ok(Ed25519Verify)
    }
}
