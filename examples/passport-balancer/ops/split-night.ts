/**
 * Split the balancer's NIGHT into N UTxOs, so its DUST arrives in N coins.
 *
 * THIS SCRIPT IS NOT APPROVED TO RUN. As of 2026/09/02 the authorisation on the
 * DUST-coin split is `approved=false`: the sizing may be computed, printed, and
 * argued about, and nothing may be moved. `--plan` is therefore the only mode
 * anybody should be invoking, and `--execute` refuses unless an operator has
 * deliberately set `SPLIT_APPROVED=yes` AND stopped the service. Read
 * `./SPLIT.md` before you even consider the second one.
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
 *   node dist/ops/split-night.mjs --plan --outputs 8 --total 4998916000
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
import { DustWallet } from '@midnight-ntwrk/wallet-sdk/dust';
import { WalletFacade, type FacadeState } from '@midnight-ntwrk/wallet-sdk/facade';
import { Roles } from '@midnight-ntwrk/wallet-sdk/hd';
import { WasmProver } from '@midnight-ntwrk/wallet-sdk/prover-client/effect';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk/shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk/unshielded';

import { applyEnvFile, loadConfig, type BalancerConfig } from '../src/config.js';
import { deriveRoleKeys, formatNight } from '../src/wallet.js';
import { computeSplitPlan, formatSplitPlan, type SplitPlan } from './splitPlan.js';

// The wallet SDK's indexer client needs a global WebSocket under plain Node.
(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket;

const SERVICE_UNIT = 'passport-balancer';
/** The balancer's own holding on 2026/09/02, for `--plan` with no wallet. */
const DEFAULT_TOTAL_ATOMIC = 4_998_916_000n;
const DEFAULT_OUTPUTS = 8;

