// MIP-0012 conformance — tests 1 (deposit conformance), 2 (witness spend),
// and 3 (change chain, the change-rule regression gate).
//
//   1. Deposit lands; public state holds no coin material; the inbox entry
//      decrypts to the deposited coin; index capture succeeds, including a
//      wrong-index candidate-retry probe that fails at proving without
//      producing a transaction (INV-2, INV-4, INV-5).
//   2. A full-amount spend from the coin store is accepted by the node
//      (INV-1, INV-2) — run here as the second hop of the change chain, so
//      it also proves the change coin is first-class.
//   3. Partial spend, re-capture of the surviving change (the §6.3
//      baseline realisation: persist result.change directly, no re-owning
//      step), inbox backfill, spend of the change in a LATER transaction
//      (INV-3). This test fails on the consumed-coin defect (R4).

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence } from './evidence.js';
import {
  standardSetup,
  mintToUser,
  depositAndCapture,
  captureChange,
  withdrawShieldedWithRetry,
  userCoinPublicKey,
  expectAbort,
} from './flow.js';
import { openInboxEntry } from '../wallet/inbox.js';
import { needlesFor, auditSurfaces } from './observer.js';
import { bytesToHex } from '../wallet/hex.js';

const COLOR_SEED = '0'.repeat(62) + '11';
const MINT = 600n;
const FIRST_SPEND = 200n; // leaves 400 change
const SECOND_SPEND = 400n; // full amount of the change coin

await runScenario('custody-shielded', async () => {
  const s = await standardSetup();
  const userCpk = await userCoinPublicKey(s.ctx);
  const details: Record<string, unknown> = { account: s.account.address };

  // ── Test 1: deposit conformance ───────────────────────────────────────────

  step('test 1: mint 600, deposit_shielded with a sealed InboxEntry, capture the index');
  const coin = await mintToUser(s.ctx, s.faucet, COLOR_SEED, MINT);
  const dep = await depositAndCapture(s.account, s.encKeys, coin);
  details.depositTx = dep.depositTx;
  details.mtIndexCandidates = dep.candidates.map(String);

  const ledger1 = await waitForLedger(
    () => s.account.ledgerState(),
    'inbox grew by one',
    (l) => l.inbox_count === 1n,
  );

  step('test 1a: the inbox entry decrypts to the deposited coin (INV-4)');
  const entry = ledger1.inbox.lookup(0n);
  const opened = openInboxEntry(s.encKeys.secretKey, entry);
  if (!opened) throw new Error('inbox entry did not decrypt with the account secret');
  if (
    opened.value !== coin.value ||
    !Buffer.from(opened.nonce).equals(Buffer.from(coin.nonce)) ||
    !Buffer.from(opened.color).equals(Buffer.from(coin.color))
  ) {
    throw new Error('decrypted entry does not match the deposited coin');
  }
  console.log('  ✓ entry decrypts to the deposited coin');

  step('test 1b: no coin material in observer surfaces (INV-2)');
  const needles = needlesFor('deposit', coin);
  const audit = await auditSurfaces(s.ctx.providers, s.account.address, [dep.depositTx], needles);
  details.depositAudit = audit.leaks;
  if (audit.leaked) {
    throw new Error(`coin material visible to observers: ${JSON.stringify(audit.leaks)}`);
  }
  console.log('  ✓ nonce, color, and value absent from raw tx and contract state');

  step('test 1c: wrong-index candidate probe fails at proving, no transaction (INV-5)');
  const ledgerBeforeProbe = await s.account.ledgerState();
  const wrongIndex = dep.candidates[dep.candidates.length - 1] + 1000n;
  await s.account.putCoin({ ...coin, mtIndex: wrongIndex });
  details.wrongIndexRejection = await expectAbort('spend with a wrong mt_index', () =>
    s.account.withdrawShielded(s.device, userCpk, coin.color, 50n));
  const ledgerAfterProbe = await s.account.ledgerState();
  if (
    ledgerAfterProbe.round !== ledgerBeforeProbe.round ||
    ledgerAfterProbe.auth_nonce !== ledgerBeforeProbe.auth_nonce
  ) {
    throw new Error('wrong-index probe produced a transaction');
  }
  console.log('  ✓ failed locally at proving; ledger untouched');

  // ── Test 3: change chain (partial spend first) ────────────────────────────

  step('test 3a: partial spend 200 of 600 — authorised witness spend (candidate retry)');
  const spend1 = await withdrawShieldedWithRetry(
    s.account, s.device, userCpk, coin, FIRST_SPEND, dep.candidates,
  );
  details.partialSpendTx = spend1.txId;
  details.partialSpendAttempts = spend1.attempts;
  if (!spend1.change) throw new Error('partial spend returned no change coin');
  if (spend1.change.value !== MINT - FIRST_SPEND) {
    throw new Error(`change value ${spend1.change.value}, expected ${MINT - FIRST_SPEND}`);
  }
  console.log(`  change: value=${spend1.change.value} nonce=${bytesToHex(spend1.change.nonce).slice(0, 16)}…`);

  step('test 3b: persist the SURVIVING coin (result.change, §6.3) and backfill the inbox');
  await s.account.dropCoin(coin.color);
  const changeCapture = await captureChange(s.account, s.device, s.encKeys, spend1.txId, {
    nonce: spend1.change.nonce,
    color: spend1.change.color,
    value: spend1.change.value,
  });
  details.changeCandidates = changeCapture.candidates.map(String);
  const ledger3 = await waitForLedger(
    () => s.account.ledgerState(),
    'inbox backfilled (INV-4)',
    (l) => l.inbox_count === 2n,
  );
  const backfilled = openInboxEntry(s.encKeys.secretKey, ledger3.inbox.lookup(1n));
  if (!backfilled || backfilled.value !== MINT - FIRST_SPEND) {
    throw new Error('backfilled entry does not decrypt to the change coin');
  }

  // ── Test 2 + 3c: spend the change, full amount, in a later transaction ────

  step('test 2/3c: full-amount spend of the change coin in a later transaction (INV-3)');
  const spend2 = await withdrawShieldedWithRetry(
    s.account, s.device, userCpk, spend1.change, SECOND_SPEND, changeCapture.candidates,
  );
  details.changeSpendTx = spend2.txId;
  details.changeSpendAttempts = spend2.attempts;
  if (spend2.change) throw new Error('full-amount spend unexpectedly returned change');
  await s.account.dropCoin(coin.color);
  console.log(`  ✓ node accepted the change spend: ${spend2.txId}`);
  console.log('  (this is the regression gate for the consumed-coin defect, R4)');

  step('post-conditions: observer audit over the whole lifecycle (INV-2)');
  const lifecycleAudit = await auditSurfaces(
    s.ctx.providers,
    s.account.address,
    [spend1.txId, spend2.txId],
    needlesFor('change', { nonce: spend1.change.nonce, color: coin.color, value: spend1.change.value }),
  );
  details.lifecycleAudit = lifecycleAudit.leaks;
  if (lifecycleAudit.leaked) {
    throw new Error('change-coin material visible to observers');
  }
  console.log('  ✓ change coin never observable');

  writeEvidence({
    testId: 'CUST-1-2-3',
    name: 'custody-shielded',
    description: 'MIP-0012 deposit conformance, witness spend, change chain',
    verdict: 'PASS',
    note: 'Stateless deposit conforms (entry decrypts, no coin material observable, wrong-index probe fails at proving); partial spend + surviving-coin capture + cross-transaction change spend all accepted by the node.',
    details,
  });
});
