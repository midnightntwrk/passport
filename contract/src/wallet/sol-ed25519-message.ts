// Arm `sol_ed25519`: the signed messages, format sol v1, rendered
// independently of the contract.
//
// The contract renders every approval text in-circuit
// (`sol_message_<operation>` in contracts/account-sol-ed25519.compact) and
// verifies the wallet's signature over that text after the 50-byte head of
// the signing format (contracts/modules/SolanaFormats): `raw`, what a
// wallet's `signMessage` signs, puts a line naming the format first;
// `offchain`, the Solana off-chain message v1 that hardware wallets and
// `signOffchainMessage` sign, puts the off-chain envelope naming the signing
// key first. `solSignedMessage` builds those bytes. This module renders the
// same text
// from the same values with plain TypeScript (its own hex, decimal and label
// code), and builds the display inputs the circuits check (decimal digits,
// the site's label and amount claims). The offline suite holds the two
// renderers to each other byte for byte; a client signs only after both
// agree (`solMessageChecked`).
//
// The grammar: printable ASCII, LF line breaks, no final LF:
//
//   Midnight Passport approval (sol v1)
//   Operation: <title>
//   Site: <site label, 32 bytes, padding shown as spaces>
//   Role: device of this account | Role: grantee of a scoped grant
//   Account: <64 hex>
//   Signing key: <base58, left-aligned and space-padded to 44>
//   <operation lines: every operand and consumed witness value in full>
//   Consequence: <...>              (authority-granting operations)
//   Device nonce: <20>              (device role)
//   Grant label / slot / issued at nonce / use nonce   (grantee role)
//
// Numbers are decimal, left-aligned and space-padded to their type's width
// (Uint<8> 3, Uint<32> 10, Uint<64> 20, Uint<128> 39); bytes are lowercase
// hex, in full; a Solana key is its base58 text (as Solana wallets show it),
// space-padded to 44; a grant's expiry is also shown as a UTC date and time,
// and a zero window as the words "no window". Curve coordinates follow the base's
// COORDINATE_DISPLAY_ORDER: secp256k1 and P-256 big-endian, JubJub
// little-endian; Field values little-endian. Platform-neutral (no
// node:crypto).

import { ed25519 } from '@noble/curves/ed25519.js';
import { DESCRIPTOR_TAGS, parseSolanaPublicKey, type DescriptorScheme, type ReadableFormat } from './descriptors.js';
import { BLIND_MESSAGE_VERSION, GRANTEE_BLIND_MESSAGE_VERSION, blindFormats } from './blind.js';
import { ENUM_TEXT_WIDTH, k256EnvelopeLabel, recipientKindLabel } from './labels.js';
import {
  BASE58_TEXT_WIDTH, DATETIME_TEXT_WIDTH, EXPIRY_TEXT_WIDTH, RP_HASH_TEXT_WIDTH, SITE_AMOUNT_LABEL_WIDTH, WINDOW_CAP_TEXT_WIDTH, WINDOW_TEXT_WIDTH,
  base58Inputs, base58Text32, expiryDateTimeText, expiryText, rpHashText, siteAmountLabel, utcDateTimeInputs, windowCapText, windowText,
} from './rendering.js';

export const SOL_MESSAGE_FORMAT = 'sol v1';
export const SOL_FIRST_LINE = 'Midnight Passport approval (sol v1)';
/** The smallest length at which a message starting "Midn" could parse as a
 *  legacy Solana transaction message: header (3) + key count (1) + 110 keys
 *  (32 each) + blockhash (32) + instruction count (1). */
export const SOL_PARSE_BOUND = 3 + 1 + 110 * 32 + 32 + 1;

/** The arm's two signing formats, as its READABLE_ARMS entry lists them:
 *  `raw` (what a wallet's `signMessage` signs) and `offchain` (the Solana
 *  off-chain message v1). A device's approvals and its blind request are
 *  signed in one of them. */
export type SolFormat = ReadableFormat<'sol_ed25519'>;
export const SOL_FORMATS: readonly SolFormat[] = Object.freeze(blindFormats('sol_ed25519') as SolFormat[]);
/** Every format's head is 50 bytes. */
export const SOL_HEAD_LENGTH = 50;
/** The raw head: a line naming the format, then LF (50 ASCII bytes). */
export const SOL_RAW_HEAD = 'Midnight Passport, Solana signMessage format (v1)\n';
/** The off-chain message's signing domain: 0xff, then "solana offchain". */
export const SOL_OFFCHAIN_DOMAIN: Uint8Array = Uint8Array.of(0xff, ...new TextEncoder().encode('solana offchain'));
/** The off-chain message's version and signer count: version 1, one signer
 *  (the signing key). */
export const SOL_OFFCHAIN_VERSION = 1;
export const SOL_OFFCHAIN_SIGNERS = 1;

const enc = new TextEncoder();
const hex = (b: Uint8Array, n: number, what: string): string => {
  if (!(b instanceof Uint8Array) || b.length !== n) throw new Error(`sol message: ${what} is ${n} bytes`);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};
const reversed = (b: Uint8Array) => Uint8Array.from(b).reverse();
// The base's exact words (src/wallet/rendering.ts), padded as
// the circuits pad them: a grant expiry of 0 as "never", the all-zero RP hash
// of a non-passkey grantee as "not applicable". Every number is shown in
// full digits.
const expiryShown = (v: bigint) => expiryText(v).padEnd(EXPIRY_TEXT_WIDTH, ' ');
// The same expiry as a UTC date and time ("never" for 0; the words
// "after 9999-12-31 23:59:59 UTC" above year 9999), and a zero window as
// "no window" (a zero cap of a zero window too).
const expiryDateShown = (v: bigint) => expiryDateTimeText(v).padEnd(DATETIME_TEXT_WIDTH, ' ');
const windowShown = (v: bigint) => windowText(v).padEnd(WINDOW_TEXT_WIDTH, ' ');
const windowCapShown = (len: bigint, cap: bigint) => windowCapText(len, cap).padEnd(WINDOW_CAP_TEXT_WIDTH, ' ');
/** A Solana key as its base58 text, space-padded to 44. */
const b58 = (b: Uint8Array, what: string) => { hex(b, 32, what); return base58Text32(b).padEnd(BASE58_TEXT_WIDTH, ' '); };
const rpHashShown = (h: Uint8Array) => { hex(h, 32, 'the RP hash'); return rpHashText(h).padEnd(RP_HASH_TEXT_WIDTH, ' '); };
/** A passkey's own RP hash: its hex, never zero (the circuits refuse a zero
 *  one with the same message). */
