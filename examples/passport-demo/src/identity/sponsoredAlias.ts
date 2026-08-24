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
 * This module is the client half: one probe that asks the funder whether it is
 * sponsoring right now, and one call that asks it to register. Everything the
 * funder refuses comes back as a typed {@link AliasSponsorRefusal} so the
 * caller can decide — honestly, per code — whether the self-paid path is worth
 * offering instead. The self-paid path in `midnames.ts` is unchanged and
 * remains the fallback, not a dead branch: it is what runs when no funder is
 * configured, when the funder is out of NIGHT, or when this Passport already
 * had its one sponsored name and the user wants another.
 *
 * The service stands in for Midnames-side sponsorship until the Midnames team
 * runs their own; nothing in the protocol is Passport-specific.
 * WHERE THIS STANDS ON STAGENET (2026/08/24)
 * ------------------------------------------
 * Nowhere, and by design rather than by omission. This module is pure
 * transport — it holds no ledger, no SDK, and no contract — so the move to
 * ledger-9 changed nothing in it. What changed is the answer it gets:
 * {@link checkAliasSponsorship} requires the funder's own `/status` to report
 * the network being claimed on, and the deployed funder reports
 * `network: "preview"`. On stagenet it therefore returns `false`, every time,
 * and the caller takes the self-paid path.
 *
 * That is the correct behaviour and it needs no gate of its own: the funder
 * genuinely cannot register a stagenet name — it holds preview NIGHT, on a
 * preview wallet, against the preview registry. The stagenet balancer at
 * `/balancer` sponsors FEES and nothing else; it has no `/register-alias` and
 * does not send NIGHT. So on stagenet a registration's COST is the user's, and
 * the code already says so rather than hoping.
 */

import type { AliasClaimResult, MidnamesNetwork } from './midnames.js';

/** How long one probe answer is trusted before the funder is asked again. */
const PROBE_TTL_MS = 30_000;
/** Ceiling on the probe round-trip — a slow funder must not stall a claim. */
const PROBE_TIMEOUT_MS = 4_000;
/**
 * Ceiling on the registration round-trip. The funder submits two transactions
 * and waits for the registry to confirm before answering — 63 s measured on
 * preview 2026/08/20 — so this is generous but not unbounded.
 */
const REGISTER_TIMEOUT_MS = 180_000;

/** The funder's refusal, verbatim: its `error` code and its human sentence. */
export class AliasSponsorRefusal extends Error {
  constructor(
    /** The funder's machine-readable `error` code, or `'unreachable'`. */
    readonly code: string,
    message: string,
    /**
     * Whether falling back to the SELF-PAID claim is honest for this code.
     * False where the fallback could double-register (`registration-in-flight`,
     * `confirmation-failed` — the sponsored name may have landed) or where it
     * would fail identically (`name-taken`).
     */
    readonly selfPayWorthTrying: boolean,
  ) {
    super(message);
    this.name = 'AliasSponsorRefusal';
  }
}

/** Codes after which the self-paid path must NOT be attempted. */
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
 * unexpected body is `false`: the self-paid path is the honest answer when the
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
  /**
   * This Passport's unshielded `mn_addr…` address, for the leaf's payment
   * half — exactly what the self-paid path writes there.
   */
  ownerAddress: string;
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
 * `registryConfirmed` to `false` — the same honest "awaiting the registry"
 * the self-paid path reports — it never fails the claim.
 *
 * Refusals throw {@link AliasSponsorRefusal}; the caller inspects
 * `selfPayWorthTrying` before offering the self-paid path.
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
        ownerAddress: request.ownerAddress,
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
       no registration at all — but without a fallback, because something DID
       land and a self-paid attempt on top of it could double-register. */
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
    targetUnshieldedAddress: request.ownerAddress,
    resolverTarget: 'contract',
    resolverTargetHex: request.contractAddress,
    claimedAt: success.registeredAt,
    registryConfirmed,
  };
}
