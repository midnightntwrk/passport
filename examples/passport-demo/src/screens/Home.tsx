import {
  AlertTriangle,
  ArrowDownLeft,
  Check,
  Coins,
  Copy,
  Layers,
  LogOut,
  RefreshCw,
  Send,
  SendHorizontal,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { AliasRecord } from '../identity/aliasStore.js'
import type { PassportIncentiveRecord } from '../identity/incentiveStore.js'
/* The names this screen shares with the wallet (Contract W). Type-only, and
   only the two that describe the FEE — a fee is still the wallet's to pay. */
import type { FeeReadiness, LocalWalletProvingMode } from '../lib/localWallet.js'
import { FeaturedApps, type AppsScreenProps, type FeaturedAppsProps } from './Apps.js'
import { EcosystemIdentity } from './Ecosystem.js'
import NetworkSwitcher, { type PassportNetwork } from './NetworkSwitcher.js'
import NotificationToggle from './NotificationToggle.js'
import PassportContractCard, { type PassportContractCardProps } from './PassportContract.js'
import SendSheet, { shortToken, type SendSheetHolding } from './SendSheet.js'
import ThemeToggle from './ThemeToggle.js'
import './home.css'

/* NO FAUCET ON RECEIVE, and no dead branch for one either (2026/08/25). A
   faucet drips to a WALLET address, and the account is a contract: a drip sent
   to the contract never reaches the account's mirror, and one sent to the
   wallet puts value where the account model says none may sit — which is the
   very state the legacy-funds card exists to remediate. Test NIGHT arrives
   through the service's activation deposit instead (`POST /fund-account`).
   `faucetUrlFor` stays in `../lib/networks.ts` for the network tables; nothing
   on this screen calls it. */

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
  /**
   * What this Passport's account-custody contract holds — the ONLY money this
   * screen shows since 2026/08/24.
   *
   * These are the contract's own `night_balances` and `coins`, not the passkey
   * wallet's balances: the wallet is the signer and the fee payer, and is not
   * something a Passport user is shown. `null` when the Passport has no
   * deployed contract, and the asset row is then absent rather than showing
   * zeros against an account that does not exist.
   */
  account?: {
    /** Formatted NIGHT the account holds. `null` means unknown, `'0'` a real zero. */
    nightBalance: string | null
    /**
     * The stablecoin row, when the fee sponsor has named its colour. `amount`
     * is that colour's own atomic units — a shielded colour carries no decimal
     * scale on the ledger, so nothing here invents one.
     */
    stablecoin: { symbol: string; amount: bigint } | null
    /** Every other shielded colour the account holds, shown by short colour. */
    otherShielded: { colourHex: string; amount: bigint }[]
    /** `idle` means there is nothing to read; `unavailable` means a read failed. */
    status: 'idle' | 'loading' | 'ready' | 'unavailable'
    /** Present only on `unavailable`, in the reader's own words. */
    error: string | null
  } | null
  /**
   * NIGHT sitting at this device's wallet ADDRESS rather than inside the
   * account — an older Passport, or anyone who paid the receiving address by
   * hand. It is money outside the account: the contract's own `night_balances`
   * mirror is what a withdrawal is checked against, so the account can neither
   * see it nor spend it until a `deposit_night` moves it, and the card offers
   * exactly that.
   *
   * The host supplies this ONLY when the wallet really holds a positive
   * balance and there is an account to move it into; omit or `null` and no card
   * appears. Nothing else on this screen shows a wallet balance.
   */
  legacyFunds?: {
    /** Formatted NIGHT the wallet holds. */
    balance: string
    busy: boolean
    onMove: () => void
  } | null
  /**
   * Live wallet sync progress, 0–100, as the on-device wallet reports it.
   * null = no figure known.
   */
  syncPercent?: number | null
  /** Selected network context; filters the app grid, does not move the wallet. */
  network: PassportNetwork
  onSelectNetwork: (network: PassportNetwork) => void
  /** Failure from any control on this screen — copy, send, refresh. */
  error?: string | null
  onDismissError?: () => void
  onRefresh: () => void
  /**
   * The Send seam — a withdrawal from the account contract, plus the
   * fee-readiness probe whose answer the sheet quotes.
   *
   * Omitted or `null` whenever no wallet session is open or this Passport has
   * no account to spend from. The Send control is then ABSENT rather than
   * disabled: a button that cannot work should not be on screen claiming it
   * nearly could. Receive needs no seam — it is the address sheet, which is
   * driven by the name and address this screen already has.
   */
  send?: {
    /** The network a recipient must belong to. */
    networkId: string
    /** Where this wallet proves — the send sheet's progress line names it. */
    provingMode: LocalWalletProvingMode
    readFeeReadiness: (options?: { force?: boolean }) => Promise<FeeReadiness>
    onSend: (params: { recipientAddress: string; amount: bigint }) => Promise<void>
    /**
     * The shielded half of the send seam — see the Send sheet's own header
     * comment. Supplied together or not at all: a host that offers neither
     * leaves a shielded recipient refused, which is honest, because nothing
     * behind the sheet could pay one.
     */
    readShieldedHoldings?: () => Promise<SendSheetHolding[]>
    onSendShielded?: (params: {
      recipientAddress: string
      tokenType: string
      amount: bigint
    }) => Promise<void>
    /** The live phase of the account call, narrated by the sheet. */
    phase?: 'checking' | 'connecting' | 'submitting' | 'confirming' | null
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

export default function HomeScreen(props: HomeScreenProps) {
  const {
    displayName,
    aliasLabel,
    identity,
    passportContract,
    account,
    legacyFunds,
    syncPercent,
    network,
    onSelectNetwork,
    error,
    onDismissError,
    onRefresh,
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

  const [copied, setCopied] = useState(false)
  const [copiedName, setCopiedName] = useState(false)
  /* The Receive sheet, opened only from the Receive action in the money row.
     The top-bar address pill that also opened it was cut on 2026/08/19: a
     Passport user never sees their addresses in the everyday UI — their
     visible identity is their `.night` name, and everything else is registered
     to that. Receiving still needs a real address until senders can resolve
     names, so ONE address survives inside this sheet, beneath the name: the
     payment address the resolver leaf carries. The shielded and DUST rows that
     sat under "Technical details" went with the account ruling of
     2026/08/24 — they describe the wallet, and the wallet is machinery. */
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

  /* Every copy on this screen is a LOCAL clipboard write. The host used to
     hand down an `onCopyAddress` seam for the engine's unshielded address; it
     went on 2026/08/25 with the address it copied, because nothing on this
     surface offers that address any more. No clipboard, no tick — nothing is
     claimed falsely. */
  /* The account is what the user IS on chain: the contract the `.night` name
     resolves to. Receive shows it, and only it — the passkey wallet's address
     is machinery and is never handed out as somewhere to send value. */
  const accountAddress =
    (passportContract?.record?.status === 'deployed' ? passportContract.record.address : null) ??
    identity?.record?.resolverTargetHex ??
    null
  const handleCopyAccount = useCallback(() => {
    if (!accountAddress) return
    void navigator.clipboard?.writeText(accountAddress).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1_600)
      },
      () => undefined,
    )
  }, [accountAddress])

  const handleCopyName = useCallback((name: string) => {
    void navigator.clipboard?.writeText(name).then(
      () => {
        setCopiedName(true)
        window.setTimeout(() => setCopiedName(false), 1_600)
      },
      () => undefined,
    )
  }, [])

  /* The account's own read, in the vocabulary the cards already speak: a
     figure still being read is 'Syncing', a read that failed is 'Unavailable',
     and neither is ever a zero. */
  const balancesLoading = account?.status === 'loading' || account?.status === 'idle'

  /* Sending needs a seam. The host withholds it unless a wallet session is
     open AND there is an account contract to withdraw from, so this is one
     test rather than two. */
  const canSend = Boolean(send)

  /* The user's visible identity: the `.night` name held on this network. The
     record carries it whole (`alice.night`); `aliasLabel` is only the bare
     label, so the record is the source of truth and there is no suffix
     guessed here. */
  const nightName = identity?.record?.domain ?? null
  /* Only a REGISTERED record actually resolves for a sender. A queued or
     failed one still shows its name — hiding it would be its own confusion —
     but says plainly that the address below is what works meanwhile. */
  const nameResolves = identity?.record?.status === 'registered'

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
          the wallet walks the chain. The wallet is machinery now, but its
          sync still gates whether a transaction can be signed at all, so the
          strip stays — it is the one thing about the wallet a user needs. Gone
          once synced. */}
      {syncPercent != null && syncPercent < 100 ? (
        <div
          className="mnhome-syncstrip"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(syncPercent)}
          aria-label={`Passport sync ${Math.round(syncPercent)} per cent complete`}
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

        {/* The money row. Send is present only when there is an account to
            withdraw from — see the `send` prop. Receive opens the sheet below:
            the `.night` name to be paid at, and the address beneath it. */}
        {canSend || accountAddress ? (
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
            {accountAddress ? (
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

        {/* What this Passport holds — the account contract's own ledger. The
            DUST battery that used to sit here went with the account ruling of
            2026/08/24: it described the wallet's fee charge, the wallet is
            machinery, and fees are the sponsor's. */}
        {account ? (
          <div className="mnhome-assets">
            <BalanceCard
              icon={<Wallet size={14} aria-hidden="true" />}
              label="NIGHT"
              value={account.nightBalance}
              unit="native token"
              loading={balancesLoading}
            />
            {account.stablecoin ? (
              <BalanceCard
                icon={<Coins size={14} aria-hidden="true" />}
                label={account.stablecoin.symbol}
                value={account.stablecoin.amount.toString()}
                unit="stablecoin"
                loading={balancesLoading}
              />
            ) : null}
            {/* Any other shielded colour the account holds. With no symbol to
                put on it the colour itself is the honest label — naming it
                would be Passport inventing a ticker the ledger does not carry. */}
            {account.otherShielded.map((held) => (
              <BalanceCard
                key={held.colourHex}
                icon={<Layers size={14} aria-hidden="true" />}
                label="Shielded"
                value={held.amount.toString()}
                unit={shortToken(held.colourHex)}
                loading={balancesLoading}
              />
            ))}
          </div>
        ) : null}

        {account?.status === 'unavailable' ? (
          <p className="mnhome-notice">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              Your account&rsquo;s balances could not be read, so none is shown.
              {account.error ? ` ${account.error}` : ''} Refresh once the network is reachable.
            </span>
          </p>
        ) : null}

        {/* Money that is OUTSIDE the account. Rendered only when the wallet
            genuinely holds NIGHT — the host gates on a positive balance — and
            `deposit_night` is the only route that makes it spendable. See the
            `legacyFunds` prop. */}
        {legacyFunds ? (
          <article className="mnhome-card">
            <p className="mnhome-card-head">
              <Wallet size={14} aria-hidden="true" />
              <span className="mnhome-micro">Money outside your account</span>
            </p>
            <p className="mnhome-card-unit">
              {legacyFunds.balance} NIGHT is sitting at your receiving address, outside your
              Passport account. Your account cannot see it or spend it until it is moved in, and
              moving it in is one transaction.
            </p>
            <button
              type="button"
              className="mnhome-send-primary"
              onClick={legacyFunds.onMove}
              disabled={legacyFunds.busy}
            >
              <span>{legacyFunds.busy ? 'Moving…' : 'Move into your account'}</span>
            </button>
          </article>
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
            /* The ACCOUNT's NIGHT, because that is what a withdrawal comes out
               of, with the account's own read status behind it. */
            availableBalance={account?.nightBalance ?? null}
            balanceStatus={account?.status ?? 'loading'}
            provingMode={send.provingMode}
            readFeeReadiness={send.readFeeReadiness}
            onSend={send.onSend}
            {...(send.readShieldedHoldings
              ? { readShieldedHoldings: send.readShieldedHoldings }
              : {})}
            {...(send.onSendShielded ? { onSendShielded: send.onSendShielded } : {})}
            phase={send.phase ?? null}
            onClose={() => setSendOpen(false)}
          />
        ) : null}

        {/* Receive. The name leads; the address is the technical detail under
            it, because until senders resolve names an address is still what a
            transfer needs. It is the only address on this surface. */}
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

                  {/* One address: the account contract the name resolves to.
                      Not the wallet's — under the account model nothing is
                      ever sent to the wallet, so nothing here invites it. */}
                  <ul className="mnhome-addresses">
                    <li className="mnhome-address">
                      <span className="mnhome-address-label">Your account</span>
                      <code className="mnhome-address-value">
                        {accountAddress ? truncateHash(accountAddress) : 'Not available'}
                      </code>
                      <button
                        type="button"
                        className="mnhome-icon-button"
                        onClick={handleCopyAccount}
                        disabled={!accountAddress}
                        aria-label="Copy your account address"
                      >
                        {copied ? (
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
                  </div>

                  {/* The "Technical details" disclosure that held the shielded
                      and DUST addresses was removed on 2026/08/24. Both belong
                      to the passkey wallet, which is machinery under the
                      account ruling; a dApp that genuinely needs one still gets
                      it through the consent sheet, where the user is asked. */}
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

        {/* Renders nothing where the browser has no Notification API, which is
            why it needs no condition here. */}
        <NotificationToggle />

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
