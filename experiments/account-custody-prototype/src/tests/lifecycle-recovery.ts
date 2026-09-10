// Total-loss recovery lifecycle on localnet (C14 — BUSS / ANARKey):
//
//   deploy → deposit → enrol guardians: another passport (via the same
//   copy/paste request/reply strings the CLI demo uses) plus two paper
//   keys → publish φ + rotated commitment on-chain → TOTAL LOSS → the
//   guardian passport re-derives σ from its own key, the user types one
//   paper key back in → reconstruct the recovery secret off-chain from the
//   on-chain φ → recover with a fresh device → the lost device is locked
//   out, the old recovery secret is dead, and φ is cleared.
//
// Guardians store nothing between the two ceremonies: the guardian passport
// holds only its own device secret, and σ is recomputed on demand.

import { firstValueFrom } from 'rxjs';

import { runScenario, step, expectFailure, waitForLedger } from './runner.js';
import { setupWallet, deployAccount, connectAccount } from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { randomBytes32, hexToBytes32, bytesToHex } from '../wallet/hex.js';
import { recoveryCommitment } from '../wallet/contract.js';
import {
  newRecoverySecret,
  newSessionNonce,
  newPaperKey,
  guardianSkFromDeviceSecret,
  computeSigma,
  paperSigma,
  buildPhi,
  reconstructRecoverySecret,
  paramsFromPhi,
  phiBytesFromField,
  encodeGuardianRequest,
  decodeGuardianRequest,
  encodeGuardianReply,
  decodeGuardianReply,
  encodePaperKey,
  decodePaperKey,
  type GuardianReply,
} from '../wallet/buss.js';

