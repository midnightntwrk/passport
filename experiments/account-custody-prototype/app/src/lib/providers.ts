// Browser-side Midnight wiring. The explicit local demo uses a disposable
// genesis wallet. The default Dynamic path keeps Compact proving in the app,
// then delegates finalization, wallet authorization, and submission to the
// connected Dynamic Midnight wallet.

import * as Rx from 'rxjs';

import type { MidnightWallet } from '@dynamic-labs/midnight';
import dynamicMidnightPackage from '@dynamic-labs/midnight/package.json';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as ledgerPkg from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  MidnightBech32m,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import {
  createDynamicMidnightProofProvider,
  DYNAMIC_MIDNIGHT_PROOF_CAPABILITY_METHOD,
  DYNAMIC_MIDNIGHT_PROOF_METHOD,
  requireDynamicMidnightProofCapability,
  submitDynamicTransaction,
  type DynamicMidnightProofProvider,
  type DynamicTransactionIntent,
  type DynamicTransactionReceipt,
} from '../../../src/wallet/dynamic-transaction.js';
import { Contract } from '../../../src/wallet/contract.js';
import { makeWitnesses } from '../../../src/wallet/witnesses.js';
import { hexToBytes } from '../../../src/wallet/hex.js';
import * as FaucetModule from '../../../contracts/managed/faucet/contract/index.js';
import { Contract as IdentityRegistryContract } from '../../../src/wallet/identity.js';

import { proveStarted, proveEnded } from './txTracker.js';
import { wasmProofProvider, wasmWalletProvingService } from './wasmProver.js';

// The local demo defaults to the Docker proof server because it is the most
// reliable path for live calls. `?prover=browser` opts into the experimental
// in-tab zkir-v2 prover described in BROWSER-PROVING-SCOPE.md.
const proverParam =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('prover')
    : null;
export const BROWSER_PROVER = proverParam === 'browser';

// Localnet genesis wallet — the dev node funds this seed at genesis.
// Demo-only; never use outside a throwaway local network.
export const GENESIS_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';

const ORIGIN = window.location.origin;
const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws');

const LOCAL_CONFIG = {
  networkId: 'undeployed',
  indexer: `${ORIGIN}/indexer/api/v4/graphql`,
  indexerWS: `${WS_ORIGIN}/indexer/api/v4/graphql/ws`,
  node: `${ORIGIN}/rpc`,
  // The proof server sends permissive CORS headers, so the browser talks to
  // it directly — proxying the multi-megabyte streaming /prove bodies
  // through Vite's http-proxy breaks the wallet's proving step.
  proofServer: 'http://127.0.0.1:6300',
} as const;

const DYNAMIC_CONFIG = {
  preview: {
    networkId: 'preview',
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preview.midnight.network',
    proofServer: 'https://proof-server.preview.midnight.network',
  },
} as const;

export type PassportNetworkId = keyof typeof DYNAMIC_CONFIG | 'undeployed';

export let CONFIG: {
  networkId: PassportNetworkId;
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
} = { ...LOCAL_CONFIG };

export function configureLocalNetwork(): void {
  CONFIG = { ...LOCAL_CONFIG };
  setNetworkId(CONFIG.networkId as any);
}

export function dynamicWalletNetwork(wallet: MidnightWallet): 'preview' | 'mainnet' {
  const connector = wallet.connector as any;
  const selectedName = String(connector.getSelectedNetwork?.()?.name ?? '').toLowerCase();
  const address = wallet.address.toLowerCase();

  // Match the resolver in DynamicWaasMidnightConnector exactly. Its MPC
  // backend routes any selected network containing "testnet" to Preview and
  // everything else to Mainnet, so accepting a display name such as
  // "Preview" here would prove and submit against different networks.
  if (selectedName) {
    if (selectedName.includes('testnet')) return 'preview';
    if (selectedName.includes('mainnet')) return 'mainnet';
    throw new Error(
      `Dynamic selected "${selectedName}", which cannot be mapped safely. Select Midnight Testnet or Mainnet and reconnect.`,
    );
  }
  if (address.includes('_preview')) return 'preview';
  if (address.includes('_mainnet')) return 'mainnet';
  throw new Error(
    'Cannot determine the Dynamic Midnight network. Select Midnight Testnet or Mainnet in Dynamic and reconnect.',
  );
}

