/**
 * Which coins a spend job may NOT be handed, and why.
 *
 * WHAT THE SDK ALREADY DOES, read from the dist on 2026/09/03 rather than
 * assumed. Balancing is not a read: `RunningV1Variant.balanceUnboundTransaction`
 * runs inside `SubscriptionRef.modifyEffect`, and the transacting capability's
 * `#prepareOffer` calls `CoreWallet.spendUtxos`, which moves every input it
 * selected from `availableUtxos` to `pendingUtxos` before the recipe is
 * returned (the shielded and dust wallets do the same through `spendCoins`).
 * `getAvailableCoins` reads `availableUtxos` only. So two balances, however
 * close together, cannot be handed the same coin — and this service serialises
 * them under one claim anyway. The smallest-first selector
 * (`chooseCoin` in wallet-sdk-capabilities' `Balancer.js`) is not, on its own,
 * how two of this sponsor's transactions came to spend one UTxO.
 *
 * WHAT THE SDK DOES THAT DOES HURT. The facade subscribes to its own pending
 * list and, for every entry whose polled result is `FAILURE` or
 * `PARTIAL_SUCCESS`, calls `revert(tx)` on all three wallets
 * (`WalletFacade` constructor, `PendingTransactions.allFailed`). The poll is a
 * transaction-status query against the indexer, independent of the wallet's own
 * sync stream — and the revert rolls back every input still marked pending,
 * including the ones in the GUARANTEED segment that the chain really did
 * consume. If that revert runs before the sync applies the block — the two
 * come from the same indexer, in no promised order — the fee coin and any
 * guaranteed input go back to `available`, the next job is handed them, and
 * the node refuses it with `1010: Invalid Transaction: Custom error: 231`.
 * The pending service also SYNTHESISES a `FAILURE` for any transaction it
 * cannot find once its TTL has passed (`startPolling`, `hasTTLExpired`), so a
 * transaction that landed late is reverted the same way. Both are the shape
 * the acceptance of 2026/09/03 recorded: a `FailFallible` landing at 02:50:09,
 * then fifteen `231` refusals behind it.
 *
 * THIS MODULE holds two kinds of exclusion and one wait:
 *
 *   - HELD: coins a job's balancing just took. Belt and braces over the SDK's
 *     own pending mark, and released the moment the job reverts or ends.
 *   - IN FLIGHT: coins of a transaction this service has SUBMITTED. Excluded
 *     from selection until the wallet's sync has applied their spend (they
 *     vanish from available and pending alike) or the transaction's own TTL has
 *     passed, whichever is first. A facade revert that puts them back in
 *     `available` in the meantime does not make them selectable.
 *   - the WAIT: when the only coins of a type are excluded, the shortage is
 *     contention, not poverty, and the caller may wait for a release rather
 *     than fail.
 *
 * It is wired into the SDK through `V1Builder.withCoinSelection`, the public
 * hook: `CustomUnshieldedWallet(cfg, new V1Builder().withDefaults()
 * .withCoinSelection(() => selector))`, and the same for the shielded and dust
 * builders. The selector receives the wallet's available coins and hands the
 * SDK's own `chooseCoin` the subset that is not excluded.
 */

/** A coin as the SDK's selectors see it. Only the fields this module reads. */
export interface SelectableCoin {
  type?: string;
  value: bigint;
  intentHash?: string;
  outputNo?: number;
  nonce?: string;
  /** Dust coins arrive as `{ token, value }`, the nonce one level down. */
  token?: { nonce?: string; type?: string };
}

export type CoinSelector<TCoin extends SelectableCoin = SelectableCoin> = (
  coins: TCoin[],
  tokenType: string,
  amount: bigint,
  costModel: unknown,
) => TCoin | undefined;

/**
 * The SDK's own rules, restated verbatim from the dist so the tests can pin
 * them: the unshielded and shielded wallets pick the SMALLEST coin of the
 * imbalanced type (`chooseCoin`, wallet-sdk-capabilities `Balancer.js`); the
 * dust wallet picks the smallest coin with any generated DUST at all
 * (`chooseCoin`, wallet-sdk-dust-wallet `CoinsAndBalances.js`), and is not
 * asked for a type because DUST is the only thing it holds.
 */
export const smallestOfType: CoinSelector = (coins, tokenType) =>
  coins
    .filter((coin) => coin.type === tokenType)
    .sort((a, b) => Number(a.value - b.value))
    .at(0);

export const smallestDust: CoinSelector = (coins) =>
  coins
    .filter((coin) => coin.value > 0n)
    .sort((a, b) => Number(a.value - b.value))
    .at(0);

