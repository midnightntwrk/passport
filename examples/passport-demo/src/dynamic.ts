import type { MidnightWallet, MidnightWalletConnector } from '@dynamic-labs/midnight';

type AddressStatus = 'loading' | 'ready' | 'partial';
type BalanceStatus = 'loading' | 'ready' | 'syncing' | 'unavailable';

export interface DynamicSurfaceState {
  unshieldedAddress: string;
  shieldedAddress: string | null;
  dustAddress: string | null;
  unshieldedBalance: string | null;
  shieldedTokenCount: number | null;
  dustBalance: string | null;
  dustSyncing: boolean;
  addressStatus: AddressStatus;
  balanceStatus: BalanceStatus;
  balanceError: string | null;
}

const MIDNIGHT_SHIELDED = 'midnight_shielded';
const MIDNIGHT_DUST = 'midnight_dust';
const ADDRESS_TIMEOUT_MS = 7_500;
const BALANCE_TIMEOUT_MS = 15_000;
const SIGN_TIMEOUT_MS = 180_000;
const SUBMIT_TIMEOUT_MS = 90_000;

function addressFromWallet(wallet: MidnightWallet, type: string): string | null {
  return wallet.additionalAddresses.find((address) => address.type === type)?.address ?? null;
}

function withTimeout<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
    operation.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Runs Dynamic's real WaaS/MPC transaction finalization. The returned value is
 * the serialized FinalizedTransaction produced by Dynamic, never a local mock.
 */
export async function signDynamicTransaction(wallet: MidnightWallet, serializedTransaction: string): Promise<string> {
  const connector = wallet.connector as MidnightWalletConnector;
  if (connector.overrideKey !== 'dynamicwaas') {
    throw new Error('A Dynamic embedded Midnight wallet is required for MPC signing.');
  }
  return withTimeout(
    wallet.signTransaction(serializedTransaction),
    'Dynamic MPC signing and Midnight proof generation',
    SIGN_TIMEOUT_MS,
  );
}

/** Broadcasts a Dynamic-finalized transaction and requires a real chain hash. */
export async function submitDynamicTransaction(wallet: MidnightWallet, finalizedTransaction: string): Promise<{ txHash: string }> {
  const submitted = await withTimeout(
    wallet.submitTransaction(finalizedTransaction),
    'Dynamic Midnight broadcast',
    SUBMIT_TIMEOUT_MS,
  );
  if (!submitted?.txHash) {
    throw new Error('Dynamic completed the broadcast call without returning a Midnight transaction hash.');
  }
  return submitted;
}

async function optional<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T | null> {
  try {
    return await withTimeout(operation, label, timeoutMs);
  } catch {
    return null;
  }
}

export function initialDynamicSurfaceState(wallet: MidnightWallet): DynamicSurfaceState {
  const shieldedAddress = addressFromWallet(wallet, MIDNIGHT_SHIELDED);
  const dustAddress = addressFromWallet(wallet, MIDNIGHT_DUST);
  return {
    unshieldedAddress: wallet.address,
    shieldedAddress,
    dustAddress,
    unshieldedBalance: null,
    shieldedTokenCount: null,
    dustBalance: null,
    dustSyncing: false,
    addressStatus: shieldedAddress && dustAddress ? 'ready' : 'loading',
    balanceStatus: 'loading',
    balanceError: null,
  };
}

export async function refreshDynamicAddresses(wallet: MidnightWallet): Promise<Pick<DynamicSurfaceState, 'unshieldedAddress' | 'shieldedAddress' | 'dustAddress' | 'addressStatus'>> {
  const connector = wallet.connector as MidnightWalletConnector;
  await optional(wallet.sync(), 'Wallet activation', ADDRESS_TIMEOUT_MS);

  const [additionalAddresses, unshielded, shielded, dust] = await Promise.all([
    optional(wallet.connector.getAdditionalAddresses(wallet.address), 'Additional addresses', ADDRESS_TIMEOUT_MS),
    optional(connector.getUnshieldedAddress(), 'Unshielded address', ADDRESS_TIMEOUT_MS),
    optional(connector.getShieldedAddresses(), 'Shielded address', ADDRESS_TIMEOUT_MS),
    optional(connector.getDustAddress(), 'DUST address', ADDRESS_TIMEOUT_MS),
  ]);

  const findAdditional = (type: string) => additionalAddresses?.find((address) => address.type === type)?.address ?? addressFromWallet(wallet, type);
  const unshieldedAddress = unshielded?.unshieldedAddress ?? wallet.address;
  const shieldedAddress = shielded?.shieldedAddress ?? findAdditional(MIDNIGHT_SHIELDED);
  const dustAddress = dust?.dustAddress ?? findAdditional(MIDNIGHT_DUST);

  return {
    unshieldedAddress,
    shieldedAddress,
    dustAddress,
    addressStatus: shieldedAddress && dustAddress ? 'ready' : 'partial',
  };
}

export async function refreshDynamicBalances(wallet: MidnightWallet): Promise<Pick<DynamicSurfaceState, 'unshieldedBalance' | 'shieldedTokenCount' | 'dustBalance' | 'dustSyncing' | 'balanceStatus' | 'balanceError'>> {
  try {
    const formatted = await withTimeout(wallet.getFormattedBalances(), 'Midnight balance sync', BALANCE_TIMEOUT_MS);
    return {
      // A missing native token entry is a real zero balance, not an unknown balance.
      unshieldedBalance: formatted.unshieldedBalance ?? '0',
      shieldedTokenCount: formatted.shieldedTokenCount ?? 0,
      dustBalance: formatted.dustBalance?.balance ?? '0',
      dustSyncing: formatted.dustSyncing === true,
      balanceStatus: formatted.dustSyncing ? 'syncing' : 'ready',
      balanceError: null,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      unshieldedBalance: null,
      shieldedTokenCount: null,
      dustBalance: null,
      dustSyncing: false,
      balanceStatus: 'unavailable',
      balanceError: message,
    };
  }
}

export function compactAddress(address: string): string {
  if (address.length < 18) return address;
  return `${address.slice(0, 9)}...${address.slice(-7)}`;
}
