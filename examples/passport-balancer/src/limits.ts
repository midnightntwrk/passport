/**
 * Who is calling, how often they may, and how many spends may be in flight.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT
 * ------------------------------------
 * The three endpoints that SPEND — `/balance-only`, `/register-alias`,
 * `/fund-account` — ran their handlers for any caller who knew the URL. The
 * CORS allow-list does not help: it decides which headers a BROWSER is given
 * back, and the handler has already executed and already spent by the time
 * those headers are written. `aliasMaxPerHour` and `accountMaxPerHour` are real
 * ceilings but they are GLOBAL, so one caller can exhaust the hour for
 * everybody, and `/balance-only` had no ceiling at all while paying a DUST fee
 * on every call.
 *
 * So this module adds the three things that were missing, and deliberately
 * nothing else:
 *
 *   1. a per-client token bucket, so one caller cannot have the whole service;
 *   2. a bound on how many spend requests may be in flight at once, so a flood
 *      queues to a limit and is refused past it rather than stacking behind the
 *      wallet's one-at-a-time queue for ever;
 *   3. an optional shared secret, so the link can be handed to a room without
 *      handing the wallet to the internet.
 *
 * None of it touches the readiness vocabulary. `available`, `unavailableCause`,
 * the 429 `PENDING_TRANSACTION` sentence the client waits out, and the
 * `{ error, message }` refusal shape are the wire contract
 * `examples/passport-demo/src/lib/sponsor.ts` is written against, and a refusal
 * from here is that same shape with a new code in it.
 *
 * THE FORWARDED-ADDRESS RULE IS THE LOAD-BEARING PART
 * ---------------------------------------------------
 * A per-client limit keyed on a header anybody can set is not a limit — an
 * abuser sends a fresh `X-Forwarded-For` per request and gets a fresh bucket
 * every time. The box sits behind Caddy on loopback, and Caddy APPENDS the
 * address it actually observed to whatever the client sent. So the rightmost
 * hop is the only entry a client cannot forge, and it is only worth reading at
 * all when the socket's own peer is a proxy we trust. A request arriving
 * straight off the internet is keyed on its socket address and its headers are
 * ignored, whatever they claim.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The peers whose `X-Forwarded-For` is believed, unless an operator overrides
 * it. Loopback only: Caddy proxies from `127.0.0.1` on this droplet, and every
 * other peer is somebody on the internet talking to the port directly.
 */
export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1'] as const;

/** The bucket key for a request whose peer cannot be read at all. */
export const UNKNOWN_CLIENT = 'unknown';

/**
 * One address, in the one spelling every comparison here uses: lower case, no
 * brackets, no port, and IPv4-mapped IPv6 (`::ffff:127.0.0.1`) reduced to the
 * IPv4 address Node would otherwise report differently on a dual-stack socket.
 * `null` for anything that is not an address.
 */
export function normaliseAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  const bracketed = value.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) {
    value = bracketed[1] as string;
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(':'));
  }
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  return value || null;
}

export interface ClientAddressInput {
  /** `request.socket.remoteAddress` — the one address that cannot be forged. */
  socketAddress?: string | null;
  /** `request.headers['x-forwarded-for']`, believed only behind a trusted peer. */
  forwardedFor?: string | string[] | undefined;
  /** Defaults to {@link DEFAULT_TRUSTED_PROXIES}. */
  trustedProxies?: readonly string[];
}

/**
 * The address a rate limit should be keyed on.
 *
 * The socket peer wins outright unless it is a trusted proxy. Behind one, the
 * chain is read from the RIGHT — the end a proxy appends to and a client cannot
 * reach — skipping further trusted proxies so a two-hop deployment still lands
 * on the real caller. A chain that is empty, unreadable, or entirely trusted
 * falls back to the peer, which is always something rather than nothing.
 */
export function clientAddress(input: ClientAddressInput): string {
  const peer = normaliseAddress(input.socketAddress);
  if (peer === null) return UNKNOWN_CLIENT;

  const trusted = new Set(
    (input.trustedProxies ?? DEFAULT_TRUSTED_PROXIES)
      .map((entry) => normaliseAddress(entry))
      .filter((entry): entry is string => entry !== null),
  );
  if (!trusted.has(peer)) return peer;

  const header = Array.isArray(input.forwardedFor)
    ? input.forwardedFor.join(',')
    : input.forwardedFor;
  const hops = (header ?? '')
    .split(',')
    .map((hop) => normaliseAddress(hop))
    .filter((hop): hop is string => hop !== null);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index] as string;
    if (!trusted.has(hop)) return hop;
  }
  return peer;
}

/* -------------------------------------------------------------------------- */
/* The per-client token bucket                                                */
/* -------------------------------------------------------------------------- */

export interface TokenBucketOptions {
  /** Sustained rate. Zero or less turns the limit off entirely. */
  ratePerMinute: number;
  /** How many calls may arrive at once on a bucket that has been idle. */
  burst: number;
  /** Injectable for the tests, which run this on a fake clock. */
  now?: () => number;
  /**
   * How long a silent key is kept before it is forgotten.
   *
   * Forgetting is not a hole: it is floored at the time a bucket takes to refill
   * completely, so a key that is dropped would have been handed a full bucket on
   * its next call anyway. What it buys is a bound on memory, because the key
   * space is "every address on the internet".
   */
  idleMs?: number;
}

