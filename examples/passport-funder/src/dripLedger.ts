/**
 * The drip ledger and the rolling-hour rate limiter.
 *
 * The ledger is the hard once-only gate: one activation per address, ever,
 * persisted as a small JSON file in the state directory so a restart cannot
 * forget who has already been activated. The rate limiter is in-memory —
 * a restart resets the window, which for a global back-stop is fine.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DripEntry {
  txHash: string;
  amountAtomic: string;
  at: string;
}

export class DripLedger {
  private constructor(
    private readonly path: string,
    private readonly entries: Record<string, DripEntry>,
  ) {}

  static async open(stateDir: string, networkId: string): Promise<DripLedger> {
    const path = join(stateDir, `drips-${networkId}.json`);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, DripEntry>;
      return new DripLedger(path, parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
      return new DripLedger(path, {});
    }
  }

  get(address: string): DripEntry | null {
    return this.entries[address] ?? null;
  }

  get count(): number {
    return Object.keys(this.entries).length;
  }

  async record(address: string, entry: DripEntry): Promise<void> {
    this.entries[address] = entry;
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(this.entries, null, 2), 'utf8');
    await rename(temp, this.path);
  }
}

export class HourlyRateLimiter {
  private stamps: number[] = [];

  constructor(private readonly maxPerHour: number) {}

  /** True when another drip is allowed right now; records it when so. */
  take(): boolean {
    const now = Date.now();
    this.stamps = this.stamps.filter((stamp) => now - stamp < 3_600_000);
    if (this.stamps.length >= this.maxPerHour) return false;
    this.stamps.push(now);
    return true;
  }
}
