// Caller values are injected only into the local simulator. On-node tests
// separately establish the runtime/ledger boundary using actual call trees.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { createCallContext, createCircuitContext, type PublicAddress } from '@midnight-ntwrk/compact-runtime';
import { AccountSim } from './sim.js';
import { pureCircuits } from '../wallet/contract.js';
import {
  JubjubDevice, JubjubGrantee, K256Grantee, jubjubChallenges, jubjubGrantChallenges,
  k256GrantChallenges, scopeArgs, scopeDigest, spendScope, readOnlyScope, originHash,
  openingOf, grantAuthArgs, authArgs, assertIssueRules,
} from '../wallet/signer.js';
import { withCoin } from '../wallet/witnesses.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const pinned = rnd(), wrong = rnd();
const contractCaller = (bytes: Uint8Array): PublicAddress => ({ tag: 'contract', address: hex(bytes) });
const goodCaller = contractCaller(pinned);
const badCallers = [undefined, { tag: 'user', address: hex(pinned) } as PublicAddress, contractCaller(wrong)];
const sim = await AccountSim.create({ initialRecoveryPk: JubjubDevice.generate().pk, initialWrap: rnd(64), vetoWindowSeconds: 60n });
assert.equal(sim.ledger().spec_version, 3n);

async function invoke(caller: PublicAddress | undefined, circuit: string, args: unknown[]) {
  const ctx = createCircuitContext({ circuitId: circuit, contractAddress: sim.addressHex,
    coinPublicKeyOrZswapState: sim.coinPk, contractState: sim.state, privateState: sim.privateState, time: sim.now });
  ctx.callContext = createCallContext(circuit, sim.addressHex, sim.coinPk, sim.state, sim.privateState, sim.now, undefined, caller);
  ctx.queryContexts[sim.addressHex] = ctx.callContext.currentQueryContext;
  const result = await sim.contract.provableCircuits[circuit](ctx, ...args);
  sim.state = result.context.callContext.currentQueryContext.state;
  sim.privateState = result.context.callContext.currentPrivateState;
  return result.context.callProofDataTrace.at(-1).publicTranscript;
}

const color = rnd(), recipient = rnd(), origin = originHash('https://bank.example');
await sim.call('deposit_unshielded', color, 100n);
const base = { withdrawUnshielded: true, color, cap: 20n, perCallCap: 10n };
const scope = spendScope({ ...base, caller: pinned });
const salt = rnd();
const noCaller = { is_some: false, value: { bytes: new Uint8Array(32) } };
assert.deepEqual(pureCircuits.derive_grant_caller_commit(salt, noCaller), new Uint8Array(32));
assert.throws(() => pureCircuits.derive_grant_caller_commit(salt, { ...noCaller, value: { bytes: pinned } }), /noncanonical/);
assert.notDeepEqual(scopeDigest(salt, scope), scopeDigest(salt, spendScope(base)));
assert.notDeepEqual(scopeDigest(salt, scope), scopeDigest(salt, spendScope({ ...base, caller: wrong })));
assert.throws(() => assertIssueRules({ ...readOnlyScope({ readPkHash: rnd() }), caller: pinned }), /read-only/);
assert.throws(() => spendScope({ ...base, caller: rnd(31) }), /32-byte/);

