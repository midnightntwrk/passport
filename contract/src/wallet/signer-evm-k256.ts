// The `evm_k256` arm's client facade: an Ethereum
// account (MetaMask, or any EIP-712 wallet) as a Passport device or grantee.
//
// The device is its 20-byte Ethereum address, BLINDED:
// every entry, boot commitment and grant id binds the address together with a
// per-account secret, the blind, which the client derives from the wallet's
// own deterministic signature over a readable request message:
//
//   1. The client builds the request for (network, wallet address, account
//      index) with blind.ts `blindMessage` (the wallet shows it as text).
//   2. The wallet signs it TWICE with `personal_sign` (EIP-191). Each
//      signature must come from the wallet's address (the signer check,
//      below), and both must have the same canonical form (low-S r || s):
//      RFC 6979 makes an honest wallet deterministic, and a hedged or MPC
//      wallet, whose blind could never be re-derived, is refused here.
//   3. blind = SHA-256(pad32("midnight:account:blind:evm:v1") || r || s).
//   4. The device's public point is RECOVERED from that same signature (a
//      wallet never exposes it).
//
// The arm has one format, `eip712-v1` (descriptors.ts READABLE_ARMS): every
// approval is EIP-712 V1 typed data signed with `eth_signTypedData_v4`, and
// every blind request is signed with `personal_sign`. A wallet is asked for
// nothing else, and typed data under any other domain is refused before a
// wallet sees it.
//
// THE SIGNER CHECK. A wallet may answer with another account than the one
// asked for (two installed extensions, a switched account), and the address
// a wallet reports is not evidence of who signed. Every signature a wallet
// returns, approvals and blind requests alike, is therefore checked before
// it is used: the address recovered from the exact digest the wallet was
// asked to sign must be the one the signature must come from (blind.ts
// checkSigner). A refusal names another address only when the signature
// recovers to it (the addresses other connected wallets report are the
// candidates); otherwise the signer is unknown. Nothing is proved.
//
// The roster record (`EvmK256RosterRecord`) persists the format, address,
// point, network and account index per device and caches the blind. A
// client that lost the cache derives the blind again in the record's format;
// a client without a record derives blind_0, blind_1, ... and finds its
// accounts by testing entries (`entryAt`) against each account's device set
// (blind.ts restoreBlind, through restoreEvmK256Device).
//
// As a GRANTEE the wallet derives its blind from a different request (blind.ts
// `granteeBlindMessage`): it names the role, the network, the wallet and
// the issuing account, and has no account index. The issuer must know a
// grantee's blind (it derives the grant id and is shown in the issuer's
// approvals), so a grantee never uses a device blind, and every issuer gets a
// blind of its own.
//
// A grantee also derives the X25519 key the account seals its records to
// when a grant allows reading (`read_pk`; the record stores SHA-256 of it in
// the clear). The key is fresh per issuing account and per grant, so two
// grants never share a published hash: its secret is
// SHA-256(read seed || account || site label || slot), clamped per RFC 7748,
// where the read seed is SHA-256(pad32("midnight:account:read:evm:v1")
// || r || s) over the same canonical signature as the grantee blind. The
// issuer learns the blind, never the signature, so it cannot derive the key.
// The grantee record (`EvmK256GranteeRecord`), one per issuing account,
// caches the grantee blind in the same way. The read seed is never stored:
// it stays in memory for the session, and a grantee restored from its cache
// derives it again from one signature of the grantee request when it first
// reads (`readKeyFromWallet`), so a leak of the client's storage links the
// wallet to its grants but opens none of their records.
//
// Every derivation goes through the contract's own exported pure circuits
// (`derive_*_with_evm_k256`), so the client and the circuit can never
// disagree. The readable EIP-712 approvals are built by the arm's codec
// (`evm-k256-codec.ts`).

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { pureCircuits, type Secp256k1Point } from './contract.js';
import {
  blindMessageBytes,
  granteeBlindMessageBytes,
  canonicalEvmSignature,
  checkBlindFormat,
  checkSigner,
  deriveBlind,
  restoreBlind,
  sameCanonicalSignature,
} from './blind.js';
import {
  DESCRIPTOR_TAGS, checkDescriptor, evmAddressOf, evmChecksumAddress, grantOriginHash, padTag, parseEvmAddress,
  type Descriptor, type Ed25519Descriptor, type JubjubDescriptor, type K256Descriptor, type P256Descriptor, type W52Descriptor,
} from './descriptors.js';
import {
  checkEip712V1TypedData, typedDataDigest, evmK256Messages, evmK256KindOf, EVM_K256_KINDS,
  type Eip712TypedData, type EvmK256DescriptorInput, type EvmK256GranteeInput, type EvmK256Payload, type IssueScope, type SiteAmount, type SpentCoin,
} from './evm-k256-codec.js';
import type { GrantOpening } from './signer.js';
import {
  evmK256KeyHint, evmK256SeamHint, evmK256GrantSeamHint, evmK256AmountHint, evmK256CoinHint,
  evmK256DescriptorHint, evmK256RemoveHint, evmK256GranteeHint, evmK256IssueHint,
  ed25519Args, EVM_K256_ED25519_FILLER_ARGS,
  type EvmAddressHint, type EvmK256SeamHint, type EvmK256GrantSeamHint,
} from './evm-k256-hints.js';
export { ed25519Args, ed25519KeyOf, EVM_K256_ED25519_FILLER_ARGS, type EvmK256Ed25519Args } from './evm-k256-hints.js';

// ── Signatures ───────────────────────────────────────────────────────────────

export const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER;

/** An ECDSA signature as the circuit ABI carries it (`Secp256k1EcdsaSignature`). */
export interface EvmEcdsaSignature { r: bigint; s: bigint }

/** A 65-byte wallet signature `r || s || v`, parsed. Both S forms are kept as
 *  given: the contract accepts both; the rolling entry makes a
 *  malleated twin single-use. */
export interface ParsedEvmSignature extends EvmEcdsaSignature { v: number; recovery: 0 | 1 }

const be32 = (v: bigint): Uint8Array => {
  const o = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; }
  return o;
};
const beInt = (b: Uint8Array): bigint => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string): Uint8Array => {
  if (!/^([0-9a-f]{2})*$/i.test(h)) throw new Error('evm_k256: not a hex string');
  return new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
};
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Parses the wallet form `r || s || v` (65 bytes; v in {0, 1, 27, 28}).
 *  Refuses r or s outside [1, n). */
export function parseEvmSignature(sig: Uint8Array): ParsedEvmSignature {
  if (sig.length !== 65) throw new Error(`evm_k256: a wallet signature is 65 bytes (r || s || v), got ${sig.length}`);
  const r = beInt(sig.subarray(0, 32));
  const s = beInt(sig.subarray(32, 64));
  if (r === 0n || r >= SECP256K1_ORDER) throw new Error('evm_k256: signature r outside [1, n)');
  if (s === 0n || s >= SECP256K1_ORDER) throw new Error('evm_k256: signature s outside [1, n)');
  const v = sig[64];
  if (![0, 1, 27, 28].includes(v)) throw new Error(`evm_k256: signature v must be 0, 1, 27 or 28, got ${v}`);
  return { r, s, v, recovery: (v >= 27 ? v - 27 : v) as 0 | 1 };
}

/** The wallet form of a parsed signature. */
export function serialiseEvmSignature(sig: ParsedEvmSignature): Uint8Array {
  return new Uint8Array([...be32(sig.r), ...be32(sig.s), sig.v]);
}

/** The malleated twin (r, n - s): the same digest and key, the other S and
 *  recovery parity. The contract accepts it; used by the tests. */
export function highSTwin(sig: ParsedEvmSignature): ParsedEvmSignature {
  const recovery = (sig.recovery ^ 1) as 0 | 1;
  return { r: sig.r, s: SECP256K1_ORDER - sig.s, recovery, v: sig.v >= 27 ? 27 + recovery : recovery };
}

/** The point that produced `sig` over `digest` (the wallet never exposes it). */
export function recoverEvmPoint(digest: Uint8Array, sig: ParsedEvmSignature): Secp256k1Point {
  if (digest.length !== 32) throw new Error('evm_k256: a digest is 32 bytes');
  const p = new secp256k1.Signature(sig.r, sig.s, sig.recovery).recoverPublicKey(digest).toAffine();
  return { x: p.x, y: p.y, identity: false } as Secp256k1Point;
}

/** EIP-191 version 0x45 (`personal_sign`):
 *  keccak256("\x19Ethereum Signed Message:\n" || decimal length || message). */
export function personalMessageDigest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  return keccak_256(new Uint8Array([...prefix, ...message]));
}

/** The 20-byte address of a point, `keccak256(x_be || y_be)[12..32]`: what
 *  the circuit's `evm_address` computes (the standard library's
 *  `secp256k1EthereumAddress` gives the same value). */
export function evmAddressOfPoint(pk: { x: bigint; y: bigint }): Uint8Array {
  return evmAddressOf(pk);
}

// ── The format and the signer check ─────────────────────────────────────────

/** The arm's one format (descriptors.ts READABLE_ARMS.evm_k256.formats):
 *  approvals are EIP-712 V1 typed data, signed with `eth_signTypedData_v4`;
 *  blind requests are signed with `personal_sign`. */
export const EVM_K256_FORMAT = 'eip712-v1';

/** The formats an Ethereum wallet can sign: the arm's one format, for every
 *  wallet, so nothing is detected. A wallet whose settings refuse EIP-712 V1
 *  typed data (the Ledger Ethereum app does by default) refuses the request
 *  itself; its provider does not report that beforehand. */
export function evmK256WalletFormats(): string[] {
  return [checkBlindFormat('evm_k256', EVM_K256_FORMAT)];
}

/** The arm's verification of a wallet signature under an Ethereum address:
 *  the address recovered (ecrecover, with the signature's own recovery byte)
 *  from the exact digest the wallet was asked to sign. A signature from
 *  which no point can be recovered verifies under no address. */
function recoversTo(digest: Uint8Array, sig: ParsedEvmSignature): (address: Uint8Array) => boolean {
  let recovered: Uint8Array | undefined;
  return (address) => eq(recovered ??= evmAddressOfPoint(recoverEvmPoint(digest, sig)), address);
}

/** The addresses the other connected wallets report: the candidates a
 *  refusal may name, each only when the signature recovers to it. None when
 *  the wallet has no such list or the list fails. */
async function otherAddresses(wallet: EvmWallet | undefined): Promise<Uint8Array[]> {
  if (!wallet?.otherAddresses) return [];
  try {
    return [...(await wallet.otherAddresses())];
  } catch {
    return [];
  }
}

/** The signer check: refuses (blind.ts SignerMismatchError), before any
 *  proof, a wallet signature over `digest` that does not recover to
 *  `expected`, naming the first of `others` it recovers to, if any, and
 *  otherwise saying the signer is unknown. Returns the parsed signature. */
export function checkEvmK256Signer(
  expected: Uint8Array, digest: Uint8Array, signature: Uint8Array, others: readonly Uint8Array[] = [],
): ParsedEvmSignature {
  const sig = parseEvmSignature(signature);
  checkSigner('evm_k256', expected, recoversTo(digest, sig), others);
  return sig;
}

// ── Wallets ──────────────────────────────────────────────────────────────────

