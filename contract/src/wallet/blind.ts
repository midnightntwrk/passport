// The blind of a readable device or grantee — the request messages, the
// canonical signature forms, the restore over the arm's formats, and the
// signer check.
//
// A readable arm's device entries and grant ids bind a per-account secret,
// the BLIND, so that a public wallet identity (an Ethereum address, a Solana
// key: the identity of the arm's READABLE_ARMS entry) never appears in
// ledger state in a form anyone can test:
//
//   blind = SHA-256(pad32(blind tag) || canonical signature)
//
// The signature is the wallet's own, over a readable request message built
// here. The wallet signs deterministically (RFC 6979 ECDSA, RFC 8032 Ed25519),
// so the blind can be derived again from the wallet alone. There are two
// requests, signed under the same blind tag; they differ from their first
// line on, so a wallet's two kinds of blind are never equal.
//
// The DEVICE request (blindMessage) gives the blind of a device of the
// wallet's own Passport account. A restored client derives blind_0, blind_1,
// ... for account indexes 0, 1, ... and finds its accounts by testing
// entries. The message:
//
//   - names Midnight Passport, the network, the wallet identity, and the
//     account index, so that one signature reveals one account's blind on one
//     network only;
//   - never contains the account address (it does not exist before deploy);
//   - says what the signature reveals and that it authorises nothing. No
//     circuit accepts it: an arm's authorisation messages have their own,
//     different first line (and on EVM another signing envelope).
//
// The GRANTEE request (granteeBlindMessage) gives the blind of the wallet as
// a grantee of another Passport account, the issuing account. The issuer must
// know a grantee's blind: it derives the grant id and is shown in the
// issuer's IssueGrant and RevokeGrant approvals. A grantee therefore never
// uses a device blind, which would let the issuer find the wallet's own
// account and recognise every call it makes there. The message:
//
//   - names Midnight Passport, the role "grantee", the network, the wallet
//     identity, and the issuing account's full 32-byte address (it exists at
//     grant time), so that each issuing account gets its own blind, and no
//     issuer learns a blind another issuer holds;
//   - has no account index: a restored client derives the grantee blind
//     again from the wallet and the issuing account's address;
//   - says that the issuing account's owner learns it, what it reveals, and
//     that it authorises nothing.
//
// The canonical forms make the blind independent of signature malleability.
// Each arm's entry names its wallet's signature scheme, which picks the form:
// secp256k1 ECDSA signatures (EVM) are reduced to low-S r || s (big-endian,
// 32 bytes each, the recovery byte dropped); Ed25519 signatures are the raw
// 64-byte R || S, with S below the group order and R a canonical point
// encoding. Enrolment signs twice and refuses the wallet unless both
// canonical forms are equal (sameCanonicalSignature): a non-deterministic
// wallet would lose its accounts on restore.
//
// FORMATS. A readable arm's wallets sign in one or more formats (the entry's
// `formats`), and a wallet signs the blind request in its device's format, so
// the blind depends on the format: a device is usable only with the blind of
// the format it was enrolled in, and a wallet that cannot sign that format
// cannot derive that blind again. The client therefore stores per device (and
// per grant a wallet holds) its arm, its format and its account index, which
// are not secret, and caches the blind with them in its local storage; the
// blind never leaves the client. restoreBlind is the one rule for finding the
// blind again: the cache, else the stored format, else every format the
// wallet can sign, and never a format the wallet cannot sign. A blind derived
// again is used only once it finds the device (or the grant): a deterministic
// signature depends on the wallet's nonce rule as well as on the key and the
// bytes, so another wallet holding the same key can derive another blind from
// the same request.
//
// THE SIGNER CHECK. A wallet may answer with another key than the one asked
// for (two installed extensions, a switched account), and the key a wallet
// reports is not evidence of who signed. Every signature is therefore checked
// against the key it must come from before it is used (checkSigner), and a
// refusal names another key only when the signature verifies under it.

import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  READABLE_SCHEMES, padTag, readableArm, unknownScheme,
  type ReadableArm, type ReadableScheme, type ReadableSignature,
} from './descriptors.js';

