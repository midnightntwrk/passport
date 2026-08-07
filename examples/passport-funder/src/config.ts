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
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : [...DEFAULT_ALLOWED_ORIGINS],
    port: Number(trimmed(env.FUNDER_PORT) ?? DEFAULT_PORT),
    host: trimmed(env.FUNDER_HOST) ?? '0.0.0.0',
  };
}