const passkeyRpHash = (h: Uint8Array, refusal: string) => {
  const x = hex(h, 32, 'the RP hash');
  if (h.every((b) => b === 0)) throw new Error(refusal);
  return x;
};
const MAX: Record<number, bigint> = { 3: 255n, 10: 0xffffffffn, 20: 0xffffffffffffffffn, 39: (1n << 128n) - 1n };
/** A decimal of a fixed-width unsigned type, left-aligned, space-padded. */
export function decimal(v: bigint, width: 3 | 10 | 20 | 39): string {
  if (typeof v !== 'bigint' || v < 0n || v > MAX[width]) throw new Error(`sol message: ${v} does not fit ${width} digits`);
  return v.toString(10).padEnd(width, ' ');
}
/** The display input of a decimal: its ASCII bytes as the circuit takes them. */
export function digitsOf(v: bigint, width: 3 | 10 | 20 | 39): bigint[] {
  return [...enc.encode(decimal(v, width))].map(BigInt);
}

/** A 32-byte label: visible words separated by single spaces, zero-padded. */
export function labelBytes(text: string): Uint8Array {
  if (!/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(text)) throw new Error('sol message: a label is visible words separated by single spaces');
  const b = enc.encode(text);
  if (b.length > 32) throw new Error('sol message: a label is at most 32 bytes');
  const out = new Uint8Array(32);
  out.set(b);
  return out;
}
/** A zero-padded label as shown: the zero bytes as spaces. Refuses a label
 *  the circuit would refuse. */
export function labelText(b: Uint8Array): string {
  if (b.length !== 32) throw new Error('sol message: a label is 32 bytes');
  let end = 32;
  while (end > 0 && b[end - 1] === 0) end--;
  const text = String.fromCharCode(...b.subarray(0, end));
  if (!/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(text)) throw new Error('sol message: not a zero-padded label');
  return text.padEnd(32, ' ');
}

/** The site's label for an amount, 49 bytes: the digits of `value` with the
 *  site's decimal point (0..18 decimals) and its symbol (1..8 visible
 *  characters, the first a letter), as the base's rendering module builds
 *  it (the circuits check it with site_amount_label_text). */
export const claimText = (value: bigint, decimals: number, symbol: string): string =>
  siteAmountLabel(value, decimals, symbol).padEnd(SITE_AMOUNT_LABEL_WIDTH, ' ');

const yesNo = (b: boolean) => (b ? 'yes' : 'no ');
/** Enumerated values as their labels (24 bytes, the base's table in
 *  labels.ts, which the circuits' rendering module selects from). */
const envelopeLabel = (e: bigint) => k256EnvelopeLabel(e).padEnd(ENUM_TEXT_WIDTH, ' ');
const kindWord = (k: bigint) => recipientKindLabel(k).padEnd(ENUM_TEXT_WIDTH, ' ');

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface SolSite { site: string }
export interface SolDeviceContext extends SolSite { account: Uint8Array; key: Uint8Array; nonce: bigint }
export interface SolGranteeContext extends SolSite { account: Uint8Array; key: Uint8Array; label: string; slot: bigint; issuedAt: bigint; nonce: bigint }
export interface SolAmount { color: Uint8Array; amount: bigint; decimals: number; symbol: string }
export interface SolCoin { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint }
/** A target device or grantee, as the circuits' SolTarget / SolGrantee. */
export interface SolTargetFields {
  tag: string; address?: Uint8Array; a?: Uint8Array; b?: Uint8Array; c?: Uint8Array; origin?: Uint8Array; envelope?: bigint;
}
export interface SolGranteeFields extends SolTargetFields { label?: string; originHash?: Uint8Array; slot: bigint }

const Z32 = new Uint8Array(32), Z20 = new Uint8Array(20), Z21 = new Uint8Array(21);

// ── Pieces ──────────────────────────────────────────────────────────────────

const L = (...parts: string[]) => parts.join('') + '\n';
function head(title: string, role: 'device' | 'grantee', c: { site: string; account: Uint8Array; key: Uint8Array }): string {
  return L(SOL_FIRST_LINE) + L('Operation: ', title) + L('Site: ', labelText(labelBytes(c.site)))
    + L(role === 'device' ? 'Role: device of this account' : 'Role: grantee of a scoped grant')
    + L('Account: ', hex(c.account, 32, 'the account')) + L('Signing key: ', b58(c.key, 'the signing key'));
}
const deviceTail = (c: SolDeviceContext) => 'Device nonce: ' + decimal(c.nonce, 20);
const grantTail = (c: SolGranteeContext) => L('Grant label: ', labelText(labelBytes(c.label))) + L('Grant slot: ', decimal(c.slot, 3))
  + L('Grant issued at nonce: ', decimal(c.issuedAt, 20)) + 'Grant use nonce: ' + decimal(c.nonce, 20);
const amountLines = (a: SolAmount) => L('Token: ', hex(a.color, 32, 'the token')) + L('Amount (base units): ', decimal(a.amount, 39))
  + L('This site labels it: ', claimText(a.amount, a.decimals, a.symbol));
