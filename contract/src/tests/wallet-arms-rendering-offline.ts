// Offline suite for the readable rendering helpers (contracts/modules/
// WalletArmRendering.compact), compiled through the base probe contract.
// Every helper is compared with an independent renderer written here, and
// every check the helpers make is exercised with inputs that must be refused.
//
//   decimal  uint{8,32,64,128}_text: each value accepts exactly its canonical
//            text (left-aligned, space-padded, no leading zero); edge values
//            of every width, including 2^128 - 1 (39 digits); refusals for
//            leading zeros, empty, right-aligned, inner spaces, zero-byte
//            padding, signs, letters, and wrong digits.
//   hex      hex_text_{20,32,64,192}: every byte value, lowercase, in full;
//            reverse_32.
//   labels   label_text_32: canonical zero-padded words accepted and shown
//            with spaces; leading, trailing, and double spaces, empty labels,
//            inner zero bytes, and control and non-ASCII bytes refused; distinct
//            labels never show the same text. visible_text_21: visible ASCII
//            only.
//   enums    recipient_kind_text and k256_envelope_text: every value with a
//            label shows the client table's text (src/wallet/labels.ts),
//            space-padded to 24 bytes, labels distinct; every other value of
//            the type (0-255) is refused, by the circuit and by the client.
//   words    exact-value words only. expiry_text: "never" exactly for 0,
//            else the checked seconds;
//            rp_hash_text: "not applicable" exactly for the all-zero hash,
//            else the full hex; window_text and window_cap_text: "no window"
//            exactly for a zero window (and, for the cap, a zero cap), else
//            the checked digits; all equal to the client
//            (src/wallet/rendering.ts).
//   dates    utc_datetime_text and expiry_datetime_text against an
//            independent renderer (Node's Date) and the client: the epoch,
//            day and year boundaries, leap days (2000-02-29, 2024-02-29,
//            2400-02-29) and the century years without one (2100, 2200,
//            2300), the range end 253402300799 and the words above it,
//            2^64 - 1, and seeded values; every check refused on its own:
//            the shape, the month, the day (29 February of a common year
//            and the other aliases of a valid date), the time of day, the
//            year split (a split outside its digit ranges, the split of
//            another year), the value, and the words above the range.
//   base58   base58_text_32 against an independent byte-array renderer, the
//            client and descriptors.ts's base58Encode: all zero, leading
//            zero bytes, all 0xff, the bytes 0..31, and seeded keys and
//            values; refusals for a digit at 58 or more, padding inside the
//            text, a "1" too many or too few, a digit changed in each group,
//            a byte changed in each half of the value, and each hint off by
//            one.
//   amount   site_amount_label_text against an independent renderer and the
//            client: 0..18 decimals, symbols of 1..8 characters, the largest
//            amount; refusals for every malformed label, by the circuit and
//            by the client.
//
// Writes $EVIDENCE_DIR/wallet-arms-rendering-offline.json when EVIDENCE_DIR
// is set; never writes into the repository.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pureCircuits as probe } from '../../contracts/managed/probe-wallet-arms-base/contract/index.js';
import {
  ENUM_TEXT_WIDTH, RECIPIENT_KIND_LABELS, K256_ENVELOPE_LABELS, recipientKindLabel, k256EnvelopeLabel, enumText,
} from '../wallet/labels.js';
import {
  EXPIRY_TEXT_WIDTH, RP_HASH_TEXT_WIDTH, NEVER_TEXT, NOT_APPLICABLE_TEXT,
  expiryTextBytes, rpHashText, rpHashTextBytes,
  WINDOW_TEXT_WIDTH, WINDOW_CAP_TEXT_WIDTH, NO_WINDOW_TEXT, windowText, windowTextBytes, windowCapText, windowCapTextBytes,
  DATETIME_TEXT_WIDTH, DATETIME_MAX, AFTER_RANGE_TEXT, utcDateTimeText, utcDateTimeTextBytes, expiryDateTimeText,
  expiryDateTimeTextBytes, utcDateTimeInputs,
  BASE58_TEXT_WIDTH, base58Text32, base58Text32Bytes, base58Inputs,
  SITE_AMOUNT_LABEL_WIDTH, siteAmountLabel, siteAmountLabelBytes,
} from '../wallet/rendering.js';
import { base58Encode } from '../wallet/descriptors.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const SEED = 'wallet-arms-base/v1/wallet-arms-rendering-offline';
let ctr = 0;
const rnd = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 32) {
    const h = createHash('sha256').update(SEED).update(String(ctr++)).digest();
    out.set(h.subarray(0, Math.min(32, n - i)), i);
  }
  return out;
};
// Vector<n, Uint<8>> crosses the generated JavaScript as an array of bigint.
const vec = (b: Uint8Array): bigint[] => [...b].map(BigInt);
const ascii = (v: Uint8Array | bigint[]): string => Buffer.from(Uint8Array.from(v as ArrayLike<number>, Number)).toString('latin1');
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'latin1'));
const randBig = (bits: number): bigint => {
  const b = rnd(Math.ceil(bits / 8));
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v & ((1n << BigInt(bits)) - 1n);
};

// ── Independent renderers ───────────────────────────────────────────────────

const decimal = (v: bigint, width: number): Uint8Array => {
  const s = v.toString(10);
  if (s.length > width) throw new Error('value too wide');
  return bytes(s.padEnd(width, ' '));
};
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const labelShown = (b: Uint8Array): string => ascii(b.map((c) => (c === 0 ? 32 : c)));
const zeroPadded = (s: string, w: number): Uint8Array => { const o = new Uint8Array(w); o.set(bytes(s)); return o; };

