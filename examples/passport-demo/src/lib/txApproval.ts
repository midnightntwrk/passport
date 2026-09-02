/**
 * The transaction-approval ladder, shared by Passport's two approval surfaces.
 *
 * Passport can be asked to pay over two channels: the in-app browser
 * (`screens/AppBrowser.tsx`, where the app is a framed iframe and Passport is
 * `window.parent`) and the popup consent surface (`txConsent.tsx`, where the
 * app is an ordinary tab and Passport is the window it opened). The channel
 * differs; what the user is agreeing to must not. This module is the single
 * definition of:
 *
 *   - the ladder of refusals a request must survive before a sheet is shown,
 *     in one fixed order;
 *   - the exact atomic → display NIGHT conversion the sheet quotes;
 *   - the mapping from a wallet failure onto the bridge's fixed error
 *     vocabulary;
 *   - the two sentences of sheet copy that state what approving actually does.
 *
 * Nothing here touches the DOM, React, or a wallet: it is pure, so both
 * surfaces can call it from wherever they need to and neither can drift from
 * the other. Extracted verbatim from `AppBrowser.tsx` on 2026/08/07 — the
 * strings, the order of the checks, and the codes are unchanged, deliberately,
 * because an app already handles them.
 */

import {
  mainnet,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk/address-format'
import type { PassportTxRequest, PassportTxResponse } from '../backend.js'
import { explorerTxUrl } from './networks.js'

const NIGHT_DECIMALS = 6

/** The app's own parser rejects a reply whose `detail` runs past this. */
const DETAIL_CAP = 400

/** The reply body, minus the five fields `createPassportTxResponse` binds. */
export type PassportTxResponseBody = Omit<
  PassportTxResponse,
  'protocol' | 'type' | 'version' | 'requestId' | 'nonce'
>

/**
 * The wallet the approval sheet is describing. `networkId` is the network a
 * recipient address must belong to; `formattedBalance` is NIGHT in display
 * units, or null while it is still unknown (the sheet then says so).
 */
export interface PassportTransferContext {
  networkId: string
  formattedBalance: string | null
}

/** What the surface knows at the moment a request lands. */
export interface TxApprovalConditions {
  /** An approval sheet — profile or transaction — is already on screen. */
  sheetOpen: boolean
  /** A send seam exists: something that can actually sign and submit. */
  walletReady: boolean
  /** Null whenever no local wallet session is open. */
  transferContext: PassportTransferContext | null
}

export type TxApprovalVerdict =
  /** Answer the app with this body and show no sheet. */
  | { kind: 'refuse'; body: PassportTxResponseBody }
  /** Show the approval sheet for exactly this many atomic units. */
  | { kind: 'show'; amount: bigint }

/**
 * The explorer's transaction route, per network. The link takes the 32-byte
 * ledger transaction hash — never the identifier `submitTransaction` answers
 * with, which resolves nowhere. Which networks have an
 * explorer at all is answered by `lib/networks.ts`, and `null` from it means
 * the id is shown as text instead.
 */
export function explorerTxHref(
  networkId: string | null | undefined,
  txId: string,
): string | null {
  return explorerTxUrl(networkId, txId)
}

/** Atomic NIGHT → display NIGHT. Exact: string arithmetic, never a float. */
export function formatNight(atomic: bigint): string {
  const negative = atomic < 0n
  const digits = (negative ? -atomic : atomic).toString().padStart(NIGHT_DECIMALS + 1, '0')
  const whole = digits.slice(0, digits.length - NIGHT_DECIMALS)
  const fraction = digits.slice(digits.length - NIGHT_DECIMALS).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export function shortAddress(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`
}

/** `mainnet` arrives as a symbol from the address codec; every other network is its own name. */
function networkNameOf(value: string | typeof mainnet): string {
  return value === mainnet ? 'mainnet' : value
}

export function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  return typeof cause === 'string' && cause ? cause : 'No further detail was reported.'
}

/**
 * Maps a payment failure onto the bridge's fixed error vocabulary. The thrown
 * value is the account module's `AccountCustodyError` shape — `{ code, message }`
 * — but this is postMessage-adjacent code, so an unrecognised throw becomes
 * `submit-failed` with its real message rather than a guess at a nicer code.
 * `insufficient-night` is recognised because App.tsx translates the contract's
 * own shortfall codes into this vocabulary before they arrive. `fee-unavailable`
 * deliberately is NOT mapped to `insufficient-funds`: the fee sponsor standing
 * down is not the user running short, and telling an app otherwise would put
 * the shortfall on the wrong party. It falls through to `submit-failed`,
 * carrying the sponsor's own sentence as the detail.
 */
export function transferErrorFrom(cause: unknown): {
  error: NonNullable<PassportTxResponse['error']>
  detail: string
} {
  const code =
    typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : null
  const detail = messageOf(cause)
  if (code === 'insufficient-night') return { error: 'insufficient-funds', detail }
  if (code === 'wrong-network') return { error: 'network-mismatch', detail }
  if (code === 'invalid-recipient') return { error: 'invalid-request', detail }
  /* The signing session went away between the sheet appearing and the approval
     landing — genuinely unavailable, not a failed submission. The wire code is
     `wallet-unavailable` because that is the versioned protocol's word for it;
     nothing a user reads says "wallet". */
  if (code === 'wallet-closed') return { error: 'wallet-unavailable', detail }
  /* The session's passkey could not be asserted at all, so no transaction can
     be approved until the user signs in again. */
  if (code === 'presence-unavailable') return { error: 'wallet-unavailable', detail }
  return { error: 'submit-failed', detail }
}

/**
 * Truncates `detail` to the cap the app's own parser enforces.
 *
 * An SDK message can be far longer than 400 characters, and the app rejects
 * the whole response if it is — so truncate here rather than have the app
 * silently ignore an honest failure reply.
 */
export function capTxDetail(body: PassportTxResponseBody): PassportTxResponseBody {
  const detail =
    body.detail && body.detail.length > DETAIL_CAP
      ? `${body.detail.slice(0, DETAIL_CAP - 3)}…`
      : body.detail
  return detail ? { ...body, detail } : body
}

/**
 * The ladder every transaction request climbs before a user ever sees it.
 *
 * The order is load-bearing and identical on both channels — an app that
 * handles `invalid-request` before `wallet-unavailable` in one place and the
 * other way round in another is an app that cannot be reasoned about. The
 * function is total: every request either refuses with a named code or comes
 * back with the one bigint the sheet and the send must both be driven by.
 */
export function evaluateTxRequest(
  request: PassportTxRequest,
  conditions: TxApprovalConditions,
): TxApprovalVerdict {
  /* (1) One sheet at a time, exactly as for profile requests. */
  if (conditions.sheetOpen) {
    return {
      kind: 'refuse',
      body: {
        status: 'failed',
        error: 'invalid-request',
        detail: 'Passport is already showing an approval sheet for this app.',
      },
    }
  }

  /* (2) No wallet, no sheet. Asking the user to approve a signature that
     cannot happen would be theatre, and the network in step 3 is the open
     wallet's — with no wallet there is nothing to validate against. */
  const transferContext = conditions.transferContext
  if (!conditions.walletReady || !transferContext) {
    return {
      kind: 'refuse',
      body: {
        status: 'failed',
        error: 'wallet-unavailable',
        detail: 'No Passport session is open in this browser, so nothing can be signed or sent.',
      },
    }
  }

  /* (3) The recipient must really be an unshielded address on the open
     wallet's own network. This is the check the bridge protocol cannot make
     for itself — the demo backend carries no Midnight SDK. */
  let parsed: MidnightBech32m
  try {
    parsed = MidnightBech32m.parse(request.intent.recipientAddress.trim())
  } catch (cause) {
    return {
      kind: 'refuse',
      body: {
        status: 'failed',
        error: 'invalid-request',
        detail: `That recipient is not a Midnight address. ${messageOf(cause)}`,
      },
    }
  }
  const recipientNetwork = networkNameOf(parsed.network)
  if (recipientNetwork !== transferContext.networkId) {
    return {
      kind: 'refuse',
      body: {
        status: 'failed',
        error: 'network-mismatch',
        detail: `That address belongs to the ${recipientNetwork} network; this Passport is on ${transferContext.networkId}.`,
      },
    }
  }
  try {
    parsed.decode(UnshieldedAddress, transferContext.networkId)
  } catch (cause) {
    return {
      kind: 'refuse',
      body: {
        status: 'failed',
        error: 'invalid-request',
        detail: `That is a Midnight address, but not an unshielded (mn_addr…) one. ${messageOf(cause)}`,
      },
    }
  }

  /* (4) The amount. The parser has already refused anything that is not
     1–20 base-10 digits and non-zero, so this cannot throw — but the sheet
     and the send must be driven by one bigint, not two conversions. */
  return { kind: 'show', amount: BigInt(request.intent.amount) }
}

/**
 * The balance line. It is the ACCOUNT-CUSTODY CONTRACT's NIGHT — what the user
 * owns and what a transfer is drawn from — and not the passkey engine's, which
 * is machinery and holds nothing a user is told about. Never guesses: a balance
 * the indexer has not answered with yet is reported as unknown rather than as
 * zero.
 */
export function accountHoldsCopy(formattedBalance: string | null | undefined): string {
  return formattedBalance
    ? `${formattedBalance} NIGHT`
    : 'Not known yet — the balance is still being read from the indexer.'
}

/**
 * The fee-and-key sentence under the rows. This is the honesty line: it says
 * the transaction is real, says whose key signs it, says where the key stays,
 * and promises the app nothing but the id. Both surfaces show it verbatim.
 */
export function txBoundaryCopy(networkId: string | null | undefined): string {
  return `Approving signs a real transaction on ${networkId ?? 'this'} with this Passport's own key, on this device. The app never sees the key, and only receives the transaction id once the node has accepted it.`
}
