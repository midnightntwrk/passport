import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { CONFIG, FT } from './utils.js';

const rl = createInterface({ input: stdin, output: stdout });

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        Contract State — Midnight Preprod                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    const contractAddress = (await rl.question('Enter contract address: ')).trim();
    console.log('');

    console.log('─── Public State ───────────────────────────────────────────────');
    console.log('');

    const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
    const { contractState } = await getPublicStates(publicDataProvider, contractAddress);

    // contractState.data is the ChargedState that ledger() expects
    const ls = FT.ledger(contractState.data);

    console.log(`total_supply : ${ls.total_supply}`);
    console.log(`mint_nonce   : ${ls.mint_nonce}`);
    console.log('');
  } finally {
    rl.close();
  }
}

main().catch(console.error);
