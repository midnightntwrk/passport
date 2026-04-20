#!/usr/bin/env tsx
/**
 * night-tps.ts — Midnight NIGHT transfer TPS proof-of-viability
 *
 * Commands:
 *   setup   Fund N test wallets from the genesis wallet and register each for DUST.
 *           Wallet mnemonics and addresses are saved to a JSON store for reuse.
 *   run     Load wallets from the store and send a burst of NIGHT transfers,
 *           reporting the submission TPS and per-tx latency.
 *
 * Usage (from experiments/mn-tui/):
 *   npx tsx src/night-tps.ts setup [--wallets 3] [--night 1000] [--network undeployed]
 *   npx tsx src/night-tps.ts run   [--txs 5]     [--network undeployed]
 *
 * Options:
 *   --wallets  N     Number of test wallets to fund (setup, default 3)
 *   --night    N     NIGHT to send to each wallet, in whole NIGHT (setup, default 1000)
 *   --txs      N     Transactions per wallet in run phase (default 5)
 *   --network  NAME  undeployed | preprod (default undeployed)
 *   --store    PATH  Wallet JSON store path (default ./night-tps-wallets.json)
 *   --node     URL   Override node RPC URL
 *   --indexer  URL   Override indexer GraphQL URL
 *   --prover   URL   Override proof server URL
 *
 * Genesis wallet:
 *   The "genesis mint wallet" is derived from the fixed 32-byte seed
 *   0x00…01, which holds all NIGHT minted in the genesis block of a local
 *   Midnight development node.  The genesis wallet is used only during setup.
 */

import { Buffer }                                        from 'buffer';
import * as fs                                           from 'node:fs/promises';
import * as Rx                                           from 'rxjs';
import * as bip39                                        from 'bip39';
import * as ledger                                       from '@midnight-ntwrk/ledger-v7';
import { WalletFacade }                                  from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet }                                    from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { ShieldedWallet }                                from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
}                                                        from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { HDWallet, Roles }                               from '@midnight-ntwrk/wallet-sdk-hd';
import { setNetworkId }                                  from '@midnight-ntwrk/midnight-js-network-id';
import { WebSocket }                                     from 'ws';

// Must register WebSocket globally before any SDK code runs.
(globalThis as any).WebSocket = WebSocket;

// ---------------------------------------------------------------------------
// Workaround: ledger-v7 7.0.0/7.0.1 ZswapChainState::tryApply panic
//
// MerkleTree::collapse panics on any non-empty tree when producing shielded
// outputs (shielded transfers, DUST registration, shielded minting, contract
// deployment). Without this patch the WASM panic corrupts the proof state,
// resulting in a BalanceCheckOverspend (error 138) from the node.
// Returning [this, new Map()] makes the local state update a no-op and lets
// proof generation proceed correctly.
// See: https://github.com/geofflittle/tryapply-crash-repro
// Fix expected in ledger-v7 7.0.2+; remove when upgrading.
// ---------------------------------------------------------------------------
const _origTryApply = (ledger as any).ZswapChainState.prototype.tryApply;
(ledger as any).ZswapChainState.prototype.tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()];
  }
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** NIGHT native token identifier (64 zero hex digits). */
const NIGHT_ID = '0'.repeat(64);

/** Fixed seed for the genesis mint wallet on a local dev node. */
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

