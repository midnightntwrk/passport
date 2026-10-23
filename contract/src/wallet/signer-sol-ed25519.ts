// Arm `sol_ed25519`: the client facade, arm-owned so that account.ts stays
// unchanged.
//
// THE DEVICE IS A SOLANA WALLET'S PUBLIC KEY: the 32-byte RFC 8032 encoding
// the wallet exports (its base58 address). The contract takes it as a
// Curve25519Point with those 32 bytes and the x-coordinate's bytes as checked
// inputs (`encode_public_key_with_sol_ed25519` compares them with the
// point), so this module decodes the bytes STRICTLY first: canonical y < p,
// on the curve, in the prime-order subgroup, not the identity
// (descriptors.ts `parseSolanaPublicKey`).
//
// THE BLIND. Entries and grant ids bind a per-account
// secret that the wallet re-derives: the wallet signs the readable request
// message of blind.ts (raw bytes, Solana `signMessage`), twice; both
// signatures must verify and be identical (RFC 8032 signing is
// deterministic, so a wallet that is not, for example an MPC or a hedged
// signer, would lose its accounts on restore and is refused at enrolment);
// blind = SHA-256(pad32("midnight:account:blind:sol:v1") || signature). The
// client keeps (network, account index, key, blind) per device in its roster.
//
// Platform-neutral: no node:crypto, so the same code runs in a browser page.

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { curve25519FromProjective, isValidCurve25519Point, type Curve25519Point } from '@midnight-ntwrk/compact-runtime';

import { pureCircuits } from './contract.js';
import { DESCRIPTOR_TAGS, base58Encode, checkDescriptor, grantOriginHash, grantScopeSalt, parseSolanaPublicKey, solDescriptor, type Descriptor, type SolDescriptor } from './descriptors.js';
import { blindMessage, blindMessageBytes, canonicalEd25519Signature, deriveBlind, granteeBlindMessageBytes } from './blind.js';
import {
  assertSafeSolMessage, digitsOf, labelBytes, nibblesOf, solFrameNibbles, solAmountShow, solCoinShow, solDeviceHexValues, solDeviceMessageText,
  solGranteeArg, solGranteeHexValues, solGranteeShow, solGrantShow, solGranteeMessageText, solScopeShow, solShow, solTargetArg,
  solTargetShow, solTargetPointArg, solUnusedKey, type SolAmount, type SolDeviceOperation, type SolGranteeFields, type SolGranteeOperation, type SolTargetFields,
} from './sol-ed25519-message.js';
import type { GrantOpening } from './signer.js';

export type { Curve25519Point };

/** The arm's name: the circuit suffix (`<operation>_with_sol_ed25519`). */
export const SOL_ED25519 = 'sol_ed25519' as const;

/** The order L of the prime-order subgroup (RFC 8032). */
export const ED25519_L: bigint = ed25519.Point.Fn.ORDER;

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string, n: number, what: string): Uint8Array => {
  if (typeof s !== 'string' || s.length !== 2 * n || !/^[0-9a-f]*$/.test(s)) throw new Error(`sol_ed25519: ${what} is ${n} bytes of lower-case hex`);
  return Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
};
const bigLE = (b: Uint8Array): bigint => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };

// ── Keys and signatures: strict decoding (the arm's acceptance policy) ─────

/** The circuit's Curve25519Point for a Solana public key (base58 text or the
 *  32 bytes), decoded strictly: refuses non-canonical encodings, points off
 *  the curve, the identity, and small-order and mixed-order points. */
export function solPublicKeyPoint(key: Uint8Array | string): Curve25519Point {
  const bytes = parseSolanaPublicKey(key);
  const point = curve25519FromProjective(ed25519.Point.fromBytes(bytes, false));
  if (!isValidCurve25519Point(point)) throw new Error('sol_ed25519: the key is not a valid Curve25519Point');
  return { x: point.x, y: point.y };
}

/** The 32-byte RFC 8032 encoding of a Curve25519Point (what the circuit's
 *  `encode_public_key_with_sol_ed25519` checks). */
export function solPublicKeyBytes(pk: Curve25519Point): Uint8Array {
  return ed25519.Point.fromAffine({ x: pk.x, y: pk.y }).toBytes();
}

/** A point's checked byte inputs, each byte as the generated JavaScript takes
 *  a Uint<8>: its 32-byte RFC 8032 encoding (y little-endian, x's parity in
 *  bit 255) and its x-coordinate little-endian. No validity check: the
 *  circuit refuses whatever does not match the point. */
export function solPointInputs(p: Curve25519Point): { bytes: bigint[]; x: bigint[] } {
  const le = (v: bigint) => { const out: bigint[] = []; let x = v; for (let i = 0; i < 32; i++) { out.push(x & 0xffn); x >>= 8n; } return out; };
  const bytes = le(p.y);
  if (p.x & 1n) bytes[31] |= 0x80n;
  return { bytes, x: le(p.x) };
}

/** The key's checked byte inputs (`pk_bytes`, `pk_x`). */
export function solKeyHints(pk: Curve25519Point): { pk_bytes: bigint[]; pk_x: bigint[] } {
  const i = solPointInputs(pk);
  return { pk_bytes: i.bytes, pk_x: i.x };
}

/** An Ed25519 signature as the circuit takes it (the standard library's
 *  Ed25519Signature): R decoded, s below L, never reduced. */
export interface SolSignatureArg { r: Curve25519Point; s: bigint }

/** Decodes a 64-byte RFC 8032 signature strictly: R a canonical encoding of a
 *  prime-order point other than the identity (the arm's `R != O` rule), S
 *  below L (an S + L twin is refused, never reduced). */
export function decodeSolSignature(signature: Uint8Array): SolSignatureArg {
  if (signature.length !== 64) throw new Error('sol_ed25519: a signature is 64 bytes');
  const rBytes = signature.subarray(0, 32);
  let R;
  try { R = ed25519.Point.fromBytes(rBytes, false); } catch (e: any) {
    throw new Error(`sol_ed25519: the signature's R does not decode (strict RFC 8032): ${e?.message ?? e}`);
  }
  if (!equalBytes(R.toBytes(), rBytes)) throw new Error("sol_ed25519: the signature's R is not canonical");
  if (R.is0()) throw new Error("sol_ed25519: the signature's R is the identity");
  if (R.isSmallOrder()) throw new Error("sol_ed25519: the signature's R has small order");
  if (!R.isTorsionFree()) throw new Error("sol_ed25519: the signature's R is not in the prime-order subgroup");
  const s = bigLE(signature.subarray(32, 64));
  if (s >= ED25519_L) throw new Error("sol_ed25519: the signature's S is not below L (refused, never reduced)");
  const r = curve25519FromProjective(R);
  return { r: { x: r.x, y: r.y }, s };
}

/**
 * The client's pre-check (SOL-ED25519.md, section 1):
 * strict decoding of A and of the signature (canonical encodings, A and R
 * in the prime-order subgroup and not the identity, s < L), THEN noble's
 * verification with `{ zip215: false }`. That verification is cofactored
 * ([8][s]B = [8]R + [8][k]A) and on its own accepts signatures under a
 * mixed-order key that the circuit refuses; only together with the torsion
 * checks before it does it equal the circuit's cofactorless rule. Never
 * reduce this to the noble call alone. Throws with a reason; a wallet that
 * signed other bytes, with another key, or in a wrapped format (a Ledger's
 * off-chain envelope) fails here before any proof.
 */
