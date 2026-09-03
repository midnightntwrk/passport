/**
 * Split CHOSEN NIGHT UTxOs into N UTxOs each, so the balancer's DUST arrives in
 * more coins and its spend lanes multiply.
 *
 * WHAT CHANGED ON 2026/09/02. This script was written for a wallet that held
 * one lump of NIGHT, and it split the lot. The wallet now holds four material
 * UTxOs, and the ruling is to split only the two NEWEST 5,000 NIGHT coins into
 * ten coins of 1,000 — leaving the original coin and the third 5,000 untouched
 * so their accrued DUST keeps paying fees while the new coins generate from
 * zero. That makes WHICH UTxOs are spent the load-bearing question, and the
 * answer is `--inputs`.
 *
 * WHY `--inputs` NEEDED REAL WORK. The wallet SDK's unshielded transfer does
 * its own coin selection and offers no way to pin inputs:
 * `WalletFacade.transferTransaction` takes `{ type, outputs }` and a
 * `{ ttl, payFees }` — there is no `inputs` field in the type or the runtime
 * (`wallet-sdk-facade/dist/index.d.ts:427-433`, `index.js:686-710`). The
 * selector it uses is `chooseCoin` in
 * `wallet-sdk-capabilities/dist/balancer/Balancer.js:63-68`:
 *
 *     coins.filter((c) => c.type === tokenType).sort((a,b) => Number(a.value-b.value)).at(0)
 *
 * — SMALLEST-FIRST, called repeatedly until the outputs are covered. So the
 * obvious trick of "just ask for a self-send of exactly 5,000 and let the
 * selector satisfy it from one 5,000 coin" DOES NOT WORK: the smallest UTxO in
 * this wallet is the original ~4,998.9 coin, so it would be taken FIRST, then a
 * 5,000 to cover the shortfall — spending the very coin the ruling protects,
 * and breaking one 5,000 anyway.
 *
 * WHAT DOES WORK. `V1Builder.withCoinSelection` replaces that selector
 * wholesale (`wallet-sdk-unshielded-wallet/dist/v1/V1Builder.d.ts:45`), and the
 * selector is the ONLY way a UTxO becomes an unshielded input: `makeTransfer`
 * calls `#balanceSegment(..., this.getCoinSelection())`, which passes it
 * straight to `getBalanceRecipe`, whose `doBalance` adds inputs from nowhere
 * else (`v1/Transacting.js:100,114,243-255`;
 * `capabilities/dist/balancer/Balancer.js:28-62`). So a selector that only ever
 * returns UTxOs from an allow-list — and `undefined` for everything else —
 * provably cannot spend a protected coin: the worst it can do is fail to cover
 * the outputs, which surfaces as `InsufficientFundsError` before anything is
 * signed. This script wires that selector up through `CustomUnshieldedWallet`,
 * and then CHECKS the built transaction's own offer inputs against the
 * allow-list before it signs anything.
 *
 * THIS SCRIPT MOVES NIGHT. `--execute` refuses unless an operator has
 * deliberately set `SPLIT_APPROVED=yes` AND stopped the service AND named the
 * inputs. `--plan` moves nothing, and `--plan --live` reads the live wallet
 * without ever writing a snapshot. Read `./SPLIT.md` before the second one.
 *
 * WHY IT IS A SEPARATE SCRIPT AND NOT A ROUTE. This spends the NIGHT that backs
 * every DUST coin the balancer sponsors from. It must never be reachable over
 * HTTP, must never run concurrently with the service (two writers, one
 * snapshot, one coin set), and must be readable end to end by whoever signs off
 * on running it. So: no server, no queue, no retries, one transaction, and a
 * refusal for every precondition it cannot prove.
 *
 * It is deliberately NOT wired into `package.json` — that file belongs to the
 * service. Build it ad hoc:
 *
 *   npx esbuild ops/split-night.ts --bundle --format=esm --platform=node \
 *     --packages=external --outfile=dist/ops/split-night.mjs
 *   node dist/ops/split-night.mjs --plan --outputs 5 --amount 1000 --spend 5000
 */

import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import WebSocket from 'ws';
import * as Rx from 'rxjs';

