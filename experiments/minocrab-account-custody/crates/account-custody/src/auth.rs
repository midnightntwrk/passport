//! Reference FAB commitments and the two independent authorisation arms.
use crate::{ACCOUNT, Mutation, increment};
use minocrab::v3::{AnyWire3, Circuit3, FieldT, Wire3};
use minocrab::{Alignment, AlignmentAtom, AlignmentSegment, Private};
use minocrab_std::v3::Disclose;
use minocrab_std::v3::{
    B32, Bytes, BytesN, CircuitArg, JubjubPoint, Secp256k1EcdsaSignature, Secp256k1Point,
    Secp256k1Scalar, Uint, hash, kernel, secp256k1_ecdsa_verify,
};

pub type F = Wire3<FieldT, Private>;

#[derive(Default, Clone)]
pub struct Preimage {
    atoms: Vec<AlignmentSegment>,
    slots: Vec<AnyWire3<Private>>,
}

impl Preimage {
    pub fn bytes(mut self, value: B32<Private>) -> Self {
        self.atoms
            .push(AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }));
        self.slots.extend([value.hi.erase(), value.lo.erase()]);
        self
    }
    pub fn uint(mut self, value: F, bytes: u32) -> Self {
        self.atoms
            .push(AlignmentSegment::Atom(AlignmentAtom::Bytes {
                length: bytes,
            }));
        self.slots.push(value.erase());
        self
    }
    pub fn field(mut self, value: F) -> Self {
        self.atoms
            .push(AlignmentSegment::Atom(AlignmentAtom::Field));
        self.slots.push(value.erase());
        self
    }
    pub fn blob<const N: usize>(mut self, value: &BytesN<Private, N>) -> Self {
        self.atoms
            .push(AlignmentSegment::Atom(AlignmentAtom::Bytes {
                length: N as u32,
            }));
        self.slots.extend(value.limbs().iter().map(|w| w.erase()));
        self
    }
    pub fn append(mut self, rhs: Self) -> Self {
        self.atoms.extend(rhs.atoms);
        self.slots.extend(rhs.slots);
        self
    }
    pub fn hash(self, c: &mut Circuit3) -> B32<Private> {
        let imm: Option<Vec<minocrab::Fr>> = self.slots.iter().map(|w| w.as_immediate()).collect();
        match imm {
            Some(limbs) => hash::constant_persistent_hash(c, &Alignment(self.atoms), &limbs),
            None => hash::persistent_hash_compact(c, Alignment(self.atoms), &self.slots),
        }
    }
    pub fn tag(_c: &mut Circuit3, tag: &str) -> Self {
        assert!(tag.len() <= 32);
        let mut bytes = [0u8; 32];
        bytes[..tag.len()].copy_from_slice(tag.as_bytes());
        let mut p = Self::default();
        p.atoms.push(AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }));
        p.slots.push(AnyWire3::immediate(minocrab::Fr::from(u64::from(bytes[31]))));
        p.slots.push(AnyWire3::immediate(minocrab::Fr::from_le_bytes(&bytes[..31]).unwrap()));
        p
    }
}

#[derive(CircuitArg)]
pub struct Signature {
    pub r: Secp256k1Scalar,
    pub s: Secp256k1Scalar,
}

pub enum Auth {
    P256 {
        pk: crate::p256::Point,
        policy: crate::p256::Policy,
        data: BytesN<Private, 37>,
        sig: crate::p256::Signature,
        x: B32<Private>,
        y: B32<Private>,
    },
    Jubjub {
        pk: JubjubPoint,
        r: JubjubPoint,
        s: F,
        grind: Uint<64>,
    },
    K256 {
        pk: Secp256k1Point,
        sig: Signature,
        envelope: Uint<8>,
        x: B32<Private>,
        y: B32<Private>,
    },
}

impl Auth {
    pub fn p256(
        c: &mut Circuit3,
        pk: crate::p256::Point,
        policy: crate::p256::Policy,
        data: BytesN<Private, 37>,
        sig: crate::p256::Signature,
    ) -> Self {
        let (x, y) = c.into_coordinates(pk.0);
        let x = c.into_bytes32(x);
        let x = B32::from_typed(c, x);
        let y = c.into_bytes32(y);
        let y = B32::from_typed(c, y);
        Self::P256 {
            pk,
            policy,
            data,
            sig,
            x,
            y,
        }
    }

