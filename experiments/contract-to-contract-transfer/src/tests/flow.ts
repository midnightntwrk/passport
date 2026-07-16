// Shared probe plumbing: faucet mint → derived on-chain colour → stateless
// deposit with encrypted blob → client-side QSCI capture. Kept out of the
// individual runners so each probe file reads as its scenario.

import { randomBytes } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { rawTokenType, encodeRawTokenType } from '@midnight-ntwrk/ledger-v8';

import { sleep, step } from './runner.js';
import { deployFaucet, deployCustody, setupWallet, type TestContext, type FaucetHandle } from '../node/setup.js';
import { coinPublicKeyBytes } from '../node/wallet.js';
import { StatelessCustody } from '../wallet/custody.js';
import {
  generateEncKeyPair,
  encryptCoinBlob,
  mtIndexForSingleOutput,
  type EncKeyPair,
  type PlainCoin,
  type TxPosition,
} from '../wallet/coinstore.js';
import { hexToBytes32 } from '../wallet/hex.js';

export interface MintedCoin extends PlainCoin {
  mintTx: string;
  faucetAddress: string;
  colorSeedHex: string;
}

export async function userCoinPublicKey(ctx: TestContext): Promise<Uint8Array> {
  const state: any = await firstValueFrom(ctx.walletCtx.wallet.state());
  return coinPublicKeyBytes(state);
}

/** Faucet-mint `amount` of a contract-scoped colour to the user's wallet. */
export async function mintToUser(
  ctx: TestContext,
  faucet: FaucetHandle,
  colorSeedHex: string,
  amount: bigint,
): Promise<MintedCoin> {
  const colorSeed = hexToBytes32(colorSeedHex);
  const nonce = new Uint8Array(randomBytes(32));
  const cpk = await userCoinPublicKey(ctx);
  const mintTx = await faucet.mint(colorSeed, amount, nonce, cpk);
  // On-chain colour is the contract-scoped derivation of the seed.
  const color = encodeRawTokenType(rawTokenType(colorSeed, faucet.address));
  console.log(`  mintTx = ${mintTx}`);
  console.log('  waiting 15s for the wallet to index the minted note...');
  await sleep(15_000);
  return { nonce, color, value: amount, mintTx, faucetAddress: faucet.address, colorSeedHex };
}

export interface PairSetup {
  ctx: TestContext;
  faucet: FaucetHandle;
  /** The paying account. */
  custodyA: StatelessCustody;
  encKeysA: EncKeyPair;
  /** The receiving account. */
  custodyB: StatelessCustody;
  encKeysB: EncKeyPair;
}

export async function pairSetup(): Promise<PairSetup> {
  step('setup: wallet, faucet, custody contracts A (payer) and B (payee)');
  const ctx = await setupWallet();
  const faucet = await deployFaucet(ctx.walletCtx);
  console.log(`  faucet    @ ${faucet.address}`);
  const encKeysA = generateEncKeyPair();
  const custodyA = await deployCustody(ctx, encKeysA, 'custodyA');
  console.log(`  custody A @ ${custodyA.address}`);
  const encKeysB = generateEncKeyPair();
  const custodyB = await deployCustody(ctx, encKeysB, 'custodyB');
  console.log(`  custody B @ ${custodyB.address}`);
  return { ctx, faucet, custodyA, encKeysA, custodyB, encKeysB };
}

/** Fund custody A with a coin it can later spend: mint → deposit → capture. */
export async function fundA(
  s: PairSetup,
  colorSeedHex: string,
  amount: bigint,
): Promise<{ coin: MintedCoin; deposit: CapturedDeposit }> {
  const coin = await mintToUser(s.ctx, s.faucet, colorSeedHex, amount);
  const deposit = await depositAndCapture(
    { ctx: s.ctx, custody: s.custodyA, encKeys: s.encKeysA },
    coin,
  );
  return { coin, deposit };
}

export interface CapturedDeposit {
  depositTx: string;
  mtIndex: bigint;
  position: TxPosition;
}

/**
 * Deposit a coin through the stateless path and capture its QSCI into the
 * wallet-local store: blob encrypted to the account key, mt_index recovered
 * from the indexer (single-output inference), coin recorded via putCoin.
 */
export async function depositAndCapture(
  s: { ctx: TestContext; custody: StatelessCustody; encKeys: EncKeyPair },
  coin: PlainCoin,
): Promise<CapturedDeposit> {
  const blob = encryptCoinBlob(s.encKeys.publicKey, coin);
  const { txId } = await s.custody.depositStateless(
    { nonce: coin.nonce, color: coin.color, value: coin.value },
    blob,
  );
  console.log(`  depositTx = ${txId}`);
  console.log('  waiting 10s for the indexer to settle the deposit block...');
  await sleep(10_000);
  const { mtIndex, position } = await mtIndexForSingleOutput(txId);
  console.log(`  mt_index = ${mtIndex} (indexer startIndex, ${position.status})`);
  await s.custody.putCoin({ ...coin, mtIndex });
  return { depositTx: txId, mtIndex, position };
}
