import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

import { createWallet, createProviders, SingleNamed, zkConfigPath } from './utils.js';
import { readMnemonic, mnemonicToHexSeed, syncWallet, randomScalar } from './common.js';


async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      Single Named Account — Register                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // 1. Load deployment info
    if (!fs.existsSync('deployment.json')) {
      console.error('No deployment.json found. Run the deploy script first.');
      process.exit(1);
    }
    const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));
    console.log(`Contract: ${contractAddress}`);
    console.log('');

    // 2. Wallet setup
    const mn = await readMnemonic(rl, 'Enter your mnemonic: ');
    console.log('');
    console.log('Creating wallet...');
    const walletCtx = await createWallet(await mnemonicToHexSeed(mn));
    await syncWallet(walletCtx, 'wallet');
    console.log('');

    // 3. Connect to deployed contract
    const providers = await createProviders(walletCtx);

    const compiledContract = CompiledContract.make('single-named', SingleNamed.Contract).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(zkConfigPath),
    );

    const deployed = await findDeployedContract(providers, {
      compiledContract,
      contractAddress,
      privateStateId: 'single-named-state',
      initialPrivateState: {},
    });

    // 4. Collect registration inputs
    const name = await rl.question('Name to register (e.g. alice.midnight): ');

    let kScanScalar: bigint;
    let kSpendScalar: bigint;

    const keysFile = `${name}.json`;
    if (fs.existsSync(keysFile)) {
      const stored = JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
      kScanScalar  = BigInt(stored.kScanScalar);
      kSpendScalar = BigInt(stored.kSpendScalar);
      console.log(`\nLoaded scalars from ${keysFile}.`);
    } else {
      kScanScalar  = randomScalar();
      kSpendScalar = randomScalar();

      fs.writeFileSync(keysFile, JSON.stringify({
        name,
        kScanScalar:  '0x' + kScanScalar.toString(16),
        kSpendScalar: '0x' + kSpendScalar.toString(16),
      }, null, 2));
      console.log(`\n  k_scan  scalar: 0x${kScanScalar.toString(16)}`);
      console.log(`  k_spend scalar: 0x${kSpendScalar.toString(16)}`);
      console.log(`\n  ⚠️  Scalars saved to ${keysFile} — keep this file secret.\n`);
    }

    // Derive public Jubjub points: K = scalar * G
    const kScanPt  = ecMulGenerator(kScanScalar);
    const kSpendPt = ecMulGenerator(kSpendScalar);

    console.log('\nDerived public keys (will be stored on-chain):');
    console.log(`  K_scan  x: 0x${kScanPt.x.toString(16)}`);
    console.log(`  K_scan  y: 0x${kScanPt.y.toString(16)}`);
    console.log(`  K_spend x: 0x${kSpendPt.x.toString(16)}`);
    console.log(`  K_spend y: 0x${kSpendPt.y.toString(16)}`);

    const confirm = await rl.question(`\nRegister "${name}"? [y/N] `);
    if (confirm.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }

    // 5. Call register() circuit.
    //    NativePoint in Compact maps to JubjubPoint = {x, y} in TypeScript.
    console.log('\nSubmitting transaction (this may take 20-30 seconds)...');
    try {
      const tx = await deployed.callTx.register(name, kScanPt, kSpendPt);
      console.log(`\n✅ "${name}" registered successfully.`);
      console.log(`   Transaction: ${tx.public.txId}`);
      console.log(`   Block:       ${tx.public.blockHeight}`);
      console.log(`   Contract:    ${contractAddress}`);
      console.log('');
    } catch (e) {
      console.error(`\n❌ Error: ${e instanceof Error ? e.message : e}\n`);
    }

    await walletCtx.wallet.stop();
  } finally {
    rl.close();
  }
}

main().catch(console.error);
