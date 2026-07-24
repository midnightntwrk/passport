// Lazily initialized Midnight context shared by the app. The default context
// uses Dynamic on Preview; the explicit local demo boots the disposable
// genesis wallet and faucet providers.

import { firstValueFrom } from 'rxjs';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightWallet } from '@dynamic-labs/midnight';

import {
  createWallet,
  createProviders,
  createDynamicProviders,
  awaitSync,
  compiledFaucetContract,
  compiledIdentityRegistryContract,
  configureDynamicNetwork,
  configureLocalNetwork,
  dynamicMidnightProofProvider,
  dynamicWalletNetwork,
  DynamicTransactionCoordinator,
  type DynamicTransactionResult,
  type PassportNetworkId,
  type WalletContext,
  GENESIS_SEED,
} from './providers.js';
import type { DynamicTransactionIntent } from '../../../src/wallet/dynamic-transaction.js';
import {
  IdentityRegistry,
  type IdentityRegistration,
} from '../../../src/wallet/identity.js';

declare const __FAUCET_ADDRESS__: string;
declare const __IDENTITY_REGISTRY_ADDRESS__: string;

export interface Midnight {
  mode: 'local' | 'dynamic';
  networkId: PassportNetworkId;
  walletCtx: WalletContext | null;
  dynamicWallet: MidnightWallet | null;
  dynamicTransactions: DynamicTransactionCoordinator | null;
  accountProviders: any;
  faucetProviders: any;
  identityRegistryProviders: any;
  nightColorHex: string;
  faucetAddress: string;
  identityRegistryAddress: string;
}

let booted: Promise<Midnight> | null = null;
let bootedWalletKey = '';

export function getMidnight(dynamicWallet: MidnightWallet): Promise<Midnight> {
  const localMode = new URLSearchParams(window.location.search).get('demoMode') === 'local';
  const networkKey = localMode ? 'undeployed' : dynamicWalletNetwork(dynamicWallet);
  const walletKey = `${localMode ? 'local' : 'dynamic'}:${networkKey}:${
    dynamicWallet.id || dynamicWallet.address
  }`;
  if (!booted || bootedWalletKey !== walletKey) {
    faucetHandle = null;
    identityRegistryHandle = null;
    bootedWalletKey = walletKey;
    booted = (localMode ? initLocal() : initDynamic(dynamicWallet)).catch((error) => {
      if (bootedWalletKey === walletKey) booted = null;
      throw error;
    });
  }
  return booted;
}

async function initLocal(): Promise<Midnight> {
  configureLocalNetwork();
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
    mode: 'local',
    networkId: 'undeployed',
    walletCtx,
    dynamicWallet: null,
    dynamicTransactions: null,
    accountProviders,
    faucetProviders,
    identityRegistryProviders,
    nightColorHex,
    faucetAddress: __FAUCET_ADDRESS__ ?? '',
    identityRegistryAddress: __IDENTITY_REGISTRY_ADDRESS__ ?? '',
  };
}

async function initDynamic(dynamicWallet: MidnightWallet): Promise<Midnight> {
  const networkId = configureDynamicNetwork(dynamicWallet);
  const proofProvider = dynamicMidnightProofProvider(dynamicWallet);
  const dynamicTransactions = new DynamicTransactionCoordinator(
    networkId,
    proofProvider,
  );
  const [accountProviders, faucetProviders, identityRegistryProviders] = await Promise.all([
    createDynamicProviders(dynamicWallet, 'account', dynamicTransactions),
    createDynamicProviders(dynamicWallet, 'faucet', dynamicTransactions),
    createDynamicProviders(dynamicWallet, 'identity_registry', dynamicTransactions),
  ]);

  return {
    mode: 'dynamic',
    networkId,
    walletCtx: null,
    dynamicWallet,
    dynamicTransactions,
    accountProviders,
    faucetProviders,
    identityRegistryProviders,
    nightColorHex: '00'.repeat(32),
    faucetAddress: '',
    identityRegistryAddress: '',
  };
}

