/**
 * The ledger-9 plumbing every deployment leg shares: the balancer's wallet,
 * the provider set midnight-js 5 wants, and the encodings that cross the
 * boundary between JavaScript and Compact.
 *
 * This is `examples/passport-balancer/src/wallet.ts` plus
 * `examples/passport-funder/src/contractRuntime.ts`, rewritten against the
 * stack the stagenet compatibility matrix names:
 *
 *   compact compiler 0.33.0-rc.2  →  runtime 0.18.0-rc.1
 *   compact.js       2.5.5-rc.7
 *   midnight.js      5.0.0-beta.6
 *   wallet SDK       2.0.0-beta.2   (@midnightntwrk/ledger-v9, hyphenless)
 *   proof server     9.0.0-rc.6
 *
 * The seed is read from a file and never printed, logged, or returned.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import * as ledger from '@midnightntwrk/ledger-v9';
import { NoOpTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk';
import {
  makeServerProvingService,
  makeWasmProvingService,
} from '@midnight-ntwrk/wallet-sdk/capabilities/proving';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk/dust';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk/facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk/hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk/shielded';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk/unshielded';
import * as Rx from 'rxjs';

// The wallet SDK's indexer client needs a global WebSocket under plain Node.
globalThis.WebSocket ??= WebSocket;

/* Keep-alive sockets against the indexer produce `Premature close` inside
   `watchForTxData`, which turns a landed transaction into a thrown deploy.
   Turning the agent's pooling off is what the upstream end-to-end harness does
   and it costs nothing at this volume. */
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Minimal dotenv, copied from the balancer: the real environment always wins. */
export function applyEnvFile(env = process.env) {
  const path = env.BALANCER_ENV_FILE?.trim();
  if (!path) return;
  const text = readFileSync(path.replace(/^~(?=\/)/, env.HOME ?? '~'), 'utf8');
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (env[key] !== undefined) continue;
    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

export function loadConfig(env = process.env) {
  const seedHex = (env.BALANCER_SEED ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error('BALANCER_SEED must be 64 hex characters (a 32-byte wallet seed).');
  }
  const indexerHttpUrl =
    env.BALANCER_INDEXER_URL?.trim() ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
  const nodeUrl = env.BALANCER_NODE_URL?.trim() ?? 'wss://rpc.stagenet.shielded.tools';
  return {
    networkId: env.BALANCER_NETWORK?.trim() ?? 'stagenet',
    seedHex,
    indexerHttpUrl,
    indexerWsUrl: `${indexerHttpUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`,
    nodeUrl,
    relayUrl: /^wss?:/.test(nodeUrl) ? nodeUrl : nodeUrl.replace(/^http/, 'ws'),
    /* Contract circuits are proved by a proof server. Stagenet publishes none,
       so this defaults to the 9.0.0-rc.6 image run locally. The wallet's own
       DUST/Zswap legs are proved in-process unless this is also set as the
       wallet prover. */
    proofServerUrl: env.DEPLOY_PROOF_SERVER_URL?.trim() ?? 'http://127.0.0.1:6300',
    walletProverUrl: env.BALANCER_PROVER_URL?.trim() || undefined,
    stateDir: env.DEPLOY_STATE_DIR?.trim() ?? './state',
    feeBlocksMargin: Number(env.BALANCER_FEE_BLOCKS_MARGIN ?? 5),
    ttlMs: Number(env.DEPLOY_TTL_MS ?? 30 * 60 * 1000),
  };
}

/* -------------------------------------------------------------------------- */
/* Encodings                                                                  */
/* -------------------------------------------------------------------------- */

export const bytesToHex = (value) => Buffer.from(value).toString('hex');

export function hexToBytes(value) {
  const normalized = value.replace(/^0x/, '');
  if (normalized.length % 2 !== 0) throw new Error(`Odd-length hex string: ${value}`);
  return new Uint8Array(Buffer.from(normalized, 'hex'));
}

/** Normalises a Midnight contract address to its raw 64-hex form. */
export function rawContractAddress(value) {
  const normalized = String(value).trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid Midnight contract address: ${value}`);
  }
  return normalized;
}

export const contractAddressBytes = (value) => hexToBytes(rawContractAddress(value));

/** The native NIGHT colour, as a Compact `Bytes<32>` argument takes it. */
export const nativeColourBytes = () => hexToBytes(String(ledger.nativeToken().raw));

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * midnight-js reports transaction *identifiers*, not the 32-byte ledger hashes
 * an explorer resolves. The indexer maps one to the other; an identifier that
 * never resolves is returned unchanged rather than replaced by a plausible lie.
 */
export async function resolveTransactionHash(indexerHttpUrl, identifier, attempts = 15) {
  const query = `{ transactions(offset: { identifier: "${identifier}" }) { hash block { height } } }`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(indexerHttpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const body = await response.json();
      const found = body?.data?.transactions?.[0];
      if (found?.hash) return { hash: found.hash, block: found.block?.height ?? null };
    } catch {
      // Transient network or parse failure — retried below.
    }
    await wait(2_000);
  }
  return { hash: identifier, block: null };
}

/* -------------------------------------------------------------------------- */
/* Wallet                                                                     */
/* -------------------------------------------------------------------------- */

export function deriveRoleKeys(seedHex) {
  const wallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (wallet.type !== 'seedOk') throw new Error('The seed was rejected by the HD wallet.');
  const derived = wallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  wallet.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new Error('Key derivation failed.');
  return derived.keys;
}

const NIGHT_DECIMALS = 6;
export function formatNight(value) {
  const scale = 10n ** BigInt(NIGHT_DECIMALS);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(NIGHT_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * Opens the balancer's stagenet wallet and hands back exactly what a deployment
 * needs: the facade, the keys, the address, and a serialised spend path.
 */
export async function openWallet(config, log = console.log) {
  /* midnight.js 5 keeps the network id in module-level state and `getNetworkId`
     THROWS when it is unset — `Transaction.fromParts` and
     `parseCoinPublicKeyToHex` both call it. It is also the bech32m tag, so a
     mismatch here silently produces addresses for another network. */
  setNetworkId(config.networkId);

  const keys = deriveRoleKeys(config.seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] },
    config.networkId,
  );
  const publicKey = PublicKey.fromKeyStore(unshieldedKeystore);
  const address = publicKey.address;

  const configuration = {
    networkId: config.networkId,
    indexerClientConnection: {
      indexerHttpUrl: config.indexerHttpUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    relayURL: new URL(config.relayUrl),
    costParameters: { feeBlocksMargin: config.feeBlocksMargin },
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    ...(config.walletProverUrl ? { provingServerUrl: new URL(config.walletProverUrl) } : {}),
  };

  const provingService = config.walletProverUrl
    ? makeServerProvingService({ provingServerUrl: new URL(config.walletProverUrl) })
    : makeWasmProvingService({});

  const snapshotFile = join(config.stateDir, `sync-snapshot-${config.networkId}.json`);
  let snapshot = null;
  try {
    const parsed = JSON.parse(await readFile(snapshotFile, 'utf8'));
    if (parsed.version === 1 && parsed.networkId === config.networkId && parsed.unshieldedAddress === address) {
      snapshot = parsed;
    }
  } catch {
    snapshot = null;
  }

  const startFacade = (from) =>
    WalletFacade.init({
      configuration,
      provingService: () => provingService,
      shielded: (cfg) =>
        from
          ? ShieldedWallet(cfg).restore(from.shielded)
          : ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (cfg) =>
        from
          ? UnshieldedWallet(cfg).restore(from.unshielded)
          : UnshieldedWallet(cfg).startWithPublicKey(publicKey),
      dust: (cfg) =>
        from
          ? DustWallet(cfg).restore(from.dust)
          : DustWallet(cfg).startWithSecretKey(
              dustSecretKey,
              ledger.LedgerParameters.initialParameters().dust,
            ),
    });

  await mkdir(config.stateDir, { recursive: true });
  let facade;
  try {
    facade = await startFacade(snapshot);
    log(snapshot ? `[wallet] resumed from the snapshot saved at ${snapshot.savedAt}` : '[wallet] cold start');
  } catch (cause) {
    log(`[wallet] snapshot rejected (${cause?.message ?? cause}); cold-starting`);
    facade = await startFacade(null);
  }
  await facade.start(shieldedSecretKeys, dustSecretKey);

  const nightTokenType = ledger.nativeToken().raw;
  const currentState = () => Rx.firstValueFrom(facade.state().pipe(Rx.timeout({ first: 60_000 })));

  const saveSnapshot = async () => {
    try {
      const [shielded, unshielded, dust] = await Promise.all([
        facade.shielded.serializeState(),
        facade.unshielded.serializeState(),
        facade.dust.serializeState(),
      ]);
      const body = JSON.stringify({
        version: 1,
        networkId: config.networkId,
        unshieldedAddress: address,
        savedAt: new Date().toISOString(),
        shielded,
        unshielded,
        dust,
      });
      await writeFile(`${snapshotFile}.tmp`, body, 'utf8');
      await rename(`${snapshotFile}.tmp`, snapshotFile);
    } catch (cause) {
      log(`[wallet] unable to save the sync snapshot: ${cause?.message ?? cause}`);
    }
  };

  /* One spend at a time. The droplet's balancer service is live against this
     same wallet, so every spend here is serialised and kept few, to minimise
     coin-selection races against it. */
  let queue = Promise.resolve();
  const exclusive = (job) => {
    const next = queue.then(job, job);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    facade,
    address,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    publicKey,
    currentState,
    saveSnapshot,
    exclusive,

    /**
     * Waits for a STABLE synced state.
     *
     * `isSynced` flaps true → false → true while the three wallets catch up;
     * taking the first `true` grabs a transient and the next balancing fails
     * with "could not balance dust". Throttling by five seconds first is what
     * the upstream end-to-end harness does, and it is the difference between a
     * deploy that works and one that fails on a wallet that is in fact fine.
     */
    async waitForSync(onTick) {
      const ticker = onTick
        ? setInterval(() => {
            void currentState().then(onTick).catch(() => undefined);
          }, 5_000)
        : null;
      try {
        await Rx.firstValueFrom(
          facade.state().pipe(
            Rx.throttleTime(5_000),
            Rx.filter((state) => state.isSynced),
          ),
        );
      } finally {
        if (ticker) clearInterval(ticker);
      }
    },

    async balances() {
      const state = await currentState();
      return {
        night: state.unshielded.balances[nightTokenType] ?? 0n,
        dust: state.dust.balance(new Date()),
        synced: state.isSynced,
      };
    },

    async close() {
      await saveSnapshot();
      await facade.stop();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

/** Session-lifetime private-state store, mirroring the funder's. */
export function inMemoryPrivateStateProvider(initial = {}) {
  const states = new Map(Object.entries(initial));
  const signingKeys = new Map();
  return {
    setContractAddress() {},
    async set(id, state) {
      states.set(id, state);
    },
    async get(id) {
      return states.has(id) ? states.get(id) : null;
    },
    async remove(id) {
      states.delete(id);
    },
    async clear() {
      states.clear();
    },
    async setSigningKey(address, key) {
      signingKeys.set(address, key);
    },
    async getSigningKey(address) {
      return signingKeys.get(address) ?? null;
    },
    async removeSigningKey(address) {
      signingKeys.delete(address);
    },
    async clearSigningKeys() {
      signingKeys.clear();
    },
    async exportPrivateStates() {
      throw new Error('Private-state export is not supported by this harness.');
    },
  };
}

/**
 * The v5 `WalletProvider` / `MidnightProvider`, backed by the beta wallet SDK.
 *
 * This is the join that had to be proved: midnight.js 5 hands out an
 * `UnboundTransaction` and expects a `FinalizedTransaction` back, which is
 * precisely `balanceUnboundTransaction` → `signRecipe` → `finalizeRecipe` on
 * the facade. Both sides speak `@midnightntwrk/ledger-v9` 1.0.0-rc.3, so the
 * objects cross the boundary unconverted.
 */
export function walletProviderFrom(wallet, config, log = console.log) {
  return {
    getCoinPublicKey: () => wallet.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => wallet.shieldedSecretKeys.encryptionPublicKey,

    async balanceTx(tx, ttl) {
      const deadline = ttl ?? new Date(Date.now() + config.ttlMs);
      return wallet.exclusive(async () => {
        /* Under ledger-9 the fee is DUST, and DUST accrues per block. A wallet
           that is a few Specks short is not broken, it is early — so the fee is
           estimated first and the estimate is retried rather than turned into a
           deploy failure. */
        const budgetMs = 600_000;
        const startedAt = Date.now();
        for (;;) {
          try {
            const fee = await wallet.facade.estimateTransactionFee(tx, wallet.dustSecretKey, {
              ttl: deadline,
            });
            log(`[wallet] estimated fee ${fee} Specks`);
            break;
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            if (
              !/insufficient funds|could not balance dust/i.test(message) ||
              Date.now() - startedAt > budgetMs
            ) {
              throw cause;
            }
            log(`[wallet] waiting for DUST (${message.slice(0, 80)})`);
            await wait(10_000);
          }
        }

        let recipe = null;
        try {
          /* `facade.validateTransaction` is NOT called here, and must not be.
             The beta SDK's validation service builds a BLANK ledger state
             (`LedgerState.blank(networkId)` with only the real parameters) and
             runs `wellFormed` against it, so any transaction that CALLS a
             deployed contract fails with
             `call to non-existant contract ContractAddress(…)` — measured on
             stagenet against a TLD that demonstrably existed, at block 157797.
             The check is sound for a self-contained transfer and structurally
             impossible for a contract call. */
          recipe = await wallet.facade.balanceUnboundTransaction(
            tx,
            {
              shieldedSecretKeys: wallet.shieldedSecretKeys,
              dustSecretKey: wallet.dustSecretKey,
            },
            { ttl: deadline },
          );
          const signed = await wallet.facade.signRecipe(
            recipe,
            wallet.unshieldedKeystore.signDataAsync,
          );
          recipe = signed;
          const finalized = await wallet.facade.finalizeRecipe(signed);
          log(`[wallet] balanced and finalized (${finalized.serialize().length} bytes)`);
          return finalized;
        } catch (cause) {
          if (recipe) {
            try {
              await wallet.facade.revert(recipe);
            } catch {
              // Reserved coins are released on restart anyway.
            }
          }
          throw cause;
        }
      });
    },

    async submitTx(tx) {
      const identifier = await wallet.facade.submitTransaction(tx);
      log(`[wallet] submitted ${String(identifier).slice(0, 20)}…`);
      return identifier;
    },
  };
}

/** The Midnames owner-key derivation: `sha256(pad(32,'midnight.domains') || secret)`. */
export function deriveMidnamesOwnerKey(secret) {
  if (secret.length !== 32) throw new Error('A Midnames owner secret must be 32 bytes.');
  const payload = new Uint8Array(64);
  payload.set(new TextEncoder().encode('midnight.domains'));
  payload.set(secret, 32);
  return new Uint8Array(createHash('sha256').update(payload).digest());
}
