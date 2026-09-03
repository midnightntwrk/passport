/*
 * Everything Passport Poll needs to know about the outside world.
 *
 * Neither value is a default worth guessing wrong. A request sent to the wrong
 * Passport origin is never delivered and never answered, and a tally service
 * on the wrong port is a poll that silently counts nothing. Override both with
 * a `.env.local`.
 */

/** The Passport this app asks. Production by default — see the README. */
export const PASSPORT_ORIGIN: string =
  import.meta.env.VITE_PASSPORT_ORIGIN ?? 'https://midnightpassport.com';

/** The vote-tally service. Its own origin, on its own port. */
export const TALLY_URL: string = import.meta.env.VITE_TALLY_URL ?? 'http://localhost:5183';

/** How often results are refreshed while a poll is on screen. */
export const REFRESH_MS = 3_000;