const report: Record<string, unknown> = { suite: 'wallet-arms-rendering-offline', seed: SEED, ranAt: new Date().toISOString() };
const counts: Record<string, { accepted: number; refused: number }> = {};
const count = (k: string, field: 'accepted' | 'refused') => { (counts[k] ??= { accepted: 0, refused: 0 })[field]++; };

// ── Decimal ─────────────────────────────────────────────────────────────────

console.log('\n── decimal (digit binding)');
const WIDTHS: [string, number, number, (v: bigint, t: bigint[]) => bigint[]][] = [
  ['uint8_text', 8, 3, probe.uint8_text],
  ['uint32_text', 32, 10, probe.uint32_text],
  ['uint64_text', 64, 20, probe.uint64_text],
  ['uint128_text', 128, 39, probe.uint128_text],
];
for (const [name, bits, width, f] of WIDTHS) {
  const max = (1n << BigInt(bits)) - 1n;
  assert.equal(max.toString().length, width, `${name}: the width is the type's widest value`);
  const values = new Set<bigint>([0n, 1n, 9n, 10n, 11n, 99n, 100n, max, max - 1n]);
  for (let k = 1; 10n ** BigInt(k) <= max; k++) { values.add(10n ** BigInt(k) - 1n); values.add(10n ** BigInt(k)); }
  for (let i = 0; i < 24; i++) values.add(randBig(bits));
  for (const v of values) {
    const t = decimal(v, width);
    const out = f(v, vec(t));
    assert.equal(ascii(out), ascii(t), `${name}(${v})`);
    count(name, 'accepted');
  }
  // Refusals: each text below is wrong for the value next to it.
  const refuse = (v: bigint, text: string, why: RegExp, label: string) => {
    assert.equal(text.length, width, `${name}: test text width (${label})`);
    assert.throws(() => f(v, vec(bytes(text))), why, `${name}: ${label}`);
    count(name, 'refused');
  };
  const sp = (s: string) => s.padEnd(width, ' ');
  refuse(7n, sp('07'), /leading zero/, 'leading zero');
  refuse(0n, sp('00'), /leading zero/, 'zero with a leading zero');
  refuse(0n, sp(''), /empty decimal/, 'empty');
  refuse(7n, (' 7').padEnd(width, ' '), /empty decimal|left-aligned/, 'right-shifted');
  refuse(12n, sp('1 2'), /left-aligned/, 'inner space');
  refuse(1n, '1' + '\0'.repeat(width - 1), /left-aligned/, 'zero-byte padding');
  refuse(1n, sp('+1'), /left-aligned/, 'sign');
  refuse(10n, sp('1a'), /left-aligned/, 'letter');
  refuse(5n, sp('6'), /do not match/, 'wrong digit');
  refuse(5n, sp('5').replace(/ $/, '0'), /left-aligned/, 'digit after the padding');
  if (bits < 128) {
    // A text of the next power of ten (the type cannot hold it) never matches.
    refuse(0n, sp((max + 1n).toString().slice(0, width)), /do not match|leading zero/, 'out-of-range digits');
  }
  console.log(`  ✓ ${name}: ${counts[name].accepted} values accepted with their canonical text, ${counts[name].refused} wrong texts refused`);
}

// ── Hex ─────────────────────────────────────────────────────────────────────

console.log('\n── hex');
const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
for (const [name, n, f] of [
  ['hex_text_20', 20, probe.hex_text_20],
  ['hex_text_32', 32, probe.hex_text_32],
  ['hex_text_64', 64, probe.hex_text_64],
  ['hex_text_192', 192, probe.hex_text_192],
] as [string, number, (b: Uint8Array) => bigint[]][]) {
  let checked = 0;
  for (let off = 0; off < 256; off += n) {
    const b = new Uint8Array(n);
    for (let j = 0; j < n; j++) b[j] = allBytes[(off + j) % 256];
    assert.equal(ascii(f(b)), hexOf(b), `${name} @${off}`);
    checked++;
  }
  for (let i = 0; i < 8; i++) { const b = rnd(n); assert.equal(ascii(f(b)), hexOf(b), `${name} random`); checked++; }
  counts[name] = { accepted: checked, refused: 0 };
  console.log(`  ✓ ${name}: every byte value, lowercase, ${2 * n} digits (${checked} vectors)`);
}
for (let i = 0; i < 8; i++) {
  const b = rnd(32);
  assert.equal(hexOf(probe.reverse_32(b)), hexOf(Uint8Array.from(b).reverse()));
}
console.log('  ✓ reverse_32: byte order reversed');

// ── Labels ──────────────────────────────────────────────────────────────────

