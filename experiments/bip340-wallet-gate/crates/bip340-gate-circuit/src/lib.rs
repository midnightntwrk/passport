//! BIP-340 Schnorr (secp256k1) verification in a midnight-zk circuit, over
//! the exact message shape the Midnight wallet stack signs.
//!
//! The wallet's `signData` (ledger WASM, wallet SDK keystore, and the dApp
//! connector) produces a BIP-340 signature whose 32-byte message is the
//! plain SHA-256 of the payload (the k256 `RandomizedSigner` pre-hash,
//! `midnight-base-crypto` -> `k256::schnorr`). On the dApp-connector path
//! the payload is additionally prefixed with the ASCII string
//! `midnight_signed_message:<data_size>:` (normative: the connector
//! SPECIFICATION.md), so the signed message is
//! `SHA-256(prefix || payload)`.
//!
//! The relation here verifies exactly that, with the public interface an
//! account contract knows: the 32-byte x-only verifying key and the
//! 32-byte payload (the authorisation challenge). Ported from the ECDSA
//! relation pattern of `experiments/p256-in-circuit` (itself ported from
//! midnight-zk's `ethereum_signature.rs`), replacing the ECDSA equation
//! with BIP-340:
//!
//! 1. `P = lift_x(pk_x)`: the prover witnesses the full point; the circuit
//!    constrains it on-curve (assignment), binds its x-coordinate bytes to
//!    the public `pk_x`, and asserts its y-coordinate is even.
//! 2. `m = SHA-256(prefix || payload)` in-circuit.
//! 3. `e = int(SHA-256(tagH || tagH || r || pk_x || m)) mod n` in-circuit,
//!    where `tagH = SHA-256("BIP0340/challenge")`.
//! 4. `R = s * G - e * P`; assert `R` is not the identity, `R.y` is even,
//!    and the bytes of `R.x` equal the witnessed `r` (byte equality against
//!    the canonical reduced coordinate also enforces `r < p`).

use ff::PrimeField;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use midnight_circuits::{
    field::foreign::params::MultiEmulationParams,
    instructions::{
        ArithInstructions, AssertionInstructions, AssignmentInstructions,
        DecompositionInstructions, EccInstructions, PublicInputInstructions, ZeroInstructions,
    },
    types::{AssignedByte, AssignedField, AssignedForeignPoint, Instantiable},
};
use midnight_curves::k256::{Fp as K256Base, Fq as K256Scalar, K256Affine, K256};
use midnight_proofs::{
    circuit::{Layouter, Value},
    plonk::Error,
};
use midnight_zk_stdlib::{Relation, ZkStdLib, ZkStdLibArch};
use sha2::{Digest, Sha256};

/// The native field of the proof system (BLS12-381 scalar field).
pub type F = midnight_curves::Fq;

/// An assigned secp256k1 point, emulated over the native field.
pub type AssignedPoint = AssignedForeignPoint<F, K256, MultiEmulationParams>;

/// An assigned secp256k1 scalar-field element.
pub type AssignedScalar = AssignedField<F, K256Scalar, MultiEmulationParams>;

/// Length in bytes of a SHA-256 digest, an x-only key, and the payload.
pub const DIGEST_LEN: usize = 32;

/// The connector's mandatory signing prefix for a payload of `data_size`
/// bytes: `midnight_signed_message:<data_size>:` (dApp connector
/// SPECIFICATION.md, section "Signing").
pub fn connector_prefix(data_size: usize) -> Vec<u8> {
    format!("midnight_signed_message:{data_size}:").into_bytes()
}

/// `SHA-256("BIP0340/challenge")`, the BIP-340 tagged-hash key.
fn challenge_tag_hash() -> [u8; DIGEST_LEN] {
    Sha256::digest(b"BIP0340/challenge").into()
}