export function configureDynamicNetwork(wallet: MidnightWallet): 'preview' {
  const network = dynamicWalletNetwork(wallet);
  if (network === 'mainnet') {
    throw new Error(
      'This prototype refuses to submit C1 transactions on Mainnet. Select Midnight Testnet in Dynamic.',
    );
  }
  CONFIG = { ...DYNAMIC_CONFIG[network] };
  setNetworkId(network as any);
  return network;
}

const NoopTxHistoryStorage = {
  upsert: async (..._args: unknown[]) => undefined,
  get: async (..._args: unknown[]) => null,
  delete: async (..._args: unknown[]) => undefined,
  list: async (..._args: unknown[]) => [] as unknown[],
  clear: async (..._args: unknown[]) => undefined,
};

// Workaround for ledger-v8 MerkleTree::collapse panic (see node/wallet.ts).
const _origTryApply = (ledgerPkg.ZswapChainState.prototype as any).tryApply;
(ledgerPkg.ZswapChainState.prototype as any).tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()];
  }
};

export function deriveKeys(seedHex: string) {
  const hdWallet = HDWallet.fromSeed(hexToBytes(seedHex));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
}

export async function createWallet(seedHex: string) {
  const keys = deriveKeys(seedHex);
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledgerPkg.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledgerPkg.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  const configuration = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexer,
      indexerWsUrl: CONFIG.indexerWS,
    },
    provingServerUrl: new URL(CONFIG.proofServer),
    relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
    costParameters: { feeBlocksMargin: 100 },
    txHistoryStorage: NoopTxHistoryStorage,
  };

  const wallet: any = await (WalletFacade as any).init({
    configuration,
    shielded: (config: any) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config: any) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config: any) =>
      DustWallet(config).startWithSecretKey(
        dustSecretKey,
        ledgerPkg.LedgerParameters.initialParameters().dust,
      ),
    // With ?prover=browser the balancing proofs (zswap, dust) are computed
    // in this tab too — no proof server anywhere in the stack.
    ...(BROWSER_PROVER ? { provingService: () => wasmWalletProvingService() } : {}),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

export type WalletContext = Awaited<ReturnType<typeof createWallet>>;

export async function awaitSync(walletCtx: WalletContext): Promise<any> {
  return Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.filter((s: any) => s.isSynced === true)),
  );
}

export interface DynamicTransactionResult<T> {
  readonly result: T;
  readonly receipt: DynamicTransactionReceipt;
}

export class DynamicTransactionConfirmationError extends Error {
  constructor(
    readonly receipt: DynamicTransactionReceipt,
    readonly confirmationError: unknown,
  ) {
    super(
      `Dynamic broadcast ${receipt.txHash}, but Midnight indexer confirmation did not complete. Do not resubmit until that hash is reconciled.`,
      { cause: confirmationError },
    );
    this.name = 'DynamicTransactionConfirmationError';
  }
}

export class DynamicTransactionCoordinator {
  private activeIntent: DynamicTransactionIntent | null = null;
  private receipt: DynamicTransactionReceipt | null = null;

  constructor(
    readonly network: 'preview' | 'mainnet',
    readonly proofProvider: DynamicMidnightProofProvider,
  ) {}