console.log('\n── labels');
const GOOD = [
  'midnight:account:device:v1', 'midnight:account:grant:id:evm:v1', 'Midnight Night Market',
  'wallet.example', 'a', 'A b C d', 'x'.repeat(32), '~!#$%&()*+,-./:;<=>?@[]^_`{|}', 'MN Bank - grants v1',
];
const shown = new Map<string, string>();
for (const s of GOOD) {
  const b = zeroPadded(s, 32);
  const out = probe.label_text_32(b);
  assert.equal(ascii(out), labelShown(b), `label_text_32(${JSON.stringify(s)})`);
  assert.equal(ascii(out).trimEnd(), s);
  shown.set(ascii(out), s);
  count('label_text_32', 'accepted');
}
for (let i = 0; i < 64; i++) {
  // Random canonical labels: words of visible characters, single spaces.
  const r = rnd(32);
  const len = 1 + (r[0] % 32);
  let s = '';
  for (let j = 0; j < len; j++) {
    const c = 0x21 + (r[j] % 94);
    s += j > 0 && j < len - 1 && r[j] % 7 === 0 && s[s.length - 1] !== ' ' ? ' ' : String.fromCharCode(c);
  }
  const b = zeroPadded(s, 32);
  const out = ascii(probe.label_text_32(b));
  assert.equal(out, labelShown(b));
  if (shown.has(out)) assert.equal(shown.get(out), s, `two labels show the same text: ${JSON.stringify(out)}`);
  shown.set(out, s);
  count('label_text_32', 'accepted');
}
const BAD: [string, Uint8Array][] = [
  ['empty', new Uint8Array(32)],
  ['leading space', zeroPadded(' a', 32)],
  ['trailing space before the padding', zeroPadded('a ', 32)],
  ['trailing space at full width', bytes('a'.repeat(31) + ' ')],
  ['double space', zeroPadded('a  b', 32)],
  ['zero byte inside the text', zeroPadded('a\0b', 32)],
  ['space-padded instead of zero-padded', bytes('abc'.padEnd(32, ' '))],
  ['newline', zeroPadded('a\nb', 32)],
  ['tab', zeroPadded('a\tb', 32)],
  ['DEL', zeroPadded('a\x7fb', 32)],
  ['non-ASCII byte', zeroPadded('caf\xe9', 32)],
  ['carriage return at the end', zeroPadded('a\r', 32)],
];
for (const [why, b] of BAD) {
  assert.throws(() => probe.label_text_32(b), /not a zero-padded label/, `label_text_32 must refuse: ${why}`);
  count('label_text_32', 'refused');
}
console.log(`  ✓ label_text_32: ${counts.label_text_32.accepted} canonical labels shown one-to-one, ${counts.label_text_32.refused} malformed labels refused`);

for (const o of ['https://a.example.com', 'http://localhost:5173', 'https://x.y.bank.test']) {
  assert.equal(ascii(probe.visible_text_21(bytes(o))), o);
  count('visible_text_21', 'accepted');
}
for (const [why, o] of [
  ['space', 'https://a example.com'], ['zero byte', 'https://a.example.co\0'],
  ['DEL', 'https://a.example.co\x7f'], ['non-ASCII', 'https://a.example.co\xe9'], ['newline', 'https://a.example.co\n'],
] as [string, string][]) {
  assert.throws(() => probe.visible_text_21(bytes(o)), /not visible ASCII/, `visible_text_21 must refuse: ${why}`);
  count('visible_text_21', 'refused');
}
console.log(`  ✓ visible_text_21: ${counts.visible_text_21.accepted} origins shown byte for byte, ${counts.visible_text_21.refused} refused`);

// ── Enumerated values ───────────────────────────────────────────────────────

console.log('\n── enums');
const enums: [string, (v: bigint) => unknown, readonly string[], (v: bigint) => string, string][] = [
  ['recipient_kind_text', (v) => probe.recipient_kind_text(v), RECIPIENT_KIND_LABELS, recipientKindLabel, 'unknown recipient kind'],
  ['k256_envelope_text', (v) => probe.k256_envelope_text(v), K256_ENVELOPE_LABELS, k256EnvelopeLabel, 'unknown signing envelope'],
];
for (const [name, f, table, client, refusal] of enums) {
  const texts = new Set<string>();
  for (let v = 0n; v < 256n; v++) {
    if (v < BigInt(table.length)) {
      const out = ascii(f(v) as bigint[]);
      assert.equal(out.length, ENUM_TEXT_WIDTH);
      assert.equal(out, table[Number(v)].padEnd(ENUM_TEXT_WIDTH, ' '), `${name}(${v})`);
      assert.equal(out, Buffer.from(enumText(client(v))).toString('latin1'), `${name}(${v}) == the client's text`);
      assert.ok(/^[!-~]+(?: [!-~]+)* *$/.test(out), `${name}(${v}): visible words, then spaces`);
      assert.ok(!texts.has(out), `${name}: two values show the same label`);
      texts.add(out);
      count(name, 'accepted');
    } else {
      assert.throws(() => f(v), (e: unknown) => String(e).includes(`failed assert: display: ${refusal}`), `${name}(${v}) must be refused`);
      assert.throws(() => client(v), (e: unknown) => String(e).includes(refusal), `the client must refuse ${name}(${v})`);
      count(name, 'refused');
    }
  }
  console.log(`  ✓ ${name}: ${counts[name].accepted} labels equal the client table (${table.map((t) => JSON.stringify(t)).join(', ')}), ${counts[name].refused} other values refused`);
}

// ── Exact words ─────────────────────────────────────────────────────────────

