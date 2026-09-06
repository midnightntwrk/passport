/**
 * The second opinion, tested without a node.
 *
 * Two things are proved here and they are the two the health ladder depends on.
 * The first is that the probe reads a real Substrate header — the body below is
 * the one `https://rpc.stagenet.shielded.tools` actually answered on
 * 2026/09/06, copied rather than invented, so a change in the node's shape
 * fails here rather than on the droplet. The second, and the more important, is
 * that NOTHING makes it throw: a timeout, a refused connection, a 502, a body
 * that is not JSON, a JSON-RPC error, a header with no number. Each of those is
 * a counted failure and a resolved promise, because a probe that could reject
 * into `assessHealth` would turn somebody else's node having a moment into this
 * wallet being called unreadable — which is a restart-eligible verdict.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chainHeadUrl,
  createChainHeadProbe,
  parseChainHead,
  type ChainHeadFetch,
  type ChainHeadRequest,
} from '../src/chainHead.js';

/**
 * The live stagenet answer of 2026/09/06, verbatim but for the trimmed digest.
 * `0x537ff` is 342,015.
 */
const STAGENET_HEADER = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    parentHash: '0xe7a6f8109b8dd490a109672b1a9102952f54499539c1e8a1f6ed5033af76b0c7',
    number: '0x537ff',
    stateRoot: '0xd859709aff546346c49764a2ca89953f7dfa5f4dc17bebf1008ed31a42d050fa',
    extrinsicsRoot: '0x6f3f41d6cd07b4adac2b74148cadcd7c733212ebee7248acee3dc04d81ca0942',
    digest: { logs: ['0x0661757261202de1c41100000000'] },
  },
};

/** A fetch that answers whatever the test hands it, and records the request. */
function fakeFetch(
  answers: Array<
    | { body: unknown; status?: number }
    | { throws: string }
    | { unparseable: true }
  >,
): { call: ChainHeadFetch; requests: Array<{ url: string; init: ChainHeadRequest }> } {
  const requests: Array<{ url: string; init: ChainHeadRequest }> = [];
  let index = 0;
  return {
    requests,
    call: async (url, init) => {
      requests.push({ url, init });
      const answer = answers[Math.min(index++, answers.length - 1)]!;
      if ('throws' in answer) throw new Error(answer.throws);
      if ('unparseable' in answer) {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('Unexpected token < in JSON at position 0');
          },
        };
      }
      const status = answer.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => answer.body };
    },
  };
}

describe('the node URL the head is asked on', () => {
  it('turns the configured WebSocket into the HTTPS endpoint beside it', () => {
    /* Stagenet's `BALANCER_NODE_URL` default. Substrate serves JSON-RPC on both
       transports at the same host and path. */
    assert.equal(
      chainHeadUrl('wss://rpc.stagenet.shielded.tools'),
      'https://rpc.stagenet.shielded.tools',
    );
  });

  it('downgrades an insecure WebSocket to plain HTTP rather than to HTTPS', () => {
    assert.equal(chainHeadUrl('ws://localhost:19944'), 'http://localhost:19944');
  });

  it('leaves an HTTP node URL exactly as configured', () => {
    /* `preview` and `preprod` are configured with `https` already, and an
       undeployed node with `http` — see `NETWORK_DEFAULTS` in `./config.ts`. */
    assert.equal(
      chainHeadUrl('https://rpc.preview.midnight.network'),
      'https://rpc.preview.midnight.network',
    );
    assert.equal(chainHeadUrl('http://localhost:19944'), 'http://localhost:19944');
  });

  it('does not mangle a path or a port on the way', () => {
    assert.equal(chainHeadUrl('wss://node.example:9944/rpc'), 'https://node.example:9944/rpc');
  });
});

describe('reading a header number', () => {
  it('reads the hex Substrate actually sends', () => {
    assert.equal(parseChainHead(STAGENET_HEADER), 342_015);
  });

  it('accepts a decimal string and a plain number, rather than insisting on hex', () => {
    /* A proxy or a differently-configured node answering in one of these is a
       reading the ladder can still use; refusing it would mean falling back to
       the thirty-minute rule for no reason at all. */
    assert.equal(parseChainHead({ result: { number: '342015' } }), 342_015);
    assert.equal(parseChainHead({ result: { number: 342_015 } }), 342_015);
  });

  it('refuses everything that is not a header number', () => {
    for (const body of [
      null,
      'not an object',
      {},
      { result: null },
      { result: {} },
      { result: { number: '' } },
      { result: { number: '  ' } },
      { result: { number: 'zero' } },
      { result: { number: '0xnothex' } },
      { result: { number: -1 } },
      { result: { number: 1.5 } },
      { result: { number: Number.NaN } },
      { error: { code: -32_601, message: 'Method not found' } },
    ]) {
      assert.equal(parseChainHead(body), null, `accepted ${JSON.stringify(body)}`);
    }
  });
});

