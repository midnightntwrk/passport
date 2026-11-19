// Native Compact account coverage for the normal and exact Chrome GREASE
// WebAuthn profiles. Captured hardware signatures verify through the compiled
// pure circuit. Stateful grant/device cases use an independent Node/OpenSSL
// software authenticator to sign fresh account challenges; they are explicitly
// simulator coverage, not evidence of a hardware-authorised node transaction.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { p256 } from '@noble/curves/nist.js';
import { pureCircuits as probe } from '../../contracts/managed/probe-p256/contract/index.js';
import { pureCircuits as accountCircuits } from '../wallet/contract.js';
import { assertionMaterial, parseES256Signature, webauthnPolicy,
  type WebAuthnAssertion } from '../wallet/webauthn.js';
import { P256Device, P256Grantee, p256Challenges, p256GrantChallenges } from '../wallet/signer-p256.js';
import { JubjubDevice, jubjubChallenges, authArgs, grantAuthArgs, originHash,
  scopeArgs, scopeDigest, spendScope, openingOf } from '../wallet/signer.js';
import { AccountSim } from './sim.js';
import { softwarePasskey, sha256, TEST_ORIGIN, TEST_RP } from './p256-fixtures.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const decodeHex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const rows: { name: string; outcome: 'PASS' }[] = [];
const mark = (name: string) => { rows.push({ name, outcome: 'PASS' }); console.log(`PASS ${name}`); };
const provenance = JSON.parse(readFileSync(new URL('./ledger-flex/fixtures/provenance.json', import.meta.url), 'utf8'));
const policy = webauthnPolicy(TEST_RP, TEST_ORIGIN);

// Reconstruct the two test shapes independently of the production adapter.
const chromeTail = ',"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"';
function browserJSON(challenge: Uint8Array, grease: boolean): Uint8Array {
  return new Uint8Array(Buffer.from(
    `{"type":"webauthn.get","challenge":"${Buffer.from(challenge).toString('base64url')}","origin":"${TEST_ORIGIN}","crossOrigin":false${grease ? chromeTail : ''}}`,
  ));
}

const nativeVerify = (challenge: Uint8Array, assertion: WebAuthnAssertion,
  pk: { x: bigint; y: bigint; identity: boolean }, grease: boolean) =>
  probe.webauthn_verify_profiled(challenge, policy, assertion.authenticatorData,
    parseES256Signature(assertion.signature), pk, grease);

for (const [filename, grease, length] of [
  ['initial.json', false, 134], ['reconnect.json', true, 243],
] as const) {
  const raw = readFileSync(new URL(`./ledger-flex/fixtures/${filename}`, import.meta.url));
  assert.equal(hex(sha256(raw)), provenance.captures.find((v: any) => v.file === filename).sha256);
  const fixture = JSON.parse(raw.toString());
  const challenge = decodeHex(fixture.challenge_hex);
  const assertion: WebAuthnAssertion = {
    authenticatorData: decodeHex(fixture.authenticator_data_hex),
    clientDataJSON: new Uint8Array(Buffer.from(fixture.client_data_json_b64url, 'base64url')),
    signature: decodeHex(fixture.signature_der_hex),
  };
  const pk = { x: BigInt(`0x${fixture.pk_x_hex}`), y: BigInt(`0x${fixture.pk_y_hex}`), identity: false };
  assert.equal(assertion.clientDataJSON.length, length);
  assert.deepEqual(assertion.clientDataJSON, browserJSON(challenge, grease));
  const material = assertionMaterial(challenge, policy, pk, assertion);
  assert.equal(material.chrome_grease, grease);
  const circuitHash = grease
    ? probe.webauthn_client_data_hash_chrome_grease(challenge, policy.origin)
    : probe.webauthn_client_data_hash(challenge, policy.origin);
  assert.deepEqual(circuitHash, sha256(assertion.clientDataJSON));
  assert.equal(nativeVerify(challenge, assertion, pk, grease), true);
  assert.equal(nativeVerify(challenge, assertion, pk, !grease), false,
    'wrong layout selector must not authorise the same signature');
  const { r, s } = parseES256Signature(assertion.signature);
  assert.equal(probe.webauthn_verify_profiled(challenge, policy, assertion.authenticatorData,
    { r, s: p256.Point.Fn.ORDER - s }, pk, grease), true, 'both valid S forms remain accepted');
  const wrongChallenge = new Uint8Array(challenge); wrongChallenge[0] ^= 1;
  assert.equal(nativeVerify(wrongChallenge, assertion, pk, grease), false);
  mark(`captured ${filename}: exact hash, native ES256, selector and challenge binding`);
}

