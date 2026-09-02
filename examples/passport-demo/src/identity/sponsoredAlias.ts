/**
 * Sponsored `.night` registration — the funder pays, the user owns.
 *
 * The deployed registry's `register_domain_for(owner, domain, len, resolver)`
 * takes the owner as an ARGUMENT, not from the caller, so a third party can pay
 * for a name the registry records as belonging to somebody else. The
 * passport-funder service (`examples/passport-funder`, `POST /register-alias`)
 * is that third party: it deploys the resolver leaf pointing at the user's
 * account-custody contract and registers the name under the user's own
 * Midnames key, paying the registry price from its own NIGHT and the fees from
 * its own DUST. The user's wallet signs nothing, spends nothing, and needs to
 * hold nothing.
 *
 * This module is the client half: one probe that asks the service whether it is
 * sponsoring right now, and one call that asks it to register. Everything the
 * service refuses comes back as a typed {@link AliasSponsorRefusal}, and
 * `selfPayWorthTrying` says only whether a RETRY could honestly land — never
 * whether the wallet should buy the name instead. It should not, and since
 * 2026/08/25 it cannot: the self-paid `claimAlias` is gone from `midnames.ts`,
 * because the passkey wallet originates exactly one transaction in its life
 * and that is the account-custody deploy. A refusal this module reports ends
 * with the name QUEUED for a later attempt.
 *
 * The service stands in for Midnames-side sponsorship until the Midnames team
 * runs their own; nothing in the protocol is Passport-specific.
 *
 * WHO SPEAKS THIS ON STAGENET (2026/08/25)
 * ----------------------------------------
 * The stagenet balancer does. `examples/passport-balancer` serves the same
 * three routes this client uses — `GET /status`, `POST /register-alias`,
 * `POST /fund-account` — against the stagenet `.night` TLD deployed on
 * 2026/08/24 (see `midnames.ts#MIDNAMES_TLD_ADDRESSES`), and it holds stagenet
 * NIGHT to pay the registry price with. An earlier version of this comment said
 * the balancer had no `/register-alias` and that a stagenet registration's COST
 * was therefore the user's; both halves were wrong by the time it was read.
 *
 * This module is pure transport — no ledger, no SDK, no contract — so it did
 * not have to move for ledger-9, and it does not care which of the two services
 * answers. {@link checkAliasSponsorship} still requires the service's own
 * `/status` to name the network being claimed on, so a service pointed at
 * another network reads as unavailable and the name queues.
 */

import type { AliasClaimResult, MidnamesNetwork } from './midnames.js';
/* The leaf, not `./midnames.js`: this module is pure transport and must stay
   importable without the ledger WASM behind it. */
import { aliasDomain } from './midnamesText.js';

/** How long one probe answer is trusted before the funder is asked again. */
const PROBE_TTL_MS = 30_000;
/** Ceiling on the probe round-trip — a slow funder must not stall a claim. */
const PROBE_TIMEOUT_MS = 4_000;
/**
 * Ceiling on the registration round-trip. The service submits two transactions
 * and waits for the registry to confirm before answering.
 *
 * What that costs, measured rather than remembered: 63 s on preview with a
 * remote proof server (2026/08/20); the stagenet balancer proves on a LOCAL
 * proof server at 127.0.0.1:6300 — its own `/status` says so — and took ~9 s
 * from receiving a request to landing a fully proved circuit call in a block,
 * with the rest of the wait being blocks and indexer lag rather than proving.
 * An earlier version of this comment quoted 113 s for "stagenet proving
 * in-process on a laptop", which stopped describing this deployment when the
 * proof server arrived.
 *
 * The ceiling stays where it is regardless, and generously: it matches the fee
 * sponsor's own patience, and abandoning a registration the service is still
 * proving costs more than waiting, because the name then lands with nobody
 * listening.
 */
const REGISTER_TIMEOUT_MS = 600_000;

/** The funder's refusal, verbatim: its `error` code and its human sentence. */
export class AliasSponsorRefusal extends Error {
  constructor(
    /** The funder's machine-readable `error` code, or `'unreachable'`. */
    readonly code: string,
    message: string,
    /**
     * Whether asking again later could honestly land this name.
     *
     * False where a second attempt could DOUBLE-REGISTER
     * (`registration-in-flight`, `confirmation-failed` — the name may already
     * have landed) or where it would fail identically (`name-taken`). The
     * caller uses it to choose between "queued, we will try again" and "stop,
     * with the service's own sentence"; it has never been permission to spend
     * from the wallet, and there is no longer a wallet-funded claim to permit.
     */
    readonly selfPayWorthTrying: boolean,
    /**
     * What the SERVICE said, for a log — never for a screen.
     *
     * The split is `lib/sponsor.ts`'s, and it is here for the same reason it
     * is there. Until 2026/09/02 this client put the service's own sentence in
     * front of the user, and what a person saw when the sponsor ran out of
     * free DUST mid-claim was "The .night registry rejected the registration
     * of alice.night" — a machinery word, and a wrong diagnosis: the registry
     * had rejected nothing, the sponsor could not pay for the transaction that
     * would have asked it. {@link message} is now Passport's own sentence and
     * this carries the rest, so an operator loses nothing.
     *
     * Deliberately NOT called `detail`: the claim path in `App.tsx` appends a
     * caught error's `detail` to what it shows and stores, so a field by that
     * name would put these words back on the screen by another route.
     */
    readonly serviceMessage: string = message,
  ) {
    super(message);
    this.name = 'AliasSponsorRefusal';
  }
}

