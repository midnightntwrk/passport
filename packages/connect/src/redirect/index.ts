/* ===========================================================================
 * `@midnight-passport/connect/redirect`
 * ===========================================================================
 *
 * The receiver's half of the signed redirect channel: build the launch URL,
 * remember the state token somewhere that survives the round trip, read the
 * reply out of the fragment, verify it, and scrub the address bar.
 *
 * WHY `sessionStorage` AND NOT A VARIABLE. The tab that navigates away may be
 * discarded by the phone before it comes back — that is the entire reason this
 * channel exists — so the state token has to outlive the page. `sessionStorage`
 * survives a tab restore; a module-level variable does not.
 *
 * Every storage access is guarded. Safari in private mode throws on
 * `sessionStorage`, and a flow that dies there would be a flow that dies on
 * exactly the device this channel was written for.
 * ========================================================================= */

import { MAX_STRING_LENGTH, MAX_PURPOSE_LENGTH, MAX_TX_RECIPIENT_ADDRESS_LENGTH } from '../protocol/limits.js';
import { PassportProtocolError } from '../protocol/errors.js';
import { randomBase64Url } from './encoding.js';
import {
  PASSPORT_CALLBACK_FIELDS_PARAM,
  PASSPORT_CALLBACK_PARAM,
  PASSPORT_CALLBACK_STATE_PARAM,
  PASSPORT_TX_CALLBACK_AMOUNT_PARAM,
  PASSPORT_TX_CALLBACK_PARAM,
  PASSPORT_TX_CALLBACK_PURPOSE_PARAM,
  PASSPORT_TX_CALLBACK_RECIPIENT_PARAM,
  PASSPORT_TX_CALLBACK_STATE_PARAM,
  parsePassportCallbackReturn,
  parsePassportTxCallbackReturn,
  type PassportCallbackField,
  type PassportCallbackReturn,
} from './protocol.js';

export * from './protocol.js';
export * from './crypto.js';
export * from './verify.js';
export { fromBase64Url, randomBase64Url, toBase64Url } from './encoding.js';

const AMOUNT_PATTERN = /^[0-9]{1,20}$/;

/* ---------------------------------------------------------------------------
 * The launch
 * ------------------------------------------------------------------------ */

/**
 * Builds the URL that sends the user to Passport for a PROFILE.
 *
 * `state` is this app's own token. It must be unguessable and it must be
 * remembered somewhere that survives the round trip — see
 * {@link rememberPassportState}.
 */
export function buildPassportLaunchUrl(input: {
  passportOrigin: string;
  callbackUrl: string;
  fields: readonly PassportCallbackField[];
  state: string;
}): string {
  if (input.fields.length === 0) {
    throw new PassportProtocolError(
      'invalid_request',
      'a launch must say which profile fields it wants',
    );
  }
  if (input.state.length > MAX_STRING_LENGTH) {
    throw new PassportProtocolError(
      'invalid_request',
      `the state token must be at most ${MAX_STRING_LENGTH} characters`,
    );
  }
  const target = new URL(input.passportOrigin);
  target.pathname = '/';
  target.searchParams.set(PASSPORT_CALLBACK_PARAM, input.callbackUrl);
  target.searchParams.set(PASSPORT_CALLBACK_FIELDS_PARAM, input.fields.join(','));
  target.searchParams.set(PASSPORT_CALLBACK_STATE_PARAM, input.state);
  return target.href;
}

/**
 * Builds the URL that sends the user to Passport for a PAYMENT.
 *
 * The phone path is the one a QR code lands on, and until this existed it was
 * exactly the path that could not complete a payment without falling back to a
 * pop-up the phone may discard.
 *
 * The intent is validated here rather than discovered to be invalid three
 * redirects later: an amount that is not positive base-10 atomic units, or a
 * purpose longer than the approval sheet can show, is a bug in the calling app
 * and it hears about it at the call site.
 */
export function buildPassportTxLaunchUrl(input: {
  passportOrigin: string;
  callbackUrl: string;
  recipientAddress: string;
  /** Atomic NIGHT units. 1 NIGHT is 1,000,000. Never a float. */
  amount: string | bigint;
  purpose: string;
  state: string;
}): string {
  const amount = typeof input.amount === 'bigint' ? input.amount.toString(10) : input.amount;
  if (
    input.recipientAddress.length === 0 ||
    input.recipientAddress.length > MAX_TX_RECIPIENT_ADDRESS_LENGTH
  ) {
    throw new PassportProtocolError(
      'invalid-request',
      `recipientAddress must be 1 to ${MAX_TX_RECIPIENT_ADDRESS_LENGTH} characters`,
    );
  }
  if (!AMOUNT_PATTERN.test(amount) || /^0+$/.test(amount)) {
    throw new PassportProtocolError(
      'invalid-request',
      'amount must be 1 to 20 base-10 digits of atomic NIGHT, greater than zero',
    );
  }
  if (input.purpose.length === 0 || input.purpose.length > MAX_PURPOSE_LENGTH) {
    throw new PassportProtocolError(
      'invalid-request',
      `purpose must be 1 to ${MAX_PURPOSE_LENGTH} characters`,
    );
  }
  if (input.state.length > MAX_STRING_LENGTH) {
    throw new PassportProtocolError(
      'invalid-request',
      `the state token must be at most ${MAX_STRING_LENGTH} characters`,
    );
  }
  const target = new URL(input.passportOrigin);
  target.pathname = '/';
  target.searchParams.set(PASSPORT_TX_CALLBACK_PARAM, input.callbackUrl);
  target.searchParams.set(PASSPORT_TX_CALLBACK_RECIPIENT_PARAM, input.recipientAddress);
  target.searchParams.set(PASSPORT_TX_CALLBACK_AMOUNT_PARAM, amount);
  target.searchParams.set(PASSPORT_TX_CALLBACK_PURPOSE_PARAM, input.purpose);
  target.searchParams.set(PASSPORT_TX_CALLBACK_STATE_PARAM, input.state);
  return target.href;
}