// Re-sign all envelope-policy mutations to separate policy failure from a
// damaged signature. Bypass the client adapter when testing the native gate.
const software = softwarePasskey();
const challenge = rnd();
for (const grease of [false, true]) {
  const goodJSON = browserJSON(challenge, grease);
  const good = await software.assertion(challenge, { clientDataJSON: goodJSON });
  assert.equal(nativeVerify(challenge, good, software.pk, grease), true);
  assert.equal(assertionMaterial(challenge, policy, software.pk, good).chrome_grease, grease);
  const source = Buffer.from(goodJSON).toString();
  for (const [label, mutated] of [
    ['origin', source.replace('8973', '8974')],
    ['type', source.replace('webauthn.get', 'webauthn.create')],
    ['cross-origin', source.replace('false', 'true')],
    ['duplicate origin', `${source.slice(0, -1)},"origin":"http://localhost:8974"}`],
    ['unsupported extra', `${source.slice(0, -1)},"future":"field"}`],
    ['whitespace', `{ ${source.slice(1)}`],
    ['challenge', source.replace(Buffer.from(challenge).toString('base64url'), Buffer.from(rnd()).toString('base64url'))],
    ...(grease ? [['GREASE value', source.replace('do not compare', 'do NOT compare')]] : []),
  ]) {
    const bad = await software.assertion(challenge, { clientDataJSON: new Uint8Array(Buffer.from(mutated)) });
    assert.throws(() => assertionMaterial(challenge, policy, software.pk, bad), /clientDataJSON/);
    assert.equal(nativeVerify(challenge, bad, software.pk, false), false, label);
    assert.equal(nativeVerify(challenge, bad, software.pk, true), false, label);
  }
  for (const flags of [0, 1, 4, 21, 37, 69, 133]) {
    const data = new Uint8Array(good.authenticatorData); data[32] = flags;
    const bad = await software.assertion(challenge, { clientDataJSON: goodJSON, authenticatorData: data });
    assert.throws(() => nativeVerify(challenge, bad, software.pk, grease), /flags/);
  }
  const wrongRP = new Uint8Array(good.authenticatorData); wrongRP[0] ^= 1;
  const badRP = await software.assertion(challenge, { clientDataJSON: goodJSON, authenticatorData: wrongRP });
  assert.throws(() => nativeVerify(challenge, badRP, software.pk, grease), /RP/);
  mark(`profile ${grease ? 'Chrome GREASE' : 'normal'}: re-signed envelope/RP/flag refusals`);
}

// Use the actual compiled ACC and its existing JubJub owner to issue a scoped
// grant to a P-256 delegate. The same delegate alternates browser shapes.
const recovery = JubjubDevice.generate();
const sim = await AccountSim.create({ initialRecoveryPk: recovery.pk, initialWrap: rnd(64), vetoWindowSeconds: 60n });
let grease = false;
const provider = (fresh: Uint8Array) => software.assertion(fresh, { clientDataJSON: browserJSON(fresh, grease) });
const device = new P256Device(software.pk, TEST_RP, TEST_ORIGIN, provider);
const delegate = new P256Grantee(software.pk, TEST_RP, TEST_ORIGIN, provider);
const deviceEntry = device.entryAt(sim.address, 0n, 0n);
await sim.authorised('add_device', (ctx, d) => jubjubChallenges.addDevice(ctx, d.pk, deviceEntry), [deviceEntry]);
let deviceCounter = 0n;
for (const shape of [false, true]) {
  grease = shape;
  const newKey = rnd();
  const auth = await device.sign(p256Challenges.rotateEncKey(sim.callContext(), device.pk, newKey), deviceCounter);
  assert.equal(auth.chrome_grease, shape);
  const before = sim.state.toString(false);
  await assert.rejects(() => sim.call('rotate_enc_key_with_p256', newKey,
    ...authArgs({ ...auth, chrome_grease: !shape })), /signature/);
  assert.deepEqual(sim.state.toString(false), before);
  await sim.call('rotate_enc_key_with_p256', newKey, ...authArgs(auth));
  assert.deepEqual(sim.ledger().enc_key, newKey);
  deviceCounter++;
  await assert.rejects(() => sim.call('rotate_enc_key_with_p256', newKey, ...authArgs(auth)), /unknown device/);
  mark(`compiled ACC device gate: ${shape ? 'Chrome GREASE' : 'normal'} rotation, selector refusal and replay refusal`);
}

