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
 *   - CREATED: the DUST successor a spend writes. Measured on 2026/09/03 on
 *     the build that held consumed coins only: the registration of
 *     famtl14uefvbh.night deployed its leaf at 04:33:56 spending DUST
 *     n:1707…/n:1013…, submitted at 04:34:00; the grant balanced at 04:34:02
 *     was handed DUST n:1590… — a coin no line had named before, the successor
 *     the ledger's local state had written for that spend, which the dust
 *     wallet lists as available at once — and the node refused it at 04:34:12
 *     with `231`, eight seconds before the deploy landed at 04:34:20. At
 *     04:34:42 the same n:1590… paid the registration's own second leg and
 *     landed. Every refusal of that run has this shape. So the coins a
 *     balance CREATES are excluded with the ones it consumes, until the spend
 *     that created them is applied.
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
 * A DUST coin below this is a CRUMB: the generation of a 0.02-NIGHT coin an
 * hour old, not a fee. Measured on 2026/09/03 after the crumb split: the forty
 * new NIGHT coins each registered a DUST coin of a few thousand million
 * Specks, the SDK's smallest-first accumulation swept all forty-one into every
 * fee leg, and each of those forty-one inputs was a separate `/prove` against
 * a proof server with a job capacity of ten — "Failed to prove: Job Queue
 * full", five times before the first click. A fee that needs forty-one inputs
 * is not being paid, it is being spread.
 */
export const DUST_CRUMB_FLOOR = 1_000_000_000_000_000n;

/**
 * The DUST fee selector. ONE coin that covers the need, the smallest such;
 * only when no single coin covers it, the LARGEST first, so the set is as
 * short as it can be. Crumbs below {@link DUST_CRUMB_FLOOR} are passed over
 * while anything else exists. The reservation guard sits in front of this and
 * removes held and in-flight coins before it is asked.
 *
 * The SDK asks again with the remaining need after every input it takes
 * (`doBalance` in wallet-sdk-capabilities' `Balancer.js`), so a selector that
 * returns the largest coin when nothing covers the need converges in the
 * fewest calls. The dust wallet's cost model carries no per-input overhead,
 * and its own loop re-estimates the fee after each recipe and stops once the
 * inputs cover it.
 */
export const dustFeeFirst: CoinSelector = (coins, _tokenType, amount) => {
  const needed = amount < 0n ? -amount : amount;
  const spendable = coins.filter((coin) => coin.value > 0n);
  const worth = spendable.filter((coin) => coin.value >= DUST_CRUMB_FLOOR);
  const pool = worth.length > 0 ? worth : spendable;
  const covering = pool.filter((coin) => coin.value >= needed);
  if (covering.length > 0) {
    return covering.sort((a, b) => Number(a.value - b.value)).at(0);
  }
  return pool.sort((a, b) => Number(b.value - a.value)).at(0);
};

/**
 * The dust selector as the wallet installs it: {@link dustFeeFirst}, except
 * that the first `padding` asks of a balance are answered with the SMALLEST
 * crumbs available, fully consumed, before the covering coin.
 *
 * WHY A FEE LEG WOULD EVER WANT MORE INPUTS. `1010: Custom error: 231` is
 * `FeeCalculation.OutsideTimeToDismiss` — read from the ledger's own wasm:
 * "exceeded the maximum time to dismiss for transaction size; this
 * transaction would take N to dismiss, but given its size of M bytes, it may
 * take at most K". A transaction's processing time may not exceed a bound
 * that grows with its BYTE size. `deposit_night` is a small transaction that
 * costs real compute — a contract call carrying a fallible NIGHT payload —
 * and with one DUST input it is under the byte count that buys its compute.
 * On 2026/09/03 every grant built with one DUST input was refused, 112 of
 * 112 on 93dff96 and 9 of 9 on de234e0, and every grant with two or more
 * landed, 5 of 5 — the extra spends were bytes. Registrations, larger
 * transactions, land with one. The wallet checks the rule locally before
 * proving (`fees(params, true)` throws the same error) and, when it fails,
 * balances again with more padding. Padding coins are crumbs on purpose:
 * they are consumed whole, cost almost nothing to prove, and exist in
 * quantity.
 */
