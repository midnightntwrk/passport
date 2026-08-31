/**
 * Single seam between the PWA and the demo backend with connectors.
 * Every backend import in this app goes through this module, so the
 * backend can be replaced behind one boundary.
 */
export {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  PassportStateInjection,
  PassportEnrolmentConflictError,
  /* Carries the authenticator's own reason for a discoverable assertion that
     produced nothing — `cancelled`, `prf-missing`, or `failed`. Onboarding
     needs the reason, not the text: it is what separates "a passkey answered
     and cannot open a Passport" from "no passkey could be produced at all",
     and those two states offer different explanations for the same button. */
  PassportPasskeyDiscoveryError,
  WebAuthnPrfKeyProvider,
  createPassportProfileReady,
  createPassportProfileResponse,
  createPassportTxResponse,
  parsePassportIncentiveReport,
  parsePassportProfileRequest,
  parsePassportTxRequest,
} from 'passport-demo-backend';
export type {
  AssertPassportPasskeyOptions,
  DiscoveredPassportPasskey,
  EnrolledPassportPasskey,
  PassportAccountBlob,
  PassportAccountBlobWriteOutcome,
  PassportAccountBlobWriteResult,
  PassportIncentiveReport,
  PassportPasskeyOnboarding,
  PassportPasskeyReference,
  PassportProfileField,
  PassportProfileRequest,
  PassportProfileResponse,
  PassportStateScope,
  PassportTxErrorCode,
  PassportTxRequest,
  PassportTxResponse,
  PassportWalletSeedProvider,
} from 'passport-demo-backend';
