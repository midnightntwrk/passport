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

import { createHash, randomBytes } from 'node:crypto';
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

  // Grant lifecycle (scoped-grants MIP section 6.1): device-gated over
  // auth_nonce in the same tag family. The issue challenge's argument list
  // is [grant_id, scope_digest]: the device signs the salted digest of the
  // sixteen plaintext fields, not the fields themselves.
  issueGrant:
    (ctx: CallContext, pk: JubjubPoint, grantId: Uint8Array, digest: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_issue_grant_with_jubjub(addr(ctx), sigR, pk, grantId, digest, ctx.authNonce, grind),

  revokeGrant:
    (ctx: CallContext, pk: JubjubPoint, grantId: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_revoke_grant_with_jubjub(addr(ctx), sigR, pk, grantId, ctx.authNonce, grind),

  revokeAllGrants:
    (ctx: CallContext, pk: JubjubPoint): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_revoke_all_grants_with_jubjub(addr(ctx), sigR, pk, ctx.authNonce, grind),
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
  /** The device's envelope id: the signature covers
   *  SHA-256(prefix(envelope) || challenge) (`envelope_digest` in the
   *  contract). Bound into the device's entry derivation, so it is a
   *  property of the enrolled device, not of one call. */
  envelope: K256Envelope;
}

/** Envelope 0: no prefix. The digest is plain SHA-256 of the challenge
 *  bytes, i.e. ordinary ECDSA-SHA256 over the challenge as the message. */
export const K256_ENVELOPE_NONE = 0n;
/** Envelope 1: the dApp-connector `signData` envelope, prefix
 *  "midnight_signed_message:32:" (the `ecdsa_secp256k1_sha256` scheme). */
export const K256_ENVELOPE_CONNECTOR = 1n;
export type K256Envelope = typeof K256_ENVELOPE_NONE | typeof K256_ENVELOPE_CONNECTOR;

export class K256Device {
  readonly arm = 'k256' as const;
  readonly pk: Secp256k1Point;

  constructor(readonly sk: bigint, readonly envelope: K256Envelope = K256_ENVELOPE_NONE) {
    this.pk = pureCircuits.compute_public_point_with_k256(sk);
  }

  static generate(): K256Device {
    return new K256Device(randomSecp256k1Scalar());
  }

  /** A device whose key sits behind the dApp-connector `signData`
   *  surface (the `ecdsa_secp256k1_sha256` scheme): envelope 1. */
  static generateConnector(): K256Device {
    return new K256Device(randomSecp256k1Scalar(), K256_ENVELOPE_CONNECTOR);
  }

  /** The device's rolling entry at a given account/epoch/counter. */
  entryAt(contractAddress: Uint8Array, epoch: bigint, counter: bigint): Uint8Array {
    return pureCircuits.derive_device_entry_with_k256(
      { bytes: contractAddress }, this.pk, this.envelope, epoch, counter,
    );
  }

  /** The boot commitment for this device's arm and envelope. */
  bootCommitment(salt: Uint8Array): Uint8Array {
    return pureCircuits.derive_boot_commitment_with_k256(salt, this.pk, this.envelope);
  }

  /** The 32-byte digest this device signs for a challenge:
   *  SHA-256(prefix(envelope) || challenge), recomputed through the
   *  contract's own exported pure circuit so wallet and circuit can never
   *  disagree. Never the challenge itself. */
  signedDigest(challenge: Uint8Array): Uint8Array {
    return pureCircuits.envelope_digest(this.envelope, challenge);
  }

  /** ECDSA-sign the envelope digest of the 32-byte challenge (passed to
   *  the curve library as a prehash, since the envelope hash is already
   *  applied). `useCounter` is carried alongside for the seam's entry
   *  consumption. */
  sign(challenge: Uint8Array, useCounter: bigint): K256Authorisation {
    const digest = this.signedDigest(challenge);
    const sigBytes = secp256k1.sign(digest, scalarToBytesBE(this.sk), { prehash: false });
    const { r, s } = secp256k1.Signature.fromBytes(sigBytes);
    return {
      arm: 'k256', pk: this.pk, use_counter: useCounter, sig: { r, s },
      envelope: this.envelope,
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

  // Grant lifecycle (scoped-grants MIP section 6.1), family
  // `midnight:account:auth:k1:v1:<op>`; see the jubjub builders.
  issueGrant: (ctx: CallContext, pk: Secp256k1Point, grantId: Uint8Array, digest: Uint8Array): Uint8Array =>
    pureCircuits.challenge_issue_grant_with_k256(addr(ctx), pk, grantId, digest, ctx.authNonce),

  revokeGrant: (ctx: CallContext, pk: Secp256k1Point, grantId: Uint8Array): Uint8Array =>
    pureCircuits.challenge_revoke_grant_with_k256(addr(ctx), pk, grantId, ctx.authNonce),

  revokeAllGrants: (ctx: CallContext, pk: Secp256k1Point): Uint8Array =>
    pureCircuits.challenge_revoke_all_grants_with_k256(addr(ctx), pk, ctx.authNonce),
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
    : [a.pk, a.use_counter, a.sig, a.envelope];
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoped grants (the scoped-grants MIP): grantee signers, scope, openings
// ─────────────────────────────────────────────────────────────────────────────
//
// A grant delegates a bounded slice of the account's spend authority to a
// grantee key that holds no device entry. The grant twins
// (`<operation>_with_grant_<arm>`) are gated by a record the owner issued
// through the device seam (`issue_grant_with_<arm>`), and the grantee's
// call opens that record's commitments in the clear as witness data. As on
// the device seam, every preimage is reproduced through the contract's own
// exported pure circuits, so the signer inherits the compiled encoding
// bit-exactly, and the signing side needs no node or prover.
//
// Two rosters coexist and never mix: the DEVICE arm (which device signs
// the lifecycle calls, over auth_nonce) and the GRANTEE arm (which curve
// the grantee key lives on, over the record's own nonce). A k256 owner may
// issue to a jubjub grantee and vice versa.

/** The section 4.4 origin tag; it fills its 32-byte pad exactly. */
export const GRANT_ORIGIN_TAG = 'midnight:account:grant:origin:v1';

/** The tag's ASCII bytes, zero-padded on the right to `width`. */
function padTag(width: number, tag: string): Uint8Array {
  const b = Buffer.from(tag, 'ascii');
  if (b.length > width) throw new Error(`tag exceeds pad width ${width}: ${tag}`);
  const out = new Uint8Array(width);
  out.set(b);
  return out;
}

/**
 * `origin_hash` (section 4.4): SHA-256(pad(32, origin tag) || client_id
 * bytes), the client_id appended raw with no length prefix. Computed off
 * chain only: it is a private argument of the grant twins and of nothing
 * else, so no circuit exports it. The client_id is the normalised origin
 * (scheme, host, and any non-default port, no path); the caller
 * normalises, this function only encodes. Bytes are UTF-8, which for the
 * ASCII origins the reference signer accepts is the same encoding.
 */
export function originHash(clientId: string): Uint8Array {
  const h = createHash('sha256');
  h.update(padTag(32, GRANT_ORIGIN_TAG));
  h.update(Buffer.from(clientId, 'utf8'));
  return new Uint8Array(h.digest());
}

/** `recipient_kind` values of section 4.2. */
export const RECIPIENT_ANY = 0n;
export const RECIPIENT_USER_ADDRESS = 1n;
export const RECIPIENT_ZSWAP_COIN_PUBLIC_KEY = 2n;
export const RECIPIENT_CONTRACT_ADDRESS = 3n;

/**
 * The plaintext scope the approver consents to (section 4.2): the sixteen
 * arguments `issue_grant_with_<arm>` takes after `grant_id`, less the salt.
 * Field names follow the circuit's, camel-cased; `scopeArgs` restores the
 * declaration order.
 */
export interface PlainScope {
  opWithdrawUnshielded: boolean;
  opWithdrawShielded: boolean;
  opWithdrawShieldedToContract: boolean;
  read: boolean;
  /** Token color; all-zero is Night. Zero on a read-only grant. */
  color: Uint8Array;
  /** 0 any, 1 UserAddress, 2 ZswapCoinPublicKey, 3 ContractAddress. */
  recipientKind: bigint;
  /** The `bytes` field of the pinned recipient struct; zero when kind 0. */
  recipient: Uint8Array;
  /** Upper bound on the value of the coin a shielded twin may consume. */
  maxCoinValue: bigint;
  perCallCap: bigint;
  cap: bigint;
  /** Whole seconds since the UNIX epoch; 0 means never. */
  expiresAt: bigint;
  /** SHA-256 of the dApp host for an r1 grantee; zero otherwise. */
  rpIdHash: Uint8Array;
  /** SHA-256 of the delegate's X25519 read_pk when `read`; zero otherwise. */
  readPkHash: Uint8Array;
  /** Reserved; MUST be 0. */
  windowLen: bigint;
  /** Reserved; MUST be 0. */
  windowCap: bigint;
}

const ZERO32 = new Uint8Array(32);

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

/** The sixteen scope arguments in the circuit's declaration order, as
 *  `issue_grant_with_<arm>` and `derive_grant_scope_digest` take them. */
export function scopeArgs(s: PlainScope): [
  boolean, boolean, boolean, boolean,
  Uint8Array, bigint, Uint8Array, bigint, bigint, bigint, bigint,
  Uint8Array, Uint8Array, bigint, bigint,
] {
  return [
    s.opWithdrawUnshielded, s.opWithdrawShielded, s.opWithdrawShieldedToContract, s.read,
    s.color, s.recipientKind, s.recipient, s.maxCoinValue, s.perCallCap, s.cap, s.expiresAt,
    s.rpIdHash, s.readPkHash, s.windowLen, s.windowCap,
  ];
}

/** True when any spend flag is set. */
export function isSpendScope(s: PlainScope): boolean {
  return s.opWithdrawUnshielded || s.opWithdrawShielded || s.opWithdrawShieldedToContract;
}

/**
 * The issue rules of section 5.1, checked client-side in the circuit's
 * order so a refused scope is caught before a device signs over it. Throws
 * with the rule number; the circuit asserts the same predicates.
 */
export function assertIssueRules(s: PlainScope): void {
  const spend = isSpendScope(s);
  const shielded = s.opWithdrawShielded || s.opWithdrawShieldedToContract;
  if (!spend && !s.read) throw new Error('issue rule 1: empty scope (no operation flag and no read)');
  if (shielded && !s.read) throw new Error('issue rule 2: a shielded spend flag requires read');
  if (s.perCallCap > s.cap) throw new Error('issue rule 3: per_call_cap above cap');
  if (spend && (s.cap === 0n || s.maxCoinValue < s.perCallCap)) {
    throw new Error('issue rule 4: a spend grant requires cap > 0 and max_coin_value >= per_call_cap');
  }
  if (s.read && isZero(s.readPkHash)) throw new Error('issue rule 5: read without a delegate key hash');
  if (s.windowLen !== 0n || s.windowCap !== 0n) throw new Error('issue rule 6: window bounds are reserved');
  if (!spend && (
    !isZero(s.color) || s.recipientKind !== 0n || !isZero(s.recipient)
    || s.maxCoinValue !== 0n || s.perCallCap !== 0n || s.cap !== 0n
  )) {
    throw new Error('issue rule 7: a read-only grant carries object fields');
  }
  if (s.recipientKind > 3n) throw new Error('recipient_kind outside 0..3');
  if (s.recipientKind === 0n && !isZero(s.recipient)) throw new Error('recipient given without a recipient kind');
}

/** A read-only grant (section 8): the viewing capability alone, every
 *  object field zero so `object_commit` depends on the salt only (rule 7). */
export function readOnlyScope(opts: {
  readPkHash: Uint8Array;
  expiresAt?: bigint;
  rpIdHash?: Uint8Array;
}): PlainScope {
  const s: PlainScope = {
    opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false,
    read: true,
    color: ZERO32, recipientKind: RECIPIENT_ANY, recipient: ZERO32, maxCoinValue: 0n,
    perCallCap: 0n, cap: 0n, expiresAt: opts.expiresAt ?? 0n,
    rpIdHash: opts.rpIdHash ?? ZERO32, readPkHash: opts.readPkHash,
    windowLen: 0n, windowCap: 0n,
  };
  assertIssueRules(s);
  return s;
}

/**
 * A spend grant. `read` is implied by either shielded flag (rule 2), in
 * which case `readPkHash` is mandatory (rule 5). `perCallCap` and
 * `maxCoinValue` default to `cap`, the MIP's recommendation where the
 * owner can pre-split coins (R7). A pin needs both `recipientKind` and
 * `recipient`; without one the grant admits any recipient.
 */
export function spendScope(opts: {
  withdrawUnshielded?: boolean;
  withdrawShielded?: boolean;
  withdrawShieldedToContract?: boolean;
  color: Uint8Array;
  cap: bigint;
  perCallCap?: bigint;
  maxCoinValue?: bigint;
  recipientKind?: bigint;
  recipient?: Uint8Array;
  expiresAt?: bigint;
  readPkHash?: Uint8Array;
  rpIdHash?: Uint8Array;
}): PlainScope {
  const shielded = !!(opts.withdrawShielded || opts.withdrawShieldedToContract);
  const s: PlainScope = {
    opWithdrawUnshielded: !!opts.withdrawUnshielded,
    opWithdrawShielded: !!opts.withdrawShielded,
    opWithdrawShieldedToContract: !!opts.withdrawShieldedToContract,
    read: shielded || !!opts.readPkHash,
    color: opts.color,
    recipientKind: opts.recipientKind ?? RECIPIENT_ANY,
    recipient: opts.recipient ?? ZERO32,
    maxCoinValue: opts.maxCoinValue ?? opts.cap,
    perCallCap: opts.perCallCap ?? opts.cap,
    cap: opts.cap,
    expiresAt: opts.expiresAt ?? 0n,
    rpIdHash: opts.rpIdHash ?? ZERO32,
    readPkHash: opts.readPkHash ?? ZERO32,
    windowLen: 0n, windowCap: 0n,
  };
  assertIssueRules(s);
  return s;
}

/** `scope_digest` (section 4.5): the seventeen-element salted digest the
 *  issuing device signs over, through the contract's pure circuit. */
export function scopeDigest(scopeSalt: Uint8Array, s: PlainScope): Uint8Array {
  return pureCircuits.derive_grant_scope_digest(scopeSalt, ...scopeArgs(s));
}

/**
 * What the grantee holds to open one grant record, delivered in the issue
 * response and kept in the owner's roster (section 7.5). The identity
 * members (`originHash`, `slot`) ride in the opening: every twin call
 * needs both the identity and the commitment openings, and the response
 * carries them together. `spentPrev` is the only member that moves: after
 * a successful call the grantee advances it by the amount released.
 */
export interface GrantOpening {
  /** `origin_hash` of the grantee's client_id (section 4.4). */
  originHash: Uint8Array;
  /** The grantee slot under that origin (Uint<8>). */
  slot: bigint;
  /** Opens `object_commit`, `rp_commit`, and `spent_commit`. */
  scopeSalt: Uint8Array;
  recipientKind: bigint;
  pinnedRecipient: Uint8Array;
  maxCoinValue: bigint;
  /** The cumulative value released so far, opening the live `spent_commit`. */
  spentPrev: bigint;
}

/** The opening a spend grant's grantee receives for an issued scope. */
export function openingOf(scope: PlainScope, scopeSalt: Uint8Array, originHash: Uint8Array, slot: bigint): GrantOpening {
  return {
    originHash, slot, scopeSalt,
    recipientKind: scope.recipientKind, pinnedRecipient: scope.recipient,
    maxCoinValue: scope.maxCoinValue, spentPrev: 0n,
  };
}

/**
 * The signing context of one grant call (section 6.3): the account, the
 * record's id, and the two record fields the challenge binds, read from
 * the ledger before signing. `grantNonce` is the record's own freshness
 * counter (pre-increment), never `auth_nonce`.
 */
export interface GrantContext {
  contractAddress: Uint8Array;
  grantId: Uint8Array;
  issuedAt: bigint;
  grantNonce: bigint;
}

const gaddr = (g: GrantContext) => ({ bytes: g.contractAddress });

/** The authorising material a k256-arm grant twin consumes. */
export interface K256GrantAuthorisation {
  arm: 'k256';
  pk: Secp256k1Point;
  /** Must be 0 on a spend grant: the seam asserts it (section 3.2). */
  envelope: K256Envelope;
  sig: EcdsaSignature;
}

/** The authorising material a jubjub-arm grant twin consumes. */
export interface JubjubGrantAuthorisation {
  arm: 'jubjub';
  pk: JubjubPoint;
  sig_r: JubjubPoint;
  sig_s: bigint;
  grind_nonce: bigint;
}

export type GrantAuthorisation = K256GrantAuthorisation | JubjubGrantAuthorisation;

/**
 * A grantee key on the k256 arm. Unlike a device it has no use counter
 * and no entry: its authority is the record found under
 * `derive_grant_id_with_k256(self, pk, envelope, origin_hash, slot)`. The
 * envelope enters the identity, so an envelope-1 key is a different
 * grantee from the same key at envelope 0, and the seam refuses a spend
 * from envelope 1 in-circuit. Neither identity encoding of the point is
 * rejected here: the circuit's step-1 guard is the check, and a
 * construction-time guard would only duplicate it.
 */
export class K256Grantee {
  readonly arm = 'k256' as const;
  readonly pk: Secp256k1Point;

  constructor(readonly sk: bigint, readonly envelope: K256Envelope = K256_ENVELOPE_NONE) {
    this.pk = pureCircuits.compute_public_point_with_k256(sk);
  }

  static generate(): K256Grantee {
    return new K256Grantee(randomSecp256k1Scalar());
  }

  /** The v1 identity of this grantee at one account, origin, and slot. */
  grantId(contractAddress: Uint8Array, originHash: Uint8Array, slot: bigint): Uint8Array {
    return pureCircuits.derive_grant_id_with_k256(
      { bytes: contractAddress }, this.pk, this.envelope, originHash, slot,
    );
  }

  /** The digest actually signed: SHA-256(prefix(envelope) || challenge). */
  signedDigest(challenge: Uint8Array): Uint8Array {
    return pureCircuits.envelope_digest(this.envelope, challenge);
  }

  /** ECDSA-sign the envelope digest of a 32-byte grant challenge. */
  sign(challenge: Uint8Array): K256GrantAuthorisation {
    const digest = this.signedDigest(challenge);
    const sigBytes = secp256k1.sign(digest, scalarToBytesBE(this.sk), { prehash: false });
    const { r, s } = secp256k1.Signature.fromBytes(sigBytes);
    return { arm: 'k256', pk: this.pk, envelope: this.envelope, sig: { r, s } };
  }
}

/**
 * Schnorr over JubJub with the grinding rule of MIP-0013 section 5.2: a
 * fresh nonce point, then grind_nonce = 0, 1, 2, ... until the challenge's
 * little-endian value is below r_J. Shared by the grantee signer; the
 * device signer keeps its own loop so its bytes are untouched.
 */
function schnorrSignGrinding(sk: bigint, challenge: ChallengeBuilder): {
  sig_r: JubjubPoint; sig_s: bigint; grind_nonce: bigint;
} {
  const r = randomJubjubScalar();
  const sigR = pureCircuits.compute_public_point_with_jubjub(r);
  let grindNonce = 0n;
  let c: bigint;
  for (;;) {
    const hInt = bytesToBigIntLE(challenge(sigR, grindNonce));
    if (hInt < JUBJUB_R) {
      c = hInt;
      break;
    }
    grindNonce++;
  }
  const s = (r + ((c % JUBJUB_R) * (sk % JUBJUB_R)) % JUBJUB_R) % JUBJUB_R;
  return { sig_r: sigR, sig_s: s, grind_nonce: grindNonce };
}

/**
 * A grantee key on the jubjub arm (the v1 scheme). Its authority is the
 * record under `derive_grant_id_with_jubjub(self, pk, origin_hash, slot)`;
 * there is no envelope. The small-order guard (`[8]pk != O`, section 3.3)
 * is asserted by the circuit's step 1, not at construction: a key sampled
 * by `generate` is in the prime-order subgroup by construction, and a
 * caller-supplied scalar that lands on a small-order point is refused at
 * the seam, which is the check the MIP makes normative.
 */
export class JubjubGrantee {
  readonly arm = 'jubjub' as const;
  readonly pk: JubjubPoint;

  constructor(readonly sk: bigint) {
    this.pk = pureCircuits.compute_public_point_with_jubjub(sk);
  }

  static generate(): JubjubGrantee {
    return new JubjubGrantee(randomJubjubScalar());
  }

  /** The v1 identity of this grantee at one account, origin, and slot. */
  grantId(contractAddress: Uint8Array, originHash: Uint8Array, slot: bigint): Uint8Array {
    return pureCircuits.derive_grant_id_with_jubjub({ bytes: contractAddress }, this.pk, originHash, slot);
  }

  /** Produce (R, s, grind_nonce) for the grant call the builder describes,
   *  grinding exactly as `JubjubDevice.sign` does. */
  sign(challenge: ChallengeBuilder): JubjubGrantAuthorisation {
    return { arm: 'jubjub', pk: this.pk, ...schnorrSignGrinding(this.sk, challenge) };
  }
}

export type AnyGrantee = K256Grantee | JubjubGrantee;

// Grant-twin challenges (section 6.3). Preimage, k256:
// [DST_TWIN, self, pk_x, pk_y, grant_id, issued_at, ...args, [coin], nonce];
// jubjub inserts sig_r after self and appends grind_nonce, as the device
// family does. `args` are the twin's operation arguments in declaration
// order (the shielded twins carry change_entry and enc_pk), and the
// shielded twins bind the held_coin result after them (AUTH-10). The DST
// family is `midnight:account:grant:auth:k1:v1:<op>` (k256) and
// `midnight:account:grant:auth:v1:<op>` (jubjub), disjoint from the device
// families.

export const k256GrantChallenges = {
  withdrawUnshielded: (g: GrantContext, pk: Secp256k1Point, color: Uint8Array, amount: bigint, recipient: Uint8Array): Uint8Array =>
    pureCircuits.challenge_withdraw_unshielded_with_grant_k256(
      gaddr(g), pk, g.grantId, g.issuedAt, color, amount, { bytes: recipient }, g.grantNonce,
    ),

  withdrawShielded: (
    g: GrantContext, pk: Secp256k1Point, recipient: Uint8Array, color: Uint8Array, amount: bigint,
    changeEntry: Uint8Array, encPk: Uint8Array, coin: QualifiedCoin,
  ): Uint8Array =>
    pureCircuits.challenge_withdraw_shielded_with_grant_k256(
      gaddr(g), pk, g.grantId, g.issuedAt, { bytes: recipient }, color, amount, changeEntry, encPk, coin, g.grantNonce,
    ),

  withdrawShieldedToContract: (
    g: GrantContext, pk: Secp256k1Point, recipient: Uint8Array, color: Uint8Array, amount: bigint,
    changeEntry: Uint8Array, encPk: Uint8Array, coin: QualifiedCoin,
  ): Uint8Array =>
    pureCircuits.challenge_withdraw_shielded_to_contract_with_grant_k256(
      gaddr(g), pk, g.grantId, g.issuedAt, { bytes: recipient }, color, amount, changeEntry, encPk, coin, g.grantNonce,
    ),
};

export const jubjubGrantChallenges = {
  withdrawUnshielded:
    (g: GrantContext, pk: JubjubPoint, color: Uint8Array, amount: bigint, recipient: Uint8Array): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_withdraw_unshielded_with_grant_jubjub(
        gaddr(g), sigR, pk, g.grantId, g.issuedAt, color, amount, { bytes: recipient }, g.grantNonce, grind,
      ),

  withdrawShielded:
    (
      g: GrantContext, pk: JubjubPoint, recipient: Uint8Array, color: Uint8Array, amount: bigint,
      changeEntry: Uint8Array, encPk: Uint8Array, coin: QualifiedCoin,
    ): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_withdraw_shielded_with_grant_jubjub(
        gaddr(g), sigR, pk, g.grantId, g.issuedAt, { bytes: recipient }, color, amount, changeEntry, encPk, coin, g.grantNonce, grind,
      ),

  withdrawShieldedToContract:
    (
      g: GrantContext, pk: JubjubPoint, recipient: Uint8Array, color: Uint8Array, amount: bigint,
      changeEntry: Uint8Array, encPk: Uint8Array, coin: QualifiedCoin,
    ): ChallengeBuilder =>
    (sigR, grind) =>
      pureCircuits.challenge_withdraw_shielded_to_contract_with_grant_jubjub(
        gaddr(g), sigR, pk, g.grantId, g.issuedAt, { bytes: recipient }, color, amount, changeEntry, encPk, coin, g.grantNonce, grind,
      ),
};

/**
 * The trailing circuit arguments a grant call expands to, in the section
 * 6.1 order of the grantee's arm:
 *   k256:   pk, envelope, origin_hash, slot, scope_salt, recipient_kind,
 *           pinned_recipient, max_coin_value, spent_prev, sig
 *   jubjub: pk, origin_hash, slot, scope_salt, recipient_kind,
 *           pinned_recipient, max_coin_value, spent_prev, sig_r, sig_s,
 *           grind_nonce
 * The identity members come from the opening (see GrantOpening).
 */
export function grantAuthArgs(o: GrantOpening, a: GrantAuthorisation): unknown[] {
  const openings = [o.scopeSalt, o.recipientKind, o.pinnedRecipient, o.maxCoinValue, o.spentPrev];
  return a.arm === 'k256'
    ? [a.pk, a.envelope, o.originHash, o.slot, ...openings, a.sig]
    : [a.pk, o.originHash, o.slot, ...openings, a.sig_r, a.sig_s, a.grind_nonce];
}
