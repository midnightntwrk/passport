/**
 * The activation grant, paid INTO the user's account-custody contract — both
 * legs of it: the NIGHT that makes the account operable, and the 100 mUSD that
 * makes it worth opening.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Passport's value is supposed to live in its account-custody contract (the
 * ACC), not in the passkey wallet that happens to have deployed it. A grant
 * that lands on the wallet address puts the user back in the position the whole
 * design exists to avoid — holding, watching, and spending from a wallet — and
 * it has to be moved into the contract afterwards by a second transaction the
 * user pays for.
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
 * Anyone may fund an account; the balancer is just the first anyone.
 *
 * The balancer therefore calls the circuit itself, paying the coins from its
 * own NIGHT and the fee from its own DUST. The user's wallet signs nothing,
 * spends nothing, and — this is the point — never holds the grant at all. The
 * value exists inside the contract from the moment it exists.
 *
 * THE ASSET LEG
 * -------------
 * NIGHT alone is not an opening balance a demo can show. The account should
 * open holding money — 100 mUSD — and it should hold it in the SAME place the
 * NIGHT is, inside the contract's own `coins` map, for exactly the reason above.
 *
 * The mechanism was proved on stagenet on 2026/08/24 by
 * `deploy-stagenet/src/shielded-receipt-drill.mjs`, and it is two transactions:
 *
 *   1. `mint_shielded(domain separator, amount, nonce, recipient)` on the mUSD
 *      faucet, with the BALANCER's own coin public key as the recipient. The
 *      faucet is permissionless, so anyone may call it; the coin lands in the
 *      balancer's own shielded wallet.
 *   2. `deposit_shielded(coin)` on the user's account, spending that coin. Like
 *      `deposit_night` it is PERMISSIONLESS — no `require_device()`, no witness,
 *      no caller check — so it calls `receive(coin)` and writes the credit into
 *      the account's `coins` map, where the indexer can read it back.
 *
 * The user signs nothing for either. The colour a coin carries is bound to the
 * minting contract — `rawTokenType(domain separator, faucet address)` — so mUSD
 * is not a label this service applies but a fact about where the coin came
 * from, and it is reported to callers as `assetColourHex` for that reason.
 *
 * WHAT THIS SERVICE CANNOT DO
 * ---------------------------
 * The compiled account contract declares three witnesses — `device_secret`,
 * `grant_secret`, `recovery_secret` — and every circuit that MOVES value out of
 * an account demands one of them. The witness set below is three refusals.
 * `deposit_night` never asks for one, so the deposit path is unaffected; every
 * other path is impossible from this process, by construction rather than by
 * discipline.
 *
 * PROVENANCE
 * ----------
 * The policy and the vocabulary are a port of
 * `examples/passport-funder/src/account.ts`, which does this on preview. The
 * contract handling is the beta stack `deploy-stagenet` deployed an ACC with,
 * against `contracts-stagenet/managed/account` — the same build, so the same
 * verifier keys as the contracts the migrated PWA deploys on stagenet.
 */

import { randomBytes } from 'node:crypto';

import * as ledger from '@midnightntwrk/ledger-v9';

import { ASSET_SYMBOL, type BalancerConfig } from './config.js';
import {
  CONFIRM_INTERVAL_MS,
  bytesToHex,
  contractProviders,
  createContractProofProvider,
  hexToBytes,
  isConfirmationTimeout,
  managedBuildPath,
  nativeColourBytes,
  publicDataProviderFor,
  queryIndexerHeight,
  rawContractAddress,
  resolveTransactionHash,
  transactionIdentifier,
  wait,
  type ContractProvingMode,
} from './contractRuntime.js';
import { progress } from './reservation.js';
import { isSubmissionTimeout } from './submission.js';
import { isDustShortfall, isWalletCallTimeout, type BalancerWallet } from './wallet.js';

/** Attempts, {@link CONFIRM_INTERVAL_MS} apart, to watch the credit appear. */
const CONFIRM_ATTEMPTS = 180;

/**
 * Attempts, {@link CONFIRM_INTERVAL_MS} apart, to watch a freshly minted coin
 * become spendable in the balancer's own wallet.
 *
 * Generous — three minutes — because this is a wallet catching up with a
 * transaction it has just made, not a chain confirmation. The drill saw the coin
 * on the first poll; a wallet that is momentarily behind the indexer would take
 * longer, and giving up early would strand a coin that was about to appear.
 */
const MINT_VISIBLE_ATTEMPTS = 360;

/**
 * The mUSD faucet's domain separator, as the drills used it: 32 zero bytes with
 * a leading `0x06`. It is an ARGUMENT to `mint_shielded`, not the colour — the
 * contract computes the colour as `tokenType(separator, kernel.self())`, which
 * is why the same separator against a different faucet is a different currency.
 */
const MUSD_DOMAIN_SEPARATOR = (() => {
  const bytes = new Uint8Array(32);
  bytes[0] = 0x06;
  return bytes;
})();

/**
 * Where the compiled account build's ZK ARTEFACTS live.
 * `BALANCER_ACCOUNT_ASSETS` overrides the search. See {@link managedBuildPath}
 * for the candidates and the liveness probe.
 */
function accountManagedPath(configured?: string): string {
  return managedBuildPath('account', {
    configured,
    remedy:
      'The build ships in examples/passport-balancer/contracts-stagenet/managed/account; set BALANCER_ACCOUNT_ASSETS to point elsewhere.',
  });
}

/** The same, for the mUSD faucet build the asset leg mints through. */
function faucetManagedPath(configured?: string): string {
  return managedBuildPath('faucet', {
    configured,
    remedy:
      'The build ships in examples/passport-balancer/contracts-stagenet/managed/faucet; set BALANCER_ASSET_ASSETS to point elsewhere.',
  });
}

interface AccountModule {
  Contract: new (witnesses: unknown) => unknown;
  ledger: (state: unknown) => AccountLedger;
}

