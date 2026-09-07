/**
 * A SECOND INDEXER, AND THE FACT THAT AN INDEXER CANNOT BE SWAPPED MID-FLIGHT.
 *
 * WHAT IS DIFFERENT ABOUT THIS ONE
 * --------------------------------
 * Proving and fee sponsorship fail over PER REQUEST: `endpoints.ts` picks a
 * host, one HTTP round trip happens, and the next request picks again from
 * scratch. Nothing is carried between them, which is why that rule is a pure
 * function over a list.
 *
 * The indexer is not a request. `WalletFacade.init` is handed one
 * `indexerClientConnection` — an HTTP URL and a WebSocket URL — and from that
 * moment the three component wallets hold a live subscription to it. The SDK
 * exposes no way to retarget an open client, and every consumer of an open
 * wallet has captured that facade: `identity/accountCustody.ts` subscribes to
 * `wallet.facade.state()` for the length of a deploy, `identity/
 * contractRuntime.ts` submits through it, and `lib/localWallet.ts`'s own
 * snapshot, balance, and sync-progress subscriptions all ride it.
 *
 * So there are two honest moments, and this module holds the rule for both:
 *
 *  1. **AT OPEN.** Before the facade is built, the list is walked and the
 *     wallet is built against the first indexer that answers a bounded probe.
 *     This is the whole of the standby's value in the common case — a primary
 *     indexer that is down when somebody opens Passport no longer means a
 *     Passport that will not open — and it costs one cheap GraphQL query.
 *  2. **AFTER A STALL.** A connection that dies, or a walk that stops
 *     advancing, cannot be moved to another host in place. The wallet is
 *     REBUILT on the next indexer — the same operation `App.tsx` already
 *     performs on a silent session restore, which unwraps the stored seed and
 *     calls `createLocalMidnightWallet` again — and it resumes from the sync
 *     snapshot it has already saved, so the cost is a reconnection rather than
 *     a chain walk. Nothing here pretends the open client moved, because it
 *     did not.
 *
 * No `fetch` and no wall clock of its own: a list in, a decision out, with the
 * probe and the timer injected. Drilled in `./indexerFailover.test.ts`.
 */

import {
  describeEndpointRefusals,
  firstEndpointThatServes,
  parseEndpointList,
} from './endpoints.js';

/** One indexer, both of the URLs a facade needs for it. */
export interface IndexerEndpoint {
  httpUrl: string;
  wsUrl: string;
}

/**
 * The indexer's WebSocket endpoint is its HTTP endpoint with `/ws` appended —
 * confirmed against the deployed stagenet indexer; see the header comment in
 * `./indexerTx.ts`.
 */