import * as ledger from '@midnightntwrk/ledger-v9';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { type KeyMaterialProvider } from '@midnight-ntwrk/zkir-v2';
import { NoOpTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk';
import { UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import {
  makeServerProvingService,
  makeWasmProvingService,
} from '@midnight-ntwrk/wallet-sdk/capabilities/proving';
import { CustomDustWallet, DustWallet } from '@midnight-ntwrk/wallet-sdk/dust';
import { V1Builder as DustV1Builder } from '@midnight-ntwrk/wallet-sdk/dust/v1';
import { WalletFacade, type FacadeState } from '@midnight-ntwrk/wallet-sdk/facade';
import { Roles } from '@midnight-ntwrk/wallet-sdk/hd';
import { WasmProver } from '@midnight-ntwrk/wallet-sdk/prover-client/effect';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk/shielded';
import {
  createKeystore,
  CustomUnshieldedWallet,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk/unshielded';
import { V1Builder } from '@midnight-ntwrk/wallet-sdk/unshielded/v1';

import { applyEnvFile, loadConfig, type BalancerConfig } from '../src/config.js';
import { dustFeeFirst } from '../src/coinReservation.js';
import { deriveRoleKeys, formatNight } from '../src/wallet.js';
import {
  assertOnlyChosenInputs,
  createPinnedSelector,
  parseNightAmount,
  parseUtxoRef,
  Refusal,
  resolveRefs,
  utxoKey,
  type PinnedSelector,
  type TransactionLike,
  type UtxoRef,
} from './splitInputs.js';
import {
  ATOMIC_PER_NIGHT,
  computeSplitPlan,
  formatNightAtomic,
  formatSplitPlan,
  RULED_PER_COIN_ATOMIC_NIGHT,
  type SplitPlan,
} from './splitPlan.js';

// The wallet SDK's indexer client needs a global WebSocket under plain Node.
(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket;

const SERVICE_UNIT = 'passport-balancer';
/** The ruling of 2026/09/02: five coins of 1,000 NIGHT out of each 5,000. */
const DEFAULT_OUTPUTS = 5;
/** One 5,000 NIGHT UTxO, for `--plan` with no wallet. */
const DEFAULT_SPEND_ATOMIC = 5_000n * ATOMIC_PER_NIGHT;

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Options {
  mode: 'plan' | 'execute' | 'help';
  outputs: number;
  /** Size of each output, atomic. `--amount 1000` → 1,000,000,000. */
  perCoinAtomic: bigint;
  /** Offline sizing only: what the chosen inputs would carry. */
  spendAtomic: bigint | null;
  inputs: UtxoRef[];
  /** Read the live wallet (never writing to it) rather than sizing on paper. */
  live: boolean;
  cold: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
  let mode: Options['mode'] = 'help';
  let outputs = DEFAULT_OUTPUTS;
  let perCoinAtomic = RULED_PER_COIN_ATOMIC_NIGHT;
  let spendAtomic: bigint | null = null;
  let inputs: UtxoRef[] = [];
  let live = false;
  let cold = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--plan':
        mode = 'plan';
        break;
      case '--execute':
        mode = 'execute';
        break;
      case '--live':
        live = true;
        break;
      case '--cold':
        cold = true;
        break;
      case '--outputs': {
        const value = Number(argv[index + 1]);
        if (!Number.isInteger(value) || value < 2) {
          throw new Error('--outputs takes an integer of 2 or more');
        }
        outputs = value;
        index += 1;
        break;
      }
      case '--amount': {
        try {
          perCoinAtomic = parseNightAmount(argv[index + 1]);
        } catch (cause) {
          throw new Error(`--amount: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        if (perCoinAtomic <= 0n) throw new Error('--amount must be positive');
        index += 1;
        break;
      }
      case '--spend': {
        try {
          spendAtomic = parseNightAmount(argv[index + 1]);
        } catch (cause) {
          throw new Error(`--spend: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        index += 1;
        break;
      }
      case '--inputs': {
        const raw = argv[index + 1];
        if (!raw) throw new Error('--inputs takes <intentHash>:<outputNo>[,…]');
        inputs = raw
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .map(parseUtxoRef);
        if (inputs.length === 0) throw new Error('--inputs named no UTxOs');
        index += 1;
        break;
      }
      case '--help':
      case '-h':
        mode = 'help';
        break;
      default:
        throw new Error(`unrecognised argument ${arg}`);
    }
  }

  return { mode, outputs, perCoinAtomic, spendAtomic, inputs, live, cold };
}

const USAGE = `split-night — size and (only when approved) perform a DUST-coin split

  --plan [--outputs N] [--amount NIGHT] [--spend NIGHT]
        print the sizing on paper. Moves nothing, needs no seed, no wallet,
        no network.

  --plan --live [--inputs REF,…] [--cold]
        print the sizing against the LIVE wallet: every NIGHT UTxO with its
        reference, which ones --inputs would spend, which ones are protected,
        and where the DUST fee would come from. Reads only — it never writes
        the snapshot, so it is safe while ${SERVICE_UNIT} is running.

  --execute --inputs REF,… --outputs N --amount NIGHT [--cold]
        perform the split. Refuses unless SPLIT_APPROVED=yes, the
        ${SERVICE_UNIT} unit is stopped, and --inputs names the UTxOs.

REF is <intentHash>:<outputNo>, copied from the --plan --live listing. A hash
prefix is enough as long as it is unambiguous.

Read ops/SPLIT.md first.`;

/* -------------------------------------------------------------------------- */
/* Preconditions                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Both writers of this wallet's snapshot must never run at once, and "the unit
 * is stopped" is a thing the machine can be asked rather than assumed. A
 * missing `systemctl` is itself a refusal: on a box where the question cannot
 * be answered, the answer is not "probably fine".
 */
function assertServiceStopped(): void {
  const probe = spawnSync('systemctl', ['is-active', SERVICE_UNIT], { encoding: 'utf8' });
  if (probe.error) {
    throw new Refusal(
      `cannot ask systemctl whether ${SERVICE_UNIT} is running (${probe.error.message}). Run this on the droplet, with the unit stopped.`,
    );
  }
  const verdict = `${probe.stdout ?? ''}`.trim() || `${probe.stderr ?? ''}`.trim();
  if (verdict === 'active') {
    throw new Refusal(
      `${SERVICE_UNIT} is active. Stop it first (systemctl stop ${SERVICE_UNIT}) — two writers on one coin set and one snapshot is how the wallet loses track of its own DUST.`,
    );
  }
  console.log(`[split] ${SERVICE_UNIT} is ${verdict} — safe to proceed`);
}

function snapshotPath(config: BalancerConfig): string {
  return join(config.stateDir, `sync-snapshot-${config.networkId}.json`);
}

/**
 * A `.tmp` beside the snapshot means a `writeFile`/`rename` pair was interrupted
 * — the service died mid-save. Opening the wallet over that is how a
 * half-written state becomes the state. It is checked for `--plan --live` too:
 * a plan read off a half-written snapshot names the wrong coins.
 */
async function assertNoSnapshotWriteInFlight(config: BalancerConfig): Promise<void> {
  const temp = `${snapshotPath(config)}.tmp`;
  try {
    await access(temp);
  } catch {
    return;
  }
  throw new Refusal(
    `${temp} exists — a snapshot write was interrupted. Investigate (and move it aside) before splitting.`,
  );
}

function loadBalancerConfig(): BalancerConfig {
  applyEnvFile();
  try {
    return loadConfig();
  } catch (cause) {
    /* A missing seed or a malformed env is an operator problem to fix, not a
       crash to read a stack trace out of. */
    throw new Refusal(
      `the balancer's own environment does not load: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The wallet                                                                 */
/* -------------------------------------------------------------------------- */

interface OpenedWallet {
  facade: WalletFacade;
  address: string;
  addressBytes: UnshieldedAddress;
  keystore: UnshieldedKeystore;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  save(): Promise<void>;
}

/**
 * The same facade the unit builds, from the same env and the same state
 * directory — see `src/wallet.ts::openBalancerWallet`, which this mirrors. It
 * is a mirror rather than a call because that function returns the SERVICE's
 * interface (balance-only, the spend queue, the health hooks) and deliberately
 * exposes no way to build a transfer: a routine spend path that could move the
 * balancer's NIGHT is exactly what should not exist.
 *
 * The ONE deliberate divergence from the service is `selector`: when it is
 * given, the unshielded wallet is built through `CustomUnshieldedWallet` with
 * the pinned selector in place of the SDK's smallest-first default. `--plan`
 * passes nothing and gets the stock wallet, because a plan that read the world
 * through a modified selector would not be describing what `--execute` does.
 */
async function openWallet(
  config: BalancerConfig,
  cold: boolean,
  selector: PinnedSelector | null,
): Promise<OpenedWallet> {
  setNetworkId(config.networkId);

  const keys = deriveRoleKeys(config.seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const keystore: UnshieldedKeystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] },
    config.networkId,
  );
  const publicKey = PublicKey.fromKeyStore(keystore);

  const keyMaterialProvider: KeyMaterialProvider = WasmProver.makeDefaultKeyMaterialProvider();
  const provingService = config.provingServerUrl
    ? makeServerProvingService({ provingServerUrl: new URL(config.provingServerUrl) })
    : makeWasmProvingService({ keyMaterialProvider });

  const snapshot = cold ? null : await readSnapshot(config, publicKey.address);
  if (cold) console.log('[split] --cold: ignoring the sync snapshot, walking from chain');

  /* THE FEE LEG, AND WHY IT NEEDS ITS OWN SELECTOR. The dust wallet's stock
     selection is smallest-first, the same accumulation `chooseCoin` does for
     NIGHT. After the 2026/09/03 crumb split the wallet held fifty-three DUST
     coins below `DUST_CRUMB_FLOOR` — a few thousand million Specks each, the
     generation of the new 0.02-NIGHT coins — and smallest-first swept every
     one of them into the fee leg ahead of the coins that could actually pay
     it. Each input is a separate `/prove` against a proof server whose job
     queue holds ten, so the split died with "Failed to prove: Job Queue full"
     at 12:23 UTC, after the input check had passed and before anything was
     signed. `dustFeeFirst` — the service's own fee selector — takes ONE coin
     that covers the fee, and passes over crumbs while anything else exists. */
  const dustWallet = (cfg: Parameters<typeof DustWallet>[0]) =>
    CustomDustWallet(
      cfg,
      new DustV1Builder().withDefaults().withCoinSelection((() => dustFeeFirst) as never) as never,
    );

  const unshieldedWallet = selector
    ? (cfg: Parameters<typeof UnshieldedWallet>[0]) =>
        CustomUnshieldedWallet(
          cfg,
          new V1Builder()
            .withDefaults()
            /* The one deliberate divergence from the service's wallet. The
               SDK's `CoinSelection` is 4-arity; `amountNeeded` and the cost
               model are ignored here exactly as they are ignored by the stock
               `chooseCoin` it replaces. */
            .withCoinSelection(
              () => (coins: readonly ledger.Utxo[], tokenType: ledger.RawTokenType) =>
                selector.select(coins, tokenType) as ledger.Utxo | undefined,
            ),
        )
    : UnshieldedWallet;

  const facade = await WalletFacade.init({
    configuration: {
      networkId: config.networkId,
      indexerClientConnection: {
        indexerHttpUrl: config.indexerHttpUrl,
        indexerWsUrl: config.indexerWsUrl,
      },
      relayURL: new URL(config.relayUrl),
      costParameters: { feeBlocksMargin: config.feeBlocksMargin },
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
      ...(config.provingServerUrl ? { provingServerUrl: new URL(config.provingServerUrl) } : {}),
    },
    provingService: () => provingService,
    shielded: (cfg) =>
      snapshot
        ? ShieldedWallet(cfg).restore(snapshot.shielded)
        : ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) =>
      snapshot
        ? unshieldedWallet(cfg).restore(snapshot.unshielded)
        : unshieldedWallet(cfg).startWithPublicKey(publicKey),
    dust: (cfg) =>
      snapshot
        ? dustWallet(cfg).restore(snapshot.dust)
        : dustWallet(cfg).startWithSecretKey(
            dustSecretKey,
            ledger.LedgerParameters.initialParameters().dust,
          ),
  });
  await facade.start(shieldedSecretKeys, dustSecretKey);

  return {
    facade,
    address: publicKey.address,
    addressBytes: new UnshieldedAddress(Buffer.from(publicKey.addressHex, 'hex')),
    keystore,
    shieldedSecretKeys,
    dustSecretKey,
    save: () => writeSnapshot(config, facade, publicKey.address),
  };
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

async function readSnapshot(
  config: BalancerConfig,
  address: string,
): Promise<StoredSnapshot | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(snapshotPath(config), 'utf8')) as StoredSnapshot;
    if (
      parsed.version !== 1 ||
      parsed.networkId !== config.networkId ||
      parsed.unshieldedAddress !== address
    ) {
      return null;
    }
    console.log(`[split] resuming from the snapshot saved at ${parsed.savedAt}`);
    return parsed;
  } catch {
    return null;
  }
}

/* Byte-for-byte the shape `src/wallet.ts` writes, including the `.tmp`/rename
   pair — the service must be able to resume from what this leaves behind.
   Called from `--execute` and from nowhere else: `--plan --live` opens the same
   wallet and never reaches this function, which is what makes it read-only. */
async function writeSnapshot(
  config: BalancerConfig,
  facade: WalletFacade,
  address: string,
): Promise<void> {
  const { rename, writeFile } = await import('node:fs/promises');
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
  await writeFile(`${path}.tmp`, JSON.stringify(snapshot), 'utf8');
  await rename(`${path}.tmp`, path);
  console.log(`[split] snapshot saved to ${path}`);
}

function currentState(facade: WalletFacade): Promise<FacadeState> {
  return Rx.firstValueFrom(facade.state().pipe(Rx.timeout({ first: 60_000 })));
}

async function waitForSync(facade: WalletFacade): Promise<FacadeState> {
  console.log('[split] waiting for the wallet to reach the tip…');
  const ticker = setInterval(() => {
    void currentState(facade).then(
      (state) =>
        console.log(
          /* Field names differ per wallet — the unshielded progress counts
             transaction ids (`appliedId`), the dust and shielded ones count
             block indices. Same pair either way: what has been applied against
             what is relevant to THIS wallet, which is the comparison
             `isSynced` itself makes. */
          `[split]   unshielded ${state.unshielded.progress.appliedId}/${state.unshielded.progress.highestTransactionId}, dust ${state.dust.progress.appliedIndex}/${state.dust.progress.highestRelevantWalletIndex}`,
        ),
      () => undefined,
    );
  }, 15_000);
  ticker.unref();
  try {
    return await Rx.firstValueFrom(facade.state().pipe(Rx.filter((state) => state.isSynced)));
  } finally {
    clearInterval(ticker);
  }
}

/* -------------------------------------------------------------------------- */
/* Reading the wallet's shape                                                 */
/* -------------------------------------------------------------------------- */

interface NightUtxo {
  utxo: { intentHash: string; outputNo: number; value: bigint; type: string };
  meta: { ctime: Date; registeredForDustGeneration: boolean };
}

interface DustCoin {
  generatedNow: bigint;
  rate: bigint;
  dtime?: Date | undefined;
}

function nightUtxos(state: FacadeState, nightTokenType: string): NightUtxo[] {
  return ((state.unshielded.availableCoins ?? []) as unknown as NightUtxo[])
    .filter((coin) => coin.utxo.type === nightTokenType)
    .sort((a, b) => a.meta.ctime.getTime() - b.meta.ctime.getTime());
}

function dustCoins(state: FacadeState): DustCoin[] {
  return ([...state.dust.availableCoins] as unknown as DustCoin[]).sort((a, b) =>
    a.generatedNow < b.generatedNow ? -1 : a.generatedNow > b.generatedNow ? 1 : 0,
  );
}

/**
 * Prints every NIGHT UTxO with the reference `--inputs` takes, and marks the
 * ones the split would spend. The `PROTECTED` marker is the line an operator is
 * meant to read before typing `--execute`: it is the promise that the coins
 * still paying fees are not in the transaction.
 */
function reportUtxos(coins: readonly NightUtxo[], chosenKeys: ReadonlySet<string>): string[] {
  return coins.map((coin) => {
    const key = utxoKey(coin.utxo);
    const marker = chosenKeys.has(key) ? 'SPEND    ' : 'PROTECTED';
    const age = `${Math.round((Date.now() - coin.meta.ctime.getTime()) / 60_000)} min old`;
    const registered = coin.meta.registeredForDustGeneration ? 'registered' : 'UNREGISTERED';
    return `  ${marker} ${key}  ${formatNightAtomic(coin.utxo.value).padStart(16)} NIGHT  ${age}, ${registered}`;
  });
}

/**
 * Where the fee comes from.
 *
 * The DUST leg is balanced completely separately from the unshielded one — the
 * facade builds the transfer first and only then calls
 * `dust.balanceTransactions` on the finished transaction
 * (`wallet-sdk-facade/dist/index.js:425`) — and it selects
 * smallest-generated-first, with no knowledge of which NIGHT UTxOs the transfer
 * just consumed. So the coin at the top of this list is the one that pays, and
 * it may well be the DUST backed by a UTxO this very transaction spends. That
 * is not a problem to fix: that DUST starts decaying the moment its backing
 * NIGHT is spent, so spending it first is the right order. It IS something the
 * operator should see before signing.
 */
function reportDustCoins(coins: readonly DustCoin[], parametersRate: bigint): string[] {
  return coins.map((coin, index) => {
    const backing = coin.rate > 0n ? coin.rate / parametersRate : 0n;
    const marker = index === 0 ? 'FEE FROM ' : '         ';
    const decaying = coin.dtime ? ', DECAYING' : '';
    return `  ${marker} ${String(coin.generatedNow).padStart(22)} Specks  backed by ${formatNightAtomic(backing).padStart(16)} NIGHT${decaying}`;
  });
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

function planOnPaper(options: Options): void {
  const spend = options.spendAtomic ?? DEFAULT_SPEND_ATOMIC;
  let plan: SplitPlan;
  try {
    plan = computeSplitPlan({
      spendAtomicNight: spend,
      outputs: options.outputs,
      perCoinAtomicNight: options.perCoinAtomic,
    });
  } catch (cause) {
    /* Arithmetic that does not add up is an argument the operator got wrong,
       not a bug to read a stack trace out of. */
    throw new Refusal(cause instanceof Error ? cause.message : String(cause));
  }
  console.log(formatSplitPlan(plan));
  console.log(
    '\n  This is the sizing on paper. Run --plan --live to see it against the wallet.',
  );
}

async function planAgainstLiveWallet(options: Options): Promise<void> {
  const config = loadBalancerConfig();
  await assertNoSnapshotWriteInFlight(config);

  console.log(
    `[split] --plan --live: reading only. This never writes the snapshot, so ${SERVICE_UNIT} may keep running.`,
  );
  /* The STOCK selector, deliberately: a plan built through the pinned one would
     be describing a wallet the service does not have. */
  const wallet = await openWallet(config, options.cold, null);
  try {
    const synced = await waitForSync(wallet.facade);
    const nightTokenType = ledger.nativeToken().raw;
    const coins = nightUtxos(synced, nightTokenType);
    const dust = dustCoins(synced);
    const generationRate = ledger.LedgerParameters.initialParameters().dust.generationDecayRate;

    const chosen = options.inputs.length > 0 ? resolveRefs(coins, options.inputs) : [];
    const chosenKeys = new Set(chosen.map((coin) => utxoKey(coin.utxo)));
    const protectedCoins = coins.filter((coin) => !chosenKeys.has(utxoKey(coin.utxo)));

    console.log(`\n[split] ${wallet.address}`);
    console.log(
      `[split] holds ${formatNight(synced.unshielded.balances[nightTokenType] ?? 0n)} NIGHT in ${coins.length} UTxO(s), ${dust.length} DUST coin(s)\n`,
    );
    console.log('NIGHT UTxOs (oldest first) — the reference is what --inputs takes:');
    console.log(reportUtxos(coins, chosenKeys).join('\n'));
    console.log('\nDUST coins (smallest first — the SDK balances the fee in this order):');
    console.log(reportDustCoins(dust, BigInt(generationRate)).join('\n'));

    if (chosen.length === 0) {
      console.log(
        '\n[split] no --inputs given, so nothing is selected. Name the UTxOs to size the split.',
      );
      return;
    }

    const spendAtomic = chosen.reduce((sum, coin) => sum + coin.utxo.value, 0n);
    const untouchedSpendable = dust.reduce((sum, coin) => sum + coin.generatedNow, 0n);
    const plan = computeSplitPlan({
      spendAtomicNight: spendAtomic,
      outputs: options.outputs,
      perCoinAtomicNight: options.perCoinAtomic,
      untouchedCoinsAtomicNight: protectedCoins.map((coin) => coin.utxo.value),
      untouchedSpendableSpecks: untouchedSpendable,
    });

    console.log(`\n${formatSplitPlan(plan)}`);
    console.log(`\nWhat --execute would do with these arguments:`);
    console.log(`  spend      ${chosen.length} UTxO(s): ${[...chosenKeys].join(', ')}`);
    console.log(
      `  pay        ${plan.explicitOutputs} × ${plan.perCoinAtomicNight} atomic NIGHT to ${wallet.address}`,
    );
    console.log(`  change     ${plan.changeAtomicNight} atomic NIGHT to the same address`);
    console.log(
      `  fee        DUST, balanced from this wallet's own coins — top of the list above`,
    );
    console.log(
      `  protect    ${protectedCoins.length} UTxO(s) excluded from the transaction: ${protectedCoins.map((coin) => utxoKey(coin.utxo)).join(', ') || '(none)'}`,
    );
    console.log('\n  Nothing was moved and no snapshot was written.');
  } finally {
    await wallet.facade.stop().catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Execute                                                                    */
/* -------------------------------------------------------------------------- */

async function execute(options: Options): Promise<void> {
  if (process.env.SPLIT_APPROVED !== 'yes') {
    throw new Refusal(
      'the DUST-coin split needs SPLIT_APPROVED=yes. Nothing moves. Set it only once the split has been approved in writing — and read ops/SPLIT.md first.',
    );
  }
  if (options.inputs.length === 0) {
    throw new Refusal(
      '--execute needs --inputs. Without it the SDK would select coins smallest-first and take the very UTxOs the ruling protects: run --plan --live, read the listing, and name the UTxOs to spend.',
    );
  }
  assertServiceStopped();

  const config = loadBalancerConfig();
  await assertNoSnapshotWriteInFlight(config);

  const selector = createPinnedSelector();
  const wallet = await openWallet(config, options.cold, selector);
  try {
    const synced = await waitForSync(wallet.facade);
    const nightTokenType = ledger.nativeToken().raw;
    const coins = nightUtxos(synced, nightTokenType);
    if (coins.length === 0) throw new Refusal('the wallet holds no NIGHT');

    let chosen: NightUtxo[];
    try {
      chosen = resolveRefs(coins, options.inputs);
    } catch (cause) {
      throw new Refusal(cause instanceof Error ? cause.message : String(cause));
    }
    const chosenKeys = new Set(chosen.map((coin) => utxoKey(coin.utxo)));
    const protectedCoins = coins.filter((coin) => !chosenKeys.has(utxoKey(coin.utxo)));

    console.log(`[split] ${wallet.address}`);
    console.log(reportUtxos(coins, chosenKeys).join('\n'));

    const spendAtomic = chosen.reduce((sum, coin) => sum + coin.utxo.value, 0n);
    const untouchedSpendable = dustCoins(synced).reduce(
      (sum, coin) => sum + coin.generatedNow,
      0n,
    );
    let plan: SplitPlan;
    try {
      plan = computeSplitPlan({
        spendAtomicNight: spendAtomic,
        outputs: options.outputs,
        perCoinAtomicNight: options.perCoinAtomic,
        untouchedCoinsAtomicNight: protectedCoins.map((coin) => coin.utxo.value),
        untouchedSpendableSpecks: untouchedSpendable,
      });
    } catch (cause) {
      throw new Refusal(cause instanceof Error ? cause.message : String(cause));
    }
    console.log(formatSplitPlan(plan));

    /* The allow-list is the pin. Until this line the selector can hand out
       nothing at all, which is why nothing may build a transfer before it. */
    for (const key of chosenKeys) selector.allow.add(key);

    const identifier = await submitSplit(wallet, plan, nightTokenType, selector, chosenKeys);
    console.log(`[split] submitted ${identifier}`);

    const expectedUtxos = coins.length - chosen.length + options.outputs;
    const after = await waitForShape(wallet.facade, nightTokenType, expectedUtxos);
    console.log(
      `[split] settled: ${after.nightUtxos} NIGHT UTxO(s), ${after.dustCoins} DUST coin(s)`,
    );
    await wallet.save();
    console.log(
      `[split] done. The ${options.outputs} new coins hold NO DUST yet: each needs about ${plan.secondsToLaneCapablePerCoin} s to become a lane. The ${protectedCoins.length} protected coin(s) kept paying throughout. Start ${SERVICE_UNIT} and check its first [dust] line — see ops/SPLIT.md.`,
    );
  } finally {
    await wallet.facade.stop().catch(() => undefined);
  }
}

/**
 * One unshielded self-transfer out of the CHOSEN UTxOs: `outputs - 1` explicit
 * outputs of the per-coin amount, and the change the wallet gives itself is the
 * last coin. Paying oneself is what makes this safe — every atomic unit that
 * leaves the wallet comes straight back to the same address, and a failure
 * loses only the fee.
 */
async function submitSplit(
  wallet: OpenedWallet,
  plan: SplitPlan,
  nightTokenType: string,
  selector: PinnedSelector,
  chosenKeys: ReadonlySet<string>,
): Promise<string> {
  const outputs = Array.from({ length: plan.explicitOutputs }, () => ({
    type: nightTokenType as ledger.RawTokenType,
    receiverAddress: wallet.addressBytes,
    amount: plan.perCoinAtomicNight,
  }));
  console.log(
    `[split] building ${outputs.length} output(s) of ${plan.perCoinAtomicNight} atomic NIGHT to ${wallet.address}, change ${plan.changeAtomicNight}`,
  );

  const ttl = new Date(Date.now() + 30 * 60_000);
  /* `payFees: true` balances the DUST leg out of this wallet's OWN coins —
     there is no sponsor for the sponsor. */
  let recipe;
  try {
    recipe = await wallet.facade.transferTransaction(
      [{ type: 'unshielded', outputs }],
      { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey },
      { ttl, payFees: true },
    );
  } catch (cause) {
    if (selector.refusedFor.length > 0) {
      throw new Refusal(
        `the chosen inputs do not cover ${plan.outputs} × ${plan.perCoinAtomicNight} atomic NIGHT, and the selector refused to reach for a protected coin. Nothing was signed or submitted. (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
    throw cause;
  }

  /* The last gate before a signature, and the one that does not take the
     selector's word for it: it reads the BUILT transaction's own unshielded
     offers. Two independent checks of the same property, because the cost of
     being wrong is the balancer's fee-paying DUST. */
  const spent = assertOnlyChosenInputs(
    recipe.transaction as unknown as TransactionLike,
    chosenKeys,
    selector,
  );
  console.log(
    `[split] verified: the transaction spends ${spent.length} UTxO(s), all of them named by --inputs (${spent.join(', ')})`,
  );

  const signed = await wallet.facade.signRecipe(recipe, wallet.keystore.signDataAsync);
  console.log('[split] proving…');
  const finalized = await wallet.facade.finalizeRecipe(signed);
  console.log(`[split] proved ${String(finalized.transactionHash())}, submitting`);
  return wallet.facade.submitTransaction(finalized);
}

/**
 * Waits for the wallet to SEE the split, not merely for the node to accept it:
 * the expected NIGHT UTxO count, and at least one DUST entry per NIGHT UTxO.
 */
async function waitForShape(
  facade: WalletFacade,
  nightTokenType: string,
  expectedUtxos: number,
): Promise<{ nightUtxos: number; dustCoins: number }> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const state = await currentState(facade);
    const seenNight = nightUtxos(state, nightTokenType).length;
    const seenDust = state.dust.availableCoins.length + state.dust.pendingCoins.length;
    if (seenNight >= expectedUtxos && seenDust >= expectedUtxos) {
      return { nightUtxos: seenNight, dustCoins: seenDust };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the split did not settle within 15 min: ${seenNight}/${expectedUtxos} NIGHT UTxO(s), ${seenDust} DUST coin(s). The transaction may still land — check before retrying anything.`,
      );
    }
    console.log(
      `[split]   waiting: ${seenNight}/${expectedUtxos} NIGHT UTxO(s), ${seenDust} DUST coin(s)`,
    );
    await new Promise((settle) => setTimeout(settle, 10_000));
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (cause) {
    console.error(`[split] ${cause instanceof Error ? cause.message : String(cause)}`);
    console.error(USAGE);
    return 2;
  }

  if (options.mode === 'help') {
    console.log(USAGE);
    return 0;
  }

  try {
    if (options.mode === 'plan') {
      if (options.live) await planAgainstLiveWallet(options);
      else planOnPaper(options);
      return 0;
    }
    await execute(options);
    return 0;
  } catch (cause) {
    if (cause instanceof Refusal) {
      console.error(`[split] refusing: ${cause.message}`);
      return 1;
    }
    console.error('[split] failed', cause);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /split-night(\.[cm]?[jt]s)?$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
