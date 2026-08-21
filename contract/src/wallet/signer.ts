// Device signer — ECDSA-secp256k1 arm (see the contract header; this is
// not the MIP-0013 scheme).
//
// A device holds an independent ECDSA keypair (sk, pk = sk·G) on secp256k1;
// keys are never derived from one another or from a seed (AUTH-7). To
// authorise a call the device ECDSA-signs the 32-byte per-circuit challenge
// digest directly: the contract's secp256k1EcdsaVerify interprets the
// challenge as a big-endian integer and reduces it mod the curve order n
// internally, so there is no grinding step, and an ECDSA message must not
// depend on its own signature, so there is no signature commitment in the
// preimage either. The signer emits low-S signatures (the @noble/curves
// default); the circuit deliberately accepts both S forms (see the
// malleability note in the contract header).
//
// The challenge preimages are reproduced through the contract's own
// exported pure circuits, so the signer inherits the compiler's
// field-aligned encoding bit-exactly. The signing side needs no node,
// indexer, prover, or contract runtime beyond those pure functions — the
// approval/proving separation of R5. Proof generation consumes the
// signature and never sk (AUTH-4).

import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { pureCircuits, type Secp256k1Point, type QualifiedCoin } from './contract.js';

// secp256k1 group order n.
export const SECP256K1_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);

/** Uniform scalar in [1, n), by rejection sampling. */
export function randomSecp256k1Scalar(): bigint {
  for (;;) {
    const candidate = BigInt('0x' + randomBytes(32).toString('hex'));
    if (candidate > 0n && candidate < SECP256K1_N) return candidate;
  }
}

/** Big-endian 32-byte encoding of a scalar (the noble key/digest format). */
export function scalarToBytesBE(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** An ECDSA signature as the generated circuit ABI carries it. */
export interface EcdsaSignature {
  r: bigint;
  s: bigint;
}

/** The authorising material a gated circuit consumes (MIP-0012 §4). */
export interface Authorisation {
  pk: Secp256k1Point;
  /** The device's current use counter — the rolling-entry position
   *  (AUTH-9). Not part of the challenge; bound by entry consumption. */
  use_counter: bigint;
  sig: EcdsaSignature;
}

export class Device {
  readonly pk: Secp256k1Point;

  constructor(readonly sk: bigint) {
    this.pk = pureCircuits.compute_public_point(sk);
  }

  static generate(): Device {
    return new Device(randomSecp256k1Scalar());
  }

  /** The device's rolling entry at a given account/epoch/counter. */
  entryAt(contractAddress: Uint8Array, epoch: bigint, counter: bigint): Uint8Array {
    return pureCircuits.derive_device_entry({ bytes: contractAddress }, this.pk, epoch, counter);
  }

  /** ECDSA-sign the 32-byte challenge digest (prehashed — the digest IS
   *  the message). `useCounter` is carried alongside for the seam's entry
   *  consumption. */
  sign(challenge: Uint8Array, useCounter: bigint): Authorisation {
    const sigBytes = secp256k1.sign(challenge, scalarToBytesBE(this.sk), { prehash: false });
    const { r, s } = secp256k1.Signature.fromBytes(sigBytes);
    return { pk: this.pk, use_counter: useCounter, sig: { r, s } };
  }
}

// ── Per-circuit challenge digests ───────────────────────────────────────────
//
// Preimage: [DST_CIRCUIT, self, pk_x, pk_y, ...args, ...witness_values,
// auth_nonce] with args in declaration order and the values returned by the
// circuit's witness invocations pinned after them (AUTH-10) — for the two
// shielded spends that is the held_coin result, which is why their builders
// take the qualified coin. Each builder mirrors one gated circuit and
// returns the digest the device signs.

export interface CallContext {
  /** The account's contract address, raw bytes (binds the account, AUTH-3). */
  contractAddress: Uint8Array;
  /** The auth_nonce the call will execute against (pre-increment, AUTH-2). */
  authNonce: bigint;
}

const addr = (ctx: CallContext) => ({ bytes: ctx.contractAddress });

export const challenges = {
  withdrawUnshielded: (ctx: CallContext, pk: Secp256k1Point, color: Uint8Array, amount: bigint, recipient: Uint8Array): Uint8Array =>
    pureCircuits.challenge_withdraw_unshielded(
      addr(ctx), pk, color, amount, { bytes: recipient }, ctx.authNonce,
    ),

  // The witness-consuming circuits bind the held_coin return value into
  // the challenge (AUTH-10): the approver receives — and signs over — the
  // exact qualified coin the spend will consume.
  withdrawShielded: (ctx: CallContext, pk: Secp256k1Point, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin): Uint8Array =>
    pureCircuits.challenge_withdraw_shielded(
      addr(ctx), pk, { bytes: recipient }, color, amount, coin, ctx.authNonce,
    ),

  withdrawShieldedToContract: (ctx: CallContext, pk: Secp256k1Point, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin): Uint8Array =>
    pureCircuits.challenge_withdraw_shielded_to_contract(
      addr(ctx), pk, { bytes: recipient }, color, amount, coin, ctx.authNonce,
    ),

  appendInbox: (ctx: CallContext, pk: Secp256k1Point, entry: Uint8Array): Uint8Array =>
    pureCircuits.challenge_append_inbox(addr(ctx), pk, entry, ctx.authNonce),

  rotateEncKey: (ctx: CallContext, pk: Secp256k1Point, newKey: Uint8Array): Uint8Array =>
    pureCircuits.challenge_rotate_enc_key(addr(ctx), pk, newKey, ctx.authNonce),

  addDevice: (ctx: CallContext, pk: Secp256k1Point, newPk: Secp256k1Point): Uint8Array =>
    pureCircuits.challenge_add_device(addr(ctx), pk, newPk, ctx.authNonce),

  removeDevice: (ctx: CallContext, pk: Secp256k1Point, commitment: Uint8Array): Uint8Array =>
    pureCircuits.challenge_remove_device(addr(ctx), pk, commitment, ctx.authNonce),
};
