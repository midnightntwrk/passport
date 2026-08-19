// MIP-0012 conformance — test 5: the observer leak audit.
//
// Identical lifecycles (deposit 600, partial spend 200, change 400) run
// through this standard's stateless path and through the public-map
// control contract; a byte-scan of raw transactions and contract state
// finds coin material in the control (validating the scanner — the
// positive control) and none in the conforming path (INV-2).

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence } from './evidence.js';
import {
  standardSetup,
  mintToUser,
  depositAndCapture,
  captureChange,
  withdrawShieldedWithRetry,
  userCoinPublicKey,
} from './flow.js';
import { deployControl } from '../node/setup.js';
import { needlesFor, auditSurfaces, anyHit } from './observer.js';

const SEED_CONTROL = '0'.repeat(62) + '6c';
const SEED_STATELESS = '0'.repeat(62) + '65';
const MINT = 600n;
const SPEND = 200n;

await runScenario('leak-audit', async () => {
  const s = await standardSetup();
  const userCpk = await userCoinPublicKey(s.ctx);
  const details: Record<string, unknown> = { account: s.account.address };

  // ── Control lifecycle (public map — the pattern INV-2 rules out) ──────────

  step('control: deploy the public-map contract; deposit 600, spend 200');
  const control = await deployControl(s.ctx.walletCtx);
  details.control = control.address;
  const controlCoin = await mintToUser(s.ctx, s.faucet, SEED_CONTROL, MINT);
  const cDepTx = await control.depositPublic({
    nonce: controlCoin.nonce,
    color: controlCoin.color,
    value: controlCoin.value,
  });
  await waitForLedger(
    () => control.ledgerState(),
    'control registered the coin publicly',
    (l: any) => l.public_coins.member(controlCoin.color),
  );
  const cSpendTx = await control.spendPublic(userCpk, controlCoin.color, SPEND);
  await sleep(10_000);
  details.controlTxs = { deposit: cDepTx, spend: cSpendTx };

  step('control audit: the scanner MUST find coin material (positive control)');
  const controlNeedles = needlesFor('control', controlCoin);
  const controlAudit = await auditSurfaces(
    control.providers,
    control.address,
    [cDepTx, cSpendTx],
    controlNeedles,
  );
  details.controlLeaks = controlAudit.leaks;
  if (!controlAudit.leaked) {
    throw new Error(
      'scanner found nothing on the public-map control — the audit method is invalid, not the path clean',
    );
  }
  const controlHits = Object.entries(controlAudit.leaks)
    .filter(([, hits]) => anyHit(hits))
    .map(([surface]) => surface);
  console.log(`  ✓ positive control leaked on: ${controlHits.join(', ')}`);

  // ── Conforming lifecycle (this standard) ──────────────────────────────────

  step('conforming path: deposit 600, spend 200, capture change 400');
  const coin = await mintToUser(s.ctx, s.faucet, SEED_STATELESS, MINT);
  const dep = await depositAndCapture(s.account, s.encKeys, coin);
  const spend = await withdrawShieldedWithRetry(
    s.account, s.device, userCpk, coin, SPEND, dep.candidates,
  );
  if (!spend.change) throw new Error('expected change from the partial spend');
  await s.account.dropCoin(coin.color);
  const backfill = await captureChange(s.account, s.device, s.encKeys, spend.txId, spend.change);
  details.conformingTxs = { deposit: dep.depositTx, spend: spend.txId, backfill: backfill.depositTx };

  step('conforming audit: no coin material anywhere observer-visible (INV-2)');
  const txIds = [dep.depositTx, spend.txId, backfill.depositTx];
  const depositNeedles = needlesFor('deposited-coin', coin);
  const changeNeedles = needlesFor('change-coin', {
    nonce: spend.change.nonce,
    color: coin.color,
    value: spend.change.value,
  });
  const auditDeposit = await auditSurfaces(s.ctx.providers, s.account.address, txIds, depositNeedles);
  const auditChange = await auditSurfaces(s.ctx.providers, s.account.address, txIds, changeNeedles);
  details.conformingLeaks = { deposited: auditDeposit.leaks, change: auditChange.leaks };
  if (auditDeposit.leaked || auditChange.leaked) {
    throw new Error('conforming path leaked coin material — INV-2 violated');
  }
  console.log('  ✓ deposited coin and change coin invisible on every surface');

  writeEvidence({
    testId: 'CUST-5',
    name: 'leak-audit',
    description: 'MIP-0012 observer leak audit: conforming path vs public-map control',
    verdict: 'PASS',
    note: 'Identical lifecycles through both patterns: the public-map control leaks nonce/color/value into observer surfaces (scanner validated); the conforming stateless path shows zero coin artefacts (INV-2).',
    details,
  });
});
