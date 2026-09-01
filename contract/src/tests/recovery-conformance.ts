// Recovery conformance on a live localnet (recovery MIP, Path to Active):
// the on-node half of the evidence, mirroring the simulator matrix of
// recovery-sim.ts through real transactions, real proofs, and real block
// time. Deploys its own account with birth artefacts and a short veto
// window so the finalisation leg completes in one run.
//
// Requires the localnet from infra/ and WALLET_SEED, like the other
// on-node suites.

import { randomBytes } from 'node:crypto';

import { runScenario, step, sleep, waitForLedger } from './runner.js';
import { writeEvidence } from './evidence.js';
import { expectAbort } from './flow.js';
import { setupWallet, compiledAccountContract } from '../node/setup.js';
import { CustodyAccount } from '../wallet/account.js';
import { JubjubDevice } from '../wallet/signer.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { pureCircuits } from '../wallet/contract.js';
import {
  deriveShare,
  split,
  reconstruct,
  fieldToBytes,
  guardianSecretFromPrf,
  sealWrap,
  openWrap,
  newRecoverySecret,
  newSessionNonce,
  type IndexedShare,
} from '../wallet/recovery.js';

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

const eqBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

// Short deployment window: long enough that the early-finalise probe has
// time to land inside it under localnet block cadence, short enough that
// one suite run waits it out.
const WINDOW_SECONDS = 60n;

