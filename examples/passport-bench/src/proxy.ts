/**
 * The instrumented reverse proxy every virtual user's traffic goes through.
 *
 * WHY A PROXY AND NOT A WRAPPED `fetch`
 * -------------------------------------
 * The two halves of a sponsored transaction do not share an HTTP client. The
 * sponsor client in `sponsor.ts` calls `globalThis.fetch`, which under Node is
 * undici; midnight-js's proof-server client imports `cross-fetch`, which under
 * Node is `node-fetch` and never touches the global. Wrapping one misses the
 * other, and wrapping both means patching two unrelated stacks and hoping a
 * dependency bump does not move one of them.
 *
 * A proxy is agnostic to all of that. It sees `/wallet-status`, `/balance-only`,
 * `/prove`, and `/check` alike, with real status codes and real byte counts,
 * because it is the thing on the other end of the socket. It is also the shape
 * the 2026/09/01 gateway measurements were taken with, so these numbers are
 * comparable to those.
 *
 * WHICH USER, AND WHICH ENDPOINT
 * ------------------------------
 * Both are read out of the request path, never inferred:
 *
 *     http://127.0.0.1:PORT/<user>/<role><index>/<the endpoint's own path>
 *     http://127.0.0.1:PORT/vu03/s0/balance-only  →  the balancer's /balance-only
 *     http://127.0.0.1:PORT/vu03/p1/prove         →  the gateway's /prove
 *
 * A worker is handed `…/vu03/s0,…/vu03/s1` as its sponsor list and the ordered
 * failover the app performs is preserved exactly: `s0` before `s1` is the
 * operator's order, and the proxy reorders nothing. What it adds is that a
 * fall-through is now VISIBLE — `s0` answering 429 and `s1` answering 200 are
 * two records with two upstreams, and no console line has to be parsed to know
 * which sponsor paid.
 *
 * `127.0.0.1` is deliberate: `assertSecureSponsorUrl` refuses plaintext for
 * anything that is not loopback, and a signed transaction goes over this wire.
 * The proxy never leaves the machine and the upstream leg is HTTPS.
 *
 * WHAT IT RECORDS AND WHAT IT REFUSES TO
 * --------------------------------------
 * Sizes, status codes, and durations. Request bodies are never recorded: a
 * `/balance-only` body is a signed transaction and a `/prove` body is 280 KB of
 * proving input. A RESPONSE body is kept only when the response was not a 2xx,
 * truncated to 300 characters, because a refusal's own words are the finding —
 * `A balance transaction is already pending` and `INSUFFICIENT_DUST` are
 * different answers to the same question and the whole report turns on which
 * one came back.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { HttpEvent, UpstreamRef } from './events.js';

/** Headers that belong to one hop and must not be forwarded to the next. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/**
 * Response headers that describe the body AS THE UPSTREAM SENT IT, and are
 * lies by the time this proxy passes the body on.
 *
 * `fetch` decompresses transparently, so what the proxy holds is plain bytes
 * while the upstream's `content-encoding: gzip` still says otherwise. Forwarded
 * unchanged, that header makes every client downstream try to gunzip plain
 * JSON. It cost the bench's first live run: two `GET /wallet-status` calls came
 * back `200` with a perfectly good body, the sponsor client could not parse
 * either, and the whole Passport was refused with "the fee sponsor cannot be
 * reached right now" — a proxy bug wearing the costume of the exact finding
 * this bench exists to report.
 *
 * `content-length` is dropped for the same reason and belongs to a hop anyway.
 */
const RESPONSE_ONLY_DROP = new Set(['content-encoding', 'content-length']);

/** How much of a refusal's body is worth keeping. */
const REFUSAL_EXCERPT = 300;

export interface ProxyHandle {
  /** `http://127.0.0.1:PORT`. */
  origin: string;
  /**
   * The base URL a given user should be handed for a given endpoint —
   * `origin/<user>/<role><index>`.
   */
  baseFor(user: string, role: 'sponsor' | 'prover', index: number): string;
  /** The comma-separated list for one user, in the operator's order. */
  listFor(user: string, role: 'sponsor' | 'prover'): string;
  close(): Promise<void>;
}

export interface ProxyOptions {
  sponsors: UpstreamRef[];
  provers: UpstreamRef[];
  /** Called once per completed request, successful or not. */
  onRequest: (event: HttpEvent) => void;
}

function roleTag(role: 'sponsor' | 'prover'): string {
  return role === 'sponsor' ? 's' : 'p';
}

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const lists: Record<'sponsor' | 'prover', UpstreamRef[]> = {
    sponsor: options.sponsors,
    prover: options.provers,
  };

  const resolveUpstream = (segment: string): UpstreamRef | null => {
    const role = segment.startsWith('s') ? 'sponsor' : segment.startsWith('p') ? 'prover' : null;
    if (!role) return null;
    const index = Number(segment.slice(1));
    if (!Number.isInteger(index)) return null;
    return lists[role][index] ?? null;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const started = Date.now();
    const raw = request.url ?? '/';
    const [pathname = '/', query] = raw.split('?');
    const segments = pathname.split('/').filter((segment) => segment.length > 0);
    const [user, upstreamTag, ...rest] = segments;

    const upstream = upstreamTag ? resolveUpstream(upstreamTag) : null;
    if (!user || !upstream) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('The bench proxy expects /<user>/<role><index>/<path>.\n');
      return;
    }

    const body = await readBody(request);
    const target = `${upstream.url}/${rest.join('/')}${query ? `?${query}` : ''}`;

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      if (typeof value === 'string') headers[name] = value;
    }

    const record = (status: number, responseBytes: number, refusal?: string): void => {
      options.onRequest({
        kind: 'http',
        user,
        upstream,
        method: request.method ?? 'GET',
        path: `/${rest.join('/')}`,
        ms: Date.now() - started,
        status,
        requestBytes: body.length,
        responseBytes,
        startedAt: started,
        ...(refusal ? { refusal } : {}),
      });
    };

    try {
      const answer = await fetch(target, {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body: new Uint8Array(body) }),
      });
      const payload = Buffer.from(await answer.arrayBuffer());

      /* Only a refusal's words are kept, and only a short excerpt of them. A
         2xx body is a balanced transaction or a proof and has no place in a
         results file. */
      const refusal = answer.ok
        ? undefined
        : payload.toString('utf8').slice(0, REFUSAL_EXCERPT).replace(/\s+/g, ' ').trim();
      record(answer.status, payload.length, refusal);

      const out: Record<string, string> = {};
      answer.headers.forEach((value, name) => {
        const key = name.toLowerCase();
        if (HOP_BY_HOP.has(key) || RESPONSE_ONLY_DROP.has(key)) return;
        out[name] = value;
      });
      response.writeHead(answer.status, out);
      response.end(payload);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      /* `0` is "the upstream never answered", which is a different fact from
         any status it could have returned, and the failover walk treats it
         differently too: a throw falls through, a refusal falls through with
         the endpoint's own reason. */
      record(0, 0, message.slice(0, REFUSAL_EXCERPT));
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('the bench proxy could not reach the upstream\n');
    }
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((cause) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(cause));
    });
  });

  /* A contract proof can take minutes and midnight-js allows it ten. Node's
     defaults would cut the socket off long before that and the bench would
     report a timeout that belongs to the bench. */
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 30_000;

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the proxy took no port');
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    baseFor: (user, role, index) => `${origin}/${user}/${roleTag(role)}${index}`,
    listFor: (user, role) =>
      lists[role].map((_, index) => `${origin}/${user}/${roleTag(role)}${index}`).join(','),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
