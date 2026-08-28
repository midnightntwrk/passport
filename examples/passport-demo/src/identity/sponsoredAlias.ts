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

/** How long one probe answer is trusted before the funder is asked again. */
const PROBE_TTL_MS = 30_000;
/** Ceiling on the probe round-trip — a slow funder must not stall a claim. */
const PROBE_TIMEOUT_MS = 4_000;
/**
 * Ceiling on the registration round-trip. The service submits two
 * transactions and waits for the registry to confirm before answering: 63 s
 * measured on preview with a remote proof server (2026/08/20), 113 s on
 * stagenet proving in-process on a laptop (2026/08/24), and slower again on a
 * small server. Matches the fee sponsor's own patience — abandoning a
 * registration the service is still proving costs more than waiting, because
 * the name then lands with nobody listening.
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
  ) {
    super(message);
    this.name = 'AliasSponsorRefusal';
  }
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
 */
export async function sponsorAliasRegistration(
  funderUrl: string,
  request: SponsorAliasRequest,
): Promise<AliasClaimResult> {
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

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Handled below: a non-JSON body from the funder is a refusal, not a crash.
  }

  if (!response.ok) {
    const refusal = (body ?? {}) as { error?: unknown; message?: unknown };
    const code = typeof refusal.error === 'string' ? refusal.error : 'unreachable';
    const message =
      typeof refusal.message === 'string'
        ? refusal.message
        : `The sponsorship service refused with status ${response.status}.`;
    if (code === 'funder-empty' || code === 'funder-no-dust' || code === 'rate-limited') {
      // The probe's cached "available" is now demonstrably stale.
      invalidateSponsorshipProbe(funderUrl);
    }
    throw new AliasSponsorRefusal(code, message, !NO_FALLBACK_CODES.has(code));
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