console.log('\n── exact words');
const words: Record<string, unknown> = {};
{
  // Expiry: "never" only for 0.
  const U64 = (1n << 64n) - 1n;
  for (const v of [0n, 1n, 9n, 10n, 1712345678n, U64, U64 - 1n, ...Array.from({ length: 16 }, () => randBig(64))]) {
    const out = ascii(probe.expiry_text(v, vec(decimal(v, 20))) as bigint[]);
    const want = (v === 0n ? 'never' : v.toString()).padEnd(EXPIRY_TEXT_WIDTH, ' ');
    assert.equal(out, want, `expiry_text(${v})`);
    assert.equal(out, Buffer.from(expiryTextBytes(v)).toString('latin1'), `expiry_text(${v}) == the client`);
    assert.equal(out.startsWith(NEVER_TEXT), v === 0n, `"never" iff the expiry is 0 (${v})`);
    count('expiry_text', 'accepted');
  }
  for (const [v, text, why, label] of [
    [0n, 'never', /left-aligned/, 'the word as digits'],
    [0n, '00', /leading zero/, 'zero with a leading zero'],
    [1n, '0', /do not match/, "0's digits for 1 (the word follows the value, not the text)"],
    [1n, '2', /do not match/, 'wrong digits'],
  ] as [bigint, string, RegExp, string][]) {
    assert.throws(() => probe.expiry_text(v, vec(bytes(text.padEnd(20, ' ')))), why, `expiry_text: ${label}`);
    count('expiry_text', 'refused');
  }
  console.log(`  ✓ expiry_text: ${counts.expiry_text.accepted} values ("never" exactly for 0, else the decimal seconds) equal the client; ${counts.expiry_text.refused} wrong digit texts refused`);

  // RP hash: "not applicable" only for the all-zero hash.
  const hashes: Uint8Array[] = [new Uint8Array(32), new Uint8Array(32).fill(0xff), rnd(32), rnd(32)];
  for (let i = 0; i < 32; i++) { const h = new Uint8Array(32); h[i] = 1; hashes.push(h); }
  for (const h of hashes) {
    const out = ascii(probe.rp_hash_text(h) as bigint[]);
    const zero = h.every((b) => b === 0);
    assert.equal(out, (zero ? 'not applicable' : hexOf(h)).padEnd(RP_HASH_TEXT_WIDTH, ' '), `rp_hash_text(${hexOf(h)})`);
    assert.equal(out, Buffer.from(rpHashTextBytes(h)).toString('latin1'), 'rp_hash_text == the client');
    assert.equal(out, ascii(probe.rp_hash_text_from_hex(h, probe.hex_text_32(h)) as bigint[]), 'rp_hash_text == rp_hash_text_from_hex(h, hex_text_32(h))');
    assert.equal(out.startsWith(NOT_APPLICABLE_TEXT), zero, '"not applicable" iff the hash is all zero');
    count('rp_hash_text', 'accepted');
  }
  // The word is never a hex text, and a hex text is never the word: the selection is one-to-one.
  assert.ok(!/^[0-9a-f]{64}$/.test(NOT_APPLICABLE_TEXT.padEnd(64, ' ')));
  assert.throws(() => rpHashText(new Uint8Array(31)), /32 bytes/);
  console.log(`  ✓ rp_hash_text: ${counts.rp_hash_text.accepted} hashes ("not applicable" exactly for all zero, incl. every single-bit-set byte position, else 64 hex digits) equal the client and rp_hash_text_from_hex`);

  words.rule = 'a word only for an exact protocol value, by exact equality: expiry 0 -> "never" (20 bytes, space-padded); an all-zero RP hash -> "not applicable" (64 bytes, space-padded)';
}
report.words = words;

// ── Window words ────────────────────────────────────────────────────────────

console.log('\n── window words');
{
  const U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n;
  for (const len of [0n, 1n, 60n, 86400n, U64, ...Array.from({ length: 8 }, () => randBig(64))]) {
    const out = ascii(probe.window_text(len, vec(decimal(len, 20))) as bigint[]);
    assert.equal(out, (len === 0n ? 'no window' : len.toString()).padEnd(WINDOW_TEXT_WIDTH, ' '), `window_text(${len})`);
    assert.equal(out, Buffer.from(windowTextBytes(len)).toString('latin1'), `window_text(${len}) == the client`);
    assert.equal(out.startsWith(NO_WINDOW_TEXT), len === 0n);
    count('window_text', 'accepted');
    for (const cap of [0n, 1n, U128, randBig(128)]) {
      const c = ascii(probe.window_cap_text(len, cap, vec(decimal(cap, 39))) as bigint[]);
      const word = len === 0n && cap === 0n;
      assert.equal(c, (word ? 'no window' : cap.toString()).padEnd(WINDOW_CAP_TEXT_WIDTH, ' '), `window_cap_text(${len}, ${cap})`);
      assert.equal(c, Buffer.from(windowCapTextBytes(len, cap)).toString('latin1'), 'window_cap_text == the client');
      assert.equal(windowCapText(len, cap).startsWith(NO_WINDOW_TEXT), word);
      count('window_cap_text', 'accepted');
    }
  }
  for (const [f, label, why] of [
    [() => probe.window_text(0n, vec(bytes('no window'.padEnd(20, ' ')))), 'the word as digits', /left-aligned/],
    [() => probe.window_text(1n, vec(decimal(0n, 20))), "0's digits for 1", /do not match/],
    [() => probe.window_text(0n, vec(decimal(1n, 20))), "1's digits for 0", /do not match/],
    [() => probe.window_cap_text(0n, 5n, vec(decimal(0n, 39))), "0's digits for a cap of 5", /do not match/],
    [() => probe.window_cap_text(0n, 0n, vec(bytes('no window'.padEnd(39, ' ')))), 'the word as the cap digits', /left-aligned/],
  ] as [() => unknown, string, RegExp][]) {
    assert.throws(f, why, `window: ${label}`);
    count('window_text', 'refused');
  }
  for (const [f, label] of [[() => windowText(-1n), 'a negative window'], [() => windowText(1n << 64n), 'a window above 2^64 - 1'],
    [() => windowCapText(0n, 1n << 128n), 'a cap above 2^128 - 1']] as [() => unknown, string][]) {
    assert.throws(f, /out of range/, `the client refuses ${label}`);
    count('window_text', 'refused');
  }
  console.log(`  ✓ window_text: ${counts.window_text.accepted} lengths ("no window" exactly for 0); window_cap_text: ${counts.window_cap_text.accepted} (length, cap) pairs ("no window" exactly when both are 0); both equal the client; ${counts.window_text.refused} wrong inputs refused`);
}

// ── UTC dates ───────────────────────────────────────────────────────────────

