/**
 * Balancer configuration — everything comes from the environment, and every
 * default points at the stagenet the ledger-9 release candidates run on.
 *
 * The shape deliberately mirrors `examples/passport-funder/src/config.ts`, so an
 * operator who already runs the funder on the droplet recognises every knob;
 * only the prefix (`BALANCER_` rather than `FUNDER_`) and the network default
 * differ.
 */

import { readFileSync } from 'node:fs';

import { DEFAULT_TRUSTED_PROXIES } from './limits.js';

export interface BalancerNetworkEndpoints {
  indexerHttpUrl: string;
  indexerWsUrl: string;
  nodeUrl: string;
  /** The submission relay: the node URL as a WebSocket. */
  relayUrl: string;
  /**
   * An external proof server, when one exists. `undefined` means the service
   * proves in-process with the SDK's own WASM prover — see `wallet.ts`.
   */
  provingServerUrl?: string;
}

export interface BalancerConfig extends BalancerNetworkEndpoints {
  /** Midnight network id. `stagenet` by default. */
  networkId: string;
  /** 64-hex-character wallet seed. Required to run the service. */
  seedHex: string;
  /** Directory holding the sync snapshot. */
  stateDir: string;
  /** Origins allowed to call this service from a browser. */
  allowedOrigins: string[];
  port: number;
  host: string;
  /**
   * How far ahead of the current block the fee estimate reaches. A wallet with
   * only a few blocks of DUST accrued refuses its own transactions under a
   * large margin; five is what the funder runs with on preview.
   */
  feeBlocksMargin: number;
  /**
   * How long a balanced transaction stays valid. It is the TTL the balancing
   * DUST leg is built with and the `expiresAt` handed back to the caller, so
   * the number the client refuses on is the number the ledger refuses on.
   */
  balanceTtlMs: number;
  /**
   * How long a balanced transaction may go unseen on chain before the DUST it
   * booked is reverted back into this wallet.
   *
   * `/balance-only` never submits — the caller does — so a caller whose submit
   * is rejected or abandoned leaves this wallet's DUST booked against a
   * transaction that will never land, for the whole of {@link balanceTtlMs}.
   * This is how long the sweeper waits before it stops believing in one.
   */
  balanceOrphanMs: number;
  /**
   * How often the in-process health watchdog evaluates this wallet. Zero turns
   * it off — the external `passport-balancer-watchdog.timer` on the droplet is
   * a separate leg and is unaffected.
   */
  healthIntervalMs: number;
  /**
   * The deployed `.night` TLD registry this service sponsors names against.
   * `undefined` disables `/register-alias`, and the refusal says so.
   */
  midnamesTldAddress?: string;
  /** Overrides the search for the compiled Midnames build's ZK artefacts. */
  midnamesAssetsPath?: string;
  /** Overrides the search for the compiled account-custody build's ZK artefacts. */
  accountAssetsPath?: string;
  /** Sponsored `.night` registrations allowed per rolling hour. */
  aliasMaxPerHour: number;
  /** The activation grant `/fund-account` deposits, in atomic NIGHT. */
  accountGrantAtomic: bigint;
  /** Accounts `/fund-account` will credit per rolling hour. */
  accountMaxPerHour: number;
  /**
   * The mUSD faucet the asset grant is minted from. `undefined` disables the
   * asset leg of `/fund-account`, and the response says so.
   */
  assetFaucetAddress?: string;
  /** Overrides the search for the compiled faucet build's ZK artefacts. */
  assetAssetsPath?: string;
  /**
   * The asset grant `/fund-account` deposits into the account's `coins` map,
   * in whole mUSD. Zero disables the asset leg.
   */
  assetGrant: bigint;
  /** The per-client ceiling on `/balance-only`, which pays a DUST fee per call. */
  balanceRate: RateLimit;
  /** The per-client ceiling on `/register-alias`. */
  aliasRate: RateLimit;
  /** The per-client ceiling on `/fund-account`. */
  accountRate: RateLimit;
  /**
   * How many spend requests may be in flight at once, across every client.
   * Zero means unbounded.
   */
  spendQueueMax: number;
  /**
   * The CEILING on how many spend jobs may run at once. The real limit is the
   * number of free DUST coins, and `./server.ts` takes the smaller of the two.
   */
  spendLanes: number;
  /**
   * How many pre-deployed resolver leaves the sponsor tries to hold. The filler
   * tops the shelf up to here and never past it. Zero switches the pool off and
   * every registration deploys its own leaf, which is the behaviour this
   * service had before the pool existed.
   */
  resolverPoolTarget: number;
  /**
   * The depth below which the shelf is reported as LOW. It changes nothing
   * about how the filler behaves — the filler is always at the lowest priority,
   * and a shelf running out is never a reason to take a coin off a user — it is
   * the number an operator reads on `/status` to know the shelf needs a quiet
   * hour before the next demo.
   */
  resolverPoolFloor: number;
  /**
   * The peers whose `X-Forwarded-For` is believed. Everything else is keyed on
   * the address its socket really came from, whatever its headers claim.
   */
  trustedProxies: string[];
  /**
   * When set, the three spend endpoints require it in an `X-Passport-Key`
   * header. Unset — the default — leaves every caller admitted, which is the
   * deployed behaviour.
   */
  clientKey?: string;
}

