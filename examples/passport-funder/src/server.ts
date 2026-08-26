/**
 * passport-funder — a small self-hosted service that pays for onboarding.
 *
 * It does three things, all of them so a brand-new Passport does not have to
 * hold NIGHT before it can be useful:
 *
 *   POST /activate        { address }  →  { txHash, amount }
 *   POST /fund-account    { contractAddress }
 *                                      →  { contractAddress, txHash,
 *                                           amountAtomic, balanceAfterAtomic,
 *                                           fundedAt }
 *   POST /register-alias  { alias, ownerKey, contractAddress }
 *                                      →  { alias, resolverAddress,
 *                                           resolverDeployTx, registerTx,
 *                                           target }
 *   GET  /status                       →  { network, address, balanceAtomic,
 *                                           dripsServed, accountsFunded,
 *                                           aliasesSponsored, ready }
 *
 * `/activate` drips an activation-sized NIGHT grant (default 1 000 atomic =
 * 0.001 NIGHT) to a wallet ADDRESS, so a user's own `.night` claim executes
 * immediately instead of queueing behind a captcha faucet.
 *
 * `/fund-account` puts the grant somewhere better: inside the user's own
 * account-custody contract. The ACC's `deposit_night(color, amount)` circuit is
 * permissionless, so the funder calls it on the user's contract, paying the
 * coins from its own NIGHT and the fee from its own DUST. The value exists
 * inside the contract from the moment it exists, and the user's wallet never
 * holds it. See `./account.ts`.
 *
 * `/register-alias` removes a payment entirely: the funder registers the name
 * FOR the user, paying the registry price from its own NIGHT and the fees from
 * its own DUST. The user's wallet signs nothing and holds nothing; the registry
 * records the user's own key as the owner. See `./midnames.ts` for how the
 * deployed TLD makes that possible.
 *
 * Activation policy, in the order it is enforced: well-formed unshielded
 * address on THIS network → once-only per address (persisted ledger) → global
 * hourly rate limit → funder able to pay → recipient not already holding a
 * drip's worth.
 *
 * Account-funding policy, in the order it is enforced: well-formed contract
 * address on THIS network → no other funding for the same contract in flight →
 * the contract exists AND decodes as an account-custody contract → once-only
 * per contract address (persisted ledger) → the account is not already holding
 * a grant's worth → global hourly rate limit → funder able to pay.
 *
 * Alias policy, in the order it is enforced: well-formed and unreserved label,
 * owner key, and contract address on THIS network → no other registration for
 * the same alias or the same contract in flight → the name is free on the
 * registry → the contract really exists on chain → once-only per contract
 * address (persisted ledger) → global hourly rate limit → funder able to pay.
 *
 * Every refusal is a clear JSON error.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { nativeToken } from '@midnight-ntwrk/ledger-v8';
import {
  mainnet,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import {
  AccountFundingError,
  createAccountFunder,
  type AccountFunder,
} from './account.js';
import { applyEnvFile, loadConfig, type FunderConfig } from './config.js';
import { rawContractAddress } from './contractRuntime.js';
import {
  HourlyRateLimiter,
  JsonLedger,
  type AccountEntry,
  type AliasEntry,
  type DripEntry,
} from './dripLedger.js';
import {
  AliasSponsorError,
  aliasCostAtomicNight,
  aliasDomain,
  createMidnamesSponsor,
  normalisePassportAlias,
  ownerKeyBytes,
  type MidnamesSponsor,
} from './midnames.js';
import { recipientNightBalance } from './recipientBalance.js';
import { formatNight, openFunderWallet, type FunderWallet } from './wallet.js';

/**
 * `MidnightBech32m.parse` reports mainnet as the exported `mainnet` symbol (a
 * mainnet address carries no network segment), every other network as its
 * string — the SDK's own normalisation, mirrored from the demo wallet.
 */
function parsedNetworkName(value: string | typeof mainnet): string {
  return value === mainnet ? 'mainnet' : value;
}

type Refusal = { status: number; error: string; message: string; extra?: Record<string, unknown> };

