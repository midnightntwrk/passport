use crate::Mutation;
use crate::auth::{Auth, Preimage, Signature};
use crate::custody::{self, Change, Scalar, SentAndChange};
use crate::grants::{self, ScopeInput, SpendOpening};
use minocrab::Private;
use minocrab::v3::Circuit3;
use minocrab_std::v3::*;
pub struct GrantCalls;
#[contract]
impl GrantCalls {
    #[circuit]
    pub fn issue_grant_with_jubjub(
        c: &mut Circuit3,
        grant_id: B32<Private>,
        scope: ScopeInput,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,)> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        let digest = scope.digest(c);
        let args = Preimage::default().bytes(grant_id).bytes(digest);
        custody::gate(c, &a, use_counter, "issue_grant", args);
        grants::issue(c, grant_id, scope);
        Discloses::of(())
    }
    #[circuit]
    pub fn revoke_grant_with_jubjub(
        c: &mut Circuit3,
        grant_id: B32<Private>,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,)> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        let args = Preimage::default().bytes(grant_id);
        custody::gate(c, &a, use_counter, "revoke_grant", args);
        grants::revoke(c, grant_id);
        Discloses::of(())
    }
    #[circuit]
    pub fn revoke_all_grants_with_jubjub(
        c: &mut Circuit3,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,)> {
        let a = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        let args = Preimage::default();
        custody::gate(c, &a, use_counter, "revoke_all_grants", args);
        grants::revoke_all(c);
        Discloses::of(())
    }
    #[circuit]
    pub fn withdraw_unshielded_with_grant_jubjub(
        c: &mut Circuit3,
        color: CoinColor<Private>,
        amount: Uint<128>,
        recipient: UserAddress<Private>,
        pk: JubjubPoint,
        origin_hash: B32<Private>,
        slot: Uint<8>,
        opening: SpendOpening,
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
        let (id, g) = grants::authenticate(c, &a, origin_hash, slot);
        let new_spent = grants::check_scope(
            c,
            &g,
            g.scope.op_withdraw_unshielded,
            &opening,
            color.bytes(),
            amount,
            recipient.bytes(),
            1,
        );
        let args = Preimage::default()
            .bytes(id.private())
            .uint(g.issued_at.field().private(), 8)
            .bytes(color.bytes())
            .uint(amount.field(), 16)
            .bytes(recipient.bytes());
        let challenge = a.challenge(
            c,
            "withdraw_unshielded",
            true,
            args,
            g.nonce.field().private(),
        );
        grants::settle(c, &a, id, g, challenge, opening.salt, new_spent);
        custody::withdraw_unshielded(c, color, amount, recipient);
        Discloses::of(())
    }
    #[circuit(output = "reference shielded result")]
    pub fn withdraw_shielded_with_grant_jubjub(
        c: &mut Circuit3,
        recipient: ZswapCoinPublicKey<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        change_entry: BytesN<Private, 192>,
        enc_pk: B32<Private>,
        pk: JubjubPoint,
        origin_hash: B32<Private>,
        slot: Uint<8>,
        opening: SpendOpening,
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
        let (id, g) = grants::authenticate(c, &a, origin_hash, slot);
        let new_spent = grants::check_scope(
            c,
            &g,
            g.scope.op_withdraw_shielded,
            &opening,
            coin.color.bytes(),
            amount,
            recipient.bytes(),
            2,
        );
        grants::shielded_bounds(c, &coin, opening.max_coin_value, enc_pk);
        let args = Preimage::default()
            .bytes(id.private())
            .uint(g.issued_at.field().private(), 8)
            .bytes(recipient.bytes())
            .bytes(color.bytes())
            .uint(amount.field(), 16)
            .blob(&change_entry)
            .bytes(enc_pk)
            .append(custody::coin_preimage(&coin));
        let challenge = a.challenge(
            c,
            "withdraw_shielded",
            true,
            args,
            g.nonce.field().private(),
        );
        grants::settle(c, &a, id, g, challenge, opening.salt, new_spent);
        let result = custody::withdraw_shielded(c, coin, amount, recipient.bytes(), false);
        c.when(result.change.is_some.field(), |c| {
            custody::append(c, &change_entry)
        });
        Discloses::of(result.change)
    }
    #[circuit(output = "reference shielded result")]
    pub fn withdraw_shielded_to_contract_with_grant_jubjub(
        c: &mut Circuit3,
        recipient: ContractAddress<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        change_entry: BytesN<Private, 192>,
        enc_pk: B32<Private>,
        pk: JubjubPoint,
        origin_hash: B32<Private>,
        slot: Uint<8>,
        opening: SpendOpening,
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
        let (id, g) = grants::authenticate(c, &a, origin_hash, slot);
        let new_spent = grants::check_scope(
            c,
            &g,
            g.scope.op_withdraw_shielded_to_contract,
            &opening,
            coin.color.bytes(),
            amount,
            recipient.bytes(),
            3,
        );
        grants::shielded_bounds(c, &coin, opening.max_coin_value, enc_pk);
        let args = Preimage::default()
            .bytes(id.private())
            .uint(g.issued_at.field().private(), 8)
            .bytes(recipient.bytes())
            .bytes(color.bytes())
            .uint(amount.field(), 16)
            .blob(&change_entry)
            .bytes(enc_pk)
            .append(custody::coin_preimage(&coin));
        let challenge = a.challenge(
            c,
            "withdraw_shielded_to_contract",
            true,
            args,
            g.nonce.field().private(),
        );
        grants::settle(c, &a, id, g, challenge, opening.salt, new_spent);
        let result = custody::withdraw_shielded(c, coin, amount, recipient.bytes(), true);
        c.when(result.change.is_some.field(), |c| {
            custody::append(c, &change_entry)
        });
        Discloses::of(SentAndChange(result.sent, result.change))
    }
    #[circuit]
    pub fn issue_grant_with_k256(
        c: &mut Circuit3,
        grant_id: B32<Private>,
        scope: ScopeInput,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,)> {
        let a = Auth::k256(c, pk, sig, envelope);
        let digest = scope.digest(c);
        let args = Preimage::default().bytes(grant_id).bytes(digest);
        custody::gate(c, &a, use_counter, "issue_grant", args);
        grants::issue(c, grant_id, scope);
        Discloses::of(())
    }
    #[circuit]
    pub fn revoke_grant_with_k256(
        c: &mut Circuit3,
        grant_id: B32<Private>,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,)> {
        let a = Auth::k256(c, pk, sig, envelope);
        let args = Preimage::default().bytes(grant_id);
        custody::gate(c, &a, use_counter, "revoke_grant", args);
        grants::revoke(c, grant_id);
        Discloses::of(())
    }
    #[circuit]
    pub fn revoke_all_grants_with_k256(
        c: &mut Circuit3,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,)> {
        let a = Auth::k256(c, pk, sig, envelope);
        let args = Preimage::default();
        custody::gate(c, &a, use_counter, "revoke_all_grants", args);
        grants::revoke_all(c);
        Discloses::of(())
    }
    #[circuit(max_k = 16)]
    pub fn withdraw_unshielded_with_grant_k256(
        c: &mut Circuit3,
        color: CoinColor<Private>,
        amount: Uint<128>,
        recipient: UserAddress<Private>,
        pk: Secp256k1Point,
        envelope: Uint<8>,
        origin_hash: B32<Private>,
        slot: Uint<8>,
        opening: SpendOpening,
        sig: Signature,
    ) -> Discloses<(Mutation,), ()> {
        let a = Auth::k256(c, pk, sig, envelope);
        let (id, g) = grants::authenticate(c, &a, origin_hash, slot);
        let new_spent = grants::check_scope(
            c,
            &g,
            g.scope.op_withdraw_unshielded,
            &opening,
            color.bytes(),
            amount,
            recipient.bytes(),
            1,
        );
        let args = Preimage::default()
            .bytes(id.private())
            .uint(g.issued_at.field().private(), 8)
            .bytes(color.bytes())
            .uint(amount.field(), 16)
            .bytes(recipient.bytes());
        let challenge = a.challenge(
            c,
            "withdraw_unshielded",
            true,
            args,
            g.nonce.field().private(),
        );
        grants::settle(c, &a, id, g, challenge, opening.salt, new_spent);
        custody::withdraw_unshielded(c, color, amount, recipient);
        Discloses::of(())
    }
    #[circuit(output = "reference shielded result")]
    pub fn withdraw_shielded_with_grant_k256(
        c: &mut Circuit3,
        recipient: ZswapCoinPublicKey<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        change_entry: BytesN<Private, 192>,
        enc_pk: B32<Private>,
        pk: Secp256k1Point,
        envelope: Uint<8>,
        origin_hash: B32<Private>,
        slot: Uint<8>,
        opening: SpendOpening,
        sig: Signature,
    ) -> Discloses<(Mutation,), Change> {
        let a = Auth::k256(c, pk, sig, envelope);
        let coin = custody::held_coin(c);
        let (id, g) = grants::authenticate(c, &a, origin_hash, slot);
        let new_spent = grants::check_scope(
            c,
            &g,
            g.scope.op_withdraw_shielded,
            &opening,
            coin.color.bytes(),
            amount,
            recipient.bytes(),
            2,
        );
        grants::shielded_bounds(c, &coin, opening.max_coin_value, enc_pk);
        let args = Preimage::default()
            .bytes(id.private())
            .uint(g.issued_at.field().private(), 8)
            .bytes(recipient.bytes())
            .bytes(color.bytes())
            .uint(amount.field(), 16)
            .blob(&change_entry)
            .bytes(enc_pk)
            .append(custody::coin_preimage(&coin));
        let challenge = a.challenge(
            c,
            "withdraw_shielded",
            true,
            args,
            g.nonce.field().private(),
        );
        grants::settle(c, &a, id, g, challenge, opening.salt, new_spent);
        let result = custody::withdraw_shielded(c, coin, amount, recipient.bytes(), false);
        c.when(result.change.is_some.field(), |c| {
            custody::append(c, &change_entry)
        });
        Discloses::of(result.change)
    }
    #[circuit(output = "reference shielded result")]
    pub fn withdraw_shielded_to_contract_with_grant_k256(
        c: &mut Circuit3,
        recipient: ContractAddress<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        change_entry: BytesN<Private, 192>,
        enc_pk: B32<Private>,
        pk: Secp256k1Point,
        envelope: Uint<8>,
        origin_hash: B32<Private>,
        slot: Uint<8>,
        opening: SpendOpening,
        sig: Signature,
    ) -> Discloses<(Mutation,), SentAndChange> {
        let a = Auth::k256(c, pk, sig, envelope);
        let coin = custody::held_coin(c);
        let (id, g) = grants::authenticate(c, &a, origin_hash, slot);
        let new_spent = grants::check_scope(
            c,
            &g,
            g.scope.op_withdraw_shielded_to_contract,
            &opening,
            coin.color.bytes(),
            amount,
            recipient.bytes(),
            3,
        );
        grants::shielded_bounds(c, &coin, opening.max_coin_value, enc_pk);
        let args = Preimage::default()
            .bytes(id.private())
            .uint(g.issued_at.field().private(), 8)
            .bytes(recipient.bytes())
            .bytes(color.bytes())
            .uint(amount.field(), 16)
            .blob(&change_entry)
            .bytes(enc_pk)
            .append(custody::coin_preimage(&coin));
        let challenge = a.challenge(
            c,
            "withdraw_shielded_to_contract",
            true,
            args,
            g.nonce.field().private(),
        );
        grants::settle(c, &a, id, g, challenge, opening.salt, new_spent);
        let result = custody::withdraw_shielded(c, coin, amount, recipient.bytes(), true);
        c.when(result.change.is_some.field(), |c| {
            custody::append(c, &change_entry)
        });
        Discloses::of(SentAndChange(result.sent, result.change))
    }
}
