// Uses real ledger state/VK decoding and the SDK submission pipeline. Provider
// transport/proving seams are mocks; these checks do not establish finality.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import test from 'node:test';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  ContractDeploy, ContractMaintenanceAuthority, ContractOperation, ContractState, Intent,
  sampleSigningKey, signatureVerifyingKey, sampleEncryptionPublicKey, MaintenanceUpdate, ReplaceAuthority, VerifierKeyInsert,
} from '@midnightntwrk/ledger-v9';
import { allCircuits, armCircuits, deployAccountInWaves, planWaves, resumeAccountInWaves, VERIFIER_BYTE_BUDGET, type WaveDeploymentCheckpoint } from '../wallet/wave-deploy.js';
import { Contract, pureCircuits } from '../wallet/contract.js';
import { emptyCoinStore, makeWitnesses } from '../wallet/witnesses.js';

setNetworkId('undeployed');
const immediate = { observationTimeoutMs: 0, pollIntervalMs: 1 };
const shortObservation = { observationTimeoutMs: 20, pollIntervalMs: 1 };
// Allow delayed-visibility fixtures to tolerate timer scheduling under CI load.
const observationGrace = { observationTimeoutMs: 1_000, pollIntervalMs: 1 };
const verifier = new Uint8Array(readFileSync(new URL('../../contracts/managed/control/keys/deposit_public.verifier', import.meta.url)));
const otherVerifier = new Uint8Array(readFileSync(new URL('../../contracts/managed/control/keys/spend_public.verifier', import.meta.url)));
function operation(bytes = verifier) {
  const result = new ContractOperation(); result.verifierKey = bytes; return result;
}
async function fixture(bootstrapMode = 1n, historicalSignedFirst = false) {
  const key = sampleSigningKey();
  const birth = await new Contract(makeWitnesses()).initialState(
    createConstructorContext(emptyCoinStore(), { bytes: new Uint8Array(32) }),
    new Uint8Array(32).fill(1), new Uint8Array(32), pureCircuits.compute_public_point_with_jubjub(1n),
    new Uint8Array(64), 60n, bootstrapMode, new Uint8Array(32).fill(Number(bootstrapMode)),
  );
  const initial = new ContractState();
  initial.data = ContractState.deserialize(birth.currentContractState.serialize()).data;
  initial.maintenanceAuthority = new ContractMaintenanceAuthority([signatureVerifyingKey(key)], 1, 0n);
  initial.setOperation('deposit_unshielded', operation());
  if (historicalSignedFirst) initial.setOperation('activate_initial_passkey', operation());
  const deploy = new ContractDeploy(initial);
  const checkpoint: WaveDeploymentCheckpoint = { version: 1, address: String(deploy.address),
    initialState: initial.serialize(), deploymentIntent: Intent.new(new Date(Date.now() + 60000)).addDeploy(deploy).serialize(),
    privateStateId: 'bootstrap-checkpoint-test', firstArm: 'p256', retireAuthority: true };
  let live: ContractState | undefined = ContractState.deserialize(initial.serialize());
  let storedKey: typeof key | undefined = key;
  const submitted: any[] = [];
  let submit = async (_payload: any): Promise<string> => { throw new Error('unexpected submission'); };
  const providers = {
    zkConfigProvider: { getVerifierKey: async () => verifier },
    publicDataProvider: { queryContractState: async () => live,
      watchForTxData: async (_id: string) => ({ version: 'v9', status: 'SucceedEntirely' }) },
    privateStateProvider: { getSigningKey: async () => storedKey, setContractAddress: async () => {} },
    proofProvider: { supportedEras: ['v9'], proveTx: async (payload: any) => payload },
    walletProvider: { supportedEras: ['v9'], balanceTx: async (payload: any) => payload },
    midnightProvider: { supportedEras: ['v9'], submitTx: async (payload: any) => { submitted.push(payload); return submit(payload); } },
  };
  return { checkpoint, providers, key, initial, submitted, setSubmit: (fn: typeof submit) => { submit = fn; },
    live: () => live!, setLive: (value: ContractState | undefined) => { live = value; },
    setKey: (value: typeof key | undefined) => { storedKey = value; } };
}

test('B11: a complete retired deployment resumes without its erased maintenance key', async () => {
  const f = await fixture();
  for (const id of allCircuits()) f.live().setOperation(id, operation());
  f.live().maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 6n);
  // Actual ledger API supplies named operations and raw VKs as expected.
  assert.deepEqual(f.live().operations().sort(), allCircuits().sort());
  assert.deepEqual(f.live().operation('activate_initial_passkey')!.verifierKey, verifier);
  f.setKey(undefined);
  assert.equal(await resumeAccountInWaves(f.providers, f.checkpoint), f.checkpoint.address);
});

