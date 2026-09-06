/**
 * A second opinion on whether the chain is moving: the PUBLIC node's head,
 * asked over plain HTTPS, by a probe that shares nothing with the connections
 * this service is trying to judge.
 *
 * WHY THE WALLET CANNOT ANSWER THIS QUESTION ABOUT ITSELF
 * ------------------------------------------------------
 * On 2026/09/05 the sponsor's node websocket died at about 14:48 UTC. The
 * watchdog's only staleness signal is `stallMs` in `./health.ts`, and it waits
 * for THIRTY MINUTES of the wallet's own sync indices standing still — so the
 * first word of trouble was `degraded: the wallet's sync indices have not moved
 * in 40 min` at 15:28, forty minutes after the fault and half an hour of dead
 * sponsorships too late.
 *
 * That patience is not laziness; it is the only safe setting for a signal with
 * one input. A wallet watching its own indices cannot tell
 *
 *     "nothing relevant has happened on chain for a while"   (quiet, fine)
 *
 * from
 *
 *     "I have stopped being told what is happening"          (cut off, not fine)
 *
 * because both read identically from the inside: indices that do not move.
 * Half an hour is how long a quiet stagenet was judged able to go without
 * producing anything this wallet cares about, and so half an hour is how long
 * the fault had to be tolerated too.
 *
 * A second, INDEPENDENT observer breaks the tie. Stagenet produces a block
 * about every six seconds whatever this service is doing, so if the public
 * node's head has climbed fifty blocks while the wallet's indices have not
 * moved at all, "the chain is quiet" is no longer one of the explanations. That
 * is a five-minute verdict rather than a thirty-minute one, and it is the whole
 * reason this module exists.
 *
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------
 *   - NOT the wallet's connection. It opens its own HTTPS request each time, so
 *     a socket, provider, or subscription that has died cannot make this probe
 *     lie by dying with it. That independence is the entire value; sharing a
 *     transport with the thing under test would make it a mirror, not a second
 *     opinion.
 *   - NOT a source of exceptions. `read()` resolves for every outcome —
 *     timeout, DNS failure, 502, a body that is not JSON, a `number` that is
 *     not a hex string. A probe that could throw into the health ladder would
 *     turn "the public node is having a moment" into "the wallet is unreadable",
 *     which is a restart-eligible verdict, and it would do it for a fault that
 *     is not this service's at all.
 *   - NOT unbounded. Five seconds, and the health tick is minutes, so a hung
 *     node costs the watchdog five seconds of a tick and nothing else.
 *   - NOT authoritative on its own. A failing probe means the second opinion is
 *     unavailable, and `./health.ts` falls back to the old thirty-minute rule
 *     rather than concluding anything. No verdict is ever reached BECAUSE this
 *     probe failed.
 *
 * THE CALL
 * --------
 * `chain_getHeader` with no parameters, which every Substrate node answers with
 * its current best header. Measured against stagenet on 2026/09/06:
 *
 *     POST https://rpc.stagenet.shielded.tools
 *     {"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}
 *
 *     {"jsonrpc":"2.0","id":1,"result":{"parentHash":"0xe7a6…","number":"0x537ff",…}}
 *
 * `0x537ff` is 342,015. `number` is the only field read; everything else in the
 * header is ignored.
 *
 * It is deliberately the cheapest call that answers the question. `chain_getHeader`
 * returns one header — a few hundred bytes — and asks the node for nothing it
 * does not already hold at the tip.
 */

/* -------------------------------------------------------------------------- */
/* The reading                                                                */
/* -------------------------------------------------------------------------- */

export interface ChainHeadReading {
  /**
   * The last head height this probe successfully read, or `null` if it has
   * never read one.
   *
   * DELIBERATELY STICKY. A failed probe leaves the last good height in place
   * rather than blanking it, so `at` ages and the staleness of the reading is
   * what a caller judges it by. Blanking it would throw away the one figure
   * that makes a late-arriving verdict possible.
   */
  height: number | null;
  /** When {@link height} was read, in epoch milliseconds. `null` with it. */
  at: number | null;
  /**
   * Probes that have failed since the last one that did not.
   *
   * The gate on the second opinion: a caller uses the head only while this is
   * zero, because a stale height with a moving clock would otherwise read as a
   * head that has stopped — which is a fault this probe is not entitled to
   * report.
   */
  probeFailures: number;
  /** Probes attempted, ever, this process. */
  probes: number;
  /** Probes that failed, ever, this process. */
  failures: number;
  /** Why the last failure failed, for `/status`. `null` after a success. */
  lastError: string | null;
}

/* -------------------------------------------------------------------------- */
/* The fetch seam                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Just enough of `fetch` to make the request and read the body — structural, so
 * a test supplies a two-line function and the real one is passed through
 * unchanged.
 */
