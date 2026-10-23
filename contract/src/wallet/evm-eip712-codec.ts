// The `evm_eip712` arm's EIP-712 codec, client side (byte contract:
// contract/EVM-EIP712.md; circuit side: contracts/modules/EvmEip712.compact).
//
// Two independent halves meet here:
//
//   - a general EIP-712 encoder (encodeType with its sorted dependencies,
//     encodeData, hashStruct, the domain separator, the digest), written from
//     the EIP and nothing else, over the typed-data JSON a wallet receives;
//   - builders that turn an operation's values into that JSON
//     (`eth_signTypedData_v4` form), one per operation and role.
//
// The contract computes the same digest word by word from the values it
// executes (its exported `evm_eip712_struct_*` and `evm_eip712_digest` pure
// circuits). The offline suite checks that both agree on every frozen vector,
// and evm-eip712-viem.ts checks the JSON against viem's hashTypedData.
//
// Platform-neutral: no node: imports, so a browser page can use it.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { evmChecksumAddress } from './descriptors.js';
import { recipientKindLabel, k256EnvelopeLabel } from './labels.js';
import { NOT_APPLICABLE_TEXT, NO_WINDOW_TEXT, expiryDateTimeText, base58Text32Bytes, siteAmountLabelBytes } from './rendering.js';

// ── The frozen type set (version "1") ────────────────────────────────────────

export const EVM_EIP712_DOMAIN_NAME = 'Midnight Passport Account';
export const EVM_EIP712_DOMAIN_VERSION = '1';

export interface TypedField { name: string; type: string }
export type TypeSet = Record<string, TypedField[]>;

const f = (spec: [string, string][]): TypedField[] => spec.map(([name, type]) => ({ name, type }));
const FRAME: [string, string][] = [['account', 'bytes32'], ['device', 'address'], ['authNonce', 'uint64']];
const GFRAME: [string, string][] = [['account', 'bytes32'], ['grantee', 'address'], ['siteLabel', 'string'], ['slot', 'uint8'], ['issuedAt', 'uint64'], ['grantNonce', 'uint64']];
// The moved amount in base units, then the site's label for it (amountLabel).
const AMOUNT: [string, string][] = [['amount', 'uint128'], ['amountLabel', 'string']];
const COIN: [string, string][] = [['coinNonce', 'bytes32'], ['coinValue', 'uint128'], ['coinMerkleIndex', 'uint64'], ['change', 'uint128']];
const SCOPE: [string, string][] = [
  ['withdrawUnshielded', 'bool'], ['withdrawShielded', 'bool'], ['withdrawShieldedToContract', 'bool'], ['read', 'bool'],
  ['color', 'bytes32'], ['recipientKind', 'string'], ['recipient', 'bytes32'], ['maxCoinValue', 'uint128'], ['perCallCap', 'uint128'],
  ['cap', 'uint128'], ['expiresAt', 'uint64'], ['expiry', 'string'], ['passkeyRpHash', 'bytes32'], ['passkeyRp', 'string'],
  ['readKey', 'bytes32'], ['windowLength', 'uint64'],
  ['windowCap', 'uint128'], ['window', 'string'], ['callerPinned', 'bool'], ['caller', 'bytes32'],
];

/** The nested descriptor types: one per target scheme. */
export const EVM_EIP712_DESCRIPTOR_TYPES: TypeSet = {
  EvmDevice: f([['scheme', 'string'], ['wallet', 'address'], ['privacySalt', 'bytes32']]),
  SolanaDevice: f([['scheme', 'string'], ['publicKey', 'string'], ['privacySalt', 'bytes32']]),
  JubjubDevice: f([['scheme', 'string'], ['x', 'bytes32'], ['y', 'bytes32']]),
  K256Device: f([['scheme', 'string'], ['x', 'bytes32'], ['y', 'bytes32'], ['envelope', 'string']]),
  PasskeyDevice: f([['scheme', 'string'], ['x', 'bytes32'], ['y', 'bytes32'], ['origin', 'string'], ['passkeyRpHash', 'bytes32']]),
  EvmGrantee: f([['scheme', 'string'], ['wallet', 'address'], ['privacySalt', 'bytes32'], ['siteLabel', 'string'], ['slot', 'uint8']]),
  SolanaGrantee: f([['scheme', 'string'], ['publicKey', 'string'], ['privacySalt', 'bytes32'], ['siteLabel', 'string'], ['slot', 'uint8']]),
  JubjubGrantee: f([['scheme', 'string'], ['x', 'bytes32'], ['y', 'bytes32'], ['siteLabelHash', 'bytes32'], ['slot', 'uint8']]),
  K256Grantee: f([['scheme', 'string'], ['x', 'bytes32'], ['y', 'bytes32'], ['envelope', 'string'], ['siteLabelHash', 'bytes32'], ['slot', 'uint8']]),
  PasskeyGrantee: f([['scheme', 'string'], ['x', 'bytes32'], ['y', 'bytes32'], ['origin', 'string'], ['slot', 'uint8']]),
};

