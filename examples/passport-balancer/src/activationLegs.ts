/**
 * Which half of an activation is still owed, and whether a failed half is
 * worth this service trying again on its own.
 *
 * An activation is two credits — NIGHT into `night_balances`, mUSD into
 * `coins` — and either can land without the other. Until 2026/09/03 the NIGHT
 * leg was considered done as soon as ANY ledger entry existed for the
 * account, so an entry the asset leg had written first (mUSD landed, NIGHT
 * refused) answered every later `/fund-account` with `409 already-activated`
 * carrying `nightTx: null`. Four of thirteen Passports in that acceptance
 * ended with no NIGHT that way. A leg is done when ITS transaction is on
 * record, not when the other one's is.
 */

export interface LedgerEntryLike {
  txHash?: string | null;
  asset?: { depositTx?: string | null } | undefined;
}

export interface ActivationLegsInput {
  previous: LedgerEntryLike | null;
  heldNight: bigint;
  heldAsset: bigint;
  assetSupported: boolean;
  grantAtomic: bigint;
  assetGrant: bigint;
}

export interface ActivationLegs {
  nightNeeded: boolean;
  assetNeeded: boolean;
}

export function activationLegs(input: ActivationLegsInput): ActivationLegs {
  const nightRecorded = Boolean(input.previous?.txHash);
  const assetRecorded = input.previous?.asset !== undefined;
  return {
    nightNeeded: !nightRecorded && input.heldNight < input.grantAtomic,
    assetNeeded: input.assetSupported && !assetRecorded && input.heldAsset < input.assetGrant,
  };
}

/**
 * Should the sponsor queue the NIGHT grant again itself after this failure,
 * rather than wait for the client to post again?
 *
 * Yes for anything the chain or this wallet might do differently a moment
 * later — a refusal, a landing that did not apply, a confirmation that ran
 * out. No for the two the caller has to fix: an address that is not an
 * account, and an indexer that cannot be reached at all (the retry would sit
 * on the same unreachable indexer). A DUST shortfall is handled before this
 * is asked: nothing was built, and the caller's own wait rebuilds it.
 */
export function shouldRetryGrant(code: string): boolean {
  return code !== 'not-an-account' && code !== 'indexer-unreachable';
}

/** How long the sponsor waits before its own second attempt at a grant. */
export const GRANT_RETRY_DELAY_MS = 15_000;
