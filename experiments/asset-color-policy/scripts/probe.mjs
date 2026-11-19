import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as Policy from '../contracts/managed/Policy/contract/index.js';

const b = n => new Uint8Array(32).fill(n);
const hex = x => Buffer.from(x).toString('hex');
const hash = (...parts) => new Uint8Array(createHash('sha256').update(Buffer.concat(parts)).digest());
const pad = s => { const x = b(0); x.set(Buffer.from(s)); return x; };
const le = bytes => BigInt('0x' + Buffer.from(bytes).reverse().toString('hex'));
const R = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
const COLOR = b(41), FREE = b(42), UNKNOWN = b(43), SALT = b(44), ADMIN = b(45);
const RECIPIENT = { bytes: b(46) }, ENC = b(47), NONCE = b(48);
const tag = color => hash(pad('passport:policy-tag:v1'), SALT, color);
const ACCOUNT = hex(b(60)), POLICY = hex(b(61)), COIN_PK = hex(b(62));
const records = [], privacy = {};
const clean = x => typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? hex(x)
  : Array.isArray(x) ? x.map(clean) : x && typeof x === 'object'
    ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clean(v)])) : x;
const save = (file, value) => writeFileSync(new URL(`../evidence/${file}`, import.meta.url), JSON.stringify(clean(value), null, 2) + '\n');
mkdirSync(new URL('../evidence', import.meta.url), { recursive: true });

function schnorr(pure, sk, challenge) {
  // Fresh nonce on every signature, even though all fixture keys are synthetic.
  const r = BigInt('0x' + randomBytes(32).toString('hex')) % (R - 1n) + 1n;
  const point = pure.compute_public_point_with_jubjub(r);
  for (let grind = 0n; ; grind++) {
    const c = le(challenge(point, grind));
    if (c < R) return [point, (r + c * sk) % R, grind];
  }
}
function ecdsa(pure, sk, challenge) {
  const secret = Buffer.from(sk.toString(16).padStart(64, '0'), 'hex');
  const sig = secp256k1.Signature.fromBytes(secp256k1.sign(pure.envelope_digest(0n, challenge), secret, { prehash: false }));
  return { r: sig.r, s: sig.s };
}
function stateValue(s) {
  if (typeof s.type !== 'function') return stateValue(s.state);
  switch (s.type()) {
    case 'null': return null;
    case 'cell': return clean(s.asCell());
    case 'array': return s.asArray().map(stateValue);
    case 'map': { const m = s.asMap(); return m.keys().map(k => [clean(k), stateValue(m.get(k))]); }
    default: throw new Error(`unsupported state type: ${s.type()}`);
  }
}
function publicView(res) {
  // Intentionally exclude input/output, privateTranscriptOutputs, commCommRand,
  // and zswapLocalState: these are prover/client data, not a chain observer view.
  return res.context.callProofDataTrace.map(t => ({
    circuit: t.circuitId, address: t.contractAddress,
    transcript: clean(t.publicTranscript),
    stateBefore: stateValue(t.initialQueryContext.state),
    stateAfter: stateValue(t.finalQueryContext.state),
    communicationCommitment: t.commCommData?.commComm,
  }));
}