export interface ChainHeadResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface ChainHeadRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type ChainHeadFetch = (
  url: string,
  init: ChainHeadRequest,
) => Promise<ChainHeadResponse>;

/* -------------------------------------------------------------------------- */
/* The URL                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The node's JSON-RPC endpoint over HTTP, derived from the WebSocket URL the
 * service is already configured with.
 *
 * Substrate nodes serve JSON-RPC on both transports at the same host and path,
 * so stagenet's `wss://rpc.stagenet.shielded.tools` is
 * `https://rpc.stagenet.shielded.tools` — verified against the live node on
 * 2026/09/06. `preview` and `preprod` are configured with `https` URLs already
 * (see `NETWORK_DEFAULTS` in `./config.ts`) and pass through untouched, as does
 * the `http://localhost:19944` of an undeployed node.
 *
 * The mapping is exactly the inverse of `relayFrom` in `./config.ts`, and it is
 * kept here rather than there because it is this module's business what
 * transport it wants: the relay's WebSocket is the connection under test.
 */
export function chainHeadUrl(nodeUrl: string): string {
  if (nodeUrl.startsWith('wss:')) return `https:${nodeUrl.slice('wss:'.length)}`;
  if (nodeUrl.startsWith('ws:')) return `http:${nodeUrl.slice('ws:'.length)}`;
  return nodeUrl;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `result.number` as a block height, or `null` if the body is not a header this
 * probe recognises.
 *
 * Substrate answers with a hex string (`"0x537ff"`), but the shape is asserted
 * rather than assumed: a decimal string and a plain number are both accepted,
 * because a proxy or a differently-configured node answering in one of those
 * is a reading this probe can still use, and refusing it would mean falling
 * back to the thirty-minute rule for no reason. Anything else — a JSON-RPC
 * `error`, a missing `result`, a `number` that is not finite or is negative —
 * is `null`, which the caller counts as a failure.
 */
export function parseChainHead(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const result = (body as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) return null;
  const raw = (result as { number?: unknown }).number;

  let height: number;
  if (typeof raw === 'number') {
    height = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    /* `Number()` reads `0x…` as hex and a bare decimal as decimal, which is
       both forms in one call — but it also reads `''` as 0 and `'  12  '` as
       12, so the emptiness is ruled out above and the shape below. */
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) return null;
    height = Number(trimmed);
  } else {
    return null;
  }

  if (!Number.isFinite(height) || !Number.isInteger(height) || height < 0) return null;
  return height;
}

/* -------------------------------------------------------------------------- */
/* The probe                                                                  */
/* -------------------------------------------------------------------------- */

export interface ChainHeadProbe {
  /** The endpoint being asked, for `/status` and the start-up log. */
  url: string;
  /** Ask the node. Never rejects; every outcome is in the reading. */
  read(): Promise<ChainHeadReading>;
  /** The last reading, without asking anything. */
  reading(): ChainHeadReading;
}

export interface ChainHeadProbeOptions {
  /** `config.nodeUrl` — converted to HTTP by {@link chainHeadUrl}. */
  nodeUrl: string;
  /** Five seconds, which is under one stagenet block. */
  timeoutMs?: number;
  now?: () => number;
  fetch?: ChainHeadFetch;
}

/** Five seconds: shorter than a health tick by two orders of magnitude. */
export const DEFAULT_CHAIN_HEAD_TIMEOUT_MS = 5_000;

export function createChainHeadProbe(options: ChainHeadProbeOptions): ChainHeadProbe {
  const url = chainHeadUrl(options.nodeUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHAIN_HEAD_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const call: ChainHeadFetch =
    options.fetch ?? ((target, init) => fetch(target, init));

  const state: ChainHeadReading = {
    height: null,
    at: null,
    probeFailures: 0,
    probes: 0,
    failures: 0,
    lastError: null,
  };

  const fail = (detail: string): ChainHeadReading => {
    state.failures += 1;
    state.probeFailures += 1;
    state.lastError = detail;
    return { ...state };
  };

  return {
    url,
    reading: () => ({ ...state }),
    read: async (): Promise<ChainHeadReading> => {
      state.probes += 1;
      let response: ChainHeadResponse;
      try {
        response = await call(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'chain_getHeader',
            params: [],
          }),
          /* Bounded here rather than by a race, so the request is actually
             cancelled and not merely stopped being waited on. Node's timeout
             signal does not hold the event loop open. */
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }

      if (!response.ok) return fail(`the node answered ${response.status}`);

      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        return fail(
          `the node's answer was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      const height = parseChainHead(body);
      if (height === null) return fail('the node answered without a readable header number');

      state.height = height;
      state.at = now();
      state.probeFailures = 0;
      state.lastError = null;
      return { ...state };
    },
  };
}
