// Arm `sol_ed25519`: which formats a Solana wallet can sign, and the adapters
// that ask a wallet for exactly those.
//
// A Solana key signs Passport approvals and blind requests in one of two
// formats (sol-ed25519-message.ts): raw, what `signMessage` signs, or the
// Solana off-chain message v1. Wallets differ, and a wallet asked for a
// format it cannot sign either refuses or shows the user bytes it cannot
// read:
//   - Phantom signs raw only: it refuses an off-chain message, even one the
//     page builds.
//   - Backpack and Solflare sign raw, and the off-chain message v1 through
//     their own wallet-standard feature `solana:signOffchainMessage`, which
//     shows the text with its line breaks. Handed the off-chain bytes through
//     `signMessage`, a wallet shows the binary head as garbled characters, so
//     the off-chain format always goes through the feature.
//   - Ledger and Trezor sign the off-chain message v1 only: their Solana apps
//     refuse raw bytes.
//   - Any other wallet-standard wallet may advertise a format it does not
//     honour (a `signMessage` backed by a hardware account that refuses raw
//     bytes), so the client tests it before enrolment: one signature of a
//     probe text in the raw format when it offers `solana:signMessage`, then,
//     if that is refused or does not verify, in the off-chain format when it
//     advertises the feature with message version 1 (probeSolWalletFormats,
//     solEnrolmentSigner). The probe text is fresh, authorises nothing, and
//     its signature is checked and dropped. A restore without a record tries
//     what the wallet advertises, raw then off-chain, and moves past a
//     format the wallet refuses: the blind request's own signatures are the
//     test there.
// solWalletFormats gives the formats a wallet advertises it can sign,
// preferred first: enrolment signs in the first (for another wallet, the
// first that passed the probe), a restore tries each. The adapters refuse,
// without asking the wallet, bytes of a format it cannot sign.
//
// A wallet-standard wallet advertises features for all its accounts, and
// each account lists the features it supports itself (`WalletAccount.features`:
// "Feature names supported by the account. This must be a subset of the
// names of features of the Wallet."): a wallet can offer off-chain signing
// while a connected account (a hardware account behind it, say) supports
// only `signMessage`. The adapters therefore use only the wallet's features
// that the connected account lists (solAccountFeatures), before the family
// rules. The standard makes the list part of every account, so an account
// object without one (or with a value that is not a list of names) supports
// no feature the client can rely on, and is asked for nothing: an adapter
// that builds account objects itself must carry the account's `features`.
//
// A wallet may answer with another key than the one it reports (with two
// extensions installed, one may answer requests made to the other's
// wallet-standard entry). The adapters do not decide who signed: the arm's
// signer check does (signer-sol-ed25519.ts `checkSolSignature`), over the
// exact bytes the wallet was asked to sign. `others` gives it the keys other
// connected wallets report, so that a refusal can name the wallet that
// answered.
//
// Auto-approve: a wallet setting that signs messages without showing them
// (for example a time-limited "auto-approve message signing") signs Passport
// approvals unseen as well. Passport cannot detect it; such a setting must
// stay off for a wallet that holds a Passport device.

import { base58Encode, parseSolanaPublicKey } from './descriptors.js';
import { SOL_HEAD_LENGTH, SOL_OFFCHAIN_VERSION, SOL_RAW_HEAD, solFormatOfSigned, solMessageHead, type SolFormat } from './sol-ed25519-message.js';
import { checkSolSignature, type SolSigner } from './signer-sol-ed25519.js';

/** The wallet-standard feature of raw message signing. */
export const SOL_SIGN_MESSAGE_FEATURE = 'solana:signMessage';
/** The wallet-standard feature of off-chain message signing. */
export const SOL_SIGN_OFFCHAIN_MESSAGE_FEATURE = 'solana:signOffchainMessage';

/** The wallet families whose formats the client knows; `other` is any other
 *  wallet-standard wallet, judged by the features it advertises. */
export type SolWalletFamily = 'phantom' | 'backpack' | 'solflare' | 'ledger' | 'trezor' | 'other';

/** A wallet as the client meets it: its family and, for a wallet-standard
 *  wallet, the features it offers the connected account (solAccountFeatures). */
export interface SolWalletProfile {
  family: SolWalletFamily;
  features?: Readonly<Record<string, unknown>>;
}

