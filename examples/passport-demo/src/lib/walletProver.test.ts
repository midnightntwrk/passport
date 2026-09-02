/**
 * The drill for the bug that broke every shielded send, and it is a drill about
 * ONE STRING: where a wallet proof is actually POSTed.
 *
 * The wallet SDK's own client composes `new URL('/prove', baseUrl)`, and an
 * absolute path replaces the base's path — so a proof server configured as
 * `https://host/prover` was posted to at `https://host/prove`, which on the
 * deployed Caddy is a catch-all that answers without a CORS header. Nothing
 * about that failure looks like a URL: it arrives in a browser as a blocked
 * preflight, and it reached users as a fee-sponsorship refusal.
 *
 * So the assertion is on the request line a REAL server received, from the REAL
 * proving client, over a real socket. Nothing here is stubbed, and that is
 * deliberate: a stubbed HTTP client is exactly what would have agreed with the
 * broken code. `cross-fetch` is bundled inside the proving client and cannot be
 * mocked from here anyway — a listener on `127.0.0.1` is both the honest test
 * and the only one available.
 *
 * The one thing that has to be built rather than faked is a proof preimage:
 * `createProvingPayload` deserialises it before any request is made. The
 * shortest well-formed one is the tag and seven bytes, which is what
 * {@link MINIMAL_PREIMAGE} is.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';

import { httpWalletProvingService } from './walletProver.js';
import type { ProvableTransaction } from './walletProver.js';

/**
 * The shortest byte string `@midnightntwrk/ledger-v9` accepts as a serialised
 * proof preimage: the tag, then the seven bytes its deserialiser reads. Enough
 * to get a request onto the wire, which is all this file is about.
 */
const MINIMAL_PREIMAGE = (() => {
  const tag = new TextEncoder().encode('midnight:proof-preimage:');
  const preimage = new Uint8Array(tag.length + 7);
  preimage.set(tag, 0);
  return preimage;
})();

const PROOF = Uint8Array.from([0xaa, 0xbb]);

const servers: Server[] = [];

/** A proof server that records every path it was asked for. */
async function proofServer(): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(Buffer.from(PROOF));
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${address.port}`, paths };
}

/** An address nothing is listening on, so a POST to it is refused outright. */
async function deadAddress(): Promise<string> {
  const { url } = await proofServer();
  const server = servers.pop() as Server;
  server.close();
  await once(server, 'close');
  return url;
}

/**
 * A transaction that proves itself by asking the provider for exactly one
 * circuit — the wallet's Zswap spend, which is the leg `deposit_shielded`
 * needs and the leg that was failing.
 */
function transactionProvingOneCircuit(): ProvableTransaction & { costModel: unknown } {
  const tx = {
    costModel: undefined as unknown,
    async prove(provingProvider: unknown, costModel: unknown): Promise<unknown> {
      tx.costModel = costModel;
      return (
        provingProvider as {
          prove(preimage: Uint8Array, keyLocation: string): Promise<Uint8Array>;
        }
      ).prove(MINIMAL_PREIMAGE, 'midnight/zswap/spend');
    },
  };
  return tx;
}

describe('httpWalletProvingService', () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        server.close();
        await once(server, 'close');
      }),
    );
  });

  it('keeps the path of the configured proof server', async () => {
    const server = await proofServer();
    const tx = transactionProvingOneCircuit();
    const proof = await httpWalletProvingService([`${server.url}/prover`])({}).prove(tx);

    /* The whole fix. `/prove` appended to the base's own path — NOT `/prove`
       at the origin, which is where the SDK's own client sent it and where the
       deployed Caddy answers without a CORS header. */
    expect(server.paths).toEqual(['/prover/prove']);
    expect(Array.from(proof as Uint8Array)).toEqual([0xaa, 0xbb]);
    // And the ledger's own cost model reached the transaction's `prove`.
    expect(tx.costModel).toBeDefined();
  });

  it('leaves a bare origin alone', async () => {
    const server = await proofServer();
    await httpWalletProvingService([server.url])({}).prove(transactionProvingOneCircuit());
    expect(server.paths).toEqual(['/prove']);
  });

  it('falls through to the second proof server, and says which one served', async () => {
    const down = await deadAddress();
    const up = await proofServer();
    const logged: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      const proof = await httpWalletProvingService([`${down}/prover`, `${up.url}/prover`])(
        {},
      ).prove(transactionProvingOneCircuit());
      expect(Array.from(proof as Uint8Array)).toEqual([0xaa, 0xbb]);
    } finally {
      info.mockRestore();
    }
    expect(up.paths).toEqual(['/prover/prove']);
    /* An operator's line, and the reason a second prover is worth having: a
       silent fall-through is how nobody notices the first one died until the
       second one dies too. */
    const log = logged.join('\n');
    expect(log).toContain('[contract] prove midnight/zswap/spend by');
    expect(log).toContain(`${up.url}/prover`);
    expect(log).toContain(`${down}/prover`);
    /* Thirty seconds because midnight-js's own proof-server client retries a
       failed request three times with 1/2/4 s backoff before it gives up — the
       same ladder that made a broken gateway cost seven seconds per circuit in
       production. The fall-through starts after it, not instead of it. */
  }, 30_000);

  it('names every proof server when none of them could prove', async () => {
    const first = await deadAddress();
    const second = await deadAddress();
    const failure = await httpWalletProvingService([first, second])({})
      .prove(transactionProvingOneCircuit())
      .catch((cause: unknown) => cause);
    expect(String(failure)).toMatch(/no proof server could prove midnight\/zswap\/spend/);
    expect(String(failure)).toContain(first);
    expect(String(failure)).toContain(second);
  }, 30_000);

  it('builds the proving provider once, however many proofs it serves', async () => {
    const server = await proofServer();
    const service = httpWalletProvingService([`${server.url}/prover`], {
      // Both options exercised here: an injected resolver and an explicit
      // timeout, neither of which production passes.
      zkConfigProvider: { get: () => Promise.reject(new Error('not ours')) },
      timeoutMs: 5_000,
    })({});
    await service.prove(transactionProvingOneCircuit());
    await service.prove(transactionProvingOneCircuit());
    expect(server.paths).toEqual(['/prover/prove', '/prover/prove']);
  });

  it('refuses to build a service with no proof server, by name', () => {
    /* At construction rather than at the first spend, where the failure would
       arrive as a message about `undefined` in the middle of a transfer. */
    expect(() => httpWalletProvingService([])).toThrow(/VITE_MIDNIGHT_PROVING_URL/);
  });
});
