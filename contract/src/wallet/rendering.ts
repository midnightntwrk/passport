// Readable values — the client's copy of the rendering module's texts
// (contracts/modules/WalletArmRendering.compact): the exact words
// (`expiry_text`, `rp_hash_text`, `window_text`, `window_cap_text`), the UTC
// date (`utc_datetime_text`, `expiry_datetime_text`), base58
// (`base58_text_32`) and the site's amount label (`site_amount_label_text`),
// with the display inputs and hints those circuits check.
//
// A fixed word replaces a value only where the value has an exact protocol
// meaning: a grant expiry of 0 is "never", an all-zero passkey RP hash is
// "not applicable", a zero rate-limit window is "no window". Every other
// value is shown in full; amounts and caps in base units.
//
// The circuit space-pads each text to its field's width; the *Bytes
// functions return exactly those bytes, the plain ones the visible text.

/** The width of a Uint<64> decimal field, and of the expiry text. */
export const EXPIRY_TEXT_WIDTH = 20;
/** The width of a 32-byte hash in hex, and of the RP hash text. */
export const RP_HASH_TEXT_WIDTH = 64;
/** A grant expiry of 0: the grant never expires. */
export const NEVER_TEXT = 'never';
/** An all-zero passkey RP hash: no passkey is involved. */
export const NOT_APPLICABLE_TEXT = 'not applicable';

const UINT64_MAX = (1n << 64n) - 1n;

const asBig = (v: bigint | number, what: string, max: bigint): bigint => {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error(`rendering: ${what} must be an integer`);
  const n = BigInt(v);
  if (n < 0n || n > max) throw new Error(`rendering: ${what} out of range`);
  return n;
};
const padded = (s: string, w: number): Uint8Array => new TextEncoder().encode(s.padEnd(w, ' '));

/** A grant's expiry (block time, seconds): "never" for 0, else the decimal seconds. */
export function expiryText(value: bigint | number): string {
  const v = asBig(value, 'an expiry', UINT64_MAX);
  return v === 0n ? NEVER_TEXT : v.toString(10);
}

/** The expiry as the circuit shows it: space-padded to 20 bytes. */
export const expiryTextBytes = (value: bigint | number): Uint8Array => padded(expiryText(value), EXPIRY_TEXT_WIDTH);

