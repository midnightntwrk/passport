// Execute one circuit group. run.py supplies the series, artifacts and sample indices.
import { channel } from 'node:diagnostics_channel';
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [contract, artifacts, fixtures, output, server, circuit, variant, first, count] = process.argv.slice(2);
const origin = new URL(server);
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw Error('Proof inputs must stay on a local HTTP endpoint');
}
const req = createRequire(path.join(contract, 'package.json'));
const { createCheckPayload, parseCheckResult } = await import(req.resolve('@midnightntwrk/ledger-v9'));
const { proveStream } = await import(path.join(contract, 'src/tests/webauthn-variable/proof-provider.ts'));
const preimage = readFileSync(path.join(fixtures, circuit + '.bin'));
const files = [
  path.join(artifacts, 'keys', circuit + '.prover'),
  path.join(artifacts, 'keys', circuit + '.verifier'),
  path.join(artifacts, 'zkir', circuit + '.bzkir'),
];
const check = await fetch(new URL('/check', origin), {
  method: 'POST', body: createCheckPayload(preimage, readFileSync(files[2])),
  signal: AbortSignal.timeout(120_000), redirect: 'error',
});
if (!check.ok) throw Error(circuit + ' failed /check: ' + await check.text());
parseCheckResult(new Uint8Array(await check.arrayBuffer()));

let requestFinished;
channel('http.client.request.start').subscribe(({ request }) => {
  if (request.path === '/prove') request.once('finish', () => { requestFinished = performance.now(); });
});
for (let run = Number(first); run < Number(first) + Number(count); run++) {
  requestFinished = undefined;
  const start = new Date().toISOString();
  const before = performance.now();
  const { proof, milliseconds, requestBytes } = await proveStream(origin.origin, preimage, undefined, files);
  if (!proof.length) throw Error(circuit + ' produced an empty proof');
  const row = {
    circuit, variant: variant || undefined, run, start, milliseconds, requestBytes,
    proofBytes: proof.length,
    requestSentMilliseconds: requestFinished === undefined ? undefined : requestFinished - before,
  };
  appendFileSync(output, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}
