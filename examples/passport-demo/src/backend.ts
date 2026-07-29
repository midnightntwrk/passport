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
  parsePassportProfileRequest,
} from 'passport-demo-backend';
export type {
  PassportPasskeyReference,
  PassportProfileField,
  PassportProfileRequest,
  PassportProfileResponse,
} from 'passport-demo-backend';