/** A grant's passkey RP hash: "not applicable" when all 32 bytes are zero, else its 64 hex digits. */
export function rpHashText(h: Uint8Array): string {
  if (!(h instanceof Uint8Array) || h.length !== 32) throw new Error('rendering: an RP hash is 32 bytes');
  return h.every((b) => b === 0) ? NOT_APPLICABLE_TEXT : Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The RP hash as the circuit shows it: space-padded to 64 bytes. */
export const rpHashTextBytes = (h: Uint8Array): Uint8Array => padded(rpHashText(h), RP_HASH_TEXT_WIDTH);

// ── Rate-limit window ───────────────────────────────────────────────────────

/** The width of the window length text (a Uint<64> decimal). */
export const WINDOW_TEXT_WIDTH = 20;
/** The width of the window cap text (a Uint<128> decimal). */
export const WINDOW_CAP_TEXT_WIDTH = 39;
/** A zero rate-limit window: no per-window bound applies. The scoped-grants
 *  MIP reserves the window fields and requires both to be 0. */
export const NO_WINDOW_TEXT = 'no window';

const UINT128_MAX = (1n << 128n) - 1n;

/** A grant's window length (seconds): "no window" for 0, else the decimal seconds. */
export function windowText(windowLen: bigint | number): string {
  const v = asBig(windowLen, 'a window length', UINT64_MAX);
  return v === 0n ? NO_WINDOW_TEXT : v.toString(10);
}

/** The window length as the circuit shows it: space-padded to 20 bytes. */
export const windowTextBytes = (windowLen: bigint | number): Uint8Array => padded(windowText(windowLen), WINDOW_TEXT_WIDTH);

/** A grant's window cap: "no window" when the window length and the cap are
 *  both 0, else the cap's decimal digits. */
export function windowCapText(windowLen: bigint | number, windowCap: bigint | number): string {
  const len = asBig(windowLen, 'a window length', UINT64_MAX);
  const cap = asBig(windowCap, 'a window cap', UINT128_MAX);
  return len === 0n && cap === 0n ? NO_WINDOW_TEXT : cap.toString(10);
}

/** The window cap as the circuit shows it: space-padded to 39 bytes. */
export const windowCapTextBytes = (windowLen: bigint | number, windowCap: bigint | number): Uint8Array =>
  padded(windowCapText(windowLen, windowCap), WINDOW_CAP_TEXT_WIDTH);

// ── UTC date and time ───────────────────────────────────────────────────────

/** The width of the date text: "yyyy-mm-dd hh:mm:ss UTC" (23) space-padded,
 *  or the 29-byte words above the range. */
export const DATETIME_TEXT_WIDTH = 29;
/** The last second shown as a date: 9999-12-31 23:59:59 UTC. */
export const DATETIME_MAX = 253402300799n;
/** The words for any later time. */
export const AFTER_RANGE_TEXT = 'after 9999-12-31 23:59:59 UTC';

/** The civil date of a day count since 1970-01-01 (proleptic Gregorian). */
function civilFromDays(z: bigint): { year: bigint; month: bigint; day: bigint } {
  const zz = z + 719468n;                          // days since 0000-03-01
  const era = zz / 146097n;                         // zz >= 0 in the supported range
  const doe = zz - era * 146097n;                   // [0, 146096]
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;                // March = 0
  const day = doy - (153n * mp + 2n) / 5n + 1n;
  const month = mp < 10n ? mp + 3n : mp - 9n;
  const year = yoe + era * 400n + (month <= 2n ? 1n : 0n);
  return { year, month, day };
}

const two = (n: bigint): string => n.toString(10).padStart(2, '0');

/** Unix seconds as "yyyy-mm-dd hh:mm:ss UTC" for 0 to 253402300799, and the
 *  words "after 9999-12-31 23:59:59 UTC" above. */
export function utcDateTimeText(value: bigint | number): string {
  const v = asBig(value, 'a time', UINT64_MAX);
  if (v > DATETIME_MAX) return AFTER_RANGE_TEXT;
  const { year, month, day } = civilFromDays(v / 86400n);
  const sod = v % 86400n;
  return `${year.toString(10).padStart(4, '0')}-${two(month)}-${two(day)} ${two(sod / 3600n)}:${two((sod % 3600n) / 60n)}:${two(sod % 60n)} UTC`;
}

/** The date as the circuit shows it: space-padded to 29 bytes. */
export const utcDateTimeTextBytes = (value: bigint | number): Uint8Array => padded(utcDateTimeText(value), DATETIME_TEXT_WIDTH);

/** A grant's expiry as a date: "never" for 0, else utcDateTimeText. */
export function expiryDateTimeText(value: bigint | number): string {
  const v = asBig(value, 'an expiry', UINT64_MAX);
  return v === 0n ? NEVER_TEXT : utcDateTimeText(v);
}

/** The expiry date as the circuit shows it: space-padded to 29 bytes. */
export const expiryDateTimeTextBytes = (value: bigint | number): Uint8Array => padded(expiryDateTimeText(value), DATETIME_TEXT_WIDTH);

/** The display inputs of utc_datetime_text and expiry_datetime_text: the
 *  date text of the value (the epoch's date for 0, which the expiry circuit
 *  shows as "never") and `yearSplit`, the year minus one as
 *  400 * s[0] + 100 * s[1] + 4 * s[2] + s[3] (all zero above the range). */
export function utcDateTimeInputs(value: bigint | number): { text: bigint[]; yearSplit: bigint[] } {
  const v = asBig(value, 'a time', UINT64_MAX);
  const text = [...utcDateTimeTextBytes(v)].map(BigInt);
  if (v > DATETIME_MAX) return { text, yearSplit: [0n, 0n, 0n, 0n] };
  const y1 = civilFromDays(v / 86400n).year - 1n;
  return { text, yearSplit: [y1 / 400n, (y1 % 400n) / 100n, (y1 % 100n) / 4n, y1 % 4n] };
}

// ── Base58 ──────────────────────────────────────────────────────────────────

/** The width of a 32-byte value's base58 text (32..44 characters, space-padded). */
export const BASE58_TEXT_WIDTH = 44;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const LIMB = 1n << 128n;

const bytes32 = (b: Uint8Array, what: string): Uint8Array => {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`rendering: ${what} is 32 bytes`);
  return b;
};

