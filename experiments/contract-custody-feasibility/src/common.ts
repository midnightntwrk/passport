// Shared helpers — wallet creation, balance reading, evidence serialisation.
//
// Adapted from experiments/redjubjub-wallet/src/common.ts. All Schnorr- and
// JubJub-specific helpers are stripped: this experiment is about the
// custody surface, not signature verification.

import type { Interface } from 'node:readline/promises';
import * as rx from 'rxjs';
import * as bip39 from 'bip39';
import { Buffer } from 'node:buffer';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ZswapChainState, ZswapSecretKeys, DustSecretKey } from '@midnight-ntwrk/ledger-v8';
import {
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  DustAddress,
  MidnightBech32m,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import { deriveKeys, createWallet } from './utils.js';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { Roles } from '@midnight-ntwrk/wallet-sdk-hd';

// Workaround for ledger-v8 bug: MerkleTree::collapse panics on non-empty
// trees when producing shielded outputs. Inherited from redjubjub-wallet —
// drop on the day this issue is verified fixed and leave a comment in
// FINDINGS.md if so.
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

// Get a wallet seed, either from the WALLET_SEED env var (32-byte hex, for
// local devnet) or by prompting for a mnemonic (preprod). Use SECONDARY=true
// to switch to WALLET_SEED_SECONDARY for tests that need a second user.
export async function getWalletSeed(rl: Interface, secondary = false): Promise<string> {
  const envVar = secondary ? 'WALLET_SEED_SECONDARY' : 'WALLET_SEED';
  const envSeed = process.env[envVar];
  if (envSeed) {
    console.log(`Using ${envVar} from environment`);
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
    const bal =
      dustState?.capabilities?.coinsAndBalances?.getWalletBalance?.(dustState.state, new Date()) ??
      dustState?.walletBalance?.(new Date()) ??
      '(unknown)';
    console.log(`Dust: ${bal}`);
  } catch {
    console.log('Dust: (unable to read)');
  }
  console.log('');
}

// ─── Evidence file writer ────────────────────────────────────────────────────
//
// Every test case writes one JSON file under evidence/. The shape is fixed so
// FINDINGS.md can be regenerated mechanically.

export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'PENDING';

export interface Evidence {
  test: string;            // brief test ID, e.g. 'U1', 'S4'
  name: string;            // descriptive name, e.g. 'receive-unshielded'
  verdict: Verdict;
  txHash?: string;         // present when verdict === 'PASS'
  errorCode?: string;      // present when verdict === 'FAIL' (e.g. 'ledger-168')
  note: string;            // one-line summary
  evidence: Record<string, unknown>;  // full request/response/log payload
  ranAt: string;           // ISO timestamp
  sdkVersions: Record<string, string>;
  nodeVersion: string;
}

export function writeEvidence(testId: string, payload: Omit<Evidence, 'ranAt' | 'sdkVersions' | 'nodeVersion'>): string {
  const evidenceDir = resolve(dirname(new URL(import.meta.url).pathname), '..', 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const filePath = resolve(evidenceDir, `${testId.toLowerCase()}-${payload.name}.json`);
  const sdkVersions = readSdkVersions();
  const full: Evidence = {
    ...payload,
    ranAt: new Date().toISOString(),
    sdkVersions,
    nodeVersion: process.env.MIDNIGHT_NODE_IMAGE ?? 'midnightntwrk/midnight-node:0.22.0',
  };
  writeFileSync(filePath, JSON.stringify(full, null, 2) + '\n');
  return filePath;
}

function readSdkVersions(): Record<string, string> {
  const pkgPath = resolve(dirname(new URL(import.meta.url).pathname), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const out: Record<string, string> = {};
  for (const [name, version] of Object.entries(pkg.dependencies as Record<string, string>)) {
    if (name.startsWith('@midnight-ntwrk/')) out[name] = version;
  }
  return out;
}
