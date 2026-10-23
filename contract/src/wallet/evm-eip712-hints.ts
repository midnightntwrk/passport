// The checked byte hints of the `evm_eip712` circuits (circuit side:
// contracts/modules/EvmEip712.compact, "Checked byte hints", and
// contracts/account-evm-eip712.compact).
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
import type { EvmEip712DescriptorInput, EvmEip712GranteeInput, IssueScope, SiteAmount } from './evm-eip712-codec.js';
import { DESCRIPTOR_TAGS, solanaKeyInputs } from './descriptors.js';
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

/** A key's address hint (the circuit's `EvmEip712KeyHint`): the coordinates'
 *  bytes as `Bytes<32>` stores them (little-endian), and the bytes of
 *  keccak256 of the big-endian x || y. */
export interface EvmEip712KeyHint { x: ByteHint; y: ByteHint; key_hash: ByteHint }
export function evmEip712KeyHint(pk: { x: bigint; y: bigint }): EvmEip712KeyHint {
  const pre = new Uint8Array(64);
  pre.set(be32(pk.x), 0);
  pre.set(be32(pk.y), 32);
  return { x: bytesHint(le32(pk.x)), y: bytesHint(le32(pk.y)), key_hash: bytesHint(keccak_256(pre)) };
}

/** The bytes of keccak256 of an account's 32-byte address (the domain's
 *  verifyingContract is their low 20 bytes). */
export const accountHashHint = (account: Uint8Array): ByteHint => bytesHint(keccak_256(account));

/** The device seam's hint (`EvmEip712SeamHint`). */
export interface EvmEip712SeamHint { key: EvmEip712KeyHint; account_hash: ByteHint; digest: ByteHint; nonce: ByteHint }
export function evmEip712SeamHint(
  pk: { x: bigint; y: bigint }, account: Uint8Array, digest: Uint8Array, authNonce: bigint,
): EvmEip712SeamHint {
  return { key: evmEip712KeyHint(pk), account_hash: accountHashHint(account), digest: bytesHint(digest), nonce: leHint(authNonce, 8) };
}

/** The grant seam's hint (`EvmEip712GrantSeamHint`): the key's, the account
 *  hash's and the digest's, and the frame's label, issuedAt and nonce. */
export interface EvmEip712GrantSeamHint {
  key: EvmEip712KeyHint; account_hash: ByteHint; digest: ByteHint; label: ByteHint; issued_at: ByteHint; grant_nonce: ByteHint;
}
export function evmEip712GrantSeamHint(
  pk: { x: bigint; y: bigint }, account: Uint8Array, digest: Uint8Array, label: Uint8Array, issuedAt: bigint, grantNonce: bigint,
): EvmEip712GrantSeamHint {
  return {
    key: evmEip712KeyHint(pk), account_hash: accountHashHint(account), digest: bytesHint(digest),
    label: bytesHint(label), issued_at: leHint(issuedAt, 8), grant_nonce: leHint(grantNonce, 8),
  };
}

// ── Solana keys ─────────────────────────────────────────────────────────────

/** The three arguments the four descriptor circuits take beside a
 *  descriptor: a Solana target's key as its Curve25519Point, the key's 32
 *  encoded bytes and the point's x-coordinate as 32 little-endian bytes
 *  (solanaKeyInputs; the circuit checks both against the point). */
export type EvmEip712SolArgs = [point: { x: bigint; y: bigint }, pkBytes: bigint[], pkX: bigint[]];
const solArgsOf = (k: ReturnType<typeof solanaKeyInputs>): EvmEip712SolArgs => [k.point, k.pkBytes, k.pkX];
/** A circuit computes every descriptor class, so for any other target the
 *  client passes a fixed non-identity key (the Ed25519 base point) with its
 *  inputs; the circuit discards its results. */
export const EVM_EIP712_SOL_FILLER_ARGS: EvmEip712SolArgs = (() => {
  const { x, y } = ed25519.Point.BASE.toAffine();
  return solArgsOf(solanaKeyInputs({ x, y }));
})();
const SOL_TAGS = new Set([DESCRIPTOR_TAGS.device.sol_ed25519, DESCRIPTOR_TAGS['grant-id'].sol_ed25519]);
const tagTextOf = (tag: Uint8Array) => new TextDecoder().decode(tag.subarray(0, tag.indexOf(0) < 0 ? 32 : tag.indexOf(0)));
const isSol = (input: { tag: Uint8Array }) => SOL_TAGS.has(tagTextOf(input.tag));
/** The Solana arguments for a descriptor input: a Solana target's key (its
 *  32-byte encoding in `key`), the filler key otherwise. */