console.log('\n── UTC dates');
{
  // The independent renderer: Node's Date.
  const iso = (v: bigint): string => {
    if (v > 253402300799n) return 'after 9999-12-31 23:59:59 UTC';
    const t = new Date(Number(v) * 1000).toISOString();
    return `${t.slice(0, 10)} ${t.slice(11, 19)} UTC`;
  };
  const at = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0) => BigInt(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000);
  const splitOf = (year: bigint): bigint[] => { const y1 = year - 1n; return [y1 / 400n, (y1 % 400n) / 100n, (y1 % 100n) / 4n, y1 % 4n]; };
  const U64 = (1n << 64n) - 1n;
  const values: bigint[] = [
    0n, 1n, 59n, 60n, 3599n, 3600n, 86399n, 86400n,
    at(1972, 2, 29), at(1972, 3, 1), at(1999, 12, 31, 23, 59, 59), at(2000, 1, 1),
    at(2000, 2, 28), at(2000, 2, 29), at(2000, 3, 1), at(2024, 2, 29, 12, 34, 56), at(2024, 3, 1),
    at(2026, 11, 16, 14, 51, 50), at(2038, 1, 19, 3, 14, 8),
    at(2100, 2, 28, 23, 59, 59), at(2100, 3, 1), at(2200, 3, 1), at(2300, 2, 28), at(2400, 2, 29), at(2400, 3, 1),
    at(9999, 12, 31), 253402300799n, 253402300800n, 253402300801n, 1n << 40n, U64 - 1n, U64,
    ...Array.from({ length: 48 }, () => randBig(64) % 253402300800n),
    ...Array.from({ length: 8 }, () => randBig(64)),
  ];
  assert.equal(iso(1794840710n), '2026-11-16 14:51:50 UTC');
  assert.equal(iso(253402300799n), '9999-12-31 23:59:59 UTC');
  for (const v of values) {
    const want = iso(v);
    const { text, yearSplit } = utcDateTimeInputs(v);
    assert.equal(ascii(text), want.padEnd(DATETIME_TEXT_WIDTH, ' '), `the client's date text (${v})`);
    assert.deepEqual(yearSplit, v > DATETIME_MAX ? [0n, 0n, 0n, 0n] : splitOf(BigInt(want.slice(0, 4))), `the client's year split (${v})`);
    const out = ascii(probe.utc_datetime_text(v, text, yearSplit) as bigint[]);
    assert.equal(out, want.padEnd(DATETIME_TEXT_WIDTH, ' '), `utc_datetime_text(${v})`);
    assert.equal(out, Buffer.from(utcDateTimeTextBytes(v)).toString('latin1'));
    assert.equal(utcDateTimeText(v), want);
    const exp = ascii(probe.expiry_datetime_text(v, text, yearSplit) as bigint[]);
    assert.equal(exp, (v === 0n ? 'never' : want).padEnd(DATETIME_TEXT_WIDTH, ' '), `expiry_datetime_text(${v})`);
    assert.equal(exp, Buffer.from(expiryDateTimeTextBytes(v)).toString('latin1'));
    assert.equal(expiryDateTimeText(v), v === 0n ? NEVER_TEXT : want);
    count('utc_datetime_text', 'accepted');
  }
  assert.equal(ascii(utcDateTimeInputs(253402300800n).text), AFTER_RANGE_TEXT);
  // Refusals, each named by the first check that fails. All but the last
  // case fail exactly one check (the prover suite bypasses that one alone).
  const T = (s: string) => vec(bytes(s.padEnd(DATETIME_TEXT_WIDTH, ' ')));
  const D = (v: bigint) => utcDateTimeInputs(v);
  const cases: [string, bigint, bigint[], bigint[], RegExp][] = [
    ['a slash for a dash', 0n, T('1970/01-01 00:00:00 UTC'), D(0n).yearSplit, /not a UTC date and time/],
    ['a letter for a digit', 0n, T('197O-01-01 00:00:00 UTC'), D(0n).yearSplit, /not a UTC date and time/],
    ['lower-case utc', 0n, T('1970-01-01 00:00:00 utc'), D(0n).yearSplit, /not a UTC date and time/],
    ['a T for the space', 0n, T('1970-01-01T00:00:00 UTC'), D(0n).yearSplit, /not a UTC date and time/],
    ['a character in the padding', 0n, vec(bytes('1970-01-01 00:00:00 UTC     Z')), D(0n).yearSplit, /not a UTC date and time/],
    ['zero-byte padding', 0n, vec(bytes('1970-01-01 00:00:00 UTC'.padEnd(29, '\0'))), D(0n).yearSplit, /not a UTC date and time/],
    ['month 13 (the alias of 1970-12-01)', at(1970, 12, 1), T('1970-13-01 00:00:00 UTC'), D(0n).yearSplit, /month out of range/],
    ['month 00 (the alias of 1970-12-01)', at(1970, 12, 1), T('1970-00-01 00:00:00 UTC'), D(0n).yearSplit, /month out of range/],
    ['29 February 2100 (the alias of 2100-03-01)', at(2100, 3, 1), T('2100-02-29 00:00:00 UTC'), D(at(2100, 3, 1)).yearSplit, /day out of range/],
    ['29 February 2023 (the alias of 2023-03-01)', at(2023, 3, 1), T('2023-02-29 00:00:00 UTC'), D(at(2023, 3, 1)).yearSplit, /day out of range/],
    ['30 February 2024 (the alias of 2024-03-01)', at(2024, 3, 1), T('2024-02-30 00:00:00 UTC'), D(at(2024, 3, 1)).yearSplit, /day out of range/],
    ['31 April (the alias of 1 May)', at(2025, 5, 1), T('2025-04-31 00:00:00 UTC'), D(at(2025, 5, 1)).yearSplit, /day out of range/],
    ['32 January (the alias of 1 February)', at(1970, 2, 1), T('1970-01-32 00:00:00 UTC'), D(0n).yearSplit, /day out of range/],
    ['day 00 (the alias of the last day before)', at(1970, 1, 31), T('1970-02-00 00:00:00 UTC'), D(0n).yearSplit, /day out of range/],
    ['hour 24 (the alias of the next midnight)', 86400n, T('1970-01-01 24:00:00 UTC'), D(0n).yearSplit, /time of day out of range/],
    ['minute 60', 3600n, T('1970-01-01 00:60:00 UTC'), D(0n).yearSplit, /time of day out of range/],
    ['second 60', 60n, T('1970-01-01 00:00:60 UTC'), D(0n).yearSplit, /time of day out of range/],
    ['a split outside its ranges (makes 2100 leap)', at(2100, 3, 1), T('2100-02-29 00:00:00 UTC'), [4n, 3n, 49n, 3n], /year split is not canonical/],
    ['the split of the next year', at(2026, 6, 1), T('2026-06-01 00:00:00 UTC'), splitOf(2027n), /year split is not canonical/],
    ['a split of 1 too many hundreds', at(2026, 6, 1), T('2026-06-01 00:00:00 UTC'), [4n, 6n, 6n, 1n], /year split is not canonical/],
    ['one second off', 1n, T('1970-01-01 00:00:00 UTC'), D(0n).yearSplit, /do not match the value/],
    ['another day', at(2026, 11, 16), T('2026-11-17 00:00:00 UTC'), D(at(2026, 11, 16)).yearSplit, /do not match the value/],
    ['a year before 1970', 0n, T('1969-12-31 23:59:59 UTC'), splitOf(1969n), /do not match the value/],
    ['a date with a zero split above the range', 253402300800n, T('9999-12-31 23:59:59 UTC'), [0n, 0n, 0n, 0n], /not the words for a time after/],
    ['the words with a split above the range', U64, T(AFTER_RANGE_TEXT), [1n, 0n, 0n, 0n], /year split is not canonical/],
    ['the words within the range', 253402300799n, T(AFTER_RANGE_TEXT), D(253402300799n).yearSplit, /not a UTC date and time/],
  ];
  for (const [label, v, text, split, why] of cases) {
    assert.throws(() => probe.utc_datetime_text(v, text, split), why, `utc_datetime_text must refuse: ${label}`);
    assert.throws(() => probe.expiry_datetime_text(v, text, split), why, `expiry_datetime_text must refuse: ${label}`);
    count('utc_datetime_text', 'refused');
  }
  // 1900 lies before the range; its leap rule (no 29 February) is the
  // same century rule as 2100, 2200 and 2300 above.
  for (const [f, label] of [[() => utcDateTimeText(-1n), 'a negative time'], [() => utcDateTimeText(1n << 64n), 'a time above 2^64 - 1'],
    [() => expiryDateTimeText(-1n), 'a negative expiry'], [() => utcDateTimeInputs(1n << 64n), 'inputs above 2^64 - 1']] as [() => unknown, string][]) {
    assert.throws(f, /out of range/, `the client refuses ${label}`);
    count('utc_datetime_text', 'refused');
  }
  console.log(`  ✓ utc_datetime_text and expiry_datetime_text: ${counts.utc_datetime_text.accepted} values equal Node's Date and the client ("never" for an expiry of 0, the words above 253402300799); ${counts.utc_datetime_text.refused} wrong inputs refused`);
}

