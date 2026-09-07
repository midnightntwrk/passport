/**
 * An ORDERED LIST of endpoints, and the one rule for choosing between them.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026/09/06 this service depended on exactly one node
 * (`wss://rpc.stagenet.shielded.tools`) and exactly one indexer
 * (`https://indexer.stagenet.shielded.tools/api/v4/graphql`), both of them
 * defaults in the network table in `./config.ts`. Neither is ours, neither has
 * an availability promise, and a bad afternoon at either one is a sponsor that
 * cannot register a name, cannot fund an account, and cannot balance a fee —
 * with nothing an operator can do about it but wait.
 *
 * Nothing here makes a second provider appear. What it does is make adding one
 * a CONFIGURATION CHANGE rather than a code change: both endpoints now take a
 * comma-separated list, the singular variables keep working as a list of one,
 * and every place that opens a connection or asks a question walks the list.
 * Until somebody writes a second URL into `BALANCER_NODE_URLS` or
 * `BALANCER_INDEXER_URLS`, every list has one entry and every walk is one
 * attempt — which is exactly what this service did yesterday.
 *
 * THE RULE IS THE DEMO'S RULE
 * ---------------------------
 * `examples/passport-demo/src/lib/endpoints.ts` already decides this for the
 * browser's sponsorship and proving endpoints, and it is deliberately the same
 * decision here rather than a second one that could drift from it. The
 * semantics are copied; the code is not imported, because these are two
 * separately built packages and a shared module between them would be a build
 * dependency neither of them wants.
 *
 *  1. **One endpoint behaves exactly as one URL did.** A list of one is not a
 *     new code path with a new failure mode: it is asked, and either its answer
 *     or its failure is the whole outcome.
 *  2. **Order is the operator's, not ours.** The list is tried left to right and
 *     nothing here reorders, load-balances, or remembers a winner BETWEEN
 *     calls. An operator who writes `ours,theirs` gets ours first every time,
 *     and can prove failover by writing it the other way round.
 *  3. **A fallback never invents an answer.** This module answers with an
 *     OUTCOME. When every endpoint refuses, the caller gets each refusal and
 *     says the same thing it says today about one.
 *
 * WHAT A CONNECTION IS ALLOWED TO DO INSTEAD
 * ------------------------------------------
 * Rule 2 is about CALLS. A connection-oriented thing — the submission
 * `ApiPromise`, the wallet facade's own relay client, an Apollo client over a
 * graphql-ws socket — naturally stays on the URL it opened, because that is
 * what a connection is. It returns to the front of the list when it is next
 * REBUILT, which is the point at which the preferred provider may be back.
 *
 * No `fetch`, no clock, no environment: an array in, a decision out.
 */

/**
 * Reads a comma-separated endpoint list out of one environment variable.
 *
 * The single-value case is the whole point of the format: `BALANCER_NODE_URL=
 * wss://rpc.stagenet.shielded.tools` parses to a list of one and every caller
 * then behaves exactly as it did when the variable was a URL, so no deployment
 * plumbing had to be invented to carry a second provider — the existing
 * variable simply holds two values now.
 *
 * Blank entries are dropped rather than treated as endpoints (`a,,b` is two),
 * surrounding whitespace goes (`a, b` is two, not one of them named ` b`),
 * trailing slashes are stripped so `https://host/base/` and `https://host/base`
 * are one endpoint rather than two, and a repeated URL is kept only the first
 * time — a list that names the same host twice would otherwise ask it twice
 * before falling through, doubling the wait for no second opinion.
 *
 * Nothing here validates a URL. `networkEndpoints` in `./config.ts` is where a
 * list that parses to nothing becomes the error it is.
 */
