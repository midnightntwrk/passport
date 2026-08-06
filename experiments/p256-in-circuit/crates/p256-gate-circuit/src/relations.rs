//! The three P-256 ECDSA `Relation` implementations, ported from
//! midnight-zk's `zk_stdlib/examples/ethereum_signature.rs` (secp256k1 with
//! in-circuit Keccak) to P-256 with SHA-256.

use group::Group;
use midnight_circuits::{
    field::foreign::params::MultiEmulationParams,
    instructions::{
        ArithInstructions, AssertionInstructions, AssignmentInstructions,
        DecompositionInstructions, EccInstructions, PublicInputInstructions, ZeroInstructions,
    },
    types::{AssignedByte, AssignedField, AssignedForeignPoint, Instantiable},
};
use midnight_curves::p256::{Fq as P256Scalar, P256};
use midnight_proofs::{
    circuit::{Layouter, Value},
    plonk::Error,
};
use midnight_zk_stdlib::{Relation, ZkStdLib, ZkStdLibArch};

/// The native field of the proof system (BLS12-381 scalar field).
pub type F = midnight_curves::Fq;

/// An assigned P-256 point, emulated over the native field.
pub type AssignedPoint = AssignedForeignPoint<F, P256, MultiEmulationParams>;

/// An assigned P-256 scalar-field element, emulated over the native field.
pub type AssignedScalar = AssignedField<F, P256Scalar, MultiEmulationParams>;

/// Length in bytes of the WebAuthn `authenticatorData` structure when no
/// attested credential data and no extensions are present:
/// 32 (rpIdHash) + 1 (flags) + 4 (signCount).
pub const AUTHENTICATOR_DATA_LEN: usize = 37;

/// Length in bytes of a SHA-256 digest.
pub const DIGEST_LEN: usize = 32;

/// Converts a 32-byte SHA-256 digest (big-endian integer) into a P-256
/// scalar. The conversion reduces modulo the group order `n`, which matches
/// the ECDSA specification: `z = int(hash) mod n` (SEC 1 truncates to the
/// bit length of `n`, which is 256 for P-256, then reduces).
fn digest_to_scalar(
    std_lib: &ZkStdLib,
    layouter: &mut impl Layouter<F>,
    digest: &[AssignedByte<F>],
) -> Result<AssignedScalar, Error> {
    let scalar_chip = std_lib.p256().scalar_field_chip();
    let digest_bits = digest
        .iter()
        .map(|byte| std_lib.assigned_to_be_bits(layouter, &byte.clone().into(), Some(8), true))
        .collect::<Result<Vec<_>, Error>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    scalar_chip.assigned_from_be_bits(layouter, &digest_bits)
}

/// Shared ECDSA verification body: asserts that `(r, s)` is a valid ECDSA
/// signature for public key `pk` over the (already reduced) message scalar
/// `z`.
///
/// Constraints:
/// 1. `r != 0` and `s != 0` (the templates omit this; the ECDSA spec does
///    not, so we enforce it).
/// 2. `R = (z * s^{-1}) * G + (r * s^{-1}) * pk` is not the identity.
/// 3. `R.x mod n == r` (the mod-n reduction on recomposition is intended,
///    per the ECDSA spec).
fn ecdsa_assert_valid(
    std_lib: &ZkStdLib,
    layouter: &mut impl Layouter<F>,
    pk: &AssignedPoint,
    z: &AssignedScalar,
    r: &AssignedScalar,
    s: &AssignedScalar,
) -> Result<(), Error> {
    let curve = std_lib.p256();
    let scalar_chip = curve.scalar_field_chip();
    let base_chip = curve.base_field_chip();

    scalar_chip.assert_non_zero(layouter, r)?;
    scalar_chip.assert_non_zero(layouter, s)?;

    // `inv` makes the circuit unsatisfiable if s = 0, which is also asserted
    // separately above.
    let s_inv = scalar_chip.inv(layouter, s)?;
    let u1 = scalar_chip.mul(layouter, z, &s_inv, None)?;
    let u2 = scalar_chip.mul(layouter, r, &s_inv, None)?;

    let gen = curve.assign_fixed(layouter, P256::generator())?;
    let u1_bits = scalar_chip.assigned_to_le_bits(layouter, &u1, None, true)?;
    let u2_bits = scalar_chip.assigned_to_le_bits(layouter, &u2, None, true)?;

    // R = u1 * G + u2 * pk. `msm_by_le_bits` is bit-based (double-and-add
    // with windows); it never touches the GLV/endomorphism code path, which
    // is unimplemented for P-256 upstream.
    let r_point = curve.msm_by_le_bits(layouter, &[u1_bits, u2_bits], &[gen, pk.clone()])?;

    // 1. R must not be the identity.
    curve.assert_non_zero(layouter, &r_point)?;

    // 2. R.x (a base-field element), reduced mod n, must equal r.
    let r_point_x = curve.x_coordinate(&r_point);
    let r_point_x_bytes = base_chip.assigned_to_le_bytes(layouter, &r_point_x, None)?;
    let r_point_x_scalar = scalar_chip.assigned_from_le_bytes(layouter, &r_point_x_bytes)?;
    scalar_chip.assert_equal(layouter, &r_point_x_scalar, r)
}