/** One endpoint's per-client token bucket. `perMinute: 0` turns it off. */
export interface RateLimit {
  perMinute: number;
  burst: number;
}

/**
 * Default endpoints per network.
 *
 * `stagenet` is the ledger-9 release-candidate network (node 2.0.0-rc.4,
 * indexer 4.4.0-pre-alpha.16) and is the only one this service is aimed at.
 * `preview` and `preprod` are listed so that pointing the balancer at a
 * ledger-8 network fails on a real ledger mismatch rather than on a missing
 * URL — the beta SDK cannot read those chains, and the failure should say so.
 *
 * No stagenet proof server is published today, hence no `prover` entry: absent
 * `BALANCER_PROVER_URL`, the service proves in-process.
 */
const NETWORK_DEFAULTS: Record<
  string,
  { indexer: string; node: string; prover?: string }
> = {
  stagenet: {
    indexer: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
    node: 'wss://rpc.stagenet.shielded.tools',
  },
  preview: {
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    node: 'https://rpc.preview.midnight.network',
    prover: 'https://proof-server.preview.midnight.network',
  },
  preprod: {
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    node: 'https://rpc.preprod.midnight.network',
    prover: 'https://proof-server.preprod.midnight.network',
  },
  undeployed: {
    indexer: 'http://localhost:8088/api/v4/graphql',
    node: 'http://localhost:19944',
    prover: 'http://127.0.0.1:6300',
  },
};

