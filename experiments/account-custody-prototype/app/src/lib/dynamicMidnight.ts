import { WalletAddressType } from '@dynamic-labs/sdk-api-core';

import type { AppContext } from '../App.js';

export const DYNAMIC_MIDNIGHT_IMPORT =
  'import { DynamicWaasMidnightConnectors } from "@dynamic-labs/midnight";';

export const UNSHIELDED_NIGHT_TOKEN_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';
export const SHIELDED_NIGHT_TOKEN_KEY = '488bcd...';

export interface DynamicAddressSurfaces {
  unshieldedAddress: string;
  shieldedAddress: string;
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
  dustAddress: string;
}

export interface DynamicBalanceSurfaces {
  unshielded: {
    symbol: 'NIGHT';
    tokenKey: string;
    decimals: 6;
    amount: string;
  };
  shielded: {
    symbol: 'shielded NIGHT';
    tokenKey: string;
    decimals: 6;
    amount: string;
  };
  dust: {
    symbol: 'DUST';
    tokenKey: 'DUST';
    decimals: 15;
    amount: string;
  };
}

export interface DynamicMidnightState {
  addresses: DynamicAddressSurfaces;
  balances: DynamicBalanceSurfaces;
  importLine: string;
  socialAuthStatus: string;
}

function sumRecord(record?: Record<string, bigint>): bigint {
  if (!record) return 0n;
  return Object.values(record).reduce((sum, value) => sum + value, 0n);
}

function publicKeyParts(publicKey?: string): {
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
} {
  if (!publicKey) return { shieldedCoinPublicKey: '', shieldedEncryptionPublicKey: '' };
  const half = Math.floor(publicKey.length / 2);
  return {
    shieldedCoinPublicKey: publicKey.slice(0, half),
    shieldedEncryptionPublicKey: publicKey.slice(half),
  };
}

export async function loadDynamicMidnightState(ctx: AppContext): Promise<DynamicMidnightState> {
  const wallet = ctx.dynamicWallet;
  if (!wallet) throw new Error('Dynamic Midnight wallet is not connected');

  const shielded = wallet.additionalAddresses.find(
    (address) => address.type === WalletAddressType.MidnightShielded,
  );
  const dust = wallet.additionalAddresses.find(
    (address) => address.type === WalletAddressType.MidnightDust,
  );
  const keyParts = publicKeyParts(shielded?.publicKey);

  const formatted = await wallet.getFormattedBalances().catch(() => null);
  const raw = await wallet.getBalances().catch(() => null);
  const firstShieldedToken = raw ? Object.keys(raw.shielded)[0] : undefined;

  return {
    addresses: {
      unshieldedAddress: wallet.address,
      shieldedAddress: shielded?.address ?? '',
      shieldedCoinPublicKey: keyParts.shieldedCoinPublicKey,
      shieldedEncryptionPublicKey: keyParts.shieldedEncryptionPublicKey,
      dustAddress: dust?.address ?? '',
    },
    balances: {
      unshielded: {
        symbol: 'NIGHT',
        tokenKey: UNSHIELDED_NIGHT_TOKEN_KEY,
        decimals: 6,
        amount:
          formatted?.unshieldedBalance ??
          (raw ? (raw.unshielded[UNSHIELDED_NIGHT_TOKEN_KEY] ?? sumRecord(raw.unshielded)).toString() : '0'),
      },
      shielded: {
        symbol: 'shielded NIGHT',
        tokenKey: firstShieldedToken ?? SHIELDED_NIGHT_TOKEN_KEY,
        decimals: 6,
        amount: raw ? sumRecord(raw.shielded).toString() : String(formatted?.shieldedTokenCount ?? 0),
      },
      dust: {
        symbol: 'DUST',
        tokenKey: 'DUST',
        decimals: 15,
        amount: formatted?.dustBalance?.balance ?? raw?.dust.balance.toString() ?? '0',
      },
    },
    importLine: DYNAMIC_MIDNIGHT_IMPORT,
    socialAuthStatus:
      'Dynamic embedded wallet connected; MN Passport is using its wallet object for address, balance, and authorization surfaces.',
  };
}