export function indexerWsFrom(indexerHttpUrl: string): string {
  return `${indexerHttpUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
}

/**
 * Reads `VITE_INDEXER_URL` — and the optional `VITE_INDEXER_WS_URL` beside it
 * — into an ordered list of indexers.
 *
 * Both take the comma-separated list format `endpoints.ts` defines, and both
 * behave exactly as they did when they held one URL: a single value parses to
 * a list of one. THE WEBSOCKET LIST FOLLOWS THE HTTP LIST — position by
 * position — rather than being a list in its own right, because an indexer is
 * one host reached two ways and a pair that disagreed would subscribe to a
 * different chain view than it queried. An override shorter than the HTTP list
 * (the usual case: one override, two indexers) covers the endpoints it reaches
 * and the rest derive theirs, which is what makes adding a second indexer a
 * one-variable change.
 */
export function indexerEndpointList(
  httpValue: string | null | undefined,
  wsValue?: string | null,
): IndexerEndpoint[] {
  const wsOverrides = parseEndpointList(wsValue);
  return parseEndpointList(httpValue).map((httpUrl, index) => ({
    httpUrl,
    wsUrl: wsOverrides[index] ?? indexerWsFrom(httpUrl),
  }));
}

/**
 * The list rotated so that the endpoint AFTER `httpUrl` comes first.
 *
 * This is what a rebuild is handed. It is a rotation rather than a truncation
 * because the primary coming back is the expected end of an outage: an
 * operator who restarts the indexer that stalled should get it back on the
 * next rebuild rather than after a redeploy. `null` when there is nowhere to
 * go — a list of one, or a URL that is not in the list at all, which is a
 * caller that has lost track of where it was and must not be sent somewhere
 * arbitrary.
 */
export function indexersAfter(
  endpoints: readonly IndexerEndpoint[],
  httpUrl: string,
): IndexerEndpoint[] | null {
  if (endpoints.length < 2) return null;
  const at = endpoints.findIndex((endpoint) => endpoint.httpUrl === httpUrl);
  if (at < 0) return null;
  return [...endpoints.slice(at + 1), ...endpoints.slice(0, at + 1)];
}

/**
 * Walks the list and answers with the first indexer that answers `probe`.
 *
 * `probe` is a cheap, bounded GraphQL query — `fetchChainHeight` in
 * `./walletSnapshot.ts`, which asks for one block height and gives up after a
 * few seconds. It is the smallest question that proves an indexer is both
 * reachable and serving this chain's schema, and a host that fails it would
 * have failed the facade's first subscription a moment later with a far worse
 * error.
 *
 * `null` when nothing answered. That is NOT "give up": the caller opens on the
 * first endpoint anyway, so a probe that is wrong about a healthy indexer
 * costs a few seconds and changes nothing else. A probe is allowed to be
 * cautious precisely because it is not the authority.
 */
export async function firstIndexerThatAnswers(
  endpoints: readonly IndexerEndpoint[],
  probe: (httpUrl: string) => Promise<boolean>,
  log: (message: string) => void = (message) => console.info(message),
): Promise<{ index: number; endpoint: IndexerEndpoint } | null> {
  const outcome = await firstEndpointThatServes<IndexerEndpoint>(
    endpoints.map((endpoint) => endpoint.httpUrl),
    async (httpUrl, index) => {
      const answered = await probe(httpUrl);
      return answered
        ? { served: true, value: endpoints[index] }
        : { served: false, reason: 'the indexer did not answer a block-height query' };
    },
  );
  if (!outcome.served) return null;
  if (outcome.refusals.length > 0) {
    /* An operator's line, and only an operator's — one per failover, naming
       the index in their own list first. A Passport that opened on the standby
       looks identical to one that opened on the primary, which is exactly how
       a dead primary goes unnoticed until the standby dies too. */
    log(
      `[indexer] opened on endpoint ${outcome.index} (${outcome.url}) after ${describeEndpointRefusals(
        outcome.refusals,
      )}`,
    );
  }
  return { index: outcome.index, endpoint: outcome.value };
}

/** The three numbers `LocalMidnightWallet.subscribeSyncProgress` publishes. */
export interface IndexerSyncHealth {
  /** 0–100 across the three component wallets, or `null` before a target. */
  percent: number | null;
  synced: boolean;
  connected: boolean;
}

/**
 * How long a wallet may make no progress before its indexer is called stalled.
 *
 * Generous on purpose. A chain walk genuinely produces long flat stretches —
 * the percentage is the MINIMUM of three components and a component that is
 * already at its target contributes nothing to the figure moving — and a
 * rebuild costs a reconnection and a fresh subscription for everybody holding
 * the wallet. Ninety seconds is longer than any flat stretch measured against
 * the stagenet indexer and far shorter than the ten minutes an activation
 * grant is given, so a stall is caught while the thing waiting on it is still
 * waiting.
 */
export const INDEXER_STALL_MS = 90_000;

/** How often the watch asks itself whether the wallet has gone quiet. */
export const INDEXER_STALL_TICK_MS = 15_000;

export interface IndexerStallWatch {
  /** Feed it every sync-progress reading. */
  observe(health: IndexerSyncHealth): void;
  /** Stop watching. Idempotent, and implied by a stall firing. */
  stop(): void;
}

export interface IndexerStallWatchOptions {
  /** Called ONCE, the first time the wallet is judged stalled. */
  onStalled: (health: IndexerSyncHealth | null) => void;
  stallMs?: number;
  tickMs?: number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Watches sync progress for an indexer that has stopped serving this wallet.
 *
 * TWO THINGS COUNT AS HEALTHY, and the second is why this is not a timeout on
 * emissions:
 *
 *   * SYNCED AND CONNECTED. A wallet that has caught up emits nothing at all
 *     while the chain is quiet — `subscribeSyncProgress` publishes only when
 *     the answer CHANGES — so silence there is the healthiest state there is.
 *     The tick re-affirms it from the last reading rather than counting down
 *     against it, which is the bug this shape exists to avoid: a watch that
 *     timed out on emissions would rebuild a perfectly good wallet every ninety
 *     seconds of quiet.
 *   * PROGRESSING. Not synced yet, but the percentage has moved since the last
 *     reading. A chain walk is allowed to take as long as it takes.
 *
 * Everything else is the countdown: a reading with `connected: false`, or a
 * percentage that has not moved for {@link INDEXER_STALL_MS}. It fires once
 * and stops — a rebuild replaces the wallet, and the new wallet gets its own
 * watch.
 */
export function watchIndexerStall(options: IndexerStallWatchOptions): IndexerStallWatch {
  const stallMs = options.stallMs ?? INDEXER_STALL_MS;
  const tickMs = options.tickMs ?? INDEXER_STALL_TICK_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number) => setInterval(run, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  let latest: IndexerSyncHealth | null = null;
  let lastPercent: number | null = null;
  let lastGoodAt = now();
  let stopped = false;
  let timer: unknown = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const healthy = (health: IndexerSyncHealth): boolean => health.connected && health.synced;

  timer = setTimer(() => {
    if (stopped) return;
    if (latest !== null && healthy(latest)) {
      lastGoodAt = now();
      return;
    }
    if (now() - lastGoodAt < stallMs) return;
    const stalledOn = latest;
    stop();
    options.onStalled(stalledOn);
  }, tickMs);

  return {
    observe(health: IndexerSyncHealth): void {
      if (stopped) return;
      latest = health;
      if (healthy(health) || (health.connected && health.percent !== lastPercent)) {
        lastGoodAt = now();
      }
      lastPercent = health.percent;
    },
    stop,
  };
}