/** What the arm needs from an Ethereum wallet. A browser adapter maps these to
 *  `eth_accounts`, `personal_sign` and `eth_signTypedData_v4`. */
export interface EvmWallet {
  /** The wallet's 20-byte address. */
  address(): Promise<Uint8Array>;
  /** EIP-191 `personal_sign` over the raw message bytes: 65 bytes r || s || v. */
  personalSign(message: Uint8Array): Promise<Uint8Array>;
  /** EIP-712 `eth_signTypedData_v4` over typed data: 65 bytes r || s || v. */
  signTypedData(typedData: Eip712TypedData): Promise<Uint8Array>;
  /** The addresses other connected wallets report (for example the other
   *  EIP-6963 providers' accounts), if the adapter knows them: only the
   *  candidates a refused signature's signer may be named from. */
  otherAddresses?(): Promise<readonly Uint8Array[]>;
}

/**
 * A software wallet over a secp256k1 secret key, deterministic (RFC 6979) as
 * MetaMask is. For tests and the debug page only; real devices are wallets.
 * `hedged` adds fresh randomness to every signature, which is how the tests
 * stand in for a non-deterministic (MPC, hedged-nonce) wallet.
 */
export class SoftwareEvmWallet implements EvmWallet {
  readonly pk: Secp256k1Point;
  readonly addressBytes: Uint8Array;

  constructor(readonly sk: bigint, readonly hedged = false) {
    if (sk <= 0n || sk >= SECP256K1_ORDER) throw new Error('evm_k256: a secret key is in [1, n)');
    this.pk = pureCircuits.compute_public_point_with_evm_k256(sk);
    this.addressBytes = evmAddressOfPoint(this.pk);
  }

  static generate(): SoftwareEvmWallet {
    for (;;) {
      const b = new Uint8Array(32);
      globalThis.crypto.getRandomValues(b);
      const k = beInt(b);
      if (k > 0n && k < SECP256K1_ORDER) return new SoftwareEvmWallet(k);
    }
  }

  async address(): Promise<Uint8Array> { return new Uint8Array(this.addressBytes); }

  /** Signs a 32-byte digest: the wallet form r || s || v (v = 27 + parity).
   *  noble returns low-S, as MetaMask does. */
  signDigest(digest: Uint8Array): Uint8Array {
    const rec = secp256k1.sign(digest, be32(this.sk), {
      prehash: false, format: 'recovered', ...(this.hedged ? { extraEntropy: true } : {}),
    });
    // noble's recovered format: the recovery byte, then r || s.
    return new Uint8Array([...rec.subarray(1), 27 + rec[0]]);
  }

  async personalSign(message: Uint8Array): Promise<Uint8Array> {
    return this.signDigest(personalMessageDigest(message));
  }

  /** Signs the EIP-712 digest of `typedData` (the client codec's general
   *  encoder, as a wallet hashes it). */
  async signTypedData(typedData: Eip712TypedData): Promise<Uint8Array> {
    return this.signDigest(typedDataDigest(typedData));
  }
}

// ── The device ───────────────────────────────────────────────────────────────

/** The roster record a client persists per device, in its local storage.
 *  Test keys never appear here: a device is its wallet. */
export interface EvmK256RosterRecord {
  scheme: 'evm_k256';
  /** The format the device was enrolled in (READABLE_ARMS formats: the
   *  arm's one format, `eip712-v1`). A device is usable only with the blind
   *  of its enrolment format. */
  format: string;
  network: string;
  accountIndex: string;
  /** EIP-55 checksummed address. */
  address: string;
  /** The recovered public point, big-endian hex coordinates. */
  pk: { x: string; y: string };
  /** The cached blind, hex. A secret (it links this wallet to the account):
   *  it stays in the client's local storage, protected as the wallet's
   *  session data is, and is never sent. Absent once the cache is lost:
   *  restoreEvmK256Device derives it again from the wallet. */
  blind?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,9})$/;

/** A record's point: two 64-digit lower-case hex coordinates, on the curve
 *  and not the point at infinity. */
function recordPoint(pk: unknown): Secp256k1Point {
  const p = pk as { x?: unknown; y?: unknown } | null;
  if (!p || typeof p.x !== 'string' || typeof p.y !== 'string' || !HEX64.test(p.x) || !HEX64.test(p.y)) {
    throw new Error('evm_k256: a record point is two 64-digit lower-case hex coordinates');
  }
  const point = { x: BigInt('0x' + p.x), y: BigInt('0x' + p.y), identity: false } as Secp256k1Point;
  if (point.x === 0n && point.y === 0n) throw new Error('evm_k256: the point at infinity is not a device key');
  secp256k1.Point.fromAffine({ x: point.x, y: point.y }).assertValidity();
  return point;
}

/** A record's cached 32-byte secret (the blind), or undefined when the
 *  cache is absent. */
function recordSecret(v: unknown, what: string): Uint8Array | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`evm_k256: a record's ${what} is hex`);
  const b = unhex(v);
  if (b.length !== 32) throw new Error(`evm_k256: a record's ${what} is 32 bytes`);
  return b;
}

/** The checked parts every record of the arm shares: the format, the
 *  network name, the point and its address. */
function recordCommon(rec: { scheme?: unknown; format?: unknown; network?: unknown; address?: unknown; pk?: unknown }) {
  if (!rec || rec.scheme !== 'evm_k256') throw new Error('evm_k256: not an evm_k256 record');
  const format = checkBlindFormat('evm_k256', rec.format);
  if (typeof rec.network !== 'string') throw new Error('evm_k256: a record names its network');
  const pk = recordPoint(rec.pk);
  if (typeof rec.address !== 'string' || !eq(evmAddressOfPoint(pk), parseEvmAddress(rec.address))) {
    throw new Error('evm_k256: the roster address is not the point\'s address');
  }
  return { format, network: rec.network, pk, address: evmAddressOfPoint(pk) };
}

/** A device record, checked: its parts and, when cached, its blind. */
function parseRosterRecord(rec: EvmK256RosterRecord) {
  const common = recordCommon(rec);
  if (typeof rec.accountIndex !== 'string' || !DECIMAL.test(rec.accountIndex)) throw new Error('evm_k256: a record account index is a decimal number');
  return { ...common, accountIndex: BigInt(rec.accountIndex), blind: recordSecret(rec.blind, 'blind') };
}

/** The authorising material an `evm_k256` device-gated circuit consumes
 *  (the trailing `EvmK256Auth` struct argument). The circuit derives the
 *  address from `pk`; `blind` and `use_counter` are ledger-pinned openings of
 *  the device's entry. */
export interface EvmK256Authorisation {
  arm: 'evm_k256';
  pk: Secp256k1Point;
  use_counter: bigint;
  blind: Uint8Array;
  sig: EvmEcdsaSignature;
  /** The seam's checked byte hints (evm-k256-hints.ts), from the signed typed data. */
  hint: EvmK256SeamHint;
  /** The operation's own hints, when the circuit takes them as its trailing
   *  argument (authArgs appends them). */
  op?: unknown;
}

/** The authorising material an `evm_k256` grantee twin consumes (the
 *  trailing `EvmK256GrantAuth` plus the site label, which grantAuthArgs
 *  places before the opening). The grantee's site label (32-byte
 *  zero-padded ASCII) travels with it; the circuit derives `origin_hash`
 *  from it, and the grant id from the address of `pk`, `blind`, that
 *  origin hash and the slot. */
export interface EvmK256GrantAuthorisation {
  arm: 'evm_k256';
  pk: Secp256k1Point;
  blind: Uint8Array;
  label: Uint8Array;
  sig: EvmEcdsaSignature;
  /** The grant seam's checked byte hints, from the signed typed data. */
  hint: EvmK256GrantSeamHint;
  /** The operation's own hints (grantAuthArgs appends them). */
  op?: unknown;
}

export interface EvmBlindEnrolment {
  message: Uint8Array;
  signatures: [Uint8Array, Uint8Array];
  canonical: Uint8Array;
  blind: Uint8Array;
  pk: Secp256k1Point;
  address: Uint8Array;
}

/**
 * Steps 1-4 of the header: request the blind signature twice, refuse a
 * non-deterministic wallet, derive the blind, recover the point and check
 * that it is the wallet's address.
 */
export async function enrolEvmBlind(
  wallet: EvmWallet, network: string, accountIndex: bigint | number,
): Promise<EvmBlindEnrolment> {
  const address = await wallet.address();
  if (address.length !== 20) throw new Error('blind: the wallet address is 20 bytes');
  return enrolWithRequest(wallet, address, blindMessageBytes({ scheme: 'evm_k256', network, identity: address, accountIndex }));
}

/**
 * The same steps for the wallet as a GRANTEE of `issuingAccount`: the
 * base's grantee request names the role, the network, the wallet and the
 * issuing account's address, and has no account index, so the blind the
 * issuer learns is never a device blind and is different for every issuer.
 */
export async function enrolEvmGranteeBlind(
  wallet: EvmWallet, network: string, issuingAccount: Uint8Array,
): Promise<EvmBlindEnrolment> {
  const address = await wallet.address();
  if (address.length !== 20) throw new Error('blind: the wallet address is 20 bytes');
  return enrolWithRequest(wallet, address, granteeBlindMessageBytes({ scheme: 'evm_k256', network, identity: address, issuingAccount }));
}

/** Signs `message` (a blind request naming `address`) twice; each signature
 *  must recover to `address` (the signer check; `extra` are further
 *  candidates a refusal may name, such as the address the wallet reports
 *  when it is not the one asked for), and both must have the same canonical
 *  form. */
async function enrolWithRequest(
  wallet: EvmWallet, address: Uint8Array, message: Uint8Array, extra: readonly Uint8Array[] = [],
): Promise<EvmBlindEnrolment> {
  const digest = personalMessageDigest(message);
  const others = [...extra, ...(await otherAddresses(wallet))];
  const first = await wallet.personalSign(message);
  const sig = checkEvmK256Signer(address, digest, first, others);
  const second = await wallet.personalSign(message);
  checkEvmK256Signer(address, digest, second, others);
  if (!sameCanonicalSignature('evm_k256', first, second)) {
    throw new Error('blind: the wallet signed the privacy-key request twice with different signatures (not deterministic); this wallet cannot be a Passport device');
  }
  const canonical = canonicalEvmSignature(first);
  const pk = recoverEvmPoint(digest, sig);
  return { message, signatures: [first, second], canonical, blind: deriveBlind('evm_k256', canonical), pk, address: new Uint8Array(address) };
}

/**
 * An `evm_k256` device of one account: its wallet (when present), its
 * recovered point, its address and the account's blind.
 */
export class EvmK256Device {
  readonly arm = 'evm_k256' as const;
  /** The format the device signs in and its blind is bound to. */
  readonly format = EVM_K256_FORMAT;
  readonly address: Uint8Array;

  constructor(
    readonly pk: Secp256k1Point,
    readonly blind: Uint8Array,
    readonly network: string,
    readonly accountIndex: bigint,
    readonly wallet?: EvmWallet,
  ) {
    if (blind.length !== 32) throw new Error('evm_k256: a blind is 32 bytes');
    if (pk.x === 0n && pk.y === 0n) throw new Error('evm_k256: the point at infinity is not a device key');
    secp256k1.Point.fromAffine({ x: pk.x, y: pk.y }).assertValidity();
    this.address = evmAddressOfPoint(pk);
  }

