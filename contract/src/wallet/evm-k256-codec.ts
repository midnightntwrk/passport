// The `evm_k256` arm's EIP-712 codec, client side (byte contract:
// contract/EVM-K256.md; circuit side: contracts/modules/EvmK256.compact).
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
// executes (its exported `evm_k256_struct_*` and `eip712_v1_digest` pure
// circuits; the domain is the fixed V1 domain of modules/Eip712V1). The offline suite checks that both agree on every frozen vector,
// and evm-k256-viem.ts checks the JSON against viem's hashTypedData.
//
// Platform-neutral: no node: imports, so a browser page can use it.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { DESCRIPTOR_TAGS, evmChecksumAddress, type DescriptorScheme } from './descriptors.js';
import { recipientKindLabel, k256EnvelopeLabel } from './labels.js';
import { NOT_APPLICABLE_TEXT, NO_WINDOW_TEXT, expiryDateTimeText, base58Text32Bytes, siteAmountLabelBytes } from './rendering.js';

// ── The frozen type set (version "1") ────────────────────────────────────────

// The fixed V1 domain (the contract's modules/Eip712V1): one domain for every
// account and network. The account is bound by each message's `account`
// member; there is no chainId, salt or network value. verifyingContract is
// the EIP-55 form of the low 20 bytes of keccak256("midnight:passport:evm:v1").
export const EIP712_V1_DOMAIN_NAME = 'Midnight Passport';
export const EIP712_V1_DOMAIN_VERSION = '1';
export const EIP712_V1_VERIFYING_CONTRACT_TEXT = 'midnight:passport:evm:v1';
export const EIP712_V1_VERIFYING_CONTRACT = '0x596e089eF2D7308208B9e8f7e1A147942a84104F';

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

// ── Enrolment kinds ──────────────────────────────────────────────────────────
//
// The client copy of the contract's evm_k256_kinds() (modules/EvmK256,
// "Enrolment kinds"): one entry per kind of key the arm can add, remove or
// grant to, keyed by its descriptor scheme, in the contract's order. A kind
// is named by its device and grant-id tags (descriptors.ts DESCRIPTOR_TAGS),
// shows its key in the members of its payload form, and has its own nested
// types. A kind whose key fits an existing form is added as one entry here
// and one in the contract; every table and dispatch below follows from it.
// The offline suite checks the two lists against each other.

/** How a kind's key is shown and derived (the contract's EvmK256Payload,
 *  in its order). */
export type EvmK256Payload = 'address' | 'ed25519' | 'jubjub' | 'k256' | 'passkey';
export const EVM_K256_PAYLOADS: readonly EvmK256Payload[] = ['address', 'ed25519', 'jubjub', 'k256', 'passkey'];

export type EvmK256KeyText = 'base58' | 'prefixed_base58' | 'hex';
export const EVM_K256_KEY_TEXTS: readonly EvmK256KeyText[] = ['base58', 'prefixed_base58', 'hex'];
export const EVM_K256_ED25519_KEY_PREFIX = 'ed25519:';

/** One enrolment kind: its payload form and its nested typed-data types. */
export interface EvmK256Kind {
  readonly payload: EvmK256Payload;
  /** The Ed25519 publicKey text; omitted means base58. */
  readonly keyText?: EvmK256KeyText;
  readonly deviceType: string;
  readonly granteeType: string;
}

export const EVM_K256_KINDS = {
  evm_k256: { payload: 'address', deviceType: 'EvmDevice', granteeType: 'EvmGrantee' },
  sol_ed25519: { payload: 'ed25519', deviceType: 'SolanaDevice', granteeType: 'SolanaGrantee' },
  jubjub: { payload: 'jubjub', deviceType: 'JubjubDevice', granteeType: 'JubjubGrantee' },
  k256: { payload: 'k256', deviceType: 'K256Device', granteeType: 'K256Grantee' },
  p256: { payload: 'passkey', deviceType: 'PasskeyDevice', granteeType: 'PasskeyGrantee' },
} as const satisfies Readonly<Record<DescriptorScheme, EvmK256Kind>>;

export type EvmK256KindScheme = keyof typeof EVM_K256_KINDS;
export const EVM_K256_KIND_SCHEMES: readonly EvmK256KindScheme[] = Object.keys(EVM_K256_KINDS) as EvmK256KindScheme[];

