/**
 * The gift desk: one item of its own colour, minted and deposited in process.
 *
 * `../ops/gift-nft.ts` already does this, and does it well, but it does it with
 * the SERVICE STOPPED — it opens the service's own wallet from the service's
 * own seed, and two writers over one coin set and one snapshot is how a wallet
 * loses track of its DUST. The stop is five to ten minutes, because a mint has
 * to become spendable in this wallet before it can be deposited. That is a
 * price nobody can pay while a demo is being recorded.
 *
 * So the same two legs run HERE instead, inside the process that already owns
 * the wallet, under the same `wallet.exclusive(...)` lock every other spend
 * takes. Nothing about the chain work is new: the separator, the colour, the
 * mint, the wait for the coin to become spendable, and `deposit_shielded` are
 * the ops script's, and its two pure functions are IMPORTED rather than copied
 * so the colour this deposits and the colour that tool prints cannot drift.
 *
 * The item is one unit of a colour nobody has ever held, which is exactly the
 * rule the client files a holding as an item under. There is no metadata on
 * chain and no supply cap the ledger enforces; what makes the card carry a name
 * is a registry in the client keyed by the colour hex.
 *
 * IDEMPOTENT PER ACCOUNT, in `gifts-<network>.json` beside the other ledgers.
 * An account that already holds the item is answered with the transactions that
 * put it there rather than given a second one.
 */

import { randomBytes } from 'node:crypto';

import * as ledger from '@midnightntwrk/ledger-v9';

import type { BalancerConfig } from './config.js';
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
} from './contractRuntime.js';
import type { JsonLedger } from './ledgers.js';
import type { BalancerWallet } from './wallet.js';
/* The separator padding and the colour, from the tool that documented them. */
import { DEFAULT_ITEM_NAME, DEFAULT_SEPARATOR_LABEL, giftColourHex, separatorBytes } from '../ops/gift-nft.js';

/** Attempts, {@link CONFIRM_INTERVAL_MS} apart, for each of the two waits. */
const MINT_VISIBLE_ATTEMPTS = 360;
const CONFIRM_ATTEMPTS = 180;

/** One unit. The client files a holding as an item at exactly one. */
const ITEM_AMOUNT = 1n;

export interface GiftEntry {
  account: string;
  name: string;
  colourHex: string;
  amount: string;
  mintTx: string;
  depositTx: string;
  at: string;
}

export interface GiftLedger {
  get(key: string): GiftEntry | null;
  record(key: string, entry: GiftEntry): Promise<void>;
  readonly count: number;
}

export function giftLedgerOf(store: JsonLedger<GiftEntry>): GiftLedger {
  return {
    get: (key) => store.get(key),
    record: (key, entry) => store.record(key, entry),
    get count() {
      return store.count;
    },
  };
}

