/**
 * Drills for the one thing that can go wrong in the browser prover and leave
 * nothing on the screen at all: the worker stops answering.
 *
 * iOS reclaims memory by jettisoning workers and killing the WebContent
 * process, and neither event reaches the page. `callWorker` had no timeout, no
 * signal, and no cancellation, so a proof interrupted by the user switching
 * apps hung for ever — on the send screen, after the first leg of a shielded
 * send may already have moved the note. What is asserted here is that it now
 * ends: in a fresh worker and a second attempt, and failing that in a sentence
 * naming something the reader can do.
 *
 * The two Midnight imports are mocked away. Neither is exercised by anything
 * below — one supplies a cost model the fake transaction ignores, the other a
 * registry the wallet service never builds — and loading either drags a wasm
 * module into a test about message plumbing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@midnightntwrk/ledger-v9', () => ({
  CostModel: { initialCostModel: () => ({ costModel: true }) },
}));
vi.mock('@midnight-ntwrk/midnight-js-types', () => ({
  ZKConfigRegistry: class {
    async resolveKeyLocation(): Promise<undefined> {
      return undefined;
    }
  },
  zkConfigToProvingKeyMaterial: (value: unknown) => value,
}));

import {
  PROOF_UNFINISHED_MESSAGE,
  PROOF_WORKER_IDLE_MS,
  setProofWorkerSpawn,
  wasmWalletProvingService,
} from './wasmProver.js';

/**
 * A worker that does exactly what it is told to and nothing on its own — so a
 * test can make it answer, go quiet, or crash, which are the three things a
 * real one does.
 */
class FakeWorker {
  static live: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly posted: Array<{ message: any; transfer: readonly unknown[] }> = [];
  terminated = false;
  /** Answers every `prove`/`check` with this, unless it is null (goes quiet). */
  answer: ((message: any) => unknown) | null = null;
  /** What a freshly spawned worker answers with, since the spawn is lazy. */
  static defaultAnswer: ((message: any) => unknown) | null = null;

  constructor() {
    this.answer = FakeWorker.defaultAnswer;
    FakeWorker.live.push(this);
  }

