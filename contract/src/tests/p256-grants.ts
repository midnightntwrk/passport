// A P-256 grantee spends real non-native unshielded assets on a node.
// The OpenSSL fixture is an independent software test authenticator, not a
// claim of browser/PRF coverage. Faults bypass the WebAuthn client adapter
// and target the deployed circuit through the low-level account interface.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setupWallet, compiledAccountContract, deployFaucet } from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { CustodyAccount } from '../wallet/account.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import {
  originHash, spendScope, readOnlyScope, openingOf, RECIPIENT_USER_ADDRESS,
  type GrantOpening, type PlainScope,
} from '../wallet/signer.js';
import { p256Challenges, p256GrantChallenges, type P256GrantAuthorisation } from '../wallet/signer-p256.js';
import { parseES256Signature } from '../wallet/webauthn.js';
import { pureCircuits } from '../wallet/contract.js';
import { queryTxPosition } from '../wallet/capture.js';
import { runScenario, step, sleep } from './runner.js';
import { writeEvidence } from './evidence.js';
import { softwarePasskey, sha256, TEST_ORIGIN } from './p256-fixtures.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const captureProvenance = () => Object.fromEntries([
  './p256-grants.ts', './p256-fixtures.ts', '../wallet/account.ts', '../wallet/signer.ts',
  '../wallet/signer-p256.ts', '../wallet/webauthn.ts', '../../package-lock.json',
  '../../contracts/account.compact', '../../contracts/account-p256.compact', '../../contracts/webauthn.compact',
  '../../contracts/managed/account/contract/index.js', '../../contracts/managed/account/compiler/contract-manifest.json',
  ...['activate_initial_device_with_p256', 'deposit_unshielded', 'issue_grant_with_p256',
    'revoke_grant_with_p256', 'rotate_enc_key_with_p256', 'withdraw_unshielded_with_grant_p256']
    .flatMap(name => [`../../contracts/managed/account/zkir/${name}.bzkir`,
      `../../contracts/managed/account/keys/${name}.verifier`]),
  '../../contracts/managed/faucet/contract/index.js',
  '../../contracts/managed/faucet/compiler/contract-manifest.json',
].map(relative => {
  const bytes = readFileSync(new URL(relative, import.meta.url));
  return [relative, { bytes: bytes.length, sha256: hex(sha256(bytes)) }];
}));

