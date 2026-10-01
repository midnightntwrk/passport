// Node-side provider and wallet plumbing — adapted from
// experiments/contract-custody-feasibility/src/{utils,common}.ts and ported
// to the ledger-9 stack (midnight-js 5.0.0-rc.2, wallet-sdk facade
// 5.0.0-rc.0, ledger-v9 1.0.0-rc.5) following the upstream
// compact-end-2-end harness's utils/{wallet,providers}.ts.
//
// The funding wallet (genesis-seeded on the local devnet) pays Dust fees and
// supplies Night for deposits. Fee handling is explicitly out of scope for
// the custody prototype (C24).

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { Buffer } from 'node:buffer';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import {
  NodeZkConfigProvider,
  nodeZkConfigRegistry,
} from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createWalletProvider, createMidnightProvider } from '@midnight-ntwrk/midnight-js-types';
import * as ledger from '@midnightntwrk/ledger-v9';
import { NoOpTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from '@midnightntwrk/wallet-sdk-unshielded-wallet';

// The indexer provider's HTTP transport uses Node's global agents; keep-alive
// sockets have been observed to drop finalisation waits mid-connection
// ("Premature close"). Fresh sockets per request avoid it.
// createRequire yields the real (mutable) CJS module objects; the ESM
// namespace views are frozen and reject the assignment.
const cjsRequire = createRequire(import.meta.url);
const http = cjsRequire('node:http') as typeof import('node:http');
const https = cjsRequire('node:https') as typeof import('node:https');
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

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
};

export const CONFIG = CONFIGS[NETWORK] ?? CONFIGS.local;
setNetworkId(CONFIG.networkId as any);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const managedPath = path.resolve(__dirname, '..', '..', 'contracts', 'managed');
export const zkConfigPath = path.join(managedPath, 'account');
export const controlZkConfigPath = path.join(managedPath, 'control');
export const faucetZkConfigPath = path.join(managedPath, 'faucet');

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
  const unshieldedKeystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] },
    networkId,
  );

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
    // The suites read ledger state and events from the indexer.
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
  };

  const wallet = await WalletFacade.init({
    configuration,
    shielded: (config) => ShieldedWallet(config).startWithSeed(keys[Roles.Zswap]),
    unshielded: (config) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config) =>
      DustWallet(config).startWithSeed(keys[Roles.Dust]),
  });

  await wallet.start({
    shielded: keys[Roles.Zswap],
    unshielded: keys[Roles.NightExternal],
    dust: keys[Roles.Dust],
  });

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

export type WalletContext = Awaited<ReturnType<typeof createWallet>>;

export async function syncWallet(walletCtx: WalletContext, label: string): Promise<void> {
  process.stdout.write(`Syncing ${label} to network`);
  // throttleTime is load-bearing: isSynced flaps true→false→true early in
  // sync; sampling every 5 s waits for a stable synced state, by which point
  // the genesis dust UTXO is finalised and spendable.
  await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.tap(() => process.stdout.write(' .')),
      Rx.filter((state) => state.isSynced === true),
    ),
  );
  console.log('\nWallet synced.');
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// The wallet's dust view lags the chain by a sync cycle; a transaction built
// before enough dust has generated fails to balance. Poll the fee estimate
// until the wallet can cover it (the estimate throws until then).
async function waitForDustFeeBudget(
  walletCtx: WalletContext,
  tx: Parameters<WalletFacade['estimateTransactionFee']>[0],
  ttl: Date,
): Promise<void> {
  const deadline = Date.now() + Number(process.env.DUST_FEE_TIMEOUT_MS ?? '600000');
  let waiting = false;
  for (;;) {
    try {
      await walletCtx.wallet.estimateTransactionFee(tx, { ttl });
      if (waiting) console.log('  ✓ enough DUST for the transaction fee');
      return;
    } catch (error) {
      if (!/insufficient funds|could not balance dust/i.test(errorText(error))) throw error;
    }
    if (!waiting) {
      console.log('  waiting for the wallet to generate enough DUST ...');
      waiting = true;
    }
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for enough DUST for the transaction fee');
    }
    await delay(Math.min(5_000, deadline - Date.now()));
  }
}

