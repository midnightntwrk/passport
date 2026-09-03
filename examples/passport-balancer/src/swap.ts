/**
 * The swap desk: the sponsor as a market maker for one fixed lot.
 *
 * Passport Swap is a partner app on its own origin. It asks a Passport, over
 * `@midnight-passport/connect`, to pay the sponsor a fixed price in NIGHT, and
 * then asks this service for the other half of the trade: a lot of the
 * stablecoin the sponsor mints, paid into the same account the payment came
 * out of.
 *
 * WHICH WAY ROUND, AND WHY. The app-facing transaction protocol carries one
 * intent kind — a positive unshielded NIGHT transfer to a `mn_addr…` address —
 * and Passport's approval ladder parses the recipient as an unshielded address
 * before it will show a consent sheet. So the leg a partner app can ask a user
 * for is NIGHT, and the leg the sponsor pays back is the asset. Reversing it
 * would need a new intent kind on both sides of the boundary, which is a
 * protocol change, not an app.
 *
 * WHAT THIS VERIFIES, EXACTLY. `POST /swap` will not pay out until the payment
 * transaction the app names is on chain: the indexer is asked for it by hash,
 * and only a parsed answer that names the transaction counts. An unreachable
 * indexer is evidence about the indexer, never about the chain, so it is a 503
 * and the caller may ask again. What the read does NOT do is decode the
 * transaction's unshielded outputs and prove the sponsor was the recipient —
 * that decode is not something this service can do honestly today, and saying
 * otherwise in a comment would be worse than the gap. Three things keep the
 * gap small and bounded: the payout is one fixed lot, never an amount the
 * caller chooses; a payment hash buys exactly one lot, forever, because the
 * ledger is keyed on it; and the route sits behind the same rate limiter and
 * admission slot as every other spend.
 *
 * The ledger is `swaps-<network>.json` beside the accounts ledger, and it is
 * the idempotency gate: a repeated `POST /swap` for a hash already served
 * returns the same two transaction hashes rather than paying a second lot.
 */

import type { JsonLedger } from './ledgers.js';

/* -------------------------------------------------------------------------- */
/* The rate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * THE DEMO RATE, FIXED, and a constant rather than a market: one lot of the
 * sponsor's stablecoin costs 500 atomic NIGHT — 0.0005 NIGHT.
 *
 * The number is chosen against what a Passport actually holds. A freshly
 * activated Passport is opened with 0.002 NIGHT, so a lot at 0.0005 leaves it
 * three more swaps' worth of room; a rate that priced the lot above the opening
 * balance would make the demo's first click a refusal. With the stagenet lot at
 * 100 units, that is 0.000005 NIGHT per unit. Nothing here is a price
 * discovery, and the app says as much on the screen.
 */
export const SWAP_PRICE_ATOMIC = 500n;

/** How long a quote is offered for. Nothing enforces it on chain; it is copy. */
export const SWAP_QUOTE_TTL_MS = 120_000;

/** 1 NIGHT is 1,000,000 atomic units. */
const NIGHT_DECIMALS = 6;

