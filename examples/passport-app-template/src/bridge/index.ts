/**
 * The Passport bridge, as this template speaks it.
 *
 * The two modules beside this one are complete, unmodified copies of
 * Passport's own protocol definitions — see their provenance headers. They are
 * dependency-free on purpose, so you can copy the whole `src/bridge/` folder
 * into any project, of any framework, and it will build.
 *
 * This barrel re-exports the pieces an *app* needs. (Passport itself uses the
 * mirror-image half of each module — the `create…` helpers and the
 * request-side parsers — which is why they exist in the vendored files even
 * though nothing here calls them.)
 */

/* ---- Profile: org.midnight.passport.profile/v1 -------------------------- */
export {
  PASSPORT_PROFILE_PROTOCOL,
  PASSPORT_PROFILE_FIELDS,
  parsePassportProfileReady,
  parsePassportProfileResponse,
} from './profileProtocol.js';
export type {
  PassportProfileField,
  PassportProfileReady,
  PassportProfileRequest,
  PassportProfileResponse,
} from './profileProtocol.js';

/* ---- Transactions: org.midnight.passport.tx/v1 -------------------------- */
export { PASSPORT_TX_PROTOCOL, parsePassportTxResponse } from './txProtocol.js';
export type {
  PassportTxErrorCode,
  PassportTxIntent,
  PassportTxRequest,
  PassportTxResponse,
} from './txProtocol.js';
