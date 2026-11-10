// Decrypt and deduplicate inbox candidates with the account viewing key.
// This is one part of the MIP-0012 discovery flow: an authenticated envelope
// does not prove deposit validity, current ownership, or unspent status.
// mt_index is absent from entries and must be resolved against chain data.
// Local spent tombstones are preserved when candidates re-enter withCoin;
// restoring from no prior state still needs authoritative spent-state checks.

import type { Ledger } from './contract.js';
import { coinId } from './witnesses.js';
import { openInboxEntry, type PlainCoin } from './inbox.js';

export interface DiscoveredCoin extends PlainCoin {
  /** Ordinal of the inbox entry the coin was recovered from. */
  inboxIndex: bigint;
}

/**
 * Duplicate descriptions retain their first authenticated inbox position.
 * Walk the inbox with the viewing capability (the account encryption
 * secret). Returns distinct decryptable descriptions in first-seen order.
 * Undecryptable entries (unknown version/suite, failed authentication,
 * poisoned per S3) are skipped, never errors.
 */
export function inboxWalk(ledgerState: Ledger, encSecretKey: Uint8Array): DiscoveredCoin[] {
  const out: DiscoveredCoin[] = [];
  const seen = new Set<string>();
  for (let i = 0n; i < ledgerState.inbox_count; i++) {
    if (!ledgerState.inbox.member(i)) continue;
    const entry = ledgerState.inbox.lookup(i);
    const coin = openInboxEntry(encSecretKey, entry);
    if (coin && !seen.has(coinId(coin))) {
      seen.add(coinId(coin));
      out.push({ ...coin, inboxIndex: i });
    }
  }
  return out;
}
