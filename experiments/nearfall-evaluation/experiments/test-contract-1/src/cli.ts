import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as Rx from 'rxjs';

// Midnight SDK imports
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

// Shared utilities from the utils.ts file
import { 
  createWallet, 
  createProviders, 
  compiledContract, 
  HelloWorld 
} from './utils.js';

// ─── Main CLI Script ───────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           Hello World Contract CLI (Preprod)            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Check for deployment.json
  if (!fs.existsSync('deployment.json')) {
    console.error('No deployment.json found! Run `npm run deploy` first.\n');
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));
  console.log(`  Contract: ${deployment.contractAddress}\n`);

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // Get wallet seed
    const seed = await rl.question('  Enter your wallet seed: ');

    console.log('\n  Connecting to Midnight Preprod...');
    const walletCtx = await createWallet(seed.trim());

    console.log('  Syncing wallet...');
    await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(
        Rx.throttleTime(5000), 
        Rx.filter((s) => s.isSynced)
      )
    );

    console.log('  Setting up providers...');
    const providers = await createProviders(walletCtx);

    console.log('  Joining contract...');
    const contract = await findDeployedContract(providers, {
      contractAddress: deployment.contractAddress,
      compiledContract,
      privateStateId: 'helloWorldState',
      initialPrivateState: {},
    });

    console.log('  Connected!\n');

    // Main menu loop
    let running = true;
    while (running) {
      const dust = (
        await Rx.firstValueFrom(
          walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced))
        )
      ).dust.walletBalance(new Date());

      console.log('─────────────────────────────────────────────────────────────────');
      console.log(`  DUST: ${dust.toLocaleString()}`);
      console.log('─────────────────────────────────────────────────────────────────');
      const choice = await rl.question(
        '  [1] Store a message\n  [2] Read current message\n  [3] Exit\n  > '
      );

      switch (choice.trim()) {
        case '1':
          try {
            const message = await rl.question('\n  Enter message: ');
            console.log('  Storing message (this may take 20-30 seconds)...\n');
            const tx = await contract.callTx.storeMessage(message);
            console.log(`  ✅ Message stored!`);
            console.log(`  Transaction: ${tx.public.txId}`);
            console.log(`  Block: ${tx.public.blockHeight}\n`);
          } catch (e) {
            console.error(
              `  ❌ Error: ${e instanceof Error ? e.message : e}\n`
            );
          }
          break;

        case '2':
          try {
            console.log('\n  Reading message from blockchain...');
            const state = await providers.publicDataProvider.queryContractState(
              deployment.contractAddress
            );
            if (state) {
              const ledgerState = HelloWorld.ledger(state.data);
              console.log(
                `  Current message: "${ledgerState.message || '(empty)'}"\n`
              );
            } else {
              console.log('  No message found.\n');
            }
          } catch (e) {
            console.error(
              `  ❌ Error: ${e instanceof Error ? e.message : e}\n`
            );
          }
          break;

        case '3':
          running = false;
          break;
      }
    }

    await walletCtx.wallet.stop();
    console.log('\n  Goodbye!\n');
  } finally {
    rl.close();
  }
}

main().catch(console.error);