/** The 16 primary types; `<Device>` / `<Grantee>` is the scheme's nested type. */
export const EVM_EIP712_PRIMARY_TYPES: Record<string, [string, string][]> = {
  WithdrawUnshielded: [...FRAME, ['color', 'bytes32'], ...AMOUNT, ['recipient', 'bytes32']],
  WithdrawShielded: [...FRAME, ['color', 'bytes32'], ...AMOUNT, ['recipient', 'bytes32'], ...COIN],
  WithdrawShieldedToContract: [...FRAME, ['color', 'bytes32'], ...AMOUNT, ['recipientContract', 'bytes32'], ...COIN],
  AppendInbox: [...FRAME, ['entry', 'bytes']],
  RotateEncKey: [...FRAME, ['effect', 'string'], ['newKey', 'bytes32']],
  AddDevice: [...FRAME, ['effect', 'string'], ['newDevice', '<Device>']],
  RemoveDevice: [...FRAME, ['target', '<Device>'], ['targetEpoch', 'uint32'], ['targetCounter', 'uint64']],
  RemoveUnknownDevice: [...FRAME, ['effect', 'string'], ['entry', 'bytes32']],
  IssueGrant: [...FRAME, ['effect', 'string'], ['grantee', '<Grantee>'], ...SCOPE],
  RevokeGrant: [...FRAME, ['grantee', '<Grantee>']],
  RevokeAllGrants: [...FRAME],
  PublishRecoverySession: [...FRAME, ['effect', 'string'], ['recoveryKeyX', 'bytes32'], ['recoveryKeyY', 'bytes32'], ['sessionNonce', 'bytes32'],
    ['phi1', 'bytes32'], ['phi2', 'bytes32'], ['phi3', 'bytes32'], ['phi4', 'bytes32'], ['phiLength', 'uint8'], ['wrap', 'bytes']],
  CancelRecovery: [...FRAME],
  WithdrawUnshieldedAsGrantee: [...GFRAME, ['color', 'bytes32'], ...AMOUNT, ['recipient', 'bytes32']],
  WithdrawShieldedAsGrantee: [...GFRAME, ['color', 'bytes32'], ...AMOUNT, ['recipient', 'bytes32'], ['changeEntry', 'bytes'], ['encryptionKey', 'bytes32'], ...COIN],
  WithdrawShieldedToContractAsGrantee: [...GFRAME, ['color', 'bytes32'], ...AMOUNT, ['recipientContract', 'bytes32'], ['changeEntry', 'bytes'], ['encryptionKey', 'bytes32'], ...COIN],
};

/** The circuit-fixed consequence lines, and the line of the literal-entry removal. */
export const EVM_EIP712_EFFECTS = {
  RotateEncKey: "Sets the key that can read this account's private coin records",
  AddDevice: 'Gives this key FULL control of this account',
  RemoveUnknownDevice: 'Removes a device this wallet cannot identify',
  IssueGrant: 'Lets this key use this account within the limits below',
  PublishRecoverySession: "Sets this account's recovery key",
} as const;

const DOMAIN_TYPE: TypedField[] = f([['name', 'string'], ['version', 'string'], ['verifyingContract', 'address']]);

// ── General EIP-712 (from the EIP) ───────────────────────────────────────────

export interface Eip712Domain { name: string; version: string; verifyingContract: string }
export interface Eip712TypedData {
  domain: Eip712Domain;
  /** Includes EIP712Domain, as `eth_signTypedData_v4` expects. */
  types: TypeSet;
  primaryType: string;
  message: Record<string, unknown>;
}

const enc = new TextEncoder();
const hexBytes = (h: string): Uint8Array => {
  const s = h.replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error(`eip712: not a hex string: ${h.slice(0, 20)}`);
  return new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)));
};
export const toHex = (b: Uint8Array): string => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const concat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) { out.set(x, o); o += x.length; }
  return out;
};
const word = (v: bigint): Uint8Array => {
  const o = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; }
  return o;
};
export const keccak = (b: Uint8Array): Uint8Array => keccak_256(b);

function dependencies(primary: string, types: TypeSet, found = new Set<string>()): Set<string> {
  if (found.has(primary) || !types[primary]) return found;
  found.add(primary);
  for (const field of types[primary]) dependencies(field.type.replace(/\[\d*\]$/, ''), types, found);
  return found;
}

/** encodeType: the primary type, then its dependencies sorted by name. */
export function encodeType(primary: string, types: TypeSet): string {
  const deps = [...dependencies(primary, types)].filter((t) => t !== primary).sort();
  return [primary, ...deps].map((t) => `${t}(${types[t].map((x) => `${x.type} ${x.name}`).join(',')})`).join('');
}

