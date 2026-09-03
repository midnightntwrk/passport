/**
 * gift-nft — mint ONE shielded token of its own colour and deposit it into a
 * Passport account, so that account's Assets tab shows an item card.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * It is the balancer's existing asset leg — `mint_shielded` on the mUSD faucet
 * followed by `deposit_shielded` on the account-custody contract — run once, by
 * hand, with two arguments changed: a DIFFERENT domain separator, and an amount
 * of exactly one. Nothing else about the path is new. The faucet computes a
 * coin's colour as `tokenType(separator, kernel.self())`, so a separator this
 * service has never minted under is a colour that has never existed, held by
 * nobody, and a single unit of it is the closest thing this ledger will answer
 * to a one-of-a-kind. That is precisely the rule the client files a holding as
 * an item under — see `passport-demo/src/lib/colour.ts::classifyHolding`.
 *
 * It is NOT a general NFT standard. There is no metadata on chain, no supply
 * cap the ledger enforces, and nothing stops this tool being run twice under
 * the same separator. What makes the card say "Midnight Genesis Pass" is a
 * registry in the client keyed by the colour hex this prints. Pin the hex there
 * and the two agree; do not, and the account holds an anonymous item.
 *
 * WHY IT NEEDS THE UNIT STOPPED
 * -----------------------------
 * For the reason `SPLIT.md` sets out at length: this opens the SERVICE'S OWN
 * wallet, from the service's seed and the service's sync snapshot, and two
 * writers over one coin set and one snapshot is how a wallet loses track of its
 * own DUST. `--dry-run` opens no wallet at all and is therefore safe against a
 * running unit — it computes the colour off the faucet address and the
 * separator, which is all a client needs to pin a registry entry.
 *
 * The stop is NOT ten seconds. A mint has to become spendable in this wallet
 * before it can be deposited, which is the three minutes `MINT_VISIBLE_ATTEMPTS`
 * in `../src/account.ts` exists for, and the deposit's credit then has to be
 * read back off the chain. Budget five to ten minutes with the unit down, run
 * it when nobody is onboarding, and start the unit again afterwards: the
 * snapshot this leaves behind is the one the service resumes from.
 *
 *   systemctl stop passport-balancer
 *   node /opt/passport-balancer/dist/ops/gift-nft.mjs --account <address> --execute
 *   systemctl start passport-balancer
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Move NIGHT. The only transactions it builds are a faucet mint and an account
 * deposit, both of which pay a DUST fee and neither of which has an unshielded
 * output. The account contract is compiled here with the same three refusing
 * witnesses `../src/account.ts` gives it, so `withdraw_night`, `grant_withdraw_night`
 * and `recover` are impossible from this process by construction.
 */

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import * as ledger from '@midnightntwrk/ledger-v9';

import { applyEnvFile, loadConfig, type BalancerConfig } from '../src/config.js';
import {
  CONFIRM_INTERVAL_MS,
  bytesToHex,
  contractProviders,
  createContractProofProvider,
  hexToBytes,
  managedBuildPath,
  publicDataProviderFor,
  rawContractAddress,
  resolveTransactionHash,
  transactionIdentifier,
  wait,
} from '../src/contractRuntime.js';
import { openBalancerWallet, type BalancerWallet } from '../src/wallet.js';

const SERVICE_UNIT = 'passport-balancer';

/** The separator, the title, and the image the client pins against this colour. */
export const DEFAULT_SEPARATOR_LABEL = 'midnight-genesis-pass';
export const DEFAULT_ITEM_NAME = 'Midnight Genesis Pass';

/** Attempts, {@link CONFIRM_INTERVAL_MS} apart, for each of the two waits. */
const MINT_VISIBLE_ATTEMPTS = 360;
const CONFIRM_ATTEMPTS = 180;

/* -------------------------------------------------------------------------- */
/* The separator                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A label as the 32-byte domain separator `mint_shielded` takes.
 *
 * ASCII, left-aligned, zero-padded — chosen because it is READABLE in a hex
 * dump and reproducible from the label alone by anybody, including a reviewer
 * with no access to this repository. mUSD's separator (32 zero bytes with a
 * leading `0x06`) is not of this shape and is deliberately not reachable here:
 * the two must never collide, or a gift would mint the sponsor's stablecoin.
 *
 * A label is refused rather than truncated past 32 bytes. Truncation would make
 * two different labels the same currency, which is the one mistake in this file
 * that would not announce itself.
 */
