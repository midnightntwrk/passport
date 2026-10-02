// Interactive localnet conformance: real navigator.credentials assertions,
// the production browser adapter, and an account transaction accepted on-node.
// No software-authenticator fallback or virtual authenticator is installed.
import { strict as assert } from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { build } from 'esbuild';
import { CustodyAccount } from '../wallet/account.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { P256Device, p256Challenges } from '../wallet/signer-p256.js';
import { type WebAuthnAssertion, type P256PublicKey, validateP256Key } from '../wallet/webauthn.js';
import { setupWallet, compiledAccountContract } from '../node/setup.js';
import { serialiseError } from './evidence.js';
import { assertNodeIndexerConsistent, bytes, confirmTransaction, installTimedProver } from './instrumentation.js';

const origin = 'http://localhost:8973', rpId = 'localhost';
const runId = randomUUID();
const directory = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(process.env.EVIDENCE_DIR ?? 'evidence/p256-webauthn');
mkdirSync(evidenceDir, { recursive: true });
const evidenceFile = path.join(evidenceDir, `run-browser-${runId}.json`);
const json = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');

type Credential = { credentialId: string; pk: P256PublicKey; userAgent: string };
type Request = { id: string; challenge: string; credentialId: string; purpose: 'approve' | 'cancel'; requestedAt: string };
const state: {
  runId: string; phase: string; message: string; origin: string; rpId: string;
  account?: string; operation?: { name: string; newKey: string; authNonce: string };
  request?: Request; events: { at: string; message: string }[]; result?: unknown;
} = { runId, phase: 'registration', message: 'Create a real passkey to begin.', origin, rpId, events: [] };
const evidence: Record<string, any> = {
  testId: 'p256-browser', verdict: 'PARTIAL', runId, startedAt: new Date().toISOString(),
  origin, rpId, profile: 'wa-json134', authenticator: 'interactive browser WebAuthn, userVerification=required',
  attestation: 'none; authenticator hardware and biometric method are not remotely attested',
  operation: 'rotate_enc_key_with_p256', samples: [], transactions: [], assertions: [], negatives: [], browserEvents: [],
  methodology: 'Prove timing includes key lookup/load and HTTP. Operation wall time starts when the server receives the assertion and includes local checks, proving, balancing and inclusion. Browser ceremony time is recorded separately.',
};
function save() { writeFileSync(evidenceFile, json({ ...evidence, progress: state }), { mode: 0o600 }); }
function progress(phase: string, message: string) {
  state.phase = phase; state.message = message;
  state.events.push({ at: new Date().toISOString(), message });
  console.log(message); save();
}
let register: (credential: Credential) => void;
const registration = new Promise<Credential>(resolve => { register = resolve; });
let pending: { request: Request; resolve: (a: WebAuthnAssertion) => void; reject: (e: Error) => void } | undefined;
class CeremonyError extends Error {
  constructor(readonly browserName: string, message: string) { super(message); }
}
let purpose: Request['purpose'] = 'approve';
let credential: Credential;
function requestAssertion(challenge: Uint8Array): Promise<WebAuthnAssertion> {
  assert.equal(pending, undefined, 'another assertion is pending');
  const request: Request = {
    id: randomUUID(), challenge: hex(challenge), credentialId: credential.credentialId,
    purpose, requestedAt: new Date().toISOString(),
  };
  state.request = request;
  const result = new Promise<WebAuthnAssertion>((resolve, reject) => { pending = { request, resolve, reject }; });
  progress(purpose === 'approve' ? 'approval' : 'cancellation', purpose === 'approve'
    ? 'Account ready. Click “Approve account change” and complete the passkey prompt.'
    : 'Transaction accepted. Click “Test cancellation”, then cancel the system passkey prompt.');
  return result;
}