interface Options {
  mode: 'plan' | 'execute' | 'help';
  outputs: number;
  total: bigint | null;
  cold: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
  let mode: Options['mode'] = 'help';
  let outputs = DEFAULT_OUTPUTS;
  let total: bigint | null = null;
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
      case '--total': {
        const raw = argv[index + 1];
        if (!raw || !/^\d+$/.test(raw)) {
          throw new Error('--total takes atomic NIGHT as digits (4998916000 = 4,998.916 NIGHT)');
        }
        total = BigInt(raw);
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

  return { mode, outputs, total, cold };
}

const USAGE = `split-night — size and (only when approved) perform a DUST-coin split

  --plan [--outputs N] [--total ATOMIC]   print the sizing. Moves nothing, needs
                                          no seed, no wallet, no network.
  --execute --outputs N [--cold]          perform the split. Refuses unless
                                          SPLIT_APPROVED=yes and the
                                          ${SERVICE_UNIT} unit is stopped.

The split is NOT approved as of 2026/09/02. Read ops/SPLIT.md first.`;

/** A refusal an operator can act on, as distinct from a crash. */
class Refusal extends Error {}

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
 * half-written state becomes the state.
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
 */
async function openWallet(config: BalancerConfig, cold: boolean): Promise<OpenedWallet> {
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
        ? UnshieldedWallet(cfg).restore(snapshot.unshielded)
        : UnshieldedWallet(cfg).startWithPublicKey(publicKey),
    dust: (cfg) =>
      snapshot
        ? DustWallet(cfg).restore(snapshot.dust)
        : DustWallet(cfg).startWithSecretKey(
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
   pair — the service must be able to resume from what this leaves behind. */
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

/** NIGHT UTxOs and DUST coins, the two counts the split is judged by. */
function shape(state: FacadeState, nightTokenType: string): {
  nightAtomic: bigint;
  nightUtxos: number;
  dustCoins: number;
} {
  const nightUtxos = (state.unshielded.availableCoins ?? []).filter(
    (coin) => coin.utxo.type === nightTokenType,
  );
  return {
    nightAtomic: state.unshielded.balances[nightTokenType] ?? 0n,
    nightUtxos: nightUtxos.length,
    dustCoins: state.dust.availableCoins.length + state.dust.pendingCoins.length,
  };
}

async function execute(options: Options): Promise<void> {
  if (process.env.SPLIT_APPROVED !== 'yes') {
    throw new Refusal(
      'the DUST-coin split is approved=false. Nothing moves. Set SPLIT_APPROVED=yes only once the split has been approved in writing — and read ops/SPLIT.md first.',
    );
  }
  assertServiceStopped();

  applyEnvFile();
  let config: BalancerConfig;
  try {
    config = loadConfig();
  } catch (cause) {
    /* A missing seed or a malformed env is an operator problem to fix, not a
       crash to read a stack trace out of. */
    throw new Refusal(
      `the balancer's own environment does not load: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  await assertNoSnapshotWriteInFlight(config);

  const wallet = await openWallet(config, options.cold);
  try {
    const synced = await waitForSync(wallet.facade);
    const nightTokenType = ledger.nativeToken().raw;
    const before = shape(synced, nightTokenType);
    console.log(
      `[split] ${wallet.address} holds ${formatNight(before.nightAtomic)} NIGHT in ${before.nightUtxos} UTxO(s), ${before.dustCoins} DUST coin(s)`,
    );

    if (before.nightAtomic <= 0n) throw new Refusal('the wallet holds no NIGHT');
    if (before.nightUtxos >= options.outputs) {
      throw new Refusal(
        `the wallet already holds ${before.nightUtxos} NIGHT UTxO(s); splitting into ${options.outputs} would not add a lane`,
      );
    }

    const plan = computeSplitPlan({
      totalAtomicNight: before.nightAtomic,
      outputs: options.outputs,
    });
    console.log(formatSplitPlan(plan));

    const identifier = await submitSplit(wallet, plan, nightTokenType);
    console.log(`[split] submitted ${identifier}`);

    const after = await waitForShape(wallet.facade, nightTokenType, options.outputs);
    console.log(
      `[split] settled: ${after.nightUtxos} NIGHT UTxO(s), ${after.dustCoins} DUST coin(s)`,
    );
    await wallet.save();
    console.log(
      `[split] done. The new coins hold NO DUST yet: no fee is payable for about ${plan.worstCaseBlackoutSeconds} s, and the coins are not independent for about ${plan.singleLaneGapSeconds} s. Start ${SERVICE_UNIT} and watch that its first registration logs 'already-generating', not 'registered' — see ops/SPLIT.md.`,
    );
  } finally {
    await wallet.facade.stop().catch(() => undefined);
  }
}

/**
 * One unshielded self-transfer: `outputs - 1` explicit outputs of the per-coin
 * amount, and the change the wallet gives itself is the last coin. Paying
 * oneself is what makes this safe — every atomic unit that leaves the wallet
 * comes straight back to the same address, and a failure loses only the fee.
 */
async function submitSplit(
  wallet: OpenedWallet,
  plan: SplitPlan,
  nightTokenType: string,
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
  const recipe = await wallet.facade.transferTransaction(
    [{ type: 'unshielded', outputs }],
    { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey },
    { ttl, payFees: true },
  );
  const signed = await wallet.facade.signRecipe(recipe, wallet.keystore.signDataAsync);
  console.log('[split] proving…');
  const finalized = await wallet.facade.finalizeRecipe(signed);
  console.log(`[split] proved ${String(finalized.transactionHash())}, submitting`);
  return wallet.facade.submitTransaction(finalized);
}

/**
 * Waits for the wallet to SEE the split, not merely for the node to accept it:
 * `outputs` NIGHT UTxOs, and one DUST entry per NIGHT UTxO plus the one the old
 * NIGHT left behind.
 */
async function waitForShape(
  facade: WalletFacade,
  nightTokenType: string,
  outputs: number,
): Promise<{ nightAtomic: bigint; nightUtxos: number; dustCoins: number }> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const state = await currentState(facade);
    const seen = shape(state, nightTokenType);
    if (seen.nightUtxos >= outputs && seen.dustCoins >= outputs) {
      return seen;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the split did not settle within 15 min: ${seen.nightUtxos} NIGHT UTxO(s), ${seen.dustCoins} DUST coin(s). The transaction may still land — check before retrying anything.`,
      );
    }
    console.log(
      `[split]   waiting: ${seen.nightUtxos}/${outputs} NIGHT UTxO(s), ${seen.dustCoins} DUST coin(s)`,
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

  if (options.mode === 'plan') {
    console.log(
      formatSplitPlan(
        computeSplitPlan({
          totalAtomicNight: options.total ?? DEFAULT_TOTAL_ATOMIC,
          outputs: options.outputs,
        }),
      ),
    );
    return 0;
  }

  try {
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
