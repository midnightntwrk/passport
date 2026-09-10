// MIP-0013 conformance — tests 1 (happy path), 2 (rejection matrix),
// 5 (deposit independence), and 10 (bootstrap).
//
//   1. A gated call with a valid signature from an active device executes;
//      auth_nonce and round advance (AUTH-1, AUTH-2).
//   2. The same call aborts, with no state change, under each single
//      fault: wrong sig.s; a signature for a different challenge;
//      unregistered pk; wrong use counter; tampered argument; stale
//      auth_nonce; reused signature. The
//      stale-epoch fault is N/A until the recovery seam lands (no circuit
//      bumps device_epoch yet).
//   3. A permissionless deposit lands between signing and submission; the
//      pending authorisation still executes (AUTH-8).
//   4. Bootstrap (§3): a second activation aborts; activation with
//      arguments not matching the boot commitment aborts; the committed
//      (pk, salt) activates and installs the entry at epoch 0, counter 0.
//
// Funding uses the unshielded surface (Night from the genesis wallet), so
// the suite exercises withdraw_unshielded as its gated call.

import { randomBytes } from 'node:crypto';

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { standardSetup, expectAbort } from './flow.js';
import { compiledAccountContract } from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { CustodyAccount } from '../wallet/account.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { k256Challenges, K256Device, type K256Authorisation } from '../wallet/signer.js';

const NIGHT = new Uint8Array(32); // the all-zero color
const FUND = 10_000n;
const SPEND = 500n;

