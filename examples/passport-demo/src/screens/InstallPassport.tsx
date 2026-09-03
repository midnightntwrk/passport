import { Download, Share, SquarePlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  INSTALL_HINT_STEPS,
  INSTALL_LABEL,
  installAffordance,
  type InstallAffordance,
} from '../lib/installPrompt.js'
import './install-passport.css'

/**
 * The install control, in the top bar where a person looks for it.
 *
 * Everything it decides is in `lib/installPrompt.ts`, which is drilled; this
 * file reads the browser, holds the captured event, and paints two things: a
 * button that opens Chromium's own install dialogue, and — on iOS Safari,
 * which fires no install event and never will — the two taps the reader has to
 * make themselves.
 *
 * IT DOES NOT NAG. It appears when installing is possible and disappears the
 * moment it is not, and it never opens anything by itself. `prompt()` runs on
 * a press and nowhere else. There is no "not now", because there is nothing to
 * decline: it is a control in a toolbar, not an invitation.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean
}

function readStandaloneDisplay(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
}

export default function InstallPassport() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [standalone, setStandalone] = useState(readStandaloneDisplay)
  const [hintOpen, setHintOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      /* Held rather than acted on. Chromium's own banner is suppressed by the
         default being prevented in `pwa.tsx`; this page replays the event when
         somebody presses the button, which is the only place it is ever
         replayed from. */
      setPrompt(event as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setPrompt(null)
      setStandalone(true)
      setHintOpen(false)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    /* An app opened in a tab and then installed elsewhere, or launched from
       the home screen into an already-open document, changes display mode
       without reloading. */
    const media = window.matchMedia('(display-mode: standalone)')
    const onDisplayChange = () => setStandalone(readStandaloneDisplay())
    media.addEventListener('change', onDisplayChange)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
      media.removeEventListener('change', onDisplayChange)
    }
  }, [])

  useEffect(() => {
    if (!hintOpen) return undefined
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setHintOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHintOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [hintOpen])

  const affordance: InstallAffordance = installAffordance({
    standaloneDisplay: standalone,
    iosStandalone: (navigator as NavigatorWithStandalone).standalone,
    promptHeld: prompt !== null,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  })

  if (affordance === 'hidden') return null

  const install = async () => {
    if (!prompt) return
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      /* An accepted prompt cannot be replayed, and a declined one should not
         be: the control stays for the session either way, and Chromium hands
         the page a fresh event when it is willing to be asked again. */
      if (choice.outcome === 'accepted') setPrompt(null)
    } catch {
      /* The event was already spent — the mobile sheet in `pwa.tsx` got there
         first. Nothing to say; the browser has already shown its dialogue. */
      setPrompt(null)
    }
  }

  return (
    <div className="mninstall" ref={rootRef}>
      <button
        type="button"
        className="mnhome-icon-button"
        aria-label={INSTALL_LABEL}
        title={INSTALL_LABEL}
        aria-expanded={affordance === 'hint' ? hintOpen : undefined}
        onClick={() => {
          if (affordance === 'hint') setHintOpen((open) => !open)
          else void install()
        }}
      >
        <Download size={15} aria-hidden="true" />
      </button>

      {affordance === 'hint' && hintOpen ? (
        <div className="mninstall-hint" role="dialog" aria-label={INSTALL_LABEL}>
          <p className="mninstall-hint-title">
            {INSTALL_LABEL}
            <button
              type="button"
              className="mninstall-hint-close"
              onClick={() => setHintOpen(false)}
              aria-label="Close"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </p>
          <ol className="mninstall-hint-steps">
            <li>
              <Share size={14} strokeWidth={2} aria-hidden="true" />
              <span>{INSTALL_HINT_STEPS[0]}</span>
            </li>
            <li>
              <SquarePlus size={14} strokeWidth={2} aria-hidden="true" />
              <span>{INSTALL_HINT_STEPS[1]}</span>
            </li>
          </ol>
        </div>
      ) : null}
    </div>
  )
}