/// Converts a 32-byte digest (big-endian integer) into a secp256k1 scalar,
/// reducing modulo the group order `n` as BIP-340 specifies for the
/// challenge (`e = int(hash) mod n`).
fn digest_to_scalar(
    std_lib: &ZkStdLib,
    layouter: &mut impl Layouter<F>,
    digest: &[AssignedByte<F>],
) -> Result<AssignedScalar, Error> {
    let scalar_chip = std_lib.secp256k1().scalar_field_chip();
    let digest_bits = digest
        .iter()
        .map(|byte| std_lib.assigned_to_be_bits(layouter, &byte.clone().into(), Some(8), true))
        .collect::<Result<Vec<_>, Error>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    scalar_chip.assigned_from_be_bits(layouter, &digest_bits)
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

/// Public inputs for a byte array, in the order [`assign_public_bytes`]
/// constrains them.
pub fn bytes_as_public_input(bytes: &[u8]) -> Vec<F> {
    bytes
        .iter()
        .flat_map(AssignedByte::<F>::as_public_input)
        .collect()
}

/// Asserts that an assigned secp256k1 base-field coordinate is even, via the
/// lowest bit of its canonical little-endian byte decomposition.
fn assert_even_coordinate(
    std_lib: &ZkStdLib,
    layouter: &mut impl Layouter<F>,
    coordinate: &AssignedField<F, K256Base, MultiEmulationParams>,
) -> Result<(), Error> {
    let base_chip = std_lib.secp256k1().base_field_chip();
    let le_bytes = base_chip.assigned_to_le_bytes(layouter, coordinate, None)?;
    let low_bits =
        std_lib.assigned_to_be_bits(layouter, &le_bytes[0].clone().into(), Some(8), true)?;
    // Big-endian bit order: the least significant bit sits at position 7.
    std_lib.assert_equal_to_fixed(layouter, &low_bits[7], false)
}

/// Asserts byte-wise equality between a coordinate's canonical big-endian
/// bytes and an assigned 32-byte array.
fn assert_coordinate_equals_bytes(
    std_lib: &ZkStdLib,
    layouter: &mut impl Layouter<F>,
    coordinate: &AssignedField<F, K256Base, MultiEmulationParams>,
    be_bytes: &[AssignedByte<F>],
) -> Result<(), Error> {
    let base_chip = std_lib.secp256k1().base_field_chip();
    let le_bytes = base_chip.assigned_to_le_bytes(layouter, coordinate, None)?;
    for (le_byte, be_byte) in le_bytes.iter().zip(be_bytes.iter().rev()) {
        std_lib.assert_equal(layouter, le_byte, be_byte)?;
    }
    Ok(())
}

/// BIP-340 Schnorr verification over secp256k1, with the message computed
/// in-circuit as the wallet stack computes it.
///
/// Instance: `(32-byte x-only verifying key, 32-byte payload)`.
/// Witness: `(lifted public-key point, 32-byte r, scalar s)`.
///
/// `prefix` is the fixed byte string prepended to the payload before the
/// pre-hash: empty on the SDK/keystore path, and
/// `midnight_signed_message:<data_size>:` on the dApp-connector path.
#[derive(Clone, Debug, Default)]
pub struct Bip340WalletGate {
    prefix: Vec<u8>,
}

impl Bip340WalletGate {
    /// The SDK/keystore path: the wallet signs the raw payload (message is
    /// `SHA-256(payload)`).
    pub fn sdk() -> Self {
        Bip340WalletGate { prefix: Vec::new() }
    }

    /// The dApp-connector path: the wallet prepends the mandatory prefix
    /// for a payload of [`DIGEST_LEN`] bytes (message is
    /// `SHA-256("midnight_signed_message:32:" || payload)`).
    pub fn connector() -> Self {
        Bip340WalletGate {
            prefix: connector_prefix(DIGEST_LEN),
        }
    }

    /// The exact byte string signed on this path for `payload`.
    pub fn signed_bytes(&self, payload: &[u8; DIGEST_LEN]) -> Vec<u8> {
        let mut bytes = self.prefix.clone();
        bytes.extend_from_slice(payload);
        bytes
    }
}

impl Relation for Bip340WalletGate {
    type Instance = ([u8; DIGEST_LEN], [u8; DIGEST_LEN]);

    type Witness = (K256, [u8; DIGEST_LEN], K256Scalar);

    type Error = Error;

    fn format_instance((pk_x, payload): &Self::Instance) -> Result<Vec<F>, Error> {
        Ok(
            [bytes_as_public_input(pk_x), bytes_as_public_input(payload)]
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
        let curve = std_lib.secp256k1();
        let scalar_chip = curve.scalar_field_chip();

        let pk_x_bytes =
            assign_public_bytes(std_lib, layouter, instance.as_ref().map(|(pk_x, _)| *pk_x))?;
        let payload_bytes =
            assign_public_bytes(std_lib, layouter, instance.map(|(_, payload)| payload))?;

        // Witness the lifted key point. Assignment constrains it on-curve
        // (secp256k1 has cofactor 1, so on-curve implies prime order); the
        // two constraints below bind it to the x-only public key: x equals
        // pk_x, y is even, which is exactly BIP-340 `lift_x`.
        let pk_point = curve.assign(layouter, witness.as_ref().map(|(p, _, _)| *p))?;
        assert_coordinate_equals_bytes(
            std_lib,
            layouter,
            &curve.x_coordinate(&pk_point),
            &pk_x_bytes,
        )?;
        assert_even_coordinate(std_lib, layouter, &curve.y_coordinate(&pk_point))?;

        // Witness the signature: r as bytes (it is compared, and hashed,
        // as bytes), s as a scalar (assignment enforces s < n, the BIP-340
        // range check on s).
        let r_bytes: Vec<AssignedByte<F>> = std_lib.assign_many(
            layouter,
            &witness.as_ref().map(|(_, r, _)| *r).transpose_array(),
        )?;
        let s = scalar_chip.assign(layouter, witness.map(|(_, _, s)| s))?;

        // m = SHA-256(prefix || payload): the k256 RandomizedSigner
        // pre-hash over the (possibly connector-prefixed) payload.
        let prefix_bytes: Vec<AssignedByte<F>> =
            std_lib.assign_many_fixed(layouter, &self.prefix)?;
        let message_input = prefix_bytes
            .into_iter()
            .chain(payload_bytes)
            .collect::<Vec<_>>();
        let m = std_lib.sha2_256(layouter, &message_input)?;

        // e = int(SHA-256(tagH || tagH || r || pk_x || m)) mod n.
        let tag_hash: Vec<AssignedByte<F>> =
            std_lib.assign_many_fixed(layouter, &challenge_tag_hash())?;
        let challenge_input = tag_hash
            .iter()
            .chain(tag_hash.iter())
            .chain(r_bytes.iter())
            .chain(pk_x_bytes.iter())
            .chain(m.iter())
            .cloned()
            .collect::<Vec<_>>();
        let e_bytes = std_lib.sha2_256(layouter, &challenge_input)?;
        let e = digest_to_scalar(std_lib, layouter, &e_bytes)?;
        let e_neg = scalar_chip.neg(layouter, &e)?;

        // R = s * G - e * P, via the bit-based MSM (no GLV path).
        let gen = curve.assign_fixed(layouter, K256::generator())?;
        let s_bits = scalar_chip.assigned_to_le_bits(layouter, &s, None, true)?;
        let e_neg_bits = scalar_chip.assigned_to_le_bits(layouter, &e_neg, None, true)?;
        let r_point = curve.msm_by_le_bits(layouter, &[s_bits, e_neg_bits], &[gen, pk_point])?;

        // BIP-340 acceptance: R is not the identity, R.y is even, R.x == r.
        curve.assert_non_zero(layouter, &r_point)?;
        assert_even_coordinate(std_lib, layouter, &curve.y_coordinate(&r_point))?;
        assert_coordinate_equals_bytes(std_lib, layouter, &curve.x_coordinate(&r_point), &r_bytes)
    }

    fn used_chips(&self) -> ZkStdLibArch {
        ZkStdLibArch {
            secp256k1: true,
            sha2_256: true,
            nr_pow2range_cols: 4,
            ..ZkStdLibArch::default()
        }
    }

    fn write_relation<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        let len = u32::try_from(self.prefix.len()).expect("prefix fits in u32");
        writer.write_all(&len.to_le_bytes())?;
        writer.write_all(&self.prefix)
    }

    fn read_relation<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut len_bytes = [0u8; 4];
        reader.read_exact(&mut len_bytes)?;
        let mut prefix = vec![0u8; u32::from_le_bytes(len_bytes) as usize];
        reader.read_exact(&mut prefix)?;
        Ok(Bip340WalletGate { prefix })
    }
}

/// Lifts a 32-byte x-only key to the even-y point on secp256k1, as BIP-340
/// `lift_x`. Returns `None` for an invalid x-coordinate.
pub fn lift_x_even(pk_x: &[u8; DIGEST_LEN]) -> Option<K256> {
    let vk = k256::schnorr::VerifyingKey::from_bytes(pk_x).ok()?;
    let encoded = vk.as_affine().to_encoded_point(false);
    let x = K256Base::from_bytes(encoded.x()?).into_option()?;
    let y = K256Base::from_bytes(encoded.y()?).into_option()?;
    K256Affine::from_xy(x, y).map(K256::from)
}

/// Parses a secp256k1 scalar from 32 big-endian bytes; `None` if the value
/// is not canonical (`>= n`), which BIP-340 rejects for `s`.
pub fn scalar_from_be_bytes(bytes: &[u8; DIGEST_LEN]) -> Option<K256Scalar> {
    K256Scalar::from_repr((*bytes).into()).into_option()
}
