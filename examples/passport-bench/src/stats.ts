/**
 * Percentiles, and the one honesty rule that comes with them.
 *
 * A p95 over four samples is the largest of the four wearing a Greek letter.
 * Every summary this module produces therefore carries its own `n`, and
 * {@link formatSummary} refuses to print a p95 at all below
 * {@link MIN_SAMPLES_FOR_P95} — it prints the max instead, which is what the
 * number would have been anyway and is at least labelled truthfully. The
 * project lead is going to read these figures and decide whether 200 people
 * can onboard at once; a percentile that is really a maximum is exactly the
 * kind of number that makes that decision badly.
 */

/** Below this, a p95 is a max with a Greek letter on it. */
export const MIN_SAMPLES_FOR_P95 = 8;

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  min: number;
  mean: number;
  /** True when `n` is too small for `p95` to mean anything. */
  p95Unsound: boolean;
}

/**
 * The nearest-rank percentile: the smallest sample at or above the requested
 * rank. No interpolation, because an interpolated p95 of three latencies
 * invents a measurement that was never taken.
 */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

export function summarise(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { n: 0, p50: Number.NaN, p95: Number.NaN, max: Number.NaN, min: Number.NaN, mean: Number.NaN, p95Unsound: true };
  }
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[n - 1] as number,
    min: sorted[0] as number,
    mean: sum / n,
    p95Unsound: n < MIN_SAMPLES_FOR_P95,
  };
}

/** Milliseconds, rendered the way a person reads them. */
export function ms(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)} s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

/**
 * `p50 / p95 / max`, with the p95 struck out and named when there were not
 * enough samples to earn it. See the note at the top of this module.
 */
export function formatSummary(summary: Summary): string {
  if (summary.n === 0) return '— (no samples)';
  const p95 = summary.p95Unsound ? `_(max, n=${summary.n})_` : ms(summary.p95);
  return `${ms(summary.p50)} / ${p95} / ${ms(summary.max)}`;
}

/** Groups by a key, preserving insertion order of first appearance. */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = groups.get(k);
    if (bucket) bucket.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