  /** Enrols `wallet` for the account at `accountIndex` on `network`. */
  static async enrol(wallet: EvmWallet, network: string, accountIndex: bigint | number): Promise<EvmK256Device> {
    const e = await enrolEvmBlind(wallet, network, accountIndex);
    return new EvmK256Device(e.pk, e.blind, network, BigInt(accountIndex), wallet);
  }

  /** The EIP-55 form a wallet shows. */
  get checksumAddress(): string { return evmChecksumAddress(this.address); }

  /** The device's rolling entry at an account, epoch and use counter. */
  entryAt(contractAddress: Uint8Array, epoch: bigint, counter: bigint): Uint8Array {
    return pureCircuits.derive_device_entry_with_evm_k256({ bytes: contractAddress }, this.address, this.blind, epoch, counter);
  }

  /** Use counters by account and epoch: the last one confirmed live, or
   *  noted by the caller. Not persisted (a resolution without one scans). */
  private readonly counters = new Map<string, bigint>();

  /** The use counter resolveEvmK256Counter tries first for `contractAddress`
   *  at `epoch`. */
  knownCounter(contractAddress: Uint8Array, epoch: bigint): bigint | undefined {
    return this.counters.get(counterKey(contractAddress, epoch));
  }

  /** Notes `counter` as this device's use counter on `contractAddress` at
   *  `epoch`: the next resolution checks it first, against the ledger. The
   *  way to reach an entry enrolled at a counter above auth_nonce, which the
   *  resolution's scan does not reach. */
  noteCounter(contractAddress: Uint8Array, epoch: bigint, counter: bigint): void {
    this.counters.set(counterKey(contractAddress, epoch), checkUseCounter(counter));
  }

  /** The boot commitment for an account deployed with `salt`. */
  bootCommitment(salt: Uint8Array): Uint8Array {
    return pureCircuits.derive_boot_commitment_with_evm_k256(salt, this.address, this.blind);
  }

  /** The grant id of this key as a grantee of `contractAddress`. */
  grantId(contractAddress: Uint8Array, originHash: Uint8Array, slot: bigint): Uint8Array {
    return pureCircuits.derive_grant_id_with_evm_k256({ bytes: contractAddress }, this.address, this.blind, originHash, slot);
  }

  /**
   * Signs `typedData` with the device's wallet (`eth_signTypedData_v4`) and
   * returns the circuit's authorising material. Typed data under another
   * domain than the fixed V1 domain is refused before the wallet is asked,
   * and a signature that does not recover to this device's address (a wallet
   * that signed with another account) is refused before any proof. The
   * signature is passed on as the wallet produced it; the contract accepts
   * both S forms.
   */
  async authorise(typedData: Eip712TypedData, useCounter: bigint): Promise<EvmK256Authorisation> {
    if (!this.wallet) throw new Error('evm_k256: this device has no wallet');
    checkEip712V1TypedData(typedData);
    const others = await otherAddresses(this.wallet);
    return this.authorisationFrom(typedData, await this.wallet.signTypedData(typedData), useCounter, others);
  }

  /** The authorising material of an existing wallet signature over
   *  `typedData`, with the same checks; `others` are the candidates a
   *  refusal may name. */
  authorisationFrom(typedData: Eip712TypedData, signature: Uint8Array, useCounter: bigint, others: readonly Uint8Array[] = []): EvmK256Authorisation {
    checkEip712V1TypedData(typedData);
    const digest = typedDataDigest(typedData);
    const sig = checkEvmK256Signer(this.address, digest, signature, others);
    const m = typedData.message as { authNonce: string };
    const hint = evmK256SeamHint(this.pk, digest, BigInt(m.authNonce));
    return { arm: 'evm_k256', pk: this.pk, use_counter: useCounter, blind: this.blind, sig: { r: sig.r, s: sig.s }, hint };
  }

  /** The arguments of `activate_initial_device_with_evm_k256`. */
  activationArgs(salt: Uint8Array): [Secp256k1Point, Uint8Array, Uint8Array, EvmAddressHint] {
    return [this.pk, salt, this.blind, evmK256KeyHint(this.pk)];
  }

  /** The roster record to persist, with the blind cached. */
  toRecord(): EvmK256RosterRecord {
    return {
      scheme: 'evm_k256', format: this.format, network: this.network, accountIndex: this.accountIndex.toString(),
      address: this.checksumAddress,
      pk: { x: this.pk.x.toString(16).padStart(64, '0'), y: this.pk.y.toString(16).padStart(64, '0') },
      blind: hex(this.blind),
    };
  }

  /** A device from its roster record and its cached blind. Refuses a record
   *  of another arm or format, a record whose address is not its point's,
   *  and a record without the cached blind (restoreEvmK256Device derives it
   *  again from the wallet). */
  static fromRecord(rec: EvmK256RosterRecord, wallet?: EvmWallet): EvmK256Device {
    const r = parseRosterRecord(rec);
    if (r.blind === undefined) throw new Error('evm_k256: the record holds no cached blind; restore the device from its wallet (restoreEvmK256Device)');
    return new EvmK256Device(r.pk, r.blind, r.network, r.accountIndex, wallet);
  }
}

// ── Use counters ─────────────────────────────────────────────────────────
//
// A device's live entry is at the use counter its next call presents. Every
// circuit that enrols a device of this arm inserts its entry at counter 0 (the
// activation and add_device_with_evm_k256 derive it so), and every successful
// device-gated call removes the caller's entry at counter c and inserts it at
// c + 1 in the transaction that advances auth_nonce by one. auth_nonce starts
// at 0 and never decreases (recovery's finalisation advances it too, and
// clears the device set). So an entry enrolled at counter 0 is live at a
// counter no greater than auth_nonce, and a scan of 0..auth_nonce finds it,
// however many calls the device has made. Upstream's add_device_with_jubjub,
// _with_k256 and _with_p256 take an already-derived entry, whose counter the
// contract cannot read: an entry derived at a counter k > 0 is live at k, and
// the scan reaches it only while k <= auth_nonce; above that, the caller gives
// k (EvmK256Device.noteCounter, or the resolver's `counter`). From a counter
// the device held once, its counter now is at most auth_nonce higher (one per
// call, and auth_nonce counts every call), so the scan forward from a known
// counter reaches known + auth_nonce (or 2^64 - 1, the largest counter, if
// that is less), which also follows such an entry; the scan from 0 always
// follows it, so a wrong known counter never hides an entry enrolled at 0.
// Every counter a caller gives is checked to be a Uint<64> first.
//
// A scan can be long (auth_nonce counts every call of every device), so it
// runs in chunks of SCAN_CHUNK probes and yields to the event loop between
// two chunks, and a caller's AbortSignal stops it between chunks. A live known
// counter costs one probe and its successor two, both inside the first chunk.

const counterKey = (contractAddress: Uint8Array, epoch: bigint) => `${hex(contractAddress)}/${epoch.toString()}`;

/** The largest use counter: the entry recipes take a Uint<64>. */
const MAX_USE_COUNTER = (1n << 64n) - 1n;

/** How many entries a scan probes between two yields to the event loop. */
const SCAN_CHUNK = 256;

/** A counter resolution's options: a use counter the caller knows (a
 *  Uint<64>, checked first; it overrides the device object's own), and a
 *  signal that cancels the scan (the resolution then rejects, naming the
 *  probes made, with the signal's reason as the cause). */
export interface EvmK256CounterOptions { counter?: bigint; signal?: AbortSignal }

/** Refuses a value that is not a Uint<64>, the type of a use counter. */
function checkUseCounter(counter: unknown): bigint {
  if (typeof counter !== 'bigint' || counter < 0n || counter > MAX_USE_COUNTER) throw new Error('evm_k256: a use counter is a Uint<64>');
  return counter;
}

/** Refuses the resolution when `signal` is aborted, before any probe or
 *  between two chunks of a scan. */
function checkNotAborted(signal: AbortSignal | undefined, probes: number): void {
  if (signal?.aborted) throw new Error(`evm_k256: the use-counter scan was aborted after ${probes} probes`, { cause: signal.reason });
}

/** Checks a resolution's options before the ledger is read: the counter a
 *  Uint<64>, the signal an AbortSignal not yet aborted. */
function checkCounterOptions(opts: EvmK256CounterOptions): void {
  if (opts.counter !== undefined) checkUseCounter(opts.counter);
  if (opts.signal !== undefined && typeof (opts.signal as { aborted?: unknown }).aborted !== 'boolean') throw new Error('evm_k256: signal is an AbortSignal');
  checkNotAborted(opts.signal, 0);
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => {
  const g = globalThis as { setImmediate?: (f: () => void) => unknown };
  if (typeof g.setImmediate === 'function') g.setImmediate(resolve); else setTimeout(resolve, 0);
});

/** The first live counter in the order: `known` (when given), forward from it
 *  through known + authNonce (at most the largest counter), then from 0 up to
 *  it (or through authNonce without a known counter); undefined when none is
 *  live. At most 2 x authNonce + 2 probes, in chunks (see "Use counters"). */
async function liveCounter(isLive: (counter: bigint) => boolean, authNonce: bigint, known?: bigint, signal?: AbortSignal): Promise<bigint | undefined> {
  if (known !== undefined) checkUseCounter(known);
  checkNotAborted(signal, 0);
  const ranges: [bigint, bigint][] = [];
  if (known !== undefined) ranges.push([known, known + authNonce < MAX_USE_COUNTER ? known + authNonce : MAX_USE_COUNTER]);
  const last = known !== undefined && known <= authNonce ? known - 1n : authNonce;
  if (last >= 0n) ranges.push([0n, last]);
  let probes = 0;
  for (const [from, to] of ranges) {
    for (let k = from; k <= to; k++) {
      if (probes > 0 && probes % SCAN_CHUNK === 0) {
        await yieldToEventLoop();
        checkNotAborted(signal, probes);
      }
      probes++;
      if (isLive(k)) return k;
    }
  }
  return undefined;
}

/** The result of a restore: the device (or grantee), or why it cannot be
 *  restored with this wallet and what remains, in blind.ts restoreBlind's
 *  words. `source`: `cache`, the stored blind (no signature asked);
 *  `stored-format`, derived again in the record's format; `search`, derived
 *  in every format the wallet signs and found by the caller's test. */
export type EvmK256Restore<T> =
  | { ok: true; source: 'cache' | 'stored-format' | 'search'; value: T }
  | { ok: false; reason: 'format-unavailable' | 'not-found' | 'no-format'; message: string };

/** What a device restore starts from: the stored record (its network,
 *  account index, address, format and, while cached, its blind), or, without
 *  one, the network and account index to try. `finds` is the caller's test
 *  of a candidate device against the accounts (their entries, for example
 *  evmK256DeviceFinds); it is needed for every blind derived again (a record
 *  without its cached blind, or no record), and never asked for a cached
 *  blind. */
export type EvmK256DeviceRestoreRequest =
  | { wallet: EvmWallet; record: EvmK256RosterRecord; finds?: (device: EvmK256Device) => boolean | Promise<boolean> }
  | { wallet: EvmWallet; network: string; accountIndex: bigint | number; finds: (device: EvmK256Device) => boolean | Promise<boolean> };

