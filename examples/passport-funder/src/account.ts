/**
 * The activation grant, paid INTO the user's account-custody contract.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/activate` drips NIGHT to a wallet ADDRESS. That was the right first move,
 * and it is the wrong final one: a Passport's value is supposed to live in its
 * account-custody contract (the ACC), not in the passkey wallet that happens to
 * have deployed it. A grant that lands on the wallet address puts the user back
 * in the position the whole design exists to avoid — holding, watching, and
 * spending from a wallet — and it has to be moved into the contract afterwards
 * by a second transaction the user pays for.
 *
 * So the grant is deposited straight into the contract instead. The ACC's
 * entrypoint for that is
 *
 *     deposit_night(color, amount)
 *
 * and it is PERMISSIONLESS: no `require_device()`, no witness, no caller check.
 * It calls `receiveUnshielded(color, amount)` — which makes the transaction owe
 * the contract that many coins — and then mirrors the credit into the
 * `night_balances` map so the balance is readable from decoded ledger state.
 * Anyone may fund an account; the funder is just the first anyone.
 *
 * The funder therefore calls the circuit itself, paying the coins from its own
 * NIGHT and the fee from its own DUST. The user's wallet signs nothing, spends
 * nothing, and — this is the point — never holds the grant at all. The value
 * exists inside the contract from the moment it exists.
 *
 * WHAT THE FUNDER CANNOT DO
 * -------------------------
 * The compiled account contract declares three witnesses — `device_secret`,
 * `grant_secret`, `recovery_secret` — and every circuit that MOVES value out of
 * an account demands one of them. The funder's witness set (below) is three
 * refusals. `deposit_night` never asks for one, so the deposit path is
 * unaffected; every other path is impossible from this process, by construction
 * rather than by discipline.
 *
 * PROVENANCE
 * ----------
 * The contract is `experiments/account-custody-prototype/contracts/account.compact`
 * and the circuit handling mirrors that prototype's own client
 * (`src/wallet/account.ts` — `depositNight`). The provider set, the artefact
 * reader, and the transaction-identifier handling are the shared ones in
 * `./contractRuntime.ts`, the same ones `./midnames.ts` registers names with.
 */

import type { FunderConfig } from './config.js';
import {
  CONFIRM_INTERVAL_MS,
  DirectoryZkConfigProvider,
  contractProviders,
  managedBuildPath,
  nativeColourBytes,
  rawContractAddress,
  resolveTransactionHash,
  transactionIdentifier,
  wait,
} from './contractRuntime.js';
import type { FunderWallet } from './wallet.js';

/** Attempts, {@link CONFIRM_INTERVAL_MS} apart, to watch the credit appear. */
const CONFIRM_ATTEMPTS = 45;

/**
 * Where the compiled account build's ZK ARTEFACTS live. `npm run compile` in
 * `experiments/account-custody-prototype` produces the one copy the repository
 * stages; `FUNDER_ACCOUNT_ASSETS` overrides the search. See
 * {@link managedBuildPath} for the candidates and the liveness probe.
 */
function accountManagedPath(configured?: string): string {
  return managedBuildPath('account', {
    configured,
    remedy:
      'Run `npm run compile` in experiments/account-custody-prototype, or set FUNDER_ACCOUNT_ASSETS.',
  });
}

interface AccountModule {
  Contract: new (witnesses: unknown) => unknown;
  ledger: (state: unknown) => AccountLedger;
}

/**
 * The decoded shape this module reads.
 *
 * `night_balances` is the contract's explicit MIRROR of its NIGHT holdings per
 * colour, maintained by `credit_night` / `debit_night`. It has to be a mirror:
 * a contract's unshielded balances are not part of its ledger state, so without
 * the map neither the indexer nor the simulator could report what an account
 * holds. `deposit_night` is what writes to it, which is exactly why a grant
 * routed through the circuit is visible and a raw transfer to the contract
 * address would not be.
 */