function coinLines(coin: SolCoin, amount: bigint): string {
  if (amount > coin.value) throw new Error('sol message: amount above the spent coin\'s value');
  return L('Spent coin value: ', decimal(coin.value, 39)) + L('Spent coin nonce: ', hex(coin.nonce, 32, 'the coin nonce'))
    + L('Spent coin index: ', decimal(coin.mt_index, 20)) + L('Change back to this account: ', decimal(coin.value - amount, 39));
}
const entryLines = (entry: Uint8Array, word: string) => {
  hex(entry, 192, 'an inbox entry');
  let s = '';
  for (let k = 0; k < 6; k++) s += L(`${word} ${k + 1} of 6: `, hex(entry.subarray(32 * k, 32 * k + 32), 32, 'a part'));
  return s;
};

const padBlock = (s: string, n: number) => {
  // spaces before the block's last line break
  if (!s.endsWith('\n') || s.length > n) throw new Error('sol message: block too long');
  return s.slice(0, -1) + ' '.repeat(n - s.length) + '\n';
};
const visible = (b: Uint8Array) => {
  if (!b.every((x) => x >= 0x21 && x <= 0x7e)) throw new Error('sol message: passkey origin not visible ASCII');
  return String.fromCharCode(...b);
};

// ── Enrolment kinds ─────────────────────────────────────────────────────────

/** The class of a kind's key (the circuit's SolClass): the descriptor fields
 *  it uses and how its entry and grant id are derived. `w52` and `ed25519`
 *  are the readable arms' classes (an identity with the account's blind),
 *  `w64` a JubJub point, `w65` a secp256k1 key with its envelope, `passkey` a
 *  P-256 passkey. */
export type SolKeyClass = 'w52' | 'w64' | 'ed25519' | 'w65' | 'passkey';

/** An enrolment kind of this arm (the circuit's SolKind): the descriptor
 *  scheme whose registered device and grant-id tags name it, the class of
 *  its key, and its key lines as a device target and as a grantee (before
 *  the block's padding; `label` is the grantee's label text). */
export interface SolKind {
  readonly scheme: DescriptorScheme;
  readonly keyClass: SolKeyClass;
  readonly deviceLines: (t: SolTargetFields) => string;
  readonly granteeLines: (t: SolGranteeFields, label: () => string) => string;
}

/** The kinds this arm enrols as devices and grants to, one entry each, in
 *  the order of the circuit's sol_kinds() (contracts/account-sol-ed25519.compact).
 *  A kind of an existing class is added as one entry here, with its entry and
 *  its two rows of key lines in the circuit. */
export const SOL_KINDS: readonly SolKind[] = [
  {
    scheme: 'evm_k256', keyClass: 'w52',
    deviceLines: (t) => L('Ethereum address: 0x', hex(t.address ?? Z20, 20, 'the address')) + L('Device privacy salt: ', hex(t.a ?? Z32, 32, 'the blind')),
    granteeLines: (t, label) => L('Ethereum address: 0x', hex(t.address ?? Z20, 20, 'the address')) + L('Grantee privacy salt: ', hex(t.a ?? Z32, 32, 'the blind'))
      + L('Grantee label: ', label()),
  },
  {
    scheme: 'jubjub', keyClass: 'w64',
    deviceLines: (t) => L('JubJub key x: ', hex(t.a ?? Z32, 32, 'x')) + L('JubJub key y: ', hex(t.b ?? Z32, 32, 'y')),
    granteeLines: (t) => L('JubJub key x: ', hex(t.a ?? Z32, 32, 'x')) + L('JubJub key y: ', hex(t.b ?? Z32, 32, 'y'))
      + L('Grantee site label (hash): ', hex(t.originHash ?? Z32, 32, 'the origin hash')),
  },
  {
    scheme: 'sol_ed25519', keyClass: 'ed25519',
    deviceLines: (t) => L('Solana key: ', b58(t.a ?? Z32, 'the key')) + L('Device privacy salt: ', hex(t.b ?? Z32, 32, 'the blind')),
    granteeLines: (t, label) => L('Solana key: ', b58(t.a ?? Z32, 'the key')) + L('Grantee privacy salt: ', hex(t.b ?? Z32, 32, 'the blind'))
      + L('Grantee label: ', label()),
  },
  {
    scheme: 'k256', keyClass: 'w65',
    deviceLines: (t) => L('secp256k1 key x: ', hex(reversed(t.a ?? Z32), 32, 'x')) + L('secp256k1 key y: ', hex(reversed(t.b ?? Z32), 32, 'y'))
      + L('Signing envelope: ', envelopeLabel(t.envelope ?? 0n)),
    granteeLines: (t) => L('secp256k1 key x: ', hex(reversed(t.a ?? Z32), 32, 'x')) + L('secp256k1 key y: ', hex(reversed(t.b ?? Z32), 32, 'y'))
      + L('Signing envelope: ', envelopeLabel(t.envelope ?? 0n)) + L('Grantee site label (hash): ', hex(t.originHash ?? Z32, 32, 'the origin hash')),
  },
  {
    scheme: 'p256', keyClass: 'passkey',
    deviceLines: (t) => L('Passkey key x: ', hex(reversed(t.a ?? Z32), 32, 'x')) + L('Passkey key y: ', hex(reversed(t.b ?? Z32), 32, 'y'))
      + L('Passkey origin: ', visible(t.origin ?? Z21)) + L('Passkey RP (hash): ', passkeyRpHash(t.c ?? Z32, "descriptor: a passkey's RP hash is zero")),
    granteeLines: (t) => L('Passkey key x: ', hex(reversed(t.a ?? Z32), 32, 'x')) + L('Passkey key y: ', hex(reversed(t.b ?? Z32), 32, 'y'))
      + L('Passkey origin: ', visible(t.origin ?? Z21)),
  },
];

/** The kind of a descriptor scheme, or undefined for a scheme this arm does
 *  not enrol. */
