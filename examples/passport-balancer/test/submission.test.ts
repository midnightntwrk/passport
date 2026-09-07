/**
 * The wait that never returned, and the properties that end it.
 *
 * THE FAILURE THIS PINS DOWN. On 2026/09/02 two spend jobs went silent holding
 * a lane — 23:03:31 and 23:46:30 UTC — with the proof server idle and not one
 * journal line between the hang and the operator's restart, thirty-seven and
 * twenty-three minutes later. Both jobs' transactions had ALREADY LANDED: the
 * resolver-leaf deploys are in stagenet blocks 291694 and 292118. What never
 * returned was the node submission underneath `deployContract`.
 *
 * Every version of that failure comes from one line in the SDK's node client:
 * `sendMidnightTransaction` ends every submission stream with
 * `Stream.ensuring(api.disconnect())`, and `PolkadotNodeClient.make`
 * disconnects again as soon as it has loaded its metadata. polkadot-js drops
 * `author_*` subscriptions across a close without erroring them — that is the
 * hang — and `WsProvider.disconnect()` resolves before the close event, whose
 * `#onSocketClose` then errors every handler in the provider-wide map — that is
 * the refusal `job-16` died of at 02:28 UTC on 2026/09/03, on a disconnect
 * belonging to a submission that had already finished.
 *
 * Two narrower fixes were tried and measured failing on the deployed service.
 * Serialising submissions does not help, because the harm arrives after the
 * submission that caused it is over. A connection per submission does not help
 * either: the client disconnects during its own construction, so a client built
 * moments before its submission kills that submission with its own start-up
 * close — every spare-mint attempt at 02:40 and 02:41 UTC failed exactly that
 * way.
 *
 * So this service now owns the connection and never disconnects it while it is
 * running. These tests hold the queue, the ceiling, and the acceptance
 * semantics around it — everything except the socket, which is
 * `polkadotConnection` and is exercised live.
 *
 * The last assertions are the ones that keep the fix honest: a node REFUSAL must
 * still travel out unchanged, because `isNodeRejection` matches on its message
 * and `withNodeRejectionRetry` is what turns a refusal into a rebuild.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNodeRejection } from '../src/account.js';
import {
  isSocketFailure,
  isSubmissionTimeout,
  isUnsentSocketFailure,
  polkadotConnection,
  serialiseSubmissions,
  SubmissionTimeout,
  type MidnightApi,
  type NodeConnection,
} from '../src/submission.js';

/** A transaction of the shape the facade hands down: it serialises itself. */
function tx(name: string): { serialize: () => Uint8Array; name: string } {
  return { name, serialize: () => new TextEncoder().encode(name) };
}

/** A node connection under this test's control. */
function fakeConnection(behaviour: (name: string) => Promise<string>): {
  connection: NodeConnection;
  sent: Array<{ name: string; at: number }>;
  closed: () => boolean;
} {
  const sent: Array<{ name: string; at: number }> = [];
  let wasClosed = false;
  return {
    sent,
    closed: () => wasClosed,
    connection: {
      send(transaction: Uint8Array) {
        const name = new TextDecoder().decode(transaction);
        sent.push({ name, at: Date.now() });
        return behaviour(name);
      },
      close: async () => {
        wasClosed = true;
      },
    },
  };
}

describe('one connection, never disconnected under a submission', () => {
  it('serialises the transaction and hands the bytes straight to the node', async () => {
    const { connection, sent } = fakeConnection(async () => '0xhash');
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 1_000 });

    const result = await wrapped.submitTransaction(tx('one'));

    assert.deepEqual(
      sent.map((call) => call.name),
      ['one'],
    );
    assert.deepEqual(result, { txHash: '0xhash' });
  });

  it('closes the connection only when the service itself is closed', async () => {
    /* The facade calls `close()` from `stop()`, and that is the ONLY disconnect
       this module performs. A submission that closed anything would be the
       whole defect back again. */
    const { connection, closed } = fakeConnection(async () => '0xhash');
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 1_000 });

    await wrapped.submitTransaction(tx('one'));
    assert.equal(closed(), false, 'submitting disconnected nothing');
    await wrapped.submitTransaction(tx('two'));
    assert.equal(closed(), false, 'and neither did the one after it');

    await wrapped.close();
    assert.equal(closed(), true);
  });
});

