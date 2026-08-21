// ECDSA-secp256k1 seam conformance on the coinless authorisation surface —
// the arm-specific halves of MIP-0013 tests 1, 2 (fault (a)), 6, and 10 that
// carry no token offer.
//
// Rationale: on the ledger-9 localnet, any transaction combining a contract
// call with an unshielded offer is rejected at the mempool by the fee
// model's time-to-dismiss limit (see README, "Known localnet limitation"),
// which blocks the funded suites. The authorisation seam itself is
// exercisable without coins: activation (bootstrap), gated add_device with
// a valid signature, the tampered-signature abort, and a second device
// authorising its own gated call.
//
//   1. deploy + activate (test 10 happy leg; entry at epoch 0, counter 0)
//   2. gated add_device with a valid ECDSA signature -> accepted on-node,
//      auth_nonce advances (AUTH-1, AUTH-2 on the coinless surface)
//   3. gated add_device with tampered sig.s -> in-circuit verify fails,
//      call aborts, no state change (test 2 fault (a))
//   4. the added device authorises a gated call of its own (test 6's 1-of-n
//      half; the rolling entry mechanism under a second key)

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence } from './evidence.js';
import { standardSetup, expectAbort } from './flow.js';
import { challenges, Device, type Authorisation } from '../wallet/signer.js';

await runScenario('auth-coinless (ECDSA seam)', async () => {
  const s = await standardSetup();
  const details: Record<string, unknown> = { account: s.account.address };
  const l0 = await s.account.ledgerState();
  console.log(`  account ${s.account.address}; auth_nonce ${l0.auth_nonce}`);

  step('gated add_device with a valid ECDSA signature');
  const d2 = Device.generate();
  const { txId } = await s.account.addDevice(s.device, d2.pk);
  const l1 = await waitForLedger(
    () => s.account.ledgerState(),
    'auth_nonce advanced',
    (l) => l.auth_nonce === l0.auth_nonce + 1n,
  );
  details.addDeviceTx = txId;
  console.log(`  accepted tx ${txId}; auth_nonce ${l0.auth_nonce} -> ${l1.auth_nonce}`);

  step('gated add_device with tampered sig.s aborts');
  const d3 = Device.generate();
  const ctx = await s.account.callContext();
  const counter = await s.account.resolveUseCounter(s.device);
  const auth = s.device.sign(challenges.addDevice(ctx, s.device.pk, d3.pk), counter);
  const bad: Authorisation = { ...auth, sig: { r: auth.sig.r, s: auth.sig.s + 1n } };
  details.tamperedSigAbort = await expectAbort('tampered sig.s', () =>
    s.account.addDeviceWithAuth(d3.pk, bad));
  const untouched = await s.account.ledgerState();
  if (untouched.auth_nonce !== l1.auth_nonce) {
    throw new Error('aborted call changed auth_nonce');
  }

  step('second device authorises a gated call of its own');
  const r2 = await s.account.addDevice(d2, d3.pk);
  const l2 = await waitForLedger(
    () => s.account.ledgerState(),
    'auth_nonce advanced again',
    (l) => l.auth_nonce === l0.auth_nonce + 2n,
  );
  details.secondDeviceTx = r2.txId;
  console.log(`  accepted tx ${r2.txId}; auth_nonce ${l1.auth_nonce} -> ${l2.auth_nonce}`);

  writeEvidence({
    testId: 'AUTH-COINLESS-K1',
    name: 'auth-coinless',
    description:
      'ECDSA-secp256k1 seam: bootstrap, gated call, tampered-signature abort, second-device call',
    verdict: 'PASS',
    note: 'In-circuit secp256k1EcdsaVerify gates state changes on-node: a valid device signature executes and advances auth_nonce; a tampered signature fails the in-circuit assert with no state change; a newly added device authorises its own gated call through its rolling entry.',
    details,
  });
});