export interface AccountLedger {
  readonly round: bigint;
  readonly device_count: bigint;
  recovery_shares: { size(): bigint };
  night_balances: {
    member(colour: Uint8Array): boolean;
    lookup(colour: Uint8Array): bigint;
  };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type AccountFundingErrorCode =
  /** No state at that address, or state that does not decode as an account. */
  | 'not-an-account'
  /** The indexer could not be read, so nothing may be asserted about the account. */
  | 'indexer-unreachable'
  /** The deposit transaction was refused or failed; nothing was credited. */
  | 'deposit-failed'
  /** The deposit landed, but the mirrored balance never showed the credit. */
  | 'confirmation-failed';

export class AccountFundingError extends Error {
  constructor(
    readonly code: AccountFundingErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AccountFundingError';
  }
}

/* -------------------------------------------------------------------------- */
/* The funder                                                                 */
/* -------------------------------------------------------------------------- */

export interface AccountFunding {
  /** Raw 64-hex address of the account that was credited. */
  contractAddress: string;
  /** 64-hex ledger hash where the indexer resolved it, the identifier if not. */
  txHash: string;
  amountAtomic: bigint;
  /** The account's mirrored NIGHT balance once the credit was seen. */
  balanceAfterAtomic: bigint;
  fundedAt: string;
}

export interface AccountFunder {
  /** Where the compiled build was found, for the start-up log. */
  readonly assetsPath: string;
  /** The grant this funder deposits, in atomic NIGHT. */
  readonly grantAtomic: bigint;
  /**
   * The account's own mirrored NIGHT balance for the native colour, right now.
   *
   * This is both the already-funded check and the is-it-really-an-account
   * check: a contract whose state does not decode as an account-custody
   * contract throws `not-an-account` rather than answering zero, because a zero
   * would read as "needs funding" for something that must never be fed coins.
   */
  nightBalance(contractAddress: string): Promise<bigint>;
  /**
   * Calls `deposit_night` on the account and reads the mirrored balance back.
   * Resolves only once the credit is really visible on chain.
   *
   * MUST be called inside `wallet.exclusive(...)`: it spends the funder's coins
   * and would otherwise contend with a drip or an alias registration.
   */
  fund(contractAddress: string): Promise<AccountFunding>;
}

/**
 * Builds the account funder. Loading the compiled contract here rather than per
 * request means a broken or missing artefact set fails at start-up, where an
 * operator sees it, instead of on a user's first activation.
 */
export async function createAccountFunder(
  config: FunderConfig,
  wallet: FunderWallet,
): Promise<AccountFunder> {
  const managedPath = accountManagedPath(config.accountAssetsPath);
  /**
   * A LITERAL relative specifier, for the reason `./midnames.ts` sets out at
   * its own import: `experiments/account-custody-prototype` carries its own
   * `node_modules`, so a runtime `import()` of a computed absolute path inside
   * that tree resolves a SECOND `@midnight-ntwrk/compact-runtime`, and decoding
   * a contract state then dies on `expected instance of ChargedState`. A
   * literal specifier is bundled by esbuild into this service, so there is
   * exactly one runtime in play.
   */
  const account = (await import(
    '../../../experiments/account-custody-prototype/contracts/managed/account/contract/index.js'
  )) as unknown as AccountModule;
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
  );
  const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');

  const zkConfigProvider = new DirectoryZkConfigProvider(managedPath);
  const reader = indexerPublicDataProvider(config.indexerHttpUrl, config.indexerWsUrl);
  const colour = nativeColourBytes();

  /**
   * Three refusals, one per declared witness.
   *
   * `deposit_night` calls none of them, so nothing on the funding path notices.
   * They throw rather than returning zeroes so that this service cannot, even
   * through a later mistake, attempt `withdraw_night`, `grant_withdraw_night`,
   * or `recover`. The funder can put coins into an account; it holds nothing
   * that could take them out, and that is a property of the code rather than a
   * promise about it.
   */
  const refusingWitness = (name: string) => (): never => {
    throw new Error(
      `The funder has no ${name}: it may deposit into an account-custody contract and nothing else.`,
    );
  };

  const compiledContract = CompiledContract.make(
    'passport-account',
    account.Contract as never,
  ).pipe(
    CompiledContract.withWitnesses({
      device_secret: refusingWitness('device secret'),
      grant_secret: refusingWitness('grant secret'),
      recovery_secret: refusingWitness('recovery secret'),
    } as never),
    CompiledContract.withCompiledFileAssets(managedPath),
  );

