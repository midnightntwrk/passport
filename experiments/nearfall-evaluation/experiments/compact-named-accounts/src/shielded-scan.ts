/**
 * Single Named Account — Shielded Scan & Sweep
 *
 * Reads shielded_R from the contract, derives the same stealthSeed that Bob
 * used, initialises a temporary wallet from it, and detects any shielded
 * coins sent to the stealth address.  Optionally sweeps detected balance to
 * Alice's real shielded wallet.
 *
 * Stealth seed derivation (two-ECDH, mirrors shielded-send.ts):
 *
 *   S_scan  = k_scan_scalar  · R   (= r · K_scan  on Bob's side)
 *   S_spend = k_spend_scalar · R   (= r · K_spend on Bob's side)
 *   stealthSeed = sha256(persistentHash(S_scan) || persistentHash(S_spend))
 *
 * View-key note: a holder of (k_scan_scalar, K_spend) can detect payments
 * using the original P = K_spend + h·G derivation and verify them against
 * pending_P in the unshielded escrow, but cannot derive stealthSeed (which
 * requires k_spend_scalar) and therefore cannot spend shielded coins.
 *
 * Run: npm run shielded-scan
 */

import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
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
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, InMemoryTransactionHistoryStorage, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

import { SingleNamed, CONFIG } from './utils.js';
import { readMnemonic, mnemonicToHexSeed, printBalances } from './common.js';

/** Derive the two-ECDH stealth seed (must match shielded-send.ts). */
function deriveStealthSeed(S_scan: { x: bigint; y: bigint }, S_spend: { x: bigint; y: bigint }): Uint8Array {
  const h_scan  = persistentHash(CompactTypeNativePoint, S_scan);
  const h_spend = persistentHash(CompactTypeNativePoint, S_spend);
  return createHash('sha256').update(h_scan).update(h_spend).digest();
}

