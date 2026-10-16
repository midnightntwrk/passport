// Independent Rust entry points, preserving the reference argument order.
use crate::auth::{Auth, Preimage, Signature};
use crate::custody::{self, Change, Scalar, SentAndChange};
use crate::{ACCOUNT, Mutation};
use minocrab::Private;
use minocrab::v3::Circuit3;
use minocrab_std::v3::*;
pub struct DeviceCalls;
#[contract]
impl DeviceCalls {
    #[circuit]
    pub fn activate_initial_device_with_jubjub(
        c: &mut Circuit3,
        pk: JubjubPoint,
        salt: B32<Private>,
    ) -> Discloses<(Mutation,)> {
        let zero = c.constant(0u64).private();
        let a = Auth::Jubjub {
            pk,
            r: pk,
            s: zero,
            grind: Uint::from_field_unchecked(zero),
        };
        custody::activate(c, &a, salt);
        Discloses::of(())
    }
    #[circuit]
    pub fn append_inbox_with_jubjub(
        c: &mut Circuit3,
        entry: BytesN<Private, 192>,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        custody::gate(
            c,
            &a,
            use_counter,
            "append_inbox",
            Preimage::default().blob(&entry),
        );
        custody::append(c, &entry);
        Discloses::of(())
    }
    #[circuit]
    pub fn rotate_enc_key_with_jubjub(
        c: &mut Circuit3,
        new_key: B32<Private>,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        custody::gate(
            c,
            &a,
            use_counter,
            "rotate_enc_key",
            Preimage::default().bytes(new_key),
        );
        let key = new_key.disclose_as::<Mutation>(c);
        ACCOUNT.enc_key.write(c, &key);
        Discloses::of(())
    }
    #[circuit]
    pub fn add_device_with_jubjub(
        c: &mut Circuit3,
        new_entry: B32<Private>,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        custody::gate(
            c,
            &a,
            use_counter,
            "add_device",
            Preimage::default().bytes(new_entry),
        );
        custody::add_device(c, new_entry);
        Discloses::of(())
    }
    #[circuit]
    pub fn remove_device_with_jubjub(
        c: &mut Circuit3,
        entry: B32<Private>,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        custody::gate(
            c,
            &a,
            use_counter,
            "remove_device",
            Preimage::default().bytes(entry),
        );
        custody::remove_device(c, &a, use_counter, entry);
        Discloses::of(())
    }
    #[circuit]
    pub fn withdraw_unshielded_with_jubjub(
        c: &mut Circuit3,
        color: CoinColor<Private>,
        amount: Uint<128>,
        recipient: UserAddress<Private>,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        custody::gate(
            c,
            &a,
            use_counter,
            "withdraw_unshielded",
            Preimage::default()
                .bytes(color.bytes())
                .uint(amount.field(), 16)
                .bytes(recipient.bytes()),
        );
        custody::withdraw_unshielded(c, color, amount, recipient);
        Discloses::of(())
    }
    #[circuit(output = "reference shielded result")]
    pub fn withdraw_shielded_with_jubjub(
        c: &mut Circuit3,
        recipient: ZswapCoinPublicKey<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,), Change> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        let coin = custody::held_coin(c);
        custody::gate(
            c,
            &a,
            use_counter,
            "withdraw_shielded",
            Preimage::default()
                .bytes(recipient.bytes())
                .bytes(color.bytes())
                .uint(amount.field(), 16)
                .append(custody::coin_preimage(&coin)),
        );
        let result = custody::withdraw_shielded(c, coin, amount, recipient.bytes(), false);
        Discloses::of(result.change)
    }
    #[circuit(output = "reference shielded result")]
    pub fn withdraw_shielded_to_contract_with_jubjub(
        c: &mut Circuit3,
        recipient: ContractAddress<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,), SentAndChange> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        let coin = custody::held_coin(c);
        custody::gate(
            c,
            &a,
            use_counter,
            "withdraw_shielded_to_contract",
            Preimage::default()
                .bytes(recipient.bytes())
                .bytes(color.bytes())
                .uint(amount.field(), 16)
                .append(custody::coin_preimage(&coin)),
        );
        let result = custody::withdraw_shielded(c, coin, amount, recipient.bytes(), true);
        Discloses::of(SentAndChange(result.sent, result.change))
    }
    #[circuit]
    pub fn activate_initial_device_with_k256(
        c: &mut Circuit3,
        pk: Secp256k1Point,
        salt: B32<Private>,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,)> {
        let zero = c.constant(0u64).private();
        let bytes = c.into_bytes32(zero);
        let scalar = c.from_bytes32(bytes);
        let scalar = Secp256k1Scalar::from_scalar(scalar);
        let a = Auth::k256(
            c,
            pk,
            Signature {
                r: scalar,
                s: scalar,
            },
            envelope,
        );
        custody::activate(c, &a, salt);
        Discloses::of(())
    }
    #[circuit]
    pub fn append_inbox_with_k256(
        c: &mut Circuit3,
        entry: BytesN<Private, 192>,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::k256(c, pk, sig, envelope);
        custody::gate(
            c,
            &a,
            use_counter,
            "append_inbox",
            Preimage::default().blob(&entry),
        );
        custody::append(c, &entry);
        Discloses::of(())
    }
    #[circuit]
    pub fn rotate_enc_key_with_k256(
        c: &mut Circuit3,
        new_key: B32<Private>,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::k256(c, pk, sig, envelope);
        custody::gate(
            c,
            &a,
            use_counter,
            "rotate_enc_key",
            Preimage::default().bytes(new_key),
        );
        let key = new_key.disclose_as::<Mutation>(c);
        ACCOUNT.enc_key.write(c, &key);
        Discloses::of(())
    }
    #[circuit]
    pub fn add_device_with_k256(
        c: &mut Circuit3,
        new_entry: B32<Private>,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::k256(c, pk, sig, envelope);
        custody::gate(
            c,
            &a,
            use_counter,
            "add_device",
            Preimage::default().bytes(new_entry),
        );
        custody::add_device(c, new_entry);
        Discloses::of(())
    }
    #[circuit]
    pub fn remove_device_with_k256(
        c: &mut Circuit3,
        entry: B32<Private>,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::k256(c, pk, sig, envelope);
        custody::gate(
            c,
            &a,
            use_counter,
            "remove_device",
            Preimage::default().bytes(entry),
        );
        custody::remove_device(c, &a, use_counter, entry);
        Discloses::of(())
    }
    #[circuit]
    pub fn withdraw_unshielded_with_k256(
        c: &mut Circuit3,
        color: CoinColor<Private>,
        amount: Uint<128>,
        recipient: UserAddress<Private>,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::k256(c, pk, sig, envelope);
        custody::gate(
            c,
            &a,
            use_counter,
            "withdraw_unshielded",
            Preimage::default()
                .bytes(color.bytes())
                .uint(amount.field(), 16)
                .bytes(recipient.bytes()),
        );
        custody::withdraw_unshielded(c, color, amount, recipient);
        Discloses::of(())
    }
    #[circuit(output = "reference shielded result")]
    pub fn withdraw_shielded_with_k256(
        c: &mut Circuit3,
        recipient: ZswapCoinPublicKey<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,), Change> {
        let a = Auth::k256(c, pk, sig, envelope);
        let coin = custody::held_coin(c);
        custody::gate(
            c,
            &a,
            use_counter,
            "withdraw_shielded",
            Preimage::default()
                .bytes(recipient.bytes())
                .bytes(color.bytes())
                .uint(amount.field(), 16)
                .append(custody::coin_preimage(&coin)),
        );
        let result = custody::withdraw_shielded(c, coin, amount, recipient.bytes(), false);
        Discloses::of(result.change)
    }
    #[circuit(output = "reference shielded result")]
    pub fn withdraw_shielded_to_contract_with_k256(
        c: &mut Circuit3,
        recipient: ContractAddress<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,), SentAndChange> {
        let a = Auth::k256(c, pk, sig, envelope);
        let coin = custody::held_coin(c);
        custody::gate(
            c,
            &a,
            use_counter,
            "withdraw_shielded_to_contract",
            Preimage::default()
                .bytes(recipient.bytes())
                .bytes(color.bytes())
                .uint(amount.field(), 16)
                .append(custody::coin_preimage(&coin)),
        );
        let result = custody::withdraw_shielded(c, coin, amount, recipient.bytes(), true);
        Discloses::of(SentAndChange(result.sent, result.change))
    }
}
