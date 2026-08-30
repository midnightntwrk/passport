import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronLeft,
  ExternalLink,
  Loader2,
  PenLine,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  createPassportProfileReady,
  createPassportProfileResponse,
  createPassportTxResponse,
  parsePassportIncentiveReport,
  parsePassportProfileRequest,
  parsePassportTxRequest,
  type PassportProfileField,
  type PassportProfileRequest,
  type PassportProfileResponse,
  type PassportTxRequest,
} from '../backend.js'
/* The approval ladder, the NIGHT formatting, the error mapping, and the two
   sentences of sheet copy live in one module so the popup approval surface
   (`txConsent.tsx`) cannot drift from this one. Extraction only — every string
   and the order of the checks are unchanged. */
import {
  capTxDetail,
  evaluateTxRequest,
  explorerTxHref,
  formatNight,
  shortAddress,
  transferErrorFrom,
  txBoundaryCopy,
  accountHoldsCopy,
  type PassportTxResponseBody,
} from '../lib/txApproval.js'
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

/** Must equal the `.mnapps-browser-closing` animation length in apps.css —
    the parent unmounts the browser the moment `onClose` runs, so `onClose`
    may only fire once the exit animation has played. */
const CLOSE_ANIMATION_MS = 200

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

/** What a framed app asked Passport to sign, in Passport's own units. */
export interface PassportTransferIntent {
  recipientAddress: string
  /** Atomic NIGHT units. */
  amount: bigint
  purpose: string
  /** The app origin that asked, for the caller's activity log. */
  origin: string
}

export interface AppBrowserProps {
  app: RegistryApp
  profile: PassportProfileSummary | null
  onClose: () => void
  onProfileShared?: (appName: string, fields: string[]) => void
  /**
   * Signs and submits a real unshielded NIGHT payment, resolving with the
   * node's transaction id. Wired by the host to a `withdraw_night` on this
   * Passport's account-custody contract — the money is the ACCOUNT's, the
   * wallet only signs. Left undefined when there is no wallet session OR no
   * deployed account: the approval sheet is then never shown and the app is
   * told `wallet-unavailable` rather than being left waiting.
   */
  executeTransfer?: (intent: PassportTransferIntent) => Promise<{ txId: string }>
  /**
   * The wallet the approval sheet is describing. `networkId` is the network a
   * recipient address must belong to; `formattedBalance` is NIGHT in display
   * units, or null while it is still unknown (the sheet then says so).
   */
  transferContext?: { networkId: string; formattedBalance: string | null } | null
  /** Called once per distinct incentive an app reports having granted. */
  onIncentiveRedeemed?: (incentive: {
    id: string
    app: string
    label: string
    txId?: string
  }) => void
}

interface PendingRequest {
  request: PassportProfileRequest
  origin: string
  /** True when the app echoed the request id and nonce Passport issued in its ready message. */
  bound: boolean
}

interface PendingTransfer {
  request: PassportTxRequest
  origin: string
  /** The parsed atomic amount, so the sheet and the send agree exactly. */
  amount: bigint
}

type TransferOutcome =
  | { kind: 'submitted'; txId: string }
  | { kind: 'declined' }
  | { kind: 'failed'; message: string }

/* Word for word `../../profileConsent.tsx`, and for the reason given there:
   the wire field still carries all three addresses, but the three addresses
   are kept out of Passport's primary UI, a consent sheet must not be where the
   fee token first reaches a user, and — since the account-custody ruling — the
   detail line must not read as an invitation to pay one of them. */
const FIELD_LABELS: Record<PassportProfileField, string> = {
  displayName: 'Passport display name',
  passportContract: 'Your Passport account — its address and network',
  midnightAddresses: 'Midnight technical addresses',
}