export function createDustFeeSelector(reservation: {
  dustPadding(): number;
  balanceAsks(): number;
}): CoinSelector {
  return (coins, tokenType, amount, costModel) => {
    const padding = reservation.dustPadding();
    if (padding > 0 && reservation.balanceAsks() < padding) {
      /* The LARGEST crumbs: a crumb's generated value is its age, and the
         oldest are the ones run 3 landed with. */
      const crumbs = coins
        .filter((coin) => coin.value > 0n && coin.value < DUST_CRUMB_FLOOR)
        .sort((a, b) => Number(b.value - a.value));
      if (crumbs.length > 0) return crumbs[0];
    }
    return dustFeeFirst(coins, tokenType, amount, costModel);
  };
}

/** Matches the ledger's own refusal, thrown by `fees(params, true)` and sent back by the node as `231`. */
export function isTimeToDismiss(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (/time to dismiss/i.test(message)) return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

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
  const needed = amount < 0n ? -amount : amount;
  if (change.length > 0) {
    /* ONE change coin that covers the need, the smallest such; only when
       none does, the largest first. Every unshielded input is a signature the
       node verifies, and the fee rule below charges that time against the
       transaction's bytes: a grant built from six 10-atomic crumbs and a
       change coin was 29.5 ms of processing in 9,503 bytes on 2026/09/03,
       and refused. */
    const covering = change.filter((coin) => coin.value >= needed);
    if (covering.length > 0) return covering.sort((a, b) => Number(a.value - b.value)).at(0);
    return change.sort((a, b) => Number(b.value - a.value)).at(0);
  }
  /* No change coin is selectable. For a SMALL need — a grant, a registration's
     COST — a lineage is never the answer: rotating it resets its DUST
     generation, and on 2026/09/03 at 04:35:15 a grant balanced on the
     4,998-NIGHT coin u:363747…:1 for exactly that reason, because every small
     coin was held in flight at that moment. Handing back nothing makes the
     balance fail with insufficient funds, which the wallet turns into a wait
     for a held coin to come free. Only a need that no change coin could cover
     may spend a lineage. */
  if (needed < LARGE_NIGHT_ATOMIC) return undefined;
  return smallestOfType(candidates, tokenType, amount, costModel);
};

/**
 * How many crumb DUST inputs to add for the deficit the ledger reports.
 *
 * The ledger says, verbatim: "this transaction would take T to dismiss, but
 * given its size of B bytes, it may take at most M". Measured on 2026/09/03
 * from those very lines: the allowance is 2 µs per byte (9,503 bytes → 19.006
 * ms; 15,509 → 31.018), and one crumb spend adds about 3,000 bytes of
 * transaction — 6 ms of allowance — and about 2.65 ms of processing, so each
 * is worth roughly 3.3 ms of headroom. One more than the arithmetic says,
 * because the proven transaction's verification costs more than the erased
 * estimate; never fewer than one, never more than eight.
 */
export const CRUMB_HEADROOM_MS = 3.3;

export function crumbsForDeficit(message: string): number {
  const match =
    /would take ([\d.]+)\s*(ms|s|[\u00b5\u03bc]s|us) to dismiss, but given its size of (\d+) bytes, it may take at most ([\d.]+)\s*(ms|s|[\u00b5\u03bc]s|us)/i.exec(
      message,
    );
  if (!match) return 2;
  const toMs = (value: string, unit: string): number => {
    const n = Number(value);
    if (unit === 's') return n * 1000;
    if (unit === 'us' || /^[\u00b5\u03bc]s$/.test(unit)) return n / 1000;
    return n;
  };
  const takes = toMs(match[1]!, match[2]!);
  const allowed = toMs(match[4]!, match[5]!);
  const deficit = takes - allowed;
  if (!(deficit > 0)) return 1;
  return Math.max(1, Math.min(8, Math.ceil(deficit / CRUMB_HEADROOM_MS) + 1));
}

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
    type === undefined || type === 'dust' || coin.token !== undefined
      ? 'DUST'
      : (names[type] ?? (/^0+$/.test(type) ? 'NIGHT' : `${type.slice(0, 8)}…`));
  const key = coinKey(coin);
  const short =
    key.length > 24 ? `${key.slice(0, 12)}…${key.slice(-8)}` : key;
  return `${name} ${short} value ${coin.value.toString()}`;
}

