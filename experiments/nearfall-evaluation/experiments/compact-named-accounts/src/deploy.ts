import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { firstValueFrom } from 'rxjs';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { createWallet, createProviders, SingleNamed, zkConfigPath } from './utils.js';
import { readMnemonic, mnemonicToHexSeed, syncWallet, printBalances } from './common.js';


async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        Deploy Single Named Contract — Midnight Preprod       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!fs.existsSync(path.join(zkConfigPath, 'contract', 'index.js'))) {
    console.error('Contract not compiled! Run: npm run compile');
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log('─── Wallet Setup ───────────────────────────────────────────────');
    console.log('');

    const mn = await readMnemonic(rl, 'Enter your mnemonic: ');
    console.log('');
    console.log('Creating wallet...');
    const walletCtx = await createWallet(await mnemonicToHexSeed(mn));
    await syncWallet(walletCtx, 'wallet');
    console.log('');

    console.log(`Wallet Address: ${walletCtx.unshieldedKeystore.getBech32Address()}`);
    console.log('');

    printBalances(await firstValueFrom(walletCtx.wallet.state()));

    console.log('─── Deploy Contract ────────────────────────────────────────────');
    console.log('');

    const providers = await createProviders(walletCtx);

    const compiledContract = CompiledContract.make('single-named', SingleNamed.Contract).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(zkConfigPath),
    );

    console.log('Deploying contract (this may take 30-60 seconds)...');
    console.log('');
    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId: 'single-named-state',
      initialPrivateState: {},
    });

    const contractAddress = deployed.deployTxData.public.contractAddress;
    console.log('✅ Contract deployed successfully!');
    console.log('');
    console.log(`Contract Address: ${contractAddress}`);
    console.log('');

    const deploymentFile = 'deployment.json';
    fs.writeFileSync(
      deploymentFile,
      JSON.stringify({ contractAddress, network: 'preprod', deployedAt: new Date().toISOString() }, null, 2),
    );
    console.log(`Saved to ${deploymentFile}`);
    console.log('');

    await walletCtx.wallet.stop();

    console.log('─── Deployment Complete! ───────────────────────────────────────');
    console.log('');
  } finally {
    rl.close();
  }
}

main().catch(console.error);
