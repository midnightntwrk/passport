import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleSlash,
  ExternalLink,
  Loader2,
  Wifi,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  aliasCostAtomicNight,
  aliasDomain,
  formatNight,
  normalizePassportAlias,
  PREVIEW_FAUCET_URL,
  type AliasAvailability,
  type AliasClaimProgress,
} from '../identity/midnames.js'
import { NETWORK_LABELS, type PassportNetwork } from './NetworkSwitcher.js'
import ThemeToggle from './ThemeToggle.js'
import './identity.css'

/**
 * Alias claiming — onboarding step 2, and the default path rather than a
 * detour. A Passport alias IS a Midnames `.night` name, so everything on this
 * screen is a statement about the real registry:
 *
 *   - availability is `domains.member()` on the deployed `.night` TLD, probed
 *     live as the user types (debounced);
 *   - the cost shown is the deployed contract's own COST_SHORT / COST_MED /
 *     COST_LONG for the length typed;
 *   - claiming deploys a resolver and calls `register_domain_for`, and the two
 *     transaction ids that come back are real.
 *
 * When the registry cannot be reached, or the wallet cannot pay, the screen
 * says exactly that and offers to QUEUE the name. A queued name is never shown
 * as registered.
 */

const DEBOUNCE_MS = 500

export interface AliasClaimProps {
  /** Which network the name is being claimed on. */
  networkId: PassportNetwork
  /** False while the wallet is still opening — claiming needs it. */
  walletReady: boolean
  /**
   * Whether Passport can genuinely register on `networkId` — that is, whether
   * the open wallet signs and submits there. False turns the screen into an
   * honest queue: the copy says so, and the button reads "Queue name". Additive
   * to the contract's prop list, because a wrong "this is a real registration"
   * sentence would be exactly the kind of claim this work is meant to remove.
   */
  registrationSupported: boolean
  /** Formatted NIGHT, as the wallet surfaces report it. `null` = unknown. */
  nightBalance: string | null
  checkAvailability: (alias: string) => Promise<AliasAvailability>
  /** Runs the REAL claim. Rejects with a message the caller has already shown. */
  onClaim: (alias: string) => Promise<void>
  /**
   * Records the name as queued, with the reason it is queued. Additive to the
   * contract's prop list: criterion 4 needs a queue action distinct from skip,
   * and the honest panels below all end in one.
   */
  onQueue: (alias: string, reason: string) => Promise<void>
  onSkip: () => void
  claimPhase: AliasClaimProgress['phase'] | null
  error: string | null
}

type FieldState =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'checking'; alias: string }
  | { kind: 'answered'; alias: string; availability: AliasAvailability }

/** Parses a formatted NIGHT figure back to atomic units, exactly. */
function atomicNightFrom(formatted: string | null): bigint | null {
  if (formatted === null) return null
  const cleaned = formatted.replace(/[\s,]/g, '')
  if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === '' || cleaned === '.') return null
  const [whole, fraction = ''] = cleaned.split('.')
  const padded = `${fraction}000000`.slice(0, 6)
  return BigInt(whole || '0') * 1_000_000n + BigInt(padded || '0')
}

const PHASE_COPY: Record<AliasClaimProgress['phase'], (domain: string) => string> = {
  'deploying-resolver': () => "Deploying your name's resolver…",
  registering: (domain) => `Registering ${domain}…`,
  confirming: () => 'Waiting for the registry to confirm…',
}

