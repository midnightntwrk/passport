/**
 * A SECOND FUNDER, AND THE ONE THING IT IS NEVER ALLOWED TO DO.
 *
 * WHY THIS IS NOT JUST `endpoints.ts` AGAIN
 * -----------------------------------------
 * `VITE_SPONSOR_URL` and `VITE_MIDNIGHT_PROVING_URL` have been ordered lists
 * since 2026/08/31, and the rule there is simple because the work there is
 * repeatable: a proof computed twice is the same proof, and a transaction
 * balanced by the second sponsor after the first refused costs nobody
 * anything. Falling through on ANY refusal is correct for them.
 *
 * `VITE_FUNDER_URL` is not that. The three routes behind it — `POST
 * /register-alias`, `POST /fund-account`, and the `GET /status` both read —
 * are the ones that SPEND, and a standby funder is a DIFFERENT WALLET with its
 * own NIGHT, its own DUST, and its own once-per-account ledger. Two funders
 * asked the same question answer it twice:
 *
 *   * `/register-alias` — the first funder has already registered the name, so
 *     the second registers nothing and refuses `name-taken`. Survivable (the
 *     claim classification in `identity/sponsoredAlias.ts` knows that refusal
 *     and `lib/claimFailure.ts` has copy for it), but it burns the second
 *     funder's registry price and shows the reader a refusal for a name that
 *     is, in fact, theirs.
 *   * `/fund-account` — the activation grant is once per account FOR EVER, and
 *     the "once" is each funder's own ledger. Two funders asked in turn grant
 *     twice, and the second grant cannot be recovered.
 *
 * So the rule this module holds is narrower than the sponsor's by exactly one
 * clause: **fall through only when the funder did not answer.** A refusal is
 * an answer. A 4xx is an answer. A `429` is an answer. A `503` carrying a JSON
 * body that names a code (`INSUFFICIENT_DUST`, `PAUSED`, `wallet-syncing`) is
 * the funder itself saying no, and is an answer. What is NOT an answer is a
 * socket that never opened, a request that timed out, and a `502`/`503`/`504`
 * whose body names nothing — the shape a reverse proxy emits when the service
 * behind it is down, which is the whole reason a standby droplet exists.
 *
 * THE DOUBLE GRANT THAT REMAINS POSSIBLE, AND WHY IT IS BOUNDED
 * ------------------------------------------------------------
 * One window survives this rule and cannot be closed from the client: the
 * first funder ACTED and its answer was lost on the way back — it granted, or
 * registered, and then the connection dropped, or the edge timed out while the
 * funder was still proving. From here that is indistinguishable from a funder
 * that never received the request, so the standby is asked and may act again.
 *
 * It is bounded, not prevented, and the bounds are the checks the client
 * already makes before it ever asks:
 *
 *   * `App.tsx#accountFundingAttempted` — a localStorage marker per contract
 *     address, written only on evidence the grant exists, read before every
 *     attempt and again after every backoff wait. A grant that landed stops
 *     the schedule even if this browser never saw the answer that said so.
 *   * `lib/activation.ts#classifyFundAccountAnswer` — the funder's own
 *     `already-funded` answer is a SUCCESS with `rememberFunded`, so the
 *     second funder discovering the first funder's deposit records it rather
 *     than retrying into it.
 *   * `lib/activationHold.ts` — a name the funder refused holds the grant, so
 *     the account is not funded ahead of a name it may never get.
 *   * `identity/accountCustody.ts` — the account contract's own
 *     `night_balances` mirror is what a withdrawal is checked against, so a
 *     second grant is visible and spendable rather than lost, and it is a
 *     funder's budget that pays for it rather than a user's.
 *
 * Two funders can therefore over-fund one demo account. They cannot under-fund
 * one, and they cannot leave a Passport without a name. That is the trade this
 * module makes deliberately.
 *
 * No `fetch` and no clock live here: a status and a body in, a decision out,
 * drilled in `./funderFailover.test.ts`.
 */

import {
  describeEndpointRefusals,
  firstEndpointThatServes,
  type EndpointOutcome,
} from './endpoints.js';

