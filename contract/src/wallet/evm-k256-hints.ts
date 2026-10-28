// The checked byte hints of the `evm_k256` circuits (circuit side:
// contracts/modules/EvmK256.compact, "Checked byte hints", and
// contracts/account-evm-k256.compact).
//
// Taking bytes out of a value inside a circuit costs a full field
// decomposition per byte, so the circuits take a value's bytes as an extra
// argument instead: a vector of `Uint<8>` that must be exactly the value's
// bytes in the order Compact stores them (a `Bytes<n>` in order, a number
// little-endian). The circuit rebuilds the value from the vector and compares,
// so a wrong hint only makes the call fail; it never changes what is signed or
// executed. Every hint here is a function of values the client already has.
//
// Platform-neutral: no node: imports.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { evmK256KindOf, type EvmK256DescriptorInput, type EvmK256GranteeInput, type IssueScope, type SiteAmount } from './evm-k256-codec.js';
import { ed25519KeyInputs } from './descriptors.js';
import { base58Inputs, siteAmountLabelBytes, utcDateTimeInputs } from './rendering.js';

/** A `Uint<8>` vector as the generated contract takes it. */
export type ByteHint = bigint[];

/** The bytes of a `Bytes<n>` value, in order. */
export const bytesHint = (b: Uint8Array): ByteHint => Array.from(b, (x) => BigInt(x));

/** The little-endian bytes of an unsigned number of `n` bytes. */
export function leHint(v: bigint, n: number): ByteHint {
  if (v < 0n || v >= 1n << BigInt(8 * n)) throw new Error(`hint: ${v} does not fit in ${n} bytes`);
  return Array.from({ length: n }, (_, i) => (v >> BigInt(8 * i)) & 0xffn);
}

const be32 = (v: bigint): Uint8Array => {
  const o = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; }
  return o;
};
const le32 = (v: bigint): Uint8Array => be32(v).reverse();

/** A key's address hint (the circuit's `EvmAddressHint`): the coordinates'
 *  bytes as `Bytes<32>` stores them (little-endian), and the bytes of
 *  keccak256 of the big-endian x || y. */
export interface EvmAddressHint { x: ByteHint; y: ByteHint; key_hash: ByteHint }
export function evmK256KeyHint(pk: { x: bigint; y: bigint }): EvmAddressHint {
  const pre = new Uint8Array(64);
  pre.set(be32(pk.x), 0);
  pre.set(be32(pk.y), 32);
  return { x: bytesHint(le32(pk.x)), y: bytesHint(le32(pk.y)), key_hash: bytesHint(keccak_256(pre)) };
}

/** The device seam's hint (`EvmK256SeamHint`): the key's, the digest's and
 *  auth_nonce's. */
export interface EvmK256SeamHint { key: EvmAddressHint; digest: ByteHint; nonce: ByteHint }
export function evmK256SeamHint(
  pk: { x: bigint; y: bigint }, digest: Uint8Array, authNonce: bigint,
): EvmK256SeamHint {
  return { key: evmK256KeyHint(pk), digest: bytesHint(digest), nonce: leHint(authNonce, 8) };
}

/** The grant seam's hint (`EvmK256GrantSeamHint`): the key's and the
 *  digest's, and the frame's label, issuedAt and nonce. */
export interface EvmK256GrantSeamHint {
  key: EvmAddressHint; digest: ByteHint; label: ByteHint; issued_at: ByteHint; grant_nonce: ByteHint;
}
export function evmK256GrantSeamHint(
  pk: { x: bigint; y: bigint }, digest: Uint8Array, label: Uint8Array, issuedAt: bigint, grantNonce: bigint,
): EvmK256GrantSeamHint {
  return {
    key: evmK256KeyHint(pk), digest: bytesHint(digest),
    label: bytesHint(label), issued_at: leHint(issuedAt, 8), grant_nonce: leHint(grantNonce, 8),
  };
}

// ── Ed25519 keys ────────────────────────────────────────────────────────────

/** The three arguments the four descriptor circuits take beside a
 *  descriptor: an ed25519 target's key as its Curve25519Point, the
 *  key's 32 encoded bytes and the point's x-coordinate as 32 little-endian
 *  bytes (ed25519KeyInputs; the circuit checks both against the point). */
export type EvmK256Ed25519Args = [point: { x: bigint; y: bigint }, pkBytes: bigint[], pkX: bigint[]];
const ed25519ArgsOf = (k: ReturnType<typeof ed25519KeyInputs>): EvmK256Ed25519Args => [k.point, k.pkBytes, k.pkX];
/** A circuit computes every payload form, so for a target of any other form
 *  the client passes a fixed non-identity key (the Ed25519 base point) with
 *  its inputs; the circuit discards its results. */
