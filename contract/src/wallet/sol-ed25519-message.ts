// Arm `sol_ed25519`: the signed messages, format sol v1, rendered
// independently of the contract.
//
// The contract renders every message in-circuit (`sol_message_<operation>`
// in contracts/account-sol-ed25519.compact) and verifies the wallet's
// signature over exactly those bytes. This module renders the same bytes
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
import { DESCRIPTOR_TAGS, parseSolanaPublicKey } from './descriptors.js';
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

// The class each registered tag selects (the circuits' sol_device_class and
// sol_grantee_class), from the base's tag registry.
const DEVICE_TAGS: Record<string, number> = {
  [DESCRIPTOR_TAGS.device.evm_eip712]: 0, [DESCRIPTOR_TAGS.device.jubjub]: 1, [DESCRIPTOR_TAGS.device.sol_ed25519]: 2,
  [DESCRIPTOR_TAGS.device.k256]: 3, [DESCRIPTOR_TAGS.device.p256]: 4,
};
const GRANT_TAGS: Record<string, number> = {
  [DESCRIPTOR_TAGS['grant-id'].evm_eip712]: 0, [DESCRIPTOR_TAGS['grant-id'].jubjub]: 1, [DESCRIPTOR_TAGS['grant-id'].sol_ed25519]: 2,
  [DESCRIPTOR_TAGS['grant-id'].k256]: 3, [DESCRIPTOR_TAGS['grant-id'].p256]: 4,
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

/** The device target's key lines (282 bytes). */
function deviceBlock(t: SolTargetFields): string {
  const cls = DEVICE_TAGS[t.tag];
  if (cls === undefined) throw new Error('descriptor: not a registered device tag');
  const a = t.a ?? Z32, b = t.b ?? Z32;
  switch (cls) {
    case 0: return padBlock(L('Ethereum address: 0x', hex(t.address ?? Z20, 20, 'the address')) + L('Device privacy salt: ', hex(a, 32, 'the blind')), 282);
    case 1: return padBlock(L('JubJub key x: ', hex(a, 32, 'x')) + L('JubJub key y: ', hex(b, 32, 'y')), 282);
    case 2: return padBlock(L('Solana key: ', b58(a, 'the key')) + L('Device privacy salt: ', hex(b, 32, 'the blind')), 282);
    case 3: return padBlock(L('secp256k1 key x: ', hex(reversed(a), 32, 'x')) + L('secp256k1 key y: ', hex(reversed(b), 32, 'y'))
      + L('Signing envelope: ', envelopeLabel(t.envelope ?? 0n)), 282);
    default: return padBlock(L('Passkey key x: ', hex(reversed(a), 32, 'x')) + L('Passkey key y: ', hex(reversed(b), 32, 'y'))
      + L('Passkey origin: ', visible(t.origin ?? Z21)) + L('Passkey RP (hash): ', passkeyRpHash(t.c ?? Z32, "descriptor: a passkey's RP hash is zero")), 282);
  }
}

/** The grantee's key and origin lines (299 bytes). */
function granteeBlock(t: SolGranteeFields): string {
  const cls = GRANT_TAGS[t.tag];
  if (cls === undefined) throw new Error('descriptor: not a registered grant-id tag');
  const a = t.a ?? Z32, b = t.b ?? Z32;
  const lab = () => labelText(labelBytes(t.label ?? ''));
  switch (cls) {
    case 0: return padBlock(L('Ethereum address: 0x', hex(t.address ?? Z20, 20, 'the address')) + L('Grantee privacy salt: ', hex(a, 32, 'the blind'))
      + L('Grantee label: ', lab()), 299);
    case 1: return padBlock(L('JubJub key x: ', hex(a, 32, 'x')) + L('JubJub key y: ', hex(b, 32, 'y'))
      + L('Grantee site label (hash): ', hex(t.originHash ?? Z32, 32, 'the origin hash')), 299);
    case 2: return padBlock(L('Solana key: ', b58(a, 'the key')) + L('Grantee privacy salt: ', hex(b, 32, 'the blind'))
      + L('Grantee label: ', lab()), 299);
    case 3: return padBlock(L('secp256k1 key x: ', hex(reversed(a), 32, 'x')) + L('secp256k1 key y: ', hex(reversed(b), 32, 'y'))
      + L('Signing envelope: ', envelopeLabel(t.envelope ?? 0n)) + L('Grantee site label (hash): ', hex(t.originHash ?? Z32, 32, 'the origin hash')), 299);
    default: return padBlock(L('Passkey key x: ', hex(reversed(a), 32, 'x')) + L('Passkey key y: ', hex(reversed(b), 32, 'y'))
      + L('Passkey origin: ', visible(t.origin ?? Z21)), 299);
  }
}
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
        const cls = GRANT_TAGS[o.grantee.tag];
        if (cls === undefined) throw new Error('descriptor: not a registered grant-id tag');
        // the RP hash is non-zero exactly for a passkey grantee whose scope
        // can spend: first, an RP hash belongs to a passkey grantee; then a
        // spending passkey grant carries one and a read-only grant none
        const spends = o.opWithdrawUnshielded || o.opWithdrawShielded || o.opWithdrawShieldedToContract;
        const zero = o.rpIdHash.every((b) => b === 0);
        if (cls !== 4 && !zero) throw new Error('sol_ed25519: an RP hash belongs to a passkey grantee');
        if (cls === 4 && spends) passkeyRpHash(o.rpIdHash, "sol_ed25519: a passkey grantee's RP hash is zero");
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

/** The bytes of a message (ASCII), refused if it could be read as anything
 *  else a Solana wallet signs. */
export function solMessageBytes(text: string): Uint8Array {
  if (!/^[\x20-\x7e\n]*$/.test(text)) throw new Error('sol message: not printable ASCII');
  const b = enc.encode(text);
  assertSafeSolMessage(b);
  return b;
}

/** Never a Solana transaction, versioned message, off-chain message
 *  or Sign-In With Solana request. */
export function assertSafeSolMessage(b: Uint8Array): void {
  const first = new TextDecoder().decode(b.subarray(0, SOL_FIRST_LINE.length));
  if (first !== SOL_FIRST_LINE) throw new Error('sol message: does not start with the format line');
  if (b.length >= SOL_PARSE_BOUND) throw new Error(`sol message: ${b.length} bytes, at or above the parse bound ${SOL_PARSE_BOUND}`);
  if (b[0] >= 0x80 || b[0] === 0xff) throw new Error('sol message: versioned or off-chain prefix');
  if (/wants you to sign in with your Solana account/.test(new TextDecoder().decode(b))) throw new Error('sol message: reads as Sign-In With Solana');
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
/** The key a target's or grantee's message shows in base58: a Solana key's
 *  32 bytes, zero for every other class. */
const shownKey = (t: SolTargetFields, solTag: string) => (t.tag === solTag ? t.a ?? new Uint8Array(32) : new Uint8Array(32));
export const solTargetShow = (t: SolTargetFields, counter = 0n, epoch = 0n) => ({
  counter: digitsOf(counter, 20), epoch: digitsOf(epoch, 10), origin: chars(t.origin ?? new Uint8Array(21)),
  key: solBase58(shownKey(t, DESCRIPTOR_TAGS.device.sol_ed25519)),
});
export const solGranteeShow = (g: SolGranteeFields) => ({
  slot: digitsOf(g.slot, 3),
  label: chars(g.label !== undefined ? labelBytes(g.label) : new Uint8Array(32)), origin: chars(g.origin ?? new Uint8Array(21)),
  key: solBase58(shownKey(g, DESCRIPTOR_TAGS['grant-id'].sol_ed25519)),
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

/** The unused point of a non-Solana target: the identity (x = 0). */
export const SOL_UNUSED_POINT = Object.freeze({ x: 0n, y: 1n });
/** The unused key argument of a non-Solana target or grantee: the identity
 *  and zero bytes. */
export const solUnusedKey = () => ({ pk: { ...SOL_UNUSED_POINT }, pk_bytes: new Array<bigint>(32).fill(0n), pk_x: new Array<bigint>(32).fill(0n) });
const le32b = (v: bigint): bigint[] => { const out: bigint[] = []; let x = v; for (let i = 0; i < 32; i++) { out.push(x & 0xffn); x >>= 8n; } return out; };
const SOL_POINT_TAGS = new Set([DESCRIPTOR_TAGS.device.sol_ed25519, DESCRIPTOR_TAGS['grant-id'].sol_ed25519]);
/** A Solana target's point: the 32 bytes decoded strictly
 *  (canonical, on the curve, prime-order subgroup, not the identity); the
 *  circuit derives the bytes back from it and requires them to equal `a`. */
export function solTargetPoint(key: Uint8Array): { x: bigint; y: bigint } {
  const p = ed25519.Point.fromBytes(parseSolanaPublicKey(key), false).toAffine();
  return { x: p.x, y: p.y };
}
/** The key argument beside a target or grantee struct (the circuit's
 *  SolKey): a Solana key's point with its 32 bytes and its x-coordinate's
 *  bytes little-endian; the identity and zero bytes for every other class. */
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
