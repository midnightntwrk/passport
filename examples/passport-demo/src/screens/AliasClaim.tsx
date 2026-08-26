import {
  ArrowRight,
  Sparkles,
  Check,
  CircleSlash,
  Loader2,
  Wifi,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  aliasDomain,
  normalizePassportAlias,
  type AliasAvailability,
  type AliasClaimProgress,
} from '../identity/midnames.js'
import { NETWORK_LABELS, type PassportNetwork } from './NetworkSwitcher.js'
import ThemeToggle from './ThemeToggle.js'
import './identity.css'

/**
 * Alias claiming — since 2026/08/06 the LAST onboarding screen before the
 * dashboard, and the default path rather than a detour. Claiming or skipping
 * both land on Home.
 *
 * A Passport alias IS a Midnames `.night` name, so everything on this
 * screen is a statement about the real registry:
 *
 *   - availability is `domains.member()` on the deployed `.night` TLD, probed
 *     live as the user types (debounced);
 *   - claiming deploys the account-custody contract if this Passport has none,
 *     then registers the name against it, and the transaction ids that come
 *     back are real.
 *
 * NO PRICE, AND NO BALANCE (2026/08/25). The registry's COST is paid by the
 * Passport service, from its own NIGHT — the user's wallet pays for nothing and
 * originates exactly one transaction in its life, the account deploy. So this
 * screen shows no price, reads no balance, and has no faucet link and no
 * not-enough-NIGHT panel: none of them describe anything that can happen here.
 *
 * When the registry cannot be reached, or Passport cannot register on the
 * network being shown, the screen says exactly that and offers to QUEUE the
 * name. A queued name is never shown as registered.
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
  /**
   * Human label for the network Passport's wallet DOES sign on, used in the
   * queue copy. Passed in rather than derived here so one sentence about where
   * names land cannot drift from the one the Home card shows.
   */
  signingNetworkLabel: string
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
  /**
   * Whether the Passport service will genuinely REGISTER this name — its own
   * `/status` reporting `aliasSponsorship: "available"` on this network, read
   * by the host and never assumed here.
   *
   * `undefined` (the default) and `false` keep the honest baseline: the name is
   * kept and registered when the service is back. Only a `true` the probe
   * actually produced may promise a registration, because the service is the
   * only thing that can make one — the wallet pays for nothing and there is no
   * self-paid claim behind this screen.
   *
   * Even a `true` is a prediction. A service can run out of NIGHT between the
   * probe and the call, and when it does the claim ends with the name queued
   * and the service's own sentence on the card — which is why nothing on this
   * screen reports a registration before one has happened.
   */
  nameSponsored?: boolean
}

type FieldState =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'checking'; alias: string }
  | { kind: 'answered'; alias: string; availability: AliasAvailability }

/**
 * What the button says at each stage, and why there are now seven of them.
 *
 * A reviewer clicked claim on the live site and watched one unchanging
 * sentence — "Deploying your name's resolver…" — for the whole stretch before
 * the passkey prompt appeared, which is a sentence about a step that had not
 * started yet. Three stages happen before that prompt (the registry re-check,
 * the sponsor's answer, and the ceremony), and each now says what it is.
 *
 * The account-contract stage says "Setting up your account". It used to name
 * the contract being deployed; that is the machinery, and a person waiting on
 * their Passport is owed the thing it is FOR.
 */
const PHASE_COPY: Record<AliasClaimProgress['phase'], (domain: string) => string> = {
  checking: (domain) => `Checking ${domain} is still free…`,
  preparing: () => 'Preparing your Passport…',
  'confirm-passkey': () => 'Confirm with your passkey',
  'attaching-account': () => 'Setting up your account…',
  'deploying-resolver': () => "Deploying your name's resolver…",
  registering: (domain) => `Registering ${domain}…`,
  confirming: () => 'Waiting for the registry to confirm…',
}

/**
 * The stages that run before the passkey prompt, so the panel below can say
 * "this takes a moment" while they do and "this takes minutes" afterwards.
 * Two different waits, and telling the user they are the same wait is how a
 * progress label becomes a spinner.
 */
const PRE_CEREMONY_PHASES = new Set<AliasClaimProgress['phase']>([
  'checking',
  'preparing',
  'confirm-passkey',
])