function refusal(status: number, error: string, message: string, extra?: Record<string, unknown>): Refusal {
  return { status, error, message, ...(extra ? { extra } : {}) };
}

async function main(): Promise<void> {
  applyEnvFile();
  const config: FunderConfig = loadConfig();
  console.log(`network   ${config.networkId}`);
  console.log(`indexer   ${config.indexerHttpUrl}`);
  console.log(`node      ${config.nodeUrl}`);
  console.log(`prover    ${config.provingServerUrl}`);
  console.log(`state     ${config.stateDir}`);
  console.log(`drip      ${config.dripAtomic} atomic NIGHT (${formatNight(config.dripAtomic)} NIGHT)`);
  console.log(`limit     ${config.maxPerHour} drips per rolling hour`);
  console.log(
    `grant     ${config.accountGrantAtomic} atomic NIGHT (${formatNight(config.accountGrantAtomic)} NIGHT) into each account contract`,
  );
  console.log(`grant cap ${config.accountMaxPerHour} funded accounts per rolling hour`);
  console.log(
    `alias     ${config.midnamesTldAddress ? `.night TLD ${config.midnamesTldAddress}` : 'no .night registry on this network — /register-alias disabled'}`,
  );
  console.log(`alias cap ${config.aliasMaxPerHour} sponsored registrations per rolling hour`);
  console.log(`origins   ${config.allowedOrigins.join(', ')}\n`);

  const ledgerFile = await JsonLedger.open<DripEntry>(config.stateDir, config.networkId, 'drips');
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
  const limiter = new HourlyRateLimiter(config.maxPerHour);
  const aliasLimiter = new HourlyRateLimiter(config.aliasMaxPerHour);
  const accountLimiter = new HourlyRateLimiter(config.accountMaxPerHour);
  /**
   * Addresses with an activation in progress right now.
   *
   * The once-per-address rule lives in the ledger, but the ledger is only
   * written AFTER the drip returns — and between the read and that write sit a
   * balance probe, a settle loop, and a whole transaction. Two requests for the
   * same address arriving in that window would both read "not activated" and
   * both drip. This set closes the window: it is claimed before the ledger is
   * read and released in a `finally`, so at most one activation for an address
   * is ever in flight.
   *
   * A Set is sufficient because the funder is one single-threaded process with
   * one wallet. It is deliberately NOT a substitute for the ledger, which is
   * what survives a restart.
   */
  const inFlight = new Set<string>();
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
   */
  const aliasInFlight = new Set<string>();
  /**
   * Account fundings in progress, keyed by contract address.
   *
   * One key, not two: an account funding is about exactly one thing, the
   * contract being credited. Claimed before the once-only ledger is read, for
   * the reason `/activate` documents on its own set — the ledger is written
   * only after the deposit confirms, so two requests arriving in that window
   * would both read "not funded" and both deposit.
   */
  const accountInFlight = new Set<string>();
  const nightTokenType = String(nativeToken().raw);

  process.stdout.write('opening the funder wallet');
  const wallet: FunderWallet = await openFunderWallet(config);
  console.log(`\nfunder address ${wallet.address}`);

  process.stdout.write('syncing');
  await wallet.waitForSync(() => process.stdout.write('.'));
  process.stdout.write('\n');

  const night = await wallet.nightBalance();
  console.log(`funder holds ${formatNight(night)} NIGHT (${night} atomic)`);
  if (night === 0n) {
    console.warn(
      'FUNDER IS EMPTY — faucet this address once (the captcha faucet for this network), then restart or wait: the wallet keeps syncing and picks the funds up live.',
    );
  }

  // Fees are paid in DUST, and DUST only accrues against REGISTERED NIGHT — a
  // freshly fauceted wallet must register once before it can pay its own fees.
  try {
    const registration = await wallet.registerDustIfNeeded();
    if (registration === 'registered') {
      console.log('[dust] registration submitted — DUST starts accruing within a few blocks');
    } else if (registration === 'already-generating') {
      console.log('[dust] every NIGHT UTxO is already registered for DUST generation');
    } else {
      console.log('[dust] no NIGHT yet, so nothing to register — fund the address first');
    }
  } catch (cause) {
    console.warn('[dust] registration failed (will not retry automatically):', cause);
  }
  console.log(`[dust] spendable now: ${await wallet.dustBalance()} Specks\n`);

  /**
   * The alias sponsor, built once at start-up so a missing or unreadable
   * Midnames build is a start-up log line rather than a user's first failure.
   * `null` means `/register-alias` is off — either this network has no shared
   * registry, or the artefacts could not be loaded, and the refusal says which.
   */
  let sponsor: MidnamesSponsor | null = null;
  let sponsorUnavailableReason =
    `The ${config.networkId} network has no known .night registry. Set FUNDER_MIDNAMES_TLD_ADDRESS to sponsor names against a locally deployed one.`;
  if (config.midnamesTldAddress) {
    try {
      sponsor = await createMidnamesSponsor(config, wallet);
      console.log(`[alias] sponsoring .night registrations against ${sponsor.tldAddress}`);
    } catch (cause) {
      sponsorUnavailableReason = cause instanceof Error ? cause.message : String(cause);
      console.warn(`[alias] sponsorship is DISABLED: ${sponsorUnavailableReason}`);
    }
  } else {
    console.warn(`[alias] sponsorship is DISABLED: ${sponsorUnavailableReason}`);
  }

  /**
   * The account funder, built once at start-up for the same reason as the alias
   * sponsor: a missing or unreadable account build should be a start-up log
   * line an operator sees, not a user's first activation failing. `null` means
   * `/fund-account` is off, and the refusal says why.
   */
  let accountFunder: AccountFunder | null = null;
  let accountFunderUnavailableReason =
    'The compiled account-custody build could not be loaded, so activation grants cannot be deposited.';
  try {
    accountFunder = await createAccountFunder(config, wallet);
    console.log(
      `[account] funding accounts with ${formatNight(accountFunder.grantAtomic)} NIGHT from ${accountFunder.assetsPath}`,
    );
  } catch (cause) {
    accountFunderUnavailableReason = cause instanceof Error ? cause.message : String(cause);
    console.warn(`[account] funding is DISABLED: ${accountFunderUnavailableReason}`);
  }

  let dripsServed = 0;
  let accountsFunded = 0;
  let aliasesSponsored = 0;

  /**
   * A spend consumes its whole UTxO and the change comes back in a new one, so
   * for a block or two after a drip the wallet really does hold nothing
   * spendable. Measured on preview 2026/08/07: a funder holding ~5,000 NIGHT
   * read zero immediately after a drip and was whole again 20 s later.
   *
   * Reporting that as `funder-empty` would be false, and would turn away the
   * very next person during a signup run. So a shortfall is not believed until
   * it has had time to settle: `/activate` waits, and only a shortfall that
   * outlives the window is refused.
   */
  const CHANGE_SETTLE_MS = 90_000;
  const SETTLE_POLL_MS = 3_000;

  /**
   * When the funder last spent — a drip or a sponsored registration — so
   * `/status` can say "settling" rather than "empty" while the change is still
   * in flight.
   */
  let lastSpendAt = 0;

  const readiness = async (
    options: { settle?: boolean; requireNight?: bigint } = {},
  ): Promise<{ ready: boolean; night: bigint; refuse: Refusal | null }> => {
    /* What "ready" means depends on what is being asked for: a drip needs a
       drip's worth, an alias needs the registry price. Both need DUST. */
    const required = options.requireNight ?? config.dripAtomic;
    const deadline = Date.now() + (options.settle ? CHANGE_SETTLE_MS : 0);
    for (;;) {
      const state = await wallet.currentState();
      const heldNight = await wallet.nightBalance(state);
      const heldDust = await wallet.dustBalance(state);
      if (heldNight >= required && heldDust > 0n) {
        return { ready: true, night: heldNight, refuse: null };
      }
      if (Date.now() >= deadline) {
        if (heldNight < required) {
          return {
            ready: false,
            night: heldNight,
            refuse: refusal(
              503,
              'funder-empty',
              `The funder holds ${formatNight(heldNight)} NIGHT, less than the ${formatNight(required)} NIGHT this needs. Its address (${wallet.address}) needs topping up from the ${config.networkId} faucet.`,
            ),
          };
        }
        return {
          ready: false,
          night: heldNight,
          refuse: refusal(
            503,
            'funder-no-dust',
            'The funder cannot pay a transaction fee yet: its DUST is still accruing. Try again in a minute.',
          ),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  };

  const activate = async (rawAddress: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const fail = (why: Refusal) => ({
      status: why.status,
      body: { error: why.error, message: why.message, ...(why.extra ?? {}) },
    });

    if (typeof rawAddress !== 'string' || !rawAddress.trim()) {
      return fail(refusal(400, 'invalid-address', 'POST a JSON body of the form {"address": "mn_addr…"}.'));
    }
    const candidate = rawAddress.trim();

    let parsed: MidnightBech32m;
    try {
      parsed = MidnightBech32m.parse(candidate);
    } catch (cause) {
      return fail(
        refusal(400, 'invalid-address', `That is not a Midnight address: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
    }
    const recipientNetwork = parsedNetworkName(parsed.network);
    if (recipientNetwork !== config.networkId) {
      return fail(
        refusal(400, 'wrong-network', `That address belongs to the ${recipientNetwork} network; this funder drips on ${config.networkId}.`),
      );
    }
    let recipient: UnshieldedAddress;
    try {
      recipient = parsed.decode(UnshieldedAddress, config.networkId);
    } catch (cause) {
      return fail(
        refusal(400, 'invalid-address', `That is a Midnight address, but not an unshielded (mn_addr…) one: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
    }
    const normalized = parsed.asString();

    if (normalized === wallet.address) {
      return fail(refusal(400, 'invalid-address', 'The funder does not drip to itself.'));
    }

    /* Claimed BEFORE the ledger is read, because the ledger cannot yet know
       about an activation that is still in the air. A second request for the
       same address is refused outright rather than queued: the honest answer
       is "one is already running", not a second drip. */
    if (inFlight.has(normalized)) {
      return fail(
        refusal(409, 'activation-in-flight', 'An activation for this address is already in progress. Wait for it to finish before asking again.'),
      );
    }
    inFlight.add(normalized);
    try {
      const previous = ledgerFile.get(normalized);
      if (previous) {
        return fail(
          refusal(409, 'already-activated', `This address was already activated on ${previous.at} (tx ${previous.txHash}). Activation is once per address.`, {
            txHash: previous.txHash,
          }),
        );
      }

      /* A non-consuming look at the ceiling, so a request that arrives with the
         budget already spent is turned away before the settle loop. The slot
         itself is not claimed here — see the `take()` below. */
      if (limiter.atCeiling()) {
        return fail(
          refusal(429, 'rate-limited', `The funder has reached its ceiling of ${config.maxPerHour} activations per hour. Try again later.`),
        );
      }

      const ready = await readiness({ settle: true });
      if (ready.refuse) return fail(ready.refuse);

      // Best-effort, bounded read of the recipient's own balance. An address
      // already holding a drip's worth is not a new wallet; an UNREADABLE
      // balance is not proof of anything, so the drip proceeds — the once-only
      // ledger above remains the hard gate.
      const held = await recipientNightBalance(config.indexerWsUrl, normalized, nightTokenType);
      if (held !== null && held >= config.dripAtomic) {
        return fail(
          refusal(409, 'already-funded', `That address already holds ${formatNight(held)} NIGHT — at least one activation grant's worth — so it does not need activating.`),
        );
      }

      /* The slot is consumed here and nowhere earlier: every refusal above sent
         no NIGHT, so none of them may count against an hourly ceiling that
         exists to cap what the funder SPENDS. Claiming it before the drip, not
         after, still keeps the cap honest — a drip that then fails has really
         been attempted, and re-attempting it is what the ceiling limits. */
      if (!limiter.take()) {
        return fail(
          refusal(429, 'rate-limited', `The funder has reached its ceiling of ${config.maxPerHour} activations per hour. Try again later.`),
        );
      }

      try {
        const result = await wallet.drip(recipient, config.dripAtomic);
        dripsServed += 1;
        lastSpendAt = Date.now();
        await ledgerFile.record(normalized, {
          txHash: result.txHash,
          amountAtomic: result.amountAtomic.toString(),
          at: new Date().toISOString(),
        });
        console.log(`[drip] ${formatNight(result.amountAtomic)} NIGHT → ${normalized} (tx ${result.txHash})`);
        return { status: 200, body: { txHash: result.txHash, amount: Number(result.amountAtomic) } };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`[drip] FAILED for ${normalized}: ${message}`);
        return fail(refusal(500, 'drip-failed', `The activation transaction could not be sent: ${message}`));
      }
    } finally {
      /* Released on every path — recorded, refused, or thrown — so a failure
         can never leave an address permanently unactivatable. */
      inFlight.delete(normalized);
    }
  };

  interface FundAccountRequestBody {
    contractAddress?: unknown;
    /** Optional; when present it must name THIS funder's network. */
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
    const fail = (why: Refusal) => ({
      status: why.status,
      body: { error: why.error, message: why.message, ...(why.extra ?? {}) },
    });

    /* Captured, not re-read: `accountFunder` is a `let`, and TypeScript's
       narrowing does not survive into the closures below. */
    const funder = accountFunder;
    if (!funder) {
      return fail(refusal(503, 'funding-unsupported', accountFunderUnavailableReason));
    }

    /* 1. Shape. The address is validated before anything touches the chain. */
    if (typeof body.contractAddress !== 'string') {
      return fail(
        refusal(400, 'invalid-contract-address', 'POST a JSON body of the form {"contractAddress": "64 hex"}.'),
      );
    }
    let contractAddress: string;
    try {
      contractAddress = rawContractAddress(body.contractAddress);
    } catch (cause) {
      return fail(
        refusal(400, 'invalid-contract-address', cause instanceof Error ? cause.message : String(cause)),
      );
    }

    if (body.network !== undefined && body.network !== config.networkId) {
      return fail(
        refusal(400, 'wrong-network', `That request names the ${String(body.network)} network; this funder funds accounts on ${config.networkId}.`),
      );
    }

    /* 2. In flight. Claimed BEFORE any ledger or chain read, because those
          reads cannot see a deposit that is still in the air. A second request
          for the same account is refused outright rather than queued: the
          honest answer is "one is already running", not a second grant. */
    if (accountInFlight.has(contractAddress)) {
      return fail(
        refusal(409, 'funding-in-flight', 'A funding for this Passport is already in progress. Wait for it to finish before asking again.'),
      );
    }
    accountInFlight.add(contractAddress);
    try {
      /* 3. It has to BE an account. One indexer read that must both find state
            and decode it as an account-custody contract. This is the gate that
            keeps the funder from paying coins into a stranger's contract: a
            contract that is not an ACC has no `deposit_night`, and the grant
            would be spent into something the user cannot reach. The decoded
            balance is kept for gate 5 rather than read twice. */
      let heldNight: bigint;
      try {
        heldNight = await funder.nightBalance(contractAddress);
      } catch (cause) {
        if (cause instanceof AccountFundingError) {
          return fail(
            refusal(cause.code === 'indexer-unreachable' ? 503 : 400, cause.code, cause.message, cause.detail ? { detail: cause.detail } : undefined),
          );
        }
        return fail(
          refusal(503, 'indexer-unreachable', `The contract at ${contractAddress} could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`),
        );
      }

      /* 4. Once per Passport, ever. Keyed on the contract address because that
            is what a Passport has exactly one of. */
      const previous = accountLedger.get(contractAddress);
      if (previous) {
        return fail(
          refusal(409, 'already-activated', `This Passport was already funded on ${previous.at} (tx ${previous.txHash}). The activation grant is once per account.`, {
            txHash: previous.txHash,
          }),
        );
      }

      /* 5. Not already funded. Read from the account's own `night_balances`
            mirror at gate 3: an account that already holds a grant's worth does
            not need an opening balance, whoever put it there. */
      if (heldNight >= funder.grantAtomic) {
        return fail(
          refusal(409, 'already-funded', `That account already holds ${formatNight(heldNight)} NIGHT — at least one activation grant's worth — so it does not need funding.`),
        );
      }

      /* 6. The hourly ceiling, looked at without consuming a slot. */
      if (accountLimiter.atCeiling()) {
        return fail(
          refusal(429, 'rate-limited', `The funder has reached its ceiling of ${config.accountMaxPerHour} funded accounts per hour. Try again later.`),
        );
      }

      /* 7. Can the funder actually pay? The grant plus a fee, waiting out any
            change still in flight rather than turning the user away during a
            settle window. */
      const ready = await readiness({ settle: true, requireNight: funder.grantAtomic });
      if (ready.refuse) return fail(ready.refuse);

      /* The slot is consumed here and nowhere earlier: every refusal above
         spent nothing, and an hourly ceiling exists to cap what the funder
         SPENDS. */
      if (!accountLimiter.take()) {
        return fail(
          refusal(429, 'rate-limited', `The funder has reached its ceiling of ${config.accountMaxPerHour} funded accounts per hour. Try again later.`),
        );
      }

      try {
        /* Under the wallet's spend lock, so a drip or an alias registration
           cannot reserve the coins this deposit is balancing against. */
        const result = await wallet.exclusive(() => funder.fund(contractAddress));
        accountsFunded += 1;
        lastSpendAt = Date.now();
        await accountLedger.record(contractAddress, {
          txHash: result.txHash,
          amountAtomic: result.amountAtomic.toString(),
          balanceAfterAtomic: result.balanceAfterAtomic.toString(),
          at: result.fundedAt,
        });
        console.log(
          `[account] ${formatNight(result.amountAtomic)} NIGHT → ${contractAddress} (tx ${result.txHash}, holds ${result.balanceAfterAtomic} atomic)`,
        );
        return {
          status: 200,
          body: {
            contractAddress: result.contractAddress,
            txHash: result.txHash,
            amountAtomic: result.amountAtomic.toString(),
            balanceAfterAtomic: result.balanceAfterAtomic.toString(),
            fundedAt: result.fundedAt,
          },
        };
      } catch (cause) {
        if (cause instanceof AccountFundingError) {
          console.error(`[account] FAILED for ${contractAddress}: ${cause.code} — ${cause.message}${cause.detail ? ` (${cause.detail})` : ''}`);
          /* `not-an-account` can still surface here: gate 3's read is a
             snapshot, and the deposit re-reads before it spends. */
          const status =
            cause.code === 'indexer-unreachable' ? 503 : cause.code === 'not-an-account' ? 400 : 502;
          return fail(refusal(status, cause.code, cause.message, cause.detail ? { detail: cause.detail } : undefined));
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`[account] FAILED for ${contractAddress}: ${message}`);
        return fail(refusal(500, 'deposit-failed', `The activation grant could not be deposited: ${message}`));
      }
    } finally {
      /* Released on every path — recorded, refused, or thrown — so a failure
         can never leave a Passport permanently unfundable. */
      accountInFlight.delete(contractAddress);
    }
  };

  interface AliasRequestBody {
    alias?: unknown;
    ownerKey?: unknown;
    contractAddress?: unknown;
    /** Optional; when absent the leaf carries 32 zero bytes. See `./midnames.ts`. */
    ownerAddress?: unknown;
    /** Optional; when present it must name THIS funder's network. */
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
    const fail = (why: Refusal) => ({
      status: why.status,
      body: { error: why.error, message: why.message, ...(why.extra ?? {}) },
    });

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
        refusal(400, 'invalid-alias', 'POST a JSON body of the form {"alias": "…", "ownerKey": "64 hex", "contractAddress": "64 hex"}.'),
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
      return fail(refusal(400, 'invalid-owner-key', 'ownerKey must be a 64-hex Midnames owner key.'));
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
        refusal(400, 'invalid-contract-address', 'contractAddress must be a 64-hex Midnight contract address.'),
      );
    }
    let contractAddress: string;
    try {
      contractAddress = rawContractAddress(body.contractAddress);
    } catch (cause) {
      return fail(
        refusal(400, 'invalid-contract-address', cause instanceof Error ? cause.message : String(cause)),
      );
    }

    if (body.network !== undefined && body.network !== config.networkId) {
      return fail(
        refusal(400, 'wrong-network', `That request names the ${String(body.network)} network; this funder sponsors on ${config.networkId}.`),
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
        return fail(refusal(400, 'invalid-owner-address', 'ownerAddress, when given, must be an mn_addr… unshielded address.'));
      }
      try {
        const parsed = MidnightBech32m.parse(body.ownerAddress.trim());
        if (parsedNetworkName(parsed.network) !== config.networkId) {
          return fail(
            refusal(400, 'wrong-network', `That owner address belongs to the ${parsedNetworkName(parsed.network)} network; this funder sponsors on ${config.networkId}.`),
          );
        }
        ownerAddressBytes = new Uint8Array(parsed.decode(UnshieldedAddress, config.networkId).data);
      } catch (cause) {
        return fail(
          refusal(400, 'invalid-owner-address', `That is not an unshielded Midnight address: ${cause instanceof Error ? cause.message : String(cause)}`),
        );
      }
    }

    /* 2. In flight. Claimed BEFORE any ledger or registry read, for the reason
          `/activate` documents on its own set: those reads cannot see a
          registration that is still in the air. */
    const aliasKey = `alias:${label}`;
    const contractKey = `contract:${contractAddress}`;
    if (aliasInFlight.has(aliasKey) || aliasInFlight.has(contractKey)) {
      return fail(
        refusal(409, 'registration-in-flight', `A sponsored registration for ${aliasInFlight.has(aliasKey) ? aliasDomain(label) : 'this Passport'} is already in progress. Wait for it to finish before asking again.`),
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
            refusal(409, 'name-taken', `${aliasDomain(label)} is already registered on ${config.networkId}.`),
          );
        }
      } catch (cause) {
        return fail(
          refusal(503, 'registry-unreachable', cause instanceof Error ? cause.message : String(cause)),
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
          refusal(503, 'registry-unreachable', `The contract at ${contractAddress} could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`),
        );
      }
      if (!targetExists) {
        return fail(
          refusal(400, 'target-missing', `No contract state is served at ${contractAddress}, so there is nothing for ${aliasDomain(label)} to resolve to. Deploy the account-custody contract first.`),
        );
      }

      /* 5. Once per Passport, ever. Keyed on the contract address because that
            is what a Passport has exactly one of. */
      const previous = aliasLedger.get(contractAddress);
      if (previous) {
        return fail(
          refusal(409, 'already-sponsored', `This Passport already had ${aliasDomain(previous.alias)} sponsored on ${previous.at} (tx ${previous.registerTx}). One sponsored name per Passport.`, {
            alias: previous.alias,
            registerTx: previous.registerTx,
          }),
        );
      }

      /* 6. The hourly ceiling, looked at without consuming a slot. */
      if (aliasLimiter.atCeiling()) {
        return fail(
          refusal(429, 'rate-limited', `The funder has reached its ceiling of ${config.aliasMaxPerHour} sponsored registrations per hour. Try again later.`),
        );
      }

      /* 7. Can the funder actually pay? The registry price plus a fee, waiting
            out any change still in flight rather than turning the user away
            during a settle window. */
      const cost = aliasCostAtomicNight(label);
      const ready = await readiness({ settle: true, requireNight: cost });
      if (ready.refuse) return fail(ready.refuse);

      /* The slot is consumed here and nowhere earlier: every refusal above
         spent nothing, and an hourly ceiling exists to cap what the funder
         SPENDS. */
      if (!aliasLimiter.take()) {
        return fail(
          refusal(429, 'rate-limited', `The funder has reached its ceiling of ${config.aliasMaxPerHour} sponsored registrations per hour. Try again later.`),
        );
      }

      try {
        /* Both transactions run under the wallet's spend lock, so a drip cannot
           reserve the coins this registration is balancing against. */
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
          `[alias] ${result.domain} → ${contractAddress} (resolver ${result.resolverAddress}, deploy ${result.resolverDeployTx}, register ${result.registerTx})`,
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
            target: result.target,
            ownerKey: result.ownerKey,
            costAtomic: result.costAtomic.toString(),
            registeredAt: result.registeredAt,
          },
        };
      } catch (cause) {
        if (cause instanceof AliasSponsorError) {
          console.error(`[alias] FAILED for ${aliasDomain(label)}: ${cause.code} — ${cause.message}${cause.detail ? ` (${cause.detail})` : ''}`);
          /* `name-taken` can still surface here: the availability read above is
             a snapshot, and someone else's registration can land in between. */
          const status = cause.code === 'name-taken' ? 409 : cause.code === 'registry-unreachable' ? 503 : 502;
          return fail(refusal(status, cause.code, cause.message, cause.detail ? { detail: cause.detail } : undefined));
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`[alias] FAILED for ${aliasDomain(label)}: ${message}`);
        return fail(refusal(500, 'registration-failed', `The sponsored registration could not be completed: ${message}`));
      }
    } finally {
      /* Released on every path, so a failure can never leave a name or a
         Passport permanently unregisterable. */
      aliasInFlight.delete(aliasKey);
      aliasInFlight.delete(contractKey);
    }
  };

  const corsHeaders = (request: IncomingMessage): Record<string, string> => {
    const origin = request.headers.origin?.replace(/\/+$/, '');
    if (!origin || !config.allowedOrigins.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      Vary: 'Origin',
    };
  };

  const respond = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ): void => {
    response.writeHead(status, {
      'content-type': 'application/json',
      ...corsHeaders(request),
    });
    response.end(JSON.stringify(body));
  };

  const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4_096) reject(new Error('Request body too large.'));
      });
      request.on('end', () => resolve(body));
      request.on('error', reject);
    });

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
      }

      if (request.method === 'GET' && path === '/status') {
        /* Never waits: a monitor asking the question deserves the answer now.
           `settling` distinguishes change in flight from a funder that is
           genuinely out of NIGHT — the two read identically on the chain. */
        const { ready, night } = await readiness().catch(() => ({ ready: false, night: 0n }));
        respond(request, response, 200, {
          network: config.networkId,
          address: wallet.address,
          balanceAtomic: night.toString(),
          dripsServed,
          /* Since this process started, matching `dripsServed`; each total is
             the persisted once-only ledger, which survives restarts. None of
             these is key material and none of them names a user. */
          accountsFunded,
          accountsFundedTotal: accountLedger.count,
          accountFunding: accountFunder ? 'available' : 'unavailable',
          aliasesSponsored,
          aliasesSponsoredTotal: aliasLedger.count,
          aliasSponsorship: sponsor ? 'available' : 'unavailable',
          ready,
          settling: !ready && Date.now() - lastSpendAt < CHANGE_SETTLE_MS,
        });
        return;
      }

      if (request.method === 'POST' && path === '/activate') {
        let address: unknown;
        try {
          address = (JSON.parse((await readBody(request)) || '{}') as { address?: unknown }).address;
        } catch {
          respond(request, response, 400, {
            error: 'invalid-request',
            message: 'The request body must be JSON of the form {"address": "mn_addr…"}.',
          });
          return;
        }
        const outcome = await activate(address);
        respond(request, response, outcome.status, outcome.body);
        return;
      }

      if (request.method === 'POST' && path === '/fund-account') {
        let body: FundAccountRequestBody;
        try {
          body = JSON.parse((await readBody(request)) || '{}') as FundAccountRequestBody;
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
          body = JSON.parse((await readBody(request)) || '{}') as AliasRequestBody;
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

      respond(request, response, 404, { error: 'not-found', message: 'Routes: GET /status, POST /activate, POST /fund-account, POST /register-alias.' });
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
      `listening on http://${config.host}:${config.port} — GET /status, POST /activate, POST /fund-account, POST /register-alias\n`,
    );
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
  console.error('\nFUNDER FAILED TO START');
  console.error(cause);
  process.exit(1);
});
