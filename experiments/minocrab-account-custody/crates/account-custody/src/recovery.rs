//! Recovery session publication, co-signed submission, veto and finalisation.
use crate::auth::{Auth, Preimage, bytes_eq};
use crate::custody::{self, Scalar};
use crate::{ACCOUNT, Mutation, increment};
use minocrab::v3::Circuit3;
use minocrab::{Private, Public};
use minocrab_std::v3::*;

pub fn private_point(p: JubjubPoint<Public>) -> JubjubPoint {
    JubjubPoint::from_point(p.point().private())
}
pub fn point_preimage(c: &mut Circuit3, p: JubjubPoint) -> Preimage {
    let (x, y) = c.into_coordinates(p.point());
    Preimage::default().field(x).field(y)
}
pub fn live(c: &mut Circuit3, p: JubjubPoint) {
    // [8]O = O, so the cofactor test rejects the identity as well.
    p.assert_not_small_order(c);
}

#[derive(CircuitArg)]
pub struct Session {
    pub pk: JubjubPoint,
    pub nonce: B32<Private>,
    pub phi1: Scalar,
    pub phi2: Scalar,
    pub phi3: Scalar,
    pub phi4: Scalar,
    pub len: Uint<8>,
    pub wrap: BytesN<Private, 64>,
}
impl Session {
    pub fn preimage(&self, c: &mut Circuit3) -> Preimage {
        point_preimage(c, self.pk)
            .bytes(self.nonce)
            .field(self.phi1.0)
            .field(self.phi2.0)
            .field(self.phi3.0)
            .field(self.phi4.0)
            .uint(self.len.field(), 1)
            .blob(&self.wrap)
    }
}
pub fn publish(c: &mut Circuit3, s: Session) {
    let pending = ACCOUNT.pending_recovery.read(c).stale(c);
    let clear = c.not(pending.field());
    c.assert(clear);
    let zero = c.constant(0u64).private();
    let positive = c.less_than(zero, s.len.field(), 8);
    c.assert(positive);
    let five = c.constant(5u64).private();
    let bounded = c.less_than(s.len.field(), five, 8);
    c.assert(bounded);
    let phi = [s.phi1.0, s.phi2.0, s.phi3.0, s.phi4.0];
    for (index, value) in phi.iter().enumerate().skip(1) {
        let threshold = c.constant((index + 1) as u64).private();
        let unused = c.less_than(s.len.field(), threshold, 8);
        let masked = c.mul(unused, *value);
        c.assert_eq(masked, zero);
    }
    let empty = B32::pad(c, "").private();
    let bad = bytes_eq(c, s.nonce, empty);
    let good = c.not(bad);
    c.assert(good);
    let old = ACCOUNT.recovery_session.read(c).stale(c).private();
    let bad = bytes_eq(c, s.nonce, old);
    let good = c.not(bad);
    c.assert(good);
    let old = ACCOUNT.recovery_pk.read(c).stale(c);
    let bad = c.test_eq(s.pk.point(), old.point().private());
    let good = c.not(bad);
    c.assert(good);
    live(c, s.pk);
    let pk = s.pk.disclose_as::<Mutation>(c);
    ACCOUNT.recovery_pk.write(c, &pk);
    let nonce = s.nonce.disclose_as::<Mutation>(c);
    ACCOUNT.recovery_session.write(c, &nonce);
    for (index, value) in phi.into_iter().enumerate() {
        let key = Uint::from_field_unchecked(c.constant((index + 1) as u64));
        let value = MerkleTreeDigest::from_field_unchecked(value.disclose_as::<Mutation>(c));
        ACCOUNT.recovery_phi.insert(c, &key, &value);
    }
    let len = s.len.disclose_as::<Mutation>(c);
    ACCOUNT.recovery_phi_len.write(c, &len);
    let wrap = s.wrap.disclose_as::<Mutation>(c);
    ACCOUNT.recovery_wrap.write(c, &wrap);
    let one = Uint::from_field_unchecked(c.constant(1u64));
    ACCOUNT.recovery_version.write(c, &one);
}