export const solKindOfScheme = (scheme: unknown): SolKind | undefined => SOL_KINDS.find((k) => k.scheme === scheme);
/** The kind a target's device tag names; refuses an unregistered tag, as
 *  the circuit does. */
export function solDeviceKind(tag: string): SolKind {
  const kind = SOL_KINDS.find((k) => DESCRIPTOR_TAGS.device[k.scheme] === tag);
  if (kind === undefined) throw new Error('descriptor: not a registered device tag');
  return kind;
}
/** The kind a grantee's grant-id tag names; refuses an unregistered tag. */
export function solGranteeKind(tag: string): SolKind {
  const kind = SOL_KINDS.find((k) => DESCRIPTOR_TAGS['grant-id'][k.scheme] === tag);
  if (kind === undefined) throw new Error('descriptor: not a registered grant-id tag');
  return kind;
}
/** Whether a class is a readable arm's (an identity with the account's
 *  blind, shown as a grantee with the grant's site label). */
export const solReadableClass = (c: SolKeyClass): boolean => c === 'w52' || c === 'ed25519';

/** The device target's key lines (282 bytes). */
const deviceBlock = (t: SolTargetFields): string => padBlock(solDeviceKind(t.tag).deviceLines(t), 282);

/** The grantee's key and origin lines (299 bytes). */
const granteeBlock = (t: SolGranteeFields): string =>
  padBlock(solGranteeKind(t.tag).granteeLines(t, () => labelText(labelBytes(t.label ?? ''))), 299);
const granteeLines = (g: SolGranteeFields) => L('Grantee scheme: ', labelText(labelBytes(g.tag))) + granteeBlock(g) + L('Grantee slot: ', decimal(g.slot, 3));

// ── The messages ────────────────────────────────────────────────────────────

export type SolDeviceOperation =
  | { op: 'rotate_enc_key'; newKey: Uint8Array }
  | { op: 'append_inbox'; entry: Uint8Array }
  | { op: 'withdraw_unshielded'; amount: SolAmount; recipient: Uint8Array }
  | { op: 'withdraw_shielded'; amount: SolAmount; recipient: Uint8Array; coin: SolCoin }
  | { op: 'withdraw_shielded_to_contract'; amount: SolAmount; recipient: Uint8Array; coin: SolCoin }
  | { op: 'add_device'; target: SolTargetFields }
  | { op: 'remove_device'; literal: false; target: SolTargetFields; counter: bigint; epoch: bigint }
  | { op: 'remove_device'; literal: true; entry: Uint8Array }
  | { op: 'issue_grant'; grantee: SolGranteeFields; opWithdrawUnshielded: boolean; opWithdrawShielded: boolean;
      opWithdrawShieldedToContract: boolean; read: boolean; color: Uint8Array; recipientKind: bigint; recipient: Uint8Array;
      maxCoinValue: bigint; perCallCap: bigint; cap: bigint; expiresAt: bigint; rpIdHash: Uint8Array; readPk: Uint8Array;
      windowLen: bigint; windowCap: bigint; caller: Uint8Array | null }
  | { op: 'revoke_grant'; grantee: SolGranteeFields }
  | { op: 'revoke_all_grants' }
  | { op: 'publish_recovery_session'; recoveryPk: { x: bigint; y: bigint }; sessionNonce: Uint8Array; phi: [bigint, bigint, bigint, bigint];
      phiLen: bigint; wrap: Uint8Array }
  | { op: 'recover_cancel' };

export type SolGranteeOperation =
  | { op: 'withdraw_unshielded_with_grant'; amount: SolAmount; recipient: Uint8Array }
  | { op: 'withdraw_shielded_with_grant'; amount: SolAmount; recipient: Uint8Array; changeEntry: Uint8Array; encPk: Uint8Array; coin: SolCoin }
  | { op: 'withdraw_shielded_to_contract_with_grant'; amount: SolAmount; recipient: Uint8Array; changeEntry: Uint8Array; encPk: Uint8Array; coin: SolCoin };

