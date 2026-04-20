/**
 * TEMPORARY EXPERIMENT — Hypothesis B, Alice's side
 *
 * Reads shielded_R from the contract, derives stealthSeed =
 * persistentHash(k_scan_scalar · R), then builds a ShieldedWallet from
 * stealthSeed and syncs it to the chain.  If the wallet reports a non-zero
 * shielded balance, Hypothesis B is confirmed: the wallet-native stealth
 * derivation allows Alice to detect (and later sweep) the coin without any
 * scalar addition outside the wallet SDK.
 *
 * Prerequisites:
 *   - deployment.json and ${name}.json must exist.
 *   - Bob must have run experiment-stealth-b-send.ts (published R and sent coins).
 *
 * Run: npx tsx src/experiment-stealth-b-detect.ts
 */

import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as rx from 'rxjs';

import * as ledger from '@midnight-ntwrk/ledger-v7';
import { ecMul, persistentHash, CompactTypeNativePoint } from '@midnight-ntwrk/compact-runtime';
import { ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, InMemoryTransactionHistoryStorage, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

import { SingleNamed, CONFIG } from './utils.js';

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Experiment: Hypothesis B — Alice detects stealth coin     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // ── Load Alice's private keys ─────────────────────────────────────────────

    if (!fs.existsSync('deployment.json')) {
      console.error('No deployment.json found.'); process.exit(1);
    }
    const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));

    const name = (await rl.question('Registered name (e.g. alice.midnight): ')).trim();
    const keysFile = `${name}.json`;
    if (!fs.existsSync(keysFile)) {
      console.error(`No keys file: ${keysFile}`); process.exit(1);
    }
    const stored = JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
    const kScanSc = BigInt(stored.kScanScalar);
    console.log('');

    // ── Read shielded_R from contract ─────────────────────────────────────────

    const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
    const { contractState } = await getPublicStates(publicDataProvider, contractAddress);
    const ls = SingleNamed.ledger(contractState.data);

    const R = ls.shielded_R;

    if (!R || (R.x === 0n && R.y === 0n)) {
      console.error('No shielded_R on-chain. Run experiment-stealth-b-send.ts first.');
      process.exit(1);
    }

    console.log(`shielded_R.x : 0x${R.x.toString(16)}`);
    console.log('');

    // ── Derive stealthSeed ────────────────────────────────────────────────────
    //
    // Alice computes: persistentHash(k_scan_scalar · R)
    // This equals Bob's: persistentHash(r · K_scan)  by ECDH.

    const S           = ecMul(R, kScanSc);
    const stealthSeed = persistentHash(CompactTypeNativePoint, S);  // Uint8Array, 32 bytes

    console.log('─── Hypothesis B stealth wallet ────────────────────────────────');
    console.log('');
    console.log(`stealthSeed (hex): ${Buffer.from(stealthSeed).toString('hex')}`);
    console.log('');

    // ── Construct the stealth receiver address (for verification) ─────────────

    const stealthSecretKeys = ledger.ZswapSecretKeys.fromSeed(stealthSeed);
    const networkId         = getNetworkId();

    const shieldedAddress = new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(stealthSecretKeys.coinPublicKey),
      ShieldedEncryptionPublicKey.fromHexString(stealthSecretKeys.encryptionPublicKey),
    );
    const stealthAddressStr = MidnightBech32m.encode(networkId, shieldedAddress).toString();

    console.log(`coinPublicKey      : ${stealthSecretKeys.coinPublicKey}`);
    console.log(`Stealth address    : ${stealthAddressStr}`);
    console.log('');
    console.log('If this matches the address Bob targeted, the ECDH is consistent.');
    console.log('');

    // ── Build a wallet from stealthSeed ──────────────────────────────────────
    //
    // stealthSeed drives ZswapSecretKeys (the shielded component).
    // Unshielded and dust components use stealthSeed as a dummy key — they
    // will not have real balances but are required by the WalletFacade API.

    const dummyDustKey     = ledger.DustSecretKey.fromSeed(stealthSeed);
    const dummyKeystore    = createKeystore(stealthSeed, networkId);

    const walletConfig = {
      networkId,
      indexerClientConnection: {
        indexerHttpUrl: CONFIG.indexer,
        indexerWsUrl: CONFIG.indexerWS,
      },
      provingServerUrl: new URL(CONFIG.proofServer),
      relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
    };

    const shieldedWallet   = ShieldedWallet(walletConfig).startWithSecretKeys(stealthSecretKeys);
    const unshieldedWallet = UnshieldedWallet({
      networkId,
      indexerClientConnection: walletConfig.indexerClientConnection,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    }).startWithPublicKey(PublicKey.fromKeyStore(dummyKeystore));
    const dustWallet = DustWallet({
      ...walletConfig,
      costParameters: {
        additionalFeeOverhead: 300_000_000_000_000n,
        feeBlocksMargin: 5,
      },
    }).startWithSecretKey(dummyDustKey, ledger.LedgerParameters.initialParameters().dust);

    const stealthWalletFacade = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
    await stealthWalletFacade.start(stealthSecretKeys, dummyDustKey);

    // ── Sync ─────────────────────────────────────────────────────────────────

    console.log('Syncing stealth wallet to chain');
    await rx.firstValueFrom(
      stealthWalletFacade.state().pipe(
        rx.throttleTime(5_000),
        rx.tap(() => process.stdout.write(' .')),
        rx.filter((s: any) => s.isSynced === true),
        rx.timeout({
          first: 5 * 60 * 1000,
          with: () => rx.throwError(() => new Error('Timed out waiting for sync')),
        }),
      ),
    );
    console.log('\nSynced!\n');

    // ── Check shielded balance ────────────────────────────────────────────────

    const finalState = await rx.firstValueFrom(stealthWalletFacade.state());
    const shieldedBalances = Object.entries(
      (finalState as any).shielded.balances as Record<string, bigint>
    );

    console.log('─── Shielded balances in stealth wallet ────────────────────────');
    console.log('');
    if (shieldedBalances.length === 0) {
      console.log('(none)');
    } else {
      for (const [tokenType, amount] of shieldedBalances) {
        console.log(`  ${tokenType}: ${amount}`);
      }
    }
    console.log('');

    const anyBalance = shieldedBalances.some(([, amt]) => amt > 0n);
    if (anyBalance) {
      console.log('✅ Hypothesis B CONFIRMED: wallet-native stealth detection works!');
      console.log('');
      console.log('Alice can now sweep this coin to her real wallet via:');
      console.log('  stealthWalletFacade.transferTransaction(...)');
      console.log('  to her own shielded address.');
    } else {
      console.log('❌ Hypothesis B UNCONFIRMED: no balance detected.');
      console.log('');
      console.log('Possible reasons:');
      console.log('  1. Bob has not sent tokens to this stealth address yet.');
      console.log('  2. The transfer transaction has not confirmed yet — wait a few');
      console.log('     blocks and re-run.');
      console.log('  3. The fromSeed(stealthSeed) derivation does not produce a');
      console.log('     coinPublicKey that the wallet SDK uses for note detection.');
      console.log('     (Hypothesis B is false for this mechanism.)');
    }

    await stealthWalletFacade.stop();

  } finally {
    rl.close();
  }
}

main().catch(console.error);
