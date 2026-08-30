import { ArrowRight, ArrowUpRight, Loader2, Sparkles, Tag } from 'lucide-react'

import type { AliasRecord } from '../identity/aliasStore.js'
import type { PassportIncentiveRecord } from '../identity/incentiveStore.js'
import { explorerTxUrl } from '../lib/networks.js'
import { NETWORK_LABELS, type PassportNetwork } from './NetworkSwitcher.js'
import ThemeToggle from './ThemeToggle.js'
import './identity.css'

/**
 * Ecosystem — what the user owns and what they have earned.
 *
 * Rendered twice: as the entry view immediately after onboarding
 * (`variant="screen"`), and as the identity card at the top of Home
 * (`variant="card"`).
 *
 * The status pill is load-bearing. A registered claim reads as registered; a
 * queued claim shows the sentence explaining why it is not registered yet. The
 * two never look alike, and a queued one is never called done.
 *
 * WHAT IS NOT HERE, AND WHY (ruled 2026/08/26)
 * -------------------------------------------
 * The two transaction rows — the resolver deploy and the registration — and the
 * resolver's own address were removed from this card. A reviewer looking at
 * their own name was shown two 64-character hexadecimal strings and the address
 * a name points at, none of which is a thing a person holds, checks, or acts
 * on: "we can hide all of that". The transactions still happened, are still
 * real, and are still linked from the activity trail, which is where a hash
 * belongs. What stays here is what the name IS and whether it works.
 */

export interface EcosystemProps {
  network: PassportNetwork
  /** The claim record for `network`, or null when no name is held there. */
  record: AliasRecord | null
  incentives: PassportIncentiveRecord[]
  variant?: 'screen' | 'card'
  /** Entry view only: continue into Passport. */
  onContinue?: () => void
  /** Offered when no name is held on this network. */
  onClaimName?: () => void
  /**
   * Re-runs the REAL claim path for a queued name — availability re-check,
   * funds re-check, then the two on-chain transactions. Rendered only on
   * queued records; omit (with no disabled reason) to hide the action.
   */
  onRegisterNow?: () => void
  /**
   * When set, "Register now" renders disabled with this sentence beneath it —
   * the honest reason the claim cannot run right now (wrong network, no
   * session, wallet still syncing).
   */
  registerNowDisabledReason?: string | null
  /** True while the re-run claim is in flight. */
  registerNowBusy?: boolean
  /** Live claim phase while the re-run is in flight. */
  registerNowPhase?: RegisterPhase | null
}

/** Every stage a re-run claim can narrate. Mirrors `AliasClaimProgress`. */
type RegisterPhase =
  | 'activating'
  | 'checking'
  | 'preparing'
  | 'confirm-passkey'
  | 'attaching-account'
  | 'deploying-resolver'
  | 'registering'
  | 'confirming'

/* The three pre-ceremony stages were added on 2026/08/26 alongside the claim
   screen's, for the same reason: the stretch before the passkey prompt used to
   be narrated by a label about a later step. "Setting up your account" replaces
   the contract's own name — the machinery is not what the user is waiting for. */
const REGISTER_PHASE_LABELS: Record<RegisterPhase, string> = {
  activating: 'Activating this Passport…',
  checking: 'Checking the name is still free…',
  preparing: 'Preparing your Passport…',
  'confirm-passkey': 'Confirm with your passkey',
  'attaching-account': 'Setting up your account…',
  'deploying-resolver': 'Setting your name up…',
  registering: 'Registering your name…',
  confirming: 'Confirming…',
}