const color = rnd(), recipient = rnd(), origin = originHash(TEST_ORIGIN), salt = rnd();
await sim.call('deposit_unshielded', color, 100n);
const id = delegate.grantId(sim.address, origin, 0n);
const scope = spendScope({ expiresAt: 0n, withdrawUnshielded: true, color,
  cap: 15n, perCallCap: 10n, rpIdHash: delegate.policy.rp_id_hash });
await sim.authorised('issue_grant', (ctx, d) => jubjubChallenges.issueGrant(ctx, d.pk, id, scopeDigest(salt, scope)),
  [id, ...scopeArgs(scope), salt]);
let opening = openingOf(scope, salt, origin, 0n);
const grantContext = () => {
  const g = sim.ledger().grants.lookup(id);
  return { contractAddress: sim.address, grantId: id, issuedAt: g.issued_at, grantNonce: g.nonce };
};
const freshGrantAuth = async (amount = 5n) => delegate.sign(
  p256GrantChallenges.withdrawUnshielded(grantContext(), delegate.pk, color, amount, recipient));
const spend = (auth: Awaited<ReturnType<typeof freshGrantAuth>>, amount = 5n, disclosed = opening) => sim.call(
  'withdraw_unshielded_with_grant_p256', color, amount, { bytes: recipient }, ...grantAuthArgs(disclosed, auth));
const ownerNonce = sim.ledger().auth_nonce;
for (const shape of [false, true]) {
  grease = shape;
  const auth = await freshGrantAuth();
  assert.equal(auth.chrome_grease, shape);
  const before = sim.state.toString(false);
  for (const action of [
    () => spend({ ...auth, chrome_grease: !shape }),
    () => spend(auth, 5n, { ...opening, originHash: rnd() }),
    () => spend({ ...auth, policy: { ...auth.policy, rp_id_hash: rnd() } }),
    () => spend(auth, 6n),
    () => spend(auth, 11n),
  ]) {
    await assert.rejects(action, /signature|per.call|origin|RP/);
    assert.deepEqual(sim.state.toString(false), before, 'failed grant operation must not mutate ACC state');
  }
  await spend(auth);
  opening = { ...opening, spentPrev: opening.spentPrev + 5n };
  assert.equal(sim.ledger().unshielded_balances.lookup(color), 100n - opening.spentPrev);
  assert.equal(sim.ledger().grants.lookup(id).nonce, opening.spentPrev / 5n);
  assert.deepEqual(sim.ledger().grants.lookup(id).spent_commit,
    accountCircuits.derive_grant_spent_commit(salt, opening.spentPrev));
  assert.equal(sim.ledger().auth_nonce, ownerNonce, 'grant spends leave owner authorisation nonce untouched');
  const after = sim.state.toString(false);
  await assert.rejects(() => spend(auth), /signature/);
  assert.deepEqual(sim.state.toString(false), after);
  mark(`compiled ACC grant gate: ${shape ? 'Chrome GREASE' : 'normal'} spend, selector/scope/amount/replay refusals`);
}
const capAuth = await freshGrantAuth(6n);
await assert.rejects(() => spend(capAuth, 6n), /cumulative cap/);
const pending = await freshGrantAuth(1n);
await sim.authorised('revoke_grant', (ctx, d) => jubjubChallenges.revokeGrant(ctx, d.pk, id), [id]);
const revokedState = sim.state.toString(false);
await assert.rejects(() => spend(pending, 1n), /revoked/);
assert.deepEqual(sim.state.toString(false), revokedState);
mark('compiled ACC grant gate: cumulative cap and post-revocation refusal');

const evidenceDir = path.resolve(process.env.EVIDENCE_DIR ?? 'evidence/ledger-flex-account');
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(path.join(evidenceDir, 'offline.json'), JSON.stringify({
  testId: 'ledger-flex-offline', verdict: 'PASS', ranAt: new Date().toISOString(),
  execution: 'compiled Compact pure circuits and AccountSim; no node submission or ZK proof generation',
  captures: provenance, checks: rows,
  coverage: { hardwareCapturedSignatures: 2, simulatedDeviceRotations: 2, simulatedGrantSpends: 2,
    layoutSelectors: [false, true], finalSimulatedBalance: '90', finalSimulatedGrantNonce: '2' },
  limitations: [
    'Existing Ledger signatures cover the fixed probe challenge, not these fresh account operations.',
    'Fresh account operations here use an independent Node/OpenSSL test authenticator.',
    'Hardware-authorised account transactions require the separate interactive Ledger experiment.',
    'This account profile accepts only the canonical normal JSON and exact Chromium GREASE variant.'
  ],
}, null, 2) + '\n');
console.log(`PASS ${rows.length} Ledger/Chrome native-account test groups; evidence ${evidenceDir}/offline.json`);
