// VENDORED SLICE — the jubjub device signer.
//
// Adapted from arc-passport branch nicolasdp/ecdsa-k1-arm,
// contract/src/wallet/signer.ts, commit 2b0b55d. Trimmed to the minimal
// signing surface P5 exercises: the jubjub arm only (Schnorr over JubJub,
// the normative MIP-0013 scheme), and only the rotate_enc_key challenge
// builder — the gated coinless witness-free operation with the smallest
// payload (one Bytes<32>).
//
// The signing protocol (MIP-0013 §5), unchanged from upstream:
//   1. sample a nonce scalar r uniformly from [1, r_J)
//   2. compute R = r·G
//   3. grind the challenge: h = persistentHash(preimage(grind_nonce)) for
//      grind_nonce = 0, 1, 2, … until the little-endian integer value of h
//      is strictly below r_J (§5.2), so the in-circuit scalar cast is
//      canonical
//   4. compute s = r + c·sk mod r_J
//   5. output (R, s, grind_nonce)
//
// Challenge preimages are reproduced through the contract's own exported
// pure circuits, so the signer inherits the compiler's field-aligned
// encoding bit-exactly. Signing needs no node, indexer, or prover.

import { randomBytes } from 'node:crypto';

import { pureCircuits, type JubjubPoint } from './contract.js';

/** JubJub prime-order subgroup order r_J (MIP-0013 §2). */
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

export interface CallContext {
  /** The ACCOUNT's contract address, raw bytes (binds the account, AUTH-3).
   *  In call mode this stays the account's address — the challenge binds
   *  kernel.self() as recomputed inside the CALLEE's circuit. */
  contractAddress: Uint8Array;
  /** The auth_nonce the call will execute against (pre-increment, AUTH-2). */
  authNonce: bigint;
}

const addr = (ctx: CallContext) => ({ bytes: ctx.contractAddress });

/** The authorising material a jubjub-arm gated circuit consumes. */
export interface JubjubAuthorisation {
  pk: JubjubPoint;
  /** The device's current use counter — the rolling-entry position
   *  (AUTH-9). Not part of the challenge; bound by entry consumption. */
  use_counter: bigint;
  sig_r: JubjubPoint;
  sig_s: bigint;
  grind_nonce: bigint;
}

/** The trailing circuit arguments an authorisation expands to, in the order
 *  the jubjub arm's gated circuits declare them. */
export function authArgs(a: JubjubAuthorisation): unknown[] {
  return [a.pk, a.use_counter, a.sig_r, a.sig_s, a.grind_nonce];
}

/**
 * A jubjub-arm challenge builder: the per-circuit §5.1 preimage hash,
 * closed over the account address, the circuit's arguments, and the
 * observed auth_nonce. The signer varies only grind_nonce.
 */
export type ChallengeBuilder = (sigR: JubjubPoint, grindNonce: bigint) => Uint8Array;

/** The one challenge construction P5 uses (mirrors the contract's
 *  challenge_rotate_enc_key_with_jubjub pure circuit). */
export function rotateEncKeyChallenge(
  ctx: CallContext,
  pk: JubjubPoint,
  newKey: Uint8Array,
): ChallengeBuilder {
  return (sigR, grind) =>
    pureCircuits.challenge_rotate_enc_key_with_jubjub(addr(ctx), sigR, pk, newKey, ctx.authNonce, grind);
}

export class JubjubDevice {
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
    return { pk: this.pk, use_counter: useCounter, sig_r: sigR, sig_s: s, grind_nonce: grindNonce };
  }
}
