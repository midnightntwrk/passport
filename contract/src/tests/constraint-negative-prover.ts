// Constraint-level negatives of the base modules, at the proof server.
//
// For every assert of the readable-descriptor and rendering modules, through
// the base probe contract's impure probe_* circuits (and, for the exact
// words, shown texts other than the circuit's rendering). Each bad call fails
// exactly the one assert it names, so bypassing that assert alone lets it
// reach the proof server:
//
//   positive   the honest call, built with the patched module (the same path
//              as the negatives), is proved by the proof server; it is
//              recorded as that module's positive control, and the prover
//              negative requires it;
//   runtime    the bad call, built with the original module, is refused by the
//              generated JavaScript (the usual first line of defence);
//   prover     the bad call, built with that one assert bypassed in the
//              generated JavaScript, reaches the proof server and is refused
//              there: the assert is a constraint of the proof.
//
// Then, for the ed25519 class (a Solana key by its Curve25519Point), the
// points the type refuses: small-order and mixed-order points and a
// coordinate outside the field, each refused by the generated JavaScript's
// point type and, with that type check replaced (`overrides`, after a
// positive control proved through the same copy), at the layer that refuses
// it next: the proof server's input decoding, or the runtime's value
// encoder. The identity passes the type and is refused by the
// A != O assert above.
//
// Last, the carry attack on 32-byte inputs (a byte plus 256, its neighbour
// minus one: the same 256-bit value): the checked Ed25519 encoding's two
// byte vectors and base58's value bytes. A one-byte input cannot encode a
// byte of 256, so a test copy encodes 32-byte vectors with two-byte atoms
// (the same proof preimage for every honest byte; a positive control proves
// through it) and suspends the argument type checks; the attempt must reach
// the proof server and be refused by the input's 8-bit range check.
//
// The calls are built from the probe's constructor state (no deploy, no node,
// no wallet) and only proved, never submitted. Needs a proof server at
// upstream's endpoint (CONFIG.proofServer, 127.0.0.1:6300); a missing proof
// server is an ERROR, never a pass. Writes
// $EVIDENCE_DIR/constraint-negative-prover.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ed25519, ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519.js';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import {
  createUnprovenCallTxFromInitialStates,
  createUnprovenDeployTxFromVerifierKeys,
} from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { LedgerParameters, ZswapChainState, sampleSigningKey } from '@midnightntwrk/ledger-v9';
import * as Original from '../../contracts/managed/probe-wallet-arms-base/contract/index.js';
import { CONFIG, managedPath } from '../node/wallet.js';
import { base58Inputs, utcDateTimeInputs } from '../wallet/rendering.js';
import {
  expectRefusal, expectSuccess, loadBypassedContract, recordingProofProvider,
  type NegativeResult, type PositiveResult, type ProofServerRequest,
} from './constraint-negative.js';

const PROBE = path.join(managedPath, 'probe-wallet-arms-base');
const PROBE_JS = path.join(PROBE, 'contract', 'index.js');
const zk = new NodeZkConfigProvider(PROBE);
const coinPublicKey = '00'.repeat(32);
const encryptionPublicKey = '00'.repeat(32);
const log: ProofServerRequest[] = [];
const proofProvider = recordingProofProvider(CONFIG.proofServer, zk, log);

const compiled = (C: any) => (CompiledContract.make('probe-wallet-arms-base', C) as any).pipe(
  (CompiledContract as any).withVacantWitnesses,
  (CompiledContract as any).withCompiledFileAssets(PROBE),
);
const deploy: any = await createUnprovenDeployTxFromVerifierKeys(zk as any, coinPublicKey, {
  compiledContract: compiled(Original.Contract), signingKey: sampleSigningKey(), initialPrivateState: {},
} as any, encryptionPublicKey);
const contractAddress = deploy.public.contractAddress;
const initialContractState = deploy.public.initialContractState;

/** Builds the call from the constructor state with module `C`, then proves it. */
const prove = async (C: any, circuitId: string, args: unknown[]) => {
  const call: any = await createUnprovenCallTxFromInitialStates(zk as any, {
    compiledContract: compiled(C), circuitId, contractAddress, coinPublicKey, initialContractState,
    initialZswapChainState: new ZswapChainState(), ledgerParameters: LedgerParameters.initialParameters(),
    args, initialPrivateState: {},
  } as any, encryptionPublicKey);
  return proofProvider.proveTx({ version: 'v9', tx: call.private.unprovenTx } as any);
};

