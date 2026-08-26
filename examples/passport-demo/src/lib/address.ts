/**
 * Address display helpers.
 *
 * Nothing here parses or validates: an address that reaches this module has
 * already been produced by the wallet or read back from a signed record, so
 * shortening it is a presentation concern only. A compacted address must never
 * be fed back into anything that transacts.
 */

/**
 * The middle-elided form used in activity rows, toasts, and cards.
 *
 * Addresses shorter than the two windows combined are returned untouched
 * rather than padded, so a short or malformed value stays visibly short
 * instead of being disguised as a well-formed one.
 */
export function compactAddress(address: string): string {
  if (address.length < 18) return address;
  return `${address.slice(0, 9)}...${address.slice(-7)}`;
}