await runScenario('recovery-conformance', async () => {
  const details: Record<string, unknown> = {};

  step('setup: wallet, account with birth artefacts and a 60 s window');
  const ctx = await setupWallet();
  const device = JubjubDevice.generate();
  const encKeys = generateEncKeyPair();
  const birth = newRecoverySecret();
  const account = await CustodyAccount.deploy(
    ctx.providers,
    compiledAccountContract(),
    device,
    encKeys,
    {
      recovery: {
        commitment: pureCircuits.derive_recovery_commitment(birth.bytes),
        wrap: new Uint8Array(64), // birth wrap sealed post-deploy sessions only
        vetoWindowSeconds: WINDOW_SECONDS,
      },
    },
  );
  console.log(`  account @ ${account.address}`);
  details.account = account.address;
  let l = await account.ledgerState();
  assert(l.recovery_phi_len === 0n, 'no phi at deploy (recovery at birth is commitment-only here)');
  assert(l.recovery_version === 1n, 'artefact-set version tag present');

  step('session: three guardians at threshold two, published through the seam');
  const t = 1;
  const guardians = [0, 1, 2].map(() => guardianSecretFromPrf(new Uint8Array(randomBytes(32))));
  const s = newRecoverySecret();
  const sid = newSessionNonce();
  const shares: IndexedShare[] = guardians.map((g, i) => ({
    index: i + 1,
    sigma: deriveShare(sid, account.addressBytes, g),
  }));
  const phi = split(s.field, shares, t);
  const sessionTx = await account.publishRecoverySession(device, {
    commitment: pureCircuits.derive_recovery_commitment(s.bytes),
    sessionNonce: sid,
    phi,
    wrap: sealWrap(s.bytes, account.addressBytes, encKeys.secretKey),
  });
  details.sessionTx = sessionTx.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'artefact set on-chain',
    (led) => led.recovery_phi_len === 2n && eqBytes(led.recovery_session, sid),
  );

  step('freshness backstop on-node: reused identifier rejected');
  const s2 = newRecoverySecret();
  await expectAbort('publishing under the stored session identifier', () =>
    account.publishRecoverySession(device, {
      commitment: pureCircuits.derive_recovery_commitment(s2.bytes),
      sessionNonce: sid,
      phi: [1n, 2n],
      wrap: sealWrap(s2.bytes, account.addressBytes, encKeys.secretKey),
    }));

  step('total loss: reconstruct from t+1 shares and the on-chain vector');
  l = await account.ledgerState();
  const phiOnChain: bigint[] = [];
  for (let k = 1n; k <= l.recovery_phi_len; k++) phiOnChain.push(l.recovery_phi.lookup(k));
  const sRec = reconstruct(phiOnChain, [shares[0], shares[2]], t);
  assert(
    eqBytes(pureCircuits.derive_recovery_commitment(fieldToBytes(sRec)), l.recovery),
    'reconstructed secret matches the stored commitment',
  );
  const vk = openWrap(fieldToBytes(sRec), account.addressBytes, l.recovery_wrap);
  assert(vk !== null && eqBytes(vk, encKeys.secretKey), 'the on-chain wrap restores the encryption secret (REC-7)');

  step('submission records the pending recovery');
  const successor = JubjubDevice.generate();
  const successorSecret = newRecoverySecret();
  const successorCommitment = pureCircuits.derive_recovery_commitment(successorSecret.bytes);
  const nowUpper = BigInt(Math.floor(Date.now() / 1000) + 60);
  const submitTx = await account.recoverSubmit(fieldToBytes(sRec), successor, successorCommitment, nowUpper);
  details.submitTx = submitTx.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'pending recovery on-chain',
    (led) => led.pending_recovery === true,
  );
  const epochBefore = (await account.ledgerState()).device_epoch;

  step('the window holds: early finalisation aborts');
  await expectAbort('finalising inside the veto window', () => account.recoverFinalise());

  step('cancel: immediate, epoch unchanged, pending cleared');
  const cancelTx = await account.recoverCancel(device);
  details.cancelTx = cancelTx.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'pending record cleared',
    (led) => led.pending_recovery === false && led.device_epoch === epochBefore,
  );

  step('resubmission after the cancel, then finalisation after the window');
  const nowUpper2 = BigInt(Math.floor(Date.now() / 1000) + 60);
  const submit2 = await account.recoverSubmit(fieldToBytes(sRec), successor, successorCommitment, nowUpper2);
  details.resubmitTx = submit2.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'second pending recovery on-chain',
    (led) => led.pending_recovery === true,
  );
  const waitSeconds = Number(WINDOW_SECONDS) + 75; // window + submission headroom + timestamp tolerance
  console.log(`  waiting ${waitSeconds}s for the veto window to elapse...`);
  await sleep(waitSeconds * 1000);
  const finaliseTx = await account.recoverFinalise();
  details.finaliseTx = finaliseTx.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'recovery finalised',
    (led) =>
      led.device_epoch === epochBefore + 1n &&
      led.device_count === 1n &&
      led.pending_recovery === false &&
      led.recovery_phi_len === 0n &&
      eqBytes(led.recovery, successorCommitment),
  );

  step('the successor controls the account; the old device is dead (REC-8, AUTH-6)');
  account.registerDevice(successor.pk);
  await expectAbort('old device authorising after the epoch bump', () =>
    account.addDevice(device, JubjubDevice.generate()));
  const s3 = newRecoverySecret();
  const sid3 = newSessionNonce();
  const shares3: IndexedShare[] = guardians.map((g, i) => ({
    index: i + 1,
    sigma: deriveShare(sid3, account.addressBytes, g),
  }));
  const reSession = await account.publishRecoverySession(successor, {
    commitment: pureCircuits.derive_recovery_commitment(s3.bytes),
    sessionNonce: sid3,
    phi: split(s3.field, shares3, t),
    wrap: sealWrap(s3.bytes, account.addressBytes, encKeys.secretKey),
  });
  details.postRecoverySessionTx = reSession.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'post-recovery session published by the successor',
    (led) => led.recovery_phi_len === 2n && eqBytes(led.recovery_session, sid3),
  );

  writeEvidence({
    testId: 'rec-1-9',
    name: 'recovery-conformance',
    description:
      'Recovery MIP on-node conformance: session publish through the seam, ' +
      'freshness backstop, reconstruction and wrap round-trip, two-phase ' +
      'gate with veto window and cancel, epoch bump, successor control.',
    verdict: 'PASS',
    txHash: String(details.finaliseTx ?? ''),
    note:
      'Deployed with birth artefacts and a 60 s veto window; the full ' +
      'lifecycle including a real window wait ran against the localnet.',
    details,
  });
});