/** The indexer's WebSocket endpoint is its HTTP endpoint with `/ws` appended. */
function indexerWsFrom(indexerHttpUrl: string): string {
  return `${indexerHttpUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
}

/**
 * The submission relay speaks WebSocket. Stagenet's node URL is already `wss`,
 * so this only has to upgrade an `http(s)` one and leave a `ws(s)` one alone.
 */
function relayFrom(nodeUrl: string): string {
  return /^wss?:/.test(nodeUrl) ? nodeUrl : nodeUrl.replace(/^http/, 'ws');
}

function trimmed(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

export const DEFAULT_NETWORK = 'stagenet';
export const DEFAULT_PORT = 8807;
export const DEFAULT_ALLOWED_ORIGINS = ['https://midnightpassport.com'];
export const DEFAULT_FEE_BLOCKS_MARGIN = 5;
/** Thirty minutes, the same window the demo builds its own transfers with. */
export const DEFAULT_BALANCE_TTL_MS = 30 * 60 * 1_000;
/**
 * How long a balanced transaction may go unseen on chain before the DUST it
 * booked is handed back.
 *
 * Two minutes: well past a six-second block plus the indexer lag a caller's
 * submit travels through (~14 s per round trip, measured 2026/09/02), and far
 * short of {@link DEFAULT_BALANCE_TTL_MS}, which is the window a transaction the
 * node has REJECTED would otherwise hold this wallet's DUST for. That is the
 * failure this exists for: on 2026/09/02 a rejected transaction booked the
 * balancer's only DUST coins for thirty minutes and onboarding stopped dead.
 */
export const DEFAULT_BALANCE_ORPHAN_MS = 120_000;
/** The funder's ceiling on preview, and the same reasoning applies here. */
export const DEFAULT_ALIAS_MAX_PER_HOUR = 20;
/** Two thousand atomic NIGHT — 0.002 NIGHT — as an account's opening balance. */
export const DEFAULT_ACCOUNT_GRANT_ATOMIC = 2_000n;
export const DEFAULT_ACCOUNT_MAX_PER_HOUR = 30;
/**
 * Ten minutes between health checks — the cadence the service owner asked for,
 * and comfortably longer than anything that self-heals. The DUST a sponsorship
 * spends is back in 20 to 60 seconds and the post-spend syncing flap clears in
 * about two minutes, so a check landing anywhere in a ten-minute cycle sees a
 * settled wallet unless something is genuinely wrong. See `../src/health.ts`.
 */
export const DEFAULT_HEALTH_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * The asset an account opens holding, and how much of it.
 *
 * mUSD is the demo's stand-in stablecoin, minted by the faucet contract below.
 * The symbol is fixed rather than configurable because the DOMAIN SEPARATOR is:
 * the colour a coin carries is `rawTokenType(separator, faucet address)`, so a
 * different symbol would be a different colour and a different faucet, not a
 * different label on the same one.
 */
export const ASSET_SYMBOL = 'mUSD';
/** One hundred mUSD, the balance a new Passport opens with. */
export const DEFAULT_ASSET_GRANT = 100n;

/**
 * The per-client ceilings.
 *
 * `/balance-only` is the one a normal session calls repeatedly — once per Send —
 * so it gets the loose limit; twelve a minute is far more than a person can
 * approve and a burst of six absorbs a client that retries. The other two are
 * once-in-a-lifetime calls per Passport, gated on top of that by a persisted
 * once-only ledger, so three a minute is generous for a family sharing an
 * address and useless to anybody draining the wallet.
 *
 * These are PER CLIENT and sit UNDER the existing global `aliasMaxPerHour` and
 * `accountMaxPerHour` ceilings, which are unchanged.
 */
export const DEFAULT_BALANCE_MAX_PER_MIN = 12;
export const DEFAULT_BALANCE_BURST = 6;
export const DEFAULT_SPEND_MAX_PER_MIN = 3;
export const DEFAULT_SPEND_BURST = 3;
/**
 * How many spend requests may be in flight at once. Eight, because a spend that
 * is merely waiting still holds a socket and whatever it read on the way in, and
 * eight is comfortably more than the demo's own concurrency while being a number
 * a flood reaches immediately.
 */
export const DEFAULT_SPEND_QUEUE_MAX = 8;

/**
 * How many spend jobs may run at once, before the free-coin limit is applied.
 *
 * Three, because an activation is five sequential sponsored transactions and
 * the two that can genuinely run in parallel — the NIGHT grant and the asset
 * leg — plus one registration for the person onboarding behind them is the
 * concurrency the demo actually produces. Higher would not help: the droplet
 * has two vCPUs and one proof server shared with every client, so a fourth
 * concurrent proof would simply queue there instead of here, where at least the
 * queue is visible on `/status`.
 *
 * One restores the strictly-serial behaviour this service had before
 * 2026/09/02, which is the setting to fall back to if concurrency is ever
 * suspected of a fault.
 */
export const DEFAULT_SPEND_LANES = 3;

/**
 * How many pre-deployed resolver leaves to hold, and the depth below which the
 * shelf is called low.
 *
 * A hundred because the demand is a demo, not a market: a hundred leaves is a
 * hundred names registered without anybody waiting on a leaf deploy, and at
 * 1.37e16 Specks apiece they are paid for out of the sponsor's idle minutes
 * rather than out of somebody's onboarding. The floor is half of
 * it, which is the point where refilling deserves a deliberately quiet hour
 * rather than whatever gaps the traffic leaves.
 *
 * Both are overridden by `RESOLVER_POOL_TARGET` and `RESOLVER_POOL_FLOOR` —
 * unprefixed, because they are the operator's ruling about the shelf and not a
 * tuning knob on the balancer's spending.
 */
export const DEFAULT_RESOLVER_POOL_TARGET = 100;
export const DEFAULT_RESOLVER_POOL_FLOOR = 50;

/**
 * The mUSD faucet each network's asset grant is minted from.
 *
 * Stagenet's is the instance `deploy-stagenet` put on chain at block 157,776 —
 * the same one `deploy-stagenet/src/shielded-receipt-drill.mjs` minted 500 mUSD
 * out of on 2026/08/24, proving the mint → `deposit_shielded` path end to end.
 * Its `mint_shielded` is permissionless, which is what lets the balancer mint
 * to its own shielded address and then pay the coin into somebody's account.
 *
 * No other network has an entry, for the reason {@link MIDNAMES_TLD_DEFAULTS}
 * has none: the balancer is a stagenet service, and another network's faucet is
 * the sort of thing that should be typed out rather than defaulted into.
 */
const ASSET_FAUCET_DEFAULTS: Record<string, string> = {
  stagenet: '4fc92e152e8d854ef9337275504244e18bd6e3d7d41fd81ed2dabf62be78e92f',
};

/**
 * The `.night` TLD each network's registrations go to.
 *
 * Stagenet's is OUR instance, deployed by `deploy-stagenet` on 2026/08/24 at
 * block 157797 with the preview registry's own parameters (COST 600/140/10,
 * BUY_ENABLED, the balancer's derived key as `DOMAIN_OWNER`). It is the address
 * `register_domain_for` was proved against in tx
 * `6fd842da3319c0b445f7527ecfc37e59684a2db5bf68b7f3d4525723870494d0`.
 *
 * No other network has an entry: the balancer is a stagenet service, and
 * pointing it at preview would need the preview registry's address given
 * explicitly through `BALANCER_MIDNAMES_TLD_ADDRESS`, which is exactly the sort
 * of thing that should be typed out rather than defaulted into.
 */
const MIDNAMES_TLD_DEFAULTS: Record<string, string> = {
  stagenet: '29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116',
};

/** Resolves endpoints for a network, with per-endpoint env overrides. */
export function networkEndpoints(
  networkId: string,
  env: NodeJS.ProcessEnv = process.env,
): BalancerNetworkEndpoints {
  const defaults = NETWORK_DEFAULTS[networkId];
  const indexerHttpUrl = trimmed(env.BALANCER_INDEXER_URL) ?? defaults?.indexer;
  const nodeUrl = trimmed(env.BALANCER_NODE_URL) ?? defaults?.node;
  if (!indexerHttpUrl || !nodeUrl) {
    throw new Error(
      `No default endpoints are known for network "${networkId}". Set BALANCER_INDEXER_URL and BALANCER_NODE_URL explicitly, or use one of: ${Object.keys(NETWORK_DEFAULTS).join(', ')}.`,
    );
  }
  const provingServerUrl = trimmed(env.BALANCER_PROVER_URL) ?? defaults?.prover;
  return {
    indexerHttpUrl,
    indexerWsUrl: trimmed(env.BALANCER_INDEXER_WS_URL) ?? indexerWsFrom(indexerHttpUrl),
    nodeUrl,
    relayUrl: relayFrom(nodeUrl),
    ...(provingServerUrl ? { provingServerUrl } : {}),
  };
}

/**
 * Minimal dotenv: when BALANCER_ENV_FILE names a file, its `KEY=VALUE` lines
 * (optionally `export`-prefixed, `#` comments ignored) are merged into the
 * environment — the real environment always wins over the file. This is how a
 * deployment keeps its seed in a mode-600 file instead of a shell history:
 *
 *   BALANCER_ENV_FILE=~/.midnight-passport-balancer-stagenet.env npm start
 *
 * `node --env-file=<path> dist/server.mjs` achieves the same with Node's own
 * loader; this variable exists so `npm start` and systemd can do it too.
 */
export function applyEnvFile(env: NodeJS.ProcessEnv = process.env): void {
  const path = env.BALANCER_ENV_FILE?.trim();
  if (!path) return;
  // A named file that cannot be read is a configuration error — fail loudly.
  const text = readFileSync(path.replace(/^~(?=\/)/, env.HOME ?? '~'), 'utf8');
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (env[key] !== undefined) continue;
    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BalancerConfig {
  const networkId = trimmed(env.BALANCER_NETWORK) ?? DEFAULT_NETWORK;
  const seedHex = trimmed(env.BALANCER_SEED) ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error(
      'BALANCER_SEED must be 64 hex characters (a 32-byte wallet seed). Run `npm run generate-seed` to create one, faucet its address once, and export it.',
    );
  }

  const allowedOrigins = (trimmed(env.BALANCER_ALLOWED_ORIGINS) ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const port = Number(trimmed(env.BALANCER_PORT) ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('BALANCER_PORT must be a TCP port number.');
  }

  const feeBlocksMargin = Number(
    trimmed(env.BALANCER_FEE_BLOCKS_MARGIN) ?? DEFAULT_FEE_BLOCKS_MARGIN,
  );
  if (!Number.isInteger(feeBlocksMargin) || feeBlocksMargin < 0) {
    throw new Error('BALANCER_FEE_BLOCKS_MARGIN must be a non-negative integer.');
  }

  const balanceTtlMs = Number(trimmed(env.BALANCER_BALANCE_TTL_MS) ?? DEFAULT_BALANCE_TTL_MS);
  if (!Number.isInteger(balanceTtlMs) || balanceTtlMs <= 0) {
    throw new Error('BALANCER_BALANCE_TTL_MS must be a positive integer of milliseconds.');
  }

  const balanceOrphanMs = Number(
    trimmed(env.BALANCER_BALANCE_ORPHAN_MS) ?? DEFAULT_BALANCE_ORPHAN_MS,
  );
  if (!Number.isInteger(balanceOrphanMs) || balanceOrphanMs <= 0) {
    throw new Error('BALANCER_BALANCE_ORPHAN_MS must be a positive integer of milliseconds.');
  }

  const healthIntervalMs = Number(
    trimmed(env.BALANCER_HEALTH_INTERVAL_MS) ?? DEFAULT_HEALTH_INTERVAL_MS,
  );
  /* A floor of five seconds rather than one: the check reads the wallet's state
     observable, and a sub-second interval would be a hot loop against the
     facade rather than a watchdog. Zero is the documented way to turn it off. */
  if (!Number.isInteger(healthIntervalMs) || healthIntervalMs < 0) {
    throw new Error(
      'BALANCER_HEALTH_INTERVAL_MS must be a non-negative integer of milliseconds (0 disables the health watchdog).',
    );
  }
  if (healthIntervalMs > 0 && healthIntervalMs < 5_000) {
    throw new Error('BALANCER_HEALTH_INTERVAL_MS must be at least 5000 ms, or 0 to disable.');
  }

  const aliasMaxPerHour = Number(trimmed(env.BALANCER_ALIAS_MAX_PER_HOUR) ?? DEFAULT_ALIAS_MAX_PER_HOUR);
  if (!Number.isInteger(aliasMaxPerHour) || aliasMaxPerHour < 0) {
    throw new Error('BALANCER_ALIAS_MAX_PER_HOUR must be a non-negative integer.');
  }

  const accountMaxPerHour = Number(
    trimmed(env.BALANCER_ACCOUNT_MAX_PER_HOUR) ?? DEFAULT_ACCOUNT_MAX_PER_HOUR,
  );
  if (!Number.isInteger(accountMaxPerHour) || accountMaxPerHour < 0) {
    throw new Error('BALANCER_ACCOUNT_MAX_PER_HOUR must be a non-negative integer.');
  }

  const grantRaw = trimmed(env.BALANCER_ACCOUNT_GRANT_ATOMIC);
  let accountGrantAtomic = DEFAULT_ACCOUNT_GRANT_ATOMIC;
  if (grantRaw !== undefined) {
    if (!/^\d+$/.test(grantRaw)) {
      throw new Error('BALANCER_ACCOUNT_GRANT_ATOMIC must be a whole number of atomic NIGHT.');
    }
    accountGrantAtomic = BigInt(grantRaw);
    if (accountGrantAtomic <= 0n) {
      throw new Error('BALANCER_ACCOUNT_GRANT_ATOMIC must be greater than zero.');
    }
  }

  const assetGrantRaw = trimmed(env.BALANCER_ASSET_GRANT);
  let assetGrant = DEFAULT_ASSET_GRANT;
  if (assetGrantRaw !== undefined) {
    if (!/^\d+$/.test(assetGrantRaw)) {
      throw new Error(`BALANCER_ASSET_GRANT must be a whole number of ${ASSET_SYMBOL}.`);
    }
    /* Zero is the off switch, and deliberately so: an operator who wants the
       NIGHT leg without the asset leg should not have to break the faucet
       address to get it. */
    assetGrant = BigInt(assetGrantRaw);
  }

  /* Normalised the moment they are read rather than at first use: a mistyped
     contract address should stop the service at start-up, where an operator is
     watching, not on somebody's first alias or first activation. */
  const contractAddressFrom = (variable: string, raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    const normalized = raw.toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error(`${variable} must be a 64-hex Midnight contract address, got: ${raw}`);
    }
    return normalized;
  };

  /* A non-negative whole number, or the service does not start. A mistyped
     ceiling that silently became `NaN` would read as "no limit" — the one
     failure mode a limit must not have. */
  const wholeNumber = (variable: string, raw: string | undefined, fallback: number): number => {
    const value = Number(raw ?? fallback);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${variable} must be a non-negative integer.`);
    }
    return value;
  };

  const rateLimit = (
    endpoint: string,
    rateRaw: string | undefined,
    burstRaw: string | undefined,
    rateFallback: number,
    burstFallback: number,
  ): RateLimit => ({
    perMinute: wholeNumber(`BALANCER_${endpoint}_MAX_PER_MIN`, rateRaw, rateFallback),
    burst: wholeNumber(`BALANCER_${endpoint}_BURST`, burstRaw, burstFallback),
  });

  const balanceRate = rateLimit(
    'BALANCE',
    trimmed(env.BALANCER_BALANCE_MAX_PER_MIN),
    trimmed(env.BALANCER_BALANCE_BURST),
    DEFAULT_BALANCE_MAX_PER_MIN,
    DEFAULT_BALANCE_BURST,
  );
  const aliasRate = rateLimit(
    'ALIAS',
    trimmed(env.BALANCER_ALIAS_MAX_PER_MIN),
    trimmed(env.BALANCER_ALIAS_BURST),
    DEFAULT_SPEND_MAX_PER_MIN,
    DEFAULT_SPEND_BURST,
  );
  const accountRate = rateLimit(
    'ACCOUNT',
    trimmed(env.BALANCER_ACCOUNT_MAX_PER_MIN),
    trimmed(env.BALANCER_ACCOUNT_BURST),
    DEFAULT_SPEND_MAX_PER_MIN,
    DEFAULT_SPEND_BURST,
  );
  const spendQueueMax = wholeNumber(
    'BALANCER_SPEND_QUEUE_MAX',
    trimmed(env.BALANCER_SPEND_QUEUE_MAX),
    DEFAULT_SPEND_QUEUE_MAX,
  );
  const spendLanes = wholeNumber(
    'BALANCER_SPEND_LANES',
    trimmed(env.BALANCER_SPEND_LANES),
    DEFAULT_SPEND_LANES,
  );
  if (spendLanes < 1) {
    throw new Error('BALANCER_SPEND_LANES must be at least 1 (1 runs spends strictly one at a time).');
  }

  const resolverPoolTarget = wholeNumber(
    'RESOLVER_POOL_TARGET',
    trimmed(env.RESOLVER_POOL_TARGET),
    DEFAULT_RESOLVER_POOL_TARGET,
  );
  const resolverPoolFloor = wholeNumber(
    'RESOLVER_POOL_FLOOR',
    trimmed(env.RESOLVER_POOL_FLOOR),
    DEFAULT_RESOLVER_POOL_FLOOR,
  );
  if (resolverPoolFloor > resolverPoolTarget) {
    throw new Error(
      `RESOLVER_POOL_FLOOR (${resolverPoolFloor}) cannot be above RESOLVER_POOL_TARGET (${resolverPoolTarget}): the filler never fills past the target, so a floor above it would report the shelf as low for ever.`,
    );
  }

  const trustedProxies = (trimmed(env.BALANCER_TRUSTED_PROXIES) ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const clientKey = trimmed(env.BALANCER_CLIENT_KEY);

  const midnamesTldAddress = contractAddressFrom(
    'BALANCER_MIDNAMES_TLD_ADDRESS',
    trimmed(env.BALANCER_MIDNAMES_TLD_ADDRESS) ?? MIDNAMES_TLD_DEFAULTS[networkId],
  );
  const assetFaucetAddress = contractAddressFrom(
    'BALANCER_ASSET_FAUCET_ADDRESS',
    trimmed(env.BALANCER_ASSET_FAUCET_ADDRESS) ?? ASSET_FAUCET_DEFAULTS[networkId],
  );

  return {
    networkId,
    ...networkEndpoints(networkId, env),
    seedHex,
    stateDir: trimmed(env.BALANCER_STATE_DIR) ?? './state',
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : [...DEFAULT_ALLOWED_ORIGINS],
    port,
    host: trimmed(env.BALANCER_HOST) ?? '0.0.0.0',
    feeBlocksMargin,
    balanceTtlMs,
    balanceOrphanMs,
    healthIntervalMs,
    ...(midnamesTldAddress ? { midnamesTldAddress } : {}),
    ...(trimmed(env.BALANCER_MIDNAMES_ASSETS)
      ? { midnamesAssetsPath: trimmed(env.BALANCER_MIDNAMES_ASSETS) as string }
      : {}),
    ...(trimmed(env.BALANCER_ACCOUNT_ASSETS)
      ? { accountAssetsPath: trimmed(env.BALANCER_ACCOUNT_ASSETS) as string }
      : {}),
    ...(trimmed(env.BALANCER_ASSET_ASSETS)
      ? { assetAssetsPath: trimmed(env.BALANCER_ASSET_ASSETS) as string }
      : {}),
    aliasMaxPerHour,
    accountGrantAtomic,
    accountMaxPerHour,
    ...(assetFaucetAddress ? { assetFaucetAddress } : {}),
    assetGrant,
    balanceRate,
    aliasRate,
    accountRate,
    spendQueueMax,
    spendLanes,
    resolverPoolTarget,
    resolverPoolFloor,
    trustedProxies: trustedProxies.length > 0 ? trustedProxies : [...DEFAULT_TRUSTED_PROXIES],
    ...(clientKey ? { clientKey } : {}),
  };
}
