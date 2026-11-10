/** Client policy for the remaining lifetime of a finite grant. All quantities
 * are whole UNIX seconds or durations in seconds, represented as bigint. */
export interface GrantPreflightOptions {
  /** Read the current node head on every invocation, not an indexer timestamp. */
  readNodeHeadTimeSeconds: () => Promise<bigint>;
  /** Network block interval and admission tolerance for the supported stack. */
  admissionMarginSeconds: bigint;
  /** Measured proving and balancing budget for this operation and stack. */
  proveAndBalanceSeconds: bigint;
  /** Defaults to the host wall clock. Injectable for deterministic tests. */
  nowSeconds?: () => bigint;
}

export class GrantPreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'GrantPreflightError';
  }
}

const MAX_U64 = (1n << 64n) - 1n;

function seconds(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) {
    throw new GrantPreflightError('invalid_time', `${label} must be an explicit Uint64 bigint in seconds`);
  }
  return value;
}

/** No omitted-expiry default: zero is a deliberate never-expiring choice. */
export function assertExplicitGrantExpiry(value: unknown): asserts value is bigint {
  seconds(value, 'expiresAt');
}

/** A preflight result is advisory; the circuit and admission rules still apply. */
export async function checkGrantExpiry(expiresAt: bigint, options?: GrantPreflightOptions): Promise<void> {
  assertExplicitGrantExpiry(expiresAt);
  if (expiresAt === 0n) return;
  if (!options || typeof options.readNodeHeadTimeSeconds !== 'function') {
    throw new GrantPreflightError('timing_required', 'finite grants require a fresh node-head reader and explicit timing budgets');
  }
  const admission = seconds(options.admissionMarginSeconds, 'admissionMarginSeconds');
  const proving = seconds(options.proveAndBalanceSeconds, 'proveAndBalanceSeconds');
  const head = seconds(await options.readNodeHeadTimeSeconds(), 'node head time');
  // Sample after the awaited head read so its latency cannot age this check.
  const now = seconds(options.nowSeconds ? options.nowSeconds() : BigInt(Math.floor(Date.now() / 1000)), 'wall clock');
  if (expiresAt <= now || expiresAt <= head) {
    throw new GrantPreflightError('expired', 'grant expired against the wall clock or node head');
  }
  // BigInt arithmetic deliberately avoids numeric conversion or Uint64 wrap.
  // Equality leaves no safe admission horizon and is refused as well.
  const horizon = (now > head ? now : head) + admission + proving;
  if (expiresAt <= horizon) {
    throw new GrantPreflightError('insufficient_horizon', 'grant expiry does not exceed the proving, balancing, and admission horizon');
  }
}
