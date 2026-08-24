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
  };
}