export const typeHash = (primary: string, types: TypeSet): Uint8Array => keccak(enc.encode(encodeType(primary, types)));

function encodeValue(type: string, value: unknown, types: TypeSet): Uint8Array {
  if (types[type]) return hashStruct(type, value as Record<string, unknown>, types);
  if (type === 'string') return keccak(enc.encode(String(value)));
  if (type === 'bytes') return keccak(hexBytes(String(value)));
  if (type === 'bool') return word(value ? 1n : 0n);
  if (type === 'address') {
    const b = hexBytes(String(value));
    if (b.length !== 20) throw new Error('eip712: an address is 20 bytes');
    return concat(new Uint8Array(12), b);
  }
  const fixed = type.match(/^bytes(\d+)$/);
  if (fixed) {
    const b = hexBytes(String(value));
    if (b.length !== Number(fixed[1])) throw new Error(`eip712: ${type} needs ${fixed[1]} bytes`);
    return concat(b, new Uint8Array(32 - b.length));
  }
  const uint = type.match(/^uint(\d+)$/);
  if (uint) {
    const v = BigInt(value as string | number | bigint);
    if (v < 0n || v >= 1n << BigInt(uint[1])) throw new Error(`eip712: ${type} out of range`);
    return word(v);
  }
  throw new Error(`eip712: unsupported type ${type}`);
}

export function hashStruct(primary: string, data: Record<string, unknown>, types: TypeSet): Uint8Array {
  const fields = types[primary];
  if (!fields) throw new Error(`eip712: unknown type ${primary}`);
  for (const k of Object.keys(data)) if (!fields.some((x) => x.name === k)) throw new Error(`eip712: ${primary} has no member ${k}`);
  return keccak(concat(typeHash(primary, types), ...fields.map((x) => {
    if (!(x.name in data)) throw new Error(`eip712: ${primary}.${x.name} missing`);
    return encodeValue(x.type, data[x.name], types);
  })));
}

export const domainSeparator = (d: Eip712Domain): Uint8Array =>
  hashStruct('EIP712Domain', d as unknown as Record<string, unknown>, { EIP712Domain: DOMAIN_TYPE });

/** keccak256(0x19 0x01 || domainSeparator || hashStruct(message)): what the wallet signs. */
export function typedDataDigest(t: Eip712TypedData): Uint8Array {
  const { EIP712Domain: _domain, ...rest } = t.types;
  return keccak(concat(Uint8Array.of(0x19, 0x01), domainSeparator(t.domain), hashStruct(t.primaryType, t.message, rest)));
}

// ── The arm's domain ─────────────────────────────────────────────────────────

/** verifyingContract: the low 20 bytes of keccak256 of the 32-byte account address. */
export function verifyingContract(account: Uint8Array): string {
  if (account.length !== 32) throw new Error('eip712: an account address is 32 bytes');
  return evmChecksumAddress(keccak(account).subarray(12));
}

export const evmEip712Domain = (account: Uint8Array): Eip712Domain => ({
  name: EVM_EIP712_DOMAIN_NAME, version: EVM_EIP712_DOMAIN_VERSION, verifyingContract: verifyingContract(account),
});

/** The type set of one message: the primary type, its nested type if any, and
 *  EIP712Domain (viem and ethers refuse unused types, so nothing else). */
export function typesFor(primary: string, nested?: string): TypeSet {
  const spec = EVM_EIP712_PRIMARY_TYPES[primary];
  if (!spec) throw new Error(`eip712: unknown operation ${primary}`);
  const needs = spec.some(([, t]) => t.startsWith('<'));
  if (needs !== !!nested) throw new Error(`eip712: ${primary} ${needs ? 'needs' : 'takes no'} nested descriptor type`);
  if (nested && !EVM_EIP712_DESCRIPTOR_TYPES[nested]) throw new Error(`eip712: unknown descriptor type ${nested}`);
  const types: TypeSet = { EIP712Domain: DOMAIN_TYPE, [primary]: f(spec.map(([n, t]) => [n, t.startsWith('<') ? nested! : t])) };
  if (nested) types[nested] = EVM_EIP712_DESCRIPTOR_TYPES[nested];
  return types;
}

/** A primary type's encodeType string (with its nested type, if any). */
export const typeString = (primary: string, nested?: string): string => encodeType(primary, typesFor(primary, nested));

// ── Values as the wallet shows them ──────────────────────────────────────────