/** The family of a wallet-standard wallet, by the name it registers. */
export function solWalletFamily(name: unknown): SolWalletFamily {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return n === 'phantom' || n === 'backpack' || n === 'solflare' ? n : 'other';
}

/** A wallet-standard account (`WalletAccount`): its address, its key and the
 *  names of the features it supports. */
export interface SolStandardAccount { address: string; publicKey: Uint8Array; features?: readonly string[] }

/** `solana:signMessage`: signs exactly the bytes given. */
export interface SolSignMessageFeature {
  signMessage(...inputs: { account: SolStandardAccount; message: Uint8Array }[]): Promise<readonly { signedMessage?: unknown; signature: unknown }[]>;
}

/** `solana:signOffchainMessage`: the wallet builds the off-chain message of
 *  the given text, with the required signers, and signs it. */
export interface SolSignOffchainMessageFeature {
  supportedMessageVersions?: readonly number[];
  signOffchainMessage(...inputs: { messageVersion: number; account: SolStandardAccount; message: string; requiredSigners: readonly Uint8Array[] }[]):
    Promise<readonly { signedOffchainMessage?: unknown; signature: unknown }[]>;
}

/** A wallet-standard wallet, as far as the adapter uses it. */
export interface SolStandardWallet { name: string; features: Readonly<Record<string, unknown>> }

const feature = <T>(features: Readonly<Record<string, unknown>> | undefined, name: string, method: string): T | undefined => {
  const f = features?.[name] as any;
  return f && typeof f[method] === 'function' ? (f as T) : undefined;
};

/** The features the adapters may use for `account`: the wallet's features
 *  whose names the account lists, and none when the account lists none (see
 *  the header). */
export function solAccountFeatures(wallet: SolStandardWallet, account: SolStandardAccount): Readonly<Record<string, unknown>> {
  const names = (account as { features?: unknown } | undefined)?.features;
  const offered = wallet?.features ?? {};
  const out: Record<string, unknown> = {};
  if (!Array.isArray(names)) return out;
  for (const n of names) if (typeof n === 'string' && Object.prototype.hasOwnProperty.call(offered, n)) out[n] = offered[n];
  return out;
}

/** The wallet's raw signing feature, if it offers one. */
export function solSignMessageFeature(features?: Readonly<Record<string, unknown>>): SolSignMessageFeature | undefined {
  return feature<SolSignMessageFeature>(features, SOL_SIGN_MESSAGE_FEATURE, 'signMessage');
}

/** The wallet's off-chain signing feature, if it advertises message version
 *  1 (the only version the arm verifies). */
export function solOffchainV1Feature(features?: Readonly<Record<string, unknown>>): SolSignOffchainMessageFeature | undefined {
  const f = feature<SolSignOffchainMessageFeature>(features, SOL_SIGN_OFFCHAIN_MESSAGE_FEATURE, 'signOffchainMessage');
  if (!f) return undefined;
  let versions: unknown[];
  try { versions = [...(f.supportedMessageVersions ?? [])]; } catch { return undefined; }
  return versions.includes(SOL_OFFCHAIN_VERSION) ? f : undefined;
}

/** The formats a wallet can sign, preferred first. Phantom: raw, never
 *  off-chain, whatever it advertises; Ledger and Trezor: off-chain, never
 *  raw; Backpack and Solflare: off-chain when they advertise the off-chain
 *  feature with version 1, then raw when they offer `signMessage`; any other
 *  wallet-standard wallet: what it advertises, raw first (its enrolment
 *  format comes from probeSolWalletFormats). A wallet that signs neither
 *  gets an empty list and is asked for nothing. */
export function solWalletFormats(p: SolWalletProfile): SolFormat[] {
  const raw = solSignMessageFeature(p.features) ? ['raw' as const] : [];
  const offchain = solOffchainV1Feature(p.features) ? ['offchain' as const] : [];
  switch (p.family) {
    case 'ledger': case 'trezor': return ['offchain'];
    case 'phantom': return raw;
    case 'backpack': case 'solflare': return [...offchain, ...raw];
    case 'other': return [...raw, ...offchain];
    default: throw new Error(`sol_ed25519: unknown wallet family ${String((p as any)?.family)}`);
  }
}

