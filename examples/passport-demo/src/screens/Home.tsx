import {
  AlertTriangle,
  ArrowDownLeft,
  Banknote,
  Check,
  Coins,
  Copy,
  Layers,
  LogOut,
  Moon,
  RefreshCw,
  Send,
  SendHorizontal,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { AliasRecord } from '../identity/aliasStore.js'
import type { PassportIncentiveRecord } from '../identity/incentiveStore.js'
import ActivityFeed, { type ActivityFeedItem } from './ActivityFeed.js'
/* Naming a colour, and the order a balance list puts colours in. Pure, drilled,
   and free of the wallet SDK — see `lib/colour.ts`. */
import {
  describeColours,
  NIGHT_COLOUR_HEX,
  sortTokenHoldings,
  splitHoldings,
  TOKENS_VISIBLE,
} from '../lib/colour.js'
/* The names this screen shares with the wallet (Contract W). Type-only, and
   only the two that describe the FEE — a fee is still the wallet's to pay. */
import type { FeeReadiness, LocalWalletProvingMode } from '../lib/localWallet.js'
/* The Receive code's payload, written by the same module that reads one back —
   see `lib/qrPayload.ts` for why both directions live in one place. */
import { encodeReceivePayload } from '../lib/qrPayload.js'
import { FeaturedApps, type AppsScreenProps, type FeaturedAppsProps } from './Apps.js'
import { EcosystemIdentity } from './Ecosystem.js'
import NetworkSwitcher, { type PassportNetwork } from './NetworkSwitcher.js'
import NotificationToggle from './NotificationToggle.js'
import PassportContractCard, { type PassportContractCardProps } from './PassportContract.js'
import SendSheet, { type SendSheetHolding, type SendSheetProps } from './SendSheet.js'
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
   * The ecosystem identity card: the name held on this network with its status
   * and everything redeemed. Omit to hide the card.
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
      | 'checking'
      | 'preparing'
      | 'confirm-passkey'
      | 'attaching-account'
      | 'deploying-resolver'
      | 'registering'
      | 'confirming'
      | null
  } | null
  /**
   * Whether this Passport's account is ready, being set up, or in trouble —
   * one line, and the retry when a set-up attempt failed. The address and the
   * deployment hash it used to carry went on 2026/08/26; see
   * `PassportContract.tsx`.
   *
   * Omit to hide it. It is omitted rather than disabled whenever no passkey
   * session is open, on the same principle as the Send seam: a surface that
   * cannot act should not be on screen implying it nearly could.
   */
  passportContract?: PassportContractCardProps | null
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
     *
     * `colourHex` is carried as well as the symbol because the sponsor's answer
     * is the AUTHORITY on what that colour is called, and the Send sheet's
     * picker has to be able to apply the same name to the same colour.
     */
    stablecoin: { symbol: string; colourHex: string; amount: bigint } | null
    /**
     * Every other shielded colour the account holds. Named where Passport can
     * name it and shown as `Token · a1b2…` where it cannot — never as the raw
     * 64 characters, which identify nothing and made every row look alike.
     */
    otherShielded: { colourHex: string; amount: bigint }[]
    /** `idle` means there is nothing to read; `unavailable` means a read failed. */
    status: 'idle' | 'loading' | 'ready' | 'unavailable'
    /**
     * Why the read failed, in the reader's own words — FOR A LOG, never for
     * the screen.
     *
     * It used to be interpolated into the notice below, and on 2026/08/30 that
     * put "Cannot read properties of undefined (reading 'keys')" in front of a
     * user, between two sentences of plain English. A JavaScript exception is
     * not something a person can act on, and printing one is a way of saying
     * that whatever went wrong was not anticipated. It goes to `console.warn`
     * and the notice says the same true thing every time.
     */
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
    /**
     * The name half of the send seam — resolving a `.night` name, and paying
     * the account it points at. Supplied together or not at all: a sheet that
     * could look a name up but not pay it would offer a promise nothing behind
     * it could keep, so the field stays address-only without both.
     */
    resolveName?: SendSheetProps['resolveName']
    onSendToName?: SendSheetProps['onSendToName']
    /**
     * Paying a name in a SHIELDED asset. Separate from `onSendToName` because
     * it is a different pair of circuits, and a host that has one and not the
     * other must have the combination it cannot make refused rather than
     * quietly routed to the other one.
     */
    onSendShieldedToName?: SendSheetProps['onSendShieldedToName']
    /** The live phase of the account call, narrated by the sheet. */
    phase?: 'checking' | 'connecting' | 'submitting' | 'confirming' | null
    /** Which of a name transfer's two legs is running. See the Send sheet. */
    nameLeg?: SendSheetProps['nameLeg']
  } | null
  /**
   * The activity trail, newest first — every row Passport has written for this
   * credential, with the explorer link the host resolved where a row has a
   * transaction behind it. The list itself takes the last ten and groups them
   * by day; the host hands over everything it holds.
   *
   * Omitted only by a caller that has no trail to offer. An EMPTY array is a
   * real answer — a Passport that has not done anything yet — and gets the one
   * quiet line the section is designed around.
   */
  activity?: readonly ActivityFeedItem[]
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
    activity,
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
  /* Whether the balance list is showing everything. Collapsed by default and
     never remembered: the list is short for almost every Passport, and a
     preference that outlived the session would be one more thing to explain. */
  const [showAllTokens, setShowAllTokens] = useState(false)

  /**
   * The colour the fee sponsor named for itself, when it named one.
   *
   * The sponsor mints that asset, so its `/status` answer OUTRANKS the table in
   * `lib/colour.ts` — a build pointed at a different sponsor must not show that
   * sponsor's asset under this one's ticker.
   */
  const sponsoredToken = account?.stablecoin
    ? { colourHex: account.stablecoin.colourHex, symbol: account.stablecoin.symbol }
    : null

  /**
   * Every token row, in the order a reader can predict: NIGHT, then what has a
   * name, then what has not, largest holding first. See `sortTokenHoldings`.
   *
   * A colour nobody can name reads `Token · a1b2…` with the shortened colour
   * beneath it. It used to read "Shielded" with 64 characters of hex for a
   * unit, which made every unnamed row look exactly like every other one —
   * "unusable, and it will cause wrong sends" (2026/08/26).
   */
  const tokenRows = useMemo(() => {
    if (!account) return []
    const sponsored = account.stablecoin
      ? { colourHex: account.stablecoin.colourHex, symbol: account.stablecoin.symbol }
      : null
    /* NIGHT, then the sponsor's own colour, then everything else in the order
       `sortTokenHoldings` puts it. Named as ONE SCREENFUL rather than one row
       at a time: a colour named in isolation cannot know that another colour
       beside it has been given the same ticker, and two rows both reading
       "mUSD" over different money is worse than no name at all. */
    const held: { colourHex: string; amount: bigint; icon: ReactNode; value: string | null }[] = [
      {
        colourHex: NIGHT_COLOUR_HEX,
        amount: 0n,
        icon: <Moon size={14} aria-hidden="true" />,
        value: account.nightBalance,
      },
    ]
    if (account.stablecoin) {
      held.push({
        colourHex: account.stablecoin.colourHex,
        amount: account.stablecoin.amount,
        icon: <Coins size={14} aria-hidden="true" />,
        value: account.stablecoin.amount.toString(),
      })
    }
    /* ITEMS ARE NOT BALANCES, and since 2026/08/31 they are not on this
       strip. A one-of-a-kind holding rendered here as a card reading "1"
       looked like a rounding error beside real balances; it has a shelf of its
       own on the Assets tab, where it can say what it is. `splitHoldings` is
       the single authority on which is which — see `lib/colour.ts` — so this
       strip, that shelf, and the Send picker cannot disagree. Sorted first,
       split second: the split preserves the order it is given. */
    const { tokens: otherTokens } = splitHoldings(
      sortTokenHoldings(account.otherShielded, sponsored),
      sponsored,
    )
    for (const other of otherTokens) {
      held.push({
        colourHex: other.colourHex,
        amount: other.amount,
        icon: <Layers size={14} aria-hidden="true" />,
        value: other.amount.toString(),
      })
    }
    const identities = describeColours(
      held.map((row) => row.colourHex),
      sponsored,
    )
    return held.map((row, index) => ({
      key: row.colourHex,
      icon: row.icon,
      label: identities[index].symbol,
      value: row.value,
      unit: identities[index].name,
    }))
  }, [account])

  const visibleTokens = showAllTokens ? tokenRows : tokenRows.slice(0, TOKENS_VISIBLE)

  /**
   * The shielded colours this screen is already showing, handed to the Send
   * sheet so its asset picker can be drawn on the first frame.
   *
   * Since 2026/08/31 the asset is the FIRST field on that sheet, so the list
   * has to exist before anything is typed — and Home has already read exactly
   * this, for the cards above. Advisory only: `readShieldedHoldings` is still
   * the authority a send is enabled against, and it replaces this the moment it
   * answers. See `SendSheetProps.knownHoldings`.
   *
   * A ZERO IS FILTERED OUT. The stablecoin card is rendered at a real zero —
   * the sponsor named the colour, so the row belongs on screen either way — but
   * an asset with none of it in the account is not something to offer as a
   * thing to send, and the authoritative read drops zeros too.
   */
  const sendableHoldings = useMemo((): SendSheetHolding[] => {
    if (!account) return []
    const held: SendSheetHolding[] = []
    if (account.stablecoin) {
      held.push({
        tokenType: account.stablecoin.colourHex,
        amount: account.stablecoin.amount,
      })
    }
    for (const other of account.otherShielded) {
      held.push({ tokenType: other.colourHex, amount: other.amount })
    }
    return held.filter((entry) => entry.amount > 0n)
  }, [account])

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

  /* The failed read's own words, to the console and nowhere else. Logged once
     per distinct message rather than on every render, so a screen that
     re-renders while the network is down does not fill the log with one
     sentence. */
  const balanceError = account?.status === 'unavailable' ? account.error : null
  useEffect(() => {
    if (balanceError) console.warn('[passport] account balances unavailable:', balanceError)
  }, [balanceError])

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

  /* The Receive code.
   *
   * It carries the name and, behind it, the account that name points at — the
   * one address a sender needs, which is why it lives here and nowhere else.
   * Putting it inside the square rather than beside it as a second string to
   * read keeps that rule intact: the sheet still shows one truncated address
   * and one name, and the full address travels only in a form a camera reads.
   *
   * `null` payload means there is no name yet, and no code is drawn — a square
   * carrying only a raw account is one no Passport can scan, and drawing it
   * would be this sheet promising something it cannot keep.
   */
  const receivePayload = useMemo(
    () => encodeReceivePayload({ domain: nightName, accountAddress }),
    [accountAddress, nightName],
  )
  const [receiveCode, setReceiveCode] = useState<{ size: number; path: string } | null>(null)
  useEffect(() => {
    setReceiveCode(null)
    if (!receiveOpen || !receivePayload) return undefined
    let live = true
    /* Imported only when the sheet is open: a QR generator has no business in
       the first bundle of a Passport that never opens Receive. It is ten
       kilobytes with no dependencies of its own, and it is content-hashed, so
       the second opening — and every offline one after it — is served from the
       cache rather than the network. */
    void import('uqr')
      .then(({ encode }) => {
        if (!live) return
        /* `border: 4` is the quiet zone the QR specification asks for, drawn
           INTO the matrix rather than left to a stylesheet — a camera reads
           the image, not the CSS around it. */
        const matrix = encode(receivePayload, { ecc: 'M', border: 4 })
        let path = ''
        for (let row = 0; row < matrix.size; row += 1) {
          for (let column = 0; column < matrix.size; column += 1) {
            if (matrix.data[row]?.[column]) path += `M${column} ${row}h1v1h-1z`
          }
        }
        setReceiveCode({ size: matrix.size, path })
      })
      .catch((cause: unknown) => {
        // The address row below still works; nothing here claims otherwise.
        console.warn('[passport] the Receive code could not be drawn:', cause)
      })
    return () => {
      live = false
    }
  }, [receiveOpen, receivePayload])

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
          <>
            <div className="mnhome-assets">
              {visibleTokens.map((row) => (
                <BalanceCard
                  key={row.key}
                  icon={row.icon}
                  label={row.label}
                  value={row.value}
                  unit={row.unit}
                  loading={balancesLoading}
                />
              ))}
            </div>
            {/* THE CAP. An account with a dozen colours in it used to render a
                dozen cards, pushing the name, the account, and the apps off the
                bottom of a phone — "that's not a scalable way to display them",
                2026/08/26. Five, then the rest ON REQUEST and in place: a
                separate screen for the remainder would be a place nobody goes. */}
            {tokenRows.length > TOKENS_VISIBLE ? (
              <button
                type="button"
                className="mnhome-assets-more"
                onClick={() => setShowAllTokens((shown) => !shown)}
                aria-expanded={showAllTokens}
              >
                {showAllTokens ? 'Show fewer' : `Show all (${tokenRows.length})`}
              </button>
            ) : null}
          </>
        ) : null}

        {account?.status === 'unavailable' ? (
          /* FIXED PROSE. The reader's own words go to the console — see
             `HomeScreenProps.account.error`. */
          <p className="mnhome-notice">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              Your balances could not be read just now. They will refresh once the network
              answers.
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
              <Banknote size={14} aria-hidden="true" />
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

        {/* Whether the account behind the name is ready — one line, directly
            beneath the name it belongs to. */}
        {passportContract ? <PassportContractCard {...passportContract} /> : null}

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

        {/* What has happened to this Passport, under the apps rather than over
            them: the grid is what a person came to Home to USE, and the trail
            is what they come back to check. */}
        {activity ? <ActivityFeed entries={activity} /> : null}

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
            /* What this screen is already showing, so the sheet's asset picker
               is populated in its first frame rather than after a read. The
               read above stays the authority a send is enabled against. */
            knownHoldings={sendableHoldings}
            {...(send.onSendShielded ? { onSendShielded: send.onSendShielded } : {})}
            {...(send.resolveName ? { resolveName: send.resolveName } : {})}
            {...(send.onSendToName ? { onSendToName: send.onSendToName } : {})}
            {...(send.onSendShieldedToName
              ? { onSendShieldedToName: send.onSendShieldedToName }
              : {})}
            /* The sponsor's own name for its colour, so the picker and the
               balance list call the same colour the same thing. */
            sponsoredToken={sponsoredToken}
            phase={send.phase ?? null}
            nameLeg={send.nameLeg ?? null}
            /* The sheet's approval is a passkey assertion, so it can hit the
               same mid-session dead end the name step reported on 2026/08/31.
               Home already holds the sign-out; the sheet offers it only beside
               a failure the host marked as that one. */
            onSignOut={onSignOut}
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

                  {/* The code leads the sheet: it is the fastest way to hand
                      this Passport to somebody standing next to you, and the
                      only place the full account address is ever expressed. */}
                  {receivePayload ? (
                    <div className="mnhome-recv-qr">
                      <div className="mnhome-recv-qr-plate">
                        {receiveCode ? (
                          <svg
                            className="mnhome-recv-qr-code"
                            viewBox={`0 0 ${receiveCode.size} ${receiveCode.size}`}
                            shapeRendering="crispEdges"
                            role="img"
                            aria-label={`QR code for ${nightName ?? 'your Passport'}`}
                          >
                            <path d={receiveCode.path} fill="#000000" />
                          </svg>
                        ) : (
                          <div className="mnhome-recv-qr-wait" aria-hidden="true" />
                        )}
                      </div>
                      <p className="mnhome-recv-qr-note">
                        Scan this from another Passport to send here.
                      </p>
                    </div>
                  ) : null}

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
