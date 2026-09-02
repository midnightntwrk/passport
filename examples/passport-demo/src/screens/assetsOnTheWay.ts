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
}

/** The sources that mean "this is happening somewhere other than this device". */
const OFF_DEVICE_SOURCES = new Set(['chain', 'sponsor']);

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
): readonly AssetOnTheWay[] {
  if (!activity) return [];
  const out: AssetOnTheWay[] = [];
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
 * learns WHICH thing is arriving. Several are counted instead: a strip under a
 * balance is not a second activity trail, and the trail itself is a scroll
 * away on the same screen.
 */
export function assetsOnTheWayLine(items: readonly AssetOnTheWay[]): string | null {
  if (items.length === 0) return null;
  if (items.length === 1) return `On the way · ${items[0]!.label}`;
  return `On the way · ${items.length} amounts still arriving`;
}
