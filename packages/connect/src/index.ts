/**
 * `@midnight-passport/connect` — the zero-dependency entry point.
 *
 * The wire protocols, the client that speaks them, and the two postMessage
 * transports. No curves, no hashes, no React, no Midnight SDK, no WebAssembly.
 *
 * The signed redirect channel lives at `@midnight-passport/connect/redirect`,
 * which is where the three pure-JavaScript crypto libraries are quarantined,
 * so a dApp that never uses it never pays for them. The React bindings live at
 * `@midnight-passport/connect/react`.
 */

export * from './protocol/index.js';

export { randomExchangePair, randomRequestId } from './core/random.js';

export {
  PASSPORT_DEFAULT_CLOSED_POLL_MS,
  PASSPORT_DEFAULT_PRESENCE_TIMEOUT_MS,
  PASSPORT_DEFAULT_TIMEOUT_MS,
  createPassport,
} from './core/client.js';
export type {
  CreatePassportOptions,
  Passport,
  PassportErrorEvent,
  PassportEventMap,
  PassportIncentive,
  PassportIncentiveResult,
  PassportPaymentIntent,
  PassportPaymentResult,
  PassportProfileResult,
  PassportReadyEvent,
  PassportTrafficEvent,
} from './core/client.js';

export {
  PASSPORT_LAUNCH_PARAMS,
  PASSPORT_WINDOW_NAME,
  createPopupTransport,
} from './core/transport/popup.js';
export { createIframeTransport } from './core/transport/iframe.js';
export { PassportTransportError } from './core/transport/types.js';
export type {
  PassportChannel,
  PassportExchangeKind,
  PassportExchangePair,
  PassportMode,
  PassportPresence,
  PassportTransport,
} from './core/transport/types.js';
