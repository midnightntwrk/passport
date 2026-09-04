/**
 * Single seam between the PWA and the demo backend with connectors.
 * Every backend import in this app goes through this module, so the
 * backend can be replaced behind one boundary.
 */
export {
  /* The sentence a passkey made HERE earns when it comes back with no PRF —
     the Android shape, where the platform honoured the request and the
     credential still cannot derive a key. Imported rather than restated so the
     screen and the activity trail say the same thing, and so nobody has to
     keep two copies of it true. */
  ENROLMENT_PRF_MISSING_MESSAGE,
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
  /* Reading a message now yields a RESULT rather than `T | null`, so the three
     outcomes an app cares about are distinguishable: not addressed to us, a
     revision we do not speak, and a shape we cannot read. The last two are
     answered rather than dropped — a silent drop is a three-minute hang the
     app cannot tell from Passport being absent. */
  pairOfUnreadableMessage,
  parsePassportProfileHello,
  randomRequestId,
  readPassportIncentiveReport,
  readPassportProfileRequest,
  readPassportTxRequest,
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
  PassportParseFailure,
  PassportParseResult,
  PassportProfile,
  PassportProfileField,
  PassportProfileRequest,
  PassportProfileResponse,
  PassportStateScope,
  PassportTxErrorCode,
  PassportTxRequest,
  PassportTxResponse,
  PassportWalletSeedProvider,
} from 'passport-demo-backend';
