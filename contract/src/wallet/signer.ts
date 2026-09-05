// Device signers — one per authorisation arm of the contract (see the
// contract header: arm `jubjub` is the normative MIP-0013 scheme, arm
// `k256` the interim ECDSA stand-in for the planned secp256r1 passkey arm).
//
// Common to both arms: a device holds an independent keypair (sk, pk =
// sk·G) on its arm's curve; keys are never derived from one another or
// from a seed (AUTH-7). The challenge preimages are reproduced through the
// contract's own exported pure circuits, so each signer inherits the
// compiler's field-aligned encoding bit-exactly (MIP-0013 §2). The signing
// side needs no node, indexer, prover, or contract runtime beyond those
// pure functions — the approval/proving separation of R5. Proof generation
// consumes the signature and never sk (AUTH-4).
//
// Arm jubjub (MIP-0013 §5) — to authorise a call the device:
//   1. samples a nonce scalar r uniformly from [1, r_J)   (§5.3, S1)
//   2. computes R = r·G
//   3. grinds the challenge: h = persistentHash(preimage(grind_nonce)) for
//      grind_nonce = 0, 1, 2, … until the little-endian integer value of h
//      is strictly below r_J (§5.2; ~17.5 expected attempts)
//   4. computes s = r + c·sk mod r_J
//   5. outputs (R, s, grind_nonce)
//
// Arm k256 — the device ECDSA-signs the 32-byte per-circuit challenge
// digest directly: the contract's secp256k1EcdsaVerify interprets the
// challenge as a big-endian integer and reduces it mod the curve order n
// internally, so there is no grinding step, and an ECDSA message must not
// depend on its own signature, so there is no signature commitment in the
// preimage either. The signer emits low-S signatures (the @noble/curves
// default); the circuit deliberately accepts both S forms (see the
// malleability note in the contract header).

import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import {
  pureCircuits,
  type JubjubPoint,
  type Secp256k1Point,
  type QualifiedCoin,
} from './contract.js';

/** The authorisation arms the contract exports circuits for. */
export type Arm = 'jubjub' | 'k256';

export interface CallContext {
  /** The account's contract address, raw bytes (binds the account, AUTH-3). */
  contractAddress: Uint8Array;
  /** The auth_nonce the call will execute against (pre-increment, AUTH-2). */
  authNonce: bigint;
}

const addr = (ctx: CallContext) => ({ bytes: ctx.contractAddress });

// ─────────────────────────────────────────────────────────────────────────────
// Arm jubjub (MIP-0013 §5)
// ─────────────────────────────────────────────────────────────────────────────

// JubJub prime-order subgroup order r_J (MIP-0013 §2).
export const JUBJUB_R = BigInt(
  '0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7',
);

/** Uniform scalar in [1, r_J), by rejection sampling. */
export function randomJubjubScalar(): bigint {
  for (;;) {
    const candidate = BigInt('0x' + randomBytes(32).toString('hex'));
    if (candidate > 0n && candidate < JUBJUB_R) return candidate;
  }
}

/** Little-endian integer interpretation of a 32-byte hash (§5.2). */
export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]);
  return r;
}

/** The authorising material a jubjub-arm gated circuit consumes. */
export interface JubjubAuthorisation {
  arm: 'jubjub';
  pk: JubjubPoint;
  /** The device's current use counter — the rolling-entry position
   *  (AUTH-9). Not part of the challenge; bound by entry consumption. */
  use_counter: bigint;
  sig_r: JubjubPoint;
  sig_s: bigint;
  grind_nonce: bigint;
}

/**
 * A jubjub-arm challenge builder: the per-circuit §5.1 preimage hash,
 * closed over the account address, the circuit's arguments, and the
 * observed auth_nonce. The signer varies only grind_nonce.
 */
export type ChallengeBuilder = (sigR: JubjubPoint, grindNonce: bigint) => Uint8Array;

export class JubjubDevice {
  readonly arm = 'jubjub' as const;
  readonly pk: JubjubPoint;

  constructor(readonly sk: bigint) {
    this.pk = pureCircuits.compute_public_point_with_jubjub(sk);
  }

  static generate(): JubjubDevice {
    return new JubjubDevice(randomJubjubScalar());
  }

  /** The device's rolling entry at a given account/epoch/counter (§3). */
  entryAt(contractAddress: Uint8Array, epoch: bigint, counter: bigint): Uint8Array {
    return pureCircuits.derive_device_entry_with_jubjub(
      { bytes: contractAddress }, this.pk, epoch, counter,
    );
  }

  /** The MIP-0013 §3 boot commitment for this device's arm. */
  bootCommitment(salt: Uint8Array): Uint8Array {
    return pureCircuits.derive_boot_commitment_with_jubjub(salt, this.pk);
  }

