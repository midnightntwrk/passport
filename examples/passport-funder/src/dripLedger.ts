/**
 * The funder's once-only ledgers and the rolling-hour rate limiter.
 *
 * A ledger is the hard once-only gate for whatever it keys on — one activation
 * per address, one sponsored alias per account-custody contract, one activation
 * grant per account-custody contract — persisted as a small JSON file in the
 * state directory so a restart cannot forget who has already been served. The
 * rate limiter is in-memory: a restart resets the window, which for a global
 * back-stop is fine.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One activation drip, keyed by the recipient's unshielded address. */
export interface DripEntry {
  txHash: string;
  amountAtomic: string;
  at: string;
}

/**
 * One sponsored alias registration, keyed by the account-custody contract
 * address the name was bound to. Keyed on the CONTRACT and not the alias
 * because the limit being enforced is "one free name per Passport", and the
 * contract address is the thing a Passport has exactly one of.
 */
export interface AliasEntry {
  alias: string;
  resolverAddress: string;
  resolverDeployTx: string;
  registerTx: string;
  costAtomic: string;
  at: string;
}

/**
 * One activation grant paid into an account-custody contract, keyed by that
 * contract's address. Keyed on the CONTRACT for the same reason
 * {@link AliasEntry} is: the limit being enforced is "one opening balance per
 * Passport", and the contract address is the thing a Passport has exactly one
 * of. The address it was deployed FROM is not — a user can hold several.
 */
export interface AccountEntry {
  txHash: string;
  amountAtomic: string;
  balanceAfterAtomic: string;
  at: string;
}

/**
 * An append-mostly `Record<key, Entry>` on disk. Small enough to rewrite whole
 * on every record: the funder serves tens of entries a day, not thousands, and
 * a write-and-rename is atomic where a partial append would not be.
 */
export class JsonLedger<Entry> {
  private constructor(
    private readonly path: string,
    private readonly entries: Record<string, Entry>,
  ) {}

  /** `<name>-<networkId>.json` in the state directory. */
  static async open<E>(stateDir: string, networkId: string, name: string): Promise<JsonLedger<E>> {
    const path = join(stateDir, `${name}-${networkId}.json`);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, E>;
      return new JsonLedger<E>(path, parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
      return new JsonLedger<E>(path, {});
    }
  }

  get(key: string): Entry | null {
    return this.entries[key] ?? null;
  }

  get count(): number {
    return Object.keys(this.entries).length;
  }

  async record(key: string, entry: Entry): Promise<void> {
    this.entries[key] = entry;
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(this.entries, null, 2), 'utf8');
    await rename(temp, this.path);
  }
}

export class HourlyRateLimiter {
  private stamps: number[] = [];

  constructor(private readonly maxPerHour: number) {}

  /** True when another spend is allowed right now; records it when so. */
  take(): boolean {
    const now = Date.now();
    this.stamps = this.stamps.filter((stamp) => now - stamp < 3_600_000);
    if (this.stamps.length >= this.maxPerHour) return false;
    this.stamps.push(now);
    return true;
  }

  /**
   * Whether the ceiling is reached, WITHOUT consuming a slot.
   *
   * The ceiling counts spends, not requests. A caller that refuses for some
   * other reason — already served, wrong network, funder empty — has not
   * used the funder's hourly budget, and burning a slot on it would let a
   * stream of bad requests shut the funder down without a single NIGHT
   * leaving it. So `take()` is called only once a spend is actually about to
   * be attempted, and this exists for the cheap early refusal on the way in.
   */
  atCeiling(): boolean {
    const now = Date.now();
    this.stamps = this.stamps.filter((stamp) => now - stamp < 3_600_000);
    return this.stamps.length >= this.maxPerHour;
  }
}
