//! Schnorr signature verification over the native embedded curve JubJub,
//! ported faithfully from midnight-zk's `zk_stdlib/examples/schnorr_sig.rs`
//! (same scheme, same Poseidon challenge hash), so the numbers stay
//! comparable with upstream.
//!
//! This is the cheap native baseline of the recursion leg: Midnight
//! Passport's MIP-0013 device scheme is Schnorr over JubJub, so both the
//! direct cost and the wrapped (proof-of-proof) cost of this relation are
//! directly meaningful.
//!
//! The scheme (notation as in the upstream example):
//!
//! * keys: `sk` a JubJub scalar, `pk = sk * G`;
//! * signing: pick nonce `k`, set `R = k * G`,
//!   `e_bytes = Poseidon(pk.x, pk.y, R.x, R.y, m)` serialised to 32 LE
//!   bytes, and `s = k - e * sk` where `e` is `e_bytes` reduced into the
//!   JubJub scalar field;
//! * verification: recompute `R' = s * G + e * pk` and accept iff
//!   `Poseidon(pk.x, pk.y, R'.x, R'.y, m)` serialises to `e_bytes`.

use group::Group;
use midnight_circuits::{
    ecc::native::AssignedScalarOfNativeCurve,
    instructions::{
        AssertionInstructions, AssignmentInstructions, DecompositionInstructions, EccInstructions,
        PublicInputInstructions,
    },
    types::{AssignedNativePoint, Instantiable},
};
use midnight_curves::{Fr as JubjubScalar, JubjubExtended as Jubjub, JubjubSubgroup};
use midnight_proofs::{
    circuit::{Layouter, Value},
    plonk::Error,
};
use midnight_zk_stdlib::{Relation, ZkStdLib, ZkStdLibArch};

use crate::relations::F;

/// A Schnorr signature over JubJub, in the upstream example's shape: the
/// response scalar `s` and the 32 little-endian bytes of the Poseidon
/// challenge `e`.
#[derive(Clone, Debug, Default)]
pub struct JubjubSchnorrSignature {
    /// Response scalar `s = k - e * sk`.
    pub s: JubjubScalar,
    /// Little-endian bytes of the Poseidon challenge (a native field
    /// element).
    pub e_bytes: [u8; 32],
}

/// Schnorr verification over JubJub with the Poseidon challenge hash.
///
/// Instance: `(public key, message)` where the message is a native field
/// element. Witness: the signature `(s, e_bytes)`.
#[derive(Clone, Debug, Default)]
pub struct JubjubSchnorrVerify;

impl Relation for JubjubSchnorrVerify {
    type Instance = (JubjubSubgroup, F);

    type Witness = JubjubSchnorrSignature;

    type Error = Error;

    fn format_instance((pk, msg): &Self::Instance) -> Result<Vec<F>, Error> {
        Ok([
            AssignedNativePoint::<Jubjub>::as_public_input(pk),
            vec![*msg],
        ]
        .concat())
    }

    fn circuit(
        &self,
        std_lib: &ZkStdLib,
        layouter: &mut impl Layouter<F>,
        instance: Value<Self::Instance>,
        witness: Value<Self::Witness>,
    ) -> Result<(), Error> {
        let jubjub = std_lib.jubjub();

        // Assign public inputs.
        let (pk_val, m_val) = instance.unzip();
        let pk: AssignedNativePoint<Jubjub> = jubjub.assign_as_public_input(layouter, pk_val)?;
        let message = std_lib.assign_as_public_input(layouter, m_val)?;

        // Assign witness values.
        let (sig_s_val, sig_e_bytes_val) = witness.map(|sig| (sig.s, sig.e_bytes)).unzip();
        let sig_s: AssignedScalarOfNativeCurve<Jubjub> = jubjub.assign(layouter, sig_s_val)?;
        let sig_e_bytes = std_lib.assign_many(layouter, &sig_e_bytes_val.transpose_array())?;

        let generator: AssignedNativePoint<Jubjub> =
            jubjub.assign_fixed(layouter, <JubjubSubgroup as Group>::generator())?;

        let sig_e = jubjub.scalar_from_le_bytes(layouter, &sig_e_bytes)?;

        // 1. R' = s * G + e * pk.
        let rv = jubjub.msm(layouter, &[sig_s, sig_e], &[generator, pk.clone()])?;

        let coords = |p| (jubjub.x_coordinate(p), jubjub.y_coordinate(p));
        let (pkx, pky) = coords(&pk);
        let (rx, ry) = coords(&rv);

        // 2. e' = Poseidon(pk.x, pk.y, R'.x, R'.y, m), byte-compared with
        //    the witnessed challenge bytes.
        let h = std_lib.poseidon(layouter, &[pkx, pky, rx, ry, message])?;
        let ev_bytes = std_lib.assigned_to_le_bytes(layouter, &h, None)?;

        assert_eq!(ev_bytes.len(), sig_e_bytes.len());
        (ev_bytes.iter().zip(sig_e_bytes.iter()))
            .try_for_each(|(ev, e)| std_lib.assert_equal(layouter, ev, e))
    }

    fn used_chips(&self) -> ZkStdLibArch {
        ZkStdLibArch {
            jubjub: true,
            poseidon: true,
            ..ZkStdLibArch::default()
        }
    }

    fn write_relation<W: std::io::Write>(&self, _writer: &mut W) -> std::io::Result<()> {
        Ok(())
    }

    fn read_relation<R: std::io::Read>(_reader: &mut R) -> std::io::Result<Self> {
        Ok(JubjubSchnorrVerify)
    }
}
