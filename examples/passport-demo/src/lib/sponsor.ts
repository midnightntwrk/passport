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
 *      literal `off` disables sponsorship, returning every caller to exactly
 *      the path it took before sponsorship existed.
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
 * Service state on 2026/08/05 (probed live over HTTPS at
 * `https://api-preview.1am.xyz`): healthy cluster, one balance wallet, fully
 * synced, zero DUST, therefore `available: 0` and `/balance-only` answering
 * `503 { error: 'WALLETS_UNAVAILABLE', cause: 'INSUFFICIENT_DUST' }`. Until the
 * sponsor wallet
 * `mn_addr_preview1emdcrp6c8l7n8z3uwtm8mtqtxywyur4aqlte8qh8nafyvzd26c5q0k5elf`
 * holds DUST, this module correctly reports `unavailable` and nothing in the
 * demo changes.
 */

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
/** Floor on a retry delay, so a zero `retryAfterMs` cannot spin. */
const SPONSOR_PENDING_RETRY_MIN_DELAY_MS = 250;
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
     able to pay, which is the only thing rule 2 below accepts. */
  stagenet: 'https://funder.midnightpassport.com/balancer',
  preview: 'https://api-preview.1am.xyz',
  preprod: 'https://api-preprod.1am.xyz',
};

/**
 * Reads the sponsor configuration from the environment.
 *
 *   VITE_SPONSOR_URL         base URL of the ProofStation gateway. Unset falls
 *                            back to the network's default gateway; the
 *                            literal `off` disables sponsorship outright.
 *   VITE_SPONSOR_API_KEY     optional `X-API-Key`.
 *   VITE_SPONSOR_CLIENT_ID   optional `X-Client-ID`.
 *
 * Returns `null` when sponsorship is disabled or the network has no gateway,
 * and throws when a URL could leak a signed transaction over plaintext.
 */
export function sponsorConfig(
  env: Record<string, string | undefined> = environment(),
): SponsorConfig | null {
  const explicit = trimmed(env.VITE_SPONSOR_URL);
  if (explicit === 'off') return null;
  const raw =
    explicit ??
    DEFAULT_SPONSOR_URLS[trimmed(env.VITE_MIDNIGHT_NETWORK_ID) ?? 'stagenet'];
  if (!raw) return null;
  const url = raw.replace(/\/+$/, '');
  assertSecureSponsorUrl(url);
  const config: SponsorConfig = { url };
  const apiKey = trimmed(env.VITE_SPONSOR_API_KEY);
  const clientId = trimmed(env.VITE_SPONSOR_CLIENT_ID);
  if (apiKey) config.apiKey = apiKey;
  if (clientId) config.clientId = clientId;
  return config;
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

  /** 503 — the service is up but has no wallet that can pay right now. */
  get isRetryable(): boolean {
    return this.status === 503;
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
  const detail = message ?? cause ?? rawCode ?? `HTTP ${status}`;
  const retryAfterMs =
    typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)
      ? record.retryAfterMs
      : undefined;
  return new SponsorError(status, rawCode ?? 'UNKNOWN', detail, retryAfterMs);
}