async function setup(variant, options = {}) {
  const module = await import(`../contracts/managed/${variant}/contract/index.js`);
  const pure = module.pureCircuits;
  const arm = options.arm ?? 'jubjub';
  const external = variant.startsWith('External'), tagged = variant === 'ExternalTagged';
  const key = tagged ? tag : x => x;
  const policy = new Policy.Contract({});
  const pi = await policy.initialState(rt.createConstructorContext({}, COIN_PK),
    options.policyKey ?? key(COLOR), options.frozen ?? false, hash(ADMIN));
  let policyState = pi.currentContractState;
  for (const id of ['check', 'set_frozen']) {
    const op = new rt.ContractOperation();
    op.verifierKey = readFileSync(new URL(`../contracts/managed/Policy/keys/${options.wrongVk && id === 'check' ? 'set_frozen' : id}.verifier`, import.meta.url));
    policyState.setOperation(id, op);
  }
  const sk = 17n, salt = b(49);
  const pk = pure[`compute_public_point_with_${arm}`](sk);
  let coin = { nonce: NONCE, color: options.coinColor ?? COLOR, value: 1000000n, mt_index: 0n };
  const instance = new module.Contract({
    held_coin: ctx => [ctx.privateState, coin],
    experiment_policy_salt: ctx => [ctx.privateState, options.badSalt ? b(99) : SALT],
  });
  const boot = pure[`derive_boot_commitment_with_${arm}`](salt, pk, ...(arm === 'k256' ? [0n] : []));
  const constructorArgs = variant === 'Baseline' ? [] : [key(COLOR), key(FREE), options.allowUnknown ?? false,
    ...(external ? [{ bytes: b(61) }] : [options.frozen ?? false]), ...(tagged ? [hash(SALT)] : [])];
  const ai = await instance.initialState(rt.createConstructorContext({}, COIN_PK), boot, ENC, ...constructorArgs);
  let state = ai.currentContractState, counter = 0n;
  let fetches = 0;
  const provider = { getContractState: async (_block, address) => {
    fetches++;
    if (options.providerError) throw new Error('synthetic policy provider unavailable');
    return address === POLICY && !options.missingPolicy ? policyState : undefined;
  } };
  async function call(name, args) {
    const ctx = rt.createCircuitContext({ circuitId: name, contractAddress: ACCOUNT,
      coinPublicKeyOrZswapState: COIN_PK, contractState: state, privateState: {},
      crossContract: { stateProvider: provider, moduleProvider: {
        resolve: address => address === POLICY ? async () => Policy : undefined,
      } }, time: 1800000000, parentBlockHash: 'de'.repeat(32) });
    const res = await instance.impureCircuits[name](ctx, ...args);
    state = res.context.callContext.currentQueryContext.state;
    return res;
  }
  const L = () => module.ledger(state);
  async function device(op, args, challengeArgs = args, corrupt = false) {
    const challenge = pure[`challenge_${op}_with_${arm}`];
    let tail;
    if (arm === 'jubjub') {
      const sig = schnorr(pure, sk, (r, grind) => challenge({ bytes: b(60) }, r, pk, ...challengeArgs, L().auth_nonce, grind));
      if (corrupt) sig[1] = (sig[1] + 1n) % R;
      tail = [pk, counter, ...sig];
    } else {
      const sig = ecdsa(pure, sk, challenge({ bytes: b(60) }, pk, ...challengeArgs, L().auth_nonce));
      if (corrupt) sig.s += 1n;
      tail = [pk, counter, sig, 0n];
    }
    const result = await call(`${op}_with_${arm}`, [...args, ...tail]);
    counter++;
    return result;
  }
  await call(`activate_initial_device_with_${arm}`, [pk, salt, ...(arm === 'k256' ? [0n] : [])]);
  // Synthetic ledger execution: no Merkle membership proof is generated here.
  // Funding records the real ACC receive effects, but is NOT a confirmed deposit.
  await call('deposit_shielded', [{ nonce: coin.nonce, color: coin.color, value: coin.value }, new Uint8Array(192).fill(50)]);
  let unshieldedFunded = false;
  async function fundUnshielded(op) {
    if (op === 'withdraw_unshielded' && !unshieldedFunded) {
      await call('deposit_unshielded', [coin.color, coin.value]);
      unshieldedFunded = true;
    }
  }
  async function spend(op = 'withdraw_shielded', requestedColor = coin.color, corrupt = false) {
    await fundUnshielded(op);
    const args = op === 'withdraw_unshielded' ? [requestedColor, 31337n, RECIPIENT] : [RECIPIENT, requestedColor, 31337n];
    return device(op, args, [...args, ...(op === 'withdraw_unshielded' ? [] : [coin])], corrupt);
  }
  async function setFrozen(value, secret = ADMIN) {
    const ctx = rt.createCircuitContext({ circuitId: 'set_frozen', contractAddress: POLICY,
      coinPublicKeyOrZswapState: COIN_PK, contractState: policyState, privateState: {} });
    const res = await policy.impureCircuits.set_frozen(ctx, key(COLOR), value, secret);
    policyState.data = new rt.ChargedState(res.context.callContext.currentQueryContext.state.state);
    return res;
  }
  function replayPolicy(res) {
    const trace = res.context.callProofDataTrace.find(t => t.contractAddress === POLICY);
    assert(trace, 'external trace required');
    const context = new rt.QueryContext(policyState.data, POLICY);
    context.block = trace.initialQueryContext.block;
    return context.runTranscript({ program: trace.publicTranscript,
      effects: trace.finalQueryContext.effects, gas: res.context.gasCosts[POLICY] }, res.context.costModel);
  }
  async function grantSpend(op, grantArm = 'jubjub') {
    await fundUnshielded(op);
    const gsk = 23n, gpk = pure[`compute_public_point_with_${grantArm}`](gsk);
    const origin = b(51), scopeSalt = b(52), slot = 0n;
    const id = pure[`derive_grant_id_with_${grantArm}`]({ bytes: b(60) }, gpk,
      ...(grantArm === 'k256' ? [0n] : []), origin, slot);
    const scope = [true, true, true, true, coin.color, 0n, b(0), coin.value,
      coin.value, coin.value * 10n, 0n, b(0), b(53), 0n, 0n];
    const digest = pure.derive_grant_scope_digest(scopeSalt, ...scope);
    await device('issue_grant', [id, ...scope, scopeSalt], [id, digest]);
    const g = L().grants.lookup(id);
    const args = op === 'withdraw_unshielded' ? [coin.color, 31337n, RECIPIENT]
      : [RECIPIENT, coin.color, 31337n, new Uint8Array(192).fill(54), ENC];
    const challengeArgs = [id, g.issued_at, ...args, ...(op === 'withdraw_unshielded' ? [] : [coin]), g.nonce];
    const challenge = pure[`challenge_${op}_with_grant_${grantArm}`];
    const signature = grantArm === 'jubjub'
      ? schnorr(pure, gsk, (r, grind) => challenge({ bytes: b(60) }, r, gpk, ...challengeArgs, grind))
      : [ecdsa(pure, gsk, challenge({ bytes: b(60) }, gpk, ...challengeArgs))];
    const before = JSON.stringify(stateValue(state));
    try {
      return await call(`${op}_with_grant_${grantArm}`, [...args, gpk, ...(grantArm === 'k256' ? [0n] : []),
        origin, slot, scopeSalt, 0n, b(0), coin.value, 0n, ...signature]);
    } catch (error) {
      assert.equal(JSON.stringify(stateValue(state)), before, 'rejected grant spend must not commit its nonce/budget');
      throw error;
    }
  }
  return { spend, grantSpend, setFrozen, replayPolicy, fundUnshielded, L, module, get fetches() { return fetches; },
    fingerprint: () => JSON.stringify(stateValue(state)), key: key(COLOR) };
}

