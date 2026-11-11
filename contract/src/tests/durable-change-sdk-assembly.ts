// The single generated SDK assembly case in durable-change receipt testing.
// This requires one fresh account verifier asset, but mocks proof generation,
// balancing, transport, and submission acknowledgement; it is not proof or
// node acceptance evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ContractState as RuntimeContractState } from '@midnight-ntwrk/compact-runtime';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  ChargedState, StateValue, ContractState, ContractOperation, LedgerParameters,
  ZswapChainState, ZswapOffer, ZswapOutput, sampleEncryptionPublicKey,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { createSdkChangeAdapter } from '../wallet/sdk-change-adapter.js';
import { Contract } from '../wallet/contract.js';
import { bytesToHex } from '../wallet/hex.js';
import { JubjubDevice, authArgs, jubjubChallenges } from '../wallet/signer.js';
import { emptyCoinStore, makeWitnesses, withCoin, withSelectedCoin } from '../wallet/witnesses.js';
import { AccountSim } from './sim.js';

const id = '12'.repeat(32), otherId = '34'.repeat(32);

test('SDK prepares the generated spend without private-state writes, captures final IDs, and submits at most once', async t => {
  setNetworkId('undeployed');
  const sim = await AccountSim.create({ initialRecoveryPk: new JubjubDevice(50n).pk,
    initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
  const managed = new URL('../../contracts/managed/account/', import.meta.url);
  const circuit = 'withdraw_shielded_with_jubjub';
  const compiled = CompiledContract.make('account', Contract).pipe(
    CompiledContract.withWitnesses(makeWitnesses()), CompiledContract.withCompiledFileAssets(fileURLToPath(managed)));
  const contractState = new ContractState();
  contractState.data = new ChargedState(StateValue.decode(sim.state.state.encode()));
  const operation = new ContractOperation();
  operation.verifierKey = readFileSync(new URL(`keys/${circuit}.verifier`, managed));
  contractState.setOperation(circuit, operation);
  // The pinned indexer provider exposes Compact runtime contract state.
  const providerContractState = RuntimeContractState.deserialize(contractState.serialize());
  const ledgerCoin = { nonce: '01'.repeat(32), type: '02'.repeat(32), value: 100n };
  const output = ZswapOutput.newContractOwned(ledgerCoin, 0, sim.addressHex);
  const [unclosed, positions] = new ZswapChainState().tryApply(ZswapOffer.fromOutput(output));
  const chain = unclosed.postBlockUpdate(new Date(), 600n);
  const input = { nonce: new Uint8Array(Buffer.from(ledgerCoin.nonce, 'hex')),
    color: new Uint8Array(Buffer.from(ledgerCoin.type, 'hex')), value: ledgerCoin.value,
    mt_index: positions.get(output.commitment)! };
  const privateState = withSelectedCoin(withCoin(emptyCoinStore(), { ...input, mtIndex: input.mt_index }), input);
  const recipient = new Uint8Array(32).fill(8);
  const encryptionPublicKey = sampleEncryptionPublicKey();
  const auth = sim.device.sign(jubjubChallenges.withdrawShielded(sim.callContext(), sim.device.pk,
    recipient, input.color, 30n, input), 0n);
  let writes = 0, submits = 0, proofCalls = 0, balanceCalls = 0, loseAcknowledgement = true;
  const balanced = { version: 'v9', tx: { identifiers: () => [`0x${id.toUpperCase()}`, otherId, otherId] } };
  const providers = {
    zkConfigProvider: new NodeZkConfigProvider(fileURLToPath(managed)),
    privateStateProvider: { setContractAddress: () => {}, get: async () => structuredClone(privateState),
      set: async () => { writes++; } },
    publicDataProvider: { queryBlock: async () => ({ hash: '00'.repeat(32) }),
      queryZSwapAndContractState: async () => [chain, providerContractState, LedgerParameters.initialParameters()] },
    walletProvider: { getCoinPublicKey: () => bytesToHex(recipient), getEncryptionPublicKey: () => encryptionPublicKey,
      balanceTx: async (proven: any) => { balanceCalls++; assert.equal(proven.version, 'v9'); return balanced; } },
    proofProvider: { proveTx: async (unproven: any) => {
      proofCalls++; assert.equal(unproven.version, 'v9'); assert.ok(unproven.tx);
      // Assembly is real. Cryptographic proving and balancing are this fixture's boundary.
      return { version: 'v9', tx: unproven.tx };
    } },
    midnightProvider: { submitTx: async (tx: any) => {
      submits++; assert.equal(tx, balanced);
      if (loseAcknowledgement) throw new Error('submission acknowledgement lost');
      return id;
    } },
  };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('preparation must not query recovery HTTP'); });
  const sdk = createSdkChangeAdapter({ providers, compiledContract: compiled, address: sim.addressHex,
    privateStateId: 'prepared-sdk-test', indexerUrl: 'http://localhost:1/graphql', proofServerUrl: 'http://localhost:1',
    observationTimeoutMs: 0 });
  const prepared = await sdk.prepare(circuit, [{ bytes: recipient }, input.color, 30n, ...authArgs(auth)]);
  assert.equal(proofCalls, 1); assert.equal(balanceCalls, 1);
  assert.equal(writes, 0); assert.equal(submits, 0);
  assert.deepEqual(prepared.transactionIds, [id, otherId]);
  assert.equal(prepared.change?.value, 70n);
  assert.equal(prepared.result.private.result.is_some, true);
  await assert.rejects(() => prepared.submit(), /acknowledgement lost/);
  await assert.rejects(() => prepared.submit(), /already been submitted/);
  assert.equal(submits, 1); assert.equal(writes, 0);

  loseAcknowledgement = false;
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async () => { polls++; return Response.json({ data: { transactions: [] } }); });
  const noPoll = await sdk.prepare(circuit, [{ bytes: recipient }, input.color, 30n, ...authArgs(auth)]);
  await noPoll.submit();
  assert.equal(polls, 0, 'a zero observation budget performs no post-ack polling');

  const bounded = createSdkChangeAdapter({ providers, compiledContract: compiled, address: sim.addressHex,
    privateStateId: 'prepared-sdk-test', indexerUrl: 'http://localhost:1/graphql', proofServerUrl: 'http://localhost:1',
    observationTimeoutMs: 25, requestTimeoutMs: 500 });
  const finite = await bounded.prepare(circuit, [{ bytes: recipient }, input.color, 30n, ...authArgs(auth)]);
  let now = Date.now();
  const budgets: number[] = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    budgets.push(milliseconds); return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    polls++; now += 30;
    return Response.json({ data: { transactions: [] } });
  });
  await finite.submit();
  assert.deepEqual(budgets, [25], 'each request is bounded by the remaining observation budget');
  assert.equal(polls, 1, 'deadline exhaustion prevents checking a second identifier');
  assert.equal(writes, 0);
});