export default function AliasClaimScreen(props: AliasClaimProps) {
  const {
    networkId,
    walletReady,
    registrationSupported,
    nightBalance,
    checkAvailability,
    onClaim,
    onQueue,
    onSkip,
    claimPhase,
    error,
  } = props

  const [value, setValue] = useState('')
  const [field, setField] = useState<FieldState>({ kind: 'empty' })
  const probe = useRef(0)

  const busy = claimPhase !== null

  useEffect(() => {
    const raw = value.trim()
    if (!raw) {
      setField({ kind: 'empty' })
      return undefined
    }
    let alias: string
    try {
      alias = normalizePassportAlias(raw)
    } catch (cause) {
      setField({ kind: 'invalid', message: cause instanceof Error ? cause.message : String(cause) })
      return undefined
    }
    setField({ kind: 'checking', alias })
    const token = probe.current + 1
    probe.current = token
    const timer = window.setTimeout(() => {
      void checkAvailability(alias).then(
        (availability) => {
          if (probe.current !== token) return
          setField({ kind: 'answered', alias, availability })
        },
        (cause: unknown) => {
          if (probe.current !== token) return
          setField({
            kind: 'answered',
            alias,
            availability: {
              status: 'unreachable',
              detail: cause instanceof Error ? cause.message : String(cause),
            },
          })
        },
      )
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [checkAvailability, value])

  const alias = field.kind === 'checking' || field.kind === 'answered' ? field.alias : null
  const cost = useMemo(() => (alias ? aliasCostAtomicNight(alias) : null), [alias])
  const heldAtomic = atomicNightFrom(nightBalance)
  const canPay = cost === null || heldAtomic === null ? null : heldAtomic >= cost
  const availability = field.kind === 'answered' ? field.availability : null
  const isAvailable = availability?.status === 'available'
  const isUnreachable = availability?.status === 'unreachable'
  // No payment is attempted where Passport cannot register, so the funding
  // panel would be answering a question nobody asked.
  const shortOfNight = registrationSupported && isAvailable && canPay === false

  const queueReasonForNetwork = `Passport's wallet signs and submits on preview only today, so this name is reserved for you locally but is NOT registered on ${NETWORK_LABELS[networkId]}.`
  const queueReasonForRegistry = isUnreachable
    ? `The .night registry on ${NETWORK_LABELS[networkId]} could not be reached when the name was chosen: ${
        availability?.status === 'unreachable' ? availability.detail : 'no detail reported'
      }`
    : ''
  const queueReasonForFunds =
    'Wallet has no NIGHT to pay the registration fee — visit the faucet, then claim the name.'

  const handleSubmit = useCallback(() => {
    if (!alias || busy) return
    if (isUnreachable) {
      void onQueue(alias, queueReasonForRegistry)
      return
    }
    if (!registrationSupported) {
      void onQueue(alias, queueReasonForNetwork)
      return
    }
    if (shortOfNight) {
      void onQueue(alias, queueReasonForFunds)
      return
    }
    void onClaim(alias)
  }, [
    alias,
    busy,
    isUnreachable,
    onClaim,
    onQueue,
    queueReasonForNetwork,
    queueReasonForRegistry,
    registrationSupported,
    shortOfNight,
  ])

  const primaryLabel = busy
    ? PHASE_COPY[claimPhase](aliasDomain(alias ?? 'your name'))
    : isUnreachable || !registrationSupported
      ? 'Queue name'
      : alias
        ? `Claim ${aliasDomain(alias)}`
        : 'Claim your name'

  const primaryDisabled =
    busy ||
    !walletReady ||
    alias === null ||
    availability === null ||
    availability.status === 'taken' ||
    shortOfNight

  return (
    <section className="mnid-screen" aria-busy={busy}>
      <header className="mnid-bar">
        <img className="mnid-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <span className="mnid-step">Step 2 of 3</span>
        <ThemeToggle size="sm" className="mnid-theme" />
      </header>

      <div className="mnid-body">
        <p className="mnid-kicker">Your Midnight name</p>
        <h1 className="mnid-title">Choose your .night name</h1>
        <p className="mnid-lede">
          {registrationSupported ? (
            <>
              This is the name people send to and apps recognise you by. It is a real Midnames
              registration on {NETWORK_LABELS[networkId]} — one name per network, held by this
              passkey.
            </>
          ) : (
            <>
              This is the name people send to and apps recognise you by. Passport&apos;s wallet
              signs and submits on preview only today, so a name chosen for{' '}
              {NETWORK_LABELS[networkId]} is queued here rather than registered — and Passport says
              so wherever it appears.
            </>
          )}
        </p>

        <div
          className={`mnid-field${field.kind === 'invalid' ? ' mnid-field-invalid' : ''}`}
        >
          <input
            type="text"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="yourname"
            aria-label="Your Midnight name"
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !primaryDisabled) handleSubmit()
            }}
          />
          <span className="mnid-suffix">.night</span>
        </div>

        <AvailabilityLine
          field={field}
          cost={cost}
          canPay={canPay}
          networkId={networkId}
        />

        {shortOfNight ? (
          <div className="mnid-panel" role="status">
            <p className="mnid-panel-head">
              <AlertTriangle size={15} aria-hidden="true" />
              Not enough NIGHT to register yet
            </p>
            <p>
              {aliasDomain(alias ?? '')} costs{' '}
              <span className="mnid-cost">{formatNight(cost ?? 0n)}</span> NIGHT, paid to the
              registry owner. This wallet holds{' '}
              {nightBalance === null ? (
                'an unknown amount'
              ) : (
                <>
                  <span className="mnid-cost">{nightBalance}</span> NIGHT
                </>
              )}
              . Top it up
              from the {NETWORK_LABELS[networkId]} faucet — it needs a captcha, so it opens in a
              new tab — then come back and claim.
            </p>
            <div className="mnid-panel-actions">
              <a
                className="mnid-link"
                href={PREVIEW_FAUCET_URL}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} aria-hidden="true" />
                Open the faucet
              </a>
              <button
                type="button"
                className="mnid-link"
                disabled={busy}
                onClick={() => alias && void onQueue(alias, queueReasonForFunds)}
              >
                Queue name instead
              </button>
            </div>
          </div>
        ) : null}

        {isUnreachable ? (
          <div className="mnid-panel" role="status">
            <p className="mnid-panel-head">
              <Wifi size={15} aria-hidden="true" />
              The registry cannot be reached right now
            </p>
            <p>
              Your name will be queued. Passport keeps it against{' '}
              {NETWORK_LABELS[networkId]} and shows it as queued — never as registered — until a
              real registration succeeds.
            </p>
            <code>
              {availability?.status === 'unreachable' ? availability.detail : ''}
            </code>
          </div>
        ) : null}

        {error ? (
          <div className="mnid-panel" role="alert">
            <p className="mnid-panel-head">
              <CircleSlash size={15} aria-hidden="true" />
              The claim did not complete
            </p>
            <p>{error}</p>
          </div>
        ) : null}

        <div className="mnid-actions">
          <button
            type="button"
            className="mnid-primary"
            onClick={handleSubmit}
            disabled={primaryDisabled}
          >
            {busy ? (
              <Loader2 className="mnid-spin" size={17} aria-hidden="true" />
            ) : (
              <ArrowRight size={17} aria-hidden="true" />
            )}
            {primaryLabel}
          </button>
          <button type="button" className="mnid-secondary" onClick={onSkip} disabled={busy}>
            Choose a name later
          </button>
        </div>

        <p className="mnid-foot">
          <Check size={13} aria-hidden="true" />
          <span>
            Names are 1–32 characters: lowercase letters, numbers, and hyphens inside. A real
            registration pays the registry owner in unshielded NIGHT and its fee in DUST, both from
            this wallet — which is why Passport only performs one where it can.
          </span>
        </p>
      </div>
    </section>
  )
}

