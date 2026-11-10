// Node-backed identity and authenticator-extension controls for wa-json134.
// Deploys only three ORIGINAL account operations, with the original constructor
// and verifier keys and an unsatisfiable maintenance authority. This unfunded
// diagnostic fixture is not a full conforming account deployment.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { p256 } from '@noble/curves/nist.js';
import {
  ContractState, ContractDeploy, ContractMaintenanceAuthority, Intent, Transaction,
} from '@midnightntwrk/ledger-v9';
import { createUnprovenDeployTx, submitTx, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { setupWallet, compiledAccountContract } from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { JubjubDevice, originHash, spendScope, openingOf, jubjubChallenges,
  scopeDigest, scopeArgs, authArgs, grantAuthArgs } from '../wallet/signer.js';
import { ledger } from '../wallet/contract.js';
import { p256GrantChallenges, type P256GrantAuthorisation } from '../wallet/signer-p256.js';
import { parseES256Signature, type WebAuthnAssertion } from '../wallet/webauthn.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { emptyCoinStore } from '../wallet/witnesses.js';
import { queryTxPosition } from '../wallet/capture.js';
import { softwarePasskey, sha256, TEST_ORIGIN } from './p256-fixtures.js';
import { runScenario, step } from './runner.js';
import { writeEvidence } from './evidence.js';

const rnd = () => new Uint8Array(randomBytes(32));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const circuits = ['activate_initial_device_with_jubjub', 'issue_grant_with_jubjub',
  'withdraw_unshielded_with_grant_p256'] as const;
const captureProvenance = () => Object.fromEntries([
  './p256-grant-refusals.ts', './p256-fixtures.ts', '../wallet/account.ts', '../wallet/signer.ts',
  '../wallet/signer-p256.ts', '../wallet/webauthn.ts', '../../package-lock.json',
  '../../contracts/account.compact', '../../contracts/account-p256.compact', '../../contracts/webauthn.compact',
  '../../contracts/managed/account/contract/index.js', '../../contracts/managed/account/compiler/contract-manifest.json',
  ...circuits.flatMap(name => [`../../contracts/managed/account/zkir/${name}.bzkir`,
    `../../contracts/managed/account/keys/${name}.verifier`]),
].map(relative => {
  const bytes = readFileSync(new URL(relative, import.meta.url));
  return [relative, { bytes: bytes.length, sha256: hex(sha256(bytes)) }];
}));

await runScenario('P-256 grant identity and extension refusals', async () => {
  const provenance = captureProvenance();
  const ctx = await setupWallet(), compiled = compiledAccountContract();
  const transactions: unknown[] = [], refusals: unknown[] = [];
  const record = async (label: string, txId: string) => {
    const position = await queryTxPosition(txId);
    assert.equal(position.error, undefined);
    assert.equal(position.status, 'SUCCESS');
    transactions.push({ label, txId, blockHeight: position.blockHeight, status: position.status });
    console.log(`  accepted ${label}: ${txId}`);
  };

  step('deploy original constructor and three original operations');
  const owner = JubjubDevice.generate(), salt = rnd(), enc = generateEncKeyPair();
  const privateState = emptyCoinStore(enc.secretKey);
  const privateStateId = `p256-refusals-${hex(rnd())}`;
  const prepared = await createUnprovenDeployTx(ctx.providers, {
    compiledContract: compiled, privateStateId, initialPrivateState: privateState,
    args: [owner.bootCommitment(salt), enc.publicKey, JubjubDevice.generate().pk, new Uint8Array(64), 60n],
  } as any);
  const full = ContractState.deserialize(prepared.public.initialContractState.serialize());
  const minimal = new ContractState();
  minimal.data = full.data;
  minimal.maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 0n);
  for (const circuit of circuits) {
    const operation = full.operation(circuit);
    assert.ok(operation, `original operation missing: ${circuit}`);
    minimal.setOperation(circuit, operation);
  }
  const deploy = new ContractDeploy(minimal), address = String(deploy.address);
  const unprovenTx = Transaction.fromParts(getNetworkId(), undefined, undefined,
    Intent.new(new Date(Date.now() + 60_000)).addDeploy(deploy));
  const deployed = await submitTx(ctx.providers, { unprovenTx } as any);
  await record('minimal diagnostic deployment', deployed.txId);
  await ctx.providers.privateStateProvider.setContractAddress(address);
  await ctx.providers.privateStateProvider.set(privateStateId, privateState);
  // The full-account finder deliberately rejects a restricted roster. Use
  // the per-operation API: its circuit and verifier key are still the original
  // compiled account's, while the fixture claims only this three-operation ABI.
  const call = (circuitId: string, args: unknown[]): Promise<any> => submitCallTx(ctx.providers, {
    compiledContract: compiled, contractAddress: address, circuitId, privateStateId, args,
  } as any);
  const readLedger = async () => ledger((await ctx.providers.publicDataProvider.queryContractState(address)).data);
  const addressBytes = new Uint8Array(Buffer.from(address, 'hex'));
  const activated = await call('activate_initial_device_with_jubjub', [owner.pk, salt]);
  await record('activate jubjub owner', activated.public.txId);
  assert.equal((await readLedger()).spec_version, 3n);

  step('issue a real P-256 grant and prepare genuine signed assertions');
  const delegate = softwarePasskey(), origin = originHash(TEST_ORIGIN), scopeSalt = rnd();
  const color = rnd(), recipient = userAddressBytes(ctx.walletCtx);
  const id = delegate.grantee.grantId(addressBytes, origin, 0n);
  const scope = spendScope({ expiresAt: 0n, withdrawUnshielded: true, color, cap: 10n, rpIdHash: delegate.policy.rp_id_hash });
  const ownerContext = { contractAddress: addressBytes, authNonce: (await readLedger()).auth_nonce };
  const ownerAuth = owner.sign(jubjubChallenges.issueGrant(ownerContext, owner.pk, id, scopeDigest(scopeSalt, scope)), 0n);
  const issued = await call('issue_grant_with_jubjub', [id, ...scopeArgs(scope), scopeSalt, ...authArgs(ownerAuth)]);
  await record('issue real P-256 grant', issued.public.txId);
  const opening = openingOf(scope, scopeSalt, origin, 0n);
  const grant = (await readLedger()).grants.lookup(id);
  const grantContext = { contractAddress: addressBytes, grantId: id, issuedAt: grant.issued_at, grantNonce: grant.nonce };
  const challenge = p256GrantChallenges.withdrawUnshielded(grantContext, delegate.pk, color, 1n, recipient);
  const auth = await delegate.grantee.sign(challenge);
  const signedMaterial = (assertion: WebAuthnAssertion): P256GrantAuthorisation => {
    assert.ok(p256.verify(assertion.signature,
      Buffer.concat([assertion.authenticatorData, sha256(assertion.clientDataJSON)]),
      p256.Point.fromAffine(delegate.pk).toBytes(false), { format: 'der', lowS: false }),
    'test assertion must carry a genuine ES256 signature over its exact envelope');
    return { ...auth, authenticator_data: assertion.authenticatorData, sig: parseES256Signature(assertion.signature) };
  };
  const edPrefix = new Uint8Array(auth.authenticator_data);
  edPrefix[32] |= 0x80; // UP + UV + ED.
  const edOnly = await delegate.assertion(challenge, { authenticatorData: edPrefix });
  // Valid CBOR extension-map shape { "test": true }, appended to the 37-byte
  // authenticator-data prefix with ED set. Its ES256 signature covers the suffix.
  const extensionMap = Uint8Array.of(0xa1, 0x64, 0x74, 0x65, 0x73, 0x74, 0xf5);
  const withExtension = await delegate.assertion(challenge, {
    authenticatorData: new Uint8Array([...edPrefix, ...extensionMap]),
  });
  const edAuth = signedMaterial(edOnly), extensionAuth = signedMaterial(withExtension);

  let proofs = 0, submissions = 0;
  const prove = ctx.providers.proofProvider.proveTx.bind(ctx.providers.proofProvider);
  ctx.providers.proofProvider.proveTx = async (...args: any[]) => { proofs++; return prove(...args); };
  const submit = ctx.providers.midnightProvider.submitTx.bind(ctx.providers.midnightProvider);
  ctx.providers.midnightProvider.submitTx = async (...args: any[]) => { submissions++; return submit(...args); };
  const stateBytes = async () => {
    const state = await ctx.providers.publicDataProvider.queryContractState(address);
    assert.ok(state);
    return new Uint8Array(state.serialize());
  };
  const reject = async (label: string, material: P256GrantAuthorisation, expected: RegExp,
    stage: string, control = false) => {
    const before = await stateBytes();
    let message = '';
    await assert.rejects(() => call('withdraw_unshielded_with_grant_p256',
      [color, 1n, { bytes: recipient }, ...grantAuthArgs(opening, material)]), error => {
      message = String(error);
      assert.match(message, expected);
      return true;
    });
    assert.equal(proofs, 0, 'refusal reached prover');
    assert.equal(submissions, 0, 'refusal reached submission');
    assert.deepEqual(await stateBytes(), before, 'refusal mutated chain state');
    refusals.push({ label, stage, control, message, stateHash: hex(sha256(before)) });
    console.log(`  rejected ${label}: ${message.slice(0, 200)}`);
  };

  step('identity, ED flag, and signed CBOR suffix rejected at distinct boundaries');
  await reject('identity grantee key', { ...auth, pk: { x: 0n, y: 0n, identity: true } },
    /cannot extract the x-coordinate of the secp256r1 identity point/, 'native-point-validation');
  await reject('ED flag in fixed-size authenticator-data prefix', edAuth,
    /WebAuthn flags require UP and UV/, 'circuit-profile-policy');
  await reject('signed ED assertion with CBOR extension-map suffix', extensionAuth,
    /type error:.*authenticator_data: Bytes<37>/, 'fixed-size-argument-encoding');
  // A valid ordinary assertion gets through the grant and signature checks,
  // reaching the unfunded custody guard. The fixture is not a vacuous verifier.
  await reject('valid wa-json134 assertion reaches custody', auth, /no balance for color/, 'custody-positive-control', true);
  assert.equal((await readLedger()).grants.lookup(id).nonce, 0n);
  assert.deepEqual(captureProvenance(), provenance, 'sources or artifacts changed during the refusal run');
  writeEvidence({ testId: 'p256-grant-refusals', name: 'conformance', fileName: 'p256-grant-refusals.json', verdict: 'PASS',
    description: 'Node-backed P-256 grant identity and bounded wa-json134 authenticator-extension refusals',
    note: 'Three original account operations deployed with original source and verifier keys. The real issued grant is unfunded. Invalid inputs never reach proving/submission and leave serialized state unchanged; valid ordinary authentication reaches the expected custody guard. This restricted fixture does not establish full account conformance.',
    details: { account: address, schema: 3, profile: 'wa-json134', deployedInterface: circuits,
      maintenanceAuthority: { committeeSize: 0, threshold: 1 }, transactions, refusals, provenance,
      extensionAssertions: { fixedPrefixBytes: edPrefix.length, flags: edPrefix[32],
        extendedBytes: withExtension.authenticatorData.length, cborSuffixHex: hex(extensionMap),
        authenticatorDataHex: hex(withExtension.authenticatorData),
        signedClientDataSha256: hex(sha256(withExtension.clientDataJSON)),
        signatureDerSha256: hex(sha256(withExtension.signature)), signatureVerifiedIndependently: true },
      limitation: 'The current wa-json134 profile excludes authenticator extensions. These controls do not claim that extension-bearing WebAuthn assertions are invalid in general.' } });
});