/** Network endpoint presets. */
const NETWORK_DEFAULTS: Record<string, { node: string; indexer: string; prover: string }> = {
  // node-lan pod: node-1 RPC is exposed on 9945, indexer on 8088, proof server on 6300.
  undeployed: {
    node:    'http://localhost:9945',
    indexer: 'http://localhost:8088/api/v4/graphql',
    prover:  'http://localhost:6300',
  },
  preprod: {
    node:    'https://rpc.preprod.midnight.network',
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    prover:  'https://proof-server.preprod.midnight.network',
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NetConfig {
  network: string;
  node:    string;
  indexer: string;
  prover:  string;
}

interface WalletCtx {
  facade:             WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey:      ledger.DustSecretKey;
  keystore:           ReturnType<typeof createKeystore>;
}

interface WalletRecord {
  name:     string;
  mnemonic: string;
  address:  string;
}

interface WalletStore {
  network: string;
  wallets: WalletRecord[];
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
}

// ---------------------------------------------------------------------------
// Key derivation (offline — no network connection required)
// ---------------------------------------------------------------------------

function deriveKeys(seed: Buffer): {
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey:      ledger.DustSecretKey;
  keystore:           ReturnType<typeof createKeystore>;
} {
  const hd = HDWallet.fromSeed(seed);
  if (hd.type !== 'seedOk') throw new Error('HDWallet.fromSeed failed');

  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();

  // keystore construction requires the network ID to have been set already.
  const keystore           = createKeystore(derived.keys[Roles.NightExternal], '');
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey      = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  return { shieldedSecretKeys, dustSecretKey, keystore };
}

async function mnemonicToSeed(mnemonic: string): Promise<Buffer> {
  return bip39.mnemonicToSeed(mnemonic.trim());
}

/** Derive the Bech32 unshielded address from a seed without opening a wallet. */
async function deriveAddress(seed: Buffer, network: string): Promise<string> {
  const hd = HDWallet.fromSeed(seed);
  if (hd.type !== 'seedOk') throw new Error('HDWallet.fromSeed failed');
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();
  const ks = createKeystore(derived.keys[Roles.NightExternal], network);
  return (ks.getBech32Address() as any).toString();
}

// ---------------------------------------------------------------------------
// Wallet lifecycle
// ---------------------------------------------------------------------------

async function initWallet(seed: Buffer, cfg: NetConfig): Promise<WalletCtx> {
  const hd = HDWallet.fromSeed(seed);
  if (hd.type !== 'seedOk') throw new Error('HDWallet.fromSeed failed');

  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey      = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const keystore           = createKeystore(derived.keys[Roles.NightExternal], cfg.network);

  const indexerHttpUrl = cfg.indexer;
  const indexerWsUrl   = toWsUrl(cfg.indexer) + '/ws';
  const relayURL       = new URL(toWsUrl(cfg.node));
  const provingServerUrl = new URL(cfg.prover);

  const walletCfg = {
    networkId:               cfg.network,
    indexerClientConnection: { indexerHttpUrl, indexerWsUrl },
    provingServerUrl,
    relayURL,
  };

  const shielded   = ShieldedWallet(walletCfg).startWithSecretKeys(shieldedSecretKeys);
  const unshielded = UnshieldedWallet({
    networkId:               cfg.network,
    indexerClientConnection: { indexerHttpUrl, indexerWsUrl },
    txHistoryStorage:        new InMemoryTransactionHistoryStorage(),
  }).startWithPublicKey(PublicKey.fromKeyStore(keystore));
  const dust = DustWallet({
    ...walletCfg,
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  }).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);

  const facade = new WalletFacade(shielded, unshielded, dust);
  await facade.start(shieldedSecretKeys, dustSecretKey);

  return { facade, shieldedSecretKeys, dustSecretKey, keystore };
}

function walletAddress(ctx: WalletCtx): string {
  return (ctx.keystore.getBech32Address() as any).toString();
}

async function closeWallet(ctx: WalletCtx): Promise<void> {
  try { await ctx.facade.stop(); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Wallet state observers
// ---------------------------------------------------------------------------

async function waitForSync(ctx: WalletCtx): Promise<void> {
  await Rx.firstValueFrom(
    (ctx.facade as any).state().pipe(
      Rx.filter((s: any) => s.isSynced === true),
    ),
  );
}

async function waitForFunds(ctx: WalletCtx): Promise<void> {
  await Rx.firstValueFrom(
    (ctx.facade as any).state().pipe(
      Rx.filter((s: any) =>
        s.isSynced === true &&
        ((s.unshielded?.balances?.[NIGHT_ID] ?? 0n) +
         (s.shielded?.balances?.[NIGHT_ID]   ?? 0n)) > 0n,
      ),
    ),
  );
}

async function waitForDust(ctx: WalletCtx): Promise<void> {
  process.stdout.write('  Waiting for DUST to accrue');
  await Rx.firstValueFrom(
    (ctx.facade as any).state().pipe(
      Rx.tap(() => process.stdout.write('.')),
      Rx.filter((s: any) =>
        s.isSynced === true &&
        (s.dust?.walletBalance?.(new Date()) ?? 0n) > 0n,
      ),
    ),
  );
  process.stdout.write('\n');
}

async function getNightBalance(ctx: WalletCtx): Promise<bigint> {
  const s = await Rx.firstValueFrom((ctx.facade as any).state());
  return (s.unshielded?.balances?.[NIGHT_ID] ?? 0n) +
         (s.shielded?.balances?.[NIGHT_ID]   ?? 0n);
}

async function getDustBalance(ctx: WalletCtx): Promise<bigint> {
  const s = await Rx.firstValueFrom((ctx.facade as any).state());
  return s.dust?.walletBalance?.(new Date()) ?? 0n;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

async function registerForDust(ctx: WalletCtx): Promise<string | null> {
  const state = await Rx.firstValueFrom(
    (ctx.facade as any).state().pipe(
      Rx.filter((s: any) => s.isSynced === true),
    ),
  );
  const utxos: any[] = (state.unshielded?.availableCoins ?? [])
    .filter((c: any) => !c.meta?.registeredForDustGeneration);

  if (utxos.length === 0) {
    console.log('  All NIGHT UTXOs already registered for DUST generation.');
    return null;
  }

  console.log(`  Registering ${utxos.length} NIGHT UTXO(s) for DUST generation…`);
  for (const u of utxos) {
    const repr = JSON.stringify(u, (_, v) => typeof v === 'bigint' ? `${v}` : v);
    console.log(`    UTXO: ${repr.slice(0, 160)}${repr.length > 160 ? '…' : ''}`);
  }
  const recipe    = await (ctx.facade as any).registerNightUtxosForDustGeneration(
    utxos,
    ctx.keystore.getPublicKey(),
    (payload: Uint8Array) => ctx.keystore.signData(payload),
  );
  const finalized = await (ctx.facade as any).finalizeRecipe(recipe);
  const txHash    = await (ctx.facade as any).submitTransaction(finalized) as string;
  console.log(`  DUST registration tx: ${txHash}`);
  return txHash;
}

async function transferNight(
  ctx:    WalletCtx,
  toAddr: string,
  amount: bigint,
): Promise<string> {
  const ttl    = new Date(Date.now() + 30 * 60 * 1000);
  const recipe = await (ctx.facade as any).transferTransaction(
    [{
      type:    'unshielded',
      outputs: [{ type: NIGHT_ID, amount, receiverAddress: toAddr }],
    }],
    { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
    { ttl },
  );
  const signed    = await (ctx.facade as any).signRecipe(
    recipe,
    (payload: Uint8Array) => ctx.keystore.signData(payload),
  );
  const finalized = await (ctx.facade as any).finalizeRecipe(signed);
  return (ctx.facade as any).submitTransaction(finalized) as Promise<string>;
}

// ---------------------------------------------------------------------------
// setup command
// ---------------------------------------------------------------------------

async function cmdSetup(opts: {
  nWallets:  number;
  night:     bigint;
  storePath: string;
  cfg:       NetConfig;
}): Promise<void> {
  const { nWallets, night, storePath, cfg } = opts;
  console.log(`\n=== setup: funding ${nWallets} wallet(s) × ${fmtNight(night)} NIGHT on ${cfg.network} ===\n`);

  // 1. Genesis wallet --------------------------------------------------------
  console.log('Initialising genesis wallet (seed 00…01)…');
  const genesisCtx  = await initWallet(Buffer.from(GENESIS_SEED, 'hex'), cfg);
  const genesisAddr = walletAddress(genesisCtx);
  console.log(`Genesis address : ${genesisAddr}`);

  console.log('Waiting for genesis wallet sync…');
  await waitForSync(genesisCtx);

  const genBal = await getNightBalance(genesisCtx);
  console.log(`Genesis NIGHT   : ${fmtNight(genBal)}`);
  if (genBal === 0n) throw new Error('Genesis wallet has no NIGHT — is the node running with this genesis state?');

  // Genesis wallet needs DUST to pay transfer fees.
  const genDust = await getDustBalance(genesisCtx);
  if (genDust === 0n) {
    console.log('\nRegistering genesis wallet for DUST…');
    await registerForDust(genesisCtx);
    await waitForDust(genesisCtx);
  } else {
    console.log(`Genesis DUST    : ${genDust} (already registered)`);
  }

  // 2. Generate mnemonics and derive addresses (offline) --------------------
  console.log('\nGenerating test wallet mnemonics…');
  const records: WalletRecord[] = [];
  for (let i = 0; i < nWallets; i++) {
    const name     = `wallet-${i + 1}`;
    const mnemonic = bip39.generateMnemonic(256); // 24 words
    const seed     = await mnemonicToSeed(mnemonic);
    const address  = await deriveAddress(seed, cfg.network);
    records.push({ name, mnemonic, address });
    console.log(`  ${name}: ${address}`);
  }

  // 3. Transfer NIGHT from genesis to each wallet (sequential — genesis
  //    UTXOs must be spent one at a time unless the node supports tx chaining)
  console.log('\nFunding test wallets from genesis…');
  for (const w of records) {
    console.log(`  Sending ${fmtNight(night)} → ${w.name}…`);
    const txHash = await transferNight(genesisCtx, w.address, night);
    console.log(`  tx: ${txHash}`);
  }
  await closeWallet(genesisCtx);

  // 4. Save wallet store before DUST registration so partial progress is kept.
  const store: WalletStore = { network: cfg.network, wallets: records };
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
  console.log(`\nWallet store saved to ${storePath}`);

  // 5. Register each wallet for DUST ----------------------------------------
  console.log('\nRegistering test wallets for DUST…');
  for (const w of records) {
    console.log(`\n${w.name} (${w.address})`);
    const seed = await mnemonicToSeed(w.mnemonic);
    const ctx  = await initWallet(seed, cfg);

    console.log('  Waiting for sync + funds…');
    await waitForSync(ctx);
    await waitForFunds(ctx);

    const bal = await getNightBalance(ctx);
    console.log(`  NIGHT balance : ${fmtNight(bal)}`);

    await registerForDust(ctx);
    await waitForDust(ctx);

    const dust = await getDustBalance(ctx);
    console.log(`  DUST balance  : ${dust}`);
    await closeWallet(ctx);
  }

  console.log('\n=== setup complete — wallets are funded and ready for "run" ===');
}

// ---------------------------------------------------------------------------
// run command
// ---------------------------------------------------------------------------

interface TxResult {
  wallet: string;
  seq:    number;
  txHash: string;
  ms:     number;
}

async function cmdRun(opts: {
  txsPerWallet: number;
  storePath:    string;
  cfg:          NetConfig;
}): Promise<void> {
  const { txsPerWallet, storePath, cfg } = opts;

  const raw   = await fs.readFile(storePath, 'utf-8').catch(() => {
    throw new Error(`Wallet store not found at ${storePath} — run "setup" first`);
  });
  const store: WalletStore = JSON.parse(raw);
  if (store.wallets.length === 0) throw new Error('No wallets in store — run "setup" first');

  const nWallets  = store.wallets.length;
  const totalTxs  = nWallets * txsPerWallet;
  const sendAmt   = 1_000_000n; // 1 NIGHT per transfer

  console.log(`\n=== run: ${nWallets} wallet(s) × ${txsPerWallet} tx(s) = ${totalTxs} transfers on ${cfg.network} ===\n`);

  // Initialise all wallets in parallel.
  console.log('Initialising wallets…');
  const ctxs = await Promise.all(
    store.wallets.map(async (w) => {
      const seed = await mnemonicToSeed(w.mnemonic);
      return initWallet(seed, cfg);
    }),
  );

  console.log('Waiting for all wallets to sync…');
  await Promise.all(ctxs.map(waitForSync));

  // Verify DUST is available.
  for (let i = 0; i < ctxs.length; i++) {
    const dust = await getDustBalance(ctxs[i]);
    if (dust === 0n) {
      throw new Error(`${store.wallets[i].name} has no DUST — re-run "setup" or wait for DUST to accrue`);
    }
    console.log(`  ${store.wallets[i].name}: DUST=${dust}, NIGHT=${fmtNight(await getNightBalance(ctxs[i]))}`);
  }

  // Each wallet sends to the next in a circular pattern.
  const results: TxResult[] = [];
  console.log(`\nSending (circular pattern, each wallet → next)…`);

  const globalStart = Date.now();

  await Promise.all(
    ctxs.map(async (ctx, i) => {
      const toAddr = walletAddress(ctxs[(i + 1) % nWallets]);
      const name   = store.wallets[i].name;
      for (let t = 0; t < txsPerWallet; t++) {
        const t0     = Date.now();
        const txHash = await transferNight(ctx, toAddr, sendAmt);
        const ms     = Date.now() - t0;
        results.push({ wallet: name, seq: t + 1, txHash, ms });
        console.log(`  ${name} tx ${t + 1}/${txsPerWallet}  ${txHash}  (${ms} ms)`);
      }
    }),
  );

  const totalMs  = Date.now() - globalStart;
  const avgMs    = Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length);
  const minMs    = Math.min(...results.map((r) => r.ms));
  const maxMs    = Math.max(...results.map((r) => r.ms));
  const tps      = (totalTxs / (totalMs / 1000)).toFixed(2);

  console.log(`
=== Results ===
Total transactions : ${totalTxs}
Wall-clock time    : ${(totalMs / 1000).toFixed(2)} s
Submission TPS     : ${tps}  (proof generation + submission, not finality)
Latency per tx     : avg ${avgMs} ms  min ${minMs} ms  max ${maxMs} ms
`);

  await Promise.all(ctxs.map(closeWallet));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmtNight(raw: bigint): string {
  return `${raw / 1_000_000n}.${String(raw % 1_000_000n).padStart(6, '0')}`;
}

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Midnight NIGHT transfer TPS experiment

Commands:
  setup   Fund test wallets from the genesis wallet and register DUST
  run     Burst NIGHT transfers across funded wallets and report TPS

Options (both commands):
  --network  NAME   undeployed | preprod          (default: undeployed)
  --store    PATH   Wallet JSON store path         (default: ./night-tps-wallets.json)
  --node     URL    Node RPC URL
  --indexer  URL    Indexer GraphQL URL
  --prover   URL    Proof server URL

Options (setup only):
  --wallets  N      Number of test wallets         (default: 3)
  --night    N      NIGHT per wallet (whole units)  (default: 1000)

Options (run only):
  --txs      N      Transactions per wallet         (default: 5)

Examples:
  npx tsx src/night-tps.ts setup --wallets 5 --night 500
  npx tsx src/night-tps.ts run   --txs 10
`);
    process.exit(0);
  }

  const network   = flag(rest, 'network', 'undeployed');
  const storePath = flag(rest, 'store',   './night-tps-wallets.json');
  const defaults  = NETWORK_DEFAULTS[network] ?? NETWORK_DEFAULTS['undeployed'];

  const cfg: NetConfig = {
    network,
    node:    flag(rest, 'node',    defaults.node),
    indexer: flag(rest, 'indexer', defaults.indexer),
    prover:  flag(rest, 'prover',  defaults.prover),
  };

  setNetworkId(cfg.network as any);
  console.log(`Network : ${cfg.network}`);
  console.log(`Node    : ${cfg.node}`);
  console.log(`Indexer : ${cfg.indexer}`);
  console.log(`Prover  : ${cfg.prover}`);

  switch (command) {
    case 'setup': {
      const nWallets = parseInt(flag(rest, 'wallets', '3'));
      const nightN   = parseFloat(flag(rest, 'night', '1000'));
      const night    = BigInt(Math.floor(nightN * 1_000_000));
      await cmdSetup({ nWallets, night, storePath, cfg });
      break;
    }
    case 'run': {
      const txsPerWallet = parseInt(flag(rest, 'txs', '5'));
      await cmdRun({ txsPerWallet, storePath, cfg });
      break;
    }
    default:
      console.error(`Unknown command: "${command}". Use "setup" or "run" (or --help).`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nFatal error:', e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
