import type { QualifiedCoin, ShieldedCoin } from './contract.js';
import { deriveEncPublicKey, openInboxEntry } from './inbox.js';
import { bytesToHex } from './hex.js';
import { coinId } from './witnesses.js';

/** All observations in a report refer to this exact chain snapshot. */
export interface ChainRecoveryScope {
  networkId: string;
  address: string;
  blockHash: string;
  blockHeight: string;
}

export interface ChainRecoveryCursor {
  version: 1;
  scope: ChainRecoveryScope;
  nextInboxIndex: string;
}

export interface CoinSearchCursor {
  version: 1;
  scope: ChainRecoveryScope;
  coinId: string;
  nextIndex: string;
  eventOffset?: number;
  /** Omission preserves the initial event search; tree fallback never switches back. */
  mode?: 'events' | 'tree';
}

export type ChainCoinInspection =
  | { status: 'live' | 'spent'; coin: QualifiedCoin }
  | { status: 'unknown'; reason: string; nextIndex?: string; nextEventOffset?: number; nextMode?: 'events' | 'tree' };

export interface ChainRecoverySnapshot {
  scope: ChainRecoveryScope;
  encKey: Uint8Array;
  inboxCount: bigint;
  readInbox(index: bigint): Promise<Uint8Array | null>;
  /** Live requires commitment qualification and authoritative nullifier absence;
   * spent requires the exact commitment and authoritative nullifier presence. */
  inspect(coin: ShieldedCoin, options: {
    hints: bigint[]; nextIndex?: bigint; eventOffset?: number; mode?: 'events' | 'tree'; maxIndices: number;
  }): Promise<ChainCoinInspection>;
}

export interface ChainRecoveryAdapter {
  openSnapshot(request: { address: string; blockHash?: string }): Promise<ChainRecoverySnapshot>;
}

export type RecoveryCandidateSource = 'inbox' | 'local' | 'journal' | 'caller';

export interface ChainRecoveryCandidate {
  coin: ShieldedCoin;
  hints?: bigint[];
  searchCursor?: CoinSearchCursor;
  source?: RecoveryCandidateSource;
}

export interface ScanHoldingsOptions {
  networkId: string;
  address: string;
  viewingKeys: Uint8Array[];
  cursor?: ChainRecoveryCursor;
  candidates?: ChainRecoveryCandidate[];
  /** Inbox entries in this call, from 1 through 4096. Default 256. */
  maxEntries?: number;
  /** Distinct candidate inspections in this call, from 1 through 4096. Default 256. */
  maxCandidates?: number;
  /** Commitment positions per candidate, from 1 through 4096. Default 256. */
  maxCoinIndices?: number;
}

export interface RecoveredHolding {
  id: string;
  coin: ShieldedCoin;
  status: 'live' | 'spent' | 'unknown';
  qualifiedCoin?: QualifiedCoin;
  reason?: string;
  sources: RecoveryCandidateSource[];
  inboxIndices: string[];
  searchCursor?: CoinSearchCursor;
}

/** Private recovery data, including coin descriptions. Do not publish this report. */
export interface HoldingsRecoveryReport {
  version: 1;
  scope: ChainRecoveryScope;
  coverage: {
    fromInboxIndex: string;
    nextInboxIndex: string;
    inboxCount: string;
    reachedInboxEnd: boolean;
    currentViewingKeyAvailable: boolean;
    openedEntries: number;
    unreadableEntries: number;
    missingEntries: number;
    duplicateDescriptions: number;
    inspectedCandidates: number;
    unknownCandidates: number;
    /** Only a single full pass with no gaps or unknown candidates can be complete.
     * A final resumed page does not represent earlier pages or a complete balance. */
    complete: boolean;
  };
  holdings: RecoveredHolding[];
  /** A subtotal of verified live candidates in this report, never an implicit full balance. */
  verifiedSubtotal: { colorHex: string; value: bigint }[];
  cursor: ChainRecoveryCursor | null;
  application?: { importedLive: number; recordedSpent: number; localSpentConflicts: string[] };
}

const uint64 = (value: unknown): value is string => typeof value === 'string'
  && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) < (1n << 64n);
const eventOffset = (value: unknown): value is number => Number.isSafeInteger(value)
  && (value as number) >= 0 && (value as number) <= 0x7fffffff;

