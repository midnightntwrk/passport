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