export interface GiftOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface GiftDesk {
  /** The colour this desk mints, for `/status` and for the client's registry. */
  readonly colourHex: string | null;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  give(body: { account?: unknown; network?: unknown }): Promise<GiftOutcome>;
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

export function createGiftDesk(deps: {
  config: BalancerConfig;
  wallet: BalancerWallet;
  ledger: GiftLedger;
  label?: string;
  name?: string;
  now?: () => number;
}): GiftDesk {
  const { config, wallet } = deps;
  const label = deps.label ?? DEFAULT_SEPARATOR_LABEL;
  const name = deps.name ?? DEFAULT_ITEM_NAME;
  const now = deps.now ?? (() => Date.now());
  const faucetAddress = config.assetFaucetAddress ?? null;
  const colourHex = faucetAddress ? giftColourHex(label, faucetAddress) : null;
  const inFlight = new Set<string>();

  /* Built once, on the first gift rather than at start-up: an item is asked for
     a handful of times in a demo and the two proof providers cost seconds. */
  let prepared: Promise<{
    account: AccountModule;
    compiledFaucet: unknown;
    compiledAccount: unknown;
    faucetZkConfig: unknown;
    accountZkConfig: unknown;
    faucetProofProvider: unknown;
    accountProofProvider: unknown;
    reader: Awaited<ReturnType<typeof publicDataProviderFor>>;
  }> | null = null;

  const prepare = async () => {
    const faucetPath = managedBuildPath('faucet', {
      configured: config.assetAssetsPath,
      remedy: 'The build ships in examples/passport-balancer/contracts-stagenet/managed/faucet.',
    });
    const accountPath = managedBuildPath('account', {
      configured: config.accountAssetsPath,
      remedy: 'The build ships in examples/passport-balancer/contracts-stagenet/managed/account.',
    });
    /* LITERAL relative specifiers, for the reason `./account.ts` gives at its
       own imports: a computed absolute path into `contracts-stagenet` resolves
       a SECOND compact-runtime and decoding dies on `ChargedState`. */
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
    const compiledFaucet = CompiledContract.make(
      'passport-musd-faucet',
      faucet.Contract as never,
    ).pipe(CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(faucetPath));
    /* The same three refusals `./account.ts` builds this contract with: this
       path may put a coin into an account and can take nothing out. */
    const refusing = (what: string) => (): never => {
      throw new Error(`the gift desk has no ${what}: it may deposit into an account and nothing else.`);
    };
    const compiledAccount = CompiledContract.make('passport-account', account.Contract as never).pipe(
      CompiledContract.withWitnesses({
        device_secret: refusing('device secret'),
        grant_secret: refusing('grant secret'),
        recovery_secret: refusing('recovery secret'),
      } as never),
      CompiledContract.withCompiledFileAssets(accountPath),
    );
    const reader = await publicDataProviderFor(config);
    return {
      account,
      compiledFaucet,
      compiledAccount,
      faucetZkConfig,
      accountZkConfig,
      faucetProofProvider,
      accountProofProvider,
      reader,
    };
  };

  const refuse = (status: number, error: string, message: string): GiftOutcome => {
    console.warn(`[gift] refused: ${error} — ${message}`);
    return { status, body: { error, message } };
  };

  const give = async (body: { account?: unknown; network?: unknown }): Promise<GiftOutcome> => {
    console.log(
      `[gift] asked to give ${name} to ${typeof body.account === 'string' ? body.account : '(no account)'}`,
    );
    if (body.network !== undefined && body.network !== config.networkId) {
      return refuse(
        400,
        'wrong-network',
        `That request names the ${String(body.network)} network; this service mints on ${config.networkId}.`,
      );
    }
    if (typeof body.account !== 'string') {
      return refuse(400, 'invalid-account', 'POST a JSON body of the form {"account": "64 hex"}.');
    }
    let address: string;
    try {
      address = rawContractAddress(body.account);
    } catch (cause) {
      return refuse(400, 'invalid-account', cause instanceof Error ? cause.message : String(cause));
    }
    if (!faucetAddress || !colourHex) {
      return refuse(
        503,
        'gift-unsupported',
        `No faucet is configured for ${config.networkId}, and the faucet address is half the colour.`,
      );
    }

    const previous = deps.ledger.get(address);
    if (previous) {
      return {
        status: 200,
        body: {
          given: true,
          repeat: true,
          account: address,
          name: previous.name,
          colour: previous.colourHex,
          amount: previous.amount,
          mintTx: previous.mintTx,
          depositTx: previous.depositTx,
          at: previous.at,
        },
      };
    }
    if (inFlight.has(address)) {
      return refuse(
        409,
        'gift-in-flight',
        'An item for this Passport is already on its way. Wait for it to finish before asking again.',
      );
    }

    inFlight.add(address);
    try {
      prepared ??= prepare();
      const built = await prepared;
      const separator = separatorBytes(label);
      const tokenType = String(ledger.rawTokenType(separator, faucetAddress));
      const colourBytes = ledger.encodeRawTokenType(tokenType);

      const held = async (): Promise<bigint> => {
        const state = await built.reader.queryContractState(address);
        if (!state) throw new Error(`no contract state is served at ${address} on ${config.networkId}`);
        const decoded = built.account.ledger((state as { data: unknown }).data);
        return decoded.coins.member(colourBytes) ? decoded.coins.lookup(colourBytes).value : 0n;
      };
      const before = await held();

      /* 1. mint_shielded — one unit, to this wallet's own shielded address. */
      const recipientBytes = await wallet.shieldedCoinPublicKeyBytes();
      /* The nonce identifies THIS coin in a wallet that may hold others of the
         same colour from a run whose deposit failed. Matched on, not the value. */
      const mintNonce = new Uint8Array(randomBytes(32));
      const mintNonceHex = bytesToHex(mintNonce);
      const mintTx = await wallet.exclusive(
        async () => {
          const providers = await contractProviders(config, {
            privateStateId: 'passport-balancer-faucet',
            initialPrivateState: {},
            zkConfigProvider: built.faucetZkConfig as never,
            proofProvider: built.faucetProofProvider as never,
            walletProvider: wallet.contractWalletProvider(),
          });
          const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
          const found = await findDeployedContract(providers as never, {
            compiledContract: built.compiledFaucet,
            contractAddress: faucetAddress,
          } as never);
          const callTx = (found as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> })
            .callTx;
          const mint = await callTx.mint_shielded(separator, ITEM_AMOUNT, mintNonce, {
            bytes: recipientBytes,
          });
          return transactionIdentifier(mint);
        },
        { label: `the ${name} mint` },
      );
      console.log(`[gift] minted (tx ${mintTx}, nonce ${mintNonceHex})`);

      /* 2. This wallet catching up with its own coin — the wait the ops script
            needs the unit stopped for, taken here without a lock held. */
      let coin: { nonce: string; value: bigint } | null = null;
      for (let attempt = 0; attempt < MINT_VISIBLE_ATTEMPTS && !coin; attempt += 1) {
        try {
          const coins = await wallet.availableShieldedCoins(tokenType);
          coin =
            coins.find(
              (candidate) =>
                candidate.nonce.replace(/^0x/, '').toLowerCase() === mintNonceHex &&
                candidate.value === ITEM_AMOUNT,
            ) ?? null;
        } catch {
          /* A momentary wallet-state timeout; asked again below. */
        }
        if (!coin) await wait(CONFIRM_INTERVAL_MS);
      }
      if (!coin) {
        return refuse(
          504,
          'mint-not-spendable',
          `The item was minted (${mintTx}) but has not become spendable here yet. It is not lost — ask again once this wallet has caught up.`,
        );
      }

      /* 3. deposit_shielded — the coin into the ACCOUNT. */
      const privateStateId = `passport-balancer-account-${address}`;
      const depositTx = await wallet.exclusive(
        async () => {
          const providers = await contractProviders(config, {
            privateStateId,
            initialPrivateState: {},
            zkConfigProvider: built.accountZkConfig as never,
            proofProvider: built.accountProofProvider as never,
            walletProvider: wallet.contractWalletProvider(),
          });
          const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
          const found = await findDeployedContract(providers as never, {
            compiledContract: built.compiledAccount,
            contractAddress: address,
            privateStateId,
            initialPrivateState: {},
          } as never);
          const callTx = (found as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> })
            .callTx;
          const deposit = await callTx.deposit_shielded({
            nonce: hexToBytes(coin.nonce),
            color: colourBytes,
            value: coin.value,
          });
          return transactionIdentifier(deposit);
        },
        { label: `${name} deposit_shielded into ${address}` },
      );
      console.log(`[gift] deposited (tx ${depositTx})`);

      /* 4. The credit, read back off the chain. Nothing is recorded, and
            nothing is reported, until the account's own coins map carries it. */
      const target = before + ITEM_AMOUNT;
      let after: bigint | null = null;
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS && after === null; attempt += 1) {
        try {
          const seen = await held();
          if (seen >= target) after = seen;
        } catch {
          /* Indexer lag or a transient failure; asked again below. */
        }
        if (after === null) await wait(CONFIRM_INTERVAL_MS);
      }
      if (after === null) {
        return refuse(
          504,
          'credit-not-seen',
          `The item was submitted (mint ${mintTx}, deposit ${depositTx}) but the account's coins have not shown it yet.`,
        );
      }

