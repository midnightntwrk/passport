// Readable device descriptors — client encoders and strict decoders.
//
// A readable arm (one entry of READABLE_ARMS: `evm_k256`, `sol_ed25519`)
// shows another key as a DESCRIPTOR: the target recipe's tag text and the key
// payload in the target scheme's own form. The contract derives the target's
// device entry, boot commitment, or grant id from exactly those values, one
// circuit per payload class (contracts/modules/WalletArmDescriptors.compact):
// the byte classes w52, w64, w65 and w117, and the ed25519 class, which takes
// an Ed25519 key as its Curve25519Point with the key's 32 bytes and
// x-coordinate as checked inputs (ed25519KeyInputs). This module:
//
//   - parses the forms a person or a wallet presents (an Ethereum address, a
//     Solana public key, a SEC1 secp256k1 or P-256 key, a passkey's RP ID and
//     origin, and a JubJub point) STRICTLY, refusing anything that is not exactly
//     one canonical, admissible key;
//   - encodes a descriptor as the arguments of the class circuit that
//     derives its entry, boot commitment (readable schemes only, see
//     BOOT_SCHEMES), or grant id (the caller runs them through any
//     `pureCircuits` object that exports the module, so the derivation is
//     always the contract's own);
//   - decodes those arguments back into a descriptor, refusing an unknown
//     tag, a tag of another width, and an inadmissible key, so a wallet can
//     check what it is asked to approve;
//   - describes a descriptor for display, with the forms a user can compare
//     by eye (EVM address, Solana key, passkey origin) and the labelled values
//     (the passkey's "Passkey RP (hash)" and a blinded key's privacy salt:
//     "Device privacy salt" for a device, "Grantee privacy salt" for a
//     grantee, whose blind comes from its own grantee request, blind.ts).
//
// Platform-neutral: no node:crypto, so the same code runs in Node and in a
// browser page.

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { jubjub } from '@noble/curves/misc.js';
import { WEBAUTHN_ORIGIN_BYTES, webauthnPolicy } from './webauthn.js';
import { k256EnvelopeLabel } from './labels.js';

// ── Schemes, recipes, and tags ───────────────────────────────────────────────

/** Upstream's schemes: device entries and grant ids only, with fixed tags and
 *  classes. They have no blind, and an account whose first device is one of
 *  them boots through upstream's own `derive_boot_commitment_with_<scheme>`. */
export type LegacyScheme = 'jubjub' | 'k256' | 'p256';
export const LEGACY_SCHEMES: readonly LegacyScheme[] = ['jubjub', 'k256', 'p256'];

export type DescriptorRecipe = 'device' | 'boot' | 'grant-id';

/** A readable arm's payload class (the module's ReadableClass): the
 *  derivation circuits that take its key, `derive_descriptor_<recipe>_<class>`.
 *  w52 for an identity of 20 bytes, ed25519 for an Ed25519 key. */
export type ReadableClass = 'w52' | 'ed25519';

/** What a readable arm's wallet signs its blind requests with, which fixes
 *  the canonical signature form its blind hashes (blind.ts). */
export type ReadableSignature = 'secp256k1-ecdsa' | 'ed25519';

/** How a readable arm's identity is named, parsed and shown: a w52 arm's
 *  20-byte address, an ed25519 arm's 32-byte RFC 8032 key. */
export interface ReadableIdentity {
  /** The identity's name in client errors ("Ethereum address", "Solana key"). */
  readonly name: string;
  /** Parses the forms a person or a wallet presents, strictly, refusing
   *  anything that is not exactly one admissible identity; returns its bytes. */
  readonly parse: (input: string | Uint8Array) => Uint8Array;
  /** The lines describeDescriptor shows for the identity, after the tag and
   *  before the privacy salt. */
  readonly lines: (identity: Uint8Array) => DescriptorLine[];
  /** The value of a blind request's Wallet line (blind.ts); refuses a value
   *  that is not an identity of this arm. */
  readonly walletText: (identity: Uint8Array) => string;
}

/** One readable arm: its entry in the module's registry (readable_arms: the
 *  class and the five tags) and the client's rules for its identity. */
export interface ReadableArm {
  /** The code the arm's tags carry (`evm`, `sol`). */
  readonly code: string;
  readonly payloadClass: ReadableClass;
  readonly signature: ReadableSignature;
  /** The formats the arm's wallets sign in, each with the name the client
   *  shows for it. A format fixes how a wallet signs both the arm's
   *  approvals and its blind requests. A device is bound to the format it
   *  was enrolled in: its blind is the signature over the blind request in
   *  that format, so a wallet that cannot sign that format cannot derive it
   *  again (blind.ts restoreBlind). An arm with one format lists it alone. */
  readonly formats: Readonly<Record<string, string>>;
  /** The arm's registered tags, one per recipe, the blind and the grant
   *  scope salt. */
  readonly tags: {
    readonly device: string; readonly boot: string; readonly 'grant-id': string;
    readonly blind: string; readonly salt: string;
  };
  readonly identity: ReadableIdentity;
}

/** The registry of readable arms, keyed by scheme: the same arms, classes and
 *  tags as the module's readable_arms(), in the same order (the offline suite
 *  checks the two against each other). An arm of an existing class is added
 *  as one entry here; every table, type and dispatch below follows from it.
 *  The codes `nea` (NEAR) and `cdo` (Cardano) are reserved for further
 *  ed25519 arms. */
