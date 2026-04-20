import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { FinalizedTransaction, unshieldedToken } from '@midnight-ntwrk/ledger-v7';
import * as Rx from 'rxjs';

import { 
  createWallet, 
  createProviders,
  signTransactionIntents
} from './utils.js';
import { UnprovenTransactionRecipe, WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';

const rl = createInterface({ input: stdin, output: stdout });

const seed = await rl.question('\n  Enter your 64-character seed: ');

console.log('  Creating wallet...');
const walletCtx = await createWallet(seed);
const wallet: WalletFacade = walletCtx.wallet;

console.log('  Syncing with network...');
await wallet.waitForSyncedState();

const dustState = await Rx.firstValueFrom(
  walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced))
);

const currentDustBalance = dustState.dust.walletBalance(new Date());
console.log(`  Initial DUST Balance: ${currentDustBalance.toLocaleString()}`);

if (currentDustBalance === 0n) {
  const nightUtxos = dustState.unshielded.availableCoins.filter(
    (c: any) => !c.meta?.registeredForDustGeneration
  );
  
  if (nightUtxos.length > 0) {
    console.log(`  Registering ${nightUtxos.length} NIGHT UTXOs for DUST generation...`);
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      nightUtxos,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload) => walletCtx.unshieldedKeystore.signData(payload),
    );
    await walletCtx.wallet.submitTransaction(
      await walletCtx.wallet.finalizeRecipe(recipe)
    );
  }

  console.log('  Waiting for DUST tokens to accumulate...');
  await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(
      Rx.throttleTime(5000),
      Rx.filter((s) => s.isSynced),
      Rx.filter((s) => s.dust.walletBalance(new Date()) > 0n)
    ),
  );
}

const updatedDustState = await Rx.firstValueFrom(
  walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced))
);
console.log(`  Final DUST Balance: ${updatedDustState.dust.walletBalance(new Date()).toLocaleString()}`);
console.log('  DUST tokens ready!');

const state = updatedDustState;
const providers = await createProviders(walletCtx);

const address = walletCtx.unshieldedKeystore.getBech32Address();
const tNightToken = unshieldedToken();
const balance = state.unshielded.balances[tNightToken.raw] ?? 0n;

console.log(`  Wallet Address: ${address}`);
console.log(`  tNIGHT Balance: ${balance.toLocaleString()}`);

if (balance === 0n) {
  console.error('❌ Error: Balance is 0. Please fund your wallet with tNIGHT from the faucet.');
  process.exit(1);
}

try {

  console.log('  Constructing transfer recipe...');
  const unprovenTxRecipe: UnprovenTransactionRecipe = await wallet.transferTransaction(
    [
      {
        type: 'unshielded',
        outputs: [
          {
            type: tNightToken.raw, 
            receiverAddress: 'mn_addr_preprod1u325ecjwg5aqnhg4lkqd7j9avn9mwwm4yl5w5fleet06za6dnamqry3hv3',
            amount: balance / 2n,
          }
        ]
      }
    ],
    {
      shieldedSecretKeys: walletCtx.shieldedSecretKeys,
      dustSecretKey: walletCtx.dustSecretKey,
    },
    {
      ttl: new Date(Date.now() + 10 * 60 * 1000),
    },
  );

  console.log('  Constructing finalized transaction...');
  const finalTx: FinalizedTransaction = await wallet.finalizeRecipe(unprovenTxRecipe);
  
  console.log('  Submitting to network...');
  const txId = await wallet.submitTransaction(finalTx);

  console.log(`\n  ✅ Success! Transaction ID: ${txId}`);

} catch (error: any) {
  console.error('\n❌ Error during transaction construction/submission:');
  console.error(error);
}

rl.close();
process.exit(0);