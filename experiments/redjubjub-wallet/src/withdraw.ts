import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findDeployedContract, getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { createWallet, createProviders, SchnorrWallet, zkConfigPath } from './utils.js';
import {
  getWalletSeed, syncWallet,
  JUBJUB_R, bytesToBigIntLE, bigIntToHex, bigIntToLeHex, hexToBytes32,
} from './common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNER_BIN = path.resolve(__dirname, '..', 'signer', 'target', 'debug', 'schnorr-signer');

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      Schnorr Wallet — Withdraw Tokens                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!fs.existsSync('deployment.json')) {
    console.error('No deployment.json found. Run: npm run deploy');
    process.exit(1);
  }
  if (!fs.existsSync('wallet-key.json')) {
    console.error('No wallet-key.json found. Run: npm run register');
    process.exit(1);
  }

  const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));
  const { sk: skHex } = JSON.parse(fs.readFileSync('wallet-key.json', 'utf-8'));

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

    // Read current contract state to get tx_count and owner_pk
    const pubStates = await getPublicStates(providers.publicDataProvider, contractAddress);
    const pub = SchnorrWallet.ledger(pubStates.contractState.data);

    if (!pub.registered) {
      console.error('No owner registered on this contract.');
      process.exit(1);
    }

    const currentTxCount = BigInt(pub.tx_count);
    console.log(`Current tx_count: ${currentTxCount}`);
    console.log('');

    // Get withdrawal parameters
    let color: string;
    let amount: bigint;
    let recipient: string;

    if (process.env.AUTO_CONFIRM) {
      // Auto mode: use env vars or defaults
      color = process.env.WITHDRAW_COLOR ?? '0000000000000000000000000000000000000000000000000000000000000000';
      amount = BigInt(process.env.WITHDRAW_AMOUNT ?? '500');
      // Recipient: the wallet's own unshielded public key (send back to self)
      recipient = walletCtx.unshieldedKeystore.getBech32Address();
      console.log(`AUTO_CONFIRM: withdrawing ${amount} of ${color}`);
      console.log(`  to: ${recipient}`);
    } else {
      color = await rl.question('Token color (hex): ');
      const amountStr = await rl.question('Amount to withdraw: ');
      amount = BigInt(amountStr);
      recipient = await rl.question('Recipient address (mn_addr_...): ');
    }
    console.log('');

    // --- Schnorr signature computation ---
    //
    // Split between TypeScript and Rust:
    //   - TypeScript: generates nonce r, computes R = r*G via pureCircuits,
    //     runs the nonce-retry loop for the Poseidon challenge hash
    //   - Rust CLI: computes s = (r + c * sk) mod JUBJUB_R (pure scalar arithmetic)
    //
    // In a FROST threshold setup, the Rust CLI would be replaced by a threshold
    // signing protocol. The TypeScript side stays the same.

    console.log('Computing Schnorr signature...');
    console.log(`  Signer: ${SIGNER_BIN}`);

    const { randomJubjubScalar } = await import('./common.js');

    // Step 1: Generate random nonce scalar r
    const r = randomJubjubScalar();

    // Step 2: Compute R = r*G via the contract's pure circuit (guarantees curve match)
    const sigR = SchnorrWallet.pureCircuits.compute_nonce_point(r);

    // Convert inputs to circuit types
    const colorBytes = hexToBytes32(color);
    // For UserAddress, use the raw 32-byte public key from the keystore
    const recipientPk = walletCtx.unshieldedKeystore.getPublicKey();
    const recipientBytes = typeof recipientPk === 'string' ? hexToBytes32(recipientPk) : recipientPk;
    const recipientObj = { bytes: recipientBytes };

    // Step 3: Nonce-retry loop — find nonce where challenge hash < JUBJUB_R
    let nonce = 0n;
    let c: bigint;
    let iterations = 0;

    while (true) {
      iterations++;
      const hBytes: Uint8Array = SchnorrWallet.pureCircuits.compute_withdraw_challenge(
        sigR, pub.owner_pk, colorBytes, amount, recipientObj, currentTxCount, nonce,
      );
      const hInt = bytesToBigIntLE(hBytes);
      if (hInt < JUBJUB_R) {
        c = hInt;
        break;
      }
      nonce++;
    }
    console.log(`  Challenge found after ${iterations} iterations (nonce=${nonce})`);

    // Step 4: Compute s = (r + c * sk) mod JUBJUB_R
    // Done in TypeScript to ensure the bigint representation matches
    // what the Compact runtime expects. In a FROST setup, this would
    // be replaced by threshold partial signatures from the signing nodes.
    const sk = BigInt(skHex);
    const sigS = ((r % JUBJUB_R) + ((c! % JUBJUB_R) * (sk % JUBJUB_R)) % JUBJUB_R) % JUBJUB_R;

    // Also call Rust CLI for cross-validation (optional)
    try {
      const signOutput = execFileSync(SIGNER_BIN, ['sign'], {
        input: JSON.stringify({ sk: bigIntToLeHex(sk), challenge: bigIntToLeHex(c!), r: bigIntToLeHex(r) }),
        encoding: 'utf-8',
      });
      const { s: rustS } = JSON.parse(signOutput);
      const rustSBigInt = bytesToBigIntLE(hexToBytes32(rustS));
      console.log(`  s (TypeScript): ${sigS}`);
      console.log(`  s (Rust CLI):   ${rustSBigInt}`);
      if (sigS !== rustSBigInt) {
        console.log(`  WARNING: s values differ — encoding mismatch`);
      }
    } catch {
      console.log(`  (Rust CLI cross-check skipped)`);
    }

    console.log(`  R.x: ${sigR.x}`);
    console.log('');

    if (!process.env.AUTO_CONFIRM) {
      const confirm = await rl.question(`Withdraw ${amount} of ${color}? [y/N] `);
      if (confirm.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    console.log('');
    console.log('Connecting to deployed contract...');
    const found = await (findDeployedContract as any)(providers, {
      contractAddress,
      compiledContract,
      privateStateId: 'schnorr-wallet-state',
      initialPrivateState: {},
    });

    // Debug: verify the challenge locally before submitting
    console.log('Verifying challenge locally...');
    const verifyH = SchnorrWallet.pureCircuits.compute_withdraw_challenge(
      sigR, pub.owner_pk, colorBytes, amount, recipientObj, currentTxCount, nonce,
    );
    const verifyC = bytesToBigIntLE(verifyH);
    console.log(`  c (original): ${c!}`);
    console.log(`  c (verify):   ${verifyC}`);
    console.log(`  match: ${c! === verifyC}`);

    // Verify s*G locally
    const sG = SchnorrWallet.pureCircuits.compute_nonce_point(sigS);
    console.log(`  s*G.x: ${sG.x}`);
    console.log(`  R.x:   ${sigR.x}`);
    console.log('');

    console.log('Submitting withdraw transaction (this may take 20-30 seconds)...');
    console.log('');

    const result = await found.callTx.withdraw(
      sigR,
      sigS,
      colorBytes,
      amount,
      recipientObj,
      nonce,
    );

    console.log(`Withdrawal successful!`);
    console.log(`   Transaction: ${result.public?.txId ?? '(pending)'}`);
    console.log(`   Block:       ${result.public?.blockHeight ?? '(pending)'}`);
    console.log('');

    await walletCtx.wallet.stop();
  } finally {
    rl.close();
  }
}

main().catch(console.error);