export async function runPassportTransaction<T>(
  mid: Midnight,
  intent: Omit<DynamicTransactionIntent, 'network'>,
  action: () => Promise<T>,
): Promise<{ result: T; receipt: DynamicTransactionResult<T>['receipt'] | null }> {
  if (!mid.dynamicTransactions) {
    return { result: await action(), receipt: null };
  }
  return mid.dynamicTransactions.run(intent, action);
}

export async function walletState(mid: Midnight): Promise<any> {
  if (mid.dynamicWallet) return mid.dynamicWallet.getBalances();
  if (!mid.walletCtx) throw new Error('No Midnight wallet is available.');
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

export async function getOrDeployLocalFaucet(mid: Midnight): Promise<any> {
  if (mid.mode !== 'local') {
    throw new Error('The disposable faucet is available only on the isolated localnet.');
  }
  if (mid.faucetAddress) {
    try {
      const state = await mid.faucetProviders.publicDataProvider.queryContractState(
        mid.faucetAddress,
      );
      if (state) return getFaucet(mid, mid.faucetAddress);
    } catch {
      // A localnet reset can leave a stale deployment file. Fall through and
      // create a faucet on the active disposable chain.
    }
    mid.faucetAddress = '';
    faucetHandle = null;
  }

  const deployed = await deployContract(mid.faucetProviders, {
    compiledContract: compiledFaucetContract(),
    privateStateId: 'passport-demo-faucet',
    initialPrivateState: {},
  } as any);
  const address = String(deployed.deployTxData.public.contractAddress);
  mid.faucetAddress = address;
  faucetHandle = { address, handle: deployed };
  return deployed;
}

let identityRegistryHandle: IdentityRegistry | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForNetwork(mid: Midnight): Promise<void> {
  if (mid.walletCtx) {
    await awaitSync(mid.walletCtx);
    return;
  }
  await sleep(2_000);
}

async function deployIdentityRegistry(mid: Midnight): Promise<IdentityRegistry> {
  const { result } = await runPassportTransaction(
    mid,
    {
      contractAddress: 'new identity registry',
      circuit: 'deploy identity_registry',
      summary: 'Deploy the MN Passport identity registry',
      arguments: {},
    },
    () =>
      IdentityRegistry.deploy(
        mid.identityRegistryProviders,
        compiledIdentityRegistryContract(),
      ),
  );
  return result;
}

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

  identityRegistryHandle = await deployIdentityRegistry(mid);
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
  identityRegistryHandle = await deployIdentityRegistry(mid);
  mid.identityRegistryAddress = identityRegistryHandle.address;
  await waitForNetwork(mid);
  return reconnectIdentityRegistry(mid);
}

export async function registerIdentity(
  mid: Midnight,
  handle: string,
  accountAddress: string,
): Promise<IdentityRegistration> {
  let registry = await getIdentityRegistry(mid);
  try {
    await registry.ledgerState();
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
      const { result } = await runPassportTransaction(
        mid,
        {
          contractAddress: activeRegistry.address,
          circuit: 'register_identity',
          summary: `Register ${handle}.night to the MN Passport custody account`,
          arguments: {
            accountAddress,
            handle: `${handle}.night`,
          },
        },
        () => activeRegistry.register(handle, accountAddress),
      );
      return result;
    } catch (e) {
      lastError = e;
      if (attempt === 2) break;
      await sleep(3_000 + attempt * 2_000);
      await waitForNetwork(mid);
      registry = await reconnectIdentityRegistry(mid);
      const landed = await registry.accountFor(handle);
      if (landed && landed !== accountAddress.toLowerCase()) {
        throw new Error(`${handle}.night is already registered; choose a different Night ID`);
      }
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

export async function accountForIdentity(mid: Midnight, handle: string): Promise<string | null> {
  let registry = await getIdentityRegistry(mid);
  try {
    await registry.ledgerState();
  } catch {
    registry = await deployFreshIdentityRegistry(mid);
  }
  return registry.accountFor(handle);
}
