// Shared probe plumbing: faucet mint → derived on-chain colour → vault
// deposit → client-side coin capture, plus the recipient-wallet accessors
// the probes use as their judge.

import { randomBytes } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { rawTokenType, encodeRawTokenType } from '@midnight-ntwrk/ledger-v8';

import { sleep, step } from './runner.js';
import {
  deployFaucet,
  deployVault,
  setupWallet,
  type TestContext,
  type FaucetHandle,
} from '../node/setup.js';
import { coinPublicKeyBytes } from '../node/wallet.js';
import { Vault } from '../wallet/vault.js';
import { candidateIndices } from '../wallet/capture.js';
import { hexToBytes32, anyToHex } from '../wallet/hex.js';

export interface PlainCoin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

export interface MintedCoin extends PlainCoin {
  mintTx: string;
  faucetAddress: string;
}

// ── Wallet accessors ────────────────────────────────────────────────────────

export async function walletState(ctx: TestContext): Promise<any> {
  return firstValueFrom(ctx.walletCtx.wallet.state());
}

/** The 32-byte Zswap coin public key, as the circuit argument expects it. */
export async function coinPublicKey(ctx: TestContext): Promise<Uint8Array> {
  return coinPublicKeyBytes(await walletState(ctx));
}

/** The hex coin public key and encryption public key, as the SDK maps them. */
export async function walletKeys(ctx: TestContext): Promise<{ cpk: string; epk: string }> {
  const st = await walletState(ctx);
  return {
    cpk: st.shielded.coinPublicKey.toHexString(),
    epk: st.shielded.encryptionPublicKey.toHexString(),
  };
}

/**
 * Every coin this wallet's OWN scan is holding. This is the judge: no
 * out-of-band hint, no watchFor, no application-layer inbox — just what an
 * unmodified wallet found by scanning the chain.
 */
export async function scannedCoins(ctx: TestContext): Promise<any[]> {
  const st = await walletState(ctx);
  return [
    ...((st.shielded?.availableCoins ?? []) as any[]),
    ...((st.shielded?.pendingCoins ?? []) as any[]),
  ];
}

const bare = anyToHex;

/** Did this wallet's own scan find the coin with this nonce? */
export async function discovered(ctx: TestContext, nonce: unknown): Promise<boolean> {
  const target = bare(nonce);
  return (await scannedCoins(ctx)).some((c) => bare(c?.coin?.nonce) === target);
}

export async function shieldedBalance(ctx: TestContext, color: Uint8Array): Promise<bigint> {
  const target = bare(color);
  let total = 0n;
  for (const c of await scannedCoins(ctx)) {
    const t = c?.coin?.type ?? c?.coin?.color;
    if (bare(t) === target) total += BigInt(c?.coin?.value ?? 0n);
  }
  return total;
}

// ── Funding ─────────────────────────────────────────────────────────────────

/** Faucet-mint `amount` of a contract-scoped colour to a wallet. */
export async function mintToWallet(
  ctx: TestContext,
  faucet: FaucetHandle,
  colorSeedHex: string,
  amount: bigint,
): Promise<MintedCoin> {
  const colorSeed = hexToBytes32(colorSeedHex);
  const nonce = new Uint8Array(randomBytes(32));
  const cpk = await coinPublicKey(ctx);
  const mintTx = await faucet.mint(colorSeed, amount, nonce, cpk);
  const color = encodeRawTokenType(rawTokenType(colorSeed, faucet.address));
  console.log(`  mintTx = ${mintTx}`);
  console.log('  waiting 15s for the wallet to index the minted note...');
  await sleep(15_000);
  return { nonce, color, value: amount, mintTx, faucetAddress: faucet.address };
}

export interface CapturedDeposit {
  depositTx: string;
  candidates: bigint[];
}

/** Deposit a coin into the vault and capture its candidate mt_index values. */
export async function depositAndCapture(
  vault: Vault,
  coin: PlainCoin,
): Promise<CapturedDeposit> {
  const { txId } = await vault.deposit({
    nonce: coin.nonce,
    color: coin.color,
    value: coin.value,
  });
  console.log(`  depositTx = ${txId}`);
  console.log('  waiting 10s for the indexer to settle the deposit block...');
  await sleep(10_000);
  const { candidates } = await candidateIndices(txId);
  if (!candidates.length) throw new Error('deposit transaction has no commitment window');
  console.log(`  mt_index candidates = [${candidates.join(', ')}]`);
  await vault.putCoin({ ...coin, mtIndex: candidates[0] });
  return { depositTx: txId, candidates };
}

export interface Stage {
  ctx: TestContext;
  faucet: FaucetHandle;
  vault: Vault;
  /** The recipient: a genuinely separate wallet, its own seed and keys. */
  recipient: TestContext;
}

/**
 * Wallet A funds and owns the vault. Wallet B is the recipient — a distinct
 * seed, a distinct wallet process, never told anything out of band.
 */
export async function stage(colorSeedHex: string, fund: bigint): Promise<Stage & {
  coin: MintedCoin;
  deposit: CapturedDeposit;
}> {
  step('setup: wallet A (executor), the vault, and wallet B (the recipient)');
  const ctx = await setupWallet(process.env.WALLET_SEED, 'wallet-A');
  const faucet = await deployFaucet(ctx.walletCtx);
  console.log(`  faucet @ ${faucet.address}`);
  const vault = await deployVault(ctx);
  console.log(`  vault  @ ${vault.address}`);

  const seedB = process.env.WALLET_SEED_SECONDARY;
  if (!seedB) throw new Error('WALLET_SEED_SECONDARY env var required');
  const recipient = await setupWallet(seedB, 'wallet-B');

  step('fund the vault: mint to A, deposit, capture');
  const coin = await mintToWallet(ctx, faucet, colorSeedHex, fund);
  const deposit = await depositAndCapture(vault, coin);

  return { ctx, faucet, vault, recipient, coin, deposit };
}
