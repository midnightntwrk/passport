// Text labels of enumerated operands — the client's copy of the rendering
// module's fixed labels (contracts/modules/WalletArmRendering.compact,
// `recipient_kind_text` and `k256_envelope_text`).
//
// A readable approval shows an enumerated value by its label, never as a
// bare number. The circuit selects the label from the executed value and
// refuses a value without one, so a client that shows these texts shows
// exactly what the circuit binds. Each label is visible words; the circuit
// space-pads it to ENUM_TEXT_WIDTH bytes.

/** The width the circuit pads every label to (bytes). */
export const ENUM_TEXT_WIDTH = 24;

/** A grant's recipient kind (scoped-grants MIP): 0 no recipient pin, 1 a
 *  user address (unshielded), 2 a Zswap coin public key (shielded), 3 a
 *  contract address (direct transfer). */
export const RECIPIENT_KIND_LABELS = Object.freeze([
  'any recipient',
  'unshielded user address',
  'shielded coin public key',
  'contract address',
] as const);

/** A k256 key's signing envelope: 0 the key signs SHA-256 of the challenge,
 *  1 it signs through a dApp connector's signData prefix. */
export const K256_ENVELOPE_LABELS = Object.freeze([
  'SHA-256 of the challenge',
  'dApp-connector signData',
] as const);

const label = (table: readonly string[], what: string, v: number | bigint): string => {
  const n = typeof v === 'bigint' ? v : BigInt(v);
  if (typeof v === 'number' && !Number.isInteger(v)) throw new Error(`labels: ${what} must be an integer`);
  if (n < 0n || n >= BigInt(table.length)) throw new Error(`labels: unknown ${what} ${n}`);
  return table[Number(n)];
};

/** The label of a recipient kind (0-3); anything else is refused. */
export const recipientKindLabel = (kind: number | bigint): string => label(RECIPIENT_KIND_LABELS, 'recipient kind', kind);

/** The label of a k256 signing envelope (0 or 1); anything else is refused. */
export const k256EnvelopeLabel = (envelope: number | bigint): string => label(K256_ENVELOPE_LABELS, 'signing envelope', envelope);

/** A label as the circuit shows it: its ASCII bytes, space-padded to
 *  ENUM_TEXT_WIDTH. */
export function enumText(text: string): Uint8Array {
  if (!/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(text) || text.length > ENUM_TEXT_WIDTH) {
    throw new Error(`labels: not a label of at most ${ENUM_TEXT_WIDTH} visible characters: ${JSON.stringify(text)}`);
  }
  return new TextEncoder().encode(text.padEnd(ENUM_TEXT_WIDTH, ' '));
}
