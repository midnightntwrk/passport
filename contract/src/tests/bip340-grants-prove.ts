// Prove the actual ACC unshielded BIP-340 grant circuit from simulator state.
// Setup calls are generated-JavaScript execution, including the owner-issued
// grant and simulated receiveUnshielded deposit. This is not node admission or
// evidence of funded assets. The original ACC ZKIR is checked and proved by the
// local proof server, which self-verifies its generated proof before returning.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCircuitContext } from '@midnight-ntwrk/compact-runtime';
import { createCheckPayload, parseCheckResult, proofDataIntoSerializedPreimage } from '@midnightntwrk/ledger-v9';
import { Contract, ledger, pureCircuits } from '../wallet/contract.js';
import {
  Bip340Grantee, bip340GrantChallenges, grantAuthArgs, JubjubDevice, jubjubChallenges,
  openingOf, originHash, RECIPIENT_USER_ADDRESS, scopeArgs, scopeDigest, spendScope,
  type Bip340GrantAuthorisation, type GrantContext,
} from '../wallet/signer.js';
import { makeWitnesses } from '../wallet/witnesses.js';
import { AccountSim } from './sim.js';
import { checkStreamingEncoding, proveStream } from './webauthn-variable/proof-provider.js';

const root = new URL('../../', import.meta.url);
const managed = new URL('contracts/managed/account/', root);
const evidence = new URL('evidence/bip340-grants/', root);
const captures = new URL('bip340-grant-proof-artifacts/', managed);
mkdirSync(evidence, { recursive: true });
mkdirSync(captures, { recursive: true });
const circuit = 'withdraw_unshielded_with_grant_bip340';
const endpoint = 'http://127.0.0.1:6391';
const startedAt = new Date().toISOString();
const files = [`keys/${circuit}.prover`, `keys/${circuit}.verifier`, `zkir/${circuit}.bzkir`]
  .map(file => fileURLToPath(new URL(file, managed)));
const ir = readFileSync(files[2]);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const bytes = (label: string) => new Uint8Array(createHash('sha256').update(label).digest());
const checks: unknown[] = [];
const samples: unknown[] = [];
let failure: string | undefined;

async function check(data: Uint8Array, reject = false): Promise<string | undefined> {
  const response = await fetch(new URL('/check', endpoint), {
    method: 'POST', body: createCheckPayload(data, ir) as BodyInit,
    headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(120_000),
  });
  if (reject) {
    const reason = await response.text();
    assert.equal(response.status, 400, `invalid assignment accepted or server failed: ${reason}`);
    assert.match(reason, /assert|constraint|Cannot extract coordinates of the Secp256k1 identity/i,
      `must fail original circuit evaluation, not HTTP or serialisation: ${reason}`);
    return reason;
  }
  assert.equal(response.status, 200, await response.clone().text());
  parseCheckResult(new Uint8Array(await response.arrayBuffer()));
}

