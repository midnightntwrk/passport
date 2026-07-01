// Scoped-grant lifecycle on localnet (C10/C11):
//   issue grant (colour + cap) → grant-only client withdraws within cap →
//   cumulative cap enforcement → revocation enforcement.

import { firstValueFrom } from 'rxjs';

import { runScenario, step, expectFailure, waitForLedger } from './runner.js';
import { setupWallet, deployAccount, connectAccount } from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { randomBytes32, hexToBytes32 } from '../wallet/hex.js';
import { grantCommitment } from '../wallet/contract.js';

await runScenario('lifecycle-grants', async () => {
  const ctx = await setupWallet();
  const state: any = await firstValueFrom(ctx.walletCtx.wallet.state());
  const held = Object.entries(state.unshielded.balances as Record<string, bigint>);
  if (held.length === 0) throw new Error('funding wallet has no Night — genesis seed wrong?');
  const [colorHex] = held[0];
  const color = hexToBytes32(colorHex);
  const recipient = userAddressBytes(ctx.walletCtx);

  const device = randomBytes32();
  const recovery = randomBytes32();
  const grantSecret = randomBytes32();
  const gc = grantCommitment(grantSecret);

  step('deploy account + deposit 1000 Night');
  const account = await deployAccount(ctx, { deviceSecret: device, recoverySecret: recovery });
  console.log(`  account @ ${account.address}`);
  await account.depositNight(color, 1000n);
  await waitForLedger(account, 'deposit landed', (l) =>
    l.night_balances.member(color) && l.night_balances.lookup(color) === 1000n,
  );

  step('issue grant: colour-scoped, cap 300');
  await account.addGrant(grantSecret, color, 300n);
  await waitForLedger(account, 'grant active', (l) => l.grants.member(gc) && l.grants.lookup(gc).active);

  step('grant-only client withdraws 100 (within cap)');
  const dapp = await connectAccount(ctx, account.address, { grantSecret });
  await dapp.grantWithdrawNight(color, 100n, recipient);
  await waitForLedger(account, 'spent = 100', (l) => l.grants.lookup(gc).spent === 100n);

  step('cumulative cap: withdrawing 250 more must fail (100 + 250 > 300)');
  await expectFailure(
    'over-cap grant withdraw',
    dapp.grantWithdrawNight(color, 250n, recipient),
    /grant cap exceeded/,
  );

  step('grant cannot manage devices or grants');
  await expectFailure(
    'grant adding a grant',
    dapp.addGrant(randomBytes32(), color, 50n),
    /device_secret requested/,
  );

  step('revoke grant (device-authorised), further spends must fail');
  await account.revokeGrantByCommitment(gc);
  await waitForLedger(account, 'grant revoked', (l) => !l.grants.lookup(gc).active);
  await expectFailure(
    'revoked grant withdraw',
    dapp.grantWithdrawNight(color, 10n, recipient),
    /grant revoked/,
  );

  const final = await account.ledgerState();
  console.log(`  final: balance ${final.night_balances.lookup(color)}, spent ${final.grants.lookup(gc).spent}`);
  await ctx.walletCtx.wallet.stop();
});