const FIELD_DETAILS: Record<PassportProfileField, string> = {
  displayName: 'The public name attached to this Passport.',
  passportContract: 'The account this Passport IS — where its money lives and what its .night name resolves to.',
  midnightAddresses:
    'Technical Midnight addresses used by this Passport’s transaction engine — send funds to your account address, not to these.',
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

/** Registry names may carry a parenthetical qualifier — "Midnight Raffle
    (demo dApp)". The chrome and consent sheet sit directly above the app's own
    header, so they show the bare name; the full registry name still goes to
    the activity feed untouched. */
function displayName(name: string): string {
  return name.replace(/\s*\(.*\)$/, '').trim() || name
}

export default function AppBrowser(props: AppBrowserProps) {
  const {
    app,
    profile,
    onClose,
    onProfileShared,
    executeTransfer,
    transferContext,
    onIncentiveRedeemed,
  } = props
  const shownName = displayName(app.name)

  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const handshake = useRef<{ requestId: string; nonce: string } | null>(null)

  const [loaded, setLoaded] = useState(false)
  /** Any message from the framed window is genuine evidence it is running.
      Per DOCUMENT, not per app: a navigation inside the frame replaces the
      document, and the new one has not spoken yet. */
  const [frameSpoke, setFrameSpoke] = useState(false)
  /** Whether any document in this frame has ever spoken. The slow-frame hint
      keys off this rather than off `frameSpoke`, so navigating between an
      app's own pages does not make the hint flash back on for an app that has
      already proved it frames and speaks the protocol. */
  const everSpoke = useRef(false)
  const [hintDue, setHintDue] = useState(false)
  const [hintDismissed, setHintDismissed] = useState(false)
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [approved, setApproved] = useState<PassportProfileField[]>([])
  const [outcome, setOutcome] = useState<'approved' | 'denied' | 'unavailable' | null>(
    null,
  )
  const [pendingTx, setPendingTx] = useState<PendingTransfer | null>(null)
  /** True from the moment "Approve and sign" is tapped until the wallet answers. */
  const [signing, setSigning] = useState(false)
  const [txOutcome, setTxOutcome] = useState<TransferOutcome | null>(null)
  /** Reveals the full recipient address in the sheet. */
  const [showFullRecipient, setShowFullRecipient] = useState(false)
  /** Incentive ids this app has already reported in this session. */
  const reportedIncentives = useRef<Set<string>>(new Set())

  /* An app's own record of what it granted is per app: two apps may legitimately
     use the same incentive id, and reopening a different app must not silently
     swallow its first report. */
  useEffect(() => {
    reportedIncentives.current = new Set()
  }, [app.id])

  /* Keep the transfer callables in a ref as well as in props: the message
     listener re-registers on every state change already, but the approve
     handler must always see the wallet that is open *now*. */
  const executeTransferRef = useRef(executeTransfer)
  executeTransferRef.current = executeTransfer

  /* Closing is one-shot: `closing` flips the exit-animation class, and the
     parent's `onClose` is deferred until that animation has played. The ref
     guard means a second Escape or back tap during the exit does nothing. */
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const closeTimer = useRef(0)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), CLOSE_ANIMATION_MS)
  }, [])
  /* The timer must not outlive this instance: with `key={app.id}` a stale
     timeout would close whichever app replaced this one. */
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

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

  const postTx = useCallback(
    (request: PassportTxRequest, body: PassportTxResponseBody) => {
      const target = frameRef.current?.contentWindow
      if (!target || !origin) return
      /* The app's own parser caps `detail` at 400 characters and rejects the
         whole response if it is longer — `capTxDetail` truncates rather than
         have the app silently ignore an honest failure reply. */
      target.postMessage(createPassportTxResponse(request, capTxDetail(body)), origin)
    },
    [origin],
  )

  /* Inbound app messages — profile requests, transaction requests, and
     incentive reports. Two checks make all three safe: the message must come
     from this iframe's own window, and from the app's own origin. Anything from
     another frame, another window, or another origin never reaches a parser. */
  useEffect(() => {
    if (!origin) return undefined
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (event.origin !== origin) return
      everSpoke.current = true
      setFrameSpoke(true)

      const request = parsePassportProfileRequest(event.data)
      if (request) {
        /* A sheet is already up. A second request must never replace the one the
           user is reading — that would swap the origin, the field list, and the
           ticks underneath them mid-decision. Refuse it outright. */
        if (pending || pendingTx) {
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
        return
      }

      const txRequest = parsePassportTxRequest(event.data)
      if (txRequest) {
        handleTxRequest(txRequest, event.origin)
        return
      }

      const report = parsePassportIncentiveReport(event.data)
      if (report) {
        /* Passport records what an app says it granted; it never invents an
           incentive on the app's behalf. Deduped by id, per app, per session. */
        const id = report.incentive.id
        if (reportedIncentives.current.has(id)) return
        reportedIncentives.current.add(id)
        onIncentiveRedeemed?.({
          id,
          app: app.name,
          label: report.incentive.label,
          ...(report.incentive.txId ? { txId: report.incentive.txId } : {}),
        })
      }
    }

    const handleTxRequest = (txRequest: PassportTxRequest, requestOrigin: string) => {
      /* The four-step ladder — sheet already open, wallet availability,
         recipient decode plus network match, amount — lives in
         `lib/txApproval.ts` so the popup approval surface climbs exactly the
         same one, in exactly the same order, answering with exactly the same
         codes and sentences. */
      const verdict = evaluateTxRequest(txRequest, {
        sheetOpen: Boolean(pending || pendingTx),
        walletReady: Boolean(executeTransferRef.current),
        transferContext: transferContext ?? null,
      })
      if (verdict.kind === 'refuse') {
        postTx(txRequest, verdict.body)
        return
      }

      setPendingTx({ request: txRequest, origin: requestOrigin, amount: verdict.amount })
      setSigning(false)
      setTxOutcome(null)
      setShowFullRecipient(false)
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [
    app.name,
    onIncentiveRedeemed,
    origin,
    pending,
    pendingTx,
    post,
    postTx,
    transferContext,
  ])

  /* `signing` as the load handler can see it: `handleLoad` is built once and
     the DOM calls it whenever the frame commits a document. */
  const signingRef = useRef(false)
  signingRef.current = signing
  /** How many documents this frame has committed. >1 means the app navigated. */
  const documents = useRef(0)

  const handleLoad = useCallback(() => {
    setLoaded(true)
    documents.current += 1
    /* An app that navigates — its own next page, a reload, a link out — takes
       the document that asked with it. A sheet raised by the previous document
       cannot be answered: `postMessage` would reach a window that never sent
       the request and drops the reply, while Passport's sheet went on telling
       the user their answer had been delivered. So the sheet goes with the
       document that raised it, and the exchange is simply abandoned.

       A signature already in flight is the exception, and the same one Escape
       makes: the transaction may already be at the node, so it is allowed to
       finish and report what really happened. */
    if (documents.current > 1) {
      setFrameSpoke(false)
      if (!signingRef.current) {
        setPending(null)
        setApproved([])
        setOutcome(null)
        setPendingTx(null)
        setTxOutcome(null)
      }
    }
    const target = frameRef.current?.contentWindow
    if (!target || !origin) return
    const requestId = crypto.randomUUID()
    const nonce = randomNonce()
    handshake.current = { requestId, nonce }
    target.postMessage(createPassportProfileReady(requestId, nonce), origin)
  }, [origin])

  /* The single load-time ready is race-prone: with async module scripts the
     frame's load event can fire before the app inside has attached its
     message listener, and a one-shot ready is then lost forever — the app
     reports "Passport has not completed the handshake". Re-broadcast the SAME
     requestId/nonce (idempotent for the app) until the frame says anything
     back, capped so apps that never speak the protocol are not pestered. */
  useEffect(() => {
    if (!loaded || !origin || frameSpoke) return undefined
    let attempts = 0
    const timer = window.setInterval(() => {
      const target = frameRef.current?.contentWindow
      const issued = handshake.current
      attempts += 1
      if (!target || !issued || attempts > 40) {
        window.clearInterval(timer)
        return
      }
      target.postMessage(createPassportProfileReady(issued.requestId, issued.nonce), origin)
    }, 800)
    return () => window.clearInterval(timer)
  }, [loaded, origin, frameSpoke])

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

  const declineTransfer = useCallback(() => {
    if (!pendingTx || signing) return
    postTx(pendingTx.request, { status: 'declined', error: 'declined' })
    setTxOutcome({ kind: 'declined' })
  }, [pendingTx, postTx, signing])

  const approveTransfer = useCallback(async () => {
    if (!pendingTx || signing) return
    const wallet = executeTransferRef.current
    if (!wallet) {
      /* The wallet closed between the sheet appearing and this tap. */
      postTx(pendingTx.request, {
        status: 'failed',
        error: 'wallet-unavailable',
        detail: 'The Passport signing session closed before this could be signed.',
      })
      setTxOutcome({
        kind: 'failed',
        message: 'The Passport signing session closed before this could be signed.',
      })
      return
    }
    setSigning(true)
    try {
      const { txId } = await wallet({
        recipientAddress: pendingTx.request.intent.recipientAddress,
        amount: pendingTx.amount,
        purpose: pendingTx.request.intent.purpose,
        origin: pendingTx.origin,
      })
      /* Nothing is ever reported as submitted without the node's own id. */
      if (!txId) throw new Error('Passport returned no transaction id.')
      postTx(pendingTx.request, { status: 'submitted', txId })
      setTxOutcome({ kind: 'submitted', txId })
      /* No toast is raised here. The send seam this component is handed
         (`App.tsx`'s `executeAppTransfer`) already raises the submitted toast,
         with the same explorer link, for BOTH approval surfaces — one raised
         here as well stacked two success toasts on one transaction. The seam
         is the honest place for it: it is the code that knows the transaction
         reached the node. */
    } catch (cause) {
      /* Cancelling the passkey verification sheet is the user declining, not a
         submission that failed — the app is told exactly that. */
      const cancelledCode =
        typeof cause === 'object' && cause !== null &&
        (cause as { code?: unknown }).code === 'approval-cancelled'
      if (cancelledCode) {
        postTx(pendingTx.request, { status: 'declined', error: 'declined' })
        setTxOutcome({ kind: 'declined' })
      } else {
        const { error, detail } = transferErrorFrom(cause)
        postTx(pendingTx.request, { status: 'failed', error, detail })
        setTxOutcome({ kind: 'failed', message: detail })
      }
    } finally {
      setSigning(false)
    }
  }, [pendingTx, postTx, signing])

  /* Escape closes a sheet first, then the browser. It never cancels a signature
     already in flight: the transaction may already be at the node. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (pendingTx) {
        if (signing) return
        if (txOutcome) setPendingTx(null)
        else declineTransfer()
        return
      }
      if (pending) {
        if (outcome) setPending(null)
        else deny('denied')
        return
      }
      requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pending, pendingTx, outcome, txOutcome, signing, declineTransfer, deny, requestClose])

  const anythingToShare = pending
    ? pending.request.fields.some((field) => hasField(profile, field))
    : false
  const showHint = hintDue && !hintDismissed && !frameSpoke && !everSpoke.current
  /* Networks with no public explorer show the id as text rather than
     pretending it resolves somewhere. */
  const explorerHref =
    txOutcome?.kind === 'submitted'
      ? explorerTxHref(transferContext?.networkId, txOutcome.txId)
      : null

  /* Portalled to <body>: the browser and its consent sheet are fixed overlays,
     and a host screen's stacking context (e.g. Home's entry animation with
     `fill-mode: both`) would otherwise trap them beneath the bottom nav,
     which then intercepts taps on the sheet's actions. */
  return createPortal(
    <div
      className={closing ? 'mnapps-browser mnapps-browser-closing' : 'mnapps-browser'}
      role="dialog"
      aria-modal="true"
      aria-label={`${shownName}, open inside Passport`}
    >
      <header className="mnapps-chrome">
        <button
          type="button"
          className="mnapps-chrome-button"
          onClick={requestClose}
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
              This app does not list a usable web address on a separate site, so
              Passport will not open it.
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
                            {/* Consent should show what is actually about to
                                leave, not only its category. The display name
                                is short and human, so it is quoted in full; the
                                addresses are set out in the app's own view
                                after sharing rather than dumped here. */}
                            {available && field === 'displayName' && profile?.displayName ? (
                              <em className="mnapps-field-value">{profile.displayName}</em>
                            ) : null}
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

      {pendingTx ? (
        <div className="mnapps-sheet-backdrop">
          <section
            className="mnapps-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mnapps-tx-title"
          >
            <header className="mnapps-sheet-head">
              <span className="mnapps-sheet-mark" aria-hidden="true">
                <ShieldCheck size={19} strokeWidth={2} />
              </span>
              <div>
                <p>Passport</p>
                <h2 id="mnapps-tx-title">
                  {txOutcome?.kind === 'submitted'
                    ? 'Transaction submitted.'
                    : txOutcome?.kind === 'declined'
                      ? 'Payment declined.'
                      : txOutcome?.kind === 'failed'
                        ? 'Nothing was sent.'
                        : signing
                          ? 'Signing and submitting…'
                          : `${shownName} is asking you to pay.`}
                </h2>
              </div>
            </header>

            {txOutcome ? (
              <div className="mnapps-sheet-outcome">
                {txOutcome.kind === 'submitted' ? (
                  <Check size={20} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <X size={20} strokeWidth={2.2} aria-hidden="true" />
                )}
                <p>
                  {txOutcome.kind === 'submitted' ? (
                    <>
                      Sent — {formatNight(pendingTx.amount)} NIGHT went out of your
                      account. The node accepted the transaction and returned its
                      identifier; the app has been told the same id.
                      <br />
                      <code className="mnapps-tx-hash">{txOutcome.txId}</code>
                      {explorerHref ? (
                        <>
                          <br />
                          <a
                            className="mnapps-tx-explorer"
                            href={explorerHref}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            View on the {transferContext?.networkId ?? ''} explorer
                            <ExternalLink size={13} strokeWidth={2.2} aria-hidden="true" />
                          </a>
                        </>
                      ) : null}
                    </>
                  ) : txOutcome.kind === 'declined' ? (
                    <>
                      Nothing was signed and nothing was sent. {pendingTx.origin} was told
                      you declined.
                    </>
                  ) : (
                    <>
                      Nothing was sent — no NIGHT moved from your account.{' '}
                      {txOutcome.message}
                    </>
                  )}
                </p>
                <button
                  type="button"
                  className="mnapps-sheet-done"
                  onClick={() => setPendingTx(null)}
                >
                  Back to the app
                </button>
              </div>
            ) : (
              <>
                <p className="mnapps-sheet-origin">
                  <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                  <code>{pendingTx.origin}</code>
                  <small>{transferContext?.networkId ?? 'unknown network'}</small>
                </p>

                <dl className="mnapps-tx-rows">
                  <div className="mnapps-tx-row mnapps-tx-row-amount">
                    <dt>Amount</dt>
                    <dd>
                      <strong>{formatNight(pendingTx.amount)} NIGHT</strong>
                      <small>{pendingTx.amount.toString()} atomic units</small>
                    </dd>
                  </div>
                  <div className="mnapps-tx-row">
                    <dt>Purpose</dt>
                    <dd>{pendingTx.request.intent.purpose}</dd>
                  </div>
                  <div className="mnapps-tx-row">
                    <dt>Recipient</dt>
                    <dd>
                      <button
                        type="button"
                        className="mnapps-tx-recipient"
                        onClick={() => setShowFullRecipient((shown) => !shown)}
                        aria-expanded={showFullRecipient}
                      >
                        <code>
                          {showFullRecipient
                            ? pendingTx.request.intent.recipientAddress
                            : shortAddress(pendingTx.request.intent.recipientAddress)}
                        </code>
                        <small>{showFullRecipient ? 'Hide' : 'Show full address'}</small>
                      </button>
                    </dd>
                  </div>
                  <div className="mnapps-tx-row">
                    <dt>Your account holds</dt>
                    <dd>{accountHoldsCopy(transferContext?.formattedBalance)}</dd>
                  </div>
                </dl>

                <p className="mnapps-sheet-boundary">
                  {txBoundaryCopy(transferContext?.networkId)}
                </p>

                <div className="mnapps-sheet-actions">
                  <button
                    type="button"
                    className="mnapps-button-ghost"
                    onClick={declineTransfer}
                    disabled={signing}
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    className="mnapps-button-solid"
                    onClick={() => void approveTransfer()}
                    disabled={signing}
                  >
                    {signing ? (
                      <>
                        <Loader2
                          className="mnapps-spinner"
                          size={15}
                          strokeWidth={2.2}
                          aria-hidden="true"
                        />
                        Signing and submitting…
                      </>
                    ) : (
                      <>
                        <PenLine size={15} strokeWidth={2.2} aria-hidden="true" />
                        Approve and sign
                      </>
                    )}
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
