/**
 * Token colours, normalised and shortened.
 *
 * A Midnight token is identified by its COLOUR — 32 bytes, quoted as 64
 * lowercase hex characters by the ledger, by `colourHexToBytes`, and by the
 * sponsor's own `/status` and `/fund-account` answers. Three separate places
 * in the app read a colour out of somewhere it does not control (build
 * configuration, a sponsor response, the ledger itself), and every one of them
 * has to agree on what counts as one.
 *
 * These two functions lived inside `App.tsx` until 2026/08/25. They moved here
 * for the reason anything moves out of that file: they are pure, they decide
 * something that shows up on screen, and a unit test can hold them to it.
 * Nothing about their behaviour changed.
 */

/**
 * A token colour as both the ledger and `colourHexToBytes` quote it — 64
 * lowercase hex characters — or `null` for anything that is not one.
 *
 * Strict on purpose, and for the caller's own reason: a short value is a
 * misconfiguration rather than an abbreviation, and padding it would make
 * Passport show one colour's balance under another colour's name.
 */
export function normalisedColourHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

/** A colour, shortened for a label. It identifies nothing to a reader whole. */
export function shortColour(colourHex: string): string {
  return colourHex.length <= 18 ? colourHex : `${colourHex.slice(0, 10)}…${colourHex.slice(-6)}`;
}