export function solArgs(input: EvmEip712DescriptorInput | EvmEip712GranteeInput): EvmEip712SolArgs {
  return isSol(input) ? solArgsOf(solanaKeyInputs(new Uint8Array(input.key))) : EVM_EIP712_SOL_FILLER_ARGS;
}
/** The key bytes the descriptor circuits show under the Solana type (the
 *  checked `sol_bytes` they are passed): the target's key, or the filler
 *  key's for any other target (shown nowhere: that branch is not selected). */
export const solKeyOf = (input: EvmEip712DescriptorInput | EvmEip712GranteeInput): ByteHint => solArgs(input)[1];
const bytesOfHint = (h: ByteHint): Uint8Array => Uint8Array.from(h, (x) => Number(x));

/** The base58 inputs of a 32-byte key (`EvmEip712Base58Hint`). */
export interface EvmEip712Base58Hint { digits: ByteHint; carry: bigint; low: bigint; top: bigint }
export const evmEip712Base58Hint = (key: Uint8Array): EvmEip712Base58Hint => base58Inputs(key);

// ── Amounts ─────────────────────────────────────────────────────────────────

/** The site's amount label as the circuit takes it (49 bytes, space-padded). */
export const amountLabelHint = (amount: bigint, site: SiteAmount): ByteHint =>
  bytesHint(siteAmountLabelBytes(amount, site.decimals, site.symbol));

/** An unshielded amount (`EvmEip712AmountHint`): its bytes and the site's label. */
export const evmEip712AmountHint = (amount: bigint, site: SiteAmount) => ({ amount: leHint(amount, 16), label: amountLabelHint(amount, site) });

/** A shielded spend (`EvmEip712CoinHint`): the amount, the spent coin's value
 *  and Merkle index, the change (value − amount), and the site's label. */
export function evmEip712CoinHint(amount: bigint, coinValue: bigint, coinMtIndex: bigint, site: SiteAmount) {
  if (coinValue < amount) throw new Error('hint: the spent coin is smaller than the amount');
  return { amount: leHint(amount, 16), value: leHint(coinValue, 16), mt_index: leHint(coinMtIndex, 8), change: leHint(coinValue - amount, 16),
    label: amountLabelHint(amount, site) };
}

// ── Descriptors ─────────────────────────────────────────────────────────────

/** A device descriptor (`EvmEip712DescriptorHint`): its bytes and the base58
 *  inputs of the key shown under the Solana type (solKeyOf). */
export const evmEip712DescriptorHint = (d: EvmEip712DescriptorInput) =>
  ({ key: bytesHint(d.key), key2: bytesHint(d.key2), origin: bytesHint(d.origin), b58: evmEip712Base58Hint(bytesOfHint(solKeyOf(d))) });

/** A removal (`EvmEip712RemoveHint`): the target's descriptor, epoch and counter. */
export const evmEip712RemoveHint = (d: EvmEip712DescriptorInput, targetEpoch: bigint, targetCounter: bigint) =>
  ({ target: evmEip712DescriptorHint(d), epoch: leHint(targetEpoch, 4), counter: leHint(targetCounter, 8) });

/** A grantee descriptor (`EvmEip712GranteeHint`). */
export const evmEip712GranteeHint = (g: EvmEip712GranteeInput) =>
  ({ key: bytesHint(g.key), key2: bytesHint(g.key2), origin: bytesHint(g.origin), label: bytesHint(g.label), b58: evmEip712Base58Hint(bytesOfHint(solKeyOf(g))) });

/** A grant (`EvmEip712IssueHint`): the grantee, the scope's numbers, and the
 *  expiry's date inputs (utcDateTimeInputs: the date text, 29 bytes, and the
 *  year's split). */
export function evmEip712IssueHint(g: EvmEip712GranteeInput, s: IssueScope) {
  const e = utcDateTimeInputs(s.expiresAt);
  return {
    grantee: evmEip712GranteeHint(g),
    max_coin_value: leHint(s.maxCoinValue, 16), per_call_cap: leHint(s.perCallCap, 16), cap: leHint(s.cap, 16),
    expires_at: leHint(s.expiresAt, 8), window_len: leHint(s.windowLen, 8), window_cap: leHint(s.windowCap, 16),
    expiry_text: e.text, year_split: e.yearSplit,
  };
}