const pad = (s: string, w = 32) => { const o = new Uint8Array(w); o.set(Buffer.from(s, 'latin1')); return o; };
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
const A = { bytes: fill(32, 0x11) };
const B32 = fill(32, 0x22), B20 = fill(20, 0x33), B21 = new Uint8Array(Buffer.from('https://a.example.com'));
const spaced = (s: string) => { const o = new Uint8Array(32).fill(0x20); o.set(Buffer.from(s, 'ascii')); return o; };
const digits = (s: string) => [...Buffer.from(s.padEnd(39, ' '), 'ascii')].map(BigInt);
// A Solana key's point (RFC 8032 section 7.1, TEST 1) with its encoding and
// x-coordinate bytes, and the identity with its own.
const affine = (p: { x: bigint; y: bigint }) => ({ x: p.x, y: p.y });
const u8v = (b: Uint8Array) => [...b].map(BigInt);
const le32 = (v: bigint) => Array.from({ length: 32 }, (_, i) => (v >> BigInt(8 * i)) & 0xffn);
const PT_KEY = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
const PT = affine(ed25519.Point.fromHex(PT_KEY.toString('hex')).toAffine());
const PTB = u8v(PT_KEY), PTX = le32(PT.x);
const O = { x: 0n, y: 1n };
const OB = [1n, ...new Array(31).fill(0n)], OX = new Array(32).fill(0n);
const P_ED = ed25519.Point.Fp.ORDER;
const with1 = (v: bigint[], i: number, f: (x: bigint) => bigint) => { const c = [...v]; c[i] = f(c[i]); return c; };
// The exact words.
const text = (s: string, w: number) => new Uint8Array(Buffer.from(s.padEnd(w, ' '), 'ascii'));
const d20 = (s: string) => [...text(s, 20)].map(BigInt);
const Z32 = new Uint8Array(32);
// Dates: a time's display inputs, a forged text, and the year split of a year.
const at = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0) => BigInt(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000);
const date = (v: bigint): unknown[] => { const i = utcDateTimeInputs(v); return [v, i.text, i.yearSplit]; };
const t29 = (s: string) => [...text(s, 29)].map(BigInt);
const split = (v: bigint) => utcDateTimeInputs(v).yearSplit;
const splitOf = (year: bigint) => { const y1 = year - 1n; return [y1 / 400n, (y1 % 400n) / 100n, (y1 % 100n) / 4n, y1 % 4n]; };
const AFTER = 'after 9999-12-31 23:59:59 UTC';
const U64 = (1n << 64n) - 1n;
// Base58: a value's display inputs, and the read-back hints of any digits.
const b58 = (b: Uint8Array): unknown[] => { const i = base58Inputs(b); return [u8v(b), i.digits, i.carry, i.low, i.top]; };
const b58hints = (digits: bigint[]): bigint[] => {
  const group = (g: bigint[]) => g.reduce(([v, m], d) => (d === 58n ? [v, m] : [v * 58n + d, m * 58n]), [0n, 1n]);
  const [v1] = group(digits.slice(0, 21)), [v2, m2] = group(digits.slice(21, 42)), [v3, m3] = group(digits.slice(42));
  const l2 = m2 * v1 + v2, low = l2 % (1n << 128n);
  return [l2 >> 128n, low, (m3 * low + v3) >> 128n];
};
const B58_LEAD = Uint8Array.from({ length: 32 }, (_, i) => (i < 2 ? 0 : (i * 37 + 11) % 256));
const forgedDigits = (b: Uint8Array, f: (d: bigint[]) => void): unknown[] => {
  const d = [...base58Inputs(b).digits]; f(d); return [u8v(b), d, ...b58hints(d)];
};
const flipByte = (b: Uint8Array, i: number): unknown[] => { const c = Uint8Array.from(b); c[i] ^= 1; const [, ...rest] = b58(b); return [u8v(c), ...rest]; };
// The site's amount label.
const label = (s: string) => [...text(s, 49)].map(BigInt);
const d39 = (s: string) => [...text(s, 39)].map(BigInt);

