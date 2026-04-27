// Deploy a custody contract instance.
//
// Usage:
//   npm run deploy                      # primary instance → deployment.json
//   npm run deploy-second               # secondary instance → deployment-second.json
//   CUSTODY_DEPLOY_SLOT=secondary tsx src/deploy.ts
//
// The secondary slot is required by U2 (contract → contract sendUnshielded).
// All other tests use the primary slot.

import { setupContract } from './test-helpers.js';

async function main() {
  const slot = (process.env.CUSTODY_DEPLOY_SLOT ?? 'primary') as 'primary' | 'secondary';

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║   Deploy custody contract — slot: ${slot.padEnd(28)} ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const { walletCtx, contract } = await setupContract({ slot, reuseDeployment: false });
  console.log(`\nDeployed @ ${contract.address}`);
  await walletCtx.wallet.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
