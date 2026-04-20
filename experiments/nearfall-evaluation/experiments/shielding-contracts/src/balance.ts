import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as rx from 'rxjs';

import { createWallet } from './utils.js';
import { readMnemonic, mnemonicToHexSeed, syncWallet, printBalances } from './common.js';

const rl = createInterface({ input: stdin, output: stdout });

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        Wallet Balance — Midnight Preprod                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    const mn = await readMnemonic(rl, 'Enter wallet mnemonic: ');
    console.log('');

    console.log('─── Wallet Setup ───────────────────────────────────────────────');
    console.log('');

    console.log('Initializing wallet...');
    const walletCtx = await createWallet(await mnemonicToHexSeed(mn));
    await syncWallet(walletCtx, 'wallet');
    console.log('');

    printBalances(await rx.firstValueFrom(walletCtx.wallet.state()));

    await walletCtx.wallet.stop();
  } finally {
    rl.close();
  }
}

main().catch(console.error);