fn clear_pending(c: &mut Circuit3) {
    let key = ACCOUNT.pending_recovery_pk.read(c).stale(c);
    let zero = c.constant(0u64);
    let scalar = c.jubjub_scalar_from_native(zero);
    let identity = JubjubPoint::from_point(c.ec_mul(key.point(), scalar));
    ACCOUNT.pending_recovery_pk.write(c, &identity);
    let empty = B32::pad(c, "");
    ACCOUNT.pending_entry.write(c, &empty);
    ACCOUNT
        .pending_recovery
        .write(c, &Bool::from_field_unchecked(zero));
    ACCOUNT
        .pending_not_before
        .write(c, &Uint::from_field_unchecked(zero));
}
pub fn cancel(c: &mut Circuit3) {
    let pending = ACCOUNT.pending_recovery.read(c).stale(c);
    c.assert(pending.field());
    clear_pending(c);
}

pub struct RecoveryCalls;
#[contract]
impl RecoveryCalls {
    #[circuit]
    pub fn recover_submit(
        c: &mut Circuit3,
        successor_pk: JubjubPoint,
        successor_recovery_pk: JubjubPoint,
        expected_epoch: Uint<32>,
        expected_nonce: Uint<64>,
        now_upper: Uint<64>,
        sig_r_recovery: JubjubPoint,
        sig_s_recovery: Scalar,
        sig_r_successor: JubjubPoint,
        sig_s_successor: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,)> {
        let pending = ACCOUNT.pending_recovery.read(c).stale(c);
        let clear = c.not(pending.field());
        c.assert(clear);
        let epoch = ACCOUNT.device_epoch.read(c).stale(c).field().private();
        let nonce = ACCOUNT.auth_nonce.read(c).stale(c).field().private();
        c.assert_eq(expected_epoch.field(), epoch);
        c.assert_eq(expected_nonce.field(), nonce);
        let pk = private_point(ACCOUNT.recovery_pk.read(c).stale(c));
        live(c, pk);
        live(c, successor_pk);
        live(c, successor_recovery_pk);
        let same = c.test_eq(pk.point(), successor_recovery_pk.point());
        let fresh = c.not(same);
        c.assert(fresh);
        let one = c.constant(1u64).private();
        let post = c.add(epoch, one);
        let post = c.assert_bits(post, 32);
        let mut tag = [0u8; 64];
        let name = b"midnight:account:recovery:submit:v1";
        tag[..name.len()].copy_from_slice(name);
        let dst = minocrab_std::v3::hash::Preimage::<Private>::new().blob_const(&tag).hash(c);
        let me = kernel::self_address(c).bytes().private();
        let challenge = Preimage::default()
            .bytes(dst)
            .bytes(me)
            .append(point_preimage(c, pk))
            .append(point_preimage(c, sig_r_recovery))
            .append(point_preimage(c, successor_pk))
            .append(point_preimage(c, sig_r_successor))
            .append(point_preimage(c, successor_recovery_pk))
            .uint(post, 4)
            .uint(nonce, 8)
            .uint(now_upper.field(), 8)
            .uint(grind_nonce.field(), 8)
            .hash(c);
        Auth::Jubjub {
            pk,
            r: sig_r_recovery,
            s: sig_s_recovery.0,
            grind: grind_nonce,
        }
        .verify(c, challenge);
        Auth::Jubjub {
            pk: successor_pk,
            r: sig_r_successor,
            s: sig_s_successor.0,
            grind: grind_nonce,
        }
        .verify(c, challenge);
        let upper = now_upper.disclose_as::<Mutation>(c);
        let late = kernel::block_time_greater_than(c, upper).stale(c);
        let timely = c.not(late.field());
        c.assert(timely);
        let entry = Preimage::tag(c, "midnight:account:device:v1")
            .bytes(me)
            .append(point_preimage(c, successor_pk))
            .uint(post, 4)
            .uint(c.constant(0u64).private(), 8)
            .hash(c)
            .disclose_as::<Mutation>(c);
        ACCOUNT.pending_entry.write(c, &entry);
        let key = successor_recovery_pk.disclose_as::<Mutation>(c);
        ACCOUNT.pending_recovery_pk.write(c, &key);
        let window = ACCOUNT.veto_window.read(c).stale(c);
        let sum = c.add(upper.field(), window.field());
        let deadline = Uint::from_field_checked(c, sum);
        ACCOUNT.pending_not_before.write(c, &deadline);
        let yes = Bool::from_field_unchecked(c.constant(1u64));
        ACCOUNT.pending_recovery.write(c, &yes);
        increment(c, &ACCOUNT.round);
        Discloses::of(())
    }
    #[circuit]
    pub fn recover_finalise(c: &mut Circuit3) -> Discloses<()> {
        let pending = ACCOUNT.pending_recovery.read(c).stale(c);
        c.assert(pending.field());
        let deadline = ACCOUNT.pending_not_before.read(c).stale(c);
        let early = kernel::block_time_less_than(c, deadline).stale(c);
        let ready = c.not(early.field());
        c.assert(ready);
        let key = ACCOUNT.pending_recovery_pk.read(c).stale(c);
        live(c, private_point(key));
        increment(c, &ACCOUNT.device_epoch);
        ACCOUNT.devices.reset_to_default(c);
        let entry = ACCOUNT.pending_entry.read(c).stale(c);
        ACCOUNT.devices.insert(c, &entry);
        let one = Uint::from_field_unchecked(c.constant(1u64));
        ACCOUNT.device_count.write(c, &one);
        ACCOUNT.recovery_pk.write(c, &key);
        let zero = Uint::from_field_unchecked(c.constant(0u64));
        ACCOUNT.recovery_phi_len.write(c, &zero);
        clear_pending(c);
        increment(c, &ACCOUNT.auth_nonce);
        increment(c, &ACCOUNT.round);
        Discloses::of(())
    }
    #[circuit]
    pub fn publish_recovery_session_with_jubjub(
        c: &mut Circuit3,
        session: Session,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,)> {
        let auth = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        let args = session.preimage(c);
        custody::gate(c, &auth, use_counter, "publish_recovery_session", args);
        publish(c, session);
        Discloses::of(())
    }

