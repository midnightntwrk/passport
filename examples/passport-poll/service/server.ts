/* ===========================================================================
 * The vote-tally service
 * ===========================================================================
 *
 * A Node HTTP server with no dependencies, on its own port, holding the polls
 * in memory and writing them to one JSON file so a restart does not lose the
 * recording. `tally.ts` makes every decision; this file only moves bytes.
 *
 * It is served from a DIFFERENT origin from the app, so CORS is not optional.
 * The allowed origins are listed rather than reflected: `*` would let any page
 * on the internet read the receipts, and this is a demonstration of consent.
 * ========================================================================= */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  castVote,
  createPoll,
  emptyState,
  results,
  type TallyState,
  confirmVote,
} from './tally.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5183);
const STORE = resolve(process.env.POLL_STORE ?? `${HERE}/data/polls.json`);
const ALLOWED_ORIGINS = (process.env.POLL_ALLOWED_ORIGINS ?? 'http://localhost:5182,http://127.0.0.1:5182')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

/* --- persistence ---------------------------------------------------------- */

function load(): TallyState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(STORE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Partial<TallyState>;
      return {
        polls: Array.isArray(record.polls) ? record.polls : [],
        votes: Array.isArray(record.votes) ? record.votes : [],
      };
    }
  } catch {
    /* No file yet, or an unreadable one. Either way we start clean rather than
       refusing to boot in the middle of a recording. */
  }
  return emptyState();
}

const state = load();

function save(): void {
  try {
    mkdirSync(dirname(STORE), { recursive: true });
    writeFileSync(STORE, JSON.stringify(state, null, 2));
  } catch (cause) {
    console.warn(`[poll] could not write ${STORE}: ${String(cause)}`);
  }
}

/* --- HTTP ----------------------------------------------------------------- */

function cors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Max-Age', '600');
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    /* 16 KB is far more than any poll needs and far less than a denial of
       service. A body over the cap is refused rather than buffered. */
    if (size > 16_384) throw new Error('body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const REFUSALS: Record<string, string> = {
  'question-missing': 'A poll needs a question.',
  'question-too-long': 'That question is too long.',
  'too-few-options': 'A poll needs at least two options.',
  'too-many-options': 'A poll takes at most four options.',
  'option-too-long': 'One of those options is too long.',
  'duplicate-option': 'Two of those options are the same.',
  'unknown-poll': 'There is no poll with that reference.',
  'unknown-option': 'That is not one of the options.',
  'account-missing': 'Sign in with Passport before voting.',
  'proof-missing': 'That vote arrived without the proof Passport gives it.',
  'already-voted': 'This account has already voted in this poll.',
};

const server = createServer((request, response) => {
  void handle(request, response).catch(() => send(response, 400, { error: 'bad-request' }));
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  cors(request, response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'GET' && path === '/health') {
    send(response, 200, { ok: true, polls: state.polls.length, votes: state.votes.length });
    return;
  }

  if (request.method === 'GET' && path === '/api/polls') {
    send(response, 200, {
      polls: state.polls.map((poll) => results(state, poll.id)),
    });
    return;
  }

  if (request.method === 'POST' && path === '/api/polls') {
    const body = (await readJson(request)) as { question?: unknown; options?: unknown };
    const outcome = createPoll(state, { question: body.question, options: body.options });
    if (!outcome.ok) {
      send(response, 400, { error: outcome.reason, message: REFUSALS[outcome.reason] });
      return;
    }
    save();
    send(response, 201, { poll: results(state, outcome.value.id) });
    return;
  }

  const single = /^\/api\/polls\/([A-Za-z0-9_-]{1,32})$/.exec(path);
  if (request.method === 'GET' && single) {
    const found = results(state, single[1]!);
    if (!found) {
      send(response, 404, { error: 'unknown-poll', message: REFUSALS['unknown-poll'] });
      return;
    }
    send(response, 200, { poll: found });
    return;
  }

  const voting = /^\/api\/polls\/([A-Za-z0-9_-]{1,32})\/votes$/.exec(path);
  if (request.method === 'POST' && voting) {
    const body = (await readJson(request)) as Record<string, unknown>;
    const outcome = castVote(state, {
      pollId: voting[1],
      option: body.option,
      account: body.account,
      name: body.name,
      proof: body.proof,
    });
    if (!outcome.ok) {
      send(response, outcome.reason === 'already-voted' ? 409 : 400, {
        error: outcome.reason,
        message: REFUSALS[outcome.reason],
      });
      return;
    }
    save();
    send(response, 201, { poll: results(state, voting[1]!) });
    return;
  }

  send(response, 404, { error: 'not-found' });
}

/* Every vote names its own transaction. The service asks the indexer for it
   until it lands, then marks the vote confirmed with its block, so the Verify
   table can show a real chain reference rather than a promise. */
const INDEXER = process.env.POLL_INDEXER_URL ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
async function landed(hash: string): Promise<number | null> {
  for (const offset of [`hash: "${hash}"`, `identifier: "${hash}"`]) {
    try {
      const response = await fetch(INDEXER, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{ transactions(offset: { ${offset} }) { hash block { height } } }` }),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { data?: { transactions?: Array<{ block?: { height?: number } }> } };
      const found = body.data?.transactions?.[0];
      if (found) return found.block?.height ?? 0;
    } catch {
      /* try the next shape, or the next tick */
    }
  }
  return null;
}
setInterval(() => {
  void (async () => {
    let changed = false;
    for (const vote of state.votes) {
      if (!vote.proof.txHash || vote.proof.confirmed) continue;
      const block = await landed(vote.proof.txHash);
      if (block !== null && confirmVote(state, vote.pollId, vote.account, block)) changed = true;
    }
    if (changed) save();
  })();
}, 5_000).unref();

server.listen(PORT, () => {
  console.log(`[poll] tally service on http://localhost:${PORT}`);
  console.log(`[poll] answering ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`[poll] store ${STORE}`);
});