interface FaucetModule {
  Contract: new (witnesses: unknown) => unknown;
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
  /**
   * The SHIELDED side, and not a mirror at all: `coins` holds the account's
   * actual shielded coins, one merged coin per colour, written by `receive()`
   * inside `deposit_shielded`. Reading `coins[mUSD].value` back from the indexer
   * is what makes the asset leg checkable by somebody who was not the depositor.
   */
  coins: {
    member(colour: Uint8Array): boolean;
    lookup(colour: Uint8Array): { nonce: Uint8Array; color: Uint8Array; value: bigint };
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
  | 'confirmation-failed'
  /** No faucet build or no faucet address, so no asset leg is possible. */
  | 'asset-unsupported'
  /** The mint was refused or failed; the account was not touched. */
  | 'mint-failed'
  /** The mint landed but the coin never became spendable in this wallet. */
  | 'mint-not-visible'
  /** `deposit_shielded` was refused or failed; the coin stayed with the balancer. */
  | 'asset-deposit-failed'
  /** The deposit landed, but the account's `coins` map never showed the credit. */
  | 'asset-confirmation-failed';

/* -------------------------------------------------------------------------- */
/* Rebuilding a transaction the node refused                                  */
/* -------------------------------------------------------------------------- */

/**
 * The two shapes a node rejection arrives in.
 *
 * On 2026/09/02 at 15:35:43 a `deposit_night` came back as
 * `RpcError: 1010: Invalid Transaction: Custom error: 231`, five seconds after
 * the registration in front of it had landed. The wallet had balanced against
 * the dust state as it stood BEFORE that block, so the transaction it built was
 * one event behind the chain and the node was right to refuse it.
 */
const NODE_REJECTION = /invalid transaction|rpcerror:\s*1010|\b1010:/i;

/** Walks the whole `cause` chain — the SDK wraps its rejections several deep. */
export function isNodeRejection(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const message = current instanceof Error ? `${current.name}: ${current.message}` : String(current);
    if (NODE_REJECTION.test(message)) return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * A transaction that LANDED and was NOT APPLIED.
 *
 * midnight-js throws `CallTxFailedError` (and `DeployTxFailedError`) after
 * `submitTx` whenever the finalised status is not `SucceedEntirely`. Two such
 * statuses exist. `FailFallible`: the guaranteed segment — the fee — was
 * applied and every fallible segment, the contract call among them, was
 * discarded. `FailEntirely`: nothing was applied at all. In both, the effect
 * this service was paying for did not happen, which is what makes a rebuild
 * safe: the name is still unregistered, the grant still uncredited, and the
 * confirmation each caller runs afterwards is what says so, not this predicate.
 *
 * On 2026/09/03 at 02:50:09 `register_domain_for` for hcmtkxcwhntzz.night
 * landed at block 293959 as `FailFallible`, segment map `{0: SegmentSuccess,
 * 1: SegmentSuccess, 61517: SegmentFail}`, fees paid in full. The proof had
 * been built against a view of the registry the chain had since moved past —
 * the same family as the `1010: Custom error: 231` refusal, except that here
 * the node accepted the bytes and the conflict only showed at execution. The
 * caller reported it as a rejection by the registry, which it was not.
 *
 * Matched structurally first — the SDK error carries `finalizedTxData.status`
 * — and by message second, for the copies that have been re-wrapped into a
 * plain `Error` on their way here. The message form is the JSON the SDK
 * serialises into `TxFailedError.message`.
 */
const LANDED_FAILURE = /"status":\s*"(?:FailFallible|FailEntirely)"/;
const LANDED_STATUSES = new Set(['FailFallible', 'FailEntirely']);

export function isLandedFailure(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === 'object') {
      const status = (current as { finalizedTxData?: { status?: unknown } }).finalizedTxData?.status;
      if (typeof status === 'string' && LANDED_STATUSES.has(status)) return true;
    }
    const message = current instanceof Error ? current.message : String(current);
    if (LANDED_FAILURE.test(message)) return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * How a rebuildable failure should be NAMED in the log and the step. Three
 * failures share one remedy; they must not share one description, because the
 * person reading the journal is trying to tell them apart.
 */
export function describeRebuildCause(cause: unknown): {
  verb: string;
  step: string;
} {
  if (isNodeRejection(cause)) return { verb: 'the node refused', step: 'a node refusal' };
  if (isLandedFailure(cause)) {
    return { verb: 'the chain landed but did not apply', step: 'an on-chain failure' };
  }
  return { verb: 'this service gave up waiting on', step: 'a timeout' };
}

/**
 * Is this a failure a REBUILD could fix?
 *
 * A node rejection is the original case, and a bounded wait that expired is the
 * new one. They are different failures with the same remedy: in both, the bytes
 * this service built are not going to become a landed transaction, and the
 * coins they select were chosen against a view that has since moved on. The
 * distinction the caller has already drawn by the time this is asked is the
 * important one — a `ConfirmationTimeout` is only thrown after the indexer has
 * been asked directly and said the transaction is NOT there, and a
 * `SubmissionTimeout` only after the same check in `submitTx`. A transaction
 * that landed AND APPLIED is never rebuilt; one that landed and was discarded
 * by the ledger — {@link isLandedFailure} — is the third case, added
 * 2026/09/03, and has applied nothing that a second build could double.
 */
export function isRebuildable(cause: unknown): boolean {
  return (
    isNodeRejection(cause) ||
    isLandedFailure(cause) ||
    isConfirmationTimeout(cause) ||
    isSubmissionTimeout(cause) ||
    /* Nothing has been submitted when one of these is thrown — the fee
       estimate, the balancing, and the signing all happen before the fee leg is
       proved, let alone sent — so a rebuild is not merely safe here, it is the
       only thing left to try. */
    isWalletCallTimeout(cause)
  );
}

/**
 * The block a failed build was invalidated by, when the failure says.
 *
 * A `CallTxFailedError` carries `finalizedTxData.blockHeight`: the block that
 * landed the transaction and discarded it, and the block the registry view the
 * next proof is built against must include. Nothing else carries a height —
 * a `1010` is refused before any block — so the caller supplies the chain's
 * height at the moment of refusal instead (`chainHeight`).
 */
export function landedHeight(cause: unknown): number | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === 'object') {
      const height = (current as { finalizedTxData?: { blockHeight?: unknown } }).finalizedTxData
        ?.blockHeight;
      if (typeof height === 'number' && Number.isFinite(height)) return height;
      if (typeof height === 'bigint') return Number(height);
    }
    const message = current instanceof Error ? current.message : String(current);
    const match = /"blockHeight":\s*"?(\d+)"?/.exec(message);
    if (match) return Number(match[1]);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return null;
}

export interface NodeRejectionRetryOptions {
  /** Builds and submits the transaction. Called afresh on every attempt. */
  label: string;
  /** `true` once the wallet has caught up with the block that refused it. */
  synced: () => Promise<boolean>;
  /**
   * The indexer's latest block. When given, a rebuild does not start until
   * this has reached the height that invalidated the previous build — see
   * {@link landedHeight} — or `heightWaitMs` has passed, in which case the
   * rebuild goes ahead with a journal line saying so.
   */
  indexerHeight?: () => Promise<number | null>;
  /**
   * The node's height now. Read at the moment of a `1010` refusal, which
   * carries no height of its own, and used as the target the indexer must
   * reach before that refusal is worth rebuilding against.
   */
  chainHeight?: () => Promise<number | null>;
  /** The bound on the indexer wait. One minute by default. */
  heightWaitMs?: number;
  attempts?: number;
  /** How long to wait for that, before giving up and reporting the rejection. */
  budgetMs?: number;
  pollMs?: number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Reports a step of the running spend job. Injectable for the tests. */
  progress?: (step: string) => void;
}

/**
 * Rebuilds and retries a transaction the NODE refused, once the wallet has
 * caught up with the chain that refused it.
 *
 * TWO THINGS THIS DOES THAT A PLAIN RETRY WOULD NOT, and both are the whole
 * point:
 *
 *   1. It WAITS FOR THE WALLET TO RE-SYNC first. The rejection means the coins
 *      the transaction spends were selected against a stale view, so retrying
 *      immediately produces the same refusal. The wallet flapped
 *      `WALLET_SYNCING` at 15:35:50 and 15:36:50 and the client's own retry
 *      landed at 15:39:26, once it had caught up — this does that deliberately
 *      instead of by luck.
 *   2. It REBUILDS rather than resubmits. The bytes are what the node refused;
 *      a fresh `findDeployedContract` and `callTx` selects coins against the
 *      state as it now stands. Resending the same transaction would fail
 *      identically for ever.
 *
 * Anything that is not a node rejection is rethrown untouched on the first
 * attempt: a missing contract, a refused circuit, or an unreachable prover are
 * not made better by waiting.
 *
 * Before this, a rejected first deposit answered the client 502 `deposit-failed`
 * and the client's own ladder carried the wait — 229 s to NIGHT and 519 s to
 * mUSD on 2026/09/02. The wait belongs here, where the rebuild is possible.
 */
export async function withNodeRejectionRetry<T>(
  build: () => Promise<T>,
  options: NodeRejectionRetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const budgetMs = options.budgetMs ?? 120_000;
  const pollMs = options.pollMs ?? 1_000;
  const pause = options.wait ?? wait;
  const log = options.log ?? ((line: string) => console.warn(line));

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await build();
    } catch (cause) {
      last = cause;
      if (!isRebuildable(cause) || attempt === attempts) throw cause;
      const named = describeRebuildCause(cause);
      log(
        `[retry] ${named.verb} ${options.label} (${cause instanceof Error ? cause.message : String(cause)}) — waiting for this wallet to catch up with the chain, then rebuilding (attempt ${attempt + 1} of ${attempts})`,
      );
      /* Reported as a STEP, not only as a log line. This wait is up to
         `budgetMs` — two minutes — with nothing at the prover, which is exactly
         the shape the stall watchdog aborts on. A job rebuilding after a
         refusal is healthy and must say so, or the watchdog takes its lane away
         for doing the right thing. Measured on the deployed service on
         2026/09/03: a grant sat 115 s at `fee leg proved` through one of these
         and recovered on its own, 35 s inside the window. */
      const step = options.progress ?? progress;
      step(`rebuilding after ${named.step}`);
      /* THE INDEXER FIRST, THEN THE WALLET. `synced` says the wallet has applied
         everything the indexer has; it does not say the indexer has the block
         that made the last build wrong. On stagenet the indexer trails the node
         by 13–14 s, and on 2026/09/03 a rebuild against a registry view that
         had not yet seen block 293959 failed exactly as the build before it
         had. So the height that invalidated the last build — carried by a
         landed failure, or read from the node at a refusal — is waited for at
         the indexer, bounded, before the wallet wait begins. */
      if (options.indexerHeight) {
        const target =
          landedHeight(cause) ?? (options.chainHeight ? await options.chainHeight() : null);
        if (target !== null) {
          const heightWaitMs = options.heightWaitMs ?? 60_000;
          const heightDeadline = Date.now() + heightWaitMs;
          let reached = false;
          for (;;) {
            let seen: number | null = null;
            try {
              seen = await options.indexerHeight();
            } catch {
              // An unreachable indexer has not reached anything; asked again below.
            }
            if (seen !== null && seen >= target) {
              reached = true;
              break;
            }
            step(`waiting for the indexer to reach block ${target}`);
            if (Date.now() >= heightDeadline) break;
            await pause(pollMs);
          }
          if (!reached) {
            log(
              `[retry] ${options.label}: the indexer has not reached block ${target} within ${Math.round(heightWaitMs / 1_000)} s — rebuilding anyway, against whatever view it has`,
            );
          }
        }
      }
      const deadline = Date.now() + budgetMs;
      for (;;) {
        let caught = false;
        try {
          caught = await options.synced();
        } catch {
          // An unreadable wallet is not a synced one; asked again below.
        }
        if (caught) break;
        /* Every poll, because the wait is the silence being explained. */
        step('waiting for this wallet to catch up');
        if (Date.now() >= deadline) {
          log(
            `[retry] ${options.label}: this wallet has not caught up within ${Math.round(budgetMs / 1_000)} s — reporting the rejection rather than rebuilding against a view that is still stale`,
          );
          throw last;
        }
        await pause(pollMs);
      }
    }
  }
  /* Unreachable: the loop either returns or throws. */
  throw last;
}