/**
 * Restores one device of `wallet` through blind.ts restoreBlind: a cached
 * blind is used as it is; a record without it has the blind derived again
 * in the record's format, from a signature that must come from the
 * record's address (whatever address the wallet reports), and kept only when
 * `finds` accepts the device (a wallet of the same key whose deterministic
 * signature differs from the enrolling wallet's derives another blind);
 * without a record the blind is derived in every format the wallet signs
 * (the arm's one) and kept when `finds` accepts the device. A blind is never
 * derived in another format than the stored one, and the wallet is asked for
 * nothing it cannot sign. Without a match, the result carries restoreBlind's
 * message: no account was found, and what remains (add this wallet as a new
 * device from another device of the account, or through the account's
 * recovery).
 */
export async function restoreEvmK256Device(req: EvmK256DeviceRestoreRequest): Promise<EvmK256Restore<EvmK256Device>> {
  const { wallet } = req;
  const rec = 'record' in req && req.record !== undefined ? parseRosterRecord(req.record) : undefined;
  const hasFinds = 'finds' in req && typeof req.finds === 'function';
  if (rec === undefined && !hasFinds) {
    throw new Error('evm_k256: a restore without a stored record needs the network, the account index and finds');
  }
  if (rec !== undefined && rec.blind === undefined && !hasFinds) {
    throw new Error('evm_k256: a restore of a record without its cached blind needs finds (the blind derived again is checked against the accounts)');
  }
  const reported = await wallet.address();
  const network = rec ? rec.network : (req as { network: string }).network;
  const accountIndex = rec ? rec.accountIndex : BigInt((req as { accountIndex: bigint | number }).accountIndex);
  const address = rec ? rec.address : reported;
  if (address.length !== 20) throw new Error('blind: the wallet address is 20 bytes');
  let pk: Secp256k1Point | undefined;
  const r = await restoreBlind({
    scheme: 'evm_k256', role: 'device',
    stored: rec ? { format: rec.format, blind: rec.blind } : undefined,
    walletFormats: evmK256WalletFormats(),
    derive: async (format) => {
      if (format !== EVM_K256_FORMAT) throw new Error(`evm_k256: no blind request in the format ${format}`);
      const e = await enrolWithRequest(wallet, address, blindMessageBytes({ scheme: 'evm_k256', network, identity: address, accountIndex }), [reported]);
      pk = e.pk;
      return e.blind;
    },
    finds: async (blind) => (await (req as { finds: (d: EvmK256Device) => boolean | Promise<boolean> }).finds(new EvmK256Device(pk!, blind, network, accountIndex, wallet))) === true,
  });
  if (r.ok === false) return { ok: false, reason: r.reason, message: r.message };
  return { ok: true, source: r.source, value: new EvmK256Device(rec ? rec.pk : pk!, r.matches[0].blind, network, accountIndex, wallet) };
}

/**
 * Restore without records: the account indexes 0..maxIndex of `wallet` on
 * `network`, each through restoreEvmK256Device, its blind derived from the
 * wallet and tested against candidate accounts' device sets (each account's
 * epoch and auth_nonce, read from its ledger) at every counter from 0 to its
 * auth_nonce (see "Use counters"; `opts.signal` cancels the scans). Returns
 * every match, with the counter of its live entry. The wallet is asked for 2 x (maxIndex + 1) `personal_sign`
 * approvals (two per index: the sign-twice check).
 */
export async function restoreEvmDevices(
  wallet: EvmWallet,
  network: string,
  accounts: { address: Uint8Array; epoch: bigint; authNonce: bigint; isMember: (entry: Uint8Array) => boolean }[],
  opts: { maxIndex?: number; signal?: AbortSignal } = {},
): Promise<{ accountIndex: bigint; account: Uint8Array; counter: bigint; device: EvmK256Device }[]> {
  const found: { accountIndex: bigint; account: Uint8Array; counter: bigint; device: EvmK256Device }[] = [];
  const maxIndex = opts.maxIndex ?? 4;
  checkCounterOptions({ signal: opts.signal });
  for (const a of accounts) {
    if (typeof a.authNonce !== 'bigint' || a.authNonce < 0n) throw new Error('evm_k256: each account gives its auth_nonce (a non-negative bigint), the bound of the counter scan');
  }
  for (let i = 0; i <= maxIndex; i++) {
    const hits: { account: Uint8Array; counter: bigint }[] = [];
    const r = await restoreEvmK256Device({
      wallet, network, accountIndex: i,
      finds: async (device) => {
        for (const a of accounts) {
          const k = await liveCounter((c) => a.isMember(device.entryAt(a.address, a.epoch, c)), a.authNonce, undefined, opts.signal);
          if (k !== undefined) hits.push({ account: a.address, counter: k });
        }
        return hits.length > 0;
      },
    });
    if (r.ok === true) found.push(...hits.map((h) => ({ accountIndex: BigInt(i), ...h, device: r.value })));
  }
  return found;
}

// ── Calls (the arm-owned facade) ────────────────────────────────────────
//
// The account client (account.ts) routes authorised calls by the
// Authorisation's arm through the registered authArgs branch, so the
// `*WithAuth` methods of a CustodyAccount reach this arm's circuits unchanged.
// What it cannot do for this arm is build the readable message and find the
// device's use counter; these helpers do.

/** The surface of a CustodyAccount these helpers use. */
export interface EvmK256AccountSurface {
  addressBytes: Uint8Array;
  ledgerState(): Promise<{ auth_nonce: bigint; device_epoch: bigint; devices: { member(e: Uint8Array): boolean } }>;
  rotateEncKeyWithAuth(newKey: Uint8Array, a: EvmK256Authorisation): Promise<{ txId: string }>;
}

type EvmK256LedgerView = Awaited<ReturnType<EvmK256AccountSurface['ledgerState']>>;

/** The counter of `device`'s live entry in the ledger state `l`, kept as the
 *  device's known counter (see resolveEvmK256Counter). */
async function counterIn(l: EvmK256LedgerView, account: EvmK256AccountSurface, device: EvmK256Device, opts: EvmK256CounterOptions = {}): Promise<bigint> {
  const known = opts.counter ?? device.knownCounter(account.addressBytes, l.device_epoch);
  const found = await liveCounter((k) => l.devices.member(device.entryAt(account.addressBytes, l.device_epoch, k)), l.auth_nonce, known, opts.signal);
  if (found === undefined) {
    const top = known !== undefined && known + l.auth_nonce < MAX_USE_COUNTER ? known + l.auth_nonce : MAX_USE_COUNTER;
    throw new Error(`evm_k256: no live entry for this device at the current epoch, at any use counter from 0 to auth_nonce (${l.auth_nonce})` +
      `${known !== undefined ? `, or from the known counter ${known} through ${top}` : ''}: not a device of this account, or an entry enrolled at a counter above auth_nonce (give it with noteCounter)`);
  }
  device.noteCounter(account.addressBytes, l.device_epoch, found);
  return found;
}

/** The use counter of `device`'s live entry on `account` at the current
 *  epoch (MIP-0013 S11): the known counter first (`opts.counter`, else the
 *  last one this device object confirmed for the account and epoch, or one
 *  noted with noteCounter), then every counter forward from it through
 *  known + auth_nonce, then from 0 up to it. That scan is complete for every entry
 *  enrolled at counter 0 (see "Use counters"), so a device never stops being
 *  found after many calls. The counter found becomes the known one, so the
 *  next call finds its successor with one more probe. `opts.counter` must be
 *  a Uint<64>, checked before the ledger is read; `opts.signal` cancels the
 *  scan. */
export async function resolveEvmK256Counter(account: EvmK256AccountSurface, device: EvmK256Device, opts: EvmK256CounterOptions = {}): Promise<bigint> {
  checkCounterOptions(opts);
  return counterIn(await account.ledgerState(), account, device, opts);
}

/** A restore's test of a candidate device (restoreEvmK256Device `finds`):
 *  whether it has a live entry on `account` at the current epoch, at any
 *  counter from 0 to auth_nonce; `opts.signal` cancels the scan. */
export function evmK256DeviceFinds(account: EvmK256AccountSurface, opts: { signal?: AbortSignal } = {}): (device: EvmK256Device) => Promise<boolean> {
  checkCounterOptions({ signal: opts.signal });
  return async (device) => {
    checkNotAborted(opts.signal, 0);
    const l = await account.ledgerState();
    return (await liveCounter((k) => l.devices.member(device.entryAt(account.addressBytes, l.device_epoch, k)), l.auth_nonce, undefined, opts.signal)) !== undefined;
  };
}

/** rotate_enc_key_with_evm_k256: the RotateEncKey message, signed by the
 *  device's wallet, then the call. `opts` as resolveEvmK256Counter's. */
export async function rotateEncKeyWithEvmK256(account: EvmK256AccountSurface, device: EvmK256Device, newKey: Uint8Array, opts: EvmK256CounterOptions = {}) {
  checkCounterOptions(opts);
  const l = await account.ledgerState();
  const counter = await counterIn(l, account, device, opts);
  const typedData = evmK256Messages.rotateEncKey({ account: account.addressBytes, device: device.address, authNonce: l.auth_nonce }, newKey);
  const auth = await device.authorise(typedData, counter);
  return { typedData, auth, ...(await account.rotateEncKeyWithAuth(newKey, auth)) };
}

// ── Custody ────────────────────────────────────────────────────────────

/** The surface of a CustodyAccount the custody helpers use (CustodyAccount
 *  routes each `*WithAuth` call to `<operation>_with_evm_k256` through the
 *  registered authArgs branch). */
export interface EvmK256CustodySurface extends EvmK256AccountSurface {
  appendInboxWithAuth(entry: Uint8Array, a: EvmK256Authorisation): Promise<{ txId: string }>;
  withdrawUnshieldedWithAuth(color: Uint8Array, amount: bigint, recipient: Uint8Array, a: EvmK256Authorisation): Promise<{ txId: string }>;
  withdrawShieldedWithAuth(recipient: Uint8Array, color: Uint8Array, amount: bigint, a: EvmK256Authorisation): Promise<{ txId: string; change: unknown }>;
  withdrawShieldedToContractWithAuth(recipient: Uint8Array, color: Uint8Array, amount: bigint, a: EvmK256Authorisation): Promise<{ txId: string; sent: unknown; change: unknown }>;
  /** The coin the held_coin witness will return for `color` (the store). */
  heldCoin(color: Uint8Array): Promise<{ nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint }>;
}

/** The device frame of the next call and the device's counter, from one
 *  read of the ledger; `opts` as resolveEvmK256Counter's (every helper below
 *  takes them as its last argument). */
async function deviceFrame(account: EvmK256AccountSurface, device: EvmK256Device, opts: EvmK256CounterOptions = {}) {
  checkCounterOptions(opts);
  const l = await account.ledgerState();
  const counter = await counterIn(l, account, device, opts);
  return { frame: { account: account.addressBytes, device: device.address, authNonce: l.auth_nonce }, counter };
}

/** The coin a shielded spend will consume, as the approval shows it.
 *  Refuses a stored coin of another colour at the client (the circuit
 *  asserts it too). */
async function spentCoin(account: EvmK256CustodySurface, color: Uint8Array) {
  const c = await account.heldCoin(color);
  if (!eq(c.color, color)) throw new Error('evm_k256: the held coin is not of the withdrawn colour');
  return { nonce: c.nonce, value: c.value, mtIndex: c.mt_index };
}