  async run<T>(
    intent: Omit<DynamicTransactionIntent, 'network'>,
    action: () => Promise<T>,
  ): Promise<DynamicTransactionResult<T>> {
    if (this.activeIntent) {
      throw new Error('A Dynamic Midnight transaction is already awaiting approval.');
    }

    this.activeIntent = { ...intent, network: this.network };
    this.receipt = null;
    try {
      // Fail before Compact proving or witness handling when Dynamic cannot
      // balance an arbitrary call-proved UnboundTransaction.
      await requireDynamicMidnightProofCapability(this.proofProvider);
      const result = await action();
      if (!this.receipt) {
        throw new Error('The Compact operation completed without a Dynamic transaction receipt.');
      }
      const receipt = this.receipt;
      return { result, receipt };
    } catch (error) {
      if (this.receipt) {
        throw new DynamicTransactionConfirmationError(this.receipt, error);
      }
      throw error;
    } finally {
      this.activeIntent = null;
    }
  }

  currentIntent(contractName: string): DynamicTransactionIntent {
    if (!this.activeIntent) {
      throw new Error(
        `${contractName} attempted a Dynamic Compact transaction without an explicit approval intent.`,
      );
    }
    return this.activeIntent;
  }

  record(receipt: DynamicTransactionReceipt): void {
    if (!this.activeIntent) {
      throw new Error('Dynamic returned a transaction receipt without an active approval intent.');
    }
    if (this.receipt) {
      throw new Error('A Dynamic approval intent produced more than one Compact transaction.');
    }
    this.receipt = receipt;
  }

  lastReceipt(): DynamicTransactionReceipt | null {
    return this.receipt;
  }
}

// In-memory PrivateStateProvider — secrets live for the page session only.
// (C16 wallet-local-storage is its own component; the demo deliberately
// re-derives the device secret from the passkey on every page load.)
export function inMemoryPrivateStateProvider(): any {
  const states = new Map<string, unknown>();
  const signingKeys = new Map<string, unknown>();
  return {
    setContractAddress(_address: string) {},
    async set(id: string, state: unknown) {
      states.set(id, state);
    },
    async get(id: string) {
      return states.has(id) ? states.get(id) : null;
    },
    async remove(id: string) {
      states.delete(id);
    },
    async clear() {
      states.clear();
    },
    async setSigningKey(address: string, key: unknown) {
      signingKeys.set(address, key);
    },
    async getSigningKey(address: string) {
      return signingKeys.get(address) ?? null;
    },
    async removeSigningKey(address: string) {
      signingKeys.delete(address);
    },
    async clearSigningKeys() {
      signingKeys.clear();
    },
    async exportPrivateStates() {
      throw new Error('not supported in the demo');
    },
    async importPrivateStates() {
      throw new Error('not supported in the demo');
    },
  };
}

function decodeCoinPublicKey(value: string): string {
  if (/^(?:0x)?[0-9a-f]{64}$/i.test(value)) {
    return value.replace(/^0x/, '').toLowerCase();
  }
  return ShieldedCoinPublicKey.codec
    .decode(getNetworkId(), MidnightBech32m.parse(value))
    .toHexString();
}

function decodeEncryptionPublicKey(value: string): string {
  if (/^(?:0x)?[0-9a-f]{64}$/i.test(value)) {
    return value.replace(/^0x/, '').toLowerCase();
  }
  return ShieldedEncryptionPublicKey.codec
    .decode(getNetworkId(), MidnightBech32m.parse(value))
    .toHexString();
}

export interface DynamicShieldedKeys {
  readonly shieldedCoinPublicKey: string;
  readonly shieldedEncryptionPublicKey: string;
}

const dynamicShieldedKeyCache = new WeakMap<
  MidnightWallet,
  Promise<DynamicShieldedKeys>
>();