    /// Bind the canonical coordinate bytes once to the point argument. Reuse
    /// them for the weak-key guard, commitments, and signed challenge.
    pub fn k256(c: &mut Circuit3, pk: Secp256k1Point, sig: Signature, envelope: Uint<8>) -> Self {
        let (x, y) = c.into_coordinates(pk.point());
        let x = c.into_bytes32(x);
        let x = B32::from_typed(c, x);
        let y = c.into_bytes32(y);
        let y = B32::from_typed(c, y);
        Self::K256 {
            pk,
            sig,
            envelope,
            x,
            y,
        }
    }

    pub fn marker(&self) -> &'static str {
        match self {
            Self::Jubjub { .. } => "",
            Self::K256 { .. } => "k1:",
            Self::P256 { .. } => "r1:",
        }
    }
    pub fn key(&self, c: &mut Circuit3) -> Preimage {
        match self {
            Self::Jubjub { pk, .. } => {
                let (x, y) = c.into_coordinates(pk.point());
                Preimage::default().field(x).field(y)
            }
            Self::K256 { x, y, .. } | Self::P256 { x, y, .. } => {
                Preimage::default().bytes(*x).bytes(*y)
            }
        }
    }
    pub fn live_key(&self, c: &mut Circuit3) {
        match self {
            Self::P256 { .. } => {} // coordinate extraction rejects identity; cofactor is one
            Self::Jubjub { pk, .. } => pk.assert_not_small_order(c),
            Self::K256 { x, y, .. } => {
                let zero = B32::pad(c, "").private();
                let xzero = bytes_eq(c, *x, zero);
                let yzero = bytes_eq(c, *y, zero);
                let weak = c.mul(xzero, yzero);
                let live = c.not(weak);
                c.assert(live);
            }
        }
    }
    pub fn entry(&self, c: &mut Circuit3, counter: F) -> B32<Private> {
        let version = match self {
            Self::Jubjub { .. } => "v1",
            Self::K256 { .. } => "k1:v2",
            Self::P256 { .. } => "r1:v2",
        };
        let p = Preimage::tag(c, &format!("midnight:account:device:{version}"));
        let me = kernel::self_address(c).bytes().private();
        let p = p.bytes(me).append(self.key(c));
        let p = match self {
            Self::K256 { envelope, .. } => p.uint(envelope.field(), 1),
            Self::P256 { policy, .. } => p.append(policy.preimage()),
            _ => p,
        };
        let epoch = ACCOUNT.device_epoch.read(c).stale(c).field().private();
        p.uint(epoch, 4).uint(counter, 8).hash(c)
    }
    pub fn boot(&self, c: &mut Circuit3, salt: B32<Private>) -> B32<Private> {
        let version = match self {
            Self::Jubjub { .. } => "v1",
            Self::K256 { .. } => "k1:v2",
            Self::P256 { .. } => "r1:v2",
        };
        let p = Preimage::tag(c, &format!("midnight:account:boot:{version}"));
        let p = p.bytes(salt).append(self.key(c));
        let p = match self {
            Self::K256 { envelope, .. } => p.uint(envelope.field(), 1),
            Self::P256 { policy, .. } => p.append(policy.preimage()),
            _ => p,
        };
        p.hash(c)
    }
    pub fn challenge(
        &self,
        c: &mut Circuit3,
        operation: &str,
        grant: bool,
        args: Preimage,
        nonce: F,
    ) -> B32<Private> {
        let family = if grant { "grant:auth" } else { "auth" };
        let tag = format!("midnight:account:{family}:{}v1:{operation}", self.marker());
        assert!(tag.len() <= 64);
        let mut padded = [0u8; 64];
        padded[..tag.len()].copy_from_slice(tag.as_bytes());
        let tag = hash::Preimage::<Private>::new().blob_const(&padded).hash(c);
        let me = kernel::self_address(c).bytes().private();
        let p = Preimage::default().bytes(tag).bytes(me);
        let p = if let Self::Jubjub { r, .. } = self {
            let (x, y) = c.into_coordinates(r.point());
            p.field(x).field(y)
        } else {
            p
        };
        let p = p.append(self.key(c)).append(args).uint(nonce, 8);
        let p = if let Self::Jubjub { grind, .. } = self {
            p.uint(grind.field(), 8)
        } else {
            p
        };
        p.hash(c)
    }
    pub fn verify(&self, c: &mut Circuit3, challenge: B32<Private>) {
        match self {
            Self::P256 {
                pk,
                policy,
                data,
                sig,
                ..
            } => crate::p256::verify(c, challenge, policy, data, *sig, *pk),
            Self::Jubjub { pk, r, s, .. } => {
                // Compact's Bytes<32> -> Field is checked, NOT reduction modulo p.
                let challenge = c.reconstitute_field(challenge.hi, challenge.lo, 248);
                let challenge = c.jubjub_scalar_from_native(challenge);
                let scalar = c.jubjub_scalar_from_native(*s);
                let lhs = c.ec_mul_generator(scalar);
                let term = c.ec_mul(pk.point(), challenge);
                let rhs = c.add(r.point(), term);
                c.assert_eq(lhs, rhs);
            }
            Self::K256 {
                pk, sig, envelope, ..
            } => {
                let two = c.constant(2u64).private();
                let valid = c.less_than(envelope.field(), two, 8);
                c.assert(valid);
                let none = Preimage::default().bytes(challenge).hash(c);
                // The prefix is exactly 27 bytes; Compact adds no padding here.
                let prefix = *b"midnight_signed_message:32:";
                let prefix = Bytes::<27, minocrab::Public>::constant(c, &prefix);
                let connector = Preimage::default()
                    .uint(prefix.field().private(), 27)
                    .bytes(challenge)
                    .hash(c);
                let one = c.constant(1u64).private();
                let connector_selected = c.test_eq(envelope.field(), one);
                let digest = B32::cond_select(c, connector_selected, &connector, &none);
                let sig = Secp256k1EcdsaSignature {
                    r: sig.r.scalar(),
                    s: sig.s.scalar(),
                };
                let valid = secp256k1_ecdsa_verify(c, &digest, &sig, pk.point());
                c.assert(valid);
            }
        }
    }
    /// Spend grants admit envelope zero only. Keep that constraint here as
    /// well as at authentication, and avoid hashing the unreachable envelope.
    pub fn verify_grant(&self, c: &mut Circuit3, challenge: B32<Private>) {
        match self {
            Self::K256 {
                pk, sig, envelope, ..
            } => {
                let zero = c.constant(0u64).private();
                c.assert_eq(envelope.field(), zero);
                let digest = Preimage::default().bytes(challenge).hash(c);
                let signature = Secp256k1EcdsaSignature {
                    r: sig.r.scalar(),
                    s: sig.s.scalar(),
                };
                let valid = secp256k1_ecdsa_verify(c, &digest, &signature, pk.point());
                c.assert(valid);
            }
            _ => self.verify(c, challenge),
        }
    }
    pub fn authorise(&self, c: &mut Circuit3, counter: Uint<64>, challenge: B32<Private>) {
        self.live_key(c);
        let entry = self.entry(c, counter.field()).disclose_as::<Mutation>(c);
        let known = ACCOUNT.devices.member(c, &entry).stale(c);
        c.assert(known.field());
        ACCOUNT.devices.remove(c, &entry);
        let next = next_counter(c, counter.field());
        let entry = self.entry(c, next).disclose_as::<Mutation>(c);
        ACCOUNT.devices.insert(c, &entry);
        self.verify(c, challenge);
        increment(c, &ACCOUNT.auth_nonce);
        increment(c, &ACCOUNT.round);
    }
}

pub fn next_counter(c: &mut Circuit3, prior: F) -> F {
    let one = c.constant(1u64).private();
    let sum = c.add(prior, one);
    c.assert_bits(sum, 64)
}

pub fn bytes_eq(c: &mut Circuit3, a: B32<Private>, b: B32<Private>) -> F {
    let hi = c.test_eq(a.hi, b.hi);
    let lo = c.test_eq(a.lo, b.lo);
    c.mul(hi, lo)
}