/**
 * Refusal codes whose whole meaning to a READER is "not right now".
 *
 * All three are the service saying it cannot pay for this transaction at this
 * moment — no NIGHT free, no DUST free, or too many requests in the window —
 * and every one of them clears on its own. None of them is a fact about the
 * name, and none of them is anything a person could act on.
 */
const SPONSOR_BUSY_CODES = new Set(['funder-empty', 'funder-no-dust', 'rate-limited']);

/**
 * The one sentence for a sponsor that cannot pay right now.
 *
 * It says the true thing and the useful thing in that order: it is the
 * sponsor, not the name and not the reader, and the name is not lost. The
 * Register-now control on the queued name is the manual half of "on its own",
 * and it is already there — see `App.tsx#registerQueuedAlias`.
 */
const SPONSOR_BUSY_SENTENCE =
  'The sponsor is busy — your name is queued and will register on its own.';

/**
 * The sentence a PERSON reads when the service will not register their name.
 *
 * WHY THE SERVICE'S OWN WORDS ARE NOT IT
 * --------------------------------------
 * They were, until 2026/09/02, and the first live claim of a demo pair failed
 * five times out of five with "The .night registry rejected the registration of
 * alice.night" on screen. Both halves of that are wrong for a reader: the
 * registry is machinery a Passport holder is never shown, and it had rejected
 * nothing — the sponsor held one fee-capable DUST coin, the user's own account
 * deploy had it booked for a hundred seconds, and the registration was refused
 * before it was ever asked for. A refusal that names the wrong party sends
 * somebody to change their name when what they had to do was press the button
 * again.
 *
 * So the code is mapped, and the mapping is the decision:
 *
 *   - The sponsor could not pay. `DustUnavailable` inside the service's own
 *     diagnostic, a `retryAfterMs` beside the refusal, or one of
 *     {@link SPONSOR_BUSY_CODES}. This is the measured fault, it clears on its
 *     own, and it gets {@link SPONSOR_BUSY_SENTENCE}.
 *   - The name itself was refused. `name-taken` is the only one of these the
 *     service can report, and it is the one refusal that is genuinely ABOUT
 *     what the reader typed — so it says so plainly, names no machinery, and
 *     does not promise a queue that would never drain.
 *   - Anything else. The registration did not happen and the name is kept.
 *     Said in that order, without a party named, because at this point the
 *     honest answer is that we do not know which one is at fault.
 *
 * `detail` and `retryAfterMs` are read to CLASSIFY and are never rendered:
 * `detail` is where the service puts the ledger's own words, which is exactly
 * the vocabulary this function exists to keep off the screen.
 */
export function aliasRefusalMessage(refusal: {
  code: string;
  domain: string;
  detail: string | null;
  retryAfterMs: number | null;
}): string {
  if (refusal.code === 'name-taken') {
    return `${refusal.domain} has already been taken. Choose another name.`;
  }
  if (
    SPONSOR_BUSY_CODES.has(refusal.code) ||
    refusal.retryAfterMs !== null ||
    (refusal.detail !== null && refusal.detail.includes('DustUnavailable'))
  ) {
    return SPONSOR_BUSY_SENTENCE;
  }
  return `${refusal.domain} was not registered. Your name is kept for you and can be registered again.`;
}

/** Codes after which the name must NOT be re-attempted — see `selfPayWorthTrying`. */
const NO_FALLBACK_CODES = new Set([
  'name-taken',
  'registration-in-flight',
  'confirmation-failed',
]);

interface ProbeCacheEntry {
  at: number;
  available: boolean;
}
const probeCache = new Map<string, ProbeCacheEntry>();

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the funder is sponsoring registrations on this network RIGHT NOW —
 * its own `/status` saying `aliasSponsorship: "available"` on the matching
 * network, never a hopeful assumption. Any transport failure, timeout, or
 * unexpected body is `false`: a queued name is the honest answer when the
 * sponsor cannot be confirmed. Cached for {@link PROBE_TTL_MS} per funder URL.
 */