await runScenario('auth-conformance', async () => {
  const s = await standardSetup();
  const recipient = userAddressBytes(s.ctx.walletCtx);
  const details: Record<string, unknown> = { account: s.account.address };

  // ── Funding (permissionless deposit; round advances, auth_nonce does not) ─

  step('fund: deposit_unshielded 10000 Night (permissionless)');
  const ledger0 = await s.account.ledgerState();
  await s.account.depositUnshielded(NIGHT, FUND);
  const ledger1 = await waitForLedger(
    () => s.account.ledgerState(),
    'deposit mirrored',
    (l) => l.unshielded_balances.member(NIGHT) && l.unshielded_balances.lookup(NIGHT) === FUND,
  );
  if (ledger1.round <= ledger0.round) throw new Error('deposit did not advance round (INV-7)');
  if (ledger1.auth_nonce !== ledger0.auth_nonce) {
    throw new Error('permissionless deposit advanced auth_nonce (violates AUTH-8)');
  }
  console.log(`  round ${ledger0.round} → ${ledger1.round}, auth_nonce unchanged at ${ledger1.auth_nonce}`);

  // ── Test 1: happy path ────────────────────────────────────────────────────

  step('test 1: authorised withdraw_unshielded executes; counters advance');
  const before = await s.account.ledgerState();
  const { txId } = await s.account.withdrawUnshielded(s.device, NIGHT, SPEND, recipient);
  details.happyPathTx = txId;
  const after = await waitForLedger(
    () => s.account.ledgerState(),
    'withdrawal debited the mirror',
    (l) => l.unshielded_balances.lookup(NIGHT) === FUND - SPEND,
  );
  if (after.auth_nonce !== before.auth_nonce + 1n) throw new Error('auth_nonce did not advance by 1 (AUTH-2)');
  if (after.round <= before.round) throw new Error('round did not advance (INV-7)');
  console.log(`  tx ${txId}; auth_nonce ${before.auth_nonce} → ${after.auth_nonce}`);

  // ── Test 2: rejection matrix ──────────────────────────────────────────────
  //
  // Every fault must abort before any transaction reaches the node: the
  // in-circuit assert fails during local execution/proving, so the call
  // throws and no state changes. After each fault we assert the ledger is
  // untouched.

  step('test 2: rejection matrix (each single fault aborts, no state change)');
  const matrix: Record<string, string> = {};
  const ctxNow = async () => s.account.callContext();
  const counterNow = async () => s.account.resolveUseCounter(s.device);

  // (a) wrong sig.s
  {
    const ctx = await ctxNow();
    const auth = s.device.sign(k256Challenges.withdrawUnshielded(ctx, s.device.pk, NIGHT, SPEND, recipient), await counterNow());
    const bad: K256Authorisation = { ...auth, sig: { r: auth.sig.r, s: (auth.sig.s + 1n) } };
    matrix.wrongSigS = await expectAbort('wrong sig.s', () =>
      s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, bad));
  }

  // (b) signature from a different challenge (signed for a different amount)
  {
    const ctx = await ctxNow();
    const other = s.device.sign(k256Challenges.withdrawUnshielded(ctx, s.device.pk, NIGHT, SPEND + 1n, recipient), await counterNow());
    matrix.foreignSigR = await expectAbort('signature computed for a different call', () =>
      s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, other));
  }

  // (c) unregistered pk
  {
    const ctx = await ctxNow();
    const stranger = K256Device.generate();
    const auth = stranger.sign(k256Challenges.withdrawUnshielded(ctx, stranger.pk, NIGHT, SPEND, recipient), 0n);
    matrix.unregisteredPk = await expectAbort('unregistered device key', () =>
      s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, auth));
  }

  // (c2) wrong use counter: the rolling entry at counter+1 is not in the
  // set yet, so the seam's membership assert fails (AUTH-9)
  {
    const ctx = await ctxNow();
    const counter = await counterNow();
    const auth = s.device.sign(k256Challenges.withdrawUnshielded(ctx, s.device.pk, NIGHT, SPEND, recipient), counter + 1n);
    matrix.wrongUseCounter = await expectAbort('wrong use counter (AUTH-9)', () =>
      s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, auth));
  }

  // (d) tampered argument with an otherwise-valid signature
  {
    const ctx = await ctxNow();
    const auth = s.device.sign(k256Challenges.withdrawUnshielded(ctx, s.device.pk, NIGHT, SPEND, recipient), await counterNow());
    matrix.tamperedArg = await expectAbort('tampered amount under a valid signature (AUTH-3)', () =>
      s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND * 2n, recipient, auth));
  }

  // (e) stale auth_nonce (signed against a nonce that has since advanced)
  {
    const ctx = await ctxNow();
    const stale = { ...ctx, authNonce: ctx.authNonce - 1n };
    const auth = s.device.sign(k256Challenges.withdrawUnshielded(stale, s.device.pk, NIGHT, SPEND, recipient), await counterNow());
    matrix.staleNonce = await expectAbort('stale auth_nonce (AUTH-2)', () =>
      s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, auth));
  }

  const untouched = await s.account.ledgerState();
  if (untouched.auth_nonce !== after.auth_nonce || untouched.unshielded_balances.lookup(NIGHT) !== FUND - SPEND) {
    throw new Error('a rejected call changed state');
  }
  console.log('  ✓ ledger untouched by all rejected calls');

  // (f) reused signature after a successful call
  {
    const ctx = await ctxNow();
    const auth = s.device.sign(k256Challenges.withdrawUnshielded(ctx, s.device.pk, NIGHT, SPEND, recipient), await counterNow());
    const ok = await s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, auth);
    console.log(`  first use accepted: ${ok.txId}`);
    await waitForLedger(
      () => s.account.ledgerState(),
      'second withdrawal debited',
      (l) => l.unshielded_balances.lookup(NIGHT) === FUND - 2n * SPEND,
    );
    matrix.reusedSignature = await expectAbort('reused signature (AUTH-2 single use)', () =>
      s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, auth));
  }
  details.rejectionMatrix = matrix;
  details.staleEpochFault = 'N/A — no epoch-bump surface until the recovery-paths MIP instantiates MIP-0013 §8';

  // ── Test 5: deposit independence (AUTH-8) ─────────────────────────────────

  step('test 5: a deposit lands between signing and submission; the authorisation survives');
  const ctx = await s.account.callContext();
  const pending = s.device.sign(
    k256Challenges.withdrawUnshielded(ctx, s.device.pk, NIGHT, SPEND, recipient),
    await s.account.resolveUseCounter(s.device),
  );
  // A third party funds the account while our signature is in flight.
  await s.account.depositUnshielded(NIGHT, 777n);
  await waitForLedger(
    () => s.account.ledgerState(),
    'interleaved deposit mirrored',
    (l) => l.unshielded_balances.lookup(NIGHT) === FUND - 2n * SPEND + 777n,
  );
  const r = await s.account.withdrawUnshieldedWithAuth(NIGHT, SPEND, recipient, pending);
  details.depositIndependenceTx = r.txId;
  await waitForLedger(
    () => s.account.ledgerState(),
    'pending authorisation executed after the deposit',
    (l) => l.unshielded_balances.lookup(NIGHT) === FUND - 3n * SPEND + 777n,
  );
  console.log('  ✓ deposit did not invalidate the pending authorisation (AUTH-8)');

  // ── Test 10: bootstrap (MIP-0013 §3) ──────────────────────────────────────
  //
  // The active account rejects a second activation, and a dormant account
  // rejects activations whose arguments do not match the boot commitment;
  // the committed (pk, salt) then activates and installs the entry at
  // epoch 0, use counter 0. The wrong-commitment probes need a dormant
  // account: on an active one assert(!booted) fires first and would mask
  // the commitment check.

  step('test 10: bootstrap — double activation and wrong commitment abort');
  const bootstrap: Record<string, string> = {};

  bootstrap.secondActivation = await expectAbort('second activation on an active account', () =>
    s.account.activateInitialDevice(s.device, randomBytes(32)));

  const device2 = K256Device.generate();
  const dormant = await CustodyAccount.deployDormant(
    s.ctx.providers, compiledAccountContract(), device2, generateEncKeyPair(),
  );
  console.log(`  dormant account @ ${dormant.address}`);

  const wrongSalt = randomBytes(32);
  bootstrap.wrongSalt = await expectAbort('activation with a salt not matching the commitment', () =>
    dormant.activate(device2, wrongSalt));
  bootstrap.wrongKey = await expectAbort('activation with a substituted device key', () =>
    dormant.activate(K256Device.generate(), dormant.salt));

  await dormant.activate(device2, dormant.salt);
  const account2 = dormant.finish();
  const booted = await waitForLedger(
    () => account2.ledgerState(),
    'dormant account activated with the committed (pk, salt)',
    (l) => l.booted === true && l.device_count === 1n,
  );
  const entry0 = device2.entryAt(account2.addressBytes, booted.device_epoch, 0n);
  if (!booted.devices.member(entry0)) {
    throw new Error('activation did not install the entry at epoch 0, use counter 0');
  }
  console.log('  ✓ committed (pk, salt) activated; entry at epoch 0, counter 0 installed');
  details.bootstrap = bootstrap;

  writeEvidence({
    testId: 'AUTH-1-2-5-10',
    name: 'auth-conformance',
    description: 'MIP-0013 happy path, rejection matrix, deposit independence, bootstrap',
    verdict: 'PASS',
    note: 'Gated call executes with a valid device signature; every single-fault variant aborts with no state change; a permissionless deposit between signing and submission does not invalidate the pending authorisation; double activation and commitment-mismatched activation abort, and the committed (pk, salt) installs the initial entry.',
    details,
  });
});
