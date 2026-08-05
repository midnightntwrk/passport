/**
 * Single seam between the PWA and the demo backend with connectors.
 * Every backend import in this app goes through this module, so the
 * backend can be replaced behind one boundary.
 */
export {
  EncryptedPassportPrivateStateStore,
  IndexedDbPassportEncryptedRecordStore,
  PassportStateInjection,
  WebAuthnPrfKeyProvider,
  createPassportProfileReady,
  createPassportProfileResponse,
  createPassportTxResponse,
  parsePassportIncentiveReport,
  parsePassportProfileRequest,
  parsePassportTxRequest,
} from 'passport-demo-backend';
export type {
  DiscoveredPassportPasskey,
  PassportIncentiveReport,
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
