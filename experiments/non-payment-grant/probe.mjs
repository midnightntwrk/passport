import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as rt from '@midnight-ntwrk/compact-runtime';
import * as Account from './managed/account/contract/index.js';
import * as Registry from './managed/registry/contract/index.js';
import { blockHash, blockTime, deploy, proveAndApply } from './ledger.mjs';

const deployments = new Map();
const coinPublicKey = '00'.repeat(32);
const expiresAt = BigInt(blockTime + 3600);
const crossContract = {
  stateProvider: { getContractState: async (_, address) => deployments.get(address)?.state },
  moduleProvider: { resolve: address => {
    const target = deployments.get(address);
    return target && (async () => target.module);
  } },
};

async function instantiate(directory, module, ...args) {
  const contract = new module.Contract({});
  const init = await contract.initialState(rt.createConstructorContext(undefined, coinPublicKey), ...args);
  const state = init.currentContractState;
  for (const circuit of Object.keys(module.expectedVk)) {
    const key = await readFile(new URL(`./managed/${directory}/keys/${circuit}.verifier`, import.meta.url));
    const op = state.operation(circuit);
    op.verifierKey = key;
    state.setOperation(circuit, op);
  }
  const address = deploy(state);
  const target = { directory, address, ref: { bytes: rt.encodeContractAddress(address) }, module, contract, state };
  deployments.set(address, target);
  return target;
}

// The runtime resolves the real callee and derives its caller from the call tree.
// Publish the resulting state snapshots only after the entire root circuit returns.
function circuitContext(target, circuitId) {
  return rt.createCircuitContext({
    circuitId, contractAddress: target.address, contractState: target.state,
    coinPublicKeyOrZswapState: coinPublicKey, privateState: undefined,
    crossContract, parentBlockHash: blockHash, time: blockTime,
  });
}
async function call(target, circuitId, ...args) {
  const { context } = await target.contract.circuits[circuitId](circuitContext(target, circuitId), ...args);
  const applied = await proveAndApply(context.callProofDataTrace, deployments);
  for (const [address, query] of Object.entries(context.queryContexts)) {
    const touched = deployments.get(address);
    touched.state = rt.ContractState.deserialize(applied.get(address));
    assert.deepEqual({ ...touched.module.ledger(touched.state.data) }, { ...touched.module.ledger(query.state) });
  }
  console.error(`Ledger verified and applied: ${context.callProofDataTrace.map(f => f.circuitId).join(', ')}`);
  return context.callProofDataTrace;
}

const holder = randomBytes(32);
const grantee = rt.sampleJubjubSchnorrSk();
const granteeKey = rt.jubjubSchnorrVerifyingKey(grantee);
const name = new Uint8Array(randomBytes(32));
const next = new Uint8Array(randomBytes(32));
const operation = Registry.pureCircuits.operation();
const account = await instantiate('account', Account, Account.pureCircuits.owner_commitment(holder));
const registry = await instantiate('registry', Registry, account.ref, name);
const other = await instantiate('registry', Registry, account.ref, name);
const grant = () => Account.ledger(account.state.data);
const resolver = () => Registry.ledger(registry.state.data).resolver;
const messageType = new rt.CompactTypeVector(1, rt.CompactTypeField);
function sign({ key = grantee, target = registry, accountRef = account.ref, value = next } = {}) {
  const digest = Registry.pureCircuits.arguments_hash(name, value);
  const message = Account.pureCircuits.challenge(
    accountRef, target.ref, operation, digest, grant().issuance, grant().nonce);
  const { announcement, response } = rt.jubjubSchnorrSign(messageType, [message], key);
  return [announcement.x, announcement.y, response];
}
const issue = (permission = operation, expiry = expiresAt) =>
  call(account, 'issue', holder, granteeKey, registry.ref, permission, expiry);
const update = (signature, target = registry, value = next) =>
  call(target, 'set_resolver', name, value, ...signature);

const checks = [];
async function rejected(label, action, error) {
  const before = Array.from(deployments.values(), target => target.state.serialize());
  await assert.rejects(action, error, label);
  assert.deepEqual(Array.from(deployments.values(), target => target.state.serialize()), before);
  checks.push(label);
}

await rejected('only the holder may issue', () =>
  call(account, 'issue', randomBytes(32), granteeKey, registry.ref, operation, expiresAt), /owner required/);
await issue();
const signature = sign();
const digest = Registry.pureCircuits.arguments_hash(name, next);
await rejected('direct call has no contract caller', () =>
  call(account, 'assert_grant_authorizes', operation, digest, ...signature), /contract caller required/);
await rejected('user-address caller (runtime context control)', async () => {
  const ctx = circuitContext(account, 'assert_grant_authorizes');
  const query = ctx.callContext.currentQueryContext;
  query.block = { ...query.block, caller: { tag: 'user', address: '42'.repeat(32) } };
  assert.equal(query.block.caller.tag, 'user');
  await account.contract.circuits.assert_grant_authorizes(ctx, operation, digest, ...signature);
}, /contract caller required/);
await rejected('different registry even with its own signed request', () =>
  update(sign({ target: other }), other), /wrong contract caller/);
await rejected('wrong grantee', () => update(sign({ key: rt.sampleJubjubSchnorrSk() })), /invalid grant signature/);
await rejected('signature for another account', () =>
  update(sign({ accountRef: other.ref })), /invalid grant signature/);
await rejected('changed resolver', () => update(signature, registry, randomBytes(32)), /invalid grant signature/);
await rejected('unknown name', () =>
  call(registry, 'set_resolver', randomBytes(32), next, ...signature), /unknown name/);

const trace = await update(signature);
assert.deepEqual(trace.map(frame => [frame.contractAddress, frame.circuitId]), [
  [account.address, 'assert_grant_authorizes'], [registry.address, 'set_resolver'],
]);
assert.deepEqual(trace[0].initialQueryContext.block.caller, { tag: 'contract', address: registry.address });
assert.ok(trace[0].commCommData);
assert.equal(trace[1].commCommData, undefined);
assert.equal(account.state.balance.size, 0);
assert.equal(registry.state.balance.size, 0);
assert.equal(grant().nonce, 1n);
assert.deepEqual(resolver(), next);
checks.push('signed update changes resolver and consumes one nonce');
await rejected('replay', () => update(signature), /invalid grant signature/);

const oldIssuance = grant().issuance;
await issue();
assert.equal(grant().issuance, oldIssuance + 1n);
assert.equal(grant().nonce, 0n);
await rejected('signature from prior issuance at same nonce', () => update(signature), /invalid grant signature/);
await issue(new Uint8Array(32));
await rejected('action outside grant scope', () => update(sign()), /wrong permission/);
await issue(operation, BigInt(blockTime - 60));
await rejected('expired grant', () => update(sign()), /expired grant/);
await issue();
const beforeRevocation = sign();
await call(account, 'revoke', holder);
await rejected('revoked grant', () => update(beforeRevocation), /inactive grant/);

await call(account, 'issue', holder, granteeKey, other.ref, operation, expiresAt);
const secondResolver = new Uint8Array(randomBytes(32));
await update(sign({ target: other, value: secondResolver }), other, secondResolver);
assert.deepEqual(Registry.ledger(other.state.data).resolver, secondResolver);
assert.deepEqual(resolver(), next);
checks.push('second registry uses the same API with its own grant');

console.log(`Passed ${checks.length} grant checks.`);
