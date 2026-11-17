// Interactive Ledger grant conformance on localnet. The owner is a disposable
// software JubJub device; every grantee signature comes from the user's USB
// authenticator. Negative calls execute the real circuit locally and are never
// presented as invalid proofs rejected by the node.
import { strict as assert } from 'node:assert';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { build } from 'esbuild';
import { CustodyAccount } from '../wallet/account.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { JubjubDevice, originHash, spendScope, openingOf, RECIPIENT_USER_ADDRESS } from '../wallet/signer.js';
import { P256Grantee, p256GrantChallenges, type P256GrantAuthorisation } from '../wallet/signer-p256.js';
import { type WebAuthnAssertion, type P256PublicKey, validateP256Key, WEBAUTHN_PROFILE } from '../wallet/webauthn.js';
import { pureCircuits } from '../wallet/contract.js';
import { setupWallet, compiledAccountContract, deployFaucet } from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { serialiseError } from './evidence.js';
import { assertNodeIndexerConsistent, bytes, confirmTransaction, installTimedProver } from './instrumentation.js';
import { sleep } from './runner.js';

const origin = 'http://localhost:8973', rpId = 'localhost', runId = randomUUID();
const directory = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(process.env.EVIDENCE_DIR ?? 'evidence/ledger-flex-grant');
mkdirSync(evidenceDir, { recursive: true });
const evidenceFile = path.join(evidenceDir, `run-${runId}.json`);
const json = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const rnd = (size = 32) => new Uint8Array(randomBytes(size));
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function provenance() {
  return Object.fromEntries([
    './ledger-flex-grant.ts', './ledger-flex-grant/client.ts', './ledger-flex-grant/index.html',
    '../wallet/account.ts', '../wallet/signer.ts', '../wallet/signer-p256.ts', '../wallet/webauthn.ts',
    '../../package-lock.json', '../../contracts/account.compact', '../../contracts/account-p256.compact',
    '../../contracts/webauthn.compact', '../../contracts/managed/account/contract/index.js',
    '../../contracts/managed/account/compiler/contract-manifest.json',
    ...['activate_initial_device_with_jubjub', 'deposit_unshielded', 'issue_grant_with_jubjub',
      'revoke_grant_with_jubjub', 'withdraw_unshielded_with_grant_p256']
      .flatMap(name => [`../../contracts/managed/account/zkir/${name}.bzkir`,
        `../../contracts/managed/account/keys/${name}.verifier`]),
  ].map(relative => {
    const data = readFileSync(new URL(relative, import.meta.url));
    return [relative, { bytes: data.length, sha256: digest(data) }];
  }));
}
type Credential = { credentialId: string; pk: P256PublicKey; userAgent: string };
type Request = { id: string; challenge: string; credentialId: string; requestedAt: string };
const state: {
  runId: string; phase: string; message: string; origin: string; rpId: string;
  account?: string; request?: Request; operation?: Record<string, unknown>;
  events: { at: string; message: string }[]; result?: unknown;
} = { runId, phase: 'registration', message: 'Import your Ledger capture or create a USB security-key credential.',
  origin, rpId, events: [] };
