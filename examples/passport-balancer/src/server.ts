/**
 * passport-balancer — the whole stagenet onboarding sponsor.
 *
 * It holds NIGHT, registers that NIGHT for DUST generation, and then pays for
 * the three things a new Passport cannot pay for itself:
 *
 *   GET  /status         →  a human answer: network, address, balances, whether
 *                           the wallet is synced, how it proves, what the DUST
 *                           registration did, how many transactions it balanced,
 *                           how many names and accounts it has sponsored
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
 * Everything else — env-only configuration, a sync snapshot on disk, a CORS
 * allow-list, SIGTERM saving before it exits — is `examples/passport-funder`'s
 * shape, so an operator running both on the same droplet learns one service.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

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
import {
  HourlyRateLimiter,
  JsonLedger,
  type AccountAssetEntry,
  type AccountEntry,
  type AliasEntry,
} from './ledgers.js';
import {
  AliasSponsorError,
  aliasCostAtomicNight,
  aliasDomain,
  createMidnamesSponsor,
  normalisePassportAlias,
  ownerKeyBytes,
  type MidnamesSponsor,
} from './midnames.js';
import {
  BalanceRefusal,
  formatNight,
  openBalancerWallet,
  type BalancerWallet,
} from './wallet.js';

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
  console.log(`origins   ${config.allowedOrigins.join(', ')}\n`);

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
  const aliasLimiter = new HourlyRateLimiter(config.aliasMaxPerHour);
  const accountLimiter = new HourlyRateLimiter(config.accountMaxPerHour);

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
  process.stdout.write('opening the balancer wallet\n');
  const wallet: BalancerWallet = await openBalancerWallet(config);
  console.log(`balancer address ${wallet.address}`);
  console.log(`proving via      ${wallet.provingMode === 'server' ? 'proof server' : 'WASM, in this process'}\n`);

  let syncSeconds: number | null = null;
  let registration: RegistrationState = 'pending';
  let registrationDetail: string | null = null;
  let balancesServed = 0;
  let lastBalanceAt: string | null = null;
  let aliasesSponsored = 0;
  let accountsFunded = 0;
  /** Asset legs completed since this process started, counted apart from NIGHT. */
  let assetsFunded = 0;
  /**
   * When the balancer last SPENT — a sponsored registration or an activation
   * grant — so a shortfall read straight afterwards can be reported as
   * settling rather than as an empty wallet. A spend consumes its whole UTxO
   * and the change comes back in a new one, so for a block or two the wallet
   * really does read as holding nothing.
   */
  let lastSpendAt = 0;

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
   * A spend consumes its whole UTxO and the change comes back in a new one, so
   * for a block or two after a spend the wallet really does hold nothing
   * spendable. Measured on preview 2026/08/07 for the funder: a wallet holding
   * ~5,000 NIGHT read zero immediately after a drip and was whole again 20 s
   * later. Reporting that as an empty balancer would be false, so a shortfall
   * is not believed until it has had time to settle.
   */
  /* Long enough to outlast the wallet's own post-spend "syncing" flap, which
     was measured at ~2 minutes (the SDK scores being one event AHEAD of the
     stream the same as being behind). A fund-account request arrives seconds
     after the registration that caused the flap; 90 s turned it away with
     `wallet-syncing` on the live site (2026/08/25) while the flap self-healed
     30 s later. */
  const CHANGE_SETTLE_MS = 300_000;
  const SETTLE_POLL_MS = 3_000;

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
        isSynced = (await wallet.progress(state)).isSynced;
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
      ready = progress.isSynced;
      dustSynced = progress.dust.complete;
      syncState = progress.isSynced ? 'ready' : 'syncing';
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
    const { available, unavailableCause } = walletAvailability({
      synced: ready,
      dustSpecks: dustBalance,
      reserved: wallet.isReserved(),
      proving: wallet.provingReadiness().state,
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
    };
  };

  /** `GET /status` — the funder's human answer, for an operator and a monitor. */
  const status = async (): Promise<Record<string, unknown>> => {
    let night = 0n;
    let dust = 0n;
    let progress: Awaited<ReturnType<BalancerWallet['progress']>> | null = null;
    try {
      const state = await wallet.currentState();
      progress = await wallet.progress(state);
      night = await wallet.nightBalance(state);
      dust = await wallet.dustBalance(state);
    } catch {
      // Reported as `synced: false` below rather than as an HTTP failure.
    }
    /* Same meaning as `available` on `/wallet-status`: able to pay for
       somebody right now, not merely alive. Computed before the object so
       `settling` can say why it is false. */
    const ready =
      (progress?.isSynced ?? false) &&
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
      /* `balancing` is the CLAIM on this wallet's coins — seconds. `busy` is a
         whole spend job, proving included — minutes, for an mUSD grant. They are
         reported separately because only the first says anything about whether
         this service can pay somebody's fee right now. */
      balancing: wallet.isReserved(),
      busy: wallet.isBusy(),
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
      assetUnavailableReason: accountFunder?.assetAvailable
        ? null
        : (accountFunder?.assetUnavailableReason ?? accountFunderUnavailableReason),
      /* How CONTRACT circuits are proved, which is a different question from
         `proving` above: that one is the wallet's own DUST and Zswap legs. */
      contractProving: sponsor?.provingMode ?? accountFunder?.provingMode ?? null,
      /* Not ready, but only because a spend's change is still in flight — the
         funder's distinction, and it matters: change settling and a wallet
         that is genuinely out of NIGHT read identically on the chain. */
      settling: !ready && Date.now() - lastSpendAt < CHANGE_SETTLE_MS,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1_000),
      ready,
    };
  };

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
      const nightNeeded = previous === null && held.night < funder.grantAtomic;
      const assetNeeded =
        assetSupported && previous?.asset === undefined && held.asset < funder.assetGrant;

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
      /* The NIGHT leg                                                     */
      /* ---------------------------------------------------------------- */

      /* Carried forward so the asset leg's ledger write keeps whatever the
         NIGHT leg recorded, whether that happened just now or in an earlier
         request that ended with the asset leg outstanding. */
      let nightEntry: AccountEntry | null = previous;
      let nightTxHash: string | null = previous?.txHash ?? null;
      let nightBlock: number | null = null;
      let nightAmount = previous?.amountAtomic ?? '0';
      let nightBalanceAfter = previous?.balanceAfterAtomic ?? held.night.toString();
      let fundedAt = previous?.at ?? new Date().toISOString();

      if (nightNeeded) {
        try {
          /* Under the wallet's spend lock, so a fee-sponsorship request or an
             alias registration cannot reserve the coins this deposit is
             balancing against. */
          const result = await wallet.exclusive(() => funder.fund(contractAddress));
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
          await accountLedger.record(contractAddress, nightEntry);
          console.log(
            `[account] ${formatNight(result.amountAtomic)} NIGHT → ${contractAddress} (tx ${result.txHash}${result.block ? `, block ${result.block}` : ''}, holds ${result.balanceAfterAtomic} atomic)`,
          );
        } catch (cause) {
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
          return fail(
            refusal(500, 'deposit-failed', `The activation grant could not be deposited: ${message}`),
          );
        }
      }

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
          await accountLedger.record(contractAddress, {
            ...(nightEntry ?? { at: grant.fundedAt }),
            asset: assetEntry,
          });
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
            an abuser cannot mint free targets faster than the chain allows. */
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
      if (!targetExists) {
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

      try {
        /* Both transactions run under the wallet's spend lock, so a fee
           sponsorship cannot reserve the coins this registration is balancing
           against. */
        const result = await wallet.exclusive(() =>
          midnames.register({ label, ownerKey, contractAddress, ownerAddressBytes }),
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
          `[alias] ${result.domain} → ${contractAddress} (resolver ${result.resolverAddress}, deploy ${result.resolverDeployTx}, register ${result.registerTx}${result.registerBlock ? `, block ${result.registerBlock}` : ''})`,
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
          },
        };
      } catch (cause) {
        if (cause instanceof AliasSponsorError) {
          console.error(
            `[alias] FAILED for ${aliasDomain(label)}: ${cause.code} — ${cause.message}${cause.detail ? ` (${cause.detail})` : ''}`,
          );
          /* `name-taken` can still surface here: the availability read above is
             a snapshot, and someone else's registration can land in between. */
          const status =
            cause.code === 'name-taken' ? 409 : cause.code === 'registry-unreachable' ? 503 : 502;
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
      'Access-Control-Allow-Headers': 'content-type, x-api-key, x-client-id',
      Vary: 'Origin',
    };
  };

  const respond = (
    request: IncomingMessage,
    response: ServerResponse,
    httpStatus: number,
    body: Record<string, unknown>,
  ): void => {
    response.writeHead(httpStatus, {
      'content-type': 'application/json',
      ...corsHeaders(request),
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

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
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
          const result = await wallet.balanceOnly(bytes);
          balancesServed += 1;
          lastBalanceAt = new Date().toISOString();
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
          'Routes: GET /status, GET /wallet-status, POST /balance-only, POST /register-alias, POST /fund-account.',
      });
    })().catch((cause) => {
      console.error('[http] handler failed', cause);
      try {
        respond(request, response, 500, { error: 'internal', message: 'Internal error.' });
      } catch {
        response.destroy();
      }
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `listening on http://${config.host}:${config.port} — GET /status, GET /wallet-status, POST /balance-only, POST /register-alias, POST /fund-account`,
    );
    console.log('(the wallet is still syncing; /wallet-status answers honestly meanwhile)\n');
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} — saving the sync snapshot and stopping`);
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
