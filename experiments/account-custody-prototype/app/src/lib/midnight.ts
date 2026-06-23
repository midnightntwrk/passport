// Lazily-initialised Midnight context shared by the whole app:
// genesis fee wallet (synced), providers for the account and faucet
// contracts, and the faucet handle.

import { firstValueFrom } from 'rxjs';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import {
  createWallet,
  createProviders,
  awaitSync,
  compiledFaucetContract,
  compiledIdentityRegistryContract,
  type WalletContext,
  GENESIS_SEED,
} from './providers.js';
import {
  IdentityRegistry,
  type IdentityRegistration,
} from '../../../src/wallet/identity.js';

declare const __FAUCET_ADDRESS__: string;
declare const __IDENTITY_REGISTRY_ADDRESS__: string;

export interface Midnight {
  walletCtx: WalletContext;
  accountProviders: any;
  faucetProviders: any;
  identityRegistryProviders: any;
  nightColorHex: string;
  faucetAddress: string;
  identityRegistryAddress: string;
}

let booted: Promise<Midnight> | null = null;

export function getMidnight(): Promise<Midnight> {
  if (!booted) booted = init();
  return booted;
}

async function init(): Promise<Midnight> {
  const walletCtx = await createWallet(GENESIS_SEED);
  const state = await awaitSync(walletCtx);

  const held = Object.entries(state.unshielded.balances as Record<string, bigint>);
  if (held.length === 0) {
    throw new Error('Genesis wallet holds no Night — is the localnet up and seeded?');
  }
  const [nightColorHex] = held[0];

  const accountProviders = await createProviders(walletCtx, 'account');
  const faucetProviders = await createProviders(walletCtx, 'faucet');
  const identityRegistryProviders = await createProviders(walletCtx, 'identity_registry');

  return {
    walletCtx,
    accountProviders,
    faucetProviders,
    identityRegistryProviders,
    nightColorHex,
    faucetAddress: __FAUCET_ADDRESS__ ?? '',
    identityRegistryAddress: __IDENTITY_REGISTRY_ADDRESS__ ?? '',
  };
}

export async function walletState(mid: Midnight): Promise<any> {
  return firstValueFrom(mid.walletCtx.wallet.state());
}

let faucetHandle: { address: string; handle: any } | null = null;

export async function getFaucet(mid: Midnight, address: string): Promise<any> {
  if (faucetHandle?.address === address) return faucetHandle.handle;
  const handle = await (findDeployedContract as any)(mid.faucetProviders, {
    contractAddress: address,
    compiledContract: compiledFaucetContract(),
    privateStateId: 'faucet-demo',
    initialPrivateState: {},
  });
  faucetHandle = { address, handle };
  return handle;
}

let identityRegistryHandle: IdentityRegistry | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getIdentityRegistry(mid: Midnight): Promise<IdentityRegistry> {
  if (identityRegistryHandle) return identityRegistryHandle;
  if (mid.identityRegistryAddress) {
    identityRegistryHandle = await IdentityRegistry.connect(
      mid.identityRegistryProviders,
      compiledIdentityRegistryContract(),
      mid.identityRegistryAddress,
    );
    return identityRegistryHandle;
  }

  identityRegistryHandle = await IdentityRegistry.deploy(
    mid.identityRegistryProviders,
    compiledIdentityRegistryContract(),
  );
  mid.identityRegistryAddress = identityRegistryHandle.address;
  return identityRegistryHandle;
}

async function reconnectIdentityRegistry(mid: Midnight): Promise<IdentityRegistry> {
  if (!mid.identityRegistryAddress) return getIdentityRegistry(mid);
  identityRegistryHandle = await IdentityRegistry.connect(
    mid.identityRegistryProviders,
    compiledIdentityRegistryContract(),
    mid.identityRegistryAddress,
  );
  return identityRegistryHandle;
}

async function deployFreshIdentityRegistry(mid: Midnight): Promise<IdentityRegistry> {
  identityRegistryHandle = await IdentityRegistry.deploy(
    mid.identityRegistryProviders,
    compiledIdentityRegistryContract(),
  );
  mid.identityRegistryAddress = identityRegistryHandle.address;
  await sleep(2_000);
  await awaitSync(mid.walletCtx);
  return reconnectIdentityRegistry(mid);
}

export async function registerIdentity(
  mid: Midnight,
  handle: string,
  accountAddress: string,
): Promise<IdentityRegistration> {
  let registry = await getIdentityRegistry(mid);
  try {
    const state = await registry.ledgerState();
    if (state.registration_count > 0n) {
      registry = await deployFreshIdentityRegistry(mid);
    }
  } catch {
    registry = await deployFreshIdentityRegistry(mid);
  }
  const existingAccount = await registry.accountFor(handle);
  if (existingAccount && existingAccount !== accountAddress.toLowerCase()) {
    throw new Error(`${handle}.night is already registered; choose a different Night ID`);
  }
  if (existingAccount === accountAddress.toLowerCase()) {
    return {
      registryAddress: registry.address,
      txId: 'already-registered',
      handle,
      accountAddress,
    };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const activeRegistry = attempt === 0 ? await reconnectIdentityRegistry(mid) : registry;
      return await activeRegistry.register(handle, accountAddress);
    } catch (e) {
      lastError = e;
      if (attempt === 2) break;
      await sleep(3_000 + attempt * 2_000);
      await awaitSync(mid.walletCtx);
      registry = await reconnectIdentityRegistry(mid);
      const landed = await registry.accountFor(handle);
      if (landed === accountAddress.toLowerCase()) {
        return {
          registryAddress: registry.address,
          txId: 'already-registered',
          handle,
          accountAddress,
        };
      }
    }
  }
  throw lastError;
}
