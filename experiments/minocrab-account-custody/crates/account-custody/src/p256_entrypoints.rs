//! P-256 wrappers preserve the current reference's nested auth argument ABI.
use crate::auth::{Auth, Preimage};
use crate::custody::{self, Change, SentAndChange};
use crate::grants::{self, ScopeInput, SpendOpening};
use crate::p256::{DeviceAuth, GrantAuth, Point, Policy};
use crate::{ACCOUNT, Mutation};
use minocrab::Private;
use minocrab::v3::Circuit3;
use minocrab_std::v3::*;
pub struct P256Calls;
#[contract]
impl P256Calls {
    #[circuit]
    pub fn activate_initial_device_with_p256(
        c: &mut Circuit3,
        pk: Point,
        salt: B32<Private>,
        policy: Policy,
    ) -> Discloses<(Mutation,)> {
        let zero = B32::pad(c, "").private().to_typed(c);
        let scalar = crate::p256::Scalar(c.from_bytes32(zero));
        let data = BytesN::literal(c, &[0u8; 37]);
        let a = Auth::p256(
            c,
            pk,
            policy,
            data,
            crate::p256::Signature {
                r: scalar,
                s: scalar,
            },
        );
        custody::activate(c, &a, salt);
        Discloses::of(())
    }
    #[circuit]
    pub fn append_inbox_with_p256(
        c: &mut Circuit3,
        entry: BytesN<Private, 192>,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,), ()> {
        let (a, use_counter) = auth.into_auth(c);
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
    pub fn rotate_enc_key_with_p256(
        c: &mut Circuit3,
        new_key: B32<Private>,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,), ()> {
        let (a, use_counter) = auth.into_auth(c);
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
    pub fn add_device_with_p256(
        c: &mut Circuit3,
        new_entry: B32<Private>,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,), ()> {
        let (a, use_counter) = auth.into_auth(c);
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
    pub fn remove_device_with_p256(
        c: &mut Circuit3,
        entry: B32<Private>,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,), ()> {
        let (a, use_counter) = auth.into_auth(c);
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
    pub fn withdraw_unshielded_with_p256(
        c: &mut Circuit3,
        color: CoinColor<Private>,
        amount: Uint<128>,
        recipient: UserAddress<Private>,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,), ()> {
        let (a, use_counter) = auth.into_auth(c);
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
    pub fn withdraw_shielded_with_p256(
        c: &mut Circuit3,
        recipient: ZswapCoinPublicKey<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,), Change> {
        let (a, use_counter) = auth.into_auth(c);
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
    pub fn withdraw_shielded_to_contract_with_p256(
        c: &mut Circuit3,
        recipient: ContractAddress<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,), SentAndChange> {
        let (a, use_counter) = auth.into_auth(c);
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
    pub fn issue_grant_with_p256(
        c: &mut Circuit3,
        grant_id: B32<Private>,
        scope: ScopeInput,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,)> {
        let (a, use_counter) = auth.into_auth(c);
        let digest = scope.digest(c);
        let args = Preimage::default().bytes(grant_id).bytes(digest);
        custody::gate(c, &a, use_counter, "issue_grant", args);
        grants::issue(c, grant_id, scope);
        Discloses::of(())
    }
    #[circuit]
    pub fn revoke_grant_with_p256(
        c: &mut Circuit3,
        grant_id: B32<Private>,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,)> {
        let (a, use_counter) = auth.into_auth(c);
        let args = Preimage::default().bytes(grant_id);
        custody::gate(c, &a, use_counter, "revoke_grant", args);
        grants::revoke(c, grant_id);
        Discloses::of(())
    }
    #[circuit]
    pub fn revoke_all_grants_with_p256(
        c: &mut Circuit3,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,)> {
        let (a, use_counter) = auth.into_auth(c);
        let args = Preimage::default();
        custody::gate(c, &a, use_counter, "revoke_all_grants", args);
        grants::revoke_all(c);
        Discloses::of(())
    }
    #[circuit]
    pub fn withdraw_unshielded_with_grant_p256(
        c: &mut Circuit3,
        color: CoinColor<Private>,
        amount: Uint<128>,
        recipient: UserAddress<Private>,
        origin_hash: B32<Private>,
        slot: Uint<8>,
        opening: SpendOpening,
        auth: GrantAuth,
    ) -> Discloses<(Mutation,), ()> {
        let a = auth.into_auth(c);
        let (id, g) = authenticate(c, &a, origin_hash, slot, opening.salt);
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
    pub fn withdraw_shielded_with_grant_p256(
        c: &mut Circuit3,
        recipient: ZswapCoinPublicKey<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        change_entry: BytesN<Private, 192>,
        enc_pk: B32<Private>,
        origin_hash: B32<Private>,
        slot: Uint<8>,
        opening: SpendOpening,
        auth: GrantAuth,
    ) -> Discloses<(Mutation,), Change> {
        let a = auth.into_auth(c);
        let coin = custody::held_coin(c);
        let (id, g) = authenticate(c, &a, origin_hash, slot, opening.salt);
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
    pub fn withdraw_shielded_to_contract_with_grant_p256(
        c: &mut Circuit3,
        recipient: ContractAddress<Private>,
        color: CoinColor<Private>,
        amount: Uint<128>,
        change_entry: BytesN<Private, 192>,
        enc_pk: B32<Private>,
        origin_hash: B32<Private>,
        slot: Uint<8>,
        opening: SpendOpening,
        auth: GrantAuth,
    ) -> Discloses<(Mutation,), SentAndChange> {
        let a = auth.into_auth(c);
        let coin = custody::held_coin(c);
        let (id, g) = authenticate(c, &a, origin_hash, slot, opening.salt);
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
    pub fn publish_recovery_session_with_p256(
        c: &mut Circuit3,
        session: crate::recovery::Session,
        auth: DeviceAuth,
    ) -> Discloses<(Mutation,)> {
        let (a, counter) = auth.into_auth(c);
        let args = session.preimage(c);
        custody::gate(c, &a, counter, "publish_recovery_session", args);
        crate::recovery::publish(c, session);
        Discloses::of(())
    }
    #[circuit]
    pub fn recover_cancel_with_p256(c: &mut Circuit3, auth: DeviceAuth) -> Discloses<(Mutation,)> {
        let (a, counter) = auth.into_auth(c);
        let args = Preimage::default();
        custody::gate(c, &a, counter, "recover_cancel", args);
        crate::recovery::cancel(c);
        Discloses::of(())
    }
}
fn authenticate(
    c: &mut Circuit3,
    a: &Auth,
    origin: B32<Private>,
    slot: Uint<8>,
    salt: B32<Private>,
) -> (B32<minocrab::Public>, crate::GrantRecord) {
    let Auth::P256 { policy, .. } = a else {
        unreachable!()
    };
    let hash = Preimage::tag(c, "midnight:account:grant:origin:v1")
        .uint(policy.origin.field(), 21)
        .hash(c);
    let valid = crate::auth::bytes_eq(c, hash, origin);
    c.assert(valid);
    let (id, g) = grants::authenticate(c, a, origin, slot);
    let rp = Preimage::tag(c, "midnight:account:grant:rp:v1")
        .bytes(salt)
        .bytes(policy.rp_id_hash)
        .hash(c);
    let valid = crate::auth::bytes_eq(c, rp, g.scope.rp_commit.private());
    c.assert(valid);
    (id, g)
}