/** Bytes a wallet returned: a Uint8Array, or an array of byte values. */
function walletBytes(v: unknown, what: string, length?: number): Uint8Array {
  let b: Uint8Array;
  if (v instanceof Uint8Array) b = new Uint8Array(v);
  else if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) b = Uint8Array.from(v);
  else throw new Error(`sol_ed25519: the wallet returned no ${what}`);
  if (length !== undefined && b.length !== length) throw new Error(`sol_ed25519: the wallet's ${what} is ${b.length} bytes, not ${length}`);
  return b;
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Refuses bytes whose format the wallet cannot sign, before asking it. */
function formatOf(bytes: Uint8Array, formats: readonly SolFormat[], who: string): SolFormat {
  const format = solFormatOfSigned(bytes);
  if (!formats.includes(format)) throw new Error(`sol_ed25519: ${who} cannot sign the ${format} format; not asked`);
  return format;
}

/** The text of an off-chain message for `key` (the bytes after the head),
 *  checked: the head names `key`, the text is printable ASCII. */
function offchainText(bytes: Uint8Array, key: Uint8Array): string {
  const head = solMessageHead('offchain', key);
  if (bytes.length <= SOL_HEAD_LENGTH || !same(bytes.subarray(0, SOL_HEAD_LENGTH), head)) throw new Error('sol_ed25519: not an off-chain message for this key');
  const text = new TextDecoder().decode(bytes.subarray(SOL_HEAD_LENGTH));
  if (!/^[\x20-\x7e\n]*$/.test(text)) throw new Error('sol_ed25519: an off-chain message text is printable ASCII');
  return text;
}

/**
 * A signer for a wallet-standard wallet's account (Phantom, Backpack,
 * Solflare, or another wallet). Its formats are solWalletFormats of the
 * wallet's family and the features of the wallet the account lists
 * (solAccountFeatures). Raw bytes go to `solana:signMessage`; an
 * off-chain message goes to `solana:signOffchainMessage` as its text, with
 * the account as the one required signer, and the wallet's own envelope,
 * when it returns it, must be exactly the bytes the client built. Whether the
 * signature comes from the account's key is the arm's signer check.
 */
export function solStandardSigner(wallet: SolStandardWallet, account: SolStandardAccount, opts: { others?: () => readonly Uint8Array[] } = {}): SolSigner {
  const publicKey = parseSolanaPublicKey(walletBytes(account?.publicKey, 'account key', 32));
  if (typeof account.address === 'string' && account.address !== base58Encode(publicKey)) throw new Error('sol_ed25519: the account\'s address and key disagree');
  const name = typeof wallet?.name === 'string' ? wallet.name : 'the wallet';
  const features = solAccountFeatures(wallet, account);
  const formats = solWalletFormats({ family: solWalletFamily(wallet?.name), features });
  return {
    publicKey,
    formats,
    ...(opts.others ? { others: opts.others } : {}),
    ...(solWalletFamily(wallet?.name) === 'other' ? { searchesPastRefusals: true } : {}),
    sign: async (message: Uint8Array) => {
      const bytes = new Uint8Array(message);
      if (formatOf(bytes, formats, name) === 'raw') {
        const [answer] = await solSignMessageFeature(features)!.signMessage({ account, message: bytes });
        if (answer?.signedMessage !== undefined && !same(walletBytes(answer.signedMessage, 'signed message'), bytes)) {
          throw new Error(`sol_ed25519: ${name} reports that it signed other bytes than asked; refused`);
        }
        return walletBytes(answer?.signature, 'signature', 64);
      }
      const text = offchainText(bytes, publicKey);
      const [answer] = await solOffchainV1Feature(features)!.signOffchainMessage({ messageVersion: SOL_OFFCHAIN_VERSION, account, message: text, requiredSigners: [publicKey] });
      if (answer?.signedOffchainMessage !== undefined && !same(walletBytes(answer.signedOffchainMessage, 'off-chain message'), bytes)) {
        throw new Error(`sol_ed25519: ${name} signed another off-chain message than the one asked; refused`);
      }
      return walletBytes(answer?.signature, 'signature', 64);
    },
  };
}

// ── The format probe (wallets outside the named families) ─────────────────