export function separatorBytes(label: string): Uint8Array {
  const ascii = label.trim();
  if (!/^[\x21-\x7e][\x20-\x7e]*$/.test(ascii)) {
    throw new Error(`the separator label must be printable ASCII, not ${JSON.stringify(label)}`);
  }
  const encoded = new TextEncoder().encode(ascii);
  if (encoded.length > 32) {
    throw new Error(
      `the separator label is ${encoded.length} bytes and the separator is 32; shorten ${JSON.stringify(ascii)}`,
    );
  }
  const bytes = new Uint8Array(32);
  bytes.set(encoded, 0);
  return bytes;
}

/**
 * The colour a coin minted under `label` against `faucetAddress` will carry.
 *
 * The SAME call `../src/account.ts` makes for mUSD, against the same faucet, so
 * a colour this prints and a colour the service reports over `/status` are
 * computed by one function and cannot drift apart.
 */
export function giftColourHex(label: string, faucetAddress: string): string {
  const tokenType = String(ledger.rawTokenType(separatorBytes(label), faucetAddress));
  return bytesToHex(ledger.encodeRawTokenType(tokenType));
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

export interface Options {
  account: string | null;
  name: string;
  separator: string;
  amount: bigint;
  execute: boolean;
  help: boolean;
}

export class Refusal extends Error {}

const USAGE = `gift-nft — mint one shielded item and deposit it into a Passport account

  --account <address>      the account-custody contract to deposit into (required)
  --name <title>           what the client calls it (default: ${DEFAULT_ITEM_NAME})
  --separator <label>      the domain separator, which IS the colour
                           (default: ${DEFAULT_SEPARATOR_LABEL})
  --amount <n>             units to mint (default: 1 — anything else is not an item)
  --execute                actually mint and deposit; without it, print the plan
  --help

--execute requires the ${SERVICE_UNIT} unit to be stopped. --dry-run (the
default) opens no wallet and is safe to run against the live service.`;

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    account: null,
    name: DEFAULT_ITEM_NAME,
    separator: DEFAULT_SEPARATOR_LABEL,
    amount: 1n,
    execute: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Refusal(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case '--account':
        options.account = value();
        break;
      case '--name':
        options.name = value();
        break;
      case '--separator':
        options.separator = value();
        break;
      case '--amount':
        options.amount = BigInt(value());
        break;
      case '--execute':
        options.execute = true;
        break;
      /* Named for symmetry with `--execute` and accepted so an operator who
         types the safe flag explicitly is not refused for it. It is the
         default; there is nothing to set. */
      case '--dry-run':
      case '--plan':
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Refusal(`unknown argument ${flag}`);
    }
  }
  if (options.amount <= 0n) throw new Refusal('--amount must be positive');
  return options;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

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
  console.log(`[gift] ${SERVICE_UNIT} is ${verdict} — safe to proceed`);
}