export function verifySolSignature(message: Uint8Array, signature: Uint8Array, key: Uint8Array | string): SolSignatureArg {
  const A = parseSolanaPublicKey(key);
  const sig = decodeSolSignature(signature);
  if (!ed25519.verify(signature, message, A, { zip215: false })) {
    throw new Error('sol_ed25519: the signature does not verify for this key and message');
  }
  return sig;
}

// ── Signers ─────────────────────────────────────────────────────────────────

/** Signs raw bytes and returns the 64-byte signature. Phantom:
 *  `async (m) => (await provider.signMessage(m, 'utf8')).signature`. */
export type SolSignFn = (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export interface SolSigner { publicKey: Uint8Array; sign: SolSignFn }

/** A software signer from a 32-byte RFC 8032 seed (the scheme a Solana
 *  wallet uses). Test keys only. */
export function solSoftwareSigner(seed: Uint8Array): SolSigner {
  if (seed.length !== 32) throw new Error('sol_ed25519: a seed is 32 bytes');
  const s = new Uint8Array(seed);
  return { publicKey: ed25519.getPublicKey(s), sign: (m) => ed25519.sign(m, s) };
}

/** The point of a seed through the CONTRACT's own pure circuit (SHA-512,
 *  clamp, reduce mod L, multiply), and its 32-byte key as the contract's
 *  encoding checks it. */
export function solPublicKeyFromSeed(seed: Uint8Array): { pk: Curve25519Point; key: Uint8Array } {
  if (seed.length !== 32) throw new Error('sol_ed25519: a seed is 32 bytes');
  const pk: Curve25519Point = pureCircuits.compute_public_key_with_sol_ed25519(seed);
  const h = solKeyHints(pk);
  return { pk, key: pureCircuits.encode_public_key_with_sol_ed25519(pk, h.pk_bytes, h.pk_x) };
}

// ── The blind ───────────────────────────────────────────────────────────────

export interface SolBlindRequest {
  /** The Midnight network name the account lives on ("undeployed", "preview", ...). */
  network: string;
  /** 0 for the wallet's first Passport account on this network, then 1, 2, ... */
  accountIndex: bigint | number;
}

export interface SolBlindRecord {
  scheme: 'sol_ed25519';
  network: string;
  accountIndex: bigint;
  key: Uint8Array;
  blind: Uint8Array;
}

/** The request message's text and bytes for a key (blind.ts, v1). */
export function solBlindMessage(key: Uint8Array | string, req: SolBlindRequest): { text: string; bytes: Uint8Array } {
  const identity = parseSolanaPublicKey(key);
  const r = { scheme: 'sol_ed25519' as const, network: req.network, identity, accountIndex: req.accountIndex };
  return { text: blindMessage(r), bytes: blindMessageBytes(r) };
}

/**
 * Enrolment and restore: the wallet signs the request message twice; each
 * signature must pass the pre-check, and the two must be byte-identical
 * (the sign-twice check). The blind is SHA-256 of the blind tag and the raw
 * 64-byte signature, computed here and checked against the contract's own
 * `derive_blind_with_sol_ed25519`.
 */
export async function deriveSolBlind(signer: SolSigner, req: SolBlindRequest): Promise<SolBlindRecord> {
  const key = parseSolanaPublicKey(signer.publicKey);
  const { bytes } = solBlindMessage(key, req);
  const first = new Uint8Array(await signer.sign(new Uint8Array(bytes)));
  verifySolSignature(bytes, first, key);
  const second = new Uint8Array(await signer.sign(new Uint8Array(bytes)));
  verifySolSignature(bytes, second, key);
  const a = canonicalEd25519Signature(first);
  const b = canonicalEd25519Signature(second);
  if (!equalBytes(a, b)) {
    throw new Error('sol_ed25519: the wallet signed the same message twice with different signatures (not deterministic); refused, it could not restore its accounts');
  }
  const blind = deriveBlind('sol_ed25519', a);
  const viaContract: Uint8Array = pureCircuits.derive_blind_with_sol_ed25519(a);
  if (!equalBytes(blind, viaContract)) throw new Error('sol_ed25519: blind differs from the contract derivation');
  return { scheme: 'sol_ed25519', network: req.network, accountIndex: BigInt(req.accountIndex), key, blind };
}

// ── The device ──────────────────────────────────────────────────────────────

export interface SolDeviceOptions {
  /** The wallet's public key: the 32 bytes or its base58 address. */
  publicKey: Uint8Array | string;
  /** The account's blind (deriveSolBlind). */
  blind: Uint8Array;
  /** The wallet's signMessage; absent for a key known by its public half only. */
  sign?: SolSignFn;
}

export class SolEd25519Device {
  readonly arm = SOL_ED25519;
  /** The 32-byte RFC 8032 key (what the wallet exports and the entry binds). */
  readonly key: Uint8Array;
  /** The circuit's point for the key. */
  readonly pk: Curve25519Point;
  readonly blind: Uint8Array;
  private readonly signFn?: SolSignFn;

  constructor(opts: SolDeviceOptions) {
    this.key = parseSolanaPublicKey(opts.publicKey);
    this.pk = solPublicKeyPoint(this.key);
    if (!(opts.blind instanceof Uint8Array) || opts.blind.length !== 32) throw new Error('sol_ed25519: a blind is 32 bytes');
    this.blind = new Uint8Array(opts.blind);
    this.signFn = opts.sign;
  }

  /** A device from a software signer and its blind record. */
  static fromSigner(signer: SolSigner, record: SolBlindRecord): SolEd25519Device {
    if (!equalBytes(parseSolanaPublicKey(signer.publicKey), record.key)) throw new Error('sol_ed25519: the blind record is for another key');
    return new SolEd25519Device({ publicKey: record.key, blind: record.blind, sign: signer.sign });
  }

  /** The base58 address a Solana wallet shows. */
  get address(): string { return base58Encode(this.key); }

  /** The readable descriptor another readable arm shows for this device. */
  descriptor(): SolDescriptor { return solDescriptor(this.key, this.blind); }

  /** The key's checked byte inputs. */
  get keyHints(): { pk_bytes: bigint[]; pk_x: bigint[] } { return solKeyHints(this.pk); }

  entryAt(contractAddress: Uint8Array, epoch: bigint, counter: bigint): Uint8Array {
    const h = this.keyHints;
    return pureCircuits.derive_device_entry_with_sol_ed25519({ bytes: contractAddress }, this.pk, h.pk_bytes, h.pk_x, this.blind, epoch, counter);
  }

  bootCommitment(salt: Uint8Array): Uint8Array {
    const h = this.keyHints;
    return pureCircuits.derive_boot_commitment_with_sol_ed25519(salt, this.pk, h.pk_bytes, h.pk_x, this.blind);
  }

  grantId(contractAddress: Uint8Array, originHash: Uint8Array, slot: bigint): Uint8Array {
    const h = this.keyHints;
    return pureCircuits.derive_grant_id_with_sol_ed25519({ bytes: contractAddress }, this.pk, h.pk_bytes, h.pk_x, this.blind, originHash, slot);
  }

  /** `activate_initial_device_with_sol_ed25519(pk, pk_bytes, pk_x, salt, blind)`. */
  activationArgs(salt: Uint8Array): [Curve25519Point, bigint[], bigint[], Uint8Array, Uint8Array] {
    if (salt.length !== 32) throw new Error('sol_ed25519: a salt is 32 bytes');
    const h = this.keyHints;
    return [this.pk, h.pk_bytes, h.pk_x, new Uint8Array(salt), this.blind];
  }

  /** Asks the wallet to sign raw bytes and runs the pre-check on the result. */
  async signBytes(message: Uint8Array): Promise<{ signature: Uint8Array; sig: SolSignatureArg }> {
    if (!this.signFn) throw new Error('sol_ed25519: this device has no signer');
    const signature = new Uint8Array(await this.signFn(new Uint8Array(message)));
    return { signature, sig: verifySolSignature(message, signature, this.key) };
  }
}

// ── The roster (key, blind and account index per device) ──────────────────

export interface SolRosterEntryJson {
  scheme: 'sol_ed25519';
  network: string;
  accountIndex: string;
  key: string;
  blind: string;
  /** The account's contract address, once deployed (hex). */
  account?: string;
}

/** Serialises a blind record (plus the account, once known) for storage. */
export function solRosterEntry(record: SolBlindRecord, account?: Uint8Array): SolRosterEntryJson {
  return {
    scheme: 'sol_ed25519', network: record.network, accountIndex: record.accountIndex.toString(),
    key: toHex(record.key), blind: toHex(record.blind), ...(account ? { account: toHex(account) } : {}),
  };
}

/** Parses a stored roster entry strictly. */
export function parseSolRosterEntry(json: SolRosterEntryJson): SolBlindRecord & { account?: Uint8Array } {
  if (json?.scheme !== 'sol_ed25519') throw new Error('sol_ed25519: not a sol_ed25519 roster entry');
  if (!/^(0|[1-9][0-9]{0,9})$/.test(json.accountIndex) || BigInt(json.accountIndex) > 0xffffffffn) throw new Error('sol_ed25519: bad account index');
  const record: SolBlindRecord & { account?: Uint8Array } = {
    scheme: 'sol_ed25519', network: json.network, accountIndex: BigInt(json.accountIndex),
    key: parseSolanaPublicKey(fromHex(json.key, 32, 'key')), blind: fromHex(json.blind, 32, 'blind'),
  };
  solBlindMessage(record.key, record);
  if (json.account !== undefined) record.account = fromHex(json.account, 32, 'account');
  return record;
}

// ── Authorisations (registered in signer.ts; the seam's arguments) ─────────
//
// A gated circuit's trailing arguments are the display inputs of its message
// (in the circuit's order), then the authorising material as one struct.

/** The authorising material a `sol_ed25519` device-gated circuit consumes. */
export interface SolEd25519Authorisation {
  arm: 'sol_ed25519';
  pk: Curve25519Point;
  blind: Uint8Array;
  /** The device's current use counter: the rolling-entry position (AUTH-9). */
  use_counter: bigint;
  sig: SolSignatureArg;
  /** The message's display inputs, in the circuit's argument order. */
  showArgs: unknown[];
  /** Exactly what the wallet showed and signed. Not a circuit argument. */
  message: Uint8Array;
  text: string;
}

/** The authorising material a `sol_ed25519` grantee twin consumes. */
export interface SolEd25519GrantAuthorisation {
  arm: 'sol_ed25519';
  pk: Curve25519Point;
  blind: Uint8Array;
  label: Uint8Array;
  sig: SolSignatureArg;
  showArgs: unknown[];
  message: Uint8Array;
  text: string;
}

/** The verification's checked byte inputs for a signature: R's 32-byte RFC
 *  8032 encoding (for an accepted signature, its first 32 bytes) and R's
 *  x-coordinate little-endian, each as 32 bytes. */
export function solSignatureHints(sig: SolSignatureArg): { r_bytes: bigint[]; r_x: bigint[] } {
  const i = solPointInputs(sig.r);
  return { r_bytes: i.bytes, r_x: i.x };
}

/** The trailing circuit arguments of a device-gated call. */
export function solEd25519AuthArgs(a: SolEd25519Authorisation): unknown[] {
  return [...a.showArgs, { pk: a.pk, ...solKeyHints(a.pk), blind: a.blind, use_counter: a.use_counter, sig: a.sig, ...solSignatureHints(a.sig) }];
}

/** The trailing circuit arguments of a grantee twin: the grant openings
 *  (slot, scope salt, recipient kind and pin, max coin value, spent so far),
 *  the display inputs, then the authorising material. */
export function solEd25519GrantAuthArgs(o: GrantOpening, a: SolEd25519GrantAuthorisation): unknown[] {
  return [o.slot, o.scopeSalt, o.recipientKind, o.pinnedRecipient, o.maxCoinValue, o.spentPrev,
    ...a.showArgs, { pk: a.pk, ...solKeyHints(a.pk), blind: a.blind, label: a.label, sig: a.sig, ...solSignatureHints(a.sig) }];
}

// ── Messages through the contract's own circuits ──────────────────────────

export interface SolCallContext { contractAddress: Uint8Array; authNonce: bigint }
export interface SolGrantCallContext { contractAddress: Uint8Array; label: string; slot: bigint; issuedAt: bigint; grantNonce: bigint }

/** The message of a device-role operation as the CONTRACT renders it, and the
 *  display inputs (circuit order) it was rendered from. */
export function solDeviceMessageCircuit(key: Uint8Array, ctx: SolCallContext, site: string, o: SolDeviceOperation): { bytes: Uint8Array; showArgs: unknown[] } {
  const pc: any = pureCircuits;
  const self = { bytes: ctx.contractAddress };
  const show = solShow(site, ctx.authNonce);
  const frame = solFrameNibbles(ctx.contractAddress, key);
  const hex = nibblesOf(...solDeviceHexValues(o));
  const base = [self, key, ctx.authNonce];
  let shows: unknown[];
  let bytes: Uint8Array;
  switch (o.op) {
    case 'rotate_enc_key': shows = [show]; bytes = pc.sol_message_rotate_enc_key(...base, o.newKey, show, frame, hex); break;
    case 'append_inbox': shows = [show]; bytes = pc.sol_message_append_inbox(...base, o.entry, show, frame, hex); break;
    case 'withdraw_unshielded': {
      const a = solAmountShow(o.amount); shows = [a, show];
      bytes = pc.sol_message_withdraw_unshielded(...base, o.amount.color, o.amount.amount, { bytes: o.recipient }, a, show, frame, hex); break;
    }
    case 'withdraw_shielded': case 'withdraw_shielded_to_contract': {
      const a = solAmountShow(o.amount), c = solCoinShow(o.coin, o.amount.amount); shows = [a, c, show];
      const f = o.op === 'withdraw_shielded' ? pc.sol_message_withdraw_shielded : pc.sol_message_withdraw_shielded_to_contract;
      bytes = f(...base, { bytes: o.recipient }, o.amount.color, o.amount.amount, o.coin, a, c, show, frame, hex); break;
    }
    case 'add_device': {
      const ts = solTargetShow(o.target); shows = [ts, show];
      bytes = pc.sol_message_add_device(...base, solTargetArg(o.target), ts, show, frame, hex); break;
    }
    case 'remove_device': {
      if (o.literal) {
        const ts = solTargetShow({ tag: '' }); shows = [ts, show];
        bytes = pc.sol_message_remove_device(...base, true, solTargetArg({ tag: '' }), 0n, 0n, (o as Extract<SolDeviceOperation, { literal: true }>).entry, ts, show, frame, hex);
      } else {
        const d = o as Extract<SolDeviceOperation, { literal: false }>;
        const ts = solTargetShow(d.target, d.counter, d.epoch); shows = [ts, show];
        bytes = pc.sol_message_remove_device(...base, false, solTargetArg(d.target), d.counter, d.epoch, new Uint8Array(32), ts, show, frame, hex);
      }
      break;
    }
    case 'issue_grant': {
      const gs = solGranteeShow(o.grantee), ss = solScopeShow(o); shows = [gs, ss, show];
      bytes = pc.sol_message_issue_grant(...base, solGranteeArg(o.grantee), o.opWithdrawUnshielded, o.opWithdrawShielded,
        o.opWithdrawShieldedToContract, o.read, o.color, o.recipientKind, o.recipient, o.maxCoinValue, o.perCallCap, o.cap, o.expiresAt,
        o.rpIdHash, o.readPk, o.windowLen, o.windowCap, { is_some: o.caller !== null, value: { bytes: o.caller ?? new Uint8Array(32) } }, gs, ss, show, frame, hex);
      break;
    }
    case 'revoke_grant': {
      const gs = solGranteeShow(o.grantee); shows = [gs, show];
      bytes = pc.sol_message_revoke_grant(...base, solGranteeArg(o.grantee), gs, show, frame, hex); break;
    }
    case 'revoke_all_grants': shows = [show]; bytes = pc.sol_message_revoke_all_grants(...base, show, frame); break;
    case 'publish_recovery_session': {
      const d = digitsOf(o.phiLen, 3); shows = [d, show];
      bytes = pc.sol_message_publish_recovery_session(...base, o.recoveryPk, o.sessionNonce, ...o.phi, o.phiLen, o.wrap, d, show, frame, hex); break;
    }
    case 'recover_cancel': shows = [show]; bytes = pc.sol_message_recover_cancel(...base, show, frame); break;
  }
  const noHex = o.op === 'revoke_all_grants' || o.op === 'recover_cancel';
  return { bytes, showArgs: noHex ? [...shows, frame] : [...shows, frame, hex] };
}

/** The message of a grantee-role operation as the CONTRACT renders it. */
export function solGranteeMessageCircuit(key: Uint8Array, ctx: SolGrantCallContext, site: string, o: SolGranteeOperation): { bytes: Uint8Array; showArgs: unknown[] } {
  const pc: any = pureCircuits;
  const show = solShow(site, ctx.grantNonce), g = solGrantShow(ctx.label, ctx.slot, ctx.issuedAt);
  const frame = solFrameNibbles(ctx.contractAddress, key);
  const hex = nibblesOf(...solGranteeHexValues(o));
  const base = [{ bytes: ctx.contractAddress }, key, labelBytes(ctx.label), ctx.slot, ctx.issuedAt, ctx.grantNonce];
  const a = solAmountShow(o.amount);
  if (o.op === 'withdraw_unshielded_with_grant') {
    return { showArgs: [a, show, g, frame, hex], bytes: pc.sol_message_withdraw_unshielded_with_grant(...base, o.amount.color, o.amount.amount, { bytes: o.recipient }, a, show, g, frame, hex) };
  }
  const c = solCoinShow(o.coin, o.amount.amount);
  const f = o.op === 'withdraw_shielded_with_grant' ? pc.sol_message_withdraw_shielded_with_grant : pc.sol_message_withdraw_shielded_to_contract_with_grant;
  return { showArgs: [a, c, show, g, frame, hex], bytes: f(...base, { bytes: o.recipient }, o.amount.color, o.amount.amount, o.changeEntry, o.encPk, o.coin, a, c, show, g, frame, hex) };
}

const asText = (b: Uint8Array) => String.fromCharCode(...b);

/**
 * Authorises one device-gated call: renders the message with the contract's
 * circuit AND the independent renderer and refuses any difference; refuses a
 * message that could be read as a Solana transaction or off-chain message;
 * asks the wallet; runs the pre-check (strict R, s < L, R != O, the signature
 * verifies over exactly these bytes).
 */
export async function authoriseSolDevice(device: SolEd25519Device, ctx: SolCallContext, site: string, o: SolDeviceOperation, useCounter: bigint): Promise<SolEd25519Authorisation> {
  const { bytes, showArgs } = solDeviceMessageCircuit(device.key, ctx, site, o);
  const text = solDeviceMessageText({ site, account: ctx.contractAddress, key: device.key, nonce: ctx.authNonce }, o);
  if (asText(bytes) !== text) throw new Error('sol_ed25519: the contract and the renderer disagree on the message; refused');
  assertSafeSolMessage(bytes);
  const { sig } = await device.signBytes(bytes);
  return { arm: 'sol_ed25519', pk: device.pk, blind: device.blind, use_counter: useCounter, sig, showArgs, message: bytes, text };
}

/** The same for a grantee twin. */
export async function authoriseSolGrantee(device: SolEd25519Device, ctx: SolGrantCallContext, site: string, o: SolGranteeOperation): Promise<SolEd25519GrantAuthorisation> {
  const { bytes, showArgs } = solGranteeMessageCircuit(device.key, ctx, site, o);
  const text = solGranteeMessageText({ site, account: ctx.contractAddress, key: device.key, label: ctx.label, slot: ctx.slot, issuedAt: ctx.issuedAt, nonce: ctx.grantNonce }, o);
  if (asText(bytes) !== text) throw new Error('sol_ed25519: the contract and the renderer disagree on the message; refused');
  assertSafeSolMessage(bytes);
  const { sig } = await device.signBytes(bytes);
  return { arm: 'sol_ed25519', pk: device.pk, blind: device.blind, label: labelBytes(ctx.label), sig, showArgs, message: bytes, text };
}

// ── CustodyAccount helpers ─────────────────────────────────────────────────
//
// CustodyAccount (account.ts) routes each `*WithAuth` call to
// `<operation>_with_sol_ed25519` through the registered authArgs branch, so
// the operands go first and this arm's display inputs and authorisation
// follow. What it cannot do for this arm is render the message and find the
// device's use counter; these helpers do, so account.ts stays unchanged.

/** The surface of a CustodyAccount these helpers use. */
export interface SolEd25519AccountSurface {
  addressBytes: Uint8Array;
  ledgerState(): Promise<{ auth_nonce: bigint; device_epoch: bigint; devices: { member(e: Uint8Array): boolean } }>;
}

/** The custody surface: CustodyAccount's `*WithAuth` calls and its
 *  coin store's `heldCoin` (the coin the held_coin witness will return). */
export interface SolEd25519CustodySurface extends SolEd25519AccountSurface {
  rotateEncKeyWithAuth(newKey: Uint8Array, a: SolEd25519Authorisation): Promise<{ txId: string }>;
  appendInboxWithAuth(entry: Uint8Array, a: SolEd25519Authorisation): Promise<{ txId: string }>;
  withdrawUnshieldedWithAuth(color: Uint8Array, amount: bigint, recipient: Uint8Array, a: SolEd25519Authorisation): Promise<{ txId: string }>;
  withdrawShieldedWithAuth(recipient: Uint8Array, color: Uint8Array, amount: bigint, a: SolEd25519Authorisation): Promise<{ txId: string; change: unknown }>;
  withdrawShieldedToContractWithAuth(recipient: Uint8Array, color: Uint8Array, amount: bigint, a: SolEd25519Authorisation): Promise<{ txId: string; sent: unknown; change: unknown }>;
  heldCoin(color: Uint8Array): Promise<{ nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint }>;
}

/** How far the restore scan and the counter resolver look (one bound). */
export const SOL_ED25519_COUNTER_SCAN = 4096n;

/** The device's current use counter: the first counter whose entry is live
 *  at the current epoch (MIP-0013 S11 rescan). */
export async function resolveSolEd25519Counter(account: SolEd25519AccountSurface, device: SolEd25519Device, limit = SOL_ED25519_COUNTER_SCAN): Promise<bigint> {
  const l = await account.ledgerState();
  for (let k = 0n; k < limit; k++) {
    if (l.devices.member(device.entryAt(account.addressBytes, l.device_epoch, k))) return k;
  }
  throw new Error('sol_ed25519: no live entry for this device (rescan limit reached)');
}

/** Authorises the next device-gated call of `device` on `account`: the
 *  ledger's auth_nonce, the resolved counter, the message, the signature. */
export async function authoriseSolDeviceOn(account: SolEd25519AccountSurface, device: SolEd25519Device, site: string, o: SolDeviceOperation): Promise<SolEd25519Authorisation> {
  const l = await account.ledgerState();
  const counter = await resolveSolEd25519Counter(account, device);
  return authoriseSolDevice(device, { contractAddress: account.addressBytes, authNonce: l.auth_nonce }, site, o, counter);
}

/** The coin a shielded spend will consume, as the message shows it. Refuses
 *  a stored coin of another colour at the client (the circuit asserts it
 *  too). */
export async function solSpentCoin(account: SolEd25519CustodySurface, color: Uint8Array) {
  const c = await account.heldCoin(color);
  if (!equalBytes(c.color, color)) throw new Error('sol_ed25519: the held coin is not of the withdrawn colour');
  return { nonce: c.nonce, color: c.color, value: c.value, mt_index: c.mt_index };
}

/** rotate_enc_key_with_sol_ed25519 through a CustodyAccount. */
export async function rotateEncKeyWithSolEd25519(account: SolEd25519CustodySurface, device: SolEd25519Device, site: string, newKey: Uint8Array) {
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'rotate_enc_key', newKey });
  return { auth, ...(await account.rotateEncKeyWithAuth(newKey, auth)) };
}

