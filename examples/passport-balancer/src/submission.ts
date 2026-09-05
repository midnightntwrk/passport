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
  /** Submissions that have failed on the socket since the last one that did not. */
  consecutiveSocketFailures: number;
  /** Rebuilds that have failed since the last one that did not. */
  consecutiveRebuildFailures: number;
  /** Rebuilds attempted since this process started. */
  rebuilds: number;
  lastSocketFailureAt: string | null;
  /** The message of the most recent socket failure, for the journal. */
  lastSocketFailure: string | null;
}

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
  isConnected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  rpc: { chain: { getHeader(): Promise<{ number: { toNumber(): number } }> } };
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
   * Builds one fresh connection: a new `WsProvider` and a new `ApiPromise`.
   *
   * Injected only by `test/submission.test.ts`, which is what makes the rebuild
   * path testable at all — the socket is otherwise the one part of this module
   * a unit test cannot reach.
   */
  createApi?: () => Promise<MidnightApi>;
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
  config: { relayURL: URL },
  options: PolkadotConnectionOptions = {},
): NodeConnection {
  const createApi =
    options.createApi ??
    ((): Promise<MidnightApi> =>
      ApiPromise.create({
        provider: new WsProvider(config.relayURL.toString()),
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
    const fresh = bounded(createApi(), rebuildTimeoutMs, 'the submission connection rebuild');
    opening = fresh;
    try {
      const api = await fresh;
      consecutiveRebuildFailures = 0;
      socket = 'connected';
      log('[node] the submission connection is rebuilt');
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
    if (!opening) opening = createApi();
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

    socketHealth(): NodeSocketHealth {
      return {
        nodeSocket: socket,
        consecutiveSocketFailures,
        consecutiveRebuildFailures,
        rebuilds,
        lastSocketFailureAt,
        lastSocketFailure,
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
  config: { relayURL: URL },
  options: SerialisedSubmissionOptions<TTransaction>,
  connectionOptions: PolkadotConnectionOptions = {},
): SubmissionLike<TTransaction> {
  return serialiseSubmissions(polkadotConnection(config, connectionOptions), options);
}