    #[circuit]
    pub fn recover_cancel_with_jubjub(
        c: &mut Circuit3,
        pk: JubjubPoint,
        use_counter: Uint<64>,
        sig_r: JubjubPoint,
        sig_s: Scalar,
        grind_nonce: Uint<64>,
    ) -> Discloses<(Mutation,)> {
        let auth = Auth::Jubjub {
            pk,
            r: sig_r,
            s: sig_s.0,
            grind: grind_nonce,
        };
        let args = Preimage::default();
        custody::gate(c, &auth, use_counter, "recover_cancel", args);
        cancel(c);
        Discloses::of(())
    }

    #[circuit]
    pub fn publish_recovery_session_with_k256(
        c: &mut Circuit3,
        session: Session,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: crate::auth::Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,)> {
        let auth = Auth::k256(c, pk, sig, envelope);
        let args = session.preimage(c);
        custody::gate(c, &auth, use_counter, "publish_recovery_session", args);
        publish(c, session);
        Discloses::of(())
    }

    #[circuit]
    pub fn recover_cancel_with_k256(
        c: &mut Circuit3,
        pk: Secp256k1Point,
        use_counter: Uint<64>,
        sig: crate::auth::Signature,
        envelope: Uint<8>,
    ) -> Discloses<(Mutation,)> {
        let auth = Auth::k256(c, pk, sig, envelope);
        let args = Preimage::default();
        custody::gate(c, &auth, use_counter, "recover_cancel", args);
        cancel(c);
        Discloses::of(())
    }
}
