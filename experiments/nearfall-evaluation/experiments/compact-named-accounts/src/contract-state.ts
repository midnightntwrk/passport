import * as fs from 'node:fs';

import { getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { CONFIG, SingleNamed } from './utils.js';

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        Contract State — Midnight Preprod                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!fs.existsSync('deployment.json')) {
    console.error('No deployment.json found. Run the deploy script first.');
    process.exit(1);
  }
  const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));
  console.log(`Contract: ${contractAddress}`);
  console.log('');

  console.log('─── Public State ───────────────────────────────────────────────');
  console.log('');

  const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
  const { contractState } = await getPublicStates(publicDataProvider, contractAddress);

  const ls = SingleNamed.ledger(contractState.data);

  console.log(`name           : ${ls.name ?? '(empty)'}`);
  console.log(`k_scan         : (0x${ls.k_scan.x.toString(16)}, 0x${ls.k_scan.y.toString(16)})`);
  console.log(`k_spend        : (0x${ls.k_spend.x.toString(16)}, 0x${ls.k_spend.y.toString(16)})`);
  console.log('');
  if (ls.pending_amount !== undefined) {
    console.log(`pending_amount : ${ls.pending_amount} tDUST`);
    if (ls.pending_R) {
      console.log(`pending_R      : (0x${ls.pending_R.x.toString(16)}, 0x${ls.pending_R.y.toString(16)})`);
    }
    if (ls.pending_P) {
      console.log(`pending_P      : (0x${ls.pending_P.x.toString(16)}, 0x${ls.pending_P.y.toString(16)})`);
    }
    console.log('');
  }
  if (ls.shielded_R) {
    console.log(`shielded_R     : (0x${ls.shielded_R.x.toString(16)}, 0x${ls.shielded_R.y.toString(16)})`);
    console.log('');
  }
}

main().catch(console.error);