export default function AliasClaimScreen(props: AliasClaimProps) {
  const {
    networkId,
    walletReady,
    registrationSupported,
    signingNetworkLabel,
    checkAvailability,
    onClaim,
    onQueue,
    onSkip,
    claimPhase,
    error,
    nameSponsored,
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
  const availability = field.kind === 'answered' ? field.availability : null
  const isAvailable = availability?.status === 'available'
  const isUnreachable = availability?.status === 'unreachable'

  /**
   * What the panel promises, and it is the whole of what a claim does: the
   * service registers the name and pays for it. There is no balance to check
   * and no shortfall to warn about — the wallet pays for nothing, so an empty
   * one is not a wall in front of this screen and never was the user's problem.
   * With no sponsor the claim QUEUES; the host says so, and this screen simply
   * does not promise a registration nobody is going to make.
   */
  const sponsorRegisters = registrationSupported && isAvailable && nameSponsored === true

  const queueReasonForNetwork = `Passport signs and submits on ${signingNetworkLabel} only, so this name is reserved for you locally but is NOT registered on ${NETWORK_LABELS[networkId]}.`
  const queueReasonForRegistry = isUnreachable
    ? `The .night registry on ${NETWORK_LABELS[networkId]} could not be reached when the name was chosen: ${
        availability?.status === 'unreachable' ? availability.detail : 'no detail reported'
      }`
    : ''

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
    availability.status === 'taken'

  return (
    <section className="mnid-screen" aria-busy={busy}>
      <header className="mnid-bar">
        <img className="mnid-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        {/* No step counter since 2026/08/06: the name is the LAST thing
            before the dashboard, not step 2 of a three-screen wizard. */}
        <span className="mnid-step">Last step</span>
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
              This is the name people send to and apps recognise you by. Passport signs and
              submits on {signingNetworkLabel} only, so a name chosen for{' '}
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

        <AvailabilityLine field={field} networkId={networkId} />

        {/* WHILE IT RUNS, SAY SO. A claim is three proved transactions and
            genuinely takes minutes; a reviewer on 2026/08/26 asked for exactly
            this — "your passport is on their way, please be patient… you have
            to let the user know this will take time" — after watching a
            spinner that promised nothing. Two sentences, because the wait
            before the passkey prompt and the wait after it are not the same
            wait and must not be described as one. */}
        {busy && claimPhase ? (
          <div className="mnid-panel" role="status" aria-live="polite">
            <p className="mnid-panel-head">
              <Loader2 className="mnid-spin" size={15} aria-hidden="true" />
              {PHASE_COPY[claimPhase](aliasDomain(alias ?? 'your name'))}
            </p>
            <p>
              {PRE_CEREMONY_PHASES.has(claimPhase)
                ? 'Passport is checking the name is still free and that the service can register it, before it asks for your passkey. This takes a moment.'
                : 'Your Passport is on its way. This part takes a few minutes — three transactions are proved and submitted for you. You can leave this screen open; Passport will say when it is done.'}
            </p>
          </div>
        ) : null}

        {sponsorRegisters ? (
          <div className="mnid-panel" role="status">
            <p className="mnid-panel-head">
              <Sparkles size={15} aria-hidden="true" />
              Registered for you
            </p>
            {/* No price, no grant, no "your account is empty": the service
                registers the name and pays for it, and the user's balance is
                not part of the ceremony. The panel only says what will happen. */}
            <p>
              Press claim and Passport registers {aliasDomain(alias ?? '')} for you — the
              service pays for it, and you hold nothing. It usually takes a minute or two.
            </p>
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
          {/* No skip. The name step IS the account ceremony — the custody
              contract deploys and the name binds to it inside this one action,
              and Home without an account is not a state onboarding may end in
              (ruled 2026/08/24 after exactly that was seen live). `onSkip`
              remains for the HOST's escape hatches (network unsupported), not
              as a user choice on this screen. */}
        </div>

        <p className="mnid-foot">
          <Check size={13} aria-hidden="true" />
          <span>
            Names are 1–32 characters: lowercase letters, numbers, and hyphens inside. This is a
            real registration on the network
            {nameSponsored
              ? ', paid for by the Passport service — you hold nothing and spend nothing'
              : '; with no sponsor available right now the name is kept for you and registered when the service is back — nothing is ever spent from your Passport for it'}
            .
          </span>
        </p>
      </div>
    </section>
  )
}

function AvailabilityLine({
  field,
  networkId,
}: {
  field: FieldState
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
          {/* No price and no "more NIGHT needed": the service registers the
              name and pays for it, so the user's balance is not part of this
              screen at all. */}
          {aliasDomain(field.alias)} is available
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
