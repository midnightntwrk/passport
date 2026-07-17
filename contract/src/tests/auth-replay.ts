// MIP-0013 conformance — tests 3 (cross-account replay) and 4 (cross-
// circuit replay).
//
//   3. One device key registered in two accounts; a signature computed for
//      account one is rejected by account two (AUTH-3: the challenge binds
//      kernel.self()).
//   4. A signature for one gated circuit is rejected by another gated
//      circuit with an identical argument list (AUTH-3: per-circuit tags).
//      The pair used is withdraw_shielded / withdraw_shielded_to_contract,
//      whose argument lists are byte-identical ({bytes: 32}, color,
//      amount). Both rejections happen at the seam, before any witness or
//      asset is consulted.

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence } from './evidence.js';
import { standardSetup, expectAbort } from './flow.js';
import { userAddressBytes } from '../node/wallet.js';
import { deployAccount } from '../node/setup.js';
import { challenges, Device } from '../wallet/signer.js';
import { generateEncKeyPair } from '../wallet/inbox.js';

const NIGHT = new Uint8Array(32);
const FUND = 2_000n;
const SPEND = 100n;

await runScenario('auth-replay', async () => {
  const s = await standardSetup();
  const recipient = userAddressBytes(s.ctx.walletCtx);
  const details: Record<string, unknown> = { accountOne: s.account.address };

  step('deploy account two with the SAME initial device key');
  const accountTwo = await deployAccount(s.ctx, s.device, generateEncKeyPair());
  details.accountTwo = accountTwo.address;
  console.log(`  account two @ ${accountTwo.address}`);

  step('fund both accounts');
  await s.account.depositUnshielded(NIGHT, FUND);
  await accountTwo.depositUnshielded(NIGHT, FUND);
  await waitForLedger(
    () => accountTwo.ledgerState(),
    'account two funded',
    (l) => l.unshielded_balances.member(NIGHT) && l.unshielded_balances.lookup(NIGHT) === FUND,
  );

  // ── Test 3: cross-account replay ──────────────────────────────────────────

  step('test 3: a signature for account one is rejected by account two');
  const ctxOne = await s.account.callContext();
  const authForOne = s.device.sign(
    challenges.withdrawUnshielded(ctxOne, s.device.pk, NIGHT, SPEND, recipient),
  );
  details.crossAccountRejection = await expectAbort(
    'account two given account one’s signature (AUTH-3, address binding)',
    () => accountTwo.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, authForOne),
  );
  const twoUntouched = await accountTwo.ledgerState();
  if (twoUntouched.auth_nonce !== 0n || twoUntouched.unshielded_balances.lookup(NIGHT) !== FUND) {
    throw new Error('cross-account replay changed account two state');
  }

  step('test 3 control: the same signature succeeds on account one');
  const ok = await s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, authForOne);
  details.controlTx = ok.txId;
  await waitForLedger(
    () => s.account.ledgerState(),
    'account one debited by the control call',
    (l) => l.unshielded_balances.lookup(NIGHT) === FUND - SPEND,
  );

  // ── Test 4: cross-circuit replay ──────────────────────────────────────────

  step('test 4: a withdraw_shielded signature is rejected by withdraw_shielded_to_contract');
  const dest = new Uint8Array(32).fill(3); // 32-byte recipient, identical bytes for both circuits
  const ctx = await s.account.callContext();
  const authShielded = s.device.sign(
    challenges.withdrawShielded(ctx, s.device.pk, dest, NIGHT, SPEND),
  );
  details.crossCircuitRejection = await expectAbort(
    'sibling circuit with an identical argument list (AUTH-3, per-circuit tags)',
    () => s.account.withdrawShieldedToContractWithAuth(dest, NIGHT, SPEND, authShielded),
  );
  const oneAfter = await s.account.ledgerState();
  if (oneAfter.auth_nonce !== ctx.authNonce) {
    throw new Error('cross-circuit replay advanced auth_nonce');
  }
  console.log('  ✓ both replays rejected at the seam; no witness or asset consulted');

  writeEvidence({
    testId: 'AUTH-3-4',
    name: 'auth-replay',
    description: 'MIP-0013 cross-account and cross-circuit replay rejection',
    verdict: 'PASS',
    note: 'A signature binds the account address and the per-circuit tag: replay against a second account holding the same device key, and against a sibling circuit with a byte-identical argument list, both abort with no state change.',
    details,
  });
});
