/**
 * The wire protocols, and nothing else.
 *
 * Zero runtime dependencies, no DOM, no `window`. Importing this barrel alone
 * is enough to implement either side of either postMessage protocol — which is
 * exactly what `demo-backend` does, and why there is only one copy of these
 * rules in the tree.
 */

export {
  MAX_DETAIL_LENGTH,
  MAX_FEE_NOTE_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PROFILE_ADDRESS_LENGTH,
  MAX_PURPOSE_LENGTH,
  MAX_STRING_LENGTH,
  MAX_TX_RECIPIENT_ADDRESS_LENGTH,
} from './limits.js';

export {
  PASSPORT_PROTOCOL_VERSION,
  PASSPORT_SUPPORTED_VERSIONS,
  readProtocolVersion,
} from './version.js';
export type { PassportParseFailure, PassportParseResult } from './version.js';

export {
  PASSPORT_ERROR_CODES,
  PASSPORT_LOCAL_ERROR_CODES,
  PASSPORT_PROFILE_ERROR_CODES,
  PASSPORT_TX_ERROR_CODES,
  PassportProtocolError,
  isPassportErrorCode,
  isPassportLocalErrorCode,
  isPassportProfileErrorCode,
  isPassportTxErrorCode,
  passportErrorMessage,
} from './errors.js';
export type {
  PassportErrorCode,
  PassportLocalErrorCode,
  PassportProfileErrorCode,
  PassportTxErrorCode,
} from './errors.js';

export {
  PASSPORT_PROFILE_FIELDS,
  PASSPORT_PROFILE_PROTOCOL,
  createPassportProfileErrorResponse,
  createPassportProfileHello,
  createPassportProfileReady,
  createPassportProfileRequest,
  createPassportProfileResponse,
  isPassportProfileField,
  pairOfUnreadableMessage,
  parsePassportProfileHello,
  parsePassportProfileReady,
  parsePassportProfileRequest,
  parsePassportProfileResponse,
  readPassportProfileHello,
  readPassportProfileReady,
  readPassportProfileRequest,
  readPassportProfileResponse,
} from './profile.js';
export type {
  PassportProfile,
  PassportProfileField,
  PassportProfileHello,
  PassportProfileMessage,
  PassportProfileReady,
  PassportProfileRequest,
  PassportProfileResponse,
} from './profile.js';

export {
  NIGHT_DECIMALS,
  PASSPORT_TX_PROTOCOL,
  createPassportIncentiveReport,
  createPassportTxErrorResponse,
  createPassportTxRequest,
  createPassportTxResponse,
  formatNight,
  parsePassportIncentiveReport,
  parsePassportTxRequest,
  parsePassportTxResponse,
  readPassportIncentiveReport,
  readPassportTxRequest,
  readPassportTxResponse,
} from './tx.js';
export type {
  PassportIncentiveReport,
  PassportTxIntent,
  PassportTxIntentKind,
  PassportTxMessage,
  PassportTxRequest,
  PassportTxResponse,
} from './tx.js';