  /**
   * Reads the account's ledger state, or refuses.
   *
   * The fingerprint is deliberately structural rather than "the decoder did not
   * throw": Compact decodes positionally, so a foreign contract can occasionally
   * produce a plausible-looking object. Every real account has at least one
   * device (the constructor inserts one and `remove_device` asserts it cannot
   * remove the last) and exactly three recovery shares (the constructor writes
   * 1, 2, and 3, and `recover` rewrites the same three). A candidate that fails
   * either test is not an account, and the funder will not pay coins into it.
   */
  const readAccount = async (address: string): Promise<AccountLedger> => {
    let state: unknown;
    try {
      state = await reader.queryContractState(address);
    } catch (cause) {
      throw new AccountFundingError(
        'indexer-unreachable',
        `The ${config.networkId} indexer could not be read, so nothing can be established about the contract at ${address}.`,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    if (!state) {
      throw new AccountFundingError(
        'not-an-account',
        `No contract state is served at ${address} on ${config.networkId}, so there is no account to fund. Deploy the account-custody contract first.`,
      );
    }
    let decoded: AccountLedger | null = null;
    try {
      const candidate = account.ledger((state as { data: unknown }).data);
      if (candidate.device_count >= 1n && candidate.recovery_shares.size() === 3n) {
        candidate.night_balances.member(colour);
        decoded = candidate;
      }
    } catch {
      decoded = null;
    }
    if (!decoded) {
      throw new AccountFundingError(
        'not-an-account',
        `The contract at ${address} is not a Passport account-custody contract — its state does not decode as one — so the funder will not deposit into it.`,
      );
    }
    return decoded;
  };

  /** The mirrored NIGHT balance, treating an absent colour as zero. */
  const mirroredNight = (decoded: AccountLedger): bigint =>
    decoded.night_balances.member(colour) ? decoded.night_balances.lookup(colour) : 0n;

  return {
    assetsPath: managedPath,

    grantAtomic: config.accountGrantAtomic,

    async nightBalance(contractAddress: string): Promise<bigint> {
      return mirroredNight(await readAccount(rawContractAddress(contractAddress)));
    },

    async fund(contractAddress: string): Promise<AccountFunding> {
      const address = rawContractAddress(contractAddress);
      /* Read inside the lock, immediately before spending: the confirmation
         below is "this deposit's credit is visible", not "the balance is
         non-zero", and it needs a baseline nothing else can have moved since. */
      const before = mirroredNight(await readAccount(address));

      const privateStateId = `passport-funder-account-${address}`;
      const providers = await contractProviders(config, {
        privateStateId,
        initialPrivateState: {},
        zkConfigProvider,
        walletProvider: await wallet.contractWalletProvider(),
      });

      let depositTx: string;
      try {
        const found = await findDeployedContract(providers as never, {
          compiledContract,
          contractAddress: address,
          privateStateId,
          initialPrivateState: {},
        } as never);
        const callTx = (found as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> })
          .callTx;
        /* The paid call. `receiveUnshielded` inside the circuit makes the
           transaction owe the contract `grantAtomic` of the native colour, and
           the funder's own wallet provider balances that from the funder's own
           NIGHT — the same mechanism that pays Midnames its COST. */
        const deposit = await callTx.deposit_night(colour, config.accountGrantAtomic);
        depositTx = transactionIdentifier(deposit);
      } catch (cause) {
        throw new AccountFundingError(
          'deposit-failed',
          `The activation grant could not be deposited into ${address}; nothing was credited.`,
          cause instanceof Error ? cause.message : String(cause),
        );
      }

      /* Confirmation is the decisive step, and it is not "the transaction was
         accepted": it is the account's own mirrored balance showing THIS
         credit. A deposit that never lands is a failure, not a slow success. */
      const target = before + config.accountGrantAtomic;
      let balanceAfter: bigint | null = null;
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
        try {
          const held = mirroredNight(await readAccount(address));
          if (held >= target) {
            balanceAfter = held;
            break;
          }
        } catch {
          // Indexer lag or a transient failure; asked again below.
        }
        await wait(CONFIRM_INTERVAL_MS);
      }
      if (balanceAfter === null) {
        throw new AccountFundingError(
          'confirmation-failed',
          `The activation grant for ${address} was submitted but the account has not shown the credit yet.`,
          `deposit ${depositTx}, balance before ${before} atomic`,
        );
      }

      return {
        contractAddress: address,
        txHash: await resolveTransactionHash(config.indexerHttpUrl, depositTx),
        amountAtomic: config.accountGrantAtomic,
        balanceAfterAtomic: balanceAfter,
        fundedAt: new Date().toISOString(),
      };
    },
  };
}