      const [mintResolved, depositResolved] = await Promise.all([
        resolveTransactionHash(config.indexerHttpUrl, mintTx),
        resolveTransactionHash(config.indexerHttpUrl, depositTx),
      ]);
      const entry: GiftEntry = {
        account: address,
        name,
        colourHex,
        amount: ITEM_AMOUNT.toString(),
        mintTx: mintResolved.hash,
        depositTx: depositResolved.hash,
        at: new Date(now()).toISOString(),
      };
      await deps.ledger.record(address, entry);
      console.log(`[gift] ${name} → ${address} (deposit ${entry.depositTx}, colour ${colourHex})`);
      return {
        status: 200,
        body: {
          given: true,
          repeat: false,
          account: address,
          name,
          colour: colourHex,
          amount: entry.amount,
          mintTx: entry.mintTx,
          mintBlock: mintResolved.block,
          depositTx: entry.depositTx,
          depositBlock: depositResolved.block,
          held: after.toString(),
          at: entry.at,
        },
      };
    } catch (cause) {
      return refuse(
        503,
        'gift-failed',
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      inFlight.delete(address);
    }
  };

  return {
    colourHex,
    available: Boolean(faucetAddress),
    unavailableReason: faucetAddress
      ? null
      : `No faucet is configured for ${config.networkId}, and the faucet address is half the colour.`,
    give,
  };
}