/** The message of a device-role operation (text). */
export function solDeviceMessageText(c: SolDeviceContext, o: SolDeviceOperation): string {
  switch (o.op) {
    case 'rotate_enc_key':
      return head('Rotate the encryption key', 'device', c) + L('New encryption key: ', hex(o.newKey, 32, 'the key'))
        + L('Consequence: coins deposited from now on are encrypted to this key; only its holder can read them.') + deviceTail(c);
    case 'append_inbox':
      return head('Append an inbox entry', 'device', c) + entryLines(o.entry, 'Inbox entry') + deviceTail(c);
    case 'withdraw_unshielded':
      return head('Withdraw unshielded tokens', 'device', c) + amountLines(o.amount) + L('To unshielded address: ', hex(o.recipient, 32, 'the recipient')) + deviceTail(c);
    case 'withdraw_shielded':
      return head('Withdraw shielded tokens', 'device', c) + amountLines(o.amount) + L('To shielded key: ', hex(o.recipient, 32, 'the recipient'))
        + coinLines(o.coin, o.amount.amount) + deviceTail(c);
    case 'withdraw_shielded_to_contract':
      return head('Withdraw shielded tokens to a contract', 'device', c) + amountLines(o.amount) + L('To contract: ', hex(o.recipient, 32, 'the recipient'))
        + coinLines(o.coin, o.amount.amount) + deviceTail(c);
    case 'add_device':
      return head('Add a device', 'device', c) + L('Consequence: gives this device FULL control of this account.')
        + L('Device scheme: ', labelText(labelBytes(o.target.tag))) + deviceBlock(o.target) + deviceTail(c);
    case 'remove_device': {
      const desc = (t: SolTargetFields, counter: bigint, epoch: bigint) => L('Device scheme: ', labelText(labelBytes(t.tag))) + deviceBlock(t)
        + L('Device use counter: ', decimal(counter, 20)) + L('Device epoch: ', decimal(epoch, 10));
      const n = 15 + 32 + 1 + 282 + 41 + 25;
      const lit = o as Extract<SolDeviceOperation, { literal: true }>, d = o as Extract<SolDeviceOperation, { literal: false }>;
      const body = o.literal
        ? padBlock(L('Removes a device this wallet cannot identify') + L('Device entry: ', hex(lit.entry, 32, 'the entry')), n)
        : desc(d.target, d.counter, d.epoch);
      return head('Remove a device', 'device', c) + L('Consequence: the removed device can no longer act for this account.') + body + deviceTail(c);
    }
    case 'issue_grant':
      // the arm's issue rules the message depends on, in the circuit's order
      // and with its messages: the read key, the grantee class, the RP hash,
      // the recipient
      {
        // a read key exactly when the grant may read (never a key shown under
        // "May read the inbox: no")
        const noReadKey = o.readPk.every((b) => b === 0);
        if (!o.read && !noReadKey) throw new Error('sol_ed25519: a read key without read');
        if (o.read && noReadKey) throw new Error('sol_ed25519: read without a read key');
        const passkey = solGranteeKind(o.grantee.tag).keyClass === 'passkey';
        // the RP hash is non-zero exactly for a passkey grantee whose scope
        // can spend: first, an RP hash belongs to a passkey grantee; then a
        // spending passkey grant carries one and a read-only grant none
        const spends = o.opWithdrawUnshielded || o.opWithdrawShielded || o.opWithdrawShieldedToContract;
        const zero = o.rpIdHash.every((b) => b === 0);
        if (!passkey && !zero) throw new Error('sol_ed25519: an RP hash belongs to a passkey grantee');
        if (passkey && spends) passkeyRpHash(o.rpIdHash, "sol_ed25519: a passkey grantee's RP hash is zero");
        if (!spends && !zero) throw new Error('sol_ed25519: a read-only grant carries no RP hash');
      }
      if (BigInt(o.recipientKind) === 0n && !o.recipient.every((b) => b === 0)) throw new Error('sol_ed25519: a recipient without a recipient kind');
      return head('Issue a scoped grant', 'device', c) + L('Consequence: lets the grantee key below spend from this account within these limits.')
        + granteeLines(o.grantee)
        + L('May withdraw unshielded: ', yesNo(o.opWithdrawUnshielded)) + L('May withdraw shielded: ', yesNo(o.opWithdrawShielded))
        + L('May withdraw shielded to a contract: ', yesNo(o.opWithdrawShieldedToContract)) + L('May read the inbox: ', yesNo(o.read))
        + L('Token: ', hex(o.color, 32, 'the token')) + L('Recipient kind: ', kindWord(o.recipientKind)) + L('Recipient: ', hex(o.recipient, 32, 'the recipient'))
        + L('Max coin value: ', decimal(o.maxCoinValue, 39)) + L('Per-call cap: ', decimal(o.perCallCap, 39)) + L('Total cap: ', decimal(o.cap, 39))
        + L('Expires at (block time, seconds): ', expiryShown(o.expiresAt)) + L('Expires at (UTC): ', expiryDateShown(o.expiresAt))
        + L('Passkey RP (hash): ', rpHashShown(o.rpIdHash))
        + L('Inbox read key: ', hex(o.readPk, 32, 'the read key')) + L('Window length: ', windowShown(o.windowLen)) + L('Window cap: ', windowCapShown(o.windowLen, o.windowCap))
        + L('Caller restricted to a contract: ', yesNo(o.caller !== null)) + L('Caller: ', hex(o.caller ?? Z32, 32, 'the caller')) + deviceTail(c);
    case 'revoke_grant':
      return head('Revoke a scoped grant', 'device', c) + L('Consequence: the grantee can no longer act under this grant.') + granteeLines(o.grantee) + deviceTail(c);
    case 'revoke_all_grants':
      return head('Revoke all scoped grants', 'device', c) + L('Consequence: every scoped grant of this account stops working.') + deviceTail(c);
    case 'publish_recovery_session': {
      let s = head('Publish a recovery session', 'device', c)
        + L("Consequence: sets this account's recovery key; its holder can take over this account after the veto window.")
        + L('Recovery key x: ', hex(le32(o.recoveryPk.x), 32, 'x')) + L('Recovery key y: ', hex(le32(o.recoveryPk.y), 32, 'y'))
        + L('Session nonce: ', hex(o.sessionNonce, 32, 'the session nonce'));
      o.phi.forEach((v, k) => { s += L(`Backup vector value ${k + 1} of 4: `, hex(le32(v), 32, 'a backup value')); });
      hex(o.wrap, 64, 'the key wrap');
      return s + L('Backup vector length: ', decimal(o.phiLen, 3)) + L('Key wrap part 1 of 2: ', hex(o.wrap.subarray(0, 32), 32, 'part 1'))
        + L('Key wrap part 2 of 2: ', hex(o.wrap.subarray(32), 32, 'part 2')) + deviceTail(c);
    }
    case 'recover_cancel':
      return head('Cancel a pending recovery', 'device', c) + L('Consequence: the pending recovery of this account is cancelled.') + deviceTail(c);
  }
}

/** The message of a grantee-role operation (text). */
export function solGranteeMessageText(c: SolGranteeContext, o: SolGranteeOperation): string {
  switch (o.op) {
    case 'withdraw_unshielded_with_grant':
      return head('Withdraw unshielded tokens under a grant', 'grantee', c) + amountLines(o.amount)
        + L('To unshielded address: ', hex(o.recipient, 32, 'the recipient')) + grantTail(c);
    case 'withdraw_shielded_with_grant':
    case 'withdraw_shielded_to_contract_with_grant': {
      const toContract = o.op === 'withdraw_shielded_to_contract_with_grant';
      return head(toContract ? 'Withdraw shielded tokens to a contract under a grant' : 'Withdraw shielded tokens under a grant', 'grantee', c)
        + amountLines(o.amount) + L(toContract ? 'To contract: ' : 'To shielded key: ', hex(o.recipient, 32, 'the recipient'))
        + entryLines(o.changeEntry, 'Change entry') + L('Change entry key: ', hex(o.encPk, 32, 'the change key'))
        + coinLines(o.coin, o.amount.amount) + grantTail(c);
    }
  }
}