// [circuit, honest arguments, bad arguments, the assert the bad call fails]
const CASES: [string, unknown[], unknown[], string][] = [
  ['probe_entry_w52', [pad('midnight:account:device:evm:v1'), A, B20, B32, 0n, 0n], [pad('midnight:account:device:sol:v1'), A, B20, B32, 0n, 0n], 'descriptor: not a 52-byte device tag'],
  ['probe_entry_w64', [pad('midnight:account:device:v1'), A, B32, B32, 0n, 0n], [pad('midnight:account:device:sol:v1'), A, B32, B32, 0n, 0n], 'descriptor: not a 64-byte device tag'],
  ['probe_entry_w65', [pad('midnight:account:device:k1:v2'), A, B32, B32, 1n, 0n, 0n], [pad('midnight:account:device:ed:v1'), A, B32, B32, 1n, 0n, 0n], 'descriptor: not a 65-byte device tag'],
  ['probe_entry_w117', [pad('midnight:account:device:r1:v2'), A, B32, B32, B32, B21, 0n, 0n], [pad('midnight:account:grant:id:r1:v1'), A, B32, B32, B32, B21, 0n, 0n], 'descriptor: not a 117-byte device tag'],
  ['probe_boot_w52', [pad('midnight:account:boot:evm:v1'), B32, B20, B32], [pad('midnight:account:device:evm:v1'), B32, B20, B32], 'descriptor: not a 52-byte boot tag'],
  ['probe_grant_id_w52', [pad('midnight:account:grant:id:evm:v1'), A, B20, B32, B32, 0n], [pad('midnight:account:grant:id:sol:v1'), A, B20, B32, B32, 0n], 'descriptor: not a 52-byte grant-id tag'],
  ['probe_grant_id_w64', [pad('midnight:account:grant:id:r1:v1'), A, B32, B32, B32, 3n], [pad('midnight:account:grant:id:sol:v1'), A, B32, B32, B32, 3n], 'descriptor: not a 64-byte grant-id tag'],
  ['probe_entry_ed25519', [pad('midnight:account:device:sol:v1'), A, PT, PTB, PTX, B32, 0n, 0n], [pad('midnight:account:device:v1'), A, PT, PTB, PTX, B32, 0n, 0n], 'descriptor: not an Ed25519 device tag'],
  ['probe_boot_ed25519', [pad('midnight:account:boot:sol:v1'), B32, PT, PTB, PTX, B32], [pad('midnight:account:boot:v1'), B32, PT, PTB, PTX, B32], 'descriptor: not an Ed25519 boot tag'],
  ['probe_grant_id_ed25519', [pad('midnight:account:grant:id:sol:v1'), A, PT, PTB, PTX, B32, B32, 3n], [pad('midnight:account:grant:id:r1:v1'), A, PT, PTB, PTX, B32, B32, 3n], 'descriptor: not an Ed25519 grant-id tag'],
  ['probe_entry_ed25519', [pad('midnight:account:device:sol:v1'), A, PT, PTB, PTX, B32, 0n, 0n], [pad('midnight:account:device:sol:v1'), A, O, OB, OX, B32, 0n, 0n], 'descriptor: the Ed25519 key is the identity'],
  ['probe_boot_ed25519', [pad('midnight:account:boot:sol:v1'), B32, PT, PTB, PTX, B32], [pad('midnight:account:boot:sol:v1'), B32, O, OB, OX, B32], 'descriptor: the Ed25519 key is the identity'],
  ['probe_grant_id_ed25519', [pad('midnight:account:grant:id:sol:v1'), A, PT, PTB, PTX, B32, B32, 3n], [pad('midnight:account:grant:id:sol:v1'), A, O, OB, OX, B32, B32, 3n], 'descriptor: the Ed25519 key is the identity'],
  // The checked encoding: inputs other than the point's own bytes.
  ['probe_encode_ed25519', [PT, PTB, PTX], [PT, with1(PTB, 7, (x) => x ^ 1n), PTX], "descriptor: the Ed25519 key bytes do not match the point's y"],
  ['probe_encode_ed25519', [O, OB, OX], [O, le32(1n + P_ED), OX], "descriptor: the Ed25519 key bytes do not match the point's y"],
  ['probe_encode_ed25519', [PT, PTB, PTX], [PT, PTB, with1(PTX, 9, (x) => x ^ 4n)], "descriptor: the Ed25519 x bytes do not match the point's x"],
  ['probe_encode_ed25519', [PT, PTB, PTX], [PT, with1(PTB, 31, (x) => x ^ 0x80n), le32(PT.x + P_ED)], "descriptor: the Ed25519 x bytes do not match the point's x"],
  ['probe_encode_ed25519', [PT, PTB, PTX], [PT, with1(PTB, 31, (x) => x ^ 0x80n), PTX], "descriptor: the Ed25519 sign bit is not x's parity"],
  ['probe_entry_ed25519', [pad('midnight:account:device:sol:v1'), A, PT, PTB, PTX, B32, 0n, 0n], [pad('midnight:account:device:sol:v1'), A, PT, with1(PTB, 0, (x) => x ^ 1n), PTX, B32, 0n, 0n], "descriptor: the Ed25519 key bytes do not match the point's y"],
  ['probe_grant_id_w65', [pad('midnight:account:grant:id:k1:v1'), A, B32, B32, 0n, B32, 3n], [pad('midnight:account:device:k1:v2'), A, B32, B32, 0n, B32, 3n], 'descriptor: not a 65-byte grant-id tag'],
  ['probe_blind', [pad('midnight:account:blind:sol:v1'), fill(64, 0x44)], [spaced('midnight:account:blind:evm:v1'), fill(64, 0x44)], 'descriptor: not a blind tag'],
  ['probe_grant_scope_salt', [pad('midnight:account:salt:sol:v1'), B32, A, 7n], [pad('midnight:account:blind:sol:v1'), B32, A, 7n], 'descriptor: not a grant salt tag'],
  ['probe_grant_scope_salt', [pad('midnight:account:salt:evm:v1'), B32, A, 7n], [spaced('midnight:account:salt:evm:v1'), B32, A, 7n], 'descriptor: not a grant salt tag'],
  ['probe_uint128_text', [1000000n, digits('1000000')], [1000000n, digits('1000001')], 'display: digits do not match the value'],
  ['probe_uint128_text', [7n, digits('7')], [7n, digits('07')], 'display: leading zero'],
  ['probe_label_text_32', [pad('Midnight Night Market')], [pad('Midnight Night Market ')], 'display: not a zero-padded label'],
  ['probe_visible_text_21', [B21], [new Uint8Array(Buffer.from('https://a example.com'))], 'display: not visible ASCII'],
  ['probe_recipient_kind_text', [3n], [4n], 'display: unknown recipient kind'],
  ['probe_k256_envelope_text', [1n], [2n], 'display: unknown signing envelope'],
  // Exact words: a shown text other than the circuit's own rendering (an arm
  // binds it through its signed bytes; the probe through an assert).
  ['probe_check_expiry', [1n, d20('1'), text('1', 20)], [1n, d20('1'), text('never', 20)], "display: the shown expiry is not the circuit's"],
  ['probe_check_expiry', [0n, d20('0'), text('never', 20)], [0n, d20('0'), text('0', 20)], "display: the shown expiry is not the circuit's"],
  ['probe_check_rp_hash', [B32, text(Buffer.from(B32).toString('hex'), 64)], [B32, text('not applicable', 64)], "display: the shown RP hash is not the circuit's"],
  ['probe_check_rp_hash', [Z32, text('not applicable', 64)], [Z32, text('0'.repeat(64), 64)], "display: the shown RP hash is not the circuit's"],
  ['probe_check_window', [0n, d20('0'), text('no window', 20)], [0n, d20('0'), text('0', 20)], "display: the shown window is not the circuit's"],
  ['probe_check_window', [5n, d20('5'), text('5', 20)], [5n, d20('5'), text('no window', 20)], "display: the shown window is not the circuit's"],
  ['probe_check_window_cap', [0n, 0n, d39('0'), text('no window', 39)], [0n, 0n, d39('0'), text('0', 39)], "display: the shown window cap is not the circuit's"],
  ['probe_check_window_cap', [0n, 7n, d39('7'), text('7', 39)], [0n, 7n, d39('7'), text('no window', 39)], "display: the shown window cap is not the circuit's"],
  // UTC dates: each bad call fails one check; a day, a month and a time that
  // are aliases of a valid date reach the value check with the right seconds.
  ['probe_utc_datetime_text', date(0n), [0n, t29('1970/01-01 00:00:00 UTC'), split(0n)], 'display: not a UTC date and time'],
  ['probe_utc_datetime_text', date(at(1970, 12, 1)), [at(1970, 12, 1), t29('1970-13-01 00:00:00 UTC'), split(0n)], 'display: month out of range'],
  ['probe_utc_datetime_text', date(at(2100, 3, 1)), [at(2100, 3, 1), t29('2100-02-29 00:00:00 UTC'), split(at(2100, 3, 1))], 'display: day out of range'],
  ['probe_expiry_datetime_text', date(at(2025, 5, 1)), [at(2025, 5, 1), t29('2025-04-31 00:00:00 UTC'), split(at(2025, 5, 1))], 'display: day out of range'],
  ['probe_utc_datetime_text', date(86400n), [86400n, t29('1970-01-01 24:00:00 UTC'), split(0n)], 'display: time of day out of range'],
  ['probe_utc_datetime_text', date(at(2100, 3, 1)), [at(2100, 3, 1), t29('2100-02-29 00:00:00 UTC'), [4n, 3n, 49n, 3n]], 'display: the year split is not canonical'],
  ['probe_utc_datetime_text', date(at(2026, 6, 1)), [at(2026, 6, 1), t29('2026-06-01 00:00:00 UTC'), splitOf(2027n)], 'display: the year split is not canonical'],
  ['probe_utc_datetime_text', date(U64), [U64, t29(AFTER), [1n, 0n, 0n, 0n]], 'display: the year split is not canonical'],
  ['probe_utc_datetime_text', date(1n), [1n, t29('1970-01-01 00:00:00 UTC'), split(0n)], 'display: the date and time do not match the value'],
  ['probe_utc_datetime_text', date(253402300800n), [253402300800n, t29('9999-12-31 23:59:59 UTC'), [0n, 0n, 0n, 0n]], 'display: not the words for a time after 9999-12-31 23:59:59 UTC'],
  ['probe_check_expiry_datetime', [...date(1n), text('1970-01-01 00:00:01 UTC', 29)], [...date(1n), text('never', 29)], "display: the shown expiry date is not the circuit's"],
  ['probe_check_expiry_datetime', [...date(0n), text('never', 29)], [...date(0n), text('1970-01-01 00:00:00 UTC', 29)], "display: the shown expiry date is not the circuit's"],
  // Base58: a digit at 58 or more and padding inside keep the value; a "1"
  // too many keeps the value; a digit or a byte changed keeps the hints.
  ['probe_base58_text_32', b58(PT_KEY), forgedDigits(PT_KEY, (d) => { const i = d[42] > 0n ? 42 : 41; d[i] -= 1n; d[i + 1] += 58n; }), 'display: not a left-aligned base58 text'],
  ['probe_base58_text_32', b58(B58_LEAD), forgedDigits(B58_LEAD, (d) => { const n = d.indexOf(58n); d.splice(n - 1, 0, 58n); d.pop(); }), 'display: not a left-aligned base58 text'],
  ['probe_base58_text_32', b58(B58_LEAD), forgedDigits(B58_LEAD, (d) => { d.unshift(0n); d.pop(); }), 'display: the leading base58 ones do not match the leading zero bytes'],
  ['probe_base58_text_32', b58(PT_KEY), (() => { const [b, d, ...h] = b58(PT_KEY); const c = [...(d as bigint[])]; c[5] = (c[5] + 1n) % 58n; return [b, c, ...h]; })(), 'display: the base58 carry hints do not split the leading digits'],
  ['probe_base58_text_32', b58(PT_KEY), (() => { const [b, d, ...h] = b58(PT_KEY); const c = [...(d as bigint[])]; c[43] = (c[43] + 1n) % 58n; return [b, c, ...h]; })(), "display: the base58 digits do not match the value's low bytes"],
  ['probe_base58_text_32', b58(PT_KEY), flipByte(PT_KEY, 20), "display: the base58 digits do not match the value's low bytes"],
  ['probe_base58_text_32', b58(PT_KEY), flipByte(PT_KEY, 3), "display: the base58 digits do not match the value's high bytes"],
  // The site's amount label.
  ['probe_site_amount_label_text', [1000000n, label('1.000000 tUSDC')], [1000000n, label('1.000000 tUS\nDC')], 'display: not a site amount label'],
  ['probe_site_amount_label_text', [1000000n, label('1.000000 tUSDC')], [1000000n, label('1.000000 .5')], 'display: the symbol does not start with a letter'],
  ['probe_site_amount_label_text', [1n, label('0.000000000000000001 tUSDC')], [1n, label('0.0000000000000000001 tUSDC')], 'display: more than 18 decimals'],
  ['probe_site_amount_label_text', [1000000n, label('1.000000 ABCDEFGH')], [1000000n, label('1.000000 ABCDEFGHI')], 'display: symbol longer than 8'],
  ['probe_site_amount_label_text', [15n, label('1.5 X')], [15n, label('01.5 X')], 'display: leading zero in the site amount label'],
  ['probe_site_amount_label_text', [15n, label('1.5 X')], [16n, label('1.5 X')], 'display: the site amount label does not match the value'],
];

