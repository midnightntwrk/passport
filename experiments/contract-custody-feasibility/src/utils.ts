// Provider/wallet plumbing — adapted from experiments/redjubjub-wallet/src/utils.ts.
// The redjubjub-specific signer signature plumbing (signTransactionIntents) is
// retained because every contract call still needs the unshielded keystore to
// sign intents; the JubJub-Schnorr-specific compute helpers are dropped.

import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

// InMemoryTransactionHistoryStorage was removed from
// @midnight-ntwrk/wallet-sdk-unshielded-wallet@3. The new wallet-sdk-shielded
// and wallet-sdk-dust-wallet expect a storage object exposing `upsert`,
// `get`, `delete`, `list`. We don't need history for this experiment, so
// supply a no-op stub. If the SDK adds new methods, add them here.
const NoopTxHistoryStorage = {
  upsert: async (..._args: unknown[]) => undefined,
  get:    async (..._args: unknown[]) => null,
  delete: async (..._args: unknown[]) => undefined,
  list:   async (..._args: unknown[]) => [] as unknown[],
  clear:  async (..._args: unknown[]) => undefined,
};

// Enable WebSocket for GraphQL subscriptions.
// @ts-expect-error required for wallet sync
globalThis.WebSocket = WebSocket;

const NETWORK = process.env.MIDNIGHT_NETWORK ?? 'local';

const CONFIGS: Record<
  string,
  { networkId: string; indexer: string; indexerWS: string; node: string; proofServer: string }
> = {
  local: {
    networkId: 'undeployed',
    indexer: 'http://localhost:8088/api/v4/graphql',
    indexerWS: 'ws://localhost:8088/api/v4/graphql/ws',
    node: 'http://localhost:9944',
    proofServer: 'http://127.0.0.1:6300',
  },
  preprod: {
    networkId: 'preprod',
    indexer: 'https://indexer.preprod.midnight.network/api/v3/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
    node: 'https://rpc.preprod.midnight.network',
    proofServer: 'http://127.0.0.1:6300',
  },
};

export const CONFIG = CONFIGS[NETWORK] ?? CONFIGS.local;
setNetworkId(CONFIG.networkId as any);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'custody');

const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
export const CustodyContract = await import(pathToFileURL(contractPath).href);

export const PRIVATE_STATE_ID = 'custody-state';

// ─── Wallet ─────────────────────────────────────────────────────────────────

export function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');

  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');

  hdWallet.hdWallet.clear();
  return result.keys;
}

export async function createWallet(seed: string) {
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  // feeBlocksMargin: how much fee headroom the wallet attaches to a tx's
  // Dust branch beyond the SDK's fee estimate. Inherited value (5) was
  // tuned for redjubjub-wallet's largest circuit (k=11). The
  // contract-custody-feasibility contract has a k=15 / ~20k-row circuit
  // and triggered MalformedError::BalanceCheckOverspend on devnet
  // 0.22.0 at margin=5. 100 is a generous default; lower it once the
  // actual fee is known. Set FEE_BLOCKS_MARGIN env var to override.
  const feeBlocksMargin = Number(process.env.FEE_BLOCKS_MARGIN ?? '100');

  const configuration = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexer,
      indexerWsUrl: CONFIG.indexerWS,
    },
    provingServerUrl: new URL(CONFIG.proofServer),
    relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
    costParameters: {
      feeBlocksMargin,
    },
    txHistoryStorage: NoopTxHistoryStorage,
  };

  const wallet: WalletFacade = await (WalletFacade as any).init({
    configuration,
    shielded: (config: any) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config: any) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config: any) =>
      DustWallet(config).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

export async function createProviders(walletCtx: Awaited<ReturnType<typeof createWallet>>) {
  const state = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));

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
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);

  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: `midnight-level-db`,
      privateStateStoreName: PRIVATE_STATE_ID,
      privateStoragePasswordProvider: () => 'CustodyFeasibility!exp',
      accountId: state.shielded.encryptionPublicKey.toHexString().slice(0, 16),
      walletProvider,
    }),
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}