// ── Base58 ──────────────────────────────────────────────────────────────────

console.log('\n── base58');
{
  // The independent renderer: base conversion on a byte array (no BigInt).
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (src: Uint8Array): string => {
    let zeros = 0;
    while (zeros < src.length && src[zeros] === 0) zeros++;
    const out: number[] = [];
    for (const byte of src) {
      let carry = byte;
      for (let j = 0; j < out.length; j++) { carry += out[j] << 8; out[j] = carry % 58; carry = Math.floor(carry / 58); }
      while (carry > 0) { out.push(carry % 58); carry = Math.floor(carry / 58); }
    }
    return '1'.repeat(zeros) + out.reverse().map((d) => ALPHA[d]).join('');
  };
  // The read-back hints of any digit vector, by the circuit's formulas.
  const hintsOf = (digits: bigint[]) => {
    const group = (g: bigint[]) => g.reduce(([v, m], d) => (d === 58n ? [v, m] : [v * 58n + d, m * 58n]), [0n, 1n]);
    const [v1] = group(digits.slice(0, 21)), [v2, m2] = group(digits.slice(21, 42)), [v3, m3] = group(digits.slice(42));
    const l2 = m2 * v1 + v2, low = l2 % (1n << 128n);
    return { carry: l2 >> 128n, low, top: (m3 * low + v3) >> 128n };
  };
  const run = (b: Uint8Array, d: bigint[], h: { carry: bigint; low: bigint; top: bigint }) =>
    probe.base58_text_32(vec(b), d, h.carry, h.low, h.top) as bigint[];
  const vals: [string, Uint8Array][] = [
    ['all zero', new Uint8Array(32)], ['all 0xff', new Uint8Array(32).fill(0xff)],
    ['the bytes 0..31', Uint8Array.from({ length: 32 }, (_, i) => i)],
    ['1 then zeros', Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0))],
  ];
  for (let k = 1; k < 32; k++) {
    const b = rnd(32); b.fill(0, 0, k); if (b[k] === 0) b[k] = 1;
    vals.push([`${k} leading zero byte${k > 1 ? 's' : ''}`, b]);
  }
  { const b = new Uint8Array(32); b[31] = 1; vals.push(['31 zero bytes then 1', b]); }
  { const b = new Uint8Array(32); b[31] = 0xff; vals.push(['31 zero bytes then 0xff', b]); }
  for (let i = 0; i < 48; i++) vals.push([`key ${i}`, ed25519.getPublicKey(rnd(32))]);
  for (let i = 0; i < 16; i++) vals.push([`value ${i}`, rnd(32)]);
  const lengths = new Set<number>();
  for (const [name, b] of vals) {
    const want = b58(b);
    assert.equal(base58Text32(b), want, `${name}: the client`);
    assert.equal(base58Encode(b), want, `${name}: descriptors.ts`);
    const { digits, carry, low, top } = base58Inputs(b);
    const out = ascii(run(b, digits, { carry, low, top }));
    assert.equal(out, want.padEnd(BASE58_TEXT_WIDTH, ' '), `base58_text_32 (${name})`);
    assert.equal(out, Buffer.from(base58Text32Bytes(b)).toString('latin1'));
    assert.ok(want.length >= 32 && want.length <= 44, `${name}: 32..44 characters`);
    lengths.add(want.length);
    count('base58_text_32', 'accepted');
  }
  assert.equal(b58(new Uint8Array(32)), '1'.repeat(32));
  assert.equal(b58(new Uint8Array(32).fill(0xff)), 'JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG');
  assert.ok(lengths.has(32) && lengths.has(44) && lengths.has(43), 'the shortest, the longest and a 43-character text');
  // Refusals, each named by the first check that fails. The forged digits
  // and bytes fail exactly one check; a hint off by one fails two of the
  // three limb equations.
  const key = vals.find(([n, b]) => n.startsWith('key') && b58(b).length === 44)![1];
  const kin = base58Inputs(key);
  const lead = vals.find(([n]) => n === '2 leading zero bytes')![1];
  const lin = base58Inputs(lead);
  assert.ok(b58(lead).length < 44);
  const forge = (d: bigint[], f: (x: bigint[]) => void) => { const c = [...d]; f(c); return c; };
  const cases: [string, Uint8Array, bigint[], { carry: bigint; low: bigint; top: bigint }, RegExp][] = [];
  { // A digit of 58 or more: the last two digits (a, b) as (a - 1, b + 58), the same value.
    const i = kin.digits.findIndex((x, j) => j > 0 && j < 43 && x > 0n);
    const d = forge(kin.digits, (c) => { c[42] -= 1n; c[43] += 58n; });
    if (kin.digits[42] > 0n) cases.push(['a digit at 58 or more (the same value)', key, d, hintsOf(d), /not a left-aligned base58 text/]);
    else { const e = forge(kin.digits, (c) => { c[i] -= 1n; c[i + 1] += 58n; }); cases.push(['a digit at 58 or more (the same value)', key, e, hintsOf(e), /not a left-aligned base58 text/]); }
  }
  { const n = b58(lead).length; // padding inside: a space before the last digit, the same value
    const d = forge(lin.digits, (c) => { c.splice(n - 1, 0, 58n); c.pop(); });
    cases.push(['padding inside the text (the same value)', lead, d, hintsOf(d), /not a left-aligned base58 text/]); }
  { const d = forge(lin.digits, (c) => { c.unshift(0n); c.pop(); });
    cases.push(['a "1" too many', lead, d, hintsOf(d), /leading base58 ones do not match/]); }
  { const d = forge(lin.digits, (c) => { c.shift(); c.push(58n); });
    cases.push(['a "1" too few', lead, d, hintsOf(d), /leading base58 ones do not match/]); }
  cases.push(['a digit changed in the first group', key, forge(kin.digits, (c) => { c[5] = (c[5] + 1n) % 58n; }), kin, /carry hints do not split/]);
  cases.push(['a digit changed in the second group', key, forge(kin.digits, (c) => { c[30] = (c[30] + 1n) % 58n; }), kin, /carry hints do not split/]);
  cases.push(['a digit changed in the third group', key, forge(kin.digits, (c) => { c[43] = (c[43] + 1n) % 58n; }), kin, /value's low bytes/]);
  { const b = Uint8Array.from(key); b[3] ^= 1; cases.push(['a byte changed in the high half', b, kin.digits, kin, /value's high bytes/]); }
  { const b = Uint8Array.from(key); b[20] ^= 1; cases.push(['a byte changed in the low half', b, kin.digits, kin, /value's low bytes/]); }
  cases.push(['carry + 1', key, kin.digits, { ...kin, carry: kin.carry + 1n }, /carry hints do not split/]);
  cases.push(['low + 1', key, kin.digits, { ...kin, low: kin.low + 1n }, /carry hints do not split/]);
  cases.push(['top + 1', key, kin.digits, { ...kin, top: kin.top + 1n }, /value's low bytes/]);
  // The hint widths: a value V = N + r at or above the field modulus r,
  // shown as the text of N with hints that make the limb equations hold
  // modulo r. Each needs one hint larger than its type allows (by r's high
  // 128 bits): the carry for a text of at most 42 digits, the top hint for
  // a longer one.
  {
    const R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
    const M128 = (1n << 128n) - 1n;
    const be32 = (v: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((v >> BigInt(8 * (31 - i))) & 0xffn));
    for (const [what, n] of [['carry', 58n ** 41n * 7n + 1000n], ['top', 58n ** 43n + 58n ** 42n * 5n + 1000n]] as [string, bigint][]) {
      const v = n + R;
      assert.ok(v < 1n << 256n);
      const c = (n & M128) + (R & M128) > M128 ? 1n : 0n;
      const nin = base58Inputs(be32(n));
      const h = what === 'carry'
        ? { carry: nin.carry + (R >> 128n) + c, low: v & M128, top: 0n }
        : { carry: nin.carry, low: nin.low, top: nin.top + (R >> 128n) + c };
      cases.push([`the text of V - r with a ${what} hint above its width`, be32(v), nin.digits, h, /type error: .*expected value of type Uint<0\.\./]);
    }
  }
  for (const [label, b, d, h, why] of cases) {
    assert.throws(() => run(b, d, h), why, `base58_text_32 must refuse: ${label}`);
    count('base58_text_32', 'refused');
  }
  assert.throws(() => base58Text32(new Uint8Array(31)), /32 bytes/);
  assert.throws(() => base58Inputs(new Uint8Array(33)), /32 bytes/);
  count('base58_text_32', 'refused'); count('base58_text_32', 'refused');
  console.log(`  ✓ base58_text_32: ${counts.base58_text_32.accepted} values (texts of ${[...lengths].sort((a, b) => a - b).join(', ')} characters) equal an independent renderer, the client and base58Encode; ${counts.base58_text_32.refused} forged inputs refused`);
}

// ── The site's amount label ─────────────────────────────────────────────────

console.log('\n── the site\'s amount label');
{
  // The independent renderer: integer and fraction parts by division.
  const label = (v: bigint, dec: number, sym: string): string => {
    const scale = 10n ** BigInt(dec);
    const num = dec === 0 ? v.toString() : `${v / scale}.${(v % scale).toString().padStart(dec, '0')}`;
    return `${num} ${sym}`;
  };
  const U128 = (1n << 128n) - 1n;
  const SYMBOLS = ['X', 'tUSDC', 'USDC', 'NIGHT', 'tDUST', 'ABCDEFGH', 'w.ETH', 'a1', 'Z~!'];
  for (const v of [0n, 1n, 9n, 10n, 1200000n, 999999999999999999n, 10n ** 18n, U128, randBig(128), randBig(64), randBig(20)]) {
    for (let dec = 0; dec <= 18; dec += v % 3n === 0n ? 1 : 6) {
      const sym = SYMBOLS[Number((v + BigInt(dec)) % BigInt(SYMBOLS.length))];
      const want = label(v, dec, sym);
      assert.equal(siteAmountLabel(v, dec, sym), want, `the client (${v}, ${dec}, ${sym})`);
      const out = ascii(probe.site_amount_label_text(v, vec(siteAmountLabelBytes(v, dec, sym))) as bigint[]);
      assert.equal(out, want.padEnd(SITE_AMOUNT_LABEL_WIDTH, ' '), `site_amount_label_text(${v}, ${dec}, ${sym})`);
      count('site_amount_label_text', 'accepted');
    }
  }
  const L = (s: string) => vec(bytes(s.padEnd(SITE_AMOUNT_LABEL_WIDTH, ' ')));
  for (const [v, text, why, what] of [
    [1n, '0.0000000000000000001 tUSDC', /more than 18 decimals/, '19 decimals'],
    [1000000n, '1.000000 ABCDEFGHI', /symbol longer than 8/, 'a symbol of 9 characters'],
    [1000000n, '1 000000', /does not start with a letter|do not match/, 'a symbol starting with a digit ("1 000")'],
    [1000000n, '1.000000 000', /does not start with a letter/, 'a digit symbol after the number'],
    [1000000n, '1.000000 .5', /does not start with a letter/, 'a symbol starting with a point'],
    [1000000n, '1.000000 tUS\nDC', /not a site amount label/, 'a line break'],
    [15n, '01.5 X', /leading zero in the site amount label/, 'a leading zero'],
    [0n, '00 X', /leading zero in the site amount label/, 'zero with a leading zero'],
    [16n, '1.5 X', /does not match the value/, 'other digits'],
    [5n, '5', /not a site amount label/, 'no symbol'],
    [5n, '5 ', /not a site amount label/, 'no symbol before the padding'],
    [5n, '5. X', /not a site amount label/, 'a point without decimals'],
    [5n, '.5 X', /not a site amount label/, 'no digit before the point'],
    [5n, '5  X', /not a site amount label/, 'two spaces'],
    [5n, '5 X Y', /not a site amount label/, 'a second word'],
    [5n, '', /not a site amount label/, 'empty'],
    [5n, '5 X\0', /not a site amount label/, 'a zero byte'],
    [5n, '5,0 X', /not a site amount label/, 'a comma'],
    [5n, '5 Xé', /not a site amount label/, 'a non-ASCII byte'],
  ] as [bigint, string, RegExp, string][]) {
    assert.throws(() => probe.site_amount_label_text(v, L(text)), why, `site_amount_label_text must refuse: ${what}`);
    count('site_amount_label_text', 'refused');
  }
  for (const [f, why, what] of [
    [() => siteAmountLabel(1n, 19, 'X'), /0 to 18 decimals/, '19 decimals'],
    [() => siteAmountLabel(1n, -1, 'X'), /0 to 18 decimals/, 'negative decimals'],
    [() => siteAmountLabel(1n, 1.5, 'X'), /0 to 18 decimals/, 'fractional decimals'],
    [() => siteAmountLabel(1n, 0, ''), /first a letter/, 'an empty symbol'],
    [() => siteAmountLabel(1n, 0, '9X'), /first a letter/, 'a symbol starting with a digit'],
    [() => siteAmountLabel(1n, 0, 'ABCDEFGHI'), /first a letter/, 'a symbol of 9 characters'],
    [() => siteAmountLabel(1n, 0, 'A B'), /first a letter/, 'a symbol with a space'],
    [() => siteAmountLabel(-1n, 0, 'X'), /out of range/, 'a negative amount'],
    [() => siteAmountLabel(1n << 128n, 0, 'X'), /out of range/, 'an amount above 2^128 - 1'],
  ] as [() => unknown, RegExp, string][]) {
    assert.throws(f, why, `the client refuses ${what}`);
    count('site_amount_label_text', 'refused');
  }
  console.log(`  ✓ site_amount_label_text: ${counts.site_amount_label_text.accepted} labels (0..18 decimals, symbols of 1..8 characters, up to 2^128 - 1) equal an independent renderer and the client; ${counts.site_amount_label_text.refused} malformed labels refused by the circuit or the client`);
}

report.counts = counts;
report.verdict = 'PASS';
if (process.env.EVIDENCE_DIR) {
  const file = path.join(process.env.EVIDENCE_DIR, 'wallet-arms-rendering-offline.json');
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n■ evidence → ${file}`);
}
console.log('\n◆ wallet-arms-rendering-offline: PASS');