const results: { circuit: string; assert: string; positive: PositiveResult; runtime: NegativeResult; prover: NegativeResult }[] = [];
let failures = 0, errors = 0;
for (const [circuit, good, badArgs, message] of CASES) {
  const bypassed = await loadBypassedContract(PROBE_JS, [message]);
  const positive = await expectSuccess({ name: `${circuit}: honest call proved`, proofLog: log, through: bypassed, attempt: () => prove(bypassed.Contract, circuit, good) });
  const runtime = await expectRefusal({ name: `${circuit}: ${message} (generated JavaScript)`, expectedLayer: 'runtime', proofLog: log, attempt: () => prove(Original.Contract, circuit, badArgs) });
  const prover = await expectRefusal({ name: `${circuit}: ${message} (JavaScript check bypassed)`, expectedLayer: 'prover', bypassed, proofLog: log, requirePositiveControl: true, attempt: () => prove(bypassed.Contract, circuit, badArgs) });
  for (const r of [positive, runtime, prover]) { if (r.verdict === 'FAIL') failures++; if (r.verdict === 'ERROR') errors++; }
  results.push({ circuit, assert: message, positive: { ...positive, result: undefined }, runtime, prover });
  console.log(`  ${positive.verdict === 'PASS' && runtime.verdict === 'PASS' && prover.verdict === 'PASS' ? '✓' : '✗'} ${circuit} — "${message}": positive ${positive.verdict}, runtime ${runtime.verdict}, prover ${prover.verdict} (${prover.layer}${prover.proofServer.at(-1)?.status ? `, ${prover.proofServer.at(-1)!.endpoint} ${prover.proofServer.at(-1)!.status}` : ''})`);
  if (positive.verdict !== 'PASS') console.log(`      positive: ${positive.reason} ${positive.detail ?? ''}`);
  if (prover.verdict !== 'PASS') console.log(`      prover: ${prover.reason} ${prover.detail ?? ''}`);
}
// ── The ed25519 class: points the Curve25519Point type refuses ──────────────