/** append_inbox_with_evm_k256: the AppendInbox message (the 192-byte
 *  entry in full), signed by the device's wallet, then the call. */
export async function appendInboxWithEvmK256(account: EvmK256CustodySurface, device: EvmK256Device, entry: Uint8Array, opts: EvmK256CounterOptions = {}) {
  const { frame, counter } = await deviceFrame(account, device, opts);
  const typedData = evmK256Messages.appendInbox(frame, entry);
  const auth = await device.authorise(typedData, counter);
  return { typedData, auth, ...(await account.appendInboxWithAuth(entry, auth)) };
}

/** withdraw_unshielded_with_evm_k256 to a 32-byte user address. */
export async function withdrawUnshieldedWithEvmK256(
  account: EvmK256CustodySurface, device: EvmK256Device, color: Uint8Array, amount: bigint, recipient: Uint8Array, site: SiteAmount,
  opts: EvmK256CounterOptions = {},
) {
  const { frame, counter } = await deviceFrame(account, device, opts);
  const typedData = evmK256Messages.withdrawUnshielded(frame, color, amount, recipient, site);
  const auth = { ...(await device.authorise(typedData, counter)), op: evmK256AmountHint(amount, site) };
  return { typedData, auth, ...(await account.withdrawUnshieldedWithAuth(color, amount, recipient, auth)) };
}

/** withdraw_shielded_with_evm_k256 to a Zswap coin public key: the approval
 *  shows the coin the store holds for `color` (nonce, value, Merkle index)
 *  and the change. */
export async function withdrawShieldedWithEvmK256(
  account: EvmK256CustodySurface, device: EvmK256Device, recipient: Uint8Array, color: Uint8Array, amount: bigint, site: SiteAmount,
  opts: EvmK256CounterOptions = {},
) {
  const { frame, counter } = await deviceFrame(account, device, opts);
  const coin = await spentCoin(account, color);
  const typedData = evmK256Messages.withdrawShielded(frame, color, amount, recipient, coin, site);
  const auth = { ...(await device.authorise(typedData, counter)), op: evmK256CoinHint(amount, coin.value, coin.mtIndex, site) };
  return { typedData, auth, coin, ...(await account.withdrawShieldedWithAuth(recipient, color, amount, auth)) };
}

/** withdraw_shielded_to_contract_with_evm_k256 (direct transfer, MIP-0012
 *  §6.6): the typed data and authorisation only, because the call must be
 *  composed with the recipient contract's claim in one transaction (see
 *  `withdrawShieldedToContractWithAuth` for an uncomposed call). */
export async function authoriseWithdrawShieldedToContract(
  account: EvmK256CustodySurface, device: EvmK256Device, recipientContract: Uint8Array, color: Uint8Array, amount: bigint, site: SiteAmount,
  opts: EvmK256CounterOptions = {},
) {
  const { frame, counter } = await deviceFrame(account, device, opts);
  const coin = await spentCoin(account, color);
  const typedData = evmK256Messages.withdrawShieldedToContract(frame, color, amount, recipientContract, coin, site);
  return { typedData, coin, auth: { ...(await device.authorise(typedData, counter)), op: evmK256CoinHint(amount, coin.value, coin.mtIndex, site) } };
}

// ── Device lifecycle ───────────────────────────────────────────────────
//
// add_device_with_evm_k256 and remove_device_with_evm_k256 take the other
// key as a readable descriptor, not an entry: the circuit
// derives the entry from it with the target scheme's own recipe. Their ABI
// differs from upstream's add/remove_device(entry), so CustodyAccount's
// entry-typed helpers cannot reach them; these call the circuits directly.

