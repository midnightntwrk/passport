/**
 * passport-balancer — the whole stagenet onboarding sponsor.
 *
 * It holds NIGHT, registers that NIGHT for DUST generation, and then pays for
 * the three things a new Passport cannot pay for itself:
 *
 *   GET  /status         →  a human answer: network, address, balances, whether
 *                           the wallet is synced, how it proves, what the DUST
 *                           registration did, how many transactions it balanced,
 *                           how many names and accounts it has sponsored, and
 *                           — as `health` — what its own watchdog last decided
 *                           about it, why, and what it did about it
 *   GET  /wallet-status  →  { total, available, wallets[] } — the exact shape
 *                           `examples/passport-demo/src/lib/sponsor.ts` parses,
 *                           down to `wallets[].dust.balance` being a STRING
 *   POST /balance-only   →  a serialised finalized transaction in, the same
 *                           transaction with a DUST fee leg attached and proved
 *                           out, as `{ txHash, txBytes, expiresAt }`
 *   POST /register-alias →  { alias, ownerKey, contractAddress } in, a `.night`
 *                           name registered TO the user's key and resolving to
 *                           the user's contract out — the balancer paying the
 *                           registry price and both fees
 *   POST /fund-account   →  { contractAddress } in, an activation grant
 *                           deposited INTO that account-custody contract out —
 *                           BOTH legs: NIGHT into `night_balances`, and 100 mUSD
 *                           minted from the faucet and paid into `coins`
 *
 * FEES, NAME, ACTIVATION — the three costs of onboarding, and none of them
 * reaches the user's wallet. `/balance-only` is the fee sponsorship the demo
 * already consumes on preview through the 1AM gateway. The other two are ports
 * of `examples/passport-funder`, which does them on preview, onto the ledger-9
 * stack stagenet needs; their policy order, their refusal codes, and their
 * response shapes are the funder's, so a client written against one works
 * against the other.
 *
 * Why they had to move here rather than stay in the funder: the funder's v8
 * wallet SDK cannot read stagenet at all, and the ONE thing a migrated PWA
 * still cannot do on stagenet is pay the 10 atomic NIGHT `register_domain_for`
 * takes from its CALLER. A fresh passkey wallet holds nothing, and the stagenet
 * faucet is captcha-gated, so there is no self-service path to that 10. The
 * registry's entrypoint takes the owner as an ARGUMENT, so a third party can
 * pay — and the balancer, which already holds NIGHT and DUST for the fee leg,
 * is the third party already standing there.
 *
 * The sponsorship protocol is not invented here. `sponsor.ts` is the ground
 * truth for `/balance-only` and this service answers it, which means three
 * things are load-bearing:
 *
 *   1. **`available` is a capability claim, not a health check.** The client
 *      gates on `available > 0` precisely because the deployed preview gateway
 *      reports a synced wallet with zero DUST as "ready". A wallet that cannot
 *      pay a fee right now contributes nothing to `available` here, whatever
 *      else is true of it. The converse binds just as hard, and cost a morning
 *      of stalled Sends on 2026/08/26: a wallet that IS busy but is busy PROVING
 *      can still pay a fee, because the coins its own transaction will spend are
 *      already booked as spent and a second balancing picks different ones. So
 *      `available` reads the CLAIM on the wallet's coins (`isReserved()`), never
 *      the length of the job holding the queue. See `./reservation.ts`.
 *   2. **`/balance-only` never submits.** It hands the balanced transaction
 *      back and the caller's own wallet submits it. That is what keeps the
 *      user's approval moment — and the user's own custody of the send —
 *      untouched by sponsorship.
 *   3. **A refusal is typed and honest.** `WALLET_SYNCING`,
 *      `INSUFFICIENT_DUST`, `PENDING_TRANSACTION`, `INVALID_TRANSACTION`,
 *      `BALANCE_FAILED` — each with the HTTP status `sponsor.ts` branches on.
 *      An unfunded balancer says `available: 0` and refuses; it never pretends.
 *
 * Alias policy, in the order it is enforced — the funder's own, unchanged:
 * well-formed and unreserved label, owner key, and contract address on THIS
 * network → no other registration for the same alias or the same contract in
 * flight → the name is free on the registry → the contract really exists on
 * chain → once-only per contract address (persisted ledger) → global hourly
 * rate limit → the balancer able to pay.
 *
 * Account-funding policy, likewise: well-formed contract address on THIS
 * network → no other funding for the same contract in flight → the contract
 * exists AND decodes as an account-custody contract → once-only per contract
 * address (persisted ledger) → the account is not already holding a grant's
 * worth → global hourly rate limit → the balancer able to pay.
 *
 * The once-only gate is asked PER LEG, because an activation is two credits and
 * the second can fail after the first has landed. A request whose asset leg
 * fails answers 200 with `assetTx: null` and an `assetError` — the NIGHT credit
 * is real and must not be reported as a failure — and the persisted ledger
 * records only the leg that actually happened, so the next `/fund-account` for
 * that contract performs the missing half and nothing else.
 *
 * Every refusal is a clear JSON error, and nothing is reported as done until it
 * has been read back off the chain.
 *
 * WHO MAY ASK AT ALL. The policies above bound what one PASSPORT can be given;
 * they say nothing about what one CALLER can ask for, and until 2026/09/01 they
 * were the only gates the three spending endpoints had. Anybody holding the URL
 * could post to them — the CORS allow-list decides which headers a browser gets
 * back, not whether the handler runs — and `/balance-only` had no ceiling at all
 * while paying a DUST fee on every call. So each of the three now passes through
 * `./limits.ts` before it reaches a policy gate: a per-client token bucket keyed
 * on the address the socket really came from, a bound on how many spend requests
 * may be in flight at once, and — when `BALANCER_CLIENT_KEY` is set — a shared
 * secret in `X-Passport-Key`. All three refuse in the shape above, with the same
 * `[balance]`/`[alias]`/`[account] refused:` line in the journal, and the
 * counters are published as `limits` on `/status`.
 *
 * Everything else — env-only configuration, a sync snapshot on disk, a CORS
 * allow-list, SIGTERM saving before it exits — is `examples/passport-funder`'s
 * shape, so an operator running both on the same droplet learns one service.
 *
 * KEEPING ITSELF ALIVE. A watchdog runs in here on a ten-minute interval
 * (`BALANCER_HEALTH_INTERVAL_MS`), classifies the wallet, and repairs it when
 * repair is what is called for — and, far more often, does nothing, because the
 * two states this wallet is usually in when it looks broken are states in which
 * acting would BE the fault. It never runs while `isReserved()` or `isBusy()`,
 * and it never treats the 20-to-60-second DUST settle after a sponsorship as a
 * problem. `./health.ts` carries the classifier, the remedies, and the reasons.
 * The failure it cannot see from in here — a live process that has stopped
 * answering HTTP — belongs to `passport-balancer-watchdog.timer` on the
 * droplet, which probes `/wallet-status` from outside.
 */

