/**
 * Funder configuration — everything comes from the environment, and every
 * default matches the endpoints the Passport demo itself uses (see
 * `examples/passport-demo/src/lib/localWallet.ts` for the public networks and
 * `fund-localnet.mjs` at the repository root for the localnet).
 */

import { readFileSync } from 'node:fs';

export interface FunderNetworkEndpoints {
  indexerHttpUrl: string;
  indexerWsUrl: string;
  nodeUrl: string;
  relayUrl: string;
  provingServerUrl: string;
}

export interface FunderConfig extends FunderNetworkEndpoints {
  /** Midnight network id: `preview` (default), `preprod`, or `undeployed`. */
  networkId: string;
  /** 64-hex-character wallet seed. Required to run the service. */
  seedHex: string;
  /** Directory holding the sync snapshot and the drip ledger. */
  stateDir: string;
  /** Atomic NIGHT per activation drip. 1 000 atomic = 0.001 NIGHT. */
  dripAtomic: bigint;
  /** Global ceiling on drips per rolling hour. */
  maxPerHour: number;
  /**
   * Global ceiling on SPONSORED ALIAS REGISTRATIONS per rolling hour, counted
   * separately from drips: the two spend the same coins but answer different
   * questions, and a burst of one must not silently close the other.
   */
  aliasMaxPerHour: number;
  /**
   * Atomic NIGHT deposited INTO an account-custody contract per activation.
   *
   * Larger than {@link dripAtomic} because it is not spending money on a
   * wallet's behalf — it is the account's opening balance, and it should cover
   * a name registration plus a few real transfers without a second visit.
   */
  accountGrantAtomic: bigint;
  /**
   * Global ceiling on ACCOUNT FUNDINGS per rolling hour, counted separately
   * from drips and from alias registrations for the same reason those two are
   * counted apart: they spend the same coins but answer different questions.
   */
  accountMaxPerHour: number;
  /** Explicit path to the compiled account build, when auto-discovery is wrong. */
  accountAssetsPath?: string;
  /**
   * The `.night` TLD this funder registers against. Defaults to the deployed
   * registry for {@link networkId}; override for a locally deployed one.
   */
  midnamesTldAddress: string;
  /** Explicit path to the pinned Midnames build, when auto-discovery is wrong. */
  midnamesAssetsPath?: string;
  /** Origins allowed to call this service from a browser. */
  allowedOrigins: string[];
  port: number;
  host: string;
}

/**
 * Default endpoints per network. Public networks use the same hosts the demo
 * wallet defaults to; `undeployed` matches the disposable localnet brought up
 * from `experiments/account-custody-prototype/infra` (node on 19944 — see the
 * header of `fund-localnet.mjs`).
 */
