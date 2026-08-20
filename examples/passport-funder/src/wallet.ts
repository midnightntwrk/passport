/**
 * The funder's Midnight wallet, run under plain Node.
 *
 * A straight port of the working `fund-localnet.mjs` path (repository root) —
 * `transferTransaction → signRecipe → finalizeRecipe → submitTransaction` —
 * plus two behaviours borrowed from the demo's `localWallet.ts`:
 *
 *   1. a serialized sync snapshot on disk (FUNDER_STATE_DIR), so a restart
 *      resumes the chain walk instead of replaying it from genesis; and
 *   2. `registerDustIfNeeded()`, the DUST-generation registration a freshly
 *      fauceted wallet must perform once before it can pay its own fees.
 *
 * The seed is read once at start-up and never leaves this process.
 */

import { Buffer } from 'node:buffer';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Rx from 'rxjs';

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade, type FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import {
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import type { FunderConfig } from './config.js';

// The wallet SDK's indexer client needs a global WebSocket under plain Node.
(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket;

export const NIGHT_DECIMALS = 6;

/** Formats atomic NIGHT for logs, on the same 6-decimal human scale the demo uses. */
export function formatNight(value: bigint): string {
  const scale = 10n ** BigInt(NIGHT_DECIMALS);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(NIGHT_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * ledger-v8 8.0.3 can panic inside `MerkleTree::collapse` while applying a
 * Zswap offer. Same guard `fund-localnet.mjs` and the demo both install.
 */
let zswapGuardInstalled = false;
function installZswapApplyGuard(): void {
  if (zswapGuardInstalled) return;
  zswapGuardInstalled = true;
  const prototype = ledger.ZswapChainState.prototype as unknown as Record<string, unknown>;
  const original = prototype.tryApply as (...args: unknown[]) => unknown;
  if (typeof original !== 'function') return;
  prototype.tryApply = function tryApply(this: unknown, ...args: unknown[]) {
    try {
      return original.apply(this, args);
    } catch {
      return [this, new Map()];
    }
  };
}

/** Account 0, index 0 — the derivation the demo and the prototype share. */
export function deriveRoleKeys(seedHex: string): Record<0 | 2 | 3, Uint8Array> {
  const wallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (wallet.type !== 'seedOk') throw new Error('The funder seed was rejected by the HD wallet.');
  const derived = wallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  wallet.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new Error('Key derivation from the funder seed failed.');
  return derived.keys;
}

/** The bech32m unshielded address a seed produces on the CURRENT network id. */
export function unshieldedAddressFromSeed(seedHex: string): string {
  const keys = deriveRoleKeys(seedHex);
  const keystore = createKeystore(keys[Roles.NightExternal], getNetworkId());
  return PublicKey.fromKeyStore(keystore).address;
}

interface StoredSnapshot {
  version: 1;
  networkId: string;
  unshieldedAddress: string;
  savedAt: string;
  shielded: string;
  unshielded: string;
  dust: string;
}

function snapshotPath(config: FunderConfig): string {
  return join(config.stateDir, `sync-snapshot-${config.networkId}.json`);
}

async function loadSnapshot(
  config: FunderConfig,
  address: string,
): Promise<StoredSnapshot | null> {
  try {
    const raw = await readFile(snapshotPath(config), 'utf8');
    const parsed = JSON.parse(raw) as StoredSnapshot;
    if (
      parsed.version !== 1 ||
      parsed.networkId !== config.networkId ||
      parsed.unshieldedAddress !== address
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface DripResult {
  txHash: string;
  amountAtomic: bigint;
}

/**
 * The subset of midnight-js's `WalletProvider & MidnightProvider` that contract
 * deployments and circuit calls actually use.
 *
 * Structural, not imported: `@midnight-ntwrk/midnight-js-types` describes these
 * in terms of ledger generics this module has no reason to name, and the demo's
 * own providers (`examples/passport-demo/src/identity/midnames.ts`) are built
 * the same structural way.
 */
export interface ContractWalletProvider {
  getCoinPublicKey(): string;
  getEncryptionPublicKey(): string;
  balanceTx(tx: unknown, ttl?: Date): Promise<unknown>;
  submitTx(tx: unknown): Promise<unknown>;
}

/**
 * The facade methods a contract transaction needs, named structurally for the
 * same reason as {@link ContractWalletProvider}: midnight-js hands us an
 * unproven transaction whose type does not line up with the facade's own
 * `UnboundTransaction`, and casting one narrow boundary is more honest than
 * threading a generic through code that never inspects it.
 */
interface ContractCapableFacade {
  balanceUnboundTransaction(
    tx: unknown,
    secretKeys: unknown,
    options: { ttl: Date },
  ): Promise<unknown>;
  signRecipe(recipe: unknown, sign: (data: Uint8Array) => unknown): Promise<unknown>;
  finalizeRecipe(recipe: unknown): Promise<unknown>;
  submitTransaction(tx: unknown): Promise<unknown>;
  revert(recipe: unknown): Promise<unknown>;
}

export interface FunderWallet {
  readonly address: string;
  currentState(): Promise<FacadeState>;
  waitForSync(onTick?: () => void): Promise<void>;
  /** Atomic NIGHT held right now. */
  nightBalance(state?: FacadeState): Promise<bigint>;
  /** Spendable DUST (Specks) right now. */
  dustBalance(state?: FacadeState): Promise<bigint>;
  /**
   * Registers every unregistered NIGHT UTxO for DUST generation, so the funder
   * can pay its own fees. Returns what actually happened.
   */
  registerDustIfNeeded(): Promise<'registered' | 'already-generating' | 'no-night'>;
  /**
   * Sends `amountAtomic` NIGHT to `recipient` and resolves with the ledger
   * transaction hash once the node has accepted the submission. Calls are
   * serialized internally so two drips can never reserve the same coins.
   */
  drip(recipient: UnshieldedAddress, amountAtomic: bigint): Promise<DripResult>;
  /**
   * Runs `task` with exclusive use of this wallet's coins — the same queue
   * `drip` uses, exposed so a multi-transaction job (an alias registration is
   * two) cannot interleave with a drip and reserve the same UTxO.
   *
   * The lock is held for the whole task, proofs included, so a registration
   * really does hold up a drip for its duration. That is the correct trade:
   * two transactions contending for one UTxO produce a rejected transaction,
   * and a queued drip produces a slightly later one.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
  /**
   * A midnight-js wallet provider bound to this wallet: it balances every token
   * kind from the funder's OWN NIGHT, signs with the funder's keystore, pays
   * the fee from the funder's OWN DUST, and submits. There is deliberately no
   * sponsor path here — the funder already registers its NIGHT for DUST
   * generation, so it can pay its own way, and a service that pays for other
   * people has no business asking a third party to pay for it.
   *
   * Calls made through this provider MUST be wrapped in {@link exclusive}.
   */
  contractWalletProvider(): Promise<ContractWalletProvider>;
  /**
   * The funder's own 32 unshielded address bytes, as a Compact `UserAddress`
   * argument expects them.
   */
  unshieldedAddressBytes(): Uint8Array;
  saveSnapshot(): Promise<void>;
  close(): Promise<void>;
}

export async function openFunderWallet(config: FunderConfig): Promise<FunderWallet> {
  installZswapApplyGuard();
  setNetworkId(config.networkId);

  const keys = deriveRoleKeys(config.seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore: UnshieldedKeystore = createKeystore(
    keys[Roles.NightExternal],
    getNetworkId(),
  );
  const publicKey = PublicKey.fromKeyStore(unshieldedKeystore);
  const address = publicKey.address;

  const configuration = {
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: config.indexerHttpUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    provingServerUrl: new URL(config.provingServerUrl),
    relayURL: new URL(config.relayUrl),
    // A wallet with only a few blocks of DUST accrued can refuse its own
    // transactions under a large fee margin. Five matches `fund-localnet.mjs`.
    costParameters: { feeBlocksMargin: 5 },
    txHistoryStorage: {
      upsert: async () => undefined,
      getAll: async () => [],
      get: async () => undefined,
      serialize: async () => '',
    },
  };

  const startFacade = async (snapshot: StoredSnapshot | null): Promise<WalletFacade> => {
    const facade = await (WalletFacade.init as (params: unknown) => Promise<WalletFacade>)({
      configuration,
      shielded: (cfg: unknown) =>
        snapshot
          ? ShieldedWallet(cfg as never).restore(snapshot.shielded)
          : ShieldedWallet(cfg as never).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (cfg: unknown) =>
        snapshot
          ? UnshieldedWallet(cfg as never).restore(snapshot.unshielded)
          : UnshieldedWallet(cfg as never).startWithPublicKey(publicKey),
      dust: (cfg: unknown) =>
        snapshot
          ? DustWallet(cfg as never).restore(snapshot.dust)
          : DustWallet(cfg as never).startWithSecretKey(
              dustSecretKey,
              ledger.LedgerParameters.initialParameters().dust,
            ),
    });
    await facade.start(shieldedSecretKeys, dustSecretKey);
    return facade;
  };

  await mkdir(config.stateDir, { recursive: true });
  const cached = await loadSnapshot(config, address);
  let facade: WalletFacade;
  let resumed = false;
  if (cached) {
    try {
      facade = await startFacade(cached);
      resumed = true;
      console.log(`[wallet] resumed sync from the snapshot saved at ${cached.savedAt}`);
    } catch (cause) {
      console.warn('[wallet] stored sync snapshot rejected; cold-starting', cause);
      facade = await startFacade(null);
    }
  } else {
    facade = await startFacade(null);
  }
  if (!resumed) console.log('[wallet] cold start — walking the chain from genesis');

  const nightTokenType = ledger.nativeToken().raw;
  let closed = false;

  const currentState = (): Promise<FacadeState> =>
    Rx.firstValueFrom(facade.state().pipe(Rx.timeout({ first: 30_000 })));

  const saveSnapshot = async (): Promise<void> => {
    if (closed) return;
    try {
      const [shielded, unshielded, dust] = await Promise.all([
        facade.shielded.serializeState(),
        facade.unshielded.serializeState(),
        facade.dust.serializeState(),
      ]);
      const snapshot: StoredSnapshot = {
        version: 1,
        networkId: config.networkId,
        unshieldedAddress: address,
        savedAt: new Date().toISOString(),
        shielded,
        unshielded,
        dust,
      };
      const path = snapshotPath(config);
      const temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify(snapshot), 'utf8');
      await rename(temp, path);
    } catch (cause) {
      // Losing the cache costs a longer sync next time and nothing else.
      console.warn('[wallet] unable to save the sync snapshot', cause);
    }
  };

  // Refresh the snapshot every minute while synced, so a killed process
  // resumes from close to the tip.
  let sawSynced = false;
  const snapshotTimer = setInterval(() => {
    if (sawSynced) void saveSnapshot();
  }, 60_000);
  snapshotTimer.unref();
  const snapshotSubscription = facade.state().subscribe({
    next: (state) => {
      if (state.isSynced && !sawSynced) {
        sawSynced = true;
        void saveSnapshot();
      } else if (!state.isSynced) {
        sawSynced = false;
      }
    },
    error: () => undefined,
  });

  // One spend at a time: the SDK reserves coins while balancing, and two
  // concurrent transactions could otherwise contend for the same UTxO. Drips
  // and alias registrations share this queue because they share the coins.
  let spendQueue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = spendQueue.then(task, task);
    spendQueue = next.catch(() => undefined);
    return next;
  };

  /** The bech32m address decoded back to the 32 bytes Compact circuits take. */
  const addressBytes = (): Uint8Array => {
    const parsed = MidnightBech32m.parse(address);
    const decoded = parsed.decode(UnshieldedAddress, parsed.network);
    const bytes = new Uint8Array(decoded.data);
    if (bytes.length !== 32) {
      throw new Error(`Expected a 32-byte unshielded address, got ${bytes.length}.`);
    }
    return bytes;
  };

  const contractFacade = facade as unknown as ContractCapableFacade;

  return {
    address,

    currentState,

    async waitForSync(onTick?: () => void): Promise<void> {
      const ticker = onTick ? setInterval(onTick, 1_000) : null;
      try {
        await Rx.firstValueFrom(facade.state().pipe(Rx.filter((state) => state.isSynced)));
      } finally {
        if (ticker) clearInterval(ticker);
      }
    },

    async nightBalance(state?: FacadeState): Promise<bigint> {
      const current = state ?? (await currentState());
      return current.unshielded.balances[nightTokenType] ?? 0n;
    },

    async dustBalance(state?: FacadeState): Promise<bigint> {
      const current = state ?? (await currentState());
      return current.dust.balance(new Date());
    },

    async registerDustIfNeeded(): Promise<'registered' | 'already-generating' | 'no-night'> {
      const state = await currentState();
      const unregistered = (state.unshielded.availableCoins ?? []).filter(
        (coin) =>
          coin.utxo.type === nightTokenType &&
          coin.meta.registeredForDustGeneration === false,
      );
      if (unregistered.length === 0) {
        if ((state.unshielded.balances[nightTokenType] ?? 0n) === 0n) return 'no-night';
        return 'already-generating';
      }
      const recipe = await facade.registerNightUtxosForDustGeneration(
        unregistered,
        unshieldedKeystore.getPublicKey(),
        (payload: Uint8Array) => unshieldedKeystore.signData(payload),
      );
      const finalized = await facade.finalizeTransaction(recipe.transaction);
      await facade.submitTransaction(finalized);
      console.log(
        `[wallet] registered ${unregistered.length} NIGHT UTxO(s) for DUST generation (tx ${String(finalized.transactionHash())})`,
      );
      return 'registered';
    },

    drip(recipient: UnshieldedAddress, amountAtomic: bigint): Promise<DripResult> {
      return serialize(async () => {
        if (closed) throw new Error('The funder wallet has been closed.');
        const ttl = new Date(Date.now() + 30 * 60 * 1_000);
        const recipe = await facade.transferTransaction(
          [
            {
              type: 'unshielded',
              outputs: [
                { type: nightTokenType, receiverAddress: recipient, amount: amountAtomic },
              ],
            },
          ],
          { shieldedSecretKeys, dustSecretKey },
          { ttl },
        );
        let finalized: Awaited<ReturnType<typeof facade.finalizeRecipe>>;
        try {
          const signed = await facade.signRecipe(recipe, (data: Uint8Array) =>
            unshieldedKeystore.signData(data),
          );
          finalized = await facade.finalizeRecipe(signed);
        } catch (cause) {
          try {
            await facade.revert(recipe);
          } catch {
            // Best effort — the reserved coins are released on restart anyway.
          }
          throw cause;
        }
        await facade.submitTransaction(finalized);
        // The submit call answers with a transaction *identifier*; the ledger's
        // own hash is the one indexers and explorers key on.
        return { txHash: String(finalized.transactionHash()), amountAtomic };
      });
    },

    exclusive<T>(task: () => Promise<T>): Promise<T> {
      return serialize(async () => {
        if (closed) throw new Error('The funder wallet has been closed.');
        return task();
      });
    },

    async contractWalletProvider(): Promise<ContractWalletProvider> {
      const state = await currentState();
      return {
        getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
        getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
        async balanceTx(tx: unknown, ttl?: Date): Promise<unknown> {
          const deadline = ttl ?? new Date(Date.now() + 30 * 60 * 1_000);
          const recipe = await contractFacade.balanceUnboundTransaction(
            tx,
            { shieldedSecretKeys, dustSecretKey },
            { ttl: deadline },
          );
          try {
            const signed = await contractFacade.signRecipe(recipe, (data: Uint8Array) =>
              unshieldedKeystore.signData(data),
            );
            return await contractFacade.finalizeRecipe(signed);
          } catch (cause) {
            try {
              await contractFacade.revert(recipe);
            } catch {
              // Best effort — the reserved coins are released on restart anyway.
            }
            throw cause;
          }
        },
        submitTx: (tx: unknown) => contractFacade.submitTransaction(tx),
      };
    },

    unshieldedAddressBytes: addressBytes,

    saveSnapshot,

    async close(): Promise<void> {
      if (closed) return;
      clearInterval(snapshotTimer);
      snapshotSubscription.unsubscribe();
      await saveSnapshot();
      closed = true;
      await facade.stop();
    },
  };
}
