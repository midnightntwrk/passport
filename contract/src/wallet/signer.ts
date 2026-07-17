// Device signer — MIP-0013 §5.
//
// A device holds an independent Schnorr keypair (sk, pk = sk·G) on JubJub
// (§1); keys are never derived from one another or from a seed (AUTH-7).
// To authorise a call the device:
//   1. samples a nonce scalar r uniformly from [1, r_J)   (§5.3, S1)
//   2. computes R = r·G
//   3. grinds the challenge: h = persistentHash(preimage(grind_nonce)) for
//      grind_nonce = 0, 1, 2, … until the little-endian integer value of h
//      is strictly below r_J (§5.2; ~17.5 expected attempts)
//   4. computes s = r + c·sk mod r_J
//   5. outputs (R, s, grind_nonce)
//
// The challenge preimages are reproduced through the contract's own
// exported pure circuits, so the signer inherits the compiler's
// field-aligned encoding bit-exactly (§2). The signing side needs no node,
// indexer, prover, or contract runtime beyond those pure functions — the
// approval/proving separation of R5. Proof generation consumes the
// signature and never sk (AUTH-4).

import { randomBytes } from 'node:crypto';

import { pureCircuits, type JubjubPoint, type QualifiedCoin } from './contract.js';

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

/** The authorising material a gated circuit consumes (MIP-0013 §4). */
export interface Authorisation {
  pk: JubjubPoint;
  /** The device's current use counter — the rolling-entry position
   *  (AUTH-9). Not part of the challenge; bound by entry consumption. */
  use_counter: bigint;
  sig_r: JubjubPoint;
  sig_s: bigint;
  grind_nonce: bigint;
}

/**
 * A challenge builder: the per-circuit §5.1 preimage hash, closed over the
 * account address, the circuit's arguments, and the observed auth_nonce.
 * The signer varies only grind_nonce.
 */
export type ChallengeBuilder = (sigR: JubjubPoint, grindNonce: bigint) => Uint8Array;

export class Device {
  readonly pk: JubjubPoint;

  constructor(readonly sk: bigint) {
    this.pk = pureCircuits.compute_public_point(sk);
  }

  static generate(): Device {
    return new Device(randomJubjubScalar());
  }

  /** The device's rolling entry at a given account/epoch/counter (§3). */
  entryAt(contractAddress: Uint8Array, epoch: bigint, counter: bigint): Uint8Array {
    return pureCircuits.derive_device_entry({ bytes: contractAddress }, this.pk, epoch, counter);
  }

  /** Produce (R, s, grind_nonce) for the call the builder describes.
   *  `useCounter` is carried alongside for the seam's entry consumption. */
  sign(challenge: ChallengeBuilder, useCounter: bigint): Authorisation {
    const r = randomJubjubScalar();
    const sigR = pureCircuits.compute_public_point(r);

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
    return { pk: this.pk, use_counter: useCounter, sig_r: sigR, sig_s: s, grind_nonce: grindNonce };
  }
}

// ── Per-circuit challenge builders (MIP-0013 §5.1) ──────────────────────────
//
// Preimage: [DST_CIRCUIT, self, sig_r, pk, ...args, auth_nonce, grind_nonce]
// with args in declaration order. Each builder mirrors one gated circuit.

export interface CallContext {
  /** The account's contract address, raw bytes (binds the account, AUTH-3). */
  contractAddress: Uint8Array;
  /** The auth_nonce the call will execute against (pre-increment, AUTH-2). */
  authNonce: bigint;
}

const addr = (ctx: CallContext) => ({ bytes: ctx.contractAddress });

export const challenges = {
  withdrawUnshielded:
    (ctx: CallContext, pk: JubjubPoint, color: Uint8Array, amount: bigint, recipient: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_withdraw_unshielded(
        addr(ctx), sigR, pk, color, amount, { bytes: recipient }, ctx.authNonce, grind,
      ),

  // The witness-consuming circuits bind the held_coin return value into
  // the challenge (AUTH-10): the approver receives — and signs over — the
  // exact qualified coin the spend will consume (MIP-0013 §5.3).
  withdrawShielded:
    (ctx: CallContext, pk: JubjubPoint, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_withdraw_shielded(
        addr(ctx), sigR, pk, { bytes: recipient }, color, amount, coin, ctx.authNonce, grind,
      ),

  withdrawShieldedToContract:
    (ctx: CallContext, pk: JubjubPoint, recipient: Uint8Array, color: Uint8Array, amount: bigint, coin: QualifiedCoin): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_withdraw_shielded_to_contract(
        addr(ctx), sigR, pk, { bytes: recipient }, color, amount, coin, ctx.authNonce, grind,
      ),

  appendInbox:
    (ctx: CallContext, pk: JubjubPoint, entry: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_append_inbox(addr(ctx), sigR, pk, entry, ctx.authNonce, grind),

  rotateEncKey:
    (ctx: CallContext, pk: JubjubPoint, newKey: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_rotate_enc_key(addr(ctx), sigR, pk, newKey, ctx.authNonce, grind),

  addDevice:
    (ctx: CallContext, pk: JubjubPoint, newPk: JubjubPoint): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_add_device(addr(ctx), sigR, pk, newPk, ctx.authNonce, grind),

  removeDevice:
    (ctx: CallContext, pk: JubjubPoint, commitment: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_remove_device(addr(ctx), sigR, pk, commitment, ctx.authNonce, grind),
};
