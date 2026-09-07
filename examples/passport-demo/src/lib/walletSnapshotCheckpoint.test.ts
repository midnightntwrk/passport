import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWalletSnapshotCheckpointer,
  SYNCED_SNAPSHOT_REFRESH_MS,
  UNSYNCED_SNAPSHOT_CHECKPOINT_MS,
} from './walletSnapshotCheckpoint.js';

describe('createWalletSnapshotCheckpointer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checkpoints an unfinished walk instead of waiting for 100% sync', async () => {
    vi.useFakeTimers();
    const save = vi.fn((): Promise<void> => Promise.resolve());
    const checkpoints = createWalletSnapshotCheckpointer({ save });

    checkpoints.noteState(false);
    await vi.advanceTimersByTimeAsync(UNSYNCED_SNAPSHOT_CHECKPOINT_MS - 1);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    await checkpoints.stop();
  });

  it('writes at completion, then returns to the quieter steady-state cadence', async () => {
    vi.useFakeTimers();
    const save = vi.fn((): Promise<void> => Promise.resolve());
    const checkpoints = createWalletSnapshotCheckpointer({ save });

    checkpoints.noteState(false);
    checkpoints.noteState(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);

    checkpoints.noteState(true);
    await vi.advanceTimersByTimeAsync(SYNCED_SNAPSHOT_REFRESH_MS - 1);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
    await checkpoints.stop();
  });

  it('does not let a stale write win when the facade updates during it', async () => {
    let finishFirst: (() => void) | undefined;
    const save = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const checkpoints = createWalletSnapshotCheckpointer({ save });

    checkpoints.noteState(true);
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    checkpoints.noteState(true);
    finishFirst?.();
    await checkpoints.stop();

    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('the checkpointer at its edges', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores state after it has stopped, and stopping twice is harmless', async () => {
    vi.useFakeTimers();
    const saves: number[] = [];
    const checkpointer = createWalletSnapshotCheckpointer({
      save: async () => {
        saves.push(Date.now());
      },
    });
    checkpointer.noteState(false);
    await checkpointer.stop();
    await checkpointer.stop();
    checkpointer.noteState(true);
    await vi.advanceTimersByTimeAsync(UNSYNCED_SNAPSHOT_CHECKPOINT_MS * 2);
    expect(saves).toHaveLength(1);
  });

  it('shares one write between callers while it is in flight, and keeps one cadence per state', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    let saves = 0;
    const checkpointer = createWalletSnapshotCheckpointer({
      save: () =>
        new Promise<void>((resolve) => {
          saves += 1;
          release = resolve;
        }),
    });
    checkpointer.noteState(false);
    checkpointer.noteState(false);
    const first = checkpointer.flush();
    const second = checkpointer.flush();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    release();
    await first;
    expect(saves).toBe(1);
    expect(await checkpointer.flush()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(UNSYNCED_SNAPSHOT_CHECKPOINT_MS);
    expect(saves).toBe(1);
    await checkpointer.stop();
  });

  it('swallows a failed write when nobody asked to hear about it, and writes again at stop if state moved mid-write', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let checkpointer: ReturnType<typeof createWalletSnapshotCheckpointer>;
    checkpointer = createWalletSnapshotCheckpointer({
      save: async () => {
        calls += 1;
        if (calls === 1) throw new Error('no storage');
        if (calls === 2) checkpointer.noteState(true);
      },
    });
    checkpointer.noteState(false);
    await checkpointer.flush();
    checkpointer.noteState(false);
    await checkpointer.stop();
    expect(calls).toBe(3);
  });

  it('keeps one timer when both cadences are the same, and stops cleanly having never been told a state', async () => {
    vi.useFakeTimers();
    let saves = 0;
    const same = createWalletSnapshotCheckpointer({
      save: async () => {
        saves += 1;
      },
      unsyncedIntervalMs: 1_000,
      syncedIntervalMs: 1_000,
    });
    same.noteState(false);
    same.noteState(true);
    /* Synced writes at once; the timer then finds nothing dirty. */
    await vi.advanceTimersByTimeAsync(2_500);
    expect(saves).toBe(1);
    same.noteState(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toBe(2);
    await same.stop();
    const idle = createWalletSnapshotCheckpointer({ save: async () => undefined });
    await idle.stop();
  });

  it('hands a failed write to the listener that asked for it', async () => {
    const heard: unknown[] = [];
    const failing = createWalletSnapshotCheckpointer({
      save: async () => {
        throw new Error('quota');
      },
      onError: (cause) => {
        heard.push(cause);
      },
    });
    failing.noteState(false);
    await failing.flush();
    expect(heard).toHaveLength(1);
    expect((heard[0] as Error).message).toBe('quota');
    await failing.stop();
  });
});
