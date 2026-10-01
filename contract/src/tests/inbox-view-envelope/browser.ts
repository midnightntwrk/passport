import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { assertionMaterial, webauthnPolicy, validateP256Key } from '../../wallet/webauthn.js';
import { random, hex } from './codec.js';

const origin = 'http://localhost:8984', rpId = 'localhost', runId = randomUUID();
const state: any = { runId, context: { network: 'offline-browser-probe', account: hex(random()), rpId, origin },
  signingChallenge: hex(random()), events: [], scope: 'Same-credential PRF + ES256 browser probe; no account deployment or on-node claim.' };
if (process.env.PASSKEY_CREDENTIAL_FILE) {
  const { credential } = JSON.parse(readFileSync(process.env.PASSKEY_CREDENTIAL_FILE, 'utf8'));
  assert.equal(credential.rpId, rpId);
  state.credential = { credentialId: credential.credentialId, pk: credential.pk, source: 'existing-public-credential-metadata' };
}
const directory = new URL('.', import.meta.url);
const bundle = await build({ entryPoints: [new URL('browser-client.ts', directory).pathname], bundle: true,
  write: false, platform: 'browser', format: 'esm', target: 'es2022' });
const html = `<!doctype html><meta charset="utf-8"><title>One passkey: PRF + P-256</title>
<style>body{font:18px system-ui;max-width:800px;margin:60px auto;padding:20px;line-height:1.5}button{font:inherit;padding:12px;margin:8px}pre{white-space:pre-wrap}</style>
<h1>One passkey: signing and decryption</h1><p>PRF unlocks a separate encryption key. ES256 signs independently. Neither the signing secret nor PRF output is sent to this local server.</p>
<p>This capability test stores a 192-byte encrypted envelope locally. It creates no Passport account and submits no transactions.</p>
<button id="existing">1. Test existing passkey PRF</button><button id="create">Create a test passkey with PRF</button>
<p>After preparing an envelope, reload this page to discard page memory, then:</p><button id="restore">2. Restore and sign with the same passkey</button>
<h2 id="status">Loading…</h2><pre id="detail"></pre><script type="module" src="/app.js"></script>`;
const bytes = (s: unknown, size?: number) => {
  assert.equal(typeof s, 'string'); assert.match(s as string, /^(?:[0-9a-f]{2})+$/i);
  const out = new Uint8Array(Buffer.from(s as string, 'hex')); if (size !== undefined) assert.equal(out.length, size); return out;
};
const pk = (p: any) => { const value = { x: BigInt(p.x), y: BigInt(p.y), identity: false }; validateP256Key(value); return value; };
function save() {
  mkdirSync('evidence/inbox-view-envelope', { recursive: true });
  writeFileSync(`evidence/inbox-view-envelope/run-browser-${runId}.json`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
createServer(async (req, res) => {
  const reply = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  try {
    assert.equal(req.headers.host, 'localhost:8984');
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (req.method === 'GET' && req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle.outputFiles[0].contents); return; }
    if (req.method === 'GET' && req.url === '/state') { reply(200, state); return; }
    assert.equal(req.method, 'POST'); assert.equal(req.headers.origin, origin); assert.equal(req.headers['content-type'], 'application/json');
    let body = ''; for await (const part of req) { body += part.toString(); assert.ok(Buffer.byteLength(body) <= 32_768); }
    const input = JSON.parse(body); assert.equal(input.runId, runId, 'stale browser run');
    if (req.url === '/prepared') {
      assert.equal(state.envelope, undefined, 'one prepared envelope per run');
      bytes(input.envelope, 192); bytes(input.currentViewPublicKey, 32); bytes(input.readerPublicKey, 32);
      assert.ok(bytes(input.credential.credentialId).length <= 1024); pk(input.credential.pk);
      state.credential = input.credential; state.envelope = input.envelope;
      state.currentViewPublicKey = input.currentViewPublicKey; state.readerPublicKey = input.readerPublicKey;
      state.prfAuthenticatorDataBytes = input.prfAuthenticatorDataBytes;
    } else if (req.url === '/result') {
      assert.ok(state.envelope); assert.equal(input.verdict, 'PASS'); assert.equal(input.envelopeBytes, 192);
      assert.equal(input.readerPublicKey, state.readerPublicKey);
      assert.deepEqual(pk(input.restoredPublicSigningKey), pk(state.credential.pk));
      assertionMaterial(bytes(state.signingChallenge, 32), webauthnPolicy(rpId, origin), pk(state.credential.pk), {
        authenticatorData: bytes(input.assertion.authenticatorData), clientDataJSON: bytes(input.assertion.clientDataJSON),
        signature: bytes(input.assertion.signature),
      });
      state.result = { ...input, completedAt: new Date().toISOString(),
        note: 'Server independently verifies ES256. PRF/decryption results are browser-reported; no PRF secret is exported.' };
      console.log('PASS: browser reports same-credential PRF restore; independent ES256 signature verification passed.');
    } else if (req.url === '/event') state.events.push({ message: String(input.message).slice(0, 2048), browser: String(input.browser).slice(0, 1024) });
    else throw new Error('unknown route');
    save(); reply(200, { ok: true });
  } catch (e) { reply(400, { error: e instanceof Error ? e.message : String(e) }); }
}).listen(8984, '127.0.0.1', () => console.log(`Open ${origin}; use existing passkey, reload, restore and sign. Run ${runId}`));
save();