/** The bytes of an approval text (ASCII), refused if it is not one, or if
 *  its raw message could be read as anything else a Solana wallet signs. */
export function solMessageBytes(text: string): Uint8Array {
  const b = enc.encode(text);
  assertSolText(b);
  assertSafeSolMessage(solSignedMessage('raw', new Uint8Array(32), b));
  return b;
}

/** An approval text: the format line first, printable ASCII and LF only,
 *  never the Sign-In With Solana statement. */
export function assertSolText(b: Uint8Array): void {
  const text = new TextDecoder().decode(b);
  if (!/^[\x20-\x7e\n]*$/.test(text)) throw new Error('sol message: not printable ASCII');
  if (!text.startsWith(SOL_FIRST_LINE)) throw new Error('sol message: does not start with the format line');
  if (/wants you to sign in with your Solana account/.test(text)) throw new Error('sol message: reads as Sign-In With Solana');
}

/** The 50-byte head of a format: the raw head, or the off-chain envelope
 *  (signing domain, version 1, one signer) naming `key`. */
export function solMessageHead(format: SolFormat, key: Uint8Array): Uint8Array {
  if (format === 'raw') return enc.encode(SOL_RAW_HEAD);
  if (format !== 'offchain') throw new Error(`sol message: unknown format ${String(format)}`);
  hex(key, 32, 'the signing key');
  return Uint8Array.of(...SOL_OFFCHAIN_DOMAIN, SOL_OFFCHAIN_VERSION, SOL_OFFCHAIN_SIGNERS, ...key);
}

/** What a wallet signs for an approval text in a format: the format's head,
 *  then the text. Refused unless the text is an approval text and the whole
 *  passes its format's check (assertSafeSolMessage, assertSolOffchainMessage). */
export function solSignedMessage(format: SolFormat, key: Uint8Array, text: Uint8Array): Uint8Array {
  assertSolText(text);
  const head = solMessageHead(format, key);
  const b = new Uint8Array(head.length + text.length);
  b.set(head); b.set(text, head.length);
  if (format === 'raw') assertSafeSolMessage(b); else assertSolOffchainMessage(b, key);
  return b;
}

/** A raw message (what `signMessage` signs: the raw head, then an approval
 *  text): never a Solana transaction, versioned message, off-chain message
 *  or Sign-In With Solana request. It starts with "Midn", so as a legacy
 *  message it would need SOL_PARSE_BOUND bytes (SOL-ED25519.md, "Never a
 *  Solana transaction or off-chain message"). */
export function assertSafeSolMessage(b: Uint8Array): void {
  if (new TextDecoder().decode(b.subarray(0, SOL_HEAD_LENGTH)) !== SOL_RAW_HEAD) throw new Error('sol message: does not start with the raw head');
  assertSolText(b.subarray(SOL_HEAD_LENGTH));
  if (b.length >= SOL_PARSE_BOUND) throw new Error(`sol message: ${b.length} bytes, at or above the parse bound ${SOL_PARSE_BOUND}`);
  if (b[0] >= 0x80 || b[0] === 0xff) throw new Error('sol message: versioned or off-chain prefix');
}

/** An off-chain message v1 (what an off-chain signer signs): the signing
 *  domain, version 1, exactly one signer, which is `key`, then an approval
 *  text. */
export function assertSolOffchainMessage(b: Uint8Array, key: Uint8Array): void {
  assertSolOffchainHead(b, key);
  assertSolText(b.subarray(SOL_HEAD_LENGTH));
}

/** The head of an off-chain message v1: the signing domain, version 1, and
 *  exactly one signer, which is `key`. */
function assertSolOffchainHead(b: Uint8Array, key: Uint8Array): void {
  hex(key, 32, 'the signing key');
  const d = SOL_OFFCHAIN_DOMAIN.length;
  if (b.length < SOL_HEAD_LENGTH || !SOL_OFFCHAIN_DOMAIN.every((x, i) => b[i] === x)) throw new Error('sol message: not an off-chain message');
  if (b[d] !== SOL_OFFCHAIN_VERSION) throw new Error(`sol message: off-chain message version ${b[d]}, not ${SOL_OFFCHAIN_VERSION}`);
  if (b[d + 1] !== SOL_OFFCHAIN_SIGNERS) throw new Error(`sol message: ${b[d + 1]} off-chain signers, not ${SOL_OFFCHAIN_SIGNERS}`);
  if (!key.every((x, i) => b[d + 2 + i] === x)) throw new Error('sol message: the off-chain envelope names another signer');
}

/** The format of bytes built for signing (an approval or a blind request):
 *  an off-chain message begins with the signing domain's 0xff, which no raw
 *  message can (assertSafeSolMessage, assertSolBlindRequest). A wallet
 *  adapter uses it to ask the wallet for that format, and refuses one the
 *  wallet cannot sign. */
export function solFormatOfSigned(b: Uint8Array): SolFormat {
  if (!(b instanceof Uint8Array) || b.length === 0) throw new Error('sol message: nothing to sign');
  return b[0] === SOL_OFFCHAIN_DOMAIN[0] ? 'offchain' : 'raw';
}

/** The first lines of the two blind requests (blind.ts): the device's and
 *  the grantee's. */
const BLIND_FIRST_LINES = [
  `Midnight Passport account privacy key (v${BLIND_MESSAGE_VERSION})`,
  `Midnight Passport grantee privacy key (v${GRANTEE_BLIND_MESSAGE_VERSION})`,
];

