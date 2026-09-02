/* ===========================================================================
 * The client — one exchange state machine, two transports
 * ===========================================================================
 *
 * This is the ~400 lines of transport that every integrating app used to write
 * by hand: origin pinning, mode detection, pair minting, the two inbound
 * handlers, the pop-up open with its blocked path, the closed-window poll, the
 * three-minute budget, and the plain-English sentence for every refusal code.
 * None of it was importable. All of it is here, once.
 *
 * WHAT AN INTEGRATOR STILL HAS TO KNOW, because the SDK cannot hide it:
 *
 *   - Passport decides, not the app. You ask; the user answers on Passport's
 *     own surface. Your app never sees a key, a seed, or a signature.
 *   - Consent is partial. A profile reply may carry fewer fields than you
 *     asked for. Render what arrived and say plainly what did not.
 *   - `requestPayment` needs a user gesture in pop-up mode, because opening a
 *     window does. Call it from a click handler, not from an effect.
 *   - `submitted` means at the node, not final. No confirmation depth is
 *     reported by anything in this protocol.
 *
 * EVERY RESULT CARRIES A RENDERED `message`. The point of that is that no app
 * ever shows a user a bare error code, and no app has to keep its own copy of
 * the sentence for each one — which is precisely what every app in this
 * repository used to do, in slightly different words each time.
 * ========================================================================= */

import {
  PassportProtocolError,
  passportErrorMessage,
  type PassportLocalErrorCode,
  type PassportProfileErrorCode,
  type PassportTxErrorCode,
} from '../protocol/errors.js';
import {
  createPassportProfileRequest,
  readPassportProfileResponse,
  type PassportProfile,
  type PassportProfileField,
} from '../protocol/profile.js';
import {
  createPassportIncentiveReport,
  createPassportTxRequest,
  readPassportTxResponse,
} from '../protocol/tx.js';
import { randomExchangePair } from './random.js';
import { createIframeTransport } from './transport/iframe.js';
import { createPopupTransport } from './transport/popup.js';
import {
  PassportTransportError,
  type PassportChannel,
  type PassportMode,
  type PassportPresence,
  type PassportTransport,
} from './transport/types.js';

/* ---------------------------------------------------------------------------
 * Results
 * ------------------------------------------------------------------------ */

export type PassportProfileResult =
  | {
      readonly approved: true;
      readonly profile: PassportProfile;
      /** What was asked for but not returned. Consent is partial by design. */
      readonly withheld: readonly PassportProfileField[];
      readonly message: string;
    }
  | {
      readonly approved: false;
      /** Passport answered, and this is what it said. */
      readonly source: 'passport';
      readonly error: PassportProfileErrorCode;
      readonly message: string;
    }
  | {
      readonly approved: false;
      /** Nothing was ever asked. This side stopped it. */
      readonly source: 'local';
      readonly error: PassportLocalErrorCode;
      readonly message: string;
    };

export type PassportPaymentResult =
  | {
      readonly status: 'submitted';
      readonly txId: string;
      /** True ONLY when the reply said so. Absent means user-paid. */
      readonly sponsored: boolean;
      readonly feeNote?: string;
      readonly message: string;
    }
  | {
      readonly status: 'declined' | 'failed';
      readonly source: 'passport';
      readonly error: PassportTxErrorCode;
      readonly detail?: string;
      readonly message: string;
    }
  | {
      readonly status: 'failed';
      readonly source: 'local';
      readonly error: PassportLocalErrorCode;
      readonly message: string;
    };

export type PassportIncentiveResult =
  | { readonly sent: true; readonly message: string }
  | {
      readonly sent: false;
      readonly error: PassportLocalErrorCode;
      readonly message: string;
    };

/* ---------------------------------------------------------------------------
 * Events
 * ------------------------------------------------------------------------ */

export interface PassportTrafficEvent {
  readonly direction: 'in' | 'out';
  /** The message `type`, e.g. `passport.profile.request`. */
  readonly type: string;
  readonly payload: unknown;
  readonly at: number;
}

export interface PassportReadyEvent {
  readonly requestId: string;
  readonly nonce: string;
}

export interface PassportErrorEvent {
  readonly code: PassportLocalErrorCode | PassportProfileErrorCode | PassportTxErrorCode;
  readonly message: string;
}

export interface PassportEventMap {
  message: PassportTrafficEvent;
  ready: PassportReadyEvent;
  error: PassportErrorEvent;
}

/* ---------------------------------------------------------------------------
 * Options
 * ------------------------------------------------------------------------ */

