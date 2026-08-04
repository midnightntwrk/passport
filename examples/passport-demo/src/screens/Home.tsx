import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Layers,
  LogOut,
  Plus,
  RefreshCw,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

import type { RecentTransaction } from '../lib/indexerTx'
import './home.css'

export interface HomeScreenProps {
  displayName: string | null
  /** Formatted NIGHT. `null` means unknown, `'0'` means a real zero. */
  unshieldedBalance: string | null
  shieldedTokenCount: number | null
  /** Formatted DUST. */
  dustBalance: string | null
  /** Formatted cap, may be null. */
  dustCap: string | null
  /** 0-100, `null` means unknown. */
  dustFillPercent: number | null
  dustSyncing: boolean
  balanceStatus: string
  unshieldedAddress: string | null
  shieldedAddress: string | null
  dustAddress: string | null
  transactions: RecentTransaction[]
  transactionsStatus: 'loading' | 'ready' | 'empty' | 'unavailable'
  /** Failure from any control on this screen — copy, DUST registration, refresh. */
  error?: string | null
  onDismissError?: () => void
  onRefresh: () => void
  onCopyAddress: (kind: 'unshielded' | 'shielded' | 'dust') => void
  onOpenTransaction: (hash: string) => void
  onRegisterDust: () => void
  onOpenClassic: () => void
  onSignOut: () => void
}

type AddressKind = 'unshielded' | 'shielded' | 'dust'

const RING_RADIUS = 34
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

const STAGE_LABELS: Record<string, string> = {
  SUCCESS: 'Success',
  PARTIAL_SUCCESS: 'Partial',
  FAILURE: 'Failed',
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

function truncateHash(hash: string): string {
  if (hash.length <= 18) return hash
  return `${hash.slice(0, 9)}...${hash.slice(-7)}`
}

function formatWhen(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null
  const parsed = Date.parse(timestamp)
  if (Number.isNaN(parsed)) return null
  const ageMs = Date.now() - parsed
  if (ageMs >= 0 && ageMs < 60_000) return 'Just now'
  if (ageMs >= 0 && ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)} min ago`
  if (ageMs >= 0 && ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)} h ago`
  return dateFormatter.format(new Date(parsed))
}

function stageLabel(applyStage: string | null | undefined): string | null {
  if (!applyStage) return null
  return STAGE_LABELS[applyStage] ?? applyStage.replace(/_/g, ' ').toLowerCase()
}

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