/** append_inbox_with_sol_ed25519: the 192-byte entry in full. */
export async function appendInboxWithSolEd25519(account: SolEd25519CustodySurface, device: SolEd25519Device, site: string, entry: Uint8Array) {
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'append_inbox', entry });
  return { auth, ...(await account.appendInboxWithAuth(entry, auth)) };
}

/** withdraw_unshielded_with_sol_ed25519 to a 32-byte user address. `amount`
 *  carries the site's decimals and symbol (shown as the site's claim). */
export async function withdrawUnshieldedWithSolEd25519(account: SolEd25519CustodySurface, device: SolEd25519Device, site: string, amount: SolAmount, recipient: Uint8Array) {
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'withdraw_unshielded', amount, recipient });
  return { auth, ...(await account.withdrawUnshieldedWithAuth(amount.color, amount.amount, recipient, auth)) };
}

/** withdraw_shielded_with_sol_ed25519 to a Zswap coin public key: the
 *  message shows the coin the store holds for the colour (nonce, value,
 *  Merkle index) and the change. */
export async function withdrawShieldedWithSolEd25519(account: SolEd25519CustodySurface, device: SolEd25519Device, site: string, amount: SolAmount, recipient: Uint8Array) {
  const coin = await solSpentCoin(account, amount.color);
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'withdraw_shielded', amount, recipient, coin });
  return { auth, coin, ...(await account.withdrawShieldedWithAuth(recipient, amount.color, amount.amount, auth)) };
}

