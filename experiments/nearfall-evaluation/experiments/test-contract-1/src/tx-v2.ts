import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as rx from 'rxjs';
import * as bip39 from 'bip39';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { CombinedTokenTransfer } from '@midnight-ntwrk/wallet-sdk-facade';
import { createWallet } from './utils.js';


const shieldedTokenRaw = ledger.shieldedToken().raw;
const unshieldedTokenRaw = ledger.unshieldedToken().raw;

const rl = createInterface({ input: stdin, output: stdout });

const mn = await rl.question('\n  Enter your mnemonic: ');
const seed = await bip39.mnemonicToSeed(mn).then((x) => x.toString('hex'));
console.log(`Seed: ${seed}`);
  
let sender = await createWallet(seed);

await rx.firstValueFrom(
  sender.wallet.state().pipe(
    rx.throttleTime(5_000),
    rx.tap((state) => {
      const applyGap = state.unshielded.progress.highestTransactionId - state.unshielded.progress.appliedId;
      console.log(`Wallet facade behind by ${applyGap}`);
    }),
    rx.filter((state) => state.isSynced === true),
  ),
);
const senderInitialState = await rx.firstValueFrom(sender.wallet.state());

const initialShieldedBalance = senderInitialState.shielded.balances[shieldedTokenRaw] ?? 0n;
console.log(`Shielded balance: ${initialShieldedBalance}`);

const initialUnshieldedBalance = senderInitialState.unshielded.balances[unshieldedTokenRaw] ?? 0n;
console.log(`Unshielded balance: ${initialUnshieldedBalance}`);

const initialDustBalance = senderInitialState.dust.walletBalance(new Date());
console.log(`Dust balance: ${initialDustBalance}`);

try {

  const outputsToCreate: CombinedTokenTransfer[] = [
    {
      type: 'unshielded',
      outputs: [
        {
          type: unshieldedTokenRaw,
          amount: initialUnshieldedBalance / 8n,
          receiverAddress: 'mn_addr_preprod1tqcl5yytaawn4chdwaqp35synp3w2xpclcv9r4uvst4rlg2kul5qft769v',
        },
      ],
    },
  ];

  console.log('Building tx . . .')
  const txRecipe = await sender.wallet.transferTransaction(
    outputsToCreate,
    {
      shieldedSecretKeys: sender.shieldedSecretKeys,
      dustSecretKey: sender.dustSecretKey,
    },
    {
      ttl: new Date(Date.now() + 30 * 60 * 1000),
    },
  );
  console.log(txRecipe);

  console.log('Signing tx . . .');
  const signedTxRecipe = await sender.wallet.signRecipe(txRecipe, (payload) =>
    sender.unshieldedKeystore.signData(payload),
  );
  console.log(signedTxRecipe);

  console.log('Finalizing tx . . .');
  const finalizedTx = await sender.wallet.finalizeRecipe(signedTxRecipe);
  console.log(finalizedTx.toString());

  console.log('Submitting transaction...');
  const txId = await sender.wallet.submitTransaction(finalizedTx);
  console.log('txProcessing');
  console.log('Transaction id: ' + txId);


} catch (error: any) {
  console.error(`❌ Error during transaction construction/submission: ${error}`);
}

rl.close();
process.exit(0);