export default function HomeScreen(props: HomeScreenProps) {
  const {
    displayName,
    unshieldedBalance,
    shieldedTokenCount,
    dustBalance,
    dustCap,
    dustFillPercent,
    dustSyncing,
    balanceStatus,
    unshieldedAddress,
    shieldedAddress,
    dustAddress,
    transactions,
    transactionsStatus,
    error,
    onDismissError,
    onRefresh,
    onCopyAddress,
    onOpenTransaction,
    onRegisterDust,
    onOpenClassic,
    onSignOut,
  } = props

  const [copied, setCopied] = useState<AddressKind | null>(null)

  const handleCopy = useCallback(
    (kind: AddressKind) => {
      onCopyAddress(kind)
      setCopied(kind)
      window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1_600)
    },
    [onCopyAddress],
  )

  const balancesLoading = balanceStatus === 'loading'
  const fill = clampPercent(dustFillPercent)
  /* Registration is a real on-chain action, so it is only offered once the DUST
     state is genuinely known to be empty. While balances are loading or syncing,
     or when the balance call failed, `fill === null` means "unknown" — not
     "unregistered" — and nothing is offered. */
  const dustStateKnown = balanceStatus === 'ready' && !dustSyncing
  const needsDustRegistration = dustStateKnown && (fill === null || fill === 0)

  const ringDash = useMemo(() => {
    const shown = fill ?? 0
    const filled = (shown / 100) * RING_CIRCUMFERENCE
    return `${filled} ${RING_CIRCUMFERENCE - filled}`
  }, [fill])

  const addressRows: { kind: AddressKind; label: string; value: string | null }[] = [
    { kind: 'unshielded', label: 'Unshielded', value: unshieldedAddress },
    { kind: 'shielded', label: 'Shielded', value: shieldedAddress },
    { kind: 'dust', label: 'DUST', value: dustAddress },
  ]

  return (
    <section className="mnhome-screen" aria-busy={balancesLoading || transactionsStatus === 'loading'}>
      <header className="mnhome-bar">
        <img className="mnhome-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <div className="mnhome-bar-actions">
          <button
            type="button"
            className="mnhome-icon-button"
            onClick={onRefresh}
            aria-label="Refresh balances and transactions"
            title="Refresh"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="mnhome-icon-button"
            onClick={onSignOut}
            aria-label="Sign out of this Passport"
            title="Sign out"
          >
            <LogOut size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="mnhome-body">
        <div className="mnhome-identity">
          <p className="mnhome-kicker">Passport</p>
          <h1 className="mnhome-name">{displayName ?? 'Your Passport'}</h1>
        </div>

        {error ? (
          <p className="mnhome-notice" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{error}</span>
            {onDismissError ? (
              <button
                type="button"
                className="mnhome-icon-button mnhome-notice-dismiss"
                onClick={onDismissError}
                aria-label="Dismiss error"
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </p>
        ) : null}

        <div className="mnhome-assets">
          <BalanceCard
            icon={<Layers size={14} aria-hidden="true" />}
            label="Shielded"
            value={
              shieldedTokenCount === null
                ? null
                : `${shieldedTokenCount}`
            }
            unit={shieldedTokenCount === 1 ? 'token type' : 'token types'}
            loading={balancesLoading}
          />
          <BalanceCard
            icon={<Wallet size={14} aria-hidden="true" />}
            label="Unshielded"
            value={unshieldedBalance}
            unit="NIGHT"
            loading={balancesLoading}
          />

          <article className="mnhome-dust">
            <div className={`mnhome-battery${dustSyncing ? ' mnhome-battery-charging' : ''}`}>
              <svg viewBox="0 0 80 80" role="img" aria-label={fill === null ? 'DUST charge unknown' : `DUST charge ${Math.round(fill)} per cent`}>
                <circle className="mnhome-battery-track" cx="40" cy="40" r={RING_RADIUS} />
                <circle
                  className="mnhome-battery-fill"
                  cx="40"
                  cy="40"
                  r={RING_RADIUS}
                  strokeDasharray={ringDash}
                  strokeDashoffset="0"
                />
              </svg>
              <span className="mnhome-battery-value">
                {fill === null ? '—' : `${Math.round(fill)}%`}
              </span>
            </div>

            <div className="mnhome-dust-copy">
              <p className="mnhome-micro">DUST battery</p>
              <p className={`mnhome-dust-balance${dustBalance === null ? ' mnhome-dust-balance-muted' : ''}`}>
                {dustBalance === null ? (
                  balancesLoading ? 'Syncing' : 'Unavailable'
                ) : (
                  <>
                    {dustBalance}
                    <span>DUST</span>
                  </>
                )}
              </p>
              <p className="mnhome-dust-cap">
                {dustCap ? `Cap ${dustCap}` : 'Cap not reported'}
                {dustSyncing ? ' · charging' : ''}
              </p>
              {needsDustRegistration ? (
                <button type="button" className="mnhome-ghost" onClick={onRegisterDust}>
                  <Plus size={13} aria-hidden="true" />
                  <span>Register DUST</span>
                </button>
              ) : null}
            </div>
          </article>
        </div>

        {balanceStatus === 'unavailable' ? (
          <p className="mnhome-notice">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>Balances are unavailable. Pull a refresh once the wallet reconnects.</span>
          </p>
        ) : null}

        <ul className="mnhome-addresses">
          {addressRows.map((row) => (
            <li key={row.kind} className="mnhome-address">
              <span className="mnhome-address-label">{row.label}</span>
              <code className="mnhome-address-value">
                {row.value ? truncateHash(row.value) : 'Not available'}
              </code>
              <button
                type="button"
                className="mnhome-icon-button"
                onClick={() => handleCopy(row.kind)}
                disabled={!row.value}
                aria-label={`Copy ${row.label.toLowerCase()} address`}
              >
                {copied === row.kind ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>

        <section className="mnhome-panel" aria-label="Recent transactions">
          <div className="mnhome-panel-head">
            <h2 className="mnhome-micro">Recent transactions</h2>
            <button
              type="button"
              className="mnhome-panel-refresh"
              onClick={onRefresh}
              disabled={transactionsStatus === 'loading'}
            >
              <RefreshCw size={13} aria-hidden="true" />
              <span>Refresh</span>
            </button>
          </div>

          {transactionsStatus === 'loading' && transactions.length === 0 ? (
            <>
              <p className="mnhome-sr">Loading recent transactions.</p>
              <ul className="mnhome-rows" aria-hidden="true">
                {[0, 1, 2, 3].map((index) => (
                  <li key={index} className="mnhome-row mnhome-row-skeleton">
                    <span className="mnhome-skeleton mnhome-skeleton-hash" />
                    <span className="mnhome-skeleton mnhome-skeleton-meta" />
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {transactions.length === 0 &&
          (transactionsStatus === 'empty' || transactionsStatus === 'ready') ? (
            <p className="mnhome-empty">No transactions yet on this account</p>
          ) : null}

          {transactionsStatus === 'unavailable' ? (
            <div className="mnhome-empty mnhome-empty-error">
              <p>
                <AlertTriangle size={14} aria-hidden="true" />
                {/* True whether the indexer was unreachable or could only
                    answer chain-wide — either way this account's own history
                    is not being shown. */}
                <span>Account history unavailable</span>
              </p>
              <button type="button" className="mnhome-ghost" onClick={onRefresh}>
                <RefreshCw size={13} aria-hidden="true" />
                <span>Try again</span>
              </button>
            </div>
          ) : null}

          {/* Rows the app already holds stay visible even while the indexer is
              unreachable — the notice above says the history may be incomplete. */}
          {transactions.length > 0 ? (
            <ul className="mnhome-rows">
              {transactions.map((transaction, index) => {
                const stage = stageLabel(transaction.applyStage)
                const when = formatWhen(transaction.timestamp)
                return (
                  <li key={`${transaction.hash}-${index}`}>
                    <button
                      type="button"
                      className={`mnhome-row${transaction.involvesUser ? ' mnhome-row-mine' : ''}`}
                      onClick={() => onOpenTransaction(transaction.hash)}
                    >
                      <span className="mnhome-row-top">
                        <code className="mnhome-row-hash">{truncateHash(transaction.hash)}</code>
                        <ArrowRight size={14} aria-hidden="true" className="mnhome-row-arrow" />
                      </span>
                      <span className="mnhome-row-meta">
                        {transaction.kind ? <span className="mnhome-pill">{transaction.kind}</span> : null}
                        {stage ? (
                          <span
                            className={`mnhome-pill${transaction.applyStage === 'FAILURE' ? ' mnhome-pill-hollow' : ''}`}
                          >
                            {stage}
                          </span>
                        ) : null}
                        {typeof transaction.blockHeight === 'number' ? (
                          <span className="mnhome-row-block">#{transaction.blockHeight}</span>
                        ) : null}
                        {when ? <span className="mnhome-row-when">{when}</span> : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </section>

        <button type="button" className="mnhome-classic" onClick={onOpenClassic}>
          <span>Open full dashboard</span>
          <ExternalLink size={14} aria-hidden="true" />
        </button>

        <p className="mnhome-foot">
          <Zap size={12} aria-hidden="true" />
          <span>Midnight preview · balances and history read live from the indexer</span>
        </p>
      </div>
    </section>
  )
}

interface BalanceCardProps {
  icon: ReactNode
  label: string
  value: string | null
  unit: string
  loading: boolean
}

function BalanceCard(props: BalanceCardProps) {
  const { icon, label, value, unit, loading } = props
  const unknown = value === null
  return (
    <article className="mnhome-card">
      <p className="mnhome-card-head">
        {icon}
        <span className="mnhome-micro">{label}</span>
      </p>
      <p className={`mnhome-card-value${unknown ? ' mnhome-card-value-muted' : ''}`}>
        {unknown ? (loading ? 'Syncing' : 'Unavailable') : value}
      </p>
      <p className="mnhome-card-unit">{unknown ? ' ' : unit}</p>
    </article>
  )
}
