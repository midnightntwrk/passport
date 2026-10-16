//! Adversarial checks for the exact released backend versions in ecc-validation.md.
#[cfg(test)]
mod tests {
    use ff::Field;
    use group::{cofactor::CofactorGroup, Group};
    use midnight_circuits::{
        ecc::curves::CircuitCurve,
        instructions::{AssignmentInstructions, EccInstructions, PublicInputInstructions},
        types::{AssignedNativePoint, Instantiable},
    };
    use midnight_curves::{Bls12, Fq as F, JubjubExtended, JubjubSubgroup};
    use midnight_proofs::{
        circuit::{Layouter, Value},
        dev::MockProver,
        plonk::Error,
        poly::kzg::params::ParamsKZG,
    };
    use midnight_zk_stdlib::{MidnightCircuit, Relation, ZkStdLib, ZkStdLibArch};

    #[derive(Clone, Default)]
    struct Coordinates;
    impl Relation for Coordinates {
        type Instance = (F, F);
        type Witness = (F, F);
        type Error = Error;
        fn format_instance(p: &Self::Instance) -> Result<Vec<F>, Error> {
            Ok(vec![p.0, p.1])
        }
        fn circuit(
            &self,
            std: &ZkStdLib,
            l: &mut impl Layouter<F>,
            _: Value<Self::Instance>,
            w: Value<Self::Witness>,
        ) -> Result<(), Error> {
            let (x, y) = w.unzip();
            let x = std.assign(l, x)?;
            let y = std.assign(l, y)?;
            let p = std.jubjub().point_from_coordinates(l, &x, &y)?;
            std.jubjub().constrain_as_public_input(l, &p)
        }
        fn used_chips(&self) -> ZkStdLibArch {
            ZkStdLibArch {
                jubjub: true,
                ..Default::default()
            }
        }
        fn write_relation<W: std::io::Write>(&self, _: &mut W) -> std::io::Result<()> {
            Ok(())
        }
        fn read_relation<R: std::io::Read>(_: &mut R) -> std::io::Result<Self> {
            Ok(Self)
        }
    }
    #[derive(Clone, Default)]
    struct RawAssignment;
    impl Relation for RawAssignment {
        type Instance = (F, F);
        type Witness = JubjubSubgroup;
        type Error = Error;
        fn format_instance(p: &Self::Instance) -> Result<Vec<F>, Error> {
            Ok(vec![p.0, p.1])
        }
        fn circuit(
            &self,
            std: &ZkStdLib,
            l: &mut impl Layouter<F>,
            _: Value<Self::Instance>,
            w: Value<Self::Witness>,
        ) -> Result<(), Error> {
            let p: AssignedNativePoint<JubjubExtended> = std.jubjub().assign(l, w)?;
            std.jubjub().constrain_as_public_input(l, &p)
        }
        fn used_chips(&self) -> ZkStdLibArch {
            Coordinates.used_chips()
        }
        fn write_relation<W: std::io::Write>(&self, _: &mut W) -> std::io::Result<()> {
            Ok(())
        }
        fn read_relation<R: std::io::Read>(_: &mut R) -> std::io::Result<Self> {
            Ok(Self)
        }
    }
    fn coords(p: JubjubSubgroup) -> (F, F) {
        <JubjubExtended as CircuitCurve>::coordinates(&p.into()).unwrap()
    }
    fn mock_coordinates(p: (F, F)) -> bool {
        let c = MidnightCircuit::new(&Coordinates, Value::known(p), Value::known(p), Some(11));
        MockProver::run(&c, vec![vec![], vec![p.0, p.1]])
            .unwrap()
            .verify()
            .is_ok()
    }
    #[test]
    fn altered_x_decodes_but_coordinate_constraints_reject() {
        let p = JubjubSubgroup::generator();
        let (x, y) = coords(p);
        let altered = (x + F::from(2), y);
        assert_eq!(
            AssignedNativePoint::<JubjubExtended>::from_public_input(&[altered.0, altered.1]),
            Some(p)
        );
        assert!(mock_coordinates((x, y)));
        assert!(!mock_coordinates(altered));
        println!("valid coordinates pass; x+2 decodes to original point but MockProver rejects");
    }
    #[test]
    fn identity_is_valid_generic_point() {
        assert!(mock_coordinates((F::ZERO, F::ONE)));
    }
    #[test]
    fn torsion_and_mixed_torsion_do_not_satisfy_subgroup_assignment() {
        let torsion = <JubjubExtended as CircuitCurve>::from_xy(F::ZERO, -F::ONE).unwrap();
        assert!(!bool::from(torsion.is_torsion_free()));
        let mixed = torsion + JubjubExtended::from(JubjubSubgroup::generator());
        for p in [torsion, mixed] {
            assert!(bool::from(
                <JubjubExtended as CofactorGroup>::into_subgroup(p).is_none()
            ));
            let xy = <JubjubExtended as CircuitCurve>::coordinates(&p).unwrap();
            // Forge the Rust subgroup wrapper deliberately: type safety must not replace constraints.
            let forged = JubjubSubgroup::from_raw_unchecked(xy.0, xy.1);
            let c = MidnightCircuit::new(
                &RawAssignment,
                Value::known(xy),
                Value::known(forged),
                Some(11),
            );
            assert!(MockProver::run(&c, vec![vec![], vec![xy.0, xy.1]])
                .unwrap()
                .verify()
                .is_err());
            assert!(std::panic::catch_unwind(|| mock_coordinates(xy)).is_err());
        }
        println!(
            "torsion and mixed torsion fail subgroup constraints; coordinate synthesis panics"
        );
    }
    #[test]
    fn full_proof_valid_control_and_altered_x() {
        let xy = coords(JubjubSubgroup::generator());
        let altered = (xy.0 + F::from(2), xy.1);
        // Test-only local setup, never production parameters.
        let params = ParamsKZG::<Bls12>::unsafe_setup(11, rand::rngs::OsRng);
        let vk = midnight_zk_stdlib::setup_vk(&params, &Coordinates);
        let pk = midnight_zk_stdlib::setup_pk(&Coordinates, &vk);
        let proof = midnight_zk_stdlib::prove::<Coordinates, blake2b_simd::State>(
            &params,
            &pk,
            &Coordinates,
            &xy,
            xy,
            rand::rngs::OsRng,
        )
        .unwrap();
        midnight_zk_stdlib::verify::<Coordinates, blake2b_simd::State>(
            &params.verifier_params(),
            &vk,
            &xy,
            None,
            &proof,
        )
        .unwrap();
        match midnight_zk_stdlib::prove::<Coordinates, blake2b_simd::State>(
            &params,
            &pk,
            &Coordinates,
            &altered,
            altered,
            rand::rngs::OsRng,
        ) {
            Ok(proof) => {
                assert!(
                    midnight_zk_stdlib::verify::<Coordinates, blake2b_simd::State>(
                        &params.verifier_params(),
                        &vk,
                        &altered,
                        None,
                        &proof
                    )
                    .is_err()
                );
                println!("valid proof verifies; altered-x proof bytes are produced but verification rejects");
            }
            Err(_) => println!("valid proof verifies; altered-x proof generation rejects"),
        }
    }

    #[test]
    fn verification_key_reader_leaves_trailing_bytes() {
        let params = ParamsKZG::<Bls12>::unsafe_setup(11, rand::rngs::OsRng);
        let vk = midnight_zk_stdlib::setup_vk(&params, &Coordinates);
        let mut bytes = Vec::new();
        vk.write(&mut bytes, midnight_proofs::utils::SerdeFormat::Processed)
            .unwrap();
        bytes.push(0x42);
        let mut reader = bytes.as_slice();
        midnight_zk_stdlib::MidnightVK::read(
            &mut reader,
            midnight_proofs::utils::SerdeFormat::Processed,
        )
        .unwrap();
        assert_eq!(reader, &[0x42]);
    }
}
