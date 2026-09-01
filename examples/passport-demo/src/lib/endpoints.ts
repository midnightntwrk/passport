/**
 * An ORDERED LIST of endpoints, and the one rule for choosing between them.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026/08/31 the demo's proving, fee sponsorship, sponsored name
 * registration, and activation grants all rode one droplet
 * (`67.205.177.162`). Four independent things, one host, and any of its bad
 * days took the whole demo with it. Two of the four — proving and fee
 * sponsorship — have a second, independent provider available on stagenet:
 * the 1AM gateway at `https://api-stagenet.1am.xyz`, which serves `POST
 * /prove`, `POST /check`, `POST /balance-only`, and `GET /wallet-status` on the
 * same wire contract our own balancer was built against. The other two,
 * `/register-alias` and `/fund-account`, exist nowhere but our balancer
 * (probed 2026/08/31: the gateway answers both with `404 Endpoint not found`),
 * so they are deliberately NOT in scope here and `VITE_FUNDER_URL` keeps its
 * single-value meaning.
 *
 * So the two heaviest paths take a LIST rather than a URL, and this module is
 * the part of that which is a rule rather than a network call: how a list is
 * read out of an environment variable, and how one endpoint is chosen from it.
 * The rule lives here, alone, because it is the half that can be drilled — and
 * it is drilled, exhaustively, in `./endpoints.test.ts`.
 *
 * THE THREE PROPERTIES THAT MAKE THIS SAFE
 * ----------------------------------------
 *  1. **One endpoint behaves exactly as one URL did.** A list of one is not a
 *     new code path with a new failure mode: {@link firstEndpointThatServes}
 *     asks it, and either its answer or its failure is the whole outcome.
 *     Every caller preserves this — see `sponsorBalanceOnly` in `./sponsor.ts`,
 *     which rethrows a single endpoint's error verbatim rather than wrapping
 *     it.
 *  2. **Order is the operator's, not ours.** The list is tried left to right
 *     and nothing here reorders, load-balances, or remembers a winner between
 *     calls. An operator who writes `gateway,balancer` gets the gateway first
 *     every time, and can prove failover by writing it the other way round.
 *  3. **A fallback never changes what the user is told.** This module answers
 *     with an OUTCOME, never a substituted result: when every endpoint refuses,
 *     the caller gets each refusal and says the same thing it says today about
 *     one. Nothing here invents a success, and nothing here softens a failure.
 *
 * No `fetch`, no clock, no environment: an array in, a decision out.
 */

/**
 * What one endpoint said when it was asked.
 *
 * `served` is the only success. A refusal carries the endpoint's own words for
 * a log — never for a screen — and, when the refusal arrived as a thrown error,
 * the {@link EndpointRefusal.cause} that was thrown, so a caller that
 * classifies errors (a `429 PENDING_TRANSACTION` is worth waiting out; a `503`
 * is not) can still do so after the fall-through.
 */
export type EndpointAnswer<T> =
  | { served: true; value: T }
  | { served: false; reason: string };

/** One endpoint's refusal, with whatever it refused with. */
export interface EndpointRefusal {
  url: string;
  /** The endpoint's own diagnostic. A log line, never a sentence for a user. */
  reason: string;
  /** The thrown value, when the refusal arrived as a throw. */
  cause?: unknown;
}

/**
 * The result of asking a list. Either exactly one endpoint served — and it is
 * named, so an operator can tell where a transaction was proved and paid for —
 * or every one of them refused and each refusal is carried.
 *
 * `refusals` is present on BOTH, and that is deliberate. A fall-through that
 * succeeds is the single most important thing this change can put in a log: it
 * is the day the first provider broke and nobody noticed, which is exactly the
 * failure the second provider exists to absorb and exactly the failure a silent
 * success would hide until both were down.
 */
export type EndpointOutcome<T> =
  | { served: true; url: string; index: number; value: T; refusals: EndpointRefusal[] }
  | { served: false; refusals: EndpointRefusal[] };

/**
 * Reads a comma-separated endpoint list out of one environment variable.
 *
 * The single-value case is the whole point of the format: `VITE_SPONSOR_URL=
 * https://host/balancer` parses to a list of one and every caller then behaves
 * exactly as it did when the variable was a URL, so no deployment plumbing had
 * to be invented to carry a second provider — the existing variable simply
 * holds two values now.
 *
 * Blank entries are dropped rather than treated as endpoints (`a,,b` is two),
 * trailing slashes are stripped so `https://host/base/` and `https://host/base`
 * are one endpoint rather than two, and a repeated URL is kept only the first
 * time — a list that names the same host twice would otherwise ask it twice
 * before falling through, doubling the wait for no second opinion.
 *
 * Nothing here validates a URL. That is the caller's rule and differs between
 * them: `sponsor.ts` refuses plaintext outright, because a signed transaction
 * goes over that wire.
 */
export function parseEndpointList(value: string | null | undefined): string[] {
  if (typeof value !== 'string') return [];
  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const entry of value.split(',')) {
    const url = entry.trim().replace(/\/+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    endpoints.push(url);
  }
  return endpoints;
}

/**
 * Asks each endpoint in turn and answers with the first one that serves.
 *
 * Two ways of not serving, and they are deliberately the same to a caller of
 * this function while staying distinguishable to the caller of `ask`:
 *
 *   * `ask` answers `{ served: false, reason }` — the endpoint was reachable
 *     and said no. That is a readiness probe reporting a sponsor with no DUST
 *     free, and it is how "skip an endpoint that is not ready" is expressed.
 *   * `ask` THROWS — the request failed or timed out. The thrown value is
 *     carried on the refusal so a caller can classify it afterwards.
 *
 * Both fall through to the next endpoint; neither is allowed to end the walk,
 * because an endpoint that cannot serve is exactly the case a second provider
 * exists for. An endpoint that DOES serve ends it immediately — the ones after
 * it are never contacted, so a healthy first choice costs one request.
 *
 * An empty list answers `{ served: false, refusals: [] }` rather than throwing.
 * "Nothing is configured" is a real state — `VITE_SPONSOR_URL=off` — and it is
 * the caller that knows what to say about it.
 */
export async function firstEndpointThatServes<T>(
  urls: readonly string[],
  ask: (url: string, index: number) => Promise<EndpointAnswer<T>>,
): Promise<EndpointOutcome<T>> {
  const refusals: EndpointRefusal[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index] as string;
    try {
      const answer = await ask(url, index);
      if (answer.served) return { served: true, url, index, value: answer.value, refusals };
      refusals.push({ url, reason: answer.reason });
    } catch (cause) {
      refusals.push({
        url,
        reason: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    }
  }
  return { served: false, refusals };
}

/**
 * Every refusal on one line, for a log.
 *
 * Each endpoint is NAMED beside its reason, because "the sponsor was busy" is
 * a different operational fact from "both sponsors were busy" and an operator
 * reading one line should not have to guess which happened. An empty list says
 * so in words rather than producing an empty string that reads as a missing
 * message.
 *
 * This never reaches a screen. The user-facing sentence for an all-refused
 * outcome is unchanged and lives in `sponsorRefusal` — see the note there about
 * the day a wallet index and a DUST balance ended up in front of somebody.
 */
export function describeEndpointRefusals(refusals: readonly EndpointRefusal[]): string {
  if (refusals.length === 0) return 'no endpoint was configured';
  return refusals.map((refusal) => `${refusal.url}: ${refusal.reason}`).join('; ');
}
