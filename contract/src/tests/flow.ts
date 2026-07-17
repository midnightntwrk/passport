// Shared conformance-suite plumbing: faucet mint → derived on-chain color →
// shielded deposit with InboxEntry → client-side coin capture. Kept out of
// the individual suites so each file reads as its scenario.

import { randomBytes } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { rawTokenType, encodeRawTokenType } from '@midnight-ntwrk/ledger-v8';

import { sleep, step } from './runner.js';
import {
  deployFaucet,
  deployAccount,
  setupWallet,
  type TestContext,
  type FaucetHandle,
} from '../node/setup.js';
import { coinPublicKeyBytes } from '../node/wallet.js';
import { CustodyAccount } from '../wallet/account.js';
import { Device } from '../wallet/signer.js';
import {
  generateEncKeyPair,
  sealInboxEntry,
  type EncKeyPair,
  type PlainCoin,
} from '../wallet/inbox.js';
import { candidateIndices, type TxPosition } from '../wallet/capture.js';
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

/** Faucet-mint `amount` of a contract-scoped color to the user's wallet. */
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
  const color = encodeRawTokenType(rawTokenType(colorSeed, faucet.address));
  console.log(`  mintTx = ${mintTx}`);
  console.log('  waiting 15s for the wallet to index the minted note...');
  await sleep(15_000);
  return { nonce, color, value: amount, mintTx, faucetAddress: faucet.address, colorSeedHex };
}

export interface AccountSetup {
  ctx: TestContext;
  faucet: FaucetHandle;
  account: CustodyAccount;
  device: Device;
  encKeys: EncKeyPair;
}

export async function standardSetup(): Promise<AccountSetup> {
  step('setup: wallet, faucet, account contract (one device, fresh enc key)');
  const ctx = await setupWallet();
  const faucet = await deployFaucet(ctx.walletCtx);
  console.log(`  faucet  @ ${faucet.address}`);
  const device = Device.generate();
  const encKeys = generateEncKeyPair();
  const account = await deployAccount(ctx, device, encKeys);
  console.log(`  account @ ${account.address}`);
  return { ctx, faucet, account, device, encKeys };
}

export interface CapturedDeposit {
  depositTx: string;
  /** Candidate commitment-tree positions, first recorded in the store. */
  candidates: bigint[];
  position: TxPosition;
}

/**
 * Deposit a coin through deposit_shielded and capture its qualified
 * description into the wallet-local store: InboxEntry sealed to the account
 * key, candidate mt_index values recovered from the depositing
 * transaction's position window (MIP-0012 §6.2, §6.5). Where the window
 * holds several commitments (the funding wallet may add its own change
 * output), disambiguation is by candidate retry at spend time — a wrong
 * qualified description fails at proving and cannot mis-spend (INV-5).
 */
export async function depositAndCapture(
  account: CustodyAccount,
  encKeys: EncKeyPair,
  coin: PlainCoin,
): Promise<CapturedDeposit> {
  const entry = sealInboxEntry(encKeys.publicKey, coin);
  const { txId } = await account.depositShielded(
    { nonce: coin.nonce, color: coin.color, value: coin.value },
    entry,
  );
  console.log(`  depositTx = ${txId}`);
  console.log('  waiting 10s for the indexer to settle the deposit block...');
  await sleep(10_000);
  const { candidates, position } = await candidateIndices(txId);
  if (!candidates.length) throw new Error('deposit transaction has no commitment window');
  console.log(`  mt_index candidates = [${candidates.join(', ')}] (${position.status})`);
  await account.putCoin({ ...coin, mtIndex: candidates[0] });
  return { depositTx: txId, candidates, position };
}

/**
 * Persist a spend's surviving change per the §6.3 rule and backfill its
 * inbox entry (INV-3, INV-4): record candidate positions from the spend
 * transaction's window, record the coin, append the entry under the
 * account key.
 */
export async function captureChange(
  account: CustodyAccount,
  device: Device,
  encKeys: EncKeyPair,
  spendTxId: string,
  change: PlainCoin,
): Promise<CapturedDeposit> {
  console.log('  waiting 10s for the indexer to settle the spend block...');
  await sleep(10_000);
  const { candidates, position } = await candidateIndices(spendTxId);
  if (!candidates.length) throw new Error('spend transaction has no commitment window');
  console.log(`  change mt_index candidates = [${candidates.join(', ')}]`);
  await account.putCoin({ ...change, mtIndex: candidates[0] });
  const entry = sealInboxEntry(encKeys.publicKey, change);
  const { txId } = await account.appendInbox(device, entry);
  console.log(`  inbox backfill tx = ${txId}`);
  return { depositTx: txId, candidates, position };
}

export interface RetrySpendOutcome {
  txId: string;
  change: PlainCoin | null;
  mtIndex: bigint;
  attempts: Array<{ mtIndex: string; outcome: string }>;
}

/**
 * Spend a held coin, resolving its mt_index by candidate retry (§6.5): put
 * each candidate into the store and attempt the authorised spend; a wrong
 * candidate fails at proving with no transaction (INV-5).
 */
export async function withdrawShieldedWithRetry(
  account: CustodyAccount,
  device: Device,
  recipient: Uint8Array,
  coin: PlainCoin,
  amount: bigint,
  candidates: bigint[],
): Promise<RetrySpendOutcome> {
  const attempts: Array<{ mtIndex: string; outcome: string }> = [];
  for (const idx of candidates) {
    await account.putCoin({ ...coin, mtIndex: idx });
    try {
      const r = await account.withdrawShielded(device, recipient, coin.color, amount);
      attempts.push({ mtIndex: idx.toString(), outcome: `accepted: ${r.txId}` });
      return {
        txId: r.txId,
        change: r.change
          ? { nonce: r.change.nonce, color: r.change.color, value: r.change.value }
          : null,
        mtIndex: idx,
        attempts,
      };
    } catch (e: any) {
      attempts.push({ mtIndex: idx.toString(), outcome: `rejected: ${String(e?.message).slice(0, 80)}` });
    }
  }
  throw new Error(
    `no candidate mt_index produced an accepted spend: ${JSON.stringify(attempts)}`,
  );
}

/** Expect a call to abort; returns the error message. */
export async function expectAbort(label: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.log(`  ✓ rejected: ${label} — ${msg.slice(0, 120)}`);
    return msg;
  }
  throw new Error(`expected rejection did not happen: ${label}`);
}