/** A blind request text (blind.ts): printable ASCII and LF only, its first
 *  line one of the two requests', so never an approval text (whose first
 *  line is SOL_FIRST_LINE), and, as a raw message, never anything else a
 *  Solana wallet signs: it starts with "Midn" and stays below
 *  SOL_PARSE_BOUND. */
export function assertSolBlindRequest(b: Uint8Array): void {
  const text = new TextDecoder().decode(b);
  if (!/^[\x20-\x7e\n]*$/.test(text)) throw new Error('sol message: a blind request is printable ASCII');
  if (!BLIND_FIRST_LINES.includes(text.split('\n')[0])) throw new Error('sol message: not a blind request');
  if (b.length >= SOL_PARSE_BOUND) throw new Error(`sol message: ${b.length} bytes, at or above the parse bound ${SOL_PARSE_BOUND}`);
}

/** What a wallet signs for a blind request (device or grantee) in a format:
 *  raw, the request's bytes unchanged (so a raw blind stays the blind it has
 *  always been); off-chain, the off-chain v1 head naming `key`, then the
 *  same bytes. The blind depends on the format: a device is usable only with
 *  the blind of the format it was enrolled in. */
export function solBlindSignedMessage(format: SolFormat, key: Uint8Array, request: Uint8Array): Uint8Array {
  assertSolBlindRequest(request);
  if (format === 'raw') return new Uint8Array(request);
  if (format !== 'offchain') throw new Error(`sol message: unknown format ${String(format)}`);
  const head = solMessageHead('offchain', key);
  const b = new Uint8Array(head.length + request.length);
  b.set(head); b.set(request, head.length);
  assertSolOffchainHead(b, key);
  return b;
}

// ── The circuits' display inputs and target structs ────────────────────────

const ascii = (s: string) => [...enc.encode(s)].map(BigInt);
const padTag32 = (tag: string) => {
  if (tag === '') return new Uint8Array(32); // no target (the literal removal)
  const b = enc.encode(tag);
  if (b.length > 32 || !/^[\x21-\x7e]+$/.test(tag)) throw new Error('sol message: bad tag');
  const o = new Uint8Array(32);
  o.set(b);
  return o;
};

const chars = (b: Uint8Array) => [...b].map(BigInt);

/** SolShow: the site's label characters (zero-padded) and the nonce's digits. */
export const solShow = (site: string, nonce: bigint) => ({ site: chars(labelBytes(site)), nonce: digitsOf(nonce, 20) });
/** SolGrantShow: the grant label's characters, the slot and issued_at digits. */
export const solGrantShow = (label: string, slot: bigint, issuedAt: bigint) => ({ label: chars(labelBytes(label)), slot: digitsOf(slot, 3), issued: digitsOf(issuedAt, 20) });
/** SolAmountShow: the amount's digits and the site's claim. */
export const solAmountShow = (a: SolAmount) => ({ units: digitsOf(a.amount, 39), claim: ascii(claimText(a.amount, a.decimals, a.symbol)) });
/** SolCoinShow: a spent coin's value, index and the change. */
export const solCoinShow = (coin: SolCoin, amount: bigint) => ({
  value: digitsOf(coin.value, 39), index: digitsOf(coin.mt_index, 20), change: digitsOf(coin.value - amount, 39),
});
/** SolTargetShow / SolGranteeShow / SolScopeShow. */
/** SolBase58: a 32-byte key's base58 digits and read-back hints. */
export const solBase58 = (b: Uint8Array) => base58Inputs(b);
/** The key a target's or grantee's message shows in base58: the 32 bytes of
 *  a kind of the ed25519 class, zero for every other kind (and for a tag no
 *  kind lists), as the circuit's sol_target_key_bytes and
 *  sol_grantee_key_bytes. */
const shownKey = (t: SolTargetFields, recipe: 'device' | 'grant-id') =>
  (SOL_KINDS.some((k) => k.keyClass === 'ed25519' && DESCRIPTOR_TAGS[recipe][k.scheme] === t.tag) ? t.a ?? new Uint8Array(32) : new Uint8Array(32));
export const solTargetShow = (t: SolTargetFields, counter = 0n, epoch = 0n) => ({
  counter: digitsOf(counter, 20), epoch: digitsOf(epoch, 10), origin: chars(t.origin ?? new Uint8Array(21)),
  key: solBase58(shownKey(t, 'device')),
});
export const solGranteeShow = (g: SolGranteeFields) => ({
  slot: digitsOf(g.slot, 3),
  label: chars(g.label !== undefined ? labelBytes(g.label) : new Uint8Array(32)), origin: chars(g.origin ?? new Uint8Array(21)),
  key: solBase58(shownKey(g, 'grant-id')),
});
export const solScopeShow = (o: { maxCoinValue: bigint; perCallCap: bigint; cap: bigint; expiresAt: bigint; windowLen: bigint; windowCap: bigint }) => {
  const d = utcDateTimeInputs(o.expiresAt);
  return {
    max_coin: digitsOf(o.maxCoinValue, 39), per_call: digitsOf(o.perCallCap, 39), cap: digitsOf(o.cap, 39),
    expires: digitsOf(o.expiresAt, 20), expires_utc: d.text, expires_split: d.yearSplit, window: digitsOf(o.windowLen, 20), window_cap: digitsOf(o.windowCap, 39),
  };
};

// ── The hex display inputs ───────────────────────────────────────────────
//
// `frame`: the account's nibbles and the signing key's base58 inputs (the
// seam renders them). `hex`: the nibbles of every other value the message shows in hex, in
// the order of the layout table (SOL-ED25519.md), each value in its stored
// byte order (curve coordinates little-endian; Field values as their
// canonical 32-byte little-endian encoding), each byte high nibble first.