const ascii = (b: Uint8Array): string => String.fromCharCode(...b);
/** A 32-byte zero-padded site label as shown: zero bytes as spaces (32 characters). */
export function siteLabelText(label: Uint8Array): string {
  if (label.length !== 32) throw new Error('eip712: a site label is 32 bytes');
  // The grammar of the shared rendering module (one-to-one display).
  let prevSpace = true, padding = false, ok = true;
  for (const c of label) {
    const zero = c === 0, space = c === 32, shown = c >= 33 && c <= 126;
    const fits = padding ? zero : zero ? !prevSpace : shown || (space && !prevSpace);
    prevSpace = space; padding = padding || zero; ok = ok && fits;
  }
  if (!ok || prevSpace) throw new Error('eip712: not a site label');
  return ascii(label.map((c) => (c === 0 ? 32 : c)));
}
export function visibleText(b: Uint8Array): string {
  if (!b.every((c) => c >= 33 && c <= 126)) throw new Error('eip712: not visible ASCII');
  return ascii(b);
}
const tagText = (tag: Uint8Array): string => ascii(tag.subarray(0, tag.indexOf(0) < 0 ? 32 : tag.indexOf(0)));
const rev = (b: Uint8Array): Uint8Array => new Uint8Array(b).reverse();

// ── Descriptors: circuit input and typed-data member ─────────────────────────

/** The circuit's `EvmEip712Descriptor`. */
export interface EvmEip712DescriptorInput {
  tag: Uint8Array; key: Uint8Array; key2: Uint8Array; address: Uint8Array;
  envelope: bigint; rp_id_hash: Uint8Array; origin: Uint8Array;
}
/** The circuit's `EvmEip712GranteeDescriptor`. */
export interface EvmEip712GranteeInput {
  tag: Uint8Array; key: Uint8Array; key2: Uint8Array; address: Uint8Array; envelope: bigint;
  origin: Uint8Array; label: Uint8Array; origin_hash: Uint8Array; slot: bigint;
}

const DEVICE_TAGS: Record<string, string> = {
  'midnight:account:device:evm:v1': 'EvmDevice', 'midnight:account:device:sol:v1': 'SolanaDevice',
  'midnight:account:device:v1': 'JubjubDevice', 'midnight:account:device:k1:v2': 'K256Device', 'midnight:account:device:r1:v2': 'PasskeyDevice',
};
const GRANTEE_TAGS: Record<string, string> = {
  'midnight:account:grant:id:evm:v1': 'EvmGrantee', 'midnight:account:grant:id:sol:v1': 'SolanaGrantee',
  'midnight:account:grant:id:v1': 'JubjubGrantee', 'midnight:account:grant:id:k1:v1': 'K256Grantee', 'midnight:account:grant:id:r1:v1': 'PasskeyGrantee',
};
/** The enumerated members' text labels are the base's shared texts
 *  (labels.ts): the circuit hashes the same constant, selected by the value,
 *  and refuses a value with no label. */
/** The arm's pointer texts, shown when the value is not the one the base's
 *  word names. Each points at the typed members that carry the value. */
export const EVM_EIP712_PASSKEY_RP_POINTER = 'see passkeyRpHash';
export const EVM_EIP712_WINDOW_POINTER = 'see windowLength and windowCap';
/** The fixed words before the site's amount label: the label is the site's
 *  claim, not a value the contract knows. */
export const EVM_EIP712_AMOUNT_LABEL_PREFIX = 'This site labels it: ';

/** `IssueGrant.expiry`: the base's "never" for an expiry of 0, the UTC date
 *  and time `yyyy-mm-dd hh:mm:ss UTC` up to 9999-12-31 23:59:59 UTC, and
 *  the words "after 9999-12-31 23:59:59 UTC" above; exact, no padding. */
export function expiryText(expiresAt: bigint): string {
  if (typeof expiresAt !== 'bigint') throw new Error('eip712: expiresAt is a bigint');
  return expiryDateTimeText(expiresAt);
}

/** `IssueGrant.window`: the base's "no window" when the window length and
 *  the window cap are both 0, else the pointer to the two numbers. */
export function windowWord(windowLen: bigint, windowCap: bigint): string {
  return windowLen === 0n && windowCap === 0n ? NO_WINDOW_TEXT : EVM_EIP712_WINDOW_POINTER;
}

/** The site's choice of how to show an amount: its decimal point (0 to 18
 *  digits after it) and its symbol (1 to 8 visible characters, the first a
 *  letter). It cannot change the amount: the digits are the amount's own. */
export interface SiteAmount { decimals: number; symbol: string }

/** `amountLabel`: the fixed words, then the base's site amount label, space-padded to 49 bytes. */
export function amountLabelText(amount: bigint, site: SiteAmount): string {
  if (!site || typeof site !== 'object') throw new Error('eip712: an amount needs the site\'s decimals and symbol');
  return EVM_EIP712_AMOUNT_LABEL_PREFIX + ascii(siteAmountLabelBytes(amount, site.decimals, site.symbol));
}