/** The first line of a format probe text: unlike the first line of every
 *  approval (`Midnight Passport approval (sol v1)`) and of both blind
 *  requests (`Midnight Passport account privacy key (v1)`, `Midnight
 *  Passport grantee privacy key (v1)`), so no check of the arm accepts a
 *  probe text as either. */
export const SOL_FORMAT_PROBE_FIRST_LINE = 'Midnight Passport signing format check (sol v1)';

const PROBE_NONCE_BYTES = 32;
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A format probe text for `key` with a fresh `nonce` (32 bytes): printable
 *  ASCII, LF line breaks. The nonce makes every probe's bytes new, so a
 *  probe signature collected once is not one a later probe accepts. */
export function solFormatProbeText(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  const k = parseSolanaPublicKey(key);
  if (!(nonce instanceof Uint8Array) || nonce.length !== PROBE_NONCE_BYTES) throw new Error(`sol_ed25519: a probe nonce is ${PROBE_NONCE_BYTES} bytes`);
  return new TextEncoder().encode([
    SOL_FORMAT_PROBE_FIRST_LINE,
    `Wallet: Solana public key ${base58Encode(k)}`,
    `Nonce: ${hexOf(nonce)}`,
    'It authorises nothing: it only tests which signing format this wallet signs.',
  ].join('\n'));
}

/** What the wallet signs for a probe text in a format: the raw head, then
 *  the text; or the off-chain v1 head naming the key, then the text. */
export function solFormatProbeBytes(format: SolFormat, key: Uint8Array, text: Uint8Array): Uint8Array {
  const head = format === 'raw' ? new TextEncoder().encode(SOL_RAW_HEAD) : format === 'offchain' ? solMessageHead('offchain', parseSolanaPublicKey(key)) : undefined;
  if (head === undefined) throw new Error(`sol_ed25519: unknown format ${String(format)}`);
  const b = new Uint8Array(head.length + text.length);
  b.set(head); b.set(text, head.length);
  return b;
}

/** One probe request and how it ended. Holds no signature: a probe
 *  signature is checked and dropped. */
export interface SolFormatProbeAttempt { format: SolFormat; outcome: 'verified' | 'refused' | 'wrong-signature'; reason?: string }

export interface SolFormatProbe {
  family: SolWalletFamily;
  /** The formats the wallet advertises for the account (solWalletFormats of
   *  solAccountFeatures). */
  advertised: SolFormat[];
  /** False for a named family, whose rule is fixed and which is never asked. */
  probed: boolean;
  /** The enrolment format: the first format whose probe signature verified
   *  (a named family: its rule's first format); absent when none did. */
  format?: SolFormat;
  attempts: SolFormatProbeAttempt[];
  /** Why the wallet cannot enrol, when no format verified. */
  message?: string;
}

/**
 * Tests a wallet-standard wallet outside the named families before
 * enrolment: one signature of a fresh probe text in the raw format when it
 * offers `solana:signMessage`, checked by the arm's signer check over the
 * exact bytes under the account's key; if the wallet refuses, throws or
 * returns a signature that does not verify, the same text in the off-chain
 * format through `solana:signOffchainMessage` (version 1), checked the same
 * way. The first format that verifies is the enrolment format. Each request
 * prompts the user; a named family is never asked (its rule is the spec's).
 * The signatures are never stored, returned or used as a blind.
 */