/**
 * A built transaction would spend a coin another job holds or has in flight.
 *
 * Thrown by {@link CoinReservation.claimInputs} for the case the selectors
 * cannot see: a transaction that reaches the wallet ALREADY carrying inputs —
 * the shape of 05:23:52 on 2026/09/03, when a grant's rebuild consumed
 * u:2dd48b54…:17 with no selector ever asked, while the grant beside it had
 * just been handed the same coin. The remedy is a rebuild once the wallet has
 * caught up, which is what `isRebuildable` in `./account.ts` makes of it.
 */
export class CoinContention extends Error {
  readonly key: string;
  readonly heldBy: string;

  constructor(key: string, heldBy: string) {
    super(
      `this transaction would spend ${key}, which ${heldBy} holds — rebuilding rather than double-spending it`,
    );
    this.name = 'CoinContention';
    this.key = key;
    this.heldBy = heldBy;
  }
}

/** A built transaction carries the same input twice — the shape the node refuses. */
export class DuplicateInput extends CoinContention {
  constructor(key: string) {
    super(key, 'this same transaction, twice');
    this.name = 'DuplicateInput';
  }
}

/**
 * Every input a recipe's transactions carry, as keys: unshielded UTxOs by
 * intent hash and index, DUST spends by the nullifier they consume. Used to
 * refuse a transaction that names one input twice before it is proved.
 */
export function inputKeysOf(recipe: unknown): string[] {
  const keys = unshieldedInputsOf(recipe).map(coinKey);
  if (!recipe || typeof recipe !== 'object') return keys;
  const r = recipe as Record<string, unknown>;
  for (const tx of [r.baseTransaction, r.transaction, r.originalTransaction, r.balancingTransaction]) {
    const intents = (tx as { intents?: unknown } | undefined)?.intents;
    if (!intents || typeof (intents as { values?: unknown }).values !== 'function') continue;
    for (const intent of (intents as Map<unknown, Record<string, unknown>>).values()) {
      const spends = (intent?.dustActions as { spends?: unknown[] } | undefined)?.spends;
      if (!Array.isArray(spends)) continue;
      for (const spend of spends) {
        const nullifier = (spend as { oldNullifier?: unknown }).oldNullifier;
        if (nullifier !== undefined) keys.push(`d:${String(nullifier).toLowerCase()}`);
      }
    }
  }
  return keys;
}

export function assertNoDuplicateInputs(recipe: unknown): void {
  const seen = new Set<string>();
  for (const key of inputKeysOf(recipe)) {
    if (seen.has(key)) throw new DuplicateInput(key);
    seen.add(key);
  }
}

