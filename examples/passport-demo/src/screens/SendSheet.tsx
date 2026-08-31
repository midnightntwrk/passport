import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ArrowRight,
  Check,
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

/* The two names this screen shares with the transaction engine (Contract W) —
   both about the FEE, which the sponsor pays. Type-only, so nothing of
   `lib/localWallet.ts` — and none of the wallet SDK it statically imports — is
   pulled into this chunk. */
import type { FeeReadiness, LocalWalletProvingMode } from '../lib/localWallet.js'

/* The sponsor watcher. A real (tiny) import rather than a type-only one: it is
   what turns a refusal that has already stopped being true into a control that
   enables itself. It pulls in no wallet SDK — only a type from `localWallet`,
   which is erased. */
import { startFeeReadinessPoll, type FeeReadinessPoll } from '../lib/feeReadinessPoll.js'

/* Whether a refusal is a passkey ceremony the host could not complete. Pure,
   drilled, and imports nothing — see `lib/passkeyRecovery.ts`. */
import { isMidSessionWayOut } from '../lib/passkeyRecovery.js'
import { PasskeyWayOutActions } from './PasskeyWayOut.js'

/* Reading the recipient field's two vocabularies, and remembering what each
   name resolved to. Pure, drilled, and free of the wallet SDK — which is why
   the label rule is spelled out there rather than imported from
   `identity/midnames.ts`, whose every import pulls in the ledger. */
import {
  accountTail,
  classifyRecipientInput,
  createNameResolutionCache,
  type NameLookup,
} from '../lib/recipientName.js'

/* The scanner's vocabulary. Only the account normaliser is needed here, so the
   registry's answer and a scanned code's claim go through one rule rather than
   two — `QrPayload` itself arrives typed from the scan sheet. */
import { normalisedAccountHex } from '../lib/qrPayload.js'

/* What this account can send, and where each of those things is allowed to go.
   Pure and drilled, and — like `recipientName.ts` — free of the wallet SDK,
   which `identity/accountCustody.ts` would drag in. */
import {
  buildSendAssets,
  NIGHT_ASSET_ID,
  refusalFor,
  routeFor,
  type SendAsset,
  type SendCapabilities,
} from '../lib/sendAssets.js'

import './home.css'

/**
 * The Send sheet — a real withdrawal from this Passport's account.
 *
 * Since 2026/08/24 the money on this surface is the account-custody contract's,
 * not the passkey wallet's: confirming here runs `withdraw_night` or
 * `withdraw_shielded` against the contract, with the wallet signing and the
 * sponsor paying. Nothing about that changes what the sheet owes the user.
 *
 * Everything on this surface describes something that will actually happen. The
 * recipient is validated with the wallet SDK's own codec, so its refusals are
 * the SDK's own taxonomy rather than a regular expression's guess; the amount
 * is converted to atomic units by string arithmetic, never through a float; the
 * fee sentence is whatever the sponsor probe reported — quoted as the
 * prediction it is, and re-read immediately before submitting so a stale quote
 * is never silently acted on; and the sheet only reports success once the node
 * has returned a transaction id.
 *
 * A NAME IS A RECIPIENT (2026/08/30)
 * ----------------------------------
 * "A name, not an address" is the second promise on Passport's welcome screen,
 * and until this date the Send sheet could not keep it: whatever was typed went
 * straight to the wallet SDK's bech32m codec, and anything that was not an
 * address was refused. `alice.night` — or bare `alice` — is now resolved
 * through the `.night` registry, and what it resolves to is that Passport's
 * ACCOUNT.
 *
 * That is why a name is a different send from an address, rather than the same
 * send with the address filled in for you. `withdraw_night` takes a
 * `UserAddress`; unshielded value sent to a contract by any route other than
 * its own `deposit_night` is invisible to the balance mirror the recipient's
 * Passport reads (`account.compact`, `night_balances`). So paying a name is a
 * withdrawal followed by a DEPOSIT into the recipient's account — two
 * transactions, narrated as two — and it has its own seam,
 * {@link SendSheetProps.onSendToName}, precisely so the difference cannot be
 * lost by accident.
 *
 * The name is what the review step shows. The account it resolved to appears
 * only as its last four characters, in the chip that confirms the lookup found
 * something: an address is not a thing a Passport user is shown, and four
 * characters are enough to tell two resolutions apart and far too few to
 * mistake for one.
 *
 * Pasting a raw address still works, unchanged, and everything below is about
 * that path.
 *
 * THE ASSET IS CHOSEN, AND THE ASSET DECIDES THE RECIPIENT (2026/08/31)
 * ---------------------------------------------------------------------
 * Until this date this sheet worked the other way round: whatever address was
 * pasted decided what was being sent — `mn_addr…` meant NIGHT, `mn_shield-addr…`
 * meant one of the shielded colours the account held — and the person sending
 * never chose. That reads fine with one token in the account and stops being
 * true the moment there are several: "right now I can only send NIGHT; I want
 * to be able to send mUSD, and any other asset I have going forward".
 *
 * So the FIRST field is the asset, offered from what this account actually
 * holds, and everything below it follows from that choice: which units the
 * amount is quoted in, what Max means, what the review step names, and — the
 * point — which recipients are valid. The list and the rules are in
 * `lib/sendAssets.ts`, where they can be drilled.
 *
 * The address taxonomy did NOT move. {@link classifyRecipient} still runs the
 * wallet SDK's own codec over whatever is in the field and still owns every
 * sentence about what an address is, whose network it belongs to, and which
 * ledger it names. What changed is what happens to its verdict: it is now
 * CHECKED AGAINST the chosen asset rather than used to pick one. A shielded
 * address pasted while NIGHT is chosen is refused in NIGHT's name — never
 * silently answered by switching the asset, which is the same wrong-send in a
 * new costume.
 *
 * NIGHT cannot be sent to a shielded address. `nativeToken()` is tagged
 * `unshielded`, the ledger keys its balance check by that tag, and the contract
 * keeps the two in separate maps. A shielded colour cannot be sent to an
 * unshielded one for the mirror-image reason. The two therefore quote different
 * balances, different units, and different refusals; what they share is the fee
 * sentence, because the fee is the same either way.
 *
 * THE RECIPIENT TYPE DECIDES TOO (2026/08/31, later the same day)
 * ----------------------------------------------------------------
 * The inversion above left one dead end behind it: a shielded asset was refused
 * a name outright, in a sentence claiming that a name is always paid in NIGHT.
 * That was true of what had been BUILT and not of the ledger — an account's
 * shielded deposit is as permissionless as its unshielded one — and the
 * dispatch made it structural as well as textual, because `handleSend` tested
 * the resolved name FIRST and the asset second, so the name branch shadowed the
 * shielded one whatever the rules said.
 *
 * Both are now decided by the PAIR. `routeFor` in `lib/sendAssets.ts` names the
 * four sends, the dispatch is a switch over its answer, and the shielded name
 * route has its own seam, {@link SendSheetProps.onSendShieldedToName}, whose
 * presence is what the rules are told about when they are asked whether a name
 * may be paid in a shielded asset. The agreed model then reads off the code
 * rather than off a comment: a shielded ADDRESS takes a withdrawal only, a
 * PASSPORT takes the account route, in either asset.
 *
 * It is still two transactions, and it is still said so before the confirm.
 *
 * The shielded assets exist only when the host supplies both
 * {@link SendSheetProps.readShieldedHoldings} and
 * {@link SendSheetProps.onSendShielded}. Without them the picker offers NIGHT
 * alone and a shielded address is refused, which is the honest answer when
 * nothing behind the sheet could act on one.
 *
 * The host mounts this ONLY while there is genuinely an account to withdraw
 * from. Without one there is no Send button at all — a control that cannot work
 * is absent, not disabled and lying about why.
 *
 * THE PRIMARY CONTROL IS ALWAYS RENDERED (2026/08/25)
 * ---------------------------------------------------
 * That rule is about the SHEET, not about a state inside it. Once this sheet is
 * open its primary button exists in every state it can reach — disabled and
 * labelled with what is being waited for, never removed. Removing it produced
 * exactly one thing, seen live: a modal with a grey paragraph, an X, and no
 * action of any kind, in a state (`available: 0` on the sponsor) that clears
 * itself inside a minute or two. The sheet now waits with the user — see
 * {@link startFeeReadinessPoll} — and enables the control the moment the
 * sponsor comes back, without the sheet being closed and reopened.
 */