export interface RateVerdict {
  allowed: boolean;
  /** How long until one token exists again. Zero when allowed. */
  retryAfterMs: number;
}

/**
 * A token bucket per key: `burst` tokens to spend at once, refilling at
 * `ratePerMinute`. A bucket rather than a fixed window because the shape of the
 * traffic being protected is bursty and legitimate — one Passport onboarding
 * fires a name and a grant within a second of each other — while the shape being
 * refused is sustained, and a window either allows the burst and the flood or
 * refuses both.
 */
export class TokenBucket {
  private readonly states = new Map<string, { tokens: number; seenAt: number }>();
  private readonly clock: () => number;
  private readonly perMs: number;
  private readonly capacity: number;
  private readonly idleMs: number;
  private sweptAt: number;

  constructor(private readonly options: TokenBucketOptions) {
    this.clock = options.now ?? Date.now;
    this.perMs = Math.max(0, options.ratePerMinute) / 60_000;
    this.capacity = Math.max(1, Math.floor(options.burst));
    /* Never shorter than a full refill, so dropping a key is indistinguishable
       from keeping it — see `idleMs` above. */
    const refillMs = this.perMs > 0 ? Math.ceil(this.capacity / this.perMs) : 0;
    this.idleMs = Math.max(options.idleMs ?? 600_000, refillMs);
    this.sweptAt = this.clock();
  }

  /** False when `ratePerMinute` is zero — the documented off switch. */
  get enabled(): boolean {
    return this.options.ratePerMinute > 0;
  }

  /** How many keys are currently remembered. Published on `/status`. */
  get size(): number {
    return this.states.size;
  }

  /** Spends one token for `key`, or says how long until there is one. */
  /**
   * Gives one token back. For an answer that cost the service nothing and
   * that the client is TOLD to repeat — `429 grant-retrying` says "ask again
   * in fifteen seconds", and a client that does so must not be rate-limited
   * for obeying. Measured 2026/09/03: the client polled `/fund-account` past
   * the 3-a-minute limit while the sponsor was retrying its own grant.
   */
  refund(key: string): void {
    if (!this.enabled) return;
    const state = this.states.get(key);
    if (!state) return;
    this.states.set(key, { tokens: Math.min(this.capacity, state.tokens + 1), seenAt: state.seenAt });
  }

  take(key: string): RateVerdict {
    if (!this.enabled) return { allowed: true, retryAfterMs: 0 };
    const now = this.clock();
    this.sweep(now);
    const state = this.states.get(key);
    const tokens =
      state === undefined
        ? this.capacity
        : Math.min(this.capacity, state.tokens + (now - state.seenAt) * this.perMs);
    if (tokens < 1) {
      this.states.set(key, { tokens, seenAt: now });
      return { allowed: false, retryAfterMs: Math.ceil((1 - tokens) / this.perMs) };
    }
    this.states.set(key, { tokens: tokens - 1, seenAt: now });
    return { allowed: true, retryAfterMs: 0 };
  }

  private sweep(now: number): void {
    if (now - this.sweptAt < this.idleMs) return;
    this.sweptAt = now;
    for (const [key, state] of this.states) {
      if (now - state.seenAt >= this.idleMs) this.states.delete(key);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The global admission cap                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How many spend requests may be in flight at once, across every client.
 *
 * The wallet already runs spends one at a time (`./reservation.ts`), and that is
 * a QUEUE, not a bound: a hundred `/fund-account` posts all wait their turn, all
 * hold a socket, and all hold whatever they read before they queued. This caps
 * the queue instead, so past the limit a caller is told to come back rather than
 * being enrolled in a wait nobody can serve.
 */
export class SpendAdmission {
  private inFlight = 0;

  /** Zero or less means unbounded — the off switch, for a local run. */
  constructor(private readonly maxInFlight: number) {}

  get depth(): number {
    return this.inFlight;
  }

  get max(): number {
    return this.maxInFlight;
  }

  /** Claims a slot, or returns false. Every true MUST be paired with `leave()`. */
  enter(): boolean {
    if (this.maxInFlight > 0 && this.inFlight >= this.maxInFlight) return false;
    this.inFlight += 1;
    return true;
  }

  leave(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

/* -------------------------------------------------------------------------- */
/* The optional shared secret                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Does this request carry the shared secret?
 *
 * `expected` unset means no key is configured and every caller passes, which is
 * how the deployed behaviour is unchanged until an operator sets one. Both sides
 * are hashed before they are compared so the comparison is constant time in the
 * VALUE and in the LENGTH — a length-first `timingSafeEqual` leaks the size of
 * the secret, and there is no reason to.
 */
export function clientKeyAccepted(
  expected: string | undefined,
  presented: string | string[] | undefined,
): boolean {
  if (!expected) return true;
  const offered = Array.isArray(presented) ? presented[0] : presented;
  if (typeof offered !== 'string') return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(offered.trim()));
}