const bundle = await build({
  entryPoints: [path.join(directory, 'p256-browser/client.ts')], bundle: true, write: false,
  platform: 'browser', format: 'esm', target: 'es2022',
});
const html = readFileSync(path.join(directory, 'p256-browser/index.html'));
const server = createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(json(body));
  };
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  try {
    assert.equal(req.headers.host, 'localhost:8973', 'open the localhost origin');
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (req.method === 'GET' && req.url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle.outputFiles[0].contents); return;
    }
    if (req.method === 'GET' && req.url === '/status') { reply(200, state); return; }
    if (req.method !== 'POST') { reply(404, { error: 'not found' }); return; }
    assert.equal(req.headers.origin, origin, 'same-origin request required');
    assert.equal(req.headers['content-type'], 'application/json');
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
      assert.ok(Buffer.byteLength(body) <= 65_536, 'request too large');
    }
    const input = JSON.parse(body);
    assert.equal(input.runId, runId, 'stale page; reload');
    if (req.url === '/credential') {
      assert.equal(state.phase, 'registration', 'registration already completed');
      assert.equal(input.rpId, rpId); assert.equal(input.origin, origin);
      const credentialId = hex(bytes(input.credentialId));
      assert.ok(credentialId.length <= 2048);
      const pk = { x: BigInt('0x' + hex(bytes(input.x, 32))), y: BigInt('0x' + hex(bytes(input.y, 32))), identity: false };
      validateP256Key(pk);
      credential = { credentialId, pk, userAgent: String(input.userAgent).slice(0, 1024) };
      evidence.credential = { ...credential, rpId, origin, createdOrReused: input.createdOrReused };
      progress('deploying', 'Passkey profile checked. Synchronising localnet and deploying its account in ten waves…');
      register(credential); reply(202, { ok: true }); return;
    }
    if (req.url === '/assertion') {
      assert.ok(pending, 'no pending assertion');
      assert.equal(input.requestId, pending.request.id, 'stale assertion response');
      const active = pending;
      // Validate the transport before consuming the outstanding request.
      const assertion = input.error ? undefined : {
        authenticatorData: bytes(input.authenticatorData), clientDataJSON: bytes(input.clientDataJSON),
        signature: bytes(input.signature),
      };
      pending = undefined; state.request = undefined;
      evidence.assertions.push({ ...active.request, receivedAt: new Date().toISOString(),
        browserMilliseconds: input.browserMilliseconds, error: input.error,
        ...(assertion && { authenticatorData: hex(assertion.authenticatorData),
          clientDataJSON: hex(assertion.clientDataJSON), signature: hex(assertion.signature) }),
      });
      progress('processing', input.error ? 'Browser ceremony returned without an assertion.' : 'Received the browser assertion; checking the signature and account operation.');
      if (assertion) active.resolve(assertion);
      else active.reject(new CeremonyError(String(input.error.name), String(input.error.message)));
      reply(200, { ok: true }); return;
    }
    if (req.url === '/browser-event') {
      evidence.browserEvents.push({ at: new Date().toISOString(), event: input.event }); save();
      console.log('Browser:', json(input.event)); reply(200, { ok: true }); return;
    }
    reply(404, { error: 'not found' });
  } catch (error) { reply(400, { error: error instanceof Error ? error.message : String(error) }); }
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject); server.listen(8973, '127.0.0.1', resolve);
});
console.log(`Open ${origin} in Safari or Chrome. Evidence: ${evidenceFile}`);
save();