describe('the head probe', () => {
  it('asks chain_getHeader by POST at the HTTPS endpoint', async () => {
    const fake = fakeFetch([{ body: STAGENET_HEADER }]);
    const probe = createChainHeadProbe({
      nodeUrl: 'wss://rpc.stagenet.shielded.tools',
      fetch: fake.call,
      now: () => 1_000,
    });
    const reading = await probe.read();

    assert.equal(probe.url, 'https://rpc.stagenet.shielded.tools');
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.url, 'https://rpc.stagenet.shielded.tools');
    assert.equal(fake.requests[0]!.init.method, 'POST');
    assert.equal(fake.requests[0]!.init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(fake.requests[0]!.init.body), {
      jsonrpc: '2.0',
      id: 1,
      method: 'chain_getHeader',
      params: [],
    });
    /* Bounded, and cancelled rather than merely stopped being waited on. */
    assert.ok(fake.requests[0]!.init.signal, 'the request carries an abort signal');

    assert.equal(reading.height, 342_015);
    assert.equal(reading.at, 1_000);
    assert.equal(reading.probeFailures, 0);
    assert.equal(reading.probes, 1);
    assert.equal(reading.failures, 0);
    assert.equal(reading.lastError, null);
  });

  it('resolves rather than throwing for every way the node can fail', async () => {
    /* The whole point of the module. Each of these used to be, in some other
       design, an exception into `assessHealth` — where an unreadable wallet is
       a restart-eligible verdict, and none of these is evidence about the
       wallet at all. */
    for (const answer of [
      { throws: 'The operation was aborted due to timeout' },
      { throws: 'fetch failed' },
      { body: {}, status: 502 },
      { unparseable: true as const },
      { body: { error: { code: -32_601, message: 'Method not found' } } },
      { body: { result: { parentHash: '0x00' } } },
    ]) {
      const probe = createChainHeadProbe({
        nodeUrl: 'wss://rpc.stagenet.shielded.tools',
        fetch: fakeFetch([answer]).call,
      });
      const reading = await probe.read();
      assert.equal(reading.height, null, `${JSON.stringify(answer)} produced a height`);
      assert.equal(reading.probeFailures, 1);
      assert.equal(reading.failures, 1);
      assert.notEqual(reading.lastError, null, 'a failure says why');
    }
  });

  it('counts consecutive failures and clears them on the next answer', async () => {
    const probe = createChainHeadProbe({
      nodeUrl: 'wss://rpc.stagenet.shielded.tools',
      now: () => 5_000,
      fetch: fakeFetch([
        { throws: 'fetch failed' },
        { throws: 'fetch failed' },
        { throws: 'fetch failed' },
        { body: STAGENET_HEADER },
      ]).call,
    });
    await probe.read();
    await probe.read();
    assert.equal((await probe.read()).probeFailures, 3);
    const recovered = await probe.read();
    assert.equal(recovered.probeFailures, 0, 'one good answer clears the streak');
    assert.equal(recovered.failures, 3, 'the running total is not cleared with it');
    assert.equal(recovered.height, 342_015);
    assert.equal(recovered.lastError, null);
  });

  it('keeps the last good height across failures, so its AGE is what betrays it', async () => {
    /* Sticky on purpose. Blanking the height on a failure would throw away the
       one figure a late-arriving verdict can be built from; what stops a stale
       height being mistaken for a live one is `probeFailures` and the age of
       `at`, both of which the health policy insists on. */
    const probe = createChainHeadProbe({
      nodeUrl: 'wss://rpc.stagenet.shielded.tools',
      now: () => 9_000,
      fetch: fakeFetch([{ body: STAGENET_HEADER }, { throws: 'fetch failed' }]).call,
    });
    await probe.read();
    const stale = await probe.read();
    assert.equal(stale.height, 342_015, 'the last good height survives');
    assert.equal(stale.at, 9_000, 'and so does when it was read');
    assert.equal(stale.probeFailures, 1, 'which is how a reader knows not to trust it');
  });

  it('reports what it last read without asking again', async () => {
    const fake = fakeFetch([{ body: STAGENET_HEADER }]);
    const probe = createChainHeadProbe({
      nodeUrl: 'wss://rpc.stagenet.shielded.tools',
      fetch: fake.call,
      now: () => 3_000,
    });
    assert.equal(probe.reading().height, null, 'nothing read yet');
    await probe.read();
    assert.equal(probe.reading().height, 342_015);
    assert.equal(fake.requests.length, 1, '`reading()` opens no request — /status polls it');
  });

  it('moves the height as the chain moves, which is the whole measurement', async () => {
    const probe = createChainHeadProbe({
      nodeUrl: 'wss://rpc.stagenet.shielded.tools',
      now: () => 1,
      fetch: fakeFetch([
        { body: { result: { number: '0x537ff' } } },
        { body: { result: { number: '0x53831' } } },
      ]).call,
    });
    assert.equal((await probe.read()).height, 342_015);
    /* 0x53831 is 342,065 — fifty blocks on, which is five minutes of stagenet. */
    assert.equal((await probe.read()).height, 342_065);
  });
});
