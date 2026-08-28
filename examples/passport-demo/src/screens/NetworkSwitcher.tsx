import { Check, ChevronDown, Globe } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  defaultSelectedNetwork,
  networkIsTransactable,
  networkUnavailableReason,
  walletNetwork,
} from '../lib/networks.js'
import './network-switcher.css'

/**
 * Network indicator + switcher. The selected network filters which registry
 * apps are shown; it does not move the demo wallet, which runs on the ONE
 * network this build was configured for (`VITE_MIDNIGHT_NETWORK_ID`) — callers
 * surface that honestly rather than pretending balances exist elsewhere.
 *
 * The default follows that same build configuration (2026/08/06), so the app
 * opens on the network its wallet actually signs on and the app grid filters
 * to match. A user's own choice, once made, wins for the session — but a
 * persisted choice that no longer matches the wallet's network is discarded at
 * boot (2026/08/06), because a stale selection silently filtered this build's
 * own apps (the raffle, local dev entries) out of the grid.
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

const NETWORK_ORDER: PassportNetwork[] = ['stagenet', 'preview', 'preprod', 'mainnet']

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

export interface NetworkSwitcherProps {
  network: PassportNetwork
  onSelect: (network: PassportNetwork) => void
}

export default function NetworkSwitcher({ network, onSelect }: NetworkSwitcherProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="mnnet" ref={rootRef}>
      <button
        type="button"
        className="mnnet-pill"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Network: ${NETWORK_LABELS[network]}. Change network`}
        title="Network"
      >
        <span className={`mnnet-dot mnnet-dot-${network}`} aria-hidden="true" />
        <span className="mnnet-name">{NETWORK_LABELS[network]}</span>
        <ChevronDown
          className={`mnnet-chevron${open ? ' mnnet-chevron-open' : ''}`}
          size={13}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="mnnet-menu" role="listbox" aria-label="Choose a network">
          {NETWORK_ORDER.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="option"
              aria-selected={candidate === network}
              className={`mnnet-option${candidate === network ? ' mnnet-option-active' : ''}`}
              onClick={() => {
                onSelect(candidate)
                setOpen(false)
              }}
            >
              <span className={`mnnet-dot mnnet-dot-${candidate}`} aria-hidden="true" />
              <span className="mnnet-option-copy">
                <strong>{NETWORK_LABELS[candidate]}</strong>
                {candidate === WALLET_NETWORK ? (
                  <small>Passport signs here</small>
                ) : networkIsTransactable(candidate) ? null : (
                  /* Selecting a network only filters the app list — it never
                     moves where Passport signs, which is what the note below
                     says. But
                     this build's ledger cannot transact on the ledger-8
                     networks at all, so saying "read-only" here is the
                     difference between a filter and a promise. */
                  <small>Read-only from this build</small>
                )}
              </span>
              {candidate === network ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ))}
          <p className="mnnet-note">
            <Globe size={12} aria-hidden="true" />
            Switching filters the app list. Passport keeps signing on{' '}
            {WALLET_NETWORK ? NETWORK_LABELS[WALLET_NETWORK] : 'its configured network'}.
          </p>
          {/* Why the selected network is read-only, in the words networks.ts
              uses — shown only when it IS read-only, so the common case is
              unchanged. Without it, "switching filters the app list" reads as
              though a name could still be claimed over there. */}
          {networkUnavailableReason(network) ? (
            <p className="mnnet-note mnnet-note-warning">{networkUnavailableReason(network)}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
