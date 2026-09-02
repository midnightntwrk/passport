/**
 * Sponsored fees — a minimal ProofStation balance-service client.
 *
 * The demo's promise is that a name registration and a raffle entry cost the
 * user nothing. That promise is kept by a *sponsor*: a service that owns DUST,
 * adds the fee input to a transaction the user has already built, proved, and
 * signed, and hands the balanced transaction back for the user's own wallet to
 * submit. The user's NIGHT never moves to pay a fee, and the user's approval
 * moment is untouched — sponsorship removes the cost, not the signing.
 *
 * This is a deliberately small port of the 1AM wallet's balance-service client
 * (`packages/wallet-core/src/network/balance-service-{client,policy}.ts` on
 * `one-am-wallet-william` `origin/main`), carrying only the two endpoints this
 * demo needs and none of the wallet-settings machinery:
 *
 *   POST {base}/balance-only   raw serialised PROVEN transaction bytes in,
 *                              `{ txHash, txBytes, expiresAt }` out.
 *   GET  {base}/wallet-status  `{ total, available, wallets[] }`.
 *
 * Three rules make this honest by construction:
 *
 *   1. **On by default, off by one word.** Each public network carries a
 *      default gateway (see `DEFAULT_SPONSOR_URLS` — decided 2026/08/07,
 *      because a fresh passkey wallet holds no DUST and default-off failed
 *      every first transaction). `VITE_SPONSOR_URL` overrides it, and the
 *      literal `off` is REFUSED at configuration time, naming the variable:
 *      the passkey wallet holds no DUST, so an unsponsored build cannot pay
 *      for its one deploy, and the mistake belongs before the ship, not in
 *      front of a user at their first transaction.
 *   2. **`available > 0`, not "ready".** The upstream `isBalanceServiceReady`
 *      returns `true` for a wallet that is merely *synced* — which is precisely
 *      the state the deployed preview gateway is in today (`total: 1`,
 *      `available: 0`, dust balance `"0"`, `unavailableCause:
 *      INSUFFICIENT_DUST`). Gating on that would make the demo claim a free
 *      transaction and then fail. We gate on `available > 0` only.
 *   3. **Never a silent claim.** A caller may only report a covered fee when a
 *      real `/balance-only` response came back and the transaction it returned
 *      is the one that was submitted. Everything else falls back to the
 *      unsponsored path, real fees and all.
 *
 * `/ready` is NOT used: it is the legacy check and 404s on the deployed
 * gateway. `/wallet-status` is the deployed truth.
 *
 * MORE THAN ONE SPONSOR (2026/08/31)
 * ----------------------------------
 * `VITE_SPONSOR_URL` now takes a COMMA-SEPARATED, ORDERED list, and a list of
 * one is byte-for-byte the behaviour it had when it was a single URL. Rule 1
 * above is unchanged, rule 3 is unchanged, and rule 2 is now applied per
 * endpoint: the first one that reports `available > 0` serves, and an endpoint
 * that cannot — or that fails mid-request — is fallen through to the next.
 *
 * The reason is not redundancy for its own sake. Proving, fee sponsorship,
 * sponsored name registration, and activation grants all rode ONE droplet, and
 * two of those four have a second provider available on stagenet: the 1AM
 * gateway at `https://api-stagenet.1am.xyz`, which serves `GET /wallet-status`
 * and `POST /balance-only` on exactly this contract and accepts them
 * anonymously (probed 2026/08/31 — a deliberately malformed body came back
 * `400 INVALID_TX`, not `401`, so no API key is involved). `/register-alias`
 * and `/fund-account` are ours alone and stay on our balancer; nothing in this
 * module touches them.
 *
 * WHAT A SECOND SPONSOR IS NOT ALLOWED TO CHANGE. The refusal vocabulary. If
 * every endpoint refuses, the user reads the same sentence they read when one
 * endpoint refused — see {@link combineSponsorReadiness}, which folds a list of
 * answers into exactly one of the states {@link sponsorRefusal} already knows
 * how to speak about. The endpoint names and their diagnostics travel in
 * `reason`, which belongs in a log and nowhere else.
 *
 * Service state on 2026/08/05 (probed live over HTTPS at
 * `https://api-preview.1am.xyz`): healthy cluster, one balance wallet, fully
 * synced, zero DUST, therefore `available: 0` and `/balance-only` answering
 * `503 { error: 'WALLETS_UNAVAILABLE', cause: 'INSUFFICIENT_DUST' }`. Until the
 * sponsor wallet
 * `mn_addr_preview1emdcrp6c8l7n8z3uwtm8mtqtxywyur4aqlte8qh8nafyvzd26c5q0k5elf`
 * holds DUST, this module correctly reports `unavailable` and nothing in the
 * demo changes.
 */

import {
  describeEndpointRefusals,
  firstEndpointThatServes,
  parseEndpointList,
} from './endpoints.js';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** How long a readiness probe is trusted before it is taken again. */
export const SPONSOR_READINESS_TTL_MS = 30_000;
/** Upper bound on the whole 429 `PENDING_TRANSACTION` retry window. */
export const SPONSOR_PENDING_RETRY_WINDOW_MS = 20_000;
/**
 * The same window for a CONTRACT transaction, which is a different bet.
 *
 * 20 seconds is right for a transfer: the wallet can pay its own fee, so giving
 * up early costs a slower path, not a failed one. A contract deploy from a
 * fresh passkey wallet has NO fall-back — it holds no DUST — so giving up early
 * costs the whole operation, and the operation already takes tens of seconds.
 *
 * Ten minutes, and every shorter value here was measured and found wanting
 * against the stagenet balancer on 2026/08/24. It proves the DUST leg
 * in-process with the WASM prover, having first fetched and warmed ~32 MB of
 * circuit keys, and it serialises balancing so a caller who arrives mid-proof
 * is told `429 PENDING_TRANSACTION` and has to wait the whole thing out. Three
 * observed service times: ~100 s, ~180 s, and one over 180 s. At 20 s and again
 * at 180 s the client gave up while the sponsor was working correctly and went
 * on to finish.
 *
 * Giving up early is worse than waiting in a second way, too, and this is the
 * part that decided the number. The service reserves its DUST for a balanced
 * transaction the moment it finalizes one, and an abandoned request leaves that
 * reservation standing until it expires — so an impatient client does not just
 * fail itself, it takes the sponsor's DUST out of circulation for everyone,
 * for far longer than it would have waited. Measured: two abandoned requests
 * put the sponsor at `available: 0` for roughly twenty minutes each.
 *
 * Ten minutes still sits inside the balanced transaction's own TTL (thirty
 * minutes, see DEFAULT_TTL_MS in `../identity/contractRuntime.ts`), so a client
 * that waits the full window never submits something already expired.
 */
