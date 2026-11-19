export {};

const $ = (id: string) => document.getElementById(id)!;
const button = (id: string) => $(id) as HTMLButtonElement;
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const bytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
const fromBase64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
let state: any, busy = false;
async function post(route: string, payload: Record<string, unknown>) {
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, runId: state.runId }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
async function report(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  $('error').textContent = message;
  await post('/browser-event', { event: { error: message, userAgent: navigator.userAgent } }).catch(() => {});
}
function render() {
  $('phase').textContent = state.phase.toUpperCase(); $('status').textContent = state.message;
  $('account').textContent = state.account ?? 'A fresh test account will be deployed.';
  $('operation').textContent = state.operation ? JSON.stringify(state.operation, null, 2) : 'Waiting for account and grant setup.';
  $('events').textContent = state.events.map((e: any) => `${e.at.slice(11, 19)} ${e.message}`).join('\n');
  $('result').textContent = state.result ? JSON.stringify(state.result, null, 2) : '';
  $('registration').hidden = state.phase !== 'registration'; button('approve').hidden = state.phase !== 'approval';
  for (const id of ['create', 'import', 'approve']) button(id).disabled = busy;
}
async function refresh() { state = await (await fetch('/status')).json(); render(); }
async function register(create: boolean) {
  busy = true; render(); $('error').textContent = '';
  try {
    let metadata: Record<string, unknown>;
    if (create) {
      const name = `Ledger grant test ${new Date().toLocaleString()}`;
      const credential = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { id: state.rpId, name: 'Passport Ledger grant test' },
        user: { id: crypto.getRandomValues(new Uint8Array(32)), name, displayName: name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], attestation: 'none', timeout: 120000,
        authenticatorSelection: { authenticatorAttachment: 'cross-platform', residentKey: 'discouraged',
          requireResidentKey: false, userVerification: 'required' },
      } }) as PublicKeyCredential | null;
      if (!credential) throw new Error('Credential creation was cancelled.');
      const response = credential.response as AuthenticatorAttestationResponse;
      if (response.getPublicKeyAlgorithm() !== -7) throw new Error('The security key did not create an ES256 credential.');
      const spki = response.getPublicKey();
      if (!spki) throw new Error('This browser did not return the credential public key.');
      const transports = response.getTransports();
      if (transports.length && !transports.includes('usb')) throw new Error('Use the Ledger connected through USB.');
      const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const jwk = await crypto.subtle.exportKey('jwk', key);
      if (!jwk.x || !jwk.y) throw new Error('Missing P-256 public-key coordinates.');
      metadata = { credentialId: hex(new Uint8Array(credential.rawId)), x: hex(fromBase64Url(jwk.x)),
        y: hex(fromBase64Url(jwk.y)), rpId: state.rpId, origin: location.origin, source: 'new external browser credential' };
    } else {
      const file = ($('capture') as HTMLInputElement).files?.[0];
      if (!file) throw new Error('Choose ledger-flex-vector.json first.');
      if (file.size > 65_536) throw new Error('Capture file is too large.');
      const capture = JSON.parse(await file.text());
      if (capture.format !== 'p256-gate-webauthn-v1' || capture.capture?.origin !== location.origin) {
        throw new Error('Expected a Ledger probe capture for this localhost origin.');
      }
      const id = fromBase64Url(capture.credential_id_b64url);
      metadata = { credentialId: hex(id), x: capture.pk_x_hex, y: capture.pk_y_hex,
        rpId: state.rpId, origin: location.origin, source: 'public credential imported from earlier Ledger capture' };
    }
    await post('/credential', { ...metadata, userAgent: navigator.userAgent });
  } catch (error) { await report(error); }
  finally { busy = false; await refresh(); }
}
async function sign() {
  const request = state.request; if (!request || busy) return;
  busy = true; render(); $('error').textContent = ''; const start = performance.now();
  let payload: Record<string, unknown>;
  try {
    const id = bytes(request.credentialId);
    const credential = await navigator.credentials.get({ publicKey: {
      challenge: bytes(request.challenge).buffer, rpId: state.rpId, userVerification: 'required', timeout: 120000,
      allowCredentials: [{ type: 'public-key', id: id.buffer, transports: ['usb'] }],
    } }) as PublicKeyCredential | null;
    if (!credential) throw new DOMException('The Ledger request was cancelled.', 'NotAllowedError');
    if (hex(new Uint8Array(credential.rawId)) !== request.credentialId) throw new Error('A different credential was returned.');
    const response = credential.response as AuthenticatorAssertionResponse;
    payload = { credentialId: hex(new Uint8Array(credential.rawId)), authenticatorData: hex(new Uint8Array(response.authenticatorData)),
      clientDataJSON: hex(new Uint8Array(response.clientDataJSON)), signature: hex(new Uint8Array(response.signature)) };
  } catch (error) { payload = { error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }; }
  try { await post('/assertion', { ...payload, requestId: request.id, browserMilliseconds: performance.now() - start,
    userAgent: navigator.userAgent }); }
  catch (error) { await report(error); }
  finally { busy = false; await refresh(); }
}
button('create').onclick = () => void register(true);
button('import').onclick = () => void register(false);
button('approve').onclick = () => void sign();
await refresh();
if (!window.isSecureContext || !window.PublicKeyCredential) $('error').textContent = 'Open http://localhost:8973 in Chrome with WebAuthn enabled.';
setInterval(() => { if (!busy) void refresh().catch(error => { $('error').textContent = String(error); }); }, 1000);