/**
 * One key per coin, across all three wallets. Unshielded UTxOs are identified
 * the way the SDK's `isCoinEqual` identifies them — `intentHash` and
 * `outputNo` — and shielded and dust coins by `nonce`.
 */
export function coinKey(coin: SelectableCoin): string {
  const nonce = coin.nonce ?? coin.token?.nonce;
  if (nonce !== undefined) return `n:${String(nonce).toLowerCase()}`;
  return `u:${String(coin.intentHash ?? '?').toLowerCase()}:${coin.outputNo ?? '?'}`;
}

/** The native token's raw type: sixty-four zeros. */
export const NATIVE_TOKEN_TYPE = '0'.repeat(64);

/**
 * A NIGHT UTxO at or above this is a DUST LINEAGE, not change. NIGHT has six
 * decimals, so this is 1,000 NIGHT in atomic units. Spending such a coin
 * rotates it — the ledger re-creates it as a new UTxO — and a rotation resets
 * the DUST generation that coin was backing to zero, which on 2026/09/03 is
 * what left the sponsor without a fee-capable coin for minutes after a
 * 2,000-atomic grant had been paid from a 1,000-NIGHT input.
 */
export const LARGE_NIGHT_ATOMIC = 1_000n * 10n ** 6n;

/**
 * The unshielded selector: smallest first, as the SDK does, but for the
 * native token NEVER a lineage coin while any smaller coin of the type is
 * selectable. Only when every remaining NIGHT coin is a lineage does one get
 * spent, because the alternative is no transaction at all.
 */
export const nightPayloadFirst: CoinSelector = (coins, tokenType, amount, costModel) => {
  if (tokenType !== NATIVE_TOKEN_TYPE) return smallestOfType(coins, tokenType, amount, costModel);
  const candidates = coins.filter((coin) => coin.type === tokenType);
  const change = candidates.filter((coin) => coin.value < LARGE_NIGHT_ATOMIC);
  return smallestOfType(change.length > 0 ? change : candidates, tokenType, amount, costModel);
};

/**
 * The unshielded inputs a balanced recipe will spend, read from the built
 * transaction's intents rather than from the wallet.
 *
 * NECESSARY, NOT BELT AND BRACES. For an unbound transaction — every contract
 * call this service makes — the unshielded wallet's
 * `#balanceUnboundishTransaction` (wallet-sdk-unshielded-wallet, dist/v1/
 * Transacting.js) destructures only `{ offer }` from `#prepareOffer` and
 * returns `[transaction, wallet]`: the ORIGINAL wallet state, with the
 * selected NIGHT inputs still in `availableUtxos`. Read from the dist on
 * 2026/09/03, after sixteen `consumes` lines named DUST and mUSD and never a
 * NIGHT coin, while the indexer showed registrations and grants spending the
 * same 10-atomic UTxOs and eleven `1010: Custom error: 231` refusals behind
 * them. The shielded and dust wallets commit their spends; the unshielded
 * wallet, for this transaction shape, does not — so its inputs are held here
 * from the transaction itself.
 */
export function unshieldedInputsOf(recipe: unknown): SelectableCoin[] {
  const out: SelectableCoin[] = [];
  if (!recipe || typeof recipe !== 'object') return out;
  const r = recipe as Record<string, unknown>;
  const transactions = [r.baseTransaction, r.transaction, r.originalTransaction, r.balancingTransaction];
  for (const tx of transactions) {
    const intents = (tx as { intents?: unknown } | undefined)?.intents;
    if (!intents || typeof (intents as { values?: unknown }).values !== 'function') continue;
    for (const intent of (intents as Map<unknown, Record<string, unknown>>).values()) {
      for (const offer of [intent?.guaranteedUnshieldedOffer, intent?.fallibleUnshieldedOffer]) {
        const inputs = (offer as { inputs?: unknown[] } | undefined)?.inputs;
        if (!Array.isArray(inputs)) continue;
        for (const input of inputs) {
          const u = input as { type?: unknown; value?: unknown; intentHash?: unknown; outputNo?: unknown };
          if (u.intentHash === undefined || u.outputNo === undefined) continue;
          out.push({
            type: String(u.type ?? ''),
            value: typeof u.value === 'bigint' ? u.value : BigInt(String(u.value ?? 0)),
            intentHash: String(u.intentHash),
            outputNo: Number(u.outputNo),
          });
        }
      }
    }
  }
  return out;
}

/**
 * One coin, for the journal: `NIGHT u:3f9a…c1:0 value 2000`. The type is
 * shortened the way the rest of the journal shortens it — the native token's
 * type is sixty-four zeros and reads as `NIGHT` — and the hash is cut to its
 * ends, because the whole line has to fit beside the step it explains.
 */