/// Assigns an array of instance bytes and constrains them as public inputs.
fn assign_public_bytes<const N: usize>(
    std_lib: &ZkStdLib,
    layouter: &mut impl Layouter<F>,
    bytes: Value<[u8; N]>,
) -> Result<Vec<AssignedByte<F>>, Error> {
    let assigned: Vec<AssignedByte<F>> = std_lib.assign_many(layouter, &bytes.transpose_array())?;
    assigned
        .iter()
        .try_for_each(|byte| std_lib.constrain_as_public_input(layouter, byte))?;
    Ok(assigned)
}

/// Public inputs for a byte array, in the same order as
/// [`assign_public_bytes`] constrains them.
fn bytes_as_public_input(bytes: &[u8]) -> Vec<F> {
    bytes
        .iter()
        .flat_map(AssignedByte::<F>::as_public_input)
        .collect()
}

/// ECDSA over P-256 with a pre-hashed message.
///
/// Instance: `(public key, 32-byte message hash)`. Witness: `(r, s)`.
#[derive(Clone, Debug, Default)]
pub struct P256EcdsaPreHashed;

impl Relation for P256EcdsaPreHashed {
    type Instance = (P256, [u8; DIGEST_LEN]);

    type Witness = (P256Scalar, P256Scalar);

    type Error = Error;

