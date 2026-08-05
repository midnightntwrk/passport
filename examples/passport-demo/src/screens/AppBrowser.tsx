import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronLeft,
  ExternalLink,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  createPassportProfileReady,
  createPassportProfileResponse,
  parsePassportProfileRequest,
  type PassportProfileField,
  type PassportProfileRequest,
  type PassportProfileResponse,
} from '../backend.js'
import type { RegistryApp } from '../lib/registry.js'
import './apps.css'

/**
 * Fullscreen in-app browser for a registry app.
 *
 * Honest boundary: the same-origin policy makes it impossible to inject
 * `window.midnight.*` into a cross-origin iframe, so this browser does not
 * pretend to. The only bridge is the Passport profile postMessage protocol —
 * the app asks, Passport asks you, and only the fields you approve leave.
 */

/** How long to wait before warning that the app may have refused to frame. */
const FRAME_HINT_MS = 6_000

/** Shape of the profile Passport is willing to expose to a framed app. */
export interface PassportProfileSummary {
  displayName?: string | null
  /** Address and the network it is deployed on — a localnet Passport must not
      be reported to an app as a preview one. */
  passportContract?: { address: string; network: string } | null
  midnightAddresses?: {
    unshielded?: string | null
    shielded?: string | null
    dust?: string | null
  }
}

export interface AppBrowserProps {
  app: RegistryApp
  profile: PassportProfileSummary | null
  onClose: () => void
  onProfileShared?: (appName: string, fields: string[]) => void
}

interface PendingRequest {
  request: PassportProfileRequest
  origin: string
  /** True when the app echoed the request id and nonce Passport issued in its ready message. */
  bound: boolean
}

const FIELD_LABELS: Record<PassportProfileField, string> = {
  displayName: 'Passport display name',
  passportContract: 'Passport contract address and network',
  midnightAddresses: 'Midnight unshielded, shielded, and DUST addresses',
}

const FIELD_DETAILS: Record<PassportProfileField, string> = {
  displayName: 'The public name attached to this Passport.',
  passportContract: 'The C1 address this Passport is deployed at.',
  midnightAddresses: 'Public receiving addresses — never the keys behind them.',
}

function randomNonce(bytes = 24): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes))
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hasField(
  profile: PassportProfileSummary | null,
  field: PassportProfileField,
): boolean {
  if (!profile) return false
  if (field === 'displayName') return Boolean(profile.displayName)
  if (field === 'passportContract') return Boolean(profile.passportContract)
  return Boolean(profile.midnightAddresses?.unshielded)
}

