import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ArrowRight,
  Loader2,
  ScanLine,
  SendHorizontal,
  X,
} from 'lucide-react'

/* The camera scanner, loaded only when opened — the camera stack and the jsQR
   fallback have no business in the Send chunk of a user who only pastes. */
const QrScanSheet = lazy(() => import('./QrScanSheet.js'))
import {
  mainnet,
  MidnightBech32m,
  ShieldedAddress,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk/address-format'

/* The names this screen shares with the wallet (Contract W). Type-only, so
   nothing of `lib/localWallet.ts` — and none of the wallet SDK it statically
   imports — is pulled into this chunk. */
import type {
  FeeReadiness,
  SendNightResult,
  SendShieldedResult,
  ShieldedHolding,
} from '../lib/localWallet.js'

import './home.css'

/**
 * The Send sheet — a real transfer from the on-device wallet.
 *
 * Everything on this surface describes something that will actually happen. The
 * recipient is validated with the wallet SDK's own codec, so its refusals are
 * the wallet's own taxonomy rather than a regular expression's guess; the
 * amount is converted to atomic units by string arithmetic, never through a
 * float; the fee sentence is whatever the wallet's sponsor probe reported —
 * quoted as the prediction it is, and re-read immediately before submitting so
 * a stale quote is never silently acted on; and the sheet only reports success
 * once the node has returned a transaction id.
 *
 * TWO KINDS OF RECIPIENT, DECIDED BY THE ADDRESS
 * ----------------------------------------------
 * The address the user pastes or scans decides what is being sent, because on
 * Midnight the two are not interchangeable:
 *
 *   `mn_addr…`         unshielded — NIGHT, quoted with six decimals.
 *   `mn_shield-addr…`  shielded — one of the shielded colours this wallet
 *                      holds, quoted in whole units.
 *
 * NIGHT cannot be sent to a shielded address. `nativeToken()` is tagged
 * `unshielded`, the ledger keys its balance check by that tag, and no wallet
 * SDK primitive crosses the boundary — so the shielded mode offers the wallet's
 * own shielded colours and says plainly when there are none. The two modes
 * therefore quote different balances, different units, and different refusals;
 * what they share is the fee sentence, because the fee is DUST either way.
 *
 * The shielded mode exists only when the host supplies both
 * {@link SendSheetProps.readShieldedHoldings} and
 * {@link SendSheetProps.onSendShielded}. Without them a shielded address is
 * refused, which is the honest answer when nothing behind the sheet could act
 * on one.
 *
 * The host mounts this ONLY while a local wallet session is genuinely open. A
 * closed wallet has no Send button at all — a control that cannot work is
 * absent, not disabled and lying about why.
 */

const NIGHT_DECIMALS = 6

export interface SendSheetProps {
  /** The open wallet's network id — the network a recipient must belong to. */
  networkId: string
  /** Formatted NIGHT available to send. `null` means genuinely not known yet. */
  availableBalance: string | null
  /**
   * Why the balance is `null`, when it is — the wallet's
   * `LocalWalletBalanceStatus`. `'unavailable'` is a read that failed and
   * disables sending; anything else while the balance is `null` reads as a
   * read still in flight. Optional, so a host with no status to report gets
   * the loading copy, never the failure one.
   */
  balanceStatus?: string
  /**
   * Where this wallet computes its proofs, so the progress line names the right
   * machine. `browser` proves in this tab; `http` proves on a proof server.
   * Either way it can take tens of seconds, which is what the line admits.
   */
  provingMode: 'browser' | 'http'
  /**
   * Reads the wallet's own fee readiness — the advisory `feeReadiness()` probe.
   * Called when the sheet opens; its answer is quoted, never paraphrased into a
   * stronger claim.
   */
  readFeeReadiness: () => Promise<FeeReadiness>
  /**
   * Signs and submits the transfer, resolving with the node's transaction id.
   * Refusals arrive as Contract W's `SendNightError` — `{ code, message,
   * detail? }` — and are shown untouched.
   */
  onSend: (params: { recipientAddress: string; amount: bigint }) => Promise<SendNightResult>
  /**
   * Reads the shielded colours this wallet holds, in the wallet's own atomic
   * units. Called once, when a shielded recipient first turns up. An empty
   * array is a real answer — this Passport holds nothing shielded — and the
   * sheet says so rather than offering a control that cannot work.
   *
   * Optional together with {@link SendSheetProps.onSendShielded}: a host that
   * supplies neither leaves shielded addresses refused.
   */
  readShieldedHoldings?: () => Promise<ShieldedHolding[]>
  /**
   * Signs and submits the shielded transfer, resolving with the node's
   * transaction id. Refusals arrive as Contract W's `SendShieldedError` —
   * `{ code, message, detail? }` — and are shown untouched.
   */
  onSendShielded?: (params: {
    recipientAddress: string
    tokenType: string
    amount: bigint
  }) => Promise<SendShieldedResult>
  onClose: () => void
}

type Step = 'compose' | 'review'
/** Which ledger the pasted recipient belongs to — see the header comment. */
type Mode = 'unshielded' | 'shielded'

/** Atomic NIGHT → display NIGHT. Exact: string arithmetic, never a float. */
function formatNight(atomic: bigint): string {
  const negative = atomic < 0n
  const digits = (negative ? -atomic : atomic).toString().padStart(NIGHT_DECIMALS + 1, '0')
  const whole = digits.slice(0, digits.length - NIGHT_DECIMALS)
  const fraction = digits.slice(digits.length - NIGHT_DECIMALS).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/**
 * Display NIGHT → atomic units, or a refusal.
 *
 * The conversion is `BigInt(whole + fraction.padEnd(6, '0'))` — no
 * `parseFloat`, no multiplication by 1e6, so 0.000001 NIGHT is one atomic unit
 * and not 0.9999999999999999 of one.
 */
function parseNight(input: string): { amount: bigint } | { error: string } {
  const text = input.trim()
  if (!text) return { error: 'Enter an amount of NIGHT to send.' }
  if (!/^\d*\.?\d*$/.test(text) || !/\d/.test(text)) {
    return { error: 'Amounts are plain decimal NIGHT, for example 1.5.' }
  }
  const [whole = '', fraction = ''] = text.split('.')
  if (fraction.length > NIGHT_DECIMALS) {
    return {
      error: `NIGHT divides into ${NIGHT_DECIMALS} decimal places; that amount has ${fraction.length}.`,
    }
  }
  const amount = BigInt(`${whole || '0'}${fraction.padEnd(NIGHT_DECIMALS, '0')}`)
  if (amount <= 0n) return { error: 'Send an amount greater than zero.' }
  return { amount }
}

/**
 * Whole shielded units → a `bigint`, or a refusal.
 *
 * Deliberately not {@link parseNight}. A shielded colour is minted by a
 * contract and carries no decimal scale anywhere on the ledger, so there is no
 * honest place to put a decimal point: an amount is a whole count of that
 * colour's atomic units, and a typed `1.5` is refused rather than silently
 * rounded into something the user did not mean.
 */
function parseShieldedUnits(input: string): { amount: bigint } | { error: string } {
  const text = input.trim()
  if (!text) return { error: 'Enter an amount to send.' }
  if (!/^\d+$/.test(text)) {
    return {
      error: 'Shielded tokens carry no decimal scale on the ledger, so amounts are whole units.',
    }
  }
  const amount = BigInt(text)
  if (amount <= 0n) return { error: 'Send an amount greater than zero.' }
  return { amount }
}

/** A shielded colour is 64 hex characters and identifies nothing to a reader. */
function shortToken(tokenType: string): string {
  return tokenType.length <= 18 ? tokenType : `${tokenType.slice(0, 10)}…${tokenType.slice(-6)}`
}

/**
 * `formatUnits` in the wallet produces exact decimal strings, so reading one
 * back is lossless. `null` whenever the balance is genuinely unknown — the
 * caller then declines to compare rather than inventing a ceiling.
 *
 * Deliberately NOT `parseNight`: that refuses a zero, because zero is not a
 * sendable amount. A zero BALANCE is a real, known figure, and reading it as
 * "unknown" would quietly disable the very refusal an empty wallet needs.
 */
function atomicFromFormatted(value: string | null): bigint | null {
  if (value === null) return null
  const text = value.trim()
  if (!/^\d*\.?\d*$/.test(text) || !/\d/.test(text)) return null
  const [whole = '', fraction = ''] = text.split('.')
  if (fraction.length > NIGHT_DECIMALS) return null
  return BigInt(`${whole || '0'}${fraction.padEnd(NIGHT_DECIMALS, '0')}`)
}

/** `mainnet` arrives as a symbol from the codec; every other network is a string. */
function networkNameOf(value: string | typeof mainnet): string {
  return value === mainnet ? 'mainnet' : value
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  return typeof cause === 'string' && cause ? cause : 'No further detail was reported.'
}

function detailOf(cause: unknown): string | null {
  const detail =
    typeof cause === 'object' && cause !== null ? (cause as { detail?: unknown }).detail : null
  return typeof detail === 'string' && detail ? detail : null
}

function shortAddress(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`
}

/** What {@link classifyRecipient} concluded. `null` means "nothing typed yet". */
type Verdict = { mode: Mode } | { error: string }

/**
 * The wallet's own recipient taxonomy, in the same order Contract W and the
 * in-Passport browser use: is it a Midnight address at all, is it on this
 * wallet's network, and which of the two ledgers does it name.
 *
 * `shieldedSupported` is not a preference — it is whether the host gave this
 * sheet a shielded send to perform. Without one, a perfectly valid shielded
 * address still earns a refusal, because accepting it would promise a transfer
 * nothing here could make.
 *
 * Sending to one's own address is deliberately allowed. It is harmless, it is a
 * real transaction, and refusing it would be the UI inventing a rule the chain
 * does not have.
 */
function classifyRecipient(
  raw: string,
  networkId: string,
  shieldedSupported: boolean,
): Verdict | null {
  const value = raw.trim()
  if (!value) return null
  let parsed: MidnightBech32m
  try {
    parsed = MidnightBech32m.parse(value)
  } catch {
    return { error: 'That is not a Midnight address.' }
  }
  const recipientNetwork = networkNameOf(parsed.network)
  if (recipientNetwork !== networkId) {
    return {
      error: `That address belongs to the ${recipientNetwork} network; this wallet is on ${networkId}.`,
    }
  }
  try {
    parsed.decode(UnshieldedAddress, networkId)
    return { mode: 'unshielded' }
  } catch {
    // Not unshielded. The shielded codec gets the next word.
  }
  try {
    parsed.decode(ShieldedAddress, networkId)
  } catch {
    return {
      error: shieldedSupported
        ? 'That is a Midnight address, but neither an unshielded (mn_addr…) nor a shielded (mn_shield-addr…) one.'
        : 'That is a Midnight address, but not an unshielded (mn_addr…) one.',
    }
  }
  if (!shieldedSupported) {
    return {
      error: 'That is a shielded (mn_shield-addr…) address, and this Passport cannot pay one.',
    }
  }
  return { mode: 'shielded' }
}

export default function SendSheet(props: SendSheetProps) {
  const {
    networkId,
    availableBalance,
    balanceStatus,
    provingMode,
    readFeeReadiness,
    onSend,
    readShieldedHoldings,
    onSendShielded,
    onClose,
  } = props

  const [step, setStep] = useState<Step>('compose')
  const [recipient, setRecipient] = useState('')
  const [scanning, setScanning] = useState(false)
  const [amountText, setAmountText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; detail: string | null } | null>(null)
  const [showFullRecipient, setShowFullRecipient] = useState(false)
  const [fee, setFee] = useState<FeeReadiness | null>(null)
  const [feeUnknown, setFeeUnknown] = useState<string | null>(null)
  const [feeChanged, setFeeChanged] = useState(false)
  /* `null` while nothing has been read yet — never a stand-in for an empty
     wallet, which is `[]` and gets its own sentence. */
  const [holdings, setHoldings] = useState<ShieldedHolding[] | null>(null)
  const [holdingsError, setHoldingsError] = useState<string | null>(null)
  const [tokenType, setTokenType] = useState<string | null>(null)

  const recipientRef = useRef<HTMLTextAreaElement | null>(null)

  const shieldedSupported = Boolean(readShieldedHoldings && onSendShielded)

  /* The fee sentence describes what will really happen, so it is read from the
     wallet when the sheet opens rather than assumed. Until it answers, nothing
     is said about who pays. */
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const readiness = await readFeeReadiness()
        if (!live) return
        setFee(readiness)
        setFeeUnknown(null)
      } catch (cause) {
        if (!live) return
        setFee(null)
        setFeeUnknown(messageOf(cause))
      }
    })()
    return () => {
      live = false
    }
  }, [readFeeReadiness])

  // Escape closes, unless a transaction is in flight — abandoning the sheet
  // mid-submission would hide an outcome that is still coming. While the
  // scanner is open, Escape belongs to it: one press closes one sheet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !scanning) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose, scanning])

  useEffect(() => {
    recipientRef.current?.focus()
  }, [])

  const verdict = useMemo(
    () => classifyRecipient(recipient, networkId, shieldedSupported),
    [networkId, recipient, shieldedSupported],
  )
  const recipientError = verdict && 'error' in verdict ? verdict.error : null
  const mode: Mode = verdict && 'mode' in verdict ? verdict.mode : 'unshielded'

  /* The shielded colours are read once, and only once a shielded recipient has
     actually turned up: a user sending NIGHT should not pay for a balance
     query they will never look at. */
  useEffect(() => {
    if (mode !== 'shielded' || !readShieldedHoldings) return
    if (holdings !== null || holdingsError !== null) return
    let live = true
    void (async () => {
      try {
        const read = await readShieldedHoldings()
        if (!live) return
        setHoldings(read)
        setHoldingsError(null)
      } catch (cause) {
        if (!live) return
        setHoldings(null)
        setHoldingsError(messageOf(cause))
      }
    })()
    return () => {
      live = false
    }
  }, [holdings, holdingsError, mode, readShieldedHoldings])

  /* One colour is chosen for the user; several are offered. Re-chosen whenever
     the current selection is no longer one of the colours actually held. */
  useEffect(() => {
    if (holdings === null || holdings.length === 0) return
    if (tokenType !== null && holdings.some((held) => held.tokenType === tokenType)) return
    setTokenType(holdings[0].tokenType)
  }, [holdings, tokenType])

  const selectedHolding = useMemo(
    () => holdings?.find((held) => held.tokenType === tokenType) ?? null,
    [holdings, tokenType],
  )

  const availableAtomic = useMemo(
    () =>
      mode === 'shielded'
        ? (selectedHolding?.amount ?? null)
        : atomicFromFormatted(availableBalance),
    [availableBalance, mode, selectedHolding],
  )
  const parsedAmount = useMemo(() => {
    if (!amountText.trim()) return null
    return mode === 'shielded' ? parseShieldedUnits(amountText) : parseNight(amountText)
  }, [amountText, mode])
  const amountError = useMemo(() => {
    if (!parsedAmount) return null
    if ('error' in parsedAmount) return parsedAmount.error
    if (availableAtomic !== null && parsedAmount.amount > availableAtomic) {
      return mode === 'shielded'
        ? `That is more than this wallet holds — ${availableAtomic.toString()} units of this token are available.`
        : `That is more than this wallet holds — ${availableBalance} NIGHT is available.`
    }
    return null
  }, [availableAtomic, availableBalance, mode, parsedAmount])

  const amount = parsedAmount && !('error' in parsedAmount) ? parsedAmount.amount : null
  const recipientReady = recipient.trim().length > 0 && recipientError === null
  /* A balance the wallet tried and failed to read. Distinct from one still in
     flight: with no ceiling to compare against, sending stays disabled rather
     than proceeding uncapped. The shielded read has the same two states, and
     an empty holdings list is neither — it is a known, empty wallet. */
  const balanceUnreadable =
    mode === 'shielded'
      ? holdingsError !== null || holdings === null
      : availableBalance === null && balanceStatus === 'unavailable'
  /* Nothing shielded to send is not an error and not a loading state: it is a
     fact about this Passport, and it removes the Send control rather than
     disabling it. */
  const noShieldedTokens = mode === 'shielded' && holdings !== null && holdings.length === 0
  const canReview =
    recipientReady &&
    amount !== null &&
    amountError === null &&
    !balanceUnreadable &&
    (mode === 'unshielded' || tokenType !== null)

  /* Why no sponsor is covering the fee, when the wallet says. The field is
     being added to `feeReadiness()`'s answer and may not exist yet, so it is
     read defensively — absence simply says nothing. */
  const sponsorUnavailableReason = useMemo(() => {
    if (fee === null || fee.mode === 'sponsored') return null
    const reason = (fee as { sponsorUnavailableReason?: unknown }).sponsorUnavailableReason
    return typeof reason === 'string' && reason ? reason : null
  }, [fee])

  /* The fee note. It says only what the wallet reported, and as the prediction
     it is: `feeReadiness()` is advisory and a sponsor can drain between this
     quote and the submit, so `sponsored` earns "expected to be covered" and
     nothing stronger. `no-dust` replaces the send control with the wallet's
     own refusal rather than a rewrite of it. */
  const feeNoteBase =
    fee === null
      ? feeUnknown
        ? `The wallet could not report how this fee would be paid: ${feeUnknown}`
        : 'Checking how this fee will be paid…'
      : fee.mode === 'sponsored'
        ? 'Network fee expected to be covered by the fee sponsor.'
        : fee.mode === 'own-dust'
          ? `Network fee paid from your DUST (${fee.dustBalance} DUST available).`
          : /* The wallet's own refusal sentence, verbatim. */ fee.reason
  const feeNote = sponsorUnavailableReason
    ? `${feeNoteBase} ${sponsorUnavailableReason}`
    : feeNoteBase

  const feeBlocksSend = fee?.mode === 'no-dust'

  const handleMax = useCallback(() => {
    if (mode === 'shielded') {
      if (selectedHolding === null) return
      setAmountText(selectedHolding.amount.toString())
      return
    }
    if (availableBalance === null) return
    setAmountText(availableBalance)
  }, [availableBalance, mode, selectedHolding])

  const handleSend = useCallback(async () => {
    if (amount === null || !recipientReady || busy) return
    setBusy(true)
    setFailure(null)
    setFeeChanged(false)
    /* The fee quote was read when the sheet opened and is only a prediction —
       a sponsor can drain in the meantime, and the send would then quietly
       fall back to the user's own DUST. Re-read immediately before submitting;
       a different answer means the quoted sentence is no longer true, so
       nothing is sent until it has been confirmed against the new one. A
       probe that fails outright is handled the same way: the line falls back
       to "could not report", and a second confirm against that sentence — the
       modes then match — proceeds, because the probe is advisory and the send
       path keeps its own authoritative checks. */
    const quotedMode = fee?.mode ?? null
    let recheckedMode: FeeReadiness['mode'] | null
    try {
      const readiness = await readFeeReadiness()
      recheckedMode = readiness.mode
      setFee(readiness)
      setFeeUnknown(null)
    } catch (cause) {
      recheckedMode = null
      setFee(null)
      setFeeUnknown(messageOf(cause))
    }
    if (recheckedMode !== quotedMode) {
      setBusy(false)
      setFeeChanged(true)
      return
    }
    try {
      if (mode === 'shielded') {
        // `canReview` already required a chosen colour and a shielded seam;
        // both are re-read here so this branch cannot be entered on a `null`.
        if (!onSendShielded || tokenType === null) {
          throw new Error('This Passport cannot send a shielded token right now.')
        }
        await onSendShielded({ recipientAddress: recipient.trim(), tokenType, amount })
      } else {
        await onSend({ recipientAddress: recipient.trim(), amount })
      }
      // A real txId came back from the node. The host owns the toast, the
      // activity row, and the refreshes; the sheet's job here is to get out
      // of the way.
      onClose()
    } catch (cause) {
      const code =
        typeof cause === 'object' && cause !== null &&
        typeof (cause as { code?: unknown }).code === 'string'
          ? (cause as { code: string }).code
          : null
      if (code === 'wallet-closed') {
        // The session went away. There is no sheet to keep open — the host's
        // toast carries the wallet's own sentence.
        onClose()
        return
      }
      setBusy(false)
      setFailure({ message: messageOf(cause), detail: detailOf(cause) })
    }
  }, [
    amount,
    busy,
    fee,
    mode,
    onClose,
    onSend,
    onSendShielded,
    readFeeReadiness,
    recipient,
    recipientReady,
    tokenType,
  ])

  return createPortal(
    <>
    <div
      className="mnhome-addr-scrim"
      onClick={() => {
        if (!busy) onClose()
      }}
      role="presentation"
    >
      <div
        className="mnhome-addr-modal mnhome-send"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mnhome-send-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mnhome-addr-head">
          <p className="mnhome-micro" id="mnhome-send-title">
            {step === 'review'
              ? 'Review this transfer'
              : mode === 'shielded'
                ? 'Send a shielded token'
                : 'Send NIGHT'}
          </p>
          <button
            type="button"
            className="mnhome-icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        {step === 'compose' ? (
          <div className="mnhome-send-form">
            <label className="mnhome-send-field">
              <span className="mnhome-send-label">
                Recipient
                {/* The camera fills this field; it never bypasses it. Whatever
                    the scanner hands over meets the same validator a pasted
                    address does, so a scanned wrong-network address gets the
                    same honest sentence. */}
                <button
                  type="button"
                  className="mnhome-send-max"
                  onClick={() => setScanning(true)}
                  disabled={busy}
                >
                  <ScanLine size={12} aria-hidden="true" /> Scan QR
                </button>
              </span>
              <textarea
                ref={recipientRef}
                className="mnhome-send-input mnhome-send-input-mono"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder={`mn_addr_${networkId}1…`}
                rows={2}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={recipientError !== null}
                aria-describedby={recipientError ? 'mnhome-send-recipient-error' : undefined}
              />
              {recipientError ? (
                <span className="mnhome-send-error" id="mnhome-send-recipient-error" role="alert">
                  {recipientError}
                </span>
              ) : mode === 'shielded' ? (
                <span className="mnhome-send-hint">
                  A shielded {networkId} address. This pays one of the shielded tokens this
                  Passport holds — not NIGHT, which is unshielded and cannot reach a shielded
                  account.
                </span>
              ) : (
                <span className="mnhome-send-hint">
                  {shieldedSupported
                    ? `An unshielded (mn_addr…) or shielded (mn_shield-addr…) ${networkId} address. Paste it — nothing is guessed from a partial one.`
                    : `An unshielded ${networkId} address. Paste it — nothing is guessed from a partial one.`}
                </span>
              )}
            </label>

            {/* The colour picker. One held colour is simply named; several are
                offered; none at all is said plainly by the amount hint below,
                and the Send control goes with it. */}
            {mode === 'shielded' && holdings !== null && holdings.length === 1 ? (
              /* A `div`, not a `label`: there is no control here to label — one
                 held colour is stated, not chosen. */
              <div className="mnhome-send-field">
                <span className="mnhome-send-label">Token</span>
                <span className="mnhome-send-hint">
                  <code>{shortToken(holdings[0].tokenType)}</code> — the only shielded token this
                  Passport holds.
                </span>
              </div>
            ) : null}
            {mode === 'shielded' && holdings !== null && holdings.length > 1 ? (
              <label className="mnhome-send-field">
                <span className="mnhome-send-label">Token</span>
                <select
                  className="mnhome-send-input mnhome-send-input-mono"
                  value={tokenType ?? ''}
                  onChange={(event) => setTokenType(event.target.value)}
                >
                  {holdings.map((held) => (
                    <option key={held.tokenType} value={held.tokenType}>
                      {shortToken(held.tokenType)} — {held.amount.toString()} units
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="mnhome-send-field">
              <span className="mnhome-send-label">
                Amount
                {/* Max means "everything this wallet holds". With nothing held,
                    and with the balance not yet known, there is no such figure —
                    the hint line below already says which of the two it is. */}
                <button
                  type="button"
                  className="mnhome-send-max"
                  onClick={handleMax}
                  disabled={availableAtomic === null || availableAtomic === 0n}
                >
                  Max
                </button>
              </span>
              <span className="mnhome-send-amount">
                <input
                  className="mnhome-send-input"
                  value={amountText}
                  onChange={(event) => setAmountText(event.target.value)}
                  placeholder={mode === 'shielded' ? '0' : '0.0'}
                  inputMode={mode === 'shielded' ? 'numeric' : 'decimal'}
                  spellCheck={false}
                  aria-invalid={amountError !== null}
                  aria-describedby={amountError ? 'mnhome-send-amount-error' : undefined}
                />
                <span className="mnhome-send-unit">{mode === 'shielded' ? 'units' : 'NIGHT'}</span>
              </span>
              {amountError ? (
                <span className="mnhome-send-error" id="mnhome-send-amount-error" role="alert">
                  {amountError}
                </span>
              ) : mode === 'shielded' ? (
                <span className="mnhome-send-hint">
                  {holdingsError !== null
                    ? `The shielded balances could not be read, so sending is disabled until they can be: ${holdingsError}`
                    : holdings === null
                      ? 'Reading which shielded tokens this Passport holds…'
                      : holdings.length === 0
                        ? 'This Passport holds no shielded tokens, so there is nothing to pay a shielded address with. Shielded tokens are minted by contracts; NIGHT is unshielded and never appears here.'
                        : `${(selectedHolding?.amount ?? 0n).toString()} units of this token available. A shielded token has no decimal scale on the ledger, so this is a whole-unit count. Fees are paid in DUST, so the whole balance can go.`}
                </span>
              ) : (
                <span className="mnhome-send-hint">
                  {availableBalance === null
                    ? balanceUnreadable
                      ? 'The balance could not be read, so sending is disabled until it can be.'
                      : 'The balance is still being read from the indexer, so nothing is capped yet.'
                    : `${availableBalance} NIGHT available. Fees are paid in DUST, so the whole balance can go.`}
                </span>
              )}
            </label>

            <p className={`mnhome-send-fee${feeBlocksSend ? ' mnhome-send-fee-blocked' : ''}`}>
              {feeNote}
            </p>

            {/* Nothing stands in for the Send control when the fee cannot be
                paid, or when there is nothing shielded to pay with: the
                sentences above already say why, and there is no user-side
                registration left to point at. */}
            {feeBlocksSend || noShieldedTokens ? null : (
              <button
                type="button"
                className="mnhome-send-primary"
                onClick={() => {
                  setShowFullRecipient(false)
                  setFailure(null)
                  setFeeChanged(false)
                  setStep('review')
                }}
                disabled={!canReview}
              >
                <span>Review</span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        ) : (
          <div className="mnhome-send-form">
            <dl className="mnhome-send-rows">
              <div className="mnhome-send-row">
                <dt>Amount</dt>
                <dd>
                  <strong>
                    {amount === null
                      ? '—'
                      : mode === 'shielded'
                        ? `${amount.toString()} units`
                        : `${formatNight(amount)} NIGHT`}
                  </strong>
                  <small>
                    {amount === null
                      ? ''
                      : mode === 'shielded'
                        ? /* There is no second scale to convert to: the figure
                             above already IS the ledger's own count. */
                          'A shielded token has no decimal scale on the ledger.'
                        : `${amount.toString()} atomic units`}
                  </small>
                </dd>
              </div>
              {mode === 'shielded' ? (
                <div className="mnhome-send-row">
                  <dt>Token</dt>
                  <dd>
                    <strong>{tokenType === null ? '—' : shortToken(tokenType)}</strong>
                    <small>{tokenType ?? ''}</small>
                  </dd>
                </div>
              ) : null}
              <div className="mnhome-send-row">
                <dt>Recipient</dt>
                <dd>
                  <button
                    type="button"
                    className="mnhome-send-reveal"
                    onClick={() => setShowFullRecipient((shown) => !shown)}
                    aria-expanded={showFullRecipient}
                  >
                    <code>
                      {showFullRecipient ? recipient.trim() : shortAddress(recipient.trim())}
                    </code>
                    <small>{showFullRecipient ? 'Hide' : 'Show full address'}</small>
                  </button>
                </dd>
              </div>
              <div className="mnhome-send-row">
                <dt>Network</dt>
                <dd>{networkId}</dd>
              </div>
              <div className="mnhome-send-row">
                <dt>Fee</dt>
                <dd>{feeNote}</dd>
              </div>
            </dl>

            {feeChanged ? (
              /* The pre-send re-check answered differently from the quote the
                 user confirmed against. The fee line above already shows the
                 new reality; this explains why nothing was submitted. */
              <p className="mnhome-notice" role="alert">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>
                  Nothing was sent — the fee arrangement changed. Review the fee line above
                  and confirm again.
                </span>
              </p>
            ) : null}

            {failure ? (
              <p className="mnhome-notice" role="alert">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>
                  Nothing was sent — {mode === 'shielded' ? 'no shielded token' : 'no NIGHT'}{' '}
                  moved from this wallet. {failure.message}
                  {failure.detail ? ` ${failure.detail}` : ''}
                </span>
              </p>
            ) : null}

            {busy ? (
              /* An honest progress line, not a percentage nobody measured: the
                 proving step reports no figure, so none is invented. It does
                 say where the work happens and that it genuinely takes time. */
              <p className="mnhome-send-busy" role="status">
                <Loader2 className="mnhome-send-spinner" size={14} aria-hidden="true" />
                <span>
                  {provingMode === 'browser'
                    ? 'Proving and submitting. The proof is computed in this tab and can take tens of seconds — leave this open.'
                    : 'Proving and submitting. The proof is computed on the proof server and can take tens of seconds — leave this open.'}
                </span>
              </p>
            ) : null}

            <div className="mnhome-send-actions">
              <button
                type="button"
                className="mnhome-send-secondary"
                onClick={() => setStep('compose')}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="mnhome-send-primary"
                onClick={() => void handleSend()}
                disabled={busy || !canReview}
              >
                {busy ? (
                  <>
                    <Loader2 className="mnhome-send-spinner" size={15} aria-hidden="true" />
                    <span>Sending…</span>
                  </>
                ) : (
                  <>
                    <SendHorizontal size={15} aria-hidden="true" />
                    <span>Send</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* A JSX sibling of the scrim, deliberately: the scanner portals its own
        scrim, and mounting it inside this one would let its clicks bubble
        through the React tree and close both sheets at once. */}
    {scanning && (
      <Suspense fallback={null}>
        <QrScanSheet
          onAddress={(address) => {
            setRecipient(address)
            setScanning(false)
          }}
          onClose={() => setScanning(false)}
        />
      </Suspense>
    )}
    </>,
    document.body,
  )
}
