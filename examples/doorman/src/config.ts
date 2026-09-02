/*
 * Everything Doorman needs to know about the outside world.
 *
 * The Passport origin is not a default worth guessing wrong: a mistyped origin
 * is a silent failure, because a message sent to the wrong origin is simply
 * never delivered and never answered. Override both values with a `.env.local`
 * when running against something other than the local Passport.
 */

export const PASSPORT_ORIGIN: string =
  import.meta.env.VITE_PASSPORT_ORIGIN ?? 'http://localhost:5173';

/** Where the door fee is paid to. Never shown on screen — it is not copy. */
export const DOORMAN_ACCOUNT: string =
  import.meta.env.VITE_DOORMAN_ACCOUNT ?? 'doorman-demo-account';

/** The price of entry, in the smallest unit, as a decimal string. */
export const DOOR_FEE = '5';