const le32 = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } if (x) throw new Error('sol message: value above 32 bytes'); return o; };
/** The nibbles of byte strings, concatenated (high nibble first). */
export function nibblesOf(...values: Uint8Array[]): bigint[] {
  const out: bigint[] = [];
  for (const v of values) for (const b of v) out.push(BigInt(b >> 4), BigInt(b & 15));
  return out;
}
/** The frame (SolFrame): the account's nibbles and the signing key's base58
 *  inputs. */
export const solFrameNibbles = (account: Uint8Array, key: Uint8Array) => ({ account: nibblesOf(account), key: solBase58(key) });
/** The other values a device-role message shows in hex, in its layout order. */
export function solDeviceHexValues(o: SolDeviceOperation): Uint8Array[] {
  const head: Uint8Array[] = [];
  const t = (x: SolTargetFields) => [x.address ?? new Uint8Array(20), x.a ?? new Uint8Array(32), x.b ?? new Uint8Array(32), x.c ?? new Uint8Array(32)];
  const g = (x: SolGranteeFields) => [x.address ?? new Uint8Array(20), x.a ?? new Uint8Array(32), x.b ?? new Uint8Array(32), x.originHash ?? new Uint8Array(32)];
  switch (o.op) {
    case 'rotate_enc_key': return [...head, o.newKey];
    case 'append_inbox': return [...head, o.entry];
    case 'withdraw_unshielded': return [...head, o.amount.color, o.recipient];
    case 'withdraw_shielded': case 'withdraw_shielded_to_contract': return [...head, o.amount.color, o.recipient, o.coin.nonce];
    case 'add_device': return [...head, ...t(o.target)];
    case 'remove_device': {
      if (o.literal) return [...head, ...t({ tag: '' }), (o as Extract<SolDeviceOperation, { literal: true }>).entry];
      return [...head, ...t((o as Extract<SolDeviceOperation, { literal: false }>).target), new Uint8Array(32)];
    }
    case 'issue_grant': return [...head, ...g(o.grantee), o.color, o.recipient, o.rpIdHash, o.readPk, o.caller ?? new Uint8Array(32)];
    case 'revoke_grant': return [...head, ...g(o.grantee)];
    case 'revoke_all_grants': case 'recover_cancel': return head;
    case 'publish_recovery_session': return [...head, le32(o.recoveryPk.x), le32(o.recoveryPk.y), o.sessionNonce, ...o.phi.map(le32), o.wrap];
  }
}
/** The other values a grantee-role message shows in hex, in its layout order. */
export function solGranteeHexValues(o: SolGranteeOperation): Uint8Array[] {
  if (o.op === 'withdraw_unshielded_with_grant') return [o.amount.color, o.recipient];
  return [o.amount.color, o.recipient, o.changeEntry, o.encPk, o.coin.nonce];
}

/** The unused point of a target or grantee whose kind is not of the ed25519
 *  class: the identity (x = 0). */
export const SOL_UNUSED_POINT = Object.freeze({ x: 0n, y: 1n });
/** The unused key argument of a target or grantee whose kind is not of the
 *  ed25519 class: the identity and zero bytes. */
export const solUnusedKey = () => ({ pk: { ...SOL_UNUSED_POINT }, pk_bytes: new Array<bigint>(32).fill(0n), pk_x: new Array<bigint>(32).fill(0n) });
const le32b = (v: bigint): bigint[] => { const out: bigint[] = []; let x = v; for (let i = 0; i < 32; i++) { out.push(x & 0xffn); x >>= 8n; } return out; };
/** The device and grant-id tags of the kinds of the ed25519 class: a target
 *  or grantee of these is also passed as its point. */
const SOL_POINT_TAGS = new Set(SOL_KINDS.filter((k) => k.keyClass === 'ed25519')
  .flatMap((k) => [DESCRIPTOR_TAGS.device[k.scheme], DESCRIPTOR_TAGS['grant-id'][k.scheme]]));
/** An ed25519-class target's point: the 32 bytes decoded strictly
 *  (canonical, on the curve, prime-order subgroup, not the identity); the
 *  circuit derives the bytes back from it and requires them to equal `a`. */
export function solTargetPoint(key: Uint8Array): { x: bigint; y: bigint } {
  const p = ed25519.Point.fromBytes(parseSolanaPublicKey(key), false).toAffine();
  return { x: p.x, y: p.y };
}
/** The key argument beside a target or grantee struct (the circuit's
 *  SolKey): an ed25519-class key's point with its 32 bytes and its
 *  x-coordinate's bytes little-endian; the identity and zero bytes for every
 *  other class. */
export const solTargetPointArg = (t: { tag: string; a?: Uint8Array }) => {
  if (!SOL_POINT_TAGS.has(t.tag)) return solUnusedKey();
  const key = t.a ?? new Uint8Array(32);
  const pk = solTargetPoint(key);
  return { pk, pk_bytes: Array.from(key, (b) => BigInt(b)), pk_x: le32b(pk.x) };
};

/** The circuit's SolTarget for a device target (unused fields zero). */
export function solTargetArg(t: SolTargetFields) {
  return { tag: padTag32(t.tag), address: t.address ?? new Uint8Array(20), a: t.a ?? new Uint8Array(32), b: t.b ?? new Uint8Array(32),
    c: t.c ?? new Uint8Array(32), origin: t.origin ?? new Uint8Array(21), envelope: t.envelope ?? 0n };
}
/** The circuit's SolGrantee for a grantee (unused fields zero). */
export function solGranteeArg(g: SolGranteeFields) {
  return { tag: padTag32(g.tag), address: g.address ?? new Uint8Array(20), a: g.a ?? new Uint8Array(32), b: g.b ?? new Uint8Array(32),
    envelope: g.envelope ?? 0n, label: g.label !== undefined ? labelBytes(g.label) : new Uint8Array(32), origin: g.origin ?? new Uint8Array(21),
    origin_hash: g.originHash ?? new Uint8Array(32), slot: g.slot };
}