const evidence: Record<string, any> = {
  testId: 'ledger-flex-grant', verdict: 'PARTIAL', runId, startedAt: new Date().toISOString(),
  origin, rpId, profile: WEBAUTHN_PROFILE, accountOwner: 'disposable software JubJub test device',
  grantee: 'interactive USB WebAuthn; physical Ledger use is user-observed, not attested',
  attestation: 'none', operation: 'withdraw_unshielded_with_grant_p256',
  transactions: [], assertions: [], negatives: [], samples: [], browserEvents: [],
  limitations: ['Non-native localnet unshielded test assets only.',
    'Negative controls execute compiled account circuits against indexed state, without proving or submission.',
    'Ledger WebAuthn confirms the relying party; spend details are displayed by the browser, not clear-signed on the device.',
    'No PRF, recovery, real-world funds or hardware-attestation claim.'],
};
function save() { writeFileSync(evidenceFile, json({ ...evidence, progress: state }), { mode: 0o600 }); }
function progress(phase: string, message: string) {
  state.phase = phase; state.message = message;
  state.events.push({ at: new Date().toISOString(), message });
  console.log(message); save();
}
let register: (value: Credential) => void;
const registration = new Promise<Credential>(resolve => { register = resolve; });
let credential: Credential;
let pending: { request: Request; resolve: (a: WebAuthnAssertion) => void; reject: (e: Error) => void } | undefined;
class CeremonyError extends Error {
  constructor(readonly browserName: string, message: string) { super(message); }
}
function requestAssertion(challenge: Uint8Array): Promise<WebAuthnAssertion> {
  assert.equal(pending, undefined, 'another assertion is pending');
  const request = { id: randomUUID(), challenge: hex(challenge), credentialId: credential.credentialId,
    requestedAt: new Date().toISOString() };
  state.request = request;
  const result = new Promise<WebAuthnAssertion>((resolve, reject) => { pending = { request, resolve, reject }; });
  progress('approval', 'Ready for your Ledger. Review the operation below, then click “Sign with Ledger”.');
  return result;
}
function acceptCredential(input: any) {
  assert.equal(state.phase, 'registration', 'credential already registered for this run');
  assert.equal(input.rpId, rpId); assert.equal(input.origin, origin);
  const id = bytes(input.credentialId);
  assert.ok(id.length > 0 && id.length <= 1024, 'invalid credential ID length');
  const pk = { x: BigInt('0x' + hex(bytes(input.x, 32))), y: BigInt('0x' + hex(bytes(input.y, 32))), identity: false };
  validateP256Key(pk);
  credential = { credentialId: hex(id), pk, userAgent: String(input.userAgent ?? '').slice(0, 1024) };
  evidence.credential = { ...credential, rpId, origin, source: String(input.source ?? 'browser').slice(0, 128) };
  progress('deploying', 'Checking localnet and deploying a fresh test account. No Ledger approval is needed yet.');
  register(credential);
}

const bundle = await build({ entryPoints: [path.join(directory, 'ledger-flex-grant/client.ts')],
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' });
const html = readFileSync(path.join(directory, 'ledger-flex-grant/index.html'));
const server = createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(json(body)); };
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  try {
    assert.equal(req.headers.host, 'localhost:8973', 'open the localhost origin');
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (req.method === 'GET' && req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle.outputFiles[0].contents); return; }
    if (req.method === 'GET' && req.url === '/status') { reply(200, state); return; }
    if (req.method !== 'POST') { reply(404, { error: 'not found' }); return; }
    assert.equal(req.headers.origin, origin, 'same-origin request required');
    assert.equal(req.headers['content-type'], 'application/json');
    let body = '';
    for await (const chunk of req) { body += chunk.toString(); assert.ok(Buffer.byteLength(body) <= 65_536, 'request too large'); }
    const input = JSON.parse(body); assert.equal(input.runId, runId, 'stale page; reload');
    if (req.url === '/credential') { acceptCredential(input); reply(202, { ok: true }); return; }
    if (req.url === '/assertion') {
      assert.ok(pending, 'no pending assertion'); assert.equal(input.requestId, pending.request.id, 'stale assertion');
      const active = pending;
      const assertion = input.error ? undefined : { authenticatorData: bytes(input.authenticatorData),
        clientDataJSON: bytes(input.clientDataJSON), signature: bytes(input.signature) };
      if (assertion) assert.equal(hex(bytes(input.credentialId)), credential.credentialId, 'credential ID mismatch');
      pending = undefined; state.request = undefined;
      evidence.assertions.push({ ...active.request, receivedAt: new Date().toISOString(), error: input.error,
        browserMilliseconds: input.browserMilliseconds, userAgent: String(input.userAgent ?? '').slice(0, 1024),
        ...(assertion && { authenticatorData: hex(assertion.authenticatorData), clientDataJSON: hex(assertion.clientDataJSON), signature: hex(assertion.signature) }) });
      progress('processing', assertion ? 'Checking your Ledger signature and the account operation…' : 'Browser request cancelled or denied.');
      if (assertion) active.resolve(assertion);
      else active.reject(new CeremonyError(String(input.error?.name), String(input.error?.message)));
      reply(200, { ok: true }); return;
    }
    if (req.url === '/browser-event') { evidence.browserEvents.push({ at: new Date().toISOString(), event: input.event }); save(); reply(200, { ok: true }); return; }
    reply(404, { error: 'not found' });
  } catch (error) { reply(400, { error: error instanceof Error ? error.message : String(error) }); }
});
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(8973, '127.0.0.1', resolve); });
console.log(`Open ${origin}. Evidence: ${evidenceFile}`); save();