/** Each payload form: the members its nested types carry after `scheme`,
 *  and their values from a descriptor input, with the circuit's checks in
 *  its order and with its messages (evm_k256_device_descriptor_hash,
 *  evm_k256_grantee_descriptor_hash). */
const PAYLOADS: Readonly<Record<EvmK256Payload, {
  deviceMembers: [string, string][];
  granteeMembers: [string, string][];
  device: (d: EvmK256DescriptorInput, keyText?: EvmK256KeyText) => Record<string, unknown>;
  grantee: (g: EvmK256GranteeInput, label: () => string, slot: string, keyText?: EvmK256KeyText) => Record<string, unknown>;
}>> = {
  address: {
    deviceMembers: [['wallet', 'address'], ['privacySalt', 'bytes32']],
    granteeMembers: [['wallet', 'address'], ['privacySalt', 'bytes32'], ['siteLabel', 'string'], ['slot', 'uint8']],
    device: (d) => ({ wallet: evmChecksumAddress(d.address), privacySalt: toHex(d.key2) }),
    grantee: (g, label, slot) => ({ wallet: evmChecksumAddress(g.address), privacySalt: toHex(g.key2), siteLabel: label(), slot }),
  },
  ed25519: {
    deviceMembers: [['publicKey', 'string'], ['privacySalt', 'bytes32']],
    granteeMembers: [['publicKey', 'string'], ['privacySalt', 'bytes32'], ['siteLabel', 'string'], ['slot', 'uint8']],
    device: (d, keyText) => ({ publicKey: ed25519DisplayText(d.key, keyText), privacySalt: toHex(d.key2) }),
    grantee: (g, label, slot, keyText) => ({ publicKey: ed25519DisplayText(g.key, keyText), privacySalt: toHex(g.key2), siteLabel: label(), slot }),
  },
  jubjub: {
    deviceMembers: [['x', 'bytes32'], ['y', 'bytes32']],
    granteeMembers: [['x', 'bytes32'], ['y', 'bytes32'], ['siteLabelHash', 'bytes32'], ['slot', 'uint8']],
    device: (d) => ({ x: toHex(d.key), y: toHex(d.key2) }),
    grantee: (g, _label, slot) => ({ x: toHex(g.key), y: toHex(g.key2), siteLabelHash: toHex(g.origin_hash), slot }),
  },
  k256: {
    deviceMembers: [['x', 'bytes32'], ['y', 'bytes32'], ['envelope', 'string']],
    granteeMembers: [['x', 'bytes32'], ['y', 'bytes32'], ['envelope', 'string'], ['siteLabelHash', 'bytes32'], ['slot', 'uint8']],
    device: (d) => ({ x: toHex(rev(d.key)), y: toHex(rev(d.key2)), envelope: labelOf('envelope', d.envelope) }),
    grantee: (g, _label, slot) => {
      if (typeof g.envelope !== 'bigint' || g.envelope > 1n) throw new Error('evm_k256: not a k256 envelope');
      return { x: toHex(rev(g.key)), y: toHex(rev(g.key2)), envelope: labelOf('envelope', g.envelope), siteLabelHash: toHex(g.origin_hash), slot };
    },
  },
  passkey: {
    deviceMembers: [['x', 'bytes32'], ['y', 'bytes32'], ['origin', 'string'], ['passkeyRpHash', 'bytes32']],
    granteeMembers: [['x', 'bytes32'], ['y', 'bytes32'], ['origin', 'string'], ['slot', 'uint8']],
    device: (d) => {
      // the origin, then the RP hash, a passkey's own pin, never zero
      const origin = visibleText(d.origin);
      if (d.rp_id_hash.every((b) => b === 0)) throw new Error("evm_k256: a passkey's RP hash is zero");
      return { x: toHex(rev(d.key)), y: toHex(rev(d.key2)), origin, passkeyRpHash: toHex(d.rp_id_hash) };
    },
    grantee: (g, _label, slot) => {
      if (!g.origin.every((c) => c >= 33 && c <= 126)) throw new Error('evm_k256: the passkey origin is not visible ASCII');
      return { x: toHex(rev(g.key)), y: toHex(rev(g.key2)), origin: visibleText(g.origin), slot };
    },
  },
};

const KINDS = EVM_K256_KIND_SCHEMES.map((scheme) => ({ scheme, ...(EVM_K256_KINDS[scheme] as EvmK256Kind) }));