test('B11: partial deployment cannot proceed after key loss or premature authority retirement', async () => {
  const f = await fixture(); f.setKey(undefined);
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /no usable maintenance/);
  f.setKey(f.key); f.live().maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 1n);
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /no usable maintenance/);
  f.setLive(undefined); f.setKey(undefined);
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint, immediate), /missing retained maintenance key/);
});

test('B11: checkpoint identity, installed verifier substitutions and extra operations reject before submission', async () => {
  const f = await fixture();
  await assert.rejects(() => resumeAccountInWaves(f.providers, { ...f.checkpoint, address: '00'.repeat(32) }), /address mismatch/);
  const alteredInitial = ContractState.deserialize(f.checkpoint.initialState);
  alteredInitial.setOperation('activate_initial_passkey', operation());
  await assert.rejects(() => resumeAccountInWaves(f.providers, { ...f.checkpoint, initialState: alteredInitial.serialize() }), /initial state mismatch/);
  f.live().setOperation('activate_initial_passkey', operation(otherVerifier));
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /unexpected deployed verifier/);
  f.setLive(ContractState.deserialize(f.initial.serialize()));
  f.live().setOperation('unexpected_takeover', operation());
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /unexpected deployed verifier/);
});

test('B11: maintenance identity and configured retirement policy are checked even for complete rosters', async () => {
  const f = await fixture(); f.setKey(sampleSigningKey());
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /does not match deployment checkpoint/);
  f.setKey(f.key);
  for (const id of allCircuits()) f.live().setOperation(id, operation());
  f.live().maintenanceAuthority = new ContractMaintenanceAuthority([signatureVerifyingKey(sampleSigningKey())], 1, 3n);
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint), /deployed maintenance authority/);
  f.live().maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 4n);
  await assert.rejects(() => resumeAccountInWaves(f.providers, { ...f.checkpoint, retireAuthority: false }), /unexpected retired/);
});

test('mode-0 wave 1 prioritises usable first-arm operations; mode 1 prioritises signed activation', () => {
  const sizes = new Map(allCircuits().map(id => [id, Math.floor(VERIFIER_BYTE_BUDGET / 9)]));
  for (const arm of ['jubjub', 'k256', 'p256'] as const) {
    const legacy = planWaves(sizes, arm), signed = planWaves(sizes, arm, true, 1n);
    assert.deepEqual(legacy, planWaves(sizes, arm, true, 0n), 'default remains legacy mode');
    assert.equal(legacy[0].circuits.includes('activate_initial_passkey'), false);
    assert.equal(signed[0].circuits[2], 'activate_initial_passkey');
    assert.equal(legacy[0].circuits.includes(`activate_initial_device_with_${arm}`), true);
    assert.equal(signed[0].circuits.some(id => id.startsWith('activate_initial_device_')), false);
    const countUsableArm = (ids: string[]) => ids.filter(id => armCircuits(arm).slice(1).includes(id)).length;
    assert.equal(countUsableArm(legacy[0].circuits), countUsableArm(signed[0].circuits),
      'each mode spends one activation slot and retains the same usable first-arm capacity');
    for (const waves of [legacy, signed]) {
      assert.deepEqual(waves.flatMap(wave => wave.circuits).sort(), allCircuits().sort());
      assert.ok(waves.every(wave => wave.verifierBytes <= VERIFIER_BYTE_BUDGET));
      assert.deepEqual(waves.filter(wave => wave.retiresAuthority), [waves.at(-1)]);
    }
  }
  assert.throws(() => planWaves(sizes, 'p256', true, 2n), /unsupported bootstrap mode/);
});

test('B11: earlier mode-0 checkpoints retain their original intent/address despite revised wave ordering', async () => {
  const f = await fixture(0n, true);
  const before = new Uint8Array(f.checkpoint.deploymentIntent);
  for (const id of allCircuits()) f.live().setOperation(id, operation());
  f.live().maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 6n);
  f.setKey(undefined);
  assert.equal(await resumeAccountInWaves(f.providers, f.checkpoint), f.checkpoint.address);
  assert.deepEqual(f.checkpoint.deploymentIntent, before);
  assert.equal('bootstrapMode' in f.checkpoint, false, 'mode comes from the original constructor state');
});

function completeDeployment(f: Awaited<ReturnType<typeof fixture>>) {
  for (const id of allCircuits()) f.live().setOperation(id, operation());
  f.live().maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 6n);
}