describe('bounding a node submission', () => {
  it('gives up on a submission that never answers, and says so in its own type', async () => {
    /* The hang itself: the node's status callback simply never arrives, which
       is what a dropped `author_*` subscription looks like from up here. */
    const { connection } = fakeConnection(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 60 });

    const started = Date.now();
    const failure = await wrapped.submitTransaction(tx('one')).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.ok(failure instanceof SubmissionTimeout, 'the wait ends in a SubmissionTimeout');
    assert.ok(isSubmissionTimeout(failure), 'and the predicate matches it across a bundle');
    assert.ok(
      Date.now() - started < 1_000,
      'and it ends when the ceiling says so, not when the node feels like it',
    );
  });

  it('names the wait it abandoned, without claiming the transaction failed', async () => {
    const { connection } = fakeConnection(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 40 });
    const failure = (await wrapped.submitTransaction(tx('one')).catch((c: unknown) => c)) as Error;
    /* The wording matters as much as the type: both hangs had landed, so a
       message that said "this transaction failed" would be false, and `submitTx`
       would be entitled to revert DUST the chain has genuinely spent. */
    assert.match(failure.message, /may still have landed/);
  });

  it("ends the wait when the running job's watchdog aborts it", async () => {
    /* The watchdog rejects the job; without this the node's promise would keep
       the queue — and so every later submission — waiting behind a job that has
       already been given up on. */
    const abort = new AbortController();
    const { connection } = fakeConnection(() => new Promise(() => undefined));
    const wrapped = serialiseSubmissions(connection, {
      timeoutMs: 60_000,
      signal: () => abort.signal,
    });

    const pending = wrapped.submitTransaction(tx('one')).catch((cause: unknown) => cause);
    abort.abort(new Error('stalled'));
    assert.ok(isSubmissionTimeout(await pending));
  });
});

describe('never two submissions at once', () => {
  it('starts the second only after the first has settled', async () => {
    /* Safety no longer depends on this, but the node still sees one transaction
       of this wallet's at a time, built against one view of its coins. */
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const { connection } = fakeConnection(
      (name) =>
        new Promise((settle) => {
          order.push(`start ${name}`);
          if (name === 'first') releaseFirst = () => settle('0xhash');
          else settle('0xhash');
        }),
    );
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 5_000 });

    const first = wrapped.submitTransaction(tx('first'));
    const second = wrapped.submitTransaction(tx('second'));
    await new Promise((settle) => setTimeout(settle, 20));

    assert.deepEqual(order, ['start first'], 'the second submission has not touched the node');
    assert.ok(releaseFirst, 'the first is still open');
    (releaseFirst as unknown as () => void)();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['start first', 'start second']);
  });

  it('lets the next submission through after one that failed', async () => {
    /* A rejected predecessor must not poison the chain: the node refuses
       transactions routinely — twice in each of the 2026/09/02 hangs — and a
       queue that stopped at the first refusal would be a worse wedge than the
       one being fixed. */
    const seen: string[] = [];
    const { connection } = fakeConnection(async (name) => {
      seen.push(name);
      if (name === 'refused') throw new Error('1010: Invalid Transaction: Custom error: 231');
      return '0xhash';
    });
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 5_000 });

    const refused = wrapped.submitTransaction(tx('refused')).catch((cause: unknown) => cause);
    const after = wrapped.submitTransaction(tx('after'));
    await refused;

    assert.deepEqual(await after, { txHash: '0xhash' });
    assert.deepEqual(seen, ['refused', 'after']);
  });

  it('holds the next submission for the ceiling, then lets it through', async () => {
    /* A timed-out submission is abandoned, not cancelled. What is guaranteed is
       that the next one waits out the first's whole ceiling rather than starting
       alongside it. */
    const starts: number[] = [];
    const { connection } = fakeConnection(
      () =>
        new Promise(() => {
          starts.push(Date.now());
        }),
    );
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 60 });

    const at = Date.now();
    await Promise.allSettled([
      wrapped.submitTransaction(tx('one')),
      wrapped.submitTransaction(tx('two')),
    ]);

    assert.equal(starts.length, 2);
    assert.ok(starts[0]! - at < 40, 'the first went straight to the node');
    assert.ok(
      starts[1]! - starts[0]! >= 55,
      'the second waited out the first ceiling instead of overlapping it',
    );
  });
});

