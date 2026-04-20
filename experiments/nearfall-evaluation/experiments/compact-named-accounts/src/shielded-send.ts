/**
 * Single Named Account — Shielded Send
 *
 * Sends shielded tokens to a registered name's stealth address and publishes
 * the ephemeral key R on-chain so Alice can scan.
 *
 * Stealth seed derivation (two-ECDH, preserves view/spend key separation):
 *
 *   S_scan  = r · K_scan    (= k_scan_scalar · R on Alice's side)
 *   S_spend = r · K_spend   (= k_spend_scalar · R on Alice's side)
 *   stealthSeed = sha256(persistentHash(S_scan) || persistentHash(S_spend))
 *
 * Spending the coin requires BOTH k_scan and k_spend.  A view-only holder of
 * (k_scan_scalar, K_spend) can detect the payment via the original
 * P = K_spend + h·G derivation but cannot derive stealthSeed.
 *
 * Run: npm run shielded-send
 */

import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as rx from 'rxjs';

import * as ledger from '@midnight-ntwrk/ledger-v7';
import { ecMul, ecMulGenerator, persistentHash, CompactTypeNativePoint } from '@midnight-ntwrk/compact-runtime';
import { ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { getPublicStates, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { SingleNamed, CONFIG, zkConfigPath, createWallet, createProviders } from './utils.js';
import { readMnemonic, mnemonicToHexSeed, syncWallet, randomScalar, printBalances } from './common.js';

/** Derive the two-ECDH stealth seed. */
function deriveStealthSeed(S_scan: { x: bigint; y: bigint }, S_spend: { x: bigint; y: bigint }): Uint8Array {
  const h_scan  = persistentHash(CompactTypeNativePoint, S_scan);
  const h_spend = persistentHash(CompactTypeNativePoint, S_spend);
  return createHash('sha256').update(h_scan).update(h_spend).digest();
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       Single Named Account — Shielded Send                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // ── Deployment ───────────────────────────────────────────────────────────

    if (!fs.existsSync('deployment.json')) {
      console.error('No deployment.json found. Run deploy first.'); process.exit(1);
    }
    const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));
    console.log(`Contract: ${contractAddress}`);
    console.log('');

    // ── Recipient lookup ─────────────────────────────────────────────────────

    const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
    const { contractState } = await getPublicStates(publicDataProvider, contractAddress);
    const ls = SingleNamed.ledger(contractState.data);

    if (!ls.name) {
      console.error('No name registered in this contract. Run register first.'); process.exit(1);
    }

    const kScanPt  = ls.k_scan;
    const kSpendPt = ls.k_spend;

    console.log(`Recipient : ${ls.name}`);
    console.log(`K_scan.x  : 0x${kScanPt.x.toString(16)}`);
    console.log(`K_spend.x : 0x${kSpendPt.x.toString(16)}`);
    console.log('');

    // ── Stealth seed derivation ───────────────────────────────────────────────
    //
    // Two-ECDH: stealthSeed = sha256(H(r·K_scan) || H(r·K_spend))
    // Alice reproduces this with k_scan_scalar and k_spend_scalar in shielded-scan.

    const r       = randomScalar();
    const R       = ecMulGenerator(r);
    const S_scan  = ecMul(kScanPt, r);
    const S_spend = ecMul(kSpendPt, r);
    const stealthSeed = deriveStealthSeed(S_scan, S_spend);

    // ── Stealth receiver address ─────────────────────────────────────────────

    const stealthKeys = ledger.ZswapSecretKeys.fromSeed(stealthSeed);
    const networkId   = getNetworkId();

    const shieldedAddress = new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(stealthKeys.coinPublicKey),
      ShieldedEncryptionPublicKey.fromHexString(stealthKeys.encryptionPublicKey),
    );
    const stealthAddressStr = MidnightBech32m.encode(networkId, shieldedAddress).toString();

    console.log('Derived stealth address:');
    console.log(`  R.x     : 0x${R.x.toString(16)}`);
    console.log(`  Address : ${stealthAddressStr}`);
    console.log('');

    // ── Bob's wallet ─────────────────────────────────────────────────────────

    const mn = await readMnemonic(rl, "Enter your (Bob's) mnemonic: ");
    console.log('\nCreating wallet...');
    const bobWallet = await createWallet(await mnemonicToHexSeed(mn));
    await syncWallet(bobWallet, 'wallet');

    const walletState = await rx.firstValueFrom(bobWallet.wallet.state());
    printBalances(walletState);

    // ── Show available shielded balances ─────────────────────────────────────

    const shieldedBalances = Object.entries(walletState.shielded.balances as Record<string, bigint>)
      .filter(([, amt]) => amt > 0n);

    if (shieldedBalances.length === 0) {
      console.log('⚠️  Your wallet has no shielded tokens to send.');
      console.log('   Shield some tokens first (via the shielding-contracts experiment),');
      console.log('   then re-run this script.');
      console.log('');
      console.log('Proceeding to publish R on-chain only...');
    } else {
      console.log('Your shielded balances:');
      shieldedBalances.forEach(([tokenType, amount], i) => {
        console.log(`  [${i + 1}] ${tokenType} : ${amount}`);
      });
      console.log('');
    }

    // ── Transfer ─────────────────────────────────────────────────────────────

    if (shieldedBalances.length > 0) {
      // Pick token
      let tokenType: string;
      let available: bigint;
      if (shieldedBalances.length === 1) {
        [tokenType, available] = shieldedBalances[0];
        console.log(`Using token: ${tokenType}`);
      } else {
        const choice = parseInt(await rl.question('Pick token number: '), 10);
        [tokenType, available] = shieldedBalances[Math.max(0, Math.min(choice - 1, shieldedBalances.length - 1))];
      }

      const amountStr = await rl.question(`Amount to send (available: ${available}): `);
      const sendAmount = BigInt(amountStr.trim());
      console.log('');

      const confirm = await rl.question(`Send ${sendAmount} of ${tokenType} to "${ls.name}"? [y/N] `);
      if (confirm.trim().toLowerCase() !== 'y') {
        console.log('Aborted.'); return;
      }
      console.log('');

      console.log('Building shielded transfer...');
      const txRecipe = await bobWallet.wallet.transferTransaction(
        [
          {
            type: 'shielded',
            outputs: [{ type: tokenType, amount: sendAmount, receiverAddress: stealthAddressStr }],
          },
        ],
        { shieldedSecretKeys: bobWallet.shieldedSecretKeys, dustSecretKey: bobWallet.dustSecretKey },
        { ttl: new Date(Date.now() + 30 * 60 * 1000) },
      );

      console.log('Signing...');
      const signedRecipe = await bobWallet.wallet.signRecipe(txRecipe, (payload) =>
        bobWallet.unshieldedKeystore.signData(payload),
      );

      console.log('Finalizing and submitting...');
      const finalizedTx = await bobWallet.wallet.finalizeRecipe(signedRecipe);
      const txId = await bobWallet.wallet.submitTransaction(finalizedTx);
      console.log('');
      console.log(`✅ Transfer submitted.`);
      console.log(`   Transaction: ${txId}`);
      console.log('');
    }

    // ── Publish R on-chain ───────────────────────────────────────────────────
    //
    // Alice reads shielded_R from the contract to derive the same stealthSeed.
    // Requires the proof server at localhost:6300.

    console.log('Publishing R via publish_ephemeral...');
    console.log('(Requires proof server at localhost:6300)');
    const providers = await createProviders(bobWallet);
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

    const pubTx = await deployed.callTx.publish_ephemeral(r);
    console.log('');
    console.log(`✅ R published on-chain.`);
    console.log(`   Transaction: ${pubTx.public.txId}`);
    console.log(`   Block:       ${pubTx.public.blockHeight}`);
    console.log('');
    console.log(`Alice can now claim using: npm run shielded-scan`);

    await bobWallet.wallet.stop();

  } finally {
    rl.close();
  }
}

main().catch(console.error);