function AvailabilityLine({
  field,
  cost,
  canPay,
  networkId,
}: {
  field: FieldState
  cost: bigint | null
  canPay: boolean | null
  networkId: PassportNetwork
}) {
  if (field.kind === 'empty') {
    return (
      <p className="mnid-status mnid-status-checking">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>Type a name to see whether it is free on {NETWORK_LABELS[networkId]}.</span>
      </p>
    )
  }
  if (field.kind === 'invalid') {
    return (
      <p className="mnid-status mnid-status-error" role="alert">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>{field.message}</span>
      </p>
    )
  }
  if (field.kind === 'checking') {
    return (
      <p className="mnid-status mnid-status-checking" role="status">
        <Loader2 className="mnid-spin" size={13} aria-hidden="true" />
        <span>Checking the registry…</span>
      </p>
    )
  }
  if (field.availability.status === 'available') {
    return (
      <p className="mnid-status mnid-status-available" role="status">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>
          {aliasDomain(field.alias)} is available ·{' '}
          <span className="mnid-cost">{formatNight(cost ?? 0n)}</span> NIGHT
          {canPay === false ? ' · more NIGHT needed' : ''}
        </span>
      </p>
    )
  }
  if (field.availability.status === 'taken') {
    return (
      <p className="mnid-status mnid-status-taken" role="status">
        <span className="mnid-status-dot" aria-hidden="true" />
        <span>
          {aliasDomain(field.alias)} is already taken on {NETWORK_LABELS[networkId]}. Its resolver
          is {field.availability.resolverAddress.slice(0, 10)}…
        </span>
      </p>
    )
  }
  return (
    <p className="mnid-status mnid-status-error" role="status">
      <span className="mnid-status-dot" aria-hidden="true" />
      <span>The registry cannot be reached right now; your name will be queued.</span>
    </p>
  )
}
