import {
  AlertTriangle,
  Droplets,
  Check,
  Copy,
  ExternalLink,
  Layers,
  LogOut,
  Plus,
  RefreshCw,
  Send,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { AliasRecord } from '../identity/aliasStore.js'
import type { PassportIncentiveRecord } from '../identity/incentiveStore.js'
import { FeaturedApps, type AppsScreenProps, type FeaturedAppsProps } from './Apps.js'
import { EcosystemIdentity } from './Ecosystem.js'
import NetworkSwitcher, { type PassportNetwork } from './NetworkSwitcher.js'
import SyncRing from './SyncRing.js'
import ThemeToggle from './ThemeToggle.js'
import './home.css'

export interface HomeScreenProps {
  displayName: string | null
  /**
   * The `.night` name held on the active network, without its suffix. When set
   * the greeting reads "Good morning, alice"; when null it falls back to the
   * previous greeting-plus-displayName behaviour.
   */
  aliasLabel?: string | null
  /**
   * The ecosystem identity card: the name held on this network with its status,
   * its real transaction ids, and everything redeemed. Omit to hide the card.
   */
  identity?: {
    record: AliasRecord | null
    incentives: PassportIncentiveRecord[]
    onClaimName?: () => void
    /** Re-runs the real claim for a queued name. See EcosystemProps. */
    onRegisterNow?: () => void
    registerNowDisabledReason?: string | null
    registerNowBusy?: boolean
    registerNowPhase?: 'deploying-resolver' | 'registering' | 'confirming' | null
  } | null
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
  /**
   * Live wallet sync progress, 0–100, when the wallet source reports one
   * (the on-device wallet does; Dynamic does not). null = no figure known.
   */
  syncPercent?: number | null
  /** Selected network context; filters the app grid, does not move the wallet. */
  network: PassportNetwork
  onSelectNetwork: (network: PassportNetwork) => void
  balanceStatus: string
  unshieldedAddress: string | null
  shieldedAddress: string | null
  dustAddress: string | null
  /** Failure from any control on this screen — copy, DUST registration, refresh. */
  error?: string | null
  onDismissError?: () => void
  onRefresh: () => void
  onCopyAddress: (kind: 'unshielded' | 'shielded' | 'dust') => void
  onRegisterDust: () => void
  /**
   * Set when DUST registration genuinely cannot run for the active wallet.
   * The control is disabled and this sentence is shown in its place — the
   * button is never left live to fail silently.
   */
  registerDustDisabledReason?: string | null
  /** Replaces the footer line, so the screen names where its figures came from. */
  walletSourceNote?: string | null
  /** Fed to the embedded apps grid and its in-Passport browser. */
  appsProfile: AppsScreenProps['profile']
  /** Notified after the user approves a profile request, for the activity feed. */
  onProfileShared?: (appName: string, fields: string[]) => void
  /** The wallet seam the embedded apps grid hands to its in-Passport browser. */
  executeTransfer?: FeaturedAppsProps['executeTransfer']
  transferContext?: FeaturedAppsProps['transferContext']
  onIncentiveRedeemed?: FeaturedAppsProps['onIncentiveRedeemed']
  /**
   * Telegram support channel. When set, an outlined "Support on Telegram"
   * pill renders in the footer area; when null, no support link is shown.
   */
  supportUrl?: string | null
  onOpenClassic: () => void
  onSignOut: () => void
}

type AddressKind = 'unshielded' | 'shielded' | 'dust'

const RING_RADIUS = 34
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function truncateHash(hash: string): string {
  if (hash.length <= 18) return hash
  return `${hash.slice(0, 9)}...${hash.slice(-7)}`
}

/** Date-based time-of-day greeting — no libraries, no locale surprises. */
function timeOfDayGreeting(date = new Date()): string {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

export default function HomeScreen(props: HomeScreenProps) {
  const {
    displayName,
    aliasLabel,
    identity,
    unshieldedBalance,
    shieldedTokenCount,
    dustBalance,
    dustCap,
    dustFillPercent,
    dustSyncing,
    syncPercent,
    network,
    onSelectNetwork,
    balanceStatus,
    unshieldedAddress,
    shieldedAddress,
    dustAddress,
    error,
    onDismissError,
    onRefresh,
    onCopyAddress,
    onRegisterDust,
    registerDustDisabledReason,
    walletSourceNote,
    appsProfile,
    onProfileShared,
    executeTransfer,
    transferContext,
    onIncentiveRedeemed,
    supportUrl,
    onOpenClassic,
    onSignOut,
  } = props

  const [copied, setCopied] = useState<AddressKind | null>(null)
  /* Addresses are a power-user surface: collapsed by default behind the
     disclosure below, per the 2026/08/05 declutter decision. */
  const [addressesOpen, setAddressesOpen] = useState(false)

  // Escape closes the address modal, mirroring the scrim click.
  useEffect(() => {
    if (!addressesOpen) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddressesOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addressesOpen])

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
  /* Registration is a real on-chain action, so it is only offered once the
     balance call has answered — 'ready', or 'syncing', where the figures are
     real but DUST is still catching up. It is NOT additionally gated on the
     syncing flag: a first sync can report "syncing" indefinitely, and hiding
     the only actionable control behind that flag would strand the user. When
     registration genuinely cannot run, the integrator disables the button
     via `registerDustDisabledReason` instead. Note `dustBalance === '0'` is a
     genuine zero, but does not by itself mean the wallet is registered — only
     a reported cap or fill does. */
  const dustAnswered = balanceStatus === 'ready' || balanceStatus === 'syncing'
  const needsDustRegistration = dustAnswered && (fill === null || fill === 0)

  /* One legible story for the battery when the fill is unknown: say whether
     we are still waiting, whether the wallet is unreachable, or whether there
     is simply no DUST yet. */
  /* While the wallet is still walking the chain, the ring becomes a live
     sync gauge when the source reports a percentage; the DUST charge takes
     over once the fill is known. */
  const stillSyncing = balancesLoading || dustSyncing
  const showSyncGauge = fill === null && stillSyncing && syncPercent != null
  const ringLabel =
    fill !== null
      ? `${Math.round(fill)}%`
      : showSyncGauge
        ? `${Math.round(syncPercent)}%`
        : stillSyncing
          ? 'Syncing'
          : balanceStatus === 'unavailable'
            ? 'Unknown'
            : 'No charge'
  const ringAriaLabel =
    fill !== null
      ? `DUST charge ${Math.round(fill)} per cent`
      : showSyncGauge
        ? `Wallet sync ${Math.round(syncPercent)} per cent complete`
        : stillSyncing
          ? 'DUST charge still syncing'
          : balanceStatus === 'unavailable'
            ? 'DUST charge unknown — wallet unavailable'
            : 'DUST battery empty'

  const dustDetail = dustCap
    ? `Cap ${dustCap}${dustSyncing ? ' · charging' : ''}`
    : balancesLoading
      ? showSyncGauge
        ? `Syncing the wallet — ${Math.round(syncPercent)}% of the chain walked`
        : 'Checking DUST state with the wallet'
      : balanceStatus === 'unavailable'
        ? 'DUST state unavailable — refresh once the wallet reconnects'
        : dustSyncing
          ? showSyncGauge
            ? `Syncing the wallet — ${Math.round(syncPercent)}% of the chain walked`
            : 'No charge reported yet — the wallet is still syncing'
          : fill === null
            ? 'Not registered yet — DUST pays transaction fees'
            : 'Empty — DUST accrues while NIGHT is held'

  const ringDash = useMemo(() => {
    const shown = fill ?? (showSyncGauge ? syncPercent : 0) ?? 0
    const filled = (shown / 100) * RING_CIRCUMFERENCE
    return `${filled} ${RING_CIRCUMFERENCE - filled}`
  }, [fill, showSyncGauge, syncPercent])

  const addressRows: { kind: AddressKind; label: string; value: string | null }[] = [
    { kind: 'unshielded', label: 'Unshielded', value: unshieldedAddress },
    { kind: 'shielded', label: 'Shielded', value: shieldedAddress },
    { kind: 'dust', label: 'DUST', value: dustAddress },
  ]

  return (
    <section className="mnhome-screen" aria-busy={balancesLoading}>
      <header className="mnhome-bar">
        <img className="mnhome-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <div className="mnhome-bar-actions">
          <NetworkSwitcher network={network} onSelect={onSelectNetwork} />
          {network !== 'mainnet' ? (
            /* Test-NIGHT faucet for the selected network. Mainnet has no
               faucet, so the button honestly disappears there. */
            <a
              className="mnhome-icon-button mnhome-faucet"
              href={`https://faucet.${network}.midnight.network`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open the ${network} faucet to get test NIGHT`}
              title="Get test NIGHT"
            >
              <Droplets size={15} aria-hidden="true" />
            </a>
          ) : null}
          <button
            type="button"
            className="mnhome-address-pill"
            onClick={() => setAddressesOpen(true)}
            aria-haspopup="dialog"
            aria-label="Show your Midnight addresses"
            title="Your addresses"
          >
            <Wallet size={14} aria-hidden="true" />
            <code>
              {unshieldedAddress ? `${unshieldedAddress.slice(0, 9)}…${unshieldedAddress.slice(-4)}` : 'Addresses'}
            </code>
          </button>
          {/* Standard 34px size, matching the icon buttons beside it. */}
          <ThemeToggle />
          <button
            type="button"
            className="mnhome-icon-button"
            onClick={onRefresh}
            aria-label="Refresh balances"
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
          {/* The greeting carries the user's own name once they hold one: the
              alias IS their identity here, so it leads. Without an alias the
              screen keeps its previous greeting-plus-displayName shape. */}
          <h1 className="mnhome-name">
            {aliasLabel ? `${timeOfDayGreeting()}, ${aliasLabel}` : timeOfDayGreeting()}
          </h1>
          {!aliasLabel && displayName ? <p className="mnhome-person">{displayName}</p> : null}
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
              {fill !== null ? (
                /* A real DUST charge — the accent-blue animated ring. */
                <SyncRing percent={fill} tone="charge" label={ringAriaLabel} />
              ) : showSyncGauge && syncPercent != null ? (
                /* Live chain-walk progress — the muted animated gauge. */
                <SyncRing percent={syncPercent} tone="sync" label={ringAriaLabel} />
              ) : (
                /* Word states — Syncing / Unknown / No charge — keep the
                   static ring; there is no numeral to animate towards. */
                <>
                  <svg viewBox="0 0 80 80" role="img" aria-label={ringAriaLabel}>
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
                  <span className="mnhome-battery-value mnhome-battery-value-label">
                    {ringLabel}
                  </span>
                </>
              )}
            </div>

            <div className="mnhome-dust-copy">
              <p className="mnhome-micro">DUST battery</p>
              <p className={`mnhome-dust-balance${dustBalance === null ? ' mnhome-dust-balance-muted' : ''}`}>
                {dustBalance === null ? (
                  balancesLoading || dustSyncing ? 'Syncing' : 'Unavailable'
                ) : (
                  <>
                    {dustBalance}
                    <span>DUST</span>
                  </>
                )}
              </p>
              <p className="mnhome-dust-cap">{dustDetail}</p>
              {needsDustRegistration ? (
                <>
                  <button
                    type="button"
                    className="mnhome-ghost"
                    onClick={onRegisterDust}
                    disabled={Boolean(registerDustDisabledReason)}
                  >
                    <Plus size={13} aria-hidden="true" />
                    <span>Register DUST</span>
                  </button>
                  {registerDustDisabledReason ? (
                    <p className="mnhome-dust-note">{registerDustDisabledReason}</p>
                  ) : null}
                </>
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

        {/* Identity: the name held on this network, its real registration
            transactions or the reason it is only queued, and what has been
            redeemed across the ecosystem. */}
        {identity ? (
          <EcosystemIdentity
            network={network}
            record={identity.record}
            incentives={identity.incentives}
            variant="card"
            onClaimName={identity.onClaimName}
            onRegisterNow={identity.onRegisterNow}
            registerNowDisabledReason={identity.registerNowDisabledReason}
            registerNowBusy={identity.registerNowBusy}
            registerNowPhase={identity.registerNowPhase}
          />
        ) : null}

        {/* The applications, directly below the wallet summary — the same
            registry, cards, and in-Passport browser as the Apps tab. */}
        <FeaturedApps
          profile={appsProfile}
          onProfileShared={onProfileShared}
          network={network}
          executeTransfer={executeTransfer}
          transferContext={transferContext}
          onIncentiveRedeemed={onIncentiveRedeemed}
        />

        {addressesOpen
          ? createPortal(
              <div
                className="mnhome-addr-scrim"
                onClick={() => setAddressesOpen(false)}
                role="presentation"
              >
                <div
                  className="mnhome-addr-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Your Midnight addresses"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="mnhome-addr-head">
                    <p className="mnhome-micro">Your addresses</p>
                    <button
                      type="button"
                      className="mnhome-icon-button"
                      onClick={() => setAddressesOpen(false)}
                      aria-label="Close"
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
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
                  <p className="mnhome-addr-note">
                    Public receiving addresses — never the keys behind them.
                  </p>
                </div>
              </div>,
              document.body,
            )
          : null}

        <button type="button" className="mnhome-classic" onClick={onOpenClassic}>
          <span>Open full dashboard</span>
          <ExternalLink size={14} aria-hidden="true" />
        </button>

        {supportUrl ? (
          <a className="mnhome-support" href={supportUrl} target="_blank" rel="noreferrer">
            <Send size={14} aria-hidden="true" />
            <span>Support on Telegram</span>
          </a>
        ) : null}

        <p className="mnhome-foot">
          <Zap size={12} aria-hidden="true" />
          <span>
            {walletSourceNote ??
              'Midnight preview · balances read live from the indexer'}
          </span>
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
      <p className="mnhome-card-unit">{unknown ? ' ' : unit}</p>
    </article>
  )
}