const NIGHT_DECIMALS = 6

/**
 * One colour the account holds, and how much of it.
 *
 * `tokenType` is the raw ledger colour the contract's `coins` map is keyed by —
 * not a name, a symbol, or a contract. A shielded colour is minted by a
 * contract and carries no on-chain ticker and no on-chain decimal scale, so
 * `amount` is in that colour's own atomic units and nothing here invents a way
 * to make it prettier.
 */
export interface SendSheetHolding {
  tokenType: string
  amount: bigint
}

export interface SendSheetProps {
  /** The network a recipient must belong to. */
  networkId: string
  /**
   * Formatted NIGHT the ACCOUNT holds and can therefore withdraw. `null` means
   * genuinely not known yet.
   */
  availableBalance: string | null
  /**
   * Why the balance is `null`, when it is. `'unavailable'` is a read that
   * failed and disables sending; anything else while the balance is `null`
   * reads as a read still in flight. Optional, so a host with no status to
   * report gets the loading copy, never the failure one.
   */
  balanceStatus?: string
  /**
   * Where this wallet computes its proofs, so the progress line names the right
   * machine. `browser` proves in this tab; `http` proves on a proof server.
   * Either way it can take tens of seconds, which is what the line admits.
   */
  provingMode: LocalWalletProvingMode
  /**
   * Reads the wallet's own fee readiness — the advisory `feeReadiness()` probe.
   * Called when the sheet opens and every few seconds after that; its answer is
   * quoted, never paraphrased into a stronger claim.
   *
   * `force` skips the readiness cache. The sheet passes it always: a cached
   * verdict is exactly what a watcher must not have — a sponsor that came back
   * would go unnoticed for as long as the cache says nothing has changed.
   */
  readFeeReadiness: (options?: { force?: boolean }) => Promise<FeeReadiness>
  /**
   * Runs the withdrawal, resolving only once the node has taken it. Refusals
   * arrive as the account module's `AccountCustodyError` — `{ code, message,
   * detail? }` — and are shown untouched.
   */
  onSend: (params: { recipientAddress: string; amount: bigint }) => Promise<void>
  /**
   * Reads the shielded colours the ACCOUNT holds, in each colour's own atomic
   * units. Called ONCE, when the sheet opens — since 2026/08/31 the asset is
   * the first field, so what can be sent has to be known before anything is
   * typed rather than after a shielded address turns up. An empty array is a
   * real answer — this Passport's account holds nothing shielded — and the
   * picker then offers NIGHT alone.
   *
   * This is the AUTHORITY on what may be sent, and its answer is what a
   * shielded send is enabled against; {@link SendSheetProps.knownHoldings} only
   * lets the picker be drawn before it lands.
   *
   * Optional together with {@link SendSheetProps.onSendShielded}: a host that
   * supplies neither leaves shielded addresses refused.
   */
  readShieldedHoldings?: () => Promise<SendSheetHolding[]>
  /**
   * The shielded colours the host is ALREADY showing, so the asset picker can
   * be drawn on the first frame instead of after a network read.
   *
   * Advisory, and deliberately not trusted for a send: it is a mirror of the
   * same account state the host painted its balance list from, and it is
   * replaced the moment {@link SendSheetProps.readShieldedHoldings} answers.
   * Until it does, a shielded asset can be CHOSEN and read about but not sent
   * — the control says what it is waiting for — because a stale figure is not
   * something to check an amount against.
   */
  knownHoldings?: readonly SendSheetHolding[]
  /**
   * Runs the shielded withdrawal, resolving only once the node has taken it.
   * `recipientAddress` is the WHOLE `mn_shield-addr…` string: the note's
   * ciphertext is built client-side from the recipient's encryption key, and
   * only the full address carries it.
   */
  onSendShielded?: (params: {
    recipientAddress: string
    tokenType: string
    amount: bigint
  }) => Promise<void>
  /**
   * Asks the `.night` registry what one name points at.
   *
   * Resolves with a real ANSWER either way: `{ found: true }` with the account
   * the name leads to, or `{ found: false }` with the sentence to show. It
   * THROWS only when the registry could not be read at all, because "nobody
   * holds this name" and "we could not find out" are different things to tell
   * somebody about to send money.
   *
   * Optional together with {@link SendSheetProps.onSendToName}: a host that
   * supplies neither leaves the field address-only, exactly as it was before
   * 2026/08/30.
   */
  resolveName?: (domain: string) => Promise<NameLookup>
  /**
   * Pays the account a name resolves to.
   *
   * NOT a plain transfer to `accountAddress`, and the distinction is the whole
   * reason this is a separate seam from {@link SendSheetProps.onSend}: a
   * `withdraw_night` takes a `UserAddress`, and unshielded value sent to a
   * contract by any route other than its own `deposit_night` is invisible to
   * the balance mirror the recipient's Passport reads. The host's
   * implementation deposits INTO the recipient's account; see `App.tsx`.
   */
  onSendToName?: (params: {
    domain: string
    accountAddress: string
    amount: bigint
  }) => Promise<void>
  /**
   * Pays the account a name resolves to, in a SHIELDED asset.
   *
   * A separate seam from {@link SendSheetProps.onSendToName} for the same
   * reason that one is separate from {@link SendSheetProps.onSend}: it is a
   * different pair of circuits. The shielded withdrawal's recipient is a user
   * key BY TYPE, so it cannot name an account at all, and the way into an
   * account is its own permissionless deposit — which takes one whole note
   * rather than a colour and an amount. The host's implementation withdraws to
   * the sender's own shielded address for exactly this amount and then deposits
   * that note into the recipient's account; see `App.tsx`.
   *
   * Optional, and its absence is what decides the sheet's answer to "may a
   * shielded asset be paid to a name?" — a build without it refuses the
   * combination rather than offering a promise nothing behind the sheet could
   * keep. It also needs {@link SendSheetProps.resolveName}, without which
   * nothing is ever read as a name in the first place.
   */
  onSendShieldedToName?: (params: {
    domain: string
    accountAddress: string
    tokenType: string
    amount: bigint
  }) => Promise<void>
  /**
   * The colour the fee sponsor named for itself, when it named one.
   *
   * Passed so the picker calls a colour exactly what the balance list on Home
   * calls it. Two spellings of one colour read as two tokens, and the picker is
   * the surface where that becomes a wrong send rather than a puzzle.
   */
  sponsoredToken?: { colourHex: string; symbol: string } | null
  /**
   * The live phase of the account call, when the host reports one. It narrates
   * the wait rather than measuring it: the prover reports no figure, so no
   * percentage is invented.
   */
  phase?: 'checking' | 'connecting' | 'submitting' | 'confirming' | null
  /**
   * Which leg of a send-to-name is running, when the host reports one. A
   * name's transfer is two transactions — out of the sender's account, then
   * into the recipient's — and a progress line that hid the second would leave
   * somebody watching an apparently finished send carry on for another minute.
   *
   * `returning` is not a leg of the transfer at all: it is the amount being put
   * back after the paying leg refused, which the shielded path does because
   * there is no card on Home that could sweep a shielded amount back in. It is
   * narrated for the same reason the other three are — something is still
   * happening, and a spinner that said "Step 2 of 2" through it would be
   * describing a step that has already failed.
   */
  nameLeg?: 'withdrawing' | 'settling' | 'depositing' | 'returning' | null
  /**
   * Leaves the session for the landing screen — offered ONLY beside a failure
   * the host marked as a passkey ceremony that could not be completed.
   *
   * The send's approval IS a passkey assertion (it is what yields the device
   * secret `withdraw_night` is gated on), so the mid-session dead end reported
   * on 2026/08/31 for the name step can land here too: a passkey on another
   * device, the platform's cross-device sheet, and a refusal the sheet could
   * only report. `lib/passkeyRecovery.ts` holds the rule that decides, and
   * `PasskeyWayOut.tsx` the two controls; this is the seam for the one of them
   * the sheet cannot perform itself.
   */
  onSignOut?: () => void
  onClose: () => void
}

