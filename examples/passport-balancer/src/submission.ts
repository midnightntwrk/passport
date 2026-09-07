/**
 * How this service hands a transaction to the node — and why it does not use
 * the wallet SDK's submission service at all.
 *
 * THE DEFECT THIS MODULE EXISTS FOR
 * --------------------------------
 * On 2026/09/02 two spend jobs went silent while holding a lane, 23:03:31 and
 * 23:46:30 UTC, with the proof server idle and no journal line, until an
 * operator restarted the service. In both cases the job's transaction had
 * ALREADY LANDED on chain — the resolver-leaf `ContractDeploy` is in blocks
 * 291694 and 292118 — and the job never noticed.
 *
 * Every version of that failure comes back to one habit in the SDK's node
 * client. `PolkadotNodeClient.sendMidnightTransaction` ends every submission
 * stream with `Stream.ensuring(api.disconnect())`, and `PolkadotNodeClient.make`
 * disconnects once more the moment it has loaded metadata. polkadot-js's
 * `WsProvider.disconnect()` calls `websocket.close(1000)` and RESOLVES
 * IMMEDIATELY — it does not wait for the socket's close event — and when that
 * event eventually arrives, `#onSocketClose` walks the provider-wide handler
 * map and errors every entry in it, while `#resubscribe` explicitly skips
 * anything whose type starts with `author_`. So a disconnect reaches whatever
 * the connection is doing a moment later:
 *
 *   - a live `author_submitAndWatchExtrinsic` is dropped in silence — no
 *     further status callback, the `Stream.async` never ends, and
 *     `reconnectionTimeout` is `Duration.infinity`. That is the 37-minute and
 *     23-minute hangs of 2026/09/02.
 *   - a submission that has just registered its handler is failed outright with
 *     `disconnected from wss://rpc.stagenet.shielded.tools/: 1000:: Normal
 *     Closure`. That is the registration refused 39.7 s in at 02:28 UTC on
 *     2026/09/03.
 *
 * TWO NARROWER FIXES, BOTH MEASURED FAILING ON THE DEPLOYED SERVICE
 * ----------------------------------------------------------------
 * Serialising submissions was the first, and it cannot work: the harm is done
 * by an event that arrives after the submission which caused it is over, so no
 * ordering of submissions keeps them apart.
 *
 * A connection per submission was the second, and it was worse. The client
 * disconnects during its own construction, a second or so before the submission
 * it was built for, so every submission killed itself with its own start-up
 * close: deployed at 02:41 UTC on 2026/09/03, it failed a grant, a mint, and a
 * registration inside ninety seconds, all with `1000:: Normal Closure`.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * It owns the connection. One polkadot-js `ApiPromise`, opened on the first
 * submission and disconnected only when this service is closed — which the
 * facade does from `stop()`, and nothing else does at all. Submission is
 * `api.tx.midnight.sendMnTransaction(...).send(callback)`, the same call the
 * SDK makes, with this module unsubscribing its own subscription when it is
 * finished with it and nothing ever closing the socket underneath anybody.
 * `WsProvider` keeps its own auto-reconnect, so a socket that drops comes back
 * without any of this having to notice.
 *
 * Two properties then hold that did not before: a submission cannot be killed
 * by another submission's clean-up, and no submission waits for ever, because
 * {@link SubmissionTimeout} bounds it whatever the socket does.
 *
 * THE THIRD PROPERTY, ADDED AFTER 2026/09/05
 * ------------------------------------------
 * "`WsProvider` keeps its own auto-reconnect, so a socket that drops comes back
 * without any of this having to notice" was measured false, and it cost five
 * hours. At 14:48 UTC the wallet's node websocket died. At 15:28 the health
 * loop said `degraded: the wallet's sync indices have not moved in 40 min` and
 * remedied it with `refresh`, which re-reads the wallet and does not so much as
 * look at this connection. From 15:30:27 until an operator restarted the unit
 * at 20:12, EVERY submission failed instantly — 520 of them — with
 * `RPC-CORE: submitAndWatchExtrinsic … WebSocket is not connected` and
 * `Failed WS Request author_submitAndWatchExtrinsic`, while `/status` reported
 * `synced: true`, `busy: false`, and both sponsorships `available`. Every name
 * registration, every activation grant, and every mUSD mint in those five hours
 * failed. The public node was healthy throughout, and the restart fixed it at
 * once.
 *
 * The provider's reconnect had wedged, and `connect()` on a provider in that
 * state rejects — which the branch below used to swallow as "the provider is
 * doing exactly what is wanted". It was not. So this module no longer waits on
 * a reconnect it cannot see: a socket that reports itself disconnected, or a
 * submission that fails with the `WebSocket is not connected` / `Failed WS
 * Request` family, gets a BUILT-FRESH connection — a new `WsProvider` and a new
 * `ApiPromise`, with the old one disconnected and thrown away — before the next
 * submission, and the failing submission is retried once on it. The rebuild is
 * bounded, consecutive failures are counted, and `/status` publishes both
 * ({@link NodeConnection.socketHealth}) so the same outage cannot be invisible
 * twice. When the rebuild itself keeps failing, `./health.ts` escalates to a
 * process exit and systemd brings the service back — which is the remedy the
 * operator applied by hand.
 *
 * And one consequence worth stating plainly: this takes the node's FIRST status
 * rather than finality. A node REFUSAL still arrives, as the rejection of the
 * `.send()` call itself — which is what `isNodeRejection` and
 * `withNodeRejectionRetry` match on, so neither changes — while the 15–25 s of
 * stagenet finality per submission comes off the user's click. Finality is not
 * a thing this service ever needed from the node: every job that cares about
 * its transaction confirms it against the INDEXER afterwards.
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';

/** The subset of the SDK's `SubmissionService` this service uses. */
export interface SubmissionLike<TTransaction> {
  submitTransaction(transaction: TTransaction, waitForStatus?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The node, as everything above it needs to see it: bytes in, a transaction
 * hash out, and a `close` nobody but the facade's `stop()` ever calls.
 *
 * Narrow on purpose. The socket is the one part of this module that cannot be
 * tested from a unit test, so it is the one part behind this interface —
 * everything else is exercised against a fake connection.
 */
export interface NodeConnection {
  /** Resolves at the node's first status for this transaction. */
  send(transaction: Uint8Array): Promise<string>;
  /**
   * The node's best block height right now, or `null` if it cannot be asked.
   * Optional so a test's fake connection need not carry it. The rebuild path
   * reads it at a `1010` refusal, as the height the indexer must reach before
   * the refused transaction is worth building again.
   */
  height?(): Promise<number | null>;
  /**
   * Throw the current socket away and open a fresh one.
   *
   * Called by this module whenever a submission proves the socket dead, and
   * from outside by the health loop's `reconnect` remedy — including the
   * `refresh` rung, which on 2026/09/05 re-read the wallet while the connection
   * underneath it stayed dead for another four and a half hours.
   */
  rebuild?(reason: string): Promise<void>;
  /**
   * Re-attach the head watch to the connection that is already open.
   *
   * The `resubscribe` remedy in `./health.ts`. Optional so a test's fake
   * connection need not carry it, and deliberately NOT a rebuild: the fault it
   * repairs is a live, submitting socket that is merely not streaming heads.
   */
  resubscribe?(): Promise<void>;
  /** What the socket looks like right now. Published on `/status`. */
  socketHealth?(): NodeSocketHealth;
  close(): Promise<void>;
}

/**
 * The submission socket as `/status` and `./health.ts` see it.
 *
 * `connected` means no failure stands against it — which is also its state
 * before the first submission has opened anything.
 */
export type NodeSocketState = 'connected' | 'reconnecting' | 'dead';

export interface NodeSocketHealth {
  nodeSocket: NodeSocketState;
  /**
   * The node this connection is actually open on.
   *
   * With one node configured it is that node, always. With two it is the answer
   * to the only question an operator has during a provider's bad afternoon:
   * whether this sponsor fell through to the second one, or is still failing
   * against the first.
   */
  nodeUrlInUse: string;
  /** Submissions that have failed on the socket since the last one that did not. */
  consecutiveSocketFailures: number;
  /** Rebuilds that have failed since the last one that did not. */
  consecutiveRebuildFailures: number;
  /** Rebuilds attempted since this process started. */
  rebuilds: number;
  lastSocketFailureAt: string | null;
  /** The message of the most recent socket failure, for the journal. */
  lastSocketFailure: string | null;
  /** The chain as this socket sees it. See {@link SocketHead}. */
  socketHead: SocketHead;
}

/**
 * The head of the chain as read THROUGH THE SUBMISSION SOCKET.
 *
 * WHY IT IS NOT THE WALLET'S SYNC INDICES. The health ladder briefly judged
 * this socket by whether the wallet's sync indices moved while the public
 * node's head climbed, and on 2026/09/06 that called a perfectly well sponsor
 * degraded every two minutes: a wallet's unshielded `highestTransactionId` and
 * its shielded and DUST merkle indices only move when there is ledger activity
 * THAT CONCERNS IT, so on a quiet stagenet they stand still for hours while the
 * wallet is synced and every stream is connected. Wallet stillness was never
 * evidence of a dead socket; on 2026/09/05 the two happened to coincide.
 *
 * This is the like-for-like signal that rule wanted. It is one
 * `chain_subscribeNewHeads` on the very `ApiPromise` the service submits on —
 * the connection that actually died — so a head arriving over it is proof that
 * this socket is alive, and a head NOT arriving while the public node's HTTPS
 * probe climbs is proof that it is not. Both figures are block heights of the
 * same chain, so the difference between them is a number rather than an
 * analogy.
 *
 * `height: null` with `subscribed: false` means unknown — a connection that has
 * never opened, or a node client that does not offer the subscription — and
 * `./health.ts` treats unknown as no evidence rather than as a stall.
 */
export interface SocketHead {
  /** The highest header this socket has delivered, or `null` for none yet. */
  height: number | null;
  /** When that header arrived, epoch ms. */
  at: number | null;
  /** Whether a head subscription is currently established on this socket. */
  subscribed: boolean;
  /**
   * Whether this connection's client OFFERS `subscribeNewHeads` at all.
   *
   * The field that separates the two ways `subscribed` can be false, which want
   * opposite responses. A client that does not implement the subscription can
   * never be made to stream heads, so asking again is a loop; a client that
   * offers it and whose attempt failed is one call away from working. Only the
   * second is worth a remedy — see the `resubscribe` rung in `./health.ts`.
   */
  offered: boolean;
  /** Headers delivered since this connection was last built. */
  headers: number;
}

/**
 * A connection that has no view of the chain, and is not pretending to.
 *
 * Used wherever a socket is torn down or has not been opened: every field is
 * the absence of an observation rather than a stale one. THIS IS LOAD BEARING.
 * On 2026/09/07 `unwatchHead` kept the dead connection's `height`, `at`, and
 * `headers` and cleared only `subscribed`, so a rebuild that FAILED left a
 * corpse behind — a height from ten minutes ago against a reference that was
 * still climbing. `./health.ts` read that as a socket falling further behind
 * every tick and rebuilt it again, and again, for as long as the outage lasted.
 * A connection that is gone knows nothing, and says so.
 */
export const NO_SOCKET_HEAD: SocketHead = {
  height: null,
  at: null,
  subscribed: false,
  offered: false,
  headers: 0,
};

/**
 * The socket-failure family: a submission that failed because the transport
 * under it was not there, rather than because the node said anything about the
 * transaction.
 *
 * Every one of the 520 failures of 2026/09/05 was one of the first two forms.
 * The third — `disconnected from wss://…: 1000:: Normal Closure` — is the older
 * defect this module was written for, and it belongs here because the remedy is
 * the same; it is deliberately NOT in {@link isUnsentSocketFailure}.
 */
const SOCKET_FAILURE =
  /websocket is not connected|failed ws request|disconnected from wss?:|websocket (?:is )?(?:closed|not open)/i;

/**
 * The subset of {@link SOCKET_FAILURE} in which the bytes provably never left
 * this process, so the submission may be retried on a fresh socket without any
 * risk of putting the same transaction on chain twice.
 *
 * polkadot-js raises both of these BEFORE it writes anything: `WebSocket is not
 * connected` is `WsProvider.send` refusing to queue a request on a socket that
 * is not open, and `Failed WS Request` is the same refusal named by the RPC
 * layer above it. A `disconnected from …` error, by contrast, reaches handlers
 * whose request had already gone out — that one is rebuilt and reported, never
 * resent.
 */
const UNSENT_SOCKET_FAILURE = /websocket is not connected|failed ws request/i;

const matchesAlongCauses = (pattern: RegExp, cause: unknown): boolean => {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const message =
      current instanceof Error ? `${current.name}: ${current.message}` : String(current);
    if (pattern.test(message)) return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
};

/** Did this failure come from the transport rather than from the node? */
export function isSocketFailure(cause: unknown): boolean {
  return matchesAlongCauses(SOCKET_FAILURE, cause);
}

/** Is it the kind of socket failure whose bytes provably never went out? */
export function isUnsentSocketFailure(cause: unknown): boolean {
  return matchesAlongCauses(UNSENT_SOCKET_FAILURE, cause);
}

/**
 * A submission that was abandoned rather than completed.
 *
 * It does NOT mean the transaction failed: by the time this is thrown the bytes
 * are almost always with the node, and both hangs it was written for had landed
 * on chain. The caller's job is to find out which — see `submitTx` in
 * `./wallet.ts`, which asks the indexer before it reverts anything.
 */
export class SubmissionTimeout extends Error {
  readonly waitedMs: number;

  constructor(waitedMs: number) {
    super(
      `The node did not acknowledge this transaction within ${Math.round(waitedMs / 1_000)} s. It may still have landed; the caller checks the indexer before giving up on it.`,
    );
    this.name = 'SubmissionTimeout';
    this.waitedMs = waitedMs;
  }
}

/** Matches {@link SubmissionTimeout} across a bundle boundary, as `isNodeRejection` does. */
export function isSubmissionTimeout(cause: unknown): boolean {
  if (cause instanceof SubmissionTimeout) return true;
  return cause instanceof Error && cause.name === 'SubmissionTimeout';
}

export interface SerialisedSubmissionOptions<TTransaction> {
  /** How long one submission may take. See `config.submitTimeoutMs`. */
  timeoutMs: number;
  /** Aborts the wait early — the running job's watchdog signal. */
  signal?: () => AbortSignal | undefined;
  /** One line per submission, for the journal. */
  log?: (line: string) => void;
  /**
   * Reports a step of the running spend job — `reservation.progress`.
   *
   * Not decoration. Submissions are serialised, so a job whose turn has not
   * come yet is genuinely doing nothing and saying nothing, and with three
   * lanes it can wait two full ceilings before it starts. Without a step
   * reported here that silence is indistinguishable from the wedge the stall
   * watchdog exists to catch, and the watchdog would eventually abort a job
   * that was merely queued.
   */
  onStep?: (step: string) => void;
}

/** A transaction as the facade hands it over: it knows how to serialise itself. */
interface Serialisable {
  serialize(): Uint8Array;
}

/* The extrinsic is reached through the chain's own metadata, which is why none
   of this needs generated types: the node publishes the `midnight` pallet and
   polkadot-js builds `api.tx.midnight.sendMnTransaction` from it. */
export interface MidnightApi {
  /**
   * Resolves when the client has its metadata and its RPC methods.
   *
   * Optional because a test's fake api need not carry it, and awaited before
   * the head subscription is opened: `ApiPromise.create` is built here with
   * `throwOnConnect: false`, so it can hand back a client whose provider is
   * still settling, and `subscribeNewHeads` on one of those rejects.
   */
  isReady?: Promise<unknown>;
  isConnected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  rpc: {
    chain: {
      getHeader(): Promise<{ number: { toNumber(): number } }>;
      /**
       * The head, streamed over THIS socket.
       *
       * Optional so a test's fake api need not carry it, and guarded at the one
       * call site — a connection with no subscription simply reports no socket
       * head, which reads as "unknown" rather than as "stalled".
       */
      subscribeNewHeads?(
        callback: (header: { number: { toNumber(): number } }) => void,
      ): Promise<() => void>;
    };
  };
  tx: {
    midnight: {
      sendMnTransaction(payload: string): {
        send(callback: (result: ExtrinsicStatusResult) => void): Promise<() => void>;
      };
    };
  };
}

interface ExtrinsicStatusResult {
  txHash: { toString(): string };
  status: {
    type: string;
    isReady: boolean;
    isBroadcast: boolean;
    isFuture: boolean;
    isInBlock: boolean;
    isFinalized: boolean;
    isRetracted: boolean;
    isInvalid: boolean;
    isDropped: boolean;
    isUsurped: boolean;
  };
}

export interface PolkadotConnectionOptions {
  /**
   * Builds one fresh connection to ONE node: a new `WsProvider` and a new
   * `ApiPromise` for the URL it is handed.
   *
   * Injected only by `test/submission.test.ts`, which is what makes the rebuild
   * path testable at all — the socket is otherwise the one part of this module
   * a unit test cannot reach. The URL argument is what makes the failover
   * testable too: a fake that answers differently per URL is the whole of the
   * "the second node picks it up" case.
   */
  createApi?: (url: string) => Promise<MidnightApi>;
  /**
   * How long one rebuild may take before it is abandoned and counted as
   * failed. Bounded because a rebuild that hangs is the outage again with a
   * different shape: `serialiseSubmissions` would abandon the submission on its
   * own ceiling and the next one would find the same half-built connection.
   */
  rebuildTimeoutMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The real connection: one `ApiPromise`, never disconnected by a submission —
 * and REBUILT, rather than waited on, the moment it is shown to be dead.
 *
 * Nothing here trusts `WsProvider`'s auto-reconnect any more. It is what the
 * service relied on until 2026/09/05, when a provider whose reconnect had
 * wedged failed 520 consecutive submissions over five hours while every other
 * signal this process publishes said the sponsor was well.
 */
export function polkadotConnection(
  config: { relayURL: URL; relayURLs?: readonly URL[] },
  options: PolkadotConnectionOptions = {},
): NodeConnection {
  /* The list, in the operator's order, with the singular `relayURL` as its one
     entry when no list was given. That is what the wallet facade hands down
     when it builds this service itself — see `submissionService` in
     `./wallet.ts`, which passes the configured list alongside it. */
  const relayUrls = (
    config.relayURLs && config.relayURLs.length > 0 ? config.relayURLs : [config.relayURL]
  ).map((url) => url.toString());
  const createApi =
    options.createApi ??
    ((url: string): Promise<MidnightApi> =>
      ApiPromise.create({
        provider: new WsProvider(url),
        throwOnConnect: false,
        noInitWarn: true,
      }) as unknown as Promise<MidnightApi>);
  const rebuildTimeoutMs = options.rebuildTimeoutMs ?? 20_000;
  const log = options.log ?? ((line: string) => console.warn(line));
  const now = options.now ?? Date.now;

  let opening: Promise<MidnightApi> | null = null;
  let socket: NodeSocketState = 'connected';
  let consecutiveSocketFailures = 0;
  let consecutiveRebuildFailures = 0;
  let rebuilds = 0;
  let lastSocketFailureAt: string | null = null;
  let lastSocketFailure: string | null = null;
  /* The node this connection is open on — the preferred one until something
     has actually been opened, which is also what it reads as for the whole life
     of a single-node deployment. */
  let nodeUrlInUse = relayUrls[0] as string;
  /* The head as seen THROUGH THIS SOCKET, and the unsubscribe for the watch
     that supplies it. See `subscribeHead` below for why this exists. */
  let socketHead: SocketHead = { ...NO_SOCKET_HEAD };
  let unsubscribeHead: (() => void) | null = null;

  /** Bounds one wait without leaving the loser of the race unhandled. */
  const bounded = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, fail) => {
          timer = setTimeout(
            () => fail(new Error(`${what} did not finish within ${Math.round(ms / 1_000)} s`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const noteSocketFailure = (cause: unknown): void => {
    consecutiveSocketFailures += 1;
    lastSocketFailureAt = new Date(now()).toISOString();
    lastSocketFailure = describeCause(cause);
  };

  /**
   * The head watch, attached to EVERY connection this module opens — the
   * initial one, a rebuilt one, and one revived by `connect()`.
   *
   * WHY EVERY PATH, AND NOT JUST THE FIRST. On 2026/09/07 the subscription was
   * attached only inside `openSomewhere`, so a connection that came back any
   * other way, or one whose subscribe call failed, submitted perfectly well and
   * streamed nothing for the rest of the process's life. Nothing retried it and
   * nothing could see that it was blind.
   *
   * WHAT IS RESET, AND WHEN. The whole reading goes to {@link NO_SOCKET_HEAD}
   * FIRST, before the subscription is attempted — so a fresh socket reads as
   * UNKNOWN rather than as the previous connection's frozen height. That is
   * what stops `./health.ts` reading a new connection as a stalled one and
   * rebuilding it for ever; a fresh socket earns its own five minutes from the
   * moment its watch begins, and its first header is what gives it a height.
   *
   * `api.isReady` is awaited before subscribing. `ApiPromise.create` is built
   * with `throwOnConnect: false`, so it can hand back a client whose provider
   * is still settling, and `subscribeNewHeads` on one of those rejects — which
   * is a blind socket produced by asking one moment too early.
   *
   * Failure to subscribe is never failure to connect: a connection that submits
   * but cannot stream heads is worth keeping, and what it costs is one signal.
   * The two ways that happens are told apart by `offered`, because they want
   * opposite responses — see {@link SocketHead.offered}.
   */
  const subscribeHead = async (api: MidnightApi, url: string): Promise<void> => {
    const subscribe = api.rpc.chain.subscribeNewHeads;
    /* Unknown, not stalled. Every field of the previous connection's view is
       dropped here, at the one moment we know it no longer describes anything. */
    socketHead = { ...NO_SOCKET_HEAD, offered: Boolean(subscribe) };
    if (!subscribe) {
      log(`[node] ${url} offers no new-head subscription — this socket streams no heads`);
      return;
    }
    try {
      if (api.isReady) await bounded(Promise.resolve(api.isReady), rebuildTimeoutMs, 'the client');
      const stop = await bounded(
        Promise.resolve(
          subscribe.call(api.rpc.chain, (header) => {
            const height = header.number.toNumber();
            socketHead = {
              ...socketHead,
              height:
                socketHead.height === null ? height : Math.max(socketHead.height, height),
              at: now(),
              subscribed: true,
              headers: socketHead.headers + 1,
            };
          }),
        ),
        rebuildTimeoutMs,
        'the head subscription',
      );
      unsubscribeHead = stop;
      socketHead = { ...socketHead, subscribed: true };
      log(`[node] subscribed to new heads on ${url}`);
    } catch (cause) {
      /* Logged and left alone, with `offered` still true — which is what marks
         this as the repairable kind of blindness and earns the `resubscribe`
         rung rather than another rebuild of a connection that is fine. */
      log(`[node] the head subscription could not be opened on ${url}: ${describeCause(cause)}`);
    }
  };

  /**
   * Ends the current head watch, if there is one. Never throws.
   *
   * The reading goes to {@link NO_SOCKET_HEAD} rather than merely losing its
   * `subscribed` flag. A torn-down connection has no view of the chain, and
   * keeping its last height was what turned one failed rebuild into an endless
   * series of them on 2026/09/07 — see `NO_SOCKET_HEAD`.
   */
  const unwatchHead = (): void => {
    try {
      unsubscribeHead?.();
    } catch {
      // A subscription the node has already closed is not a failure.
    }
    unsubscribeHead = null;
    socketHead = { ...NO_SOCKET_HEAD };
  };

  /**
   * Opens ONE connection, walking the node list left to right.
   *
   * Every URL gets the same bounded attempt the single node has always had, and
   * the first one that yields an api wins — the rest are never contacted. A URL
   * is passed over only when building against it REJECTS or exceeds
   * `rebuildTimeoutMs`, which is what an unreachable or wedged node looks like
   * from here; `throwOnConnect: false` means `ApiPromise.create` waits for a
   * socket rather than resolving without one, so the ceiling is the real test.
   *
   * Every attempt starts at the front of the list. There is deliberately no
   * cursor and no memory of which node failed last time: a rebuild is the
   * moment to ask the preferred provider whether it is back, and an outage that
   * is over should not need a restart to be noticed.
   */
  /**
   * Close a connection that arrived after this module stopped waiting for it.
   *
   * `bounded` is a RACE, not a cancellation: when an attempt exceeds
   * `rebuildTimeoutMs` the `createApi` promise underneath it goes on running,
   * and a node that was merely slow rather than unreachable eventually hands
   * back a perfectly good `ApiPromise` that nothing holds a reference to. Each
   * timed-out rebuild leaked one — an open websocket, with its own reconnect
   * timers, for the life of the process. The drill of 2026/09/07 produced one.
   *
   * IT IS CLOSED RATHER THAN ADOPTED, deliberately. By the time it arrives the
   * rebuild that asked for it has already failed and reported so, and the next
   * one may have opened a connection of its own — possibly to a different node,
   * since every attempt starts again at the front of the list. Adopting the
   * late arrival would race that: two live sockets, and whichever resolved last
   * silently deciding which one this service submits on. A connection nobody
   * waited for is not a connection anybody asked for.
   *
   * Never throws and never touches `socketHead`: the arrival is not an
   * observation of anything, and the connection that IS open must not have its
   * reading disturbed by the closing of one that is not.
   */
  const closeLateArrival = (building: Promise<MidnightApi>, url: string): void => {
    void building
      .then((api) => {
        log(`[node] a late connection to ${url} was closed`);
        return api.disconnect().catch(() => undefined);
      })
      /* An attempt that REJECTED left nothing behind to close, and its refusal
         has already been recorded by the caller. Swallowed here so an abandoned
         promise cannot surface as an unhandled rejection. */
      .catch(() => undefined);
  };

  const openSomewhere = async (what: string): Promise<MidnightApi> => {
    const refusals: string[] = [];
    for (const url of relayUrls) {
      /* Held apart from the race so the abandoned promise can still be reached:
         `bounded` stops waiting on it, it does not stop it. */
      const building = createApi(url);
      try {
        const api = await bounded(building, rebuildTimeoutMs, what);
        nodeUrlInUse = url;
        if (refusals.length > 0) {
          /* The line that matters most on the day this earns its keep: the
             preferred node refused and a second one picked the sponsor up. A
             fall-through that succeeded in silence is the outage nobody
             noticed. */
          log(`[node] fell through to ${url} — ${refusals.join('; ')}`);
        }
        await subscribeHead(api, url);
        return api;
      } catch (cause) {
        refusals.push(`${url}: ${describeCause(cause)}`);
        closeLateArrival(building, url);
      }
    }
    throw new Error(
      relayUrls.length === 1
        ? (refusals[0] as string)
        : `no configured node could be reached — ${refusals.join('; ')}`,
    );
  };

  /**
   * Throw the socket away and open another.
   *
   * The old one is DISCARDED, not reconnected: a provider that has decided it
   * is reconnecting cannot be talked out of it — `connect()` on one rejects,
   * which is what the old code read as "the provider is doing exactly what is
   * wanted" for five hours.
   */
  const rebuild = async (reason: string): Promise<MidnightApi> => {
    const previous = opening;
    opening = null;
    unwatchHead();
    socket = 'reconnecting';
    rebuilds += 1;
    log(`[node] rebuilding the submission connection — ${reason} (rebuild ${rebuilds})`);
    if (previous) {
      const stale = await previous.catch(() => null);
      /* Not awaited: `WsProvider.disconnect()` resolves before the close event
         either way, and a socket nothing will submit on again is not worth
         holding the next submission for. */
      void stale?.disconnect().catch(() => undefined);
    }
    const fresh = openSomewhere('the submission connection rebuild');
    opening = fresh;
    try {
      const api = await fresh;
      consecutiveRebuildFailures = 0;
      socket = 'connected';
      log(`[node] the submission connection is rebuilt on ${nodeUrlInUse}`);
      return api;
    } catch (cause) {
      consecutiveRebuildFailures += 1;
      socket = 'dead';
      if (opening === fresh) opening = null;
      log(
        `[node] the submission connection could NOT be rebuilt (${consecutiveRebuildFailures} in a row): ${describeCause(cause)}`,
      );
      throw cause;
    }
  };

  const connected = async (): Promise<MidnightApi> => {
    if (!opening) opening = openSomewhere('the submission connection');
    let api: MidnightApi;
    try {
      api = await opening;
    } catch (cause) {
      opening = null;
      return await rebuild(`the connection could not be opened: ${describeCause(cause)}`);
    }
    if (api.isConnected) return api;
    /* One bounded attempt at the cheap repair, and then a fresh connection
       whatever it says. `connect()` rejecting is not evidence that a reconnect
       is under way, and neither is it resolving: what counts is whether the
       socket is connected afterwards. */
    const reachable = await bounded(api.connect(), rebuildTimeoutMs, 'the socket reconnect').then(
      () => api.isConnected,
      () => false,
    );
    if (reachable) return api;
    return await rebuild('the node socket reports itself disconnected');
  };

  const sendOn = async (api: MidnightApi, payload: string): Promise<string> =>
    await new Promise<string>((settle, fail) => {
      let unsubscribe: (() => void) | null = null;
      let done = false;
      const finish = (): void => {
        done = true;
        /* Ours alone. Unsubscribing ends this watch and touches no other, and
           it is the only teardown this module performs per submission. */
        try {
          unsubscribe?.();
        } catch {
          // A subscription the node has already closed is not a failure.
        }
      };
      api.tx.midnight
        .sendMnTransaction(payload)
        .send((result) => {
          if (done) return;
          const status = result.status;
          if (
            status.isReady ||
            status.isBroadcast ||
            status.isFuture ||
            status.isRetracted ||
            status.isInBlock ||
            status.isFinalized
          ) {
            settle(result.txHash.toString());
            finish();
          } else if (status.isInvalid || status.isDropped || status.isUsurped) {
            /* Worded so `isNodeRejection` matches it. These are the node
               refusing a transaction it had already taken over RPC, and the
               remedy is the rebuild a `1010` gets. */
            fail(
              new Error(
                `1010: Invalid Transaction: the node reported this transaction as ${status.type}`,
              ),
            );
            finish();
          }
        })
        .then(
          (thunk) => {
            unsubscribe = thunk;
            /* The status callback can fire before the subscription handle
               arrives, so the watch may already be over by now. */
            if (done) finish();
          },
          (cause: unknown) => {
            /* A refusal at the RPC itself: `1010: Invalid Transaction: Custom
               error: 231` and its kin. Passed out untouched. */
            fail(cause);
          },
        );
    });

  return {
    async height(): Promise<number | null> {
      try {
        const api = await connected();
        const header = await api.rpc.chain.getHeader();
        return header.number.toNumber();
      } catch {
        return null;
      }
    },

    async rebuild(reason: string): Promise<void> {
      await rebuild(reason);
    },

    /**
     * Attach the head watch to the CURRENT connection, without rebuilding it.
     *
     * The remedy for the one fault a rebuild is the wrong answer to: a socket
     * that is connected and submitting perfectly well, whose client offers the
     * subscription, and which is nevertheless streaming no heads because the
     * subscribe call failed. Rebuilding that throws away a working connection —
     * and, if the subscribe went on failing, would throw one away every five
     * minutes for ever.
     *
     * Never throws: `subscribeHead` swallows and logs, so a re-subscribe that
     * cannot be made leaves `subscribed: false` and the ladder where it was.
     */
    async resubscribe(): Promise<void> {
      const api = opening ? await opening.catch(() => null) : null;
      if (!api) {
        log('[node] there is no open connection to subscribe to new heads on');
        return;
      }
      unwatchHead();
      await subscribeHead(api, nodeUrlInUse);
    },

    socketHealth(): NodeSocketHealth {
      return {
        nodeSocket: socket,
        nodeUrlInUse,
        consecutiveSocketFailures,
        consecutiveRebuildFailures,
        rebuilds,
        lastSocketFailureAt,
        lastSocketFailure,
        socketHead: { ...socketHead },
      };
    },

    async send(transaction: Uint8Array): Promise<string> {
      const payload = u8aToHex(transaction);
      try {
        const txHash = await sendOn(await connected(), payload);
        consecutiveSocketFailures = 0;
        socket = 'connected';
        return txHash;
      } catch (cause) {
        /* Anything the NODE said about this transaction travels out untouched —
           a `1010` is a rebuild for the caller, not for the socket. */
        if (!isSocketFailure(cause)) throw cause;
        noteSocketFailure(cause);
        log(
          `[node] a submission failed on a dead socket (${consecutiveSocketFailures} in a row): ${describeCause(cause)}`,
        );
        /* Retried only when the bytes provably never left this process. A
           `disconnected from …` failure reaches a request that had already gone
           out, and resending that would be this service putting the same
           transaction on chain twice. */
        const resendable = isUnsentSocketFailure(cause);
        let api: MidnightApi;
        try {
          api = await rebuild('a submission failed on a dead socket');
        } catch {
          /* The original failure is the one the caller's classifier reads, and
             it names the real fault. The rebuild's own failure is counted and
             logged above, and `./health.ts` escalates on the count. */
          throw cause;
        }
        if (!resendable) throw cause;
        try {
          const txHash = await sendOn(api, payload);
          consecutiveSocketFailures = 0;
          socket = 'connected';
          log('[node] the retried submission went out on the rebuilt connection');
          return txHash;
        } catch (second) {
          if (isSocketFailure(second)) {
            noteSocketFailure(second);
            socket = 'dead';
          }
          throw second;
        }
      }
    },

    async close(): Promise<void> {
      unwatchHead();
      if (!opening) return;
      const api = await opening.catch(() => null);
      opening = null;
      await api?.disconnect().catch(() => undefined);
    },
  };
}

/**
 * Bounds every submission, and takes them one at a time.
 *
 * The ceiling is the part that matters: nothing underneath this bounds
 * anything. A submission still unanswered at `timeoutMs` is abandoned with a
 * typed {@link SubmissionTimeout}, and the caller — `submitTx` in `./wallet.ts`
 * — asks the indexer whether it landed before reverting anything.
 *
 * One at a time is no longer what keeps submissions safe from each other, and
 * it is kept for a smaller reason: at the node's first status the window is
 * under a second, and it keeps the node from being handed several transactions
 * of this wallet's built against one view of its coins at once.
 */
export function serialiseSubmissions<TTransaction>(
  connection: NodeConnection,
  options: SerialisedSubmissionOptions<TTransaction>,
): SubmissionLike<TTransaction> {
  let tail: Promise<unknown> = Promise.resolve();

  const bounded = async (transaction: TTransaction): Promise<{ txHash: string }> => {
    options.onStep?.('submitting');
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const signal = options.signal?.();
    try {
      const txHash = await new Promise<string>((settle, fail) => {
        timer = setTimeout(() => fail(new SubmissionTimeout(Date.now() - startedAt)), options.timeoutMs);
        if (signal) {
          if (signal.aborted) {
            fail(new SubmissionTimeout(Date.now() - startedAt));
            return;
          }
          onAbort = (): void => fail(new SubmissionTimeout(Date.now() - startedAt));
          signal.addEventListener('abort', onAbort, { once: true });
        }
        /* The underlying promise is merely stopped being waited on. Its
           eventual rejection is swallowed here rather than left to crash the
           process as an unhandled rejection. */
        void connection
          .send((transaction as unknown as Serialisable).serialize())
          .then(settle, fail);
      });
      return { txHash };
    } finally {
      if (timer) clearTimeout(timer);
      /* Removed on EVERY path, not just on abort. One job submits several
         transactions against one `AbortController`, and listeners that
         accumulated on it would trip Node's max-listeners warning and hold the
         closure of every submission the job had already finished. */
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  };

  return {
    async submitTransaction(transaction: TTransaction): Promise<unknown> {
      /* Chained on the tail rather than guarded by a flag, so submissions run
         in arrival order and a rejected predecessor never poisons the chain. */
      /* Announced before the wait, not after it: this is the step that explains
         a job which is about to go quiet for somebody else's ceiling. */
      options.onStep?.('waiting to submit');
      const mine = tail.then(
        () => bounded(transaction),
        () => bounded(transaction),
      );
      tail = mine.then(
        () => undefined,
        () => undefined,
      );
      const result = await mine;
      options.log?.('[job] the node acknowledged this transaction');
      return result;
    },
    close: () => connection.close(),
  };
}

/**
 * The submission service this service hands to `WalletFacade.init`.
 *
 * Every node submission the balancer makes goes through it, because it IS the
 * facade's service: the DUST registration's `facade.submitTransaction`, the
 * spare-mint path, and the contract path in `midnightProvider.submitTx`.
 */
export function serialisedSubmissionService<TTransaction>(
  config: { relayURL: URL; relayURLs?: readonly URL[] },
  options: SerialisedSubmissionOptions<TTransaction>,
  connectionOptions: PolkadotConnectionOptions = {},
): SubmissionLike<TTransaction> {
  return serialiseSubmissions(polkadotConnection(config, connectionOptions), options);
}