/** The readable schemes, which have a blind: one per READABLE_ARMS entry. */
export type BlindScheme = ReadableScheme;
export const BLIND_SCHEMES: readonly BlindScheme[] = READABLE_SCHEMES;
const unknownBlindScheme = (scheme: never, where: string): never => unknownScheme(scheme, where, BLIND_SCHEMES, 'blind');

/** The registry entry of a blind scheme; any other value (an unregistered
 *  scheme, one without a blind, none) is refused, never looked up as
 *  undefined. */
function blindArm(scheme: BlindScheme, where: string): ReadableArm {
  return readableArm(scheme) ?? unknownBlindScheme(scheme as never, where);
}

/** The device request message's format version, named on its first line. */
export const BLIND_MESSAGE_VERSION = 1;

/** Network names: lower-case letters, digits, and hyphens (for example
 *  "undeployed", "preview", "preprod", "mainnet"). */
const NETWORK = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_ACCOUNT_INDEX = 0xffffffffn;

export interface BlindRequest {
  scheme: BlindScheme;
  /** The network the account lives on, by its Midnight network name. */
  network: string;
  /** The wallet identity, as the arm's entry defines it: a w52 arm's 20-byte
   *  address (the Ethereum address), or an ed25519 arm's 32-byte public key. */
  identity: Uint8Array;
  /** 0 for the wallet's first Passport account on this network, then 1, 2, ... */
  accountIndex: bigint | number;
}

function checkNetwork(network: string): void {
  if (!NETWORK.test(network)) throw new Error('blind: the network name is lower-case letters, digits, and hyphens');
}

/** The wallet line's value, by the arm's entry (for example the EIP-55
 *  address, or the base58 Solana key). */
function walletText(scheme: BlindScheme, identity: Uint8Array): string {
  return blindArm(scheme, 'the blind request').identity.walletText(identity);
}

/** The blind tag text of a readable scheme; any other scheme is refused. */
function blindTagText(scheme: BlindScheme, where: string): string {
  return blindArm(scheme, where).tags.blind;
}

/** The DEVICE request message (ASCII, lines separated by LF, no trailing
 *  newline). Deterministic: equal requests give equal bytes. A grantee never
 *  signs it: see granteeBlindMessage. */
export function blindMessage(req: BlindRequest): string {
  checkNetwork(req.network);
  if (typeof req.accountIndex === 'number' && !Number.isSafeInteger(req.accountIndex)) throw new Error('blind: the account index is an integer');
  const index = BigInt(req.accountIndex);
  if (index < 0n || index > MAX_ACCOUNT_INDEX) throw new Error('blind: the account index is 0 to 4294967295');
  const wallet = walletText(req.scheme, req.identity);
  return [
    `Midnight Passport account privacy key (v${BLIND_MESSAGE_VERSION})`,
    `Network: ${req.network}`,
    `Wallet: ${wallet}`,
    `Account index: ${index}`,
    'Warning: this signature reveals the privacy key of this Passport account.',
    'Anyone who obtains it can link this wallet to that account.',
    'Sign it only in a Midnight Passport client you trust.',
    'It authorises nothing: no transfer, no new device, no grant.',
  ].join('\n');
}

/** The message's bytes (ASCII). */
export function blindMessageBytes(req: BlindRequest): Uint8Array {
  return new TextEncoder().encode(blindMessage(req));
}

/** The grantee request's format version, named on its first line. */
export const GRANTEE_BLIND_MESSAGE_VERSION = 1;

export interface GranteeBlindRequest {
  scheme: BlindScheme;
  /** The network the issuing account lives on, by its Midnight network name. */
  network: string;
  /** The grantee wallet's identity, as the arm's entry defines it (see
   *  BlindRequest.identity). */
  identity: Uint8Array;
  /** The issuing account: the 32-byte contract address of the Passport
   *  account that issues the grant (the address its grant ids bind). */
  issuingAccount: Uint8Array;
}