const TYPE_BYPASS = Symbol.for('midnight-passport.constraint-negative.curve25519-type');
(globalThis as any)[TYPE_BYPASS] = { refused: 0 };
const typeFired = () => (globalThis as any)[TYPE_BYPASS].refused as number;
// The copy accepts every point at the type check and counts the points the
// original check refuses, so a negative proves the check was reached.
const typeBypassed = await loadBypassedContract(PROBE_JS, [], {
  overrides: `isValidCurve25519Point(p) {
    if (!__compactRuntimeOriginal.isValidCurve25519Point(p)) globalThis[Symbol.for('midnight-passport.constraint-negative.curve25519-type')].refused++;
    return true;
  },`,
});
const typePositive = await expectSuccess({
  name: 'probe_encode_ed25519: an honest point proved through the type-bypassed copy', proofLog: log, through: typeBypassed,
  attempt: () => prove(typeBypassed.Contract, 'probe_encode_ed25519', [PT, PTB, PTX]),
});
if (typePositive.verdict === 'FAIL') failures++; else if (typePositive.verdict === 'ERROR') errors++;
console.log(`  ${typePositive.verdict === 'PASS' ? '✓' : '✗'} type-bypassed copy positive control: ${typePositive.verdict} (${typePositive.reason})`);
const T = (h: string) => ed25519.Point.fromBytes(Buffer.from(h, 'hex'), true);
const POINTS: [string, { x: bigint; y: bigint }, 'decoding' | 'runtime'][] = [];
for (const h of ED25519_TORSION_SUBGROUP) {
  const p = T(h);
  if (p.is0()) continue; // the identity: the type admits it (A != O above)
  let order = 1n; for (let q = p; !q.is0(); q = q.add(p)) order++;
  POINTS.push([`small order ${order} (${h.slice(0, 8)}…)`, affine(p.toAffine()), 'decoding']);
}
const T8 = T(ED25519_TORSION_SUBGROUP.find((h) => { const p = T(h); return !p.multiply(4n).is0(); })!);
for (const sk of ['4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7']) {
  const A8 = ed25519.Point.fromBytes(ed25519.getPublicKey(Buffer.from(sk, 'hex'))).add(T8);
  POINTS.push([`mixed order A + T8 (${sk.slice(0, 8)}…)`, affine(A8.toAffine()), 'decoding']);
}
POINTS.push(['coordinate y + p (not below p)', { x: PT.x, y: PT.y + ed25519.Point.Fp.ORDER }, 'runtime']);
const pointResults: { point: string; x: string; y: string; runtime: NegativeResult; bypassed: NegativeResult; typeCheckReached: boolean }[] = [];
// Each point with its own encoding and x bytes, so the checked encoding's
// asserts pass and the point reaches the layer under test (a coordinate
// outside the field is refused when the runtime encodes it, before any
// comparison).
const ownBytes = (pt: { x: bigint; y: bigint }): [bigint[], bigint[]] =>
  pt.y < P_ED && pt.x < P_ED ? [u8v(ed25519.Point.fromAffine(pt).toBytes()), le32(pt.x)] : [PTB, PTX];