export function parseUrlList(value: string | null | undefined): string[] {
  if (typeof value !== 'string') return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of value.split(',')) {
    const url = entry.trim().replace(/\/+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** What one endpoint said when it was asked. `served` is the only success. */
export type UrlAnswer<T> = { served: true; value: T } | { served: false; reason: string };

/** One endpoint's refusal, with whatever it refused with. */
export interface UrlRefusal {
  url: string;
  /** The endpoint's own diagnostic. A log line, never a sentence for a user. */
  reason: string;
  /** The thrown value, when the refusal arrived as a throw. */
  cause?: unknown;
}

/**
 * The result of asking a list. Either exactly one endpoint served — and it is
 * NAMED, so an operator can tell which provider answered — or every one of them
 * refused and each refusal is carried.
 *
 * `refusals` is present on both, and deliberately: a fall-through that succeeds
 * is the single most important thing this change can put in a log. It is the
 * day the first provider broke and nobody noticed, which is exactly the failure
 * the second provider exists to absorb and exactly the failure a silent success
 * would hide until both were down.
 */
export type UrlOutcome<T> =
  | { served: true; url: string; index: number; value: T; refusals: UrlRefusal[] }
  | { served: false; refusals: UrlRefusal[] };

/**
 * Asks each URL in turn and answers with the first one that serves.
 *
 * Two ways of not serving, and they fall through identically: `ask` answering
 * `{ served: false, reason }` — the endpoint was reachable and could not help —
 * and `ask` THROWING, which is a request that failed or timed out. Neither ends
 * the walk, because an endpoint that cannot serve is exactly the case a second
 * provider exists for. An endpoint that DOES serve ends it immediately, so a
 * healthy first choice costs one attempt.
 *
 * An empty list answers `{ served: false, refusals: [] }` rather than throwing.
 */
export async function firstUrlThatServes<T>(
  urls: readonly string[],
  ask: (url: string, index: number) => Promise<UrlAnswer<T>>,
): Promise<UrlOutcome<T>> {
  const refusals: UrlRefusal[] = [];
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
 * Each endpoint is NAMED beside its reason, because "the indexer would not
 * answer" is a different operational fact from "both indexers would not answer"
 * and an operator reading one line should not have to guess which happened.
 */
export function describeUrlRefusals(refusals: readonly UrlRefusal[]): string {
  if (refusals.length === 0) return 'no endpoint was configured';
  return refusals.map((refusal) => `${refusal.url}: ${refusal.reason}`).join('; ');
}

/* -------------------------------------------------------------------------- */
/* The indexer                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One indexer URL, or the ordered list of them.
 *
 * Both accepted so the query helpers below could take the list without every
 * one of their thirty-odd call sites having to change in the same commit, and
 * so a test can still hand one of them a single string.
 */
export type IndexerUrls = string | readonly string[];

/** The list form of {@link IndexerUrls}, whichever form was given. */
export function urlsOf(urls: IndexerUrls): readonly string[] {
  return typeof urls === 'string' ? [urls] : urls;
}

/**
 * Which indexer most recently answered a question, published on `/status` as
 * `indexerUrlInUse`.
 *
 * Module state, and that is the honest shape for it: the indexer is asked from
 * eight modules and from every spend job, and threading an observability
 * counter through all of them would be a larger change than the failover
 * itself. It is READ-ONLY as far as behaviour is concerned — no decision in
 * this service consults it, and rule 2 above forbids one from ever doing so.
 * It answers one question for an operator: which provider is currently carrying
 * this sponsor.
 */
let lastIndexerServed: string | null = null;

/** The indexer that last answered, or `null` before any of them has. */
export function indexerUrlInUse(): string | null {
  return lastIndexerServed;
}

/** For tests, which must not inherit a previous case's winner. */
export function forgetIndexerUrlInUse(): void {
  lastIndexerServed = null;
}

/**
 * Runs one indexer query over the list and returns the first USABLE answer.
 *
 * `usable` is the caller's own idea of an answer worth keeping, and it has to
 * be, because these helpers do not agree on what failure looks like: one
 * returns `null`, one returns `{ reachable: false }`, one returns the
 * identifier it was given. Whatever the caller calls unusable is a refusal here
 * and the next URL is tried; a thrown error is the same. When no URL serves,
 * the LAST answer is returned unchanged — so a single-URL list returns exactly
 * what its one query returned, which is the whole of yesterday's behaviour.
 */
export async function askIndexers<T>(
  urls: IndexerUrls,
  ask: (url: string) => Promise<T>,
  usable: (value: T) => boolean,
): Promise<T> {
  const list = urlsOf(urls);
  if (list.length === 0) {
    throw new Error('no indexer URL is configured');
  }
  let last: T | undefined;
  let lastFailure: unknown;
  let answered = false;
  for (const url of list) {
    try {
      const value = await ask(url);
      answered = true;
      last = value;
      if (usable(value)) {
        lastIndexerServed = url;
        return value;
      }
    } catch (cause) {
      lastFailure = cause;
    }
  }
  if (answered) return last as T;
  throw lastFailure instanceof Error
    ? lastFailure
    : new Error(`no indexer answered: ${String(lastFailure)}`);
}
