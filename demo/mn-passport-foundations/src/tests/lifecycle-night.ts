// Night custody lifecycle on localnet:
//   deposit → withdraw (device A) → wrong-device rejection →
//   add device B → withdraw from device B (P3 multi-device).

import { firstValueFrom } from 'rxjs';

import { runScenario, step, expectFailure, waitForLedger } from './runner.js';
import { setupWallet, deployAccount, connectAccount } from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { randomBytes32, hexToBytes32 } from '../wallet/hex.js';
import { deviceCommitment } from '../wallet/contract.js';

await runScenario('lifecycle-night', async () => {
  const ctx = await setupWallet();
  const state: any = await firstValueFrom(ctx.walletCtx.wallet.state());
  const held = Object.entries(state.unshielded.balances as Record<string, bigint>);
  if (held.length === 0) throw new Error('funding wallet has no Night — genesis seed wrong?');
  const [colorHex] = held[0];
  const color = hexToBytes32(colorHex);
  const recipient = userAddressBytes(ctx.walletCtx);

  const deviceA = randomBytes32();
  const recovery = randomBytes32();

  step('deploy account');
  const account = await deployAccount(ctx, { deviceSecret: deviceA, recoverySecret: recovery });
  console.log(`  account @ ${account.address}`);

  step('deposit 1000 Night');
  await account.depositNight(color, 1000n);
  await waitForLedger(account, 'night_balances = 1000', (l) =>
    l.night_balances.member(color) && l.night_balances.lookup(color) === 1000n,
  );

  step('withdraw 400 Night (device A)');
  await account.withdrawNight(color, 400n, recipient);
  await waitForLedger(account, 'night_balances = 600', (l) =>
    l.night_balances.lookup(color) === 600n,
  );

  step('withdraw with an unregistered device secret must fail');
  const rogue = await connectAccount(ctx, account.address, { deviceSecret: randomBytes32() });
  await expectFailure(
    'rogue withdraw',
    rogue.withdrawNight(color, 100n, recipient),
    /unknown device/,
  );

  step('add device B (authorised by device A)');
  const deviceB = randomBytes32();
  await account.addDevice(deviceB);
  await waitForLedger(account, 'device B registered', (l) =>
    l.devices.member(deviceCommitment(deviceB)) && l.device_count === 2n,
  );

  step('withdraw 100 Night from device B');
  const clientB = await connectAccount(ctx, account.address, { deviceSecret: deviceB });
  await clientB.withdrawNight(color, 100n, recipient);
  await waitForLedger(account, 'night_balances = 500', (l) =>
    l.night_balances.lookup(color) === 500n,
  );

  const final = await account.ledgerState();
  console.log(`  final round = ${final.round}, devices = ${final.device_count}`);
  await ctx.walletCtx.wallet.stop();
});