/** The GRANTEE request message (ASCII, lines separated by LF, no trailing
 *  newline): the readable, non-authorising request whose signature gives the
 *  wallet's blind as a grantee of `issuingAccount`. Signed under the same
 *  blind tag as the device request (the same deriveBlind). Its first two
 *  lines differ from the device request's, so a grantee blind is never a
 *  device blind; the issuing account's address makes it one blind per issuer.
 *  Deterministic: equal requests give equal bytes. */
export function granteeBlindMessage(req: GranteeBlindRequest): string {
  checkNetwork(req.network);
  if (!(req.issuingAccount instanceof Uint8Array) || req.issuingAccount.length !== 32) throw new Error('blind: the issuing account address is 32 bytes');
  if (req.issuingAccount.every((b) => b === 0)) throw new Error('blind: the issuing account address is not zero');
  const wallet = walletText(req.scheme, req.identity);
  const account = Array.from(req.issuingAccount, (x) => x.toString(16).padStart(2, '0')).join('');
  return [
    `Midnight Passport grantee privacy key (v${GRANTEE_BLIND_MESSAGE_VERSION})`,
    'Role: grantee',
    `Network: ${req.network}`,
    `Wallet: ${wallet}`,
    `Issuing account: ${account}`,
    'Warning: this signature reveals this wallet\'s privacy key for grants from that account.',
    'The owner of that account learns it when issuing a grant to this wallet.',
    'Anyone who obtains it can link this wallet to its grants from that account.',
    'It is not the privacy key of any Passport account this wallet controls.',
    'Sign it only in a Midnight Passport client you trust.',
    'It authorises nothing: no transfer, no new device, no grant.',
  ].join('\n');
}

/** The grantee message's bytes (ASCII). */
export function granteeBlindMessageBytes(req: GranteeBlindRequest): Uint8Array {
  return new TextEncoder().encode(granteeBlindMessage(req));
}

const N_K1 = secp256k1.Point.Fn.ORDER;
const L_ED = ed25519.Point.Fn.ORDER;
const be32 = (v: bigint): Uint8Array => { const o = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const bigBE = (b: Uint8Array): bigint => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };
const bigLE = (b: Uint8Array): bigint => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };

/** An EVM signature (64-byte r || s, or 65-byte r || s || v as wallets return
 *  it) in canonical form: low-S r || s, 64 bytes. Refuses r or s outside
 *  [1, n) and a malformed recovery byte. */
export function canonicalEvmSignature(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64 && sig.length !== 65) throw new Error('blind: an EVM signature is 64 or 65 bytes');
  if (sig.length === 65 && ![0, 1, 27, 28].includes(sig[64])) throw new Error('blind: invalid EVM recovery byte');
  const r = bigBE(sig.subarray(0, 32));
  let s = bigBE(sig.subarray(32, 64));
  if (r === 0n || r >= N_K1 || s === 0n || s >= N_K1) throw new Error('blind: EVM signature scalar outside [1, n)');
  if (s > N_K1 / 2n) s = N_K1 - s;
  return new Uint8Array([...be32(r), ...be32(s)]);
}

/** An Ed25519 signature in canonical form: the raw 64-byte R || S, refused
 *  unless S < L and R is a canonical point encoding. */
export function canonicalEd25519Signature(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) throw new Error('blind: an Ed25519 signature is 64 bytes');
  if (bigLE(sig.subarray(32)) >= L_ED) throw new Error('blind: Ed25519 S is not below the group order');
  try {
    const R = ed25519.Point.fromBytes(sig.subarray(0, 32), false);
    if (!R.toBytes().every((b, i) => b === sig[i])) throw new Error('non-canonical');
  } catch (e: any) {
    throw new Error(`blind: Ed25519 R is not a canonical point encoding (${e?.message ?? e})`);
  }
  return new Uint8Array(sig);
}

/** The canonical form of each signature scheme a readable arm's wallet uses. */
const CANONICAL_FORMS: Readonly<Record<ReadableSignature, (sig: Uint8Array) => Uint8Array>> = {
  'secp256k1-ecdsa': canonicalEvmSignature,
  ed25519: canonicalEd25519Signature,
};