export function isCoinContention(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof CoinContention) return true;
    if (current instanceof Error && current.name === 'CoinContention') return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export interface CoinTicket {
  /** The job this ticket belongs to, for the journal and for refusals. */
  readonly label: string;
  /** Still holding, not yet submitted or released. */
  isOpen(): boolean;
  /**
   * The node refused the transaction built on the coins held so far. They
   * stay held — nobody else may take them — but this ticket will not be
   * handed them again: the next build must be a different shape, or fail
   * plainly. Three identical refusals in a row is what this ends.
   */
  refused(): void;
  /** How many coins this ticket is avoiding after refusals. */
  avoiding(): number;
  /** Mark these coins as taken by this job's balancing. */
  hold(keys: Iterable<string>): void;
  /**
   * Mark these coins as CREATED by this job's balancing — the DUST successors
   * the ledger's local state writes at spend time, which the dust wallet lists
   * as available at once and which do not exist on chain until this job's
   * transaction lands. Excluded with the consumed coins, and released with
   * them: the moment the spend is applied, the successor is real.
   */
  created(keys: Iterable<string>): void;
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
  /**
   * From here until `endBalance`, every coin a guarded selector hands out is
   * HELD by this ticket the instant it is handed out — before the SDK has
   * committed anything, before any state has been read back. Balancing is
   * serialised under the wallet claim, so at most one balance is active.
   */
  beginBalance(ticket: CoinTicket): void;
  /** Ends the active balance and returns the coins its selectors handed out. */
  endBalance(): SelectableCoin[];
  /**
   * The inputs a BUILT transaction carries, checked against everyone else:
   * a coin held by another ticket or in flight throws {@link CoinContention};
   * the rest are held by `ticket`. The gate for inputs that arrived without a
   * selector being asked.
   */
  claimInputs(ticket: CoinTicket, coins: Iterable<SelectableCoin>): void;
  /** Is any submitted transaction still unsettled? Cheap; for the state stream. */
  hasFlights(): boolean;
  /** How many crumb inputs the dust selector adds ahead of the covering coin — see `createDustFeeSelector`. */
  setDustPadding(count: number): void;
  dustPadding(): number;
  /** How many coins the active balance has been handed so far. */
  balanceAsks(): number;
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
   * Called with every wallet state. A submitted transaction whose consumed
   * coins are in neither list has been applied by the sync; it, and the coins
   * it created, are forgotten. The lists are keys.
   */
  observe(available: Iterable<string>, pending: Iterable<string>): void;
  /** Resolves on the next release or application, or after `maxMs`. True if something came free. */
  whenReleased(maxMs: number): Promise<boolean>;
}

/** One submitted transaction's coins, until the chain or the TTL settles it. */
interface Flight {
  label: string;
  consumed: Set<string>;
  created: Set<string>;
  expiresAt: number;
}

