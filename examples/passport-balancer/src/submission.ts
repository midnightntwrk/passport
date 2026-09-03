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
 * Everything about that traces back to one line in the SDK.
 * `PolkadotNodeClient.sendMidnightTransaction` ends every submission stream
 * with `Stream.ensuring(api.disconnect())`, and `PolkadotNodeClient.make`
 * disconnects once more the moment it has loaded metadata. polkadot-js's
 * `WsProvider.disconnect()` calls `websocket.close(1000)` and RESOLVES
 * IMMEDIATELY — it does not wait for the socket's close event — and when that
 * event eventually arrives, `#onSocketClose` walks the provider-wide handler
 * map and errors every entry in it, while `#resubscribe` explicitly skips
 * anything whose type starts with `author_`. So a disconnect belonging to one
 * submission reaches whatever the connection is doing a moment later:
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
 * TWO FIXES THAT DID NOT HOLD, BECAUSE THEY BOTH LEFT THE DISCONNECT IN PLACE
 * --------------------------------------------------------------------------
 * Serialising submissions was the first. It cannot work: the damage is done by
 * an event that arrives after the submission which caused it is already over,
 * so there is no ordering of submissions that keeps them apart.
 *
 * Giving each submission its own client was the second, and it made things
 * worse rather than better — every submission then hit the CONSTRUCTION
 * disconnect instead, the one `PolkadotNodeClient.make` performs after loading
 * metadata, a second or so before the submission it was built for. Deployed at
 * 02:41 UTC on 2026/09/03, it failed a grant, a mint, and a registration in
 * the first ninety seconds, all with `1000:: Normal Closure`.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * It keeps ONE polkadot-js connection and never disconnects it. Submission is
 * `api.tx.midnight.sendMnTransaction(...).send(callback)` — the same call the
 * SDK makes — with this service unsubscribing its own subscription when it is
 * finished with it and nothing ever closing the socket underneath anybody.
 * `WsProvider` reconnects on its own if the socket drops, so the connection
 * outlives a network blip without any of this having to notice.
 *
 * Two properties are then true that were not before: a submission cannot be
 * killed by another submission's clean-up, and a submission cannot wait for
 * ever, because {@link SubmissionTimeout} bounds it whatever the socket does.
 *
 * And one consequence worth stating plainly: this asks the node for the first
 * status it reports rather than for finality. A node REFUSAL still arrives, as
 * the rejection of the `.send()` call itself — which is what `isNodeRejection`
 * and `withNodeRejectionRetry` match on, so neither changes — while the 15–25 s
 * of stagenet finality per submission comes off the user's click. Finality is
 * not a thing this service ever needed from the node: every job that cares
 * about its transaction confirms it against the INDEXER afterwards.
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';

/** The subset of the SDK's `SubmissionService` this service uses. */
export interface SubmissionLike<TTransaction> {
  submitTransaction(transaction: TTransaction, waitForStatus?: unknown): Promise<unknown>;
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

/** What a submission reports back. Nothing in this service reads it. */
export interface SubmissionAcknowledged {
  txHash: string;
  status: string;
}

/** A transaction as the facade hands it over: it knows how to serialise itself. */
interface Serialisable {
  serialize(): Uint8Array;
}

/* The extrinsic is reached through the chain's own metadata, which is why this
   needs no generated types: the node publishes the `midnight` pallet and
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
 * One connection to the node, opened once and never closed by a submission.
 *
 * `WsProvider` is left with its own auto-reconnect, which is the whole point:
 * a socket that drops comes back by itself, and nothing in this file ever calls
 * `disconnect()` except {@link close}, which the facade calls when it stops.
 */
export function persistentNodeSubmission<TTransaction>(config: {
  relayURL: URL;
}): SubmissionLike<TTransaction> {
  let opening: Promise<MidnightApi> | null = null;

  const api = async (): Promise<MidnightApi> => {
    if (!opening) {
      opening = ApiPromise.create({
        provider: new WsProvider(config.relayURL.toString()),
        throwOnConnect: false,
        noInitWarn: true,
      }) as unknown as Promise<MidnightApi>;
    }
    const ready = await opening;
    if (!ready.isConnected) {
      /* `connect()` rejects when a reconnect is already in flight, which is not
         an error here — the provider is doing exactly what is wanted. */
      await ready.connect().catch(() => undefined);
    }
    return ready;
  };

  return {
    async submitTransaction(transaction: TTransaction): Promise<unknown> {
      const connection = await api();
      const bytes = (transaction as unknown as Serialisable).serialize();
      return await new Promise<SubmissionAcknowledged>((settle, fail) => {
        let unsubscribe: (() => void) | null = null;
        let done = false;
        const finish = (): void => {
          done = true;
          /* Ours alone. Unsubscribing ends this watch and touches no other. */
          try {
            unsubscribe?.();
          } catch {
            // A subscription the node has already closed is not a failure.
          }
        };
        connection.tx.midnight
          .sendMnTransaction(u8aToHex(bytes))
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
              settle({ txHash: result.txHash.toString(), status: status.type });
              finish();
            } else if (status.isInvalid || status.isDropped || status.isUsurped) {
              /* Worded so `isNodeRejection` matches it: these are the node
                 refusing the transaction after it accepted the RPC, and the
                 remedy is the same rebuild a `1010` gets. */
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
              /* Settled before the subscription handle arrived — the status
                 callback can fire first — so end the watch now. */
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
      const ready = await opening.catch(() => null);
      opening = null;
      await ready?.disconnect().catch(() => undefined);
    },
  };
}

/**
 * Bounds every submission, and takes them one at a time.
 *
 * The ceiling is the part that matters: nothing underneath this bounds
 * anything, and `reconnectionTimeout` in the SDK's client is
 * `Duration.infinity`. A submission that is still unanswered at `timeoutMs` is
 * abandoned with a typed {@link SubmissionTimeout}, and the caller — `submitTx`
 * in `./wallet.ts` — asks the indexer whether it landed before reverting
 * anything.
 *
 * One at a time is no longer load-bearing now that no submission can disturb
 * another, and it is kept for a smaller reason: at the node's first status the
 * window is under a second, and it keeps the node from being handed several
 * transactions of this wallet's built against one view of its coins at once.
 */
export function serialiseSubmissions<TTransaction>(
  inner: SubmissionLike<TTransaction>,
  options: SerialisedSubmissionOptions<TTransaction>,
): SubmissionLike<TTransaction> {
  let tail: Promise<unknown> = Promise.resolve();

  const bounded = async (transaction: TTransaction): Promise<unknown> => {
    options.onStep?.('submitting');
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const signal = options.signal?.();
    try {
      return await new Promise((settle, fail) => {
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
        void inner.submitTransaction(transaction).then(settle, fail);
      });
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
    close: () => inner.close(),
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
  return serialiseSubmissions(persistentNodeSubmission<TTransaction>(config), options);
}
