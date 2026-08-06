import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ArrowRight,
  Loader2,
  SendHorizontal,
  X,
  Zap,
} from 'lucide-react'
import {
  mainnet,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format'

/* The two names this screen shares with the wallet (Contract W). Type-only, so
   nothing of `lib/localWallet.ts` — and none of the wallet SDK it statically
   imports — is pulled into this chunk. */
import type { FeeReadiness, SendNightResult } from '../lib/localWallet.js'

import './home.css'

/**
 * The Send sheet — a real unshielded NIGHT transfer from the on-device wallet.
 *
 * Everything on this surface describes something that will actually happen. The
 * recipient is validated with the wallet SDK's own codec, so its refusals are
 * the wallet's own taxonomy rather than a regular expression's guess; the
 * amount is converted to atomic units by string arithmetic, never through a
 * float; the fee sentence is whatever the wallet's sponsor probe reported and
 * promises a covered fee on no other basis; and the sheet only reports success
 * once the node has returned a transaction id.
 *
 * The host mounts this ONLY while a local wallet session is genuinely open. A
 * closed or Dynamic-hosted wallet has no Send button at all — a control that
 * cannot work is absent, not disabled and lying about why.
 */

const NIGHT_DECIMALS = 6

export interface SendSheetProps {
  /** The open wallet's network id — the network a recipient must belong to. */
  networkId: string
  /** Formatted NIGHT available to send. `null` means genuinely not known yet. */
  availableBalance: string | null
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
   * Opens the same DUST registration the battery card offers. Provided only
   * when that affordance genuinely applies to this wallet; the `no-dust`
   * refusal stands alone without it.
   */
  onRegisterDust?: () => void
  onClose: () => void
}

type Step = 'compose' | 'review'

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

/**
 * The wallet's own recipient taxonomy, in the same three steps and the same
 * order Contract W and the in-Passport browser use: is it a Midnight address at
 * all, is it on this wallet's network, and is it an unshielded one.
 *
 * Sending to one's own address is deliberately allowed. It is harmless, it is a
 * real transaction, and refusing it would be the UI inventing a rule the chain
 * does not have.
 */
function validateRecipient(raw: string, networkId: string): string | null {
  const value = raw.trim()
  if (!value) return null
  let parsed: MidnightBech32m
  try {
    parsed = MidnightBech32m.parse(value)
  } catch {
    return 'That is not a Midnight address.'
  }
  const recipientNetwork = networkNameOf(parsed.network)
  if (recipientNetwork !== networkId) {
    return `That address belongs to the ${recipientNetwork} network; this wallet is on ${networkId}.`
  }
  try {
    parsed.decode(UnshieldedAddress, networkId)
  } catch {
    return 'That is a Midnight address, but not an unshielded (mn_addr…) one.'
  }
  return null
}

export default function SendSheet(props: SendSheetProps) {
  const {
    networkId,
    availableBalance,
    provingMode,
    readFeeReadiness,
    onSend,
    onRegisterDust,
    onClose,
  } = props

  const [step, setStep] = useState<Step>('compose')
  const [recipient, setRecipient] = useState('')
  const [amountText, setAmountText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; detail: string | null } | null>(null)
  const [showFullRecipient, setShowFullRecipient] = useState(false)
  const [fee, setFee] = useState<FeeReadiness | null>(null)
  const [feeUnknown, setFeeUnknown] = useState<string | null>(null)

  const recipientRef = useRef<HTMLTextAreaElement | null>(null)

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
  // mid-submission would hide an outcome that is still coming.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  useEffect(() => {
    recipientRef.current?.focus()
  }, [])

  const availableAtomic = useMemo(() => atomicFromFormatted(availableBalance), [availableBalance])
  const recipientError = useMemo(
    () => validateRecipient(recipient, networkId),
    [networkId, recipient],
  )
  const parsedAmount = useMemo(
    () => (amountText.trim() ? parseNight(amountText) : null),
    [amountText],
  )
  const amountError = useMemo(() => {
    if (!parsedAmount) return null
    if ('error' in parsedAmount) return parsedAmount.error
    if (availableAtomic !== null && parsedAmount.amount > availableAtomic) {
      return `That is more than this wallet holds — ${availableBalance} NIGHT is available.`
    }
    return null
  }, [availableAtomic, availableBalance, parsedAmount])

  const amount = parsedAmount && !('error' in parsedAmount) ? parsedAmount.amount : null
  const recipientReady = recipient.trim().length > 0 && recipientError === null
  const canReview = recipientReady && amount !== null && amountError === null

  /* The fee note. It says only what the wallet reported: a covered fee is
     promised on `sponsored` and on nothing else, and `no-dust` replaces the
     send control with the wallet's own refusal rather than a rewrite of it. */
  const feeNote =
    fee === null
      ? feeUnknown
        ? `The wallet could not report how this fee would be paid: ${feeUnknown}`
        : 'Checking how this fee will be paid…'
      : fee.mode === 'sponsored'
        ? 'Network fee covered by the fee sponsor.'
        : fee.mode === 'own-dust'
          ? `Network fee paid from your DUST (${fee.dustBalance} DUST available).`
          : /* The wallet's own refusal sentence, verbatim. */ fee.reason

  const feeBlocksSend = fee?.mode === 'no-dust'

  const handleMax = useCallback(() => {
    if (availableBalance === null) return
    setAmountText(availableBalance)
  }, [availableBalance])

  const handleSend = useCallback(async () => {
    if (amount === null || !recipientReady || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await onSend({ recipientAddress: recipient.trim(), amount })
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
  }, [amount, busy, onClose, onSend, recipient, recipientReady])

  return createPortal(
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
            {step === 'compose' ? 'Send NIGHT' : 'Review this transfer'}
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
              <span className="mnhome-send-label">Recipient</span>
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
              ) : (
                <span className="mnhome-send-hint">
                  An unshielded {networkId} address. Paste it — nothing is guessed from a
                  partial one.
                </span>
              )}
            </label>

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
                  placeholder="0.0"
                  inputMode="decimal"
                  spellCheck={false}
                  aria-invalid={amountError !== null}
                  aria-describedby={amountError ? 'mnhome-send-amount-error' : undefined}
                />
                <span className="mnhome-send-unit">NIGHT</span>
              </span>
              {amountError ? (
                <span className="mnhome-send-error" id="mnhome-send-amount-error" role="alert">
                  {amountError}
                </span>
              ) : (
                <span className="mnhome-send-hint">
                  {availableBalance === null
                    ? 'The balance is still being read from the indexer, so nothing is capped yet.'
                    : `${availableBalance} NIGHT available. Fees are paid in DUST, so the whole balance can go.`}
                </span>
              )}
            </label>

            <p className={`mnhome-send-fee${feeBlocksSend ? ' mnhome-send-fee-blocked' : ''}`}>
              {feeNote}
            </p>

            {feeBlocksSend ? (
              onRegisterDust ? (
                <button
                  type="button"
                  className="mnhome-ghost"
                  onClick={() => {
                    onRegisterDust()
                    onClose()
                  }}
                >
                  <Zap size={13} aria-hidden="true" />
                  <span>Generate DUST</span>
                </button>
              ) : null
            ) : (
              <button
                type="button"
                className="mnhome-send-primary"
                onClick={() => {
                  setShowFullRecipient(false)
                  setFailure(null)
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
                  <strong>{amount === null ? '—' : `${formatNight(amount)} NIGHT`}</strong>
                  <small>{amount === null ? '' : `${amount.toString()} atomic units`}</small>
                </dd>
              </div>
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

            {failure ? (
              <p className="mnhome-notice" role="alert">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>
                  Nothing was sent — no NIGHT moved from this wallet. {failure.message}
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
    </div>,
    document.body,
  )
}