const NETWORK_DEFAULTS: Record<string, { indexer: string; node: string; prover: string }> = {
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

/**
 * The deployed Midnames `.night` top-level domain on each network.
 *
 * Copied verbatim from `examples/passport-demo/src/identity/midnames.ts`, which
 * in turn took them from the Midnames SDK's own `NETWORK_REGISTRY`. All three
 * were probed live on 2026/08/05: each decodes with this repository's pinned
 * contract build, each reports `BUY_ENABLED = true`, and each charges
 * 600 / 140 / 10 atomic NIGHT for a name of <=3 / 4 / >=5 bytes.
 *
 * `undeployed` deliberately has no entry: a disposable localnet has no shared
 * registry. Point `FUNDER_MIDNAMES_TLD_ADDRESS` at a locally deployed TLD to
 * sponsor names there.
 */
export const MIDNAMES_TLD_ADDRESSES: Record<string, string> = {
  preview: 'e2655a6d554d5d3ceb03dfbee517ad4186d6c287c5e638a29258320dde3e0ba7',
  preprod: '43b500cadaa57d174d82cd6fd596002e33e3e680d7cf8bd7ba3383f62ceb0749',
  mainnet: '0167c9ad2f166e717dd7b4a72606bf5cbba2fd462d5e1ca95e2d0452af288638',
};

/** The indexer's WebSocket endpoint is its HTTP endpoint with `/ws` appended. */
function indexerWsFrom(indexerHttpUrl: string): string {
  return `${indexerHttpUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
}

/** The submission relay speaks WebSocket, so an `http(s)` node URL is upgraded. */
function relayFrom(nodeUrl: string): string {
  return nodeUrl.replace(/^http/, 'ws');
}

function trimmed(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

export const DEFAULT_DRIP_ATOMIC = 1_000n; // 0.001 NIGHT — ~100 long-name registrations
export const DEFAULT_MAX_PER_HOUR = 60;
/**
 * Deliberately modest. A sponsored registration costs the funder two proofs and
 * two transactions as well as the 10 atomic NIGHT price, so the ceiling that
 * matters is throughput, not spend: at twenty an hour the funder is never
 * queueing registrations behind each other for longer than a few minutes.
 */
export const DEFAULT_ALIAS_MAX_PER_HOUR = 20;
/**
 * 0.002 NIGHT into the account itself. Twice the wallet drip because it is the
 * account's opening balance rather than a one-transaction allowance: it covers
 * a `.night` registration at any label length (600 atomic at worst) and still
 * leaves the user something to move.
 */
export const DEFAULT_ACCOUNT_GRANT_ATOMIC = 2_000n;
/**
 * Higher than the alias ceiling and lower than the drip one. An account funding
 * is one proof and one transaction — cheaper than a sponsored registration,
 * dearer than a transfer — so throughput sits between the two.
 */
export const DEFAULT_ACCOUNT_MAX_PER_HOUR = 30;
export const DEFAULT_ALLOWED_ORIGINS = ['https://midnightpassport.com'];
export const DEFAULT_PORT = 8799;

/** Resolves endpoints for a network, with per-endpoint env overrides. */
export function networkEndpoints(
  networkId: string,
  env: NodeJS.ProcessEnv = process.env,
): FunderNetworkEndpoints {
  const defaults = NETWORK_DEFAULTS[networkId];
  const indexerHttpUrl = trimmed(env.FUNDER_INDEXER_URL) ?? defaults?.indexer;
  const nodeUrl = trimmed(env.FUNDER_NODE_URL) ?? defaults?.node;
  const provingServerUrl = trimmed(env.FUNDER_PROVER_URL) ?? defaults?.prover;
  if (!indexerHttpUrl || !nodeUrl || !provingServerUrl) {
    throw new Error(
      `No default endpoints are known for network "${networkId}". Set FUNDER_INDEXER_URL, FUNDER_NODE_URL, and FUNDER_PROVER_URL explicitly, or use one of: ${Object.keys(NETWORK_DEFAULTS).join(', ')}.`,
    );
  }
  return {
    indexerHttpUrl,
    indexerWsUrl: trimmed(env.FUNDER_INDEXER_WS_URL) ?? indexerWsFrom(indexerHttpUrl),
    nodeUrl,
    relayUrl: relayFrom(nodeUrl),
    provingServerUrl,
  };
}

/**
 * Minimal dotenv: when FUNDER_ENV_FILE names a file, its `KEY=VALUE` lines
 * (optionally `export`-prefixed, `#` comments ignored) are merged into the
 * environment — the real environment always wins over the file. This is how a
 * deployment keeps its seed in a mode-600 file instead of a shell history:
 *
 *   FUNDER_ENV_FILE=~/.midnight-passport-funder.env npm start
 *
 * `node --env-file=<path> dist/server.mjs` achieves the same with Node's own
 * loader; this variable exists so `npm start` and Docker can do it too.
 */
export function applyEnvFile(env: NodeJS.ProcessEnv = process.env): void {
  const path = env.FUNDER_ENV_FILE?.trim();
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FunderConfig {
  const networkId = trimmed(env.FUNDER_NETWORK) ?? 'preview';
  const seedHex = trimmed(env.FUNDER_SEED) ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error(
      'FUNDER_SEED must be 64 hex characters (a 32-byte wallet seed). Run `npm run generate-seed` to create one, faucet its address once, and export it.',
    );
  }

  const dripRaw = trimmed(env.FUNDER_DRIP_ATOMIC);
  let dripAtomic = DEFAULT_DRIP_ATOMIC;
  if (dripRaw) {
    dripAtomic = BigInt(dripRaw);
    if (dripAtomic <= 0n) throw new Error('FUNDER_DRIP_ATOMIC must be a positive integer.');
  }

  const maxPerHour = Number(trimmed(env.FUNDER_MAX_PER_HOUR) ?? DEFAULT_MAX_PER_HOUR);
  if (!Number.isInteger(maxPerHour) || maxPerHour <= 0) {
    throw new Error('FUNDER_MAX_PER_HOUR must be a positive integer.');
  }

  const aliasMaxPerHour = Number(
    trimmed(env.FUNDER_ALIAS_MAX_PER_HOUR) ?? DEFAULT_ALIAS_MAX_PER_HOUR,
  );
  if (!Number.isInteger(aliasMaxPerHour) || aliasMaxPerHour <= 0) {
    throw new Error('FUNDER_ALIAS_MAX_PER_HOUR must be a positive integer.');
  }

  const grantRaw = trimmed(env.FUNDER_ACCOUNT_GRANT_ATOMIC);
  let accountGrantAtomic = DEFAULT_ACCOUNT_GRANT_ATOMIC;
  if (grantRaw) {
    accountGrantAtomic = BigInt(grantRaw);
    if (accountGrantAtomic <= 0n) {
      throw new Error('FUNDER_ACCOUNT_GRANT_ATOMIC must be a positive integer.');
    }
  }

  const accountMaxPerHour = Number(
    trimmed(env.FUNDER_ACCOUNT_MAX_PER_HOUR) ?? DEFAULT_ACCOUNT_MAX_PER_HOUR,
  );
  if (!Number.isInteger(accountMaxPerHour) || accountMaxPerHour <= 0) {
    throw new Error('FUNDER_ACCOUNT_MAX_PER_HOUR must be a positive integer.');
  }

  /* An empty string here is not a misconfiguration — it is a network with no
     shared registry. `/register-alias` refuses on it with a named reason
     instead of the service failing to start. */
  const midnamesTldAddress =
    trimmed(env.FUNDER_MIDNAMES_TLD_ADDRESS) ?? MIDNAMES_TLD_ADDRESSES[networkId] ?? '';

  const allowedOrigins = (trimmed(env.FUNDER_ALLOWED_ORIGINS) ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return {
    networkId,
    ...networkEndpoints(networkId, env),
    seedHex,
    stateDir: trimmed(env.FUNDER_STATE_DIR) ?? './state',
    dripAtomic,
    maxPerHour,
    aliasMaxPerHour,
    accountGrantAtomic,
    accountMaxPerHour,
    accountAssetsPath: trimmed(env.FUNDER_ACCOUNT_ASSETS),
    midnamesTldAddress,
    midnamesAssetsPath: trimmed(env.FUNDER_MIDNAMES_ASSETS),
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : [...DEFAULT_ALLOWED_ORIGINS],
    port: Number(trimmed(env.FUNDER_PORT) ?? DEFAULT_PORT),
    host: trimmed(env.FUNDER_HOST) ?? '0.0.0.0',
  };
}