/** A Solana key as shown: its base58 text, space-padded to 44 bytes. */
export const solanaKeyText = (key: Uint8Array): string => ascii(base58Text32Bytes(key));

/** `IssueGrant.passkeyRp`: the base's "not applicable" for an all-zero RP hash
 *  (only a grant whose RP pin is never checked: no passkey grantee, or one
 *  that cannot spend), else the pointer to `passkeyRpHash`. */
export function passkeyRpWord(rpIdHash: Uint8Array): string {
  return rpIdHash.every((b) => b === 0) ? NOT_APPLICABLE_TEXT : EVM_EIP712_PASSKEY_RP_POINTER;
}

export function labelOf(member: 'recipientKind' | 'envelope', v: bigint): string {
  if (typeof v !== 'bigint') throw new Error(`eip712: ${member} is a bigint`);
  return member === 'recipientKind' ? recipientKindLabel(v) : k256EnvelopeLabel(v);
}
const isZeroPadded = (tag: Uint8Array, text: string) => tag.length === 32 && tag.every((c, i) => c === (i < text.length ? text.charCodeAt(i) : 0));

/** The nested type and member values of a device descriptor. Refuses an
 *  unregistered tag and a passkey origin that is not visible ASCII. */
export function deviceMember(d: EvmEip712DescriptorInput): { type: string; value: Record<string, unknown> } {
  const scheme = tagText(d.tag);
  const type = DEVICE_TAGS[scheme];
  if (!type || !isZeroPadded(d.tag, scheme)) throw new Error('descriptor: not a registered device tag');
  switch (type) {
    case 'EvmDevice': return { type, value: { scheme, wallet: evmChecksumAddress(d.address), privacySalt: toHex(d.key2) } };
    case 'SolanaDevice': return { type, value: { scheme, publicKey: solanaKeyText(d.key), privacySalt: toHex(d.key2) } };
    case 'JubjubDevice': return { type, value: { scheme, x: toHex(d.key), y: toHex(d.key2) } };
    case 'K256Device': return { type, value: { scheme, x: toHex(rev(d.key)), y: toHex(rev(d.key2)), envelope: labelOf('envelope', d.envelope) } };
    default: {
      // the circuit's order (evm_eip712_device_descriptor_hash) and messages:
      // the origin, then the RP hash, a passkey's own pin, never zero
      const origin = visibleText(d.origin);
      if (d.rp_id_hash.every((b) => b === 0)) throw new Error("evm_eip712: a passkey's RP hash is zero");
      return { type, value: { scheme, x: toHex(rev(d.key)), y: toHex(rev(d.key2)), origin, passkeyRpHash: toHex(d.rp_id_hash) } };
    }
  }
}

/** The nested type and member values of a grantee descriptor. */
/** The RFC 8032 encoding of the Ed25519 identity (y = 1, x = 0). */
const ED25519_IDENTITY_ENCODING = (() => { const b = new Uint8Array(32); b[0] = 1; return b; })();

export function granteeMember(g: EvmEip712GranteeInput): { type: string; value: Record<string, unknown> } {
  // The grantee checks, in the order issue_grant_with_evm_eip712 and
  // revoke_grant_with_evm_eip712 reach them and with their messages: the
  // registered grant-id tag (evm_eip712_grantee_scheme), a
  // Solana grantee's key not the identity (the base's ed25519 class), then
  // the descriptor (evm_eip712_grantee_descriptor_hash): the site label, the
  // passkey origin, the k256 envelope.
  const scheme = tagText(g.tag);
  const type = GRANTEE_TAGS[scheme];
  if (!type || !isZeroPadded(g.tag, scheme)) throw new Error('evm_eip712: not a registered grant-id tag');
  if (type === 'SolanaGrantee' && g.key.length === 32 && g.key.every((b, i) => b === ED25519_IDENTITY_ENCODING[i])) {
    throw new Error('descriptor: the Ed25519 key is the identity');
  }
  const label = (): string => { try { return siteLabelText(g.label); } catch { throw new Error('evm_eip712: not a site label'); } };
  const slot = u8(g.slot, 'slot');
  switch (type) {
    case 'EvmGrantee': return { type, value: { scheme, wallet: evmChecksumAddress(g.address), privacySalt: toHex(g.key2), siteLabel: label(), slot } };
    case 'SolanaGrantee': return { type, value: { scheme, publicKey: solanaKeyText(g.key), privacySalt: toHex(g.key2), siteLabel: label(), slot } };
    case 'JubjubGrantee': return { type, value: { scheme, x: toHex(g.key), y: toHex(g.key2), siteLabelHash: toHex(g.origin_hash), slot } };
    case 'K256Grantee': {
      if (typeof g.envelope !== 'bigint' || g.envelope > 1n) throw new Error('evm_eip712: not a k256 envelope');
      return { type, value: { scheme, x: toHex(rev(g.key)), y: toHex(rev(g.key2)), envelope: labelOf('envelope', g.envelope), siteLabelHash: toHex(g.origin_hash), slot } };
    }
    default: {
      if (!g.origin.every((c) => c >= 33 && c <= 126)) throw new Error('evm_eip712: the passkey origin is not visible ASCII');
      return { type, value: { scheme, x: toHex(rev(g.key)), y: toHex(rev(g.key2)), origin: visibleText(g.origin), slot } };
    }
  }
}

