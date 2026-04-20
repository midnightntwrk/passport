import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import { firstValueFrom } from 'rxjs';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { createWallet, createProviders, SchnorrWallet, zkConfigPath } from './utils.js';
import { getWalletSeed, syncWallet, randomJubjubScalar, bigIntToHex } from './common.js';

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      Schnorr Wallet — Register Owner Key                     ║');
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

    const providers = await createProviders(walletCtx);

    const compiledContract = CompiledContract.make('schnorr-wallet', SchnorrWallet.Contract).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(zkConfigPath),
    );

    // Generate or load the owner's JubJub secret key
    const keyFile = 'wallet-key.json';
    let sk: bigint;

    if (fs.existsSync(keyFile)) {
      const data = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
      sk = BigInt(data.sk);
      console.log(`Loaded existing key from ${keyFile}`);
    } else {
      sk = randomJubjubScalar();
      fs.writeFileSync(keyFile, JSON.stringify({ sk: bigIntToHex(sk) }, null, 2));
      console.log(`Generated new JubJub key, saved to ${keyFile}`);
    }
    console.log('');

    // Compute the public key using the contract's own pure circuit
    // (ensures we use the same curve parameters as the ZK circuit)
    const pk = SchnorrWallet.pureCircuits.compute_nonce_point(sk);
    console.log(`Owner public key:`);
    console.log(`  x: ${pk.x}`);
    console.log(`  y: ${pk.y}`);
    console.log('');

    if (!process.env.AUTO_CONFIRM) {
      const confirm = await rl.question('Register this key? [y/N] ');
      if (confirm.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }
    } else {
      console.log('AUTO_CONFIRM: registering...');
    }

    console.log('');
    console.log('Connecting to deployed contract...');
    const found = await (findDeployedContract as any)(providers, {
      contractAddress,
      compiledContract,
      privateStateId: 'schnorr-wallet-state',
      initialPrivateState: {},
    });

    console.log('Submitting register_owner transaction (this may take 20-30 seconds)...');
    console.log('');

    const result = await found.callTx.register_owner(sk);

    console.log(`Owner key registered successfully.`);
    console.log(`   Transaction: ${result.public?.txId ?? '(pending)'}`);
    console.log(`   Block:       ${result.public?.blockHeight ?? '(pending)'}`);
    console.log('');

    await walletCtx.wallet.stop();
  } finally {
    rl.close();
  }
}

main().catch(console.error);