export function createCoinReservation(options: CoinReservationOptions = {}): CoinReservation {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));

  /** key → the ticket holding it, for coins a job holds (consumed or created) before submitting. */
  const held = new Map<string, CoinTicket>();
  /** Every submitted transaction still unsettled, and an index from key to it. */
  const flights = new Set<Flight>();
  const inFlight = new Map<string, Flight>();
  const waiters = new Set<() => void>();

  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };

  const forget = (flight: Flight): void => {
    flights.delete(flight);
    for (const key of flight.consumed) if (inFlight.get(key) === flight) inFlight.delete(key);
    for (const key of flight.created) if (inFlight.get(key) === flight) inFlight.delete(key);
  };

  const expireInFlight = (): void => {
    const at = now();
    for (const flight of [...flights]) {
      if (flight.expiresAt <= at) {
        forget(flight);
        log(
          `[coins] ${flight.label} was never seen applied and its transaction's TTL has passed — selectable again (${flight.consumed.size + flight.created.size} coins)`,
        );
      }
    }
  };

  /**
   * Excluded for `asker`: held by ANOTHER ticket, or in flight. A ticket may
   * always be handed its own held coins again — that is how a rebuild after a
   * refusal keeps the coins it already holds rather than releasing them for
   * the job beside it to take.
   */
  /** key → the ticket that was refused on it and must not be handed it again. */
  const avoided = new Map<string, CoinTicket>();
  let padding = 0;

  const isExcludedFor = (key: string, asker: CoinTicket | null): boolean => {
    const holder = held.get(key);
    if (holder !== undefined && holder !== asker) return true;
    if (asker !== null && avoided.get(key) === asker) return true;
    return inFlight.has(key);
  };
  const isExcluded = (key: string): boolean => isExcludedFor(key, null);

  /* One balance at a time (the wallet holds a lock), and within it every coin
     handed out is excluded from every later ask of the SAME balance — the
     SDK's loop asks again after re-estimating the fee, and a selector that
     answers twice with the same coin builds a transaction that names it
     twice. Across attempts the ticket may have its own coins again. */
  let active: { ticket: CoinTicket; selected: SelectableCoin[]; handed: Set<string> } | null = null;

  return {
    beginBalance(ticket) {
      active = { ticket, selected: [], handed: new Set() };
    },
    endBalance() {
      const selected = active?.selected ?? [];
      active = null;
      return selected;
    },
    hasFlights: () => flights.size > 0,
    setDustPadding(count) {
      padding = Math.max(0, Math.floor(count));
    },
    dustPadding: () => padding,
    /* DUST hand-outs only: the NIGHT payload is handed out first in the same
       balance, and counting it made `padding` N yield N−1 crumbs. */
    balanceAsks: () => active?.selected.filter((coin) => coin.token !== undefined).length ?? 0,

    open(label) {
      const consumed = new Set<string>();
      const created = new Set<string>();
      let state: 'open' | 'submitted' | 'released' = 'open';
      const ticket: CoinTicket = {
        label,
        isOpen: () => state === 'open',
        refused() {
          if (state !== 'open') return;
          for (const key of consumed) avoided.set(key, ticket);
        },
        avoiding() {
          let count = 0;
          for (const [, owner] of avoided) if (owner === ticket) count += 1;
          return count;
        },
        hold(keys) {
          if (state !== 'open') return;
          for (const key of keys) {
            consumed.add(key);
            held.set(key, ticket);
          }
        },
        created(keys) {
          if (state !== 'open') return;
          for (const key of keys) {
            created.add(key);
            held.set(key, ticket);
          }
        },
        submitted(expiresAt) {
          if (state !== 'open') return;
          state = 'submitted';
          const flight: Flight = { label, consumed: new Set(consumed), created: new Set(created), expiresAt };
          flights.add(flight);
          for (const key of consumed) {
            if (held.get(key) === ticket) held.delete(key);
            inFlight.set(key, flight);
          }
          for (const key of created) {
            if (held.get(key) === ticket) held.delete(key);
            inFlight.set(key, flight);
          }
        },
        release() {
          if (state === 'released') return;
          const wasHeld = state === 'open';
          state = 'released';
          if (wasHeld) {
            for (const key of consumed) if (held.get(key) === ticket) held.delete(key);
            for (const key of created) if (held.get(key) === ticket) held.delete(key);
          }
          for (const [key, owner] of [...avoided]) if (owner === ticket) avoided.delete(key);
          consumed.clear();
          created.clear();
          if (wasHeld) wake();
        },
      };
      return ticket;
    },

    claimInputs(ticket, inputs) {
      expireInFlight();
      const keys: string[] = [];
      const seen = new Set<string>();
      for (const coin of inputs) {
        const key = coinKey(coin);
        if (seen.has(key)) throw new DuplicateInput(key);
        seen.add(key);
        const holder = held.get(key);
        if (holder !== undefined && holder !== ticket) throw new CoinContention(key, holder.label);
        const flight = inFlight.get(key);
        if (flight) throw new CoinContention(key, `${flight.label} (in flight)`);
        keys.push(key);
      }
      ticket.hold(keys);
    },

    guard(base) {
      return (coins, tokenType, amount, costModel) => {
        expireInFlight();
        const asker = active?.ticket ?? null;
        const handed = active?.handed;
        const chosen = base(
          coins.filter((coin) => {
            const key = coinKey(coin);
            return !isExcludedFor(key, asker) && !(handed?.has(key) ?? false);
          }),
          tokenType,
          amount,
          costModel,
        );
        if (chosen !== undefined && active) {
          const key = coinKey(chosen);
          active.ticket.hold([key]);
          active.handed.add(key);
          active.selected.push(chosen);
        }
        return chosen;
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
      if (flights.size === 0) return;
      const present = new Set<string>();
      for (const key of available) present.add(key);
      for (const key of pending) present.add(key);
      let applied = 0;
      for (const flight of [...flights]) {
        /* Applied when every coin it consumed has left both lists. The coins
           it created stay present — they are real now — and are released
           with it. A flight that consumed nothing has nothing to wait for. */
        let outstanding = 0;
        for (const key of flight.consumed) if (present.has(key)) outstanding += 1;
        if (outstanding > 0) continue;
        forget(flight);
        applied += 1;
        log(
          `[coins] ${flight.label} is applied on chain — forgotten (${flight.consumed.size} consumed, ${flight.created.size} created)`,
        );
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
