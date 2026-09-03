/*
 * Everything Passport Swap needs to know about the outside world.
 *
 * Both origins are named explicitly and neither is guessed. A message sent to
 * the wrong Passport origin is never delivered and never answered, and a swap
 * desk at the wrong address is a quote nobody will honour — so both are
 * overridable with a `.env.local` and both default to what the demo runs on.
 */

/** The Passport this app talks to. Production by default. */
export const PASSPORT_ORIGIN: string =
  import.meta.env.VITE_PASSPORT_ORIGIN ?? 'https://midnightpassport.com';

/** The swap desk — the same service that opens a Passport's account. */
export const SWAP_DESK: string = (
  import.meta.env.VITE_SWAP_DESK ?? 'https://67-205-177-162.sslip.io'
).replace(/\/+$/, '');

/** Sent only when the desk is configured to require it. */
export const SWAP_DESK_KEY: string | undefined = import.meta.env.VITE_SWAP_DESK_KEY;

/** Where a landed transaction can be read by anybody. */
export const EXPLORER = 'https://explorer.1am.xyz';
export const EXPLORER_NETWORK = import.meta.env.VITE_EXPLORER_NETWORK ?? 'stagenet';

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER}/tx/${hash}?network=${EXPLORER_NETWORK}`;
}