export const SPONSOR_CONTRACT_RETRY_WINDOW_MS = 600_000;
/**
 * Floor on a retry delay, so a zero `retryAfterMs` cannot spin.
 *
 * Two seconds since 2026/09/02, up from 250 ms, because the window this
 * measures is no longer only a `429 PENDING_TRANSACTION`. The refusals that
 * now repeat a round — `INSUFFICIENT_DUST`, `WALLET_SYNCING` — clear when the
 * balancer's own change settles, and that takes 20 to 60 seconds after each
 * spend it makes. A quarter-second poll against a condition with that shape is
 * two hundred pointless POSTs and a rate limit; two seconds is ten.
 */
const SPONSOR_PENDING_RETRY_MIN_DELAY_MS = 2_000;
/**
 * Ceiling on a retry delay. A service that asks for a longer wait than this is
 * asked again sooner: the window as a whole is what bounds the waiting, and a
 * single `retryAfterMs: 120000` would otherwise spend the user's entire budget
 * in one sleep and never re-probe a sponsor that recovered in five seconds.
 */
const SPONSOR_PENDING_RETRY_MAX_DELAY_MS = 10_000;
/** Fallback delay when the service names no `retryAfterMs`. */
const SPONSOR_PENDING_RETRY_DEFAULT_DELAY_MS = 2_000;
/** A readiness probe must not hold a send hostage. */
const SPONSOR_STATUS_TIMEOUT_MS = 6_000;
/**
 * The SECOND probe attempt's timeout, deliberately much shorter than the
 * first. The incident that motivated retrying at all was a fast unparseable
 * `200`, not a slow host, so a retry that could itself burn six seconds would
 * buy nothing and double the worst case a caller has to wait through.
 */
const SPONSOR_STATUS_RETRY_TIMEOUT_MS = 2_000;
/**
 * The wait between a transport-failed sponsor call and its one retry. Driven
 * through `SponsorClientOptions.sleep` so a test never really waits; used by
 * both retrying paths — the readiness probe and the `/balance-only` POST.
 */
export const SPONSOR_PROBE_RETRY_DELAY_MS = 500;
/**
 * Balancing proves a dust segment server-side, so it gets real room.
 *
 * 600 s rather than the 90 s it was until 2026/08/24, measured rather than
 * guessed: the stagenet balancer proves in-process with the WASM prover and
 * warms ~32 MB of circuit keys first, and its observed service times were
 * ~100 s, ~180 s, and one longer still. At 90 s — and again at 180 s — the
 * client aborted a request the sponsor then completed, which fails the caller
 * AND leaves the sponsor's DUST reserved against a balanced transaction nobody
 * will submit. Kept equal to {@link SPONSOR_CONTRACT_RETRY_WINDOW_MS} so that
 * neither bound can silently undercut the other.
 */
const SPONSOR_BALANCE_TIMEOUT_MS = 600_000;

export interface SponsorConfig {
  /** Base URL, no trailing slash. */
  url: string;
  apiKey?: string;
  clientId?: string;
}

/**
 * The token kinds a sponsored transaction balances *locally*, mirroring
 * `BALANCE_WITHOUT_DUST` in the 1AM runtime.
 *
 * The sponsor owns DUST and nothing else. It cannot supply the user's NIGHT or
 * shielded coins, and a transaction handed over with those legs unbalanced is
 * rejected by the node (error 138, `BalanceCheckOverspend`). So the wallet
 * balances every kind except DUST before it asks, and the fee input — the one
 * thing that would otherwise cost the user — is all the service adds.
 */
export const BALANCE_WITHOUT_DUST: ('shielded' | 'unshielded')[] = ['shielded', 'unshielded'];

/**
 * Vite replaces `import.meta.env` at build time; under plain Node — which is
 * how the wallet's live behaviour gets measured against a real chain before
 * anything ships — there is no such object. An absent one reads as "nothing
 * configured", which for sponsorship means `disabled`. Same shim as
 * `localWallet.ts`; found on 2026/08/06 when a Node harness for
 * `subscribeBalances` died in `sponsorConfig` on the bare read.
 */
function environment(): Record<string, string | undefined> {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  /* The `?? {}` half is the Node-harness case in the comment above. Under
     vitest and in the browser `import.meta.env` always exists, and a test
     cannot delete it from ANOTHER module's `import.meta`, so that branch is
     unreachable from a unit test. Every caller below takes an explicit env
     object instead, and those are drilled. */
  /* v8 ignore next */
  return env ?? {};
}

