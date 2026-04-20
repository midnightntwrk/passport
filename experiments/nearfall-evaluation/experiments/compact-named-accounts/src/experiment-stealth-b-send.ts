/**
 * TEMPORARY EXPERIMENT — Hypothesis B, Bob's side
 *
 * Derives stealthSeed = persistentHash(r · K_scan) for a registered name,
 * constructs a Hypothesis-B shielded receiver address, transfers shielded
 * tokens to it, and publishes R on-chain via publish_ephemeral so Alice can
 * scan.
 *
 * Protocol:
 *   stealthSeed = persistentHash(r · K_scan)         [Bob, using private r]
 *   coinPubKey  = ZswapSecretKeys.fromSeed(stealthSeed).coinPublicKey
 *   receiverAddr = MidnightBech32m.encode(ShieldedAddress(coinPubKey, encPubKey))
 *   Bob sends shielded tokens to receiverAddr.
 *   Bob calls publish_ephemeral(r) so Alice can derive the same stealthSeed.
 *
 * Alice runs experiment-stealth-b-detect.ts to check for detection.
 *
 * Run: npx tsx src/experiment-stealth-b-send.ts
 */

import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as rx from 'rxjs';

import { ZswapSecretKeys } from '@midnight-ntwrk/ledger-v7';
import { ecMul, ecMulGenerator, persistentHash, CompactTypeNativePoint } from '@midnight-ntwrk/compact-runtime';
import { ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { getPublicStates, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { SingleNamed, CONFIG, zkConfigPath, createWallet, createProviders } from './utils.js';
import { readMnemonic, mnemonicToHexSeed, syncWallet, randomScalar } from './common.js';

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Experiment: Hypothesis B — Bob sends to stealth address   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // ── Load deployment ───────────────────────────────────────────────────────

    if (!fs.existsSync('deployment.json')) {
      console.error('No deployment.json found.'); process.exit(1);
    }
    const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));
    console.log(`Contract: ${contractAddress}`);
    console.log('');

    // ── Read registered K_scan from contract ─────────────────────────────────

    const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
    const { contractState } = await getPublicStates(publicDataProvider, contractAddress);
    const ls = SingleNamed.ledger(contractState.data);

    if (!ls.name) {
      console.error('No name registered in this contract. Run register first.');
      process.exit(1);
    }

    const kScanPt = ls.k_scan;
    console.log(`Recipient  : ${ls.name}`);
    console.log(`K_scan.x   : 0x${kScanPt.x.toString(16)}`);
    console.log('');

    // ── Derive stealth seed (Hypothesis B) ───────────────────────────────────
    //
    // stealthSeed = persistentHash(r · K_scan)
    // Both Bob (here) and Alice (detect experiment) arrive at the same seed
    // via ECDH: r·K_scan = k_scan_scalar·R  (shared secret on JubJub).

    const r         = randomScalar();
    const R         = ecMulGenerator(r);
    const S         = ecMul(kScanPt, r);
    const stealthSeed = persistentHash(CompactTypeNativePoint, S);  // Uint8Array, 32 bytes

    console.log(`Ephemeral r: 0x${r.toString(16)}`);
    console.log(`R.x        : 0x${R.x.toString(16)}`);
    console.log('');

    // ── Construct Hypothesis-B receiver address ───────────────────────────────

    const stealthKeys = ZswapSecretKeys.fromSeed(stealthSeed);
    const networkId   = getNetworkId();

    const shieldedAddress = new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(stealthKeys.coinPublicKey),
      ShieldedEncryptionPublicKey.fromHexString(stealthKeys.encryptionPublicKey),
    );
    const stealthAddressStr = MidnightBech32m.encode(networkId, shieldedAddress).toString();

    console.log('─── Stealth address (Hypothesis B) ─────────────────────────────');
    console.log('');
    console.log(`stealthSeed (hex)  : ${Buffer.from(stealthSeed).toString('hex')}`);
    console.log(`coinPublicKey      : ${stealthKeys.coinPublicKey}`);
    console.log(`encPublicKey       : ${stealthKeys.encryptionPublicKey}`);
    console.log(`Receiver address   : ${stealthAddressStr}`);
    console.log('');
    console.log('Alice runs experiment-stealth-b-detect.ts to detect this coin.');
    console.log('');

    // ── Bob's wallet ─────────────────────────────────────────────────────────

    const mn = await readMnemonic(rl, "Enter Bob's mnemonic: ");
    console.log('\nCreating wallet...');
    const bobWallet = await createWallet(await mnemonicToHexSeed(mn));
    await syncWallet(bobWallet, 'wallet');
    console.log('');

    const state = await rx.firstValueFrom(bobWallet.wallet.state());
    const shieldedBalances = Object.entries(state.shielded.balances as Record<string, bigint>)
      .filter(([, amount]) => amount > 0n);

    console.log('Shielded balances:');
    if (shieldedBalances.length === 0) {
      console.log('  (none)');
      console.log('');
      console.log('⚠️  Bob has no shielded tokens to send.');
      console.log('   Shield some tokens first (e.g. via the shielding-contracts experiment)');
      console.log('   then re-run this experiment.');
      console.log('');
      console.log('Proceeding to publish_ephemeral only...');
    } else {
      for (const [tokenType, amount] of shieldedBalances) {
        console.log(`  ${tokenType}: ${amount}`);
      }
      console.log('');
    }

    // ── Transfer to stealth address ───────────────────────────────────────────

    if (shieldedBalances.length > 0) {
      const [tokenType, availableAmount] = shieldedBalances[0];
      const amountStr = await rl.question(
        `Amount to send (token: ${tokenType.slice(0, 16)}…, available: ${availableAmount}): `
      );
      const sendAmount = BigInt(amountStr.trim());
      console.log('');

      console.log('Building shielded transfer to stealth address...');
      const txRecipe = await bobWallet.wallet.transferTransaction(
        [
          {
            type: 'shielded',
            outputs: [
              {
                type: tokenType,
                amount: sendAmount,
                receiverAddress: stealthAddressStr,
              },
            ],
          },
        ],
        {
          shieldedSecretKeys: bobWallet.shieldedSecretKeys,
          dustSecretKey: bobWallet.dustSecretKey,
        },
        {
          ttl: new Date(Date.now() + 30 * 60 * 1000),
        },
      );

      console.log('Signing...');
      const signedTxRecipe = await bobWallet.wallet.signRecipe(txRecipe, (payload) =>
        bobWallet.unshieldedKeystore.signData(payload),
      );

      console.log('Finalizing...');
      const finalizedTx = await bobWallet.wallet.finalizeRecipe(signedTxRecipe);

      console.log('Submitting transfer...');
      const txId = await bobWallet.wallet.submitTransaction(finalizedTx);
      console.log('');
      console.log(`✅ Transfer submitted: ${txId}`);
      console.log('');
    }

    // ── Publish R on-chain via publish_ephemeral ──────────────────────────────
    //
    // Alice reads shielded_R from the contract to derive stealthSeed
    // independently: persistentHash(k_scan_scalar · R)

    console.log('Publishing R on-chain via publish_ephemeral...');
    console.log('(This requires the proof server at localhost:6300)');

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
    console.log('Alice can now run: npx tsx src/experiment-stealth-b-detect.ts');

    await bobWallet.wallet.stop();

  } finally {
    rl.close();
  }
}

main().catch(console.error);