/** withdraw_shielded_to_contract_with_sol_ed25519 (direct transfer, MIP-0012
 *  §6.6): the authorisation only, because the call must be composed with the
 *  recipient contract's claim in one transaction. */
export async function authoriseWithdrawShieldedToContractSol(account: SolEd25519CustodySurface, device: SolEd25519Device, site: string, amount: SolAmount, recipientContract: Uint8Array) {
  const coin = await solSpentCoin(account, amount.color);
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'withdraw_shielded_to_contract', amount, recipient: recipientContract, coin });
  return { auth, coin };
}

// ── Device lifecycle ──────────────────────────────────────────────────────
//
// add_device_with_sol_ed25519 and remove_device_with_sol_ed25519 take the
// other key as a readable descriptor, not an entry: the circuit
// derives the entry from it with the target scheme's own recipe. Their ABI
// differs from upstream's add/remove_device(entry), so CustodyAccount's
// entry-typed helpers cannot reach them; these call the circuits directly.

/** A CustodyAccount's call surface (the circuit handle's callTx). */
export interface SolEd25519LifecycleSurface extends SolEd25519AccountSurface {
  callTx: Record<string, (...args: unknown[]) => Promise<any>>;
}

const le32 = (v: bigint): Uint8Array => { const o = new Uint8Array(32); let x = v; for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const txIdOf = (r: any): string => {
  const id = r?.public?.txId ?? r?.public?.transactionHash;
  if (!id) throw new Error('sol_ed25519: the call returned no transaction id');
  return id;
};

/** The message-level target of a readable descriptor (the circuit's
 *  SolTarget): the target scheme's registered device tag and its key fields,
 *  coordinates little-endian as the recipes bind them (the message shows
 *  secp256k1 and P-256 big-endian). A passkey target needs its policy. */
/** The five registered descriptor schemes; anything else is refused before
 *  any message is built (the base's checkDescriptor returns nothing for an
 *  unknown scheme, so the facade must not rely on it to throw). */
const SOL_REGISTERED_SCHEMES: readonly string[] = ['jubjub', 'k256', 'p256', 'evm_eip712', 'sol_ed25519'];
function requireRegisteredScheme<T>(d: T): T {
  const scheme = (d as any)?.scheme;
  if (typeof scheme !== 'string' || !SOL_REGISTERED_SCHEMES.includes(scheme)) {
    throw new Error(`sol_ed25519: not a registered descriptor scheme (${String(scheme)})`);
  }
  return d;
}

export function solTargetOf(d: Descriptor): SolTargetFields {
  requireRegisteredScheme(d);
  const tag = DESCRIPTOR_TAGS.device[d.scheme];
  switch (d.scheme) {
    case 'jubjub': return { tag, a: le32(d.x), b: le32(d.y) };
    case 'k256': return { tag, a: le32(d.x), b: le32(d.y), envelope: BigInt(d.envelope) };
    case 'p256': {
      if (!d.policy) throw new Error('sol_ed25519: a passkey target needs its policy (RP hash and origin)');
      return { tag, a: le32(d.x), b: le32(d.y), c: new Uint8Array(d.policy.rpIdHash), origin: new Uint8Array(d.policy.origin) };
    }
    case 'evm_eip712': return { tag, address: new Uint8Array(d.address), a: new Uint8Array(d.blind) };
    case 'sol_ed25519': return { tag, a: new Uint8Array(d.key), b: new Uint8Array(d.blind) };
    default: throw new Error(`sol_ed25519: not a registered descriptor scheme (${String((d as any).scheme)})`);
  }
}

/** add_device_with_sol_ed25519: the message ("gives this device FULL
 *  control of this account" and the target's descriptor), signed, then the
 *  call; the circuit enrols the target at the current epoch and counter 0. */
export async function addDeviceWithSolEd25519(account: SolEd25519LifecycleSurface, device: SolEd25519Device, site: string, target: Descriptor) {
  const t = solTargetOf(checkDescriptor(requireRegisteredScheme(target)));
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'add_device', target: t });
  const r = await account.callTx.add_device_with_sol_ed25519(solTargetArg(t), solTargetPointArg(t), ...solEd25519AuthArgs(auth));
  return { auth, target: t, txId: txIdOf(r) };
}