for (const retainedKey of [true, false]) test(`B11: an in-flight deployment becomes visible before another submission (retained key=${retainedKey})`, async () => {
  const f = await fixture(); completeDeployment(f); if (!retainedKey) f.setKey(undefined);
  let reads = 0;
  f.providers.publicDataProvider.queryContractState = async () => ++reads < 3 ? undefined : f.live();
  assert.equal(await resumeAccountInWaves(f.providers, f.checkpoint, observationGrace), f.checkpoint.address);
  assert.equal(f.submitted.length, 0);
  assert.ok(reads >= 3);
});

for (const outcome of ['accepted', 'duplicate rejection', 'duplicate failed status'] as const) {
  test(`B11: resume observes indexed deployment after ${outcome}`, async () => {
    const f = await fixture(); completeDeployment(f);
    let afterSubmitReads = 0;
    f.providers.publicDataProvider.queryContractState = async () =>
      !f.submitted.length || ++afterSubmitReads < 3 ? undefined : f.live();
    f.setSubmit(async payload => {
      const actions = [...payload.tx.intents.values()].flatMap((intent: any) => intent.actions);
      assert.equal(actions.length, 1); assert.ok(actions[0] instanceof ContractDeploy);
      assert.equal(String(actions[0].address), f.checkpoint.address, 'reuses the original deployment identity');
      if (outcome === 'duplicate rejection') throw new Error('SubmissionError: contract already exists');
      return 'deployment-test';
    });
    if (outcome === 'duplicate failed status') {
      f.providers.publicDataProvider.watchForTxData = async () => ({ version: 'v9', status: 'FailEntirely' });
    }
    assert.equal(await resumeAccountInWaves(f.providers, f.checkpoint, observationGrace), f.checkpoint.address);
    assert.equal(f.submitted.length, 1, 'no blind duplicate/dust retry');
    assert.ok(afterSubmitReads >= 3);
  });
}

test('B11: an unobserved failed submission retains its original error', async () => {
  const f = await fixture(); f.setLive(undefined);
  const refusal = new Error('SubmissionError: fee budget exhausted');
  f.setSubmit(async () => { throw refusal; });
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint, immediate), error => error === refusal);
  assert.equal(f.submitted.length, 1);
});

test('B11: accepted but unobserved deployment times out without another submission', async () => {
  const f = await fixture(); f.setLive(undefined); f.setSubmit(async () => 'deployment-test');
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint, shortObservation), /not yet observed; retain checkpoint/);
  assert.equal(f.submitted.length, 1);
});

test('B11: a duplicate rejection cannot conceal an unexpected deployed verifier', async () => {
  const f = await fixture(); completeDeployment(f);
  f.live().setOperation('activate_initial_passkey', operation(otherVerifier));
  f.providers.publicDataProvider.queryContractState = async () => f.submitted.length ? f.live() : undefined;
  f.setSubmit(async () => { throw new Error('SubmissionError: contract already exists'); });
  await assert.rejects(() => resumeAccountInWaves(f.providers, f.checkpoint, immediate), /unexpected deployed verifier/);
  assert.equal(f.submitted.length, 1);
});


