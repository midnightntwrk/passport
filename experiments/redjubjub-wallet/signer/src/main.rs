//! Schnorr signer CLI for the redjubjub-wallet experiment.
//!
//! Two commands:
//!   keygen — generate a new JubJub key pair
//!   sign   — compute s = (r + c * sk) mod JUBJUB_R given (sk, challenge, r)
//!
//! The sign command is a pure scalar arithmetic tool. It does NOT compute
//! the challenge hash (that uses Midnight's Poseidon, handled by TypeScript
//! via the contract's pureCircuits). It does NOT generate the nonce r
//! (TypeScript generates r and computes R = r*G via pureCircuits to ensure
//! curve parameter match).
//!
//! In a FROST threshold setup, this command would be replaced by a threshold
//! signing protocol where each node holds a share of sk and contributes a
//! partial response.

use ff::Field;
use group::Group;
use jubjub::Fr;
use serde::{Deserialize, Serialize};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(String::as_str).unwrap_or("help");

    match command {
        "keygen" => cmd_keygen(),
        "sign" => cmd_sign(),
        _ => {
            eprintln!("Usage: schnorr-signer <keygen|sign>");
            eprintln!("  keygen  — generate a JubJub key pair (JSON to stdout)");
            eprintln!("  sign    — read (sk, challenge, r) from stdin, write s to stdout");
            std::process::exit(1);
        }
    }
}

#[derive(Serialize)]
struct KeygenOutput {
    /// Secret key as 0x-prefixed little-endian hex
    sk: String,
    /// Public key x coordinate (little-endian hex)
    pk_x: String,
    /// Public key y coordinate (little-endian hex)
    pk_y: String,
}

fn cmd_keygen() {
    let sk = Fr::random(&mut rand::thread_rng());
    let pk = jubjub::ExtendedPoint::from(jubjub::SubgroupPoint::generator()) * sk;
    let pk_affine = jubjub::AffinePoint::from(pk);

    let output = KeygenOutput {
        sk: format!("0x{}", hex::encode(sk.to_bytes())),
        pk_x: format!("0x{}", hex::encode(pk_affine.get_u().to_bytes())),
        pk_y: format!("0x{}", hex::encode(pk_affine.get_v().to_bytes())),
    };

    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

#[derive(Deserialize)]
struct SignRequest {
    /// Secret key (0x-prefixed little-endian hex, 32 bytes)
    sk: String,
    /// Challenge hash c (0x-prefixed little-endian hex, 32 bytes).
    /// Must be < JUBJUB_R (caller is responsible for nonce-retry).
    challenge: String,
    /// Nonce scalar r (0x-prefixed little-endian hex, 32 bytes).
    /// R = r*G is computed by the caller (TypeScript via pureCircuits).
    r: String,
}

#[derive(Serialize)]
struct SignOutput {
    /// Response scalar s = (r + c * sk) mod JUBJUB_R
    s: String,
}

fn decode_scalar(hex_str: &str) -> Fr {
    let clean = hex_str.strip_prefix("0x").unwrap_or(hex_str);
    let bytes = hex::decode(clean).expect("invalid hex");
    let mut arr = [0u8; 32];
    arr[..bytes.len()].copy_from_slice(&bytes);
    let opt = Fr::from_bytes(&arr);
    if bool::from(opt.is_some()) {
        opt.unwrap()
    } else {
        panic!("scalar out of range for JubJub Fr");
    }
}

fn cmd_sign() {
    let input: SignRequest =
        serde_json::from_reader(std::io::stdin()).expect("invalid JSON on stdin");

    let sk = decode_scalar(&input.sk);
    let c = decode_scalar(&input.challenge);
    let r = decode_scalar(&input.r);

    // s = r + c * sk  (mod JUBJUB_R)
    let s = r + (c * sk);

    let output = SignOutput {
        s: format!("0x{}", hex::encode(s.to_bytes())),
    };

    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