export async function checkAliasSponsorship(
  funderUrl: string,
  network: MidnamesNetwork,
): Promise<boolean> {
  const cached = probeCache.get(funderUrl);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.available;
  let available = false;
  try {
    const response = await fetchWithTimeout(`${funderUrl}/status`, PROBE_TIMEOUT_MS);
    if (response.ok) {
      const body = (await response.json()) as {
        network?: unknown;
        aliasSponsorship?: unknown;
      };
      available = body.network === network && body.aliasSponsorship === 'available';
    }
  } catch {
    available = false;
  }
  probeCache.set(funderUrl, { at: Date.now(), available });
  return available;
}

/** Drops the cached probe answer — used after a refusal that dates it. */
export function invalidateSponsorshipProbe(funderUrl?: string): void {
  if (funderUrl === undefined) probeCache.clear();
  else probeCache.delete(funderUrl);
}

export interface SponsorAliasRequest {
  alias: string;
  /** The user's Midnames owner key — `deriveMidnamesOwnerKey`, 32 bytes. */
  ownerKey: Uint8Array;
  /** The user's account-custody contract — the name's target. */
  contractAddress: string;
  /* Deliberately no payment address. The leaf has an owner-address half that
     a resolver may pay; filling it with the wallet's address would route
     value to the wallet, which the account model forbids. The service
     zero-fills it, and the account remains the only target. */
  network: MidnamesNetwork;
  /**
   * True when {@link contractAddress} names an account contract that has been
   * SUBMITTED but may not yet be served by the indexer.
   *
   * The service's fourth gate reads the target's state and refuses
   * `target-missing` when it finds none — both a correctness gate (a name bound
   * to nothing is worse than no name) and its anti-spam gate (a target costs a
   * real transaction to mint). This flag does not waive that gate; it moves
   * WHEN it is answered, from a precondition on the request to a precondition
   * on the registry call, which the service makes after it has deployed the
   * resolver leaf. A caller that sets it is saying "the deploy is in flight,
   * wait for it rather than turning me away", and a service that has never
   * heard of the flag simply ignores it and refuses exactly as it does today —
   * which is what {@link SponsorAliasOptions.awaitTarget} is for.
   */
  targetPending?: boolean;
}

export interface SponsorAliasOptions {
  /**
   * How to wait for the account contract, used ONLY after the service has
   * refused with `target-missing`.
   *
   * This is the compatibility half of {@link SponsorAliasRequest.targetPending}
   * and it is not optional politeness: a service that predates the flag refuses
   * a submitted-but-unindexed target, and without this the claim would fail on
   * a contract that is perfectly real and merely fourteen seconds early. So the
   * refusal is taken as "not yet", this is awaited, and the request is made
   * once more — after which a second `target-missing` is a genuine refusal and
   * is reported as one.
   *
   * It may REJECT, and a rejection is not swallowed: the account deploy failing
   * is precisely why the target will never appear, and the caller needs that
   * error rather than a sentence about the name service.
   */
  awaitTarget?: () => Promise<unknown>;
}

interface FunderSuccessBody {
  alias: string;
  domain: string;
  network: string;
  tldAddress: string;
  resolverAddress: string;
  resolverDeployTx: string;
  registerTx: string;
  target: { kind: string; address: string };
  registeredAt: string;
}

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Asks the funder to register `alias`.night for this Passport, and confirms
 * the result with the client's OWN registry read before reporting it
 * confirmed. The funder's 200 already means IT read the name back resolving to
 * the requested contract; the local read is this client refusing to take that
 * on faith. A local read that has not caught up yet downgrades
 * `registryConfirmed` to `false` — the honest "awaiting the registry" the UI
 * already has copy for — it never fails the claim.
 *
 * Refusals throw {@link AliasSponsorRefusal}; the caller inspects
 * `selfPayWorthTrying` to decide whether the name is worth queueing for another
 * attempt or whether it must stop with the service's own sentence.
 *
 * Exactly ONE refusal is retried here rather than reported: `target-missing`,
 * and only when the caller both declared the target pending and said how to
 * wait for it. See {@link SponsorAliasOptions.awaitTarget}.
 */