async function scenario() {
  credential = await registration;
  const { block, nodeBlockHash } = await assertNodeIndexerConsistent();
  evidence.chain = { indexedBlock: block, nodeBlockHash }; save();
  const ctx = await setupWallet();
  let label = 'activation', proofCalls = 0, submissions = 0;
  await installTimedProver(ctx.providers, sample => { evidence.samples.push({ label, ...sample }); save(); },
    () => { proofCalls++; });
  const submit = ctx.providers.midnightProvider.submitTx.bind(ctx.providers.midnightProvider);
  ctx.providers.midnightProvider.submitTx = (...args: unknown[]) => {
    submissions++;
    if (!state.account) progress('deploying', `Submitting account deployment transaction ${submissions} (ten waves)…`);
    return submit(...args);
  };
  const device = new P256Device(credential.pk, rpId, origin, requestAssertion);
  const dormant = await CustodyAccount.deployDormant(ctx.providers, compiledAccountContract(), device, generateEncKeyPair());
  state.account = dormant.address; evidence.account = dormant.address; save();
  const activation: any = await dormant.activate(device, dormant.salt);
  const account = dormant.finish();
  const record = async (name: string, txId: string) => {
    evidence.transactions.push({ name, ...(await confirmTransaction(txId)) }); save();
  };
  await record('activate_initial_device_with_p256', activation.public.txId);
  const snapshot = async () => {
    const s = await account.ledgerState();
    return { authNonce: s.auth_nonce.toString(), encKey: hex(s.enc_key), deviceCounter: (await account.resolveUseCounter(device)).toString() };
  };
  const before = await snapshot(); evidence.before = before;
  const newKey = generateEncKeyPair().publicKey;
  const context = await account.callContext(), counter = await account.resolveUseCounter(device);
  state.operation = { name: 'Rotate this test account’s encryption key', newKey: hex(newKey), authNonce: context.authNonce.toString() };
  let auth: Awaited<ReturnType<typeof device.sign>>;
  for (;;) {
    try { auth = await device.sign(p256Challenges.rotateEncKey(context, device.pk, newKey), counter); break; }
    catch (error) {
      if (!(error instanceof CeremonyError) || !['NotAllowedError', 'AbortError'].includes(error.browserName)) throw error;
      assert.deepEqual(await snapshot(), before);
      evidence.negatives.push({ name: 'browser request cancelled or denied before approval', stage: 'browser', error: error.message, stateUnchanged: true });
    }
  }
  const assertionReceived = performance.now();
  async function refuses(name: string, fn: () => Promise<unknown>, expected: RegExp) {
    const prior = await snapshot(), proofCount = proofCalls, submittedCount = submissions;
    let caught: unknown;
    try { await fn(); } catch (error) { caught = error; }
    assert.ok(caught, `${name} unexpectedly succeeded`);
    const detail = serialiseError(caught);
    assert.match(json(detail.causeChain), expected, `${name} must fail for the expected circuit predicate`);
    assert.equal(proofCalls, proofCount, `${name} reached proving`);
    assert.equal(submissions, submittedCount, `${name} reached submission`);
    assert.deepEqual(await snapshot(), prior);
    evidence.negatives.push({ name, stage: 'local circuit execution', error: detail, stateUnchanged: true, proofCalls: 0, submissions: 0 }); save();
  }
  progress('processing', 'Checking changed-operation rejection, then proving the approved account change…');
  await refuses('changed operation argument', () => account.rotateEncKeyWithAuth(new Uint8Array(randomBytes(32)), auth), /signature/i);
  label = 'rotate_enc_key_with_p256';
  const start = performance.now();
  const result = await account.rotateEncKeyWithAuth(newKey, auth);
  await record(label, result.txId);
  evidence.operationMilliseconds = performance.now() - start;
  evidence.assertionToAcceptedMilliseconds = performance.now() - assertionReceived;
  const after = await snapshot(); evidence.after = after;
  assert.equal(after.authNonce, (BigInt(before.authNonce) + 1n).toString());
  assert.equal(after.deviceCounter, (BigInt(before.deviceCounter) + 1n).toString());
  assert.equal(after.encKey, hex(newKey));
  await refuses('replay consumed authorisation', () => account.rotateEncKeyWithAuth(newKey, auth), /unknown device/i);
  state.result = { txId: result.txId, before, after };

  // An actual browser cancellation, against a fresh operation challenge.
  // NotAllowedError can also mean timeout/denial; record that distinction.
  purpose = 'cancel';
  const cancelKey = generateEncKeyPair().publicKey;
  const cancelContext = await account.callContext();
  state.operation = { name: 'Cancellation check — no change will be submitted', newKey: hex(cancelKey), authNonce: cancelContext.authNonce.toString() };
  for (;;) {
    const proofCount = proofCalls, submittedCount = submissions;
    try {
      await device.sign(p256Challenges.rotateEncKey(cancelContext, device.pk, cancelKey), await account.resolveUseCounter(device));
      evidence.browserEvents.push({ at: new Date().toISOString(), event: 'Cancellation check was approved; discarded without submission. Retry and cancel the prompt.' });
    } catch (error) {
      if (!(error instanceof CeremonyError) || !['NotAllowedError', 'AbortError'].includes(error.browserName)) throw error;
      assert.equal(proofCalls, proofCount); assert.equal(submissions, submittedCount);
      assert.deepEqual(await snapshot(), after);
      evidence.negatives.push({ name: 'browser cancellation/denial', stage: 'browser', browserName: error.browserName,
        message: error.message, stateUnchanged: true, proofCalls: 0, submissions: 0 }); break;
    }
  }
  evidence.verdict = 'PASS'; evidence.completedAt = new Date().toISOString();
  progress('complete', 'PASS: real browser assertion accepted on-node; changed argument, replay and cancellation/denial checks passed.');
  console.log(`Evidence saved: ${evidenceFile}`);
  await ctx.walletCtx.wallet.stop();
}
void scenario().catch(error => {
  evidence.verdict = 'FAIL'; evidence.error = { ...serialiseError(error), inspected: inspect(error, { depth: 8 }) };
  progress('failed', `Flow stopped: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
});

// Resume a previously registered browser credential after a local-stack or
// server failure. This loads only its public metadata; a NEW browser-signed
// assertion is still required for the new account operation.
if (process.env.PASSKEY_CREDENTIAL_FILE) {
  const source = JSON.parse(readFileSync(process.env.PASSKEY_CREDENTIAL_FILE, 'utf8'));
  const c = source.credential;
  assert.equal(c.rpId, rpId); assert.equal(c.origin, origin);
  credential = { credentialId: hex(bytes(c.credentialId)), userAgent: c.userAgent,
    pk: { x: BigInt(c.pk.x), y: BigInt(c.pk.y), identity: false } };
  validateP256Key(credential.pk);
  evidence.credential = { ...credential, rpId, origin, createdOrReused: 'resumed public metadata', sourceRunId: source.runId };
  progress('deploying', 'Reusing your registered passkey. Checking node/indexer consistency and deploying a fresh account…');
  register(credential);
}
