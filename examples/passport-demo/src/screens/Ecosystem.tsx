import { ArrowRight, ArrowUpRight, ExternalLink, Loader2, Sparkles, Tag } from 'lucide-react'

import type { AliasRecord } from '../identity/aliasStore.js'
import type { PassportIncentiveRecord } from '../identity/incentiveStore.js'
import { PREVIEW_EXPLORER_URL } from '../identity/midnames.js'
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
 * The status pill is load-bearing. A registered claim shows both real
 * transaction ids, linked to the explorer; a queued claim shows the sentence
 * explaining why it is not on chain. The two never look alike.
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
  registerNowPhase?: 'deploying-resolver' | 'registering' | 'confirming' | null
}

const REGISTER_PHASE_LABELS: Record<'deploying-resolver' | 'registering' | 'confirming', string> = {
  'deploying-resolver': 'Deploying resolver…',
  registering: 'Registering on-chain…',
  confirming: 'Confirming…',
}

function shortHash(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`
}

function explorerUrl(network: string, txId: string): string | null {
  // Only preview has a public explorer we can honestly link. Other networks
  // show the hash without pretending it resolves somewhere.
  //
  // The route is `/transactions/{hash}`; the `/tx/{hash}` this used to build
  // 404s, so the link was honest about existing and dishonest about working.
  return network === 'preview'
    ? `${PREVIEW_EXPLORER_URL}/transactions/${encodeURIComponent(txId)}`
    : null
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

        {record?.status === 'registered' ? (
          <ul className="mnid-txs">
            <TxRow
              label="Resolver deploy"
              txId={record.resolverDeployTxId}
              network={record.network}
            />
            <TxRow label="Registration" txId={record.registerTxId} network={record.network} />
          </ul>
        ) : null}

        {record?.status === 'registered' && record.registryConfirmed === false ? (
          <p className="mnid-reason">
            Both transactions were submitted and returned real ids. The registry had not yet
            reported the name when this view was written — reopen Passport to re-check.
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
                ? REGISTER_PHASE_LABELS[registerNowPhase ?? 'deploying-resolver']
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
    return <span className="mnid-pill mnid-pill-queued">Queued — not yet on-chain</span>
  }
  return <span className="mnid-pill mnid-pill-failed">Not registered</span>
}

function TxRow({
  label,
  txId,
  network,
}: {
  label: string
  txId: string | undefined
  network: string
}) {
  if (!txId) return null
  const url = explorerUrl(network, txId)
  return (
    <li className="mnid-tx">
      <span className="mnid-tx-label">{label}</span>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title={txId}>
          {shortHash(txId)}
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      ) : (
        <code title={txId}>{shortHash(txId)}</code>
      )}
    </li>
  )
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
            : 'Your passkey and wallet are ready. Claim a name whenever you like — apps will recognise it once you do.'}
        </p>

        <EcosystemIdentity {...props} variant="screen" />

        <div className="mnid-actions">
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