function trimmed(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

/**
 * The gateway each public network sponsors through when nothing overrides it.
 * Sponsorship is ON BY DEFAULT (decided 2026/08/07): a fresh passkey wallet
 * holds no DUST, so without a sponsor its first transaction is impossible —
 * default-off made every new user's first attempt fail. A devnet has no entry
 * and stays unsponsored unless a URL is set explicitly.
 */
const DEFAULT_SPONSOR_URLS: Record<string, string> = {
  /* Stagenet is sponsored by our OWN balancer rather than a 1AM gateway,
     because there is no 1AM gateway on stagenet. It speaks the identical wire
     contract — `GET /wallet-status` and `POST /balance-only`, same bodies,
     same error codes — so nothing else in this module changes. Probed live
     2026/08/24: `{"total":1,"available":1,…,"dust":{"balance":
     "288384879317778538","utxoCount":3,"isSynced":true}}`, i.e. genuinely
     able to pay, which is the only thing rule 2 below accepts.

     The HOST changed on 2026/09/02, and this line is why the change had to
     reach the source rather than only the deployment: the old name still
     resolves, but to a RECYCLED address (the 1 GB droplet it named was deleted
     on 2026/08/27 and its IP handed to somebody else), so a build that fell
     back to this default reached a stranger's Caddy rather than our balancer.
     The balancer moved to the 8 GB droplet at 67.205.177.162 and is served
     over its sslip.io name, which needs no DNS record to be right. */
  stagenet: 'https://67-205-177-162.sslip.io/balancer',
  preview: 'https://api-preview.1am.xyz',
  preprod: 'https://api-preprod.1am.xyz',
};

/**
 * Reads the sponsor configuration from the environment, in the operator's own
 * order.
 *
 *   VITE_SPONSOR_URL         base URL of the ProofStation gateway, or SEVERAL
 *                            separated by commas and tried left to right.
 *                            Unset falls back to the network's default
 *                            gateway; the literal `off` is refused outright,
 *                            because a build with no sponsor cannot pay.
 *   VITE_SPONSOR_API_KEY     optional `X-API-Key`.
 *   VITE_SPONSOR_CLIENT_ID   optional `X-Client-ID`.
 *
 * Returns an EMPTY list when the network has no gateway, THROWS when
 * `VITE_SPONSOR_URL` is the literal `off` — an unsponsored build cannot pay
 * for its one deploy, so that is a refusal at start-up rather than a failure
 * at the first transaction — and throws when any URL in the list could leak a
 * signed transaction
 * over plaintext — a bad entry is refused at configuration time rather than
 * quietly skipped at send time, because an endpoint silently dropped from a
 * failover list is a single point of failure nobody knows they have.
 *
 * The credentials are shared across the list. Both are optional and neither is
 * needed by the two gateways this build ships with: our own balancer takes no
 * key, and the 1AM stagenet gateway serves `/wallet-status` and
 * `/balance-only` anonymously (an API key there is for `/rpc/midnight` and
 * `/api/v4/graphql`, which nothing here uses).
 */
export function sponsorConfigs(
  env: Record<string, string | undefined> = environment(),
): SponsorConfig[] {
  const explicit = trimmed(env.VITE_SPONSOR_URL);
  if (explicit === 'off') {
    /* Refused here rather than answered with an empty list. The passkey wallet
       holds no DUST, so an unsponsored build cannot pay for its one deploy —
       an empty list only surfaced that at the first transaction, in front of
       whoever was using the Passport. Naming the variable makes it a build
       mistake somebody can fix before shipping. */
    throw new Error(
      'VITE_SPONSOR_URL is set to `off`, which leaves this build with no way to pay ' +
        'for its first transaction. Point VITE_SPONSOR_URL at a sponsor service, or ' +
        'unset it to use the network default.',
    );
  }
  const raw =
    explicit ??
    DEFAULT_SPONSOR_URLS[trimmed(env.VITE_MIDNIGHT_NETWORK_ID) ?? 'stagenet'];
  if (!raw) return [];
  const apiKey = trimmed(env.VITE_SPONSOR_API_KEY);
  const clientId = trimmed(env.VITE_SPONSOR_CLIENT_ID);
  return parseEndpointList(raw).map((url) => {
    assertSecureSponsorUrl(url);
    const config: SponsorConfig = { url };
    if (apiKey) config.apiKey = apiKey;
    if (clientId) config.clientId = clientId;
    return config;
  });
}

/**
 * The FIRST configured sponsor, or `null` when there is none.
 *
 * Kept because a caller that only wants to know "is sponsorship configured at
 * all, and where does it point first" should not have to reason about a list.
 * Every path that actually sponsors a transaction goes through
 * {@link sponsorConfigs} and honours the whole of it.
 */
export function sponsorConfig(
  env: Record<string, string | undefined> = environment(),
): SponsorConfig | null {
  return sponsorConfigs(env)[0] ?? null;
}

/**
 * A signed, proved transaction is going over this wire. Anything other than
 * HTTPS — localhost excepted, for a developer running a gateway on the same
 * machine — is refused rather than downgraded.
 */
export function assertSecureSponsorUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid sponsor service URL: ${url}`);
  }
  const isLocalhost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]';
  if (!isLocalhost && parsed.protocol !== 'https:') {
    throw new Error(
      `Insecure sponsor service URL: ${parsed.protocol}// — HTTPS is required for anything but localhost.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Wire types and their parsers                                               */
/* -------------------------------------------------------------------------- */

/** The `/balance-only` success body. `txBytes` is the balanced transaction. */
export interface SponsorBalanceResult {
  txHash: string;
  /** Hex, without a `0x` prefix, even length. */
  txBytes: string;
  /** ISO timestamp after which the balanced transaction is stale. May be ''. */
  expiresAt: string;
}

/**
 * A balanced transaction, plus WHICH sponsor paid for it.
 *
 * The provider is carried out of {@link sponsorBalanceOnly} rather than only
 * logged inside it, because "where was this transaction's fee paid" is a
 * question an operator asks after the fact, about a specific transaction, and
 * a log line that scrolled past cannot answer it. It is an operator's fact and
 * only an operator's: no surface renders it, and constraint (b) is why — a
 * user reading a screen must meet no wallet, DUST, contract, registry,
 * indexer, or resolver vocabulary, and a gateway hostname is all of those at
 * once.
 */
export interface SponsoredBalance extends SponsorBalanceResult {
  /** The base URL of the endpoint that balanced this transaction. */
  servedBy: string;
}

export interface SponsorWalletStatus {
  total: number;
  available: number;
  wallets: Array<{
    index: number;
    ready: boolean;
    syncState?: string;
    dust: { balance: string; utxoCount: number; isSynced: boolean };
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HEX_PATTERN = /^[0-9a-fA-F]*$/;

/** Normalises `0x`-prefixed or bare hex, refusing anything that is not hex. */
export function normaliseSponsorHex(value: string): string {
  const body = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (body.length === 0 || body.length % 2 !== 0 || !HEX_PATTERN.test(body)) {
    throw new Error('The sponsor service returned a transaction that is not hex.');
  }
  return body.toLowerCase();
}

export function sponsorHexToBytes(value: string): Uint8Array {
  const hex = normaliseSponsorHex(value);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Accepts a `/balance-only` body only when it carries both a transaction hash
 * and real hex transaction bytes. A missing or malformed field is a failure,
 * never a partially-filled result: the caller would otherwise submit nothing
 * and report a covered fee.
 */
export function validateSponsorBalanceResult(body: unknown): SponsorBalanceResult {
  if (!isRecord(body)) {
    throw new Error('The sponsor service returned a response that is not an object.');
  }
  if (typeof body.txHash !== 'string' || body.txHash.length === 0) {
    throw new Error('The sponsor service response is missing txHash.');
  }
  if (typeof body.txBytes !== 'string' || body.txBytes.length === 0) {
    throw new Error('The sponsor service response is missing txBytes.');
  }
  return {
    txHash: body.txHash,
    txBytes: normaliseSponsorHex(body.txBytes),
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : '',
  };
}

/** Parses `/wallet-status`. `null` for any body that is not that shape. */
export function parseSponsorWalletStatus(body: unknown): SponsorWalletStatus | null {
  if (!isRecord(body)) return null;
  if (typeof body.total !== 'number' || typeof body.available !== 'number') return null;
  const wallets = (Array.isArray(body.wallets) ? body.wallets : []).filter(isRecord).map((wallet) => {
    const dust = isRecord(wallet.dust) ? wallet.dust : {};
    const entry: SponsorWalletStatus['wallets'][number] = {
      index: typeof wallet.index === 'number' ? wallet.index : -1,
      ready: wallet.ready === true,
      dust: {
        balance: typeof dust.balance === 'string' ? dust.balance : '0',
        utxoCount: typeof dust.utxoCount === 'number' ? dust.utxoCount : 0,
        isSynced: dust.isSynced === true,
      },
    };
    if (typeof wallet.syncState === 'string') entry.syncState = wallet.syncState;
    return entry;
  });
  return { total: body.total, available: body.available, wallets };
}

/**
 * The gate. Strictly `available > 0` — see rule 2 in the module header. A
 * wallet that is `ready: true`, `syncState: 'ready'`, and `dust.isSynced: true`
 * with a zero DUST balance is exactly what the preview gateway reports today,
 * and it cannot sponsor anything.
 */
export function sponsorWalletIsAvailable(status: SponsorWalletStatus | null): boolean {
  return status !== null && status.available > 0;
}

/** Why the sponsor could not be used, in words a log line can carry. */
export function describeSponsorWalletStatus(status: SponsorWalletStatus): string {
  const causes = status.wallets
    .map((wallet) => `#${wallet.index} dust ${wallet.dust.balance}`)
    .join(', ');
  return `sponsor reports ${status.available}/${status.total} wallets available${
    causes ? ` (${causes})` : ''
  }`;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A named failure from the balance service. Carries the HTTP status so a
 * caller can tell "the service said no" from "the service was not there".
 */
export class SponsorError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly retryAfterMs?: number;

  constructor(status: number, code: string, detail: string, retryAfterMs?: number) {
    super(`${code}: ${detail}`);
    this.name = 'SponsorError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }

  /**
   * Worth asking again, on this endpoint, inside the caller's window.
   *
   * WHAT THIS COVERS, AND WHY EACH ONE IS TRANSIENT. Every code here names a
   * condition the balancer clears without anybody doing anything, and each one
   * was observed refusing a real send on 2026/09/02:
   *
   *   503 `INSUFFICIENT_DUST`      the sponsor's own change is nullified for
   *   503 `WALLET_SYNCING`         20-60 s after each spend it makes, and it
   *   503 `WALLETS_UNAVAILABLE`    makes five during an activation.
   *   503 `PROVER_UNAVAILABLE`     the proof server is mid-restart.
   *   502 `BALANCE_FAILED`         the dust leg's proof failed once.
   *   429 `PENDING_TRANSACTION`    balancing is serialised; somebody is ahead.
   *   429 anything else            the per-client rate limit, added the same
   *                                day, which answers with `retryAfterMs`.
   *
   * Everything else is NOT retryable and must not be, which is the half that
   * matters more: a `400 INVALID_TRANSACTION` is a transaction the service will
   * refuse identically forever, and re-posting it is a slower way of telling
   * the user the same thing while holding their sheet open.
   *
   * This used to be `status === 503` alone, and that is what made the NIGHT
   * send fail at step one: the client retried only `429 PENDING_TRANSACTION`,
   * fell through to the gateway on a 503 the balancer would have cleared in
   * twenty seconds, and the leg it built there was proved against a contract
   * state that had already moved.
   */
  get isRetryable(): boolean {
    if (this.status === 429) return true;
    if (this.status === 502) return this.code === 'BALANCE_FAILED';
    if (this.status !== 503) return false;
    return (
      this.code === 'INSUFFICIENT_DUST' ||
      this.code === 'WALLET_SYNCING' ||
      this.code === 'WALLETS_UNAVAILABLE' ||
      this.code === 'PROVER_UNAVAILABLE'
    );
  }

  get isWalletSyncing(): boolean {
    return this.code === 'WALLET_SYNCING';
  }

  get isInsufficientDust(): boolean {
    return this.code === 'INSUFFICIENT_DUST';
  }

  /** 429 — a sponsor wallet is mid-transaction; worth waiting out. */
  get isPendingTransaction(): boolean {
    return (
      this.status === 429 &&
      (this.code === 'PENDING_TRANSACTION' ||
        /already pending/i.test(this.detail) ||
        /already pending/i.test(this.message))
    );
  }
}

/** Builds a {@link SponsorError} from an error body, inventing no fields. */
export function createSponsorError(status: number, body: unknown): SponsorError {
  const record = isRecord(body) ? body : {};
  const rawCode = typeof record.error === 'string' ? record.error : undefined;
  const message = typeof record.message === 'string' ? record.message : undefined;
  const cause = typeof record.cause === 'string' ? record.cause : undefined;
  /* BOTH, when both are given. The balancer puts the sentence in `message`
     and the underlying reason in `cause` — `{"error":"BALANCE_FAILED",
     "message":"Failed to prove transaction","cause":"Invalid Transaction:
     Custom error: 239"}` — and keeping only the first threw away the only
     thing in the body that says WHAT the node objected to. */
  const detail =
    message && cause ? `${message} (${cause})` : (message ?? cause ?? rawCode ?? `HTTP ${status}`);
  const retryAfterMs =
    typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)
      ? record.retryAfterMs
      : undefined;
  return new SponsorError(status, rawCode ?? 'UNKNOWN', detail, retryAfterMs);
}

/** How long to wait before a `PENDING_TRANSACTION` retry, given the budget. */
export function sponsorRetryDelayMs(retryAfterMs: number | undefined, remainingMs: number): number {
  const requested = retryAfterMs ?? SPONSOR_PENDING_RETRY_DEFAULT_DELAY_MS;
  /* Clamp what was ASKED FOR into [min, max] first, and only then cap it by
     what is left of the window. The two must happen in that order: capping
     first would let the floor push a sleep past a budget of 900 ms, and the
     budget is the one bound that exists to be honoured exactly. */
  const clamped = Math.max(
    SPONSOR_PENDING_RETRY_MIN_DELAY_MS,
    Math.min(requested, SPONSOR_PENDING_RETRY_MAX_DELAY_MS),
  );
  return Math.min(clamped, remainingMs);
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export interface SponsorClientOptions {
  /**
   * Exactly ONE endpoint, or `null` for none. The single-endpoint seam, kept
   * because most callers and every existing test mean one service when they
   * say `config`. {@link SponsorClientOptions.configs} wins when both are
   * given.
   */
  config?: SponsorConfig | null;
  /** The ordered list. Absent means "read the build's own environment". */
  configs?: SponsorConfig[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Total 429 retry budget. Defaults to 20 s; 0 disables retrying. */
  pendingRetryWindowMs?: number;
  /**
   * Ignores the cached readiness verdict and probes again.
   *
   * The cache exists so that a burst of fee gates on one send costs one HTTP
   * call. A surface that is WATCHING for the sponsor to come back needs the
   * opposite — a `busy` answer clears in about a minute, and a poll that read
   * a 30-second cache would tell the user to keep waiting for half the time it
   * was actually free. An in-flight probe is still joined rather than
   * duplicated.
   */
  force?: boolean;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function authHeaders(config: SponsorConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.apiKey) headers['X-API-Key'] = config.apiKey;
  if (config.clientId) headers['X-Client-ID'] = config.clientId;
  return headers;
}

/**
 * The endpoints one call should use, in order.
 *
 * Precedence is explicit-list, then explicit-single, then the build's own
 * environment. `config: null` is a deliberate "no sponsor" rather than "ask
 * the environment" — that distinction is drilled, because getting it backwards
 * would make a test that meant to disable sponsorship silently reach the real
 * default gateway.
 */
function resolveConfigs(options: SponsorClientOptions): SponsorConfig[] {
  if (options.configs !== undefined) return options.configs;
  if (options.config !== undefined) return options.config ? [options.config] : [];
  return sponsorConfigs();
}

/**
 * Readiness, in the three states a caller actually has to branch on.
 *
 *   `disabled`    — sponsorship is not configured for this build.
 *   `ready`       — the service answered and has a wallet that can pay.
 *   `unavailable` — configured, but not usable right now, with the reason.
 */
export type SponsorReadiness =
  | { state: 'disabled' }
  | { state: 'ready'; url: string; available: number }
  | { state: 'unavailable'; url: string; reason: string; cause: SponsorUnavailableCause };

/**
 * WHY the sponsor is unusable, as a value rather than a sentence to sniff.
 *
 *   `busy`        — the service answered, and has no wallet with DUST free
 *                   right now. It reserves DUST per in-flight transaction, so
 *                   this is the TRANSIENT one: it clears on its own, usually
 *                   inside a minute, and a surface should wait rather than
 *                   refuse.
 *   `unreachable` — nothing usable came back: a transport failure, an HTTP
 *                   error, or a body that was not a wallet status. Waiting may
 *                   still help, but nothing has been learned about DUST.
 *
 * A surface branches on this; only a log ever reads the reason string beside
 * it. That separation is the whole point — see {@link sponsorRefusal}.
 */
export type SponsorUnavailableCause = 'busy' | 'unreachable';

/**
 * The one refusal sentence every fee gate gives when the sponsor cannot cover
 * a transaction.
 *
 * There is no second fee payer to fall back to, and deliberately: a Passport
 * holder never funds their own fees, so a refusal here is a fact about the
 * SPONSOR and says so. It names no token and reads no balance — a user has
 * nothing to top up and nothing to wait for, and telling them otherwise would
 * invite a step that does not exist.
 *
 * The parameter is the shape of a non-`ready` {@link SponsorReadiness} rather
 * than the union itself, so a caller that learned the sponsor had stood down
 * some other way — a `/balance-only` that failed mid-flight, say — can report
 * it in the same words, while a `ready` readiness still cannot be passed at
 * all.
 */
export function sponsorFeeRefusal(readiness: SponsorRefusalInput): string {
  return sponsorRefusal(readiness).message;
}

/** The shape {@link sponsorRefusal} accepts: any readiness that is not `ready`. */
export type SponsorRefusalInput =
  | { state: 'disabled' }
  | { state: 'unavailable'; reason: string; cause?: SponsorUnavailableCause };

/**
 * A refusal, split into the half a user reads and the half an operator does.
 *
 * The two were one string until 2026/08/25, and the join is what put
 * "sponsor reports 0/1 wallets available (#0 dust 4993664979775282371)" on a
 * user's screen — a wallet index and a DUST balance, from a wallet that is not
 * theirs, about a token they are never asked to hold. The sentence now says
 * only what is true for the person reading it, and the diagnostic travels in
 * `detail`, which belongs in a log and nowhere else.
 */
export interface SponsorRefusal {
  /** The user's sentence. Carries no figures and names nothing to top up. */
  message: string;
  /** What went wrong, for a surface to branch on. */
  cause: 'disabled' | SponsorUnavailableCause;
  /** The sponsor's own diagnostic — `console.info`, never the screen. */
  detail: string | null;
}

export function sponsorRefusal(readiness: SponsorRefusalInput): SponsorRefusal {
  if (readiness.state === 'disabled') {
    return {
      message:
        'Network fees on this Passport are covered by the fee sponsor, and this build has no sponsor configured, so nothing can be submitted.',
      cause: 'disabled',
      detail: null,
    };
  }
  /* An absent cause is treated as `busy` rather than `unreachable`: a caller
     that reports a refusal it learned some other way — a `/balance-only` that
     failed mid-flight, say — reached the service, so "cannot be reached" would
     be the wrong claim, while "cannot cover this one right now" is true of
     every one of them. */
  const cause = readiness.cause ?? 'busy';
  return {
    message:
      cause === 'unreachable'
        ? 'Network fees on this Passport are covered by the fee sponsor, and the fee sponsor cannot be reached right now.'
        : 'Network fees on this Passport are covered by the fee sponsor, and the sponsor cannot cover this one right now.',
    cause,
    detail: readiness.reason,
  };
}

/**
 * Why one probe attempt produced no verdict, tagged so the final reason can
 * say WHICH thing went wrong.
 *
 *   `transport` — nothing was received: DNS, TLS, an abort, a dead host.
 *   `schema`    — something was received and it was not a wallet status.
 */
interface ProbeFailure {
  kind: 'transport' | 'schema';
  message: string;
}

/**
 * One endpoint's verdict. The whole {@link SponsorReadiness} union minus
 * `disabled`, because `disabled` is a fact about the BUILD and never about an
 * endpoint — an endpoint that exists cannot be "not configured".
 */
export type SponsorEndpointReadiness = Exclude<SponsorReadiness, { state: 'disabled' }>;

/**
 * Folds what each endpoint said into the one answer a caller branches on.
 *
 * THE RULE, AND WHY IT IS THIS ONE:
 *
 *   * **No endpoints** is `disabled` — sponsorship is not configured, which is
 *     a different sentence from "nobody could pay".
 *   * **Exactly one endpoint** is returned VERBATIM. A list of one must be
 *     indistinguishable from the single URL this variable used to hold, down
 *     to the diagnostic string, so nothing that reads a reason had to change.
 *   * **The first `ready` wins**, and the walk stops there — the endpoints
 *     after it are never contacted, so a healthy first choice costs one probe.
 *   * **All refused** collapses to ONE cause, and it is `busy` if ANY endpoint
 *     said `busy`. That is the transient one: at least one service answered
 *     and told us about its DUST, so "the sponsor cannot be reached" would be
 *     a claim contradicted by the evidence. `unreachable` survives only when
 *     nothing was learned from any of them.
 *
 * The user-facing half is unchanged in every branch: {@link sponsorRefusal}
 * turns each of these into the same two sentences it turned one endpoint's
 * answer into. Only `reason` grew, and `reason` is a log line.
 */
export function combineSponsorReadiness(
  answers: readonly SponsorEndpointReadiness[],
): SponsorReadiness {
  if (answers.length === 0) return { state: 'disabled' };
  const first = answers[0] as SponsorEndpointReadiness;
  if (answers.length === 1) return first;
  const ready = answers.find((answer) => answer.state === 'ready');
  if (ready) return ready;
  const refused = answers as readonly Extract<
    SponsorEndpointReadiness,
    { state: 'unavailable' }
  >[];
  return {
    state: 'unavailable',
    url: first.url,
    reason: describeEndpointRefusals(refused),
    cause: refused.some((answer) => answer.cause === 'busy') ? 'busy' : 'unreachable',
  };
}

interface CachedReadiness {
  /** The whole list, joined — a different list is a different verdict. */
  key: string;
  at: number;
  value: SponsorReadiness;
}

let readinessCache: CachedReadiness | null = null;
let readinessInFlight: Promise<SponsorReadiness> | null = null;

/** Drops the cached probe — for tests, and for a "retry sponsorship" control. */
export function resetSponsorReadinessCache(): void {
  readinessCache = null;
  readinessInFlight = null;
}

/**
 * Probes `GET /wallet-status`, at most once per
 * {@link SPONSOR_READINESS_TTL_MS}. Never throws: an unreachable service is an
 * `unavailable` answer, because a send must not fail because a *fee optimiser*
 * was down.
 */
export async function sponsorReadiness(
  options: SponsorClientOptions = {},
): Promise<SponsorReadiness> {
  const configs = resolveConfigs(options);
  if (configs.length === 0) return { state: 'disabled' };

  const now = options.now ?? Date.now;
  const key = configs.map((config) => config.url).join(',');
  const cached = readinessCache;
  if (
    !options.force &&
    cached &&
    cached.key === key &&
    now() - cached.at < SPONSOR_READINESS_TTL_MS
  ) {
    return cached.value;
  }
  if (readinessInFlight) return readinessInFlight;

  const fetchRequest = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;

  /**
   * One probe attempt against ONE endpoint: a readiness verdict, or the reason
   * it produced none.
   *
   * The two failure kinds are kept apart because they are different bugs and
   * a single "could not be fetched or parsed" reason sent an operator hunting
   * a network problem that was really a body the parser did not recognise.
   */
  const attempt = async (
    config: SponsorConfig,
    timeoutMs: number,
  ): Promise<SponsorEndpointReadiness | ProbeFailure> => {
    try {
      const response = await fetchRequest(`${config.url}/wallet-status`, {
        method: 'GET',
        headers: authHeaders(config),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          state: 'unavailable',
          url: config.url,
          reason: `wallet-status returned HTTP ${response.status}`,
          /* The service answered, but not with a wallet status — nothing has
             been learned about DUST, so this is not the transient `busy`. */
          cause: 'unreachable',
        };
      }
      const status = parseSponsorWalletStatus(body);
      /* A 200 whose body is not a wallet status: the service answered, so
         this is a SCHEMA failure, not a transport one. */
      if (!status) return { kind: 'schema', message: 'the body was not a wallet status' };
      if (sponsorWalletIsAvailable(status)) {
        return { state: 'ready', url: config.url, available: status.available };
      }
      return {
        state: 'unavailable',
        url: config.url,
        reason: describeSponsorWalletStatus(status),
        /* The one transient state: the service is up and its DUST is spoken
           for. It frees up as its in-flight transactions settle. */
        cause: 'busy',
      };
    } catch (cause) {
      return {
        kind: 'transport',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  };

  /** The two-attempt probe of one endpoint, always ending in a verdict. */
  const probeEndpoint = async (config: SponsorConfig): Promise<SponsorEndpointReadiness> => {
    /* A readiness verdict is cached and read by fee gates downstream, so one
       transient failure must not poison it: measured live on 2026/08/19, a
       single unparseable answer mid-drill turned a ready sponsor into a
       refused contract deploy. A failed attempt gets exactly one retry; a
       well-formed "unavailable" answer is believed first time.

       WORST CASE PER ENDPOINT, asserted here because a fee optimiser must
       never be the slowest thing on a send: SPONSOR_STATUS_TIMEOUT_MS (6 s) +
       SPONSOR_PROBE_RETRY_DELAY_MS (0.5 s) + SPONSOR_STATUS_RETRY_TIMEOUT_MS
       (2 s) = 8.5 s, and only when both attempts time out. A list of N
       endpoints multiplies that, and only in the case where every one of them
       is dead — the first endpoint that answers ends the walk, so the cost of
       having a second sponsor configured is nil while the first is healthy. */
    let value = await attempt(config, SPONSOR_STATUS_TIMEOUT_MS);
    if ('kind' in value) {
      await sleep(SPONSOR_PROBE_RETRY_DELAY_MS);
      value = await attempt(config, SPONSOR_STATUS_RETRY_TIMEOUT_MS);
    }
    if ('kind' in value) {
      return {
        state: 'unavailable',
        url: config.url,
        /* The SECOND attempt's kind names the failure, and a transport
           failure carries the error it actually hit — "twice" alone told an
           operator nothing about what to go and look at. */
        reason:
          value.kind === 'schema'
            ? 'wallet-status returned an unrecognised body, twice'
            : `wallet-status could not be fetched, twice: ${value.message}`,
        cause: 'unreachable',
      };
    }
    return value;
  };

  const probe = (async (): Promise<SponsorReadiness> => {
    /* In the operator's order, stopping at the first endpoint that can pay.
       Every endpoint's answer is kept even after one of them serves, so the
       fold below has the whole picture; the ones AFTER the winner are never
       asked at all. */
    const answers: SponsorEndpointReadiness[] = [];
    for (const config of configs) {
      const answer = await probeEndpoint(config);
      answers.push(answer);
      if (answer.state === 'ready') break;
    }
    const value = combineSponsorReadiness(answers);
    readinessCache = { key, at: now(), value };
    return value;
  })();

  readinessInFlight = probe;
  try {
    return await probe;
  } finally {
    readinessInFlight = null;
  }
}

/** Convenience wrapper: `true` only when the sponsor can pay right now. */
export async function sponsorCanPay(options: SponsorClientOptions = {}): Promise<boolean> {
  return (await sponsorReadiness(options)).state === 'ready';
}

/**
 * Whether one endpoint's refusal is worth asking the SAME endpoint about again.
 *
 * A {@link SponsorError} answers for itself. Anything else that was thrown is
 * a transport failure — a `TypeError` from `fetch`, an `AbortError` from the
 * timeout — which is retryable by definition: nothing reached the service, so
 * nothing has been learned except that the network was unhappy once. A refusal
 * that carried no thrown cause at all is not retried, because there is nothing
 * there to say it would go differently.
 */
function refusalIsRetryable(cause: unknown): boolean {
  if (cause instanceof SponsorError) return cause.isRetryable;
  return cause instanceof Error;
}

/**
 * `POST /balance-only` with a raw serialised PROVEN transaction, against the
 * first sponsor in the list that will take it.
 *
 * The service adds its own DUST fee input, proves and balances the dust
 * segment, and returns the balanced transaction for *this* wallet to submit.
 *
 * WHAT A LIST CHANGED, AND WHAT IT DELIBERATELY DID NOT. The unit of work is
 * now a ROUND — one POST to each endpoint, in order, stopping the moment one
 * answers with a balanced transaction. A round in which every endpoint refused
 * is what the retry window measures, and only a round containing at least one
 * RETRYABLE refusal is worth repeating — see {@link SponsorError.isRetryable}
 * for which those are and, more importantly, which are not.
 *
 * That ordering matters more than it looks. Waiting out a busy sponsor is the
 * right thing when it is the ONLY sponsor — a contract deploy has nothing to
 * fall back to, which is why {@link SPONSOR_CONTRACT_RETRY_WINDOW_MS} is ten
 * minutes — and the wrong thing when another one is sitting idle. Falling
 * through first and waiting second gets both: a second provider is used
 * immediately, and a single provider still gets waited out exactly as long as
 * it did before.
 *
 * With ONE endpoint the shape is unchanged — one POST per round, one immediate
 * retry for a thrown fetch, and the endpoint's own error rethrown VERBATIM when
 * the window closes, so a caller that catches a typed `SponsorError` still
 * catches one. What changed on 2026/09/02 is which answers buy another round:
 * a `503 INSUFFICIENT_DUST` from the only sponsor there is used to end the send
 * on the spot, and it is now waited out exactly as a `429` always was.
 */
export async function sponsorBalanceOnly(
  provenTxBytes: Uint8Array,
  options: SponsorClientOptions = {},
): Promise<SponsoredBalance> {
  const configs = resolveConfigs(options);
  if (configs.length === 0) {
    throw new Error('Sponsorship is not configured (VITE_SPONSOR_URL is unset).');
  }
  for (const config of configs) assertSecureSponsorUrl(config.url);

  const fetchRequest = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const retryWindowMs = options.pendingRetryWindowMs ?? SPONSOR_PENDING_RETRY_WINDOW_MS;
  const startedAt = now();
  /* Time SPENT WAITING, counted independently of the clock.

     The window is a wall-clock budget, and the clock is the honest measure of
     it — but it is the only measure that a caller can make stand still, and a
     retry loop that trusts a clock which never advances never ends. Since
     2026/09/02 far more refusals buy another round than the one `429` that
     used to, so the guard stopped being theoretical: an injected no-op sleep
     turns a repeating round into a spin. The budget is therefore whichever has
     gone further, elapsed time or the sleeps this loop asked for, which bounds
     the round count at `retryWindowMs / SPONSOR_PENDING_RETRY_MIN_DELAY_MS`
     however the clock behaves. */
  let sleptMs = 0;
  const remainingBudgetMs = (): number =>
    retryWindowMs - Math.max(now() - startedAt, sleptMs);
  const byUrl = new Map(configs.map((config) => [config.url, config]));
  const urls = configs.map((config) => config.url);

  const post = (config: SponsorConfig): Promise<Response> =>
    fetchRequest(`${config.url}/balance-only`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeaders(config) },
      // A fresh view over the exact bytes: `BodyInit` will not take a
      // `Uint8Array<ArrayBufferLike>` whose buffer may be shared.
      body: provenTxBytes.slice().buffer as ArrayBuffer,
      signal: AbortSignal.timeout(SPONSOR_BALANCE_TIMEOUT_MS),
    });

  /** One endpoint, one round: a balanced transaction, or a throw. */
  const balanceAt = async (config: SponsorConfig): Promise<SponsorBalanceResult> => {
    let response: Response;
    try {
      response = await post(config);
    } catch {
      /* Exactly one retry, and ONLY for a thrown fetch. A throw means no
         response reached us at all, so re-posting cannot act twice on a
         transaction the service already balanced. The moment a response
         exists — any status — its body is the thing to act on and the POST is
         never repeated: that is what keeps a 503, a 429, or a balanced
         transaction from being sent through the service twice. */
      await sleep(SPONSOR_PROBE_RETRY_DELAY_MS);
      response = await post(config);
    }
    const body = await response.json().catch(() => null);
    if (response.ok) return validateSponsorBalanceResult(body);
    throw createSponsorError(response.status, body);
  };

  for (;;) {
    const outcome = await firstEndpointThatServes(urls, async (url) => ({
      served: true as const,
      value: await balanceAt(byUrl.get(url) as SponsorConfig),
    }));

    if (outcome.served) {
      /* An operator's line, and only an operator's. It says WHERE a
         transaction was paid for, which after the fact is otherwise
         unanswerable — and it says it in a console, never on a screen.
         A fall-through says so and names what it fell through: the day the
         first sponsor breaks, a silent success is how nobody finds out until
         the second one breaks too. */
      console.info(
        outcome.refusals.length === 0
          ? `[sponsor] fee covered by ${outcome.url}`
          : `[sponsor] fee covered by ${outcome.url} after ${describeEndpointRefusals(
              outcome.refusals,
            )}`,
      );
      return { ...outcome.value, servedBy: outcome.url };
    }

    /* Every endpoint refused this round. If ANY of those refusals was one the
       service clears on its own — DUST that is spoken for rather than absent,
       a wallet mid-sync, a rate limit, a transport failure — the round is
       worth repeating while the window lasts.

       This used to be `429 PENDING_TRANSACTION` alone, and the day it was
       widened is the day a NIGHT send stopped failing at step one. The
       balancer nullifies its own DUST change for 20-60 s after each spend it
       makes, and it makes five during an activation; `/wallet-status` answers
       `503 INSUFFICIENT_DUST` instantly through that whole window while
       `/fund-account` waits it out server-side. The client gave up on the
       first 503, fell through to the other gateway, and built a leg there
       against a contract state the balancer was already moving. Waiting is
       both the faster answer and the correct one. */
    const retryable = outcome.refusals.find((refusal) =>
      refusalIsRetryable(refusal.cause),
    );
    const retryAfterMs =
      retryable?.cause instanceof SponsorError ? retryable.cause.retryAfterMs : undefined;
    const remainingMs = remainingBudgetMs();
    if (retryable && retryWindowMs > 0 && remainingMs > 0) {
      const delayMs = sponsorRetryDelayMs(retryAfterMs, remainingMs);
      sleptMs += delayMs;
      await sleep(delayMs);
      continue;
    }

    /* One endpoint keeps its own failure, whole. Anything a caller used to
       catch — a typed SponsorError, a raw transport TypeError — reaches it
       unchanged, because a list of one must not be a new failure mode. */
    if (outcome.refusals.length === 1) throw (outcome.refusals[0] as { cause?: unknown }).cause;
    throw new Error(
      `no fee sponsor would balance this transaction — ${describeEndpointRefusals(
        outcome.refusals,
      )}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Giving a balanced transaction back                                          */
/* -------------------------------------------------------------------------- */

/** How long the abandon notice is worth waiting on. It is a courtesy, not a step. */
const SPONSOR_ABANDON_TIMEOUT_MS = 5_000;

/**
 * Whether an endpoint has a `/balance-only/abandon` route at all.
 *
 * Our own balancer does; the 1AM gateway does not, and posting to it would only
 * earn a 404 in somebody's console. The gateways are the `*.1am.xyz` hosts, so
 * that is the test — a hostname rather than an allowlist, because the preview
 * and preprod gateways are the same software under different names.
 */
export function sponsorSupportsAbandon(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.hostname !== '1am.xyz' && !parsed.hostname.endsWith('.1am.xyz');
}

/**
 * Tells the sponsor that a transaction it balanced will never be submitted.
 *
 * The sponsor books a whole DUST coin per balanced transaction and only gets
 * the change back when the transaction LANDS — 50-95 s observed, and never at
 * all when the node rejects it. On 2026/09/02 a node-rejected leg left that
 * coin booked until a sweeper found it two minutes later, and during those two
 * minutes every registration and grant behind it waited. This is the client
 * saying so at once instead.
 *
 * A COURTESY, never a step: it is fired and forgotten by the failure path of a
 * submit that has already failed, so it resolves on every answer — 200, 4xx,
 * 5xx, a transport failure, a timeout — and throws nothing at anybody. The
 * sweeper is still the thing that guarantees the release; this only shortens
 * the common case. Nothing it does reaches a screen: `console.info` names the
 * endpoint, and constraint (b) keeps a gateway hostname out of the UI.
 */
export async function sponsorAbandonBalance(
  txHash: string,
  servedBy: string,
  options: SponsorClientOptions = {},
): Promise<void> {
  if (!sponsorSupportsAbandon(servedBy)) return;
  const config =
    resolveConfigs(options).find((candidate) => candidate.url === servedBy) ?? { url: servedBy };
  const fetchRequest = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchRequest(`${servedBy}/balance-only/abandon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
      body: JSON.stringify({ txHash }),
      signal: AbortSignal.timeout(SPONSOR_ABANDON_TIMEOUT_MS),
    });
    console.info(
      response.ok
        ? `[sponsor] ${servedBy} released the fee it booked for ${txHash}`
        : `[sponsor] ${servedBy} would not release the fee booked for ${txHash} (${response.status})`,
    );
  } catch (cause) {
    /* The sweeper releases it anyway. Saying so at debug level keeps an
       operator's trail without turning a courtesy into a visible failure. */
    console.debug(`[sponsor] could not tell ${servedBy} to release ${txHash}`, cause);
  }
}
