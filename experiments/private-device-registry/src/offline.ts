// Executes the generated Compact circuits. No keys, proofs or node are used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CostModel, type CircuitResults } from '@midnight-ntwrk/compact-runtime';
import { Simulator, pure, cloneRows } from './simulator.js';
import { Device, fieldBytes, freshBytes } from './signing.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks: { name: string; passed: boolean }[] = [];
const transcripts: { operation: string; operations: number; sha256: string }[] = [];
const serialize = (value: unknown): string => JSON.stringify(value, (_, v) =>
  typeof v === 'bigint' ? { bigint: v.toString() } :
  v instanceof Uint8Array ? { bytes: Buffer.from(v).toString('hex') } : v);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(b);
const stateBytes = (sim: Simulator) => serialize(sim.state.state.encode());

async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false }); throw new Error(name, { cause: error }); }
}

async function refuses(sim: Simulator, action: () => Promise<unknown>, reason: RegExp) {
  const before = stateBytes(sim);
  await assert.rejects(action, reason);
  assert.equal(stateBytes(sim), before, 'refusal changed simulator state');
}

const signatureRefusal = /invalid signature|range error/;

// Aligned fields can trim zero bytes: match complete values with their trailing
// zero bytes removed, as well as full-width byte subsequences. This is a
// fixture detector, not a proof of zero-knowledge or of absence of all leaks.
function exposes(value: unknown, needle: Uint8Array): boolean {
  let end = needle.length;
  while (end > 0 && needle[end - 1] === 0) end--;
  const trimmed = needle.subarray(0, end);
  assert(trimmed.length >= 16, 'privacy fixture is too small for a useful scan');
  if (value instanceof Uint8Array) return Buffer.from(value).includes(Buffer.from(trimmed));
  if (typeof value === 'bigint') return same(fieldBytes(value), needle);
  if (Array.isArray(value)) return value.some(v => exposes(v, needle));
  if (value && typeof value === 'object') return Object.values(value).some(v => exposes(v, needle));
  return false;
}

function audit(result: CircuitResults<{}, []>, fixtures: Uint8Array[]) {
  const trace = result.context.callProofDataTrace.at(-1)!;
  assert(trace);
  const surfaces = {
    transcript: trace.publicTranscript,
    state: trace.finalQueryContext.state.state.encode(),
    effects: trace.finalQueryContext.effects,
    events: result.context.events,
  };
  for (const fixture of fixtures) {
    assert(!exposes(surfaces, fixture), 'private fixture exposed on public surfaces');
    assert(exposes({ injectedPublicValue: fixture }, fixture), 'vacuous disclosure scanner');
  }
  const replay = trace.initialQueryContext.runTranscript({
    program: trace.publicTranscript, gas: result.gasCost,
    effects: trace.finalQueryContext.effects,
  }, CostModel.initialCostModel());
  assert.deepEqual(replay.state.state.encode(), trace.finalQueryContext.state.state.encode());
  transcripts.push({ operation: trace.circuitId, operations: trace.publicTranscript.length,
    sha256: sha(serialize(trace.publicTranscript)) });
}