/** App icon with a letter-tile fallback when the registry icon fails to load. */
export function AppIcon({
  app,
  className,
}: {
  app: RegistryApp
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const letter = app.name.trim().charAt(0).toUpperCase() || '?'
  const classes = className ? `mnapps-icon ${className}` : 'mnapps-icon'

  if (!app.icon || failed) {
    return (
      <span className={`${classes} mnapps-icon-letter`} aria-hidden="true">
        {letter}
      </span>
    )
  }
  return (
    <span className={classes} aria-hidden="true">
      {/* Registry icons are third-party hosts: send no Referer, so an icon
          host learns nothing about which Passport screen requested it. */}
      <img
        src={app.icon}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </span>
  )
}

/** Registry names may carry a parenthetical qualifier — "Atlas (Passport demo
    dApp)". The chrome and consent sheet sit directly above the app's own
    header, so they show the bare name; the full registry name still goes to
    the activity feed untouched. */
function displayName(name: string): string {
  return name.replace(/\s*\(.*\)$/, '').trim() || name
}

export default function AppBrowser(props: AppBrowserProps) {
  const { app, profile, onClose, onProfileShared } = props
  const shownName = displayName(app.name)

  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const handshake = useRef<{ requestId: string; nonce: string } | null>(null)

  const [loaded, setLoaded] = useState(false)
  /** Any message from the framed window is genuine evidence it is running. */
  const [frameSpoke, setFrameSpoke] = useState(false)
  const [hintDue, setHintDue] = useState(false)
  const [hintDismissed, setHintDismissed] = useState(false)
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [approved, setApproved] = useState<PassportProfileField[]>([])
  const [outcome, setOutcome] = useState<'approved' | 'denied' | 'unavailable' | null>(
    null,
  )

  /* `null` means "Passport refuses to frame this entry", which is also what
     switches the surface over to the explanatory panel below. Registry
     entries are third-party data, so two refusals matter here:
       - a non-http(s) URL, which `window.open` would execute as script;
       - an app served from Passport's OWN origin. The frame needs
         `allow-same-origin` for the app to keep a nameable origin for the
         consent sheet, but on a same-origin document that flag also lifts the
         sandbox entirely — the "app" would get Passport's IndexedDB and could
         forge a profile request that passes the `event.origin` check. */
  const origin = useMemo(() => {
    try {
      const parsed = new URL(app.url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
      if (parsed.origin === window.location.origin) return null
      return parsed.origin
    } catch {
      return null
    }
  }, [app.url])

  /* The 6-second heuristic. X-Frame-Options and frame-ancestors refusals are
     not observable from script, so a timer plus the always-available new-tab
     button is the most honest thing we can offer. */
  useEffect(() => {
    const timer = window.setTimeout(() => setHintDue(true), FRAME_HINT_MS)
    return () => window.clearTimeout(timer)
  }, [app.id])

  /* Lock the page behind the overlay so the list does not scroll underneath. */
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const post = useCallback(
    (
      request: PassportProfileRequest,
      body: Omit<
        PassportProfileResponse,
        'protocol' | 'type' | 'requestId' | 'nonce'
      >,
    ) => {
      const target = frameRef.current?.contentWindow
      if (!target || !origin) return
      target.postMessage(createPassportProfileResponse(request, body), origin)
    },
    [origin],
  )

  /* Inbound profile requests. Two checks make this safe: the message must come
     from this iframe's own window, and from the app's own origin. */
  useEffect(() => {
    if (!origin) return undefined
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (event.origin !== origin) return
      setFrameSpoke(true)
      const request = parsePassportProfileRequest(event.data)
      if (!request) return
      /* A sheet is already up. A second request must never replace the one the
         user is reading — that would swap the origin, the field list, and the
         ticks underneath them mid-decision. Refuse it outright. */
      if (pending) {
        post(request, { approved: false, error: 'invalid_request' })
        return
      }
      /* An iframe-aware app echoes the ready pair; an opener-style app mints
         its own. Both are accepted — the reply is always bound to the ids the
         app itself sent — but only the echoed case is reported as bound. */
      const issued = handshake.current
      const bound =
        issued !== null &&
        issued.requestId === request.requestId &&
        issued.nonce === request.nonce
      setPending({ request, origin: event.origin, bound })
      /* Consent is opt-in: every box starts unticked, for every new request. */
      setApproved([])
      setOutcome(null)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [origin, pending, post])

  const handleLoad = useCallback(() => {
    setLoaded(true)
    const target = frameRef.current?.contentWindow
    if (!target || !origin) return
    const requestId = crypto.randomUUID()
    const nonce = randomNonce()
    handshake.current = { requestId, nonce }
    target.postMessage(createPassportProfileReady(requestId, nonce), origin)
  }, [origin])

  const openExternally = useCallback(() => {
    if (!origin) return
    window.open(app.url, '_blank', 'noopener,noreferrer')
  }, [app.url, origin])

  const toggle = (field: PassportProfileField) => {
    if (!hasField(profile, field)) return
    setApproved((current) =>
      current.includes(field)
        ? current.filter((value) => value !== field)
        : [...current, field],
    )
  }

  const deny = useCallback(
    (reason: 'denied' | 'profile_unavailable') => {
      if (!pending) return
      post(pending.request, { approved: false, error: reason })
      setOutcome(reason === 'denied' ? 'denied' : 'unavailable')
    },
    [pending, post],
  )

  const share = () => {
    if (!pending) return
    const shared: NonNullable<PassportProfileResponse['profile']> = {}
    const names: string[] = []

    for (const field of pending.request.fields) {
      if (!approved.includes(field)) continue
      if (field === 'displayName' && profile?.displayName) {
        shared.displayName = profile.displayName
        names.push('displayName')
        continue
      }
      if (field === 'passportContract' && profile?.passportContract) {
        shared.passportContract = {
          address: profile.passportContract.address,
          network: profile.passportContract.network,
        }
        names.push('passportContract')
        continue
      }
      if (field === 'midnightAddresses') {
        const unshielded = profile?.midnightAddresses?.unshielded
        if (!unshielded) continue
        const addresses: { unshielded: string; shielded?: string; dust?: string } = {
          unshielded,
        }
        const shielded = profile?.midnightAddresses?.shielded
        const dust = profile?.midnightAddresses?.dust
        if (shielded) addresses.shielded = shielded
        if (dust) addresses.dust = dust
        shared.midnightAddresses = addresses
        names.push('midnightAddresses')
      }
    }

    if (names.length === 0) {
      deny('profile_unavailable')
      return
    }
    post(pending.request, { approved: true, profile: shared })
    onProfileShared?.(app.name, names)
    setOutcome('approved')
  }

  /* Escape closes the sheet first, then the browser. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (pending) {
        if (outcome) setPending(null)
        else deny('denied')
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pending, outcome, deny, onClose])

  const anythingToShare = pending
    ? pending.request.fields.some((field) => hasField(profile, field))
    : false
  const showHint = hintDue && !hintDismissed && !frameSpoke

  /* Portalled to <body>: the browser and its consent sheet are fixed overlays,
     and a host screen's stacking context (e.g. Home's entry animation with
     `fill-mode: both`) would otherwise trap them beneath the bottom nav,
     which then intercepts taps on the sheet's actions. */
  return createPortal(
    <div
      className="mnapps-browser"
      role="dialog"
      aria-modal="true"
      aria-label={`${shownName}, open inside Passport`}
    >
      <header className="mnapps-chrome">
        <button
          type="button"
          className="mnapps-chrome-button"
          onClick={onClose}
          aria-label="Close app and return to Apps"
        >
          <ChevronLeft size={20} strokeWidth={2.2} aria-hidden="true" />
        </button>
        <AppIcon app={app} className="mnapps-icon-chrome" />
        <span className="mnapps-chrome-copy">
          <strong>{shownName}</strong>
          <code>{origin ?? app.url}</code>
        </span>
        <button
          type="button"
          className="mnapps-chrome-button"
          onClick={openExternally}
          disabled={!origin}
          aria-label="Open this app in a new tab"
        >
          <ExternalLink size={17} strokeWidth={2.1} aria-hidden="true" />
        </button>
      </header>

      <div className="mnapps-frame-wrap">
        {origin ? (
          <iframe
            ref={frameRef}
            className="mnapps-frame"
            title={shownName}
            src={app.url}
            onLoad={handleLoad}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div className="mnapps-frame-invalid" role="alert">
            <TriangleAlert size={20} strokeWidth={2} aria-hidden="true" />
            <p>
              This registry entry does not carry a usable web address on a
              separate origin, so Passport will not open it.
            </p>
          </div>
        )}

        {!loaded && origin ? (
          <div className="mnapps-frame-loading" role="status">
            <Loader2
              className="mnapps-spinner"
              size={18}
              strokeWidth={2}
              aria-hidden="true"
            />
            <span>Loading {shownName}…</span>
          </div>
        ) : null}

        {showHint && origin ? (
          <div className="mnapps-hint" role="status">
            <TriangleAlert size={16} strokeWidth={2.1} aria-hidden="true" />
            <p>This app may refuse to load inside Passport. Open it in a new tab instead.</p>
            <button
              type="button"
              className="mnapps-hint-open"
              onClick={openExternally}
            >
              New tab
            </button>
            <button
              type="button"
              className="mnapps-hint-dismiss"
              onClick={() => setHintDismissed(true)}
              disabled={!loaded}
              aria-label="Dismiss this notice"
              title={
                loaded
                  ? 'Dismiss this notice'
                  : 'Available once the app reports that it has loaded'
              }
            >
              <X size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      {pending ? (
        <div className="mnapps-sheet-backdrop">
          <section
            className="mnapps-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mnapps-sheet-title"
          >
            <header className="mnapps-sheet-head">
              <span className="mnapps-sheet-mark" aria-hidden="true">
                <ShieldCheck size={19} strokeWidth={2} />
              </span>
              <div>
                <p>Passport connection</p>
                <h2 id="mnapps-sheet-title">
                  {outcome === 'approved'
                    ? 'Profile shared.'
                    : outcome === 'denied'
                      ? 'Request declined.'
                      : outcome === 'unavailable'
                        ? 'Nothing to share yet.'
                        : `${shownName} is asking for your profile.`}
                </h2>
              </div>
            </header>

            {outcome ? (
              <div className="mnapps-sheet-outcome">
                {outcome === 'approved' ? (
                  <Check size={20} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <X size={20} strokeWidth={2.2} aria-hidden="true" />
                )}
                <p>
                  {outcome === 'approved'
                    ? `Only the fields you ticked were returned to ${pending.origin}.`
                    : outcome === 'denied'
                      ? `No Passport data was returned to ${pending.origin}.`
                      : `Passport told ${pending.origin} that no profile is available yet.`}
                </p>
                <button
                  type="button"
                  className="mnapps-sheet-done"
                  onClick={() => setPending(null)}
                >
                  Back to the app
                </button>
              </div>
            ) : (
              <>
                <p className="mnapps-sheet-origin">
                  <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                  <code>{pending.origin}</code>
                  <small>{pending.bound ? 'Handshake bound' : 'Unsolicited'}</small>
                </p>
                <p className="mnapps-sheet-copy">
                  Tick only what this app may read. Everything else stays on this
                  device.
                </p>
                <ul className="mnapps-sheet-fields">
                  {pending.request.fields.map((field) => {
                    const available = hasField(profile, field)
                    const checked = approved.includes(field)
                    return (
                      <li key={field}>
                        <button
                          type="button"
                          className="mnapps-field"
                          onClick={() => toggle(field)}
                          disabled={!available}
                          aria-pressed={checked}
                        >
                          <span
                            className={
                              checked
                                ? 'mnapps-field-box mnapps-field-box-on'
                                : 'mnapps-field-box'
                            }
                            aria-hidden="true"
                          >
                            {checked ? <Check size={13} strokeWidth={3} /> : null}
                          </span>
                          <span className="mnapps-field-copy">
                            <strong>{FIELD_LABELS[field]}</strong>
                            <small>
                              {available
                                ? FIELD_DETAILS[field]
                                : 'Not available on this Passport yet.'}
                            </small>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <p className="mnapps-sheet-boundary">
                  Passkey references, encrypted witnesses, private state, and
                  recovery data are never shared — not with this app, not with any
                  app.
                </p>
                <div className="mnapps-sheet-actions">
                  <button
                    type="button"
                    className="mnapps-button-ghost"
                    onClick={() => deny('denied')}
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    className="mnapps-button-solid"
                    onClick={share}
                    disabled={!anythingToShare || approved.length === 0}
                  >
                    <ShieldCheck size={15} strokeWidth={2.2} aria-hidden="true" />
                    Share selected
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