// ── Builders: one per operation and role ─────────────────────────────────────
//
// Strict: every integer is range-checked for its EIP-712 type here, before any
// wallet sees the message (a refusal at the client layer).

const uint = (bits: number) => (v: bigint, what: string): string => {
  if (typeof v !== 'bigint' || v < 0n || v >= 1n << BigInt(bits)) throw new Error(`eip712: ${what} is not a uint${bits}`);
  return v.toString();
};
const u8 = uint(8), u32 = uint(32), u64 = uint(64), u128 = uint(128);
const b32 = (b: Uint8Array, what: string): string => {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`eip712: ${what} is 32 bytes`);
  return toHex(b);
};

export interface DeviceFrame { account: Uint8Array; device: Uint8Array; authNonce: bigint }
export interface GranteeFrame { account: Uint8Array; grantee: Uint8Array; label: Uint8Array; slot: bigint; issuedAt: bigint; grantNonce: bigint }
export interface SpentCoin { nonce: Uint8Array; value: bigint; mtIndex: bigint }

const frame = (c: DeviceFrame) => ({ account: b32(c.account, 'account'), device: evmChecksumAddress(c.device), authNonce: u64(c.authNonce, 'authNonce') });
const gframe = (c: GranteeFrame) => ({
  account: b32(c.account, 'account'), grantee: evmChecksumAddress(c.grantee), siteLabel: siteLabelText(c.label),
  slot: u8(c.slot, 'slot'), issuedAt: u64(c.issuedAt, 'issuedAt'), grantNonce: u64(c.grantNonce, 'grantNonce'),
});
const amountFields = (amount: bigint, site: SiteAmount) => ({ amount: u128(amount, 'amount'), amountLabel: amountLabelText(amount, site) });
const coinFields = (coin: SpentCoin, amount: bigint) => {
  u128(amount, 'amount');
  if (u128(coin.value, 'coinValue') && coin.value < amount) throw new Error('eip712: the spent coin is smaller than the amount');
  return { coinNonce: b32(coin.nonce, 'coinNonce'), coinValue: coin.value.toString(), coinMerkleIndex: u64(coin.mtIndex, 'coinMerkleIndex'), change: (coin.value - amount).toString() };
};
const typed = (account: Uint8Array, primaryType: string, message: Record<string, unknown>, nested?: string): Eip712TypedData =>
  ({ domain: evmEip712Domain(account), types: typesFor(primaryType, nested), primaryType, message });