for (const [name, pt, layer] of POINTS) {
  const runtime = await expectRefusal({ name: `${name}: the point type (generated JavaScript)`, expectedLayer: 'runtime', proofLog: log, attempt: () => prove(Original.Contract, 'probe_encode_ed25519', [pt, ...ownBytes(pt)]) });
  const before = typeFired();
  const bypassed = await expectRefusal({ name: `${name}: type check bypassed`, expectedLayer: layer, bypassed: typeBypassed, proofLog: log, attempt: () => prove(typeBypassed.Contract, 'probe_encode_ed25519', [pt, ...ownBytes(pt)]) });
  const reached = typeFired() > before;
  if (bypassed.verdict === 'PASS' && !reached) { bypassed.verdict = 'FAIL'; bypassed.reason = 'the type-check bypass never saw the point: the tampering missed'; }
  if (runtime.verdict === 'PASS' && !/Curve25519Point/.test(runtime.detail ?? '')) { runtime.verdict = 'FAIL'; runtime.reason = 'refused at runtime, but not by the point type'; }
  if (layer === 'runtime' && bypassed.verdict === 'PASS' && !/expected Curve25519Base/.test(bypassed.detail ?? '')) { bypassed.verdict = 'FAIL'; bypassed.reason = 'refused at runtime, but not by the value encoder'; }
  for (const r of [runtime, bypassed]) { if (r.verdict === 'FAIL') failures++; if (r.verdict === 'ERROR') errors++; }
  pointResults.push({ point: name, x: pt.x.toString(16), y: pt.y.toString(16), runtime, bypassed, typeCheckReached: reached });
  const rej = bypassed.rejection ? `, ${bypassed.rejection.endpoint} ${bypassed.rejection.status} ${bypassed.rejection.rule}` : '';
  console.log(`  ${runtime.verdict === 'PASS' && bypassed.verdict === 'PASS' ? '✓' : '✗'} ${name}: runtime ${runtime.verdict}; type check bypassed: ${bypassed.verdict} (${bypassed.layer}${rej})`);
  if (bypassed.verdict !== 'PASS') console.log(`      ${bypassed.reason} ${bypassed.detail ?? ''}`);
}

