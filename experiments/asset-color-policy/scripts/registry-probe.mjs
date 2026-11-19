import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as rt from '@midnight-ntwrk/compact-runtime';
import * as Policy from '../contracts/managed/Policy/contract/index.js';
import * as Alternate from '../contracts/managed/PolicyAlternate/contract/index.js';
import * as Registry from '../contracts/managed/Registry/contract/index.js';
import * as Dispatch from '../contracts/managed/Dispatch/contract/index.js';

const b = n => new Uint8Array(32).fill(n);
const address = n => Buffer.from(b(n)).toString('hex');
const reference = n => ({ bytes: b(n) });
const key = b(41), admin = b(42);
const hash = x => new Uint8Array(createHash('sha256').update(x).digest());
const states = new Map(), modules = new Map(), instances = new Map();
const records = [];
const DISPATCH = 1, REGISTRY = 2, FIRST = 3, SECOND = 4, DISABLED = 5;
async function deploy(n, module, name, args) {
  const instance = new module.Contract({});
  const state = (await instance.initialState(rt.createConstructorContext({}, address(90)), ...args)).currentContractState;
  for (const id of state.operations()) {
    const operation = new rt.ContractOperation();
    operation.verifierKey = readFileSync(new URL(`../contracts/managed/${name}/keys/${id}.verifier`, import.meta.url));
    state.setOperation(id, operation);
  }
  states.set(address(n), state); modules.set(address(n), module); instances.set(n, instance);
}
async function call(n, circuitId, args) {
  const context = rt.createCircuitContext({ circuitId, contractAddress: address(n),
    coinPublicKeyOrZswapState: address(90), contractState: states.get(address(n)), privateState: {},
    parentBlockHash: 'de'.repeat(32), time: 1800000000,
    crossContract: {
      stateProvider: { getContractState: async (_, a) => states.get(a) },
      moduleProvider: { resolve: a => modules.has(a) ? async () => modules.get(a) : undefined },
    } });
  const res = await instances.get(n).circuits[circuitId](context, ...args);
  for (const [a, q] of Object.entries(res.context.queryContexts)) states.get(a).data = new rt.ChargedState(q.state.state);
  return res;
}
const dispatch = (asset = key) => call(DISPATCH, 'check', [asset]);
const rebind = (n, secret = admin) => call(REGISTRY, 'rebind', [key, reference(n), secret]);
const trace = res => res.context.callProofDataTrace.map(t => ({ circuit: t.circuitId, address: t.contractAddress }));
async function test(name, run) {
  try { records.push({ name, pass: true, detail: await run() }); console.log(`PASS registry: ${name}`); }
  catch (e) { records.push({ name, pass: false, error: String(e.stack ?? e) }); console.error(`FAIL registry: ${name}: ${e.message}`); }
}

await deploy(FIRST, Policy, 'Policy', [key, false, hash(admin)]);
await deploy(SECOND, Alternate, 'PolicyAlternate', [key, true]);
await deploy(DISABLED, Alternate, 'PolicyAlternate', [key, false]);
await deploy(REGISTRY, Registry, 'Registry', [key, reference(FIRST), hash(admin)]);
await deploy(DISPATCH, Dispatch, 'Dispatch', [reference(REGISTRY)]);
const callerKeys = JSON.stringify(Dispatch.expectedVk);
let prepared;
await test('resolve and call first policy, with real deployed verifier keys', async () => {
  prepared = await dispatch();
  assert.deepEqual(trace(prepared).map(t => t.address), [address(REGISTRY), address(FIRST), address(DISPATCH)]);
  return trace(prepared);
});
await test('registry rebind selects different implementation without recompiling caller', async () => {
  assert.notEqual(Policy.expectedVk.check, Alternate.expectedVk.check);
  await rebind(SECOND);
  const res = await dispatch();
  assert.deepEqual(trace(res).map(t => t.address), [address(REGISTRY), address(SECOND), address(DISPATCH)]);
  assert.equal(JSON.stringify(Dispatch.expectedVk), callerKeys);
  return { trace: trace(res), distinctPolicyVerifierKeys: true, unchangedCallerKeys: true };
});
await test('stale registry transcript rejects after a mapping update in VM replay', async () => {
  assert(prepared, 'first dispatch must have succeeded');
  const t = prepared.context.callProofDataTrace.find(t => t.contractAddress === address(REGISTRY));
  const transaction = { program: t.publicTranscript, effects: t.finalQueryContext.effects,
    gas: prepared.context.gasCosts[address(REGISTRY)] };
  t.initialQueryContext.runTranscript(transaction, prepared.context.costModel); // positive control
  const changed = new rt.QueryContext(states.get(address(REGISTRY)).data, address(REGISTRY));
  changed.block = t.initialQueryContext.block;
  let error;
  try { changed.runTranscript(transaction, prepared.context.costModel); } catch (e) { error = String(e); }
  assert.match(error ?? '', /mismatch/);
  return { stage: 'VM verification, not node submission', error };
});
await test('unauthorized registry rebind rejected', async () => {
  await assert.rejects(() => rebind(FIRST, b(99)), /invalid registry admin/);
  assert.equal(trace(await dispatch())[1].address, address(SECOND));
});
await test('new implementation can deny', async () => {
  await rebind(DISABLED);
  try { await assert.rejects(dispatch, /alternate policy disabled/); }
  finally { await rebind(SECOND); }
});
await test('unregistered color rejects', async () => {
  await assert.rejects(() => dispatch(b(99)), /registry has no policy/);
});
await test('missing module rejects', async () => {
  modules.delete(address(SECOND));
  try { await assert.rejects(dispatch, /module|binding|resolve/i); }
  finally { modules.set(address(SECOND), Alternate); }
});
await test('missing deployed policy state rejects', async () => {
  const state = states.get(address(SECOND)); states.delete(address(SECOND));
  try { await assert.rejects(dispatch, /contract state|state.*callee|state.*found/i); }
  finally { states.set(address(SECOND), state); }
});
await test('module supplied for wrong implementation rejects against deployed keys', async () => {
  modules.set(address(SECOND), Policy);
  try { await assert.rejects(dispatch, /key|fingerprint|implementation/i); }
  finally { modules.set(address(SECOND), Alternate); }
});
await test('module not implementing Policy interface rejects', async () => {
  modules.set(address(SECOND), Registry);
  try { await assert.rejects(dispatch, /interface|circuit|implement/i); }
  finally { modules.set(address(SECOND), Alternate); }
});
writeFileSync(new URL('../evidence/registry.json', import.meta.url), JSON.stringify({ compiler: '0.35.0', runtime: '0.20.0',
  stage: 'coinless dispatch probe, real callee keys, local execution and VM replay; no ACC integration or node submission',
  passed: records.filter(r => r.pass).length, failed: records.filter(r => !r.pass).length, tests: records }, null, 2) + '\n');
if (records.some(r => !r.pass)) process.exitCode = 1;