export interface CreatePassportOptions {
  /**
   * The exact origin Passport is served from. REQUIRED, and there is no
   * default on purpose: a default would be a value somebody ships by accident.
   * A trailing slash is stripped, because `event.origin` never has one and
   * `'https://x/' !== 'https://x'` would silently drop every inbound message.
   */
  readonly origin: string;
  /**
   * `auto` is `window.parent !== window`, which is the whole detection.
   *
   * A {@link PassportTransport} may be passed instead, for a host that embeds
   * Passport some other way — and it is the seam the client's own drills use,
   * which is why the failure paths below are testable at all.
   */
  readonly transport?: 'auto' | 'iframe' | 'popup' | PassportTransport;
  /**
   * How long an exchange may run. Passport proves, signs, and submits before
   * it answers, so the wait is long by web standards. Time out anyway: a
   * promise that never settles is a spinner that never stops.
   */
  readonly timeoutMs?: number;
  /** How long `detect()` and the framed handshake wait. */
  readonly presenceTimeoutMs?: number;
  /** How often a pop-up is checked for having been closed. */
  readonly closedPollMs?: number;
  /** Pop-up window features. */
  readonly popupFeatures?: string;
  /** Injected for tests; production passes the real window. */
  readonly window?: Window;
}

export const PASSPORT_DEFAULT_TIMEOUT_MS = 180_000;
export const PASSPORT_DEFAULT_PRESENCE_TIMEOUT_MS = 2_500;
export const PASSPORT_DEFAULT_CLOSED_POLL_MS = 500;

export interface PassportPaymentIntent {
  readonly recipientAddress: string;
  /** Atomic NIGHT units. 1 NIGHT is 1,000,000. Never a float. */
  readonly amount: string | bigint;
  readonly purpose: string;
}

export interface PassportIncentive {
  readonly id: string;
  readonly label: string;
  readonly txId?: string;
}

export interface Passport {
  readonly origin: string;
  readonly mode: PassportMode;
  /** Honest about being unknowable in pop-up mode. See {@link PassportPresence}. */
  detect(): Promise<PassportPresence>;
  /**
   * Resolves when there is a channel to talk over. Framed, that is the
   * handshake; in pop-up mode there is nothing to wait for until the user
   * presses something, so it resolves at once.
   */
  ready(): Promise<void>;
  requestProfile(fields: readonly PassportProfileField[]): Promise<PassportProfileResult>;
  requestPayment(intent: PassportPaymentIntent): Promise<PassportPaymentResult>;
  reportIncentive(incentive: PassportIncentive): Promise<PassportIncentiveResult>;
  on<K extends keyof PassportEventMap>(
    event: K,
    listener: (payload: PassportEventMap[K]) => void,
  ): () => void;
  destroy(): void;
}

/** The sentence for a submission whose fee somebody else paid. */
function sponsoredMessage(feeNote: string | undefined): string {
  return `Submitted. ${feeNote ?? 'The network fee was covered by a sponsor.'}`;
}

/* ---------------------------------------------------------------------------
 * The client
 * ------------------------------------------------------------------------ */