    fn format_instance((pk, hash): &Self::Instance) -> Result<Vec<F>, Error> {
        Ok([
            AssignedPoint::as_public_input(pk),
            bytes_as_public_input(hash),
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

        let pk = curve.assign_as_public_input(layouter, instance.as_ref().map(|(pk, _)| *pk))?;
        let hash_bytes = assign_public_bytes(std_lib, layouter, instance.map(|(_, hash)| hash))?;

        let (r_val, s_val) = witness.unzip();
        let r = scalar_chip.assign(layouter, r_val)?;
        let s = scalar_chip.assign(layouter, s_val)?;

        let z = digest_to_scalar(std_lib, layouter, &hash_bytes)?;
        ecdsa_assert_valid(std_lib, layouter, &pk, &z, &r, &s)
    }

    fn used_chips(&self) -> ZkStdLibArch {
        ZkStdLibArch {
            p256: true,
            nr_pow2range_cols: 4,
            ..ZkStdLibArch::default()
        }
    }

    fn write_relation<W: std::io::Write>(&self, _writer: &mut W) -> std::io::Result<()> {
        Ok(())
    }

    fn read_relation<R: std::io::Read>(_reader: &mut R) -> std::io::Result<Self> {
        Ok(P256EcdsaPreHashed)
    }
}

/// ECDSA over P-256 with the WebAuthn assertion message computed in-circuit:
/// `z = SHA-256(authenticator_data || client_data_hash)`.
///
/// Instance: `(public key, 37-byte authenticator data, 32-byte client data
/// hash)`. Witness: `(r, s)`.
///
/// The 69-byte concatenation is exactly what a WebAuthn authenticator signs
/// for an assertion without extensions (Web Authentication Level 2,
/// section 6.3.3).
#[derive(Clone, Debug, Default)]
pub struct P256EcdsaWebAuthn;

impl Relation for P256EcdsaWebAuthn {
    type Instance = (P256, [u8; AUTHENTICATOR_DATA_LEN], [u8; DIGEST_LEN]);

    type Witness = (P256Scalar, P256Scalar);

    type Error = Error;

    fn format_instance((pk, auth_data, cd_hash): &Self::Instance) -> Result<Vec<F>, Error> {
        Ok([
            AssignedPoint::as_public_input(pk),
            bytes_as_public_input(auth_data),
            bytes_as_public_input(cd_hash),
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

        let pk = curve.assign_as_public_input(layouter, instance.as_ref().map(|(pk, _, _)| *pk))?;
        let auth_data_bytes = assign_public_bytes(
            std_lib,
            layouter,
            instance.as_ref().map(|(_, auth_data, _)| *auth_data),
        )?;
        let cd_hash_bytes =
            assign_public_bytes(std_lib, layouter, instance.map(|(_, _, cd_hash)| cd_hash))?;

        let (r_val, s_val) = witness.unzip();
        let r = scalar_chip.assign(layouter, r_val)?;
        let s = scalar_chip.assign(layouter, s_val)?;

        // The signed message: authenticator_data || client_data_hash.
        let sha_input = (auth_data_bytes.into_iter())
            .chain(cd_hash_bytes)
            .collect::<Vec<_>>();
        let digest = std_lib.sha2_256(layouter, &sha_input)?;

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

    fn write_relation<W: std::io::Write>(&self, _writer: &mut W) -> std::io::Result<()> {
        Ok(())
    }

    fn read_relation<R: std::io::Read>(_reader: &mut R) -> std::io::Result<Self> {
        Ok(P256EcdsaWebAuthn)
    }
}

/// ECDSA over P-256 with a private public key.
///
/// Instance: `(32-byte message hash)` only. Witness: `(pk, r, s)`.
///
/// The public key is assigned as a witness: the chip still constrains it to
/// be a point on the curve (P-256 has cofactor 1, so on-curve implies in the
/// prime-order subgroup). This relation measures the marginal cost of taking
/// the public key as a witness; standalone it proves nothing about who
/// signed, since a prover can satisfy it for any public hash with a freshly
/// generated keypair. A real deployment must additionally bind the witnessed
/// key to a public commitment or a set-membership proof.
#[derive(Clone, Debug, Default)]
pub struct P256EcdsaPrivatePk;

impl Relation for P256EcdsaPrivatePk {
    type Instance = [u8; DIGEST_LEN];

    type Witness = (P256, P256Scalar, P256Scalar);

    type Error = Error;

    fn format_instance(hash: &Self::Instance) -> Result<Vec<F>, Error> {
        Ok(bytes_as_public_input(hash))
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

        let hash_bytes = assign_public_bytes(std_lib, layouter, instance)?;

        // Witness assignment: `assign` (unlike `assign_as_public_input`)
        // keeps the point private but still constrains it on-curve.
        let pk = curve.assign(layouter, witness.as_ref().map(|(pk, _, _)| *pk))?;
        let r = scalar_chip.assign(layouter, witness.as_ref().map(|(_, r, _)| *r))?;
        let s = scalar_chip.assign(layouter, witness.map(|(_, _, s)| s))?;

        let z = digest_to_scalar(std_lib, layouter, &hash_bytes)?;
        ecdsa_assert_valid(std_lib, layouter, &pk, &z, &r, &s)
    }

    fn used_chips(&self) -> ZkStdLibArch {
        ZkStdLibArch {
            p256: true,
            nr_pow2range_cols: 4,
            ..ZkStdLibArch::default()
        }
    }

    fn write_relation<W: std::io::Write>(&self, _writer: &mut W) -> std::io::Result<()> {
        Ok(())
    }

    fn read_relation<R: std::io::Read>(_reader: &mut R) -> std::io::Result<Self> {
        Ok(P256EcdsaPrivatePk)
    }
}
