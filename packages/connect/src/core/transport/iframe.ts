/* ===========================================================================
 * The framed channel — Passport is the parent window
 * ===========================================================================
 *
 * Passport posts `passport.profile.ready` down as soon as the frame loads and
 * RE-BROADCASTS the same pair every 800 ms until the frame says something
 * back, capped at 40 attempts. Two consequences this transport handles so no
 * integrator has to:
 *
 *   1. `ready` can arrive more than once, and can arrive late — mid-flow. It
 *      is idempotent here: the pair is recorded, waiters are woken, and
 *      nothing already in flight is disturbed.
 *   2. It must be ANSWERED. Any message from the frame counts as "the app
 *      spoke", which is what stops the re-broadcast and clears Passport's
 *      "this app is not responding" hint. The ack is `passport.profile.hello`,
 *      which is a real protocol message now rather than a magic string three
 *      apps happened to agree on.
 *
 * Presence, framed, is answerable: send a bare `hello` and wait a bounded time
 * for a `ready`. A Passport that is there answers within one broadcast
 * interval; one that is not there never will, and the wait ends with a typed
 * `not-present` instead of a hang.
 * ========================================================================= */

import {
  createPassportProfileHello,
  parsePassportProfileReady,
} from '../../protocol/profile.js';
import { randomExchangePair } from '../random.js';
import {
  PassportTransportError,
  type PassportChannel,
  type PassportExchangeKind,
  type PassportExchangePair,
  type PassportPresence,
  type PassportTransport,
} from './types.js';

export interface IframeTransportOptions {
  /** The exact origin Passport is served from. Never `'*'`. */
  readonly origin: string;
  /** How long `presence()` waits for a `ready` before answering. */
  readonly presenceTimeoutMs: number;
  /** Injected for tests; production passes the real window. */
  readonly window?: Window;
  /** Records every message this transport sends or accepts. */
  readonly onTraffic?: (direction: 'in' | 'out', type: string, payload: unknown) => void;
  /** Called with the handshake pair each time Passport announces itself. */
  readonly onReady?: (pair: PassportExchangePair) => void;
}

export function createIframeTransport(options: IframeTransportOptions): PassportTransport {
  const host = options.window ?? window;
  const parent = host.parent;
  const handlers = new Set<(data: unknown) => void>();
  /** The pair Passport minted, once it has arrived. */
  let handshake: PassportExchangePair | null = null;
  const readyWaiters = new Set<(pair: PassportExchangePair) => void>();
  let attached = false;

  const post = (message: object, type: string): void => {
    options.onTraffic?.('out', type, message);
    /* The second argument is the whole point. Never `'*'`. */
    parent.postMessage(message, options.origin);
  };

  const onMessage = (event: MessageEvent): void => {
    /* Gate one: the origin must be exactly Passport's. Gate two: it must be
       the parent window, not some other frame that guessed the origin. */
    if (event.origin !== options.origin || event.source !== parent) return;

    const ready = parsePassportProfileReady(event.data);
    if (ready) {
      options.onTraffic?.('in', ready.type, ready);
      handshake = { requestId: ready.requestId, nonce: ready.nonce };
      options.onReady?.(handshake);
      /* The acknowledgement, echoing the pair. Idempotent: Passport stops
         re-broadcasting on the first one and ignores the rest. */
      post(createPassportProfileHello(handshake), 'passport.profile.hello');
      for (const waiter of [...readyWaiters]) waiter(handshake);
      readyWaiters.clear();
      return;
    }
    for (const handler of handlers) handler(event.data);
  };

  const attach = (): void => {
    if (attached) return;
    attached = true;
    host.addEventListener('message', onMessage);
  };

  const waitForHandshake = (signal: AbortSignal, timeoutMs: number): Promise<PassportExchangePair> => {
    attach();
    if (handshake) return Promise.resolve(handshake);
    return new Promise((resolve, reject) => {
      const settle = (outcome: () => void) => {
        readyWaiters.delete(waiter);
        host.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        outcome();
      };
      const waiter = (pair: PassportExchangePair) => settle(() => resolve(pair));
      const onAbort = () =>
        settle(() =>
          reject(new PassportTransportError('timed-out', 'The exchange was abandoned.')),
        );
      const timer = host.setTimeout(() => {
        settle(() =>
          reject(
            new PassportTransportError(
              'not-present',
              'No Passport answered inside the frame around this page.',
            ),
          ),
        );
      }, timeoutMs);
      readyWaiters.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
      /* Ask. A cold hello — no pair — is a frame saying "are you there?", and
         Passport answers it with a `ready` rather than waiting out its own
         broadcast interval. */
      post(createPassportProfileHello(), 'passport.profile.hello');
    });
  };

  return {
    mode: 'iframe',

    listen(handler) {
      attach();
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    async open(kind: PassportExchangeKind, signal: AbortSignal): Promise<PassportChannel> {
      /* A PROFILE request must echo the pair Passport minted: minting one of
         our own works — Passport accepts it — but it is not bound to the
         handshake, and the whole point of the handshake is that it is.
         A PAYMENT and an incentive report mint fresh pairs, so one payment's
         outcome can never be read as another's. */
      const pair =
        kind === 'profile'
          ? await waitForHandshake(signal, options.presenceTimeoutMs)
          : randomExchangePair();
      attach();
      return {
        pair,
        post: (message: object) => {
          post(message, String((message as { type?: unknown }).type ?? 'unknown'));
        },
        /* A live frame does not go away underneath us. If Passport navigates,
           this document goes with it. */
        closed: () => false,
        release: () => {},
      };
    },

    async presence(signal: AbortSignal): Promise<PassportPresence> {
      try {
        await waitForHandshake(signal, options.presenceTimeoutMs);
        return {
          present: true,
          via: 'handshake',
          message: 'Passport is hosting this page and has completed the handshake.',
        };
      } catch {
        return {
          present: false,
          reason: 'no-reply',
          message:
            'This page is framed by something that did not answer the Passport handshake, so it is not Passport.',
        };
      }
    },

    destroy() {
      if (attached) host.removeEventListener('message', onMessage);
      attached = false;
      handlers.clear();
      readyWaiters.clear();
      handshake = null;
    },
  };
}
