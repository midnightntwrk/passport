import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { createWallet, createProviders, SchnorrWallet, zkConfigPath } from './utils.js';
import { getWalletSeed, syncWallet, printBalances } from './common.js';
import { firstValueFrom } from 'rxjs';

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      Schnorr Wallet — Deposit Tokens                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!fs.existsSync('deployment.json')) {
    console.error('No deployment.json found. Run: npm run deploy');
    process.exit(1);
  }

  const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));
  console.log(`Contract: ${contractAddress}`);
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const seed = await getWalletSeed(rl);
    console.log('Creating wallet...');
    const walletCtx = await createWallet(seed);
    await syncWallet(walletCtx, 'wallet');
    console.log('');

    const state = await firstValueFrom(walletCtx.wallet.state());
    printBalances(state);

    const providers = await createProviders(walletCtx);

    const compiledContract = CompiledContract.make('schnorr-wallet', SchnorrWallet.Contract).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(zkConfigPath),
    );

    console.log('Connecting to deployed contract...');
    const found = await (findDeployedContract as any)(providers, {
      contractAddress,
      compiledContract,
      privateStateId: 'schnorr-wallet-state',
      initialPrivateState: {},
    });

    // Show unshielded balances and let user pick a token
    const unshieldedBalances = Object.entries(state.unshielded.balances as Record<string, bigint>);
    if (unshieldedBalances.length === 0) {
      console.error('No unshielded tokens available to deposit.');
      process.exit(1);
    }

    console.log('Your unshielded balances:');
    unshieldedBalances.forEach(([token, amount], i) => {
      console.log(`  [${i + 1}] ${token} : ${amount}`);
    });
    console.log('');

    let tokenIdx: number;
    let color: string;
    let available: bigint;
    let amount: bigint;

    if (process.env.AUTO_CONFIRM) {
      // Auto mode: first token, use DEPOSIT_AMOUNT or 1000
      tokenIdx = 0;
      [color, available] = unshieldedBalances[tokenIdx];
      amount = BigInt(process.env.DEPOSIT_AMOUNT ?? '1000');
      console.log(`AUTO_CONFIRM: depositing ${amount} of ${color}`);
    } else {
      tokenIdx = parseInt(await rl.question('Token number to deposit: '), 10) - 1;
      if (tokenIdx < 0 || tokenIdx >= unshieldedBalances.length) {
        console.error('Invalid selection.');
        process.exit(1);
      }
      [color, available] = unshieldedBalances[tokenIdx];

      const amountStr = await rl.question(`Amount to deposit (available: ${available}): `);
      amount = BigInt(amountStr);
      if (amount <= 0n || amount > available) {
        console.error('Invalid amount.');
        process.exit(1);
      }

      const confirm = await rl.question(`Deposit ${amount} of ${color} into the contract? [y/N] `);
      if (confirm.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    console.log('');
    console.log('Submitting deposit transaction (this may take 20-30 seconds)...');
    console.log('');

    const { hexToBytes32 } = await import('./common.js');
    const result = await found.callTx.deposit(hexToBytes32(color), amount);

    console.log(`Deposit successful!`);
    console.log(`   Transaction: ${result.public?.txId ?? '(pending)'}`);
    console.log(`   Block:       ${result.public?.blockHeight ?? '(pending)'}`);
    console.log('');

    await walletCtx.wallet.stop();
  } finally {
    rl.close();
  }
}

main().catch(console.error);