function scopeOf(value: ChainRecoveryScope): ChainRecoveryScope {
  if (!value || [value.networkId, value.address, value.blockHash].some(s => typeof s !== 'string' || !s || s.length > 512)
    || !uint64(value.blockHeight)) throw new Error('invalid chain recovery scope');
  return { networkId: value.networkId, address: value.address, blockHash: value.blockHash, blockHeight: value.blockHeight };
}

function sameScope(left: ChainRecoveryScope, right: ChainRecoveryScope): boolean {
  return left.networkId === right.networkId && left.address === right.address
    && left.blockHash === right.blockHash && left.blockHeight === right.blockHeight;
}

function limit(value: number | undefined, name: string): number {
  const result = value ?? 256;
  if (!Number.isSafeInteger(result) || result < 1 || result > 4096) throw new Error(`invalid recovery ${name} limit`);
  return result;
}

function cloneCoin(coin: ShieldedCoin): ShieldedCoin {
  if (!coin || !(coin.nonce instanceof Uint8Array) || coin.nonce.length !== 32
    || !(coin.color instanceof Uint8Array) || coin.color.length !== 32
    || typeof coin.value !== 'bigint' || coin.value < 0n || coin.value >= (1n << 128n)) throw new Error('invalid recovery coin');
  return { nonce: coin.nonce.slice(), color: coin.color.slice(), value: coin.value };
}

function index(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << 64n)) throw new Error('invalid recovery commitment index');
  return value;
}

export function recoverySubtotal(holdings: RecoveredHolding[], excluded = new Set<string>()): HoldingsRecoveryReport['verifiedSubtotal'] {
  const totals = new Map<string, bigint>();
  for (const holding of holdings) if (holding.status === 'live' && !excluded.has(holding.id)) {
    const colour = bytesToHex(holding.coin.color);
    totals.set(colour, (totals.get(colour) ?? 0n) + holding.coin.value);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([colorHex, value]) => ({ colorHex, value }));
}