/** The base58 digits (0..57) of 32 bytes: a 0 per leading zero byte, then the
 *  big-endian value in base 58 without leading zeros. */
function base58Digits(b: Uint8Array): number[] {
  let zeros = 0;
  while (zeros < 32 && b[zeros] === 0) zeros++;
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n % 58n)); n /= 58n; }
  return [...new Array(zeros).fill(0), ...out];
}

/** 32 bytes as the base58 text Solana wallets show (Bitcoin alphabet). */
export function base58Text32(b: Uint8Array): string {
  return base58Digits(bytes32(b, 'a base58 value')).map((d) => BASE58[d]).join('');
}

/** The base58 text as the circuit shows it: space-padded to 44 bytes. */
export const base58Text32Bytes = (b: Uint8Array): Uint8Array => padded(base58Text32(b), BASE58_TEXT_WIDTH);

/** The display inputs of base58_text_32: the digits (58 at every padding
 *  position) and the hints `carry`, `low` and `top` of the read-back on two
 *  128-bit limbs (positions 0..20, 21..41 and 42..43 form three groups):
 *  58^c2 * v1 + v2 = carry * 2^128 + low, and
 *  58^c3 * low + v3 = top * 2^128 + (the value mod 2^128). */
export function base58Inputs(b: Uint8Array): { digits: bigint[]; carry: bigint; low: bigint; top: bigint } {
  const ds = base58Digits(bytes32(b, 'a base58 value'));
  const digits = [...ds, ...new Array(BASE58_TEXT_WIDTH - ds.length).fill(58)].map(BigInt);
  const group = (g: bigint[]) => g.reduce(([v, m], d) => (d === 58n ? [v, m] : [v * 58n + d, m * 58n]), [0n, 1n]);
  const [v1] = group(digits.slice(0, 21));
  const [v2, m2] = group(digits.slice(21, 42));
  const [v3, m3] = group(digits.slice(42, 44));
  const l2 = m2 * v1 + v2;
  const low = l2 % LIMB;
  return { digits, carry: l2 / LIMB, low, top: (m3 * low + v3) / LIMB };
}

// ── The site's amount label ─────────────────────────────────────────────────

/** The width of the site's amount label. */
export const SITE_AMOUNT_LABEL_WIDTH = 49;

/** The site's label for an amount: the digits of `value` with the site's
 *  decimal point (0..18 decimals) and its symbol (1..8 visible characters,
 *  the first a letter), "<number> <symbol>". */
export function siteAmountLabel(value: bigint, decimals: number, symbol: string): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('rendering: 0 to 18 decimals');
  if (typeof symbol !== 'string' || !/^[A-Za-z][\x21-\x7e]{0,7}$/.test(symbol)) {
    throw new Error('rendering: a symbol is 1 to 8 visible characters, the first a letter');
  }
  if (typeof value !== 'bigint' || value < 0n || value > UINT128_MAX) throw new Error('rendering: amount out of range');
  let d = value.toString(10);
  let number: string;
  if (decimals === 0) number = d;
  else {
    d = d.padStart(decimals + 1, '0');
    number = `${d.slice(0, d.length - decimals)}.${d.slice(d.length - decimals)}`;
  }
  const s = `${number} ${symbol}`;
  if (s.length > SITE_AMOUNT_LABEL_WIDTH) throw new Error('rendering: amount label longer than 49 bytes');
  return s;
}

/** The label as the circuit shows it and takes it: space-padded to 49 bytes. */
export const siteAmountLabelBytes = (value: bigint, decimals: number, symbol: string): Uint8Array =>
  padded(siteAmountLabel(value, decimals, symbol), SITE_AMOUNT_LABEL_WIDTH);