// The constructor, verifier loading, deployment identity, and SDK submission
// pipeline are real. This transport records when private persistence occurs.
function deploymentFixture(mode = 0n) {
  const managed = new URL('../../contracts/managed/account/', import.meta.url);
  const compiled = CompiledContract.make('account', Contract).pipe(
    CompiledContract.withWitnesses(makeWitnesses()), CompiledContract.withCompiledFileAssets(fileURLToPath(managed)));
  const events: string[] = [], submissions: any[] = [];
  const existingKey = sampleSigningKey(), existingState = { preserved: true };
  const keys = new Map([['existing-account', existingKey]]);
  const states = new Map<string, unknown>([['deployment-test-state', existingState]]);
  let live: ContractState | undefined;
  const providers: any = {
    zkConfigProvider: { getVerifierKey: async (id: string) => new Uint8Array(readFileSync(new URL(`keys/${id}.verifier`, managed))) },
    privateStateProvider: {
      setContractAddress: async () => { events.push('scope'); },
      setSigningKey: async (address: string, key: typeof existingKey) => { events.push('key'); keys.set(address, key); },
      set: async (id: string, value: unknown) => { events.push('state'); states.set(id, value); },
    },
    proofProvider: { supportedEras: ['v9'], proveTx: async (payload: any) => payload },
    walletProvider: { supportedEras: ['v9'], getCoinPublicKey: () => '00'.repeat(32),
      getEncryptionPublicKey: () => sampleEncryptionPublicKey(), balanceTx: async (payload: any) => payload },
    publicDataProvider: {
      queryContractState: async () => live,
      watchForTxData: async () => { events.push('accepted'); return { version: 'v9', status: 'SucceedEntirely' }; },
    },
    midnightProvider: { supportedEras: ['v9'], submitTx: async (payload: any) => {
      events.push('submit'); submissions.push(payload);
      for (const intent of payload.tx.intents.values()) for (const action of intent.actions) {
        if (action instanceof ContractDeploy) live = action.initialState;
        else {
          assert.ok(action instanceof MaintenanceUpdate); assert.ok(live);
          assert.equal(action.counter, live.maintenanceAuthority.counter);
          const before = live.maintenanceAuthority;
          live.maintenanceAuthority = new ContractMaintenanceAuthority(before.committee, before.threshold, before.counter + 1n);
          for (const update of action.updates) {
            if (update instanceof VerifierKeyInsert) {
              // The versioned wrapper exposes untagged VK payloads; the state
              // setter takes the tagged artefact, as the actual ledger does.
              assert.equal(typeof update.operation, 'string');
              live.setOperation(update.operation, operation(new Uint8Array(readFileSync(new URL(`keys/${update.operation}.verifier`, managed)))));
            }
            else { assert.ok(update instanceof ReplaceAuthority); live.maintenanceAuthority = update.authority; }
          }
        }
      }
      return 'deployment-test';
    } },
  };
  const options = { firstArm: 'p256' as const, privateStateId: 'deployment-test-state', initialPrivateState: emptyCoinStore(),
    args: [new Uint8Array(32).fill(1), new Uint8Array(32), pureCircuits.compute_public_point_with_jubjub(1n),
      new Uint8Array(64), 60n, mode, new Uint8Array(32).fill(Number(mode))] };
  return { providers, compiled, options, events, keys, states, existingKey, existingState, submissions, live: () => live };
}

for (const failure of ['refused status', 'thrown rejection'] as const) test(`non-checkpointed wave 1 ${failure} leaves retained data unchanged`, async () => {
  const f = deploymentFixture();
  if (failure === 'refused status') {
    f.providers.midnightProvider.submitTx = async (payload: any) => {
      f.events.push('submit'); f.submissions.push(payload); return 'deployment-test';
    };
    f.providers.publicDataProvider.watchForTxData = async () => ({ version: 'v9', status: 'FailEntirely' });
  } else {
    f.providers.midnightProvider.submitTx = async () => { f.events.push('submit'); throw new Error('transport refused deployment'); };
  }
  await assert.rejects(() => deployAccountInWaves(f.providers, f.compiled, f.options), /wave-1 deploy failed|transport refused deployment/);
  assert.deepEqual(f.events, ['submit']);
  assert.equal(f.live(), undefined);
  assert.deepEqual([...f.keys], [['existing-account', f.existingKey]]);
  assert.deepEqual([...f.states], [['deployment-test-state', f.existingState]]);
});

test('non-checkpointed deployment persists after wave 1 acceptance and before maintenance', async () => {
  const f = deploymentFixture();
  const address = await deployAccountInWaves(f.providers, f.compiled, f.options);
  assert.deepEqual(f.events.slice(0, 6), ['submit', 'accepted', 'scope', 'key', 'state', 'submit']);
  assert.equal(f.keys.get('existing-account'), f.existingKey);
  assert.ok(f.keys.has(address));
  assert.notEqual(f.states.get(f.options.privateStateId), f.existingState);
  assert.deepEqual(f.live()!.operations().sort(), allCircuits().sort());
  assert.equal(f.live()!.maintenanceAuthority.committee.length, 0);
});

test('checkpointed deployment persists recovery material before its pre-submission interruption', async () => {
  const f = deploymentFixture(1n), interruption = new Error('checkpoint saved; interrupted before submit');
  let checkpoint: WaveDeploymentCheckpoint | undefined;
  await assert.rejects(() => deployAccountInWaves(f.providers, f.compiled, { ...f.options,
    onPrepared: async value => {
      checkpoint = value; f.events.push('prepared');
      assert.ok(f.keys.has(value.address));
      assert.notEqual(f.states.get(value.privateStateId), f.existingState);
      throw interruption;
    },
  }), error => error === interruption);
  assert.ok(checkpoint);
  assert.deepEqual(f.events, ['scope', 'key', 'state', 'prepared']);
  assert.equal(f.submissions.length, 0);
  assert.ok(f.keys.has(checkpoint.address));
  assert.equal(f.keys.get('existing-account'), f.existingKey);
});
