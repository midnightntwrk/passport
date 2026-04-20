import type { Interface } from 'node:readline/promises';
import * as rx from 'rxjs';
import * as bip39 from 'bip39';
import { Buffer } from 'node:buffer';
import { ZswapChainState, ZswapSecretKeys, DustSecretKey } from '@midnight-ntwrk/ledger-v7';
import { ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, DustAddress, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';

import { deriveKeys, createWallet } from './utils.js';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { Roles } from '@midnight-ntwrk/wallet-sdk-hd';

// Workaround for ledger-v7 7.0.0/7.0.1 bug: MerkleTree::collapse panics on non-empty
// trees when producing shielded outputs. See: https://github.com/geofflittle/tryapply-crash-repro
const _origTryApply = ZswapChainState.prototype.tryApply;
ZswapChainState.prototype.tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()];
  }
};

export function hexToBytes32(hex: string): Uint8Array {
  const cleanHex = hex.replace(/^0x/, '');
  const buffer = Buffer.from(cleanHex, 'hex');
  const bytes = new Uint8Array(32);
  bytes.set(buffer.subarray(0, Math.min(32, buffer.length)));
  return bytes;
}

export async function readMnemonic(rl: Interface, prompt: string): Promise<string> {
  while (true) {
    const mn = (await rl.question(prompt)).trim();
    const words = mn.split(/\s+/);
    if (words.length !== 24) {
      console.error(`Error: expected 24 words, got ${words.length}. Please try again.`);
      continue;
    }
    if (!bip39.validateMnemonic(mn)) {
      console.error('Error: invalid mnemonic (bad checksum or unknown words). Please try again.');
      continue;
    }
    await printAddresses(mn);
    return mn;
  }
}

async function printAddresses(mnemonic: string): Promise<void> {
  const seed = await bip39.mnemonicToSeed(mnemonic).then((x) => x.toString('hex'));
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();

  const unshieldedAddress = createKeystore(keys[Roles.NightExternal], networkId).getBech32Address();

  const zswapKeys = ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const shieldedAddress = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(zswapKeys.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(zswapKeys.encryptionPublicKey),
  );
  const shieldedAddressStr = MidnightBech32m.encode(networkId, shieldedAddress).toString();

  const dustKey = DustSecretKey.fromSeed(keys[Roles.Dust]);
  const dustAddressStr = DustAddress.encodePublicKey(networkId, dustKey.publicKey);

  console.log('');
  console.log('--- Account Addresses ---');
  console.log('');
  console.log(`Unshielded : ${unshieldedAddress}`);
  console.log(`Shielded   : ${shieldedAddressStr}`);
  console.log(`Dust       : ${dustAddressStr}`);
  console.log('');
}

export async function mnemonicToHexSeed(mnemonic: string): Promise<string> {
  return bip39.mnemonicToSeed(mnemonic).then((x) => x.toString('hex'));
}

export async function syncWallet(
  walletCtx: Awaited<ReturnType<typeof createWallet>>,
  label: string,
): Promise<void> {
  process.stdout.write(`Syncing ${label} to network`);
  await rx.firstValueFrom(
    walletCtx.wallet.state().pipe(
      rx.throttleTime(5_000),
      rx.tap(() => process.stdout.write(' .')),
      rx.filter((state) => state.isSynced === true),
    ),
  );
  console.log('\nWallet Synced!');
}

export function printBalances(state: any): void {
  console.log('--- Wallet Balances ---');
  console.log('');
  console.log('Shielded:');
  const shieldedBalances = Object.entries(state.shielded.balances as Record<string, bigint>);
  if (shieldedBalances.length === 0) {
    console.log('(none)');
  } else {
    for (const [token, amount] of shieldedBalances) {
      console.log(`${token}: ${amount}`);
    }
  }
  console.log('');
  console.log('Unshielded:');
  const unshieldedBalances = Object.entries(state.unshielded.balances as Record<string, bigint>);
  if (unshieldedBalances.length === 0) {
    console.log('(none)');
  } else {
    for (const [token, amount] of unshieldedBalances) {
      console.log(`${token}: ${amount}`);
    }
  }
  console.log('');
  console.log(`Dust: ${state.dust.walletBalance(new Date())}`);
  console.log('');
}