export const evmEip712Messages = {
  withdrawUnshielded: (c: DeviceFrame, color: Uint8Array, amount: bigint, recipient: Uint8Array, site: SiteAmount) =>
    typed(c.account, 'WithdrawUnshielded', { ...frame(c), color: b32(color, 'color'), ...amountFields(amount, site), recipient: toHex(recipient) }),
  withdrawShielded: (c: DeviceFrame, color: Uint8Array, amount: bigint, recipient: Uint8Array, coin: SpentCoin, site: SiteAmount) =>
    typed(c.account, 'WithdrawShielded', { ...frame(c), color: b32(color, 'color'), ...amountFields(amount, site), recipient: toHex(recipient), ...coinFields(coin, amount) }),
  withdrawShieldedToContract: (c: DeviceFrame, color: Uint8Array, amount: bigint, recipientContract: Uint8Array, coin: SpentCoin, site: SiteAmount) =>
    typed(c.account, 'WithdrawShieldedToContract', { ...frame(c), color: b32(color, 'color'), ...amountFields(amount, site), recipientContract: toHex(recipientContract), ...coinFields(coin, amount) }),
  appendInbox: (c: DeviceFrame, entry: Uint8Array) => {
    if (entry.length !== 192) throw new Error('eip712: an inbox entry is 192 bytes');
    return typed(c.account, 'AppendInbox', { ...frame(c), entry: toHex(entry) });
  },
  rotateEncKey: (c: DeviceFrame, newKey: Uint8Array) =>
    typed(c.account, 'RotateEncKey', { ...frame(c), effect: EVM_EIP712_EFFECTS.RotateEncKey, newKey: toHex(newKey) }),
  addDevice: (c: DeviceFrame, d: EvmEip712DescriptorInput) => {
    const m = deviceMember(d);
    return typed(c.account, 'AddDevice', { ...frame(c), effect: EVM_EIP712_EFFECTS.AddDevice, newDevice: m.value }, m.type);
  },
  removeDevice: (c: DeviceFrame, d: EvmEip712DescriptorInput, targetEpoch: bigint, targetCounter: bigint) => {
    const m = deviceMember(d);
    return typed(c.account, 'RemoveDevice', { ...frame(c), target: m.value, targetEpoch: u32(targetEpoch, 'targetEpoch'), targetCounter: u64(targetCounter, 'targetCounter') }, m.type);
  },
  removeUnknownDevice: (c: DeviceFrame, entry: Uint8Array) =>
    typed(c.account, 'RemoveUnknownDevice', { ...frame(c), effect: EVM_EIP712_EFFECTS.RemoveUnknownDevice, entry: toHex(entry) }),
  issueGrant: (c: DeviceFrame, g: EvmEip712GranteeInput, s: IssueScope) => {
    // Every issue rule, in the order issue_grant_with_evm_eip712 asserts it
    // and with its message, so a wallet is never asked to sign a grant the
    // circuit refuses: the read key is shown, and stored as its hash, exactly
    // when `read` is on; the grantee (granteeMember); the passkey RP hash is
    // non-zero exactly for a passkey grantee whose scope can spend, because
    // upstream checks it only on the passkey spend path; "any recipient"
    // carries no recipient; the recipient kind has a label; then the shared
    // chip's rules.
    const readZero = s.readPk.every((b) => b === 0);
    if (!s.read && !readZero) throw new Error('evm_eip712: a read key without read');
    if (s.read && readZero) throw new Error('evm_eip712: read without a read key');
    const m = granteeMember(g);
    const rpZero = s.rpIdHash.every((b) => b === 0);
    const rpPinned = m.type === 'PasskeyGrantee' && (s.opWithdrawUnshielded || s.opWithdrawShielded || s.opWithdrawShieldedToContract);
    if (!rpPinned && !rpZero) throw new Error('evm_eip712: an RP hash belongs to a spending passkey grant');
    if (rpPinned && rpZero) throw new Error("evm_eip712: a spending passkey grant's RP hash is zero");
    if (s.recipientKind === 0n && !s.recipient.every((b) => b === 0)) throw new Error('evm_eip712: a recipient for any recipient');
    if (typeof s.recipientKind !== 'bigint' || s.recipientKind < 0n || s.recipientKind > 3n) throw new Error('evm_eip712: not a recipient kind');
    // Then upstream's shared chip (do_issue_grant, after the seam): its issue
    // rules in its order and with its messages. Two of its checks have no
    // client counterpart: "grant already active" reads the ledger, and "read
    // without delegate key" cannot fire after the arm's rule above (the stored
    // read_pk_hash is the hash of a non-zero key).
    const spend = s.opWithdrawUnshielded || s.opWithdrawShielded || s.opWithdrawShieldedToContract;
    if (!spend && !s.read) throw new Error('empty scope');
    if (!spend && s.caller) throw new Error('read-only grant cannot restrict caller');
    if ((s.opWithdrawShielded || s.opWithdrawShieldedToContract) && !s.read) throw new Error('shielded spend requires read');
    if (s.perCallCap > s.cap) throw new Error('per-call cap above cap');
    if (spend && s.cap === 0n) throw new Error('spend without cap');
    if (spend && s.maxCoinValue < s.perCallCap) throw new Error('coin bound below per-call cap');
    if (s.windowLen !== 0n || s.windowCap !== 0n) throw new Error('window bounds reserved');
    if (!spend && (!s.color.every((b) => b === 0) || s.recipientKind !== 0n || !s.recipient.every((b) => b === 0)
      || s.maxCoinValue !== 0n || s.perCallCap !== 0n || s.cap !== 0n)) throw new Error('read-only grant carries object fields');
    return typed(c.account, 'IssueGrant', {
      ...frame(c), effect: EVM_EIP712_EFFECTS.IssueGrant, grantee: m.value,
      withdrawUnshielded: s.opWithdrawUnshielded, withdrawShielded: s.opWithdrawShielded,
      withdrawShieldedToContract: s.opWithdrawShieldedToContract, read: s.read,
      color: b32(s.color, 'color'), recipientKind: labelOf('recipientKind', s.recipientKind), recipient: b32(s.recipient, 'recipient'),
      maxCoinValue: u128(s.maxCoinValue, 'maxCoinValue'), perCallCap: u128(s.perCallCap, 'perCallCap'), cap: u128(s.cap, 'cap'),
      expiresAt: u64(s.expiresAt, 'expiresAt'), expiry: expiryText(s.expiresAt),
      passkeyRpHash: b32(s.rpIdHash, 'passkeyRpHash'), passkeyRp: passkeyRpWord(s.rpIdHash), readKey: b32(s.read ? s.readPk : new Uint8Array(32), 'readKey'),
      windowLength: u64(s.windowLen, 'windowLength'), windowCap: u128(s.windowCap, 'windowCap'), window: windowWord(s.windowLen, s.windowCap),
      callerPinned: !!s.caller, caller: toHex(s.caller ?? new Uint8Array(32)),
    }, m.type);
  },
  revokeGrant: (c: DeviceFrame, g: EvmEip712GranteeInput) => {
    const m = granteeMember(g);
    return typed(c.account, 'RevokeGrant', { ...frame(c), grantee: m.value }, m.type);
  },
  revokeAllGrants: (c: DeviceFrame) => typed(c.account, 'RevokeAllGrants', frame(c)),
  publishRecoverySession: (c: DeviceFrame, r: RecoverySession) => {
    if (r.wrap.length !== 64) throw new Error('eip712: the recovery wrap is 64 bytes');
    return typed(c.account, 'PublishRecoverySession', {
      ...frame(c), effect: EVM_EIP712_EFFECTS.PublishRecoverySession,
      recoveryKeyX: toHex(fieldLE(r.recoveryPk.x)), recoveryKeyY: toHex(fieldLE(r.recoveryPk.y)), sessionNonce: toHex(r.sessionNonce),
      phi1: toHex(fieldLE(r.phi[0])), phi2: toHex(fieldLE(r.phi[1])), phi3: toHex(fieldLE(r.phi[2])), phi4: toHex(fieldLE(r.phi[3])),
      phiLength: u8(r.phiLen, 'phiLength'), wrap: toHex(r.wrap),
    });
  },
  cancelRecovery: (c: DeviceFrame) => typed(c.account, 'CancelRecovery', frame(c)),
  withdrawUnshieldedAsGrantee: (c: GranteeFrame, color: Uint8Array, amount: bigint, recipient: Uint8Array, site: SiteAmount) =>
    typed(c.account, 'WithdrawUnshieldedAsGrantee', { ...gframe(c), color: b32(color, 'color'), ...amountFields(amount, site), recipient: toHex(recipient) }),
  withdrawShieldedAsGrantee: (c: GranteeFrame, color: Uint8Array, amount: bigint, recipient: Uint8Array, changeEntry: Uint8Array, encPk: Uint8Array, coin: SpentCoin, site: SiteAmount) => {
    if (changeEntry.length !== 192) throw new Error('eip712: a change entry is 192 bytes');
    return typed(c.account, 'WithdrawShieldedAsGrantee', { ...gframe(c), color: b32(color, 'color'), ...amountFields(amount, site), recipient: toHex(recipient),
      changeEntry: toHex(changeEntry), encryptionKey: toHex(encPk), ...coinFields(coin, amount) });
  },
  withdrawShieldedToContractAsGrantee: (c: GranteeFrame, color: Uint8Array, amount: bigint, recipientContract: Uint8Array, changeEntry: Uint8Array, encPk: Uint8Array, coin: SpentCoin, site: SiteAmount) => {
    if (changeEntry.length !== 192) throw new Error('eip712: a change entry is 192 bytes');
    return typed(c.account, 'WithdrawShieldedToContractAsGrantee', { ...gframe(c), color: b32(color, 'color'), ...amountFields(amount, site), recipientContract: toHex(recipientContract),
      changeEntry: toHex(changeEntry), encryptionKey: toHex(encPk), ...coinFields(coin, amount) });
  },
};

export interface IssueScope {
  opWithdrawUnshielded: boolean; opWithdrawShielded: boolean; opWithdrawShieldedToContract: boolean; read: boolean;
  color: Uint8Array; recipientKind: bigint; recipient: Uint8Array; maxCoinValue: bigint; perCallCap: bigint; cap: bigint;
  expiresAt: bigint; rpIdHash: Uint8Array; readPk: Uint8Array; windowLen: bigint; windowCap: bigint;
  /** The pinned caller contract's 32-byte address, or null. */
  caller: Uint8Array | null;
}

export interface RecoverySession {
  recoveryPk: { x: bigint; y: bigint }; sessionNonce: Uint8Array;
  phi: readonly [bigint, bigint, bigint, bigint]; phiLen: bigint; wrap: Uint8Array;
}

/** A Field value (or JubJub coordinate) as the contract encodes it: 32 bytes little-endian. */
export function fieldLE(v: bigint): Uint8Array {
  const o = new Uint8Array(32);
  let x = v;
  for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; }
  if (x !== 0n) throw new Error('eip712: a field value is below 2^256');
  return o;
}

/** The digest the wallet signs, as JSON for a browser wallet. */
export const typedDataJson = (t: Eip712TypedData): string => JSON.stringify(t);
