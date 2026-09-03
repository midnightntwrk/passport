/**
 * The swap desk: what it quotes, and what one payment can buy.
 *
 * The two properties worth pinning are the ones a demo will actually hit. The
 * quote must price the lot in NIGHT the way the app prints it, refusing a pair
 * or an amount it does not sell rather than quoting something it will not
 * settle. And a payment hash must buy exactly one lot: a second `POST /swap`
 * for a hash already served is the reload case, and it has to answer with the
 * SAME deposit rather than paying a second time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SWAP_PRICE_ATOMIC,
  createSwapDesk,
  formatAtomicNight,
  parseNightAmount,
  type PaymentVerdict,
  type SwapEntry,
  type SwapLedger,
} from '../src/swap.js';

const ACCOUNT = 'ab'.repeat(32);
const PAYMENT = 'cd'.repeat(32);

function memoryLedger(): SwapLedger & { entries: Map<string, SwapEntry> } {
  const entries = new Map<string, SwapEntry>();
  return {
    entries,
    get: (key) => entries.get(key) ?? null,
    record: async (key, entry) => {
      entries.set(key, entry);
    },
    get count() {
      return entries.size;
    },
  };
}

function desk(options: { verdict?: PaymentVerdict; ledger?: SwapLedger } = {}) {
  const ledger = options.ledger ?? memoryLedger();
  let payouts = 0;
  const made = createSwapDesk({
    networkId: 'stagenet',
    depositTo: 'mn_addr_test1sponsor',
    assetSymbol: 'mUSD',
    assetLot: 100n,
    assetAvailable: true,
    assetUnavailableReason: null,
    ledger,
    verifyPayment: async () => options.verdict ?? { state: 'landed', hash: PAYMENT, block: 42 },
    payOut: async () => {
      payouts += 1;
      return { depositTxHash: `deposit-${payouts}`, mintTxHash: `mint-${payouts}`, amount: 100n };
    },
    normaliseAccount: (value) => {
      if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('An account address is 64 hex characters.');
      return value;
    },
    now: () => Date.UTC(2026, 8, 3, 12, 0, 0),
  });
  return { desk: made, ledger, payouts: () => payouts };
}

describe('the quote', () => {
  it('prices one lot in display NIGHT, and names where the payment goes', () => {
    const { desk: d } = desk();
    const outcome = d.quote(new URLSearchParams('from=NIGHT&to=mUSD'));
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.pay, '0.0005');
    assert.equal(outcome.body.payAtomic, SWAP_PRICE_ATOMIC.toString());
    assert.equal(outcome.body.receive, '100');
    assert.equal(outcome.body.rate, '1 NIGHT = 200000 mUSD');
    assert.equal(outcome.body.depositTo, 'mn_addr_test1sponsor');
    assert.equal(typeof outcome.body.expiresAt, 'string');
  });

  it('accepts the amount it sells and refuses one it does not', () => {
    const { desk: d } = desk();
    assert.equal(d.quote(new URLSearchParams('amount=0.0005')).status, 200);
    const wrong = d.quote(new URLSearchParams('amount=1'));
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'unsupported-amount');
  });

  it('refuses a pair it does not trade', () => {
    const { desk: d } = desk();
    assert.equal(d.quote(new URLSearchParams('from=mUSD&to=NIGHT')).body.error, 'unsupported-pair');
  });

  it('reads NIGHT as exact units, never a float', () => {
    assert.equal(parseNightAmount('0.0005'), 500n);
    assert.equal(parseNightAmount('1'), 1_000_000n);
    assert.equal(parseNightAmount('0.0000005'), null);
    assert.equal(parseNightAmount('1e-3'), null);
    assert.equal(formatAtomicNight(2_000n), '0.002');
  });
});

describe('settling a payment', () => {
  it('pays one lot, records it, and says which transactions did it', async () => {
    const { desk: d, ledger, payouts } = desk();
    const outcome = await d.swap({ account: ACCOUNT, txHash: PAYMENT, amount: '0.0005' });
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.settled, true);
    assert.equal(outcome.body.repeat, false);
    assert.equal(outcome.body.depositTx, 'deposit-1');
    assert.equal(outcome.body.received, '100');
    assert.equal(payouts(), 1);
    assert.equal(ledger.get(PAYMENT)?.account, ACCOUNT);
  });

  it('is idempotent: the same payment never buys a second lot', async () => {
    const { desk: d, payouts } = desk();
    const first = await d.swap({ account: ACCOUNT, txHash: PAYMENT });
    const second = await d.swap({ account: ACCOUNT, txHash: PAYMENT.toUpperCase() });
    assert.equal(payouts(), 1);
    assert.equal(second.status, 200);
    assert.equal(second.body.repeat, true);
    assert.equal(second.body.depositTx, first.body.depositTx);
  });

  it('will not let a second Passport spend a payment already settled', async () => {
    const { desk: d, payouts } = desk();
    await d.swap({ account: ACCOUNT, txHash: PAYMENT });
    const stolen = await d.swap({ account: 'ef'.repeat(32), txHash: PAYMENT });
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.error, 'payment-spent');
    assert.equal(payouts(), 1);
  });

  it('pays nothing for a payment the chain has not seen', async () => {
    const { desk: d, payouts } = desk({ verdict: { state: 'absent' } });
    const outcome = await d.swap({ account: ACCOUNT, txHash: PAYMENT });
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.error, 'payment-not-seen');
    assert.equal(payouts(), 0);
  });

  it('an unreachable indexer is a 503, not a refusal to the user', async () => {
    const { desk: d, payouts } = desk({ verdict: { state: 'unreachable' } });
    const outcome = await d.swap({ account: ACCOUNT, txHash: PAYMENT });
    assert.equal(outcome.status, 503);
    assert.equal(outcome.body.error, 'indexer-unreachable');
    assert.equal(payouts(), 0);
  });

  it('refuses a malformed account or payment before anything is verified', async () => {
    const { desk: d, payouts } = desk();
    assert.equal((await d.swap({ account: 'nope', txHash: PAYMENT })).body.error, 'invalid-account');
    assert.equal((await d.swap({ account: ACCOUNT, txHash: 'nope' })).body.error, 'invalid-payment');
    assert.equal(
      (await d.swap({ account: ACCOUNT, txHash: PAYMENT, network: 'preview' })).body.error,
      'wrong-network',
    );
    assert.equal(payouts(), 0);
  });
});