function shortHash(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`
}

function explorerUrl(network: string, txId: string): string | null {
  // Networks with no public explorer show the hash without pretending it
  // resolves somewhere. The link needs the 32-byte ledger transaction hash —
  // an identifier dies with "not found". The per-network table and the route
  // shape live in lib/networks.ts.
  return explorerTxUrl(network, txId)
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

export function EcosystemIdentity(props: EcosystemProps) {
  const {
    network,
    record,
    incentives,
    variant = 'card',
    onClaimName,
    onRegisterNow,
    registerNowDisabledReason,
    registerNowBusy,
    registerNowPhase,
  } = props
  const embedded = variant === 'card'

  return (
    <>
      <article className={`mnid-card${embedded ? ' mnid-card-embedded' : ''}`}>
        <div className="mnid-card-head">
          <p className="mnid-kicker">Your name on {NETWORK_LABELS[network]}</p>
          {record ? <StatusPill record={record} network={network} /> : null}
        </div>

        {record ? (
          <p className="mnid-alias">{record.domain}</p>
        ) : (
          <p className="mnid-alias mnid-alias-muted">No name on this network yet</p>
        )}

        {/* WHAT THE NAME POINTS AT — stated for every registered record, and
            stated differently for the ones that predate the choice.

            A name claimed from 2026/08/19 points at this Passport's account.
            Names claimed before that point at an older part of this Passport,
            because that was the only path the code had; those records carry no
            `resolverTarget` at all and are NOT back-filled. Saying so plainly
            is the point: an older record is not broken, it is simply bound to a
            different thing.

            The address it points AT used to be printed here beside the
            sentence. It is gone (2026/08/26): the one address anybody needs is
            offered in Receive, as the thing you copy, and a hexadecimal string
            on a status card is not a fact a person can use. */}
        {record?.status === 'registered' ? (
          <p className="mnid-reason">
            {record.resolverTarget === 'contract'
              ? 'People sending to this name reach your account.'
              : record.resolverTarget === 'wallet'
                ? 'This name points at an older part of this Passport, not at your account.'
                : 'Claimed before names pointed at your account, so it reaches an older part of ' +
                  'this Passport instead.'}
          </p>
        ) : null}

        {record?.status === 'registered' && record.registryConfirmed === false ? (
          <p className="mnid-reason">
            Your name was submitted and accepted. It had not been reported back yet when this was
            written — reopen Passport to re-check.
          </p>
        ) : null}

        {record && record.status !== 'registered' ? (
          <p className="mnid-reason">{record.queuedReason}</p>
        ) : null}

        {record?.status === 'queued' && (onRegisterNow || registerNowDisabledReason) ? (
          <div className="mnid-panel-actions mnid-register-row">
            <button
              type="button"
              className="mnid-register"
              onClick={onRegisterNow}
              disabled={Boolean(registerNowBusy || registerNowDisabledReason || !onRegisterNow)}
            >
              {registerNowBusy ? (
                <Loader2 className="mnid-register-spinner" size={14} aria-hidden="true" />
              ) : (
                <ArrowUpRight size={14} aria-hidden="true" />
              )}
              {registerNowBusy
                ? /* The fallback is the FIRST stage, not a middle one: a busy
                     re-run with no phase reported yet has, by definition, only
                     just started. */
                  REGISTER_PHASE_LABELS[registerNowPhase ?? 'checking']
                : 'Register now'}
            </button>
            {registerNowDisabledReason ? (
              <p className="mnid-reason mnid-register-reason">{registerNowDisabledReason}</p>
            ) : null}
          </div>
        ) : null}

        {!record && onClaimName ? (
          <div className="mnid-panel-actions">
            <button type="button" className="mnid-link" onClick={onClaimName}>
              <Tag size={14} aria-hidden="true" />
              Choose a name
            </button>
          </div>
        ) : null}
      </article>

      {/* On Home the empty state is noise — the section appears there once
          something has genuinely been redeemed. The full ecosystem view always
          shows it, so the surface is never a mystery. */}
      {embedded && incentives.length === 0 ? null : (
      <section className="mnid-section" aria-label="Redeemed incentives">
        <div className="mnid-section-head">
          <p className="mnid-kicker">Redeemed incentives</p>
        </div>
        {incentives.length === 0 ? (
          <p className="mnid-empty">Nothing redeemed yet.</p>
        ) : (
          <ul className="mnid-list">
            {incentives.map((incentive) => {
              const url = incentive.txId ? explorerUrl(incentive.network, incentive.txId) : null
              return (
                <li key={incentive.id} className="mnid-item">
                  <span className="mnid-item-app">{incentive.app}</span>
                  <strong>{incentive.label}</strong>
                  <small>
                    {formatDate(incentive.redeemedAt)} · {incentive.network}
                    {incentive.txId ? ' · ' : ''}
                    {incentive.txId ? (
                      url ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          {shortHash(incentive.txId)}
                        </a>
                      ) : (
                        <code>{shortHash(incentive.txId)}</code>
                      )
                    ) : null}
                  </small>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      )}
    </>
  )
}

function StatusPill({ record, network }: { record: AliasRecord; network: PassportNetwork }) {
  if (record.status === 'registered') {
    return (
      <span className="mnid-pill mnid-pill-registered">
        Registered on {NETWORK_LABELS[network]}
      </span>
    )
  }
  if (record.status === 'queued') {
    /* "Queued" is the honest word and it stays. A name that is waiting is
       never shown as one that is done (ruled 2026/08/25). */
    return <span className="mnid-pill mnid-pill-queued">Queued — not registered yet</span>
  }
  return <span className="mnid-pill mnid-pill-failed">Not registered</span>
}

/** The full-screen entry view shown at the end of onboarding. */
export default function EcosystemScreen(props: EcosystemProps) {
  const { onContinue, record } = props
  return (
    <section className="mnid-screen">
      <header className="mnid-bar">
        <img className="mnid-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <span className="mnid-step">You&apos;re in</span>
        <ThemeToggle size="sm" className="mnid-theme" />
      </header>

      <div className="mnid-body">
        <p className="mnid-kicker">Welcome to Midnight</p>
        {/* The name itself belongs to the card below; the hero greets the
            person so the two are not the same sentence twice. */}
        <h1 className="mnid-title">
          {record ? `Welcome, ${record.alias}` : 'Your Passport is ready'}
        </h1>
        <p className="mnid-lede">
          {record
            ? 'Your name, its registration, and everything you redeem across the ecosystem live here.'
            : 'Your Passport is ready. Claim a name whenever you like — apps will recognise it once you do.'}
        </p>

        <EcosystemIdentity {...props} variant="screen" />

        <div className="mnid-actions" data-toast-clear>
          <button type="button" className="mnid-primary" onClick={onContinue}>
            <ArrowRight size={17} aria-hidden="true" />
            Enter Passport
          </button>
        </div>

        <p className="mnid-foot">
          <Sparkles size={13} aria-hidden="true" />
          <span>
            Registrations and redemptions shown here are read from the chain, or plainly
            labelled as queued when they are not on it yet.
          </span>
        </p>
      </div>
    </section>
  )
}
