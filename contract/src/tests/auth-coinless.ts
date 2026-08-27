// Seam conformance on the coinless authorisation surface, both arms — the
// arm-specific halves of MIP-0013 tests 1, 2 (fault (a)), 6, and 10 that
// carry no token offer, plus the cross-arm enrolment path that only exists
// because the arms are co-resident.
//
// Rationale: on the ledger-9 localnet, any transaction combining a contract
// call with an unshielded offer is rejected at the mempool by the fee
// model's time-to-dismiss limit (see README, "Known localnet limitation"),
// which blocks the funded suites. The authorisation seam itself is
// exercisable without coins: activation (bootstrap), gated add_device, the
// tampered-signature aborts, and each arm authorising gated calls of its
// own. Flow:
//
//   1. deploy + activate under the k256 arm (test 10 happy leg; entry at
//      epoch 0, counter 0)
//   2. CROSS-ARM: the k256 device enrols a JUBJUB device — the k256 seam
//      gates the call, the jubjub entry lands (the arm-migration path)
//   3. the jubjub device authorises a gated call of its own: it enrols a
//      second jubjub device — the Schnorr seam verifies on-node and the
//      rolling entry advances (test 6's 1-of-n half under the jubjub arm)
//   4. gated add_device with tampered jubjub sig_s -> in-circuit Schnorr
//      verify fails, call aborts, no state change (test 2 fault (a))
//   5. gated add_device with tampered k256 sig.s -> in-circuit ECDSA verify
//      fails, call aborts, no state change (test 2 fault (a))
//   6. CROSS-ARM, reverse: the jubjub device enrols a k256 device

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence } from './evidence.js';
import { standardSetup, expectAbort } from './flow.js';
import {
  JubjubDevice,
  K256Device,
  jubjubChallenges,
  k256Challenges,
  type JubjubAuthorisation,
  type K256Authorisation,
} from '../wallet/signer.js';

await runScenario('auth-coinless (both arms)', async () => {
  const s = await standardSetup(); // initial device: k256
  const details: Record<string, unknown> = { account: s.account.address };
  const l0 = await s.account.ledgerState();
  console.log(`  account ${s.account.address}; auth_nonce ${l0.auth_nonce}; initial arm k256`);

  step('cross-arm enrolment: the k256 device adds a jubjub device');
  const j1 = JubjubDevice.generate();
  const { txId } = await s.account.addDevice(s.device, j1);
  const l1 = await waitForLedger(
    () => s.account.ledgerState(),
    'auth_nonce advanced',
    (l) => l.auth_nonce === l0.auth_nonce + 1n,
  );
  if (l1.device_count !== 2n) throw new Error('jubjub device entry did not land');
  details.crossArmAddTx = txId;
  console.log(`  accepted tx ${txId}; auth_nonce ${l0.auth_nonce} -> ${l1.auth_nonce}; devices ${l1.device_count}`);

  step('the jubjub device authorises a gated call of its own (Schnorr seam on-node)');
  const j2 = JubjubDevice.generate();
  const r2 = await s.account.addDevice(j1, j2);
  const l2 = await waitForLedger(
    () => s.account.ledgerState(),
    'auth_nonce advanced again',
    (l) => l.auth_nonce === l0.auth_nonce + 2n,
  );
  if (l2.device_count !== 3n) throw new Error('second jubjub entry did not land');
  details.jubjubSeamTx = r2.txId;
  console.log(`  accepted tx ${r2.txId}; auth_nonce ${l1.auth_nonce} -> ${l2.auth_nonce}; devices ${l2.device_count}`);

  step('gated add_device with tampered jubjub sig_s aborts');
  {
    const probe = JubjubDevice.generate();
    const ctx = await s.account.callContext();
    const counter = await s.account.resolveUseCounter(j1);
    const newEntry = probe.entryAt(s.account.addressBytes, l2.device_epoch, 0n);
    const auth = j1.sign(jubjubChallenges.addDevice(ctx, j1.pk, newEntry), counter);
    const bad: JubjubAuthorisation = { ...auth, sig_s: auth.sig_s + 1n };
    details.tamperedJubjubAbort = await expectAbort('tampered jubjub sig_s', () =>
      s.account.addDeviceWithAuth(newEntry, bad));
    const untouched = await s.account.ledgerState();
    if (untouched.auth_nonce !== l2.auth_nonce) {
      throw new Error('aborted jubjub call changed auth_nonce');
    }
  }

  step('gated add_device with tampered k256 sig.s aborts');
  {
    const probe = K256Device.generate();
    const ctx = await s.account.callContext();
    const counter = await s.account.resolveUseCounter(s.device);
    const newEntry = probe.entryAt(s.account.addressBytes, l2.device_epoch, 0n);
    const auth = s.device.sign(k256Challenges.addDevice(ctx, s.device.pk, newEntry), counter);
    const bad: K256Authorisation = { ...auth, sig: { r: auth.sig.r, s: auth.sig.s + 1n } };
    details.tamperedK256Abort = await expectAbort('tampered k256 sig.s', () =>
      s.account.addDeviceWithAuth(newEntry, bad));
    const untouched = await s.account.ledgerState();
    if (untouched.auth_nonce !== l2.auth_nonce) {
      throw new Error('aborted k256 call changed auth_nonce');
    }
  }

  step('cross-arm enrolment, reverse: the jubjub device adds a k256 device');
  const k2 = K256Device.generate();
  const r3 = await s.account.addDevice(j1, k2);
  const l3 = await waitForLedger(
    () => s.account.ledgerState(),
    'auth_nonce advanced a third time',
    (l) => l.auth_nonce === l0.auth_nonce + 3n,
  );
  if (l3.device_count !== 4n) throw new Error('reverse cross-arm entry did not land');
  details.reverseCrossArmAddTx = r3.txId;
  console.log(`  accepted tx ${r3.txId}; auth_nonce ${l2.auth_nonce} -> ${l3.auth_nonce}; devices ${l3.device_count}`);

  writeEvidence({
    testId: 'AUTH-COINLESS-ARMS',
    name: 'auth-coinless',
    description:
      'Co-resident arms: k256 and jubjub seams both gate on-node; cross-arm enrolment in both directions; tampered signatures abort per arm',
    verdict: 'PASS',
    note: 'Both in-circuit verifications gate state changes on-node: a k256 device enrolled a jubjub device and vice versa (the arm-migration path), the jubjub device authorised its own gated call through its rolling entry, and a tampered signature of either arm failed its in-circuit assert with no state change.',
    details,
  });
});
