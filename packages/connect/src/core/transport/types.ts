/**
 * The transport seam.
 *
 * Two channels reach Passport from a page — the parent frame when Passport is
 * hosting the app, and a pop-up window when it is not — and they differ in
 * exactly three ways. Everything else (matching a reply to its pair, the
 * timeouts, the sentences) belongs to the client and is written once.
 *
 *   1. WHO MINTS THE PAIR. Framed, Passport mints it and broadcasts it in
 *      `ready`; the app must echo that exact pair, because a pair of its own
 *      is not bound to the handshake. In a pop-up the app mints it and hands
 *      it over on the launch URL.
 *   2. WHEN THE FAR SIDE IS LISTENING. A live frame always is. A pop-up is
 *      not, until it has loaded and echoed the pair back — posting into a
 *      document that has not loaded yet reaches nothing.
 *   3. HOW IT CAN GO AWAY. A frame does not. A pop-up can be closed, and no
 *      message ever says so, which is why `closed()` exists at all.
 *
 * Payments are the one place the framed channel mints a pair of its own: a
 * payment reply must never be mistakable for the answer to the profile
 * question, or to an earlier payment the user already declined.
 */

export type PassportMode = 'iframe' | 'popup';

export type PassportExchangeKind = 'profile' | 'tx' | 'incentive';

export interface PassportExchangePair {
  readonly requestId: string;
  readonly nonce: string;
}

/** An open channel to Passport for exactly one exchange. */
export interface PassportChannel {
  readonly pair: PassportExchangePair;
  /** Posts to the pinned origin. Never to `'*'`. */
  post(message: object): void;
  /** True once the far side is known to have gone away. */
  closed(): boolean;
  /** Releases anything this exchange held. Idempotent. */
  release(): void;
}

export interface PassportTransport {
  readonly mode: PassportMode;
  /**
   * Subscribes to inbound messages that have already passed BOTH gates: the
   * exact pinned origin, and the exact window this transport talks to.
   * Returns the unsubscribe.
   */
  listen(handler: (data: unknown) => void): () => void;
  /**
   * Opens a channel for one exchange, resolving once the far side can receive.
   * Rejects with a {@link PassportTransportError} when it cannot.
   */
  open(kind: PassportExchangeKind, signal: AbortSignal): Promise<PassportChannel>;
  /** Whatever this transport already knows about Passport's presence. */
  presence(signal: AbortSignal): Promise<PassportPresence>;
  destroy(): void;
}

/**
 * What a presence check can honestly conclude.
 *
 * `unknown` is a real answer and the SDK refuses to launder it into a boolean.
 * There is no injected provider — a dApp on another origin cannot receive
 * `window.midnight.*`, the same-origin policy forbids it, and Passport
 * deliberately does not weaken it — so outside a frame the only way to find
 * out whether Passport is there is to open a window, which costs a user
 * gesture. An SDK that returned `false` for "I did not check" would be lying
 * to every integrator who guards a button on it.
 */
export type PassportPresence =
  | { readonly present: true; readonly via: 'handshake'; readonly message: string }
  | { readonly present: false; readonly reason: 'no-reply'; readonly message: string }
  | { readonly present: 'unknown'; readonly reason: 'popup-mode'; readonly message: string };

export class PassportTransportError extends Error {
  readonly code: 'popup-blocked' | 'timed-out' | 'passport-closed' | 'not-present';

  constructor(code: PassportTransportError['code'], message: string) {
    super(message);
    this.name = 'PassportTransportError';
    this.code = code;
  }
}
