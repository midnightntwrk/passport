// Same-credential PRF + ES256 diagnostic. PRF output, reader secret and viewing
// secret stay in this page. The local server stores only public metadata,
// ciphertext and diagnostic evidence. This is not an on-chain browser test.
import { assertionMaterial, browserAssertionProvider, validateP256Key, webauthnPolicy, type P256PublicKey } from '../../wallet/webauthn.js';
import { hex, random, prfInput, readerFromPrf, viewPublicKey, sealViewEnvelope, openViewEnvelope } from './codec.js';

const $ = (id: string) => document.getElementById(id)!;
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], v => parseInt(v, 16));
const toPk = (p: any): P256PublicKey => ({ x: BigInt(p.x), y: BigInt(p.y), identity: false });
const publicPk = (p: P256PublicKey) => ({ x: String(p.x), y: String(p.y) });
const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const integer = (b: Uint8Array) => b.reduce((n, v) => (n << 8n) | BigInt(v), 0n);
let state: any;
async function refresh() {
  state = await (await fetch('/state')).json();
  $('status').textContent = state.result?.verdict ?? (state.envelope ? 'Envelope ready. Reload, then restore and sign.' : 'Ready for a PRF capability check.');
  ($('existing') as HTMLButtonElement).disabled = !state.credential;
  ($('restore') as HTMLButtonElement).disabled = !state.envelope;
}
async function post(route: string, value: any) {
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...value, runId: state.runId }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
function context() { return { ...state.context, account: unhex(state.context.account) }; }
async function evaluatePrf(credentialId: string) {
  const c = await navigator.credentials.get({ publicKey: { rpId: state.context.rpId,
    challenge: random(), userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: unhex(credentialId) }],
    extensions: { prf: { eval: { first: prfInput(context()) } } } as AuthenticationExtensionsClientInputs,
  } }) as PublicKeyCredential | null;
  if (!c || hex(new Uint8Array(c.rawId)) !== credentialId) throw new Error('Cancelled or wrong credential');
  const prf = (c.getClientExtensionResults() as any).prf;
  if (!prf?.results?.first) throw new Error('This credential/browser returned no PRF output. ES256 signing support does not imply PRF support.');
  const output = new Uint8Array(prf.results.first);
  if (output.length !== 32) throw new Error('Unexpected PRF output length');
  return { output, authenticatorDataBytes: (c.response as AuthenticatorAssertionResponse).authenticatorData.byteLength };
}
async function prepare(credential: any) {
  $('status').textContent = 'Approve the PRF request for this credential.';
  const { output, authenticatorDataBytes } = await evaluatePrf(credential.credentialId);
  const reader = readerFromPrf(output, context()); output.fill(0);
  const secret = random(), pk = toPk(credential.pk);
  const envelope = await sealViewEnvelope(context(), reader.publicKey, secret, pk);
  const currentViewPublicKey = viewPublicKey(secret);
  secret.fill(0); reader.secretKey.fill(0);
  await post('/prepared', { credential, envelope: hex(envelope), currentViewPublicKey: hex(currentViewPublicKey),
    readerPublicKey: hex(reader.publicKey), prfAuthenticatorDataBytes: authenticatorDataBytes });
  await refresh();
  $('detail').textContent = 'Encrypted envelope saved on the local server. Secret buffers cleared. Reload this page, then restore with the same passkey.';
}
async function create() {
  const c = await navigator.credentials.create({ publicKey: { rp: { id: state.context.rpId, name: 'Passport PRF + P-256 experiment' },
    user: { id: random(), name: `envelope-${state.runId.slice(0, 8)}`, displayName: 'Passport envelope test' },
    challenge: random(), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], attestation: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
  } }) as PublicKeyCredential | null;
  if (!c) throw new Error('Creation cancelled');
  const response = c.response as AuthenticatorAttestationResponse;
  if (response.getPublicKeyAlgorithm() !== -7 || !response.getPublicKey()) throw new Error('ES256 required');
  const key = await crypto.subtle.importKey('spki', response.getPublicKey()!, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pk = { x: integer(fromB64(jwk.x!)), y: integer(fromB64(jwk.y!)), identity: false }; validateP256Key(pk);
  await prepare({ credentialId: hex(new Uint8Array(c.rawId)), pk: publicPk(pk), source: 'created-with-prf-request',
    prfEnabledAtCreation: (c.getClientExtensionResults() as any).prf?.enabled ?? null });
}
async function restore() {
  $('status').textContent = 'First approve PRF unlock; then approve a separate P-256 signature.';
  const { output, authenticatorDataBytes } = await evaluatePrf(state.credential.credentialId);
  const reader = readerFromPrf(output, context()); output.fill(0);
  const opened = await openViewEnvelope(context(), reader.secretKey, unhex(state.envelope), unhex(state.currentViewPublicKey));
  reader.secretKey.fill(0);
  if (!opened) throw new Error('PRF-derived key did not open the current envelope');
  opened.viewSecret.fill(0);
  const challenge = unhex(state.signingChallenge);
  const assertion = await browserAssertionProvider(unhex(state.credential.credentialId), state.context.rpId)(challenge);
  assertionMaterial(challenge, webauthnPolicy(state.context.rpId, location.origin), opened.signingKey, assertion);
  await post('/result', { verdict: 'PASS', envelopeBytes: unhex(state.envelope).length,
    readerPublicKey: hex(reader.publicKey), restoredPublicSigningKey: publicPk(opened.signingKey),
    prfAuthenticatorDataBytes: authenticatorDataBytes, browser: navigator.userAgent,
    assertion: { authenticatorData: hex(assertion.authenticatorData), clientDataJSON: hex(assertion.clientDataJSON), signature: hex(assertion.signature) } });
  await refresh(); $('detail').textContent = 'PASS: the same credential provided repeatable PRF output to decrypt, then a separate valid ES256 signature. No new Passport account was created. This test uses an off-chain test envelope, not the live account inbox.';
}
for (const [id, fn] of [['existing', () => prepare(state.credential)], ['create', create], ['restore', restore]] as const) {
  $(id).addEventListener('click', async () => {
    for (const b of document.querySelectorAll('button')) b.disabled = true;
    try { await fn(); } catch (error) {
      $('detail').textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      await post('/event', { message: $('detail').textContent, browser: navigator.userAgent }).catch(() => {});
    } finally { await refresh(); ($('create') as HTMLButtonElement).disabled = false; }
  });
}
void refresh();
