import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as rx from 'rxjs';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { createWallet, createProviders, FT, zkConfigPath } from './utils.js';
import { hexToBytes32, readMnemonic, mnemonicToHexSeed, syncWallet, printBalances } from './common.js';

const rl = createInterface({ input: stdin, output: stdout });

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Shielded Mint and Transfer — Midnight Preprod              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    const mn = await readMnemonic(rl, 'Enter Wallet mnemonic: ');
    const contractAddress = (await rl.question('Enter deployed Contract Address: ')).trim();
    const receiverShieldedAddress = 'mn_shield-addr_preprod1rdd5j3hzkhp4pje75uv2esft6qzg06fznqsyp0t0xc366a37zysncslsd64smun2rvvgryn04wwzuel08w7rqt2lc2h2u3w80yvv6ycm3tae3';
    console.log('');

    console.log('─── Wallet Setup ───────────────────────────────────────────────');
    console.log('');

    console.log('Initializing Wallet...');
    const sender = await createWallet(await mnemonicToHexSeed(mn));
    await syncWallet(sender, 'Wallet');
    console.log('');

    const initialState = await rx.firstValueFrom(sender.wallet.state());
    printBalances(initialState);

    const providers = await createProviders(sender);

    console.log('─── Mint ───────────────────────────────────────────────────────');
    console.log('');

    console.log(`Connecting to contract at ${contractAddress}...`);
    console.log('');

    const contractWithWitnesses = CompiledContract.make('fungible-token', FT.Contract).pipe(
      CompiledContract.withWitnesses({
        get_user_shielded_address: (context: any) => {
          return [context.privateState, { bytes: hexToBytes32(providers.walletProvider.getCoinPublicKey()) }];
        },
      }),
      CompiledContract.withCompiledFileAssets(zkConfigPath),
    );

    const contract = await findDeployedContract(providers, {
      contractAddress,
      compiledContract: contractWithWitnesses,
      privateStateId: 'fungibleTokenState',
      initialPrivateState: {},
    });

    console.log('Generating local ZK proof and submitting mint transaction...');
    console.log('');
    const amountToMint = 1000n;
    const mintTx = await contract.callTx.mint(amountToMint, hexToBytes32(contractAddress));

    // The wallet-visible token key (RawTokenType) is available directly on the
    // result — no need to compare before/after balances or compute a hash.
    const customTokenId = mintTx.private.newCoins[0].type;
    console.log('✅ Mint transaction successful!');
    console.log(`Hash:     ${mintTx.public.txHash}`);
    console.log(`Token ID: ${customTokenId}`);
    console.log('');

    console.log('Waiting for wallet to detect newly minted custom tokens...');
    await rx.firstValueFrom(
      sender.wallet.state().pipe(
        rx.throttleTime(3_000),
        rx.tap((state) => {
          const balance = state.shielded.balances[customTokenId] ?? 0n;
          process.stdout.write(`\rCurrent Custom Token Balance: ${balance}`);
        }),
        rx.filter((state) => (state.shielded.balances[customTokenId] ?? 0n) >= amountToMint),
        rx.timeout({
          first: 5 * 60 * 1000,
          with: () => rx.throwError(() => new Error('Timed out waiting for minted tokens to appear in wallet')),
        }),
      ),
    );
    console.log('');
    console.log('✅ New tokens detected in Wallet!');
    console.log('');

    console.log('─── Transfer ───────────────────────────────────────────────────');
    console.log('');

    console.log(`Destination: ${receiverShieldedAddress}`);
    console.log('');

    console.log('Building transfer transaction...');
    const txRecipe = await sender.wallet.transferTransaction(
      [
        {
          type: 'shielded',
          outputs: [
            {
              type: customTokenId,
              amount: 300n,
              receiverAddress: receiverShieldedAddress,
            },
          ],
        },
      ],
      {
        shieldedSecretKeys: sender.shieldedSecretKeys,
        dustSecretKey: sender.dustSecretKey,
      },
      {
        ttl: new Date(Date.now() + 30 * 60 * 1000),
      },
    );

    console.log('Signing transfer transaction...');
    const signedTxRecipe = await sender.wallet.signRecipe(txRecipe, (payload) =>
      sender.unshieldedKeystore.signData(payload),
    );

    console.log('Finalizing transfer transaction...');
    const finalizedTx = await sender.wallet.finalizeRecipe(signedTxRecipe);

    console.log('Submitting transfer to network...');
    const txId = await sender.wallet.submitTransaction(finalizedTx);
    console.log('');
    console.log('✅ Transfer successful!');
    console.log(`Transaction ID: ${txId}`);
    console.log('');

    const expectedFinalBalance =
      (initialState.shielded.balances[customTokenId] ?? 0n) + amountToMint - 300n;
    console.log(`Waiting for wallet to settle (expected balance: ${expectedFinalBalance})...`);
    const finalBalance = await rx.firstValueFrom(
      sender.wallet.state().pipe(
        rx.throttleTime(3_000),
        rx.tap((state) => {
          const balance = state.shielded.balances[customTokenId] ?? 0n;
          process.stdout.write(`\rCurrent balance: ${balance}`);
        }),
        rx.map((state) => state.shielded.balances[customTokenId] ?? 0n),
        rx.filter((balance) => balance === expectedFinalBalance),
        rx.timeout({
          first: 5 * 60 * 1000,
          with: () => rx.throwError(() => new Error('Timed out waiting for transfer to settle')),
        }),
      ),
    );
    console.log('');
    console.log(`Final Wallet Custom Token Balance: ${finalBalance}`);
    console.log('');

  } catch (error: any) {
    console.error('');
    console.error('❌ Error during execution:', error);
  } finally {
    rl.close();
    process.exit(0);
  }
}

main().catch(console.error);
