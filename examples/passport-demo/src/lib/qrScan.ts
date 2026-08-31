/**
 * The address half of the QR vocabulary, kept as its own name.
 *
 * Every rule that used to live here moved into `qrPayload.ts` on 2026/08/31,
 * when Receive learned to DRAW a code and the scanner had to start reading
 * names as well as addresses. Both directions of one format have to be written
 * down once — an encoder and a decoder that disagree produce a QR only some
 * other app can read — so this module is now a projection of that one, kept
 * because "did this code carry an address?" is still a question worth asking
 * in those words.
 */

import { parseQrPayload } from './qrPayload.js';

/**
 * Pulls a plausible Midnight address out of a decoded QR payload, or returns
 * `null` when the payload is anything else — a name, a URL, arbitrary text, an
 * empty read. Plausibility, not validity: the Send sheet's recipient validator
 * remains the sole judge of whether the address is usable.
 */
export function extractMidnightAddress(payload: string): string | null {
  const parsed = parseQrPayload(payload);
  return parsed?.kind === 'address' ? parsed.address : null;
}