export async function probeSolWalletFormats(wallet: SolStandardWallet, account: SolStandardAccount,
  opts: { others?: () => readonly Uint8Array[]; nonce?: () => Uint8Array } = {}): Promise<SolFormatProbe> {
  const family = solWalletFamily(wallet?.name);
  const advertised = solWalletFormats({ family, features: solAccountFeatures(wallet, account) });
  if (family !== 'other') return { family, advertised, probed: false, ...(advertised.length > 0 ? { format: advertised[0] } : {}), attempts: [] };
  const signer = solStandardSigner(wallet, account, opts);
  const nonce = opts.nonce ? opts.nonce() : globalThis.crypto.getRandomValues(new Uint8Array(PROBE_NONCE_BYTES));
  const text = solFormatProbeText(signer.publicKey, nonce);
  const attempts: SolFormatProbeAttempt[] = [];
  for (const format of advertised) {
    const bytes = solFormatProbeBytes(format, signer.publicKey, text);
    let signature: Uint8Array;
    try { signature = await signer.sign(bytes); } catch (e: any) {
      attempts.push({ format, outcome: 'refused', reason: String(e?.message ?? e) });
      continue;
    }
    try { checkSolSignature(bytes, signature, signer.publicKey, opts.others?.() ?? []); } catch (e: any) {
      attempts.push({ format, outcome: 'wrong-signature', reason: String(e?.message ?? e) });
      continue;
    }
    attempts.push({ format, outcome: 'verified' });
    return { family, advertised, probed: true, format, attempts };
  }
  const name = typeof wallet?.name === 'string' ? wallet.name : 'the wallet';
  return {
    family, advertised, probed: true, attempts,
    message: advertised.length === 0
      ? `sol_ed25519: ${name} offers neither raw message signing nor the off-chain message v1; it cannot enrol a Passport device`
      : `sol_ed25519: ${name} signed no probe correctly (${attempts.map((a) => `${a.format}: ${a.outcome}`).join('; ')}); it cannot enrol a Passport device`,
  };
}

/**
 * The signer enrolment uses for a wallet-standard account: for a named
 * family, solStandardSigner as it is (never probed); for any other wallet,
 * solStandardSigner after probeSolWalletFormats, listing the format that
 * passed first and dropping raw when raw failed, or a refusal with the
 * probe's message (nothing is derived). The signer it returns asks the
 * wallet afresh for every request.
 */
export async function solEnrolmentSigner(wallet: SolStandardWallet, account: SolStandardAccount,
  opts: { others?: () => readonly Uint8Array[]; nonce?: () => Uint8Array } = {}): Promise<SolSigner> {
  const signer = solStandardSigner(wallet, account, opts);
  if (solWalletFamily(wallet?.name) !== 'other') return signer;
  const probe = await probeSolWalletFormats(wallet, account, opts);
  if (probe.format === undefined) throw new Error(probe.message);
  const formats = [probe.format, ...signer.formats.filter((f) => f !== probe.format && !(f === 'raw' && probe.format !== 'raw'))];
  return { ...signer, formats };
}

/** A hardware wallet's off-chain signing: `envelope` is the whole off-chain
 *  message v1 (what a Ledger's Solana app takes), `text` its text (what a
 *  Trezor takes, building the envelope itself). It returns the signature,
 *  and the signed bytes when the device reports them. */
export type SolHardwareSignFn = (envelope: Uint8Array, text: Uint8Array) =>
  Promise<Uint8Array | { signature: Uint8Array; signed?: Uint8Array }> | Uint8Array | { signature: Uint8Array; signed?: Uint8Array };

/**
 * A signer for a Ledger or a Trezor account (its 32-byte key and its
 * transport's off-chain signing). Off-chain only: raw bytes are refused
 * without asking the device. The signed bytes a device reports must be
 * exactly the envelope the client built.
 */
export function solHardwareSigner(opts: { family: 'ledger' | 'trezor'; publicKey: Uint8Array; signOffchain: SolHardwareSignFn; others?: () => readonly Uint8Array[] }): SolSigner {
  if (opts.family !== 'ledger' && opts.family !== 'trezor') throw new Error(`sol_ed25519: not a hardware wallet family: ${String(opts.family)}`);
  const publicKey = parseSolanaPublicKey(opts.publicKey);
  const formats = solWalletFormats({ family: opts.family });
  return {
    publicKey,
    formats,
    ...(opts.others ? { others: opts.others } : {}),
    sign: async (message: Uint8Array) => {
      const bytes = new Uint8Array(message);
      formatOf(bytes, formats, `the ${opts.family === 'ledger' ? 'Ledger' : 'Trezor'}`);
      offchainText(bytes, publicKey);
      const r = await opts.signOffchain(new Uint8Array(bytes), bytes.slice(SOL_HEAD_LENGTH));
      const answer = r instanceof Uint8Array || Array.isArray(r) ? { signature: r as Uint8Array } : r;
      if (answer?.signed !== undefined && !same(walletBytes(answer.signed, 'signed message'), bytes)) {
        throw new Error('sol_ed25519: the device signed another off-chain message than the one asked; refused');
      }
      return walletBytes(answer?.signature, 'signature', 64);
    },
  };
}