// Retry an indexer finalisation wait that drops mid-connection ("Premature
// close" — a known indexer gap); logs each retry.
function retryOnDrop<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(...args);
      } catch (e) {
        if (attempt > 3 || !/Premature close/.test(String(e))) throw e;
        console.warn(`  ⚠ indexer gap: ${name} dropped finalisation wait — retry ${attempt}/3`);
        await delay(Math.min(3000, 500 * attempt));
      }
    }
  };
}

export async function createProviders<K extends string = string>(walletCtx: WalletContext, contractZkPath: string = zkConfigPath) {
  const state = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
  );

  // wallet-sdk-facade >= 5.0.0-beta.2 made signing async-only (out-of-process
  // signers need it); wrap so the keystore's `this` binding is preserved.
  const signFn = (payload: Uint8Array) => walletCtx.unshieldedKeystore.signDataAsync(payload);

  // Midnight JS tags provider transactions by ledger era. The adapters reject
  // unsupported eras before handing a v9 transaction to this localnet wallet.
  const walletProvider = createWalletProvider({
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx, ttl) {
      // Node 2.1.0 enforces a fee-model dismissal window far below the
      // 30-minute TTL older stacks accepted (Malformed(FeeCalculation(
      // OutsideTimeToDismiss))); a short TTL keeps the fee calculation
      // inside the window. Balancing-to-submission is sub-second here.
      const transactionTtl = ttl ?? new Date(Date.now() + Number(process.env.TX_TTL_MS ?? '60000'));
      const handle = walletCtx.wallet.adoptTransaction(tx.serialize(), 'Unbound');
      await waitForDustFeeBudget(walletCtx, handle, transactionTtl);
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        handle,
        { ttl: transactionTtl },
      );

      const signed = await walletCtx.wallet.signRecipe(recipe, signFn);
      const finalized = await walletCtx.wallet.finalizeRecipe(signed);
      return ledger.Transaction.deserialize('signature', 'proof', 'binding', finalized.serialize());
    },
  });
  const midnightProvider = createMidnightProvider((tx) =>
    walletCtx.wallet.submitTransaction(walletCtx.wallet.adoptTransaction(tx.serialize(), 'Finalized')));

  // midnight-js deploy/make reads this contract's own verifier keys by circuit
  // id (the leaf provider); proving a cross-contract call tree needs keys for
  // every contract in the tree, so the proof provider gets a registry over the
  // artifact root (the parent holding every compiled bundle).
  const zkConfigProvider = new NodeZkConfigProvider<K>(contractZkPath);
  const zkConfigRegistry = await nodeZkConfigRegistry(managedPath);

  const pdp = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
  (pdp as any).watchForTxData = retryOnDrop('watchForTxData', (pdp as any).watchForTxData.bind(pdp));
  (pdp as any).watchForDeployTxData = retryOnDrop(
    'watchForDeployTxData',
    (pdp as any).watchForDeployTxData.bind(pdp),
  );

  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: `midnight-level-db`,
      privateStateStoreName: 'account-custody-reference',
      privateStoragePasswordProvider: () => 'AccountCustody!reference',
      accountId: state.shielded.encryptionPublicKey.toHexString().slice(0, 16),
    }),
    publicDataProvider: pdp,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigRegistry),
    walletProvider,
    midnightProvider,
  };
}

// The user's 32-byte unshielded address bytes, as the contract's
// UserAddress argument expects them. This is the ADDRESS (the hash the
// ledger indexes UTXOs by), NOT the raw signing public key — tokens sent
// to the public-key bytes land at an address nobody owns.
export function userAddressBytes(walletCtx: WalletContext): Uint8Array {
  return ledger.encodeUserAddress(walletCtx.unshieldedKeystore.getAddress());
}

// The user's Zswap coin public key bytes, as ZswapCoinPublicKey expects.
export function coinPublicKeyBytes(state: any): Uint8Array {
  const cpk = state.shielded.coinPublicKey;
  const hex: string =
    typeof cpk?.toHexString === 'function' ? cpk.toHexString() : String(cpk?.bytes ?? cpk);
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(32);
  out.set(Buffer.from(clean, 'hex').subarray(0, 32));
  return out;
}