export interface EnsureSpareCoinOptions {
  /**
   * Whether the spend queue has nothing waiting on it.
   *
   * Passed in rather than read, because the queue's depth belongs to
   * `./server.ts` and this module has no business knowing about HTTP
   * admission. Absent means "do not ask", which is what the tests and the
   * start-up call use.
   */
  queueIdle?: () => boolean;
}

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
  /** The block it landed in, when the indexer knew it. */
  block: number | null;
  amountAtomic: bigint;
  /** The account's mirrored NIGHT balance once the credit was seen. */
  balanceAfterAtomic: bigint;
  fundedAt: string;
}

/** What one asset leg did, once its credit has been read back off the chain. */
export interface AssetFunding {
  contractAddress: string;
  /** The faucet call that created the coin, paid to the balancer's own address. */
  mintTxHash: string;
  mintBlock: number | null;
  /** `deposit_shielded` — the transaction that credited the ACCOUNT. */
  depositTxHash: string;
  depositBlock: number | null;
  amount: bigint;
  /** 64 lower-case hex: `rawTokenType(domain separator, faucet address)`. */
  colourHex: string;
  /** The account's own `coins[colour].value` once the credit was seen. */
  balanceAfter: bigint;
  fundedAt: string;
}

/** Both balances an account holds, from ONE decode of ONE indexer read. */
export interface AccountBalances {
  /** Mirrored NIGHT for the native colour. */
  night: bigint;
  /** `coins[mUSD].value`, or zero when the account holds none. */
  asset: bigint;
}