  /** Produce (R, s, grind_nonce) for the call the builder describes.
   *  `useCounter` is carried alongside for the seam's entry consumption. */
  sign(challenge: ChallengeBuilder, useCounter: bigint): JubjubAuthorisation {
    const r = randomJubjubScalar();
    const sigR = pureCircuits.compute_public_point_with_jubjub(r);

    let grindNonce = 0n;
    let c: bigint;
    for (;;) {
      const h = challenge(sigR, grindNonce);
      const hInt = bytesToBigIntLE(h);
      if (hInt < JUBJUB_R) {
        c = hInt;
        break;
      }
      grindNonce++;
    }

    const s = (r + ((c % JUBJUB_R) * (this.sk % JUBJUB_R)) % JUBJUB_R) % JUBJUB_R;
    return { arm: 'jubjub', pk: this.pk, use_counter: useCounter, sig_r: sigR, sig_s: s, grind_nonce: grindNonce };
  }
}

// Per-circuit challenge builders (MIP-0013 §5.1). Preimage:
// [DST_CIRCUIT, self, sig_r, pk, ...args, ...witness_values, auth_nonce,
// grind_nonce] with args in declaration order and the values returned by
// the circuit's witness invocations pinned after them (AUTH-10) — for the
// two shielded spends that is the held_coin result, which is why their
// builders take the qualified coin. Each builder mirrors one gated circuit.