/** remove_device_with_sol_ed25519, descriptor form: the target's entry at
 *  (epoch, counter); the epoch may be a future one (removal only reduces
 *  authority). */
export async function removeDeviceWithSolEd25519(
  account: SolEd25519LifecycleSurface, device: SolEd25519Device, site: string, target: Descriptor, epoch: bigint, counter: bigint,
) {
  const t = solTargetOf(checkDescriptor(requireRegisteredScheme(target)));
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'remove_device', literal: false, target: t, counter, epoch });
  const r = await account.callTx.remove_device_with_sol_ed25519(false, solTargetArg(t), solTargetPointArg(t), counter, epoch, new Uint8Array(32), ...solEd25519AuthArgs(auth));
  return { auth, target: t, txId: txIdOf(r) };
}

/** remove_device_with_sol_ed25519, literal form: an entry this wallet
 *  cannot describe, under "Removes a device this wallet cannot identify". */
export async function removeUnknownDeviceWithSolEd25519(account: SolEd25519LifecycleSurface, device: SolEd25519Device, site: string, entry: Uint8Array) {
  if (!(entry instanceof Uint8Array) || entry.length !== 32) throw new Error('sol_ed25519: an entry is 32 bytes');
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'remove_device', literal: true, entry: new Uint8Array(entry) });
  const r = await account.callTx.remove_device_with_sol_ed25519(true, solTargetArg({ tag: '' }), solUnusedKey(), 0n, 0n, new Uint8Array(entry), ...solEd25519AuthArgs(auth));
  return { auth, txId: txIdOf(r) };
}