await runScenario('lifecycle-recovery', async () => {
  const ctx = await setupWallet();
  const state: any = await firstValueFrom(ctx.walletCtx.wallet.state());
  const held = Object.entries(state.unshielded.balances as Record<string, bigint>);
  if (held.length === 0) throw new Error('funding wallet has no Night — genesis seed wrong?');
  const [colorHex] = held[0];
  const color = hexToBytes32(colorHex);
  const recipient = userAddressBytes(ctx.walletCtx);

  const lostDevice = randomBytes32();
  const initialRecoverySecret = newRecoverySecret();

  step('deploy account + deposit 500 Night');
  const account = await deployAccount(ctx, {
    deviceSecret: lostDevice,
    recoverySecret: initialRecoverySecret,
  });
  console.log(`  account @ ${account.address}`);
  await account.depositNight(color, 500n);
  await waitForLedger(account, 'deposit landed', (l) =>
    l.night_balances.member(color) && l.night_balances.lookup(color) === 500n,
  );

  // ── Backup ceremony: 1 guardian passport + 2 paper keys, any 2 recover ──
  // t=1, n=4 → threshold 2 of 3 guardians, φ length 2.

  step('enrol guardian: ANOTHER PASSPORT (copy/paste request → σ reply)');
  const rotatedSecret = newRecoverySecret();
  const sessionNonce = newSessionNonce();
  const nonceHex = bytesToHex(sessionNonce);

  // Owner side: produce the request string handed to the guardian.
  const requestString = encodeGuardianRequest({
    address: account.address,
    sessionNonce: nonceHex,
    index: 1,
  });
  console.log(`  owner → guardian   ${requestString}`);

  // Guardian passport side: its ONLY state is its own device secret. It
  // decodes the request and answers with σ — nothing is stored.
  const guardianDeviceSecret = randomBytes32(); // the other passport's device
  const guardianSk = guardianSkFromDeviceSecret(guardianDeviceSecret);
  const replyString = encodeGuardianReply(
    computeSigma(decodeGuardianRequest(requestString), guardianSk),
  );
  console.log(`  guardian → owner   ${replyString}`);

  step('enrol guardians: TWO PAPER KEYS (write these down)');
  const paper2 = newPaperKey(2);
  const paper3 = newPaperKey(3);
  const paperSlip2 = encodePaperKey(paper2);
  const paperSlip3 = encodePaperKey(paper3);
  console.log(`  paper slip #2      ${paperSlip2}`);
  console.log(`  paper slip #3      ${paperSlip3}`);

  step('publish the BUSS backup on-chain (φ + rotated commitment + session)');
  const replies: GuardianReply[] = [
    decodeGuardianReply(replyString),
    paperSigma(paper2, account.address, nonceHex),
    paperSigma(paper3, account.address, nonceHex),
  ];
  const phi = buildPhi(rotatedSecret, replies, { t: 1, n: 4 });
  await account.publishRecoveryBackup(rotatedSecret, sessionNonce, phi);
  await waitForLedger(account, 'φ published (len 2)', (l) => l.recovery_phi_len === 2n);

  // ── Total loss ────────────────────────────────────────────────────────────

  step('TOTAL LOSS — rebuild everything from public state + a t+1 quorum');
  const l = await account.ledgerState();
  const phiFromChain = [
    phiBytesFromField(l.recovery_phi.lookup(1n)),
    phiBytesFromField(l.recovery_phi.lookup(2n)),
  ];
  const sessionFromChain = bytesToHex(l.recovery_session);

  // Quorum member 1: the guardian passport, asked again with a request
  // rebuilt purely from on-chain state. It recomputes the SAME σ from its
  // own key — the guardian stored nothing in between.
  const recoveryRequest = encodeGuardianRequest({
    address: account.address,
    sessionNonce: sessionFromChain,
    index: 1,
  });
  const recoveryReply = decodeGuardianReply(
    encodeGuardianReply(computeSigma(decodeGuardianRequest(recoveryRequest), guardianSk)),
  );

  // Quorum member 2: the user types paper slip #3 back in.
  const typedPaper = decodePaperKey(paperSlip3);
  const quorum: GuardianReply[] = [
    recoveryReply,
    paperSigma(typedPaper, account.address, sessionFromChain),
  ];

  const reconstructed = reconstructRecoverySecret(
    phiFromChain,
    quorum,
    paramsFromPhi(phiFromChain.length, 3),
  );
  if (recoveryCommitment(reconstructed) !== l.recovery) {
    throw new Error('reconstructed secret does not match the on-chain recovery commitment');
  }
  console.log(`  ✓ reconstructed secret matches commitment (${bytesToHex(reconstructed).slice(0, 12)}…)`);

  step('recover with a fresh device + rotated recovery secret');
  const freshDevice = randomBytes32();
  const newRecovery = newRecoverySecret();
  const recoverer = await connectAccount(ctx, account.address, {
    recoverySecret: reconstructed,
  });
  await recoverer.recover(freshDevice, newRecovery);
  await waitForLedger(account, 'device_epoch = 1, φ cleared', (l2) =>
    l2.device_epoch === 1n && l2.recovery_phi_len === 0n,
  );

  step('fresh device controls the recovered account (assets followed, I-5.3)');
  const recovered = await connectAccount(ctx, account.address, { deviceSecret: freshDevice });
  await recovered.withdrawNight(color, 100n, recipient);
  await waitForLedger(account, 'night_balances = 400', (l2) =>
    l2.night_balances.lookup(color) === 400n,
  );

  step('the lost device is locked out');
  const lost = await connectAccount(ctx, account.address, { deviceSecret: lostDevice });
  await expectFailure(
    'lost-device withdraw',
    lost.withdrawNight(color, 10n, recipient),
    /device of revoked epoch/,
  );

  step('old recovery secret no longer recovers');
  const replayRecoverer = await connectAccount(ctx, account.address, {
    recoverySecret: reconstructed,
  });
  await expectFailure(
    'stale recovery',
    replayRecoverer.recover(randomBytes32(), newRecoverySecret()),
    /invalid recovery secret/,
  );

  await ctx.walletCtx.wallet.stop();
});
