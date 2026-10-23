// The blind of a readable device or grantee — the request messages and the
// canonical signature forms.
//
// A readable arm's device entries and grant ids bind a per-account secret,
// the BLIND, so that a public wallet identity (an Ethereum address, a Solana
// key) never appears in ledger state in a form anyone can test:
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
// The canonical forms make the blind independent of signature malleability:
// EVM signatures are reduced to low-S r || s (big-endian, 32 bytes each, the
// recovery byte dropped); Ed25519 signatures are the raw 64-byte R || S, with
// S below the group order and R a canonical point encoding. Enrolment signs
// twice and refuses the wallet unless both canonical forms are equal
// (sameCanonicalSignature): a non-deterministic wallet would lose its accounts
// on restore.

import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { BLIND_TAGS, padTag, evmChecksumAddress, base58Encode, parseSolanaPublicKey, unknownScheme } from './descriptors.js';

export type BlindScheme = 'evm_eip712' | 'sol_ed25519';
/** The readable schemes that have a blind. Every switch over a BlindScheme
 *  ends in unknownScheme (a `never` check): any other scheme is refused. */
export const BLIND_SCHEMES: readonly BlindScheme[] = ['evm_eip712', 'sol_ed25519'];
const unknownBlindScheme = (scheme: never, where: string): never => unknownScheme(scheme, where, BLIND_SCHEMES, 'blind');

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
  /** The wallet identity: the 20-byte Ethereum address, or the 32-byte
   *  Ed25519 public key. */
  identity: Uint8Array;
  /** 0 for the wallet's first Passport account on this network, then 1, 2, ... */
  accountIndex: bigint | number;
}

function checkNetwork(network: string): void {
  if (!NETWORK.test(network)) throw new Error('blind: the network name is lower-case letters, digits, and hyphens');
}

/** The wallet line's value: the EIP-55 address, or the base58 Ed25519 key. */
function walletText(scheme: BlindScheme, identity: Uint8Array): string {
  switch (scheme) {
    case 'evm_eip712':
      if (identity.length !== 20 || identity.every((b) => b === 0)) throw new Error('blind: an Ethereum address is 20 bytes, not zero');
      return `Ethereum address ${evmChecksumAddress(identity)}`;
    case 'sol_ed25519': return `Solana public key ${base58Encode(parseSolanaPublicKey(identity))}`;
    default: return unknownBlindScheme(scheme, 'the blind request');
  }
}

/** The blind tag text of a readable scheme; any other scheme is refused (never
 *  looked up as undefined). */
function blindTagText(scheme: BlindScheme, where: string): string {
  switch (scheme) {
    case 'evm_eip712': return BLIND_TAGS.evm_eip712;
    case 'sol_ed25519': return BLIND_TAGS.sol_ed25519;
    default: return unknownBlindScheme(scheme, where);
  }
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
  /** The grantee wallet's identity: the 20-byte Ethereum address, or the
   *  32-byte Ed25519 public key. */
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

/** The canonical form for a scheme; any other scheme is refused. */
export function canonicalSignature(scheme: BlindScheme, sig: Uint8Array): Uint8Array {
  switch (scheme) {
    case 'evm_eip712': return canonicalEvmSignature(sig);
    case 'sol_ed25519': return canonicalEd25519Signature(sig);
    default: return unknownBlindScheme(scheme, 'canonicalSignature');
  }
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
