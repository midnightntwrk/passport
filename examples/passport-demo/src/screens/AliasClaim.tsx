import {
  ArrowRight,
  Check,
  CircleSlash,
  Loader2,
  Sparkles,
  Wifi,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  aliasDomain,
  normalizePassportAlias,
  type AliasAvailability,
  type AliasClaimProgress,
} from '../identity/midnames.js'
import { claimSteps } from '../lib/claimSteps.js'
import { NETWORK_LABELS, type PassportNetwork } from './NetworkSwitcher.js'
import { PasskeyWayOutActions } from './PasskeyWayOut.js'
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
   * True when {@link AliasClaimProps.error} is a PASSKEY ceremony that could
   * not be completed, rather than anything about the name or the registry.
   *
   * It changes what the failure card carries, not what it says: the sentence
   * is still the host's, and beneath it go the two controls
   * {@link PasskeyWayOutActions} defines. The host decides, because only the
   * host saw the failure — see `lib/passkeyRecovery.ts` for the rule.
   *
   * This screen is the one that needed it most. Its header is the wordmark,
   * "Last step", and the theme toggle: there is NO sign-out on it, so before
   * this a user whose passkey the browser could not use read one line of error
   * text and had nowhere at all to go (reported with a screenshot,
   * 2026/08/31).
   */
  errorIsPasskeyWayOut?: boolean
  /**
   * Leaves the session for the landing screen. Required for the way out above
   * to be offered at all — a panel that named a control this screen could not
   * perform would be the same dead end with more words on it.
   */
  onSignOut?: () => void
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
 *
 * The stage after it now says "Setting your name up…" for the same reason, and
 * in the same words `Ecosystem.tsx` already used for that phase. The sentence
 * it replaces — "Deploying your name's resolver…" — survived the 2026/08/26
 * pass because the pass renamed the phases around it, and it was still on the
 * live site during a real claim: "resolver" is a thing inside the registry,
 * not a thing that is happening to the reader.
 */
const PHASE_COPY: Record<AliasClaimProgress['phase'], (domain: string) => string> = {
  checking: (domain) => `Checking ${domain} is still free…`,
  preparing: () => 'Preparing your Passport…',
  'confirm-passkey': () => 'Confirm with your passkey',
  'attaching-account': () => 'Setting up your account…',
  'deploying-resolver': () => 'Setting your name up…',
  registering: (domain) => `Registering ${domain}…`,
  confirming: () => 'Confirming your name…',
}

/**
 * What the third step says underneath itself, from the moment the claim
 * starts rather than when the wait begins.
 *
 * The reviewer's ask on 2026/08/26 was "your passport is on its way, please be
 * patient… you have to let the user know this will take time" — and a warning
 * about a wait is worth most before it starts. It names no transaction count:
 * how many proofs are involved is machinery, and "a few minutes" is the whole
 * of what a person can act on.
 */
const LONG_WAIT_NOTE = 'Your Passport is on its way. This part takes a few minutes.'

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
    errorIsPasskeyWayOut,
    onSignOut,
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
    ? `Passport could not check names on ${NETWORK_LABELS[networkId]} when this one was chosen: ${
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

  /**
   * What the button says while a claim runs, and why it is no longer the
   * phase's own sentence.
   *
   * It used to repeat, with a spinner beside it, exactly the sentence already
   * printed under the running step: two spinners' worth of movement and one
   * fact, said twice. The STEPPER is the progress indicator now — it shows
   * which of the three is running, what that step is doing, and what is still
   * ahead — so the button says only which step is running, and says it once.
   *
   * `busy` is `claimPhase !== null`, so wherever this branch is taken the
   * stepper above is on screen and there is always an active step to name.
   */
  const runningStep = busy ? claimSteps(claimPhase).find((step) => step.state === 'active') : null
  const primaryLabel = busy
    ? (runningStep?.label ?? PHASE_COPY[claimPhase](aliasDomain(alias ?? 'your name')))
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

        {/* WHILE IT RUNS, SHOW WHERE IT IS. What stood here was a spinner and
            one sentence, and a reviewer on 2026/08/26 could not tell a slow
            network from a hung app: "no infinite spinner". What was promised
            in reply, the same afternoon, was this — three steps, circle and
            line, the finished ones ticked and the one running now alive.

            The seven phases the claim reports are folded into the three by
            `../lib/claimSteps.ts`, which is where that rule lives and is
            drilled. The phase's own words are still said, as the running
            step's detail line: "Registering alice.night…" is a sub-state of
            setting the account up, not a fourth circle. */}
        {busy && claimPhase ? (
          <div className="mnid-panel" role="status" aria-live="polite">
            <ol className="mnid-stepper">
              {claimSteps(claimPhase).map((step) => (
                <li key={step.id} className="mnid-stepper-item" data-state={step.state}>
                  {/* Both marks are always in the DOM and the state chooses
                      which is painted, so a step never changes shape as it
                      completes — it only fills in. */}
                  <span className="mnid-stepper-mark" aria-hidden="true">
                    <span className="mnid-stepper-dot" />
                    <Check className="mnid-stepper-check" size={13} strokeWidth={3} />
                  </span>
                  <span className="mnid-stepper-text">
                    <span className="mnid-stepper-label">{step.label}</span>
                    {step.state === 'active' ? (
                      <span className="mnid-stepper-detail">
                        {PHASE_COPY[claimPhase](aliasDomain(alias ?? 'your name'))}
                      </span>
                    ) : null}
                    {step.id === 'account' ? (
                      <span className="mnid-stepper-note">{LONG_WAIT_NOTE}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {/* The promise, until it is being kept. "Press claim" is advice about a
            button the user has already pressed, so it stands down the moment a
            claim is running and the stepper above says where it has got to. */}
        {sponsorRegisters && !busy ? (
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
              Names cannot be checked right now
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
            {/* THE CARD THAT HAD NOTHING ON IT.
                A passkey failure here used to end at the line above, on a
                screen with no sign-out anywhere — so the only exits were the
                browser's back button and closing the tab. Both controls go in
                THIS card rather than in a toast: the card is where the user is
                already reading, and a toast that carried the only way out of a
                dead end would take it away again after five seconds. */}
            {errorIsPasskeyWayOut && onSignOut ? (
              <PasskeyWayOutActions
                onRetry={handleSubmit}
                onSignOut={onSignOut}
                busy={busy}
              />
            ) : null}
          </div>
        ) : null}

        <div className="mnid-actions" data-toast-clear>
          <button
            type="button"
            className="mnid-primary"
            onClick={handleSubmit}
            disabled={primaryDisabled}
          >
            {/* NO SPINNER while the stepper is up. A second spinner over a
                view whose whole job is to show where the claim has got to adds
                movement and no information — and it was what made the button
                read as the progress indicator rather than as the control that
                had already been pressed. */}
            {busy ? null : <ArrowRight size={17} aria-hidden="true" />}
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
        <span>Checking that name…</span>
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
      <span>Names cannot be checked right now; your name will be queued.</span>
    </p>
  )
}
