/**
 * The Passport bridge, as this demo speaks it.
 *
 * Re-exports only what the raffle actually uses. The vendored modules beside
 * this one are complete copies of Passport's own — see their provenance
 * headers — so an app that needs the request-side helpers can reach for them
 * directly.
 */
export {
  PASSPORT_PROFILE_PROTOCOL,
  parsePassportProfileReady,
  parsePassportProfileResponse,
} from './profileProtocol.js';
export type {
  PassportProfileField,
  PassportProfileResponse,
} from './profileProtocol.js';
export { PASSPORT_TX_PROTOCOL, parsePassportTxResponse } from './txProtocol.js';
export type { PassportTxRequest, PassportTxResponse } from './txProtocol.js';