/** The nested descriptor types: each kind's <Kind>Device and <Kind>Grantee. */
export const EVM_K256_DESCRIPTOR_TYPES: TypeSet = Object.fromEntries([
  ...KINDS.map((k) => [k.deviceType, f([['scheme', 'string'], ...PAYLOADS[k.payload].deviceMembers])]),
  ...KINDS.map((k) => [k.granteeType, f([['scheme', 'string'], ...PAYLOADS[k.payload].granteeMembers])]),
]);

/** The 16 primary types; `<Device>` / `<Grantee>` is the scheme's nested type. */
export const EVM_K256_PRIMARY_TYPES: Record<string, [string, string][]> = {
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
export const EVM_K256_EFFECTS = {
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

/** The fixed V1 domain, as a fresh object (callers may edit the typed data
 *  they hold without touching the constant). */
export const eip712V1Domain = (): Eip712Domain => ({
  name: EIP712_V1_DOMAIN_NAME, version: EIP712_V1_DOMAIN_VERSION, verifyingContract: EIP712_V1_VERIFYING_CONTRACT,
});

/** Refuses typed data that is not under the fixed V1 domain, before a
 *  wallet is asked to sign it: the domain must be exactly eip712V1Domain()
 *  (no other member, such as a chainId or a salt) and its EIP712Domain type
 *  exactly the V1 type. The circuits verify V1 digests only, so a signature
 *  under any other domain would be refused after the wallet had shown the
 *  user a request that cannot succeed. Returns the typed data unchanged. */
export function checkEip712V1TypedData(t: Eip712TypedData): Eip712TypedData {
  const d = (t?.domain ?? undefined) as unknown as Record<string, unknown> | undefined;
  const want = eip712V1Domain() as unknown as Record<string, unknown>;
  const keys = d !== undefined && typeof d === 'object' ? Object.keys(d) : [];
  if (keys.length !== 3 || !keys.every((k) => Object.prototype.hasOwnProperty.call(want, k) && d![k] === want[k])) {
    throw new Error('eip712: not the fixed V1 domain (name "Midnight Passport", version "1", verifyingContract P, and no other member)');
  }
  const ty = t.types?.EIP712Domain as unknown;
  if (!Array.isArray(ty) || ty.length !== DOMAIN_TYPE.length
    || !ty.every((x, i) => x !== null && typeof x === 'object' && Object.keys(x).length === 2 && x.name === DOMAIN_TYPE[i].name && x.type === DOMAIN_TYPE[i].type)) {
    throw new Error('eip712: the EIP712Domain type is not the V1 type (string name, string version, address verifyingContract)');
  }
  return t;
}

/** The type set of one message: the primary type, its nested type if any, and
 *  EIP712Domain (viem and ethers refuse unused types, so nothing else). */
export function typesFor(primary: string, nested?: string): TypeSet {
  const spec = EVM_K256_PRIMARY_TYPES[primary];
  if (!spec) throw new Error(`eip712: unknown operation ${primary}`);
  const needs = spec.some(([, t]) => t.startsWith('<'));
  if (needs !== !!nested) throw new Error(`eip712: ${primary} ${needs ? 'needs' : 'takes no'} nested descriptor type`);
  if (nested && !EVM_K256_DESCRIPTOR_TYPES[nested]) throw new Error(`eip712: unknown descriptor type ${nested}`);
  const types: TypeSet = { EIP712Domain: DOMAIN_TYPE, [primary]: f(spec.map(([n, t]) => [n, t.startsWith('<') ? nested! : t])) };
  if (nested) types[nested] = EVM_K256_DESCRIPTOR_TYPES[nested];
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

/** The circuit's `EvmK256Descriptor`. */
export interface EvmK256DescriptorInput {
  tag: Uint8Array; key: Uint8Array; key2: Uint8Array; address: Uint8Array;
  envelope: bigint; rp_id_hash: Uint8Array; origin: Uint8Array;
}
/** The circuit's `EvmK256GranteeDescriptor`. */
export interface EvmK256GranteeInput {
  tag: Uint8Array; key: Uint8Array; key2: Uint8Array; address: Uint8Array; envelope: bigint;
  origin: Uint8Array; label: Uint8Array; origin_hash: Uint8Array; slot: bigint;
}

/** The kind a descriptor input names by its tag (the device tag for a
 *  device, the grant-id tag for a grantee), with its scheme and the tag's
 *  text; undefined for a tag of no kind, or a registered text with non-zero
 *  padding. */
export function evmK256KindOf(recipe: 'device' | 'grant-id', tag: Uint8Array): (EvmK256Kind & { scheme: EvmK256KindScheme; text: string }) | undefined {
  const text = tagText(tag);
  const k = KINDS.find((x) => DESCRIPTOR_TAGS[recipe][x.scheme] === text);
  return k && isZeroPadded(tag, text) ? { ...k, text } : undefined;
}
/** The enumerated members' text labels are the base's shared texts
 *  (labels.ts): the circuit hashes the same constant, selected by the value,
 *  and refuses a value with no label. */
/** The arm's pointer texts, shown when the value is not the one the base's
 *  word names. Each points at the typed members that carry the value. */
export const EVM_K256_PASSKEY_RP_POINTER = 'see passkeyRpHash';
export const EVM_K256_WINDOW_POINTER = 'see windowLength and windowCap';
/** The fixed words before the site's amount label: the label is the site's
 *  claim, not a value the contract knows. */
export const EVM_K256_AMOUNT_LABEL_PREFIX = 'This site labels it: ';

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
  return windowLen === 0n && windowCap === 0n ? NO_WINDOW_TEXT : EVM_K256_WINDOW_POINTER;
}

/** The site's choice of how to show an amount: its decimal point (0 to 18
 *  digits after it) and its symbol (1 to 8 visible characters, the first a
 *  letter). It cannot change the amount: the digits are the amount's own. */
export interface SiteAmount { decimals: number; symbol: string }

/** `amountLabel`: the fixed words, then the base's site amount label, space-padded to 49 bytes. */
export function amountLabelText(amount: bigint, site: SiteAmount): string {
  if (!site || typeof site !== 'object') throw new Error('eip712: an amount needs the site\'s decimals and symbol');
  return EVM_K256_AMOUNT_LABEL_PREFIX + ascii(siteAmountLabelBytes(amount, site.decimals, site.symbol));
}

/** An ed25519 kind's key as shown: its base58 text, space-padded to 44 bytes. */
export const ed25519Base58Text = (key: Uint8Array): string => ascii(base58Text32Bytes(key));

/** Per-kind publicKey text; the default base58 stays space-padded to 44 bytes. */
export function ed25519DisplayText(key: Uint8Array, form: EvmK256KeyText = 'base58'): string {
  if (key.length !== 32) throw new Error('eip712: an Ed25519 key is 32 bytes');
  if (form === 'hex') return toHex(key).slice(2);
  const text = ed25519Base58Text(key);
  return form === 'prefixed_base58' ? EVM_K256_ED25519_KEY_PREFIX + text : text;
}

/** `IssueGrant.passkeyRp`: the base's "not applicable" for an all-zero RP hash
 *  (only a grant whose RP pin is never checked: no passkey grantee, or one
 *  that cannot spend), else the pointer to `passkeyRpHash`. */
export function passkeyRpWord(rpIdHash: Uint8Array): string {
  return rpIdHash.every((b) => b === 0) ? NOT_APPLICABLE_TEXT : EVM_K256_PASSKEY_RP_POINTER;
}

export function labelOf(member: 'recipientKind' | 'envelope', v: bigint): string {
  if (typeof v !== 'bigint') throw new Error(`eip712: ${member} is a bigint`);
  return member === 'recipientKind' ? recipientKindLabel(v) : k256EnvelopeLabel(v);
}
function isZeroPadded(tag: Uint8Array, text: string): boolean {
  return tag.length === 32 && tag.every((c, i) => c === (i < text.length ? text.charCodeAt(i) : 0));
}

/** The nested type and member values of a device descriptor, and its kind's
 *  payload form. Refuses a tag of no kind and a passkey origin that is not
 *  visible ASCII. */
export function deviceMember(d: EvmK256DescriptorInput): { type: string; value: Record<string, unknown>; payload: EvmK256Payload } {
  const k = evmK256KindOf('device', d.tag);
  if (!k) throw new Error('descriptor: not a registered device tag');
  return { type: k.deviceType, value: { scheme: k.text, ...PAYLOADS[k.payload].device(d, k.keyText) }, payload: k.payload };
}

/** The RFC 8032 encoding of the Ed25519 identity (y = 1, x = 0). */
const ED25519_IDENTITY_ENCODING = (() => { const b = new Uint8Array(32); b[0] = 1; return b; })();

/** The nested type and member values of a grantee descriptor, and its kind's
 *  payload form. */
export function granteeMember(g: EvmK256GranteeInput): { type: string; value: Record<string, unknown>; payload: EvmK256Payload } {
  // The grantee checks, in the order issue_grant_with_evm_k256 and
  // revoke_grant_with_evm_k256 reach them and with their messages: the
  // kind's grant-id tag (evm_k256_grantee_kind), an Ed25519 grantee's key
  // not the identity (the base's ed25519 class), then the descriptor
  // (evm_k256_grantee_descriptor_hash): the site label, the passkey origin,
  // the k256 envelope.
  const k = evmK256KindOf('grant-id', g.tag);
  if (!k) throw new Error('evm_k256: not a registered grant-id tag');
  if (k.payload === 'ed25519' && g.key.length === 32 && g.key.every((b, i) => b === ED25519_IDENTITY_ENCODING[i])) {
    throw new Error('descriptor: the Ed25519 key is the identity');
  }
  const label = (): string => { try { return siteLabelText(g.label); } catch { throw new Error('evm_k256: not a site label'); } };
  const slot = u8(g.slot, 'slot');
  return { type: k.granteeType, value: { scheme: k.text, ...PAYLOADS[k.payload].grantee(g, label, slot, k.keyText) }, payload: k.payload };
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
const typed = (primaryType: string, message: Record<string, unknown>, nested?: string): Eip712TypedData =>
  ({ domain: eip712V1Domain(), types: typesFor(primaryType, nested), primaryType, message });

export const evmK256Messages = {
  withdrawUnshielded: (c: DeviceFrame, color: Uint8Array, amount: bigint, recipient: Uint8Array, site: SiteAmount) =>
    typed('WithdrawUnshielded', { ...frame(c), color: b32(color, 'color'), ...amountFields(amount, site), recipient: toHex(recipient) }),
  withdrawShielded: (c: DeviceFrame, color: Uint8Array, amount: bigint, recipient: Uint8Array, coin: SpentCoin, site: SiteAmount) =>
    typed('WithdrawShielded', { ...frame(c), color: b32(color, 'color'), ...amountFields(amount, site), recipient: toHex(recipient), ...coinFields(coin, amount) }),
  withdrawShieldedToContract: (c: DeviceFrame, color: Uint8Array, amount: bigint, recipientContract: Uint8Array, coin: SpentCoin, site: SiteAmount) =>
    typed('WithdrawShieldedToContract', { ...frame(c), color: b32(color, 'color'), ...amountFields(amount, site), recipientContract: toHex(recipientContract), ...coinFields(coin, amount) }),
  appendInbox: (c: DeviceFrame, entry: Uint8Array) => {
    if (entry.length !== 192) throw new Error('eip712: an inbox entry is 192 bytes');
    return typed('AppendInbox', { ...frame(c), entry: toHex(entry) });
  },
  rotateEncKey: (c: DeviceFrame, newKey: Uint8Array) =>
    typed('RotateEncKey', { ...frame(c), effect: EVM_K256_EFFECTS.RotateEncKey, newKey: toHex(newKey) }),
  addDevice: (c: DeviceFrame, d: EvmK256DescriptorInput) => {
    const m = deviceMember(d);
    return typed('AddDevice', { ...frame(c), effect: EVM_K256_EFFECTS.AddDevice, newDevice: m.value }, m.type);
  },
  removeDevice: (c: DeviceFrame, d: EvmK256DescriptorInput, targetEpoch: bigint, targetCounter: bigint) => {
    const m = deviceMember(d);
    return typed('RemoveDevice', { ...frame(c), target: m.value, targetEpoch: u32(targetEpoch, 'targetEpoch'), targetCounter: u64(targetCounter, 'targetCounter') }, m.type);
  },
  removeUnknownDevice: (c: DeviceFrame, entry: Uint8Array) =>
    typed('RemoveUnknownDevice', { ...frame(c), effect: EVM_K256_EFFECTS.RemoveUnknownDevice, entry: toHex(entry) }),
  issueGrant: (c: DeviceFrame, g: EvmK256GranteeInput, s: IssueScope) => {
    // Every issue rule, in the order issue_grant_with_evm_k256 asserts it
    // and with its message, so a wallet is never asked to sign a grant the
    // circuit refuses: the read key is shown, and stored as its hash, exactly
    // when `read` is on; the grantee (granteeMember); the passkey RP hash is
    // non-zero exactly for a passkey grantee whose scope can spend, because
    // upstream checks it only on the passkey spend path; "any recipient"
    // carries no recipient; the recipient kind has a label; then the shared
    // chip's rules.
    const readZero = s.readPk.every((b) => b === 0);
    if (!s.read && !readZero) throw new Error('evm_k256: a read key without read');
    if (s.read && readZero) throw new Error('evm_k256: read without a read key');
    const m = granteeMember(g);
    const rpZero = s.rpIdHash.every((b) => b === 0);
    const rpPinned = m.payload === 'passkey' && (s.opWithdrawUnshielded || s.opWithdrawShielded || s.opWithdrawShieldedToContract);
    if (!rpPinned && !rpZero) throw new Error('evm_k256: an RP hash belongs to a spending passkey grant');
    if (rpPinned && rpZero) throw new Error("evm_k256: a spending passkey grant's RP hash is zero");
    if (s.recipientKind === 0n && !s.recipient.every((b) => b === 0)) throw new Error('evm_k256: a recipient for any recipient');
    if (typeof s.recipientKind !== 'bigint' || s.recipientKind < 0n || s.recipientKind > 3n) throw new Error('evm_k256: not a recipient kind');
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
    return typed('IssueGrant', {
      ...frame(c), effect: EVM_K256_EFFECTS.IssueGrant, grantee: m.value,
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
  revokeGrant: (c: DeviceFrame, g: EvmK256GranteeInput) => {
    const m = granteeMember(g);
    return typed('RevokeGrant', { ...frame(c), grantee: m.value }, m.type);
  },
  revokeAllGrants: (c: DeviceFrame) => typed('RevokeAllGrants', frame(c)),
  publishRecoverySession: (c: DeviceFrame, r: RecoverySession) => {
    if (r.wrap.length !== 64) throw new Error('eip712: the recovery wrap is 64 bytes');
    return typed('PublishRecoverySession', {
      ...frame(c), effect: EVM_K256_EFFECTS.PublishRecoverySession,
      recoveryKeyX: toHex(fieldLE(r.recoveryPk.x)), recoveryKeyY: toHex(fieldLE(r.recoveryPk.y)), sessionNonce: toHex(r.sessionNonce),
      phi1: toHex(fieldLE(r.phi[0])), phi2: toHex(fieldLE(r.phi[1])), phi3: toHex(fieldLE(r.phi[2])), phi4: toHex(fieldLE(r.phi[3])),
      phiLength: u8(r.phiLen, 'phiLength'), wrap: toHex(r.wrap),
    });
  },
  cancelRecovery: (c: DeviceFrame) => typed('CancelRecovery', frame(c)),
  withdrawUnshieldedAsGrantee: (c: GranteeFrame, color: Uint8Array, amount: bigint, recipient: Uint8Array, site: SiteAmount) =>
    typed('WithdrawUnshieldedAsGrantee', { ...gframe(c), color: b32(color, 'color'), ...amountFields(amount, site), recipient: toHex(recipient) }),
  withdrawShieldedAsGrantee: (c: GranteeFrame, color: Uint8Array, amount: bigint, recipient: Uint8Array, changeEntry: Uint8Array, encPk: Uint8Array, coin: SpentCoin, site: SiteAmount) => {
    if (changeEntry.length !== 192) throw new Error('eip712: a change entry is 192 bytes');
    return typed('WithdrawShieldedAsGrantee', { ...gframe(c), color: b32(color, 'color'), ...amountFields(amount, site), recipient: toHex(recipient),
      changeEntry: toHex(changeEntry), encryptionKey: toHex(encPk), ...coinFields(coin, amount) });
  },
  withdrawShieldedToContractAsGrantee: (c: GranteeFrame, color: Uint8Array, amount: bigint, recipientContract: Uint8Array, changeEntry: Uint8Array, encPk: Uint8Array, coin: SpentCoin, site: SiteAmount) => {
    if (changeEntry.length !== 192) throw new Error('eip712: a change entry is 192 bytes');
    return typed('WithdrawShieldedToContractAsGrantee', { ...gframe(c), color: b32(color, 'color'), ...amountFields(amount, site), recipientContract: toHex(recipientContract),
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