// ── Scoped grants ────────────────────────────────────────────────────────────
//
// The grantee is a readable descriptor with its site and
// slot: a readable grantee (evm_eip712, sol_ed25519) by its 32-byte site
// label (shown as text), a passkey by its 21-byte origin (shown as text; its
// RP is a scope field), a k256 or JubJub grantee by the labelled origin hash
// of its client id. A Solana grantee also passes its point.

/** Where a grant's origin_hash comes from (one per grantee class). */
export type SolGranteeSite = { label: string } | { origin: Uint8Array } | { originHash: Uint8Array };

/** The message-level grantee of a readable descriptor at a site and slot. */
export function solGranteeOf(descriptor: Descriptor, site: SolGranteeSite, slot: bigint): SolGranteeFields {
  // the strict parsers (a point on its curve, a Solana key that decodes, a
  // passkey origin of visible ASCII), as the device facade does
  const d = checkDescriptor(requireRegisteredScheme(descriptor));
  const tag = DESCRIPTOR_TAGS['grant-id'][d.scheme];
  const need = <K extends string>(k: K): any => {
    if (!(k in site)) throw new Error(`sol_ed25519: a ${d.scheme} grantee is identified by its ${k}`);
    return (site as any)[k];
  };
  switch (d.scheme) {
    case 'evm_eip712': return { tag, address: new Uint8Array(d.address), a: new Uint8Array(d.blind), label: need('label'), slot };
    case 'sol_ed25519': return { tag, a: new Uint8Array(d.key), b: new Uint8Array(d.blind), label: need('label'), slot };
    case 'jubjub': return { tag, a: le32(d.x), b: le32(d.y), originHash: new Uint8Array(need('originHash')), slot };
    case 'k256': return { tag, a: le32(d.x), b: le32(d.y), envelope: BigInt(d.envelope), originHash: new Uint8Array(need('originHash')), slot };
    case 'p256': {
      // the grantee's site origin passes the base's passkey-origin rule (21
      // bytes, visible ASCII without quotes or backslashes),
      // checked through checkDescriptor's policy branch (the RP hash is a
      // scope field, so a placeholder stands in for it here)
      const origin = new Uint8Array(need('origin'));
      checkDescriptor({ scheme: 'p256', x: d.x, y: d.y, policy: { rpIdHash: new Uint8Array(32), origin } } as Descriptor);
      return { tag, a: le32(d.x), b: le32(d.y), origin, slot };
    }
    default: throw new Error(`sol_ed25519: not a registered descriptor scheme (${String((d as any).scheme)})`);
  }
}

/** A grant scope as the issuer approves it (the read key itself, not its hash). */
export interface SolIssueScope {
  opWithdrawUnshielded: boolean; opWithdrawShielded: boolean; opWithdrawShieldedToContract: boolean; read: boolean;
  color: Uint8Array; recipientKind: bigint; recipient: Uint8Array; maxCoinValue: bigint; perCallCap: bigint; cap: bigint;
  expiresAt: bigint; rpIdHash: Uint8Array; readPk: Uint8Array; windowLen: bigint; windowCap: bigint; caller: Uint8Array | null;
}

/** The scope salt issue_grant_with_sol_ed25519 derives in-circuit for a
 *  grant issued by the device with `blind` on `account` at `authNonce` (the
 *  nonce the device signs): the base's grantScopeSalt under the arm's salt
 *  tag. The issuing client hands it to the grantee, which needs it to open
 *  the grant's commitments when it spends; nobody chooses it. */
export function solGrantScopeSalt(blind: Uint8Array, account: Uint8Array, authNonce: bigint): Uint8Array {
  return grantScopeSalt('sol_ed25519', blind, account, authNonce);
}

/** issue_grant_with_sol_ed25519: the grantee descriptor and every scope
 *  field shown, signed, then the call. Returns, with the transaction, the
 *  grant's scope salt as the circuit derived it, for the grantee. */
