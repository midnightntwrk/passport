import { Check, ChevronDown, Globe } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import './network-switcher.css'

/**
 * Network indicator + switcher. The selected network filters which registry
 * apps are shown; it does not move the demo wallet, which genuinely runs on
 * preview only — callers surface that honestly rather than pretending
 * balances exist elsewhere. Default is always preview.
 */

export type PassportNetwork = 'preview' | 'preprod' | 'mainnet'

export const DEFAULT_NETWORK: PassportNetwork = 'preview'
const STORAGE_KEY = 'passport-network'

export const NETWORK_LABELS: Record<PassportNetwork, string> = {
  preview: 'Preview',
  preprod: 'Pre-production',
  mainnet: 'Mainnet',
}

const NETWORK_ORDER: PassportNetwork[] = ['preview', 'preprod', 'mainnet']

export function loadStoredNetwork(): PassportNetwork {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'preview' || stored === 'preprod' || stored === 'mainnet') return stored
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
                {candidate === 'preview' ? <small>Demo wallet lives here</small> : null}
              </span>
              {candidate === network ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ))}
          <p className="mnnet-note">
            <Globe size={12} aria-hidden="true" />
            Switching filters the app list. The demo wallet stays on Preview.
          </p>
        </div>
      ) : null}
    </div>
  )
}