describe('what the wrapper must not change', () => {
  it('passes a node refusal out untouched, so it can still be rebuilt', async () => {
    /* `withNodeRejectionRetry` matches on this message. A wrapper that wrapped
       it, or replaced it with its own error, would silently turn every
       recoverable refusal into a failed activation. */
    const { connection } = fakeConnection(async () => {
      throw new Error(
        'RPC-CORE: submitAndWatchExtrinsic: 1010: Invalid Transaction: Custom error: 231',
      );
    });
    const wrapped = serialiseSubmissions(connection, { timeoutMs: 5_000 });

    const failure = await wrapped.submitTransaction(tx('one')).catch((cause: unknown) => cause);
    assert.ok(isNodeRejection(failure), 'still recognised as a node rejection');
    assert.equal(isSubmissionTimeout(failure), false, 'and not mistaken for a timeout');
  });

  it('reports the step a job is on, so a queued submission is not silent', async () => {
    /* With submissions serialised, a job whose turn has not come is genuinely
       doing nothing. Without these steps that silence is what the stall
       watchdog aborts jobs for. */
    const steps: string[] = [];
    const { connection } = fakeConnection(async () => '0xhash');
    const wrapped = serialiseSubmissions(connection, {
      timeoutMs: 1_000,
      onStep: (step) => steps.push(step),
    });

    await wrapped.submitTransaction(tx('one'));
    assert.deepEqual(steps, ['waiting to submit', 'submitting']);
  });
});

/* -------------------------------------------------------------------------- */
/* The dead socket, and the rebuild that ends it                              */
/* -------------------------------------------------------------------------- */

/**
 * THE OUTAGE THESE PIN DOWN. On 2026/09/05 the wallet's node websocket died at
 * 14:48 UTC. At 15:28 the health loop said `degraded: the wallet's sync indices
 * have not moved in 40 min` and remedied it with `refresh`, which re-read the
 * wallet and never touched this connection. From 15:30:27 until an operator
 * restarted the unit at 20:12, EVERY submission failed instantly — 520 of them
 * — with `RPC-CORE: submitAndWatchExtrinsic … WebSocket is not connected` and
 * `Failed WS Request author_submitAndWatchExtrinsic`, while `/status` reported
 * `synced: true`, `busy: false`, and both sponsorships `available`. The public
 * node was healthy throughout.
 *
 * The provider's auto-reconnect had wedged and `connect()` on a provider in
 * that state rejects — which this module used to swallow as "the provider is
 * doing exactly what is wanted". These are the cases that say it no longer
 * waits on a reconnect it cannot see.
 *
 * The socket is otherwise the one part of this module a unit test cannot reach,
 * which is what `createApi` is for: everything below drives the REAL
 * `polkadotConnection`, with only the `ApiPromise` factory replaced.
 */

/** A polkadot-js api under this test's control. */
function fakeApi(options: {
  connected: boolean;
  /** Rejects, like a provider with a reconnect already in flight. */
  connectRejects?: boolean;
  /** What `.send()` does. Defaults to acknowledging with a hash. */
  send?: (payload: string) => Promise<string>;
  /**
   * `undefined` offers the head subscription and never delivers a header;
   * a function is handed the emit callback so a case can deliver whatever it
   * likes; `false` offers no subscription at all, like a client that does not
   * implement it.
   */
  heads?: false | ((emit: (height: number) => void) => void);
  name: string;
}): MidnightApi & {
  sends: string[];
  disconnected: () => boolean;
  connects: () => number;
  unsubscribed: () => number;
} {
  const sends: string[] = [];
  let wasDisconnected = false;
  let connects = 0;
  let unsubscribes = 0;
  const api = {
    isConnected: options.connected,
    sends,
    disconnected: () => wasDisconnected,
    connects: () => connects,
    unsubscribed: () => unsubscribes,
    async connect(): Promise<void> {
      connects += 1;
      if (options.connectRejects) throw new Error('WebSocket is not connected');
    },
    async disconnect(): Promise<void> {
      wasDisconnected = true;
    },
    rpc: {
      chain: {
        getHeader: async () => ({ number: { toNumber: () => 1 } }),
        ...(options.heads === false
          ? {}
          : {
              async subscribeNewHeads(
                callback: (header: { number: { toNumber(): number } }) => void,
              ): Promise<() => void> {
                if (typeof options.heads === 'function') {
                  options.heads((height: number) =>
                    callback({ number: { toNumber: () => height } }),
                  );
                }
                return () => {
                  unsubscribes += 1;
                };
              },
            }),
      },
    },
    tx: {
      midnight: {
        sendMnTransaction(payload: string) {
          return {
            async send(callback: (result: never) => void): Promise<() => void> {
              sends.push(payload);
              const behaviour = options.send ?? (async () => `0x${options.name}`);
              const hash = await behaviour(payload);
              (callback as unknown as (r: unknown) => void)({
                txHash: { toString: () => hash },
                status: {
                  type: 'Ready',
                  isReady: true,
                  isBroadcast: false,
                  isFuture: false,
                  isInBlock: false,
                  isFinalized: false,
                  isRetracted: false,
                  isInvalid: false,
                  isDropped: false,
                  isUsurped: false,
                },
              });
              return () => undefined;
            },
          };
        },
      },
    },
  };
  return api as unknown as ReturnType<typeof fakeApi>;
}

