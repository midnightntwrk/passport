// The inbox walk — MIP-0012 §6.5's normative discovery procedure.
//
// Enumerate inbox[0 .. inbox_count), decrypt each entry with the account
// encryption secret, skip entries that fail authentication or version
// checks, and rebuild the coin store from chain data alone. Serves both
// third-party-deposit discovery and total-loss reconstruction (INV-4).
//
// mt_index is deliberately not stored in entries; it is recomputed from
// chain data. Where the depositing transaction is known, its position
// window gives the index (capture.ts); otherwise clients resolve by
// candidate retry — a wrong qualified description fails at proving time
// and cannot mis-spend (INV-5).

import type { Ledger } from './contract.js';
import { openInboxEntry, type PlainCoin } from './inbox.js';

export interface DiscoveredCoin extends PlainCoin {
  /** Ordinal of the inbox entry the coin was recovered from. */
  inboxIndex: bigint;
}

/**
 * Walk the inbox with the viewing capability (the account encryption
 * secret). Returns every recoverable coin description, newest last.
 * Undecryptable entries (unknown version/suite, failed authentication,
 * poisoned per S3) are skipped, never errors.
 */
export function inboxWalk(ledgerState: Ledger, encSecretKey: Uint8Array): DiscoveredCoin[] {
  const out: DiscoveredCoin[] = [];
  for (let i = 0n; i < ledgerState.inbox_count; i++) {
    if (!ledgerState.inbox.member(i)) continue;
    const entry = ledgerState.inbox.lookup(i);
    const coin = openInboxEntry(encSecretKey, entry);
    if (coin) out.push({ ...coin, inboxIndex: i });
  }
  return out;
}