export interface AccountFunder {
  /** Where the compiled build was found, for the start-up log. */
  readonly assetsPath: string;
  /** The grant this service deposits, in atomic NIGHT. */
  readonly grantAtomic: bigint;
  /** How contract circuits are proved — `'wasm'` needs no proof server. */
  readonly provingMode: ContractProvingMode;
  /**
   * Whether the asset leg can run at all. `false` when there is no faucet
   * address for this network, no compiled faucet build, or a zero grant — and
   * {@link assetUnavailableReason} says which.
   */
  readonly assetAvailable: boolean;
  readonly assetUnavailableReason: string | null;
  /** `'mUSD'`. Fixed, because the colour is bound to a faucet and a separator. */
  readonly assetSymbol: string;
  /** 64 lower-case hex, or `null` when no faucet is configured. */
  readonly assetColourHex: string | null;
  /** The faucet the asset is minted from, or `null`. */
  readonly assetFaucetAddress: string | null;
  /** Where the compiled faucet build was found, or `null`. */
  readonly assetAssetsPath: string | null;
  /** The asset grant this service deposits, in whole mUSD. */
  readonly assetGrant: bigint;
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
   * Both balances at once. One indexer read, one decode, one `not-an-account`
   * verdict — so the two legs cannot disagree about what they are looking at.
   */
  balances(contractAddress: string): Promise<AccountBalances>;
  /**
   * Calls `deposit_night` on the account and reads the mirrored balance back.
   * Resolves only once the credit is really visible on chain.
   *
   * MUST be called inside `wallet.exclusive(...)`: it spends the balancer's
   * coins and would otherwise contend with a fee-sponsorship request or an
   * alias registration.
   */
  fund(contractAddress: string): Promise<AccountFunding>;
  /**
   * Mints the asset grant to the balancer's own shielded address and then
   * `deposit_shielded`s it into the account. Resolves only once the account's
   * own `coins` map has been read back and seen carrying the credit.
   *
   * Unlike {@link fund}, this takes the wallet's spend lock ITSELF, twice: once
   * around the mint and once around the deposit. Between them it waits for the
   * minted coin to become spendable, which is a wait on this wallet catching up
   * with its own transaction and has no business holding a lock that
   * `/balance-only` is queued behind.
   */
  fundAsset(contractAddress: string): Promise<AssetFunding>;
  /**
   * Mints one grant-sized asset coin AHEAD of the next activation, if there is
   * not one ready already, so the asset leg is a single `deposit_shielded`
   * rather than a mint plus the three minutes it takes this wallet to see its
   * own coin. Called on the registration loop's minute tick and after every
   * grant; never throws. Resolves `true` when it really attempted a mint, which
   * spends this wallet's DUST and so has to be recorded as a spend.
   */
  ensureSpareCoin(options?: EnsureSpareCoinOptions): Promise<boolean>;
  /** What the spare is doing, for the start-up log and `/status`. */
  spareState(): 'ready' | 'minting' | 'none' | 'unsupported';
}

/**
 * Builds the account funder. Loading the compiled contract here rather than per
 * request means a broken or missing artefact set fails at start-up, where an
 * operator sees it, instead of on a user's first activation.
 */