describe('recognising a failure of the transport rather than of the transaction', () => {
  it('matches both forms the 520 failures of 2026/09/05 arrived in', () => {
    for (const message of [
      'RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: WebSocket is not connected',
      'Failed WS Request author_submitAndWatchExtrinsic',
    ]) {
      assert.ok(isSocketFailure(new Error(message)), message);
      assert.ok(
        isUnsentSocketFailure(new Error(message)),
        'and both are refusals to queue the request, so the bytes never left',
      );
    }
  });

  it('counts a mid-flight disconnect as a socket failure but never as a resendable one', () => {
    /* The older defect. The request HAD gone out when the close event errored
       its handler, so resending it would be this service putting the same
       transaction on chain twice. Rebuilt, reported, not retried. */
    const cause = new Error('disconnected from wss://rpc.stagenet.shielded.tools/: 1000:: Normal Closure');
    assert.equal(isSocketFailure(cause), true);
    assert.equal(isUnsentSocketFailure(cause), false);
  });

  it('leaves a node refusal alone — that is a rebuild for the caller, not for the socket', () => {
    const refusal = new Error(
      'RPC-CORE: submitAndWatchExtrinsic: 1010: Invalid Transaction: Custom error: 231',
    );
    assert.equal(isSocketFailure(refusal), false);
    assert.ok(isNodeRejection(refusal), 'and it is still what `withNodeRejectionRetry` matches');
  });

  it('walks the cause chain, because the SDK wraps its failures several deep', () => {
    const wrapped = new Error('the mint could not be submitted', {
      cause: new Error('WebSocket is not connected'),
    });
    assert.equal(isSocketFailure(wrapped), true);
  });
});