  postMessage(message: any, transfer: readonly unknown[] = []): void {
    this.posted.push({ message, transfer });
    if (message.op === undefined) return;
    const answer = this.answer;
    if (!answer) return;
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: answer(message) } } as MessageEvent));
  }

  /** Asks the main thread for key material, the way the real worker does. */
  requestKey(id: number, km: 'lookupKey' | 'getParams', arg: string | number): void {
    this.onmessage?.({ data: { id, km, kmId: 1, arg } } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function spawnFake(): FakeWorker {
  return new FakeWorker();
}

/** One transaction the service can prove, standing in for the ledger's. */
function transactionCalling(
  run: (provider: { prove: (p: Uint8Array, l: string, o?: bigint) => Promise<unknown> }) => Promise<unknown>,
) {
  return { prove: (provider: any) => run(provider) };
}

afterEach(() => {
  setProofWorkerSpawn(null);
  FakeWorker.live = [];
  FakeWorker.defaultAnswer = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the proof worker channel', () => {
  it('resolves a proof the worker answers, and keeps one worker for the session', async () => {
    setProofWorkerSpawn(spawnFake as unknown as () => Worker);
    const service = wasmWalletProvingService();
    const proved: unknown[] = [];
    for (let i = 0; i < 2; i += 1) {
      FakeWorker.defaultAnswer = (message) => ({ signed: message.op });
      const result = await service.prove(
        transactionCalling((provider) =>
          provider.prove(new Uint8Array([1, 2, 3]), 'midnight/zswap/spend'),
        ),
      );
      proved.push(result);
    }
    expect(proved).toEqual([{ signed: 'prove' }, { signed: 'prove' }]);
    expect(FakeWorker.live).toHaveLength(1);
  });

  it('restarts the worker and replays once when it goes quiet', async () => {
    vi.useFakeTimers();
    setProofWorkerSpawn(spawnFake as unknown as () => Worker);
    const service = wasmWalletProvingService();

    const settled = service.prove(
      transactionCalling((provider) => provider.prove(new Uint8Array([9]), 'midnight/zswap/spend')),
    );
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWorker.live[0];
    expect(first.posted).toHaveLength(1);

    // Silence. No error event, no close — exactly what a jettisoned worker
    // looks like from the page.
    await vi.advanceTimersByTimeAsync(PROOF_WORKER_IDLE_MS + 1);
    expect(first.terminated).toBe(true);
    expect(FakeWorker.live).toHaveLength(2);
    const second = FakeWorker.live[1];
    // The same request, replayed rather than dropped or duplicated.
    expect(second.posted).toHaveLength(1);
    expect(second.posted[0].message).toMatchObject({ op: 'prove' });

    second.onmessage?.({
      data: { id: second.posted[0].message.id, ok: 'second time lucky' },
    } as MessageEvent);
    await expect(settled).resolves.toBe('second time lucky');
  });

  it('gives up in plain words rather than hanging when the replay goes quiet too', async () => {
    vi.useFakeTimers();
    setProofWorkerSpawn(spawnFake as unknown as () => Worker);
    const service = wasmWalletProvingService();

    const settled = service
      .prove(transactionCalling((provider) => provider.prove(new Uint8Array([9]), 'x')))
      .catch((cause: Error) => cause.message);
    await vi.advanceTimersByTimeAsync(PROOF_WORKER_IDLE_MS + 1);
    await vi.advanceTimersByTimeAsync(PROOF_WORKER_IDLE_MS + 1);

    await expect(settled).resolves.toBe(PROOF_UNFINISHED_MESSAGE);
    // No third worker: one restart, one replay, then an answer.
    expect(FakeWorker.live).toHaveLength(2);
    // And the sentence names nothing the reader cannot act on.
    for (const word of ['worker', 'wasm', 'WebAssembly', 'process', 'thread']) {
      expect(PROOF_UNFINISHED_MESSAGE).not.toContain(word);
    }
  });

  it('treats a key request as progress, however long the download behind it takes', async () => {
    vi.useFakeTimers();
    setProofWorkerSpawn(spawnFake as unknown as () => Worker);
    const service = wasmWalletProvingService();

    const settled = service.prove(
      transactionCalling((provider) => provider.prove(new Uint8Array([9]), 'x')),
    );
    await vi.advanceTimersByTimeAsync(0);
    const worker = FakeWorker.live[0];
    const id = worker.posted[0].message.id;

    // Two thirds of the bound, a word from the worker, two thirds again. A
    // total-time bound would have killed this; an idle bound does not.
    await vi.advanceTimersByTimeAsync(Math.floor(PROOF_WORKER_IDLE_MS * 0.7));
    worker.requestKey(id, 'lookupKey', 'not/a/system/circuit');
    await vi.advanceTimersByTimeAsync(Math.floor(PROOF_WORKER_IDLE_MS * 0.7));
    expect(worker.terminated).toBe(false);
    expect(FakeWorker.live).toHaveLength(1);

    worker.onmessage?.({ data: { id, ok: 'done' } } as MessageEvent);
    await expect(settled).resolves.toBe('done');
  });

  it('hands key material over by transfer, and never detaches the cache it came from', async () => {
    const srs = new Uint8Array(64).fill(7);
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      headers: { get: () => 'application/octet-stream' },
      arrayBuffer: async () => srs.buffer.slice(0),
    }));
    setProofWorkerSpawn(spawnFake as unknown as () => Worker);
    const service = wasmWalletProvingService();

    const settled = service.prove(
      transactionCalling((provider) => provider.prove(new Uint8Array([9]), 'x')),
    );
    await Promise.resolve();
    const worker = FakeWorker.live[0];
    const id = worker.posted[0].message.id;

    // Two requests for the SAME slice: the second must find the main thread's
    // cache intact, which it cannot if the first reply transferred it away.
    worker.requestKey(id, 'getParams', 14);
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.requestKey(id, 'getParams', 14);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const replies = worker.posted.filter((post) => post.message.kmReply !== undefined);
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(reply.message.error).toBeUndefined();
      expect(reply.message.result).toBeInstanceOf(Uint8Array);
      expect(reply.message.result).toHaveLength(64);
      // The copy travels as a move rather than a clone …
      expect(reply.transfer).toEqual([reply.message.result.buffer]);
    }
    // … and the two copies are distinct buffers, so neither reply detached the
    // other's, nor the cached original both were taken from.
    expect(replies[0].message.result.buffer).not.toBe(replies[1].message.result.buffer);

    worker.onmessage?.({ data: { id, ok: 'done' } } as MessageEvent);
    await expect(settled).resolves.toBe('done');
  });

  it('answers a crash the same way it answers silence', async () => {
    vi.useFakeTimers();
    setProofWorkerSpawn(spawnFake as unknown as () => Worker);
    const service = wasmWalletProvingService();

    const settled = service.prove(
      transactionCalling((provider) => provider.prove(new Uint8Array([9]), 'x')),
    );
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWorker.live[0];
    first.onerror?.({ message: 'out of memory' } as ErrorEvent);
    await vi.advanceTimersByTimeAsync(0);

    expect(first.terminated).toBe(true);
    expect(FakeWorker.live).toHaveLength(2);
    const second = FakeWorker.live[1];
    second.onmessage?.({
      data: { id: second.posted[0].message.id, ok: 'recovered' },
    } as MessageEvent);
    await expect(settled).resolves.toBe('recovered');
  });

  it('reports a key the main thread could not resolve, rather than going quiet', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    setProofWorkerSpawn(spawnFake as unknown as () => Worker);
    const service = wasmWalletProvingService();

    const settled = service.prove(
      transactionCalling((provider) => provider.prove(new Uint8Array([9]), 'x')),
    );
    await Promise.resolve();
    const worker = FakeWorker.live[0];
    worker.requestKey(worker.posted[0].message.id, 'getParams', 15);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reply = worker.posted.find((post) => post.message.kmReply !== undefined);
    expect(reply?.message.error).toContain('offline');

    worker.onmessage?.({
      data: { id: worker.posted[0].message.id, err: 'the key never arrived' },
    } as MessageEvent);
    await expect(settled).rejects.toThrow('the key never arrived');
  });
});
