// Deploy the shared faucet for the demo app and save its address.
// The demo app deploys account contracts itself at onboarding; the faucet
// is the only piece of pre-deployed scaffolding it needs.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupWallet, deployFaucet } from '../node/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAUCET_FILE = path.resolve(__dirname, '..', '..', 'faucet-deployment.json');

async function main() {
  const ctx = await setupWallet();
  console.log('Deploying faucet...');
  const faucet = await deployFaucet(ctx.walletCtx);
  fs.writeFileSync(
    FAUCET_FILE,
    JSON.stringify({ faucetAddress: faucet.address, deployedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`Faucet deployed @ ${faucet.address}`);
  console.log(`Saved to ${FAUCET_FILE}`);
  await ctx.walletCtx.wallet.stop();
  setTimeout(() => process.exit(0), 100).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
