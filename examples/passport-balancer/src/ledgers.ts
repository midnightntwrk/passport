/**
 * The balancer's once-only ledgers and the rolling-hour rate limiter.
 *
 * A ledger is the hard once-only gate for whatever it keys on — one sponsored
 * alias per account-custody contract, one activation grant per account-custody
 * contract — persisted as a small JSON file in the state directory so a restart
 * cannot forget who has already been served. The rate limiter is in-memory: a
 * restart resets the window, which for a global back-stop is fine.
 *
 * This is `examples/passport-funder/src/dripLedger.ts` with the drip ledger
 * left out. The balancer has no `/activate` — it never sends NIGHT to a wallet
 * address, because on stagenet a Passport's value belongs inside its account
 * contract and the two endpoints here put it there directly.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
 * The ASSET half of an activation — the mUSD minted from the faucet and paid
 * into the account's `coins` map by `deposit_shielded`.
 *
 * Two hashes because it is two transactions: the mint pays a fresh coin to the
 * balancer's OWN shielded address, and the deposit spends that coin into the
 * account. Only the second one is the account's credit, which is why it is the
 * one reported as `assetTx`.
 */
export interface AccountAssetEntry {
  symbol: string;
  /** `rawTokenType(domain separator, faucet address)`, as 64 lower-case hex. */
  colourHex: string;
  amount: string;
  mintTx: string;
  depositTx: string;
  /** The account's own `coins[colour].value` once the credit was seen. */
  balanceAfter: string;
  at: string;
}

/**
 * One activation grant paid into an account-custody contract, keyed by that
 * contract's address. Keyed on the CONTRACT for the same reason
 * {@link AliasEntry} is: the limit being enforced is "one opening balance per
 * Passport", and the contract address is the thing a Passport has exactly one
 * of. The address it was deployed FROM is not — a user can hold several.
 *
 * THE TWO LEGS ARE RECORDED SEPARATELY, and that is the point of the shape. An
 * activation is a NIGHT deposit and an mUSD deposit, and the second can fail
 * after the first has landed on chain. A single flag would then force a choice
 * between forgetting a real NIGHT credit and never retrying the asset leg;
 * recording them apart lets a retry do exactly the missing half.
 *
 * The NIGHT fields are OPTIONAL for two reasons. Entries written before the
 * asset leg existed carry them and no `asset`, which reads correctly as "NIGHT
 * done, mUSD outstanding" with no migration. And an account that already holds
 * a grant's worth of NIGHT from elsewhere can still need its mUSD, in which case
 * this service never paid a NIGHT leg and should not claim to have.
 */
export interface AccountEntry {
  txHash?: string;
  amountAtomic?: string;
  balanceAfterAtomic?: string;
  at: string;
  asset?: AccountAssetEntry;
}

/**
 * One pre-deployed resolver leaf, keyed by its own contract address.
 *
 * The pool exists because the name path's first proof is its slowest: deploying
 * the leaf is 1.37e16 Specks and a block, and it happens while somebody is
 * watching a screen. Nothing about that deploy depends on the user — a leaf can
 * be built with no domain, a zero target, and the sponsor's own key as owner,
 * and bound to a person later. So the sponsor keeps a shelf of them and pays
 * for the deploy in its own quiet time instead of in the user's.
 *
 * `consumedBy` and `consumedAt` are what stop a leaf being handed out twice.
 * They are written the INSTANT a leaf is taken — before the binding is even
 * attempted — because the failure this guards is two registrations racing onto
 * one leaf, and a leaf marked only on success would be free for the whole
 * minute the first binding spends proving. A leaf whose binding then fails is
 * spent and stays spent: it cost one deploy, the pool refills it in the
 * background, and reusing it would mean reasoning about a half-bound leaf under
 * a second user's name.
 *
 * `consumedBy` is the account-custody contract address the leaf was bound to,
 * which is what {@link AliasEntry} is keyed on as well — so the two ledgers can
 * be read against each other without naming a user in either.
 */
export interface ResolverEntry {
  /** Raw 64-hex contract address of the deployed leaf. */
  address: string;
  /** The deploy transaction, as the indexer's hash where it knew one. */
  deployTx: string;
  deployedAt: string;
  /** The account-custody contract this leaf was handed to, once it was. */
  consumedBy?: string;
  consumedAt?: string;
}

/**
 * An append-mostly `Record<key, Entry>` on disk. Small enough to rewrite whole
 * on every record: the balancer serves tens of entries a day, not thousands,
 * and a write-and-rename is atomic where a partial append would not be.
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

  /** How many entries satisfy `predicate` — one leg of a two-leg entry, say. */
  countWhere(predicate: (entry: Entry) => boolean): number {
    return Object.values(this.entries).filter(predicate).length;
  }

  /**
   * The first entry satisfying `predicate`, in insertion order, with its key.
   *
   * Insertion order is the point rather than an accident: the resolver pool
   * hands out its OLDEST unconsumed leaf, so a leaf never sits on the shelf
   * indefinitely while newer ones are spent around it. `Object.keys` on a
   * string-keyed object preserves that order, and the ledger is rewritten whole
   * from the same object on every record, so it survives a restart too.
   */
  findWhere(predicate: (entry: Entry, key: string) => boolean): { key: string; entry: Entry } | null {
    for (const [key, entry] of Object.entries(this.entries)) {
      if (predicate(entry, key)) return { key, entry };
    }
    return null;
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
   * other reason — already served, wrong network, balancer empty — has not used
   * the hourly budget, and burning a slot on it would let a stream of bad
   * requests shut the service down without a single NIGHT leaving it. So
   * `take()` is called only once a spend is actually about to be attempted, and
   * this exists for the cheap early refusal on the way in.
   */
  atCeiling(): boolean {
    const now = Date.now();
    this.stamps = this.stamps.filter((stamp) => now - stamp < 3_600_000);
    return this.stamps.length >= this.maxPerHour;
  }

  /** How many spends are still available in the current window. */
  remaining(): number {
    const now = Date.now();
    this.stamps = this.stamps.filter((stamp) => now - stamp < 3_600_000);
    return Math.max(0, this.maxPerHour - this.stamps.length);
  }
}
