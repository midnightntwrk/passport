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

/* Where a vote's transaction goes. A vote is a real NIGHT transfer from the
   voter's account — a few atomic units, enough to put the vote on chain — to
   the ballot box below (the demo desk's own address on stagenet). */
export const BALLOT_BOX: string =
  import.meta.env.VITE_BALLOT_BOX ??
  'mn_addr_stagenet127xnp9uuxwhh7a8an77mxv02ypt6u09xkk63c9zvdkjsrj4mj68qg7c5ad';
export const VOTE_ATOMIC = '10';
export function explorerTxUrl(hash: string): string {
  return `https://explorer.1am.xyz/tx/${hash}?network=stagenet`;
}