export async function dynamicShieldedKeys(
  wallet: MidnightWallet,
): Promise<DynamicShieldedKeys> {
  const cached = dynamicShieldedKeyCache.get(wallet);
  if (cached) return cached;

  const pending = (async () => {
    const connector = wallet.connector as any;
    if (typeof connector.getShieldedAddresses !== 'function') {
      throw new Error('The connected Dynamic Midnight wallet cannot expose shielded public keys.');
    }
    const keys = await connector.getShieldedAddresses();
    if (!keys?.shieldedCoinPublicKey || !keys?.shieldedEncryptionPublicKey) {
      throw new Error('Dynamic returned an incomplete Midnight shielded key surface.');
    }
    return keys as DynamicShieldedKeys;
  })();

  dynamicShieldedKeyCache.set(wallet, pending);
  try {
    return await pending;
  } catch (error) {
    dynamicShieldedKeyCache.delete(wallet);
    throw error;
  }
}

function hasDynamicProofContract(candidate: unknown): boolean {
  if (
    (typeof candidate !== 'object' || candidate === null) &&
    typeof candidate !== 'function'
  ) {
    return false;
  }
  const value = candidate as Record<string, unknown>;
  return (
    typeof value[DYNAMIC_MIDNIGHT_PROOF_CAPABILITY_METHOD] === 'function' &&
    typeof value[DYNAMIC_MIDNIGHT_PROOF_METHOD] === 'function'
  );
}

export function dynamicMidnightProofProvider(
  wallet: MidnightWallet,
): DynamicMidnightProofProvider {
  const connector = wallet.connector as unknown;
  const candidate = hasDynamicProofContract(wallet) ? wallet : connector;
  return createDynamicMidnightProofProvider(candidate, {
    packageName: '@dynamic-labs/midnight',
    packageVersion: dynamicMidnightPackage.version,
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function assertFinalizedTransaction(serializedTransaction: string): void {
  try {
    (ledgerPkg.Transaction as any).deserialize(
      'signature',
      'proof',
      'binding',
      base64ToBytes(serializedTransaction),
    );
  } catch (error) {
    throw new Error(
      `Dynamic returned data that is not a Midnight FinalizedTransaction: ${String(
        (error as Error)?.message ?? error,
      )}`,
    );
  }
}

function createZkProviders(contractName: 'account' | 'faucet' | 'identity_registry') {
  const zkConfigProvider = new FetchZkConfigProvider(
    `${ORIGIN}/zk/${contractName}`,
    window.fetch.bind(window),
  );

  const baseProofProvider: any = httpClientProofProvider(
    CONFIG.proofServer,
    zkConfigProvider as any,
  );
  const proofProvider = BROWSER_PROVER
    ? wasmProofProvider(zkConfigProvider)
    : {
        ...baseProofProvider,
        proveTx: async (...args: unknown[]) => {
          proveStarted();
          try {
            return await baseProofProvider.proveTx(...args);
          } finally {
            proveEnded();
          }
        },
      };

  return { zkConfigProvider, proofProvider };
}

export async function createProviders(
  walletCtx: WalletContext,
  contractName: 'account' | 'faucet' | 'identity_registry',
) {
  const state = await awaitSync(walletCtx);

  const signFn = (payload: Uint8Array) => walletCtx.unshieldedKeystore.signData(payload);

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: walletCtx.shieldedSecretKeys,
          dustSecretKey: walletCtx.dustSecretKey,
        },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signed = await walletCtx.wallet.signRecipe(recipe, signFn);
      return walletCtx.wallet.finalizeRecipe(signed);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx),
  };

  // Wrapped so the UI's proving dock sees when the prover is actually
  // working (build → prove → submit phases in txTracker).
  const { zkConfigProvider, proofProvider } = createZkProviders(contractName);

  return {
    privateStateProvider: inMemoryPrivateStateProvider(),
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider: walletProvider,
  };
}

interface DynamicFinalizationEnvelope {
  readonly kind: 'dynamic-midnight-finalization';
  readonly serializedTransaction: string;
}

function isDynamicFinalizationEnvelope(value: unknown): value is DynamicFinalizationEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as DynamicFinalizationEnvelope).kind === 'dynamic-midnight-finalization' &&
    typeof (value as DynamicFinalizationEnvelope).serializedTransaction === 'string'
  );
}