export const READABLE_ARMS = {
  evm_k256: {
    code: 'evm', payloadClass: 'w52', signature: 'secp256k1-ecdsa',
    // Approvals as EIP-712 V1 typed data, blind requests by personal_sign.
    formats: { 'eip712-v1': 'EIP-712 V1' },
    tags: {
      device: 'midnight:account:device:evm:v1', boot: 'midnight:account:boot:evm:v1',
      'grant-id': 'midnight:account:grant:id:evm:v1', blind: 'midnight:account:blind:evm:v1',
      salt: 'midnight:account:salt:evm:v1',
    },
    identity: {
      name: 'Ethereum address',
      parse: (input) => {
        const a = typeof input === 'string' ? parseEvmAddress(input) : new Uint8Array(input);
        if (a.length !== 20) throw new Error('descriptor: an Ethereum address is 20 bytes');
        if (a.every((b) => b === 0)) throw new Error('descriptor: the zero address is not a device');
        return a;
      },
      lines: (address) => [{ label: 'Ethereum address', value: evmChecksumAddress(address), verifiableByEye: true }],
      walletText: (address) => {
        if (address.length !== 20 || address.every((b) => b === 0)) throw new Error('blind: an Ethereum address is 20 bytes, not zero');
        return `Ethereum address ${evmChecksumAddress(address)}`;
      },
    },
  },
  sol_ed25519: {
    code: 'sol', payloadClass: 'ed25519', signature: 'ed25519',
    // The signMessage bytes, or the Solana off-chain message v1.
    formats: { raw: 'raw', offchain: 'off-chain' },
    tags: {
      device: 'midnight:account:device:sol:v1', boot: 'midnight:account:boot:sol:v1',
      'grant-id': 'midnight:account:grant:id:sol:v1', blind: 'midnight:account:blind:sol:v1',
      salt: 'midnight:account:salt:sol:v1',
    },
    identity: {
      name: 'Solana key',
      parse: (input) => parseSolanaPublicKey(input),
      lines: (key) => [
        { label: 'Solana public key', value: base58Encode(key), verifiableByEye: true },
        { label: 'Solana public key (hex)', value: toHex(key), verifiableByEye: true },
      ],
      walletText: (key) => `Solana public key ${base58Encode(parseSolanaPublicKey(key))}`,
    },
  },
} as const satisfies Readonly<Record<string, ReadableArm>>;

export type ReadableScheme = keyof typeof READABLE_ARMS;
export const READABLE_SCHEMES: readonly ReadableScheme[] = Object.keys(READABLE_ARMS) as ReadableScheme[];
/** The formats of a readable scheme: the keys of its entry's `formats`. */
export type ReadableFormat<S extends ReadableScheme = ReadableScheme> =
  { [K in S]: keyof (typeof READABLE_ARMS)[K]['formats'] & string }[S];
type SchemesOfClass<C extends ReadableClass> =
  { [S in ReadableScheme]: (typeof READABLE_ARMS)[S]['payloadClass'] extends C ? S : never }[ReadableScheme];
/** The readable schemes of each payload class. */
export type W52Scheme = SchemesOfClass<'w52'>;
export type Ed25519Scheme = SchemesOfClass<'ed25519'>;

/** The registry entry of a readable scheme, or undefined for any other value
 *  (an unknown scheme, a legacy one, an Object.prototype member, a non-string). */
export function readableArm(scheme: unknown): ReadableArm | undefined {
  return typeof scheme === 'string' && Object.prototype.hasOwnProperty.call(READABLE_ARMS, scheme)
    ? (READABLE_ARMS as Readonly<Record<string, ReadableArm>>)[scheme]
    : undefined;
}

export type DescriptorScheme = LegacyScheme | ReadableScheme;
export const DESCRIPTOR_SCHEMES: readonly DescriptorScheme[] = [...LEGACY_SCHEMES, ...READABLE_SCHEMES];

/** The schemes with a boot recipe in the module: the readable arms. A boot
 *  commitment exists only for an account's first device, and each readable
 *  arm activates only its own scheme; an account whose first device is
 *  `jubjub`, `k256`, or `p256` boots through upstream's own
 *  `derive_boot_commitment_with_<scheme>`. */
export type BootScheme = ReadableScheme;
export const BOOT_SCHEMES: readonly BootScheme[] = READABLE_SCHEMES;

/** Per recipe, a table over the schemes that recipe has: every scheme for
 *  device entries and grant ids, the readable schemes for boot commitments. */
export interface DescriptorTable<V> {
  readonly device: Readonly<Record<DescriptorScheme, V>>;
  readonly boot: Readonly<Record<BootScheme, V>>;
  readonly 'grant-id': Readonly<Record<DescriptorScheme, V>>;
}

/** A value per readable scheme, in registry order, read from its entry. */
function readableColumn<V>(f: (arm: ReadableArm) => V): Record<ReadableScheme, V> {
  return Object.fromEntries(READABLE_SCHEMES.map((s) => [s, f(READABLE_ARMS[s])])) as Record<ReadableScheme, V>;
}

/** The registered tag of each recipe and scheme (the module's constants). */
export const DESCRIPTOR_TAGS: DescriptorTable<string> = {
  device: {
    jubjub: 'midnight:account:device:v1',
    k256: 'midnight:account:device:k1:v2',
    p256: 'midnight:account:device:r1:v2',
    ...readableColumn((a) => a.tags.device),
  },
  boot: readableColumn((a) => a.tags.boot),
  'grant-id': {
    jubjub: 'midnight:account:grant:id:v1',
    k256: 'midnight:account:grant:id:k1:v1',
    p256: 'midnight:account:grant:id:r1:v1',
    ...readableColumn((a) => a.tags['grant-id']),
  },
};

/** The blind's tag per readable scheme. */
export const BLIND_TAGS: Readonly<Record<ReadableScheme, string>> = readableColumn((a) => a.tags.blind);

/** Upstream's grant origin tag (scoped-grants MIP section 4.4). */
export const GRANT_ORIGIN_TAG = 'midnight:account:grant:origin:v1';

/** The grant scope salt's tag per readable scheme: the salt an arm's
 *  issue_grant derives for the grant's commitments. */
export const SALT_TAGS: Readonly<Record<ReadableScheme, string>> = readableColumn((a) => a.tags.salt);

/** The preimage width of each readable class's payload (bytes): a 20-byte
 *  identity and the blind, or an Ed25519 key's 32-byte encoding and the blind. */
const READABLE_WIDTH = { w52: 52, ed25519: 64 } as const;

/** The width of the payload each recipe and scheme hashes (bytes). */
export const PAYLOAD_WIDTH: DescriptorTable<52 | 64 | 65 | 117> = {
  device: { jubjub: 64, k256: 65, p256: 117, ...readableColumn((a) => READABLE_WIDTH[a.payloadClass]) },
  boot: readableColumn((a) => READABLE_WIDTH[a.payloadClass]),
  'grant-id': { jubjub: 64, k256: 65, p256: 64, ...readableColumn((a) => READABLE_WIDTH[a.payloadClass]) },
};

export type DescriptorClass = 'w52' | 'w64' | 'w65' | 'w117' | ReadableClass;

