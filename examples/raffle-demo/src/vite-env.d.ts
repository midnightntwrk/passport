/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PASSPORT_ORIGIN?: string;
  readonly VITE_TELEGRAM_URL?: string;
  /**
   * The preview unshielded address (`mn_addr…`) the raffle operator controls.
   * Set it to turn on real on-chain entry; leave it unset and the raffle stays
   * in profile-only mode and says so.
   */
  readonly VITE_RAFFLE_COLLECTION_ADDRESS?: string;
  /** Entry price in atomic NIGHT units. Defaults to `100000` — 0.1 NIGHT. */
  readonly VITE_RAFFLE_ENTRY_AMOUNT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