async function test(name, run) {
  try { const detail = await run(); records.push({ name, pass: true, detail }); console.log(`PASS ${name}`); }
  catch (error) { records.push({ name, pass: false, error: String(error.stack ?? error) }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function rejectsUnchanged(account, action, pattern) {
  const before = account.fingerprint();
  await assert.rejects(action, pattern);
  assert.equal(account.fingerprint(), before, 'failed construction must not commit ACC state in this harness');
}
const operations = ['withdraw_shielded', 'withdraw_shielded_to_contract', 'withdraw_unshielded'];

for (const variant of ['Baseline', 'Inline', 'ExternalRaw', 'ExternalTagged']) {
  await test(`${variant}: allowed shielded spend and public-surface audit`, async () => {
    const a = await setup(variant);
    const res = await a.spend();
    const view = publicView(res);
    const serialized = JSON.stringify(clean(view));
    const has = bytes => serialized.includes(hex(bytes));
    const uint128 = new rt.CompactTypeUnsignedInteger((1n << 128n) - 1n, 16);
    const hasAmount = n => serialized.includes(JSON.stringify(hex(uint128.toValue(n)[0])));
    const observation = { calls: view.map(t => ({ address: t.address, circuit: t.circuit })),
      rawColor: has(COLOR), coinNonce: has(NONCE), recipientKey: has(RECIPIENT.bytes),
      salt: has(SALT), tag: has(tag(COLOR)),
      amount: hasAmount(31337n), coinValue: hasAmount(1000000n),
      publicTranscriptOps: view.map(t => t.transcript.length), policyFetches: a.fetches };
    assert.equal(observation.rawColor, variant === 'Inline' || variant === 'ExternalRaw');
    assert.equal(observation.tag, variant === 'ExternalTagged');
    assert.equal(observation.coinNonce, false);
    assert.equal(observation.recipientKey, false);
    assert.equal(observation.salt, false);
    assert.equal(observation.amount, false);
    assert.equal(observation.coinValue, false);
    assert.equal(view.length, variant.startsWith('External') ? 2 : 1);
    // Positive control: these same markers really are in local proving data.
    const privateData = JSON.stringify(clean(res.context.callProofDataTrace.map(t => ({ input: t.input, witnesses: t.privateTranscriptOutputs }))));
    assert(privateData.includes(hex(NONCE)), 'audit must not accidentally inspect an empty execution');
    assert(privateData.includes(hex(COLOR)));
    save(`public-${variant}.json`, view);
    privacy[variant] = observation;
    return observation;
  });
  if (variant === 'Baseline') continue;
  for (const arm of ['jubjub', 'k256']) {
    for (const op of operations) {
      await test(`${variant}: ${arm} ${op} frozen`, async () => {
        const a = await setup(variant, { arm, frozen: true });
        await a.fundUnshielded(op);
        await rejectsUnchanged(a, () => a.spend(op), /asset frozen/);
      });
    }
  }
  for (const grantArm of ['jubjub', 'k256']) {
    for (const frozen of [false, true]) {
      for (const op of operations) {
        await test(`${variant}: grant ${grantArm} ${op} ${frozen ? 'frozen' : 'allowed'}`, async () => {
          const a = await setup(variant, { frozen });
          if (frozen) await assert.rejects(() => a.grantSpend(op, grantArm), /asset frozen/);
          else await a.grantSpend(op, grantArm);
        });
      }
    }
  }
  await test(`${variant}: claimed unrestricted color cannot bypass actual frozen coin`, async () => {
    const a = await setup(variant, { frozen: true });
    await rejectsUnchanged(a, () => a.spend('withdraw_shielded', FREE), /asset frozen/);
  });
  for (const allowUnknown of [false, true]) {
    await test(`${variant}: unregistered color, default ${allowUnknown ? 'allow' : 'deny'}`, async () => {
      const a = await setup(variant, { coinColor: UNKNOWN, allowUnknown, missingPolicy: true });
      if (allowUnknown) await a.spend();
      else await rejectsUnchanged(a, () => a.spend(), /unregistered asset denied/);
      assert.equal(a.fetches, 0, 'unregistered branch must not fetch a policy');
    });
  }
  await test(`${variant}: explicitly unrestricted color does not need a policy contract`, async () => {
    const a = await setup(variant, { coinColor: FREE, frozen: true, missingPolicy: true });
    await a.spend();
    assert.equal(a.fetches, 0);
  });
  await test(`${variant}: policy approval cannot replace device authorization`, async () => {
    const a = await setup(variant);
    await rejectsUnchanged(a, () => a.spend('withdraw_shielded', COLOR, true), /invalid signature/);
  });
  await test(`${variant}: even an unregistered allowed color leaves a lookup identifier`, async () => {
    const a = await setup(variant, { coinColor: UNKNOWN, allowUnknown: true, missingPolicy: true });
    const view = publicView(await a.spend());
    const identifier = variant === 'ExternalTagged' ? tag(UNKNOWN) : UNKNOWN;
    assert(JSON.stringify(clean(view)).includes(hex(identifier)));
    assert.equal(a.fetches, 0);
    save(`public-unregistered-${variant}.json`, view);
  });
}

for (const variant of ['Baseline', 'ExternalTagged']) {
  await test(`${variant}: direct transfer constructs a contract-owned native output`, async () => {
    const a = await setup(variant);
    const res = await a.spend('withdraw_shielded_to_contract');
    const outputs = res.context.callContext.currentZswapLocalState.outputs;
    assert(outputs.some(o => !o.recipient.is_left && hex(o.recipient.right.bytes) === hex(RECIPIENT.bytes)));
    const owners = outputs.map(o => o.recipient.is_left ? 'user-key-hidden' : hex(o.recipient.right.bytes));
    save(`native-output-owners-${variant}.json`, {
      stage: 'local construction of output recipients; NOT a serialized Zswap offer audit', owners,
      note: 'Zswap publishes contract ownership in its output.contract field; the Compact transcript alone does not contain every native output field.' });
    return { owners };
  });
}

for (const variant of ['ExternalRaw', 'ExternalTagged']) {
  for (const [label, opts, message] of [
    ['required policy absent', { missingPolicy: true }, /contract state for callee/],
    ['required policy unavailable', { providerError: true }, /provider unavailable/],
    ['wrong implementation', { wrongVk: true }, /[Vv]erifier|implementation/],
    ['policy contract has no matching rule', { policyKey: b(88) }, /policy has no rule/],
  ]) {
    await test(`${variant}: ${label} rejects even with default-allow`, async () => {
      const a = await setup(variant, { ...opts, allowUnknown: true });
      await rejectsUnchanged(a, () => a.spend(), message);
    });
  }
  await test(`${variant}: freeze and unfreeze between executions`, async () => {
    const a = await setup(variant);
    await a.spend();
    const freeze = await a.setFrozen(true);
    save(`public-freeze-${variant}.json`, publicView(freeze));
    await rejectsUnchanged(a, () => a.spend(), /asset frozen/);
    await assert.rejects(() => a.setFrozen(false, b(99)), /invalid policy admin/);
    await a.setFrozen(false);
    await a.spend();
  });
  await test(`${variant}: VM replay of previously allowed policy transcript after freeze`, async () => {
    const a = await setup(variant);
    const prepared = await a.spend();
    a.replayPolicy(prepared); // positive control, same state
    await a.setFrozen(true);
    let error;
    try { a.replayPolicy(prepared); } catch (e) { error = String(e); }
    assert(error, 'stale transcript must be rejected against frozen state');
    assert.match(error, /[Pp]op|[Ee]qual|[Tt]ranscript|[Mm]ismatch/);
    return { stage: 'onchain-runtime VM transcript verification, not node submission', error };
  });
}
await test('ExternalTagged: arbitrary salt cannot select an unrestricted policy key', async () => {
  const a = await setup('ExternalTagged', { badSalt: true });
  await rejectsUnchanged(a, () => a.spend(), /policy salt commitment mismatch/);
});
await test('ExternalTagged: repeated transfers reveal a stable tag', async () => {
  const a = await setup('ExternalTagged');
  for (let i = 0; i < 2; i++) assert(JSON.stringify(clean(publicView(await a.spend()))).includes(hex(tag(COLOR))));
});

save('privacy.json', privacy);
save('probes.json', { compiler: '0.35.0', runtime: '0.20.0',
  stage: 'compiled Compact runtime execution; no submitted transactions or spend proofs',
  passed: records.filter(x => x.pass).length, failed: records.filter(x => !x.pass).length, tests: records });
console.log(`${records.filter(x => x.pass).length}/${records.length} probes passed`);
if (records.some(x => !x.pass)) process.exitCode = 1;