/** The circuit class of each recipe and scheme: the suffix of the module's
 *  `derive_descriptor_<recipe>_<class>` circuit. An ed25519 arm's key has its
 *  own class (its payload is a Curve25519Point, not bytes), although the
 *  preimage it hashes is 64 bytes wide. */
export const DESCRIPTOR_CLASS: DescriptorTable<DescriptorClass> = {
  device: { jubjub: 'w64', k256: 'w65', p256: 'w117', ...readableColumn((a) => a.payloadClass) },
  boot: readableColumn((a) => a.payloadClass),
  'grant-id': { jubjub: 'w64', k256: 'w65', p256: 'w64', ...readableColumn((a) => a.payloadClass) },
};

const TEXT = new TextEncoder();
const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array => {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new Error('descriptor: not hexadecimal');
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
};
const bytesLE = (v: bigint, w: number): Uint8Array => {
  const o = new Uint8Array(w);
  let x = v;
  for (let i = 0; i < w; i++) { o[i] = Number(x & 0xffn); x >>= 8n; }
  if (x !== 0n) throw new Error(`descriptor: value exceeds ${w} bytes`);
  return o;
};
const bigLE = (b: Uint8Array): bigint => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
const bigBE = (b: Uint8Array): bigint => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };
const bytesBE = (v: bigint, w: number): Uint8Array => bytesLE(v, w).reverse();

/** The value of an unknown scheme as an error shows it: a descriptor's
 *  `scheme` field or the scheme itself, quoted and cut to 40 characters. */
function schemeText(value: unknown): string {
  const s = typeof value === 'object' && value !== null ? (value as { scheme?: unknown }).scheme : value;
  if (typeof s === 'string') return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}...` : s);
  try { return String(s); } catch { return typeof s; }
}

/** Refuses a scheme that client code does not handle: the default case of
 *  every switch over a scheme (descriptor or blind). The value is typed
 *  `never`, so a switch that leaves a registered scheme unhandled fails to
 *  compile; at run time it refuses a value from outside the type (an
 *  unregistered scheme in a dApp's request, or none at all) with a client
 *  decode error, so an unknown scheme never passes silently. */
export function unknownScheme(value: never, where: string, registered: readonly string[] = DESCRIPTOR_SCHEMES, prefix = 'descriptor'): never {
  throw new Error(`${prefix}: unknown scheme ${schemeText(value)} in ${where} (registered: ${registered.join(', ')})`);
}

/** A scheme with a boot recipe in the module (BOOT_SCHEMES). A `jubjub`,
 *  `k256`, or `p256` boot commitment is refused with the circuit that derives
 *  it (upstream's own), and an unknown scheme as everywhere else. */
export function bootScheme(scheme: DescriptorScheme, where: string): BootScheme {
  switch (scheme) {
    case 'jubjub':
    case 'k256':
    case 'p256':
      throw new Error(`descriptor: ${scheme} boots through upstream's derive_boot_commitment_with_${scheme}, not through a descriptor (${where})`);
    default:
      if (readableArm(scheme) === undefined) return unknownScheme(scheme as never, where);
      return scheme;
  }
}

/** A registered tag's 32-byte, zero-padded form. */
export function padTag(text: string): Uint8Array {
  // Not a string (e.g. a tag table looked up with an unknown scheme): refused,
  // never encoded as the text "undefined" or as an all-zero tag.
  if (typeof text !== 'string') throw new Error(`descriptor: a tag is text, not ${schemeText(text)}`);
  if (!/^[\x21-\x7e]+$/.test(text)) throw new Error(`descriptor: tag is not visible ASCII: ${JSON.stringify(text)}`);
  const b = TEXT.encode(text);
  if (b.length > 32) throw new Error(`descriptor: tag exceeds 32 bytes: ${text}`);
  const out = new Uint8Array(32);
  out.set(b);
  return out;
}

/** The recipe and scheme of a registered 32-byte tag; refuses anything else,
 *  including a registered text with non-zero padding. */
export function tagOf(tag: Uint8Array): { recipe: DescriptorRecipe; scheme: DescriptorScheme; text: string } {
  if (tag.length !== 32) throw new Error('descriptor: a tag is 32 bytes');
  for (const recipe of Object.keys(DESCRIPTOR_TAGS) as DescriptorRecipe[]) {
    for (const [scheme, text] of Object.entries(DESCRIPTOR_TAGS[recipe]) as [DescriptorScheme, string][]) {
      if (equalBytes(padTag(text), tag)) return { recipe, scheme, text };
    }
  }
  throw new Error(`descriptor: unregistered tag ${toHex(tag)}`);
}

// ── Descriptors ──────────────────────────────────────────────────────────────

export interface JubjubDescriptor { scheme: 'jubjub'; x: bigint; y: bigint }
export interface K256Descriptor { scheme: 'k256'; x: bigint; y: bigint; envelope: 0 | 1 }
/** A passkey's WebAuthn policy. `rpIdHash` is a labelled value (the RP ID may
 *  be a registrable parent of the origin's host, so it cannot be derived from
 *  the origin); `rpId` is the client's own record of the RP ID, shown beside
 *  it and checked against it, never hashed by a circuit. */
export interface PasskeyPolicy { rpIdHash: Uint8Array; origin: Uint8Array; rpId?: string }
/** A passkey: its key and, for device entries and boot commitments, its
 *  policy. A grant id binds the key only (the RP is a scope field). */
export interface P256Descriptor { scheme: 'p256'; x: bigint; y: bigint; policy?: PasskeyPolicy }
/** A key of a w52 arm: its 20-byte address (for `evm_k256`, the Ethereum
 *  address) and the account's blind. */
export interface W52Descriptor<S extends W52Scheme = W52Scheme> { scheme: S; address: Uint8Array; blind: Uint8Array }
/** A key of an ed25519 arm: its 32-byte RFC 8032 encoding (what the wallet
 *  exports and a person compares) and the account's blind. The circuits take
 *  the key as its point with these 32 bytes and its x-coordinate as checked
 *  inputs (ed25519KeyInputs), and check them against the point. */