export async function sponsorAliasRegistration(
  funderUrl: string,
  request: SponsorAliasRequest,
  options: SponsorAliasOptions = {},
): Promise<AliasClaimResult> {
  const post = async (): Promise<{ response: Response; body: unknown }> => {
    let response: Response;
    try {
      response = await fetchWithTimeout(`${funderUrl}/register-alias`, REGISTER_TIMEOUT_MS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          alias: request.alias,
          ownerKey: bytesToHex(request.ownerKey),
          contractAddress: request.contractAddress,
          network: request.network,
          /* Omitted rather than sent as `false`, so the request a settled
             target makes is byte-identical to the one this client has always
             sent. */
          ...(request.targetPending ? { targetPending: true } : {}),
        }),
      });
    } catch (cause) {
      invalidateSponsorshipProbe(funderUrl);
      throw new AliasSponsorRefusal(
        'unreachable',
        `The sponsorship service could not be reached: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        true,
      );
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // Handled below: a non-JSON body from the funder is a refusal, not a crash.
    }
    return { response, body: parsed };
  };

  let { response, body } = await post();

  /* THE ONE RETRY, and the only refusal that earns one. `target-missing` from
     a service that was told the target is pending means that service does not
     know the flag: it read the indexer once, before the account deploy had been
     served, and turned the claim away for a contract that exists. Waiting for
     the deploy and asking again costs one HTTP round trip and restores exactly
     the behaviour this client had before it started asking early. Every other
     refusal is final on the first answer, and a SECOND `target-missing` is
     reported as the refusal it is. */
  if (
    !response.ok &&
    options.awaitTarget &&
    request.targetPending &&
    (body as { error?: unknown } | null)?.error === 'target-missing'
  ) {
    await options.awaitTarget();
    ({ response, body } = await post());
  }

  if (!response.ok) {
    const refusal = (body ?? {}) as {
      error?: unknown;
      message?: unknown;
      /* The service's own diagnostic — the ledger's words, routinely. Read to
         classify the refusal and never rendered; see `aliasRefusalMessage`. */
      detail?: unknown;
      retryAfterMs?: unknown;
    };
    const code = typeof refusal.error === 'string' ? refusal.error : 'unreachable';
    const serviceMessage =
      typeof refusal.message === 'string'
        ? refusal.message
        : `The sponsorship service refused with status ${response.status}.`;
    if (SPONSOR_BUSY_CODES.has(code)) {
      // The probe's cached "available" is now demonstrably stale.
      invalidateSponsorshipProbe(funderUrl);
    }
    throw new AliasSponsorRefusal(
      code,
      aliasRefusalMessage({
        code,
        domain: aliasDomain(request.alias),
        detail: typeof refusal.detail === 'string' ? refusal.detail : null,
        retryAfterMs:
          typeof refusal.retryAfterMs === 'number' && Number.isFinite(refusal.retryAfterMs)
            ? refusal.retryAfterMs
            : null,
      }),
      !NO_FALLBACK_CODES.has(code),
      serviceMessage,
    );
  }

  const success = body as FunderSuccessBody;
  if (
    typeof success?.resolverAddress !== 'string' ||
    typeof success?.registerTx !== 'string' ||
    success?.target?.kind !== 'contract' ||
    success?.target?.address !== request.contractAddress
  ) {
    /* A 200 whose body does not name THIS contract as the target is treated as
       no registration at all — but with no retry, because something DID land
       and a second attempt on top of it could double-register. */
    throw new AliasSponsorRefusal(
      'confirmation-failed',
      'The sponsorship service answered success but its answer did not name this Passport’s account contract, so the claim is not trusted.',
      false,
    );
  }

  /* The independent read-back. Same decoder, same indexer, this client's own
     eyes. Two attempts is deliberate: the funder has ALREADY seen the name
     resolve, so a miss here is indexer lag, and the UI's "awaiting the
     registry" copy exists for exactly that. */
  let registryConfirmed = false;
  const { resolveAliasTarget } = await import('./midnames.js');
  for (let attempt = 0; attempt < 2 && !registryConfirmed; attempt += 1) {
    try {
      const resolved = await resolveAliasTarget(request.network, success.alias);
      registryConfirmed =
        resolved !== null &&
        resolved.resolverAddress === success.resolverAddress &&
        resolved.target.kind === 'contract' &&
        resolved.target.hex === request.contractAddress;
    } catch {
      registryConfirmed = false;
    }
    if (!registryConfirmed && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }

  return {
    alias: success.alias,
    domain: success.domain,
    network: success.network,
    tldAddress: success.tldAddress,
    resolverAddress: success.resolverAddress,
    /* Both already 64-hex LEDGER hashes — the funder resolves the midnight-js
       identifiers before answering, so explorer links work as-is. */
    resolverDeployTxId: success.resolverDeployTx,
    registerTxId: success.registerTx,
    /* The leaf's owner-address half is zero-filled by the service — there is
       no payment address on a sponsored name, by design. */
    targetUnshieldedAddress: '',
    resolverTarget: 'contract',
    resolverTargetHex: request.contractAddress,
    claimedAt: success.registeredAt,
    registryConfirmed,
  };
}
