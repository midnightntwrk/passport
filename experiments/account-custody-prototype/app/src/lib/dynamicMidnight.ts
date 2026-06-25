import { firstValueFrom } from 'rxjs';

import type { AppContext } from '../App.js';
import { bytesToHex } from '../../../src/wallet/hex.js';
import { CONFIG, userAddressBytes } from './providers.js';

export const DYNAMIC_MIDNIGHT_IMPORT =
  'import { MidnightWalletConnectors } from "@dynamic-labs/midnight";';

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

function keyHex(key: unknown): string {
  if (typeof key === 'string') return key.replace(/^0x/, '');
  if (key && typeof (key as { toHexString?: () => string }).toHexString === 'function') {
    return (key as { toHexString: () => string }).toHexString().replace(/^0x/, '');
  }
  if (key && (key as { bytes?: Uint8Array }).bytes instanceof Uint8Array) {
    return bytesToHex((key as { bytes: Uint8Array }).bytes);
  }
  return String(key ?? '').replace(/^0x/, '');
}

function dustPublicKeyHex(publicKey: bigint): string {
  const hex = publicKey.toString(16);
  return hex.length % 2 === 0 ? hex : `0${hex}`;
}

function formatConnectorAddress(type: 'addr' | 'shield-addr' | 'dust', payloadHex: string): string {
  // Browser-safe display surface for the Dynamic demo. The real
  // @dynamic-labs/midnight connector returns address strings from these same
  // public-key surfaces; this avoids pulling the Node-oriented formatter into
  // the Vite tab.
  return `mn_${type}_${CONFIG.networkId}1${payloadHex}`;
}

function sumNight(ctx: Pick<AppContext, 'ledger'>): bigint {
  return ctx.ledger ? [...ctx.ledger.night_balances].reduce((sum, [, v]) => sum + v, 0n) : 0n;
}

function sumShielded(ctx: Pick<AppContext, 'ledger'>): bigint {
  return ctx.ledger ? [...ctx.ledger.coins].reduce((sum, [, q]) => sum + q.value, 0n) : 0n;
}

function readDustBalance(walletState: any): bigint {
  const candidates = [
    walletState?.dust?.balance,
    walletState?.dust?.balances?.total,
    walletState?.balances?.dust,
  ];
  for (const value of candidates) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  }
  return 0n;
}

export async function loadDynamicMidnightState(ctx: AppContext): Promise<DynamicMidnightState> {
  const walletState: any = await firstValueFrom(ctx.mid.walletCtx.wallet.state());
  const shieldedCoinPublicKey = keyHex(walletState.shielded?.coinPublicKey);
  const shieldedEncryptionPublicKey = keyHex(walletState.shielded?.encryptionPublicKey);
  const unshieldedAddressHex = bytesToHex(userAddressBytes(ctx.mid.walletCtx));
  const dustAddressHex = dustPublicKeyHex(ctx.mid.walletCtx.dustSecretKey.publicKey);

  return {
    addresses: {
      unshieldedAddress: formatConnectorAddress('addr', unshieldedAddressHex),
      shieldedAddress: formatConnectorAddress(
        'shield-addr',
        `${shieldedCoinPublicKey}${shieldedEncryptionPublicKey}`,
      ),
      shieldedCoinPublicKey,
      shieldedEncryptionPublicKey,
      dustAddress: formatConnectorAddress('dust', dustAddressHex),
    },
    balances: {
      unshielded: {
        symbol: 'NIGHT',
        tokenKey: UNSHIELDED_NIGHT_TOKEN_KEY,
        decimals: 6,
        amount: sumNight(ctx).toString(),
      },
      shielded: {
        symbol: 'shielded NIGHT',
        tokenKey: SHIELDED_NIGHT_TOKEN_KEY,
        decimals: 6,
        amount: sumShielded(ctx).toString(),
      },
      dust: {
        symbol: 'DUST',
        tokenKey: 'DUST',
        decimals: 15,
        amount: readDustBalance(walletState).toString(),
      },
    },
    importLine: DYNAMIC_MIDNIGHT_IMPORT,
    socialAuthStatus:
      'Embedded social-auth Midnight wallet state is pending rollout; use the 1am connector path today.',
  };
}