export const EVM_K256_ED25519_FILLER_ARGS: EvmK256Ed25519Args = (() => {
  const { x, y } = ed25519.Point.BASE.toAffine();
  return ed25519ArgsOf(ed25519KeyInputs({ x, y }));
})();
/** Whether a descriptor input (a device's or a grantee's) names a kind of
 *  the ed25519 form by its tag. */
const isEd25519Base58 = (input: { tag: Uint8Array }): boolean =>
  (evmK256KindOf('device', input.tag) ?? evmK256KindOf('grant-id', input.tag))?.payload === 'ed25519';
/** The Ed25519 arguments for a descriptor input: an ed25519 target's
 *  key (its 32-byte encoding in `key`), the filler key otherwise. */
export function ed25519Args(input: EvmK256DescriptorInput | EvmK256GranteeInput): EvmK256Ed25519Args {
  return isEd25519Base58(input) ? ed25519ArgsOf(ed25519KeyInputs(new Uint8Array(input.key))) : EVM_K256_ED25519_FILLER_ARGS;
}
/** The key bytes the descriptor circuits show for an ed25519 kind (the
 *  checked `ed_bytes` they are passed): the target's key, or the filler
 *  key's for a target of any other form (shown nowhere: that form is not
 *  selected). */
export const ed25519KeyOf = (input: EvmK256DescriptorInput | EvmK256GranteeInput): ByteHint => ed25519Args(input)[1];
const bytesOfHint = (h: ByteHint): Uint8Array => Uint8Array.from(h, (x) => Number(x));

/** The base58 inputs of a 32-byte key (`EvmK256Base58Hint`). */
export interface EvmK256Base58Hint { digits: ByteHint; carry: bigint; low: bigint; top: bigint }
export const evmK256Base58Hint = (key: Uint8Array): EvmK256Base58Hint => base58Inputs(key);

// ── Amounts ─────────────────────────────────────────────────────────────────

/** The site's amount label as the circuit takes it (49 bytes, space-padded). */
export const amountLabelHint = (amount: bigint, site: SiteAmount): ByteHint =>
  bytesHint(siteAmountLabelBytes(amount, site.decimals, site.symbol));

/** An unshielded amount (`EvmK256AmountHint`): its bytes and the site's label. */
export const evmK256AmountHint = (amount: bigint, site: SiteAmount) => ({ amount: leHint(amount, 16), label: amountLabelHint(amount, site) });

/** A shielded spend (`EvmK256CoinHint`): the amount, the spent coin's value
 *  and Merkle index, the change (value − amount), and the site's label. */
export function evmK256CoinHint(amount: bigint, coinValue: bigint, coinMtIndex: bigint, site: SiteAmount) {
  if (coinValue < amount) throw new Error('hint: the spent coin is smaller than the amount');
  return { amount: leHint(amount, 16), value: leHint(coinValue, 16), mt_index: leHint(coinMtIndex, 8), change: leHint(coinValue - amount, 16),
    label: amountLabelHint(amount, site) };
}

// ── Descriptors ─────────────────────────────────────────────────────────────

/** A device descriptor (`EvmK256DescriptorHint`): its bytes and the base58
 *  inputs of the key an ed25519 kind shows (ed25519KeyOf). */
export const evmK256DescriptorHint = (d: EvmK256DescriptorInput) =>
  ({ key: bytesHint(d.key), key2: bytesHint(d.key2), origin: bytesHint(d.origin), b58: evmK256Base58Hint(bytesOfHint(ed25519KeyOf(d))) });

/** A removal (`EvmK256RemoveHint`): the target's descriptor, epoch and counter. */
export const evmK256RemoveHint = (d: EvmK256DescriptorInput, targetEpoch: bigint, targetCounter: bigint) =>
  ({ target: evmK256DescriptorHint(d), epoch: leHint(targetEpoch, 4), counter: leHint(targetCounter, 8) });

/** A grantee descriptor (`EvmK256GranteeHint`). */
export const evmK256GranteeHint = (g: EvmK256GranteeInput) =>
  ({ key: bytesHint(g.key), key2: bytesHint(g.key2), origin: bytesHint(g.origin), label: bytesHint(g.label), b58: evmK256Base58Hint(bytesOfHint(ed25519KeyOf(g))) });

/** A grant (`EvmK256IssueHint`): the grantee, the scope's numbers, and the
 *  expiry's date inputs (utcDateTimeInputs: the date text, 29 bytes, and the
 *  year's split). */
export function evmK256IssueHint(g: EvmK256GranteeInput, s: IssueScope) {
  const e = utcDateTimeInputs(s.expiresAt);
  return {
    grantee: evmK256GranteeHint(g),
    max_coin_value: leHint(s.maxCoinValue, 16), per_call_cap: leHint(s.perCallCap, 16), cap: leHint(s.cap, 16),
    expires_at: leHint(s.expiresAt, 8), window_len: leHint(s.windowLen, 8), window_cap: leHint(s.windowCap, 16),
    expiry_text: e.text, year_split: e.yearSplit,
  };
}