type Step = 'compose' | 'review'
/** Which ledger the pasted recipient belongs to — see the header comment. */
type Mode = 'unshielded' | 'shielded'

/**
 * How long the field is left alone before the registry is asked.
 *
 * Long enough that typing `alice.night` puts ONE question rather than eleven,
 * short enough that somebody who has stopped is not left wondering whether
 * anything is happening. The resolving state is shown from the first keystroke
 * either way, so the wait is never silent.
 */
const NAME_DEBOUNCE_MS = 400

/** Where the name in the field has got to. */
type NameState =
  | { status: 'idle' }
  | { status: 'resolving'; domain: string }
  | { status: 'found'; domain: string; accountAddress: string }
  /** The registry answered, and nobody holds it. A real answer, not a failure. */
  | { status: 'missing'; domain: string; reason: string }
  /** The registry could not be read. Different from nobody holding the name. */
  | { status: 'error'; domain: string; message: string }

function lookupToState(domain: string, lookup: NameLookup): NameState {
  return lookup.found
    ? { status: 'found', domain, accountAddress: lookup.accountAddress }
    : { status: 'missing', domain, reason: lookup.reason }
}

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

/* `shortToken` lived here until 2026/08/30, exported so Home could shorten a
   colour the same way. Both screens now go through `describeColour` in
   `lib/colour.ts`, which NAMES the colour where it can and falls back to
   `shortColour` where it cannot — one function, one spelling, and the
   shortening is a subtitle rather than the label. */

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
      error: `That address belongs to the ${recipientNetwork} network; your account is on ${networkId}.`,
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
    knownHoldings,
    onSendShielded,
    resolveName,
    onSendToName,
    onSendShieldedToName,
    sponsoredToken,
    phase,
    nameLeg,
    onSignOut,
    onClose,
  } = props

  const [step, setStep] = useState<Step>('compose')
  const [recipient, setRecipient] = useState('')
  const [scanning, setScanning] = useState(false)
  const [amountText, setAmountText] = useState('')
  const [busy, setBusy] = useState(false)
  /* `wayOut` is set when the host marked the refusal as a passkey ceremony that
     could not be completed — see `SendSheetProps.onSignOut`. It rides on the
     failure rather than in a state of its own so it can never outlive the
     failure it describes. */
  const [failure, setFailure] = useState<
    { message: string; detail: string | null; wayOut: boolean } | null
  >(null)
  const [showFullRecipient, setShowFullRecipient] = useState(false)
  const [fee, setFee] = useState<FeeReadiness | null>(null)
  const [feeUnknown, setFeeUnknown] = useState<string | null>(null)
  const [feeProbing, setFeeProbing] = useState(false)
  const [feeChanged, setFeeChanged] = useState(false)
  /* `null` while nothing has been read yet — never a stand-in for an account
     that holds nothing, which is `[]` and gets its own sentence. */
  const [holdings, setHoldings] = useState<SendSheetHolding[] | null>(null)
  const [holdingsError, setHoldingsError] = useState<string | null>(null)
  /* WHAT IS BEING SENT — the first field, and since 2026/08/31 a choice rather
     than something inferred from the recipient. NIGHT to begin with: it is the
     one asset every Passport can send, and a picker that opened on whatever
     happened to sort first would move under the thumb of somebody who had
     opened this sheet a hundred times. */
  const [assetId, setAssetId] = useState<string>(NIGHT_ASSET_ID)

  /* What the registry said about the name in the field, if there is one. */
  const [nameState, setNameState] = useState<NameState>({ status: 'idle' })
  /* What a SCANNED code claimed the name behind it points at, when it carried
     that claim. It is never spent to — the registry is the sole authority on
     what a name pays — and exists only so a code that disagrees with the
     registry can be refused rather than quietly obeyed by whichever half a
     reader happens to trust. Cleared whenever the field is typed into, because
     from that keystroke on the field is no longer what was scanned. */
  const [scannedClaim, setScannedClaim] = useState<{
    domain: string
    accountHex: string
  } | null>(null)

  const recipientRef = useRef<HTMLTextAreaElement | null>(null)
  const feePollRef = useRef<FeeReadinessPoll | null>(null)
  /* One question per name, for the LIFETIME OF THIS SHEET. A sheet closed and
     reopened asks again, which is what somebody who has just been told "no
     Passport has this name" would expect after going away to fix it. */
  const nameCache = useRef(createNameResolutionCache())

  const shieldedSupported = Boolean(readShieldedHoldings && onSendShielded)
  const nameSupported = Boolean(resolveName && onSendToName)
  /* WHAT THIS PASSPORT CAN DO, handed to the rules that decide where an asset
     may go. It is a fact about the HOST rather than about the ledger — the
     shielded deposit an account offers is as permissionless as the unshielded
     one — so the rules are told rather than left to infer it from the asset.
     See `lib/sendAssets.ts`. */
  const capabilities = useMemo(
    (): SendCapabilities => ({
      shieldedToName: Boolean(shieldedSupported && resolveName && onSendShieldedToName),
    }),
    [onSendShieldedToName, resolveName, shieldedSupported],
  )

  /* The fee sentence describes what will really happen, so the sponsor is
     probed when the sheet opens rather than assumed ready — and then KEPT
     probed, because the commonest reason it cannot pay is that its DUST is
     reserved against a transaction that is about to settle. Until the first
     answer, nothing is said about the fee.

     Paused while a transfer is in flight: the sponsor is busy balancing OUR
     transaction then, so a tick would report `available: 0` and rewrite the fee
     line into a refusal for the very send that is succeeding. */
  useEffect(() => {
    if (busy) return
    const poll = startFeeReadinessPoll({
      probe: () => readFeeReadiness({ force: true }),
      onChange: (snapshot) => {
        setFee(snapshot.fee)
        setFeeUnknown(snapshot.error)
        setFeeProbing(snapshot.probing)
      },
    })
    feePollRef.current = poll
    return () => {
      poll.stop()
      feePollRef.current = null
    }
  }, [busy, readFeeReadiness])

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

  /* Which of the two vocabularies is in the field. A host with no name seam
     gets `address` for everything, so the sheet behaves exactly as it did
     before names existed. */
  const typed = useMemo(
    () => (nameSupported ? classifyRecipientInput(recipient) : null),
    [nameSupported, recipient],
  )
  const nameMode = typed?.kind === 'name' || typed?.kind === 'name-invalid'
  const typedDomain = typed?.kind === 'name' ? typed.domain : null

  /**
   * The registry read, debounced.
   *
   * Nothing is asked on a keystroke: the timer is cleared and restarted by
   * every change, so the question is only put once somebody has stopped typing.
   * A name already answered in this sheet is answered from memory with no
   * network read at all — including a "nobody holds this", which is a real
   * answer the registry gave and not a failure to re-try.
   *
   * A read that FAILS is never cached. Remembering "the network was down"
   * would keep saying so after it came back.
   */
  useEffect(() => {
    if (!resolveName || !typedDomain) {
      setNameState({ status: 'idle' })
      return undefined
    }
    const remembered = nameCache.current.get(typedDomain)
    if (remembered) {
      setNameState(lookupToState(typedDomain, remembered))
      return undefined
    }
    let live = true
    setNameState({ status: 'resolving', domain: typedDomain })
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const lookup = await resolveName(typedDomain)
          if (!live) return
          nameCache.current.set(typedDomain, lookup)
          setNameState(lookupToState(typedDomain, lookup))
        } catch (cause) {
          if (!live) return
          setNameState({ status: 'error', domain: typedDomain, message: messageOf(cause) })
        }
      })()
    }, NAME_DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [resolveName, typedDomain])

  /* WHAT THIS ACCOUNT CAN SEND, read when the sheet OPENS.

     It used to be read only once a shielded address had turned up, on the
     reasoning that somebody sending NIGHT should not pay for a query they will
     never look at. That reasoning belonged to a sheet where the address came
     first. The asset is now the first field, so the list has to exist before
     anything is typed — and there is nothing to look at at all until it does. */
  useEffect(() => {
    if (!readShieldedHoldings) return undefined
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
  }, [readShieldedHoldings])

  /* What the picker draws from. The host's own mirror of the account gets the
     picker on screen in the first frame; the read above replaces it and is what
     a send is actually enabled against — see `knownHoldings`. */
  const pickerHoldings = holdings ?? knownHoldings ?? null
  /* Whether the authoritative read is still in flight. Distinct from an account
     that holds nothing, which is `[]`, and from a read that failed. */
  const holdingsPending = shieldedSupported && holdings === null && holdingsError === null

  const assets = useMemo(
    () =>
      buildSendAssets({
        nightBalance: atomicFromFormatted(availableBalance),
        /* Without both shielded seams there is no shielded send to offer, so
           the picker offers NIGHT alone rather than options that would be
           refused on confirming. */
        holdings: shieldedSupported ? pickerHoldings : [],
        sponsored: sponsoredToken ?? null,
      }),
    [availableBalance, pickerHoldings, shieldedSupported, sponsoredToken],
  )
  /* The selection is DERIVED, not corrected by an effect. A colour that goes
     away between the host's mirror and the authoritative read falls back to
     NIGHT for as long as it is missing and is honoured again the moment it
     comes back — where an effect would have overwritten the choice for good.
     NIGHT is always present, so this can never be undefined. */
  const asset: SendAsset = assets.find((entry) => entry.id === assetId) ?? assets[0]
  const tokenType = asset.tokenType
  /* Which ledger is being spent from — now a consequence of the choice above,
     where until 2026/08/31 it was a consequence of the recipient. */
  const mode: Mode = asset.mode

  const verdict = useMemo(
    () => (nameMode ? null : classifyRecipient(recipient, networkId, shieldedSupported)),
    [nameMode, networkId, recipient, shieldedSupported],
  )
  /* A name earns the NAME's refusals; an address earns the codec's. Mixing the
     two is how somebody gets told "that is not a Midnight address" about a
     name they typed correctly. */
  /* The scanned code's claim, checked against the answer that actually decides
     where money goes. A code naming Alice and carrying somebody else's account
     is either stale or hostile, and neither is worth guessing about: the sheet
     refuses and says so, rather than picking a winner. */
  const scannedClaimBroken =
    scannedClaim !== null &&
    nameState.status === 'found' &&
    nameState.domain === scannedClaim.domain &&
    /* Both sides through the SAME rule, so a leading `0x` on either one is not
       mistaken for a disagreement. */
    normalisedAccountHex(nameState.accountAddress) !== scannedClaim.accountHex
      ? `That code does not match what ${scannedClaim.domain} points at now. Ask for a fresh code before sending anything.`
      : null
  const nameError =
    typed?.kind === 'name-invalid'
      ? typed.reason
      : nameState.status === 'missing'
        ? nameState.reason
        : nameState.status === 'error'
          ? nameState.message
          : scannedClaimBroken
  /* THE CHOSEN ASSET, CHECKED AGAINST WHAT IS IN THE FIELD.

     `classifyRecipient` still owns the address taxonomy; this only asks whether
     its verdict and the selection can go together. A mismatch is REFUSED in the
     asset's own name — never answered by switching the asset to suit the
     address, which is the silent wrong-send the picker exists to replace. See
     `lib/sendAssets.ts` for both sentences. */
  const assetRefusal = nameMode
    ? refusalFor(asset, { kind: 'name' }, capabilities)
    : verdict && 'mode' in verdict
      ? refusalFor(asset, { kind: 'address', mode: verdict.mode }, capabilities)
      : null
  /* The asset's refusal LEADS on the name path: told that mUSD cannot go to a
     name at all, "no Passport has this name" is an answer to a question they
     are no longer asking. On the address path the codec speaks first, because
     "that is not a Midnight address" is about the string itself and comes
     before anything can be said about where it would have gone. */
  const recipientError = nameMode
    ? (assetRefusal ?? nameError)
    : verdict && 'error' in verdict
      ? verdict.error
      : assetRefusal
  const resolvedName = nameState.status === 'found' ? nameState : null

  /* WHICH OF THE FOUR SENDS THIS IS — decided by the PAIR, not by the recipient
     alone. Until 2026/08/31 `handleSend` tested `resolvedName` first and the
     asset second, so a shielded asset paid to a name could not be reached even
     if the rules had allowed it: the name branch shadowed the shielded one. The
     dispatch now reads off the same rule the refusal above does, which is the
     only shape in which all four combinations are visible at once. `null` while
     the two do not go together — the sentence for that is the refusal's. */
  const sendRoute =
    resolvedName !== null
      ? routeFor(asset, { kind: 'name' }, capabilities)
      : verdict && 'mode' in verdict
        ? routeFor(asset, { kind: 'address', mode: verdict.mode }, capabilities)
        : null

  /* An item is sent whole or not at all — the rule that made it an item is that
     the account holds exactly one — so the amount is STATED rather than typed,
     and what was typed for the last asset does not leak into it. */
  const amountLocked = asset.amountCap !== null
  const effectiveAmountText = asset.amountCap !== null ? asset.amountCap.toString() : amountText

  const availableAtomic = asset.available
  const parsedAmount = useMemo(() => {
    if (!effectiveAmountText.trim()) return null
    return mode === 'shielded'
      ? parseShieldedUnits(effectiveAmountText)
      : parseNight(effectiveAmountText)
  }, [effectiveAmountText, mode])
  const amountError = useMemo(() => {
    if (!parsedAmount) return null
    if ('error' in parsedAmount) return parsedAmount.error
    if (availableAtomic !== null && parsedAmount.amount > availableAtomic) {
      return mode === 'shielded'
        ? `That is more than your account holds — ${availableAtomic.toString()} ${asset.symbol} available.`
        : `That is more than your account holds — ${availableBalance} NIGHT is available.`
    }
    return null
  }, [asset.symbol, availableAtomic, availableBalance, mode, parsedAmount])

  const amount = parsedAmount && !('error' in parsedAmount) ? parsedAmount.amount : null
  /* A name is not "ready" merely because it is well formed: it is ready when
     the registry has said what it points at. Anything less would let somebody
     press Review against a name nobody holds. */
  const recipientReady =
    recipient.trim().length > 0 &&
    recipientError === null &&
    (!nameMode || resolvedName !== null)
  /* A balance Passport tried and failed to read off the account. Distinct from
     one still in flight: with no ceiling to compare against, sending stays
     disabled rather than proceeding uncapped. The shielded read has the same
     two states, and an empty holdings list is neither — it is an account known
     to hold nothing. */
  const balanceUnreadable =
    mode === 'shielded'
      ? holdingsError !== null || holdings === null
      : availableBalance === null && balanceStatus === 'unavailable'
  /* An account with nothing shielded in it no longer needs a state of its own.
     It is simply an account with one asset to choose from, said by the picker
     above rather than by a disabled control at the bottom of the sheet. */
  const canReview =
    recipientReady &&
    amount !== null &&
    amountError === null &&
    !balanceUnreadable &&
    (mode === 'unshielded' || tokenType !== null)

  /* The fee note, and the one place on this surface where the machinery is
     deliberately not named.

     It says only what the probe reported, and as the prediction it is:
     `feeReadiness()` is advisory and a sponsor can drain between this quote and
     the submit, so `sponsored` earns "expected to be covered" and nothing
     stronger. There are two sentences because there are two outcomes: the
     sponsor covers this transfer, or it does not and nothing is sent. The user
     is never the second payer, so no sentence here names a token they would
     have to hold, and none of them invites a top-up. */
  const feeNote =
    fee === null
      ? feeUnknown
        ? `Passport could not check the fee sponsor: ${feeUnknown}`
        : 'Checking with the fee sponsor…'
      : fee.mode === 'sponsored'
        ? 'Network fee expected to be covered by the fee sponsor.'
        : /* The sponsor's own refusal SENTENCE, verbatim — which since
             2026/08/25 is the sentence only. The diagnostic that used to be
             joined onto it ("0/1 wallets available (#0 dust …)") is a fact
             about a wallet the user does not own, and it now goes to
             `console.info` from the watcher instead. */ fee.reason

  const feeBlocksSend = fee?.mode === 'unsponsored'
  const feeCause = fee?.mode === 'unsponsored' ? fee.cause : null

  /* What the primary control says while it waits. A blocked control still says
     what it is waiting FOR — "disabled" on its own is the thing that reads as
     broken. `disabled` is the one cause nothing is coming for, so it does not
     promise a wait. */
  const blockedPrimaryLabel =
    feeCause === 'disabled' ? 'No fee sponsor on this build' : 'Waiting for the fee sponsor…'

  /* The line under the control, and the one place that says how long. `busy` is
     the transient state and says so; `unreachable` makes no promise it cannot
     keep. Both keep polling underneath. */
  const feeWaitLine =
    feeCause === 'busy'
      ? 'The fee sponsor is busy — this usually clears within a minute.'
      : feeCause === 'unreachable'
        ? 'The fee sponsor cannot be reached right now.'
        : feeCause === 'disabled'
          ? 'This build has no fee sponsor, so nothing can be submitted from it.'
          : null

  const checkAgain = () => feePollRef.current?.checkAgain()

  /**
   * What the sheet says while the transfer is in flight.
   *
   * Each sentence describes the step the account module says it is on, and
   * nothing further ahead: `connecting` is a real read of the deployed
   * contract's verifier keys, `submitting` covers build-prove-balance-sign-
   * submit and is the long one, and `confirming` is the indexer being asked for
   * the ledger hash — by which point the transaction is already finalised. Only
   * that step names where proving happened; the others have not reached it.
   */
  const busyLine =
    phase === 'checking'
      ? 'Checking your account’s balance and the fee sponsor.'
      : phase === 'connecting'
        ? 'Opening your account and checking it against this build.'
        : phase === 'confirming'
          ? 'Submitted. Waiting for the network to report the transaction.'
          : provingMode === 'http'
            ? 'Proving and submitting. The proof is computed on the proof server and can take tens of seconds — leave this open.'
            : 'Proving and submitting. The proof is computed on this device and can take tens of seconds — leave this open.'

  /**
   * The second line, for a name, and the reason there is one.
   *
   * Paying a name is two transactions, and the person watching has to be told
   * that before the first one finishes — otherwise the sheet looks done and
   * then carries on for another minute. It says which of the two is running
   * and never claims the money has arrived until the second has.
   */
  const nameLegLine =
    resolvedName === null
      ? null
      : nameLeg === 'withdrawing'
        ? `Step 1 of 2 — taking the amount out of your account.`
        : nameLeg === 'settling'
          ? 'Step 1 of 2 done. Waiting for the amount to clear before it goes on.'
          : nameLeg === 'depositing'
            ? `Step 2 of 2 — paying it into ${resolvedName.domain}’s account.`
            : nameLeg === 'returning'
              ? /* Not a step of the transfer: the paying leg refused, and the
                   amount is being put back. Said plainly and immediately,
                   because the alternative is a spinner still claiming "Step 2
                   of 2" over a step that has already failed. */
                `${resolvedName.domain} was not paid. Putting the amount back into your account.`
              : null

  const handleMax = useCallback(() => {
    if (mode === 'shielded') {
      if (asset.available === null) return
      setAmountText(asset.available.toString())
      return
    }
    /* The formatted string, not the atomic figure re-formatted: it is the exact
       decimal the account reported, so nothing is lost on the round trip. */
    if (availableBalance === null) return
    setAmountText(availableBalance)
  }, [asset.available, availableBalance, mode])

  const handleSend = useCallback(async () => {
    if (amount === null || !recipientReady || busy) return
    setBusy(true)
    setFailure(null)
    setFeeChanged(false)
    /* The fee quote was read when the sheet opened and is only a prediction —
       a sponsor can drain in the meantime, and the send would then be refused
       rather than billed to anyone. Re-read before submitting; a different
       answer means the quoted sentence is no longer true, so nothing is sent
       until it has been confirmed against the new one. A probe that fails
       outright is handled the same way: the line falls back to "could not
       check", and a second confirm against that sentence — the modes then
       match — proceeds, because the probe is advisory and the send path keeps
       its own authoritative checks. */
    const quotedMode = fee?.mode ?? null
    let recheckedMode: FeeReadiness['mode'] | null
    try {
      const readiness = await readFeeReadiness({ force: true })
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
      /* ONE DISPATCH, ON THE PAIR. Every seam it can reach is re-read on the
         way in: `canReview` already required each of them, and re-reading is
         what makes it impossible for a branch to be entered on a `null` that
         changed between the render that enabled the button and this click. */
      if (sendRoute === 'shielded-name') {
        if (!onSendShieldedToName || tokenType === null || resolvedName === null) {
          throw new Error('This Passport cannot pay a name in this asset right now.')
        }
        await onSendShieldedToName({
          domain: resolvedName.domain,
          accountAddress: resolvedName.accountAddress,
          tokenType,
          amount,
        })
      } else if (sendRoute === 'night-name') {
        if (!onSendToName || resolvedName === null) {
          throw new Error('This Passport cannot send to a name right now.')
        }
        await onSendToName({
          domain: resolvedName.domain,
          accountAddress: resolvedName.accountAddress,
          amount,
        })
      } else if (sendRoute === 'shielded-address') {
        if (!onSendShielded || tokenType === null) {
          throw new Error('This Passport cannot send a shielded token right now.')
        }
        await onSendShielded({ recipientAddress: recipient.trim(), tokenType, amount })
      } else if (sendRoute === 'night-address') {
        await onSend({ recipientAddress: recipient.trim(), amount })
      } else {
        /* Unreachable behind `recipientReady`, and deliberately not a silent
           fall-through to the plain send: a pair with no route is a pair the
           rules refused, and quietly sending it somewhere is the wrong-send
           this whole dispatch exists to make impossible. */
        throw new Error('This Passport cannot make that transfer.')
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
      setFailure({
        message: messageOf(cause),
        detail: detailOf(cause),
        /* The host's own reading of the failure, never this sheet's: only the
           host saw the ceremony. See `lib/passkeyRecovery.ts`. */
        wayOut: isMidSessionWayOut(cause),
      })
    }
  }, [
    amount,
    busy,
    fee,
    onClose,
    onSend,
    onSendShielded,
    onSendShieldedToName,
    onSendToName,
    readFeeReadiness,
    recipient,
    recipientReady,
    resolvedName,
    sendRoute,
    tokenType,
  ])

  /* One row, rendered under whichever primary control is on screen. */
  const feeWaitRow = feeWaitLine ? (
    <p className="mnhome-send-wait" role="status">
      <span>{feeWaitLine}</span>
      {feeCause === 'disabled' ? null : (
        <button
          type="button"
          className="mnhome-send-recheck"
          onClick={checkAgain}
          /* No dead controls on this surface — which is the whole point of the
             defect this row exists for. There is nothing to ask while a probe
             is already running, and nothing watching at all while a transfer is
             in flight, so in both states the control says so. */
          disabled={feeProbing || busy}
        >
          {feeProbing ? 'Checking…' : 'Check again'}
        </button>
      )}
    </p>
  ) : null

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
            {/* The heading names the CHOSEN asset, because that is now the
                first thing decided on this sheet rather than the last thing
                inferred from it. */}
            {step === 'review' ? 'Review this transfer' : `Send ${asset.symbol}`}
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
            {/* THE FIRST FIELD (2026/08/31). What is being sent is a choice,
                made before the recipient, and it is what decides which
                recipients the field below will accept. With one asset there is
                nothing to choose, so it is STATED rather than offered as a
                control with a single option in it. */}
            {assets.length > 1 ? (
              <label className="mnhome-send-field">
                <span className="mnhome-send-label">Asset</span>
                <select
                  className="mnhome-send-input mnhome-send-asset"
                  value={asset.id}
                  onChange={(event) => {
                    setAssetId(event.target.value)
                    /* THE AMOUNT BELONGS TO THE ASSET. "100" means a hundred of
                       whatever was chosen when it was typed, and carrying it
                       across is how "100 mUSD" quietly becomes "100 NIGHT" on
                       an account that can afford both. Cleared here rather than
                       recomputed: there is no honest conversion between two
                       colours, so the only safe amount for a new asset is one
                       the person types for it. The recipient is NOT cleared —
                       a mismatched one earns a sentence saying so, which is
                       the whole point of choosing the asset first. */
                    setAmountText('')
                  }}
                  disabled={busy}
                >
                  {assets.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.symbol}
                      {' — '}
                      {entry.available === null
                        ? 'balance not known yet'
                        : entry.id === NIGHT_ASSET_ID
                          ? `${availableBalance ?? formatNight(entry.available)} available`
                          : entry.kind === 'nft'
                            ? 'one held'
                            : `${entry.available.toString()} available`}
                    </option>
                  ))}
                </select>
                <span className="mnhome-send-hint">
                  {asset.kind === 'nft'
                    ? `A one-of-a-kind item. It goes whole — there is one of it, so the amount below is fixed at one. Its colour is ${asset.name}.`
                    : asset.id === NIGHT_ASSET_ID
                      ? 'Everything your account holds is here. NIGHT goes to a Midnight name or to an unshielded address.'
                      : capabilities.shieldedToName
                        ? /* True since the shielded name route landed. It read
                             "cannot be paid to a name" before that, which was a
                             fact about what had been built and was said as a
                             fact about the ledger. */
                          `Everything your account holds is here. ${asset.symbol} goes to a Midnight name or to a shielded address.`
                        : `Everything your account holds is here. ${asset.symbol} goes to a shielded address.`}
                </span>
              </label>
            ) : (
              /* A `div`, not a `label`: with one asset there is no control to
                 label — it is stated. The sentence says WHY there is only one,
                 and which of the three reasons applies. */
              <div className="mnhome-send-field">
                <span className="mnhome-send-label">Asset</span>
                <span className="mnhome-send-hint">
                  <strong>{asset.symbol}</strong>
                  {holdingsPending
                    ? ' — still checking what else this Passport’s account holds.'
                    : holdingsError !== null
                      ? ' — what else this Passport’s account holds could not be read just now, so nothing else is offered.'
                      : ' — the only asset this Passport’s account holds.'}
                </span>
              </div>
            )}

            <label className="mnhome-send-field">
              <span className="mnhome-send-label">
                Recipient
                {/* The scanner — a camera, or an image of a code on a machine
                    with no camera — fills this field; it never bypasses it.
                    Whatever it hands over meets the same validator a pasted
                    address does and the same registry read a typed name does,
                    so a scanned wrong-network address gets the same honest
                    sentence. */}
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
                onChange={(event) => {
                  setRecipient(event.target.value)
                  // Typed into: whatever was scanned no longer describes it.
                  setScannedClaim(null)
                }}
                /* The placeholder follows the CHOSEN asset too. It offered
                   `alice.night` whatever was selected, which invited into the
                   field the one thing a shielded asset can never be paid to. */
                placeholder={
                  /* A name leads wherever a name can be paid, in either asset:
                     it is the recipient Passport is FOR, and the address form
                     is what somebody falls back to. It stops leading only where
                     the chosen asset genuinely cannot reach a name. */
                  capabilities.shieldedToName && mode === 'shielded'
                    ? 'alice.night'
                    : mode === 'shielded'
                      ? `mn_shield-addr_${networkId}1…`
                      : nameSupported
                        ? 'alice.night'
                        : `mn_addr_${networkId}1…`
                }
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
              ) : nameState.status === 'resolving' ? (
                <span className="mnhome-send-hint mnhome-send-resolving" role="status">
                  <Loader2 className="mnhome-send-spinner" size={12} aria-hidden="true" />
                  <span>Looking up {nameState.domain}…</span>
                </span>
              ) : resolvedName !== null ? (
                /* The confirmation chip. The NAME is the identity; the account
                   it found appears only as its last four characters — enough to
                   tell two resolutions apart, far too few to mistake for an
                   address, and the full one never renders anywhere on this
                   sheet. */
                <span className="mnhome-send-resolved" role="status">
                  <Check size={12} aria-hidden="true" />
                  <span>
                    {resolvedName.domain} → account{' '}
                    <code>{accountTail(resolvedName.accountAddress)}</code>
                  </span>
                </span>
              ) : nameMode ? (
                <span className="mnhome-send-hint">
                  A Midnight name, with or without the <code>.night</code>. Passport finds the
                  account behind it — you never need their address.
                </span>
              ) : mode === 'shielded' ? (
                /* The hint follows the CHOSEN asset, so it names what will be
                   accepted rather than listing everything and leaving the
                   refusal to do the teaching. A name is named FIRST where one
                   can be paid: it is the recipient Passport exists for, and an
                   address is the fallback. */
                capabilities.shieldedToName ? (
                  <span className="mnhome-send-hint">
                    A Midnight name, or a shielded (mn_shield-addr…) {networkId} address — the
                    two things {asset.symbol} can go to. Nothing is guessed from a partial
                    address.
                  </span>
                ) : (
                  <span className="mnhome-send-hint">
                    A shielded (mn_shield-addr…) {networkId} address — the only kind{' '}
                    {asset.symbol} can go to. Paste it; nothing is guessed from a partial one.
                  </span>
                )
              ) : (
                <span className="mnhome-send-hint">
                  {nameSupported ? 'A Midnight name, or an' : 'An'} unshielded (mn_addr…){' '}
                  {networkId} address. Paste it — nothing is guessed from a partial one.
                </span>
              )}
            </label>

            <label className="mnhome-send-field">
              <span className="mnhome-send-label">
                Amount
                {/* Max means "everything your account holds". With nothing held,
                    and with the balance not yet known, there is no such figure —
                    the hint line below already says which of the two it is. */}
                <button
                  type="button"
                  className="mnhome-send-max"
                  onClick={handleMax}
                  /* Its own name. A button nested inside a `<label>` inherits
                     that label as its accessible name, so this one announced
                     itself as "Amount mUSD 100 mUSD available. A shielded token
                     carries no decimal scale…" — the whole field read out for a
                     control that does one thing. */
                  aria-label={`Send the whole ${asset.symbol} balance`}
                  /* Nothing to fill in for an item — the amount is already the
                     only one it can be — and nothing to fill in from a balance
                     that is zero or not yet known. */
                  disabled={amountLocked || availableAtomic === null || availableAtomic === 0n}
                >
                  Max
                </button>
              </span>
              <span className="mnhome-send-amount">
                <input
                  className="mnhome-send-input"
                  value={effectiveAmountText}
                  onChange={(event) => setAmountText(event.target.value)}
                  placeholder={mode === 'shielded' ? '0' : '0.0'}
                  inputMode={mode === 'shielded' ? 'numeric' : 'decimal'}
                  spellCheck={false}
                  /* Rendered, filled in, and not editable — the house rule for
                     a control that cannot be used, with the sentence beneath
                     saying why. Removing the field would leave the review step
                     quoting an amount nothing on this screen had shown. */
                  readOnly={amountLocked}
                  aria-invalid={amountError !== null}
                  aria-describedby={amountError ? 'mnhome-send-amount-error' : undefined}
                />
                {/* The chosen asset's own ticker, where until 2026/08/31 this
                    read the fixed word "units" and named nothing. An item says
                    "item" instead: its handle is `Item · abab…`, which is a
                    label rather than a unit, and it is already on the field
                    above and on the review step. */}
                <span className="mnhome-send-unit">
                  {asset.kind === 'nft' ? 'item' : asset.symbol}
                </span>
              </span>
              {amountError ? (
                <span className="mnhome-send-error" id="mnhome-send-amount-error" role="alert">
                  {amountError}
                </span>
              ) : amountLocked ? (
                <span className="mnhome-send-hint">
                  There is one of this item, so one is what goes. Nothing here divides.
                </span>
              ) : mode === 'shielded' ? (
                <span className="mnhome-send-hint">
                  {holdingsError !== null
                    ? `What this Passport’s account holds could not be read just now, so sending is disabled until it can be: ${holdingsError}`
                    : holdings === null
                      ? `Checking what your account holds. ${asset.symbol} can be chosen now and sent once that answers.`
                      : `${(asset.available ?? 0n).toString()} ${asset.symbol} available. A shielded token carries no decimal scale on the ledger, so this is a whole-unit count. The network fee does not come out of it, so the whole balance can go.`}
                </span>
              ) : (
                <span className="mnhome-send-hint">
                  {availableBalance === null
                    ? balanceUnreadable
                      ? 'The balance could not be read, so sending is disabled until it can be.'
                      : 'Your balance is still being read, so nothing is capped yet.'
                    : `${availableBalance} NIGHT available in your account. The network fee does not come out of it, so the whole balance can go.`}
                </span>
              )}
            </label>

            <p className={`mnhome-send-fee${feeBlocksSend ? ' mnhome-send-fee-blocked' : ''}`}>
              {feeNote}
            </p>

            {/* ALWAYS RENDERED. When the fee cannot be paid this is disabled
                and says what it is waiting for, and the row beneath it says how
                long and offers a re-check. It used to be removed outright,
                which left a sheet with no action in it at all for a state that
                clears itself. */}
            <button
              type="button"
              className="mnhome-send-primary"
              onClick={() => {
                setShowFullRecipient(false)
                setFailure(null)
                setFeeChanged(false)
                setStep('review')
              }}
              disabled={!canReview || feeBlocksSend}
            >
              {feeBlocksSend ? (
                <span>{blockedPrimaryLabel}</span>
              ) : (
                <>
                  <span>Review</span>
                  <ArrowRight size={15} aria-hidden="true" />
                </>
              )}
            </button>
            {feeWaitRow}
          </div>
        ) : (
          <div className="mnhome-send-form">
            <dl className="mnhome-send-rows">
              {/* THE ASSET LEADS THE REVIEW, because it is what was chosen
                  first. It is named here whether or not it is shielded: the
                  row used to appear only for a shielded send, which left the
                  one thing the user picked off the summary of what they picked
                  whenever they picked NIGHT. */}
              <div className="mnhome-send-row">
                <dt>Asset</dt>
                <dd>
                  {/* NEVER the raw colour. This row used to print all 64
                      characters underneath the shortened form, which is the one
                      place on the review step a reader could mistake a colour
                      for something they should check. */}
                  <strong>{asset.symbol}</strong>
                  <small>{asset.kind === 'nft' ? `A one-of-a-kind item — ${asset.name}` : asset.name}</small>
                </dd>
              </div>
              <div className="mnhome-send-row">
                <dt>Amount</dt>
                <dd>
                  <strong>
                    {amount === null
                      ? '—'
                      : mode === 'shielded'
                        ? `${amount.toString()} ${asset.symbol}`
                        : `${formatNight(amount)} NIGHT`}
                  </strong>
                  <small>
                    {amount === null
                      ? ''
                      : asset.kind === 'nft'
                        ? 'There is one of it, and it goes whole.'
                        : mode === 'shielded'
                          ? /* There is no second scale to convert to: the figure
                               above already IS the ledger's own count. */
                            'A shielded token has no decimal scale on the ledger.'
                          : `${amount.toString()} atomic ${amount === 1n ? 'unit' : 'units'}`}
                  </small>
                </dd>
              </div>
              <div className="mnhome-send-row">
                <dt>Recipient</dt>
                <dd>
                  {resolvedName !== null ? (
                    /* THE NAME, AND NOTHING ELSE. There is no reveal here and
                       no address to reveal: the name is what was typed, it is
                       what the registry answered for, and printing the account
                       behind it would put back the one thing the account model
                       exists to take away. */
                    <>
                      <strong>{resolvedName.domain}</strong>
                      <small>
                        {/* The tail is held together on one line. An ellipsis
                            is a break opportunity in CSS, so "ending …" and
                            "5263" would otherwise land on separate lines and
                            read as two different things. */}
                        Their Passport account, ending{' '}
                        <span className="mnhome-send-tail">
                          {accountTail(resolvedName.accountAddress)}
                        </span>
                      </small>
                    </>
                  ) : (
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
                  )}
                </dd>
              </div>
              {resolvedName !== null ? (
                /* Said before the confirm, not after it: paying a name is two
                   transactions, and somebody who is about to wait through both
                   should know that is what they are waiting for. */
                <div className="mnhome-send-row">
                  <dt>How it goes</dt>
                  <dd>
                    <strong>Two steps</strong>
                    <small>
                      The amount leaves your account, then it is paid into theirs. Both are
                      network transactions, so this takes longer than sending to an address.
                    </small>
                  </dd>
                </div>
              ) : null}
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
              /* A div rather than the `<p>` this used to be, so the way out can
                 stand under the sentence instead of inside it. The sentence is
                 unchanged, and it still LEADS with the fact that matters most
                 to somebody who cancelled deliberately: nothing moved. */
              <div
                className={`mnhome-notice${
                  failure.wayOut && onSignOut ? ' mnhome-notice-stacked' : ''
                }`}
                role="alert"
              >
                <AlertTriangle size={14} aria-hidden="true" />
                <span>
                  Nothing was sent —{' '}
                  {asset.kind === 'nft'
                    ? 'the item is still in your account'
                    : `no ${asset.symbol} moved from your account`}
                  . {failure.message}
                  {failure.detail ? ` ${failure.detail}` : ''}
                </span>
                {/* The passkey could not be used, and this sheet's own Send
                    button is behind a Back click from here — so the retry is
                    put where the failure is read. Not a toast: the way out of a
                    dead end may not expire after five seconds. */}
                {failure.wayOut && onSignOut ? (
                  <PasskeyWayOutActions
                    onRetry={() => void handleSend()}
                    onSignOut={onSignOut}
                    busy={busy}
                  />
                ) : null}
              </div>
            ) : null}

            {busy ? (
              /* An honest progress line, not a percentage nobody measured: the
                 proving step reports no figure, so none is invented. It names
                 the phase the account module actually reports, where the work
                 happens, and that it genuinely takes time. */
              <p className="mnhome-send-busy" role="status">
                <Loader2 className="mnhome-send-spinner" size={14} aria-hidden="true" />
                <span>
                  {nameLegLine ? (
                    <>
                      <strong>{nameLegLine}</strong>
                      <br />
                    </>
                  ) : null}
                  {busyLine}
                </span>
              </p>
            ) : null}

            {feeWaitRow}

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
                disabled={busy || !canReview || feeBlocksSend}
              >
                {busy ? (
                  <>
                    <Loader2 className="mnhome-send-spinner" size={15} aria-hidden="true" />
                    <span>Sending…</span>
                  </>
                ) : feeBlocksSend ? (
                  /* The sponsor stood down between Review and here. The control
                     stays, disabled, and the row above says what it waits for. */
                  <span>{blockedPrimaryLabel}</span>
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
          onResult={(payload) => {
            /* A name goes into the field as a NAME, so the registry read and
               the confirmation chip happen exactly as they would for a typed
               one. The account the code carried, if it carried one, is kept
               only to check that answer against — never as a destination. */
            setRecipient(payload.kind === 'name' ? payload.domain : payload.address)
            setScannedClaim(
              payload.kind === 'name' && payload.accountHex !== null
                ? { domain: payload.domain, accountHex: payload.accountHex }
                : null,
            )
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