describe('rebuilding a submission connection that has died', () => {
  it('builds a fresh api when the socket is down and `connect()` rejects', async () => {
    /* Exactly the state the deployed provider was in for five hours:
       `isConnected` false, and `connect()` rejecting because it believes a
       reconnect is already in flight. The old code awaited that rejection,
       swallowed it, and submitted on the dead socket anyway. */
    const dead = fakeApi({ name: 'dead', connected: false, connectRejects: true });
    const fresh = fakeApi({ name: 'fresh', connected: true });
    const built: string[] = [];
    let next = 0;
    const connection = polkadotConnection(
      { relayURL: new URL('wss://rpc.stagenet.shielded.tools') },
      {
        log: () => undefined,
        createApi: async () => {
          const api = next++ === 0 ? dead : fresh;
          built.push(next === 1 ? 'dead' : 'fresh');
          return api;
        },
      },
    );

    const hash = await connection.send(new TextEncoder().encode('one'));

    assert.deepEqual(built, ['dead', 'fresh'], 'a second api was built, not a second connect()');
    assert.equal(dead.connects(), 1, 'the cheap repair was tried exactly once');
    assert.equal(dead.disconnected(), true, 'and the old one was disconnected and discarded');
    assert.deepEqual(dead.sends, [], 'nothing was submitted on the dead socket');
    assert.equal(fresh.sends.length, 1, 'the submission went out on the new api');
    assert.equal(hash, '0xfresh');
  });

  it('retries once on a rebuilt connection when a submission fails on the socket', async () => {
    /* The 15:30:27-to-20:12 case seen from one submission's point of view: the
       api believes it is connected, and the send is refused by the transport. */
    let failNext = true;
    const first = fakeApi({
      name: 'first',
      connected: true,
      send: async () => {
        if (failNext) {
          failNext = false;
          throw new Error(
            'RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: WebSocket is not connected',
          );
        }
        return '0xfirst';
      },
    });
    const second = fakeApi({ name: 'second', connected: true });
    let next = 0;
    const connection = polkadotConnection(
      { relayURL: new URL('wss://rpc.stagenet.shielded.tools') },
      { log: () => undefined, createApi: async () => (next++ === 0 ? first : second) },
    );

    const hash = await connection.send(new TextEncoder().encode('one'));

    assert.equal(hash, '0xsecond', 'the second attempt’s answer is the one returned');
    assert.equal(first.disconnected(), true, 'the socket that refused was thrown away');
    assert.equal(second.sends.length, 1, 'and the retry went out on the rebuilt one');
    const health = connection.socketHealth?.();
    assert.equal(health?.nodeSocket, 'connected');
    assert.equal(health?.consecutiveSocketFailures, 0, 'a submission that goes out clears the count');
    assert.equal(health?.rebuilds, 1);
  });

  it('retries once and no more', async () => {
    /* A socket that is genuinely gone must not turn one submission into an
       unbounded loop of proofs and rebuilds. */
    const refuse = (name: string) =>
      fakeApi({
        name,
        connected: true,
        send: async () => {
          throw new Error('Failed WS Request author_submitAndWatchExtrinsic');
        },
      });
    const apis = [refuse('a'), refuse('b'), refuse('c')];
    let next = 0;
    const connection = polkadotConnection(
      { relayURL: new URL('wss://rpc.stagenet.shielded.tools') },
      { log: () => undefined, createApi: async () => apis[Math.min(next++, 2)]! },
    );

    const failure = await connection.send(new TextEncoder().encode('one')).catch((c: unknown) => c);

    assert.ok(failure instanceof Error);
    assert.equal(apis[0]!.sends.length, 1);
    assert.equal(apis[1]!.sends.length, 1, 'one retry');
    assert.equal(apis[2]!.sends.length, 0, 'and not a second');
    const health = connection.socketHealth?.();
    assert.equal(health?.nodeSocket, 'dead');
    assert.equal(health?.consecutiveSocketFailures, 2);
  });

  it('does not resend a submission whose bytes had already gone out', async () => {
    /* `disconnected from …` reaches a request that was already on the wire.
       Resending it would risk the same transaction landing twice, which is a
       far worse fault than the failure being repaired. */
    const first = fakeApi({
      name: 'first',
      connected: true,
      send: async () => {
        throw new Error('disconnected from wss://rpc.stagenet.shielded.tools/: 1000:: Normal Closure');
      },
    });
    const second = fakeApi({ name: 'second', connected: true });
    let next = 0;
    const connection = polkadotConnection(
      { relayURL: new URL('wss://rpc.stagenet.shielded.tools') },
      { log: () => undefined, createApi: async () => (next++ === 0 ? first : second) },
    );

    const failure = await connection.send(new TextEncoder().encode('one')).catch((c: unknown) => c);

    assert.match((failure as Error).message, /Normal Closure/, 'the caller hears the real fault');
    assert.equal(second.sends.length, 0, 'and nothing was put on chain a second time');
    assert.equal(
      connection.socketHealth?.().rebuilds,
      1,
      'the connection was still rebuilt for whatever comes next',
    );
  });

  it('passes a node refusal straight out without rebuilding anything', async () => {
    /* The property the whole module rests on: `withNodeRejectionRetry` matches
       on this message, and a socket that rebuilt itself on every `1010` would
       throw the connection away on the service's most ordinary failure. */
    const only = fakeApi({
      name: 'only',
      connected: true,
      send: async () => {
        throw new Error('1010: Invalid Transaction: Custom error: 231');
      },
    });
    const connection = polkadotConnection(
      { relayURL: new URL('wss://rpc.stagenet.shielded.tools') },
      { log: () => undefined, createApi: async () => only },
    );

    const failure = await connection.send(new TextEncoder().encode('one')).catch((c: unknown) => c);

    assert.ok(isNodeRejection(failure));
    assert.equal(connection.socketHealth?.().rebuilds, 0, 'no rebuild');
    assert.equal(connection.socketHealth?.().consecutiveSocketFailures, 0, 'and nothing counted');
  });

  it('counts rebuilds that fail, which is what the health loop escalates on', async () => {
    let next = 0;
    const connection = polkadotConnection(
      { relayURL: new URL('wss://rpc.stagenet.shielded.tools') },
      {
        log: () => undefined,
        createApi: async () => {
          if (next++ === 0) return fakeApi({ name: 'first', connected: false, connectRejects: true });
          throw new Error('connect ECONNREFUSED');
        },
      },
    );

    await connection.send(new TextEncoder().encode('one')).catch(() => undefined);
    await connection.rebuild?.('a second attempt').catch(() => undefined);

    const health = connection.socketHealth?.();
    assert.equal(health?.nodeSocket, 'dead');
    assert.equal(health?.consecutiveRebuildFailures, 2, 'two in a row, which is the escalation fact');
  });

  it('bounds a rebuild that never finishes', async () => {
    /* A rebuild that hangs is the outage again with a different shape: the
       submission would be abandoned on its own ceiling and the next one would
       find the same half-built connection waiting. */
    let next = 0;
    const connection = polkadotConnection(
      { relayURL: new URL('wss://rpc.stagenet.shielded.tools') },
      {
        log: () => undefined,
        rebuildTimeoutMs: 40,
        createApi: async () => {
          if (next++ === 0) return fakeApi({ name: 'first', connected: false, connectRejects: true });
          return await new Promise<never>(() => undefined);
        },
      },
    );

    const started = Date.now();
    await connection.send(new TextEncoder().encode('one')).catch(() => undefined);

    assert.ok(Date.now() - started < 1_000, 'the rebuild gave up on its own clock');
    assert.equal(connection.socketHealth?.().consecutiveRebuildFailures, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The node list, and the head this connection watches on it                  */
/* -------------------------------------------------------------------------- */

const PAYLOAD = new Uint8Array([1, 2, 3]);
const A = new URL('wss://ours.example');
const B = new URL('wss://theirs.example');

describe('opening the submission connection over a list of nodes', () => {
  it('opens on the first node and never contacts the second', async () => {
    const asked: string[] = [];
    const connection = polkadotConnection(
      { relayURL: A, relayURLs: [A, B] },
      {
        log: () => undefined,
        createApi: async (url) => {
          asked.push(url);
          return fakeApi({ name: 'first', connected: true });
        },
      },
    );
    await connection.send(PAYLOAD);
    assert.deepEqual(asked, [A.toString()]);
    assert.equal(connection.socketHealth?.().nodeUrlInUse, A.toString());
  });

  it('falls through to the second when the first will not build, and says so', async () => {
    const lines: string[] = [];
    const asked: string[] = [];
    const connection = polkadotConnection(
      { relayURL: A, relayURLs: [A, B] },
      {
        log: (line) => lines.push(line),
        createApi: async (url) => {
          asked.push(url);
          if (url === A.toString()) throw new Error('connection refused');
          return fakeApi({ name: 'second', connected: true });
        },
      },
    );
    await connection.send(PAYLOAD);
    assert.deepEqual(asked, [A.toString(), B.toString()]);
    assert.equal(connection.socketHealth?.().nodeUrlInUse, B.toString());
    /* The line that matters most on the day this earns its keep: a fall-through
       that succeeded in silence is the outage nobody noticed. */
    assert.ok(
      lines.some((line) => line.includes('fell through to') && line.includes('connection refused')),
      lines.join('\n'),
    );
  });

  it('starts again at the FIRST node on every rebuild', async () => {
    /* No cursor and no memory of which node failed last time: a rebuild is the
       moment to ask the preferred provider whether it is back, and an outage
       that is over should not need a restart to be noticed. */
    const asked: string[] = [];
    let firstWorks = false;
    const connection = polkadotConnection(
      { relayURL: A, relayURLs: [A, B] },
      {
        log: () => undefined,
        createApi: async (url) => {
          asked.push(url);
          if (url === A.toString() && !firstWorks) throw new Error('connection refused');
          return fakeApi({ name: url, connected: true });
        },
      },
    );
    await connection.send(PAYLOAD);
    assert.equal(connection.socketHealth?.().nodeUrlInUse, B.toString());

    firstWorks = true;
    await connection.rebuild?.('the preferred node may be back');
    await connection.send(PAYLOAD);
    assert.equal(connection.socketHealth?.().nodeUrlInUse, A.toString());
    assert.deepEqual(asked, [A.toString(), B.toString(), A.toString()]);
  });

  it('behaves exactly as one node did when only one is configured', async () => {
    /* The failure message is the node's own, not a list's summary of it. */
    const connection = polkadotConnection(
      { relayURL: A },
      {
        log: () => undefined,
        createApi: async () => {
          throw new Error('connection refused');
        },
      },
    );
    await assert.rejects(connection.send(PAYLOAD), /connection refused/);
  });
});

describe('the head this connection watches', () => {
  it('records every header the socket delivers', async () => {
    let emit: ((height: number) => void) | null = null;
    const connection = polkadotConnection(
      { relayURL: A },
      {
        log: () => undefined,
        createApi: async () =>
          fakeApi({
            name: 'node',
            connected: true,
            heads: (send) => {
              emit = send;
            },
          }),
      },
    );
    await connection.send(PAYLOAD);
    let head = connection.socketHealth?.().socketHead;
    assert.equal(head?.subscribed, true);
    assert.equal(head?.height, null, 'subscribed, and no header yet');
    assert.equal(head?.headers, 0);

    (emit as unknown as (height: number) => void)(342_015);
    (emit as unknown as (height: number) => void)(342_016);
    head = connection.socketHealth?.().socketHead;
    assert.equal(head?.height, 342_016);
    assert.equal(head?.headers, 2);
    assert.ok(head?.at !== null);
  });

  it('never lets a late or out-of-order header lower the head', async () => {
    let emit: ((height: number) => void) | null = null;
    const connection = polkadotConnection(
      { relayURL: A },
      {
        log: () => undefined,
        createApi: async () =>
          fakeApi({ name: 'node', connected: true, heads: (send) => (emit = send) }),
      },
    );
    await connection.send(PAYLOAD);
    (emit as unknown as (height: number) => void)(342_016);
    (emit as unknown as (height: number) => void)(342_015);
    assert.equal(connection.socketHealth?.().socketHead.height, 342_016);
  });

  it('starts the count again on a rebuild, rather than carrying it over', async () => {
    /* `headers` counts what the CURRENT connection has delivered, so a fresh
       connection delivering nothing is visibly a fresh connection delivering
       nothing — which is exactly what the silence limb of the stall rule reads. */
    let emit: ((height: number) => void) | null = null;
    const connection = polkadotConnection(
      { relayURL: A },
      {
        log: () => undefined,
        createApi: async () =>
          fakeApi({ name: 'node', connected: true, heads: (send) => (emit = send) }),
      },
    );
    await connection.send(PAYLOAD);
    (emit as unknown as (height: number) => void)(342_015);
    assert.equal(connection.socketHealth?.().socketHead.headers, 1);

    await connection.rebuild?.('a drill');
    const head = connection.socketHealth?.().socketHead;
    assert.equal(head?.headers, 0);
    assert.equal(head?.height, null);
    assert.equal(head?.subscribed, true, 'the watch is re-established on the new connection');
  });

  it('keeps a connection whose client offers no head subscription, and calls it unknown', async () => {
    /* A node client without `subscribeNewHeads` submits perfectly well. What it
       costs is one signal, and `./health.ts` reads `subscribed: false` with no
       header as no evidence rather than as a stall. */
    const connection = polkadotConnection(
      { relayURL: A },
      {
        log: () => undefined,
        createApi: async () => fakeApi({ name: 'node', connected: true, heads: false }),
      },
    );
    await connection.send(PAYLOAD);
    const head = connection.socketHealth?.().socketHead;
    assert.equal(head?.subscribed, false);
    assert.equal(head?.height, null);
    assert.equal(connection.socketHealth?.().nodeSocket, 'connected', 'still a usable socket');
  });
});