/** Reads and classifies a bounded page without modifying wallet state. */
export async function scanHoldings(adapter: ChainRecoveryAdapter, options: ScanHoldingsOptions): Promise<HoldingsRecoveryReport> {
  if (!options || typeof options.networkId !== 'string' || !options.networkId
    || typeof options.address !== 'string' || !options.address || !Array.isArray(options.viewingKeys)
    || options.viewingKeys.length > 32 || (options.candidates !== undefined && !Array.isArray(options.candidates))) {
    throw new Error('invalid chain recovery options');
  }
  const maxEntries = limit(options.maxEntries, 'inbox');
  const maxCandidates = limit(options.maxCandidates, 'candidate');
  const maxCoinIndices = limit(options.maxCoinIndices, 'commitment');
  const keys = options.viewingKeys.map(key => {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('invalid recovery viewing key');
    return key.slice();
  });
  const inboxCursor = options.cursor ? {
    version: options.cursor.version, scope: scopeOf(options.cursor.scope), nextInboxIndex: options.cursor.nextInboxIndex,
  } : undefined;
  if (inboxCursor && (inboxCursor.version !== 1 || !uint64(inboxCursor.nextInboxIndex)
    || inboxCursor.scope.networkId !== options.networkId || inboxCursor.scope.address !== options.address)) {
    throw new Error('chain recovery cursor scope mismatch');
  }
  const supplied = (options.candidates ?? []).map(candidate => {
    const coin = cloneCoin(candidate.coin), id = coinId(coin);
    if (candidate.source && !['inbox', 'local', 'journal', 'caller'].includes(candidate.source)) throw new Error('invalid recovery candidate source');
    if (candidate.hints !== undefined && (!Array.isArray(candidate.hints) || candidate.hints.length > 4096)) throw new Error('invalid recovery candidate hints');
    const hints = (candidate.hints ?? []).map(index);
    const cursor = candidate.searchCursor ? { version: candidate.searchCursor.version,
      scope: scopeOf(candidate.searchCursor.scope), coinId: candidate.searchCursor.coinId, nextIndex: candidate.searchCursor.nextIndex,
      ...(candidate.searchCursor.eventOffset === undefined ? {} : { eventOffset: candidate.searchCursor.eventOffset }),
      ...(candidate.searchCursor.mode === undefined ? {} : { mode: candidate.searchCursor.mode }) } : undefined;
    if (cursor && (cursor.version !== 1 || cursor.coinId !== id || !uint64(cursor.nextIndex)
      || (cursor.eventOffset !== undefined && !eventOffset(cursor.eventOffset))
      || (cursor.mode !== undefined && !['events', 'tree'].includes(cursor.mode))
      || (cursor.mode === 'tree' && (cursor.eventOffset ?? 0) !== 0)
      || cursor.scope.networkId !== options.networkId || cursor.scope.address !== options.address)) throw new Error('coin search cursor scope mismatch');
    return { coin, id, hints, cursor, source: candidate.source ?? 'caller' as RecoveryCandidateSource };
  });
  // Every continuation in one call must share one immutable chain snapshot.
  let requestedScope = inboxCursor?.scope;
  for (const candidate of supplied) if (candidate.cursor) {
    if (requestedScope && !sameScope(requestedScope, candidate.cursor.scope)) throw new Error('mixed chain recovery cursor snapshots');
    requestedScope = candidate.cursor.scope;
  }
  const snapshot = await adapter.openSnapshot({ address: options.address, ...(requestedScope ? { blockHash: requestedScope.blockHash } : {}) });
  const scope = scopeOf(snapshot.scope);
  if (scope.networkId !== options.networkId || scope.address !== options.address
    || (requestedScope && !sameScope(scope, requestedScope))) throw new Error('chain recovery snapshot scope mismatch');
  if (!(snapshot.encKey instanceof Uint8Array) || snapshot.encKey.length !== 32
    || typeof snapshot.inboxCount !== 'bigint' || snapshot.inboxCount < 0n || snapshot.inboxCount >= (1n << 64n)) throw new Error('invalid chain recovery snapshot');
  const encKey = snapshot.encKey.slice(), inboxCount = snapshot.inboxCount;
  const currentViewingKeyAvailable = keys.some(key => bytesToHex(deriveEncPublicKey(key)) === bytesToHex(encKey));
  const from = BigInt(inboxCursor?.nextInboxIndex ?? '0');
  if (from > inboxCount) throw new Error('chain recovery cursor exceeds inbox');
  const assertSnapshot = () => {
    if (!sameScope(scopeOf(snapshot.scope), scope) || snapshot.inboxCount !== inboxCount
      || bytesToHex(snapshot.encKey) !== bytesToHex(encKey)) throw new Error('chain recovery snapshot changed during scan');
  };
  type Pending = { holding: RecoveredHolding; hints: Set<bigint>; cursor?: CoinSearchCursor };
  const pending = new Map<string, Pending>();
  let duplicateDescriptions = 0;
  const add = (coin: ShieldedCoin, source: RecoveryCandidateSource, hints: bigint[], inboxIndex?: bigint, cursor?: CoinSearchCursor) => {
    const id = coinId(coin);
    let found = pending.get(id);
    if (found) {
      duplicateDescriptions++;
      if (found.cursor && cursor && (found.cursor.nextIndex !== cursor.nextIndex
        || (found.cursor.eventOffset ?? 0) !== (cursor.eventOffset ?? 0)
        || (found.cursor.mode ?? 'events') !== (cursor.mode ?? 'events'))) throw new Error('conflicting recovery coin cursors');
      if (cursor) found.cursor = cursor;
    } else {
      found = { holding: { id, coin: cloneCoin(coin), status: 'unknown', sources: [], inboxIndices: [] }, hints: new Set(), cursor };
      pending.set(id, found);
    }
    if (!found.holding.sources.includes(source)) found.holding.sources.push(source);
    if (inboxIndex !== undefined) found.holding.inboxIndices.push(inboxIndex.toString());
    hints.forEach(hint => found!.hints.add(hint));
  };
  supplied.forEach(candidate => add(candidate.coin, candidate.source, candidate.hints, undefined, candidate.cursor as CoinSearchCursor));
  let next = from, openedEntries = 0, unreadableEntries = 0, missingEntries = 0;
  for (let read = 0; read < maxEntries && next < inboxCount; read++) {
    let entry: Uint8Array | null;
    try { entry = await snapshot.readInbox(next); }
    catch { entry = null; }
    assertSnapshot();
    if (entry === null || entry === undefined) { missingEntries++; break; }
    let coin: ShieldedCoin | null = null;
    if (entry instanceof Uint8Array) {
      for (const key of keys) {
        try { coin = openInboxEntry(key, entry); } catch { coin = null; }
        if (coin) break;
      }
    }
    if (coin) { openedEntries++; add(coin, 'inbox', [], next); }
    else unreadableEntries++;
    next++;
  }
  let inspectedCandidates = 0;
  for (const candidate of pending.values()) {
    const { holding } = candidate;
    const continuation = (nextIndex: string, offset = candidate.cursor?.eventOffset,
      mode = candidate.cursor?.mode): CoinSearchCursor => ({
      version: 1, scope: { ...scope }, coinId: holding.id, nextIndex, ...(offset === undefined ? {} : { eventOffset: offset }),
      ...(mode === undefined ? {} : { mode }),
    });
    if (inspectedCandidates >= maxCandidates) {
      holding.reason = 'candidate-budget';
      holding.searchCursor = continuation(candidate.cursor?.nextIndex ?? '0');
      continue;
    }
    inspectedCandidates++;
    const nextIndex = candidate.cursor ? BigInt(candidate.cursor.nextIndex) : undefined;
    try {
      const observed = await snapshot.inspect(cloneCoin(holding.coin), {
        hints: [...candidate.hints], ...(nextIndex === undefined ? {} : { nextIndex }), maxIndices: maxCoinIndices,
        ...(candidate.cursor?.eventOffset === undefined ? {} : { eventOffset: candidate.cursor.eventOffset }),
        ...(candidate.cursor?.mode === undefined ? {} : { mode: candidate.cursor.mode }),
      });
      assertSnapshot();
      if (!observed || !['live', 'spent', 'unknown'].includes(observed.status)) throw new Error('invalid recovery inspection');
      if (observed.status === 'unknown') {
        if (typeof observed.reason !== 'string' || !observed.reason) throw new Error('invalid recovery inspection reason');
        holding.reason = observed.reason;
        if (observed.nextIndex !== undefined || observed.nextEventOffset !== undefined || observed.nextMode !== undefined) {
          const nextPosition = observed.nextIndex ?? '0';
          const previousMode = candidate.cursor?.mode ?? 'events';
          const nextMode = observed.nextMode ?? previousMode;
          const nextOffset = observed.nextEventOffset ?? (nextMode === 'tree' ? 0 : candidate.cursor?.eventOffset ?? 0);
          const previousOffset = candidate.cursor?.eventOffset ?? 0;
          if (!uint64(nextPosition) || !eventOffset(nextOffset) || !['events', 'tree'].includes(nextMode)
            || (previousMode === 'tree' && nextMode !== 'tree')
            || (nextMode === 'tree' && nextOffset !== 0)
            || (nextMode === previousMode && (nextOffset < previousOffset
              || (nextOffset === previousOffset && BigInt(nextPosition) <= (nextIndex ?? -1n))))) {
            throw new Error('invalid recovery coin continuation');
          }
          holding.searchCursor = continuation(nextPosition, nextOffset,
            observed.nextMode ?? candidate.cursor?.mode);
        } else if (candidate.cursor) holding.searchCursor = continuation(candidate.cursor.nextIndex);
      } else {
        const qualified = { ...cloneCoin(observed.coin), mt_index: index(observed.coin.mt_index) };
        if (coinId(qualified) !== holding.id) throw new Error('recovery inspection coin identity mismatch');
        holding.status = observed.status;
        holding.qualifiedCoin = qualified;
      }
    } catch {
      holding.status = 'unknown';
      holding.reason = 'inspection-failed';
      delete holding.qualifiedCoin;
      holding.searchCursor = continuation(candidate.cursor?.nextIndex ?? '0');
    }
    assertSnapshot();
  }
  const holdings = [...pending.values()].map(value => value.holding);
  const unknownCandidates = holdings.filter(holding => holding.status === 'unknown').length;
  const reachedInboxEnd = next === inboxCount;
  return {
    version: 1, scope,
    coverage: { fromInboxIndex: from.toString(), nextInboxIndex: next.toString(), inboxCount: inboxCount.toString(), reachedInboxEnd,
      currentViewingKeyAvailable, openedEntries, unreadableEntries, missingEntries, duplicateDescriptions, inspectedCandidates, unknownCandidates,
      complete: from === 0n && reachedInboxEnd && currentViewingKeyAvailable && !unreadableEntries && !missingEntries && !unknownCandidates },
    holdings, verifiedSubtotal: recoverySubtotal(holdings),
    cursor: reachedInboxEnd ? null : { version: 1, scope: { ...scope }, nextInboxIndex: next.toString() },
  };
}