// ── The carry attack on 32-byte inputs ──────────────────────────────────────

const HS = "globalThis[Symbol.for('midnight-passport.constraint-negative.wide-bytes')]";
const wide: { on: boolean; typeErrors: number; ranges: number } =
  ((globalThis as any)[Symbol.for('midnight-passport.constraint-negative.wide-bytes')] ??= { on: false, typeErrors: 0, ranges: 0 });
// While `wide.on`, every Vector<32, Uint<8>> argument is encoded with
// two-byte atoms and the argument type checks are suspended (each counted);
// an element of 256 or more is counted when it is encoded.
const WIDE_OVERRIDES = `
  typeError(...a) { const h = ${HS}; if (h && h.on) { h.typeErrors++; return; } return __compactRuntimeOriginal.typeError(...a); },
  CompactTypeVector: class extends __compactRuntimeOriginal.CompactTypeVector {
    wide() { const h = ${HS}; return !!(h && h.on) && this.length === 32 && this.type instanceof __compactRuntimeOriginal.CompactTypeUnsignedInteger && this.type.maxValue === 255n && this.type.length === 1; }
    alignment() { if (!this.wide()) return super.alignment(); return Array.from({ length: 32 }, () => ({ tag: 'atom', value: { tag: 'bytes', length: 2 } })); }
    toValue(v) {
      if (!this.wide()) return super.toValue(v);
      const h = ${HS};
      return v.flatMap((x) => { if (x > 255n) h.ranges++; return __compactRuntimeOriginal.bigIntToValue(x); });
    }
  },`;
