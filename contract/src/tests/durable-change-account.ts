// Generated-runtime/account integration. Signatures, witness execution, inbox
// encryption, and private-state merging are real. Transaction inclusion and
// commitment qualification are explicit fixtures, not node/prover evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCircuitContext } from '@midnight-ntwrk/compact-runtime';
import { CustodyAccount } from '../wallet/account.js';
import type { ChangeJournal, DurableTransactionAdapter, TransactionObservation } from '../wallet/change-journal.js';
import { bytesToHex } from '../wallet/hex.js';
import { generateEncKeyPair, sealInboxEntry } from '../wallet/inbox.js';
import { inboxWalk } from '../wallet/discovery.js';
import { JubjubDevice, jubjubChallenges } from '../wallet/signer.js';
import { coinId, coinsForColour, emptyCoinStore, withCoin } from '../wallet/witnesses.js';
import { AccountSim } from './sim.js';

const bytes = (n: number) => new Uint8Array(32).fill(n);
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const colour = bytes(4), recipient = bytes(8);
const input = { nonce: bytes(1), color: colour, value: 100n, mtIndex: 3n };
const sibling = { nonce: bytes(2), color: colour, value: 100n, mtIndex: 4n };

async function runtimeFixture() {
  const keys = generateEncKeyPair();
  const sim = await AccountSim.create({ initialRecoveryPk: new JubjubDevice(50n).pk,
    initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
  await sim.authorised('rotate_enc_key', (ctx, device) => jubjubChallenges.rotateEncKey(ctx, device.pk, keys.publicKey), [keys.publicKey]);
  for (const coin of [input, sibling]) await sim.call('deposit_shielded', coin, sealInboxEntry(keys.publicKey, coin));
  let privateState = withCoin(withCoin(emptyCoinStore(keys.secretKey), input), sibling);
  let journal: ChangeJournal | undefined;
  const journalStore = {
    get: async () => journal && jsonCopy(journal),
    set: async (_scope: string, value: ChangeJournal) => { journal = jsonCopy(value); },
  };
  const stateProvider = {
    get: async () => jsonCopy(privateState),
    set: async (_id: string, value: typeof privateState) => { privateState = jsonCopy(value); },
  };
  let serial = 0;
  const status = new Map<string, TransactionObservation['status']>();
  const observed = {
    preparations: [] as string[], submissions: [] as string[],
    management: [] as string[],
    nextStatus: 'succeeded' as TransactionObservation['status'], loseSpendResponse: false,
    qualify: true,
  };
  const adapter: DurableTransactionAdapter = {
    prepare: async (circuitId, args) => {
      observed.preparations.push(circuitId);
      const context = createCircuitContext({ circuitId, contractAddress: sim.addressHex,
        coinPublicKeyOrZswapState: sim.coinPk, contractState: sim.state,
        privateState: jsonCopy(privateState), time: sim.now });
      const result = await sim.impure[circuitId](context, ...args);
      const call = result.context.callContext;
      const maybe = Array.isArray(result.result) ? result.result[1] : result.result;
      const change = maybe?.is_some ? maybe.value : null;
      const id = (++serial).toString(16).padStart(64, '0');
      // The generated witness consumes the input in its prospective state.
      // The adapter deliberately leaves that state uncommitted until evidence.
      return {
        transactionIds: [id], change,
        result: { public: { txId: id }, private: { result: result.result } },
        submit: async () => {
          observed.submissions.push(circuitId);
          status.set(id, observed.nextStatus);
          if (observed.nextStatus === 'succeeded') sim.state = call.currentQueryContext.state;
          if (observed.loseSpendResponse && circuitId.startsWith('withdraw_')) throw new Error('spend response lost');
        },
      };
    },
    observe: async transactionIds => ({ status: status.get(transactionIds[0]) ?? 'unknown', transactionIds }),
    qualify: async coin => {
      if (!observed.qualify) throw new Error('qualification unavailable');
      return { ...coin, mt_index: 17n };
    },
  };
  const client = () => {
    const account = Reflect.construct(CustodyAccount, [sim.addressHex, sim.address,
      { privateStateProvider: stateProvider }, 'durable-account-runtime',
      { callTx: new Proxy({}, { get: (_target, name: string) => async (...args: unknown[]) => {
        if (name.startsWith('withdraw_')) throw new Error('untracked SDK submission');
        observed.management.push(name);
        sim.privateState = jsonCopy(privateState);
        const result = await sim.call(name, ...args);
        privateState = jsonCopy(sim.privateState) as typeof privateState;
        return { public: { txId: 'management-fixture' }, private: { result } };
      } }) },
      undefined, { networkId: 'runtime-fixture', journalStore, adapter }]) as CustodyAccount;
    account.ledgerState = async () => sim.ledger();
    return account;
  };
  return { sim, keys, observed, client, state: () => jsonCopy(privateState),
    losePrivateState: () => { privateState = emptyCoinStore(keys.secretKey); } };
}

test('runtime receive, partial spend, restart, inbox recovery, and later exact spend preserve neighbours', async () => {
  const f = await runtimeFixture();
  const originalSibling = f.state().coins[coinId(sibling)];
  const first = await f.client().withdrawShielded(f.sim.device, recipient, colour, 30n, coinId(input));
  assert.equal(first.capture?.stage, 'complete');
  assert.equal(first.change?.value, 70n);
  assert.equal(f.sim.ledger().inbox_count, 3n, 'two deposits and one owner backfill');
  const recovered = inboxWalk(f.sim.ledger(), f.keys.secretKey).find(coin => coin.value === 70n);
  assert.ok(recovered, 'the persisted entry decrypts to surviving change');
  assert.equal(coinId(recovered), coinId(first.change!));
  assert.equal(f.state().spentCoins?.[coinId(input)], true);
  assert.deepEqual(f.state().coins[coinId(sibling)], originalSibling);

  const restarted = f.client();
  await restarted.reconcileChanges(f.sim.device);
  const later = await restarted.withdrawShielded(f.sim.device, recipient, colour, recovered.value, coinId(recovered));
  assert.equal(later.change, null);
  assert.equal(later.capture?.stage, 'complete');
  assert.deepEqual(coinsForColour(f.state(), colour).map(coinId), [coinId(sibling)]);
  assert.equal(f.sim.ledger().inbox_count, 3n, 'an exact later spend appends no phantom change');
  assert.equal(f.observed.submissions.filter(name => name.startsWith('withdraw_')).length, 2);
  assert.equal(f.observed.submissions.filter(name => name.startsWith('append_inbox')).length, 1);
  assert.equal((await restarted.changeJournal()).length, 2);
});

test('runtime generated next private state is not committed for a partial transaction', async () => {
  const f = await runtimeFixture(); f.observed.nextStatus = 'partial';
  const account = f.client();
  await assert.rejects(() => account.withdrawShielded(f.sim.device, recipient, colour, 30n, coinId(input)), /reconciliation/);
  assert.equal(f.state().coins[coinId(input)].value, '100');
  assert.equal(f.state().coins[coinId(sibling)].value, '100');
  assert.equal(Object.keys(f.state().coins).length, 2);
  await assert.rejects(() => f.client().withdrawShielded(f.sim.device, recipient, colour, 100n, coinId(sibling)), /reconciliation/);
  assert.equal(f.observed.submissions.length, 1);
  assert.equal((await f.client().changeJournal())[0].stage, 'partial');
});

test('runtime accepted spend with a lost response resumes capture and backfill on a fresh account', async () => {
  const f = await runtimeFixture(); f.observed.loseSpendResponse = true;
  await assert.rejects(() => f.client().withdrawShielded(f.sim.device, recipient, colour, 30n, coinId(input)), /response lost/);
  assert.equal(f.state().coins[coinId(input)].value, '100', 'speculative witness consumption was not written');
  const restarted = f.client();
  await restarted.reconcileChanges(f.sim.device);
  assert.equal((await restarted.changeJournal())[0].stage, 'complete');
  assert.equal(f.state().spentCoins?.[coinId(input)], true);
  assert.equal(coinsForColour(f.state(), colour).find(coin => coin.value === 70n)?.mt_index, 17n);
  assert.equal(f.observed.submissions.filter(name => name.startsWith('withdraw_')).length, 1);
  assert.equal(f.observed.submissions.filter(name => name.startsWith('append_inbox')).length, 1);
  assert.equal(f.sim.ledger().inbox_count, 3n);
});

test('completed journal restores lost private adoption and never resurrects subsequently spent change', async () => {
  const f = await runtimeFixture();
  const first = await f.client().withdrawShielded(f.sim.device, recipient, colour, 30n, coinId(input));
  f.losePrivateState();
  const restarted = f.client();
  await restarted.reconcileChanges(f.sim.device);
  assert.deepEqual(coinsForColour(f.state(), colour).map(coinId), [coinId(first.change!)]);
  assert.equal(f.state().spentCoins?.[coinId(input)], true);
  await restarted.withdrawShielded(f.sim.device, recipient, colour, 70n, coinId(first.change!));
  f.losePrivateState();
  await f.client().reconcileChanges(f.sim.device);
  assert.deepEqual(coinsForColour(f.state(), colour), []);
  assert.equal(f.state().spentCoins?.[coinId(input)], true);
  assert.equal(f.state().spentCoins?.[coinId(first.change!)], true);
  assert.equal(f.observed.submissions.filter(name => name.startsWith('withdraw_')).length, 2);
  assert.equal(f.observed.submissions.filter(name => name.startsWith('append_inbox')).length, 1);
});

test('unknown spend quarantine permits key management while refusing another shielded spend', async () => {
  const f = await runtimeFixture(); f.observed.nextStatus = 'unknown';
  const account = f.client();
  await assert.rejects(() => account.withdrawShielded(f.sim.device, recipient, colour, 30n, coinId(input)), /reconciliation/);
  const pending = (await account.changeJournal())[0];
  const nextKey = generateEncKeyPair();
  await account.rotateEncKey(f.sim.device, nextKey.publicKey);
  assert.equal(bytesToHex(f.sim.ledger().enc_key), bytesToHex(nextKey.publicKey));
  assert.deepEqual(f.observed.management, ['rotate_enc_key_with_jubjub']);
  assert.deepEqual((await account.changeJournal())[0], pending);
  assert.equal(f.state().coins[coinId(input)].value, '100');
  assert.equal(f.state().coins[coinId(sibling)].value, '100');
  await assert.rejects(() => f.client().withdrawShielded(f.sim.device, recipient, colour, 100n, coinId(sibling)), /reconciliation/);
  await assert.rejects(() => account.callTx.withdraw_shielded_with_jubjub(), /typed account method/);
  assert.equal(f.observed.submissions.length, 1);
});