export function describeCoin(coin: SelectableCoin, names: Record<string, string> = {}): string {
  const type = coin.type ?? coin.token?.type;
  const name =
    type === undefined
      ? 'DUST'
      : (names[type] ?? (/^0+$/.test(type) ? 'NIGHT' : `${type.slice(0, 8)}…`));
  const key = coinKey(coin);
  const short =
    key.length > 24 ? `${key.slice(0, 12)}…${key.slice(-8)}` : key;
  return `${name} ${short} value ${coin.value.toString()}`;
}

export interface CoinTicket {
  /** Mark these coins as taken by this job's balancing. */
  hold(keys: Iterable<string>): void;
  /** The transaction carrying the held coins was submitted; keep them excluded until applied or `expiresAt`. */
  submitted(expiresAt: number): void;
  /** The job ended without a submission, or reverted: every held coin is free again. */
  release(): void;
}

export interface CoinReservationOptions {
  now?: () => number;
  log?: (line: string) => void;
}

export interface CoinReservation {
  open(label: string): CoinTicket;
  /** Wraps a selector so it never hands out an excluded coin. */
  guard<TCoin extends SelectableCoin>(base: CoinSelector<TCoin>): CoinSelector<TCoin>;
  /** The keys currently excluded, for `/status` and for the wait's decision. */
  excluded(): string[];
  /**
   * Is a shortage of `tokenType` explained by exclusions? True when at least
   * one excluded coin is of that type — the caller has a reason to wait.
   */
  isContended(tokenType: string, coins: SelectableCoin[]): boolean;
  /**
   * Called with every wallet state: an in-flight coin that is in neither list
   * has been applied by the sync, and is forgotten. The lists are keys.
   */
  observe(available: Iterable<string>, pending: Iterable<string>): void;
  /** Resolves on the next release or application, or after `maxMs`. True if something came free. */
  whenReleased(maxMs: number): Promise<boolean>;
}

export function createCoinReservation(options: CoinReservationOptions = {}): CoinReservation {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));

  /** key → ticket label, for coins a job holds before submitting. */
  const held = new Map<string, string>();
  /** key → { label, expiresAt }, for coins of a submitted transaction. */
  const inFlight = new Map<string, { label: string; expiresAt: number }>();
  const waiters = new Set<() => void>();

  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };

  const expireInFlight = (): void => {
    const at = now();
    for (const [key, entry] of inFlight) {
      if (entry.expiresAt <= at) {
        inFlight.delete(key);
        log(
          `[coins] ${key} of ${entry.label} was never seen applied and its transaction's TTL has passed — selectable again`,
        );
      }
    }
  };

  const isExcluded = (key: string): boolean => held.has(key) || inFlight.has(key);

  return {
    open(label) {
      const mine = new Set<string>();
      let state: 'open' | 'submitted' | 'released' = 'open';
      return {
        hold(keys) {
          if (state !== 'open') return;
          for (const key of keys) {
            mine.add(key);
            held.set(key, label);
          }
        },
        submitted(expiresAt) {
          if (state !== 'open') return;
          state = 'submitted';
          for (const key of mine) {
            held.delete(key);
            inFlight.set(key, { label, expiresAt });
          }
        },
        release() {
          if (state === 'released') return;
          const wasHeld = state === 'open';
          state = 'released';
          for (const key of mine) {
            if (wasHeld) held.delete(key);
          }
          mine.clear();
          if (wasHeld) wake();
        },
      };
    },

    guard(base) {
      return (coins, tokenType, amount, costModel) => {
        expireInFlight();
        return base(
          coins.filter((coin) => !isExcluded(coinKey(coin))),
          tokenType,
          amount,
          costModel,
        );
      };
    },

    excluded() {
      expireInFlight();
      return [...held.keys(), ...inFlight.keys()];
    },

    isContended(tokenType, coins) {
      expireInFlight();
      return coins.some((coin) => coin.type === tokenType && isExcluded(coinKey(coin)));
    },

    observe(available, pending) {
      if (inFlight.size === 0) return;
      const present = new Set<string>();
      for (const key of available) present.add(key);
      for (const key of pending) present.add(key);
      let applied = 0;
      for (const [key, entry] of inFlight) {
        if (!present.has(key)) {
          inFlight.delete(key);
          applied += 1;
          log(`[coins] ${key} of ${entry.label} is applied on chain — forgotten`);
        }
      }
      if (applied > 0) wake();
    },

    whenReleased(maxMs) {
      return new Promise<boolean>((settle) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const waiter = (): void => {
          waiters.delete(waiter);
          if (timer) clearTimeout(timer);
          settle(true);
        };
        waiters.add(waiter);
        timer = setTimeout(() => {
          waiters.delete(waiter);
          settle(false);
        }, Math.max(0, maxMs));
      });
    },
  };
}
