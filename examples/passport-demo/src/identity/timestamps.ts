/**
 * The one reader every timestamp comparison in the identity layer uses.
 *
 * It lives in its own module because two of those comparisons are in modules
 * that must not import each other: `./backup.ts` reaches the three stores
 * through DYNAMIC imports so the backup code stays out of the app's first
 * chunk, and `./incentiveStore.ts` is imported eagerly by the app. A static
 * edge either way would undo one of those two facts, and a second copy of the
 * rule in each module is exactly the drift this file exists to prevent.
 *
 * WHY `Date.parse` IS NOT THE READER
 * ----------------------------------
 * `Date.parse` is not a validator. It is specified to fall back to any
 * implementation-defined format it likes, so `Date.parse('99999')` answers with
 * the first of January in the year 99999 — a number, and therefore a comparison
 * that silently decides a file is newer than everything in this browser. Every
 * timestamp this app writes is written by `toISOString()` or by nothing, so
 * anything that is not ISO-8601 is a timestamp this app cannot read, and saying
 * so is the whole point.
 */

/**
 * The shape every timestamp this app writes has, and the only shape the
 * comparisons will read.
 */
export const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** The milliseconds an ISO-8601 timestamp names, or null when it names none. */
export function readTimestamp(value: string): number | null {
  if (!ISO_8601.test(value)) return null;
  const parsed = Date.parse(value);
  /* The pattern admits a shape; it cannot admit a date. `2026-13-01` is the
     right shape and is not a day. */
  return Number.isNaN(parsed) ? null : parsed;
}