async function run() {
  const sim = await AccountSim.create({ initialRecoveryPk: JubjubDevice.generate().pk,
    initialWrap: new Uint8Array(64), vetoWindowSeconds: 60n });
  const grantee = new Bip340Grantee(0x1234567890abcdefn);
  const origin = originHash('https://bip340-proof.example');
  const slot = 0n;
  const color = bytes('bip340 grant proof color');
  const recipient = bytes('bip340 grant proof recipient');
  const salt = bytes('bip340 grant proof scope salt');
  const balance = 100n, amount = 20n;
  const scope = spendScope({ withdrawUnshielded: true, color, cap: 60n, perCallCap: 25n,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient });
  const grantId = grantee.grantId(sim.address, origin, slot);
  const digest = scopeDigest(salt, scope);
  await sim.authorised('issue_grant',
    (context, device) => jubjubChallenges.issueGrant(context, device.pk, grantId, digest),
    [grantId, ...scopeArgs(scope), salt]);
  await sim.call('deposit_unshielded', color, balance);
  const before = sim.ledger();
  const grant = before.grants.lookup(grantId);
  assert.equal(grant.active, true);
  assert.equal(before.unshielded_balances.lookup(color), balance);
  const context: GrantContext = { contractAddress: sim.address, grantId,
    issuedAt: grant.issued_at, grantNonce: grant.nonce };
  const opening = openingOf(scope, salt, origin, slot);
  const signature = grantee.sign(bip340GrantChallenges.withdrawUnshielded(
    context, grantee.pk, color, amount, recipient));

  async function traceFor(value: bigint, auth: Bip340GrantAuthorisation, bypassVerifier = false) {
    const contract = new Contract(makeWitnesses());
    if (bypassVerifier) {
      // Test-instance-only masking lets a bad signature produce its own fresh
      // public ledger transcript. It changes neither generated files nor ZKIR.
      // The original verifier still executes and records its lift witness.
      type Verify = (...args: unknown[]) => Promise<boolean>;
      const internal = contract as unknown as Record<string, Verify>;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(contract))
        .filter(name => /verifyBip340_\d+$/.test(name));
      assert.equal(names.length, 1, 'expected one compiled 32-byte BIP-340 helper');
      const original = internal[names[0]];
      internal[names[0]] = async (...args: unknown[]) => {
        const verified = await original.apply(contract, args);
        assert.equal(verified, false, 'negative fixture must fail signature verification');
        return true;
      };
    }
    const result = await contract.impureCircuits[circuit](createCircuitContext({
      circuitId: circuit, contractAddress: sim.addressHex, coinPublicKeyOrZswapState: sim.coinPk,
      contractState: sim.state, privateState: sim.privateState, time: sim.now,
    }), color, value, { bytes: recipient }, ...grantAuthArgs(opening, auth) as [
      Uint8Array, Uint8Array, bigint, Uint8Array, bigint, Uint8Array, bigint, bigint, Uint8Array,
    ]);
    const after = ledger(result.context.callContext.currentQueryContext.state);
    assert.equal(after.grants.lookup(grantId).nonce, grant.nonce + 1n);
    assert.equal(after.unshielded_balances.lookup(color), balance - value);
    assert.deepEqual(after.grants.lookup(grantId).spent_commit,
      pureCircuits.derive_grant_spent_commit(salt, value));
    assert.equal(after.auth_nonce, before.auth_nonce, 'grant spend must not advance owner nonce');
    const trace = result.context.callProofDataTrace.at(-1)!;
    return proofDataIntoSerializedPreimage(trace.input, trace.output, trace.publicTranscript,
      trace.privateTranscriptOutputs, circuit);
  }

  const valid = await traceFor(amount, signature);
  await check(valid);
  checks.push({ name: 'owner-issued BIP-340 unshielded grant', result: 'ACCEPTED',
    grantNonceBefore: grant.nonce.toString(), grantNonceAfter: (grant.nonce + 1n).toString(),
    mirrorBalanceBefore: balance.toString(), mirrorBalanceAfter: (balance - amount).toString() });
  console.log('PASS original ACC ZKIR accepts the owner-issued BIP-340 grant withdrawal');

  const changedSignature = new Uint8Array(signature.sig);
  changedSignature[0] ^= 1;
  const negatives = [
    { name: 'changed signature', amount, auth: { ...signature, sig: changedSignature } },
    { name: 'changed withdrawal amount with original signature', amount: amount + 1n, auth: signature },
  ];
  for (const negative of negatives) {
    const data = await traceFor(negative.amount, negative.auth, true);
    const reason = await check(data, true);
    checks.push({ name: negative.name, result: 'REJECTED', reason,
      evidenceLayer: 'original ACC ZKIR; fresh invalid-input trace bypasses only generated JS verification result' });
    console.log(`PASS original ACC ZKIR rejects ${negative.name}`);
  }

  // Explicit test binding. No transaction or wallet signature is being built.
  const binding = 0n;
  checkStreamingEncoding(valid);
  console.log('Generating the real full-ACC unshielded BIP-340 grant proof');
  const proof = await proveStream(endpoint, valid, binding, files);
  writeFileSync(new URL(`${circuit}.preimage`, captures), valid);
  writeFileSync(new URL(`${circuit}.proof`, captures), proof.proof);
  writeFileSync(new URL(`${circuit}.json`, captures), JSON.stringify({ circuit,
    binding: binding.toString(), verifierKey: files[1], ir: files[2],
    preimageSha256: sha256(valid), proofSha256: sha256(proof.proof),
  }, null, 2) + '\n');
  samples.push({ circuit, proofBytes: proof.proof.length, requestBytes: proof.requestBytes,
    proveRequestMilliseconds: proof.milliseconds, proofSha256: sha256(proof.proof),
    preimageSha256: sha256(valid), binding: binding.toString() });
  console.log(`PASS generated full-ACC proof (${proof.proof.length} bytes)`);
}

try { await run(); }
catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }

async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { bytes: statSync(file).size, sha256: hash.digest('hex') };
}
const sources = ['contracts/account.compact', 'contracts/account-bip340.compact', 'contracts/bip340.compact',
  'contracts/account-p256.compact', 'contracts/webauthn.compact',
  'src/tests/bip340-grants-prove.ts', 'src/tests/sim.ts', 'src/tests/webauthn-variable/proof-provider.ts',
  'src/wallet/signer.ts', 'src/wallet/signer-bip340.ts', 'src/wallet/witnesses.ts', 'src/wallet/bip340-witness.ts'];
const compilerInfo = JSON.parse(readFileSync(new URL('compiler/contract-info.json', managed), 'utf8'));
writeFileSync(new URL('proofs.json', evidence), JSON.stringify({
  result: failure ? 'FAIL' : 'PASS', startedAt, completedAt: new Date().toISOString(),
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  circuit, evidenceLayer: 'Original full-ACC ZKIR constraint checks and local proof-server generation with server self-verification',
  limitations: [
    'Constructor, activation, owner grant issuance and deposit are simulated setup; they are not independently proved here.',
    'The unshielded balance mirror comes from simulated receiveUnshielded; no funded assets or node admission are established.',
    'No wallet, deployment-wave execution, independent native verifier, or shielded-withdrawal proof is tested here.',
    'ledger-v9 WASM is not used as proof-verification evidence: its proof-verifying build feature is disabled.',
  ],
  proofServerImage: 'midnightntwrk/proof-server:9.0.0-rc.8',
  compilerInfo: Object.fromEntries(['compiler-version', 'language-version', 'runtime-version']
    .map(key => [key, compilerInfo[key]])),
  runtimeVersions: Object.fromEntries(['@midnight-ntwrk/compact-runtime', '@midnightntwrk/ledger-v9']
    .map(name => [name, JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, root), 'utf8')).version])),
  sources: Object.fromEntries(sources.map(file => [file, sha256(readFileSync(new URL(file, root)))])),
  artefacts: Object.fromEntries(await Promise.all(files.map(async (file, index) =>
    [['proverKey', 'verifierKey', 'binaryZkir'][index], await hashFile(file)]))),
  checks, samples, failure,
}, null, 2) + '\n');
if (failure) throw new Error(failure);
