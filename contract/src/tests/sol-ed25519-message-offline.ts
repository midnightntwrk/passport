// Arm `sol_ed25519`: the signed messages (format sol v1), offline.
//
// The contract's `sol_message_<operation>` pure circuits against the
// independent TypeScript renderer (src/wallet/sol-ed25519-message.ts), byte
// for byte, over a corpus covering all 15 layouts, both roles, every target
// class, and edge values (0, 1, 2^64 - 1, 2^128 - 1, 18 decimals, 8-character
// symbols, 32-byte labels). Also: every layout has one fixed length; every
// raw message (the raw head, then the text) and every raw blind request is
// below the Solana parse bound and parses as no Solana transaction or
// message; every off-chain message parses as an off-chain message v1 naming
// the signing key, and as no transaction; every line starts with circuit-fixed text; a site
// label changes only the Site line; display inputs that do not describe the
// value are refused by the circuit (runtime) and by the renderer (client).
// The corpus is frozen in src/tests/vectors/sol-ed25519-messages-v1.json:
// a run compares against it, or writes it when SOL_MESSAGES_WRITE=1.
//
// Writes $EVIDENCE_DIR/sol-ed25519-message-offline.json when set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { pureCircuits } from '../wallet/contract.js';
import { NEVER_TEXT, NOT_APPLICABLE_TEXT } from '../wallet/rendering.js';
import { COORDINATE_DISPLAY_ORDER, coordinateHex } from '../wallet/descriptors.js';
import { solBlindMessage, solDeviceMessageCircuit, solGranteeMessageCircuit } from '../wallet/signer-sol-ed25519.js';
import { granteeBlindMessageBytes } from '../wallet/blind.js';
import {
  SOL_FIRST_LINE, SOL_HEAD_LENGTH, SOL_OFFCHAIN_DOMAIN, SOL_PARSE_BOUND, SOL_RAW_HEAD, assertSafeSolMessage, assertSolBlindRequest, assertSolOffchainMessage, solSignedMessage, claimText, digitsOf, labelBytes, nibblesOf, solAmountShow, solBase58, solCoinShow, solDeviceMessageText, solFrameNibbles,
  solGranteeArg, solGranteeMessageText, solGranteeShow, solGrantShow, solMessageBytes, solScopeShow, solShow,
  solTargetArg, solTargetShow, type SolAmount, type SolCoin, type SolDeviceContext, type SolDeviceOperation,
  type SolGranteeContext, type SolGranteeFields, type SolGranteeOperation, type SolTargetFields,
} from '../wallet/sol-ed25519-message.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FROZEN = path.join(HERE, 'vectors', 'sol-ed25519-messages-v1.json');
const pc: any = pureCircuits;

interface Case { group: string; name: string; verdict: 'PASS' | 'FAIL'; layer?: string; detail?: string }
const cases: Case[] = [];
const ok = (group: string, name: string, cond: boolean, detail?: string, layer?: string) => {
  cases.push({ group, name, verdict: cond ? 'PASS' : 'FAIL', ...(layer ? { layer } : {}), ...(detail ? { detail } : {}) });
  if (!cond) console.log(`  ✗ ${group}: ${name}${detail ? ` — ${detail}` : ''}`);
};
const refused = (group: string, name: string, layer: string, re: RegExp, fn: () => unknown) => {
  try { fn(); ok(group, name, false, 'accepted (expected a refusal)', layer); } catch (e: any) {
    // Source positions name the checkout path, so strip them before cutting
    // the text (the frozen negatives must not depend on where the clone is).
    const m = String(e?.message ?? e); ok(group, name, re.test(m), m.replace(/ at [\w./-]+\.compact line \d+ char \d+/g, '').slice(0, 160), layer);
  }
};

