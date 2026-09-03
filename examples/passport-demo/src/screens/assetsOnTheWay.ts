/**
 * WHAT IS ALREADY ON ITS WAY, BEFORE THE BALANCE MOVES.
 *
 * Home and Assets both paint what the network reports. Between the moment
 * something is announced — a sponsored grant, an incoming transfer — and the
 * moment the figure changes, both screens said nothing at all, so the honest
 * reading of a Passport in that gap was "nothing is happening".
 *
 * This is the pure half of the fix. It derives the in-flight list from the
 * activity trail the screens ALREADY hold: a row that is still `pending` and
 * that names something happening off this device is money on its way. A row
 * that has completed is not — the balance itself now says so — and neither is
 * a row that never left this device.
 *
 * No React, no network client, nothing that can fail: the screens ask, and
 * either get a list or get nothing.
 */

import {
  OPENING_BALANCE_ON_THE_WAY_DETAIL,
  OPENING_BALANCE_ON_THE_WAY_LABEL,
} from '../lib/activation.js';

/** The shape this leaf needs from a trail row. A subset of `ActivityFeedItem`. */
export interface OnTheWayCandidate {
  id: string;
  label: string;
  status: string;
  /** Present once a row names a ledger transaction. */
  txHash?: string;
  /** Where the row came from, on trails that stamp it. */
  source?: string;
}

/** One thing on its way, as a screen needs to name it. */
export interface AssetOnTheWay {
  id: string;
  label: string;
  /**
   * The fuller sentence, where the row has one to give — today, only the
   * opening balance, whose two figures are known before anything arrives. A
   * trail row has none: what it is arriving as is the trail's own business,
   * and the line under a balance is not a second trail.
   */
  detail?: string;
}

/** The sources that mean "this is happening somewhere other than this device". */
const OFF_DEVICE_SOURCES = new Set(['chain', 'sponsor']);

/** The synthetic row for a grant that has been asked for and not landed. */
const OPENING_BALANCE_ID = 'opening-balance';

/**
 * The rows that are still arriving.
 *
 * A row qualifies when it is `pending` AND it is off-device: either it was
 * stamped with a source that says so, or it already names a transaction, which
 * says the same thing without the stamp. Anything local — a passkey ceremony,
 * a screen's own bookkeeping — is deliberately excluded: it is not money, and
 * announcing it under a balance would be a false promise about one.
 */
export function assetsOnTheWay(
  activity: readonly OnTheWayCandidate[] | undefined,
  options?: { openingBalance?: boolean },
): readonly AssetOnTheWay[] {
  const out: AssetOnTheWay[] = [];
  /* The opening balance leads, because it is the one a new Passport is
     actually waiting on and the only one with nothing else on screen to
     explain it. It is not derived from a trail row: the grant is announced
     when the account exists, which is BEFORE the sponsor has been asked, and a
     line that only appeared once a row was written would still leave the first
     minutes of a new Passport reading as "you have nothing". It names the two
     figures it is waiting for, because the grant is the sponsor's fixed one
     and both live in `lib/activation.ts` as the single source. See
     `openingBalanceOnTheWay` there for when this row is offered at all. */
  if (options?.openingBalance) {
    out.push({
      id: OPENING_BALANCE_ID,
      label: OPENING_BALANCE_ON_THE_WAY_LABEL,
      detail: OPENING_BALANCE_ON_THE_WAY_DETAIL,
    });
  }
  if (!activity) return out;
  for (const entry of activity) {
    if (entry.status !== 'pending') continue;
    const offDevice =
      (entry.source !== undefined && OFF_DEVICE_SOURCES.has(entry.source)) ||
      (entry.source === undefined && typeof entry.txHash === 'string' && entry.txHash.length > 0);
    if (!offDevice) continue;
    out.push({ id: entry.id, label: entry.label });
  }
  return out;
}

/**
 * The one line both screens print.
 *
 * A single item is named, because naming it is the whole value — the reader
 * learns WHICH thing is arriving, and, where the row knows them, WHAT AMOUNTS:
 * the opening balance carries its `detail` here, so the two figures a new
 * Passport is waiting for are on screen while they are still pending. The
 * `On the way ·` stays in front of them, which is what keeps a figure that has
 * not arrived from reading as one that has. Several are counted instead: a
 * strip under a balance is not a second activity trail, and the trail itself
 * is a scroll away on the same screen.
 */
export function assetsOnTheWayLine(items: readonly AssetOnTheWay[]): string | null {
  if (items.length === 0) return null;
  if (items.length === 1) {
    const only = items[0]!;
    return `On the way · ${only.detail ?? only.label}`;
  }
  return `On the way · ${items.length} amounts still arriving`;
}
