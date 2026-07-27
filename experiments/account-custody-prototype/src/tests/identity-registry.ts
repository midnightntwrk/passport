// Night ID lifecycle on localnet:
// deploy a shared registry → bind a handle to a Passport custody account →
// prove the same handle cannot be claimed again.

import { runScenario, step, expectFailure } from './runner.js';
import { setupWallet, deployAccount, deployIdentityRegistry } from '../node/setup.js';
import { randomBytes32 } from '../wallet/hex.js';

await runScenario('identity-registry', async () => {
  const ctx = await setupWallet();

  step('deploy two Passport custody accounts and the shared identity registry');
  const firstAccount = await deployAccount(ctx, {
    deviceSecret: randomBytes32(),
    recoverySecret: randomBytes32(),
  });
  const secondAccount = await deployAccount(ctx, {
    deviceSecret: randomBytes32(),
    recoverySecret: randomBytes32(),
  });
  const registry = await deployIdentityRegistry(ctx.walletCtx);
  console.log(`  registry @ ${registry.address}`);

  step('register alice.night to the first custody account');
  const registration = await registry.register('alice', firstAccount.address);
  console.log(`  tx ${registration.txId}`);
  const resolved = await registry.accountFor('alice');
  if (resolved !== firstAccount.address.toLowerCase()) {
    throw new Error(`alice resolved to ${resolved}, expected ${firstAccount.address}`);
  }
  console.log(`  ✓ alice.night -> ${resolved}`);

  step('reject a duplicate claim for alice.night');
  await expectFailure(
    'duplicate Night ID claim',
    registry.register('alice', secondAccount.address),
    /Night ID already registered/,
  );

  await ctx.walletCtx.wallet.stop();
});
