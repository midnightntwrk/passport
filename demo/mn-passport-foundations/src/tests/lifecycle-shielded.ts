// Shielded custody lifecycle on localnet (C4 — S4/S6-proven OZ pattern):
//   faucet mints a shielded note to the user → user deposits it into the
//   account contract → partial withdrawal (exercises the change path:
//   sendShielded + sendImmediateShielded + insertCoin of the change).

import { firstValueFrom } from 'rxjs';
import { rawTokenType, encodeRawTokenType } from '@midnight-ntwrk/ledger-v8';

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { setupWallet, deployAccount, deployFaucet } from '../node/setup.js';
import { coinPublicKeyBytes } from '../node/wallet.js';
import { randomBytes32, hexToBytes32, bytesToHex } from '../wallet/hex.js';

await runScenario('lifecycle-shielded', async () => {
  const ctx = await setupWallet();
  const state: any = await firstValueFrom(ctx.walletCtx.wallet.state());
  const userCpk = coinPublicKeyBytes(state);

  const domesticColor = hexToBytes32('06');
  const amount = 500n;
  const mintNonce = randomBytes32();

  step('deploy faucet and mint 500 shielded to the user');
  const faucet = await deployFaucet(ctx.walletCtx);
  console.log(`  faucet @ ${faucet.address}`);
  const mintTx = await faucet.mint(domesticColor, amount, mintNonce, userCpk);
  console.log(`  mintTx = ${mintTx}`);

  // On-chain colour: rawTokenType(domesticColor, faucetAddress) — the token
  // type is bound to the minting contract.
  const derivedRawHex = rawTokenType(domesticColor, faucet.address);
  const color = encodeRawTokenType(derivedRawHex);
  console.log(`  on-chain colour 0x${bytesToHex(color)}`);

  console.log('  waiting 15s for the wallet to index the minted note...');
  await sleep(15_000);

  step('deploy account and deposit the shielded note');
  const account = await deployAccount(ctx, {
    deviceSecret: randomBytes32(),
    recoverySecret: randomBytes32(),
  });
  console.log(`  account @ ${account.address}`);
  await account.depositShielded({ nonce: mintNonce, color, value: amount });
  await waitForLedger(account, 'contract holds the coin (value 500)', (l) =>
    l.coins.member(color) && l.coins.lookup(color).value === 500n,
  );

  step('withdraw 200 shielded back to the user (change path)');
  await account.withdrawShielded(userCpk, color, 200n);
  await waitForLedger(account, 'change re-registered (value 300)', (l) =>
    l.coins.member(color) && l.coins.lookup(color).value === 300n,
  );

  const final = await account.ledgerState();
  console.log(`  final contract-held shielded value: ${final.coins.lookup(color).value}`);
  await ctx.walletCtx.wallet.stop();
});