export async function issueGrantWithSolEd25519(account: SolEd25519LifecycleSurface, device: SolEd25519Device, site: string,
  grantee: SolGranteeFields, scope: SolIssueScope) {
  const o: SolDeviceOperation = { op: 'issue_grant', grantee, ...scope };
  const l = await account.ledgerState();
  const counter = await resolveSolEd25519Counter(account, device);
  const auth = await authoriseSolDevice(device, { contractAddress: account.addressBytes, authNonce: l.auth_nonce }, site, o, counter);
  const scopeSalt = solGrantScopeSalt(device.blind, account.addressBytes, l.auth_nonce);
  const caller = { is_some: scope.caller !== null, value: { bytes: scope.caller ?? new Uint8Array(32) } };
  const r = await account.callTx.issue_grant_with_sol_ed25519(solGranteeArg(grantee), solTargetPointArg(grantee),
    scope.opWithdrawUnshielded, scope.opWithdrawShielded, scope.opWithdrawShieldedToContract, scope.read, scope.color, scope.recipientKind,
    scope.recipient, scope.maxCoinValue, scope.perCallCap, scope.cap, scope.expiresAt, scope.rpIdHash, scope.readPk, scope.windowLen,
    scope.windowCap, caller, ...solEd25519AuthArgs(auth));
  return { auth, txId: txIdOf(r), scopeSalt };
}

/** A grantee's delegate read key (X25519) for one grant: the secret is
 *  clamp(SHA-256("midnight:account:grant:read:sol:v1" || secret || grant
 *  id)), the public key X25519(secret, 9). `secret` is 32 bytes the grantee
 *  keeps (a vault key); the grant id names the account and the grant, so
 *  each account and grant gets a fresh key, and the read_pk_hash the ledger
 *  stores in the clear links no two grants. The grantee sends the public key
 *  to the issuer as the grant's read key. */
export function solGranteeReadKey(secret: Uint8Array, grantId: Uint8Array): { secretKey: Uint8Array; publicKey: Uint8Array } {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('sol_ed25519: a read-key secret is 32 bytes');
  if (!(grantId instanceof Uint8Array) || grantId.length !== 32) throw new Error('sol_ed25519: a grant id is 32 bytes');
  const sk = sha256(new Uint8Array([...new TextEncoder().encode('midnight:account:grant:read:sol:v1'), ...secret, ...grantId]));
  sk[0] &= 248; sk[31] &= 127; sk[31] |= 64;
  return { secretKey: sk, publicKey: x25519.getPublicKey(sk) };
}

/** revoke_grant_with_sol_ed25519: the grantee descriptor shown; the grant id
 *  re-derived in-circuit. */
export async function revokeGrantWithSolEd25519(account: SolEd25519LifecycleSurface, device: SolEd25519Device, site: string, grantee: SolGranteeFields) {
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'revoke_grant', grantee });
  const r = await account.callTx.revoke_grant_with_sol_ed25519(solGranteeArg(grantee), solTargetPointArg(grantee), ...solEd25519AuthArgs(auth));
  return { auth, txId: txIdOf(r) };
}

/** revoke_all_grants_with_sol_ed25519. */
export async function revokeAllGrantsWithSolEd25519(account: SolEd25519LifecycleSurface, device: SolEd25519Device, site: string) {
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'revoke_all_grants' });
  const r = await account.callTx.revoke_all_grants_with_sol_ed25519(...solEd25519AuthArgs(auth));
  return { auth, txId: txIdOf(r) };
}

// ── Recovery: the session and the veto through the device seam ────────────

/** One recovery session's artefacts (recovery MIP section 5): the new
 *  recovery public key P = s·G, a fresh session identifier, 1..4 backup
 *  vector values, and the 64-byte key wrap. */
export interface SolRecoveryArtefacts {
  recoveryPk: { x: bigint; y: bigint };
  sessionNonce: Uint8Array;
  phi: bigint[];
  wrap: Uint8Array;
}

/** The message-level session (slots padded with zeros, the length), with the
 *  shared chip's client-side refusals applied before any signature. */
export function solRecoverySession(a: SolRecoveryArtefacts) {
  if (a.phi.length < 1 || a.phi.length > 4) throw new Error(`sol_ed25519: phi carries ${a.phi.length} entries; the slot bound admits 1..4`);
  if (!(a.sessionNonce instanceof Uint8Array) || a.sessionNonce.length !== 32 || a.sessionNonce.every((b) => b === 0)) {
    throw new Error('sol_ed25519: a session identifier is 32 non-zero bytes (REC-4)');
  }
  if (!(a.wrap instanceof Uint8Array) || a.wrap.length !== 64) throw new Error('sol_ed25519: the recovery wrap is 64 bytes');
  const R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
  for (const v of [...a.phi, a.recoveryPk.x, a.recoveryPk.y]) {
    if (v < 0n || v >= R) throw new Error('sol_ed25519: a backup vector value or key coordinate is not a canonical field element');
  }
  const phi: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
  a.phi.forEach((p, i) => { phi[i] = p; });
  return { op: 'publish_recovery_session' as const, recoveryPk: { x: a.recoveryPk.x, y: a.recoveryPk.y }, sessionNonce: new Uint8Array(a.sessionNonce),
    phi, phiLen: BigInt(a.phi.length), wrap: new Uint8Array(a.wrap) };
}

/** publish_recovery_session_with_sol_ed25519: the message ("sets this
 *  account's recovery key", the key's coordinates, the session identifier,
 *  the four backup vector values, the length and the wrap, all in full),
 *  signed by the device's wallet, then the call. */
export async function publishRecoverySessionWithSolEd25519(account: SolEd25519LifecycleSurface, device: SolEd25519Device, site: string, artefacts: SolRecoveryArtefacts) {
  const session = solRecoverySession(artefacts);
  const auth = await authoriseSolDeviceOn(account, device, site, session);
  const r = await account.callTx.publish_recovery_session_with_sol_ed25519(
    session.recoveryPk, session.sessionNonce, ...session.phi, session.phiLen, session.wrap, ...solEd25519AuthArgs(auth));
  return { auth, session, txId: txIdOf(r) };
}

/** recover_cancel_with_sol_ed25519: the frame and the consequence line,
 *  signed, then the call; vetoes the pending recovery. */
export async function recoverCancelWithSolEd25519(account: SolEd25519LifecycleSurface, device: SolEd25519Device, site: string) {
  const auth = await authoriseSolDeviceOn(account, device, site, { op: 'recover_cancel' });
  const r = await account.callTx.recover_cancel_with_sol_ed25519(...solEd25519AuthArgs(auth));
  return { auth, txId: txIdOf(r) };
}

// ── The grantee ────────────────────────────────────────────────────────────
//
// A Solana key acting under a grant. Its blind is NOT its device blind: the
// issuer sees a grantee's blind (it derives the grant id and is shown in the
// issuer's approvals), so a grantee blind comes from its own readable request
// naming the role "grantee", the network and the ISSUING account
// (blind.ts granteeBlindMessage), signed twice, under the same
// blind tag.

export interface SolGranteeBlindRequest { network: string; issuingAccount: Uint8Array }

