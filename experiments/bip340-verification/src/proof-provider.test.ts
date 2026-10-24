// Public, small HTTP fixtures only. No proof server, circuit keys or secrets.
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { readBoundedResponse, requestLocalProof } from './proof-provider.js';

const fixture = Buffer.from('public request fixture');
const limits = { maxResponseBytes: 32, deadlineMilliseconds: 1_000 };

async function withServer(handler: RequestListener, check: (url: URL) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await check(new URL(`http://127.0.0.1:${address.port}/prove`)); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const send = (url: URL) => requestLocalProof(url, Readable.from([fixture]), fixture.length, limits);

test('returns a bounded response and preserves the uploaded fixture', async () => {
  await withServer((req, res) => {
    const received: Buffer[] = [];
    req.on('data', chunk => received.push(chunk));
    req.on('end', () => {
      assert.deepEqual(Buffer.concat(received), fixture);
      assert.equal(req.headers['content-length'], String(fixture.length));
      res.end(Buffer.from('public proof fixture'));
    });
  }, async url => assert.deepEqual(await send(url), Buffer.from('public proof fixture')));
});

test('rejects an oversized Content-Length before reading its body and destroys the upload', async () => {
  let timer: NodeJS.Timeout | undefined;
  const upload = new Readable({
    read() { timer = setTimeout(() => { timer = undefined; this.push(Buffer.alloc(1024)); }, 10); },
    destroy(error, callback) { clearTimeout(timer); timer = undefined; callback(error); },
  });
  await withServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-length': 33 });
    res.flushHeaders(); // No body: the limit must reject on the header alone.
  }, async url => {
    await assert.rejects(requestLocalProof(url, upload, 1_000_000_000, limits), /exceeds 32 bytes \(Content-Length\)/);
    assert.equal(upload.destroyed, true);
    assert.equal(timer, undefined);
  });
});

test('rejects an oversized chunked response without a Content-Length', async () => {
  await withServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'transfer-encoding': 'chunked' });
    res.write(Buffer.alloc(20));
    res.end(Buffer.alloc(13));
  }, async url => { await assert.rejects(send(url), /exceeds 32 bytes/); });
});

test('the overall deadline expires despite a continuous slow response', async () => {
  let interval: NodeJS.Timeout | undefined;
  let responseClosed: Promise<unknown> | undefined;
  await withServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'transfer-encoding': 'chunked' });
    res.flushHeaders();
    interval = setInterval(() => res.write('x'), 10);
    res.on('close', () => { clearInterval(interval); interval = undefined; });
    responseClosed = once(res, 'close');
  }, async url => {
    const started = performance.now();
    await assert.rejects(requestLocalProof(url, Readable.from([fixture]), fixture.length,
      { maxResponseBytes: 1_000, deadlineMilliseconds: 100 }), /overall deadline exceeded/);
    assert.ok(performance.now() - started < 900, 'deadline must not reset on each response byte');
    assert.ok(responseClosed);
    await responseClosed;
  });
  assert.equal(interval, undefined);
});

test('rejects a response that closes before its declared length', async () => {
  await withServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-length': 20 });
    res.write('short');
    setImmediate(() => res.destroy());
  }, async url => { await assert.rejects(send(url), /aborted|prematurely|socket hang up/); });
});

test('rejects a bounded non-200 response with its diagnostic', async () => {
  await withServer((req, res) => { req.resume(); res.writeHead(400); res.end('invalid fixture'); },
    async url => { await assert.rejects(send(url), /proof server 400: invalid fixture/); });
});

test('rejects an upload stream error and closes the request', async () => {
  await withServer((req, res) => { req.resume(); res.on('error', () => undefined); }, async url => {
    const broken = new Readable({ read() { this.destroy(new Error('fixture upload failed')); } });
    await assert.rejects(requestLocalProof(url, broken, 1, limits), /fixture upload failed/);
    assert.equal(broken.destroyed, true);
  });
});

test('reads a bounded fetch body and releases its reader', async () => {
  await withServer((req, res) => { req.resume(); res.end('public check fixture'); }, async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    assert.deepEqual(await readBoundedResponse(response, 32), Buffer.from('public check fixture'));
    assert.equal(response.body?.locked, false);
  });
});

for (const encoding of ['Content-Length', 'chunked']) {
  test(`cancels an oversized ${encoding} fetch body and releases its reader`, async () => {
    let responseClosed: Promise<unknown> | undefined;
    await withServer((req, res) => {
      req.resume();
      responseClosed = once(res, 'close');
      if (encoding === 'Content-Length') {
        res.writeHead(200, { 'content-length': 33 });
        res.flushHeaders(); // Header rejection must not wait for a body.
      } else {
        res.writeHead(200, { 'transfer-encoding': 'chunked' });
        res.write(Buffer.alloc(33)); // Never end: cancellation must close it.
      }
    }, async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await assert.rejects(readBoundedResponse(response, 32), /exceeds 32 bytes/);
      assert.equal(response.body?.locked, false);
      assert.ok(responseClosed);
      await responseClosed;
    });
  });
}

test('fetch deadline still aborts a slow bounded body and releases its reader', async () => {
  let responseClosed: Promise<unknown> | undefined;
  await withServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'transfer-encoding': 'chunked' });
    res.flushHeaders();
    const interval = setInterval(() => res.write('x'), 10);
    res.on('close', () => clearInterval(interval));
    responseClosed = once(res, 'close');
  }, async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(100) });
    await assert.rejects(readBoundedResponse(response, 1_000), /abort|timeout/i);
    assert.equal(response.body?.locked, false);
    assert.ok(responseClosed);
    await responseClosed;
  });
});
