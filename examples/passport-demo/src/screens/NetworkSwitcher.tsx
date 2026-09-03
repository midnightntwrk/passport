import {
  defaultSelectedNetwork,
  walletNetwork,
} from '../lib/networks.js'

/**
 * The network CONTEXT — which network this build is on, what to call it, and
 * how a session remembers it. There is no switcher any more.
 *
 * THE SWITCHER WENT ON 2026/09/03, after the 2026/09/02 review. It offered
 * Preview, Pre-production, and Mainnet beside Stagenet, and choosing one of
 * them never moved anything: Passport signs on the ONE network this build was
 * configured for (`VITE_MIDNIGHT_NETWORK_ID`), so the control filtered the app
 * grid and nothing else. Its own menu had to say so in a footnote, and a second
 * footnote had to explain that two of the four were read-only from this build.
 * A control that needs two disclaimers to stop it being a promise is a control
 * that should not be on screen: this is a stagenet demo, and it now reads as
 * one everywhere rather than as a client that could be pointed anywhere.
 *
 * WHAT STAYED, AND WHY THE FILE IS STILL CALLED THIS. Everything below is
 * plumbing the rest of the app reads: the network's type, its label, and the
 * per-session memory of which one is selected. Nine modules import it from this
 * path; moving them all to say the same thing somewhere else would be churn
 * bought with nothing. `loadStoredNetwork` still discards a stale selection at
 * boot, because a value persisted by an older build can still be sitting in
 * storage and it still must not survive into a build whose wallet signs
 * elsewhere.
 */

export type PassportNetwork = 'stagenet' | 'preview' | 'preprod' | 'mainnet'

export const DEFAULT_NETWORK: PassportNetwork = defaultSelectedNetwork()
/** The network the wallet in this build signs on, or null on a devnet build. */
const WALLET_NETWORK = walletNetwork()
const STORAGE_KEY = 'passport-network'

/* Under the owner's localnet screen-recording mode the masqueraded network
   is labelled for what it really is. Env-gated; public builds never set it. */
const LOCALNET_DEMO =
  ((import.meta.env ?? {}) as Record<string, string | undefined>).VITE_LOCALNET_DEMO === '1'

export const NETWORK_LABELS: Record<PassportNetwork, string> = {
  stagenet: LOCALNET_DEMO ? 'Localnet' : 'Stagenet',
  preview: 'Preview',
  preprod: 'Pre-production',
  mainnet: 'Mainnet',
}

export function loadStoredNetwork(): PassportNetwork {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (
      stored === 'stagenet' ||
      stored === 'preview' ||
      stored === 'preprod' ||
      stored === 'mainnet'
    ) {
      /* A selection persisted by an earlier visit can disagree with the
         network THIS build's wallet signs on — after a redeploy, or across
         builds sharing an origin. Keeping it would filter the build's own
         apps out of the grid with no hint why, so the wallet's network wins
         at boot and the stale selection is discarded. */
      if (WALLET_NETWORK && stored !== WALLET_NETWORK) {
        localStorage.removeItem(STORAGE_KEY)
        return DEFAULT_NETWORK
      }
      return stored
    }
  } catch {
    /* storage unavailable — stay on the default */
  }
  return DEFAULT_NETWORK
}

export function storeNetwork(network: PassportNetwork) {
  try {
    localStorage.setItem(STORAGE_KEY, network)
  } catch {
    /* storage unavailable — selection lives for the session only */
  }
}