/** How long to wait before a `PENDING_TRANSACTION` retry, given the budget. */
export function sponsorRetryDelayMs(retryAfterMs: number | undefined, remainingMs: number): number {
  const requested = retryAfterMs ?? SPONSOR_PENDING_RETRY_DEFAULT_DELAY_MS;
  return Math.max(SPONSOR_PENDING_RETRY_MIN_DELAY_MS, Math.min(requested, remainingMs));
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export interface SponsorClientOptions {
  config?: SponsorConfig | null;
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

function resolveConfig(options: SponsorClientOptions): SponsorConfig | null {
  return options.config !== undefined ? options.config : sponsorConfig();
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

interface CachedReadiness {
  url: string;
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
  const config = resolveConfig(options);
  if (!config) return { state: 'disabled' };

  const now = options.now ?? Date.now;
  const cached = readinessCache;
  if (
    !options.force &&
    cached &&
    cached.url === config.url &&
    now() - cached.at < SPONSOR_READINESS_TTL_MS
  ) {
    return cached.value;
  }
  if (readinessInFlight) return readinessInFlight;

  const fetchRequest = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;

  /**
   * One probe attempt: a readiness verdict, or the reason it produced none.
   *
   * The two failure kinds are kept apart because they are different bugs and
   * a single "could not be fetched or parsed" reason sent an operator hunting
   * a network problem that was really a body the parser did not recognise.
   */
  const attempt = async (timeoutMs: number): Promise<SponsorReadiness | ProbeFailure> => {
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

  const probe = (async (): Promise<SponsorReadiness> => {
    /* A readiness verdict is cached and read by fee gates downstream, so one
       transient failure must not poison it: measured live on 2026/08/19, a
       single unparseable answer mid-drill turned a ready sponsor into a
       refused contract deploy. A failed attempt gets exactly one retry; a
       well-formed "unavailable" answer is believed first time.

       WORST CASE, asserted here because a fee optimiser must never be the
       slowest thing on a send: SPONSOR_STATUS_TIMEOUT_MS (6 s) +
       SPONSOR_PROBE_RETRY_DELAY_MS (0.5 s) + SPONSOR_STATUS_RETRY_TIMEOUT_MS
       (2 s) = 8.5 s, and only when both attempts time out. */
    let value = await attempt(SPONSOR_STATUS_TIMEOUT_MS);
    if ('kind' in value) {
      await sleep(SPONSOR_PROBE_RETRY_DELAY_MS);
      value = await attempt(SPONSOR_STATUS_RETRY_TIMEOUT_MS);
    }
    if ('kind' in value) {
      value = {
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
    readinessCache = { url: config.url, at: now(), value };
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
 * `POST /balance-only` with a raw serialised PROVEN transaction.
 *
 * The service adds its own DUST fee input, proves and balances the dust
 * segment, and returns the balanced transaction for *this* wallet to submit.
 * A 429 `PENDING_TRANSACTION` is retried inside a bounded window; every other
 * failure ends the attempt so the caller can fall back to real fees.
 */
export async function sponsorBalanceOnly(
  provenTxBytes: Uint8Array,
  options: SponsorClientOptions = {},
): Promise<SponsorBalanceResult> {
  const config = resolveConfig(options);
  if (!config) throw new Error('Sponsorship is not configured (VITE_SPONSOR_URL is unset).');
  assertSecureSponsorUrl(config.url);

  const fetchRequest = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const retryWindowMs = options.pendingRetryWindowMs ?? SPONSOR_PENDING_RETRY_WINDOW_MS;
  const deadline = now() + retryWindowMs;

  const post = (): Promise<Response> =>
    fetchRequest(`${config.url}/balance-only`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeaders(config) },
      // A fresh view over the exact bytes: `BodyInit` will not take a
      // `Uint8Array<ArrayBufferLike>` whose buffer may be shared.
      body: provenTxBytes.slice().buffer as ArrayBuffer,
      signal: AbortSignal.timeout(SPONSOR_BALANCE_TIMEOUT_MS),
    });

  for (;;) {
    let body: unknown;
    let ok: boolean;
    let status: number;
    let response: Response;
    try {
      response = await post();
    } catch {
      /* Exactly one retry, and ONLY for a thrown fetch. A throw means no
         response reached us at all, so re-posting cannot act twice on a
         transaction the service already balanced. The moment a response
         exists — any status — its body is the thing to act on and the POST is
         never repeated: that is what keeps a 503, a 429, or a balanced
         transaction from being sent through the service twice. */
      await sleep(SPONSOR_PROBE_RETRY_DELAY_MS);
      response = await post();
    }
    ok = response.ok;
    status = response.status;
    body = await response.json().catch(() => null);

    if (ok) return validateSponsorBalanceResult(body);

    const error = createSponsorError(status, body);
    const remainingMs = deadline - now();
    if (!error.isPendingTransaction || retryWindowMs <= 0 || remainingMs <= 0) throw error;
    await sleep(sponsorRetryDelayMs(error.retryAfterMs, remainingMs));
  }
}
