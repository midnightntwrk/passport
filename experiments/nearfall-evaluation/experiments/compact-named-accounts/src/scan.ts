import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';

import { findDeployedContract, getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ecMul, ecAdd, ecMulGenerator, persistentHash, CompactTypeNativePoint } from '@midnight-ntwrk/compact-runtime';

import { createWallet, createProviders, SingleNamed, zkConfigPath, CONFIG } from './utils.js';
import { readMnemonic, mnemonicToHexSeed, syncWallet } from './common.js';


async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      Single Named Account — Scan & Claim                     ║');
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

    // 2. Load Alice's private keys from her keys file
    const name = (await rl.question('Your registered name (e.g. alice.midnight): ')).trim();
    const keysFile = `${name}.json`;
    if (!fs.existsSync(keysFile)) {
      console.error(`No keys file found: ${keysFile}. Run register first.`);
      process.exit(1);
    }
    const stored = JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
    const kScanSc  = BigInt(stored.kScanScalar);
    const kSpendSc = BigInt(stored.kSpendScalar);
    console.log('');

    // 3. Read current contract state — no wallet needed for scanning
    const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
    const { contractState } = await getPublicStates(publicDataProvider, contractAddress);
    const ls = SingleNamed.ledger(contractState.data);

    const kSpendPt = ls.k_spend;

    // ── Unshielded scan ───────────────────────────────────────────────────────
    //
    // For each published R, Alice computes:
    //   S  = k_scan_scalar · R     (shared secret — mirrors r · K_scan on sender side)
    //   hG = hash_to_curve(S.x)
    //   P  = K_spend + hG
    // If P matches pending_P the output belongs to her and she can claim it.
    // Claiming uses a ZK proof — k_scan_scalar and k_spend_scalar stay private.

    console.log('─── Unshielded output ──────────────────────────────────────────');
    console.log('');

    if (!ls.pending_amount || ls.pending_amount === 0n) {
      console.log('No pending unshielded output in contract.');
    } else {
      const R      = ls.pending_R;
      const S      = ecMul(R, kScanSc);
      const hBytes = persistentHash(CompactTypeNativePoint, S);
      const JUBJUB_R = BigInt('0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7');
      const h      = BigInt('0x' + Buffer.from(hBytes).toString('hex')) % JUBJUB_R;
      const hG     = ecMulGenerator(h);
      const P_check = ecAdd(kSpendPt, hG);

      if (P_check.x === ls.pending_P.x && P_check.y === ls.pending_P.y) {
        console.log(`✅ Found your output!`);
        console.log(`   Amount: ${ls.pending_amount} tDUST`);
        console.log('');

        const doClaim = await rl.question('Claim now? [y/N] ');
        if (doClaim.trim().toLowerCase() === 'y') {
          console.log('');
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

          console.log('Submitting claim transaction (this may take 20-30 seconds)...');
          try {
            const tx = await deployed.callTx.claim(kScanSc, kSpendSc, h);
            console.log(`\n✅ Claimed ${ls.pending_amount} tDUST successfully.`);
            console.log(`   Transaction: ${tx.public.txId}`);
            console.log(`   Block:       ${tx.public.blockHeight}`);
            console.log('');
          } catch (e) {
            console.error(`\n❌ Error: ${e instanceof Error ? e.message : e}\n`);
          }

          await walletCtx.wallet.stop();
        }
      } else {
        console.log('Pending output does not belong to you.');
      }
    }

    // ── Shielded scan ─────────────────────────────────────────────────────────
    //
    // Bob publishes R via publish_ephemeral; the wallet SDK creates the ZSwap
    // output off-chain using a spending key derived from the stealth protocol.
    //
    // Alice can identify her output using the same derivation:
    //   S  = k_scan_scalar · R
    //   hG = hash_to_curve(S.x)
    //   P  = K_spend + hG
    //
    // LIMITATION: hash_to_curve produces a point with UNKNOWN discrete logarithm,
    // so the one-time private key (k_spend_scalar + h) cannot be computed from hG
    // analytically.  Spending a shielded coin at P requires a hash-to-scalar
    // function instead of hash_to_curve.  This is deferred to the next iteration;
    // for now this section identifies the output only.

    console.log('');
    console.log('─── Shielded path ──────────────────────────────────────────────');
    console.log('');

    const sR = ls.shielded_R;

    if (!sR || (sR.x === 0n && sR.y === 0n)) {
      console.log('No ephemeral key published for shielded path.');
    } else {
      const R      = sR;
      const S      = ecMul(R, kScanSc);
      const hBytes = persistentHash(CompactTypeNativePoint, S);
      const JUBJUB_R = BigInt('0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7');
      const h      = BigInt('0x' + Buffer.from(hBytes).toString('hex')) % JUBJUB_R;
      const hG     = ecMulGenerator(h);
      const P      = ecAdd(kSpendPt, hG);

      // Alice's one-time private key: k_spend_scalar + h (mod JUBJUB_R)
      const sk = (kSpendSc + h) % JUBJUB_R;

      console.log(`Ephemeral key R  : (0x${R.x.toString(16)})`);
      console.log(`Stealth key   P  : (0x${P.x.toString(16)}, 0x${P.y.toString(16)})`);
      console.log(`One-time priv key: 0x${sk.toString(16)}`);
      console.log('');
      console.log('  Use the one-time private key to spend the shielded ZSwap coin at P.');
    }
    console.log('');
  } finally {
    rl.close();
  }
}

main().catch(console.error);
