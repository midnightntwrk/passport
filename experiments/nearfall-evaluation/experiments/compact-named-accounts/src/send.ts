import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';

import { findDeployedContract, getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ecMulGenerator, ecMul, ecAdd, persistentHash, CompactTypeNativePoint } from '@midnight-ntwrk/compact-runtime';

import { createWallet, createProviders, SingleNamed, zkConfigPath, CONFIG } from './utils.js';
import { readMnemonic, mnemonicToHexSeed, syncWallet, randomScalar } from './common.js';


async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      Single Named Account — Send (Unshielded Escrow)         ║');
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

    // 2. Read contract state — no wallet needed for this step
    const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
    const { contractState } = await getPublicStates(publicDataProvider, contractAddress);
    const ls = SingleNamed.ledger(contractState.data);

    if (!ls.name) {
      console.error('No name registered in this contract. Run register first.');
      process.exit(1);
    }

    const kScanPt  = ls.k_scan;
    const kSpendPt = ls.k_spend;

    console.log(`Recipient : ${ls.name}`);
    console.log(`K_scan    : (0x${kScanPt.x.toString(16)})`);
    console.log(`K_spend   : (0x${kSpendPt.x.toString(16)})`);
    console.log('');

    // Warn if there is already a pending output
    if (ls.pending_amount && ls.pending_amount > 0n) {
      console.warn('⚠️  A pending unshielded output is already waiting to be claimed.');
      console.warn('    Sending again will overwrite it; the prior funds will be unrecoverable.\n');
      const proceed = await rl.question('Continue anyway? [y/N] ');
      if (proceed.trim().toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
      console.log('');
    }

    // 3. Derive stealth address
    //    r is ephemeral — generated fresh each send, never reused.
    //    R = r·G is published on-chain so Alice can scan.
    //    S = r·K_scan  (= k_scan_scalar·R on Alice's side — shared secret)
    //    hG = hash_to_curve(S.x)  — point with unknown discrete log
    //    P = K_spend + hG         — one-time stealth address stored in circuit
    const r      = randomScalar();
    const R      = ecMulGenerator(r);
    const S      = ecMul(kScanPt, r);
    const hBytes = persistentHash(CompactTypeNativePoint, S);           // Uint8Array, 32 bytes
    const JUBJUB_R = BigInt('0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7');
    const h      = BigInt('0x' + Buffer.from(hBytes).toString('hex')) % JUBJUB_R; // scalar mod field order
    const hG     = ecMulGenerator(h);
    const P      = ecAdd(kSpendPt, hG);

    console.log('Derived stealth address:');
    console.log(`  R (ephemeral key): (0x${R.x.toString(16)}, 0x${R.y.toString(16)})`);
    console.log(`  P (stealth addr):  (0x${P.x.toString(16)}, 0x${P.y.toString(16)})`);
    console.log('');

    // 4. Ask for amount
    const amountStr = await rl.question('Amount of tDUST to send: ');
    const amount = BigInt(amountStr.trim());
    console.log('');

    const confirm = await rl.question(`Send ${amount} tDUST to "${ls.name}"? [y/N] `);
    if (confirm.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
    console.log('');

    // 5. Wallet setup
    const mn = await readMnemonic(rl, 'Enter your mnemonic: ');
    console.log('\nCreating wallet...');
    const walletCtx = await createWallet(await mnemonicToHexSeed(mn));
    await syncWallet(walletCtx, 'wallet');
    console.log('');

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

    // 6. Submit send transaction
    //    r is passed as a private witness; the circuit stores R = r·G and P publicly.
    console.log('Submitting transaction (this may take 20-30 seconds)...');
    try {
      const tx = await deployed.callTx.send(r, P, amount);
      console.log(`\n✅ Sent ${amount} tDUST to "${ls.name}" successfully.`);
      console.log(`   Ephemeral key R: (0x${R.x.toString(16)})`);
      console.log(`   Transaction:     ${tx.public.txId}`);
      console.log(`   Block:           ${tx.public.blockHeight}`);
      console.log('');
      console.log(`   Alice can now claim using: npm run scan`);
      console.log('');
    } catch (e) {
      console.error('\n❌ Error:');
      let err: unknown = e;
      let depth = 0;
      while (err) {
        const indent = '  '.repeat(depth);
        if (err instanceof Error) {
          console.error(`${indent}${err.name}: ${err.message}`);
          if (err.stack) {
            const frames = err.stack.split('\n').slice(1, 5);
            frames.forEach(f => console.error(`${indent}${f}`));
          }
          err = (err as any).cause;
          depth++;
        } else {
          console.error(`${indent}${JSON.stringify(err, null, 2)}`);
          break;
        }
      }
      console.error('');
    }

    await walletCtx.wallet.stop();
  } finally {
    rl.close();
  }
}

main().catch(console.error);