export async function createDynamicProviders(
  wallet: MidnightWallet,
  contractName: 'account' | 'faucet' | 'identity_registry',
  coordinator: DynamicTransactionCoordinator,
) {
  const keys = await dynamicShieldedKeys(wallet);

  const coinPublicKey = decodeCoinPublicKey(keys.shieldedCoinPublicKey);
  const encryptionPublicKey = decodeEncryptionPublicKey(keys.shieldedEncryptionPublicKey);
  const { zkConfigProvider, proofProvider } = createZkProviders(contractName);

  const walletProvider = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encryptionPublicKey,
    async balanceTx(provenTransaction: { serialize(): Uint8Array }) {
      return {
        kind: 'dynamic-midnight-finalization',
        serializedTransaction: bytesToBase64(provenTransaction.serialize()),
      } satisfies DynamicFinalizationEnvelope;
    },
  };

  const midnightProvider = {
    async submitTx(envelope: unknown) {
      if (!isDynamicFinalizationEnvelope(envelope)) {
        throw new Error('Dynamic received an invalid Compact transaction envelope.');
      }

      const receipt = await submitDynamicTransaction({
        authorizer: wallet,
        proofProvider: coordinator.proofProvider,
        broadcaster: wallet,
        serializedTransaction: envelope.serializedTransaction,
        intent: coordinator.currentIntent(contractName),
        assertNetwork: () => {
          const currentNetwork = dynamicWalletNetwork(wallet);
          if (currentNetwork !== coordinator.network) {
            throw new Error(
              `Dynamic switched from ${coordinator.network} to ${currentNetwork} while the transaction was awaiting approval.`,
            );
          }
        },
        validateFinalizedTransaction: assertFinalizedTransaction,
      });
      coordinator.record(receipt);
      return receipt.txHash;
    },
  };

  return {
    privateStateProvider: inMemoryPrivateStateProvider(),
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  };
}

export function compiledAccountContract() {
  return CompiledContract.make('account', Contract as any).pipe(
    CompiledContract.withWitnesses(makeWitnesses() as never),
    CompiledContract.withCompiledFileAssets('/zk/account'),
  );
}

export function compiledFaucetContract() {
  return CompiledContract.make('faucet', (FaucetModule as any).Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets('/zk/faucet'),
  );
}

export function compiledIdentityRegistryContract() {
  return CompiledContract.make('identity_registry', IdentityRegistryContract as any).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets('/zk/identity_registry'),
  );
}

// User-facing byte helpers (mirrors src/node/wallet.ts).

export function userAddressBytes(walletCtx: WalletContext): Uint8Array {
  const pk: any = walletCtx.unshieldedKeystore.getPublicKey();
  const hex: string = typeof pk?.toHexString === 'function' ? pk.toHexString() : String(pk?.bytes ?? pk);
  const out = new Uint8Array(32);
  out.set(hexToBytes(hex.replace(/^0x/, '')).subarray(0, 32));
  return out;
}

export function dynamicUserAddressBytes(wallet: MidnightWallet): Uint8Array {
  const decoded = UnshieldedAddress.codec.decode(
    getNetworkId(),
    MidnightBech32m.parse(wallet.address),
  );
  return new Uint8Array(decoded.data);
}

export async function dynamicCoinPublicKeyBytes(wallet: MidnightWallet): Promise<Uint8Array> {
  const keys = await dynamicShieldedKeys(wallet);
  return hexToBytes(decodeCoinPublicKey(keys.shieldedCoinPublicKey));
}

export function coinPublicKeyBytes(state: any): Uint8Array {
  const cpk = state.shielded.coinPublicKey;
  const hex: string = typeof cpk?.toHexString === 'function' ? cpk.toHexString() : String(cpk?.bytes ?? cpk);
  const out = new Uint8Array(32);
  out.set(hexToBytes(hex.replace(/^0x/, '')).subarray(0, 32));
  return out;
}
