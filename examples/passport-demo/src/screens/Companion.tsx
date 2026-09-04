import { MessageCircle } from 'lucide-react'

import { COMPANION_LABEL, companionEnabled, companionUrl } from '../lib/companionLink.js'
import './companion.css'

/**
 * "Chat with your Midnight Companion" — a link out to a Telegram chat, and
 * nothing else.
 *
 * It is an anchor rather than a button because that is exactly what it does:
 * the browser opens a new tab, Passport takes no other action, holds no state,
 * and is told nothing about what happens on the other side. There is no
 * handshake here and no session; if that changes, it changes somewhere else.
 *
 * The address is decided by `../lib/companionLink.ts`, which is drilled. This
 * file paints two shapes of the same link:
 *
 *   `variant="row"`  the full control on the Apps tab, where a person is
 *                    already looking for something to open.
 *   `variant="icon"` the 34px circle in Home's top bar, beside the install
 *                    and theme controls, borrowing `.mnhome-icon-button` so it
 *                    is the same circle as its neighbours rather than a
 *                    lookalike.
 *
 * The handle the default points at is a PLACEHOLDER — see the link module's
 * header. A build with the real one sets `VITE_COMPANION_URL`.
 */

export interface CompanionLinkProps {
  variant?: 'row' | 'icon'
}

export default function CompanionLink({ variant = 'row' }: CompanionLinkProps) {
  const configured = import.meta.env.VITE_COMPANION_URL
  if (!companionEnabled(configured)) return null
  const href = companionUrl(configured)

  if (variant === 'icon') {
    return (
      <a
        className="mnhome-icon-button mncompanion-icon"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={COMPANION_LABEL}
        title={COMPANION_LABEL}
      >
        <MessageCircle size={15} aria-hidden="true" />
      </a>
    )
  }

  return (
    <a
      className="mncompanion-row"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      <span className="mncompanion-mark" aria-hidden="true">
        <MessageCircle size={16} strokeWidth={2} />
      </span>
      <span className="mncompanion-copy">
        <span className="mncompanion-label">{COMPANION_LABEL}</span>
        <span className="mncompanion-hint">Opens a chat in a new tab</span>
      </span>
    </a>
  )
}