/** The canonical form for a scheme (its arm's signature scheme); any other
 *  scheme is refused. */
export function canonicalSignature(scheme: BlindScheme, sig: Uint8Array): Uint8Array {
  return CANONICAL_FORMS[blindArm(scheme, 'canonicalSignature').signature](sig);
}

/** The sign-twice check: true only when both signatures have the same
 *  canonical form. Enrolment refuses the wallet otherwise. */
export function sameCanonicalSignature(scheme: BlindScheme, first: Uint8Array, second: Uint8Array): boolean {
  const a = canonicalSignature(scheme, first), b = canonicalSignature(scheme, second);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** blind = SHA-256(pad32(blind tag) || canonical signature): the module's
 *  derive_blind, computed without the contract (it is needed before an
 *  account exists). */
export function deriveBlind(scheme: BlindScheme, canonical: Uint8Array): Uint8Array {
  const tag = blindTagText(scheme, 'deriveBlind');
  if (canonical.length !== 64) throw new Error('blind: a canonical signature is 64 bytes');
  return sha256(new Uint8Array([...padTag(tag), ...canonical]));
}

/** The same derivation as a call of the module's pure circuit `derive_blind`. */
export function blindCall(scheme: BlindScheme, canonical: Uint8Array): { circuit: string; args: unknown[] } {
  const tag = blindTagText(scheme, 'blindCall');
  if (canonical.length !== 64) throw new Error('blind: a canonical signature is 64 bytes');
  return { circuit: 'derive_blind', args: [padTag(tag), canonical] };
}

// ── Formats and restore ─────────────────────────────────────────────────────

/** The formats of a blind scheme, in its entry's order; any other scheme is
 *  refused. */
export function blindFormats(scheme: BlindScheme): readonly string[] {
  return Object.keys(blindArm(scheme, 'blindFormats').formats);
}

/** Refuses a value that is not one of the scheme's formats; returns it. */
export function checkBlindFormat(scheme: BlindScheme, format: unknown): string {
  const formats = blindArm(scheme, 'checkBlindFormat').formats;
  if (typeof format !== 'string' || !Object.prototype.hasOwnProperty.call(formats, format)) {
    const shown = typeof format === 'string' ? JSON.stringify(format.length > 40 ? `${format.slice(0, 40)}...` : format) : typeof format;
    throw new Error(`blind: ${scheme} has no format ${shown} (formats: ${Object.keys(formats).join(', ')})`);
  }
  return format;
}

/** The name the client shows for a format of a scheme. */
export function blindFormatName(scheme: BlindScheme, format: string): string {
  return blindArm(scheme, 'blindFormatName').formats[checkBlindFormat(scheme, format)];
}

/** What the client stores for a device, or for a grant its wallet holds: the
 *  format the blind was derived in and, while the cache survives, the blind. */
export interface StoredBlind {
  format: string;
  blind?: Uint8Array;
}

export interface BlindRestoreRequest {
  scheme: BlindScheme;
  /** 'device' for a device of the wallet's own account (the default),
   *  'grantee' for a grant the wallet holds from another account; it only
   *  changes the wording of a failure. */
  role?: 'device' | 'grantee';
  /** The stored record, when the client has one. */
  stored?: StoredBlind;
  /** The formats this wallet can sign, as the arm detects them. The restore
   *  never asks the wallet for any other format. */
  walletFormats: readonly string[];
  /** Asks the wallet to sign the blind request in `format` (twice, with the
   *  sign-twice check) and returns the blind. */
  derive: (format: string) => Promise<Uint8Array>;
  /** Whether a blind finds the device (or the grant): the caller tests the
   *  account's entries (or the grant id). Asked for every blind derived
   *  again, with a stored format or without one; never for a cached blind. */
  finds: (blind: Uint8Array, format: string) => Promise<boolean>;
}

export interface BlindMatch {
  format: string;
  blind: Uint8Array;
}

/** The result of restoreBlind. Narrow it with `ok === true` or `ok === false`
 *  (without strictNullChecks, `!r.ok` does not narrow a union). */
export type BlindRestore =
  /** `cache`: the stored blind, no signature asked; `stored-format`: derived
   *  in the stored format; `search`: every format the wallet can sign was
   *  tried, and each match is listed (one wallet may hold devices or grants
   *  in two formats). */
  | { ok: true; source: 'cache' | 'stored-format' | 'search'; matches: BlindMatch[] }
  /** `format-unavailable`: the stored format is one this wallet cannot sign;
   *  `not-found`: no format the wallet can sign finds the device (or grant);
   *  `no-format`: the wallet signs none of the arm's formats. */
  | { ok: false; reason: 'format-unavailable' | 'not-found' | 'no-format'; tried: string[]; untried: string[]; message: string };

const orList = (names: string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

function checkBlind(scheme: BlindScheme, blind: unknown, where: string): Uint8Array {
  if (!(blind instanceof Uint8Array) || blind.length !== 32) throw new Error(`blind: ${where} for ${scheme} is not 32 bytes`);
  return new Uint8Array(blind);
}

/**
 * Finds a device's (or a grant's) blind again, without ever deriving one in
 * a format other than the one it was enrolled in, and without asking the
 * wallet for a format it cannot sign:
 *   1. a cached blind is used as it is;
 *   2. with a stored format, the wallet derives the blind in that format, and
 *      it is a match only when it finds the device (or grant): a wallet whose
 *      deterministic signature differs from the enrolling wallet's derives
 *      another blind, and the message says so; when the wallet cannot sign
 *      that format, nothing is derived and the message names the format
 *      needed;
 *   3. without a stored record, the wallet derives the blind in every format
 *      it can sign, and each blind that finds the device (or grant) is a
 *      match; without a match, the message names the formats tried and those
 *      the device may have been enrolled through instead.
 * A failure's message also says what remains: another device of the account
 * or the account's recovery enrols this wallet as a new device (a grantee
 * asks for a new grant). The request is checked before anything is asked of
 * the wallet: an unknown scheme, role or format, a format listed twice, or a
 * cached blind that is not 32 bytes throws at once.
 */
export function restoreBlind(req: BlindRestoreRequest): Promise<BlindRestore> {
  const { scheme } = req;
  const all = [...blindFormats(scheme)];
  const role = req.role ?? 'device';
  if (role !== 'device' && role !== 'grantee') throw new Error(`blind: unknown role ${String(role)}`);
  if (!Array.isArray(req.walletFormats)) throw new Error('blind: walletFormats is a list of formats');
  const wallet = req.walletFormats.map((f) => checkBlindFormat(scheme, f));
  if (new Set(wallet).size !== wallet.length) throw new Error('blind: walletFormats lists a format twice');
  const stored = req.stored === undefined ? undefined : {
    format: checkBlindFormat(scheme, req.stored.format),
    blind: req.stored.blind === undefined ? undefined : checkBlind(scheme, req.stored.blind, 'the cached blind'),
  };
  return restoreChecked(req, scheme, all, wallet, role, stored);
}

async function restoreChecked(
  req: BlindRestoreRequest, scheme: BlindScheme, all: string[], wallet: string[],
  role: 'device' | 'grantee', stored: { format: string; blind?: Uint8Array } | undefined,
): Promise<BlindRestore> {
  const name = (f: string) => blindFormatName(scheme, f);
  const remedy = role === 'device'
    ? 'add this wallet as a new device from another device of the account, or through the account\'s recovery'
    : 'ask the issuing account\'s owner for a new grant to this wallet';
  const what = role === 'device' ? 'device' : 'grant';
  const Remedy = remedy[0].toUpperCase() + remedy.slice(1);

  if (stored !== undefined) {
    const { format } = stored;
    if (stored.blind !== undefined) return { ok: true, source: 'cache', matches: [{ format, blind: stored.blind }] };
    if (!wallet.includes(format)) {
      return {
        ok: false, reason: 'format-unavailable', tried: [], untried: [format],
        message: `This ${what}'s privacy key was derived in the ${name(format)} format, which this wallet cannot sign, so it cannot be derived again here. ` +
          `Use a wallet that signs the ${name(format)} format, or ${remedy}.`,
      };
    }
    const blind = checkBlind(scheme, await req.derive(format), 'the derived blind');
    if ((await req.finds(new Uint8Array(blind), format)) === true) return { ok: true, source: 'stored-format', matches: [{ format, blind }] };
    return {
      ok: false, reason: 'not-found', tried: [format], untried: [],
      message: `${role === 'device' ? 'No account was found' : 'No grant was found'} with the privacy key this wallet derives in the ${name(format)} format, ` +
        `the format this ${what} was ${role === 'device' ? 'enrolled' : 'issued'} through. A wallet that signs the request differently from the wallet used then ` +
        `derives another privacy key from the same wallet key. Use that wallet, or ${remedy}.`,
    };
  }

  const tried = all.filter((f) => wallet.includes(f));
  const untried = all.filter((f) => !wallet.includes(f));
  if (tried.length === 0) {
    return {
      ok: false, reason: 'no-format', tried, untried,
      message: `This wallet signs none of the formats of this arm (${orList(untried.map(name))}), so no ${what} can be found with it. ${Remedy}.`,
    };
  }
  const matches: BlindMatch[] = [];
  for (const format of tried) {
    const blind = checkBlind(scheme, await req.derive(format), 'the derived blind');
    if ((await req.finds(new Uint8Array(blind), format)) === true) matches.push({ format, blind });
  }
  if (matches.length > 0) return { ok: true, source: 'search', matches };
  const found = role === 'device' ? 'No account was found' : 'No grant was found';
  return {
    ok: false, reason: 'not-found', tried, untried,
    message: `${found} in the formats this wallet can sign (${tried.map(name).join(', ')}).` +
      (untried.length > 0 ? ` The ${what} may have been ${role === 'device' ? 'enrolled' : 'issued'} through another format (${orList(untried.map(name))}).` : '') +
      ` ${Remedy}.`,
  };
}

// ── The signer check ────────────────────────────────────────────────────────

/** A signature that is not from the key it must come from. `signer` is set
 *  only when the signature verifies under that other identity. */
export class SignerMismatchError extends Error {
  constructor(
    readonly scheme: BlindScheme,
    readonly expected: Uint8Array,
    readonly signer: Uint8Array | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'SignerMismatchError';
  }
}

/**
 * Checks, before any proof, that a signature comes from `expected` (the
 * device's or grantee's identity, as the arm's entry defines it). `verifies`
 * is the arm's own verification of the signature under a given identity, over
 * the exact bytes the wallet was asked to sign; an exception in it counts as
 * "does not verify". On a mismatch, `others` (for example the keys other
 * connected wallets report) are tried in order, and the refusal names the
 * first one under which the signature verifies; a reported key is never named
 * on the wallet's word alone. Otherwise the signer is unknown.
 */
export function checkSigner(
  scheme: BlindScheme,
  expected: Uint8Array,
  verifies: (identity: Uint8Array) => boolean,
  others: readonly Uint8Array[] = [],
): void {
  const arm = blindArm(scheme, 'checkSigner');
  const exp = arm.identity.parse(expected);
  const holds = (identity: Uint8Array): boolean => {
    try { return verifies(new Uint8Array(identity)) === true; } catch { return false; }
  };
  if (holds(exp)) return;
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const candidate of others) {
    let identity: Uint8Array;
    try { identity = arm.identity.parse(candidate); } catch { continue; }
    if (same(identity, exp) || !holds(identity)) continue;
    throw new SignerMismatchError(scheme, exp, identity,
      `signer: refused before proving: the signature is not from the expected ${arm.identity.walletText(exp)}; it verifies under ${arm.identity.walletText(identity)}, another wallet's key`);
  }
  throw new SignerMismatchError(scheme, exp, undefined,
    `signer: refused before proving: the signature is not from the expected ${arm.identity.walletText(exp)}, and the signer is unknown`);
}