const le32 = (v: bigint): Uint8Array => { const o = new Uint8Array(32); let x = v; for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const leInt = (b: Uint8Array): bigint => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
const ZERO32 = new Uint8Array(32);
const ZERO21 = new Uint8Array(21);

/** A grantee's site in the form its kind shows it (GranteeSite), as bytes
 *  of the expected length; refuses any other form or length. */
type SiteField = (k: 'label' | 'origin' | 'originHash', n: number) => Uint8Array;

/** Each payload form's circuit fields, from a checked descriptor of a kind
 *  of that form (and, for a grantee, its site), and the descriptor a grantee
 *  input of that form encodes. The kind of a descriptor is its scheme's
 *  entry in EVM_K256_KINDS (evm-k256-codec.ts). */
const PAYLOAD_INPUTS: Readonly<Record<EvmK256Payload, {
  device: (d: Descriptor) => Partial<EvmK256DescriptorInput>;
  grantee: (d: Descriptor, site: SiteField) => Partial<EvmK256GranteeInput>;
  descriptorOf: (scheme: string, g: EvmK256GranteeInput) => Descriptor;
  /** A check of the grantee's site beyond the key's own (checkDescriptor). */
  checkSite?: (d: Descriptor, g: EvmK256GranteeInput) => void;
}>> = {
  address: {
    device: (d) => { const w = d as W52Descriptor; return { address: new Uint8Array(w.address), key2: new Uint8Array(w.blind) }; },
    grantee: (d, site) => { const w = d as W52Descriptor; return { address: new Uint8Array(w.address), key2: new Uint8Array(w.blind), label: site('label', 32) }; },
    descriptorOf: (scheme, g) => ({ scheme, address: g.address, blind: g.key2 }) as Descriptor,
  },
  ed25519: {
    device: (d) => { const e = d as Ed25519Descriptor; return { key: new Uint8Array(e.key), key2: new Uint8Array(e.blind) }; },
    grantee: (d, site) => { const e = d as Ed25519Descriptor; return { key: new Uint8Array(e.key), key2: new Uint8Array(e.blind), label: site('label', 32) }; },
    descriptorOf: (scheme, g) => ({ scheme, key: g.key, blind: g.key2 }) as Descriptor,
  },
  jubjub: {
    device: (d) => { const j = d as JubjubDescriptor; return { key: le32(j.x), key2: le32(j.y) }; },
    grantee: (d, site) => { const j = d as JubjubDescriptor; return { key: le32(j.x), key2: le32(j.y), origin_hash: site('originHash', 32) }; },
    descriptorOf: (scheme, g) => ({ scheme, x: leInt(g.key), y: leInt(g.key2) }) as Descriptor,
  },
  k256: {
    device: (d) => { const k = d as K256Descriptor; return { key: le32(k.x), key2: le32(k.y), envelope: BigInt(k.envelope) }; },
    grantee: (d, site) => { const k = d as K256Descriptor; return { key: le32(k.x), key2: le32(k.y), envelope: BigInt(k.envelope), origin_hash: site('originHash', 32) }; },
    descriptorOf: (scheme, g) => ({ scheme, x: leInt(g.key), y: leInt(g.key2), envelope: Number(g.envelope) }) as Descriptor,
  },
  passkey: {
    device: (d) => {
      const p = d as P256Descriptor;
      if (!p.policy) throw new Error('descriptor: a passkey device needs its policy (RP hash and origin)');
      return { key: le32(p.x), key2: le32(p.y), rp_id_hash: new Uint8Array(p.policy.rpIdHash), origin: new Uint8Array(p.policy.origin) };
    },
    grantee: (d, site) => { const p = d as P256Descriptor; return { key: le32(p.x), key2: le32(p.y), origin: checkPasskeySiteOrigin(p, site('origin', 21)) }; },
    descriptorOf: (scheme, g) => ({ scheme, x: leInt(g.key), y: leInt(g.key2) }) as Descriptor,
    checkSite: (d, g) => { checkPasskeySiteOrigin(d as P256Descriptor, g.origin); },
  },
};

/** The circuit's `EvmK256Descriptor` for a readable descriptor: its kind's
 *  device tag and the fields of the kind's payload form (an address and
 *  privacy salt; an Ed25519 key's 32 bytes and privacy salt; JubJub, k256
 *  and P-256 coordinates little-endian, as the recipes bind them; a k256
 *  envelope; a passkey's RP hash and exact origin). The other fields are
 *  zero: no recipe hashes them and no approval shows them. The descriptor is
 *  checked by the strict client decoders first. */
export function evmK256DescriptorInput(descriptor: Descriptor): EvmK256DescriptorInput {
  if (!descriptor || !Object.hasOwn(EVM_K256_KINDS, (descriptor as { scheme?: string }).scheme ?? '')) {
    throw new Error('descriptor: not a registered device scheme');
  }
  const d = checkDescriptor(descriptor);
  const base = { tag: padTag(DESCRIPTOR_TAGS.device[d.scheme]), key: ZERO32, key2: ZERO32, address: new Uint8Array(20), envelope: 0n, rp_id_hash: ZERO32, origin: ZERO21 };
  return { ...base, ...PAYLOAD_INPUTS[EVM_K256_KINDS[d.scheme].payload].device(d) };
}

/** The descriptor the literal-entry form passes: unused by the circuit. */
export const EVM_K256_UNUSED_DESCRIPTOR: EvmK256DescriptorInput = {
  tag: padTag(DESCRIPTOR_TAGS.device.evm_k256), key: ZERO32, key2: ZERO32, address: new Uint8Array(20), envelope: 0n, rp_id_hash: ZERO32, origin: ZERO21,
};

/** The trailing circuit arguments of a device-gated circuit: the auth
 *  struct (its seam hints included), then the operation's own hints when
 *  the circuit takes them. */
export function evmK256AuthArgs(a: EvmK256Authorisation): unknown[] {
  const { arm, op, ...auth } = a;
  return op === undefined ? [auth] : [auth, op];
}

/** The trailing circuit arguments of a grantee twin: the site label and
 *  slot, the grant openings (scope salt, recipient kind and pin, max coin
 *  value, spent so far), the auth struct, then the operation's own hints
 *  when the circuit takes them. */
export function evmK256GrantAuthArgs(o: GrantOpening, a: EvmK256GrantAuthorisation): unknown[] {
  const { arm, label, op, ...auth } = a;
  const openings = [o.scopeSalt, o.recipientKind, o.pinnedRecipient, o.maxCoinValue, o.spentPrev];
  return op === undefined ? [label, o.slot, ...openings, auth] : [label, o.slot, ...openings, auth, op];
}

/** The surface the device-lifecycle calls use: CustodyAccount's raw call-tx
 *  interface. */
export interface EvmK256LifecycleSurface extends EvmK256AccountSurface {
  callTx: Record<string, (...args: unknown[]) => Promise<any>>;
}

const txIdOf = (r: any): string => {
  const id = r?.public?.txId ?? r?.public?.transactionHash;
  if (!id) throw new Error('evm_k256: the call returned no transaction id');
  return id;
};
const authArg = (a: EvmK256Authorisation) => { const { arm, op, ...auth } = a; return auth; };

/** add_device_with_evm_k256: the AddDevice message ("Gives this key FULL
 *  control of this account" and the target's descriptor), signed, then the
 *  call; the circuit enrols the target at the current epoch and counter 0. */
export async function addDeviceWithEvmK256(account: EvmK256LifecycleSurface, device: EvmK256Device, target: Descriptor, opts: EvmK256CounterOptions = {}) {
  const { frame, counter } = await deviceFrame(account, device, opts);
  const input = evmK256DescriptorInput(target);
  const typedData = evmK256Messages.addDevice(frame, input);
  const auth = await device.authorise(typedData, counter);
  const r = await account.callTx.add_device_with_evm_k256(input, ...ed25519Args(input), authArg(auth), evmK256DescriptorHint(input));
  return { typedData, auth, input, txId: txIdOf(r) };
}

/** remove_device_with_evm_k256, descriptor form: the target's entry at
 *  (targetEpoch, targetCounter); the epoch may be a future one (removal only
 *  reduces authority). */
export async function removeDeviceWithEvmK256(
  account: EvmK256LifecycleSurface, device: EvmK256Device, target: Descriptor, targetEpoch: bigint, targetCounter: bigint,
  opts: EvmK256CounterOptions = {},
) {
  const { frame, counter } = await deviceFrame(account, device, opts);
  const input = evmK256DescriptorInput(target);
  const typedData = evmK256Messages.removeDevice(frame, input, targetEpoch, targetCounter);
  const auth = await device.authorise(typedData, counter);
  const r = await account.callTx.remove_device_with_evm_k256(input, ...ed25519Args(input), targetEpoch, targetCounter, { is_some: false, value: ZERO32 }, authArg(auth),
    evmK256RemoveHint(input, targetEpoch, targetCounter));
  return { typedData, auth, input, txId: txIdOf(r) };
}

/** remove_device_with_evm_k256, literal-entry form: an entry this wallet
 *  cannot describe, under "Removes a device this wallet cannot identify". */
export async function removeUnknownDeviceWithEvmK256(account: EvmK256LifecycleSurface, device: EvmK256Device, entry: Uint8Array, opts: EvmK256CounterOptions = {}) {
  if (entry.length !== 32) throw new Error('evm_k256: an entry is 32 bytes');
  const { frame, counter } = await deviceFrame(account, device, opts);
  const typedData = evmK256Messages.removeUnknownDevice(frame, entry);
  const auth = await device.authorise(typedData, counter);
  const r = await account.callTx.remove_device_with_evm_k256(EVM_K256_UNUSED_DESCRIPTOR, ...EVM_K256_ED25519_FILLER_ARGS, 0n, 0n, { is_some: true, value: new Uint8Array(entry) }, authArg(auth),
    evmK256RemoveHint(EVM_K256_UNUSED_DESCRIPTOR, 0n, 0n));
  return { typedData, auth, txId: txIdOf(r) };
}

/** This device as a descriptor (another device adds or removes it). */
export const evmDeviceDescriptor = (d: EvmK256Device): Descriptor => ({ scheme: 'evm_k256', address: new Uint8Array(d.address), blind: new Uint8Array(d.blind) });

// ── Scoped grants ──────────────────────────────────────────────────────

/** How a readable owner shows a grantee's site, by its kind's payload form
 *  (evm-k256-codec.ts EVM_K256_KINDS): an address or ed25519 grantee
 *  by its 32-byte site label (shown as text), a passkey by its exact 21-byte
 *  origin (shown as text), a k256 or JubJub grantee by its origin hash
 *  (shown under the fixed member `siteLabelHash`; the client shows the
 *  client id beside it). */
export type GranteeSite = { label: Uint8Array } | { origin: Uint8Array } | { originHash: Uint8Array; clientId?: string };

/** The circuit's `EvmK256GranteeDescriptor` for a grantee of any kind
 *  (its key as a readable descriptor, its site in its kind's form, its slot). */
export function evmK256GranteeInput(descriptor: Descriptor, site: GranteeSite, slot: bigint): EvmK256GranteeInput {
  if (!descriptor || !Object.hasOwn(EVM_K256_KINDS, (descriptor as { scheme?: string }).scheme ?? '')) {
    throw new Error('descriptor: not a registered grantee scheme');
  }
  if (slot < 0n || slot > 255n) throw new Error('descriptor: a grant slot is a Uint<8>');
  const d = checkDescriptor(descriptor);
  const base = { tag: padTag(DESCRIPTOR_TAGS['grant-id'][d.scheme]), key: ZERO32, key2: ZERO32, address: new Uint8Array(20), envelope: 0n,
    origin: ZERO21, label: ZERO32, origin_hash: ZERO32, slot };
  const need: SiteField = (k, n) => {
    const v = (site as any)[k];
    if (!(v instanceof Uint8Array) || v.length !== n) throw new Error(`descriptor: a ${d.scheme} grantee is shown by its ${k} (${n} bytes)`);
    return new Uint8Array(v);
  };
  return { ...base, ...PAYLOAD_INPUTS[EVM_K256_KINDS[d.scheme].payload].grantee(d, need) };
}

/** A passkey grantee's site origin (its own field, apart from
 *  any policy on the key) passes the base's origin rule (21 bytes, visible
 *  ASCII, no quote or backslash; descriptors.ts checkDescriptor), checked by
 *  the base function itself on the key with that origin. */
function checkPasskeySiteOrigin(d: { x: bigint; y: bigint }, origin: Uint8Array): Uint8Array {
  checkDescriptor({ scheme: 'p256', x: d.x, y: d.y, policy: { rpIdHash: new Uint8Array(32), origin } } as Descriptor);
  return origin;
}

/** The tag of a grantee's read seed (client only: the key never enters a circuit). */
export const EVM_K256_GRANT_READ_TAG = 'midnight:account:read:evm:v1';

/** A grant's X25519 read key: the secret (clamped per RFC 7748) and `read_pk`. */
export interface EvmK256ReadKey { secretKey: Uint8Array; publicKey: Uint8Array }

/** The read seed of a grantee blind request's canonical signature. */
export function evmK256GrantReadSeed(canonical: Uint8Array): Uint8Array {
  if (canonical.length !== 64) throw new Error('read key: a canonical signature is 64 bytes');
  return sha256(new Uint8Array([...padTag(EVM_K256_GRANT_READ_TAG), ...canonical]));
}

/** The read key of one grant: fresh per account (32 bytes) and per grant
 *  (site label, 32 bytes, and slot). */
export function evmK256GrantReadKey(readSeed: Uint8Array, account: Uint8Array, label: Uint8Array, slot: bigint): EvmK256ReadKey {
  if (readSeed.length !== 32 || account.length !== 32 || label.length !== 32) throw new Error('read key: the seed, the account and the label are 32 bytes each');
  if (slot < 0n || slot > 255n) throw new Error('read key: a grant slot is a Uint<8>');
  const k = sha256(new Uint8Array([...readSeed, ...account, ...label, Number(slot)]));
  k[0] &= 248; k[31] &= 127; k[31] |= 64;
  return { secretKey: k, publicKey: x25519.getPublicKey(k) };
}

/**
 * An `evm_k256` key as a GRANTEE of an account: its point, its blind (from
 * the grantee blind request, signed with `personal_sign`), the 32-byte site
 * label it is known by, and its slot. Its grant id is
 * derive_grant_id_with_evm_k256(account, address, blind,
 * H(origin tag || label), slot). It signs one readable type per operation
 * over the grant frame (the record's issuedAt and nonce, never auth_nonce).
 *
 * Its read seed (the grant read keys' secret) is held in memory only, shared
 * by the grantee's copies for other grants of the same issuing account
 * (`withGrant`), and never written to a record.
 */
export class EvmK256Grantee {
  readonly arm = 'evm_k256' as const;
  /** The format the grantee signs in and its blind is bound to. */
  readonly format = EVM_K256_FORMAT;
  readonly address: Uint8Array;
  /** The session's read seed, once known, and its derivation while one is
   *  asked of the wallet (so concurrent reads ask once). */
  private session: { readSeed?: Uint8Array; deriving?: Promise<Uint8Array> };

  constructor(
    readonly pk: Secp256k1Point,
    readonly blind: Uint8Array,
    readonly label: Uint8Array,
    readonly slot: bigint,
    readonly wallet?: EvmWallet,
    readSeed?: Uint8Array,
    /** The network and the issuing account of the grantee request the blind
     *  was derived from (known to a grantee enrolled or restored from its
     *  wallet or its record). */
    readonly issuer?: { network: string; issuingAccount: Uint8Array },
  ) {
    if (blind.length !== 32) throw new Error('evm_k256: a blind is 32 bytes');
    if (label.length !== 32) throw new Error('evm_k256: a site label is 32 bytes');
    if (readSeed && readSeed.length !== 32) throw new Error('evm_k256: a read seed is 32 bytes');
    this.session = { readSeed: readSeed === undefined ? undefined : new Uint8Array(readSeed) };
    if (issuer && (!(issuer.issuingAccount instanceof Uint8Array) || issuer.issuingAccount.length !== 32)) throw new Error('evm_k256: the issuing account address is 32 bytes');
    if (pk.x === 0n && pk.y === 0n) throw new Error('evm_k256: the point at infinity is not a grantee key');
    secp256k1.Point.fromAffine({ x: pk.x, y: pk.y }).assertValidity();
    this.address = evmAddressOfPoint(pk);
  }

  /** A grantee for `wallet` of the account `issuingAccount` on `network` (the
   *  grantee blind request signed twice), known to the owner by `label`
   *  and `slot`. */
  static async enrol(wallet: EvmWallet, network: string, issuingAccount: Uint8Array, label: Uint8Array, slot: bigint): Promise<EvmK256Grantee> {
    const e = await enrolEvmGranteeBlind(wallet, network, issuingAccount);
    return new EvmK256Grantee(e.pk, e.blind, label, slot, wallet, evmK256GrantReadSeed(e.canonical), { network, issuingAccount: new Uint8Array(issuingAccount) });
  }

  /** The grantee record to persist (one per issuing account), with the
   *  blind cached and never the read seed; only a grantee whose issuing
   *  account is known (enrolled or restored) has one. */
  toRecord(): EvmK256GranteeRecord {
    if (!this.issuer) throw new Error('evm_k256: only a grantee enrolled or restored from its wallet or record has a record');
    return {
      scheme: 'evm_k256', role: 'grantee', format: this.format, network: this.issuer.network, issuingAccount: hex(this.issuer.issuingAccount),
      address: evmChecksumAddress(this.address),
      pk: { x: this.pk.x.toString(16).padStart(64, '0'), y: this.pk.y.toString(16).padStart(64, '0') },
      blind: hex(this.blind),
    };
  }

  /** The grantee of one grant (`label`, `slot`) from its record and its
   *  cached blind, with no read seed in memory (readKeyFromWallet derives
   *  it). Refuses a record of another arm, role or format, one whose address
   *  is not its point's, one that carries a read seed, and one without the
   *  cache (restoreEvmK256Grantee derives it again from the wallet). */
  static fromRecord(rec: EvmK256GranteeRecord, label: Uint8Array, slot: bigint, wallet?: EvmWallet): EvmK256Grantee {
    const r = parseGranteeRecord(rec);
    if (r.blind === undefined) throw new Error('evm_k256: the record holds no cached blind; restore the grantee from its wallet (restoreEvmK256Grantee)');
    return new EvmK256Grantee(r.pk, r.blind, label, slot, wallet, undefined, { network: r.network, issuingAccount: r.issuingAccount });
  }

  /** Whether the session holds the read seed (no signature is needed to
   *  read). */
  get hasReadSeed(): boolean { return this.session.readSeed !== undefined; }

  /** This grant's read key on `account` (its `read_pk` goes into the grant
   *  request), from the session's read seed; refused when the session holds
   *  none (readKeyFromWallet derives it). */
  readKey(account: Uint8Array): EvmK256ReadKey {
    const seed = this.session.readSeed;
    if (!seed) throw new Error('evm_k256: this grantee has no read seed in memory (derive it from its wallet with readKeyFromWallet)');
    return evmK256GrantReadKey(seed, account, this.label, this.slot);
  }

  /**
   * This grant's read key on `account`, deriving the read seed first when
   * the session holds none: the wallet signs the grantee request once; the
   * signature must come from this grantee's address (the signer check) and
   * its canonical form must give this grantee's blind, so it is the
   * signature the blind was derived from (a non-deterministic wallet is
   * refused, as by the sign-twice check). While the session holds the seed,
   * no signature is asked.
   */
  async readKeyFromWallet(account: Uint8Array): Promise<EvmK256ReadKey> {
    if (!this.session.readSeed) {
      const s = this.session;
      s.deriving ??= this.deriveReadSeed().finally(() => { s.deriving = undefined; });
      s.readSeed = await s.deriving;
    }
    return this.readKey(account);
  }

  private async deriveReadSeed(): Promise<Uint8Array> {
    if (!this.wallet) throw new Error('evm_k256: this grantee has no wallet');
    if (!this.issuer) throw new Error('evm_k256: this grantee\'s issuing account is not known, so its request cannot be built');
    const message = granteeBlindMessageBytes({ scheme: 'evm_k256', network: this.issuer.network, identity: this.address, issuingAccount: this.issuer.issuingAccount });
    const others = [await this.wallet.address(), ...(await otherAddresses(this.wallet))];
    const signature = await this.wallet.personalSign(message);
    checkEvmK256Signer(this.address, personalMessageDigest(message), signature, others);
    const canonical = canonicalEvmSignature(signature);
    if (!eq(deriveBlind('evm_k256', canonical), this.blind)) {
      throw new Error('blind: the wallet signed the grantee privacy-key request with another signature than the one this grant\'s blind was derived from (not deterministic); its read key cannot be derived');
    }
    return evmK256GrantReadSeed(canonical);
  }

  /** The same grantee under another site label or slot (another grant of the
   *  same issuing account), keeping its wallet and sharing its session's
   *  read seed. */
  withGrant(label: Uint8Array, slot: bigint): EvmK256Grantee {
    const g = new EvmK256Grantee(this.pk, this.blind, label, slot, this.wallet, undefined, this.issuer);
    g.session = this.session;
    return g;
  }

  /** origin_hash of the site label (what the grant id binds). */
  get originHash(): Uint8Array { return grantOriginHash(this.label); }

  grantId(contractAddress: Uint8Array): Uint8Array {
    return pureCircuits.derive_grant_id_with_evm_k256({ bytes: contractAddress }, this.address, this.blind, this.originHash, this.slot);
  }

  /** This grantee as the owner shows it (IssueGrant, RevokeGrant). */
  descriptor(): EvmK256GranteeInput {
    return evmK256GranteeInput({ scheme: 'evm_k256', address: this.address, blind: this.blind }, { label: this.label }, this.slot);
  }

  /** Signs `typedData` with the grantee's wallet, with the device's checks:
   *  typed data under another domain than V1 is refused before the wallet
   *  is asked, and a signature that does not recover to this grantee's
   *  address before any proof. */
  async authorise(typedData: Eip712TypedData): Promise<EvmK256GrantAuthorisation> {
    if (!this.wallet) throw new Error('evm_k256: this grantee has no wallet');
    checkEip712V1TypedData(typedData);
    const others = await otherAddresses(this.wallet);
    const digest = typedDataDigest(typedData);
    const sig = checkEvmK256Signer(this.address, digest, await this.wallet.signTypedData(typedData), others);
    const m = typedData.message as { issuedAt: string; grantNonce: string };
    const hint = evmK256GrantSeamHint(this.pk, digest, this.label, BigInt(m.issuedAt), BigInt(m.grantNonce));
    return { arm: 'evm_k256', pk: this.pk, blind: this.blind, label: this.label, sig: { r: sig.r, s: sig.s }, hint };
  }
}

/** The grantee record a client persists per issuing account, in its local
 *  storage: the grantee blind is one per wallet, network and issuing
 *  account, whatever the grant's site label and slot. */
export interface EvmK256GranteeRecord {
  scheme: 'evm_k256';
  role: 'grantee';
  /** The format the grantee blind was derived in (the arm's one format). */
  format: string;
  network: string;
  /** The issuing account's 32-byte contract address, hex. */
  issuingAccount: string;
  /** EIP-55 checksummed address. */
  address: string;
  /** The recovered public point, big-endian hex coordinates. */
  pk: { x: string; y: string };
  /** The cached grantee blind, hex. A secret (it links this wallet to its
   *  grants from the account): it stays in the client's local storage and
   *  is never sent. Absent once the cache is lost: restoreEvmK256Grantee
   *  derives it again from the wallet. The record never holds the read
   *  seed, which opens the grants' records: it is kept in memory only. */
  blind?: string;
}

/** A grantee record, checked: its parts and, when cached, its blind. A
 *  record that carries a read seed is refused: the seed is never stored. */
function parseGranteeRecord(rec: EvmK256GranteeRecord) {
  const common = recordCommon(rec);
  if (rec.role !== 'grantee') throw new Error('evm_k256: not a grantee record');
  if (Object.prototype.hasOwnProperty.call(rec, 'readSeed')) throw new Error('evm_k256: a grantee record never holds the read seed');
  if (typeof rec.issuingAccount !== 'string' || !HEX64.test(rec.issuingAccount)) throw new Error('evm_k256: a record\'s issuing account is 32 bytes of lower-case hex');
  return { ...common, issuingAccount: unhex(rec.issuingAccount), blind: recordSecret(rec.blind, 'blind') };
}

/** What a grantee restore starts from, for the grant `label`, `slot`: the
 *  stored record, or, without one, the network and the issuing account.
 *  `finds` is the caller's test of a candidate grantee (for example that the
 *  issuing account holds a grant record under its grant id); it is needed
 *  for every blind derived again (a record without its cached blind, or no
 *  record), and never asked for a cached blind. */
export type EvmK256GranteeRestoreRequest = { wallet: EvmWallet; label: Uint8Array; slot: bigint } & (
  | { record: EvmK256GranteeRecord; finds?: (grantee: EvmK256Grantee) => boolean | Promise<boolean> }
  | { network: string; issuingAccount: Uint8Array; finds: (grantee: EvmK256Grantee) => boolean | Promise<boolean> });

/** Restores a grantee through blind.ts restoreBlind, as restoreEvmK256Device
 *  restores a device, from the grantee request of its issuing account;
 *  without a match, the message says no grant was found and that the
 *  issuing account's owner can issue a new grant to this wallet. A grantee
 *  restored from its cached blind holds no read seed (its first read asks
 *  one signature, readKeyFromWallet); one whose blind was derived again
 *  holds the seed of that signature for the session. */
export async function restoreEvmK256Grantee(req: EvmK256GranteeRestoreRequest): Promise<EvmK256Restore<EvmK256Grantee>> {
  const { wallet, label, slot } = req;
  const rec = 'record' in req && req.record !== undefined ? parseGranteeRecord(req.record) : undefined;
  const hasFinds = 'finds' in req && typeof req.finds === 'function';
  if (rec === undefined && !hasFinds) {
    throw new Error('evm_k256: a restore without a stored record needs the network, the issuing account and finds');
  }
  if (rec !== undefined && rec.blind === undefined && !hasFinds) {
    throw new Error('evm_k256: a restore of a record without its cached blind needs finds (the blind derived again is checked against the grant)');
  }
  const reported = await wallet.address();
  const network = rec ? rec.network : (req as { network: string }).network;
  const issuingAccount = rec ? rec.issuingAccount : new Uint8Array((req as { issuingAccount: Uint8Array }).issuingAccount);
  const address = rec ? rec.address : reported;
  if (address.length !== 20) throw new Error('blind: the wallet address is 20 bytes');
  const issuer = { network, issuingAccount };
  let pk: Secp256k1Point | undefined;
  let readSeed: Uint8Array | undefined;
  const r = await restoreBlind({
    scheme: 'evm_k256', role: 'grantee',
    stored: rec ? { format: rec.format, blind: rec.blind } : undefined,
    walletFormats: evmK256WalletFormats(),
    derive: async (format) => {
      if (format !== EVM_K256_FORMAT) throw new Error(`evm_k256: no blind request in the format ${format}`);
      const e = await enrolWithRequest(wallet, address, granteeBlindMessageBytes({ scheme: 'evm_k256', network, identity: address, issuingAccount }), [reported]);
      pk = e.pk;
      readSeed = evmK256GrantReadSeed(e.canonical);
      return e.blind;
    },
    finds: async (blind) => (await (req as { finds: (g: EvmK256Grantee) => boolean | Promise<boolean> }).finds(new EvmK256Grantee(pk!, blind, label, slot, wallet, readSeed, issuer))) === true,
  });
  if (r.ok === false) return { ok: false, reason: r.reason, message: r.message };
  return { ok: true, source: r.source, value: new EvmK256Grantee(rec ? rec.pk : pk!, r.matches[0].blind, label, slot, wallet, readSeed, issuer) };
}

/** The surface the grant calls use (CustodyAccount). */
export interface EvmK256GrantSurface extends EvmK256LifecycleSurface {
  heldCoin(color: Uint8Array): Promise<{ nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint }>;
  encKey(): Promise<Uint8Array>;
  grantRecord(grantId: Uint8Array): Promise<{ issued_at: bigint; nonce: bigint } | null>;
  withdrawUnshieldedWithGrantAuth(color: Uint8Array, amount: bigint, recipient: Uint8Array, opening: GrantOpening, a: EvmK256GrantAuthorisation): Promise<{ txId: string }>;
  withdrawShieldedWithGrantAuth(recipient: Uint8Array, color: Uint8Array, amount: bigint, changeEntry: Uint8Array, encPk: Uint8Array, opening: GrantOpening, a: EvmK256GrantAuthorisation): Promise<{ txId: string; change: unknown }>;
  withdrawShieldedToContractWithGrantAuth(recipient: Uint8Array, color: Uint8Array, amount: bigint, changeEntry: Uint8Array, encPk: Uint8Array, opening: GrantOpening, a: EvmK256GrantAuthorisation): Promise<{ txId: string; sent: unknown; change: unknown }>;
}


/** A grantee input built elsewhere (not by
 *  `evmK256GranteeInput`) is re-checked before any wallet signs: its tag
 *  must be a registered grant-id tag, and the descriptor it encodes must pass
 *  the strict client decoders (`checkDescriptor`: points on their curves and
 *  in their subgroups, a valid Ed25519 encoding, address and blind lengths).
 *  Returns the input unchanged. */
export function checkEvmK256GranteeInput(g: EvmK256GranteeInput): EvmK256GranteeInput {
  const k = g.tag instanceof Uint8Array ? evmK256KindOf('grant-id', g.tag) : undefined;
  if (!k) throw new Error('descriptor: not a registered grant-id tag');
  const form = PAYLOAD_INPUTS[k.payload];
  const d = form.descriptorOf(k.scheme, g);
  checkDescriptor(d);
  form.checkSite?.(d, g);
  return g;
}

/** The circuit arguments of issue_grant_with_evm_k256 after the grantee
 *  (the scope, the read key itself, the caller pin). The grant's scope salt
 *  is no argument: the circuit derives it (evmK256GrantScopeSalt). */
export function evmK256IssueArgs(scope: IssueScope): unknown[] {
  const caller = scope.caller
    ? { is_some: true, value: { bytes: new Uint8Array(scope.caller) } }
    : { is_some: false, value: { bytes: new Uint8Array(32) } };
  return [scope.opWithdrawUnshielded, scope.opWithdrawShielded, scope.opWithdrawShieldedToContract, scope.read,
    scope.color, scope.recipientKind, scope.recipient, scope.maxCoinValue, scope.perCallCap, scope.cap, scope.expiresAt,
    scope.rpIdHash, scope.read ? scope.readPk : new Uint8Array(32), scope.windowLen, scope.windowCap, caller];
}

/** The scope salt issue_grant_with_evm_k256 derives for a grant: from the
 *  issuing device's blind, the account and the auth_nonce of the issuing
 *  call (the frame's authNonce), under the arm's salt tag, through the
 *  account's own pure circuit. The issuer hands it to the grantee, which
 *  opens the grant's commitments with it when it spends. */
export function evmK256GrantScopeSalt(blind: Uint8Array, account: Uint8Array, authNonce: bigint): Uint8Array {
  if (blind.length !== 32 || account.length !== 32) throw new Error('evm_k256: the blind and the account are 32 bytes each');
  return pureCircuits.derive_grant_scope_salt(pureCircuits.salt_tag_evm_k256(), blind, { bytes: account }, authNonce);
}

/** issue_grant_with_evm_k256: the IssueGrant message ("Lets this key use
 *  this account within the limits below", the grantee, every scope field),
 *  signed by the device's wallet, then the call. The record stores
 *  SHA-256(read key) as read_pk_hash. Returns the grant's scope salt, which
 *  the circuit derives and the grantee needs to spend. */
export async function issueGrantWithEvmK256(
  account: EvmK256LifecycleSurface, device: EvmK256Device, grantee: EvmK256GranteeInput, scope: IssueScope,
  opts: EvmK256CounterOptions = {},
) {
  checkEvmK256GranteeInput(grantee);
  const { frame, counter } = await deviceFrame(account, device, opts);
  const typedData = evmK256Messages.issueGrant(frame, grantee, scope);
  const auth = await device.authorise(typedData, counter);
  const scopeSalt = evmK256GrantScopeSalt(device.blind, frame.account, frame.authNonce);
  const r = await account.callTx.issue_grant_with_evm_k256(grantee, ...ed25519Args(grantee), ...evmK256IssueArgs(scope), authArg(auth),
    evmK256IssueHint(grantee, scope));
  return { typedData, auth, scopeSalt, txId: txIdOf(r) };
}

/** revoke_grant_with_evm_k256: the grantee shown by its descriptor; the
 *  circuit re-derives the grant id. */
export async function revokeGrantWithEvmK256(account: EvmK256LifecycleSurface, device: EvmK256Device, grantee: EvmK256GranteeInput, opts: EvmK256CounterOptions = {}) {
  checkEvmK256GranteeInput(grantee);
  const { frame, counter } = await deviceFrame(account, device, opts);
  const typedData = evmK256Messages.revokeGrant(frame, grantee);
  const auth = await device.authorise(typedData, counter);
  const r = await account.callTx.revoke_grant_with_evm_k256(grantee, ...ed25519Args(grantee), authArg(auth), evmK256GranteeHint(grantee));
  return { typedData, auth, txId: txIdOf(r) };
}

/** revoke_all_grants_with_evm_k256. */
export async function revokeAllGrantsWithEvmK256(account: EvmK256LifecycleSurface, device: EvmK256Device, opts: EvmK256CounterOptions = {}) {
  const { frame, counter } = await deviceFrame(account, device, opts);
  const typedData = evmK256Messages.revokeAllGrants(frame);
  const auth = await device.authorise(typedData, counter);
  const r = await account.callTx.revoke_all_grants_with_evm_k256(authArg(auth));
  return { typedData, auth, txId: txIdOf(r) };
}

// ── Recovery ───────────────────────────────────────────────────────────
//
// The two device-gated recovery operations. The recovery gate itself
// (recover_submit) and finalisation are arm-independent and stay on
// CustodyAccount (recoverSubmit, recoverFinalise).

/** One recovery session's artefact set (recovery MIP section 5), as the
 *  client's own guardian ceremony produced it (a client obligation):
 *  P = s·G for the session's fresh secret, a fresh 32-byte session
 *  identifier, 1..4 public phi values, and the 64-byte wrap. */
export interface EvmK256RecoveryArtefacts {
  recoveryPk: { x: bigint; y: bigint };
  sessionNonce: Uint8Array;
  phi: bigint[];
  wrap: Uint8Array;
}

/** The circuit's operands of a session: the phi slots (unused ones zero) and
 *  the length field. Refuses what the chip would refuse, before any wallet
 *  signature (as upstream's publishRecoverySession does). */
export function evmK256RecoverySession(a: EvmK256RecoveryArtefacts) {
  if (a.phi.length < 1 || a.phi.length > 4) throw new Error(`evm_k256: phi carries ${a.phi.length} entries; the slot bound admits 1..4`);
  if (a.sessionNonce.length !== 32 || a.sessionNonce.every((b) => b === 0)) {
    throw new Error('evm_k256: a session identifier is 32 non-zero bytes (REC-4)');
  }
  if (a.wrap.length !== 64) throw new Error('evm_k256: the recovery wrap is 64 bytes');
  const slots: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
  a.phi.forEach((p, i) => { slots[i] = p; });
  return { recoveryPk: a.recoveryPk, sessionNonce: new Uint8Array(a.sessionNonce), phi: slots, phiLen: BigInt(a.phi.length), wrap: new Uint8Array(a.wrap) };
}

/** publish_recovery_session_with_evm_k256: the PublishRecoverySession
 *  message ("Sets this account's recovery key", the new recovery key, the
 *  session identifier, the four phi values, the length and the 64-byte wrap,
 *  all in full), signed by the device's wallet, then the call. */
export async function publishRecoverySessionWithEvmK256(account: EvmK256LifecycleSurface, device: EvmK256Device, artefacts: EvmK256RecoveryArtefacts, opts: EvmK256CounterOptions = {}) {
  const session = evmK256RecoverySession(artefacts);
  const { frame, counter } = await deviceFrame(account, device, opts);
  const typedData = evmK256Messages.publishRecoverySession(frame, session);
  const auth = await device.authorise(typedData, counter);
  const r = await account.callTx.publish_recovery_session_with_evm_k256(
    session.recoveryPk, session.sessionNonce, ...session.phi, session.phiLen, session.wrap, authArg(auth));
  return { typedData, auth, txId: txIdOf(r) };
}

/** recover_cancel_with_evm_k256: the CancelRecovery message (the frame
 *  alone: account, device, authNonce), signed, then the call; vetoes the
 *  pending recovery. */
export async function recoverCancelWithEvmK256(account: EvmK256LifecycleSurface, device: EvmK256Device, opts: EvmK256CounterOptions = {}) {
  const { frame, counter } = await deviceFrame(account, device, opts);
  const typedData = evmK256Messages.cancelRecovery(frame);
  const auth = await device.authorise(typedData, counter);
  const r = await account.callTx.recover_cancel_with_evm_k256(authArg(auth));
  return { typedData, auth, txId: txIdOf(r) };
}

/** The grantee frame of the next call under the grantee's grant. */
async function granteeFrame(account: EvmK256GrantSurface, g: EvmK256Grantee) {
  const rec = await account.grantRecord(g.grantId(account.addressBytes));
  if (!rec) throw new Error('evm_k256: no grant record for this grantee (not issued, or revoked by revoke_all)');
  return { account: account.addressBytes, grantee: g.address, label: g.label, slot: g.slot, issuedAt: rec.issued_at, grantNonce: rec.nonce };
}

const openingFor = (g: EvmK256Grantee, o: Omit<GrantOpening, 'originHash' | 'slot'>): GrantOpening => ({ ...o, originHash: g.originHash, slot: g.slot });

/** withdraw_unshielded_with_grant_evm_k256, signed by the grantee. */
export async function withdrawUnshieldedAsEvmGrantee(
  account: EvmK256GrantSurface, g: EvmK256Grantee, opening: Omit<GrantOpening, 'originHash' | 'slot'>,
  color: Uint8Array, amount: bigint, recipient: Uint8Array, site: SiteAmount,
) {
  const frame = await granteeFrame(account, g);
  const typedData = evmK256Messages.withdrawUnshieldedAsGrantee(frame, color, amount, recipient, site);
  const auth = { ...(await g.authorise(typedData)), op: evmK256AmountHint(amount, site) };
  return { typedData, auth, ...(await account.withdrawUnshieldedWithGrantAuth(color, amount, recipient, openingFor(g, opening), auth)) };
}

async function grantCoin(account: EvmK256GrantSurface, color: Uint8Array): Promise<SpentCoin> {
  const c = await account.heldCoin(color);
  if (!eq(c.color, color)) throw new Error('evm_k256: the held coin is not of the withdrawn colour');
  return { nonce: c.nonce, value: c.value, mtIndex: c.mt_index };
}

/** withdraw_shielded_with_grant_evm_k256, signed by the grantee: the change
 *  entry the grantee sealed to the account's live enc_key is shown with it. */
export async function withdrawShieldedAsEvmGrantee(
  account: EvmK256GrantSurface, g: EvmK256Grantee, opening: Omit<GrantOpening, 'originHash' | 'slot'>,
  recipient: Uint8Array, color: Uint8Array, amount: bigint, changeEntry: Uint8Array, site: SiteAmount, encPk?: Uint8Array,
) {
  const frame = await granteeFrame(account, g);
  const enc = encPk ?? await account.encKey();
  const coin = await grantCoin(account, color);
  const typedData = evmK256Messages.withdrawShieldedAsGrantee(frame, color, amount, recipient, changeEntry, enc, coin, site);
  const auth = { ...(await g.authorise(typedData)), op: evmK256CoinHint(amount, coin.value, coin.mtIndex, site) };
  return { typedData, auth, coin, ...(await account.withdrawShieldedWithGrantAuth(recipient, color, amount, changeEntry, enc, openingFor(g, opening), auth)) };
}

/** withdraw_shielded_to_contract_with_grant_evm_k256: typed data and
 *  authorisation (a direct transfer is composed with the recipient's claim). */
export async function authoriseWithdrawShieldedToContractAsEvmGrantee(
  account: EvmK256GrantSurface, g: EvmK256Grantee, recipientContract: Uint8Array, color: Uint8Array, amount: bigint,
  changeEntry: Uint8Array, site: SiteAmount, encPk?: Uint8Array,
) {
  const frame = await granteeFrame(account, g);
  const enc = encPk ?? await account.encKey();
  const coin = await grantCoin(account, color);
  const typedData = evmK256Messages.withdrawShieldedToContractAsGrantee(frame, color, amount, recipientContract, changeEntry, enc, coin, site);
  return { typedData, coin, encPk: enc, auth: { ...(await g.authorise(typedData)), op: evmK256CoinHint(amount, coin.value, coin.mtIndex, site) } };
}
