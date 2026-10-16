#[cfg(test)]
mod tests {
use transient_crypto::{curve::{EmbeddedFr, EmbeddedGroupAffine, Fr}, encryption::{SecretKey,PublicKey,Ciphertext}, hash::transient_hash, schnorr::{self,SchnorrSignature}};
use serialize::{Serializable,Deserializable};
#[test]
fn zero_key_identity_recipient_exposes_plaintext() {
    let sk=SecretKey::from_repr(&[0;32]).unwrap();
    let pk=sk.public_key();
    let mut encoded=Vec::new();pk.serialize(&mut encoded).unwrap();
    let imported=PublicKey::deserialize(&mut encoded.as_slice(),0).unwrap();
    let cipher=imported.encrypt(&mut rand::rngs::OsRng,&Fr::from(42u64));
    let public_key=transient_hash(&[Fr::from(0u64),Fr::from(1u64)]);
    assert_eq!(cipher.ciph[0]-transient_hash(&[public_key,Fr::from(0u64)]),Fr::from(0u64));
    assert_eq!(cipher.ciph[1]-transient_hash(&[public_key,Fr::from(1u64)]),Fr::from(42u64));
    assert_eq!(sk.decrypt::<Fr>(&cipher),Some(Fr::from(42u64)));
    println!("zero SK and identity public-key serialization/import accepted; plaintext recovered without secret");
}
#[test]
fn identity_ciphertext_is_rejected_twice() {
    let cipher=Ciphertext{c:EmbeddedGroupAffine::identity(),ciph:vec![Fr::from(0u64),Fr::from(42u64)]};
    let mut encoded=vec![];cipher.serialize(&mut encoded).unwrap();
    assert!(Ciphertext::deserialize(&mut encoded.as_slice(),0).is_err());
    let sk=SecretKey::from_repr(&[0;32]).unwrap();assert!(sk.decrypt::<Fr>(&cipher).is_none());
}
#[test]
fn identity_announcement_satisfies_equation_but_native_verifier_rejects() {
    let pk=EmbeddedGroupAffine::generator();let ann=EmbeddedGroupAffine::identity();let msg=[Fr::from(42u64)];
    let h=transient_hash(&[ann.x().unwrap(),ann.y().unwrap(),pk.x().unwrap(),pk.y().unwrap(),msg[0]]);
    let mut wide=[0u8;64];wide[..32].copy_from_slice(&h.0.to_bytes_le());
    let c=EmbeddedFr(midnight_curves::Fr::from_bytes_wide(&wide));
    let sig=SchnorrSignature{announcement:ann,response:c};
    assert_eq!(EmbeddedGroupAffine::generator()*sig.response,sig.announcement+pk*c);
    assert!(!schnorr::verify(pk,&msg,&sig));
    println!("identity announcement satisfies Compact's displayed relation; Ledger native verify returns false");
}
}
