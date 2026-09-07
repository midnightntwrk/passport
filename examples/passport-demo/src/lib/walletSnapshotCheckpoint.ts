/**
 * The cadence for persisting a wallet's real sync state.
 *
 * A mobile browser can discard a backgrounded Passport before its wallet has
 * caught up. Waiting for `isSynced` in that case means there is no resume point
 * at all, so the next launch repeats the same walk from genesis. A checkpoint
 * while the walk is active is safe: the SDK serialises the applied index and
 * restores from that exact point.
 *
 * Partial checkpoints are deliberately more frequent than steady-state
 * refreshes. They cap the amount of work a killed PWA can lose without turning
 * every sync event into an IndexedDB write.
 */
export const UNSYNCED_SNAPSHOT_CHECKPOINT_MS = 15_000;
export const SYNCED_SNAPSHOT_REFRESH_MS = 60_000;

export interface WalletSnapshotCheckpointer {
  /** Records that the facade published a new state, and selects its cadence. */
  noteState(isSynced: boolean): void;
  /** Writes the latest dirty state now, unless another write already owns it. */
  flush(): Promise<void>;
  /** Stops future timers and writes the last state observed before shutdown. */
  stop(): Promise<void>;
}

export interface WalletSnapshotCheckpointerOptions {
  /** Serialises and stores the facade's current state. */
  save: () => Promise<void>;
  /** Test seam; production uses the partial-sync cadence above. */
  unsyncedIntervalMs?: number;
  /** Test seam; production uses the steady-state cadence above. */
  syncedIntervalMs?: number;
  /** Best-effort snapshots must never surface an unhandled rejection. */
  onError?: (cause: unknown) => void;
}

/**
 * Coalesces facade updates into bounded snapshot writes.
 *
 * There is at most one serialization in flight. If the facade publishes while
 * it runs, `dirty` remains set and the following tick (or `stop`) stores the
 * newer state. This matters because serialising the shielded tree is expensive,
 * and concurrent writes could let an older snapshot win after a newer one.
 */
export function createWalletSnapshotCheckpointer(
  options: WalletSnapshotCheckpointerOptions,
): WalletSnapshotCheckpointer {
  const unsyncedIntervalMs = options.unsyncedIntervalMs ?? UNSYNCED_SNAPSHOT_CHECKPOINT_MS;
  const syncedIntervalMs = options.syncedIntervalMs ?? SYNCED_SNAPSHOT_REFRESH_MS;
  let active = true;
  let dirty = false;
  let syncState: boolean | null = null;
  let intervalMs: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let saveInFlight: Promise<void> | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    intervalMs = null;
  };

  const flush = (): Promise<void> => {
    if (saveInFlight) return saveInFlight;
    if (!dirty) return Promise.resolve();

    dirty = false;
    const operation = Promise.resolve()
      .then(options.save)
      .catch((cause: unknown) => options.onError?.(cause))
      .finally(() => {
        if (saveInFlight === operation) saveInFlight = null;
      });
    saveInFlight = operation;
    return operation;
  };

  const setCadence = (nextIntervalMs: number) => {
    if (timer !== null && intervalMs === nextIntervalMs) return;
    clearTimer();
    intervalMs = nextIntervalMs;
    timer = setInterval(() => {
      void flush();
    }, nextIntervalMs);
  };

  return {
    noteState(isSynced: boolean): void {
      if (!active) return;
      dirty = true;
      if (syncState === isSynced) return;

      syncState = isSynced;
      setCadence(isSynced ? syncedIntervalMs : unsyncedIntervalMs);
      /* A completed first sync is the most valuable snapshot: write it now,
         then return to the lower steady-state cadence. */
      if (isSynced) void flush();
    },

    flush,

    async stop(): Promise<void> {
      if (!active) return;
      clearTimer();
      /* The first flush runs with the checkpointer still ACTIVE, so a state
         that arrives while it writes is recorded as dirty and picked up by the
         second flush below. Deactivating first would make that second write
         unreachable, and the newest state would be lost at shutdown. */
      await flush();
      active = false;
      clearTimer();
      /* A state may have arrived while a periodic write was in flight. One
         follow-up makes shutdown's final snapshot the newest one observed,
         without retrying a permanently unavailable IndexedDB forever. */
      if (dirty) await flush();
    },
  };
}
