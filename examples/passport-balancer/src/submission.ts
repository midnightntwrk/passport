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
  close(): Promise<void>;
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
interface MidnightApi {
  isConnected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
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

/**
 * The real connection: one `ApiPromise`, opened once and never disconnected by
 * a submission.
 *
 * `WsProvider` keeps its own auto-reconnect, which is the whole point — a
 * socket that drops comes back by itself, and nothing in here calls
 * `disconnect()` except {@link NodeConnection.close}.
 */
export function polkadotConnection(config: { relayURL: URL }): NodeConnection {
  let opening: Promise<MidnightApi> | null = null;

  const connected = async (): Promise<MidnightApi> => {
    if (!opening) {
      opening = ApiPromise.create({
        provider: new WsProvider(config.relayURL.toString()),
        throwOnConnect: false,
        noInitWarn: true,
      }) as unknown as Promise<MidnightApi>;
    }
    const api = await opening;
    if (!api.isConnected) {
      /* `connect()` rejects when a reconnect is already in flight, which is not
         an error here — the provider is doing exactly what is wanted. */
      await api.connect().catch(() => undefined);
    }
    return api;
  };

  return {
    async send(transaction: Uint8Array): Promise<string> {
      const api = await connected();
      return await new Promise<string>((settle, fail) => {
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
          .sendMnTransaction(u8aToHex(transaction))
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
): SubmissionLike<TTransaction> {
  return serialiseSubmissions(polkadotConnection(config), options);
}
