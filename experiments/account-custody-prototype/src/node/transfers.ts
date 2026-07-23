import * as Rx from 'rxjs';

import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { nativeToken, type RawTokenType } from '@midnight-ntwrk/ledger-v8';
import {
  MidnightBech32m,
  UnshieldedAddress,
  type UnshieldedAddress as UnshieldedAddressType,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import type { WalletContext } from './wallet.js';

export const NIGHT_RAW = nativeToken().raw;

export function unshieldedAddressOf(walletCtx: WalletContext): UnshieldedAddressType {
  const bech32 = walletCtx.unshieldedKeystore.getBech32Address();
  return UnshieldedAddress.codec.decode(
    getNetworkId() as any,
    bech32 as MidnightBech32m,
  );
}

export async function currentWalletState(walletCtx: WalletContext): Promise<any> {
  return Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.filter((state) => state.isSynced)),
  );
}

export function nightBalanceOf(state: any): bigint {
  return state.unshielded?.balances?.[NIGHT_RAW] ?? 0n;
}

export function shieldedBalanceOf(state: any, tokenType: RawTokenType): bigint {
  return state.shielded?.balances?.[tokenType] ?? 0n;
}

export function dustBalanceOf(state: any, at = new Date()): bigint {
  return state.dust
    ? state.dust.capabilities.coinsAndBalances.getWalletBalance(state.dust.state, at)
    : 0n;
}

export async function waitForWalletState(
  walletCtx: WalletContext,
  predicate: (state: any) => boolean,
  label: string,
  timeoutMs = 180_000,
): Promise<any> {
  try {
    return await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(
        Rx.throttleTime(2_000),
        Rx.filter((state) => state.isSynced && predicate(state)),
        Rx.timeout(timeoutMs),
      ),
    );
  } catch (error) {
    throw new Error(`Timed out waiting for wallet state: ${label}.`, { cause: error });
  }
}

export async function transferNight(
  sender: WalletContext,
  recipient: WalletContext,
  amount: bigint,
): Promise<string> {
  const senderBefore = nightBalanceOf(await currentWalletState(sender));
  const recipientBefore = nightBalanceOf(await currentWalletState(recipient));
  if (senderBefore < amount) {
    throw new Error(`Funding wallet has ${senderBefore} NIGHT units; ${amount} required.`);
  }

  const recipe = await sender.wallet.transferTransaction(
    [
      {
        type: 'unshielded',
        outputs: [
          {
            type: NIGHT_RAW,
            receiverAddress: unshieldedAddressOf(recipient),
            amount,
          },
        ],
      },
    ],
    {
      shieldedSecretKeys: sender.shieldedSecretKeys,
      dustSecretKey: sender.dustSecretKey,
    },
    { ttl: new Date(Date.now() + 30 * 60 * 1000) },
  );
  const signed = await sender.wallet.signRecipe(recipe, (payload) =>
    sender.unshieldedKeystore.signData(payload),
  );
  const finalized = await sender.wallet.finalizeRecipe(signed);
  const txId = await sender.wallet.submitTransaction(finalized);

  await waitForWalletState(
    recipient,
    (state) => nightBalanceOf(state) >= recipientBefore + amount,
    `recipient NIGHT balance >= ${recipientBefore + amount}`,
  );
  await waitForWalletState(
    sender,
    (state) => nightBalanceOf(state) <= senderBefore - amount,
    'funding transaction applied to sender',
  );
  return String(txId);
}

export async function registerNightForDust(walletCtx: WalletContext): Promise<string | null> {
  const state = await currentWalletState(walletCtx);
  const before = dustBalanceOf(state);
  const available =
    state.unshielded?.availableCoins?.filter(
      (coin: any) =>
        coin.utxo.type === NIGHT_RAW &&
        coin.meta.registeredForDustGeneration === false,
    ) ?? [];

  if (available.length === 0) {
    if (before > 0n) return null;
    throw new Error('Wallet has neither DUST nor an unregistered NIGHT UTXO.');
  }

  const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
    available,
    walletCtx.unshieldedKeystore.getPublicKey(),
    (payload) => walletCtx.unshieldedKeystore.signData(payload),
  );
  const finalized = await walletCtx.wallet.finalizeTransaction(recipe.transaction);
  const txId = await walletCtx.wallet.submitTransaction(finalized);
  await waitForWalletState(
    walletCtx,
    (next) => dustBalanceOf(next) > before,
    'DUST generation after NIGHT registration',
  );
  return String(txId);
}
