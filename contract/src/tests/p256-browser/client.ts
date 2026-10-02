import { browserAssertionProvider, createBrowserCredential } from '../../wallet/webauthn.js';

const $ = (id: string) => document.getElementById(id)!;
const button = (id: string) => $(id) as HTMLButtonElement;
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const bytes = (s: string) => Uint8Array.from(s.match(/../g)!, x => parseInt(x, 16));
const storageKey = 'passport:p256:local-browser-credential:v1';
let state: any, busy = false;
async function post(route: string, payload: unknown) {
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload as object, runId: state.runId }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
async function report(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  $('error').textContent = message;
  await post('/browser-event', { event: { error: message, userAgent: navigator.userAgent } }).catch(() => {});
}
function render() {
  $('status').textContent = state.message;
  $('phase').textContent = state.phase.toUpperCase();
  $('account').textContent = state.account ?? 'Will be deployed after passkey registration.';
  $('operation').textContent = state.operation ? JSON.stringify(state.operation, null, 2) : 'A fresh local test account; no asset transfer.';
  $('events').textContent = state.events.map((e: any) => `${e.at.slice(11, 19)}  ${e.message}`).join('\n');
  $('result').textContent = state.result ? JSON.stringify(state.result, null, 2) : '';
  button('create').hidden = state.phase !== 'registration';
  button('reuse').hidden = state.phase !== 'registration' || !localStorage.getItem(storageKey);
  button('approve').hidden = state.phase !== 'approval';
  button('cancel').hidden = state.phase !== 'cancellation';
  for (const id of ['create', 'reuse', 'approve', 'cancel']) button(id).disabled = busy;
}
async function refresh() {
  const response = await fetch('/status');
  state = await response.json(); render();
}
async function register(reuse: boolean) {
  busy = true; render(); $('error').textContent = '';
  try {
    let metadata: any;
    if (reuse) metadata = JSON.parse(localStorage.getItem(storageKey)!);
    else {
      $('status').textContent = 'Complete passkey creation, then the profile-check approval prompt.';
      const credential = await createBrowserCredential(state.rpId, location.origin, `Passport local test ${new Date().toLocaleString()}`);
      metadata = { credentialId: hex(credential.credentialId), x: credential.pk.x.toString(16).padStart(64, '0'),
        y: credential.pk.y.toString(16).padStart(64, '0'), rpId: credential.rpId, origin: credential.origin };
      localStorage.setItem(storageKey, JSON.stringify(metadata));
    }
    await post('/credential', { ...metadata, createdOrReused: reuse ? 'reused' : 'created', userAgent: navigator.userAgent });
  } catch (error) { await report(error); }
  finally { busy = false; await refresh(); }
}
async function sign() {
  const request = state.request;
  if (!request || busy) return;
  busy = true; render(); $('error').textContent = '';
  const start = performance.now();
  let payload: Record<string, unknown>;
  try {
    const assertion = await browserAssertionProvider(bytes(request.credentialId), state.rpId)(bytes(request.challenge));
    payload = { authenticatorData: hex(assertion.authenticatorData), clientDataJSON: hex(assertion.clientDataJSON), signature: hex(assertion.signature) };
  } catch (error) {
    payload = { error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } };
  }
  try { await post('/assertion', { requestId: request.id, ...payload, browserMilliseconds: performance.now() - start }); }
  catch (error) { await report(error); }
  finally { busy = false; await refresh(); }
}
button('create').onclick = () => void register(false);
button('reuse').onclick = () => void register(true);
button('approve').onclick = () => void sign();
button('cancel').onclick = () => void sign();
await refresh();
if (!window.isSecureContext || !window.PublicKeyCredential) {
  $('error').textContent = 'WebAuthn is unavailable. Open http://localhost:8973 in Safari or Chrome.';
}
setInterval(() => { if (!busy) void refresh().catch(error => { $('error').textContent = String(error); }); }, 1000);
