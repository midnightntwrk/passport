/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The exact origin of the Passport app this template talks to. Every
   * outbound `postMessage` is targeted at it and every inbound message whose
   * `event.origin` does not equal it is dropped without being parsed.
   *
   * Defaults to `http://localhost:5175`. It must be a DIFFERENT origin from
   * the app itself — a handshake with yourself proves nothing.
   */
  readonly VITE_PASSPORT_ORIGIN?: string;

  /**
   * Act three, the optional payment, is off unless this is exactly `1`.
   * With it off the transaction code never runs and the interface says the
   * act is disabled rather than pretending a payment is available.
   */
  readonly VITE_DEMO_PAYMENT?: string;

  /**
   * Where the demo payment would go: an unshielded Midnight address
   * (`mn_addr…`) on the same network as the connected Passport wallet.
   * Required for act three; without it the act stays off even when
   * `VITE_DEMO_PAYMENT=1`, because there is nothing to pay to.
   */
  readonly VITE_DEMO_PAYMENT_ADDRESS?: string;

  /** Amount in ATOMIC NIGHT units (1 NIGHT = 1 000 000). Defaults to `100000`. */
  readonly VITE_DEMO_PAYMENT_AMOUNT?: string;

  /**
   * Explorer base URL used to link a submitted transaction. Defaults to the
   * preview explorer. The transaction route is `/transactions/{hash}` — set
   * this to your network's explorer, or to an empty string to render the bare
   * identifier instead of a link that goes nowhere.
   */
  readonly VITE_EXPLORER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