/** Atomic NIGHT → display NIGHT, by string arithmetic. Never a float. */
export function formatAtomicNight(atomic: bigint): string {
  const digits = atomic.toString().padStart(NIGHT_DECIMALS + 1, '0');
  const whole = digits.slice(0, digits.length - NIGHT_DECIMALS);
  const fraction = digits.slice(digits.length - NIGHT_DECIMALS).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Display NIGHT → atomic, for the one place a caller may name an amount.
 * Returns `null` for anything that is not a plain non-negative decimal with at
 * most six places — an exponent or a float would be a rounding decision, and
 * this is somebody's money.
 */
export function parseNightAmount(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  return BigInt(whole) * 10n ** BigInt(NIGHT_DECIMALS) + BigInt(fraction.padEnd(NIGHT_DECIMALS, '0'));
}

/* -------------------------------------------------------------------------- */
/* The ledger                                                                 */
/* -------------------------------------------------------------------------- */

/** One completed swap, keyed by the PAYMENT transaction hash. */
export interface SwapEntry {
  /** The account-custody contract that paid and was paid. */
  account: string;
  /** Atomic NIGHT the quote was priced at. */
  paidAtomic: string;
  /** Units of the asset the sponsor paid back. */
  received: string;
  symbol: string;
  /** The sponsor's `deposit_shielded`, which is the account's credit. */
  depositTx: string;
  /** The faucet mint, when the payout minted rather than spending a spare. */
  mintTx?: string;
  at: string;
}

/** The slice of {@link JsonLedger} the desk uses, so a test can stand one in. */
export interface SwapLedger {
  get(key: string): SwapEntry | null;
  record(key: string, entry: SwapEntry): Promise<void>;
  readonly count: number;
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

export type PaymentVerdict =
  /** The indexer answered, and it has this transaction. */
  | { state: 'landed'; hash: string; block: number | null }
  /** The indexer answered, and it does not. */
  | { state: 'absent' }
  /** The indexer could not be asked. Evidence about the indexer only. */
  | { state: 'unreachable' };

/**
 * Asks the indexer for one transaction by hash, then — because Passport may
 * answer an app with either the ledger hash or the 33-byte identifier,
 * depending on how far the submission got — by identifier.
 */
export async function verifyPaymentOnChain(
  indexerHttpUrl: string,
  txHash: string,
): Promise<PaymentVerdict> {
  const offsets = [`hash: "${txHash}"`, `identifier: "${txHash}"`];
  let reachable = false;
  for (const offset of offsets) {
    try {
      const response = await fetch(indexerHttpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{ transactions(offset: { ${offset} }) { hash block { height } } }` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as {
        data?: { transactions?: Array<{ hash?: string; block?: { height?: number } }> };
        errors?: unknown[];
      };
      /* A GraphQL error is an unanswered question, not a missing transaction:
         `hash` and `identifier` are different lengths and the schema rejects
         the wrong one outright, which is exactly why both are tried. */
      if (body.errors && body.errors.length > 0) continue;
      if (!Array.isArray(body.data?.transactions)) continue;
      reachable = true;
      const found = body.data.transactions[0];
      if (found?.hash) return { state: 'landed', hash: found.hash, block: found.block?.height ?? null };
    } catch {
      /* Network or parse failure — the next offset, or `unreachable`. */
    }
  }
  return reachable ? { state: 'absent' } : { state: 'unreachable' };
}

/* -------------------------------------------------------------------------- */
/* The desk                                                                   */
/* -------------------------------------------------------------------------- */

export interface SwapPayout {
  depositTxHash: string;
  mintTxHash?: string;
  amount: bigint;
}

export interface SwapDeskDeps {
  networkId: string;
  /** The sponsor's own unshielded address — where the app sends the payment. */
  depositTo: string;
  /** `'mUSD'` on stagenet. Fixed, because the colour is bound to a faucet. */
  assetSymbol: string;
  /** The lot the sponsor sells, in whole units of the asset. */
  assetLot: bigint;
  /** Whether the payout leg can run at all, and why not when it cannot. */
  assetAvailable: boolean;
  assetUnavailableReason: string | null;
  ledger: SwapLedger;
  verifyPayment(txHash: string): Promise<PaymentVerdict>;
  /** The sponsor's existing asset-grant path: mint if needed, then deposit. */
  payOut(account: string): Promise<SwapPayout>;
  /** Validates and normalises a raw 64-hex contract address, or throws. */
  normaliseAccount(value: string): string;
  priceAtomic?: bigint;
  now?: () => number;
}

export interface SwapOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface SwapRequestBody {
  account?: unknown;
  txHash?: unknown;
  amount?: unknown;
  network?: unknown;
}

/** 32-byte ledger hash, or the 33-byte identifier, as lower-case hex. */
const TX_HASH_PATTERN = /^[0-9a-f]{64,66}$/;

export interface SwapDesk {
  quote(params: URLSearchParams): SwapOutcome;
  swap(body: SwapRequestBody): Promise<SwapOutcome>;
}

export function createSwapDesk(deps: SwapDeskDeps): SwapDesk {
  const price = deps.priceAtomic ?? SWAP_PRICE_ATOMIC;
  const now = deps.now ?? (() => Date.now());
  const inFlight = new Set<string>();

  const refuse = (status: number, error: string, message: string): SwapOutcome => {
    console.warn(`[swap] refused: ${error} — ${message}`);
    return { status, body: { error, message } };
  };

  const quoteBody = () => ({
    network: deps.networkId,
    from: 'NIGHT',
    to: deps.assetSymbol,
    pay: formatAtomicNight(price),
    payAtomic: price.toString(),
    receive: deps.assetLot.toString(),
    /** Units of the asset one whole NIGHT buys, for the line under the price. */
    rate: `1 NIGHT = ${(deps.assetLot * 10n ** BigInt(NIGHT_DECIMALS)) / price} ${deps.assetSymbol}`,
    depositTo: deps.depositTo,
    expiresAt: new Date(now() + SWAP_QUOTE_TTL_MS).toISOString(),
  });

  const quote = (params: URLSearchParams): SwapOutcome => {
    const from = (params.get('from') ?? 'NIGHT').trim();
    const to = (params.get('to') ?? deps.assetSymbol).trim();
    if (from.toUpperCase() !== 'NIGHT') {
      return refuse(
        400,
        'unsupported-pair',
        `This desk takes NIGHT and pays ${deps.assetSymbol}. It cannot take ${from}.`,
      );
    }
    if (to.toLowerCase() !== deps.assetSymbol.toLowerCase()) {
      return refuse(
        400,
        'unsupported-pair',
        `This desk pays ${deps.assetSymbol}. It cannot pay ${to}.`,
      );
    }
    const amount = params.get('amount');
    if (amount !== null && amount.trim() !== '') {
      const wanted = parseNightAmount(amount);
      if (wanted === null) {
        return refuse(400, 'invalid-amount', 'amount must be NIGHT as a decimal with at most six places.');
      }
      if (wanted !== price) {
        return refuse(
          400,
          'unsupported-amount',
          `This desk sells one lot at a fixed price of ${formatAtomicNight(price)} NIGHT.`,
        );
      }
    }
    if (!deps.assetAvailable) {
      return refuse(
        503,
        'swap-unsupported',
        deps.assetUnavailableReason ?? `This balancer cannot pay ${deps.assetSymbol} right now.`,
      );
    }
    return { status: 200, body: quoteBody() };
  };

  const swap = async (body: SwapRequestBody): Promise<SwapOutcome> => {
    console.log(
      `[swap] asked to settle ${typeof body.txHash === 'string' ? body.txHash : '(no payment)'} for ${typeof body.account === 'string' ? body.account : '(no account)'}`,
    );
    if (body.network !== undefined && body.network !== deps.networkId) {
      return refuse(
        400,
        'wrong-network',
        `That request names the ${String(body.network)} network; this desk trades on ${deps.networkId}.`,
      );
    }
    if (typeof body.account !== 'string') {
      return refuse(400, 'invalid-account', 'POST {"account": "64 hex", "txHash": "…"}.');
    }
    let account: string;
    try {
      account = deps.normaliseAccount(body.account);
    } catch (cause) {
      return refuse(400, 'invalid-account', cause instanceof Error ? cause.message : String(cause));
    }
    if (typeof body.txHash !== 'string') {
      return refuse(400, 'invalid-payment', 'txHash must be the payment transaction, as hex.');
    }
    const txHash = body.txHash.trim().toLowerCase();
    if (!TX_HASH_PATTERN.test(txHash)) {
      return refuse(400, 'invalid-payment', 'txHash must be 64 or 66 lower-case hex characters.');
    }
    if (body.amount !== undefined) {
      const wanted = typeof body.amount === 'string' ? parseNightAmount(body.amount) : null;
      if (wanted === null) {
        return refuse(400, 'invalid-amount', 'amount must be NIGHT as a decimal with at most six places.');
      }
      if (wanted !== price) {
        return refuse(
          400,
          'unsupported-amount',
          `This desk sells one lot at a fixed price of ${formatAtomicNight(price)} NIGHT.`,
        );
      }
    }

    /* THE IDEMPOTENCY GATE, read before anything is verified or spent. A hash
       already served answers with the SAME two transactions: a demo that is
       clicked twice, or a page that is reloaded mid-settlement, must not buy a
       second lot with one payment. */
    const previous = deps.ledger.get(txHash);
    if (previous) {
      if (previous.account !== account) {
        return refuse(
          409,
          'payment-spent',
          'That payment has already been settled, for a different Passport.',
        );
      }
      return {
        status: 200,
        body: {
          settled: true,
          repeat: true,
          account,
          paymentTx: txHash,
          depositTx: previous.depositTx,
          ...(previous.mintTx === undefined ? {} : { mintTx: previous.mintTx }),
          received: previous.received,
          symbol: previous.symbol,
          paid: formatAtomicNight(BigInt(previous.paidAtomic)),
          at: previous.at,
        },
      };
    }

    if (!deps.assetAvailable) {
      return refuse(
        503,
        'swap-unsupported',
        deps.assetUnavailableReason ?? `This balancer cannot pay ${deps.assetSymbol} right now.`,
      );
    }

    /* One settlement per payment at a time. A second request for a hash still
       in the air is refused rather than queued: the ledger it would check
       cannot see a payout that has not been recorded yet. */
    if (inFlight.has(txHash)) {
      return refuse(
        409,
        'swap-in-flight',
        'That payment is already being settled. Wait for it to finish before asking again.',
      );
    }
    inFlight.add(txHash);
    try {
      const verdict = await deps.verifyPayment(txHash);
      if (verdict.state === 'unreachable') {
        return refuse(
          503,
          'indexer-unreachable',
          'The payment could not be checked just now. Nothing was paid out; ask again shortly.',
        );
      }
      if (verdict.state === 'absent') {
        return refuse(
          409,
          'payment-not-seen',
          'That payment is not on chain yet. Wait for it to land, then ask again.',
        );
      }

      const payout = await deps.payOut(account);
      const entry: SwapEntry = {
        account,
        paidAtomic: price.toString(),
        received: payout.amount.toString(),
        symbol: deps.assetSymbol,
        depositTx: payout.depositTxHash,
        ...(payout.mintTxHash === undefined ? {} : { mintTx: payout.mintTxHash }),
        at: new Date(now()).toISOString(),
      };
      /* Recorded on the way out, after the credit is real. The payout path
         resolves only once the account's own balance has been read back
         carrying the credit, so an entry here is a settlement that happened. */
      await deps.ledger.record(txHash, entry);
      console.log(
        `[swap] ${account} paid ${formatAtomicNight(price)} NIGHT (${txHash}) and received ${payout.amount} ${deps.assetSymbol} (${payout.depositTxHash})`,
      );
      return {
        status: 200,
        body: {
          settled: true,
          repeat: false,
          account,
          paymentTx: verdict.hash,
          paymentBlock: verdict.block,
          depositTx: payout.depositTxHash,
          ...(payout.mintTxHash === undefined ? {} : { mintTx: payout.mintTxHash }),
          received: entry.received,
          symbol: deps.assetSymbol,
          paid: formatAtomicNight(price),
          at: entry.at,
        },
      };
    } finally {
      inFlight.delete(txHash);
    }
  };

  return { quote, swap };
}

/** The concrete ledger, for the service. Tests stand in their own. */
export function swapLedgerOf(ledger: JsonLedger<SwapEntry>): SwapLedger {
  return {
    get: (key) => ledger.get(key),
    record: (key, entry) => ledger.record(key, entry),
    get count() {
      return ledger.count;
    },
  };
}