async function scenario() {
  credential = await registration;
  evidence.provenance = provenance(); save();
  evidence.chain = await assertNodeIndexerConsistent(); save();
  const ctx = await setupWallet();
  try {
    let proofCalls = 0, submissions = 0, label = 'deploy';
    await installTimedProver(ctx.providers, sample => { evidence.samples.push({ label, ...sample }); save(); }, () => { proofCalls++; });
    const submit = ctx.providers.midnightProvider.submitTx.bind(ctx.providers.midnightProvider);
    ctx.providers.midnightProvider.submitTx = (...args: unknown[]) => { submissions++; return submit(...args); };
    const owner = JubjubDevice.generate();
    const delegate = new P256Grantee(credential.pk, rpId, origin, requestAssertion);
    const account = await CustodyAccount.deploy(ctx.providers, compiledAccountContract(), owner, generateEncKeyPair());
    state.account = account.address; evidence.account = account.address; save();
    const record = async (name: string, txId: string) => { evidence.transactions.push({ name, ...(await confirmTransaction(txId, true)) }); save(); };
    const snapshot = async () => {
      const s = await ctx.providers.publicDataProvider.queryContractState(account.address);
      assert.ok(s); return new Uint8Array(s.serialize());
    };
    async function rejects(name: string, fn: () => Promise<unknown>, expected: RegExp) {
      const before = await snapshot(), proofsBefore = proofCalls, submittedBefore = submissions;
      let caught: unknown;
      try { await fn(); } catch (error) { caught = error; }
      assert.ok(caught, `${name} unexpectedly succeeded`);
      const detail = serialiseError(caught);
      assert.match(json(detail.causeChain), expected, `${name}: unexpected refusal`);
      assert.equal(proofCalls, proofsBefore); assert.equal(submissions, submittedBefore);
      assert.deepEqual(await snapshot(), before);
      evidence.negatives.push({ name, stage: 'local circuit execution', error: detail, stateUnchanged: true,
        stateSha256: digest(before), proofCalls: 0, submissions: 0 }); save();
    }
    progress('funding', 'Minting and depositing 100 non-native localnet test units…');
    const faucet = await deployFaucet(ctx.walletCtx), domain = rnd(), recipient = userAddressBytes(ctx.walletCtx);
    const color = await faucet.unshieldedColor(domain);
    label = 'mint'; await record('mint 100 test units', await faucet.mintUnshielded(domain, 100n, recipient));
    await sleep(15_000);
    label = 'deposit_unshielded'; await record(label, (await account.depositUnshielded(color, 100n)).txId);
    assert.equal((await account.ledgerState()).unshielded_balances.lookup(color), 100n);
    const originDigest = originHash(origin), slot = 0n, salt = rnd();
    const id = delegate.grantId(account.addressBytes, originDigest, slot);
    const scope = spendScope({ expiresAt: 0n, withdrawUnshielded: true, color, cap: 12n, perCallCap: 10n,
      recipientKind: RECIPIENT_USER_ADDRESS, recipient, rpIdHash: delegate.policy.rp_id_hash });
    let opening = openingOf(scope, salt, originDigest, slot);
    label = 'issue_grant_with_jubjub'; await record(label, (await account.issueGrant(owner, id, scope, salt)).txId);
    evidence.grant = { id: hex(id), color: hex(color), recipient: hex(recipient), cap: '12', perCallCap: '10' };
    const before = await account.ledgerState(), ownerCounter = await account.resolveUseCounter(owner);
    const ownerEntry = owner.entryAt(account.addressBytes, before.device_epoch, ownerCounter);
    const spend = (auth: P256GrantAuthorisation, amount = 5n, to = recipient) =>
      account.withdrawUnshieldedWithGrantAuth(color, amount, to, opening, auth);
    async function sign(amount: bigint, purpose: string) {
      const context = await account.grantContext(id);
      const challenge = p256GrantChallenges.withdrawUnshielded(context, delegate.pk, color, amount, recipient);
      state.operation = { purpose, account: account.address, grantId: hex(id), tokenColor: hex(color),
        amount: amount.toString(), recipient: hex(recipient), grantNonce: context.grantNonce.toString(),
        totalCap: '12', perCallCap: '10' };
      for (;;) {
        const prior = await snapshot(), proofCount = proofCalls, submittedCount = submissions;
        try {
          const auth = await delegate.sign(challenge);
          Object.assign(evidence.assertions.at(-1), { adapterVerified: true, chromeGrease: auth.chrome_grease });
          save(); return auth;
        }
        catch (error) {
          if (!(error instanceof CeremonyError) || !['NotAllowedError', 'AbortError'].includes(error.browserName)) throw error;
          assert.deepEqual(await snapshot(), prior); assert.equal(proofCalls, proofCount); assert.equal(submissions, submittedCount);
          evidence.negatives.push({ name: 'browser cancellation or denial', stage: 'browser', browserName: error.browserName,
            stateUnchanged: true, proofCalls: 0, submissions: 0 }); save();
        }
      }
    }
    const first = await sign(5n, 'Approve a spend of 5 localnet test units');
    progress('processing', 'Testing scope refusals, then proving and submitting the approved 5-unit spend…');
    await rejects('amount above per-call cap', () => spend(first, 11n), /amount above per-call cap/);
    await rejects('recipient outside pin', () => spend(first, 5n, rnd()), /recipient not admitted by pin/);
    await rejects('changed signed amount within scope', () => spend(first, 6n), /invalid grant signature/);
    label = 'withdraw_unshielded_with_grant_p256';
    const result = await spend(first); await record(label, result.txId);
    opening = { ...opening, spentPrev: 5n };
    const after = await account.ledgerState();
    assert.equal(after.unshielded_balances.lookup(color), 95n); assert.equal(after.grants.lookup(id).nonce, 1n);
    assert.deepEqual(after.grants.lookup(id).spent_commit, pureCircuits.derive_grant_spent_commit(salt, 5n));
    assert.equal(after.auth_nonce, before.auth_nonce); assert.ok(after.devices.member(ownerEntry));
    await rejects('replay with current spent opening', () => spend(first), /invalid grant signature/);
    state.result = { acceptedSpendTxId: result.txId, remainingAccountBalance: '95', grantNonce: '1' };
    const beforeRevocation = await sign(1n, 'Sign a revocation test: the grant will be revoked before this 1-unit request is attempted');
    progress('revoking', 'Revoking the grant, then checking that the signed 1-unit request is refused…');
    label = 'revoke_grant_with_jubjub'; await record(label, (await account.revokeGrant(owner, id)).txId);
    await rejects('revoked grant with valid pre-revocation signature', () => spend(beforeRevocation, 1n), /grant revoked/);
    const final = await account.ledgerState();
    assert.equal(final.unshielded_balances.lookup(color), 95n); assert.equal(final.grants.lookup(id).active, false);
    evidence.verdict = 'PASS'; evidence.completedAt = new Date().toISOString();
    state.result = { ...(state.result as object), grantRevoked: true, finalAccountBalance: '95',
      scopeRejection: true, replayRejection: true, revokedGrantRejection: true };
    progress('complete', 'PASS: the Ledger authorised a real localnet grant spend; scope, replay and revocation checks passed.');
  } finally { await ctx.walletCtx.wallet.stop(); }
}
void scenario().catch(error => {
  evidence.verdict = 'FAIL'; evidence.error = { ...serialiseError(error), inspected: inspect(error, { depth: 8 }) };
  progress('failed', `Flow stopped: ${error instanceof Error ? error.message : String(error)}`); console.error(error);
});

// Optional reuse of the user-authorised capture's PUBLIC credential data.
// The old signature is never replayed: account/grant signing happens later.
if (process.env.LEDGER_CREDENTIAL_FILE) {
  const source = readFileSync(process.env.LEDGER_CREDENTIAL_FILE);
  const capture = JSON.parse(source.toString('utf8'));
  assert.equal(capture.format, 'p256-gate-webauthn-v1');
  assert.equal(capture.capture?.origin, origin);
  evidence.importedCaptureSha256 = digest(source);
  acceptCredential({ credentialId: Buffer.from(capture.credential_id_b64url, 'base64url').toString('hex'),
    x: capture.pk_x_hex, y: capture.pk_y_hex, rpId, origin, source: 'public credential imported from earlier Ledger capture',
    userAgent: capture.capture?.browser });
}