export async function createAccountFunder(
  config: BalancerConfig,
  wallet: BalancerWallet,
): Promise<AccountFunder> {
  const managedPath = accountManagedPath(config.accountAssetsPath);
  /**
   * A LITERAL relative specifier, for the reason `./midnames.ts` sets out at
   * its own import: `contracts-stagenet` carries its own `node_modules`, so a
   * runtime `import()` of a computed absolute path inside that tree resolves a
   * SECOND `@midnight-ntwrk/compact-runtime`, and decoding a contract state
   * then dies on `expected instance of ChargedState`. A literal specifier is
   * bundled by esbuild into this service, so there is exactly one runtime in
   * play.
   */
  const account = (await import(
    '../contracts-stagenet/managed/account/contract/index.js'
  )) as unknown as AccountModule;
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const { NodeZkConfigProvider } = await import(
    '@midnight-ntwrk/midnight-js-node-zk-config-provider'
  );
  const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');

  const zkConfigProvider = new NodeZkConfigProvider(managedPath);
  const { mode: provingMode, proofProvider } = await createContractProofProvider(
    config,
    zkConfigProvider as never,
  );
  const reader = await publicDataProviderFor(config);
  const colour = nativeColourBytes();

  /**
   * Has this wallet caught up with the chain that refused a transaction?
   *
   * `isSynced` AND `dust.complete`, not either alone: the rejection is about
   * the DUST coins the balancing selected, so a wallet whose shielded and
   * unshielded halves are current but whose dust wallet is still replaying
   * would rebuild against exactly the stale view that was refused.
   */
  /**
   * Caught up ENOUGH to rebuild a transaction the node refused.
   *
   * Three terms, and the third was measured on 2026/09/03. The first two are
   * the original rule: the refusal is about the DUST the balancing selected, so
   * the wallet must have walked the block that refused it and finished its dust
   * scan. The third is that this service must have NOTHING OF ITS OWN still in
   * flight.
   *
   * At 02:14:19 UTC an activation grant was refused with `Custom error: 231`
   * and rebuilt twice more, at 02:14:46 and 02:14:56, and refused both times —
   * because a registration of this sponsor's was submitted and unlanded
   * throughout, and a rebuild that spends this wallet's DUST while another of
   * its transactions is pending selects against a view the node has already
   * moved past. Three attempts of proving, balancing, and a lane went to
   * transactions that could not land, on a wallet with one fee-capable coin,
   * and the two name claims behind them reached Home at 146.5 s against a bar
   * of 120.
   *
   * Waiting for the pending one costs a block or two. Not waiting cost a
   * minute of somebody's onboarding.
   */
  const caughtUp = async (): Promise<boolean> => {
    const walked = await wallet.progress();
    if (!walked.isSynced || !walked.dust.complete) return false;
    return (await wallet.pendingTransactionCount()) === 0;
  };
  /** The rebuild's wait on the indexer, for every retry in this module. */
  const heightGate = {
    indexerHeight: () => queryIndexerHeight(config.indexerHttpUrl),
    chainHeight: () => wallet.nodeHeight(),
  };

  /* ------------------------------------------------------------------------ */
  /* The asset side                                                           */
  /* ------------------------------------------------------------------------ */

  /**
   * Built here, at start-up, and allowed to FAIL WITHOUT TAKING THE NIGHT LEG
   * WITH IT. The two legs answer different questions — "is this account
   * operable?" and "does it open holding money?" — and a droplet that has the
   * account artefacts but not the faucet ones should still activate Passports,
   * reporting the asset leg as unavailable rather than refusing everything.
   */
  let assetUnavailableReason: string | null = null;
  let faucetPath: string | null = null;
  let assetColourBytes: Uint8Array | null = null;
  let assetTokenType: string | null = null;
  let compiledFaucet: unknown = null;
  let faucetZkConfigProvider: unknown = null;
  let faucetProofProvider: unknown = null;

  if (config.assetGrant <= 0n) {
    assetUnavailableReason = `BALANCER_ASSET_GRANT is 0, so no ${ASSET_SYMBOL} is deposited.`;
  } else if (!config.assetFaucetAddress) {
    assetUnavailableReason = `No ${ASSET_SYMBOL} faucet is known for ${config.networkId}. Set BALANCER_ASSET_FAUCET_ADDRESS to mint against a deployed one.`;
  } else {
    try {
      faucetPath = faucetManagedPath(config.assetAssetsPath);
      /* A LITERAL relative specifier, for the reason the account import below
         sets out: a computed absolute path into `contracts-stagenet` resolves a
         SECOND compact-runtime and decoding then dies on
         `expected instance of ChargedState`. */
      const faucet = (await import(
        '../contracts-stagenet/managed/faucet/contract/index.js'
      )) as unknown as FaucetModule;
      const { CompiledContract: Compiled } = await import('@midnight-ntwrk/compact-js');
      const { NodeZkConfigProvider: FaucetZkConfig } = await import(
        '@midnight-ntwrk/midnight-js-node-zk-config-provider'
      );
      faucetZkConfigProvider = new FaucetZkConfig(faucetPath);
      faucetProofProvider = (
        await createContractProofProvider(config, faucetZkConfigProvider as never)
      ).proofProvider;
      compiledFaucet = Compiled.make('passport-musd-faucet', faucet.Contract as never).pipe(
        /* The faucet declares no witnesses at all: `mint_shielded` takes the
           colour, the amount, the nonce, and the recipient as arguments, and
           knows nothing private. */
        Compiled.withVacantWitnesses,
        Compiled.withCompiledFileAssets(faucetPath),
      );
      /* The colour is bound to the MINTING CONTRACT, not to the caller or the
         separator alone. Computing it here means it is in the start-up log and
         in `/status` before anybody asks for a grant, and a client can match a
         coin it reads off the chain against it. */
      assetTokenType = String(
        ledger.rawTokenType(MUSD_DOMAIN_SEPARATOR, config.assetFaucetAddress),
      );
      assetColourBytes = ledger.encodeRawTokenType(assetTokenType);
    } catch (cause) {
      assetUnavailableReason = cause instanceof Error ? cause.message : String(cause);
      faucetPath = null;
      assetColourBytes = null;
      assetTokenType = null;
      compiledFaucet = null;
    }
  }

  const assetAvailable =
    assetUnavailableReason === null && assetColourBytes !== null && assetTokenType !== null;
  const assetColourHex = assetColourBytes ? bytesToHex(assetColourBytes) : null;

  /**
   * Three refusals, one per declared witness.
   *
   * `deposit_night` calls none of them, so nothing on the funding path notices.
   * They throw rather than returning zeroes so that this service cannot, even
   * through a later mistake, attempt `withdraw_night`, `grant_withdraw_night`,
   * or `recover`. The balancer can put coins into an account; it holds nothing
   * that could take them out, and that is a property of the code rather than a
   * promise about it.
   */
  const refusingWitness = (name: string) => (): never => {
    throw new Error(
      `The balancer has no ${name}: it may deposit into an account-custody contract and nothing else.`,
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
   * remove the last) and exactly three recovery shares (the stagenet build's
   * `initialState` takes `share_1`, `share_2`, `share_3`, and `recover` rewrites
   * the same three — the same pre-BUSS source the preview build was compiled
   * from, verified against the compiled `index.d.ts` here and against a live
   * stagenet ACC). A candidate that fails either test is not an account, and the
   * balancer will not pay coins into it.
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
        `The contract at ${address} is not a Passport account-custody contract — its state does not decode as one — so the balancer will not deposit into it.`,
      );
    }
    return decoded;
  };

  /** The mirrored NIGHT balance, treating an absent colour as zero. */
  const mirroredNight = (decoded: AccountLedger): bigint =>
    decoded.night_balances.member(colour) ? decoded.night_balances.lookup(colour) : 0n;

  /** The shielded balance of the asset colour, treating an absent colour as zero. */
  const heldAsset = (decoded: AccountLedger): bigint => {
    if (!assetColourBytes) return 0n;
    return decoded.coins.member(assetColourBytes)
      ? decoded.coins.lookup(assetColourBytes).value
      : 0n;
  };

  /**
   * Refuses when the asset leg cannot run, so every path below can treat the
   * faucet objects as present. `assetAvailable` is the same question asked
   * without throwing, for `/status` and for the endpoint's planning.
   */
  const requireAsset = (): {
    colourBytes: Uint8Array;
    tokenType: string;
    faucetAddress: string;
  } => {
    if (!assetAvailable || !assetColourBytes || !assetTokenType || !config.assetFaucetAddress) {
      throw new AccountFundingError(
        'asset-unsupported',
        assetUnavailableReason ??
          `The ${ASSET_SYMBOL} grant is not configured, so no asset can be deposited.`,
      );
    }
    return {
      colourBytes: assetColourBytes,
      tokenType: assetTokenType,
      faucetAddress: config.assetFaucetAddress,
    };
  };

  /* -------------------------------------------------------------------------- */
  /* The spare mUSD coin                                                        */
  /* -------------------------------------------------------------------------- */

  /**
   * One minted, spendable mUSD coin of exactly the grant size, held ready so an
   * activation's asset leg is a single `deposit_shielded`.
   *
   * The leg used to be mint → wait for the coin to become spendable → deposit,
   * and the middle step is a wallet catching up with its own transaction: about
   * three of the roughly four minutes an activation took. Minting one coin
   * AHEAD of the request — at start-up, and again after each grant — takes that
   * wait out of the user's onboarding entirely and puts it on a quiet service.
   *
   * Never more than one, so this cannot drift into minting money in a loop, and
   * never minted while a spend job holds the wallet, so it cannot queue itself
   * in front of somebody's fee.
   */
  let spareCoin: { nonce: string; value: bigint; mintTx: string } | null = null;
  let spareInFlight: Promise<void> | null = null;

  /** Mints one grant-sized coin to this wallet and waits for it to be spendable. */
  const mintAssetCoin = async (): Promise<{ nonce: string; value: bigint; mintTx: string }> => {
    const { tokenType, faucetAddress } = requireAsset();
    const recipientBytes = await wallet.shieldedCoinPublicKeyBytes();
    /* The nonce is what makes the minted coin identifiable in a wallet that
       may already hold other coins of the same colour — a coin stranded by an
       earlier deposit that failed, say. Everything below matches on it rather
       than on the value, so two grants of the same size can never be confused
       for one another. */
    const mintNonce = new Uint8Array(randomBytes(32));
    const mintNonceHex = bytesToHex(mintNonce);

    let mintTx: string;
    try {
      mintTx = await wallet.exclusive(async () => {
        /* Built INSIDE the job, so the job closes it. Built outside, as it was
           until 2026/09/03, its indexer client belonged to nobody: the balancer
           mints a spare at start-up and after every grant, and each of those
           left an Apollo client and a WebSocket behind for the life of the
           process. `contractProviders` says so in the journal when it happens,
           which is how this one was found. */
        const faucetProviders = await contractProviders(config, {
          privateStateId: 'passport-balancer-faucet',
          initialPrivateState: {},
          zkConfigProvider: faucetZkConfigProvider as never,
          proofProvider: faucetProofProvider,
          /* Explicitly zero, though zero is now the default: this job must
             never be the one that holds a lane waiting for a coin. If there is
             no DUST free when the mint reaches its fee estimate, it gives the
             lane back within a second and the next minute tick asks again. */
          walletProvider: wallet.contractWalletProvider({ waitForDustMs: 0 }),
        });
        const found = await findDeployedContract(faucetProviders as never, {
          compiledContract: compiledFaucet,
          contractAddress: faucetAddress,
        } as never);
        const callTx = (found as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> })
          .callTx;
        const mint = await callTx.mint_shielded(MUSD_DOMAIN_SEPARATOR, config.assetGrant, mintNonce, {
          bytes: recipientBytes,
        });
        return transactionIdentifier(mint);
      }, { label: `the spare ${ASSET_SYMBOL} mint` });
    } catch (cause) {
      throw new AccountFundingError(
        'mint-failed',
        `The ${ASSET_SYMBOL} grant could not be minted, so nothing was deposited.`,
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    /* Outside the spend lock deliberately. This is the balancer's own wallet
       catching up with a transaction it has just made, and holding the queue
       through it would stall `/balance-only` for no reason. */
    for (let attempt = 0; attempt < MINT_VISIBLE_ATTEMPTS; attempt += 1) {
      try {
        const coins = await wallet.availableShieldedCoins(tokenType);
        const found = coins.find(
          (candidate) =>
            candidate.nonce.replace(/^0x/, '').toLowerCase() === mintNonceHex &&
            candidate.value === config.assetGrant,
        );
        if (found) return { nonce: found.nonce, value: found.value, mintTx };
      } catch {
        // A momentary wallet-state timeout; asked again below.
      }
      await wait(CONFIRM_INTERVAL_MS);
    }
    throw new AccountFundingError(
      'mint-not-visible',
      `The ${ASSET_SYMBOL} grant was minted but has not become spendable in the balancer's wallet yet.`,
      `mint ${mintTx}, nonce ${mintNonceHex}`,
    );
  };

  /**
   * Makes sure one spare coin is ready, minting if there is none.
   *
   * Never throws at its caller: a spare that could not be minted costs an
   * activation the three minutes it used to cost anyway, and a start-up or a
   * post-grant housekeeping task is no place to fail a request from.
   */
  const ensureSpareCoin = async (options: EnsureSpareCoinOptions = {}): Promise<boolean> => {
    if (!assetAvailable || spareCoin || spareInFlight) return false;
    /* Never in front of somebody's fee or somebody's grant. There is always a
       next call — the next minute tick, or the end of the next activation. */
    if (wallet.isBusy()) return false;
    /* Nor while anybody is so much as WAITING to be served. On 2026/09/02 this
       job entered the queue at 15:49:03 with a request behind it and held it
       until 15:59:07: a `/balance-only`, which bypasses the queue, had taken
       the coins in between and the fee estimate then sat out its whole budget
       inside the job. The budget is gone — see `waitForDustMs` below — and so
       is the reason to start at all with a queue that is not empty. */
    if (options.queueIdle && !options.queueIdle()) return false;
    /* And never on the LAST free coin. A mint is housekeeping; taking the only
       coin a caller's registration could have used, to save a future caller
       three minutes, is the wrong trade in every case. Two is the floor rather
       than one because this wallet's coin selection sweeps the small coin plus
       a large one for a single fee. */
    try {
      if ((await wallet.dustUtxoCount()) < 2) return false;
    } catch {
      return false;
    }
    spareInFlight = (async () => {
      try {
        const minted = await mintAssetCoin();
        spareCoin = minted;
        console.log(`[asset] spare ${ASSET_SYMBOL} coin ready (mint ${minted.mintTx})`);
      } catch (cause) {
        console.warn(
          `[asset] no spare ${ASSET_SYMBOL} coin: ${cause instanceof Error ? cause.message : String(cause)} — the next activation will mint its own`,
        );
      } finally {
        spareInFlight = null;
      }
    })();
    await spareInFlight;
    /* True whether or not a coin arrived: the attempt spent this wallet's DUST
       either way, and the caller needs to know that so a shortfall read in the
       next thirty seconds is reported as settling rather than as an empty
       balancer. */
    return true;
  };

  /** Takes the spare if there is one, and mints inline if there is not. */
  const takeAssetCoin = async (): Promise<{
    nonce: string;
    value: bigint;
    mintTx: string;
    fromSpare: boolean;
  }> => {
    const take = (): { nonce: string; value: bigint; mintTx: string } | null => {
      const taken = spareCoin;
      spareCoin = null;
      return taken;
    };
    const ready = take();
    if (ready) return { ...ready, fromSpare: true };
    /* A mint already under way is worth waiting for — it is minutes ahead of
       starting a second one, and two would leave a coin stranded. */
    if (spareInFlight) await spareInFlight.catch(() => undefined);
    const arrived = take();
    if (arrived) return { ...arrived, fromSpare: true };
    return { ...(await mintAssetCoin()), fromSpare: false };
  };

  return {
    assetsPath: managedPath,
    grantAtomic: config.accountGrantAtomic,
    provingMode,
    assetAvailable,
    assetUnavailableReason,
    assetSymbol: ASSET_SYMBOL,
    assetColourHex,
    assetFaucetAddress: config.assetFaucetAddress ?? null,
    assetAssetsPath: faucetPath,
    assetGrant: config.assetGrant,

    async nightBalance(contractAddress: string): Promise<bigint> {
      return mirroredNight(await readAccount(rawContractAddress(contractAddress)));
    },

    async balances(contractAddress: string): Promise<AccountBalances> {
      const decoded = await readAccount(rawContractAddress(contractAddress));
      return { night: mirroredNight(decoded), asset: heldAsset(decoded) };
    },

    async fund(contractAddress: string): Promise<AccountFunding> {
      const address = rawContractAddress(contractAddress);
      /* Read inside the lock, immediately before spending: the confirmation
         below is "this deposit's credit is visible", not "the balance is
         non-zero", and it needs a baseline nothing else can have moved since. */
      const before = mirroredNight(await readAccount(address));

      const privateStateId = `passport-balancer-account-${address}`;
      const providers = await contractProviders(config, {
        privateStateId,
        initialPrivateState: {},
        zkConfigProvider: zkConfigProvider as never,
        proofProvider,
        walletProvider: wallet.contractWalletProvider(),
      });

      let depositTx: string;
      try {
        /* Rebuilt and retried if the NODE refuses it, which is the failure this
           leg actually has: a deposit balanced one block behind the
           registration in front of it was refused with `Custom error: 231` on
           2026/09/02, answered the client 502, and cost 229 s of the client's
           own retry ladder to land. Everything inside is rebuilt each attempt —
           a fresh `findDeployedContract` selects coins against the state as it
           now stands, where resending the refused bytes would fail identically
           for ever. */
        depositTx = await withNodeRejectionRetry(
          async () => {
            const found = await findDeployedContract(providers as never, {
              compiledContract,
              contractAddress: address,
              privateStateId,
              initialPrivateState: {},
            } as never);
            const callTx = (
              found as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> }
            ).callTx;
            /* The paid call. `receiveUnshielded` inside the circuit makes the
               transaction owe the contract `grantAtomic` of the native colour,
               and the balancer's own wallet provider balances that from the
               balancer's own NIGHT — the same mechanism that pays Midnames its
               COST. */
            const deposit = await callTx.deposit_night(colour, config.accountGrantAtomic);
            return transactionIdentifier(deposit);
          },
          { label: `deposit_night into ${address}`, synced: caughtUp, ...heightGate },
        );
      } catch (cause) {
        /* A DUST shortfall is not a failed deposit — nothing was built, nothing
           was submitted, and nothing was credited. It travels out untouched so
           `./server.ts` can wait for a coin and rebuild this leg rather than
           telling the caller its grant failed. */
        if (isDustShortfall(cause)) throw cause;
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
            progress('confirmed');
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

      const resolved = await resolveTransactionHash(config.indexerHttpUrl, depositTx);
      return {
        contractAddress: address,
        txHash: resolved.hash,
        block: resolved.block,
        amountAtomic: config.accountGrantAtomic,
        balanceAfterAtomic: balanceAfter,
        fundedAt: new Date().toISOString(),
      };
    },

    ensureSpareCoin,

    spareState(): 'ready' | 'minting' | 'none' | 'unsupported' {
      if (!assetAvailable) return 'unsupported';
      if (spareCoin) return 'ready';
      return spareInFlight ? 'minting' : 'none';
    },

    async fundAsset(contractAddress: string): Promise<AssetFunding> {
      const { colourBytes } = requireAsset();
      const address = rawContractAddress(contractAddress);
      /* The same baseline discipline as the NIGHT leg: the confirmation below
         is "THIS deposit's credit is visible", not "the map is non-empty". */
      const before = heldAsset(await readAccount(address));

      /* ------------------------------------------------------------------ */
      /* 1. Take a grant-sized coin — the spare if one is ready              */
      /* ------------------------------------------------------------------ */

      /* This is where the activation's time went. A coin minted on demand is
         only spendable once this wallet has seen its own transaction, which is
         about three minutes of a caller's onboarding; a spare minted ahead of
         the request makes the leg one `deposit_shielded`. */
      const coin = await takeAssetCoin();
      const mintTx = coin.mintTx;
      console.log(
        `[asset] ${coin.fromSpare ? 'using the spare' : 'minted a'} ${ASSET_SYMBOL} coin for ${address} (mint ${mintTx})`,
      );

      /* ------------------------------------------------------------------ */
      /* 2. deposit_shielded — the coin into the ACCOUNT                     */
      /* ------------------------------------------------------------------ */

      const privateStateId = `passport-balancer-account-${address}`;

      let depositTx: string;
      try {
        depositTx = await withNodeRejectionRetry(
          () => wallet.exclusive(async () => {
          /* Built INSIDE the job, so the job closes it — and built afresh on
             each rebuild, which is what a rebuild is for. Built once outside,
             as it was until 2026/09/03, its indexer client belonged to no job
             and was never disposed; the journal named this exact private state
             in a `built outside any spend job` line. */
          const accountProviders = await contractProviders(config, {
            privateStateId,
            initialPrivateState: {},
            zkConfigProvider: zkConfigProvider as never,
            proofProvider,
            walletProvider: wallet.contractWalletProvider(),
          });
          const found = await findDeployedContract(accountProviders as never, {
            compiledContract,
            contractAddress: address,
            privateStateId,
            initialPrivateState: {},
          } as never);
          const callTx = (
            found as { callTx: Record<string, (...args: unknown[]) => Promise<unknown>> }
          ).callTx;
          /* `receive(coin)` inside the circuit takes the coin from the
             transaction and writes it into the account's `coins` map. The
             balancer's own wallet provider supplies the shielded input that
             makes the transaction offer it. */
          const deposit = await callTx.deposit_shielded({
            nonce: hexToBytes(coin.nonce),
            color: colourBytes,
            value: coin.value,
          });
          return transactionIdentifier(deposit);
          }, { label: `deposit_shielded into ${address}` }),
          { label: `deposit_shielded into ${address}`, synced: caughtUp, ...heightGate },
        );
      } catch (cause) {
        throw new AccountFundingError(
          'asset-deposit-failed',
          `The ${ASSET_SYMBOL} grant was minted but could not be deposited into ${address}; the coin stayed with the balancer.`,
          `mint ${mintTx}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      /* ------------------------------------------------------------------ */
      /* 3. Read the credit back off the chain                               */
      /* ------------------------------------------------------------------ */

      const target = before + config.assetGrant;
      let balanceAfter: bigint | null = null;
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
        try {
          const held = heldAsset(await readAccount(address));
          if (held >= target) {
            balanceAfter = held;
            progress('confirmed');
            break;
          }
        } catch {
          // Indexer lag or a transient failure; asked again below.
        }
        await wait(CONFIRM_INTERVAL_MS);
      }
      if (balanceAfter === null) {
        throw new AccountFundingError(
          'asset-confirmation-failed',
          `The ${ASSET_SYMBOL} grant for ${address} was submitted but the account's coins map has not shown the credit yet.`,
          `mint ${mintTx}, deposit ${depositTx}, held ${before} before`,
        );
      }

      /* Mint the NEXT one now, while nobody is waiting on it. Not awaited: the
         caller's grant is already on chain and confirmed, and the three minutes
         a mint takes to become spendable is precisely what this keeps off the
         next caller's onboarding. */
      void ensureSpareCoin();

      const [mintResolved, depositResolved] = await Promise.all([
        resolveTransactionHash(config.indexerHttpUrl, mintTx),
        resolveTransactionHash(config.indexerHttpUrl, depositTx),
      ]);
      return {
        contractAddress: address,
        mintTxHash: mintResolved.hash,
        mintBlock: mintResolved.block,
        depositTxHash: depositResolved.hash,
        depositBlock: depositResolved.block,
        amount: config.assetGrant,
        colourHex: bytesToHex(colourBytes),
        balanceAfter,
        fundedAt: new Date().toISOString(),
      };
    },
  };
}