/**
 * The statuses a reverse proxy emits ON BEHALF OF a service that did not
 * answer it. Caddy in front of the balancer answers `502` with an HTML body
 * when the Node process is down, and `504` when it is up but wedged; a
 * `503` with no body is the same class of fact from a proxy that spells it
 * differently.
 *
 * Every one of them is overridden by a JSON body naming a code, because the
 * funder itself also answers `503` — `wallet-syncing`, `funder-no-dust` — and
 * that IS an answer. See {@link funderAnsweredWith}.
 */
const EDGE_STATUSES = new Set([502, 503, 504]);

/**
 * The refusal code a funder body names, or `null` if it names none.
 *
 * Both spellings are read because both are in use across the two services:
 * `examples/passport-balancer` answers `{ "error": "wallet-syncing" }` on the
 * alias and activation routes, and the fee routes answer `{ "code":
 * "INSUFFICIENT_DUST" }`. A body that is not an object, or whose field is not
 * a non-empty string, names nothing — an HTML error page from an edge parses
 * to `null` here, which is exactly the case this exists to catch.
 */
export function funderRefusalCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  for (const field of ['error', 'code'] as const) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Whether an HTTP answer counts as THE FUNDER ANSWERING — the only question
 * this module exists to settle.
 *
 * `true` for every 2xx, for every 4xx including `429`, for a `500`, and for a
 * `502`/`503`/`504` whose body names a code. `false` only for a bare
 * `502`/`503`/`504`, which is an edge speaking for a service that did not.
 *
 * A `500` is deliberately on the answering side: it comes out of the funder's
 * own process, so it is a funder that received the request and may well have
 * acted on it before it fell over. Falling through on one is the double-grant
 * this module refuses to make routine.
 */
export function funderAnsweredWith(status: number, body: unknown): boolean {
  if (funderRefusalCode(body) !== null) return true;
  return !EDGE_STATUSES.has(status);
}

/** What one funder said when it was asked. A refusal is a value, not a failure. */
export type FunderAnswer<T> =
  | { answered: true; value: T }
  | { answered: false; reason: string };

/** A funder that did not answer, phrased for {@link firstFunderThatAnswers}. */
export function funderDidNotAnswer(reason: string): FunderAnswer<never> {
  return { answered: false, reason };
}

/**
 * How long a transport failure is described as, for a log.
 *
 * The message is the browser's own (`Failed to fetch`, `The operation was
 * aborted`) and reaches nobody but an operator — see the note in
 * `endpoints.ts#describeEndpointRefusals` about the day a sponsor's own words
 * ended up on a screen.
 */
export function funderTransportReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Asks each funder in turn and stops at the first that ANSWERS — where an
 * answer includes every refusal the funder made itself.
 *
 * This is `firstEndpointThatServes` with nothing added but a log line, and
 * deliberately so: the walk is the drilled one, and the narrowing that makes
 * it safe for a spending service happens at the `ask` callback, which returns
 * {@link funderDidNotAnswer} for an unreachable funder and `{ answered: true }`
 * for everything else — a refusal included, carried out as the value so the
 * caller classifies it exactly as it classifies one funder's refusal today.
 *
 * A caller's `ask` should not throw. One that does is treated as a funder that
 * did not answer, which is the right reading of a `fetch` rejection and the
 * only thing a throw from here can honestly mean.
 *
 * THE LOG LINE. One `console.info` per failover, naming the INDEX in the
 * operator's own list first and the URL second, plus what was fallen through.
 * It is the day the primary funder broke and nobody noticed — the failure the
 * standby exists to absorb, and the one a silent success hides until both are
 * down. Nothing here reaches a screen and no user copy changes: a funder that
 * fell through says exactly what one funder says today.
 */
export async function firstFunderThatAnswers<T>(
  urls: readonly string[],
  ask: (url: string, index: number) => Promise<FunderAnswer<T>>,
  what: string,
  log: (message: string) => void = (message) => console.info(message),
): Promise<EndpointOutcome<T>> {
  const outcome = await firstEndpointThatServes<T>(urls, async (url, index) => {
    const answer = await ask(url, index);
    return answer.answered
      ? { served: true, value: answer.value }
      : { served: false, reason: answer.reason };
  });
  if (outcome.served && outcome.refusals.length > 0) {
    log(
      `[funder] ${what} answered by endpoint ${outcome.index} (${outcome.url}) after ${describeEndpointRefusals(
        outcome.refusals,
      )}`,
    );
  }
  return outcome;
}