function loadBalancerConfig(): BalancerConfig {
  applyEnvFile();
  try {
    return loadConfig();
  } catch (cause) {
    throw new Refusal(
      `the balancer's own environment does not load: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function requireFaucet(config: BalancerConfig): string {
  if (!config.assetFaucetAddress) {
    throw new Refusal(
      `no faucet is configured for ${config.networkId}; set BALANCER_ASSET_FAUCET_ADDRESS. The faucet address is half the colour.`,
    );
  }
  return config.assetFaucetAddress;
}

interface FaucetModule {
  Contract: new (witnesses: unknown) => unknown;
}
interface AccountModule {
  Contract: new (witnesses: unknown) => unknown;
  ledger: (state: unknown) => {
    coins: {
      member: (colour: Uint8Array) => boolean;
      lookup: (colour: Uint8Array) => { value: bigint };
    };
  };
}

/** Prints what `--execute` would do, opening no wallet. */
function plan(config: BalancerConfig, options: Options): void {
  const faucetAddress = requireFaucet(config);
  const colourHex = giftColourHex(options.separator, faucetAddress);
  console.log('[gift] plan (nothing has been minted — pass --execute)');
  console.log(`[gift]   network      ${config.networkId}`);
  console.log(`[gift]   faucet       ${faucetAddress}`);
  console.log(`[gift]   separator    ${options.separator}`);
  console.log(`[gift]   separator/hx ${bytesToHex(separatorBytes(options.separator))}`);
  console.log(`[gift]   amount       ${options.amount}`);
  console.log(`[gift]   name         ${options.name}`);
  console.log(`[gift]   account      ${options.account ?? '(none given — --account is required to execute)'}`);
  console.log(`[gift]   COLOUR       ${colourHex}`);
  console.log('[gift] pin that colour in passport-demo/src/lib/colour.ts::KNOWN_ITEMS');
  if (options.amount !== 1n) {
    console.log(
      '[gift] WARNING: the client files a holding as an item only at exactly one unit; this amount will show as a token row.',
    );
  }
}

async function execute(config: BalancerConfig, options: Options): Promise<void> {
  const faucetAddress = requireFaucet(config);
  const address = rawContractAddress(
    options.account ?? (() => {
      throw new Refusal('--account is required');
    })(),
  );
  const colourHex = giftColourHex(options.separator, faucetAddress);
  const separator = separatorBytes(options.separator);
  const tokenType = String(ledger.rawTokenType(separator, faucetAddress));
  const colourBytes = ledger.encodeRawTokenType(tokenType);

  assertServiceStopped();
  plan(config, options);

  /* Both builds and both proof providers, before the wallet is opened: a
     missing artefact set is an operator's problem to fix and there is no reason
     to have walked the chain first to discover it. */
  const faucetPath = managedBuildPath('faucet', {
    configured: config.assetAssetsPath,
    remedy: 'The build ships in examples/passport-balancer/contracts-stagenet/managed/faucet.',
  });
  const accountPath = managedBuildPath('account', {
    configured: config.accountAssetsPath,
    remedy: 'The build ships in examples/passport-balancer/contracts-stagenet/managed/account.',
  });

  /* LITERAL relative specifiers, for the reason `../src/account.ts` gives at
     its own imports: `contracts-stagenet` carries its own `node_modules`, so a
     computed absolute path resolves a SECOND compact-runtime and decoding then
     dies on `expected instance of ChargedState`. */
  const faucet = (await import(
    '../contracts-stagenet/managed/faucet/contract/index.js'
  )) as unknown as FaucetModule;
  const account = (await import(
    '../contracts-stagenet/managed/account/contract/index.js'
  )) as unknown as AccountModule;
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const { NodeZkConfigProvider } = await import(
    '@midnight-ntwrk/midnight-js-node-zk-config-provider'
  );
  const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');

  const faucetZkConfig = new NodeZkConfigProvider(faucetPath);
  const accountZkConfig = new NodeZkConfigProvider(accountPath);
  const { proofProvider: faucetProofProvider } = await createContractProofProvider(
    config,
    faucetZkConfig as never,
  );
  const { proofProvider: accountProofProvider } = await createContractProofProvider(
    config,
    accountZkConfig as never,
  );

  const compiledFaucet = CompiledContract.make('passport-musd-faucet', faucet.Contract as never).pipe(
    /* The faucet declares no witnesses: `mint_shielded` takes the separator,
       the amount, the nonce, and the recipient as arguments and knows nothing
       private. */
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(faucetPath),
  );
  /* The same three refusals `../src/account.ts` builds this contract with. This
     process may put a coin into an account and there is nothing it holds that
     could take one out. */
  const refusingWitness = (name: string) => (): never => {
    throw new Error(`gift-nft has no ${name}: it may deposit into an account and nothing else.`);
  };
  const compiledAccount = CompiledContract.make('passport-account', account.Contract as never).pipe(
    CompiledContract.withWitnesses({
      device_secret: refusingWitness('device secret'),
      grant_secret: refusingWitness('grant secret'),
      recovery_secret: refusingWitness('recovery secret'),
    } as never),
    CompiledContract.withCompiledFileAssets(accountPath),
  );

  const reader = await publicDataProviderFor(config);
  const heldItem = async (): Promise<bigint> => {
    const state = await reader.queryContractState(address);
    if (!state) throw new Refusal(`no contract state is served at ${address} on ${config.networkId}`);
    const decoded = account.ledger((state as { data: unknown }).data);
    return decoded.coins.member(colourBytes) ? decoded.coins.lookup(colourBytes).value : 0n;
  };

  const before = await heldItem();
  console.log(`[gift] ${address} holds ${before} of this colour before the gift`);

  let wallet: BalancerWallet | null = null;
  try {
    wallet = await openBalancerWallet(config);
    console.log(`[gift] wallet ${wallet.address} — waiting for the tip…`);
    await wallet.waitForSync();
    await wallet.warmProvingKeys();

    /* ---------------------------------------------------------------- */
    /* 1. mint_shielded — one unit of a colour nobody has ever held      */
    /* ---------------------------------------------------------------- */

    const recipientBytes = await wallet.shieldedCoinPublicKeyBytes();
    /* The nonce is what identifies THIS coin in a wallet that may hold others
       of the same colour from an earlier run whose deposit failed. Everything
       below matches on it rather than on the value. */
    const mintNonce = new Uint8Array(randomBytes(32));
    const mintNonceHex = bytesToHex(mintNonce);

    const mintTx = await wallet.exclusive(async () => {
      const providers = await contractProviders(config, {
        privateStateId: 'passport-balancer-faucet',
        initialPrivateState: {},
        zkConfigProvider: faucetZkConfig as never,
        proofProvider: faucetProofProvider,
        walletProvider: wallet!.contractWalletProvider(),
      });
      const found = await findDeployedContract(providers as never, {
        compiledContract: compiledFaucet,
        contractAddress: faucetAddress,
      } as never);
      const callTx = (found as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> })
        .callTx;
      const mint = await callTx.mint_shielded(separator, options.amount, mintNonce, {
        bytes: recipientBytes,
      });
      return transactionIdentifier(mint);
    }, { label: `the ${options.name} mint` });
    console.log(`[gift] minted (tx ${mintTx}, nonce ${mintNonceHex})`);

    /* This wallet catching up with its own transaction — about three minutes,
       and the reason the service keeps a spare coin ahead of a request. */
    console.log('[gift] waiting for the coin to become spendable here…');
    let coin: { nonce: string; value: bigint } | null = null;
    for (let attempt = 0; attempt < MINT_VISIBLE_ATTEMPTS && !coin; attempt += 1) {
      try {
        const coins = await wallet.availableShieldedCoins(tokenType);
        coin =
          coins.find(
            (candidate) =>
              candidate.nonce.replace(/^0x/, '').toLowerCase() === mintNonceHex &&
              candidate.value === options.amount,
          ) ?? null;
      } catch {
        // A momentary wallet-state timeout; asked again below.
      }
      if (!coin) await wait(CONFIRM_INTERVAL_MS);
    }
    if (!coin) {
      throw new Refusal(
        `the coin was minted (tx ${mintTx}, nonce ${mintNonceHex}) but has not become spendable in this wallet. It is not lost: run again with the same --separator once the wallet has caught up, and the deposit will find it.`,
      );
    }

    /* ---------------------------------------------------------------- */
    /* 2. deposit_shielded — the coin into the ACCOUNT                   */
    /* ---------------------------------------------------------------- */

    const privateStateId = `passport-balancer-account-${address}`;
    const depositTx = await wallet.exclusive(async () => {
      const providers = await contractProviders(config, {
        privateStateId,
        initialPrivateState: {},
        zkConfigProvider: accountZkConfig as never,
        proofProvider: accountProofProvider,
        walletProvider: wallet!.contractWalletProvider(),
      });
      const found = await findDeployedContract(providers as never, {
        compiledContract: compiledAccount,
        contractAddress: address,
        privateStateId,
        initialPrivateState: {},
      } as never);
      const callTx = (found as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> })
        .callTx;
      const deposit = await callTx.deposit_shielded({
        nonce: hexToBytes(coin!.nonce),
        color: colourBytes,
        value: coin!.value,
      });
      return transactionIdentifier(deposit);
    }, { label: `deposit_shielded into ${address}` });
    console.log(`[gift] deposited (tx ${depositTx})`);

    /* ---------------------------------------------------------------- */
    /* 3. Read the credit back off the chain                             */
    /* ---------------------------------------------------------------- */

    const target = before + options.amount;
    let after: bigint | null = null;
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS && after === null; attempt += 1) {
      try {
        const held = await heldItem();
        if (held >= target) after = held;
      } catch {
        // Indexer lag or a transient failure; asked again below.
      }
      if (after === null) await wait(CONFIRM_INTERVAL_MS);
    }
    if (after === null) {
      throw new Refusal(
        `the gift was submitted (mint ${mintTx}, deposit ${depositTx}) but ${address}'s coins map has not shown the credit yet.`,
      );
    }

    const [mintResolved, depositResolved] = await Promise.all([
      resolveTransactionHash(config.indexerHttpUrl, mintTx),
      resolveTransactionHash(config.indexerHttpUrl, depositTx),
    ]);
    console.log('');
    console.log(`[gift] ${options.name} → ${address}`);
    console.log(`[gift]   colour   ${colourHex}`);
    console.log(`[gift]   mint     ${mintResolved.hash} (block ${mintResolved.block})`);
    console.log(`[gift]   deposit  ${depositResolved.hash} (block ${depositResolved.block})`);
    console.log(`[gift]   held     ${after}`);
  } finally {
    /* The snapshot the service resumes from. Written whether or not the gift
       landed: the wallet has walked blocks either way, and throwing that away
       costs the next start-up the walk. */
    try {
      await wallet?.close?.();
    } catch (cause) {
      console.error(`[gift] the wallet did not close cleanly: ${String(cause)}`);
    }
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (cause) {
    console.error(`gift-nft: ${cause instanceof Error ? cause.message : String(cause)}`);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const config = loadBalancerConfig();
    if (options.execute) await execute(config, options);
    else plan(config, options);
    return 0;
  } catch (cause) {
    if (cause instanceof Refusal) {
      console.error(`gift-nft refuses: ${cause.message}`);
      return 1;
    }
    console.error(cause);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /gift-nft(\.[cm]?[jt]s)?$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