for (const grantee of [JubjubGrantee.generate(), K256Grantee.generate()]) {
  const id = grantee.grantId(sim.address, origin, 0n);
  const issue = (s = scope) => sim.authorised('issue_grant',
    (c, d) => jubjubChallenges.issueGrant(c, d.pk, id, scopeDigest(salt, s)), [id, ...scopeArgs(s), salt]);
  // An owner signature for unrestricted scope cannot approve a pin (or vice versa).
  const tampered = sim.device.sign(jubjubChallenges.issueGrant(sim.callContext(), sim.device.pk, id,
    scopeDigest(salt, spendScope(base))), sim.ledger().auth_nonce);
  await assert.rejects(() => sim.call('issue_grant_with_jubjub', id, ...scopeArgs(scope), salt, ...authArgs(tampered)));
  await assert.rejects(() => issue({ ...readOnlyScope({ readPkHash: rnd() }), caller: pinned }), /read-only/);
  await issue();
  assert.deepEqual(sim.ledger().grants.lookup(id).scope.caller_commit,
    pureCircuits.derive_grant_caller_commit(salt, { is_some: true, value: { bytes: pinned } }));
  const opening = openingOf(scope, salt, origin, 0n);
  const g = sim.ledger().grants.lookup(id);
  const context = { contractAddress: sim.address, grantId: id, issuedAt: g.issued_at, grantNonce: g.nonce };
  const auth = grantee.arm === 'jubjub'
    ? grantee.sign(jubjubGrantChallenges.withdrawUnshielded(context, grantee.pk, color, 5n, recipient))
    : grantee.sign(k256GrantChallenges.withdrawUnshielded(context, grantee.pk, color, 5n, recipient));
  const circuit = `withdraw_unshielded_with_grant_${grantee.arm}`;
  const args = [color, 5n, { bytes: recipient }, ...grantAuthArgs(opening, auth)];
  for (const caller of badCallers) {
    await assert.rejects(() => invoke(caller, circuit, args), /grant (requires a contract caller|caller mismatch)/);
    assert.equal(sim.ledger().grants.lookup(id).nonce, 0n);
  }
  const damaged = auth.arm === 'jubjub' ? { ...auth, sig_s: auth.sig_s + 1n }
    : { ...auth, sig: { ...auth.sig, s: 1n } };
  await assert.rejects(() => invoke(goodCaller, circuit, [color, 5n, { bytes: recipient }, ...grantAuthArgs(opening, damaged)]), /signature/);
  await invoke(goodCaller, circuit, args);
  assert.equal(sim.ledger().grants.lookup(id).nonce, 1n);
  await assert.rejects(() => invoke(goodCaller, circuit,
    [color, 5n, { bytes: recipient }, ...grantAuthArgs({ ...opening, spentPrev: 5n }, auth)]));
  await sim.authorised('revoke_grant', (c, d) => jubjubChallenges.revokeGrant(c, d.pk, id), [id]);
  await issue(spendScope(base));
  // Unrestricted calls execute with none, a user address, or any contract.
  // Their transcript must be caller-independent (no context read).
  const unrestricted = sim.ledger().grants.lookup(id);
  const uc = { ...context, issuedAt: unrestricted.issued_at, grantNonce: 0n };
  const ua = grantee.arm === 'jubjub'
    ? grantee.sign(jubjubGrantChallenges.withdrawUnshielded(uc, grantee.pk, color, 1n, recipient))
    : grantee.sign(k256GrantChallenges.withdrawUnshielded(uc, grantee.pk, color, 1n, recipient));
  const before = sim.state;
  const transcripts = [];
  for (const caller of [...badCallers, goodCaller]) {
    sim.state = before;
    transcripts.push(await invoke(caller, circuit, [color, 1n, { bytes: recipient }, ...grantAuthArgs(opening, ua)]));
  }
  for (const transcript of transcripts) assert.deepEqual(transcript, transcripts[0]);

  // The shared caller gate also dominates both shielded custody chips.
  const shieldScope = spendScope({ ...base, withdrawShielded: true, withdrawShieldedToContract: true, readPkHash: rnd(), caller: pinned });
  await sim.authorised('revoke_grant', (c, d) => jubjubChallenges.revokeGrant(c, d.pk, id), [id]);
  await issue(shieldScope);
  const coin = { nonce: rnd(), color, value: 10n, mt_index: 0n };
  sim.privateState = withCoin(sim.privateState, { ...coin, mtIndex: coin.mt_index });
  for (const name of ['withdraw_shielded', 'withdraw_shielded_to_contract']) {
    await assert.rejects(() => invoke(contractCaller(wrong), `${name}_with_grant_${grantee.arm}`,
      [{ bytes: recipient }, color, 5n, rnd(192), sim.ledger().enc_key, ...grantAuthArgs(opening, auth)]), /grant caller mismatch/);
  }
}
console.log('PASS caller scope: both arms, all six spend gates, contract/user/absent callers, signed policy, replay and unrestricted transcript independence');