/** 16 random bytes, base64url. Unguessable, and short enough for a URL. */
export function newPassportState(): string {
  return randomBase64Url(16);
}

/* ---------------------------------------------------------------------------
 * Remembering the state across the round trip
 * ------------------------------------------------------------------------ */

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const STATE_PREFIX = 'passport.connect.state.';

export function rememberPassportState(key: string, state: string): void {
  try {
    storage()?.setItem(`${STATE_PREFIX}${key}`, state);
  } catch {
    /* Nothing to do and nothing to report. The verification below will refuse
       a reply whose state it cannot match, which is the correct outcome. */
  }
}

/**
 * Reads and CONSUMES the state token for `key`.
 *
 * Consumed, because a state token answers exactly one launch. Leaving it in
 * place would let the browser's back button re-present an already-verified
 * reply and have it verify a second time — which is the replay this token
 * exists to stop.
 */
export function takePassportState(key: string): string | null {
  try {
    const store = storage();
    const value = store?.getItem(`${STATE_PREFIX}${key}`) ?? null;
    store?.removeItem(`${STATE_PREFIX}${key}`);
    return value;
  } catch {
    return null;
  }
}

/**
 * A bounded record of the nonces this app has already accepted.
 *
 * A signed reply stays valid until it expires, and it is sitting in the user's
 * own browser history where anyone with the device can find it. The freshness
 * window bounds how long that matters; this bounds how many times it can be
 * used inside the window, which is once.
 *
 * `localStorage` and not `sessionStorage`: a replay from history is most
 * interesting in a NEW session, which is exactly where a session-scoped ledger
 * would have forgotten everything.
 */
export function createPassportNonceLedger(options?: {
  key?: string;
  limit?: number;
}): { seen(nonce: string): boolean; record(nonce: string): void } {
  const key = options?.key ?? 'passport.connect.nonces';
  const limit = options?.limit ?? 64;
  const read = (): string[] => {
    try {
      if (typeof window === 'undefined') return [];
      const raw = window.localStorage.getItem(key);
      if (!raw) return [];
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    seen: (nonce: string) => read().includes(nonce),
    record: (nonce: string) => {
      try {
        if (typeof window === 'undefined') return;
        const next = [...read().filter((item) => item !== nonce), nonce].slice(-limit);
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* A ledger that cannot be written is a ledger that reports nothing as
           seen. The signature, audience, state, and freshness checks all still
           hold; only the once-per-window guarantee is lost, and the page can
           say so if it cares. */
      }
    },
  };
}

/* ---------------------------------------------------------------------------
 * The return
 * ------------------------------------------------------------------------ */

/**
 * Reads a reply out of the current fragment and SCRUBS the address bar.
 *
 * Scrubbing matters more here than it looks. The reply is in the fragment, the
 * fragment is in the user's history, and a reload — or the back button after
 * the page has already acted on it — re-presents the same signed reply to the
 * same app. Removing it with `replaceState` means the reload does nothing
 * rather than re-running the flow, and the nonce ledger catches the case where
 * somebody pastes the URL back in by hand.
 */
export function readPassportCallback(options?: {
  hash?: string;
  scrub?: boolean;
}): PassportCallbackReturn {
  return readCallback(parsePassportCallbackReturn, options);
}

/** The same, for a PAYMENT reply. */
export function readPassportTxCallback(options?: {
  hash?: string;
  scrub?: boolean;
}): PassportCallbackReturn {
  return readCallback(parsePassportTxCallbackReturn, options);
}

function readCallback(
  parse: (hash: string) => PassportCallbackReturn,
  options?: { hash?: string; scrub?: boolean },
): PassportCallbackReturn {
  const hash =
    options?.hash ?? (typeof window === 'undefined' ? '' : window.location.hash);
  const parsed = parse(hash);
  if (parsed.kind === 'absent') return parsed;
  if (options?.scrub === false || typeof window === 'undefined') return parsed;
  try {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  } catch {
    /* A page served from a `file:` URL, or a browser that refuses the call.
       The reply has already been read into memory, so nothing is lost but the
       tidy address bar. */
  }
  return parsed;
}
