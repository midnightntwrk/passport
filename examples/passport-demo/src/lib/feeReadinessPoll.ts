/**
 * A watcher for the fee sponsor, for any surface that can afford to wait.
 *
 * WHY THIS EXISTS
 * ---------------
 * The sponsor reserves its DUST against each transaction it is balancing, so
 * `available: 0` is usually a statement about the next minute rather than about
 * the day — the activation grant alone puts it there for a minute or two every
 * time. A surface that read the sponsor ONCE, when it opened, and then refused
 * for as long as it stayed open was telling the user something that had already
 * stopped being true, and giving them no way to find out. Measured live on
 * 2026/08/25: a Send sheet opened seconds after the grant showed a dead modal —
 * no primary control at all — for the whole two minutes it took the sponsor's
 * own DUST to come back, and closing and reopening the sheet was the only way
 * to learn that it had.
 *
 * So the readiness is WATCHED, not sampled. Every
 * {@link FEE_READINESS_POLL_INTERVAL_MS} the probe runs again, and the moment
 * the sponsor can pay the surface hears about it and enables its control
 * without the user having done anything.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a gate. `feeReadiness()` is advisory — see `localWallet.ts` — and
 * every path that moves value keeps its own authoritative check. This decides
 * what a button LOOKS like, never whether a transaction may be built.
 *
 * The diagnostic half of a refusal (`detail`: wallet indices, DUST balances)
 * goes to {@link FeeReadinessPollOptions.log} — `console.info` by default — and
 * is deliberately absent from the snapshot's user-facing sentence. It is logged
 * once per distinct value rather than on every tick, so a sheet left open does
 * not fill the console with the same line.
 *
 * There is no DOM and no React in here on purpose: a controller with injectable
 * timers is a thing a unit test can drive with `vi.useFakeTimers()`, and this
 * workspace has no jsdom to render a hook into.
 */

import type { FeeReadiness } from './localWallet.js';

/**
 * How often the sponsor is asked again while a surface is open.
 *
 * Five seconds against a `busy` window measured in tens of seconds: short
 * enough that "it cleared" and "the button enabled" look like the same event,
 * long enough that a sheet left open is not a load-generator. Each probe is a
 * single `GET /wallet-status`.
 */
export const FEE_READINESS_POLL_INTERVAL_MS = 5_000;

/** Everything a surface renders from. */
export interface FeeReadinessSnapshot {
  /** The last answer, or `null` before the first one has arrived. */
  fee: FeeReadiness | null;
  /**
   * Why there is no answer, when the probe itself threw — a closed wallet, say.
   * Distinct from an `unsponsored` answer, which IS an answer.
   */
  error: string | null;
  /** A probe is in flight. Drives a "checking…" affordance, nothing more. */
  probing: boolean;
}

export interface FeeReadinessPollOptions {
  /** Reads the readiness. Should bypass any cache — see `sponsor.ts`'s `force`. */
  probe: () => Promise<FeeReadiness>;
  /** Called on every state change, including the first probe starting. */
  onChange: (snapshot: FeeReadinessSnapshot) => void;
  /** Defaults to {@link FEE_READINESS_POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Where the sponsor's diagnostic goes. Defaults to `console.info`. */
  log?: (message: string) => void;
}

export interface FeeReadinessPoll {
  /** Probes now, cancelling the scheduled tick. Ignored while one is in flight. */
  checkAgain: () => void;
  /** Stops for good. Any answer still in flight is dropped. */
  stop: () => void;
}

/**
 * Starts watching. The first probe runs immediately, and each subsequent one is
 * scheduled `intervalMs` after the previous one SETTLED — never on a fixed
 * clock, so a slow sponsor cannot be asked twice at once.
 */
export function startFeeReadinessPoll(options: FeeReadinessPollOptions): FeeReadinessPoll {
  const intervalMs = options.intervalMs ?? FEE_READINESS_POLL_INTERVAL_MS;
  const log = options.log ?? ((message: string) => console.info(message));

  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastLoggedDetail: string | null = null;
  let snapshot: FeeReadinessSnapshot = { fee: null, error: null, probing: false };

  const publish = (next: FeeReadinessSnapshot): void => {
    snapshot = next;
    options.onChange(snapshot);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, intervalMs);
  };

  const run = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    publish({ fee: snapshot.fee, error: snapshot.error, probing: true });
    try {
      const fee = await options.probe();
      if (stopped) return;
      /* The half the user must never see, said once. A repeated identical
         detail is the same fact ticking, not news. */
      if (fee.mode === 'unsponsored' && fee.detail !== null && fee.detail !== lastLoggedDetail) {
        lastLoggedDetail = fee.detail;
        log(`Fee sponsor ${fee.cause}: ${fee.detail}`);
      }
      publish({ fee, error: null, probing: false });
    } catch (cause) {
      if (stopped) return;
      publish({
        fee: null,
        error: cause instanceof Error ? cause.message : String(cause),
        probing: false,
      });
    } finally {
      inFlight = false;
      if (!stopped) schedule();
    }
  };

  void run();

  return {
    checkAgain: (): void => {
      if (stopped) return;
      clearTimer();
      void run();
    },
    stop: (): void => {
      stopped = true;
      clearTimer();
    },
  };
}