await runScenario('P-256 scoped-grant spends on node', async () => {
  const provenance = captureProvenance();
  const ctx = await setupWallet();
  const transactions: { label: string; txId: string; blockHeight?: number; status?: string }[] = [];
  const negatives: { label: string; stage: string; message: string; stateHash: string }[] = [];
  let proofCalls = 0, submitCalls = 0;
  const prove = ctx.providers.proofProvider.proveTx.bind(ctx.providers.proofProvider);
  ctx.providers.proofProvider.proveTx = async (...args: any[]) => {
    proofCalls++;
    return prove(...args);
  };
  const submit = ctx.providers.midnightProvider.submitTx.bind(ctx.providers.midnightProvider);
  ctx.providers.midnightProvider.submitTx = async (...args: any[]) => {
    submitCalls++;
    return submit(...args);
  };
  const record = async (label: string, result: { txId: string }) => {
    const position = await queryTxPosition(result.txId);
    assert.equal(position.error, undefined);
    assert.equal(position.status, 'SUCCESS');
    transactions.push({ label, txId: result.txId, blockHeight: position.blockHeight, status: position.status });
    console.log(`  accepted ${label}: ${result.txId}`);
  };

  step('deploy passkey-owned v3 account; fund a real unshielded balance');
  const owner = softwarePasskey(), delegate = softwarePasskey();
  const account = await CustodyAccount.deploy(ctx.providers, compiledAccountContract(), owner.device, generateEncKeyPair());
  assert.equal((await account.ledgerState()).spec_version, 3n);
  const snapshot = async () => {
    const state = await ctx.providers.publicDataProvider.queryContractState(account.address);
    assert.ok(state);
    return new Uint8Array(state.serialize());
  };
  const reject = async (label: string, run: () => Promise<unknown>, expected: RegExp) => {
    const before = await snapshot(), proofsBefore = proofCalls, submitsBefore = submitCalls;
    let message = '';
    await assert.rejects(run, error => {
      message = String(error);
      assert.match(message, expected);
      return true;
    });
    assert.equal(proofCalls, proofsBefore, `${label} reached the prover`);
    assert.equal(submitCalls, submitsBefore, `${label} reached submission`);
    assert.deepEqual(await snapshot(), before, `${label} changed chain state`);
    negatives.push({ label, stage: 'circuit-build', message, stateHash: hex(sha256(before)) });
    console.log(`  rejected ${label}: ${message.slice(0, 160)}`);
  };
  const faucet = await deployFaucet(ctx.walletCtx);
  const domain = rnd(), recipient = userAddressBytes(ctx.walletCtx);
  const color = await faucet.unshieldedColor(domain);
  await record('mint 100 non-native units', { txId: await faucet.mintUnshielded(domain, 100n, recipient) });
  await sleep(15_000); // Allow the wallet to index the minted unshielded coin.
  await record('deposit 100 units', await account.depositUnshielded(color, 100n));
  assert.equal((await account.ledgerState()).unshielded_balances.lookup(color), 100n);

  const origin = originHash(TEST_ORIGIN);
  const id = delegate.grantee.grantId(account.addressBytes, origin, 0n);
  const scope = spendScope({ expiresAt: 0n, withdrawUnshielded: true, color, cap: 12n, perCallCap: 10n,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient, rpIdHash: delegate.policy.rp_id_hash });
  let salt = rnd(), opening = openingOf(scope, salt, origin, 0n);
  await record('P-256 owner issues P-256 spend grant', await account.issueGrant(owner.device, id, scope, salt));
  const originalRecord = await account.grantRecord(id);
  assert.ok(originalRecord);
  const ownerCounter = await account.resolveUseCounter(owner.device);
  const ownerEntry = owner.device.entryAt(account.addressBytes, (await account.ledgerState()).device_epoch, ownerCounter);
  const originalDeviceNonce = (await account.ledgerState()).auth_nonce;
  const sign = async (amount = 5n, grantId = id) => {
    const challenge = p256GrantChallenges.withdrawUnshielded(await account.grantContext(grantId), delegate.pk, color, amount, recipient);
    return { challenge, auth: await delegate.grantee.sign(challenge) };
  };
  const spend = (auth: P256GrantAuthorisation, o = opening, amount = 5n,
    spendColor = color, to = recipient) => account.withdrawUnshieldedWithGrantAuth(spendColor, amount, to, o, auth);
  const first = await sign();

  step('circuit rejects altered origin, RP, profile, signature, and scope');
  await reject('origin opening mismatch', () => spend(first.auth, { ...opening, originHash: rnd() }), /grant origin mismatch/);
  await reject('RP commitment mismatch', () => spend({ ...first.auth,
    policy: { ...first.auth.policy, rp_id_hash: rnd() } }), /grant RP mismatch/);
  const badRpData = new Uint8Array(first.auth.authenticator_data);
  badRpData.set(rnd(), 0);
  await reject('signed envelope RP differs from policy', () => spend({ ...first.auth,
    authenticator_data: badRpData }), /WebAuthn RP mismatch/);
  const wrongOrigin = new TextEncoder().encode('http://localhost:8974');
  await reject('policy origin mismatch', () => spend({ ...first.auth,
    policy: { ...first.auth.policy, origin: wrongOrigin } }), /grant origin mismatch/);
  // This is a valid ES256 assertion over JSON outside the fixed wa-json134
  // profile. Omit the client adapter and pass its real signature directly.
  const extraJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get',
    challenge: Buffer.from(first.challenge).toString('base64url'), origin: TEST_ORIGIN,
    crossOrigin: false, tokenBinding: { status: 'supported' } }));
  const extraAssertion = await delegate.assertion(first.challenge, { clientDataJSON: extraJSON });
  await reject('valid ES256 assertion outside wa-json134', () => spend({ ...first.auth,
    authenticator_data: extraAssertion.authenticatorData, sig: parseES256Signature(extraAssertion.signature) }), /invalid grant signature/);
  await reject('modified signature scalar', () => spend({ ...first.auth,
    sig: { ...first.auth.sig, s: 1n } }), /invalid grant signature/);
  await reject('modified signed amount', () => spend(first.auth, opening, 6n), /invalid grant signature/);
  await reject('amount above per-call cap', () => spend(first.auth, opening, 11n), /amount above per-call cap/);
  await reject('different token color', () => spend(first.auth, opening, 5n, rnd()), /scope object mismatch/);
  await reject('recipient outside pin', () => spend(first.auth, opening, 5n, color, rnd()), /recipient not admitted by pin/);

  step('accepted spend, nonce replay rejection, and owner-signature independence');
  const nextEnc = rnd();
  const pendingOwner = await owner.device.sign(
    p256Challenges.rotateEncKey(await account.callContext(), owner.pk, nextEnc), ownerCounter);
  await record('P-256 grantee spends 5 units', await spend(first.auth));
  opening = { ...opening, spentPrev: 5n };
  let ledger = await account.ledgerState();
  assert.equal(ledger.unshielded_balances.lookup(color), 95n);
  assert.equal(ledger.grants.lookup(id).nonce, 1n);
  assert.deepEqual(ledger.grants.lookup(id).spent_commit, pureCircuits.derive_grant_spent_commit(salt, 5n));
  assert.equal(ledger.auth_nonce, originalDeviceNonce);
  assert.ok(ledger.devices.member(ownerEntry));
  await reject('replay with current spent opening', () => spend(first.auth), /invalid grant signature/);
  await record('pre-grant owner signature still executes', await account.rotateEncKeyWithAuth(nextEnc, pendingOwner));
  const second = await sign();
  await record('P-256 grantee spends next 5 units', await spend(second.auth));
  opening = { ...opening, spentPrev: 10n };
  ledger = await account.ledgerState();
  assert.equal(ledger.unshielded_balances.lookup(color), 90n);
  assert.equal(ledger.grants.lookup(id).nonce, 2n);
  const overCap = await sign(3n);
  await reject('cumulative cap exceeded with a valid signature', () => spend(overCap.auth, opening, 3n), /cumulative cap exceeded/);

  step('revocation and re-issuance bind distinct incarnations of the same grant');
  const beforeRevocation = await sign(1n);
  await record('P-256 owner revokes grant', await account.revokeGrant(owner.device, id));
  await reject('revoked grant with pre-revocation signature', () => spend(beforeRevocation.auth, opening, 1n), /grant revoked/);
  salt = rnd();
  await record('P-256 owner reissues same grant id', await account.issueGrant(owner.device, id, scope, salt));
  opening = openingOf(scope, salt, origin, 0n);
  const reissued = await account.grantRecord(id);
  assert.ok(reissued);
  assert.notEqual(reissued.issued_at, originalRecord.issued_at);
  assert.equal(reissued.nonce, 0n);
  // The original signature also had nonce zero; use the NEW commitment
  // opening so this tests issued_at binding rather than an obsolete salt.
  await reject('original nonce-zero signature under reissued grant', () => spend(first.auth), /invalid grant signature/);
  const fresh = await sign();
  await record('fresh reissued grant spends 5 units', await spend(fresh.auth));
  assert.equal((await account.ledgerState()).unshielded_balances.lookup(color), 85n);

  step('read-only and caller-restricted grants do not admit a root spend');
  const restricted = async (slot: bigint, restrictedScope: PlainScope, label: string, expected: RegExp) => {
    const restrictedId = delegate.grantee.grantId(account.addressBytes, origin, slot), restrictedSalt = rnd();
    await record(`issue ${label}`, await account.issueGrant(owner.device, restrictedId, restrictedScope, restrictedSalt));
    const material = await sign(5n, restrictedId);
    const restrictedOpening: GrantOpening = openingOf(restrictedScope, restrictedSalt, origin, slot);
    await reject(label, () => spend(material.auth, restrictedOpening), expected);
    assert.equal((await account.grantRecord(restrictedId))!.nonce, 0n);
  };
  await restricted(1n, readOnlyScope({ expiresAt: 0n, readPkHash: rnd(), rpIdHash: delegate.policy.rp_id_hash }),
    'read-only grant cannot spend', /operation not in scope/);
  await restricted(2n, { ...scope, caller: rnd() }, 'caller-restricted grant rejects root call', /grant requires a contract caller/);

  assert.deepEqual(captureProvenance(), provenance, 'sources or artifacts changed during the conformance run');
  writeEvidence({ testId: 'p256-grants', name: 'conformance', fileName: 'p256-grants-conformance.json', verdict: 'PASS',
    description: 'P-256 wa-json134 owner and grantee: real unshielded spends, grant restrictions, freshness, and revocation',
    note: 'Accepted operations proved and included on node. Negative cases bypass the client WebAuthn adapter and fail during circuit build, with zero prover/submission calls and byte-identical contract state. OpenSSL software authenticator; no browser or PRF ceremony claim.',
    details: { account: account.address, schema: 3, profile: 'wa-json134', transactions, negatives, provenance,
      finalBalance: (await account.ledgerState()).unshielded_balances.lookup(color),
      originalIssuedAt: originalRecord.issued_at, reissuedAt: reissued.issued_at,
      limitations: ['Non-native unshielded assets only; no P-256 shielded grant spend in this suite.',
        'Caller restriction has a root-rejection control; a successful forwarded P-256 call is not exercised.',
        'Rejection controls execute the real circuit against indexed state, but are not submitted invalid proofs.'] } });
});