async function main() {
  const sim = await Simulator.create(false);
  const a = sim.owner, b = new Device(), c = new Device(), outsider = new Device();
  await check('dormant account refuses authorization', () => refuses(sim,
    () => sim.authorise(a), /not activated/));
  await check('bootstrap binds key, policy and initial private opening', async () => {
    for (const args of [
      [b.pk, a.policy, sim.bootSalt, sim.blind],
      [a.pk, b.policy, sim.bootSalt, sim.blind],
      [a.pk, a.policy, sim.bootSalt, freshBytes()],
    ]) await refuses(sim, () => sim.call('activate', ...args), /boot commitment mismatch/);
  });
  await check('activation installs one account-bound private credential', async () => {
    const r = await sim.call('activate', a.pk, a.policy, sim.bootSalt, sim.blind);
    assert.equal(sim.ledger().count, 1n);
    assert.deepEqual(sim.ledger().root, sim.root(sim.rows, sim.blind));
    assert.deepEqual(sim.ledger().boot, new Uint8Array(32));
    audit(r, [fieldBytes(a.pk.x), fieldBytes(a.pk.y), a.policy,
      sim.identity(a), sim.bootSalt, sim.blind]);
  });
  await check('bootstrap cannot be reused', () => refuses(sim,
    () => sim.call('activate', a.pk, a.policy, sim.bootSalt, sim.blind), /already activated/));
  await check('last credential cannot be removed', () => refuses(sim,
    () => sim.call('remove_device', ...sim.removeArgs(a, a).args), /cannot remove last device/));
  await check('enrolment adds precisely one independent key', async () => {
    const r = await sim.add(a, b);
    assert.equal(sim.ledger().count, 2n);
    assert.deepEqual(sim.ledger().root, sim.root(sim.rows, sim.blind));
    audit(r, [fieldBytes(a.pk.x), fieldBytes(b.pk.x), a.policy, b.policy,
      sim.identity(a), sim.identity(b), sim.blind]);
  });
  await check('after device use, different salt, policy and slot cannot re-register its key', async () => {
    await sim.authorise(b);
    for (const policy of [b.policy, freshBytes()]) {
      const rows = cloneRows(sim.rows);
      rows[7] = { active: true, identity: sim.identity(b), policy };
      await refuses(sim, () => sim.call('add_device', ...sim.addArgs(b, b, {
        rows, policy, blind: freshBytes(),
      }).args), /device already enrolled/);
    }
  });
  await check('unregistered key cannot authorize with a valid signature', () => refuses(sim,
    () => sim.authorise(outsider), /unknown device/));
  await check('policy label is authenticated by the committed record', () => refuses(sim,
    () => sim.call('authorise', sim.rows, sim.blind, sim.auth(b, freshBytes())), /unknown device/));
  await check('invalid signature is refused', async () => {
    const auth = sim.auth(a);
    auth.sig_s = (auth.sig_s + 1n);
    await refuses(sim, () => sim.call('authorise', sim.rows, sim.blind, auth), signatureRefusal);
  });
  await check('wrong root opening and altered roster cannot authorize', async () => {
    await refuses(sim, () => sim.call('authorise', sim.rows, freshBytes(), sim.auth(a)), /root opening mismatch/);
    const rows = cloneRows(sim.rows);
    rows[1].policy = freshBytes();
    await refuses(sim, () => sim.call('authorise', rows, sim.blind, sim.auth(a)), /root opening mismatch/);
  });
  await check('inactive slots have a single canonical representation', async () => {
    const rows = cloneRows(sim.rows);
    rows[7].identity = freshBytes();
    await refuses(sim, () => sim.call('authorise', rows, sim.blind, sim.auth(a)), /noncanonical inactive row/);
  });
  await check('malformed duplicate rows are rejected independently of their commitment', async () => {
    const rows = cloneRows(sim.rows);
    rows[7] = structuredClone(rows[1]);
    await refuses(sim, () => sim.call('authorise', rows, sim.blind, sim.auth(a)), /duplicate device identity/);
  });
  await check('two signers in different slots have identical public authorization transcripts', async () => {
    const initialState = sim.state;
    const rootBefore = sim.ledger().root;
    const authA = sim.auth(a), authB = sim.auth(b);
    const first = await sim.call('authorise', sim.rows, sim.blind, authA);
    const firstState = stateBytes(sim);
    sim.state = initialState;
    const second = await sim.call('authorise', sim.rows, sim.blind, authB);
    const t1 = first.context.callProofDataTrace.at(-1)!;
    const t2 = second.context.callProofDataTrace.at(-1)!;
    assert.deepEqual(t1.publicTranscript, t2.publicTranscript);
    assert.deepEqual(t1.finalQueryContext.effects, t2.finalQueryContext.effects);
    assert.equal(firstState, stateBytes(sim));
    assert.notDeepEqual(t1.input, t2.input);
    assert.deepEqual(sim.ledger().root, rootBefore);
    for (const [result, auth] of [[first, authA], [second, authB]] as const) {
      audit(result, [fieldBytes(a.pk.x), fieldBytes(b.pk.x), fieldBytes(auth.sig_r.x),
        fieldBytes(auth.sig_s), a.policy, b.policy, sim.identity(a), sim.identity(b), sim.blind]);
    }
  });
  await check('authorization is single-use despite an unchanged registry root', async () => {
    const auth = sim.auth(a);
    await sim.call('authorise', sim.rows, sim.blind, auth);
    await refuses(sim, () => sim.call('authorise', sim.rows, sim.blind, auth), signatureRefusal);
  });
  await check('enrolment cannot alter another credential or insert two keys', async () => {
    const change = sim.addArgs(a, c);
    const altered = cloneRows(change.rows); altered[1].policy = freshBytes();
    await refuses(sim, () => sim.call('add_device', ...sim.addArgs(a, c, { rows: altered }).args), /invalid insertion/);
    const two = cloneRows(change.rows);
    two[7] = { active: true, identity: sim.identity(outsider), policy: outsider.policy };
    await refuses(sim, () => sim.call('add_device', ...sim.addArgs(a, c, { rows: two }).args), /insert exactly one/);
  });
  await check('enrolment signature binds the proposed commitment and blinding', async () => {
    const change = sim.addArgs(a, c); change.args[3] = freshBytes();
    await refuses(sim, () => sim.call('add_device', ...change.args), signatureRefusal);
  });
  await check('identity key cannot be enrolled', async () => {
    const change = sim.addArgs(a, c); change.args[4] = { x: 0n, y: 1n };
    await refuses(sim, () => sim.call('add_device', ...change.args), /device key has small order/);
  });
  await check('authorising credential survives every selective removal', () => refuses(sim,
    () => sim.call('remove_device', ...sim.removeArgs(a, a).args), /cannot remove authorising device/));
  await check('unknown removal target is refused', () => refuses(sim,
    () => sim.call('remove_device', ...sim.removeArgs(a, outsider).args), /unknown removal target/));
  await check('removal cannot mutate the surviving record', async () => {
    const change = sim.removeArgs(a, b); change.rows[0].policy = freshBytes();
    await refuses(sim, () => sim.call('remove_device', ...sim.removeArgs(a, b, { rows: change.rows }).args), /invalid deletion/);
  });
  await check('removal signature binds its target and next commitment', async () => {
    const change = sim.removeArgs(a, b); change.args[3] = freshBytes();
    await refuses(sim, () => sim.call('remove_device', ...change.args), signatureRefusal);
  });
  const oldRows = cloneRows(sim.rows), oldBlind = sim.blind;
  await check('selective removal works after repeated target use without a counter', async () => {
    for (let i = 0; i < 4; i++) await sim.authorise(b);
    const r = await sim.remove(a, b);
    assert.equal(sim.ledger().count, 1n);
    audit(r, [fieldBytes(b.pk.x), sim.identity(b), oldBlind, sim.blind]);
    await refuses(sim, () => sim.authorise(b), /unknown device/);
    await sim.authorise(a);
  });
  await check('old roster cannot resurrect a revoked credential', () => refuses(sim,
    () => sim.call('authorise', oldRows, oldBlind, sim.auth(b)), /device count mismatch|root opening mismatch/));
  await check('remaining device needs refreshed private data after a registry change', () => refuses(sim,
    () => sim.call('authorise', oldRows, oldBlind, sim.auth(a)), /device count mismatch|root opening mismatch/));
  await check('fresh authorised re-enrolment is explicit and does not replay old approvals', async () => {
    const oldAuth = sim.auth(b);
    await sim.add(a, b);
    await refuses(sim, () => sim.call('authorise', sim.rows, sim.blind, oldAuth), signatureRefusal);
    await sim.authorise(b);
  });
  await check('account binding rejects a roster transplanted from another account', async () => {
    const other = await Simulator.create();
    await other.add(other.owner, b); // same public count, unrelated root/address
    await refuses(other, () => other.call('authorise', sim.rows, sim.blind, other.auth(b)), /root opening mismatch/);
    assert.notDeepEqual(sim.identity(b), other.identity(b));
  });
  await check('fresh root blinding changes the commitment for identical private records', () => {
    assert.notDeepEqual(sim.root(sim.rows, freshBytes()), sim.root(sim.rows, freshBytes()));
  });
  await check('diagnostic recovery requires its separate recovery signature', () => refuses(sim,
    () => sim.call('recover', ...sim.recoveryArgs(c, outsider).args), signatureRefusal));
  const beforeRecoveryRows = cloneRows(sim.rows), beforeRecoveryBlind = sim.blind;
  await check('diagnostic recovery replaces the whole registry without its old opening', async () => {
    const epoch = sim.ledger().epoch, nonce = sim.ledger().auth_nonce;
    const change = sim.recoveryArgs(c);
    // There is no old roster or opening among this circuit's six arguments.
    const r = await sim.call('recover', ...change.args);
    sim.rows = change.rows; sim.blind = change.blind;
    assert.equal(sim.ledger().count, 1n);
    assert.equal(sim.ledger().epoch, epoch + 1n);
    assert.equal(sim.ledger().auth_nonce, nonce + 1n);
    assert.deepEqual(sim.ledger().root, sim.root(sim.rows, sim.blind));
    audit(r, [fieldBytes(c.pk.x), c.policy, sim.identity(c), sim.blind]);
    for (const old of [a, b]) await refuses(sim, () => sim.authorise(old), /unknown device/);
    await sim.authorise(c);
    await refuses(sim, () => sim.call('recover', ...change.args), signatureRefusal);
  });
  await check('pre-recovery roster cannot authorize at the new epoch', () => refuses(sim,
    () => sim.call('authorise', beforeRecoveryRows, beforeRecoveryBlind, sim.auth(a)), /device count mismatch|root opening mismatch/));
  await check('capacity is bounded and overflow cannot overwrite a live record', async () => {
    const full = await Simulator.create();
    for (let i = 1; i < 8; i++) await full.add(full.owner, new Device());
    assert.equal(full.ledger().count, 8n);
    const target = new Device(), rows = cloneRows(full.rows);
    rows[7] = { active: true, identity: full.identity(target), policy: target.policy };
    await refuses(full, () => full.call('add_device', ...full.addArgs(full.owner, target, { rows }).args), /insert exactly one/);
    await full.authorise(full.owner);
  });
}

let failure: unknown;
try { await main(); } catch (error) { failure = error; console.error(error); process.exitCode = 1; }
const paths = ['contracts/registry.compact', 'src/signing.ts', 'src/simulator.ts', 'src/offline.ts',
  'package.json', 'package-lock.json', 'contracts/managed/registry/contract/index.js'];
const output = resolve(process.env.EVIDENCE_DIR ?? resolve(root, 'evidence'), 'offline.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({
  completed: !failure, runAt: new Date().toISOString(), node: process.version,
  scope: 'Compiled Compact simulator and public-VM transcript replay; no proof generation, proof verification or node submission. Disclosure fixture scans and paired transcripts are regression checks, not a proof of zero-knowledge.',
  capacity: 8, curve: 'JubJub only', checks, transcripts,
  sourceSha256: Object.fromEntries(paths.map(p => [p, sha(readFileSync(resolve(root, p)))])),
}, null, 2) + '\n');
console.log(`${checks.filter(c => c.passed).length}/${checks.length} checks passed; evidence: ${output}`);