/** The grantee blind for one issuing account (sign-twice check, the
 *  contract's own derivation cross-checked). */
export async function deriveSolGranteeBlind(signer: SolSigner, req: SolGranteeBlindRequest): Promise<Uint8Array> {
  const key = parseSolanaPublicKey(signer.publicKey);
  const bytes = granteeBlindMessageBytes({ scheme: 'sol_ed25519', network: req.network, identity: key, issuingAccount: req.issuingAccount });
  const first = new Uint8Array(await signer.sign(new Uint8Array(bytes)));
  verifySolSignature(bytes, first, key);
  const second = new Uint8Array(await signer.sign(new Uint8Array(bytes)));
  verifySolSignature(bytes, second, key);
  const a = canonicalEd25519Signature(first), b = canonicalEd25519Signature(second);
  if (!equalBytes(a, b)) throw new Error('sol_ed25519: the wallet signed the grantee request twice with different signatures (not deterministic); refused');
  const blind = deriveBlind('sol_ed25519', a);
  if (!equalBytes(blind, pureCircuits.derive_blind_with_sol_ed25519(a))) throw new Error('sol_ed25519: blind differs from the contract derivation');
  return blind;
}

export class SolEd25519Grantee {
  readonly arm = SOL_ED25519;
  /** The signing key with its GRANTEE blind (never its device blind). */
  readonly device: SolEd25519Device;
  readonly label: string;

  constructor(device: SolEd25519Device, label: string) {
    labelBytes(label);
    this.device = device;
    this.label = label;
  }

  /** Enrolment as a grantee of `issuingAccount`: the grantee blind. */
  static async enrol(signer: SolSigner, req: SolGranteeBlindRequest, label: string): Promise<SolEd25519Grantee> {
    const blind = await deriveSolGranteeBlind(signer, req);
    return new SolEd25519Grantee(new SolEd25519Device({ publicKey: signer.publicKey, blind, sign: signer.sign }), label);
  }

  get key(): Uint8Array { return this.device.key; }
  get pk(): Curve25519Point { return this.device.pk; }
  get blind(): Uint8Array { return this.device.blind; }

  /** The descriptor the issuer shows for this grantee at a slot. */
  grantee(slot: bigint): SolGranteeFields { return solGranteeOf(this.device.descriptor(), { label: this.label }, slot); }

  /** The grant id: the contract's own derivation (label origin hash). */
  grantId(contractAddress: Uint8Array, slot: bigint): Uint8Array {
    const h = solKeyHints(this.pk);
    return pureCircuits.derive_grant_id_with_sol_ed25519({ bytes: contractAddress }, this.pk, h.pk_bytes, h.pk_x, this.blind, grantOriginHash(labelBytes(this.label)), slot);
  }

  /** This grantee's delegate read key for its grant on `contractAddress` at
   *  `slot` (solGranteeReadKey over the grant id): fresh per account and
   *  grant. */
  readKey(secret: Uint8Array, contractAddress: Uint8Array, slot: bigint): { secretKey: Uint8Array; publicKey: Uint8Array } {
    return solGranteeReadKey(secret, this.grantId(contractAddress, slot));
  }
}

/** A CustodyAccount's surface for the grantee twins. */
export interface SolEd25519GrantSurface {
  addressBytes: Uint8Array;
  grantContext(grantId: Uint8Array): Promise<{ issuedAt: bigint; grantNonce: bigint }>;
  heldCoin(color: Uint8Array): Promise<{ nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint }>;
  encKey(): Promise<Uint8Array>;
  withdrawUnshieldedWithGrantAuth(color: Uint8Array, amount: bigint, recipient: Uint8Array, opening: GrantOpening, a: SolEd25519GrantAuthorisation): Promise<{ txId: string }>;
  withdrawShieldedWithGrantAuth(recipient: Uint8Array, color: Uint8Array, amount: bigint, changeEntry: Uint8Array, encPk: Uint8Array, opening: GrantOpening, a: SolEd25519GrantAuthorisation): Promise<{ txId: string; change: unknown }>;
  withdrawShieldedToContractWithGrantAuth(recipient: Uint8Array, color: Uint8Array, amount: bigint, changeEntry: Uint8Array, encPk: Uint8Array, opening: GrantOpening, a: SolEd25519GrantAuthorisation): Promise<{ txId: string; sent: unknown; change: unknown }>;
}

/** The grantee's signing context: the record's issued_at and nonce as the
 *  ledger holds them now (never auth_nonce). */
export async function solGrantContext(account: SolEd25519GrantSurface, g: SolEd25519Grantee, slot: bigint): Promise<SolGrantCallContext> {
  const c = await account.grantContext(g.grantId(account.addressBytes, slot));
  return { contractAddress: account.addressBytes, label: g.label, slot, issuedAt: c.issuedAt, grantNonce: c.grantNonce };
}

/** withdraw_unshielded_with_grant_sol_ed25519 under `opening`. */
export async function withdrawUnshieldedAsSolGrantee(account: SolEd25519GrantSurface, g: SolEd25519Grantee, site: string, opening: GrantOpening, amount: SolAmount, recipient: Uint8Array) {
  const auth = await authoriseSolGrantee(g.device, await solGrantContext(account, g, opening.slot), site, { op: 'withdraw_unshielded_with_grant', amount, recipient });
  return { auth, ...(await account.withdrawUnshieldedWithGrantAuth(amount.color, amount.amount, recipient, opening, auth)) };
}

/** withdraw_shielded_with_grant_sol_ed25519: the coin the store holds for
 *  the colour, the change entry sealed to the live enc_key. */
export async function withdrawShieldedAsSolGrantee(account: SolEd25519GrantSurface, g: SolEd25519Grantee, site: string, opening: GrantOpening,
  amount: SolAmount, recipient: Uint8Array, changeEntry: Uint8Array, encPk?: Uint8Array) {
  const coin = await solSpentCoin(account as any, amount.color);
  const enc = encPk ?? await account.encKey();
  const auth = await authoriseSolGrantee(g.device, await solGrantContext(account, g, opening.slot), site,
    { op: 'withdraw_shielded_with_grant', amount, recipient, changeEntry, encPk: enc, coin });
  return { auth, coin, ...(await account.withdrawShieldedWithGrantAuth(recipient, amount.color, amount.amount, changeEntry, enc, opening, auth)) };
}

/** withdraw_shielded_to_contract_with_grant_sol_ed25519: the authorisation
 *  only (the call is composed with the recipient's claim, MIP-0012 §6.6). */
export async function authoriseWithdrawShieldedToContractAsSolGrantee(account: SolEd25519GrantSurface, g: SolEd25519Grantee, site: string, opening: GrantOpening,
  amount: SolAmount, recipientContract: Uint8Array, changeEntry: Uint8Array, encPk?: Uint8Array) {
  const coin = await solSpentCoin(account as any, amount.color);
  const enc = encPk ?? await account.encKey();
  const auth = await authoriseSolGrantee(g.device, await solGrantContext(account, g, opening.slot), site,
    { op: 'withdraw_shielded_to_contract_with_grant', amount, recipient: recipientContract, changeEntry, encPk: enc, coin });
  return { auth, coin, encPk: enc };
}