import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import {
  MidnightBech32m,
  UnshieldedAddress,
  mainnet,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import {
  AccountFundingError,
  createAccountFunder,
  type AccountFunder,
} from './account.js';
import { walletAvailability } from './availability.js';
import { ASSET_SYMBOL, applyEnvFile, loadConfig, type BalancerConfig } from './config.js';
import { rawContractAddress } from './contractRuntime.js';
import { rollbackDustSnapshot } from './dustRollback.js';
import {
  DEFAULT_HEALTH_POLICY,
  EMPTY_HEALTH_RECORD,
  startHealthLoop,
  type HealthMonitor,
  type HealthProbeReading,
  type HealthRecord,
} from './health.js';
import {
  HourlyRateLimiter,
  JsonLedger,
  type AccountAssetEntry,
  type AccountEntry,
  type AliasEntry,
  type ResolverEntry,
} from './ledgers.js';
import { SpendAdmission, TokenBucket, clientAddress, clientKeyAccepted } from './limits.js';
import {
  AliasSponsorError,
  aliasCostAtomicNight,
  aliasDomain,
  createMidnamesSponsor,
  normalisePassportAlias,
  ownerKeyBytes,
  type AliasRegistration,
  type MidnamesSponsor,
} from './midnames.js';
import { startLivenessWatch } from './liveness.js';
import { countingProof, proofsInFlight } from './proving.js';
import { SpendPriority } from './reservation.js';
import {
  FEE_CAPABLE_SPECKS,
  resolverLedgerFrom,
  startResolverPool,
  type ResolverPool,
} from './resolverPool.js';
import {
  BalanceRefusal,
  DustWaitExhausted,
  formatNight,
  isEffectivelySynced,
  isLegEffectivelySynced,
  markDustColdStart,
  openBalancerWallet,
  syncAheadDetail,
  withDustWait,
  type BalancerWallet,
} from './wallet.js';
import { activationLegs, GRANT_RETRY_DELAY_MS, shouldRetryGrant } from './activationLegs.js';
import {
  createColourPayer,
  createGiftDesk,
  giftLedgerOf,
  type GiftDesk,
  type GiftEntry,
} from './gift.js';
import {
  SWAP_ASSET_SYMBOL,
  SWAP_SEPARATOR_LABEL,
  createSwapDesk,
  swapLedgerOf,
  verifyPaymentOnChain,
  type SwapDesk,
  type SwapEntry,
} from './swap.js';

/**
 * `MidnightBech32m.parse` reports mainnet as the exported `mainnet` symbol (a
 * mainnet address carries no network segment), every other network as its
 * string — the SDK's own normalisation, mirrored from the funder.
 */
function parsedNetworkName(value: string | typeof mainnet): string {
  return value === mainnet ? 'mainnet' : value;
}

type Refusal = { status: number; error: string; message: string; extra?: Record<string, unknown> };

function refusal(
  status: number,
  error: string,
  message: string,
  extra?: Record<string, unknown>,
): Refusal {
  return { status, error, message, ...(extra ? { extra } : {}) };
}

/** Bigger than any Midnight transaction the demo builds, small enough to bound. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** How often the start-up DUST registration is retried while it cannot run yet. */
const REGISTRATION_RETRY_MS = 60_000;

type RegistrationState =
  | 'pending'
  | 'registered'
  | 'already-generating'
  | 'no-night'
  | 'waiting-for-dust'
  | 'failed';

function elapsed(startedAt: number): string {
  const seconds = (Date.now() - startedAt) / 1_000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${(seconds - minutes * 60).toFixed(0)} s`;
}

async function main(): Promise<void> {
  applyEnvFile();
  const config: BalancerConfig = loadConfig();
  console.log(`network   ${config.networkId}`);
  console.log(`indexer   ${config.indexerHttpUrl}`);
  console.log(`indexerWs ${config.indexerWsUrl}`);
  console.log(`node      ${config.nodeUrl}`);
  console.log(
    `prover    ${config.provingServerUrl ?? 'in-process WASM prover (no BALANCER_PROVER_URL set)'}`,
  );
  console.log(`state     ${config.stateDir}`);
  console.log(`ttl       ${config.balanceTtlMs} ms on every balanced transaction`);
  console.log(
    `health    ${config.healthIntervalMs > 0 ? `a watchdog check every ${config.healthIntervalMs} ms` : 'watchdog disabled (BALANCER_HEALTH_INTERVAL_MS=0)'}`,
  );
  console.log(
    `alias     ${config.midnamesTldAddress ? `.night TLD ${config.midnamesTldAddress}` : `no .night registry known for ${config.networkId} — /register-alias disabled`}`,
  );
  console.log(`alias cap ${config.aliasMaxPerHour} sponsored registrations per rolling hour`);
  console.log(
    `grant     ${config.accountGrantAtomic} atomic NIGHT (${formatNight(config.accountGrantAtomic)} NIGHT) into each account contract`,
  );
  console.log(`grant cap ${config.accountMaxPerHour} funded accounts per rolling hour`);
  console.log(
    `asset     ${config.assetGrant > 0n && config.assetFaucetAddress ? `${config.assetGrant} ${ASSET_SYMBOL} minted from faucet ${config.assetFaucetAddress} into each account contract` : `no ${ASSET_SYMBOL} grant — the asset leg of /fund-account is off`}`,
  );
  console.log(`origins   ${config.allowedOrigins.join(', ')}`);
  const describeRate = (limit: { perMinute: number; burst: number }): string =>
    limit.perMinute > 0
      ? `${limit.perMinute}/min per client (burst ${limit.burst})`
      : 'no per-client limit';
  console.log(
    `limits    /balance-only ${describeRate(config.balanceRate)}; /register-alias ${describeRate(config.aliasRate)}; /fund-account ${describeRate(config.accountRate)}`,
  );
  console.log(
    `dust      a name claim or a grant waits up to ${Math.round(config.dustWaitMs / 1_000)} s, outside the spend queue, for a fee-capable DUST coin before it refuses`,
  );
  console.log(
    `queue     ${config.spendQueueMax > 0 ? `at most ${config.spendQueueMax} spend requests in flight` : 'unbounded spend queue (BALANCER_SPEND_QUEUE_MAX=0)'}`,
  );
  console.log(`proxies   X-Forwarded-For believed from ${config.trustedProxies.join(', ')} and nowhere else`);
  console.log(
    `key       ${config.clientKey ? 'the three spend endpoints require X-Passport-Key' : 'no BALANCER_CLIENT_KEY set — the spend endpoints are open to anybody who can reach them'}\n`,
  );

  const aliasLedger = await JsonLedger.open<AliasEntry>(
    config.stateDir,
    config.networkId,
    'aliases',
  );
  const accountLedger = await JsonLedger.open<AccountEntry>(
    config.stateDir,
    config.networkId,
    'accounts',
  );
  /* The swap desk's idempotency gate: one payment hash, one lot, forever. */
  const swapLedger = await JsonLedger.open<SwapEntry>(config.stateDir, config.networkId, 'swaps');
  /* One item per account, so a second ask answers with the first gift. */
  const giftLedger = await JsonLedger.open<GiftEntry>(config.stateDir, config.networkId, 'gifts');
  /**
   * The shelf of pre-deployed resolver leaves, beside the other once-only
   * ledgers. Not once-only itself — a leaf is written when it is deployed and
   * rewritten when it is consumed — but the same atomic write-and-rename, and
   * for the same reason: a restart that forgot the shelf would deploy a hundred
   * more leaves and abandon the ones it already paid for.
   */
  const resolverLedger = await JsonLedger.open<ResolverEntry>(
    config.stateDir,
    config.networkId,
    'resolvers',
  );
  /**
   * The health watchdog's restart bookkeeping, on the same atomic
   * write-and-rename the once-only ledgers use.
   *
   * On disk rather than in memory because it is the rate limit on RESTARTS: a
   * limit the restarted process forgets is not a limit, and forgetting it is
   * precisely how a service ends up bouncing itself every ten minutes. One key,
   * because there is one wallet. See `./health.ts`.
   */
  const healthLedger = await JsonLedger.open<HealthRecord>(
    config.stateDir,
    config.networkId,
    'health',
  );
  const aliasLimiter = new HourlyRateLimiter(config.aliasMaxPerHour);
  const accountLimiter = new HourlyRateLimiter(config.accountMaxPerHour);

  /**
   * The per-client ceilings, one bucket per spending endpoint.
   *
   * Separate buckets and not one shared one, because the three calls are not
   * interchangeable: a session sends repeatedly and registers a name once, so a
   * shared bucket would either let a name-flood through or refuse an ordinary
   * Send. In memory, like `HourlyRateLimiter`: a restart forgets the window,
   * which for a back-stop against a flood is fine, and the once-only ledgers —
   * the gates that must not be forgotten — are still the ones on disk.
   */
  const balanceBucket = new TokenBucket({
    ratePerMinute: config.balanceRate.perMinute,
    burst: config.balanceRate.burst,
  });
  const aliasBucket = new TokenBucket({
    ratePerMinute: config.aliasRate.perMinute,
    burst: config.aliasRate.burst,
  });
  const accountBucket = new TokenBucket({
    ratePerMinute: config.accountRate.perMinute,
    burst: config.accountRate.burst,
  });
  const spendAdmission = new SpendAdmission(config.spendQueueMax);

  /**
   * Alias registrations in progress, keyed BOTH ways: `alias:<label>` and
   * `contract:<address>`.
   *
   * Two keys because two different requests can collide. Two people racing for
   * the same name would both read it as free on the registry and both pay for a
   * resolver, and only one of those registrations can land — so the second is
   * refused, not queued. One person double-clicking would pass the once-only
   * ledger twice for the same contract, because that ledger is written only
   * after the second transaction confirms. Both keys are claimed together,
   * before any ledger read, and released in a `finally`.
   *
   * A Set is sufficient because this is one single-threaded process with one
   * wallet. It is deliberately NOT a substitute for the ledger, which is what
   * survives a restart.
   */
  const aliasInFlight = new Set<string>();
  /**
   * Account fundings in progress, keyed by contract address.
   *
   * One key, not two: an account funding is about exactly one thing, the
   * contract being credited. Claimed before the once-only ledger is read,
   * because that ledger is written only after the deposit confirms — two
   * requests arriving in that window would both read "not funded" and both
   * deposit.
   */
  const accountInFlight = new Set<string>();

  const startedAt = Date.now();

  /**
   * A spend consumes its whole UTxO and the change comes back in a new one, so
   * for a block or two after a spend the wallet really does hold nothing
   * spendable. Measured on preview 2026/08/07 for the funder: a wallet holding
   * ~5,000 NIGHT read zero immediately after a drip and was whole again 20 s
   * later. Reporting that as an empty balancer would be false, so a shortfall
   * is not believed until it has had time to settle.
   *
   * Long enough to outlast the wallet's own post-spend "syncing" flap, which
   * was measured at ~2 minutes (the SDK scores being one event AHEAD of the
   * stream the same as being behind). A fund-account request arrives seconds
   * after the registration that caused the flap; 90 s turned it away with
   * `wallet-syncing` on the live site (2026/08/25) while the flap self-healed
   * 30 s later.
   *
   * Declared HERE, above the wallet, because the wallet is given it: until
   * 2026/09/02 only `/fund-account` waited this window out and `/balance-only`
   * answered 503 instantly, which is what sent a client mid-send to a different
   * sponsor and lost the second leg of its transfer.
   */
  const CHANGE_SETTLE_MS = 300_000;
  const SETTLE_POLL_MS = 3_000;

  /**
   * When the balancer last SPENT — a sponsored registration or an activation
   * grant — so a shortfall read straight afterwards can be reported as
   * settling rather than as an empty wallet. A spend consumes its whole UTxO
   * and the change comes back in a new one, so for a block or two the wallet
   * really does read as holding nothing.
   */
  let lastSpendAt = 0;

  /**
   * True from the moment a revert is seen to have given nothing back until this
   * process leaves to be restarted with a repaired snapshot.
   *
   * The wedge is provable at the instant it happens — see `isDustWedged` in
   * `./wallet.ts` — and the health loop's next tick can be ten minutes away.
   * Rather than answer ten minutes of requests out of a wallet whose coins are
   * hidden from it, every spending endpoint refuses with `PENDING_TRANSACTION`
   * and a five-second retry, which is the refusal `sponsor.ts` already treats
   * as "try again shortly" rather than "this sponsor is dead". A tick is asked
   * for immediately alongside.
   */
  let dustRepairPending = false;

  /**
   * When a PERSON last asked this service for something — any route but the two
   * read-only probes, which are polled by watchdogs around the clock and would
   * otherwise keep the resolver pool permanently paused.
   *
   * The pool's quiet-period gate reads it. Nothing else does: this is not a
   * rate limit and not a health signal, it is the filler's answer to "is anyone
   * about?".
   */
  let lastRequestAt = 0;

  /**
   * Proofs this service has outstanding at the prover that are NOT inside a
   * spend job — which today means `/balance-only`, whose proving deliberately
   * happens outside the queue so a fee leg never waits behind a grant.
   *
   * The resolver pool needs it because `wallet.isBusy()` cannot see it: a leaf
   * deploy started while somebody's Send is being proved would put two proofs
   * on a two-vCPU droplet's single prover, and the one that suffers is the one
   * a person is waiting for.
   */
  /* A process-wide count now, not a local one: `/balance-only` is no longer
     the only path that proves. See `./proving.ts` — the stall watchdog reads
     the same number, and a watchdog that could not see a contract proof would
     abort registrations that were merely mid-proof. */

  process.stdout.write('opening the balancer wallet\n');
  const wallet: BalancerWallet = await openBalancerWallet(config, {
    lastSpendAt: () => lastSpendAt,
    settleWindowMs: CHANGE_SETTLE_MS,
    onDustWedged: () => {
      if (dustRepairPending) return;
      dustRepairPending = true;
      console.warn(
        '[dust] refusing further sponsorship with PENDING_TRANSACTION until the stored DUST state is repaired — asking the watchdog for a tick now rather than at its next interval',
      );
      void healthMonitor?.tick().catch((cause) => {
        console.warn('[dust] the immediate health tick failed', cause);
      });
    },
  });
  console.log(`balancer address ${wallet.address}`);
  console.log(`proving via      ${wallet.provingMode === 'server' ? 'proof server' : 'WASM, in this process'}\n`);

  let syncSeconds: number | null = null;
  let registration: RegistrationState = 'pending';
  let registrationDetail: string | null = null;
  let balancesServed = 0;
  let lastBalanceAt: string | null = null;
  /** The same instant as `lastBalanceAt`, kept as a number for the watchdog. */
  let lastBalanceMs = 0;
  /**
   * Assigned once the wallet is open. `null` while it is being built, and when
   * `BALANCER_HEALTH_INTERVAL_MS=0` turns the in-process leg off.
   */
  let healthMonitor: HealthMonitor | null = null;
  /**
   * The shelf of pre-deployed resolver leaves and the filler that stocks it.
   * `null` when there is no sponsor to deploy through or the target is zero.
   */
  let resolverPool: ResolverPool | null = null;
  let aliasesSponsored = 0;
  let accountsFunded = 0;
  /**
   * Accounts whose NIGHT grant this service is about to try again on its
   * own, after a failed attempt. A re-post for one of these is told to wait
   * rather than started beside the retry — two grants for one account is the
   * double credit the once-only ledger exists to prevent.
   */
  const grantRetries = new Set<string>();
  /**
   * Guard refusals since this process started, published as `limits` on
   * `/status`.
   *
   * Counted rather than merely logged because the question an operator asks
   * during a demo is "is anybody hammering this?", and that is a number, not a
   * grep. They are per-process for the same reason the buckets are.
   */
  let refusedRateLimited = 0;
  let refusedQueueFull = 0;
  let refusedUnauthorised = 0;
  /** Asset legs completed since this process started, counted apart from NIGHT. */
  let assetsFunded = 0;
  /**
   * The alias sponsor, built once at start-up so a missing or unreadable
   * Midnames build is a start-up log line rather than a user's first failure.
   * `null` means `/register-alias` is off — either this network has no known
   * registry, or the artefacts could not be loaded, and the refusal says which.
   *
   * It is built BEFORE the wallet has synced, and deliberately so: it loads
   * artefacts and providers, and none of that needs a synced chain. The gate
   * that does need one is `readiness`, at the point of spending.
   */
  let sponsor: MidnamesSponsor | null = null;
  let sponsorUnavailableReason = `The ${config.networkId} network has no known .night registry. Set BALANCER_MIDNAMES_TLD_ADDRESS to sponsor names against a deployed one.`;
  if (config.midnamesTldAddress) {
    try {
      sponsor = await createMidnamesSponsor(config, wallet);
      console.log(
        `[alias] sponsoring .night registrations against ${sponsor.tldAddress} (artefacts ${sponsor.assetsPath}, proving ${sponsor.provingMode === 'server' ? config.provingServerUrl : 'in this process'})`,
      );
    } catch (cause) {
      sponsorUnavailableReason = cause instanceof Error ? cause.message : String(cause);
      console.warn(`[alias] sponsorship is DISABLED: ${sponsorUnavailableReason}`);
    }
  } else {
    console.warn(`[alias] sponsorship is DISABLED: ${sponsorUnavailableReason}`);
  }

  /**
   * The account funder, built once at start-up for the same reason as the alias
   * sponsor. `null` means `/fund-account` is off, and the refusal says why.
   */
  let accountFunder: AccountFunder | null = null;
  let accountFunderUnavailableReason =
    'The compiled account-custody build could not be loaded, so activation grants cannot be deposited.';
  try {
    accountFunder = await createAccountFunder(config, wallet);
    console.log(
      `[account] funding accounts with ${formatNight(accountFunder.grantAtomic)} NIGHT from ${accountFunder.assetsPath} (proving ${accountFunder.provingMode === 'server' ? config.provingServerUrl : 'in this process'})`,
    );
    if (accountFunder.assetAvailable) {
      console.log(
        `[asset] each account also opens holding ${accountFunder.assetGrant} ${accountFunder.assetSymbol}, minted from faucet ${accountFunder.assetFaucetAddress} (artefacts ${accountFunder.assetAssetsPath})`,
      );
      console.log(`[asset] colour ${accountFunder.assetColourHex}`);
    } else {
      console.warn(`[asset] the asset leg is DISABLED: ${accountFunder.assetUnavailableReason}`);
    }
  } catch (cause) {
    accountFunderUnavailableReason = cause instanceof Error ? cause.message : String(cause);
    console.warn(`[account] funding is DISABLED: ${accountFunderUnavailableReason}`);
  }

  /**
   * Can the balancer pay for this, right now?
   *
   * Three ways it cannot, and they are genuinely different answers: the wallet
   * has not finished walking the chain (say so and let the caller come back);
   * it holds less NIGHT than the thing costs; it holds no DUST, so it cannot
   * pay a fee at all. `funder-empty` and `funder-no-dust` keep the funder's own
   * codes so a client can branch on one vocabulary across both services;
   * `wallet-syncing` is new here because the funder blocks its HTTP server
   * until it is synced and this one deliberately does not.
   */
  const readiness = async (
    options: { settle?: boolean; requireNight?: bigint } = {},
  ): Promise<{ ready: boolean; night: bigint; refuse: Refusal | null }> => {
    const required = options.requireNight ?? 0n;
    const deadline = Date.now() + (options.settle ? CHANGE_SETTLE_MS : 0);
    for (;;) {
      let isSynced = false;
      let heldNight = 0n;
      let heldDust = 0n;
      try {
        const state = await wallet.currentState();
        /* Effectively synced — see `isEffectivelySynced`: the strict flag is
           false for the two to three minutes after every spend of this
           wallet's own, which is when the next activation arrives. */
        isSynced = isEffectivelySynced(await wallet.progress(state));
        heldNight = await wallet.nightBalance(state);
        heldDust = await wallet.dustBalance(state);
      } catch {
        // Reported through the refusals below rather than thrown at a caller.
      }
      if (isSynced && heldNight >= required && heldDust > 0n) {
        return { ready: true, night: heldNight, refuse: null };
      }
      if (Date.now() >= deadline) {
        if (!isSynced) {
          return {
            ready: false,
            night: heldNight,
            refuse: refusal(
              503,
              'wallet-syncing',
              'The balancer wallet is still syncing and cannot spend yet. Try again shortly.',
            ),
          };
        }
        if (heldNight < required) {
          return {
            ready: false,
            night: heldNight,
            refuse: refusal(
              503,
              'funder-empty',
              `The balancer holds ${formatNight(heldNight)} NIGHT, less than the ${formatNight(required)} NIGHT this needs. Its address (${wallet.address}) needs topping up from the ${config.networkId} faucet.`,
            ),
          };
        }
        return {
          ready: false,
          night: heldNight,
          refuse: refusal(
            503,
            'funder-no-dust',
            'The balancer cannot pay a transaction fee yet: its DUST is still accruing. Try again in a minute.',
          ),
        };
      }
      await new Promise((settle) => setTimeout(settle, SETTLE_POLL_MS));
    }
  };

  /**
   * How long a refused caller is told to wait after the whole window is gone.
   *
   * Fifteen seconds rather than the three `/wallet-status` publishes: three is
   * the figure for a settle that is already most of the way through, and a
   * caller that has just watched this service wait four minutes should not be
   * sent straight back into another four.
   */
  const DUST_WAIT_RETRY_AFTER_MS = 15_000;

  /**
   * Runs one user-facing spend, WAITING for a fee-capable DUST coin rather than
   * refusing when none is free.
   *
   * THE FAILURE THIS EXISTS FOR, with a measurement against it. The sponsor
   * holds one DUST coin above the fee floor. During onboarding the user's OWN
   * account deploy books it for about 100 s, and the registration that follows
   * the click arrives inside that window — so `/register-alias` answered 502
   * about 60 s after the click, 5/5 times on 2026/09/02, and the user had to
   * press Claim again. The second press worked, in 52–58 s, because by then the
   * coin was back. Nothing was wrong except that this service would not wait
   * for its own coin.
   *
   * THE SHAPE OF THE ANSWER IS "SAY NOTHING UNTIL IT IS DONE", and that is read
   * off the client rather than chosen. `sponsoredAlias.ts` gives a registration
   * a 600-second ceiling and treats every non-2xx as a typed refusal; a 202
   * would count as `response.ok`, fail its body check, and come back as
   * `confirmation-failed` — the one code it will never retry. So the request
   * simply stays open: a 240-second wait plus a ~55-second registration is
   * comfortably inside its patience, and Node bounds the REQUEST rather than
   * the response, with Caddy proxying the answer whenever it comes.
   *
   * The wait is spent OUTSIDE the spend queue, holding no lane — see
   * `withDustWait` — so a caller waiting here blocks nobody. It does hold its
   * PRIORITY: `hold` keeps the next lane for a waiting registration, because
   * the first live run without it had the two activation grants take both
   * coins that came free while the registration watched, and the first click
   * reached Home in 173.3 s. Nobody is watching a screen for a grant.
   */
  const spendWaitingForDust = <T>(
    label: string,
    spend: () => Promise<T>,
    priority: number = SpendPriority.Normal,
  ): Promise<T> =>
    withDustWait(spend, {
      label,
      windowMs: config.dustWaitMs,
      holdWhileWaiting: () => wallet.hold(priority),
      /* Fee-CAPABLE coins, not any coin: the SDK selects per coin, so a wallet
         holding four small coins can be woken by every one of them and still
         not balance a contract call. */
      awaitFreeCoin: (maxMs) => wallet.awaitFreeDustCoin(maxMs, { minSpecks: FEE_CAPABLE_SPECKS }),
      retryAfterMs: DUST_WAIT_RETRY_AFTER_MS,
    });

  /* The wallet syncs in the background and the HTTP server starts NOW. A
     sponsor that is unreachable for the length of a chain walk looks, from
     `sponsorReadiness`, exactly like a sponsor that is down; a sponsor that
     answers `available: 0, syncState: "syncing"` tells the truth and tells it
     immediately. The same reasoning applies to the DUST registration below. */
  /* The proving key material is fetched now, in parallel with the chain walk,
     so that "can this service prove a fee leg at all?" is answered before
     anybody asks it to. In WASM mode it is roughly 33 MB over HTTPS; with
     BALANCER_PROVER_URL set it resolves immediately and the answer is the
     server's to give. */
  void (async () => {
    const readiness = await wallet.warmProvingKeys();
    if (readiness.state === 'ready') {
      console.log(
        `[prover] key material warm: ${(readiness.bytes / 1_048_576).toFixed(1)} MiB in ${(readiness.warmedInMs / 1_000).toFixed(1)} s — this service can prove a DUST fee leg with no proof server`,
      );
    } else if (readiness.state === 'server') {
      console.log(`[prover] proving through ${readiness.url}`);
    } else if (readiness.state === 'failed') {
      console.warn(
        `[prover] PROVING IS UNAVAILABLE: ${readiness.reason} — /balance-only will refuse with PROVER_UNAVAILABLE until this resolves. Set BALANCER_PROVER_URL to use a proof server instead.`,
      );
    }
  })();

  const syncStartedAt = Date.now();
  void (async () => {
    try {
      await wallet.waitForSync((progress) => {
        console.log(
          `[sync ${elapsed(syncStartedAt).padStart(9)}] shielded ${progress.shielded.applied}/${progress.shielded.highestRelevant}  unshielded ${progress.unshielded.applied}/${progress.unshielded.highestRelevant}  dust ${progress.dust.applied}/${progress.dust.highestRelevant}`,
        );
      });
      syncSeconds = (Date.now() - syncStartedAt) / 1_000;
      console.log(`[sync] synced in ${elapsed(syncStartedAt)}`);

      const night = await wallet.nightBalance();
      console.log(`[wallet] holds ${formatNight(night)} NIGHT (${night} atomic)`);

      /* Mint the activation's mUSD coin now, on a service nobody is waiting on,
         so the first activation's asset leg is a single deposit. It costs a
         DUST fee and no NIGHT, and it never throws — a spare that could not be
         minted only costs the next activation what it used to cost every one. */
      if (accountFunder?.assetAvailable) {
        console.log(
          `[asset] spare ${accountFunder.assetSymbol} coin: ${accountFunder.spareState()} — one will be minted ahead of the first activation, as soon as there is DUST to pay for it`,
        );
      }
      if (night === 0n) {
        console.warn(
          `BALANCER IS EMPTY — faucet ${wallet.address} on ${config.networkId}, then wait: the wallet keeps syncing and picks the funds up live, and the DUST registration below retries every minute.`,
        );
      }

      /* Fees are paid in DUST, and DUST only accrues against REGISTERED NIGHT.
         This loop never ends: it re-checks every minute rather than registering
         once and stopping.

         What it is NOT for, because it was measured on stagenet 2026/08/24 and
         the obvious worry turned out to be unfounded: spending a registered
         NIGHT UTxO does NOT strand the change. A 2 NIGHT operator transfer out
         of a registered 5,000 NIGHT UTxO emitted `DustSpendProcessed`,
         `DustGenerationDtimeUpdate`, and `DustInitialUtxo` in one transaction,
         and the 4,998 NIGHT change came back already generating — the wallet
         read `already-generating` on the next pass with a HIGHER DUST balance
         than before the spend. (Immediately after submitting, the wallet does
         briefly read `NIGHT 0, DUST 0`: that is the change still settling, not
         a lost registration, and it is why nothing here treats a single zero
         reading as a reason to act.)

         What it IS for: NIGHT that arrives later. A faucet top-up lands as a
         fresh, unregistered UTxO however long after start-up it happens, and a
         one-shot registration would never see it. It also covers a registration
         that could not run the first time — on ledger-9 a registration pays its
         own fee out of projected generation, so on a fresh wallet it has to
         wait minutes before it can be built at all.

         Only transitions are logged, so a steady state is silent. */
      let lastReported: RegistrationState | '' = '';
      for (;;) {
        /* Registration rotates NIGHT UTxOs; balancing reserves DUST. They do
           not touch the same coins, but both move wallet state, and a
           registration landing mid-spend is a needless risk for something that
           can simply wait a minute. `isBusy()` and not `isReserved()`
           deliberately: this is the one caller that should stand off for a whole
           job, proving included, because nothing depends on it running now. */
        if (!wallet.isBusy() && !wallet.isReserved()) {
          try {
            const outcome = await wallet.registerDustIfNeeded();
            registration = outcome;
            registrationDetail = null;
            if (outcome !== lastReported) {
              if (outcome === 'registered') {
                console.log('[dust] registration submitted — DUST accrues from here');
              } else if (outcome === 'already-generating') {
                console.log('[dust] every NIGHT UTxO is registered for DUST generation');
              } else if (outcome === 'no-night') {
                console.log('[dust] no NIGHT yet, so nothing to register — faucet the address');
              }
              console.log(`[dust] spendable now: ${await wallet.dustBalance()} Specks`);
              lastReported = outcome;
            }
          } catch (cause) {
            registration = 'failed';
            registrationDetail = cause instanceof Error ? cause.message : String(cause);
            lastReported = 'failed';
            /* Seen live on the very first funded submission: the node relay's
               WebSocket had dropped ("Normal Closure") while the wallet was
               syncing, and the submission raced its reconnect. The next pass a
               minute later went through. A one-shot registration would have
               made that transient permanent. */
            console.warn('[dust] registration failed; retrying in a minute:', cause);
          }
        }
        /* Housekeeping on the same minute tick and behind the same standoff:
           mint the next activation's mUSD coin while nobody is waiting on it,
           so the asset leg is one deposit rather than a mint plus the three
           minutes this wallet takes to see its own coin. It declines silently
           whenever there is already a spare, a mint in flight, or no DUST. */
        if (!wallet.isBusy() && !wallet.isReserved() && accountFunder?.assetAvailable) {
          /* A mint is a spend like any other: it nullifies this wallet's DUST
             for 20 to 60 seconds afterwards, and a `/balance-only` landing in
             that gap must read as settling rather than as an empty balancer.
             Recorded only when a mint was really attempted — marking a spend
             that never happened would make a genuinely empty wallet claim to be
             recovering, minute after minute. */
          if (
            await accountFunder.ensureSpareCoin({ queueIdle: () => spendAdmission.depth === 0 })
          ) {
            lastSpendAt = Date.now();
          }
        }

        await new Promise((resolve) => setTimeout(resolve, REGISTRATION_RETRY_MS));
      }
    } catch (cause) {
      console.error('[sync] the wallet stopped syncing', cause);
    }
  })();

  /* -------------------------------------------------------------------------- */
  /* Wire shapes                                                                */
  /* -------------------------------------------------------------------------- */

  /**
   * `GET /wallet-status`, in exactly the shape `parseSponsorWalletStatus` reads.
   *
   * One wallet, so `total` is always 1. `available` is 1 only when this wallet
   * can pay a fee this instant: synced, holding DUST, and not already holding
   * the spend queue. `ready` is the weaker upstream notion — merely synced —
   * kept because the client reports it, and deliberately NOT what the gate uses.
   *
   * `unavailableCause` is not read by `sponsor.ts`, which ignores unknown
   * fields; it is here because the upstream gateway carries it and an operator
   * reading a raw probe should not have to guess between "no DUST" and "still
   * syncing".
   */
  const walletStatus = async (): Promise<Record<string, unknown>> => {
    let ready = false;
    let dustBalance = 0n;
    let dustUtxoCount = 0;
    let dustSynced = false;
    let syncState = 'syncing';
    try {
      const state = await wallet.currentState();
      const progress = await wallet.progress(state);
      /* Not `progress.isSynced`, and the difference is the two to four and a
         half minutes after every one of this service's own spends. See
         `isEffectivelySynced` in `./wallet.ts`: a wallet that has applied its
         own submission ahead of the indexer's last progress announcement is
         scored unsynced by the SDK and is in fact better informed than a
         `complete` one. Gating `available` on the SDK's verdict is what refused
         a second Passport twenty seconds behind the first, 3/3, on
         2026/09/02. */
      ready = isEffectivelySynced(progress);
      dustSynced = isLegEffectivelySynced(progress.dust);
      /* Follows `ready`, and deliberately not a third string: `sponsor.ts`
         carries this value through to its logs and the deploy watchdog greps
         for `"syncState":"ready"`, so a wallet that can pay a fee must say the
         word both of them already know. */
      syncState = ready ? 'ready' : 'syncing';
      dustBalance = await wallet.dustBalance(state);
      dustUtxoCount = await wallet.dustUtxoCount(state);
    } catch {
      /* A wallet that cannot even answer its own state is not available, and
         saying so is the whole job of this endpoint. */
      syncState = 'unavailable';
    }

    /* `isReserved()` and NOT `isBusy()`: a grant that is proving holds no claim
       on this wallet's coins, and reporting it as pending is what took fee
       sponsorship down for the two minutes an mUSD leg proves. See
       `./reservation.ts` and `./availability.ts`. */
    const { available, unavailableCause, settling, retryAfterMs } = walletAvailability({
      synced: ready,
      dustSpecks: dustBalance,
      reserved: wallet.isReserved(),
      proving: wallet.provingReadiness().state,
      /* Is the shortfall explainable? A spend of this service's own still
         settling, or a transaction it balanced still outstanding. It never
         raises `available` — it tells a client the wait is short enough to hold
         for rather than a reason to go and find another sponsor. */
      settling: wallet.isSettling(),
    });

    return {
      total: 1,
      available,
      wallets: [
        {
          index: 0,
          ready,
          syncState,
          address: wallet.address,
          dust: {
            // A string, because that is what the client's parser expects; a
            // number could not carry a Speck balance faithfully anyway.
            balance: dustBalance.toString(),
            utxoCount: dustUtxoCount,
            isSynced: dustSynced,
          },
          ...(unavailableCause ? { unavailableCause } : {}),
        },
      ],
      ...(settling ? { settling: true } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  };

  /** `GET /status` — the funder's human answer, for an operator and a monitor. */
  const status = async (): Promise<Record<string, unknown>> => {
    let night = 0n;
    let dust = 0n;
    let pendingTransactions = 0;
    let progress: Awaited<ReturnType<BalancerWallet['progress']>> | null = null;
    try {
      const state = await wallet.currentState();
      progress = await wallet.progress(state);
      night = await wallet.nightBalance(state);
      dust = await wallet.dustBalance(state);
      pendingTransactions = await wallet.pendingTransactionCount(state);
    } catch {
      // Reported as `synced: false` below rather than as an HTTP failure.
    }
    /* Same meaning as `available` on `/wallet-status`: able to pay for
       somebody right now, not merely alive. Computed before the object so
       `settling` can say why it is false. */
    const ready =
      (progress !== null && isEffectivelySynced(progress)) &&
      dust > 0n &&
      !wallet.isReserved() &&
      ['ready', 'server'].includes(wallet.provingReadiness().state);
    return {
      network: config.networkId,
      address: wallet.address,
      balanceAtomic: night.toString(),
      balanceNight: formatNight(night),
      dustSpecks: dust.toString(),
      synced: progress?.isSynced ?? false,
      syncSeconds,
      progress,
      proving: wallet.provingMode,
      provingReadiness: wallet.provingReadiness(),
      provingServerUrl: config.provingServerUrl ?? null,
      dustRegistration: registration,
      dustRegistrationDetail: registrationDetail,
      balancesServed,
      lastBalanceAt,
      /* Transactions this service balanced and handed away that the chain has
         not been seen carrying, and how many it has taken the DUST back for
         since it started. A non-zero `balancesOrphaned` is not a fault: it is
         this service refusing to hold its own DUST hostage to somebody else's
         failed submit. */
      balancesWatched: wallet.orphanStats().watching,
      balancesOrphaned: wallet.orphanStats().released,
      /* `balancing` is the CLAIM on this wallet's coins — seconds. `busy` is a
         whole spend job, proving included — minutes, for an mUSD grant. They are
         reported separately because only the first says anything about whether
         this service can pay somebody's fee right now. */
      balancing: wallet.isReserved(),
      busy: wallet.isBusy(),
      /* This wallet's OWN submissions in flight, which is the fact that
         separates a legitimately DUST-less wallet from a wedged one. Read
         together with `dustSpecks` and `balanceAtomic`: NIGHT held, no DUST,
         nothing pending, and nothing watched is the wedge signature the
         external watchdog matches on. */
      pendingTransactions,
      /* True while this process is refusing sponsorship with
         `PENDING_TRANSACTION` because a revert failed to give it its DUST back
         and a repair-and-restart is on its way. */
      dustRepairPending,
      /* How many spend jobs may run at once, and how many are running. Bounded
         by free DUST coins as well as by configuration — a lane with no coin to
         spend is not a lane. */
      lanes: wallet.spendLanes(),
      lanesConfigured: config.spendLanes,
      jobsRunning: wallet.jobCount(),
      /* One entry per running job: what it is, the last step it reported, and
         how long ago. `sinceProgressMs` next to `proofInFlight` is the pair the
         droplet watchdog matches a wedge on — a job that has reported nothing
         for minutes while the prover is idle is stuck, not slow. */
      jobs: wallet.runningJobs(),
      proofInFlight: proofsInFlight() > 0,
      /* The health of the event loop itself, which is the number that would
         have made the eight-minute freeze of 2026/09/03 visible while it was
         happening rather than afterwards in a proxy's access log. A `/status`
         that answers at all proves the loop is running; `loopWorstLagMs` says
         how close it has come to not. */
      loopLagMs: Math.round(liveness.health().lagMs),
      loopWorstLagMs: Math.round(liveness.health().worstLagMs),
      loopWatched: liveness.health().watching,
      /* The heap, because the freeze of 2026/09/03 was a garbage collector
         marking continuously rather than a call waiting on anything. This is
         the number that says how close the next one is. */
      heapUsedBytes: liveness.health().heapUsedBytes,
      rssBytes: liveness.health().rssBytes,
      /* Since this process started, and — for each `…Total` — the persisted
         once-only ledger, which survives restarts. None of these is key
         material and none of them names a user. */
      aliasesSponsored,
      aliasesSponsoredTotal: aliasLedger.count,
      aliasSponsorship: sponsor ? 'available' : 'unavailable',
      aliasTldAddress: sponsor?.tldAddress ?? null,
      aliasSlotsRemainingThisHour: aliasLimiter.remaining(),
      accountsFunded,
      accountsFundedTotal: accountLedger.count,
      accountFunding: accountFunder ? 'available' : 'unavailable',
      accountGrantAtomic: config.accountGrantAtomic.toString(),
      accountSlotsRemainingThisHour: accountLimiter.remaining(),
      /* The ASSET half of an activation, counted separately from the NIGHT half
         because it can succeed or fail separately. `assetColourHex` is the
         colour a client should look for in the account's own `coins` map —
         `rawTokenType(domain separator, faucet address)`, bound to the faucet
         rather than asserted by this service. */
      assetSymbol: accountFunder?.assetSymbol ?? ASSET_SYMBOL,
      assetColourHex: accountFunder?.assetColourHex ?? null,
      assetGrant: config.assetGrant.toString(),
      assetFaucetAddress: accountFunder?.assetFaucetAddress ?? null,
      assetsFunded,
      assetsFundedTotal: accountLedger.countWhere((entry) => entry.asset !== undefined),
      assetFunding: accountFunder?.assetAvailable ? 'available' : 'unavailable',
      /* Whether a grant-sized mUSD coin is minted and waiting. `ready` is the
         difference between an activation's asset leg being one deposit and it
         being a mint plus the three minutes this wallet takes to see its own
         coin. */
      assetSpare: accountFunder?.spareState() ?? 'unsupported',
      assetUnavailableReason: accountFunder?.assetAvailable
        ? null
        : (accountFunder?.assetUnavailableReason ?? accountFunderUnavailableReason),
      /* How CONTRACT circuits are proved, which is a different question from
         `proving` above: that one is the wallet's own DUST and Zswap legs. */
      contractProving: sponsor?.provingMode ?? accountFunder?.provingMode ?? null,
      /* What the abuse guards have turned away, and how they are configured.
         Nothing here names a caller: an address is what the buckets are keyed
         on and it stays inside the process. `clientKeyRequired` is a boolean
         and never the key. */
      limits: {
        refusedRateLimited,
        refusedQueueFull,
        refusedUnauthorised,
        balancePerMinute: config.balanceRate.perMinute,
        balanceBurst: config.balanceRate.burst,
        aliasPerMinute: config.aliasRate.perMinute,
        aliasBurst: config.aliasRate.burst,
        accountPerMinute: config.accountRate.perMinute,
        accountBurst: config.accountRate.burst,
        spendQueueDepth: spendAdmission.depth,
        spendQueueMax: config.spendQueueMax,
        clientsTracked: balanceBucket.size + aliasBucket.size + accountBucket.size,
        clientKeyRequired: config.clientKey !== undefined,
      },
      /* Not ready, but only because a spend's change is still in flight — the
         funder's distinction, and it matters: change settling and a wallet
         that is genuinely out of NIGHT read identically on the chain. */
      settling: !ready && Date.now() - lastSpendAt < CHANGE_SETTLE_MS,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1_000),
      /* The watchdog's own account of itself: what it last decided, why, how
         long the current unhealthy streak is, what it last did about it, and
         how many restarts it has ever asked for. Published here so the thing
         can be watched working — and, more to the point, watched NOT firing —
         without an SSH session. `null` only when it is switched off. */
      health: healthMonitor ? healthMonitor.snapshot() : null,
      /* The shelf of pre-deployed resolver leaves: how many are on it, what it
         is aiming at, and — when it is not filling — the one reason it is not.
         `paused` is the normal reading on a sponsor with two DUST coins, and
         the reason says so: the filler spends the second coin and never the
         last. See `./resolverPool.ts`. */
      resolverPool: resolverPool ? resolverPool.snapshot() : null,
      ready,
    };
  };

  /* -------------------------------------------------------------------------- */
  /* The health watchdog                                                        */
  /* -------------------------------------------------------------------------- */

  /**
   * One tick's worth of facts, gathered the same way `walletStatus()` gathers
   * them and refusing to throw for the same reason: a wallet that cannot answer
   * its own state is a FACT about the wallet, not an error in the reading of
   * it, and turning it into an exception would hide the one failure the
   * watchdog exists to catch.
   */
  const healthProbe = async (): Promise<HealthProbeReading> => {
    let stateReadable = false;
    let synced = false;
    let connected = false;
    let dustSpecks = 0n;
    let utxoCount = 0;
    let nightAtomic = 0n;
    let pendingTransactions = 0;
    let syncAhead: string | null = null;
    let fingerprint = 'unreadable';
    try {
      const state = await wallet.currentState();
      const walked = await wallet.progress(state);
      stateReadable = true;
      /* The readiness question, not the SDK's strict one — see
         `isEffectivelySynced`. Without this the watchdog read every post-spend
         minute as `degraded: not synced` and reached for a restart. */
      synced = isEffectivelySynced(walked);
      syncAhead = syncAheadDetail(walked);
      connected = walked.shielded.connected && walked.unshielded.connected && walked.dust.connected;
      dustSpecks = await wallet.dustBalance(state);
      utxoCount = await wallet.dustUtxoCount(state);
      /* The two facts that separate a wedge from an empty wallet and from a
         wallet mid-spend. NIGHT because DUST comes from NIGHT and nothing else,
         so no DUST with thousands of NIGHT is a bookkeeping fault rather than a
         funding one; pending because a coin booked against this wallet's own
         submission is nullified for a perfectly good reason. */
      nightAtomic = await wallet.nightBalance(state);
      pendingTransactions = await wallet.pendingTransactionCount(state);
      /* Deliberately the sync INDICES and not the DUST balance. The balance is
         computed against the current time — `state.dust.balance(new Date())` —
         so it moves every tick even on a wallet that has stopped following the
         chain, which would make it useless as a staleness signal and actively
         misleading as a healthy one. */
      fingerprint = [
        synced,
        connected,
        walked.shielded.applied,
        walked.unshielded.applied,
        walked.dust.applied,
        utxoCount,
      ].join('|');
    } catch {
      // Reported as `stateReadable: false`, which is what `wedged` reads.
    }
    const lastSponsorship = Math.max(lastSpendAt, lastBalanceMs);
    return {
      uptimeMs: Date.now() - startedAt,
      stateReadable,
      synced,
      connected,
      dustSpecks,
      utxoCount,
      nightAtomic,
      /* The minute loop's own verdict on this wallet's NIGHT. `registered` is
         included as well as `already-generating`: a registration that has been
         submitted is generating from the moment it lands, and the loop only
         moves off `registered` on its next pass. */
      dustGenerating: registration === 'already-generating' || registration === 'registered',
      pendingTransactions,
      /* The real reason a post-spend wallet looks unsettled, so the verdict can
         name it instead of guessing at a prover. `null` when nothing is ahead. */
      syncAhead,
      proving: wallet.provingReadiness().state,
      reserved: wallet.isReserved(),
      busy: wallet.isBusy(),
      lastSponsorshipAt: lastSponsorship > 0 ? lastSponsorship : null,
      orphans: wallet.orphanStats().watching,
      fingerprint,
    };
  };

  if (config.healthIntervalMs > 0) {
    healthMonitor = startHealthLoop({
      intervalMs: config.healthIntervalMs,
      probe: healthProbe,
      /* The floor under a wedge verdict is the sweeper's own window, so the two
         can never disagree about when a booked coin has stopped being
         explainable. */
      policy: { ...DEFAULT_HEALTH_POLICY, orphanMs: config.balanceOrphanMs },
      store: {
        read: () => healthLedger.get('restart') ?? EMPTY_HEALTH_RECORD,
        write: (record) => healthLedger.record('restart', record),
      },
      remedies: {
        /* Rung one. A fresh read off the facade's state observable, which
           carries its own 30-second timeout, so a wallet that has stopped
           answering makes this reject rather than hang. */
        refresh: async () => {
          const state = await wallet.currentState();
          await wallet.progress(state);
        },
        /* Rung two, and the one that actually repairs something in place:
           `warmProvingKeys()` re-attempts the key-material fetch whenever
           readiness is `warming` or `failed`, which is the difference between a
           service that refuses every `/balance-only` with PROVER_UNAVAILABLE
           until an operator notices and one that fixes itself. The checkpoint
           that follows is insurance for rung three — a restart that resumes
           from a recent snapshot is a second, not a chain walk. */
        rewarm: async () => {
          const readiness = await wallet.warmProvingKeys();
          console.log(`[health] proving readiness after re-warming: ${readiness.state}`);
          await wallet.saveSnapshot();
        },
        /* The wedge's own rung, and it is not on the ladder above: refresh
           re-reads the same withheld coins, rewarm touches the prover, and a
           restart resumes from the snapshot that CARRIES the fault. The repair
           has to be to the stored state, before the process comes back. */
        resyncDust: async (reason: string) => {
          console.warn(`[dust] repairing the stored DUST state before restarting — ${reason}`);
          /* Checkpoint first, so the file being repaired is this wallet's
             current position rather than whatever the last minute tick left. */
          try {
            await wallet.saveSnapshot();
          } catch (cause) {
            console.warn('[dust] the snapshot could not be checkpointed first', cause);
          }
          const path = join(config.stateDir, `sync-snapshot-${config.networkId}.json`);
          try {
            const raw = await readFile(path, 'utf8');
            const repaired = rollbackDustSnapshot(raw, Date.now());
            /* Kept, not overwritten: a repair made on the wrong diagnosis
               leaves the exact bytes it was made from. */
            await copyFile(path, `${path}.pre-rollback-${Date.now()}`);
            const temp = `${path}.rollback.tmp`;
            await writeFile(temp, repaired.snapshot, 'utf8');
            await rename(temp, path);
            console.warn(
              `[dust] the snapshot now carries ${repaired.utxosAfter} spendable DUST UTxO(s) (${repaired.balanceAfter} Specks) where it carried ${repaired.utxosBefore} — restarting into it`,
            );
          } catch (cause) {
            /* Every failure lands here, `NothingToRepair` included: the live
               state said wedged, so a stored state that reads clean is a
               snapshot too old to be the one at fault. The narrower fallback is
               a DUST-only cold walk — 89.5 s measured — which is cheaper than
               throwing the shielded and unshielded positions away too. */
            console.warn(
              `[dust] the snapshot could not be repaired (${cause instanceof Error ? cause.message : String(cause)}) — asking the next start to walk the DUST from chain instead`,
            );
            try {
              await markDustColdStart(config);
            } catch (marker) {
              console.error('[dust] the cold-start marker could not be written either', marker);
            }
          }
          process.exit(1);
        },
        /* Rung three. Everything that could be saved has been; leaving with a
           non-zero status is how this process asks systemd (`Restart=always`,
           `RestartSec=5`) to give it a new wallet, because the SDK will not
           give it one in place — `WalletFacade.stop()` closes the submission
           service's scope and `start()` does not reopen it, so a facade
           restarted inside this process would sync and never submit. */
        restart: async (reason: string) => {
          console.warn(`[health] saving the sync snapshot before restarting — ${reason}`);
          try {
            await wallet.saveSnapshot();
          } catch (cause) {
            console.warn('[health] the snapshot could not be saved; restarting anyway', cause);
          }
          process.exit(1);
        },
      },
    });
    console.log(
      `[health] watchdog on: every ${Math.round(config.healthIntervalMs / 1_000)} s (slightly jittered), and it stands off entirely while the wallet is claimed or busy`,
    );
  } else {
    console.warn('[health] watchdog OFF — BALANCER_HEALTH_INTERVAL_MS is 0');
  }

  /* -------------------------------------------------------------------------- */
  /* The resolver-leaf pool                                                     */
  /* -------------------------------------------------------------------------- */

  /**
   * How many DUST coins could pay for a contract deploy RIGHT NOW.
   *
   * Coins and not the balance, because the SDK selects per coin: 3e16 Specks
   * spread over four small coins pays for no deploy at all. `generatedNow` is
   * the SDK's own per-coin figure — DUST accrues against its backing NIGHT, so
   * a coin's value is a function of time and not a stored number.
   *
   * Zero on any failure, which pauses the filler. A coin count that cannot be
   * read is not a coin.
   */
  const feeCapableDustCoins = async (): Promise<number> => {
    try {
      const state = await wallet.currentState();
      return state.dust.availableCoins.filter((coin) => coin.generatedNow >= FEE_CAPABLE_SPECKS)
        .length;
    } catch {
      return 0;
    }
  };

  if (sponsor && config.resolverPoolTarget > 0) {
    const leafSponsor = sponsor;
    resolverPool = startResolverPool({
      ledger: resolverLedgerFrom(resolverLedger),
      target: config.resolverPoolTarget,
      floor: config.resolverPoolFloor,
      facts: async () => ({
        /* Asked, not remembered. `snapshot()` is the last tick's word and the
           loop's interval is minutes, so a `busy` left over from a spend that
           finished long ago used to pause the filler for the whole gap. */
        verdict: (await healthMonitor?.assessNow())?.verdict ?? null,
        /* Booked OR queued OR claimed. See the field's own note in
           `./resolverPool.ts`: a leaf deploy must never join a queue somebody
           is waiting in. */
        reservationBooked:
          wallet.isBusy() || wallet.isReserved() || spendAdmission.depth > 0 || dustRepairPending,
        feeCapableCoins: await feeCapableDustCoins(),
        /* The filler takes a lane like any other spend, so it must leave one.
           See `MIN_FREE_LANES`. */
        freeLanes: wallet.spendLanes() - wallet.jobCount(),
        proofInFlight: proofsInFlight() > 0,
        lastRequestAt,
      }),
      /* Through the spend queue like every other spend, at Normal priority —
         the gate is what keeps it out of a user's way, not a priority, and a
         deploy that skipped the queue would contend for coins with the very
         registration it exists to make faster. */
      deploy: () =>
        wallet.exclusive(() => leafSponsor.deployPoolLeaf(), {
          label: 'a resolver leaf for the shelf',
        }),
    });
    console.log(
      `[pool] holding ${resolverLedger.countWhere((entry) => entry.consumedAt === undefined)} pre-deployed resolver leaves, target ${config.resolverPoolTarget}, floor ${config.resolverPoolFloor} — the filler deploys one at a time, at most one a minute, and only when nothing else wants this wallet`,
    );
  } else if (config.resolverPoolTarget > 0) {
    console.warn('[pool] OFF — there is no .night sponsor to deploy resolver leaves through');
  } else {
    console.warn('[pool] OFF — RESOLVER_POOL_TARGET is 0, so every name deploys its own leaf');
  }

  /* -------------------------------------------------------------------------- */
  /* POST /fund-account                                                         */
  /* -------------------------------------------------------------------------- */

  interface FundAccountRequestBody {
    contractAddress?: unknown;
    /** Optional; when present it must name THIS service's network. */
    network?: unknown;
  }

  /**
   * Deposits one activation grant into a user's account-custody contract.
   *
   * Nothing is spent until every gate below has passed, and nothing is reported
   * as funded until the account's own mirrored balance has been read back and
   * seen carrying the credit.
   */
  const fundAccount = async (
    body: FundAccountRequestBody,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const fail = (why: Refusal) => {
      /* Every refusal is logged: a 503 that leaves no trace made tonight's
         `wallet-syncing` invisible until the client's console showed it. */
      console.warn(`[account] refused: ${why.error} — ${why.message}`);
      return {
        status: why.status,
        body: { error: why.error, message: why.message, ...(why.extra ?? {}) },
      };
    };

    /* Logged on ARRIVAL, not only on the way out. Until 2026/09/02 an
       activation that went silent left no journal line saying it had ever been
       asked for, so reading the journal after a wedge could not tell a request
       that hung from one that never came. */
    console.log(
      `[account] asked to fund ${typeof body.contractAddress === 'string' ? body.contractAddress : '(no address)'}`,
    );

    /* Captured, not re-read: `accountFunder` is a `let`, and TypeScript's
       narrowing does not survive into the closures below. */
    const funder = accountFunder;
    if (!funder) {
      return fail(refusal(503, 'funding-unsupported', accountFunderUnavailableReason));
    }

    /* 1. Shape. The address is validated before anything touches the chain. */
    if (typeof body.contractAddress !== 'string') {
      return fail(
        refusal(
          400,
          'invalid-contract-address',
          'POST a JSON body of the form {"contractAddress": "64 hex"}.',
        ),
      );
    }
    let contractAddress: string;
    try {
      contractAddress = rawContractAddress(body.contractAddress);
    } catch (cause) {
      return fail(
        refusal(
          400,
          'invalid-contract-address',
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }

    if (body.network !== undefined && body.network !== config.networkId) {
      return fail(
        refusal(
          400,
          'wrong-network',
          `That request names the ${String(body.network)} network; this balancer funds accounts on ${config.networkId}.`,
        ),
      );
    }

    /* 2. In flight. Claimed BEFORE any ledger or chain read, because those
          reads cannot see a deposit that is still in the air. A second request
          for the same account is refused outright rather than queued: the
          honest answer is "one is already running", not a second grant. */
    if (accountInFlight.has(contractAddress)) {
      return fail(
        refusal(
          409,
          'funding-in-flight',
          'A funding for this Passport is already in progress. Wait for it to finish before asking again.',
        ),
      );
    }
    accountInFlight.add(contractAddress);
    try {
      /* 3. It has to BE an account. One indexer read that must both find state
            and decode it as an account-custody contract. This is the gate that
            keeps the balancer from paying coins into a stranger's contract: a
            contract that is not an ACC has no `deposit_night`, and the grant
            would be spent into something the user cannot reach. BOTH balances
            come out of that one decode, so the two legs cannot end up
            disagreeing about what they are looking at. */
      let held: { night: bigint; asset: bigint };
      try {
        held = await funder.balances(contractAddress);
      } catch (cause) {
        if (cause instanceof AccountFundingError) {
          return fail(
            refusal(
              cause.code === 'indexer-unreachable' ? 503 : 400,
              cause.code,
              cause.message,
              cause.detail ? { detail: cause.detail } : undefined,
            ),
          );
        }
        return fail(
          refusal(
            503,
            'indexer-unreachable',
            `The contract at ${contractAddress} could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        );
      }

      /* 4 and 5, now asked PER LEG. An activation is two credits — NIGHT into
            `night_balances`, mUSD into `coins` — and the second can fail after
            the first has landed on chain. So neither the persisted ledger nor
            the balance check is allowed to speak for both: each leg is needed
            when this service has no record of having paid it AND the account
            does not already hold it, whoever put it there.

            That is what makes a retry after a half-success do exactly the
            missing half, and it is also what stops a second full request from
            paying twice. An entry written before the asset leg existed carries
            NIGHT and no `asset`, which reads correctly as "NIGHT done, mUSD
            outstanding" with no migration. */
      const previous = accountLedger.get(contractAddress);
      const assetSupported = funder.assetAvailable;
      if (grantRetries.has(contractAddress)) {
        return fail(
          refusal(
            429,
            'grant-retrying',
            `The activation grant for this Passport failed a moment ago and this service is about to try it again itself. Ask again shortly.`,
            { retryAfterMs: GRANT_RETRY_DELAY_MS },
          ),
        );
      }
      /* Per leg, and by THAT leg's own record — see `./activationLegs.ts`. */
      const { nightNeeded, assetNeeded } = activationLegs({
        previous,
        heldNight: held.night,
        heldAsset: held.asset,
        assetSupported,
        grantAtomic: funder.grantAtomic,
        assetGrant: funder.assetGrant,
      });

      if (!nightNeeded && !assetNeeded) {
        if (previous) {
          return fail(
            refusal(
              409,
              'already-activated',
              `This Passport was already funded on ${previous.at}${previous.txHash ? ` (tx ${previous.txHash})` : ''}. The activation grant is once per account.`,
              {
                txHash: previous.txHash ?? null,
                nightTx: previous.txHash ?? null,
                assetTx: previous.asset?.depositTx ?? null,
              },
            ),
          );
        }
        return fail(
          refusal(
            409,
            'already-funded',
            `That account already holds ${formatNight(held.night)} NIGHT${assetSupported ? ` and ${held.asset} ${funder.assetSymbol}` : ''} — at least one activation grant's worth — so it does not need funding.`,
          ),
        );
      }

      /* 6. The hourly ceiling, looked at without consuming a slot. */
      if (accountLimiter.atCeiling()) {
        return fail(
          refusal(
            429,
            'rate-limited',
            `The balancer has reached its ceiling of ${config.accountMaxPerHour} funded accounts per hour. Try again later.`,
          ),
        );
      }

      /* 7. Can the balancer actually pay? The grant plus a fee, waiting out any
            change still in flight rather than turning the user away during a
            settle window. The asset leg needs no NIGHT of its own — the faucet
            mints the coin — so a request that is only topping up the mUSD asks
            for nothing but a synced wallet and some DUST. */
      const ready = await readiness({
        settle: true,
        requireNight: nightNeeded ? funder.grantAtomic : 0n,
      });
      if (ready.refuse) return fail(ready.refuse);

      /* The slot is consumed here and nowhere earlier: every refusal above
         spent nothing, and an hourly ceiling exists to cap what the balancer
         SPENDS. */
      if (!accountLimiter.take()) {
        return fail(
          refusal(
            429,
            'rate-limited',
            `The balancer has reached its ceiling of ${config.accountMaxPerHour} funded accounts per hour. Try again later.`,
          ),
        );
      }

      /* ---------------------------------------------------------------- */
      /* The two legs, run TOGETHER                                        */
      /* ---------------------------------------------------------------- */

      /**
       * Merges one leg's record into whatever the other has already written.
       *
       * The legs now run concurrently, so neither may write the ledger from a
       * value it captured before the other started: an asset leg holding a
       * `nightEntry` read at request time would erase a NIGHT credit written
       * while it was proving, and vice versa. Each write therefore re-reads the
       * entry at the moment it writes. The ledger is a file behind one
       * single-threaded process, so read-modify-write here is atomic in the
       * only sense that matters.
       */
      const recordLeg = async (patch: Partial<AccountEntry>): Promise<void> => {
        const current = accountLedger.get(contractAddress) ?? previous;
        await accountLedger.record(contractAddress, {
          ...(current ?? { at: new Date().toISOString() }),
          ...patch,
        } as AccountEntry);
      };

      /* Carried forward so the asset leg's ledger write keeps whatever the
         NIGHT leg recorded, whether that happened just now or in an earlier
         request that ended with the asset leg outstanding. */
      let nightEntry: AccountEntry | null = previous;
      let nightTxHash: string | null = previous?.txHash ?? null;

      /**
       * The sponsor's own second attempt at a failed grant. One, delayed,
       * detached from this request — the response still reports the failure,
       * and a client that posts again meanwhile is told to wait. The ledger
       * is checked again before spending: a client retry that got there first
       * makes this a no-op, not a second credit.
       */
      const retryGrantLater = (why: string): void => {
        if (grantRetries.has(contractAddress)) return;
        grantRetries.add(contractAddress);
        console.warn(
          `[account] ${contractAddress}: the grant failed (${why}) — this service will try it once more itself in ${Math.round(GRANT_RETRY_DELAY_MS / 1_000)} s rather than wait for the client`,
        );
        const timer = setTimeout(() => {
          void (async () => {
            try {
              if (accountLedger.get(contractAddress)?.txHash) {
                console.log(`[account] ${contractAddress}: the grant landed before the retry — nothing to do`);
                return;
              }
              const label = `the activation grant for ${contractAddress} (retry)`;
              const result = await spendWaitingForDust(label, () =>
                wallet.exclusive(() => funder.fund(contractAddress), { label }),
              );
              accountsFunded += 1;
              lastSpendAt = Date.now();
              await recordLeg({
                txHash: result.txHash,
                amountAtomic: result.amountAtomic.toString(),
                balanceAfterAtomic: result.balanceAfterAtomic.toString(),
                at: result.fundedAt,
              });
              console.log(
                `[account] retry: ${formatNight(result.amountAtomic)} NIGHT → ${contractAddress} (tx ${result.txHash}${result.block ? `, block ${result.block}` : ''})`,
              );
            } catch (cause) {
              console.error(
                `[account] retry FAILED for ${contractAddress}: ${cause instanceof Error ? cause.message : String(cause)} — the next /fund-account runs the NIGHT leg again`,
              );
            } finally {
              grantRetries.delete(contractAddress);
            }
          })();
        }, GRANT_RETRY_DELAY_MS);
        timer.unref();
      };
      let nightBlock: number | null = null;
      let nightAmount = previous?.amountAtomic ?? '0';
      let nightBalanceAfter = previous?.balanceAfterAtomic ?? held.night.toString();
      let fundedAt = previous?.at ?? new Date().toISOString();

      /**
       * The NIGHT leg. Resolves to a refusal when it fails, rather than
       * throwing, so the asset leg running beside it is always awaited.
       */
      const nightLeg = async (): Promise<{ status: number; body: Record<string, unknown> } | null> => {
      if (nightNeeded) {
        try {
          /* One job on the spend queue, which since 2026/09/02 means one LANE
             rather than the whole queue: this leg and the asset leg beside it
             each take a lane when a DUST coin is free for it, and neither waits
             on the other. They contend for nothing — the grant is unshielded
             NIGHT out of this wallet, the asset leg is a shielded coin the
             faucet mints — and running them in series is most of the five
             minutes an activation used to take to show its assets. */
          const result = await spendWaitingForDust(
            `the activation grant for ${contractAddress}`,
            () =>
              wallet.exclusive(() => funder.fund(contractAddress), {
                label: `the activation grant for ${contractAddress}`,
              }),
          );
          accountsFunded += 1;
          lastSpendAt = Date.now();
          nightTxHash = result.txHash;
          nightBlock = result.block;
          nightAmount = result.amountAtomic.toString();
          nightBalanceAfter = result.balanceAfterAtomic.toString();
          fundedAt = result.fundedAt;
          nightEntry = {
            txHash: result.txHash,
            amountAtomic: nightAmount,
            balanceAfterAtomic: nightBalanceAfter,
            at: result.fundedAt,
          };
          /* Written the moment the credit is confirmed, and not held back until
             the asset leg finishes: the NIGHT is on chain, and a crash between
             the two legs must not be able to lose that fact and pay it twice. */
          await recordLeg(nightEntry);
          console.log(
            `[account] ${formatNight(result.amountAtomic)} NIGHT → ${contractAddress} (tx ${result.txHash}${result.block ? `, block ${result.block}` : ''}, holds ${result.balanceAfterAtomic} atomic)`,
          );
        } catch (cause) {
          /* Same as the registration: a window that ran out with no coin free
             is a DUST shortfall, not a failed deposit, and nothing was spent. */
          if (cause instanceof DustWaitExhausted) {
            console.warn(`[account] ${contractAddress}: ${cause.message} — nothing was credited`);
            return fail(
              refusal(
                503,
                'funder-no-dust',
                'The balancer could not free a coin to pay this grant’s fee in time. Nothing was credited; try again shortly.',
                { retryAfterMs: cause.retryAfterMs },
              ),
            );
          }
          if (cause instanceof AccountFundingError) {
            console.error(
              `[account] FAILED for ${contractAddress}: ${cause.code} — ${cause.message}${cause.detail ? ` (${cause.detail})` : ''}`,
            );
            /* `not-an-account` can still surface here: gate 3's read is a
               snapshot, and the deposit re-reads before it spends. */
            const status =
              cause.code === 'indexer-unreachable'
                ? 503
                : cause.code === 'not-an-account'
                  ? 400
                  : 502;
            if (shouldRetryGrant(cause.code)) retryGrantLater(cause.code);
            return fail(
              refusal(
                status,
                cause.code,
                cause.message,
                cause.detail ? { detail: cause.detail } : undefined,
              ),
            );
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          console.error(`[account] FAILED for ${contractAddress}: ${message}`);
          retryGrantLater('deposit-failed');
          return fail(
            refusal(500, 'deposit-failed', `The activation grant could not be deposited: ${message}`),
          );
        }
      }
      return null;
      };

      /* ---------------------------------------------------------------- */
      /* The ASSET leg                                                     */
      /* ---------------------------------------------------------------- */

      /* A failure here is NOT a failed activation. By this point the NIGHT
         credit is real and on chain — either this request put it there or an
         earlier one did — and reporting the whole thing as an error would tell
         the caller to retry something that has already been paid for. So the
         asset leg reports itself: `assetTx` when it landed, `assetError` when it
         did not, and the once-only ledger records only what actually happened,
         so the next `/fund-account` for this contract runs the missing half and
         nothing else. */
      let assetEntry: AccountAssetEntry | null = previous?.asset ?? null;
      let assetBlock: number | null = null;
      let assetError: string | null = null;

      const assetLeg = async (): Promise<void> => {
      if (assetNeeded) {
        try {
          /* Takes the spend lock itself, twice — mint, then deposit — with the
             wait for the minted coin to become spendable in between and outside
             it. See `fundAsset` for why. */
          const grant = await funder.fundAsset(contractAddress);
          assetsFunded += 1;
          lastSpendAt = Date.now();
          assetBlock = grant.depositBlock;
          assetEntry = {
            symbol: funder.assetSymbol,
            colourHex: grant.colourHex,
            amount: grant.amount.toString(),
            mintTx: grant.mintTxHash,
            depositTx: grant.depositTxHash,
            balanceAfter: grant.balanceAfter.toString(),
            at: grant.fundedAt,
          };
          /* Re-read at write time rather than merged from `nightEntry`: the
             NIGHT leg may have confirmed while this one was proving. */
          await recordLeg({ asset: assetEntry });
          console.log(
            `[asset] ${grant.amount} ${funder.assetSymbol} → ${contractAddress} (mint ${grant.mintTxHash}, deposit ${grant.depositTxHash}${grant.depositBlock ? `, block ${grant.depositBlock}` : ''}, holds ${grant.balanceAfter})`,
          );
        } catch (cause) {
          const detail =
            cause instanceof AccountFundingError
              ? `${cause.code}: ${cause.message}${cause.detail ? ` (${cause.detail})` : ''}`
              : cause instanceof Error
                ? cause.message
                : String(cause);
          assetError = detail;
          console.error(`[asset] FAILED for ${contractAddress}: ${detail}`);
        }
      } else if (!assetSupported) {
        assetError = funder.assetUnavailableReason;
      }
      };

      /* BOTH LEGS AT ONCE, and `allSettled` rather than `all` because the asset
         leg is not allowed to abort the NIGHT one — its failure is reported in
         the 200 as `assetError`, which is the shape this endpoint has always
         had.

         The NIGHT leg's refusal still wins the response. When it loses a race
         with an asset leg that landed, the mUSD is on chain and recorded, so the
         client's retry runs the missing NIGHT half and nothing else — the
         once-only ledger is per leg for exactly this reason. */
      const [nightOutcome] = await Promise.allSettled([nightLeg(), assetLeg()]);
      if (nightOutcome.status === 'rejected') throw nightOutcome.reason;
      if (nightOutcome.value) return nightOutcome.value;

      return {
        status: 200,
        body: {
          contractAddress,
          /* `txHash` is the old name for the NIGHT leg and stays, so a client
             written against the single-leg endpoint keeps working; `nightTx` is
             the same value under the name that says which leg it is. */
          txHash: nightTxHash,
          nightTx: nightTxHash,
          block: nightBlock,
          amountAtomic: nightAmount,
          balanceAfterAtomic: nightBalanceAfter,
          fundedAt,
          assetSymbol: funder.assetSymbol,
          assetTx: assetEntry?.depositTx ?? null,
          assetMintTx: assetEntry?.mintTx ?? null,
          assetBlock,
          assetColourHex: funder.assetColourHex,
          assetAmount: assetEntry?.amount ?? (assetSupported ? funder.assetGrant.toString() : '0'),
          assetBalanceAfter: assetEntry?.balanceAfter ?? held.asset.toString(),
          ...(assetError ? { assetError } : {}),
        },
      };
    } finally {
      /* Released on every path — recorded, refused, or thrown — so a failure
         can never leave a Passport permanently unfundable. */
      accountInFlight.delete(contractAddress);
    }
  };

  /* -------------------------------------------------------------------------- */
  /* POST /register-alias                                                       */
  /* -------------------------------------------------------------------------- */

  interface AliasRequestBody {
    alias?: unknown;
    ownerKey?: unknown;
    contractAddress?: unknown;
    /** Optional; when absent the leaf carries 32 zero bytes. See `./midnames.ts`. */
    ownerAddress?: unknown;
    /** Optional; when present it must name THIS service's network. */
    network?: unknown;
    /**
     * Optional. `true` says the account contract at `contractAddress` has been
     * SUBMITTED and the indexer may not be serving it yet — see gate 4, which
     * is where the whole of this flag's meaning is written down.
     */
    targetPending?: unknown;
  }

  /**
   * Sponsors one `.night` registration.
   *
   * Nothing is spent until every gate below has passed, and nothing is reported
   * as registered until the registry has been read back and seen resolving the
   * name to the requested contract.
   */
  const registerAlias = async (
    body: AliasRequestBody,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const fail = (why: Refusal) => {
      console.warn(`[alias] refused: ${why.error} — ${why.message}`);
      return {
        status: why.status,
        body: { error: why.error, message: why.message, ...(why.extra ?? {}) },
      };
    };

    /* Logged on ARRIVAL — see the same note in `fundAccount`. The alias path
       was the worse of the two: it printed nothing at all until it ended, so
       the 23:46 wedge had no line naming the name it was registering. */
    console.log(
      `[alias] asked to register ${typeof body.alias === 'string' ? body.alias : '(no alias)'} for ${typeof body.contractAddress === 'string' ? body.contractAddress : '(no address)'}`,
    );

    /* Captured, not re-read: `sponsor` is a `let`, and TypeScript's narrowing
       does not survive into the closures below. */
    const midnames = sponsor;
    if (!midnames) {
      return fail(refusal(503, 'alias-unsupported', sponsorUnavailableReason));
    }

    /* 1. Shape. Every field is validated before anything touches the chain, and
          the alias rules are the demo's own — same regex, same reserved list —
          so a name the browser would refuse is refused here too. */
    if (typeof body.alias !== 'string' || !body.alias.trim()) {
      return fail(
        refusal(
          400,
          'invalid-alias',
          'POST a JSON body of the form {"alias": "…", "ownerKey": "64 hex", "contractAddress": "64 hex"}.',
        ),
      );
    }
    let label: string;
    try {
      label = normalisePassportAlias(body.alias);
    } catch (cause) {
      return fail(
        refusal(400, 'invalid-alias', cause instanceof Error ? cause.message : String(cause)),
      );
    }

    if (typeof body.ownerKey !== 'string') {
      return fail(
        refusal(400, 'invalid-owner-key', 'ownerKey must be a 64-hex Midnames owner key.'),
      );
    }
    let ownerKey: Uint8Array;
    try {
      ownerKey = ownerKeyBytes(body.ownerKey);
    } catch (cause) {
      return fail(
        refusal(400, 'invalid-owner-key', cause instanceof Error ? cause.message : String(cause)),
      );
    }

    if (typeof body.contractAddress !== 'string') {
      return fail(
        refusal(
          400,
          'invalid-contract-address',
          'contractAddress must be a 64-hex Midnight contract address.',
        ),
      );
    }
    let contractAddress: string;
    try {
      contractAddress = rawContractAddress(body.contractAddress);
    } catch (cause) {
      return fail(
        refusal(
          400,
          'invalid-contract-address',
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }

    if (body.network !== undefined && body.network !== config.networkId) {
      return fail(
        refusal(
          400,
          'wrong-network',
          `That request names the ${String(body.network)} network; this balancer sponsors on ${config.networkId}.`,
        ),
      );
    }

    /* Strictly `true`, never anything truthy: a client sending a string or a
       number has not made this claim, and a flag that decides when a gate is
       answered should not be settable by accident. */
    const targetPending = body.targetPending === true;

    /* The leaf's owner ADDRESS half is optional and is not the registry's
       authority — see `AliasRegistrationRequest.ownerAddressBytes`. When one is
       given it must be a real unshielded address on this network, because
       silently discarding a malformed one would leave the user believing a
       payment address was set. */
    let ownerAddressBytes: Uint8Array | undefined;
    if (body.ownerAddress !== undefined) {
      if (typeof body.ownerAddress !== 'string' || !body.ownerAddress.trim()) {
        return fail(
          refusal(
            400,
            'invalid-owner-address',
            'ownerAddress, when given, must be an mn_addr… unshielded address.',
          ),
        );
      }
      try {
        const parsed = MidnightBech32m.parse(body.ownerAddress.trim());
        if (parsedNetworkName(parsed.network) !== config.networkId) {
          return fail(
            refusal(
              400,
              'wrong-network',
              `That owner address belongs to the ${parsedNetworkName(parsed.network)} network; this balancer sponsors on ${config.networkId}.`,
            ),
          );
        }
        ownerAddressBytes = new Uint8Array(parsed.decode(UnshieldedAddress, config.networkId).data);
      } catch (cause) {
        return fail(
          refusal(
            400,
            'invalid-owner-address',
            `That is not an unshielded Midnight address: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        );
      }
    }

    /* 2. In flight. Claimed BEFORE any ledger or registry read: those reads
          cannot see a registration that is still in the air. */
    const aliasKey = `alias:${label}`;
    const contractKey = `contract:${contractAddress}`;
    if (aliasInFlight.has(aliasKey) || aliasInFlight.has(contractKey)) {
      return fail(
        refusal(
          409,
          'registration-in-flight',
          `A sponsored registration for ${aliasInFlight.has(aliasKey) ? aliasDomain(label) : 'this Passport'} is already in progress. Wait for it to finish before asking again.`,
        ),
      );
    }
    aliasInFlight.add(aliasKey);
    aliasInFlight.add(contractKey);
    try {
      /* 3. Availability. A real read of the deployed registry, never a cache
            and never an optimistic assumption: a registry we cannot read is
            reported as unreachable, not as free. */
      try {
        if (!(await midnames.isAvailable(label))) {
          return fail(
            refusal(
              409,
              'name-taken',
              `${aliasDomain(label)} is already registered on ${config.networkId}.`,
            ),
          );
        }
      } catch (cause) {
        return fail(
          refusal(
            503,
            'registry-unreachable',
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
      }

      /* 4. The target must exist. This is both a correctness gate — a name
            bound to nothing is worse than no name — and the anti-spam gate:
            deploying an account-custody contract costs a real transaction, so
            an abuser cannot mint free targets faster than the chain allows.

            WHEN IT IS ASKED, AND WHY THAT MOVED (2026/08/31)
            ------------------------------------------------
            This is an INDEXER read, and the stagenet indexer runs 13.2–14.1 s
            behind the node's own tip (16 consecutive observations, 2026/08/31).
            A client that has just submitted its account deploy therefore fails
            this gate for fourteen seconds on a contract that is perfectly real,
            which is why it used to wait out the indexer before asking — and
            then wait again while the resolver was deployed.

            So a client may now say `targetPending`, meaning "I have submitted
            the deploy; check it when you need it rather than before you will
            talk to me". The gate is not waived by that: it moves to the moment
            before `register_domain_for`, which `register` reaches only after it
            has deployed the resolver leaf — several proofs and at least one
            block later. Nothing is ever bound to a contract that does not
            exist.

            What the flag DOES cost is a resolver deploy on a target that never
            appears. That is bounded by the gates around it and not by trust:
            one sponsored name per Passport (gate 5), an hourly ceiling on how
            many the balancer will pay for at all (gate 6, consumed before any
            spend), and the in-flight lock above. A request that does NOT set
            the flag is refused exactly as it always was. */
      let targetExists: boolean;
      try {
        targetExists = await midnames.contractExists(contractAddress);
      } catch (cause) {
        return fail(
          refusal(
            503,
            'registry-unreachable',
            `The contract at ${contractAddress} could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        );
      }
      if (!targetExists && !targetPending) {
        return fail(
          refusal(
            400,
            'target-missing',
            `No contract state is served at ${contractAddress}, so there is nothing for ${aliasDomain(label)} to resolve to. Deploy the account-custody contract first.`,
          ),
        );
      }

      /* 5. Once per Passport, ever. Keyed on the contract address because that
            is what a Passport has exactly one of. */
      const previous = aliasLedger.get(contractAddress);
      if (previous) {
        return fail(
          refusal(
            409,
            'already-sponsored',
            `This Passport already had ${aliasDomain(previous.alias)} sponsored on ${previous.at} (tx ${previous.registerTx}). One sponsored name per Passport.`,
            { alias: previous.alias, registerTx: previous.registerTx },
          ),
        );
      }

      /* 6. The hourly ceiling, looked at without consuming a slot. */
      if (aliasLimiter.atCeiling()) {
        return fail(
          refusal(
            429,
            'rate-limited',
            `The balancer has reached its ceiling of ${config.aliasMaxPerHour} sponsored registrations per hour. Try again later.`,
          ),
        );
      }

      /* 7. Can the balancer actually pay? The registry price plus a fee,
            waiting out any change still in flight rather than turning the user
            away during a settle window. */
      const cost = aliasCostAtomicNight(label);
      const ready = await readiness({ settle: true, requireNight: cost });
      if (ready.refuse) return fail(ready.refuse);

      /* The slot is consumed here and nowhere earlier: every refusal above
         spent nothing, and an hourly ceiling exists to cap what the balancer
         SPENDS. */
      if (!aliasLimiter.take()) {
        return fail(
          refusal(
            429,
            'rate-limited',
            `The balancer has reached its ceiling of ${config.aliasMaxPerHour} sponsored registrations per hour. Try again later.`,
          ),
        );
      }

      /* A leaf off the shelf, if there is one. Marked consumed the instant it
         is taken — before a single proof is attempted — so a second
         registration arriving mid-binding cannot be handed the same leaf. A
         leaf whose binding then fails stays spent: it cost one deploy, the
         filler replaces it in its own time, and reusing a half-bound leaf under
         somebody else's name is not a trade worth making.

         `null` means the shelf is bare, and the registration below takes the
         path this service has always taken. */
      const pooledResolver = resolverPool ? await resolverPool.take(contractAddress) : null;

      try {
        /* Every leg runs under the wallet's spend lock, so a fee sponsorship
           cannot reserve the coins this registration is balancing against.

           And when no coin is free, this WAITS rather than refusing, then
           re-enters the queue with a freshly built transaction — which is what
           carries `withNodeRejectionRetry` into the attempt after the wait,
           because `midnames.register` rebuilds every leg it makes. A pooled
           leaf already taken off the shelf is reused across the retry, and so
           is a leaf this registration deployed for itself: without that the
           retry deploys a SECOND leaf and needs a second fee-capable coin,
           which on the live run at 20:39 on 2026/09/02 was 132 s of the user's
           207. */
        let ownDeployedResolver: { address: string; deployTx: string } | null = null;
        const registerOnce = (): Promise<AliasRegistration> => {
          /* Read afresh on every attempt, which is the point: the first pass
             leaves the leaf here and the second one registers it. */
          const carried = ownDeployedResolver;
          return midnames.register({
              label,
              ownerKey,
              contractAddress,
              ownerAddressBytes,
              awaitTarget: !targetExists,
              onResolverDeployed: (leaf) => {
                ownDeployedResolver = leaf;
                console.log(
                  `[alias] leaf ${leaf.address} is on chain for ${aliasDomain(label)} — a retry will register it rather than deploy another`,
                );
              },
              ...(carried !== null ? { deployedResolver: carried } : {}),
              ...(pooledResolver
                ? {
                    pooledResolver: {
                      address: pooledResolver.address,
                      deployTx: pooledResolver.deployTx,
                      deployBlock: pooledResolver.deployBlock ?? null,
                    },
                  }
                : {}),
          });
        };
        /* `Registration` priority puts a waiting registration ahead of any
           activation grant that is merely waiting: somebody is watching a
           screen for this one and nobody is watching for a grant. See
           `SpendPriority`. */
        const result = await spendWaitingForDust(
          `the registration of ${aliasDomain(label)}`,
          () =>
            wallet.exclusive(registerOnce, {
              priority: SpendPriority.Registration,
              label: `the registration of ${aliasDomain(label)}`,
            }),
          SpendPriority.Registration,
        );
        aliasesSponsored += 1;
        lastSpendAt = Date.now();
        await aliasLedger.record(contractAddress, {
          alias: result.alias,
          resolverAddress: result.resolverAddress,
          resolverDeployTx: result.resolverDeployTx,
          registerTx: result.registerTx,
          costAtomic: result.costAtomic.toString(),
          at: result.registeredAt,
        });
        console.log(
          `[alias] ${result.domain} → ${contractAddress} (resolver ${result.resolverAddress}${result.fromPool ? ', off the shelf' : ''}, deploy ${result.resolverDeployTx}, register ${result.registerTx}${result.registerBlock ? `, block ${result.registerBlock}` : ''})`,
        );
        return {
          status: 200,
          body: {
            alias: result.alias,
            domain: result.domain,
            network: result.network,
            tldAddress: result.tldAddress,
            resolverAddress: result.resolverAddress,
            resolverDeployTx: result.resolverDeployTx,
            registerTx: result.registerTx,
            resolverDeployBlock: result.resolverDeployBlock,
            registerBlock: result.registerBlock,
            target: result.target,
            ownerKey: result.ownerKey,
            costAtomic: result.costAtomic.toString(),
            registeredAt: result.registeredAt,
            fromPool: result.fromPool,
          },
        };
      } catch (cause) {
        /* The window ran out with no coin free. Reported as the DUST shortfall
           it is — never as `register-rejected`, which is what a caller used to
           be shown for this and is a different fault entirely. `funder-no-dust`
           is a code `sponsoredAlias.ts` already knows: it drops its cached
           probe and queues the name for another attempt. */
        if (cause instanceof DustWaitExhausted) {
          console.warn(`[alias] ${aliasDomain(label)}: ${cause.message} — nothing was spent`);
          return fail(
            refusal(
              503,
              'funder-no-dust',
              'The balancer could not free a coin to pay this registration’s fee in time. Nothing was spent; try again shortly.',
              { retryAfterMs: cause.retryAfterMs },
            ),
          );
        }
        if (cause instanceof AliasSponsorError) {
          console.error(
            `[alias] FAILED for ${aliasDomain(label)}: ${cause.code} — ${cause.message}${cause.detail ? ` (${cause.detail})` : ''}`,
          );
          /* `name-taken` can still surface here: the availability read above is
             a snapshot, and someone else's registration can land in between. */
          const status =
            cause.code === 'name-taken'
              ? 409
              : cause.code === 'registry-unreachable'
                ? 503
                : /* Same code and same status as gate 4's own refusal, because
                     it is the same refusal asked later. A client that knows how
                     to wait for its target treats the two identically. */
                  cause.code === 'target-missing'
                  ? 400
                  : 502;
          return fail(
            refusal(status, cause.code, cause.message, cause.detail ? { detail: cause.detail } : undefined),
          );
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`[alias] FAILED for ${aliasDomain(label)}: ${message}`);
        return fail(
          refusal(
            500,
            'registration-failed',
            `The sponsored registration could not be completed: ${message}`,
          ),
        );
      }
    } finally {
      /* Released on every path, so a failure can never leave a name or a
         Passport permanently unregisterable. */
      aliasInFlight.delete(aliasKey);
      aliasInFlight.delete(contractKey);
    }
  };

  /* -------------------------------------------------------------------------- */
  /* HTTP                                                                       */
  /* -------------------------------------------------------------------------- */

  const corsHeaders = (request: IncomingMessage): Record<string, string> => {
    const origin = request.headers.origin?.replace(/\/+$/, '');
    if (!origin || !config.allowedOrigins.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      /* `x-passport-key` joins the list so a browser client can send the shared
         secret once one is configured; the other two are the upstream gateway's
         and are kept so a client written against it works here unchanged. */
      'Access-Control-Allow-Headers': 'content-type, x-api-key, x-client-id, x-passport-key',
      /* A rate-limited answer carries `Retry-After`, and a browser cannot read a
         response header it was not given permission to. The refusal body still
         carries `retryAfterMs`, which is what `sponsor.ts` actually parses. */
      'Access-Control-Expose-Headers': 'retry-after',
      Vary: 'Origin',
    };
  };

  const respond = (
    request: IncomingMessage,
    response: ServerResponse,
    httpStatus: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): void => {
    response.writeHead(httpStatus, {
      'content-type': 'application/json',
      ...corsHeaders(request),
      ...headers,
    });
    response.end(JSON.stringify(body));
  };

  const readRawBody = (request: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('Request body too large.'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });

  /**
   * The demo POSTs `application/octet-stream` — raw serialised transaction
   * bytes — and that is the path that matters. Hex and `{"txBytes": "…"}` are
   * accepted too so an operator can reproduce a failure with `curl` without
   * writing a binary body by hand.
   */
  const transactionBytesFrom = (body: Buffer, contentType: string | undefined): Uint8Array => {
    const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (type === 'application/json') {
      const parsed = JSON.parse(body.toString('utf8')) as { txBytes?: unknown };
      if (typeof parsed.txBytes !== 'string') {
        throw new Error('A JSON body must be of the form {"txBytes": "<hex>"}.');
      }
      return hexToBytes(parsed.txBytes);
    }
    if (type === 'application/octet-stream' || type === undefined || type === '') {
      return new Uint8Array(body);
    }
    // text/plain and friends: hex.
    return hexToBytes(body.toString('utf8').trim());
  };

  const hexToBytes = (value: string): Uint8Array => {
    const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('The transaction is not even-length hexadecimal.');
    }
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  };

  /* -------------------------------------------------------------------------- */
  /* Who may spend at all                                                       */
  /* -------------------------------------------------------------------------- */

  /**
   * The three endpoints that cost the balancer something, each with the journal
   * prefix it already refuses under — so a guard refusal reads like every other
   * refusal that endpoint makes and the watchdog needs to learn nothing new.
   */
  /**
   * The swap desk. It sells one fixed lot of sUSD for a fixed price in NIGHT,
   * and pays out through the same mint → `deposit_shielded` engine the gift
   * desk uses, under a separator of its OWN — because the account contract
   * refuses a second coin of a colour an account already holds, and every
   * activated Passport already holds mUSD. `./swap.ts` sets out that refusal
   * and what it costs. Everything the desk decides lives there too.
   */
  const swapPayer = createColourPayer({
    config,
    wallet,
    label: SWAP_SEPARATOR_LABEL,
    name: SWAP_ASSET_SYMBOL,
    amount: config.assetGrant,
  });
  const swapDesk: SwapDesk = createSwapDesk({
    networkId: config.networkId,
    depositTo: wallet.address,
    assetSymbol: SWAP_ASSET_SYMBOL,
    assetLot: config.assetGrant,
    assetAvailable: swapPayer.available,
    assetUnavailableReason: swapPayer.unavailableReason,
    ledger: swapLedgerOf(swapLedger),
    verifyPayment: (txHash) => verifyPaymentOnChain(config.indexerHttpUrl, txHash),
    payOut: async (account) => {
      const paid = await swapPayer.payInto(account);
      return {
        depositTxHash: paid.depositTx,
        mintTxHash: paid.mintTx,
        amount: paid.amount,
      };
    },
    normaliseAccount: rawContractAddress,
  });
  if (swapPayer.available) {
    console.log(`[swap] lots of ${config.assetGrant} ${SWAP_ASSET_SYMBOL} mint under colour ${swapPayer.colourHex}`);
  } else {
    console.warn(`[swap] the payout leg is DISABLED: ${swapPayer.unavailableReason}`);
  }

  /**
   * The gift desk. `../ops/gift-nft.ts` does the same two legs with the unit
   * stopped for five to ten minutes; this runs them in the process that owns
   * the wallet, under the same spend lock, so nothing has to be stopped.
   */
  const giftDesk: GiftDesk = createGiftDesk({
    config,
    wallet,
    ledger: giftLedgerOf(giftLedger),
  });
  if (giftDesk.available) {
    console.log(`[gift] items mint under colour ${giftDesk.colourHex}`);
  } else {
    console.warn(`[gift] items are DISABLED: ${giftDesk.unavailableReason}`);
  }

  const spendGuards: Record<string, { prefix: string; bucket: TokenBucket }> = {
    '/balance-only': { prefix: 'balance', bucket: balanceBucket },
    /* Guarded like the route it undoes, and on the same bucket: it costs a
       revert rather than a proof, but it is still a caller reaching into this
       wallet's coin state and a client that can call it in a loop should be
       turned away by the same ceiling. */
    /* Its own prefix rather than `balance`, so the DUST-repair gate above can
       let it through: abandoning a balancing spends nothing and is the earliest
       news this service can get that one is dead. */
    '/balance-only/abandon': { prefix: 'abandon', bucket: balanceBucket },
    '/register-alias': { prefix: 'alias', bucket: aliasBucket },
    '/fund-account': { prefix: 'account', bucket: accountBucket },
    /* A swap pays out one asset grant, so it costs what an activation's asset
       leg costs and is metered on the same bucket. */
    '/swap': { prefix: 'swap', bucket: accountBucket },
    /* An item is one mint and one deposit — an activation's asset leg with two
       arguments changed — so it is metered on the same bucket. */
    '/gift-nft': { prefix: 'gift', bucket: accountBucket },
  };

  /**
   * Answers one guard refusal.
   *
   * The client address goes in the LINE and never in a response: an operator
   * asking "is somebody hammering this?" needs it, and a caller does not. The
   * journal is on the droplet; `/status` is on the internet, and carries only
   * counts.
   */
  const refuseSpend = (
    request: IncomingMessage,
    response: ServerResponse,
    prefix: string,
    who: string,
    why: Refusal,
    retryAfterMs?: number,
  ): void => {
    console.warn(`[${prefix}] refused: ${why.error} — ${why.message} (client ${who})`);
    respond(
      request,
      response,
      why.status,
      { error: why.error, message: why.message, ...(why.extra ?? {}) },
      /* Seconds, because that is what `Retry-After` is; the millisecond figure
         travels in the body as `retryAfterMs`, which is the field `sponsor.ts`
         parses. Floored at one, because `Retry-After: 0` invites the retry that
         is being refused. */
      retryAfterMs === undefined
        ? {}
        : { 'retry-after': String(Math.max(1, Math.round(retryAfterMs / 1_000))) },
    );
  };

  /**
   * Everything a spend request must pass before a handler — and therefore the
   * wallet — sees it. `null` admits.
   *
   * The bucket is asked FIRST and the key second, deliberately: a wrong key is
   * still a request, and a key gate that is not itself rate limited is a
   * guessing gallery. It is also why a malformed body is limited exactly like a
   * well-formed one — the cost being bounded is the caller's ability to make
   * this service do work, and parsing their body is already work.
   */
  const guardSpend = (
    request: IncomingMessage,
    guard: { prefix: string; bucket: TokenBucket },
    who: string,
  ): { refusal: Refusal; retryAfterMs: number } | null => {
    /* Asked before the bucket, because it is not about this caller at all: the
       wallet's coins are hidden from it and a repair is on its way, so nothing
       any caller does can be served until it lands. `/balance-only/abandon` is
       the one POST that passes — it SPENDS nothing, and telling this service a
       balancing is dead is exactly what should still get through. */
    if (dustRepairPending && guard.prefix !== 'abandon') {
      return {
        refusal: refusal(
          429,
          'PENDING_TRANSACTION',
          'The balancer is repairing its own DUST bookkeeping and will be able to sponsor again shortly.',
          { retryAfterMs: 5_000 },
        ),
        retryAfterMs: 5_000,
      };
    }
    const verdict = guard.bucket.take(who);
    if (!verdict.allowed) {
      refusedRateLimited += 1;
      const seconds = Math.max(1, Math.round(verdict.retryAfterMs / 1_000));
      return {
        refusal: refusal(
          429,
          'rate-limited',
          `Too many requests from this client. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
          { retryAfterMs: verdict.retryAfterMs },
        ),
        retryAfterMs: verdict.retryAfterMs,
      };
    }
    if (!clientKeyAccepted(config.clientKey, request.headers['x-passport-key'])) {
      refusedUnauthorised += 1;
      return {
        refusal: refusal(
          401,
          'unauthorised',
          'This balancer requires a client key. Send it in an X-Passport-Key header.',
        ),
        retryAfterMs: 0,
      };
    }
    return null;
  };

  const server = createServer((request, response) => {
    /** Set once a spend request holds an admission slot; released at the end. */
    let releaseSlot: (() => void) | null = null;
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;

      /* Everything but the two read-only probes counts as somebody being about.
         `/status` and `/wallet-status` are polled by the client before every
         send and by two watchdogs around the clock, so counting them would hold
         the resolver pool at paused for the life of the process. */
      if (path !== '/status' && path !== '/wallet-status') lastRequestAt = Date.now();

      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
      }

      /* Read-only routes are deliberately NOT guarded. `/wallet-status` is the
         readiness probe every client polls before every send and `/status` is
         what both watchdogs read; limiting either would break the things that
         watch this service while costing an abuser nothing, because neither one
         spends a Speck. */
      const guard = request.method === 'POST' ? spendGuards[path] : undefined;
      let who = '';
      if (guard) {
        who = clientAddress({
          socketAddress: request.socket.remoteAddress,
          forwardedFor: request.headers['x-forwarded-for'],
          trustedProxies: config.trustedProxies,
        });
        const refused = guardSpend(request, guard, who);
        if (refused) {
          refuseSpend(request, response, guard.prefix, who, refused.refusal, refused.retryAfterMs);
          return;
        }
        if (!spendAdmission.enter()) {
          refusedQueueFull += 1;
          refuseSpend(
            request,
            response,
            guard.prefix,
            who,
            refusal(
              429,
              'queue-full',
              `The balancer is already handling ${spendAdmission.max} sponsorship request${spendAdmission.max === 1 ? '' : 's'}. Try again shortly.`,
              { retryAfterMs: 5_000 },
            ),
            5_000,
          );
          return;
        }
        releaseSlot = () => spendAdmission.leave();
      }

      if (request.method === 'GET' && path === '/wallet-status') {
        respond(request, response, 200, await walletStatus());
        return;
      }

      if (request.method === 'GET' && path === '/status') {
        respond(request, response, 200, await status());
        return;
      }

      if (request.method === 'POST' && path === '/balance-only') {
        let bytes: Uint8Array;
        try {
          const body = await readRawBody(request);
          bytes = transactionBytesFrom(body, request.headers['content-type']);
        } catch (cause) {
          respond(request, response, 400, {
            error: 'INVALID_TRANSACTION',
            message:
              'POST the serialised finalized transaction as application/octet-stream, as hex, or as {"txBytes": "<hex>"}.',
            cause: cause instanceof Error ? cause.message : String(cause),
          });
          return;
        }

        try {
          const result = await countingProof(() => wallet.balanceOnly(bytes));
          balancesServed += 1;
          lastBalanceMs = Date.now();
          lastBalanceAt = new Date(lastBalanceMs).toISOString();
          console.log(
            `[balance] added a DUST fee leg to ${result.txHash} (${bytes.length} bytes in, ${result.txBytes.length / 2} bytes out, expires ${result.expiresAt})`,
          );
          respond(request, response, 200, { ...result });
        } catch (cause) {
          if (cause instanceof BalanceRefusal) {
            console.warn(`[balance] refused: ${cause.code} — ${cause.message}${cause.cause ? ` (${cause.cause})` : ''}`);
            respond(request, response, cause.status, {
              error: cause.code,
              message: cause.message,
              ...(cause.cause !== undefined ? { cause: cause.cause } : {}),
              ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
            });
            return;
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          console.error('[balance] failed', cause);
          respond(request, response, 500, { error: 'BALANCE_FAILED', message });
        }
        return;
      }

      if (request.method === 'POST' && path === '/balance-only/abandon') {
        /* The caller's own submit failed, so the DUST this service booked for
           it is never going to be spent. Taking its word costs nothing that the
           sweeper would not do anyway two minutes later — and if the caller is
           wrong, the transaction it named is one nobody can submit any more
           anyway, because the revert is what un-books THIS wallet's coins. */
        let body: { txHash?: unknown };
        try {
          body = JSON.parse((await readRawBody(request)).toString('utf8') || '{}') as {
            txHash?: unknown;
          };
        } catch {
          respond(request, response, 400, {
            error: 'invalid-request',
            message: 'The request body must be JSON of the form {"txHash": "…"}.',
          });
          return;
        }
        const txHash = typeof body.txHash === 'string' ? body.txHash.trim() : '';
        if (txHash.length === 0) {
          respond(request, response, 400, {
            error: 'invalid-request',
            message: 'The request body must name the txHash this service handed back.',
          });
          return;
        }
        const released = await wallet.abandonBalance(txHash);
        console.log(
          released
            ? `[balance] abandoned ${txHash} at the caller's request`
            : `[balance] nothing outstanding under ${txHash} to abandon`,
        );
        respond(request, response, 200, { txHash, released });
        return;
      }

      if (request.method === 'POST' && path === '/fund-account') {
        let body: FundAccountRequestBody;
        try {
          body = JSON.parse((await readRawBody(request)).toString('utf8') || '{}') as FundAccountRequestBody;
        } catch {
          respond(request, response, 400, {
            error: 'invalid-request',
            message: 'The request body must be JSON of the form {"contractAddress": "64 hex"}.',
          });
          return;
        }
        const outcome = await fundAccount(body);
        /* A probe answered "the sponsor is retrying this itself, ask again in
           fifteen seconds" cost nothing and must not count against the
           client that obeys it — see `TokenBucket.refund`. */
        if (guard && (outcome.body as { error?: unknown }).error === 'grant-retrying') {
          guard.bucket.refund(who);
        }
        respond(request, response, outcome.status, outcome.body);
        return;
      }

      if (request.method === 'GET' && path === '/swap/quote') {
        const outcome = swapDesk.quote(new URL(request.url ?? '/', 'http://localhost').searchParams);
        respond(request, response, outcome.status, outcome.body);
        return;
      }

      if (request.method === 'POST' && path === '/gift-nft') {
        let body: unknown;
        try {
          body = JSON.parse((await readRawBody(request)).toString('utf8') || '{}');
        } catch {
          respond(request, response, 400, {
            error: 'invalid-request',
            message: 'The request body must be JSON of the form {"account": "64 hex"}.',
          });
          return;
        }
        const outcome = await giftDesk.give((body ?? {}) as { account?: unknown; network?: unknown });
        respond(request, response, outcome.status, outcome.body);
        return;
      }

      if (request.method === 'POST' && path === '/swap') {
        let body: unknown;
        try {
          body = JSON.parse((await readRawBody(request)).toString('utf8') || '{}');
        } catch {
          respond(request, response, 400, {
            error: 'invalid-request',
            message: 'The request body must be JSON of the form {"account": "64 hex", "txHash": "…"}.',
          });
          return;
        }
        const outcome = await swapDesk.swap((body ?? {}) as Parameters<SwapDesk['swap']>[0]);
        respond(request, response, outcome.status, outcome.body);
        return;
      }

      if (request.method === 'POST' && path === '/register-alias') {
        let body: AliasRequestBody;
        try {
          body = JSON.parse((await readRawBody(request)).toString('utf8') || '{}') as AliasRequestBody;
        } catch {
          respond(request, response, 400, {
            error: 'invalid-request',
            message:
              'The request body must be JSON of the form {"alias": "…", "ownerKey": "64 hex", "contractAddress": "64 hex"}.',
          });
          return;
        }
        const outcome = await registerAlias(body);
        respond(request, response, outcome.status, outcome.body);
        return;
      }

      respond(request, response, 404, {
        error: 'not-found',
        message:
          'Routes: GET /status, GET /wallet-status, GET /swap/quote, POST /balance-only, POST /balance-only/abandon, POST /register-alias, POST /fund-account, POST /swap, POST /gift-nft.',
      });
    })()
      .catch((cause) => {
        console.error('[http] handler failed', cause);
        try {
          respond(request, response, 500, { error: 'internal', message: 'Internal error.' });
        } catch {
          response.destroy();
        }
      })
      /* The admission slot is released when the request is DONE, however it
         ended — served, refused, or thrown. Held out here rather than in a
         `try` around the routes so that one slot covers the whole of a
         request's life, including the minutes an activation grant spends
         proving, which is precisely the window a flood would otherwise stack
         behind. */
      .finally(() => releaseSlot?.());
  });

  /* Started before the listener, because the failure it watches for has
     already happened to this service while it was answering requests. */
  const liveness = startLivenessWatch({
    blockedMs: config.loopBlockedMs,
    recycleHeapBytes: config.recycleHeapBytes,
    recycleRssBytes: config.recycleRssBytes,
    /* Quiet means quiet: no spend job on the queue and nothing of ours at the
       prover. A recycle mid-claim would abandon a transaction somebody is
       watching a screen for, and the whole point of recycling early is that it
       can be done when it costs nobody anything. */
    idle: () => wallet.jobCount() === 0 && proofsInFlight() === 0,
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `listening on http://${config.host}:${config.port} — GET /status, GET /wallet-status, POST /balance-only, POST /balance-only/abandon, POST /register-alias, POST /fund-account`,
    );
    console.log('(the wallet is still syncing; /wallet-status answers honestly meanwhile)\n');
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} — saving the sync snapshot and stopping`);
    void liveness.stop();
    /* Stopped first, so a tick cannot start while the wallet is closing and
       read a half-shut facade as a fault. */
    healthMonitor?.stop();
    resolverPool?.stop();
    server.close();
    void wallet
      .close()
      .catch((cause) => console.warn('[wallet] did not stop cleanly', cause))
      .finally(() => process.exit(0));
    // A wedged facade must not hold the process open forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((cause) => {
  console.error('\nBALANCER FAILED TO START');
  console.error(cause);
  process.exit(1);
});
