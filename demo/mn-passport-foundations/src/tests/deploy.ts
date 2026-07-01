// Deploy shared demo contracts and save their addresses.
// The demo app deploys account contracts itself at onboarding. The shared
// pieces are the shielded-token faucet and the identity registry.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupWallet, deployFaucet, deployIdentityRegistry } from '../node/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAUCET_FILE = path.resolve(__dirname, '..', '..', 'faucet-deployment.json');
const IDENTITY_REGISTRY_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  'identity-registry-deployment.json',
);

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

  console.log('Deploying identity registry...');
  const identityRegistry = await deployIdentityRegistry(ctx.walletCtx);
  fs.writeFileSync(
    IDENTITY_REGISTRY_FILE,
    JSON.stringify(
      { identityRegistryAddress: identityRegistry.address, deployedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(`Identity registry deployed @ ${identityRegistry.address}`);
  console.log(`Saved to ${IDENTITY_REGISTRY_FILE}`);

  await ctx.walletCtx.wallet.stop();
  setTimeout(() => process.exit(0), 100).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