export interface Ed25519Descriptor<S extends Ed25519Scheme = Ed25519Scheme> { scheme: S; key: Uint8Array; blind: Uint8Array }
export type EvmDescriptor = W52Descriptor<'evm_k256'>;
export type SolDescriptor = Ed25519Descriptor<'sol_ed25519'>;
export type ReadableDescriptor = W52Descriptor | Ed25519Descriptor;
/** The descriptor type of one readable scheme. */
export type ReadableDescriptorOf<S extends ReadableScheme> =
  S extends W52Scheme ? W52Descriptor<S> : S extends Ed25519Scheme ? Ed25519Descriptor<S> : never;
/** A Curve25519Point as the generated JavaScript takes it: affine twisted
 *  Edwards coordinates. */
export interface Curve25519Affine { x: bigint; y: bigint }
export type Descriptor = JubjubDescriptor | K256Descriptor | P256Descriptor | ReadableDescriptor;

/** Whether a readable descriptor is of the ed25519 class (by its arm's entry). */
function isEd25519Descriptor(d: ReadableDescriptor): d is Ed25519Descriptor {
  return READABLE_ARMS[d.scheme].payloadClass === 'ed25519';
}

// ── Strict parsers: the forms a person or a wallet presents ─────────────────

/** EIP-55 checksummed form of a 20-byte address. */
export function evmChecksumAddress(address: Uint8Array): string {
  if (address.length !== 20) throw new Error('descriptor: an Ethereum address is 20 bytes');
  const lower = toHex(address);
  const h = toHex(keccak_256(TEXT.encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** A 0x-prefixed Ethereum address. Mixed case must carry a valid EIP-55
 *  checksum; all-lower and all-upper case carry none. The zero address is
 *  refused: no key controls it. */
export function parseEvmAddress(text: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error('descriptor: an Ethereum address is 0x and 40 hex digits');
  const body = text.slice(2);
  const bytes = fromHex(body);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && evmChecksumAddress(bytes) !== text) throw new Error('descriptor: Ethereum address checksum mismatch');
  if (bytes.every((b) => b === 0)) throw new Error('descriptor: the zero address is not a device');
  return bytes;
}

/** The address of a secp256k1 public key: the low 20 bytes of keccak256 of the
 *  64-byte big-endian x || y. */
export function evmAddressOf(pk: { x: bigint; y: bigint }): Uint8Array {
  const point = secp256k1.Point.fromAffine({ x: pk.x, y: pk.y });
  point.assertValidity();
  return keccak_256(point.toBytes(false).subarray(1)).subarray(12);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (Bitcoin alphabet), the form Solana shows a public key in. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = bigBE(bytes);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return '1'.repeat(zeros) + out;
}

/** Strict base58: alphabet only, and the canonical encoding of its bytes. */
export function base58Decode(text: string, length: number): Uint8Array {
  if (!text || ![...text].every((c) => B58.includes(c))) throw new Error('descriptor: not base58');
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of text.slice(zeros)) n = n * 58n + BigInt(B58.indexOf(c));
  const tail: number[] = [];
  while (n > 0n) { tail.unshift(Number(n & 0xffn)); n >>= 8n; }
  const out = Uint8Array.from([...new Array(zeros).fill(0), ...tail]);
  if (out.length !== length) throw new Error(`descriptor: base58 value is ${out.length} bytes, not ${length}`);
  if (base58Encode(out) !== text) throw new Error('descriptor: non-canonical base58');
  return out;
}

/** An Ed25519 public key's 32-byte RFC 8032 encoding, decoded strictly
 *  (canonical y < p, no "negative zero" x), and only keys of the prime-order
 *  subgroup other than the identity: small-order and mixed-order points are
 *  refused. The rule every ed25519-class key passes. Returns a copy. */
export function parseEd25519PublicKey(input: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(input);
  if (bytes.length !== 32) throw new Error('descriptor: an Ed25519 public key is 32 bytes');
  let point;
  try { point = ed25519.Point.fromBytes(bytes, false); } catch (e: any) {
    throw new Error(`descriptor: not a canonical Ed25519 point (${e?.message ?? e})`);
  }
  if (!equalBytes(point.toBytes(), bytes)) throw new Error('descriptor: non-canonical Ed25519 encoding');
  if (point.isSmallOrder()) throw new Error('descriptor: Ed25519 key of small order (identity included)');
  if (!point.isTorsionFree()) throw new Error('descriptor: Ed25519 key of mixed order');
  return bytes;
}

/** A Solana public key: base58 text or the 32-byte RFC 8032 encoding, with
 *  parseEd25519PublicKey's strict rules. Returns the 32 bytes. */
export function parseSolanaPublicKey(input: string | Uint8Array): Uint8Array {
  const bytes = typeof input === 'string' ? base58Decode(input, 32) : new Uint8Array(input);
  if (bytes.length !== 32) throw new Error('descriptor: a Solana public key is 32 bytes');
  return parseEd25519PublicKey(bytes);
}

/** The Curve25519Point of a Solana public key (base58 text or the 32-byte
 *  encoding), after parseSolanaPublicKey's strict checks: the argument the
 *  ed25519 class circuits take. */
export function solanaKeyPoint(input: string | Uint8Array): Curve25519Affine {
  const { x, y } = ed25519.Point.fromBytes(parseSolanaPublicKey(input), false).toAffine();
  return { x, y };
}

/** The 32-byte RFC 8032 encoding of a Curve25519Point given by coordinates,
 *  with the same strict rules: canonical coordinates (below p), on the
 *  curve, of prime order, not the identity. Small-order and mixed-order
 *  points are refused. */
export function ed25519KeyFromPoint(p: Curve25519Affine): Uint8Array {
  if (typeof p !== 'object' || p === null || typeof p.x !== 'bigint' || typeof p.y !== 'bigint') {
    throw new Error('descriptor: an Ed25519 key point is { x, y } with bigint coordinates');
  }
  const P = ed25519.Point.Fp.ORDER;
  if (p.x < 0n || p.x >= P || p.y < 0n || p.y >= P) throw new Error('descriptor: Ed25519 coordinate not below p');
  if (p.x === 0n && p.y === 1n) throw new Error('descriptor: Ed25519 key of small order (the identity)');
  let point;
  try { point = ed25519.Point.fromAffine({ x: p.x, y: p.y }); point.assertValidity(); } catch (e: any) {
    throw new Error(`descriptor: not an Ed25519 point (${e?.message ?? e})`);
  }
  if (point.isSmallOrder()) throw new Error('descriptor: Ed25519 key of small order (identity included)');
  if (!point.isTorsionFree()) throw new Error('descriptor: Ed25519 key of mixed order');
  return parseEd25519PublicKey(point.toBytes());
}

/** A Solana key's encoding from its point (ed25519KeyFromPoint). */
export const solanaKeyFromPoint = ed25519KeyFromPoint;

/** The ed25519 class's key arguments for an Ed25519 key (its 32-byte
 *  encoding or its point), after the strict checks of parseEd25519PublicKey
 *  / ed25519KeyFromPoint: the point, the encoding's bytes (`pkBytes`) and
 *  the x-coordinate's 32 bytes, little-endian (`pkX`), each byte as the
 *  generated JavaScript takes a Uint<8>. The circuits check both byte
 *  vectors against the point. */
export function ed25519KeyInputs(input: Uint8Array | Curve25519Affine): { point: Curve25519Affine; pkBytes: bigint[]; pkX: bigint[] } {
  const key = input instanceof Uint8Array ? parseEd25519PublicKey(input) : ed25519KeyFromPoint(input);
  const { x, y } = ed25519.Point.fromBytes(key, false).toAffine();
  return { point: { x, y }, pkBytes: [...key].map(BigInt), pkX: [...bytesLE(x, 32)].map(BigInt) };
}

/** ed25519KeyInputs for a Solana public key (base58 text, the 32-byte
 *  encoding, or its point), after parseSolanaPublicKey's checks. */
export function solanaKeyInputs(input: string | Uint8Array | Curve25519Affine): { point: Curve25519Affine; pkBytes: bigint[]; pkX: bigint[] } {
  return ed25519KeyInputs(typeof input === 'string' || input instanceof Uint8Array ? parseSolanaPublicKey(input) : input);
}

type Curve = typeof secp256k1 | typeof p256;
function parseWeierstrass(curve: Curve, name: string, input: Uint8Array | { x: bigint; y: bigint }): { x: bigint; y: bigint } {
  let point;
  try {
    if (input instanceof Uint8Array) {
      if (input.length !== 33 && input.length !== 65) throw new Error('SEC1 key is 33 or 65 bytes');
      point = curve.Point.fromBytes(input);
    } else {
      const p = curve.Point.Fp.ORDER;
      if (input.x < 0n || input.x >= p || input.y < 0n || input.y >= p) throw new Error('coordinate not below p');
      point = curve.Point.fromAffine({ x: input.x, y: input.y });
    }
    point.assertValidity();
  } catch (e: any) {
    throw new Error(`descriptor: not a ${name} public key (${e?.message ?? e})`);
  }
  if (point.is0()) throw new Error(`descriptor: ${name} point at infinity`);
  const { x, y } = point.toAffine();
  return { x, y };
}

/** A secp256k1 key (SEC1 bytes or affine coordinates) and its envelope. */
export function parseK256Descriptor(key: Uint8Array | { x: bigint; y: bigint }, envelope: number): K256Descriptor {
  if (envelope !== 0 && envelope !== 1) throw new Error('descriptor: unknown k256 envelope');
  return { scheme: 'k256', ...parseWeierstrass(secp256k1, 'secp256k1', key), envelope };
}

/** Upstream's webauthnPolicy, its refusals reported as descriptor errors. */
function passkeyPolicy(rpId: string, origin: string) {
  try { return webauthnPolicy(rpId, origin); } catch (e: any) { throw new Error(`descriptor: ${e?.message ?? e}`); }
}

/** A passkey: its P-256 key, RP ID, and 21-byte origin. The RP ID must be the
 *  origin's host or a registrable parent of it (upstream's webauthnPolicy). */
export function parseP256Descriptor(key: Uint8Array | { x: bigint; y: bigint }, rpId: string, origin: string): P256Descriptor {
  const policy = passkeyPolicy(rpId, origin);
  return { scheme: 'p256', ...parseWeierstrass(p256, 'P-256', key), policy: { rpIdHash: policy.rp_id_hash, origin: policy.origin, rpId } };
}

/** A JubJub point: affine coordinates, or its 64-byte x_le || y_le encoding.
 *  Canonical coordinates, on the curve, of prime order (small-order and
 *  mixed-order points refused; the seam itself refuses small order). */
export function parseJubjubPoint(input: Uint8Array | { x: bigint; y: bigint }): JubjubDescriptor {
  let x: bigint, y: bigint;
  if (input instanceof Uint8Array) {
    if (input.length !== 64) throw new Error('descriptor: a JubJub point is 64 bytes (x_le || y_le)');
    x = bigLE(input.subarray(0, 32)); y = bigLE(input.subarray(32));
  } else ({ x, y } = input);
  const q = jubjub.Point.Fp.ORDER;
  if (x < 0n || x >= q || y < 0n || y >= q) throw new Error('descriptor: JubJub coordinate not canonical');
  if (x === 0n && y === 1n) throw new Error('descriptor: JubJub key of small order (the identity)');
  let point;
  try { point = jubjub.Point.fromAffine({ x, y }); point.assertValidity(); } catch (e: any) {
    throw new Error(`descriptor: not a JubJub point (${e?.message ?? e})`);
  }
  if (point.isSmallOrder()) throw new Error('descriptor: JubJub key of small order (identity included)');
  if (!point.isTorsionFree()) throw new Error('descriptor: JubJub key of mixed order');
  return { scheme: 'jubjub', x, y };
}

/** A readable device or grantee: its identity, parsed by its arm's rules
 *  (READABLE_ARMS: a w52 arm's 20-byte address, an ed25519 arm's 32-byte
 *  key), and the account's 32-byte blind. */
export function readableDescriptor<S extends ReadableScheme>(scheme: S, identity: string | Uint8Array, blind: Uint8Array): ReadableDescriptorOf<S>;
export function readableDescriptor(scheme: ReadableScheme, identity: string | Uint8Array, blind: Uint8Array): ReadableDescriptor {
  const arm = readableArm(scheme);
  if (arm === undefined) return unknownScheme(scheme as never, 'readableDescriptor');
  const id = arm.identity.parse(identity);
  if (blind.length !== 32) throw new Error('descriptor: a blind is 32 bytes');
  const b = new Uint8Array(blind);
  return arm.payloadClass === 'w52'
    ? { scheme: scheme as W52Scheme, address: id, blind: b }
    : { scheme: scheme as Ed25519Scheme, key: id, blind: b };
}

export function evmDescriptor(address: Uint8Array | string, blind: Uint8Array): EvmDescriptor {
  return readableDescriptor('evm_k256', address, blind);
}

export function solDescriptor(key: Uint8Array | string, blind: Uint8Array): SolDescriptor {
  return readableDescriptor('sol_ed25519', key, blind);
}

/** Re-checks a descriptor built elsewhere (for example decoded from a dApp's
 *  request) with the strict parsers above. Returns a fresh copy. Refuses a
 *  value that is not a descriptor object and a scheme that is not registered. */
export function checkDescriptor(d: Descriptor): Descriptor {
  if (typeof d !== 'object' || d === null) throw new Error(`descriptor: not a descriptor object (${d === null ? 'null' : typeof d})`);
  switch (d.scheme) {
    case 'jubjub': return parseJubjubPoint({ x: d.x, y: d.y });
    case 'k256': return parseK256Descriptor({ x: d.x, y: d.y }, d.envelope);
    case 'p256': {
      const key = parseWeierstrass(p256, 'P-256', { x: d.x, y: d.y });
      if (!d.policy) return { scheme: 'p256', ...key };
      const { rpIdHash, origin, rpId } = d.policy;
      if (rpIdHash.length !== 32) throw new Error('descriptor: rp_id_hash is 32 bytes');
      if (origin.length !== WEBAUTHN_ORIGIN_BYTES) throw new Error(`descriptor: a passkey origin is ${WEBAUTHN_ORIGIN_BYTES} bytes`);
      // The bytes the wa-json134 circuit accepts in an origin (webauthn.compact).
      if (!origin.every((b) => b >= 0x21 && b <= 0x7e && b !== 0x22 && b !== 0x5c)) {
        throw new Error('descriptor: passkey origin is not visible ASCII without quotes or backslashes');
      }
      if (rpId !== undefined) {
        // The client knows the RP ID: it must hash to the shown value and fit
        // the origin, as upstream's webauthnPolicy requires.
        const p = passkeyPolicy(rpId, String.fromCharCode(...origin));
        if (!equalBytes(p.rp_id_hash, rpIdHash)) throw new Error('descriptor: rp_id_hash is not SHA-256 of the RP ID');
      }
      return { scheme: 'p256', ...key, policy: { rpIdHash: new Uint8Array(rpIdHash), origin: new Uint8Array(origin), ...(rpId !== undefined ? { rpId } : {}) } };
    }
    default: {
      if (readableArm(d.scheme) === undefined) return unknownScheme(d as never, 'checkDescriptor');
      return readableDescriptor(d.scheme, isEd25519Descriptor(d) ? d.key : d.address, d.blind);
    }
  }
}

// ── Encoders: the class circuit and its arguments ───────────────────────────

/** A pure-circuit call: the circuit's name and its arguments, in the
 *  generated JavaScript's representation. `pick` is the index of the derived
 *  value when the circuit returns a tuple: the ed25519 class returns
 *  [key, value], the key it encoded from the point and the derived value. */
export interface DescriptorCall { circuit: string; args: unknown[]; pick?: number }

const pickOf = (cls: DescriptorClass): { pick?: number } => (cls === 'ed25519' ? { pick: 1 } : {});

const xyLE = (d: { x: bigint; y: bigint }): [Uint8Array, Uint8Array] => [bytesLE(d.x, 32), bytesLE(d.y, 32)];

/** The payload parts of a descriptor for a recipe, in circuit order. An
 *  ed25519 arm's key is passed as its point, then its 32 bytes and its
 *  x-coordinate as byte vectors (ed25519KeyInputs), never as bytes alone. A
 *  boot commitment's parts exist only for the readable schemes (bootScheme). */
export function payloadParts(d: Descriptor, recipe: DescriptorRecipe): unknown[] {
  if (recipe === 'boot') bootScheme(d.scheme, 'payloadParts');
  switch (d.scheme) {
    case 'jubjub': return xyLE(d);
    case 'k256': return [...xyLE(d), BigInt(d.envelope)];
    case 'p256': {
      if (recipe === 'grant-id') return xyLE(d);
      if (!d.policy) throw new Error('descriptor: a passkey device entry needs its policy');
      return [...xyLE(d), d.policy.rpIdHash, d.policy.origin];
    }
    default: {
      if (readableArm(d.scheme) === undefined) return unknownScheme(d as never, 'payloadParts');
      if (!isEd25519Descriptor(d)) return [d.address, d.blind];
      const k = ed25519KeyInputs(d.key);
      return [k.point, k.pkBytes, k.pkX, d.blind];
    }
  }
}

const contractAddress = (a: Uint8Array) => {
  if (a.length !== 32) throw new Error('descriptor: a contract address is 32 bytes');
  return { bytes: a };
};

/** The device entry of `d` in an account, at an epoch and use counter. An
 *  enrolment MUST pass the account's current device_epoch and counter 0. */
export function entryCall(d: Descriptor, account: Uint8Array, epoch: bigint, counter: bigint): DescriptorCall {
  // The parts first: an unknown scheme is refused before any table lookup.
  const parts = payloadParts(d, 'device');
  return {
    circuit: `derive_descriptor_entry_${DESCRIPTOR_CLASS.device[d.scheme]}`,
    args: [padTag(DESCRIPTOR_TAGS.device[d.scheme]), contractAddress(account), ...parts, epoch, counter],
    ...pickOf(DESCRIPTOR_CLASS.device[d.scheme]),
  };
}

/** The boot commitment of `d` under a salt: a readable arm's key only
 *  (BOOT_SCHEMES). A `jubjub`, `k256`, or `p256` first device boots through
 *  upstream's derive_boot_commitment_with_<scheme>, so bootCall refuses it. */
export function bootCall(d: Descriptor, salt: Uint8Array): DescriptorCall {
  // The scheme first: an unknown scheme, or one without a boot recipe here,
  // is refused before any table lookup.
  const scheme = bootScheme(d.scheme, 'bootCall');
  const parts = payloadParts(d, 'boot');
  if (salt.length !== 32) throw new Error('descriptor: a salt is 32 bytes');
  return {
    circuit: `derive_descriptor_boot_${DESCRIPTOR_CLASS.boot[scheme]}`,
    args: [padTag(DESCRIPTOR_TAGS.boot[scheme]), salt, ...parts],
    ...pickOf(DESCRIPTOR_CLASS.boot[scheme]),
  };
}

/** The grant id of grantee `d` in an account, for an origin_hash and slot. */
export function grantIdCall(d: Descriptor, account: Uint8Array, originHash: Uint8Array, slot: bigint): DescriptorCall {
  const parts = payloadParts(d, 'grant-id');
  if (originHash.length !== 32) throw new Error('descriptor: origin_hash is 32 bytes');
  return {
    circuit: `derive_descriptor_grant_id_${DESCRIPTOR_CLASS['grant-id'][d.scheme]}`,
    args: [padTag(DESCRIPTOR_TAGS['grant-id'][d.scheme]), contractAddress(account), ...parts, originHash, slot],
    ...pickOf(DESCRIPTOR_CLASS['grant-id'][d.scheme]),
  };
}

/** Runs a call through a `pureCircuits` object that exports the module. */
export function derive(pureCircuits: Record<string, any>, call: DescriptorCall): Uint8Array {
  const f = pureCircuits[call.circuit];
  if (typeof f !== 'function') throw new Error(`descriptor: ${call.circuit} is not exported by these circuits`);
  const r = f(...call.args);
  return call.pick === undefined ? r : r[call.pick];
}

// ── Decoder: circuit arguments back to a checked descriptor ─────────────────

/** Decodes the tag and payload parts of a class call (as payloadParts
 *  returns them) into a descriptor, then checks the key strictly. Refuses an
 *  unregistered tag, a tag of another recipe than `recipe`, parts of the
 *  wrong number or width, an Ed25519 key given as anything but a point, and
 *  an Ed25519 key whose byte vectors are not its point's encoding and
 *  x-coordinate. */
export function decodeDescriptor(recipe: DescriptorRecipe, tag: Uint8Array, parts: unknown[]): Descriptor {
  const t = tagOf(tag);
  if (t.recipe !== recipe) throw new Error(`descriptor: ${t.text} is a ${t.recipe} tag, not a ${recipe} tag`);
  const bytes = (v: unknown, n: number, what: string): Uint8Array => {
    if (!(v instanceof Uint8Array) || v.length !== n) throw new Error(`descriptor: ${what} must be ${n} bytes`);
    return new Uint8Array(v);
  };
  const want = (n: number) => { if (parts.length !== n) throw new Error(`descriptor: ${t.text} takes ${n} payload parts, got ${parts.length}`); };
  switch (t.scheme) {
    case 'jubjub':
      want(2);
      return parseJubjubPoint(new Uint8Array([...bytes(parts[0], 32, 'x'), ...bytes(parts[1], 32, 'y')]));
    case 'k256': {
      want(3);
      const env = parts[2];
      if (env !== 0n && env !== 1n) throw new Error('descriptor: unknown k256 envelope');
      return parseK256Descriptor({ x: bigLE(bytes(parts[0], 32, 'x')), y: bigLE(bytes(parts[1], 32, 'y')) }, Number(env));
    }
    case 'p256': {
      if (recipe === 'grant-id') {
        want(2);
        // A p256 grant id binds the key only; the RP is a scope field.
        return { scheme: 'p256', ...parseWeierstrass(p256, 'P-256', { x: bigLE(bytes(parts[0], 32, 'x')), y: bigLE(bytes(parts[1], 32, 'y')) }) };
      }
      want(4);
      return checkDescriptor({
        scheme: 'p256', x: bigLE(bytes(parts[0], 32, 'x')), y: bigLE(bytes(parts[1], 32, 'y')),
        policy: { rpIdHash: bytes(parts[2], 32, 'rp_id_hash'), origin: bytes(parts[3], WEBAUTHN_ORIGIN_BYTES, 'origin') },
      });
    }
    default: {
      const arm = readableArm(t.scheme);
      if (arm === undefined) return unknownScheme(t.scheme as never, 'decodeDescriptor');
      if (arm.payloadClass === 'w52') {
        want(2);
        return readableDescriptor(t.scheme, bytes(parts[0], 20, 'address'), bytes(parts[1], 32, 'blind'));
      }
      want(4);
      // The point first (refusing bytes in its place), then its byte vectors.
      const k = ed25519KeyInputs(ed25519KeyFromPoint(parts[0] as Curve25519Affine));
      const key = arm.identity.name;
      const vec = (v: unknown, what: string): bigint[] => {
        if (!Array.isArray(v) || v.length !== 32 || !v.every((b) => typeof b === 'bigint' && b >= 0n && b <= 255n)) {
          throw new Error(`descriptor: ${what} must be 32 byte values`);
        }
        return v as bigint[];
      };
      if (!vec(parts[1], `the ${key} bytes`).every((b, i) => b === k.pkBytes[i])) {
        throw new Error(`descriptor: the ${key} bytes are not its point's encoding`);
      }
      if (!vec(parts[2], `the ${key} x bytes`).every((b, i) => b === k.pkX[i])) {
        throw new Error(`descriptor: the ${key} x bytes are not its point's x-coordinate`);
      }
      return readableDescriptor(t.scheme, Uint8Array.from(k.pkBytes, Number), bytes(parts[3], 32, 'blind'));
    }
  }
}

// ── Display ──────────────────────────────────────────────────────────────────

/** The byte order a client SHOWS a curve coordinate in, the same as the
 *  arms' approval messages: secp256k1 and P-256 coordinates big-endian, as
 *  SEC1 and every wallet and tool show them; JubJub coordinates
 *  little-endian, Midnight's own encoding and the bytes the recipes bind
 *  (`x_le ‖ y_le`). Field values, which no descriptor carries, are shown
 *  little-endian too. */
export const COORDINATE_DISPLAY_ORDER: Readonly<Record<'jubjub' | 'k256' | 'p256', 'little-endian' | 'big-endian'>> = Object.freeze({
  jubjub: 'little-endian',
  k256: 'big-endian',
  p256: 'big-endian',
});

/** A coordinate as shown: `0x` and 64 lowercase hex digits, in the byte order
 *  of COORDINATE_DISPLAY_ORDER for its scheme. */
export function coordinateHex(scheme: keyof typeof COORDINATE_DISPLAY_ORDER, v: bigint): string {
  const order = COORDINATE_DISPLAY_ORDER[scheme];
  if (!order) throw new Error(`descriptor: ${scheme} has no coordinates`);
  return '0x' + toHex(order === 'little-endian' ? bytesLE(v, 32) : bytesBE(v, 32));
}

/** One shown line: a fixed label and its value in full. */
export interface DescriptorLine { label: string; value: string; verifiableByEye: boolean }

/** The label of a readable key's blind: a device's (device entries and boot
 *  commitments) or a grantee's (grant ids). The two blinds come from two
 *  different requests (blind.ts), so the label says whose it is. */
export function privacySaltLabel(recipe: DescriptorRecipe): 'Device privacy salt' | 'Grantee privacy salt' {
  return recipe === 'grant-id' ? 'Grantee privacy salt' : 'Device privacy salt';
}

/** The lines a client shows for a descriptor, the same values the arms'
 *  approval messages show. Keys are shown in full, in the form their arm's
 *  entry gives (an EVM address in EIP-55 form, a Solana key in base58 and
 *  hex), a passkey origin as text, and
 *  coordinates per COORDINATE_DISPLAY_ORDER (secp256k1 and P-256 big-endian,
 *  JubJub little-endian). `rp_id_hash` and the blind are the two labelled
 *  hash-like values (the blind under privacySaltLabel); the client shows the
 *  RP ID beside the RP hash when it knows it. */
export function describeDescriptor(recipe: DescriptorRecipe, d: Descriptor): DescriptorLine[] {
  const known = (DESCRIPTOR_SCHEMES as readonly unknown[]).includes(d.scheme);
  const tagText = recipe === 'boot' ? DESCRIPTOR_TAGS.boot[bootScheme(d.scheme, 'describeDescriptor')]
    : known ? DESCRIPTOR_TAGS[recipe][d.scheme] : '';
  const tag = { label: 'Scheme tag', value: tagText, verifiableByEye: true };
  const salt = (blind: Uint8Array) => ({ label: privacySaltLabel(recipe), value: '0x' + toHex(blind), verifiableByEye: false });
  const coord = (name: string, scheme: keyof typeof COORDINATE_DISPLAY_ORDER, v: bigint) =>
    ({ label: name, value: coordinateHex(scheme, v), verifiableByEye: false });
  switch (d.scheme) {
    case 'jubjub': return [tag, coord('JubJub key x', 'jubjub', d.x), coord('JubJub key y', 'jubjub', d.y)];
    case 'k256': return [tag, coord('secp256k1 key x', 'k256', d.x), coord('secp256k1 key y', 'k256', d.y),
      { label: 'Signing envelope', value: `${d.envelope} (${k256EnvelopeLabel(d.envelope)})`, verifiableByEye: false }];
    case 'p256': {
      const lines: DescriptorLine[] = [tag, coord('Passkey key x', 'p256', d.x), coord('Passkey key y', 'p256', d.y)];
      if (recipe !== 'grant-id' && d.policy) {
        lines.push({ label: 'Passkey origin', value: String.fromCharCode(...d.policy.origin), verifiableByEye: true });
        lines.push({ label: 'Passkey RP (hash)', value: '0x' + toHex(d.policy.rpIdHash) + (d.policy.rpId ? ` (RP ID ${d.policy.rpId}, shown by this client)` : ''), verifiableByEye: false });
      }
      return lines;
    }
    default: {
      const arm = readableArm(d.scheme);
      if (arm === undefined) return unknownScheme(d as never, 'describeDescriptor');
      return [tag, ...arm.identity.lines(isEd25519Descriptor(d) ? d.key : d.address), salt(d.blind)];
    }
  }
}

/** A 21-byte passkey origin's or a 32-byte label's grant origin_hash: SHA-256
 *  of the padded origin tag and the fixed-width bytes (the module's recipe). */
export function grantOriginHash(fixedWidth: Uint8Array): Uint8Array {
  if (fixedWidth.length !== WEBAUTHN_ORIGIN_BYTES && fixedWidth.length !== 32) {
    throw new Error('descriptor: a grant origin is a 21-byte passkey origin or a 32-byte label');
  }
  return sha256(new Uint8Array([...padTag(GRANT_ORIGIN_TAG), ...fixedWidth]));
}

/** A grant's scope salt, as the module's derive_grant_scope_salt computes it
 *  at issue_grant: SHA-256 of the padded salt tag, the issuing device's
 *  32-byte blind, the 32-byte account address and auth_nonce (the value the
 *  device signed, 8 bytes little-endian). The issuing client hands it to the
 *  grantee, which opens the grant's commitments with it when it spends. */
export function grantScopeSalt(scheme: ReadableScheme, blind: Uint8Array, account: Uint8Array, authNonce: bigint): Uint8Array {
  const tag = Object.prototype.hasOwnProperty.call(SALT_TAGS, scheme) ? SALT_TAGS[scheme] : undefined;
  if (tag === undefined) return unknownScheme(scheme as never, 'grantScopeSalt', Object.keys(SALT_TAGS));
  if (!(blind instanceof Uint8Array) || blind.length !== 32) throw new Error('descriptor: a blind is 32 bytes');
  if (!(account instanceof Uint8Array) || account.length !== 32) throw new Error('descriptor: an account address is 32 bytes');
  if (typeof authNonce !== 'bigint' || authNonce < 0n || authNonce >= 1n << 64n) throw new Error('descriptor: auth_nonce is a Uint<64>');
  const nonce = new Uint8Array(8);
  for (let i = 0; i < 8; i++) nonce[i] = Number((authNonce >> BigInt(8 * i)) & 0xffn);
  return sha256(new Uint8Array([...padTag(tag), ...blind, ...account, ...nonce]));
}

/** A readable grantee's 32-byte origin label: visible words separated by
 *  single spaces, zero-padded (the module's label_text_32 grammar). */
export function grantLabel(text: string): Uint8Array {
  if (!/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(text)) throw new Error('descriptor: a label is visible words separated by single spaces');
  const b = TEXT.encode(text);
  if (b.length > 32) throw new Error('descriptor: a label is at most 32 bytes');
  const out = new Uint8Array(32);
  out.set(b);
  return out;
}