// Deterministic test bytes.
const det = (seed: string, n: number) => {
  const out = new Uint8Array(n); let h = createHash('sha256').update(seed).digest(); let i = 0;
  while (i < n) { out.set(h.subarray(0, Math.min(32, n - i)), i); i += 32; h = createHash('sha256').update(h).digest(); }
  return out;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const MAX64 = (1n << 64n) - 1n, MAX128 = (1n << 128n) - 1n;
const le32 = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const FIELD_MAX = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000000n;

const SITES = ['Example Wallet', 'a', 'Site: Add a device', 'Consequence: none', 'x'.repeat(32), 'Account 00 nonce 1'];
const AMOUNTS: SolAmount[] = [
  { color: det('c1', 32), amount: 1_000_000n, decimals: 6, symbol: 'tUSDC' },
  { color: new Uint8Array(32), amount: 0n, decimals: 0, symbol: 'NIGHT' },
  { color: det('c3', 32), amount: MAX128, decimals: 18, symbol: 'ABCDEFGH' },
  { color: det('c4', 32), amount: 5n, decimals: 18, symbol: 'x?' },
];
const coinFor = (a: SolAmount, extra: bigint, idx: bigint): SolCoin => ({ nonce: det(`n${extra}`, 32), color: a.color, value: a.amount + extra > MAX128 ? MAX128 : a.amount + extra, mt_index: idx });

// 32-byte values whose base58 texts have leading "1"s (one per leading zero
// byte), the shortest (all zero: 32 "1"s) and the longest (all 0xff: 44).
const LEAD3 = Uint8Array.from([0, 0, 0, ...det('lead3', 29)]);
const ZERO32 = new Uint8Array(32), FF32 = new Uint8Array(32).fill(255);
const TARGETS: SolTargetFields[] = [
  { tag: 'midnight:account:device:evm:v1', address: det('evm', 20), a: det('blind-e', 32) },
  { tag: 'midnight:account:device:v1', a: det('jx', 32), b: det('jy', 32) },
  { tag: 'midnight:account:device:sol:v1', a: ed25519.getPublicKey(det('sk', 32)), b: det('blind-s', 32) }, // a real key (a Solana target is a point)
  { tag: 'midnight:account:device:k1:v2', a: det('kx', 32), b: det('ky', 32), envelope: 1n },
  { tag: 'midnight:account:device:r1:v2', a: det('rx', 32), b: det('ry', 32), c: det('rp', 32), origin: new TextEncoder().encode('https://a.example.com') },
];
const GRANTEES: SolGranteeFields[] = [
  { tag: 'midnight:account:grant:id:evm:v1', address: det('gevm', 20), a: det('gblind-e', 32), label: 'Example dApp', slot: 0n },
  { tag: 'midnight:account:grant:id:v1', a: det('gjx', 32), b: det('gjy', 32), originHash: det('goh-j', 32), slot: 7n },
  { tag: 'midnight:account:grant:id:sol:v1', a: ed25519.getPublicKey(det('gsk', 32)), b: det('gblind-s', 32), label: 'x'.repeat(32), slot: 255n },
  { tag: 'midnight:account:grant:id:k1:v1', a: det('gkx', 32), b: det('gky', 32), envelope: 0n, originHash: det('goh-k', 32), slot: 1n },
  { tag: 'midnight:account:grant:id:r1:v1', a: det('grx', 32), b: det('gry', 32), origin: new TextEncoder().encode('https://b.example.org'), slot: 2n },
];

type Built = { name: string; op: string; text: string; circuit: Uint8Array; key: Uint8Array };
const corpus: Built[] = [];

// The contract side: the facade's calls of the contract's pure circuits.
const deviceCall = (ctx: SolDeviceContext, o: SolDeviceOperation): Uint8Array =>
  solDeviceMessageCircuit(ctx.key, { contractAddress: ctx.account, authNonce: ctx.nonce }, ctx.site, o).bytes;
const granteeCall = (ctx: SolGranteeContext, o: SolGranteeOperation): Uint8Array =>
  solGranteeMessageCircuit(ctx.key, { contractAddress: ctx.account, label: ctx.label, slot: ctx.slot, issuedAt: ctx.issuedAt, grantNonce: ctx.nonce }, ctx.site, o).bytes;

// ── 1. The corpus: circuit == renderer ──────────────────────────────────────
const devCtx = (i: number): SolDeviceContext => ({ site: SITES[i % SITES.length], account: det(`acct${i}`, 32), key: det(`key${i}`, 32), nonce: [0n, 1n, 17n, MAX64][i % 4] });
const grCtx = (i: number): SolGranteeContext => ({ ...devCtx(i), label: ['Example dApp', 'z', 'x'.repeat(32)][i % 3], slot: [0n, 3n, 255n][i % 3], issuedAt: [0n, 5n, MAX64][i % 3] });
const devOps: [string, SolDeviceOperation][] = [];
devOps.push(['rotate_enc_key', { op: 'rotate_enc_key', newKey: det('nk', 32) }]);
devOps.push(['rotate_enc_key zero', { op: 'rotate_enc_key', newKey: new Uint8Array(32) }]);
devOps.push(['append_inbox', { op: 'append_inbox', entry: det('entry', 192) }]);
devOps.push(['append_inbox 0xff', { op: 'append_inbox', entry: new Uint8Array(192).fill(255) }]);
AMOUNTS.forEach((a, i) => {
  devOps.push([`withdraw_unshielded ${i}`, { op: 'withdraw_unshielded', amount: a, recipient: det(`ru${i}`, 32) }]);
  devOps.push([`withdraw_shielded ${i}`, { op: 'withdraw_shielded', amount: a, recipient: det(`rs${i}`, 32), coin: coinFor(a, BigInt(i) * 7n, BigInt(i) * 1000n) }]);
  devOps.push([`withdraw_shielded_to_contract ${i}`, { op: 'withdraw_shielded_to_contract', amount: a, recipient: det(`rc${i}`, 32), coin: coinFor(a, 0n, MAX64) }]);
});
TARGETS.forEach((t) => {
  devOps.push([`add_device ${t.tag}`, { op: 'add_device', target: t }]);
  devOps.push([`remove_device ${t.tag}`, { op: 'remove_device', literal: false, target: t, counter: 4n, epoch: 1n }]);
});
devOps.push(['remove_device max counter/epoch', { op: 'remove_device', literal: false, target: TARGETS[2], counter: MAX64, epoch: 0xffffffffn }]);
devOps.push(['remove_device literal', { op: 'remove_device', literal: true, entry: det('lit', 32) }]);
// readability edge values, appended after the calls above so that those keep
// their contexts: Solana keys with leading zero bytes; a grant's expiry at
// the edges of the UTC date (0 is "never"; above 9999-12-31 23:59:59 the
// words "after 9999-12-31 23:59:59 UTC")
GRANTEES.forEach((g, i) => {
  // every grantee class with a spending scope; the passkey grantee (4) shows
  // its RP hash, the others "not applicable"; every call is one upstream's
  // issue rules admit (a spend carries non-zero caps)
  const spend = true;
  devOps.push([`issue_grant ${g.tag}`, { op: 'issue_grant', grantee: g, opWithdrawUnshielded: spend, opWithdrawShielded: i % 2 === 0, opWithdrawShieldedToContract: i === 2,
    read: i % 2 === 0, color: det(`gc${i}`, 32), recipientKind: BigInt(i % 4), recipient: i % 4 === 0 ? new Uint8Array(32) : det(`gr${i}`, 32),
    maxCoinValue: [MAX128, 1000n, 1n, 50n, 1000n][i], perCallCap: [MAX128, 100n, 1n, 50n, 100n][i], cap: [MAX128, 1000n, 1n, 100n, 1000n][i],
    expiresAt: [0n, 1_800_000_000n, MAX64, 1n, 0n][i], rpIdHash: i === 4 ? det('rph', 32) : new Uint8Array(32), readPk: i % 2 === 0 ? det(`rk${i}`, 32) : new Uint8Array(32),
    windowLen: 0n, windowCap: 0n, caller: i === 1 ? det('caller', 32) : null }]);
  devOps.push([`revoke_grant ${g.tag}`, { op: 'revoke_grant', grantee: g }]);
});
devOps.push(['revoke_all_grants', { op: 'revoke_all_grants' }]);
devOps.push(['publish_recovery_session', { op: 'publish_recovery_session', recoveryPk: pc.compute_public_point_with_jubjub(5n), sessionNonce: det('sn', 32), phi: [1n, FIELD_MAX, 0n, 0n], phiLen: 2n, wrap: det('wrap', 64) }]);
devOps.push(['publish_recovery_session 4', { op: 'publish_recovery_session', recoveryPk: pc.compute_public_point_with_jubjub(FIELD_MAX), sessionNonce: det('sn4', 32), phi: [5n, 6n, 7n, 8n], phiLen: 4n, wrap: new Uint8Array(64) }]);
devOps.push(['recover_cancel', { op: 'recover_cancel' }]);
// A read-only grant to a passkey carries no RP hash ("not applicable");
// appended last so that the earlier calls keep their contexts (devCtx(i))
devOps.push(['issue_grant passkey read-only (no RP hash)', { op: 'issue_grant', grantee: { ...GRANTEES[4], slot: 3n }, opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false,
  read: true, color: new Uint8Array(32), recipientKind: 0n, recipient: new Uint8Array(32), maxCoinValue: 0n, perCallCap: 0n, cap: 0n, expiresAt: 0n,
  rpIdHash: new Uint8Array(32), readPk: det('rk-ro', 32), windowLen: 0n, windowCap: 0n, caller: null }]);
devOps.push(['add_device a Solana target with three leading zero bytes', { op: 'add_device', target: { tag: 'midnight:account:device:sol:v1', a: LEAD3, b: det('blind-lz', 32) } }]);
devOps.push(['revoke_grant a Solana grantee with three leading zero bytes', { op: 'revoke_grant', grantee: { tag: 'midnight:account:grant:id:sol:v1', a: LEAD3, b: det('gblind-lz', 32), label: 'Lead', slot: 1n } }]);
for (const v of [1n, 2147483647n, 2147483648n, 951782400n, 4107542399n, 4107542400n, 1794840710n, 253402300799n, 253402300800n]) {
  devOps.push([`issue_grant expiry ${v}`, { op: 'issue_grant', grantee: { ...GRANTEES[0], slot: 9n }, opWithdrawUnshielded: false, opWithdrawShielded: false,
    opWithdrawShieldedToContract: false, read: true, color: new Uint8Array(32), recipientKind: 0n, recipient: new Uint8Array(32), maxCoinValue: 0n, perCallCap: 0n,
    cap: 0n, expiresAt: v, rpIdHash: new Uint8Array(32), readPk: det(`rk-e${v}`, 32), windowLen: 0n, windowCap: 0n, caller: null }]);
}
devOps.push(['rotate_enc_key, a signing key with three leading zero bytes', { op: 'rotate_enc_key', newKey: det('nk-lz', 32) }]);
devOps.push(['rotate_enc_key, an all-zero signing key (32 "1"s)', { op: 'rotate_enc_key', newKey: det('nk-z', 32) }]);
devOps.push(['rotate_enc_key, an all-0xff signing key (44 characters)', { op: 'rotate_enc_key', newKey: det('nk-f', 32) }]);
/** The signing key of the calls that test it. */
const KEY_OF: Record<string, Uint8Array> = {
  'rotate_enc_key, a signing key with three leading zero bytes': LEAD3,
  'rotate_enc_key, an all-zero signing key (32 "1"s)': ZERO32,
  'rotate_enc_key, an all-0xff signing key (44 characters)': FF32,
};
const grOps: [string, SolGranteeOperation][] = [];
AMOUNTS.forEach((a, i) => {
  grOps.push([`withdraw_unshielded_with_grant ${i}`, { op: 'withdraw_unshielded_with_grant', amount: a, recipient: det(`gru${i}`, 32) }]);
  grOps.push([`withdraw_shielded_with_grant ${i}`, { op: 'withdraw_shielded_with_grant', amount: a, recipient: det(`grs${i}`, 32), changeEntry: det(`ce${i}`, 192), encPk: det(`ek${i}`, 32), coin: coinFor(a, 9n, BigInt(i)) }]);
  grOps.push([`withdraw_shielded_to_contract_with_grant ${i}`, { op: 'withdraw_shielded_to_contract_with_grant', amount: a, recipient: det(`grc${i}`, 32), changeEntry: det(`cc${i}`, 192), encPk: det(`ec${i}`, 32), coin: coinFor(a, 0n, MAX64) }]);
});

{
  const G = '1 circuit == renderer';
  let n = 0;
  devOps.forEach(([name, o], i) => {
    const ctx = { ...devCtx(i), ...(KEY_OF[name] ? { key: KEY_OF[name] } : {}) };
    const text = solDeviceMessageText(ctx, o);
    const circuit: Uint8Array = deviceCall(ctx, o);
    const same = Buffer.from(circuit).toString('latin1') === text;
    if (same) n++; else ok(G, name, false, `circuit ${circuit.length} B vs renderer ${text.length} B`);
    corpus.push({ name, op: o.op, text, circuit, key: ctx.key });
  });
  grOps.forEach(([name, o], i) => {
    const ctx = grCtx(i);
    const text = solGranteeMessageText(ctx, o);
    const circuit: Uint8Array = granteeCall(ctx, o);
    const same = Buffer.from(circuit).toString('latin1') === text;
    if (same) n++; else ok(G, name, false, `circuit ${circuit.length} B vs renderer ${text.length} B`);
    corpus.push({ name, op: o.op, text, circuit, key: ctx.key });
  });
  ok(G, `all ${corpus.length} calls byte-identical (15 layouts, both roles, 5 target classes, 5 grantee classes, edge values)`, n === corpus.length, `${n}/${corpus.length}`);
}

// ── 1b. Coordinates and Field values in the shared display order ───────────
// The approvals of every arm and the base's comparison
// display (descriptors.ts, COORDINATE_DISPLAY_ORDER) show secp256k1 and P-256
// coordinates big-endian, JubJub coordinates and Field values little-endian.
// Every coordinate line of the contract's own bytes must equal the base's
// rendering of the same value, so a key reads the same in every client.
{
  const G = '1b shared display order';
  const leInt = (b: Uint8Array) => b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
  const SCHEME: Record<string, ['jubjub' | 'k256' | 'p256', string]> = {
    'midnight:account:device:v1': ['jubjub', 'JubJub key'], 'midnight:account:grant:id:v1': ['jubjub', 'JubJub key'],
    'midnight:account:device:k1:v2': ['k256', 'secp256k1 key'], 'midnight:account:grant:id:k1:v1': ['k256', 'secp256k1 key'],
    'midnight:account:device:r1:v2': ['p256', 'Passkey key'], 'midnight:account:grant:id:r1:v1': ['p256', 'Passkey key'],
  };
  let checked = 0, bad = 0;
  const seen = new Set<string>();
  devOps.forEach(([name, o], i) => {
    const lines = Buffer.from(corpus[i].circuit).toString('latin1').split('\n').map((l) => l.trimEnd());
    const expect: string[] = [];
    const key = (t: { tag: string; a?: Uint8Array; b?: Uint8Array }) => {
      const s = SCHEME[t.tag];
      if (!s) return;
      seen.add(s[0]);
      expect.push(`${s[1]} x: ${coordinateHex(s[0], leInt(t.a!)).slice(2)}`, `${s[1]} y: ${coordinateHex(s[0], leInt(t.b!)).slice(2)}`);
    };
    const op: any = o;
    if (op.op === 'add_device' || (op.op === 'remove_device' && !op.literal)) key(op.target);
    if (op.op === 'issue_grant' || op.op === 'revoke_grant') key(op.grantee);
    if (op.op === 'publish_recovery_session') {
      seen.add('field');
      expect.push(`Recovery key x: ${coordinateHex('jubjub', op.recoveryPk.x).slice(2)}`, `Recovery key y: ${coordinateHex('jubjub', op.recoveryPk.y).slice(2)}`);
      op.phi.forEach((v: bigint, k: number) => expect.push(`Backup vector value ${k + 1} of 4: ${hex(le32(v))}`));
    }
    for (const e of expect) {
      checked++;
      if (!lines.includes(e)) { bad++; ok(G, `${name}: ${e.slice(0, 24)}`, false, 'not shown in the shared display order'); }
    }
  });
  ok(G, `every coordinate and Field value of the corpus equals the base's rendering (${checked} lines: ${[...seen].join(', ')})`,
    bad === 0 && ['jubjub', 'k256', 'p256', 'field'].every((x) => seen.has(x)));
  ok(G, 'the base display order (JubJub little-endian; secp256k1 and P-256 big-endian)',
    COORDINATE_DISPLAY_ORDER.jubjub === 'little-endian' && COORDINATE_DISPLAY_ORDER.k256 === 'big-endian' && COORDINATE_DISPLAY_ORDER.p256 === 'big-endian');
}

// ── 2. Lengths, parse safety, line starts ───────────────────────────────────
const LINE_STARTS = [
  'Midnight Passport approval (sol v1)', 'Operation: ', 'Site: ', 'Role: ', 'Account: ', 'Signing key: ', 'New encryption key: ', 'Consequence: ',
  'Device nonce: ', 'Inbox entry ', 'Token: ', 'Amount (base units): ', 'This site labels it: ', 'To unshielded address: ', 'To shielded key: ',
  'To contract: ', 'Spent coin value: ', 'Spent coin nonce: ', 'Spent coin index: ', 'Change back to this account: ', 'Device scheme: ',
  'Ethereum address: 0x', 'Device privacy salt: ', 'Grantee privacy salt: ', 'JubJub key x: ', 'JubJub key y: ', 'Solana key: ', 'secp256k1 key x: ', 'secp256k1 key y: ',
  'Signing envelope: ', 'Passkey key x: ', 'Passkey key y: ', 'Passkey origin: ', 'Passkey RP (hash): ', 'Device use counter: ', 'Device epoch: ',
  'Removes a device this wallet cannot identify', 'Device entry: ', 'Grantee scheme: ', 'Grantee label: ', 'Grantee site label (hash): ',
  'Grantee slot: ', 'May withdraw unshielded: ', 'May withdraw shielded: ', 'May withdraw shielded to a contract: ', 'May read the inbox: ',
  'Recipient kind: ', 'Recipient: ', 'Max coin value: ', 'Per-call cap: ', 'Total cap: ', 'Expires at (block time, seconds): ', 'Expires at (UTC): ',
  'Inbox read key: ', 'Window length: ', 'Window cap: ', 'Caller restricted to a contract: ', 'Caller: ', 'Recovery key x: ', 'Recovery key y: ',
  'Session nonce: ', 'Backup vector value ', 'Backup vector length: ', 'Key wrap part ', 'Change entry ', 'Grant label: ', 'Grant slot: ',
  'Grant issued at nonce: ', 'Grant use nonce: ',
];
const lengths: Record<string, number> = {};
// What the wallets sign for each corpus text: the raw message and the
// off-chain message (the signer is the text's own signing key).
const rawOf = (c: Built) => solSignedMessage('raw', c.key, c.circuit);
const offOf = (c: Built) => solSignedMessage('offchain', c.key, c.circuit);
// The raw blind requests (unchanged texts, signed as they are) at their
// longest: a 32-character network name, the largest account index, a key
// whose base58 text is 44 characters, the issuing account in full hex.
const LONG_NETWORK = 'n'.repeat(32), MAX_INDEX = 0xffffffffn;
const key44 = (() => { for (let i = 0; ; i++) { const k = ed25519.getPublicKey(det(`blind-request-key-${i}`, 32)); if (base58Len(k) === 44) return k; } })();
function base58Len(k: Uint8Array): number { let v = 0n; for (const b of k) v = (v << 8n) | BigInt(b); let n = 0; while (v > 0n) { v /= 58n; n++; } let z = 0; while (z < k.length && k[z] === 0) z++; return n + z; }
const blindRequests: { name: string; bytes: Uint8Array }[] = [
  { name: 'device blind request, longest', bytes: solBlindMessage(key44, { network: LONG_NETWORK, accountIndex: MAX_INDEX }).bytes },
  { name: 'device blind request, undeployed, index 0', bytes: solBlindMessage(key44, { network: 'undeployed', accountIndex: 0 }).bytes },
  { name: 'grantee blind request, longest', bytes: granteeBlindMessageBytes({ scheme: 'sol_ed25519', network: LONG_NETWORK, identity: key44, issuingAccount: det('issuer', 32) }) },
];
{
  const G = '2 lengths, parse bound, line starts';
  let fixed = true, safe = true, starts = true;
  for (const c of corpus) {
    const key = c.op + (c.op.endsWith('_with_grant') ? '' : '');
    if (lengths[key] === undefined) lengths[key] = c.text.length; else if (lengths[key] !== c.text.length) { fixed = false; ok(G, `fixed length ${c.name}`, false, `${c.text.length} vs ${lengths[key]}`); }
    try { assertSafeSolMessage(rawOf(c)); assertSolOffchainMessage(offOf(c), c.key); solMessageBytes(c.text); } catch (e: any) { safe = false; ok(G, `parse-safe ${c.name}`, false, e.message); }
    for (const line of c.text.split('\n')) if (!LINE_STARTS.some((p) => line.startsWith(p))) { starts = false; ok(G, `line start in ${c.name}`, false, JSON.stringify(line.slice(0, 50))); }
  }
  ok(G, `one fixed length per layout (${Object.keys(lengths).length} layouts)`, fixed && Object.keys(lengths).length === 15);
  const max = Math.max(...Object.values(lengths));
  const maxRaw = Math.max(...corpus.map((c) => rawOf(c).length));
  ok(G, `every raw message is the raw head, then the text, below the parse bound (longest ${SOL_HEAD_LENGTH} + ${max} = ${maxRaw} < ${SOL_PARSE_BOUND})`,
    safe && maxRaw === SOL_HEAD_LENGTH + max && maxRaw < SOL_PARSE_BOUND && corpus.every((c) => Buffer.from(rawOf(c).subarray(0, SOL_HEAD_LENGTH)).toString('latin1') === SOL_RAW_HEAD));
  const maxBlind = Math.max(...blindRequests.map((r) => r.bytes.length));
  ok(G, `every raw blind request starts with "Midn" and is below the parse bound (longest ${maxBlind} < ${SOL_PARSE_BOUND})`,
    blindRequests.every((r) => Buffer.from(r.bytes.subarray(0, 4)).toString('latin1') === 'Midn') && maxBlind < SOL_PARSE_BOUND);
  ok(G, 'every line of every message starts with circuit-fixed text', starts);
  ok(G, 'the parse bound is 3 + 1 + 110*32 + 32 + 1 = 3,557 for a message starting "Midn"', SOL_PARSE_BOUND === 3557 && 'Midn'.charCodeAt(3) === 110);
  ok(G, 'the raw head is 50 ASCII bytes starting "Midn" and ending in LF', SOL_RAW_HEAD.length === SOL_HEAD_LENGTH && SOL_RAW_HEAD.startsWith('Midn') && SOL_RAW_HEAD.endsWith('\n')
    && Buffer.from(SOL_RAW_HEAD, 'latin1').toString('hex') === '4d69646e696768742050617373706f72742c20536f6c616e61207369676e4d65737361676520666f726d617420287631290a');
  ok(G, 'every off-chain message is ff "solana offchain" 01 01, the signing key, then the text (50-byte head)', corpus.every((c) => {
    const b = offOf(c);
    return Buffer.from(b.subarray(0, 18)).toString('hex') === 'ff736f6c616e61206f6666636861696e0101' && Buffer.from(b.subarray(18, 50)).equals(Buffer.from(c.key))
      && Buffer.from(b.subarray(50)).equals(Buffer.from(c.circuit));
  }));
}

// ── 2b. An independent parse of Solana's wire formats ───────────────────────
// Legacy message: header (num_required_signatures, num_readonly_signed,
// num_readonly_unsigned), compact-u16 key count, keys (32 each), recent
// blockhash (32), compact-u16 instruction count, instructions (program index,
// compact-u16 account count, indices, compact-u16 data length, data), nothing
// left over. Transaction: compact-u16 signature count, signatures (64 each),
// then a message (legacy, or versioned when the first byte has bit 7 set).
function cu16(b: Uint8Array, i: number): [number, number] | null {
  let v = 0;
  for (let k = 0; k < 3; k++) {
    if (i + k >= b.length) return null;
    const x = b[i + k];
    v |= (x & 0x7f) << (7 * k);
    if (!(x & 0x80)) return [v, i + k + 1];
  }
  return null;
}
function parseLegacyMessage(b: Uint8Array, start = 0): { ok: boolean; sanitized: boolean; end: number } {
  let i = start;
  if (b.length < i + 3) return { ok: false, sanitized: false, end: i };
  const [req, ros, rou] = [b[i], b[i + 1], b[i + 2]]; i += 3;
  const n = cu16(b, i); if (!n) return { ok: false, sanitized: false, end: i };
  const [keys, j] = n; i = j + keys * 32 + 32;
  if (i > b.length) return { ok: false, sanitized: false, end: i };
  const m = cu16(b, i); if (!m) return { ok: false, sanitized: false, end: i };
  let [ix, k] = m; i = k;
  for (let t = 0; t < ix; t++) {
    i += 1; const a = cu16(b, i); if (!a) return { ok: false, sanitized: false, end: i }; i = a[1] + a[0];
    const d = cu16(b, i); if (!d) return { ok: false, sanitized: false, end: i }; i = d[1] + d[0];
    if (i > b.length) return { ok: false, sanitized: false, end: i };
  }
  const ok = i === b.length;
  // Message::sanitize: a writable fee payer (num_readonly_signed < num_required)
  // and enough keys for the signers and the read-only unsigned ones.
  return { ok, sanitized: ok && ros < req && req + rou <= keys, end: i };
}
function parsesAsTransaction(b: Uint8Array): boolean {
  const n = cu16(b, 0); if (!n) return false;
  const i = n[1] + n[0] * 64; if (i >= b.length) return false;
  return (b[i] & 0x80) ? false : parseLegacyMessage(b, i).ok;
}
// Off-chain message v1: the signing domain (0xff "solana offchain"), the
// version byte, the signer count, the signers (32 bytes each), then the
// message, with nothing else.
function parseOffchainV1(b: Uint8Array): { ok: boolean; signers: Uint8Array[]; message: Uint8Array } {
  const d = SOL_OFFCHAIN_DOMAIN.length;
  if (b.length < d + 2 || !SOL_OFFCHAIN_DOMAIN.every((x, i) => b[i] === x) || b[d] !== 1) return { ok: false, signers: [], message: new Uint8Array() };
  const n = b[d + 1], start = d + 2 + 32 * n;
  if (n === 0 || b.length <= start) return { ok: false, signers: [], message: new Uint8Array() };
  return { ok: true, signers: Array.from({ length: n }, (_, i) => b.subarray(d + 2 + 32 * i, d + 34 + 32 * i)), message: b.subarray(start) };
}
{
  const G = '2b Solana wire formats (independent parser)';
  const raws = [...corpus.map(rawOf), ...blindRequests.map((r) => r.bytes)];
  ok(G, `no raw message (${corpus.length}) and no raw blind request (${blindRequests.length}) parses as a legacy message, a versioned message or a transaction`, raws.every((m) =>
    !parseLegacyMessage(m).ok && !(m[0] & 0x80) && !parsesAsTransaction(m) && m[0] !== 0xff));
  const offs = corpus.map(offOf);
  ok(G, `every off-chain message (${offs.length}) parses as an off-chain message v1 with one signer, the signing key, and the text as its message`, corpus.every((c, i) => {
    const r = parseOffchainV1(offs[i]);
    return r.ok && r.signers.length === 1 && Buffer.from(r.signers[0]).equals(Buffer.from(c.key)) && Buffer.from(r.message).equals(Buffer.from(c.circuit));
  }));
  ok(G, 'no off-chain message parses as a transaction (its first two bytes claim 14,847 signatures) or as a legacy message; as a message its first byte is a version-127 prefix',
    offs.every((m) => !parsesAsTransaction(m) && !parseLegacyMessage(m).ok && (m[0] & 0x80) && (m[0] & 0x7f) === 127) && cu16(offs[0], 0)![0] === 14847);
  const first = rawOf(corpus[0]).subarray(0, 4);
  const at = (n: number) => { const b = new Uint8Array(n); b.set(first); return b; };
  ok(G, `the bound is tight: a "Midn" buffer of ${SOL_PARSE_BOUND} bytes parses as a legacy message, ${SOL_PARSE_BOUND - 1} bytes does not`,
    parseLegacyMessage(at(SOL_PARSE_BOUND)).ok && !parseLegacyMessage(at(SOL_PARSE_BOUND - 1)).ok);
  ok(G, 'and even then it never sanitizes: header (77, 105, 100) has no writable fee payer (105 >= 77)', !parseLegacyMessage(at(SOL_PARSE_BOUND)).sanitized);
  ok(G, 'as a transaction a "Midn" prefix claims 77 signatures (4,928 bytes before the message)', cu16(first, 0)![0] === 77);
  // the client's guards at the bound itself: a raw approval and a raw blind
  // request that would parse as a legacy message are refused, one byte
  // shorter they are not (each otherwise well formed: printable ASCII after
  // its fixed start)
  const filled = (start: Uint8Array, n: number) => { const b = new Uint8Array(n).fill(0x41); b.set(start); return b; };
  const approval = new TextEncoder().encode(`${SOL_RAW_HEAD}${SOL_FIRST_LINE}\n`);
  const request = blindRequests[1].bytes;
  const passes = (f: (b: Uint8Array) => void, b: Uint8Array) => { try { f(b); return true; } catch { return false; } };
  ok(G, `a raw approval of ${SOL_PARSE_BOUND} bytes (the raw head, then a printable approval text) is refused by the client; ${SOL_PARSE_BOUND - 1} bytes is accepted`,
    !passes(assertSafeSolMessage, filled(approval, SOL_PARSE_BOUND)) && passes(assertSafeSolMessage, filled(approval, SOL_PARSE_BOUND - 1)));
  ok(G, `a raw blind request of ${SOL_PARSE_BOUND} bytes is refused by the client; ${SOL_PARSE_BOUND - 1} bytes is accepted`,
    !passes(assertSolBlindRequest, filled(request, SOL_PARSE_BOUND)) && passes(assertSolBlindRequest, filled(request, SOL_PARSE_BOUND - 1)));
}

// ── 3. The site's label changes only the Site line ──────────────────────────
{
  const G = '3 site label isolation';
  let good = true;
  for (const site of SITES.slice(1)) {
    const a = solDeviceMessageText(devCtx(0), devOps[0][1]);
    const ctx = { ...devCtx(0), site };
    const circuit = Buffer.from(deviceCall(ctx, devOps[0][1])).toString('latin1');
    const la = a.split('\n'), lb = circuit.split('\n');
    const diffs = la.map((l, i) => (l === lb[i] ? -1 : i)).filter((i) => i >= 0);
    if (!(diffs.length === 1 && la[diffs[0]].startsWith('Site: '))) good = false;
  }
  ok(G, 'another label changes the Site line only, and an imitating label stays after "Site: "', good);
}

// ── 4. Display inputs that do not describe the value ────────────────────────
{
  const G = '4 display-input refusals';
  const ctx = devCtx(1), self = { bytes: ctx.account };
  const a = AMOUNTS[0];
  const recipient = det('r', 32);
  const good = solAmountShow(a);
  const goodFrame = solFrameNibbles(ctx.account, ctx.key);
  const goodHex = nibblesOf(a.color, recipient);
  const run = (show: any, amountShow: any, hex: bigint[] = goodHex, frame: any = goodFrame) =>
    pc.sol_message_withdraw_unshielded(self, ctx.key, ctx.nonce, a.color, a.amount, { bytes: recipient }, amountShow, show, frame, hex);
  const asc = (s: string, w: number) => [...Buffer.from(s.padEnd(w, ' '), 'ascii')].map(BigInt);
  const site = (s: string) => { const o = new Array(32).fill(0n); [...Buffer.from(s, 'latin1')].forEach((c, i) => { if (i < 32) o[i] = BigInt(c); }); return o; };
  const base = solShow(ctx.site, ctx.nonce);
  ok(G, 'positive control: the honest inputs render', run(base, good).length === 600);
  const fk = goodFrame.key;
  const digitsWith = (i: number, d: bigint) => ({ ...goodFrame, key: { ...fk, digits: fk.digits.map((x, j) => (j === i ? d : x)) } });
  const lastDigit = fk.digits.reduce((m, d, j) => (d !== 58n ? j : m), 0);
  const bad: [string, any, any, bigint[] | undefined, RegExp, any?][] = [
    ['amount digits of another value', base, { ...good, units: asc('1000001', 39) }, undefined, /digits do not match/],
    ['amount with a leading zero', base, { ...good, units: asc('01000000', 39) }, undefined, /leading zero|digits do not match/],
    ['amount right-aligned', base, { ...good, units: asc('', 32).concat(asc('1000000', 7)) }, undefined, /not a left-aligned decimal|empty decimal/],
    ['claim digits of another value', base, { ...good, claim: asc('1.000001 tUSDC', 49) }, undefined, /the site amount label does not match the value/],
    ['claim with a leading zero', base, { ...good, claim: asc('01.000000 tUSDC', 49) }, undefined, /leading zero in the site amount label/],
    ['claim with 19 decimals', base, { ...good, claim: asc('0.0000000000001000000 tUSDC', 49) }, undefined, /more than 18 decimals/],
    ['claim symbol of 9 characters', base, { ...good, claim: asc('1.000000 ABCDEFGHI', 49) }, undefined, /symbol longer than 8/],
    ['claim symbol starting with a digit (a number-like word: "1 000")', base, { ...good, claim: asc('1 000000', 49) }, undefined, /does not start with a letter|the site amount label does not match the value/],
    ['claim symbol starting with a digit after the real number', base, { ...good, claim: asc('1.000000 000', 49) }, undefined, /does not start with a letter/],
    ['claim symbol starting with a point', base, { ...good, claim: asc('1.000000 .5', 49) }, undefined, /does not start with a letter/],
    ['claim with a line break', base, { ...good, claim: asc('1.000000 tUS\nDC', 49) }, undefined, /not a site amount label/],
    ['nonce digits of another value', { ...base, nonce: asc('2', 20) }, good, undefined, /digits do not match/],
    ['site label with a leading space', { ...base, site: site(' Example') }, good, undefined, /not a zero-padded label/],
    ['site label with two spaces', { ...base, site: site('Example  Wallet') }, good, undefined, /not a zero-padded label/],
    ['site label with a line break', { ...base, site: site('Example\nDevice nonce: 0') }, good, undefined, /not a zero-padded label/],
    ['site label with a byte after the padding', { ...base, site: [...site('Example'), ].map((c, i) => (i === 20 ? 65n : c)) }, good, undefined, /not a zero-padded label/],
    ['empty site label', { ...base, site: new Array(32).fill(0n) }, good, undefined, /not a zero-padded label/],
    ['frame nibbles of another account', base, good, undefined, /hex digits do not match/, { ...goodFrame, account: nibblesOf(det('other', 32)) }],
    ["the signing key's base58 text of another key", base, good, undefined, /base58 digits do not match|base58 carry hints/, { ...goodFrame, key: solBase58(det('other key', 32)) }],
    ["the signing key's base58 text with one digit changed", base, good, undefined, /base58 digits do not match|base58 carry hints/, digitsWith(5, (fk.digits[5] + 1n) % 58n)],
    ["the signing key's base58 text with a digit outside the alphabet (59)", base, good, undefined, /not a left-aligned base58 text/, digitsWith(3, 59n)],
    ["the signing key's base58 text with padding before its last character", base, good, undefined, /not a left-aligned base58 text/, digitsWith(lastDigit - 1, 58n)],
    ["the signing key's base58 text with a leading 1 its key does not have", base, good, undefined, /leading base58 ones|base58 digits do not match|not a left-aligned/,
      { ...goodFrame, key: { ...fk, digits: [0n, ...fk.digits.slice(0, 43)] } }],
    ['hex nibbles off by one in the recipient', base, good, goodHex.map((n, i) => (i === goodHex.length - 1 ? (n + 1n) % 16n : n)), /hex digits do not match/],
    ['hex nibble 16 (not a nibble)', base, good, goodHex.map((n, i) => (i === 0 ? 16n : n)), /type error|Uint<0..16>|out of range|expected/i],
    ['frame nibble 16 (not a nibble)', base, good, undefined, /type error|Uint<0..16>|out of range|expected/i, { ...goodFrame, account: goodFrame.account.map((n, i) => (i === 0 ? 16n : n)) }],
  ];
  for (const [name, show, amountShow, hex, re, frame] of bad) refused(G, `${name}: circuit`, 'runtime', re, () => run(show, amountShow, hex, frame));
  refused(G, 'site label with a line break: renderer', 'client', /label/, () => labelBytes('Example\nDevice'));
  refused(G, 'claim symbol starting with a digit: renderer', 'client', /first a letter/, () => claimText(1n, 0, '000'));
  refused(G, 'site label longer than 32 bytes: renderer', 'client', /at most 32/, () => labelBytes('x'.repeat(33)));
  const ig = devOps.find(([n]) => n.startsWith('issue_grant'))![1] as any;
  refused(G, 'unknown recipient kind: circuit', 'runtime', /unknown recipient kind/, () => deviceCall(devCtx(0), { ...ig, recipientKind: 4n }));
  refused(G, 'unregistered target tag: circuit', 'runtime', /not a registered device tag/, () => {
    const c0 = devCtx(0); const t = { ...TARGETS[2], tag: 'midnight:account:device:ed:v1' };
    return pc.sol_message_add_device({ bytes: c0.account }, c0.key, c0.nonce, { ...solTargetArg(TARGETS[2]), tag: (() => { const o = new Uint8Array(32); o.set(Buffer.from(t.tag)); return o; })() },
      solTargetShow(TARGETS[2]), solShow(c0.site, c0.nonce), solFrameNibbles(c0.account, c0.key), nibblesOf(new Uint8Array(20), TARGETS[2].a!, TARGETS[2].b!, new Uint8Array(32)));
  });
  refused(G, 'passkey origin characters of another origin: circuit', 'runtime', /characters do not match/, () => {
    const c0 = devCtx(0); const t = TARGETS[4];
    return pc.sol_message_add_device({ bytes: c0.account }, c0.key, c0.nonce, solTargetArg(t), { ...solTargetShow(t), origin: [...Buffer.from('https://b.example.com')].map(BigInt) },
      solShow(c0.site, c0.nonce), solFrameNibbles(c0.account, c0.key), nibblesOf(new Uint8Array(20), t.a!, t.b!, t.c!));
  });
  refused(G, 'non-visible passkey origin: circuit', 'runtime', /not visible ASCII/, () => deviceCall(devCtx(0), { op: 'add_device', target: { ...TARGETS[4], origin: new TextEncoder().encode('https://a example.com') } }));
  refused(G, 'grant label characters of another label: circuit', 'runtime', /characters do not match/, () => {
    const c = grCtx(0), o = grOps[0][1] as any;
    return pc.sol_message_withdraw_unshielded_with_grant({ bytes: c.account }, c.key, labelBytes(c.label), c.slot, c.issuedAt, c.nonce, o.amount.color, o.amount.amount,
      { bytes: o.recipient }, solAmountShow(o.amount), solShow(c.site, c.nonce), { ...solGrantShow(c.label, c.slot, c.issuedAt), label: [...labelBytes('Another dApp')].map(BigInt) },
      solFrameNibbles(c.account, c.key), nibblesOf(o.amount.color, o.recipient));
  });
  {
    const c0 = devCtx(0), coin = { ...coinFor(AMOUNTS[0], 0n, 0n), value: 1n };
    const coinShow = { value: digitsOf(1n, 39), index: digitsOf(0n, 20), change: digitsOf(0n, 39) };
    refused(G, 'withdrawal above the spent coin: circuit', 'runtime', /above the spent coin/, () => pc.sol_message_withdraw_shielded(
      { bytes: c0.account }, c0.key, c0.nonce, { bytes: det('x', 32) }, AMOUNTS[0].color, AMOUNTS[0].amount, coin, solAmountShow(AMOUNTS[0]), coinShow,
      solShow(c0.site, c0.nonce), solFrameNibbles(c0.account, c0.key), nibblesOf(AMOUNTS[0].color, det('x', 32), coin.nonce)));
    refused(G, 'withdrawal above the spent coin: renderer', 'client', /above the spent coin/, () => solDeviceMessageText(c0, { op: 'withdraw_shielded', amount: AMOUNTS[0], recipient: det('x', 32), coin }));
  }
}

// ── 6. Numbers in full digits and the exact words ───────────────────────────
{
  const G = '6 digits and words';
  // every amount and cap line is "<label><39 digits>", no magnitude
  const AMOUNT = /^(Amount \(base units\)|Spent coin value|Change back to this account|Max coin value|Per-call cap|Total cap): (.*)$/;
  let lines = 0, good = true;
  for (const c of corpus) {
    for (const line of c.text.split('\n')) {
      const m = AMOUNT.exec(line);
      if (!m) continue;
      lines++;
      if (!/^[0-9]+ *$/.test(m[2]) || m[2].length !== 39) { good = false; ok(G, `amount line in ${c.name}`, false, JSON.stringify(line)); }
    }
  }
  ok(G, `every amount and cap line shows its base units in full, 39 digits, no magnitude (${lines} lines)`, good && lines > 0 && corpus.every((c) => !/~[0-9]\.[0-9]{2} x 10\^/.test(c.text)));
  const issueAll = corpus.filter((c) => c.op === 'issue_grant');
  const issue = issueAll.slice(0, 6);
  const expiryOf = (t: string) => /\nExpires at \(block time, seconds\): (.{20})\n/.exec(t)?.[1];
  ok(G, 'issue_grant: an expiry of 0 reads "never", every other expiry its seconds (the label carries no "; 0 = never")',
    issueAll.length === 15 && expiryOf(issue[0].text) === NEVER_TEXT.padEnd(20) && expiryOf(issue[4].text) === NEVER_TEXT.padEnd(20)
    && expiryOf(issue[1].text) === '1800000000'.padEnd(20) && expiryOf(issue[3].text) === '1'.padEnd(20) && issue.every((c) => !c.text.includes('0 = never')));
  const rpOf = (t: string) => /\nPasskey RP \(hash\): (.{64})\n/.exec(t)?.[1];
  ok(G, 'issue_grant: a non-passkey grantee\'s (zero) RP hash reads "not applicable"; a spending passkey grant shows its hash in 64 hex digits; a read-only passkey grant reads "not applicable"',
    issue.slice(0, 4).every((c) => rpOf(c.text) === NOT_APPLICABLE_TEXT.padEnd(64)) && rpOf(issue[4].text) === hex(det('rph', 32)) && rpOf(issue[5].text) === NOT_APPLICABLE_TEXT.padEnd(64));
  // the UTC date beside the seconds, from an independent rendering (Date):
  // "never" for 0, the words above 9999-12-31 23:59:59
  const utcOf = (t: string) => /\nExpires at \(UTC\): (.{29})\n/.exec(t)?.[1];
  const utcExpected = (v: bigint) => v === 0n ? 'never' : v > 253402300799n ? 'after 9999-12-31 23:59:59 UTC'
    : new Date(Number(v) * 1000).toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC');
  const expiryValue = (t: string) => { const e = expiryOf(t)!.trim(); return e === 'never' ? 0n : BigInt(e); };
  let utcBad = 0;
  for (const c of issueAll) if (utcOf(c.text) !== utcExpected(expiryValue(c.text)).padEnd(29)) { utcBad++; ok(G, `UTC date in ${c.name}`, false, JSON.stringify(utcOf(c.text))); }
  ok(G, `issue_grant: the expiry's UTC date equals an independent rendering, "never" for 0, the words above year 9999 (${issueAll.length} messages incl. 1, 2^31 - 1, 2^31, 2000-02-29, 2100-02-28/03-01, 9999-12-31 23:59:59 and one second later)`,
    utcBad === 0 && issueAll.some((c) => utcOf(c.text)!.startsWith('2000-02-29 00:00:00 UTC')) && issueAll.some((c) => utcOf(c.text)!.startsWith('2100-03-01 00:00:00 UTC'))
    && issueAll.some((c) => utcOf(c.text)!.startsWith('9999-12-31 23:59:59 UTC')) && issueAll.some((c) => utcOf(c.text) === 'after 9999-12-31 23:59:59 UTC'));
  // a zero window (every grant: the scoped-grants MIP reserves the window
  // fields) reads "no window" on both lines
  ok(G, 'issue_grant: a zero window reads "no window" on the length and the cap line',
    issueAll.every((c) => c.text.includes('\nWindow length: ' + 'no window'.padEnd(20) + '\n') && c.text.includes('\nWindow cap: ' + 'no window'.padEnd(39) + '\n')));
  // Solana keys in base58, from an independent encoder (Bitcoin alphabet, a
  // "1" per leading zero byte)
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (b: Uint8Array) => { let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let o = ''; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } let z = 0; while (z < b.length && b[z] === 0) z++; return '1'.repeat(z) + o; };
  let keyBad = 0;
  for (const c of corpus) if (!c.text.includes('\nSigning key: ' + b58(c.key).padEnd(44) + '\n')) { keyBad++; ok(G, `signing key in ${c.name}`, false); }
  ok(G, `every message shows its signing key in base58, as Solana wallets show it, space-padded to 44 (${corpus.length} messages)`, keyBad === 0);
  const lead = (name: string) => corpus.find((c) => c.name === name)!;
  ok(G, 'base58 edges: three leading zero bytes show "111", an all-zero key 32 "1"s, an all-0xff key 44 characters',
    /\nSigning key: 111[^1]/.test(lead('rotate_enc_key, a signing key with three leading zero bytes').text)
    && lead('rotate_enc_key, an all-zero signing key (32 "1"s)').text.includes('\nSigning key: ' + '1'.repeat(32) + ' '.repeat(12) + '\n')
    && b58(FF32).length === 44 && lead('rotate_enc_key, an all-0xff signing key (44 characters)').text.includes('\nSigning key: ' + b58(FF32) + '\n'));
  const solShown = corpus.filter((c) => /Solana key: /.test(c.text));
  ok(G, `a Solana target or grantee shows its key in base58 (${solShown.length} messages, incl. a key with three leading zero bytes); no Solana key appears in hex`,
    solShown.length >= 6 && solShown.every((c) => { const m = /\nSolana key: (.{44})\n/.exec(c.text); return !!m && /^[1-9A-HJ-NP-Za-km-z]+ *$/.test(m[1]); })
    && lead('add_device a Solana target with three leading zero bytes').text.includes('\nSolana key: ' + b58(LEAD3).padEnd(44) + '\n')
    && lead('revoke_grant a Solana grantee with three leading zero bytes').text.includes('\nSolana key: ' + b58(LEAD3).padEnd(44) + '\n')
    && corpus.every((c) => !c.text.includes('Solana key: ' + hex(ZERO32).slice(0, 8))));
  const pk = corpus.filter((c) => /^(add|remove)_device midnight:account:device:r1:v2$/.test(c.name));
  ok(G, 'device block: a passkey target shows its RP hash in hex, never a word (685 and 761 bytes)',
    pk.length === 2 && pk.every((c) => rpOf(c.text) === hex(det('rp', 32))) && pk[0].text.length === 685 && pk[1].text.length === 761 && corpus.every((c) => !c.op.endsWith('_device') || !c.text.includes('not applicable')));
  // a zero passkey RP hash, a recipient without a kind: the renderer builds no such message
  const zeroPk = { ...TARGETS[4], c: new Uint8Array(32) };
  refused(G, "add_device of a passkey target with an all-zero RP hash: renderer", 'client', /a passkey's RP hash is zero/, () => solDeviceMessageText(devCtx(0), { op: 'add_device', target: zeroPk }));
  refused(G, "remove_device by descriptor of a passkey target with an all-zero RP hash: renderer", 'client', /a passkey's RP hash is zero/, () =>
    solDeviceMessageText(devCtx(0), { op: 'remove_device', literal: false, target: zeroPk, counter: 0n, epoch: 0n }));
  const igP = devOps.find(([n]) => n === 'issue_grant midnight:account:grant:id:r1:v1')![1] as any;
  refused(G, "issue_grant, a spending grant to a passkey grantee with an all-zero RP hash: renderer", 'client', /a passkey grantee's RP hash is zero/, () =>
    solDeviceMessageText(devCtx(0), { ...igP, rpIdHash: new Uint8Array(32) }));
  const igRO = devOps.find(([n]) => n.startsWith('issue_grant passkey read-only'))![1] as any;
  refused(G, 'issue_grant, a read-only grant to a passkey grantee carrying an RP hash: renderer', 'client', /a read-only grant carries no RP hash/, () =>
    solDeviceMessageText(devCtx(0), { ...igRO, rpIdHash: det('rph', 32) }));
  const ig0 = devOps.find(([n]) => n === 'issue_grant midnight:account:grant:id:evm:v1')![1] as any;
  // an unregistered tag: the renderer refuses it with the circuit's message
  refused(G, 'add_device of an unregistered device tag: renderer (the circuit\'s message)', 'client', /^descriptor: not a registered device tag$/, () =>
    solDeviceMessageText(devCtx(0), { op: 'add_device', target: { ...TARGETS[1], tag: 'midnight:account:device:zz:v1' } }));
  refused(G, 'revoke_grant of an unregistered grant-id tag: renderer (the circuit\'s message)', 'client', /^descriptor: not a registered grant-id tag$/, () =>
    solDeviceMessageText(devCtx(0), { op: 'revoke_grant', grantee: { ...GRANTEES[1], tag: 'midnight:account:grant:id:zz:v1' } }));
  // the circuit's first issue rule (the read key), first in the renderer too
  refused(G, 'issue_grant, a read key without read: renderer (the circuit\'s first rule and message)', 'client', /a read key without read/, () =>
    solDeviceMessageText(devCtx(0), { ...ig0, read: false, readPk: det('rk-x', 32) }));
  // the circuit's first RP rule, first in the renderer too
  refused(G, 'issue_grant, an RP hash on a non-passkey grantee: renderer (the circuit\'s first RP rule and message)', 'client', /an RP hash belongs to a passkey grantee/, () =>
    solDeviceMessageText(devCtx(0), { ...ig0, rpIdHash: det('rph', 32) }));
  refused(G, 'issue_grant to any recipient (kind 0) carrying a recipient: renderer', 'client', /a recipient without a recipient kind/, () =>
    solDeviceMessageText(devCtx(0), { ...ig0, recipientKind: 0n, recipient: det('r47', 32) }));
  // digit texts that would misstate an amount are refused by the digit checks
  const ctx = devCtx(1), a = { ...AMOUNTS[0], amount: 10n ** 37n };
  const runA = (units: bigint[]) => pc.sol_message_withdraw_unshielded({ bytes: ctx.account }, ctx.key, ctx.nonce, a.color, a.amount, { bytes: det('r', 32) },
    { ...solAmountShow(a), units }, solShow(ctx.site, ctx.nonce), solFrameNibbles(ctx.account, ctx.key), nibblesOf(a.color, det('r', 32)));
  const asc = (t: string) => [...Buffer.from(t.padEnd(39, ' '), 'ascii')].map(BigInt);
  ok(G, 'positive control: 10^37 renders its 38 digits in the circuit', Buffer.from(runA(asc((10n ** 37n).toString()))).toString('latin1').includes('Amount (base units): 1' + '0'.repeat(37) + ' \n'));
  refused(G, 'a leading zero refused by the digit check', 'runtime', /leading zero/, () => runA(asc('0' + (10n ** 37n).toString())));
  refused(G, 'a digit after the padding refused by the digit check', 'runtime', /not a left-aligned decimal|digits do not match/, () => runA(asc('1' + '0'.repeat(36) + ' 0')));
}

// ── 5. The frozen corpus ────────────────────────────────────────────────────
{
  const G = '5 frozen corpus';
  // Negative vectors: every refusal of section 4, with its refusing layer.
  // Source positions ("at <file> line N char M") are stripped: they move with
  // unrelated edits of the contract and are not part of the refusal.
  const negatives = cases.filter((c) => c.layer).map((c) => ({ name: c.name, layer: c.layer,
    refusal: (c.detail ?? '').replace(/^.*?(failed assert: |sol message: |type error: )/, '$1').replace(/ at [\w./-]+\.compact line \d+ char \d+/g, '').slice(0, 120) }));
  const frozen = { format: 'sol v1', lengths, calls: corpus.map((c) => ({ name: c.name, op: c.op, bytes: c.text.length, sha256: createHash('sha256').update(c.circuit).digest('hex'), text: c.text })), negatives };
  if (process.env.SOL_MESSAGES_WRITE === '1') {
    fs.writeFileSync(FROZEN, JSON.stringify(frozen, null, 2) + '\n');
    ok(G, `wrote ${FROZEN}`, true);
  } else if (!fs.existsSync(FROZEN)) {
    ok(G, 'frozen corpus present', false, `${FROZEN} missing (SOL_MESSAGES_WRITE=1 writes it)`);
  } else {
    const f = JSON.parse(fs.readFileSync(FROZEN, 'utf8'));
    const same = JSON.stringify(f) === JSON.stringify(frozen);
    // A deliberate byte change rewrites the file with SOL_MESSAGES_WRITE=1,
    // and its diff is reviewed.
    ok(G, `corpus equals the frozen file (${frozen.calls.length} calls)`, same, same ? undefined : 'differs: the signed bytes changed; if deliberate, rewrite the frozen corpus (SOL_MESSAGES_WRITE=1) and review the diff');
  }
}

const failed = cases.filter((c) => c.verdict !== 'PASS');
for (const g of [...new Set(cases.map((c) => c.group))]) {
  const cs = cases.filter((c) => c.group === g);
  console.log(`  ${cs.every((c) => c.verdict === 'PASS') ? '✓' : '✗'} ${g}: ${cs.filter((c) => c.verdict === 'PASS').length}/${cs.length}`);
}
console.log('  lengths:', JSON.stringify(lengths));
const verdict = failed.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-message-offline.json'),
    JSON.stringify({ suite: 'sol-ed25519-message-offline', ranAt: new Date().toISOString(), lengths, cases, verdict }, null, 2) + '\n');
}
console.log(`\n◆ sol-ed25519-message-offline: ${verdict} (${cases.length} cases, ${failed.length} failed; corpus ${corpus.length} calls)`);
process.exit(verdict === 'PASS' ? 0 : 1);
