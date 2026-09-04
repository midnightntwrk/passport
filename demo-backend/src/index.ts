/**
 * The demo backend with connectors: passkey enrolment and assertion, encrypted
 * private state, and the state-injection seam.
 *
 * THE PROTOCOL IS NOT HERE ANY MORE. It moved to
 * `@midnight-passport/connect`, and this package imports it back — so there is
 * exactly ONE copy of the Passport wire protocols in the tree and the module
 * graph is what enforces it, rather than a comment asking three vendored files
 * to stay byte-identical. The re-exports below exist so that
 * `examples/passport-demo/src/backend.ts`, the single seam between the PWA and
 * this package, keeps working unchanged: Passport still imports its protocol
 * from one place, that place simply resolves somewhere honest now.
 *
 * What stayed is this package's actual job — WebAuthn PRF, encrypted private
 * state, and the scope rules that keep two accounts' derivations apart. None
 * of that is protocol and none of it belongs in a public connector.
 */

export { PassportStateInjection, joinWithPassportState } from './injection.js';
export {
  ENROLMENT_PRF_MISSING_MESSAGE,
  MAX_ACCOUNT_BLOB_BYTES,
  PassportEnrolmentConflictError,
  PassportPasskeyDiscoveryError,
  WebAuthnPrfKeyProvider,
  decodeAccountBlob,
  encodeAccountBlob,
} from './passkey.js';
export { validatePassportStateScope } from './encoding.js';
export {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  MemoryPassportEncryptedRecordStore,
} from './privateState.js';
export type {
  AssertPassportPasskeyOptions,
  DiscoverPassportPasskeyOptions,
  DiscoveredPassportPasskey,
  EnrollPassportPasskeyOptions,
  EnrolledPassportPasskey,
  PassportAccountBlob,
  PassportAccountBlobWriteOutcome,
  PassportAccountBlobWriteResult,
  PassportPasskeyOnboarding,
  PassportPasskeyDiscoveryFailure,
  PassportPasskeyReference,
} from './passkey.js';
export type {
  PassportEncryptedEnvelope,
  PassportEncryptedRecordStore,
  PassportJoinOptions,
  PassportJoinResult,
  PassportPrivateStateStore,
  PassportStateInjectionOptions,
  PassportStateInjectionResult,
  PassportStateKeyProvider,
  PassportStateScope,
  PassportWalletSeedProvider,
} from './types.js';

/* ---------------------------------------------------------------------------
 * The protocol, re-exported from the one place it lives.
 *
 * Deliberately explicit rather than `export *`: the list is the record of what
 * Passport itself uses, and a name appearing here is a name somebody decided
 * belonged on this seam.
 * ------------------------------------------------------------------------ */

export {
  MAX_PROFILE_ADDRESS_LENGTH,
  MAX_TX_RECIPIENT_ADDRESS_LENGTH,
  PASSPORT_ERROR_CODES,
  PASSPORT_PROFILE_ERROR_CODES,
  PASSPORT_PROFILE_FIELDS,
  PASSPORT_PROFILE_PROTOCOL,
  PASSPORT_PROTOCOL_VERSION,
  PASSPORT_SUPPORTED_VERSIONS,
  PASSPORT_TX_ERROR_CODES,
  PASSPORT_TX_PROTOCOL,
  PassportProtocolError,
  createPassportIncentiveReport,
  createPassportProfileErrorResponse,
  createPassportProfileHello,
  createPassportProfileReady,
  createPassportProfileRequest,
  createPassportProfileResponse,
  createPassportTxErrorResponse,
  createPassportTxRequest,
  createPassportTxResponse,
  formatNight,
  isPassportErrorCode,
  isPassportProfileErrorCode,
  isPassportProfileField,
  isPassportTxErrorCode,
  pairOfUnreadableMessage,
  parsePassportIncentiveReport,
  parsePassportProfileHello,
  parsePassportProfileReady,
  parsePassportProfileRequest,
  parsePassportProfileResponse,
  parsePassportTxRequest,
  parsePassportTxResponse,
  passportErrorMessage,
  randomRequestId,
  readPassportIncentiveReport,
  readPassportProfileHello,
  readPassportProfileReady,
  readPassportProfileRequest,
  readPassportProfileResponse,
  readPassportTxRequest,
  readPassportTxResponse,
} from '@midnight-passport/connect';
export type {
  PassportErrorCode,
  PassportIncentiveReport,
  PassportParseFailure,
  PassportParseResult,
  PassportProfile,
  PassportProfileErrorCode,
  PassportProfileField,
  PassportProfileHello,
  PassportProfileMessage,
  PassportProfileReady,
  PassportProfileRequest,
  PassportProfileResponse,
  PassportTxErrorCode,
  PassportTxIntent,
  PassportTxIntentKind,
  PassportTxMessage,
  PassportTxRequest,
  PassportTxResponse,
} from '@midnight-passport/connect';
