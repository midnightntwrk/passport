/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The exact origin of the Passport this app sends users to. It must be a
   * DIFFERENT origin from ClubCoin's own — the reply carries the origin it was
   * issued for, and a round trip to yourself never exercises that check.
   *
   * Defaults to `http://localhost:5175`, and is overridable at runtime from
   * the demo configuration panel so one build can be pointed at a local
   * Passport or a deployed one.
   */
  readonly VITE_PASSPORT_ORIGIN?: string;

  /**
   * Set to exactly `1` to accept an UNSIGNED reply (`scheme: "none"`), which a
   * Passport session with no local signing key produces. Off by default: an
   * app that accepts unsigned replies without saying so is an app whose
   * verification means nothing. When on, the accepted profile is rendered with
   * an explicit warning rather than as a verified one.
   */
  readonly VITE_ACCEPT_UNSIGNED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
