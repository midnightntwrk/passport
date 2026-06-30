// Browser-side Midnight wiring: genesis-funded fee wallet, providers, and
// compiled-contract handles. Mirrors src/node/wallet.ts minus the
// Node-specific pieces (ws, fs, level db).
//
// The embedded wallet exists ONLY to balance and pay for transactions on
// the localnet — fee handling is out of the custody prototype's scope (C24).

import * as Rx from 'rxjs';

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
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { Contract } from '../../../src/wallet/contract.js';
import { makeWitnesses } from '../../../src/wallet/witnesses.js';
import { hexToBytes } from '../../../src/wallet/hex.js';
import * as FaucetModule from '../../../contracts/managed/faucet/contract/index.js';

import { proveStarted, proveEnded } from './txTracker.js';
import { wasmProofProvider, wasmWalletProvingService } from './wasmProver.js';

// The browser prover is the DEFAULT: everything — contract circuits, zswap,
// dust — is proved in this tab by the zkir-v2 wasm prover (see
// BROWSER-PROVING-SCOPE.md). No proof server is needed anywhere in the
// stack. `?prover=server` opts back into the Docker proof server at
// 127.0.0.1:6300 (works on localhost only — the server is unreachable from
// tunnel/LAN origins).
const proverParam =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('prover')
    : null;
export const BROWSER_PROVER = proverParam !== 'server';

// Localnet genesis wallet — the dev node funds this seed at genesis.
// Demo-only; never use outside a throwaway local network.
export const GENESIS_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';

const ORIGIN = window.location.origin;
const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws');

export const CONFIG = {
  networkId: 'undeployed',
  indexer: `${ORIGIN}/indexer/api/v4/graphql`,
  indexerWS: `${WS_ORIGIN}/indexer/api/v4/graphql/ws`,
  node: `${ORIGIN}/rpc`,
  // The proof server sends permissive CORS headers, so the browser talks to
  // it directly — proxying the multi-megabyte streaming /prove bodies
  // through Vite's http-proxy breaks the wallet's proving step.
  proofServer: 'http://127.0.0.1:6300',
};

setNetworkId(CONFIG.networkId as any);

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

export async function createProviders(walletCtx: WalletContext, contractName: 'account' | 'faucet') {
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

  const zkConfigProvider = new FetchZkConfigProvider(
    `${ORIGIN}/zk/${contractName}`,
    window.fetch.bind(window),
  );

  // Wrapped so the UI's proving dock sees when the prover is actually
  // working (build → prove → submit phases in txTracker). With
  // ?prover=browser the proof is computed in this tab by the zkir-v2 wasm
  // prover; otherwise it goes to the local proof server.
  const baseProofProvider: any = httpClientProofProvider(CONFIG.proofServer, zkConfigProvider as any);
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

  return {
    privateStateProvider: inMemoryPrivateStateProvider(),
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider: walletProvider,
  };
}

export function compiledAccountContract() {
  return CompiledContract.make('account', Contract as any).pipe(
    CompiledContract.withWitnesses(makeWitnesses() as any),
    CompiledContract.withCompiledFileAssets('/zk/account'),
  );
}

export function compiledFaucetContract() {
  return CompiledContract.make('faucet', (FaucetModule as any).Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets('/zk/faucet'),
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

export function coinPublicKeyBytes(state: any): Uint8Array {
  const cpk = state.shielded.coinPublicKey;
  const hex: string = typeof cpk?.toHexString === 'function' ? cpk.toHexString() : String(cpk?.bytes ?? cpk);
  const out = new Uint8Array(32);
  out.set(hexToBytes(hex.replace(/^0x/, '')).subarray(0, 32));
  return out;
}
