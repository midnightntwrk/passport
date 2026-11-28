// Use the contract's tsx loader and installed dependencies. Arguments are the
// contract directory, compiled baseline probe directory, and compiled shared probe directory.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.length !== 5) {
  throw new Error('Usage: check.mjs CONTRACT_DIR BASELINE_PROBE_DIR SHARED_PROBE_DIR');
}
const [contract, baseline, shared] = process.argv.slice(2).map(arg => path.resolve(arg));
const { parseES256Signature, webauthnPolicy } = await import(
  pathToFileURL(path.join(contract, 'src/wallet/webauthn.ts'))
);
const fixtureDirectory = path.join(contract, 'src/tests/ledger-flex/fixtures');
for (const [variant, directory] of [['current', baseline], ['shared', shared]]) {
  const { pureCircuits } = await import(pathToFileURL(path.join(directory, 'contract/index.js')));
  for (const [fixture, grease, length] of [['initial.json', false, 134], ['reconnect.json', true, 243]]) {
    const capture = JSON.parse(await readFile(path.join(fixtureDirectory, fixture), 'utf8'));
    const clientData = Buffer.from(capture.client_data_json_b64url, 'base64url');
    assert.equal(clientData.length, length);
    const origin = JSON.parse(clientData.toString('utf8')).origin;
    const policy = webauthnPolicy(new URL(origin).hostname, origin);
    const challenge = Buffer.from(capture.challenge_hex, 'hex');
    const data = Buffer.from(capture.authenticator_data_hex, 'hex');
    const signature = parseES256Signature(Buffer.from(capture.signature_der_hex, 'hex'));
    const key = { x: BigInt('0x' + capture.pk_x_hex), y: BigInt('0x' + capture.pk_y_hex), identity: false };
    const verify = (p, selector) => pureCircuits.webauthn_verify_profiled(challenge, p, data, signature, key, selector);
    assert.equal(verify(policy, grease), true);
    assert.equal(verify(policy, !grease), false);
    const badOrigin = Buffer.from(policy.origin);
    badOrigin[0] = 34; // An unescaped double quote changes the signed JSON structure.
    assert.throws(() => verify({ ...policy, origin: badOrigin }, grease), /invalid origin bytes/);
    console.log(`PASS ${variant} ${fixture} (${length} bytes): signature, selector and origin checks`);
  }
}