const walletConfig = (networkId: string) => ({
  networkId,
  indexerClientConnection: {
    indexerHttpUrl: CONFIG.indexer,
    indexerWsUrl: CONFIG.indexerWS,
  },
  provingServerUrl: new URL(CONFIG.proofServer),
  relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
});

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       Single Named Account — Shielded Scan & Sweep           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // ── Alice's private keys ─────────────────────────────────────────────────

    if (!fs.existsSync('deployment.json')) {
      console.error('No deployment.json found.'); process.exit(1);
    }
    const { contractAddress } = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));

    const name = (await rl.question('Your registered name (e.g. alice.midnight): ')).trim();
    const keysFile = `${name}.json`;
    if (!fs.existsSync(keysFile)) {
      console.error(`No keys file: ${keysFile}. Run register first.`); process.exit(1);
    }
    const stored  = JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
    const kScanSc  = BigInt(stored.kScanScalar);
    const kSpendSc = BigInt(stored.kSpendScalar);
    console.log('');

    // ── Read shielded_R from contract ─────────────────────────────────────────

    const publicDataProvider = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
    const { contractState } = await getPublicStates(publicDataProvider, contractAddress);
    const ls = SingleNamed.ledger(contractState.data);

    const R = ls.shielded_R;
    if (!R || (R.x === 0n && R.y === 0n)) {
      console.error('No shielded_R on-chain. Ask Bob to run shielded-send first.');
      process.exit(1);
    }

    console.log(`shielded_R.x : 0x${R.x.toString(16)}`);
    console.log('');

    // ── Derive stealth seed ───────────────────────────────────────────────────

    const S_scan  = ecMul(R, kScanSc);
    const S_spend = ecMul(R, kSpendSc);
    const stealthSeed = deriveStealthSeed(S_scan, S_spend);

    const stealthSecretKeys = ledger.ZswapSecretKeys.fromSeed(stealthSeed);
    const networkId         = getNetworkId();

    const shieldedAddress = new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(stealthSecretKeys.coinPublicKey),
      ShieldedEncryptionPublicKey.fromHexString(stealthSecretKeys.encryptionPublicKey),
    );
    const stealthAddressStr = MidnightBech32m.encode(networkId, shieldedAddress).toString();

    console.log('─── Stealth wallet ─────────────────────────────────────────────');
    console.log('');
    console.log(`Stealth address : ${stealthAddressStr}`);
    console.log('');

    // ── Build stealth wallet ──────────────────────────────────────────────────
    //
    // The shielded component uses stealthSecretKeys to detect the note.
    // The dust/unshielded components use stealthSeed as a dummy; they hold no
    // real balance and are only needed to satisfy the WalletFacade API.
    // For the sweep step (below), the user's real mnemonic replaces the dummy
    // keys so that Alice's dust wallet pays the fees.

    const dummyDustKey  = ledger.DustSecretKey.fromSeed(stealthSeed);
    const dummyKeystore = createKeystore(stealthSeed, networkId);
    const cfg           = walletConfig(networkId);

    const shieldedWallet   = ShieldedWallet(cfg).startWithSecretKeys(stealthSecretKeys);
    const unshieldedWallet = UnshieldedWallet({
      networkId,
      indexerClientConnection: cfg.indexerClientConnection,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    }).startWithPublicKey(PublicKey.fromKeyStore(dummyKeystore));
    const dustWallet = DustWallet({
      ...cfg,
      costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    }).startWithSecretKey(dummyDustKey, ledger.LedgerParameters.initialParameters().dust);

    const stealthWallet = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
    await stealthWallet.start(stealthSecretKeys, dummyDustKey);

    // ── Sync ─────────────────────────────────────────────────────────────────

    process.stdout.write('Syncing stealth wallet');
    await rx.firstValueFrom(
      stealthWallet.state().pipe(
        rx.throttleTime(5_000),
        rx.tap(() => process.stdout.write(' .')),
        rx.filter((s: any) => s.isSynced === true),
        rx.timeout({
          first: 5 * 60 * 1000,
          with: () => rx.throwError(() => new Error('Timed out')),
        }),
      ),
    );
    console.log('\nSynced!\n');

    // ── Detect ───────────────────────────────────────────────────────────────

    const detectState = await rx.firstValueFrom(stealthWallet.state());
    printBalances(detectState);
    const shieldedBals  = Object.entries((detectState as any).shielded.balances as Record<string, bigint>)
      .filter(([, amt]) => amt > 0n);

    console.log('─── Shielded balances at stealth address ───────────────────────');
    console.log('');
    if (shieldedBals.length === 0) {
      console.log('(none — no coins detected)');
      console.log('');
      console.log('If Bob sent recently, wait a few blocks and re-run.');
      await stealthWallet.stop();
      return;
    }

    for (const [tokenType, amount] of shieldedBals) {
      console.log(`  ${tokenType}: ${amount}`);
    }
    console.log('');

    // ── Sweep ────────────────────────────────────────────────────────────────

    const doSweep = await rl.question('Sweep all detected coins to your real wallet? [y/N] ');
    if (doSweep.trim().toLowerCase() !== 'y') {
      await stealthWallet.stop();
      return;
    }
    console.log('');

    // Alice's real mnemonic provides dust (fees) and unshielded signing.
    const mn = await readMnemonic(rl, 'Enter your mnemonic (for fees): ');
    const aliceSeedHex = await mnemonicToHexSeed(mn);

    const hdWallet = HDWallet.fromSeed(Buffer.from(aliceSeedHex, 'hex'));
    if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
    const hdResult = hdWallet.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
      .deriveKeysAt(0);
    if (hdResult.type !== 'keysDerived') throw new Error('Key derivation failed');
    const aliceKeys = hdResult.keys;
    hdWallet.hdWallet.clear();

    const aliceDustKey     = ledger.DustSecretKey.fromSeed(aliceKeys[Roles.Dust]);
    const aliceRealKeys    = ledger.ZswapSecretKeys.fromSeed(aliceKeys[Roles.Zswap]);
    const aliceKeystore    = createKeystore(aliceKeys[Roles.NightExternal], networkId);

    // Alice's real shielded address (sweep destination)
    const aliceShieldedAddress = new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(aliceRealKeys.coinPublicKey),
      ShieldedEncryptionPublicKey.fromHexString(aliceRealKeys.encryptionPublicKey),
    );
    const aliceAddressStr = MidnightBech32m.encode(networkId, aliceShieldedAddress).toString();

    console.log('');
    console.log(`Sweep destination: ${aliceAddressStr}`);
    console.log('');

    // Build a sweep wallet: stealth shielded keys + Alice's real dust/unshielded.
    // This wallet can spend the stealth note (stealthSecretKeys) and pay fees
    // from Alice's real dust balance (aliceDustKey).

    const sweepShieldedWallet = ShieldedWallet(cfg).startWithSecretKeys(stealthSecretKeys);
    const sweepUnshieldedWallet = UnshieldedWallet({
      networkId,
      indexerClientConnection: cfg.indexerClientConnection,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    }).startWithPublicKey(PublicKey.fromKeyStore(aliceKeystore));
    const sweepDustWallet = DustWallet({
      ...cfg,
      costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    }).startWithSecretKey(aliceDustKey, ledger.LedgerParameters.initialParameters().dust);

    const sweepWallet = new WalletFacade(sweepShieldedWallet, sweepUnshieldedWallet, sweepDustWallet);
    await sweepWallet.start(stealthSecretKeys, aliceDustKey);

    process.stdout.write('Syncing sweep wallet');
    await rx.firstValueFrom(
      sweepWallet.state().pipe(
        rx.throttleTime(5_000),
        rx.tap(() => process.stdout.write(' .')),
        rx.filter((s: any) => s.isSynced === true),
        rx.timeout({
          first: 5 * 60 * 1000,
          with: () => rx.throwError(() => new Error('Timed out')),
        }),
      ),
    );
    console.log('\nSynced!\n');

    // Transfer all detected tokens to Alice's real address.
    for (const [tokenType, amount] of shieldedBals) {
      console.log(`Sweeping ${amount} of ${tokenType} → Alice's real wallet...`);
      try {
        const txRecipe = await sweepWallet.transferTransaction(
          [
            {
              type: 'shielded',
              outputs: [{ type: tokenType, amount, receiverAddress: aliceAddressStr }],
            },
          ],
          { shieldedSecretKeys: stealthSecretKeys, dustSecretKey: aliceDustKey },
          { ttl: new Date(Date.now() + 30 * 60 * 1000) },
        );

        const signedRecipe = await sweepWallet.signRecipe(txRecipe, (payload) =>
          aliceKeystore.signData(payload),
        );
        const finalizedTx = await sweepWallet.finalizeRecipe(signedRecipe);
        const txId = await sweepWallet.submitTransaction(finalizedTx);
        console.log(`  ✅ Swept. Transaction: ${txId}`);
      } catch (e) {
        console.error(`  ❌ Sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    console.log('');
    console.log('Done. Run "npm run balance" to confirm arrival in your real wallet.');

    await stealthWallet.stop();
    await sweepWallet.stop();

  } finally {
    rl.close();
  }
}

main().catch(console.error);