export const jubjubChallenges = {
  withdrawUnshielded:
    (ctx: CallContext, pk: JubjubPoint, color: Uint8Array, amount: bigint, recipient: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_withdraw_unshielded_with_jubjub(
        addr(ctx), sigR, pk, color, amount, { bytes: recipient }, ctx.authNonce, grind,
      ),

  // The witness-consuming circuits bind the held_coin return value into
  // the challenge (AUTH-10): the approver receives — and signs over — the
  // exact qualified coin the spend will consume (MIP-0013 §5.3).
  withdrawShielded:
    (ctx: CallContext, pk: JubjubPoint, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_withdraw_shielded_with_jubjub(
        addr(ctx), sigR, pk, { bytes: recipient }, color, amount, coin, ctx.authNonce, grind,
      ),

  withdrawShieldedToContract:
    (ctx: CallContext, pk: JubjubPoint, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_withdraw_shielded_to_contract_with_jubjub(
        addr(ctx), sigR, pk, { bytes: recipient }, color, amount, coin, ctx.authNonce, grind,
      ),

  appendInbox:
    (ctx: CallContext, pk: JubjubPoint, entry: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_append_inbox_with_jubjub(addr(ctx), sigR, pk, entry, ctx.authNonce, grind),

  rotateEncKey:
    (ctx: CallContext, pk: JubjubPoint, newKey: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_rotate_enc_key_with_jubjub(addr(ctx), sigR, pk, newKey, ctx.authNonce, grind),

  // The new device travels as its derived entry (a commitment to the key
  // AND its arm), so enrolment across arms needs no per-arm-pair builder.
  addDevice:
    (ctx: CallContext, pk: JubjubPoint, newEntry: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_add_device_with_jubjub(addr(ctx), sigR, pk, newEntry, ctx.authNonce, grind),

  removeDevice:
    (ctx: CallContext, pk: JubjubPoint, commitment: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_remove_device_with_jubjub(addr(ctx), sigR, pk, commitment, ctx.authNonce, grind),
};

// ─────────────────────────────────────────────────────────────────────────────
// Arm k256
// ─────────────────────────────────────────────────────────────────────────────

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

/** The authorising material a k256-arm gated circuit consumes. */
export interface K256Authorisation {
  arm: 'k256';
  pk: Secp256k1Point;
  /** The device's current use counter — the rolling-entry position
   *  (AUTH-9). Not part of the challenge; bound by entry consumption. */
  use_counter: bigint;
  sig: EcdsaSignature;
  /** Connector mode: the signature covers the envelope digest
   *  SHA-256("midnight_signed_message:32:" || challenge) instead of the
   *  challenge itself. Bound into the device's entry derivation, so the
   *  flag is a property of the enrolled device, not of one call. */
  connector: boolean;
}

export class K256Device {
  readonly arm = 'k256' as const;
  readonly pk: Secp256k1Point;

  constructor(readonly sk: bigint, readonly connector = false) {
    this.pk = pureCircuits.compute_public_point_with_k256(sk);
  }

  static generate(): K256Device {
    return new K256Device(randomSecp256k1Scalar());
  }

  /** A device whose key sits behind the dApp-connector `signData`
   *  surface (the `ecdsa_secp256k1_sha256` scheme): signatures cover the
   *  connector envelope digest rather than the raw challenge. */
  static generateConnector(): K256Device {
    return new K256Device(randomSecp256k1Scalar(), true);
  }

  /** The device's rolling entry at a given account/epoch/counter. */
  entryAt(contractAddress: Uint8Array, epoch: bigint, counter: bigint): Uint8Array {
    return pureCircuits.derive_device_entry_with_k256(
      { bytes: contractAddress }, this.pk, this.connector, epoch, counter,
    );
  }

  /** The boot commitment for this device's arm and mode. */
  bootCommitment(salt: Uint8Array): Uint8Array {
    return pureCircuits.derive_boot_commitment_with_k256(salt, this.pk, this.connector);
  }

  /** The 32-byte digest this device actually signs for a challenge: the
   *  challenge itself in raw mode, the connector envelope digest in
   *  connector mode (recomputed through the contract's own exported pure
   *  circuit, so wallet and circuit can never disagree). */
  signedDigest(challenge: Uint8Array): Uint8Array {
    return this.connector
      ? pureCircuits.connector_envelope_digest(challenge)
      : challenge;
  }

  /** ECDSA-sign the digest for the 32-byte challenge (prehashed — the
   *  digest IS the message). `useCounter` is carried alongside for the
   *  seam's entry consumption. */
  sign(challenge: Uint8Array, useCounter: bigint): K256Authorisation {
    const digest = this.signedDigest(challenge);
    const sigBytes = secp256k1.sign(digest, scalarToBytesBE(this.sk), { prehash: false });
    const { r, s } = secp256k1.Signature.fromBytes(sigBytes);
    return {
      arm: 'k256', pk: this.pk, use_counter: useCounter, sig: { r, s },
      connector: this.connector,
    };
  }
}

// Per-circuit challenge digests. Preimage: [DST_CIRCUIT, self, pk_x, pk_y,
// ...args, ...witness_values, auth_nonce] with the same binding discipline
// as the jubjub arm (AUTH-10). Each builder mirrors one gated circuit and
// returns the digest the device signs.

export const k256Challenges = {
  withdrawUnshielded: (ctx: CallContext, pk: Secp256k1Point, color: Uint8Array, amount: bigint, recipient: Uint8Array): Uint8Array =>
    pureCircuits.challenge_withdraw_unshielded_with_k256(
      addr(ctx), pk, color, amount, { bytes: recipient }, ctx.authNonce,
    ),

  withdrawShielded: (ctx: CallContext, pk: Secp256k1Point, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin): Uint8Array =>
    pureCircuits.challenge_withdraw_shielded_with_k256(
      addr(ctx), pk, { bytes: recipient }, color, amount, coin, ctx.authNonce,
    ),

  withdrawShieldedToContract: (ctx: CallContext, pk: Secp256k1Point, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin): Uint8Array =>
    pureCircuits.challenge_withdraw_shielded_to_contract_with_k256(
      addr(ctx), pk, { bytes: recipient }, color, amount, coin, ctx.authNonce,
    ),

  appendInbox: (ctx: CallContext, pk: Secp256k1Point, entry: Uint8Array): Uint8Array =>
    pureCircuits.challenge_append_inbox_with_k256(addr(ctx), pk, entry, ctx.authNonce),

  rotateEncKey: (ctx: CallContext, pk: Secp256k1Point, newKey: Uint8Array): Uint8Array =>
    pureCircuits.challenge_rotate_enc_key_with_k256(addr(ctx), pk, newKey, ctx.authNonce),

  addDevice: (ctx: CallContext, pk: Secp256k1Point, newEntry: Uint8Array): Uint8Array =>
    pureCircuits.challenge_add_device_with_k256(addr(ctx), pk, newEntry, ctx.authNonce),

  removeDevice: (ctx: CallContext, pk: Secp256k1Point, commitment: Uint8Array): Uint8Array =>
    pureCircuits.challenge_remove_device_with_k256(addr(ctx), pk, commitment, ctx.authNonce),
};

// ─────────────────────────────────────────────────────────────────────────────
// Arm-generic surface
// ─────────────────────────────────────────────────────────────────────────────

export type AnyDevice = JubjubDevice | K256Device;
export type Authorisation = JubjubAuthorisation | K256Authorisation;

/** The trailing circuit arguments an Authorisation expands to, in the
 *  order the arm's gated circuits declare them. */
export function authArgs(a: Authorisation): unknown[] {
  return a.arm === 'jubjub'
    ? [a.pk, a.use_counter, a.sig_r, a.sig_s, a.grind_nonce]
    : [a.pk, a.use_counter, a.sig, a.connector];
}
