import * as fs from 'node:fs';

import { getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { CONFIG, SchnorrWallet } from './utils.js';

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      Schnorr Wallet — Contract State                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!fs.existsSync('deployment.json')) {
    console.error('No deployment.json found. Run: npm run deploy');
    process.exit(1);
  }

  const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));
  console.log(`Contract: ${contractAddress}`);
  console.log('');

  const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);

  const pubStates = await getPublicStates(publicDataProvider, contractAddress);
  const pub = SchnorrWallet.ledger(pubStates.contractState.data);

  console.log('─── Public State ───────────────────────────────────────────────');
  console.log('');
  console.log(`registered : ${pub.registered}`);

  if (pub.registered) {
    console.log(`owner_pk   : (${pub.owner_pk.x}, ${pub.owner_pk.y})`);
  } else {
    console.log(`owner_pk   : (not set)`);
  }

  console.log(`tx_count   : ${pub.tx_count}`);
  console.log('');

  process.exit(0);
}

main().catch(console.error);
