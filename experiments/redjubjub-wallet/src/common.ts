import type { Interface } from 'node:readline/promises';
import * as rx from 'rxjs';
import * as bip39 from 'bip39';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import { ZswapChainState, ZswapSecretKeys, DustSecretKey } from '@midnight-ntwrk/ledger-v8';
import { ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, DustAddress, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';

import { deriveKeys, createWallet } from './utils.js';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { Roles } from '@midnight-ntwrk/wallet-sdk-hd';

// JubJub scalar field order.
export const JUBJUB_R = BigInt('0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7');

// Workaround for ledger-v8 bug: MerkleTree::collapse panics on non-empty
// trees when producing shielded outputs.
const _origTryApply = ZswapChainState.prototype.tryApply;
ZswapChainState.prototype.tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()];
  }
};

// Rejection-sampling random JubJub scalar, uniformly in [1, JUBJUB_R - 1].
export function randomJubjubScalar(): bigint {
  while (true) {
    const candidate = BigInt('0x' + randomBytes(32).toString('hex'));
    if (candidate > 0n && candidate < JUBJUB_R) return candidate;
  }
}

// Convert little-endian bytes to bigint.
export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]);
  return r;
}

// Convert bigint to 0x-prefixed big-endian hex string, zero-padded to 64 chars.
export function bigIntToHex(value: bigint): string {
  return '0x' + value.toString(16).padStart(64, '0');
}

// Convert bigint to 0x-prefixed little-endian hex string (for Rust/jubjub Fr).
export function bigIntToLeHex(value: bigint): string {
  const be = value.toString(16).padStart(64, '0');
  // Reverse byte pairs: "aabb" -> "bbaa"
  const le = be.match(/.{2}/g)!.reverse().join('');
  return '0x' + le;
}

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

/**
 * Get a wallet seed, either from the WALLET_SEED env var (32-byte hex, for
 * local devnet) or by prompting for a mnemonic (for preprod).
 *
 * If WALLET_SEED is set, returns it directly (no mnemonic needed).
 * Otherwise, prompts for a 24-word mnemonic and derives the seed.
 */
export async function getWalletSeed(rl: Interface): Promise<string> {
  const envSeed = process.env.WALLET_SEED;
  if (envSeed) {
    console.log('Using WALLET_SEED from environment');
    return envSeed;
  }
  const mn = await readMnemonic(rl, 'Enter your mnemonic: ');
  return mnemonicToHexSeed(mn);
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
  try {
    const dustState = state.dust;
    const bal = dustState?.capabilities?.coinsAndBalances?.getWalletBalance?.(dustState.state, new Date())
      ?? dustState?.walletBalance?.(new Date())
      ?? '(unknown)';
    console.log(`Dust: ${bal}`);
  } catch {
    console.log('Dust: (unable to read)');
  }
  console.log('');
}
