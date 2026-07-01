// Total-loss recovery lifecycle on localnet (C14):
//   deploy → deposit → reconstruct the recovery secret from two of the
//   three ON-CHAIN shares (TODO(PVSS): plaintext shares, prototype only) →
//   recover with a fresh device → fresh device controls the assets →
//   the lost device is locked out by the epoch bump.

import { firstValueFrom } from 'rxjs';

import { runScenario, step, expectFailure, waitForLedger } from './runner.js';
import { setupWallet, deployAccount, connectAccount } from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { randomBytes32, hexToBytes32, bytesToHex } from '../wallet/hex.js';
import { recoveryCommitment } from '../wallet/contract.js';
import { reconstruct } from '../wallet/shamir.js';

await runScenario('lifecycle-recovery', async () => {
  const ctx = await setupWallet();
  const state: any = await firstValueFrom(ctx.walletCtx.wallet.state());
  const held = Object.entries(state.unshielded.balances as Record<string, bigint>);
  if (held.length === 0) throw new Error('funding wallet has no Night — genesis seed wrong?');
  const [colorHex] = held[0];
  const color = hexToBytes32(colorHex);
  const recipient = userAddressBytes(ctx.walletCtx);

  const lostDevice = randomBytes32();
  const recoverySecret = randomBytes32();

  step('deploy account + deposit 500 Night');
  const account = await deployAccount(ctx, { deviceSecret: lostDevice, recoverySecret });
  console.log(`  account @ ${account.address}`);
  await account.depositNight(color, 500n);
  await waitForLedger(account, 'deposit landed', (l) =>
    l.night_balances.member(color) && l.night_balances.lookup(color) === 500n,
  );

  step('TOTAL LOSS — reconstruct the recovery secret from on-chain shares 1 + 3');
  const l = await account.ledgerState();
  const reconstructed = reconstruct([
    { index: 1, value: l.recovery_shares.lookup(1n) },
    { index: 3, value: l.recovery_shares.lookup(3n) },
  ]);
  if (recoveryCommitment(reconstructed) !== l.recovery) {
    throw new Error('reconstructed secret does not match the on-chain recovery commitment');
  }
  console.log(`  ✓ reconstructed secret matches commitment (${bytesToHex(reconstructed).slice(0, 12)}…)`);

  step('recover with a fresh device + rotated recovery secret');
  const freshDevice = randomBytes32();
  const newRecoverySecret = randomBytes32();
  const recoverer = await connectAccount(ctx, account.address, {
    recoverySecret: reconstructed,
  });
  await recoverer.recover(freshDevice, newRecoverySecret);
  await waitForLedger(account, 'device_epoch = 1', (l2) => l2.device_epoch === 1n);

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
    replayRecoverer.recover(randomBytes32(), randomBytes32()),
    /invalid recovery secret/,
  );

  await ctx.walletCtx.wallet.stop();
});
