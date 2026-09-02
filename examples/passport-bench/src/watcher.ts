/**
 * What the sponsors said about themselves while the bench was running.
 *
 * Two probes, at two rates, against the REAL hosts rather than through the
 * bench's proxy — a watcher's own traffic must not land in the per-user
 * latency figures it exists to explain.
 *
 *   * `GET /wallet-status`, at the fast rate, on every sponsor. This is the
 *     gate: the app will not attempt a `/balance-only` while `available` is 0,
 *     so every transition to 0 is a window in which arriving Passports were
 *     refused, and `unavailableCause` says which of the three reasons it was —
 *     `PENDING_TRANSACTION` (somebody else holds the coin state),
 *     `INSUFFICIENT_DUST` (the thing that ends the day at Token), or
 *     `WALLET_SYNCING`.
 *   * `GET /status`, at the slow rate, on our balancer only — the 1AM gateway
 *     does not serve it. This is where `dustSpecks` and `balancesServed` come
 *     from, and those two together are the only honest way to price a
 *     transaction: specks spent over balances served, with the wallet's own
 *     regeneration subtracted. See `./report.ts`.
 *
 * The slow rate is not thrift. `/status` reads the wallet's whole state,
 * progress, NIGHT balance, and DUST balance on every call; probing it at 1 Hz
 * for twenty minutes would be load the bench added and then measured.
 *
 * NOTHING here is written to disk unredacted. `/wallet-status` on the gateway
 * returns its DUST UTxO set, including backing NIGHT identifiers; only the
 * fields named in `WatchEvent` are kept.
 */

import type { WatchEvent } from './events.js';

export interface WatchTarget {
  /** `balancer` or `gateway`. */
  name: string;
  /** The real base URL, with no trailing slash. */
  url: string;
  /** Whether this service serves `GET /status` as well. Ours does; 1AM's does not. */
  hasStatus: boolean;
}

export interface WatcherOptions {
  targets: WatchTarget[];
  walletStatusIntervalMs: number;
  statusIntervalMs: number;
  onEvent: (event: WatchEvent) => void;
}

export interface WatcherHandle {
  stop(): void;
}

const PROBE_TIMEOUT_MS = 10_000;

async function probe(url: string): Promise<{ ms: number; ok: boolean; body: unknown; detail?: string }> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    const ms = Date.now() - started;
    if (!response.ok) {
      return { ms, ok: false, body: null, detail: `${response.status} ${text.slice(0, 200)}` };
    }
    try {
      return { ms, ok: true, body: JSON.parse(text) };
    } catch {
      return { ms, ok: false, body: null, detail: 'the answer was not JSON' };
    }
  } catch (cause) {
    return {
      ms: Date.now() - started,
      ok: false,
      body: null,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

interface WalletStatusShape {
  available?: number;
  wallets?: Array<{ unavailableCause?: string | null }>;
  pendingTxs?: { pending?: number };
}

interface StatusShape {
  dustSpecks?: string;
  balancesServed?: number;
  balancing?: boolean;
  busy?: boolean;
  ready?: boolean;
  health?: { verdict?: string; reason?: string } | null;
}

export function startWatcher(options: WatcherOptions): WatcherHandle {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];

  const loop = (intervalMs: number, run: () => Promise<void>): void => {
    const tick = async (): Promise<void> => {
      if (stopped) return;
      await run().catch(() => undefined);
      if (stopped) return;
      timers.push(setTimeout(() => void tick(), intervalMs));
    };
    void tick();
  };

  for (const target of options.targets) {
    loop(options.walletStatusIntervalMs, async () => {
      const answer = await probe(`${target.url}/wallet-status`);
      const body = (answer.body ?? {}) as WalletStatusShape;
      options.onEvent({
        kind: 'watch',
        at: Date.now(),
        service: target.name,
        probe: 'wallet-status',
        ms: answer.ms,
        ok: answer.ok,
        available: typeof body.available === 'number' ? body.available : undefined,
        unavailableCause: body.wallets?.[0]?.unavailableCause ?? null,
        pendingTxs: body.pendingTxs?.pending,
        ...(answer.detail ? { detail: answer.detail } : {}),
      });
    });

    if (!target.hasStatus) continue;

    loop(options.statusIntervalMs, async () => {
      const answer = await probe(`${target.url}/status`);
      const body = (answer.body ?? {}) as StatusShape;
      options.onEvent({
        kind: 'watch',
        at: Date.now(),
        service: target.name,
        probe: 'status',
        ms: answer.ms,
        ok: answer.ok,
        dustSpecks: body.dustSpecks,
        balancesServed: body.balancesServed,
        balancing: body.balancing,
        busy: body.busy,
        ready: body.ready,
        healthVerdict: body.health?.verdict,
        healthReason: body.health?.reason,
        ...(answer.detail ? { detail: answer.detail } : {}),
      });
    });
  }

  return {
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

/**
 * Every change in a sponsor's published availability, in order.
 *
 * A run produces hundreds of identical readings and two or three moments that
 * matter. This keeps the moments: the first reading, and thereafter only those
 * where `available` or `unavailableCause` differs from the one before it.
 */
export interface AvailabilityTransition {
  at: number;
  service: string;
  from: number | undefined;
  to: number | undefined;
  cause: string | null;
}

export function availabilityTransitions(events: readonly WatchEvent[]): AvailabilityTransition[] {
  const previous = new Map<string, { available: number | undefined; cause: string | null }>();
  const transitions: AvailabilityTransition[] = [];
  for (const event of events) {
    if (event.probe !== 'wallet-status') continue;
    const last = previous.get(event.service);
    const cause = event.unavailableCause ?? null;
    if (last === undefined || last.available !== event.available || last.cause !== cause) {
      transitions.push({
        at: event.at,
        service: event.service,
        from: last?.available,
        to: event.available,
        cause,
      });
      previous.set(event.service, { available: event.available, cause });
    }
  }
  return transitions;
}
