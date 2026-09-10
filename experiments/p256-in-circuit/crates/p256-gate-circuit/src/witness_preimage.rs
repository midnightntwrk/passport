//! Witness-preimage relations: the cheapest realistic device statement of
//! the recursion leg. The account stores a hash commitment `c`; the device
//! holds a 32-byte secret `w` and proves knowledge of `w` with `H(w) = c`.
//! No signature is involved, so these relations bound the inner-proof cost
//! from below for any device scheme the wrapper can carry.
//!
//! Two commitment hashes are covered:
//!
//! * [`PoseidonPreimage`]: `H` is the proof system's native Poseidon hash.
//!   The 32 secret bytes are packed injectively into two field elements of
//!   16 little-endian bytes each, so the full 256 bits are preserved (a
//!   single BLS12-381 scalar holds fewer than 255 bits, hence fewer than
//!   32 bytes), and hashed with one Poseidon call.
//! * [`Sha256Preimage`]: `H` is SHA-256, mirroring the persistentHash
//!   commitment shape Midnight contracts already use for preimage
//!   authorisation. The digest is exposed as 32 public input bytes, the
//!   same shape as the P-256 relations' message hashes.
//!
//! Both commitments are deterministic and unsalted: binding, but hiding
//! only if the secret is unguessable. The secret MUST be uniformly random
//! 32 bytes (as a device-held secret is); a public commitment to a
//! lower-entropy preimage could be brute-forced offline, and would need a
//! salted variant (`H(w, salt)`) instead.

use ff::PrimeField;
use midnight_circuits::{
    instructions::{AssignmentInstructions, DecompositionInstructions, PublicInputInstructions},
    types::AssignedByte,
};
use midnight_proofs::{
    circuit::{Layouter, Value},
    plonk::Error,
};
use midnight_zk_stdlib::{Relation, ZkStdLib, ZkStdLibArch};

use crate::relations::{bytes_as_public_input, DIGEST_LEN, F};

/// Length in bytes of the device secret.
pub const SECRET_LEN: usize = 32;

/// Packs a 32-byte secret into two field elements of 16 little-endian bytes
/// each. The packing is injective: each half is below 2^128, far below the
/// field modulus, so distinct secrets yield distinct pairs. The off-circuit
/// commitment (`vectors::poseidon_commitment`) and the in-circuit
/// recomposition of [`PoseidonPreimage`] both go through this byte split,
/// so they agree by construction.
pub fn pack_secret(secret: &[u8; SECRET_LEN]) -> [F; 2] {
    let half = |bytes: &[u8]| {
        F::from_u128(u128::from_le_bytes(
            bytes.try_into().expect("half of the secret is 16 bytes"),
        ))
    };
    [
        half(&secret[..SECRET_LEN / 2]),
        half(&secret[SECRET_LEN / 2..]),
    ]
}

/// Knowledge of a Poseidon preimage.
///
/// Instance: the Poseidon commitment, one native field element. Witness:
/// the 32-byte secret.
#[derive(Clone, Debug, Default)]
pub struct PoseidonPreimage;

impl Relation for PoseidonPreimage {
    type Instance = F;

    type Witness = [u8; SECRET_LEN];

    type Error = Error;

    fn format_instance(commitment: &Self::Instance) -> Result<Vec<F>, Error> {
        Ok(vec![*commitment])
    }

    fn circuit(
        &self,
        std_lib: &ZkStdLib,
        layouter: &mut impl Layouter<F>,
        _instance: Value<Self::Instance>,
        witness: Value<Self::Witness>,
    ) -> Result<(), Error> {
        // Assign the 32 secret bytes as private witnesses.
        let secret: Vec<AssignedByte<F>> =
            std_lib.assign_many(layouter, &witness.transpose_array())?;

        // Pack them injectively into two field elements, 16 little-endian
        // bytes each; this matches [`pack_secret`] bit for bit.
        let lo = std_lib.assigned_from_le_bytes(layouter, &secret[..SECRET_LEN / 2])?;
        let hi = std_lib.assigned_from_le_bytes(layouter, &secret[SECRET_LEN / 2..])?;

        // Constrain Poseidon(lo, hi) to equal the public commitment.
        let h = std_lib.poseidon(layouter, &[lo, hi])?;
        std_lib.constrain_as_public_input(layouter, &h)
    }

    fn used_chips(&self) -> ZkStdLibArch {
        ZkStdLibArch {
            poseidon: true,
            ..ZkStdLibArch::default()
        }
    }

    fn write_relation<W: std::io::Write>(&self, _writer: &mut W) -> std::io::Result<()> {
        Ok(())
    }

    fn read_relation<R: std::io::Read>(_reader: &mut R) -> std::io::Result<Self> {
        Ok(PoseidonPreimage)
    }
}

/// Knowledge of a SHA-256 preimage.
///
/// Instance: the 32-byte SHA-256 digest, exposed as public input bytes.
/// Witness: the 32-byte secret.
#[derive(Clone, Debug, Default)]
pub struct Sha256Preimage;

impl Relation for Sha256Preimage {
    type Instance = [u8; DIGEST_LEN];

    type Witness = [u8; SECRET_LEN];

    type Error = Error;

    fn format_instance(digest: &Self::Instance) -> Result<Vec<F>, Error> {
        Ok(bytes_as_public_input(digest))
    }

    fn circuit(
        &self,
        std_lib: &ZkStdLib,
        layouter: &mut impl Layouter<F>,
        _instance: Value<Self::Instance>,
        witness: Value<Self::Witness>,
    ) -> Result<(), Error> {
        // Assign the 32 secret bytes as private witnesses.
        let secret: Vec<AssignedByte<F>> =
            std_lib.assign_many(layouter, &witness.transpose_array())?;

        // Constrain SHA-256(secret) to equal the public digest, byte by
        // byte.
        let digest = std_lib.sha2_256(layouter, &secret)?;
        digest
            .iter()
            .try_for_each(|byte| std_lib.constrain_as_public_input(layouter, byte))
    }

    fn used_chips(&self) -> ZkStdLibArch {
        ZkStdLibArch {
            sha2_256: true,
            ..ZkStdLibArch::default()
        }
    }

    fn write_relation<W: std::io::Write>(&self, _writer: &mut W) -> std::io::Result<()> {
        Ok(())
    }

    fn read_relation<R: std::io::Read>(_reader: &mut R) -> std::io::Result<Self> {
        Ok(Sha256Preimage)
    }
}
