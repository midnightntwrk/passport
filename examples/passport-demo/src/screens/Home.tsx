import {
  AlertTriangle,
  ArrowDownLeft,
  Droplets,
  Check,
  Copy,
  ExternalLink,
  Layers,
  LogOut,
  RefreshCw,
  Send,
  SendHorizontal,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { AliasRecord } from '../identity/aliasStore.js'
import type { PassportIncentiveRecord } from '../identity/incentiveStore.js'
/* The two names this screen shares with the wallet (Contract W). Type-only. */
import type { FeeReadiness, SendNightResult } from '../lib/localWallet.js'
import { faucetUrlFor, walletNetwork } from '../lib/networks.js'
import { FeaturedApps, type AppsScreenProps, type FeaturedAppsProps } from './Apps.js'
import { EcosystemIdentity } from './Ecosystem.js'
import NetworkSwitcher, { type PassportNetwork } from './NetworkSwitcher.js'
import PassportContractCard, { type PassportContractCardProps } from './PassportContract.js'
import SendSheet from './SendSheet.js'
import SyncRing from './SyncRing.js'
import ThemeToggle from './ThemeToggle.js'
import './home.css'

/* The wallet's own network and its faucet, both fixed for the life of a build
   (`VITE_MIDNIGHT_NETWORK_ID`), so they are resolved once here rather than per
   render. `receiveFaucetUrl` is null wherever no public faucet exists —
   mainnet, and any devnet build — and the Receive sheet then shows no link at
   all. Deliberately NOT the network chosen in the switcher: that selection
   filters the app grid and never moves the wallet, so its faucet would drip to
   a chain this address does not live on. */
const receiveFaucetNetwork = walletNetwork()
const receiveFaucetUrl = faucetUrlFor(receiveFaucetNetwork)

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
    registerNowPhase?:
      | 'activating'
      | 'attaching-account'
      | 'deploying-resolver'
      | 'registering'
      | 'confirming'
      | null
  } | null
  /**
   * The Passport account-custody contract (C1) on the active network: its
   * status, its real address and deployment transaction, and the deploy action.
   *
   * Omit to hide the card. It is omitted rather than disabled whenever no
   * passkey wallet session is open, on the same principle as the Send seam: a
   * surface that cannot act should not be on screen implying it nearly could.
   * Deploying is NOT part of onboarding — the card simply sits below the
   * identity card, doing nothing until the user asks.
   */
  passportContract?: Omit<PassportContractCardProps, 'network'> | null
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
   * Live wallet sync progress, 0–100, as the on-device wallet reports it.
   * null = no figure known.
   */
  syncPercent?: number | null
  /** Selected network context; filters the app grid, does not move the wallet. */
  network: PassportNetwork
  onSelectNetwork: (network: PassportNetwork) => void
  balanceStatus: string
  unshieldedAddress: string | null
  shieldedAddress: string | null
  dustAddress: string | null
  /** Failure from any control on this screen — copy, send, refresh. */
  error?: string | null
  onDismissError?: () => void
  onRefresh: () => void
  onCopyAddress: (kind: 'unshielded' | 'shielded' | 'dust') => void
  /**
   * The Send seam — the open on-device wallet's own `sendUnshieldedNight`, plus
   * the fee-readiness probe whose answer the sheet quotes.
   *
   * Omitted or `null` whenever no local wallet session is genuinely open.
   * The Send control is then ABSENT rather than
   * disabled: a button that cannot work should not be on screen claiming it
   * nearly could. Receive needs no seam — it is the address sheet, which is
   * driven by the addresses this screen already has.
   */
  send?: {
    /** The wallet's own network id, which a recipient must belong to. */
    networkId: string
    /** Where this wallet proves — the send sheet's progress line names it. */
    provingMode: 'browser' | 'http'
    readFeeReadiness: () => Promise<FeeReadiness>
    onSend: (params: {
      recipientAddress: string
      amount: bigint
    }) => Promise<SendNightResult>
  } | null
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
  /**
   * Opens the Backup screen — where the private state is exported as one
   * password-encrypted file, and restored from one. Rendered in the footer
   * area beside the support link because it is a thing done rarely and
   * deliberately, not part of the everyday surface. Omit it and no control
   * appears.
   */
  onOpenBackup?: () => void
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
    passportContract,
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
    send,
    appsProfile,
    onProfileShared,
    executeTransfer,
    transferContext,
    onIncentiveRedeemed,
    supportUrl,
    onOpenBackup,
    onSignOut,
  } = props

  const [copied, setCopied] = useState<AddressKind | null>(null)
  const [copiedName, setCopiedName] = useState(false)
  /* The Receive sheet, opened only from the Receive action in the money row.
     The top-bar address pill that also opened it was cut on 2026/08/19: a
     Passport user never sees their three addresses in the everyday UI — their
     visible identity is their `.night` name, and everything else is registered
     to that. Receiving still needs a real address until senders can resolve
     names, so the address survives INSIDE this sheet, beneath the name. */
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)

  // Escape closes the Receive sheet, mirroring the scrim click.
  useEffect(() => {
    if (!receiveOpen) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReceiveOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [receiveOpen])

  const handleCopy = useCallback(
    (kind: AddressKind) => {
      onCopyAddress(kind)
      setCopied(kind)
      window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1_600)
    },
    [onCopyAddress],
  )

  /* The name is copied here rather than through `onCopyAddress`: that seam is
     keyed by address kind, and giving it a 'name' kind would change the props
     contract the integrator implements. A local clipboard write keeps the
     interface untouched. No clipboard, no tick — nothing is claimed falsely. */
  const handleCopyName = useCallback((name: string) => {
    void navigator.clipboard?.writeText(name).then(
      () => {
        setCopiedName(true)
        window.setTimeout(() => setCopiedName(false), 1_600)
      },
      () => undefined,
    )
  }, [])

  const balancesLoading = balanceStatus === 'loading'
  const fill = clampPercent(dustFillPercent)

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
            ? /* No DUST coins at all. Deliberately a state, not an
                 instruction: registering NIGHT is not a user step here —
                 fees on these networks are sponsored. */
              'No DUST yet — DUST pays transaction fees'
            : 'Empty — DUST accrues while NIGHT is held'

  const ringDash = useMemo(() => {
    const shown = fill ?? (showSyncGauge ? syncPercent : 0) ?? 0
    const filled = (shown / 100) * RING_CIRCUMFERENCE
    return `${filled} ${RING_CIRCUMFERENCE - filled}`
  }, [fill, showSyncGauge, syncPercent])

  /* Sending needs a seam AND an address to send from. Both, or no button. */
  const canSend = Boolean(send) && Boolean(unshieldedAddress)

  /* The user's visible identity: the `.night` name held on this network. The
     record carries it whole (`alice.night`); `aliasLabel` is only the bare
     label, so the record is the source of truth and there is no suffix
     guessed here. */
  const nightName = identity?.record?.domain ?? null
  /* Only a REGISTERED record actually resolves for a sender. A queued or
     failed one still shows its name — hiding it would be its own confusion —
     but says plainly that the address below is what works meanwhile. */
  const nameResolves = identity?.record?.status === 'registered'

  /* Shielded and DUST are out of the primary Receive surface entirely: they
     sit behind one quiet disclosure, for the operator who needs them. The
     unshielded address is handled on its own above — it is the one a sender
     can actually use today. */
  const technicalAddressRows: { kind: AddressKind; label: string; value: string | null }[] = [
    { kind: 'shielded', label: 'Shielded', value: shieldedAddress },
    { kind: 'dust', label: 'DUST', value: dustAddress },
  ].filter((row): row is { kind: AddressKind; label: string; value: string | null } =>
    Boolean(row.value),
  )

  return (
    <section className="mnhome-screen" aria-busy={balancesLoading}>
      <header className="mnhome-bar">
        <img className="mnhome-wordmark" src="/midnight-wordmark.svg" alt="Midnight" />
        <span className="mn-beta-badge">Beta</span>
        <div className="mnhome-bar-actions">
          <NetworkSwitcher network={network} onSelect={onSelectNetwork} />
          {/* The address pill was cut 2026/08/19. A Passport user's visible
              identity is their `.night` name, not a truncated address in the
              chrome; the address they receive at lives inside Receive. */}
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

      {/* Compact sync status: a hairline progress strip under the bar while
          the wallet walks the chain — the sync percent's home now that the
          DUST card no longer doubles as a gauge. Gone once synced. */}
      {syncPercent != null && syncPercent < 100 && stillSyncing ? (
        <div
          className="mnhome-syncstrip"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(syncPercent)}
          aria-label={`Wallet sync ${Math.round(syncPercent)} per cent complete`}
        >
          <span className="mnhome-syncstrip-track" aria-hidden="true">
            <span
              className="mnhome-syncstrip-fill"
              style={{ width: `${Math.max(2, Math.min(100, syncPercent))}%` }}
            />
          </span>
          <span className="mnhome-syncstrip-label">
            Syncing · {Math.round(syncPercent)}%
          </span>
        </div>
      ) : null}

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

        {/* The money row. Send is present only when a local wallet session is
            genuinely open and has an unshielded address to send from — see the
            `send` prop. Receive opens the sheet below: the `.night` name to be
            paid at, the address beneath it, the faucet, and nothing else. */}
        {canSend || unshieldedAddress ? (
          <div className="mnhome-actions">
            {canSend ? (
              <button
                type="button"
                className="mnhome-action mnhome-action-primary"
                onClick={() => setSendOpen(true)}
                aria-haspopup="dialog"
              >
                <SendHorizontal size={16} aria-hidden="true" />
                <span>Send</span>
              </button>
            ) : null}
            {unshieldedAddress ? (
              <button
                type="button"
                className="mnhome-action"
                onClick={() => setReceiveOpen(true)}
                aria-haspopup="dialog"
              >
                <ArrowDownLeft size={16} aria-hidden="true" />
                <span>Receive</span>
              </button>
            ) : null}
          </div>
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

          {/* The DUST card reports this wallet's charge, and asks nothing of
              the user: fees are covered by the sponsor, so there is no
              registration step to offer. Sync progress lives in the strip up
              top. The localnet demo hides the card outright, as it always has
              — the 'Generate Dust' pill that stood in its place there went
              with the rest of user-side registration. */}
          {(import.meta.env as Record<string, string | undefined>).VITE_LOCALNET_DEMO === '1' ? null : (
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
            </div>
          </article>
          )}
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

        {/* The account-custody contract, directly beneath the name it belongs
            to: same card language, same status-pill discipline. */}
        {passportContract ? (
          <PassportContractCard network={network} {...passportContract} />
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

        {sendOpen && send ? (
          <SendSheet
            networkId={send.networkId}
            availableBalance={unshieldedBalance}
            balanceStatus={balanceStatus}
            provingMode={send.provingMode}
            readFeeReadiness={send.readFeeReadiness}
            onSend={send.onSend}
            onClose={() => setSendOpen(false)}
          />
        ) : null}

        {/* Receive. The name leads; the address is the technical detail under
            it, because until senders resolve names an address is still what a
            transfer needs. Shielded and DUST are behind the one disclosure at
            the foot — off the everyday surface, not deleted from the build. */}
        {receiveOpen
          ? createPortal(
              <div
                className="mnhome-addr-scrim"
                onClick={() => setReceiveOpen(false)}
                role="presentation"
              >
                <div
                  className="mnhome-addr-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Receive to your Passport"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="mnhome-addr-head">
                    <p className="mnhome-micro">Receive</p>
                    <button
                      type="button"
                      className="mnhome-icon-button"
                      onClick={() => setReceiveOpen(false)}
                      aria-label="Close"
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>

                  {nightName ? (
                    <div className="mnhome-recv-name">
                      <p className="mnhome-recv-name-row">
                        <span className="mnhome-recv-name-value">{nightName}</span>
                        <button
                          type="button"
                          className="mnhome-icon-button"
                          onClick={() => handleCopyName(nightName)}
                          aria-label="Copy your Passport name"
                        >
                          {copiedName ? (
                            <Check size={14} aria-hidden="true" />
                          ) : (
                            <Copy size={14} aria-hidden="true" />
                          )}
                        </button>
                      </p>
                      <p className="mnhome-recv-name-note">
                        {nameResolves
                          ? 'Send to this name from any Passport.'
                          : 'This name is not registered on this network yet — use the address below until it is.'}
                      </p>
                    </div>
                  ) : null}

                  <ul className="mnhome-addresses">
                    <li className="mnhome-address">
                      <span className="mnhome-address-label">Address</span>
                      <code className="mnhome-address-value">
                        {unshieldedAddress ? truncateHash(unshieldedAddress) : 'Not available'}
                      </code>
                      <button
                        type="button"
                        className="mnhome-icon-button"
                        onClick={() => handleCopy('unshielded')}
                        disabled={!unshieldedAddress}
                        aria-label="Copy your receiving address"
                      >
                        {copied === 'unshielded' ? (
                          <Check size={14} aria-hidden="true" />
                        ) : (
                          <Copy size={14} aria-hidden="true" />
                        )}
                      </button>
                    </li>
                  </ul>

                  <div className="mnhome-addr-foot">
                    <p className="mnhome-addr-note">
                      A public receiving address — never the keys behind it.
                    </p>
                    {receiveFaucetUrl ? (
                      /* The faucet lives here, beside the address it funds —
                         and it is the faucet of the network THAT ADDRESS is on,
                         which is the wallet's network, not the one selected in
                         the switcher. The switcher only filters the app grid;
                         a drip requested from the selected network's faucet
                         would land nowhere this address can see it.

                         The URL comes from `faucetUrlFor`, the one place that
                         records which networks have a faucet at all. A network
                         with none — mainnet, or a devnet build — yields null
                         and the link simply is not rendered, rather than a
                         hand-built host that would 404. */
                      <a
                        className="mnhome-addr-faucet"
                        href={receiveFaucetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open the ${receiveFaucetNetwork} faucet to get test NIGHT`}
                      >
                        <Droplets size={14} aria-hidden="true" />
                        <span>Get test NIGHT</span>
                        <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    ) : null}
                  </div>

                  {technicalAddressRows.length > 0 ? (
                    /* One quiet native disclosure — `details`/`summary` carries
                       its own keyboard and screen-reader behaviour, so no ARIA
                       is re-implemented here. Closed on every open. */
                    <details className="mnhome-recv-more">
                      <summary className="mnhome-recv-more-summary">Technical details</summary>
                      <ul className="mnhome-addresses">
                        {technicalAddressRows.map((row) => (
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
                              {copied === row.kind ? (
                                <Check size={14} aria-hidden="true" />
                              ) : (
                                <Copy size={14} aria-hidden="true" />
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              </div>,
              document.body,
            )
          : null}

        {onOpenBackup ? (
          <button type="button" className="mnhome-support" onClick={onOpenBackup}>
            <ShieldCheck size={14} aria-hidden="true" />
            <span>Back up or restore</span>
          </button>
        ) : null}

        {supportUrl ? (
          <a className="mnhome-support" href={supportUrl} target="_blank" rel="noreferrer">
            <Send size={14} aria-hidden="true" />
            <span>Support on Telegram</span>
          </a>
        ) : null}

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