const carry = (v: bigint[], i = 3): bigint[] => { const c = [...v]; c[i] += 256n; c[i + 1] -= 1n; return c; };
const valueOf = (v: bigint[]) => v.reduce((a, x, i) => a + (x << BigInt(8 * i)), 0n);
const B58_KEY = b58(PT_KEY) as [bigint[], bigint[], bigint, bigint, bigint];
// [name, circuit, honest arguments, carried arguments, the asserts the copy's
//  own JavaScript trips on the carried bytes (bypassed; the proof refuses by
//  the range check before any of them)]
const CARRY: [string, string, unknown[], unknown[], string[]][] = [
  ['the key bytes carried', 'probe_encode_ed25519', [PT, PTB, PTX], [PT, carry(PTB), PTX], ["descriptor: the Ed25519 key bytes do not match the point's y"]],
  ['the x bytes carried', 'probe_encode_ed25519', [PT, PTB, PTX], [PT, PTB, carry(PTX)], ["descriptor: the Ed25519 x bytes do not match the point's x"]],
  ['the key bytes carried in a derivation', 'probe_entry_ed25519', [pad('midnight:account:device:sol:v1'), A, PT, PTB, PTX, B32, 0n, 0n],
    [pad('midnight:account:device:sol:v1'), A, PT, carry(PTB, 20), PTX, B32, 0n, 0n], ["descriptor: the Ed25519 key bytes do not match the point's y"]],
  ["base58's value bytes carried (high half)", 'probe_base58_text_32', [...B58_KEY], [carry(B58_KEY[0], 3), ...B58_KEY.slice(1)], ["display: the base58 digits do not match the value's high bytes"]],
  ["base58's value bytes carried (low half)", 'probe_base58_text_32', [...B58_KEY], [carry(B58_KEY[0], 20), ...B58_KEY.slice(1)], ["display: the base58 digits do not match the value's low bytes"]],
];
const carryResults: { name: string; circuit: string; positive: PositiveResult; prover: NegativeResult; reachedProofRequest: boolean }[] = [];
for (const [name, circuit, good, bad, asserts] of CARRY) {
  const a = bad.find((x, i) => Array.isArray(x) && x !== good[i]) as bigint[];
  const g = good[bad.indexOf(a)] as bigint[];
  if (valueOf(a) !== valueOf(g) || a.every((x) => x <= 255n)) throw new Error(`${name}: not a carry of the same value`);
  const copy = await loadBypassedContract(PROBE_JS, asserts, { overrides: WIDE_OVERRIDES });
  wide.on = true;
  try {
    const positive = await expectSuccess({ name: `${circuit}: honest call proved through the wide-byte copy`, proofLog: log, through: copy, attempt: () => prove(copy.Contract, circuit, good) });
    const r0 = wide.ranges, t0 = wide.typeErrors;
    const prover = await expectRefusal({ name: `${circuit}: ${name}`, expectedLayer: 'prover', bypassed: copy, proofLog: log, requirePositiveControl: true, attempt: () => prove(copy.Contract, circuit, bad) });
    const reached = wide.ranges > r0 && wide.typeErrors > t0;
    if (prover.verdict === 'PASS' && !reached) { prover.verdict = 'FAIL'; prover.reason = 'the byte of 256 or more never reached the proof request'; }
    if (prover.verdict === 'PASS' && prover.rejection?.rule !== 'bit-bound') { prover.verdict = 'FAIL'; prover.reason = `refused by ${prover.rejection?.rule}, not by the 8-bit range check`; }
    for (const r of [positive, prover]) { if (r.verdict === 'FAIL') failures++; if (r.verdict === 'ERROR') errors++; }
    carryResults.push({ name, circuit, positive: { ...positive, result: undefined }, prover, reachedProofRequest: reached });
    const rej = prover.rejection ? `, ${prover.rejection.endpoint} ${prover.rejection.status} ${prover.rejection.rule}` : '';
    console.log(`  ${positive.verdict === 'PASS' && prover.verdict === 'PASS' ? '✓' : '✗'} ${circuit} — ${name}: positive ${positive.verdict}, prover ${prover.verdict} (${prover.layer}${rej})`);
    if (positive.verdict !== 'PASS') console.log(`      positive: ${positive.reason} ${positive.detail ?? ''}`);
    if (prover.verdict !== 'PASS') console.log(`      prover: ${prover.reason} ${prover.detail ?? ''}`);
  } finally { wide.on = false; }
}

const verdict = errors ? 'ERROR' : failures ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  const file = path.join(process.env.EVIDENCE_DIR, 'constraint-negative-prover.json');
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    suite: 'constraint-negative-prover', ranAt: new Date().toISOString(), proofServer: CONFIG.proofServer,
    contractAddress, cases: results,
    carry: carryResults,
    points: { positiveControl: { ...typePositive, result: undefined }, cases: pointResults,
      note: 'Constraint layer (source-verified, not exercisable through an honest proof server): midnight-zkir 3.1.0-rc.1 assigns a Curve25519Point input with ForeignEdwardsEccChip::assign (midnight-circuits 7.2.4 src/ecc/foreign/edwards_chip.rs: witnesses an h-root Q on the curve and returns [8]Q), so a prover that skips decoding still holds a prime-order point; a small-order input becomes the identity, which A != O refuses.' },
    requests: log.length, verdict,
  }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v), 2) + '\n');
  console.log(`\n■ evidence → ${file}`);
}
console.log(`\n◆ constraint-negative-prover: ${verdict} (${CASES.length} asserts, ${POINTS.length} points, ${CARRY.length} carry attacks; ${failures} FAIL, ${errors} ERROR; ${log.length} proof-server requests)`);
process.exit(verdict === 'PASS' ? 0 : 1);
