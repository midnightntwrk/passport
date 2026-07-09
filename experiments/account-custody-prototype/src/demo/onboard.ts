// Demo step 0 — onboard: deploy a fresh Passport account and save the owner
// identity (contract address + device secret) for the other demo scripts.
//
//   npm run demo:onboard

import { setupWallet, deployAccount } from '../node/setup.js';
import { randomBytes32, bytesToHex } from '../wallet/hex.js';
import { newRecoverySecret } from '../wallet/buss.js';
import { loadEnv, saveOwnerIdentity, done } from './common.js';

loadEnv();

const ctx = await setupWallet();
const deviceSecret = randomBytes32();

console.log('Deploying a fresh Passport account (this proves a transaction — give it a minute)…');
const account = await deployAccount(ctx, {
  deviceSecret,
  recoverySecret: newRecoverySecret(),
});

saveOwnerIdentity({ address: account.address, deviceSecretHex: bytesToHex(deviceSecret) });

console.log('');
console.log(`account:  ${account.address}`);
console.log('identity: owner-identity.json (device secret saved for the demo)');
console.log('');
console.log('Next: npm run demo:backup — enrol guardians and publish the BUSS backup.');

await ctx.walletCtx.wallet.stop();
done();