export function createPassport(options: CreatePassportOptions): Passport {
  const host = options.window ?? window;
  const origin = options.origin.replace(/\/+$/, '');
  if (!origin) {
    throw new Error('createPassport requires the exact origin Passport is served from.');
  }

  const timeoutMs = options.timeoutMs ?? PASSPORT_DEFAULT_TIMEOUT_MS;
  const presenceTimeoutMs = options.presenceTimeoutMs ?? PASSPORT_DEFAULT_PRESENCE_TIMEOUT_MS;
  const closedPollMs = options.closedPollMs ?? PASSPORT_DEFAULT_CLOSED_POLL_MS;

  const requested = options.transport ?? 'auto';
  const chosen: 'iframe' | 'popup' | PassportTransport =
    requested === 'auto' ? (host.parent !== host ? 'iframe' : 'popup') : requested;

  const listeners: {
    [K in keyof PassportEventMap]: Set<(payload: PassportEventMap[K]) => void>;
  } = { message: new Set(), ready: new Set(), error: new Set() };

  function emit<K extends keyof PassportEventMap>(event: K, payload: PassportEventMap[K]): void {
    for (const listener of [...listeners[event]]) listener(payload);
  }

  const onTraffic = (direction: 'in' | 'out', type: string, payload: unknown): void => {
    emit('message', { direction, type, payload, at: Date.now() });
  };
  const onReady = (pair: { requestId: string; nonce: string }): void => emit('ready', pair);

  const transport: PassportTransport =
    typeof chosen !== 'string'
      ? chosen
      : chosen === 'iframe'
        ? createIframeTransport({ origin, presenceTimeoutMs, window: host, onTraffic, onReady })
        : createPopupTransport({
            origin,
            readyTimeoutMs: timeoutMs,
            closedPollMs,
            ...(options.popupFeatures === undefined ? {} : { features: options.popupFeatures }),
            window: host,
            onTraffic,
            onReady,
          });
  const mode: PassportMode = transport.mode;

  let destroyed = false;

  /**
   * One exchange, start to finish: open a channel, post, and settle on the
   * first reply bound to this exchange's own pair — or on the budget, or on
   * the far side going away.
   *
   * `match` is handed the raw inbound value and returns the settled result, or
   * `null` for "not mine". Matching on the PAIR rather than the message type
   * is load-bearing: the payment pop-up also announces itself with
   * `passport.profile.ready`, so the type alone cannot tell two exchanges
   * apart.
   */
  async function exchange<T>(
    kind: 'profile' | 'tx',
    build: (channel: PassportChannel) => object,
    match: (data: unknown, channel: PassportChannel) => T | null,
    onLocalFailure: (code: PassportLocalErrorCode) => T,
  ): Promise<T> {
    if (destroyed) return onLocalFailure('unsupported-transport');
    const controller = new AbortController();
    let channel: PassportChannel | null = null;
    let stopListening: (() => void) | null = null;
    let budget: number | undefined;
    let poll: number | undefined;

    const cleanup = (): void => {
      controller.abort();
      stopListening?.();
      if (budget !== undefined) host.clearTimeout(budget);
      if (poll !== undefined) host.clearInterval(poll);
      channel?.release();
    };

    try {
      channel = await transport.open(kind, controller.signal);
    } catch (cause) {
      cleanup();
      const code =
        cause instanceof PassportTransportError ? cause.code : ('timed-out' as const);
      const failure = onLocalFailure(code);
      emit('error', { code, message: passportErrorMessage(code) });
      return failure;
    }

    const open = channel;
    let message: object;
    try {
      /* The local `invalid-request`, and the reason this SDK builds the
         message through a factory rather than posting a literal. A malformed
         request used to go out, get dropped by Passport's parser, and produce
         no reply at all — three minutes of spinner for a typo. It never
         leaves the page now. */
      message = build(open);
    } catch (cause) {
      cleanup();
      const detail = cause instanceof PassportProtocolError ? cause.reason : String(cause);
      emit('error', { code: 'invalid-request', message: detail });
      return onLocalFailure('invalid-request');
    }

    return new Promise<T>((resolve) => {
      const settle = (value: T): void => {
        cleanup();
        resolve(value);
      };
      const fail = (code: PassportLocalErrorCode): void => {
        emit('error', { code, message: passportErrorMessage(code) });
        settle(onLocalFailure(code));
      };

      stopListening = transport.listen((data) => {
        const settled = match(data, open);
        if (settled !== null) settle(settled);
      });

      budget = host.setTimeout(() => fail('timed-out'), timeoutMs);
      /* A closed window will never answer, and no message says it closed. */
      poll = host.setInterval(() => {
        if (open.closed()) fail('passport-closed');
      }, closedPollMs);

      open.post(message);
    });
  }

  return {
    origin,
    mode,

    async detect() {
      const controller = new AbortController();
      try {
        return await transport.presence(controller.signal);
      } finally {
        controller.abort();
      }
    },

    async ready() {
      if (mode !== 'iframe') return;
      const controller = new AbortController();
      try {
        const presence = await transport.presence(controller.signal);
        if (presence.present !== true) {
          throw new PassportTransportError('not-present', presence.message);
        }
      } finally {
        controller.abort();
      }
    },

    requestProfile(fields) {
      return exchange<PassportProfileResult>(
        'profile',
        (channel) =>
          createPassportProfileRequest({
            requestId: channel.pair.requestId,
            nonce: channel.pair.nonce,
            fields,
          }),
        (data, channel) => {
          const parsed = readPassportProfileResponse(data);
          if (parsed.kind !== 'ok') return null;
          const response = parsed.value;
          /* Not bound to the pair we are waiting on? Not our answer. */
          if (
            response.requestId !== channel.pair.requestId ||
            response.nonce !== channel.pair.nonce
          ) {
            return null;
          }
          onTraffic('in', response.type, response);
          if (!response.approved) {
            /* The parser refuses a refusal that names no known code, so this
               is guaranteed to be one. The cast is the invariant written
               down; `profile.test.ts` is what keeps it true. */
            const error = response.error as PassportProfileErrorCode;
            emit('error', { code: error, message: passportErrorMessage(error) });
            return {
              approved: false,
              source: 'passport',
              error,
              message: passportErrorMessage(error),
            };
          }
          /* The parser always constructs a profile object on an approved
             reply — an empty one where nothing was shared — so this is never
             absent. See `profile.test.ts`. */
          const profile = response.profile as PassportProfile;
          const withheld = fields.filter((field) => profile[field] === undefined);
          return {
            approved: true,
            profile,
            withheld,
            message:
              withheld.length === 0
                ? 'Passport shared every field you asked for, and nothing else.'
                : `Passport shared what you approved. Not shared: ${withheld.join(', ')}.`,
          };
        },
        (code) => ({ approved: false, source: 'local', error: code, message: passportErrorMessage(code) }),
      );
    },

    requestPayment(intent) {
      return exchange<PassportPaymentResult>(
        'tx',
        (channel) =>
          createPassportTxRequest({
            requestId: channel.pair.requestId,
            nonce: channel.pair.nonce,
            recipientAddress: intent.recipientAddress,
            amount: intent.amount,
            purpose: intent.purpose,
          }),
        (data, channel) => {
          const parsed = readPassportTxResponse(data);
          if (parsed.kind !== 'ok') return null;
          const response = parsed.value;
          if (
            response.requestId !== channel.pair.requestId ||
            response.nonce !== channel.pair.nonce
          ) {
            return null;
          }
          onTraffic('in', response.type, response);
          if (response.status === 'submitted') {
            /* `sponsored: true` is the ONLY thing that may be rendered as a
               covered fee. Absent means "not stated", which is an ordinary,
               user-paid transaction — not a free one. */
            const sponsored = response.sponsored === true;
            return {
              status: 'submitted',
              /* The parser refuses a submitted reply with no node id, so this
                 is guaranteed to be one. See `tx.test.ts`. */
              txId: response.txId as string,
              sponsored,
              ...(response.feeNote === undefined ? {} : { feeNote: response.feeNote }),
              message: sponsored
                ? sponsoredMessage(response.feeNote)
                : 'Submitted to the node, and paid for out of the Passport account.',
            };
          }
          /* Likewise: the parser refuses a non-submitted reply that names no
             known code. */
          const error = response.error as PassportTxErrorCode;
          emit('error', { code: error, message: passportErrorMessage(error) });
          return {
            status: response.status === 'declined' ? 'declined' : 'failed',
            source: 'passport',
            error,
            ...(response.detail === undefined ? {} : { detail: response.detail }),
            message: [passportErrorMessage(error), response.detail].filter(Boolean).join(' '),
          };
        },
        (code) => ({ status: 'failed', source: 'local', error: code, message: passportErrorMessage(code) }),
      );
    },

    async reportIncentive(incentive) {
      /* Framed only, and it says so rather than pretending. There is no reply
         to this message and nothing to post to outside a frame — a pop-up is
         not hosting the app. */
      if (mode !== 'iframe') {
        return {
          sent: false,
          error: 'unsupported-transport',
          message: passportErrorMessage('unsupported-transport'),
        };
      }
      const controller = new AbortController();
      try {
        const pair = randomExchangePair();
        const channel = await transport.open('incentive', controller.signal);
        channel.post(
          createPassportIncentiveReport({
            requestId: pair.requestId,
            nonce: pair.nonce,
            id: incentive.id,
            label: incentive.label,
            ...(incentive.txId === undefined ? {} : { txId: incentive.txId }),
          }),
        );
        channel.release();
        controller.abort();
        return {
          sent: true,
          message:
            'Reported to Passport. It is an unauthenticated assertion by this app, and Passport records it as one.',
        };
      } catch (cause) {
        controller.abort();
        const code: PassportLocalErrorCode =
          cause instanceof PassportProtocolError ? 'invalid-request' : 'unsupported-transport';
        return { sent: false, error: code, message: passportErrorMessage(code) };
      }
    },

    on(event, listener) {
      listeners[event].add(listener);
      return () => {
        listeners[event].delete(listener);
      };
    },

    destroy() {
      destroyed = true;
      transport.destroy();
      listeners.message.clear();
      listeners.ready.clear();
      listeners.error.clear();
    },
  };
}
