/** Three real processes: lost spend acknowledgement, lost backfill acknowledgement,
 * then reconciliation and a later spend. An optional fourth phase checks grant
 * adoption and its atomic recovery entry. Uses public localnet funds only. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setupWallet, compiledAccountContract, deployFaucet } from '../node/setup.js';
import { CONFIG } from '../node/wallet.js';
import { createFileChangeJournalStore } from '../node/change-journal-store.js';
import { CustodyAccount, type DurableChangesOptions } from '../wallet/account.js';
import { createSdkChangeAdapter } from '../wallet/sdk-change-adapter.js';
import { JubjubDevice, JubjubGrantee, openingOf, originHash, spendScope } from '../wallet/signer.js';
import {
  CompactTypeField, CompactTypeVector, convertBytesToUint,
  degradeToTransient, transientHash, upgradeFromTransient,
} from '@midnight-ntwrk/compact-runtime';
import { generateEncKeyPair, openInboxEntry, sealInboxEntry } from '../wallet/inbox.js';
import { coinId, emptyCoinStore } from '../wallet/witnesses.js';
import { restoreJournalCoin } from '../wallet/change-journal.js';
import { mintToUser, userCoinPublicKey } from './flow.js';
import { confirmTransaction } from './instrumentation.js';

const phase = process.argv[2];
const directory = resolve(process.argv[3] ?? '.durable-change-localnet');
const fixturePath = resolve(directory, 'private-fixture.json');
const receiptPath = resolve(directory, 'receipt.json');
const publicSeed = '0'.repeat(63) + '1';
const device = new JubjubDevice(7n); // Public test credential, restricted to localnet below.
const json = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2);
let receipt: any = { scenario: 'durable-change-localnet', steps: [], transactions: [] };

async function main() {
  assert.ok(['spend', 'backfill', 'finish', 'grant'].includes(phase), 'phase must be spend, backfill, finish, or grant');
  assert.equal(CONFIG.networkId, 'undeployed', 'public development network only');
  assert.equal(process.env.WALLET_SEED ?? publicSeed, publicSeed, 'public development seed only');
  for (const endpoint of [CONFIG.node, CONFIG.indexer, CONFIG.indexerWS, CONFIG.proofServer]) {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname), 'loopback services required');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (phase !== 'spend') receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const fixture: any = phase === 'spend' ? { key: randomBytes(32).toString('hex') }
    : JSON.parse(await readFile(fixturePath, 'utf8'));
  const store = await createFileChangeJournalStore({ directory: resolve(directory, 'journal'), encryptionKey: Buffer.from(fixture.key, 'hex') });
  const ctx = await setupWallet(publicSeed);
  const compiled = compiledAccountContract();
  const originalSubmit = ctx.providers.midnightProvider.submitTx.bind(ctx.providers.midnightProvider);
  let sends = 0;
  ctx.providers.midnightProvider.submitTx = async (...args: any[]) => {
    sends++;
    return originalSubmit(...args);
  };
  let faultUsed = false;
  const durableChanges: DurableChangesOptions = {
    networkId: 'undeployed:durable-change-localnet', journalStore: store,
    adapter: context => {
      const sdk = createSdkChangeAdapter({ ...context, indexerUrl: CONFIG.indexer, proofServerUrl: CONFIG.proofServer });
      return {
        ...sdk,
        async prepare(name, args) {
          const transaction = await sdk.prepare(name, args);
          if (!faultUsed && ((phase === 'spend' && name.startsWith('withdraw_shielded'))
            || (phase === 'backfill' && name.startsWith('append_inbox')))) {
            faultUsed = true;
            return { ...transaction, async submit() {
              await transaction.submit();
              throw new Error('injected acknowledgement loss after on-chain submission');
            } };
          }
          return transaction;
        },
      };
    },
  };
  const account = phase === 'spend'
    ? await CustodyAccount.deploy(ctx.providers, compiled, device, generateEncKeyPair(), { durableChanges })
    : await CustodyAccount.connect(ctx.providers, compiled, fixture.address, emptyCoinStore(), {
      privateStateId: fixture.privateStateId, durableChanges,
    });
  if (phase === 'spend') {
    fixture.address = account.address;
    fixture.privateStateId = account.privateStateId;
    await writeFile(fixturePath, json(fixture), { mode: 0o600 });
    const faucet = await deployFaucet(ctx.walletCtx);
    const qualification = createSdkChangeAdapter({ providers: ctx.providers, compiledContract: compiled,
      address: account.address, privateStateId: account.privateStateId,
      indexerUrl: CONFIG.indexer, proofServerUrl: CONFIG.proofServer });
    const deposits = [];
    for (const value of [600n, 100n]) {
      const coin = await mintToUser(ctx, faucet, '0'.repeat(62) + '51', value);
      const entry = sealInboxEntry(await account.encKey(), coin);
      const { txId } = await account.depositShielded(coin, entry);
      const qualified = await qualification.qualify(coin, [txId]);
      await account.putCoin({ ...qualified, mtIndex: qualified.mt_index });
      deposits.push(coinId(coin));
      receipt.transactions.push(await confirmTransaction(txId, true));
    }
    fixture.inputId = deposits[0]; fixture.siblingId = deposits[1];
    await writeFile(fixturePath, json(fixture), { mode: 0o600 });
    await assert.rejects(account.withdrawShielded(device, await userCoinPublicKey(ctx),
      Buffer.from(fixture.inputId.split(':')[1], 'hex'),
      200n, fixture.inputId), /injected acknowledgement loss/);
    const journal = await account.changeJournal();
    assert.equal(journal.length, 1); assert.equal(journal[0].stage, 'submitting');
    assert.ok((await account.coinStore()).coins[fixture.inputId], 'unknown outcome retains reserved input');
    assert.ok(faultUsed);
    receipt.steps.push({ phase, result: 'PASS', interruptedAfter: 'spend accepted, acknowledgement lost', transactionIds: journal[0].transactionIds });
  } else if (phase === 'backfill') {
    await assert.rejects(account.reconcileChanges(device), /injected acknowledgement loss/);
    const journal = await account.changeJournal();
    assert.equal(journal[0].recovery.backfill?.stage, 'submitting');
    assert.equal((await account.ledgerState()).inbox_count, 3n);
    assert.ok(!(await account.coinStore()).coins[fixture.inputId]);
    assert.ok((await account.coinStore()).coins[fixture.siblingId]);
    assert.equal(sends, 1, 'recovery sends only the backfill, never the spend again');
    receipt.steps.push({ phase, result: 'PASS', interruptedAfter: 'backfill accepted, acknowledgement lost', sends });
  } else if (phase === 'finish') {
    const journal = await account.reconcileChanges(device);
    assert.equal(journal[0].stage, 'complete');
    assert.equal(sends, 0, 'already appended entry is adopted without another transaction');
    assert.equal((await account.ledgerState()).inbox_count, 3n);
    const change = restoreJournalCoin(journal[0].qualifiedChange!);
    const state = await account.coinStore();
    assert.ok(state.coins[coinId(change)]); assert.ok(state.coins[fixture.siblingId]);
    const inbox = (await account.ledgerState()).inbox.lookup(2n);
    assert.equal(coinId(openInboxEntry(Buffer.from(state.encSecretKeyHex!, 'hex'), inbox)!), coinId(change));
    const outcome = await account.withdrawShielded(device, await userCoinPublicKey(ctx), change.color, change.value, coinId(change));
    assert.equal(outcome.change, null); assert.equal(outcome.capture?.stage, 'complete');
    assert.equal(Object.keys((await account.coinStore()).coins).length, 1);
    assert.ok((await account.coinStore()).coins[fixture.siblingId]);
    assert.equal((await account.ledgerState()).inbox_count, 3n);
    await account.reconcileChanges(device);
    assert.equal(sends, 1, 'repeated reconciliation sends nothing');
    for (const entry of await account.changeJournal()) {
      receipt.transactions.push(await confirmTransaction(entry.transactionIds[0], true));
      if (entry.recovery.backfill) receipt.transactions.push(await confirmTransaction(entry.recovery.backfill.transactionIds[0], true));
    }
    receipt.steps.push({ phase, result: 'PASS', sends, recoveredChangeSpent: true, siblingPreserved: true, duplicateAppends: 0 });
  } else {
    assert.ok(receipt.steps.some((step: any) => step.phase === 'finish' && step.result === 'PASS'),
      'the grant phase requires a completed finish phase');
    assert.ok(!receipt.steps.some((step: any) => step.phase === 'grant' && step.result === 'PASS'),
      'the grant phase has already consumed the saved sibling');
    await account.reconcileChanges(device);
    assert.equal(sends, 0, 'completed owner history is replayed without sending');
    const before = await account.ledgerState();
    const sibling = await account.heldCoin(Buffer.from(fixture.siblingId.split(':')[1], 'hex'), fixture.siblingId);
    assert.equal(sibling.value, 100n);
    const grantee = new JubjubGrantee(11n); // Public test credential.
    const origin = originHash('https://durable-grant.localhost'), slot = 1n;
    const salt = new Uint8Array(randomBytes(32));
    const encKey = await account.encKey();
    const scope = spendScope({ withdrawShielded: true, color: sibling.color,
      cap: 40n, perCallCap: 40n, maxCoinValue: 100n, expiresAt: 0n,
      readPkHash: new Uint8Array(createHash('sha256').update(encKey).digest()) });
    const grantId = account.grantIdOf(grantee, origin, slot);
    const issued = await account.issueGrant(device, grantId, scope, salt);
    receipt.transactions.push(await confirmTransaction(issued.txId, true));
    assert.equal((await account.ledgerState()).inbox_count, before.inbox_count,
      'grant issuance adds no recovery entry');
    assert.equal(sends, 1, 'grant issuance is one transaction');

    // Match the pinned Compact kernel's change nonce evolution. The durable
    // client verifies this ciphertext against the actual private circuit result.
    const tag = new TextEncoder().encode('midnight:kernel:nonce_evolve/2');
    const fieldMaximum = 52435875175126190479447740508185965837690552500527637822603658699938581184512n;
    const predicted = { nonce: upgradeFromTransient(transientHash(new CompactTypeVector(2, CompactTypeField), [
      convertBytesToUint(fieldMaximum, tag.length, tag, 'Field', '<standard library>'),
      degradeToTransient(sibling.nonce),
    ])), color: sibling.color, value: sibling.value - 40n };
    const entry = sealInboxEntry(encKey, predicted);
    const outcome = await account.withdrawShieldedWithGrant(grantee, openingOf(scope, salt, origin, slot),
      await userCoinPublicKey(ctx), sibling.color, 40n, entry, encKey, { coinId: fixture.siblingId });
    assert.ok(outcome.change);
    assert.equal(coinId(outcome.change), coinId(predicted));
    assert.equal(outcome.change.value, 60n);
    assert.equal(outcome.capture?.stage, 'complete');
    assert.equal(outcome.capture?.recovery.mode, 'grant');
    assert.equal(outcome.capture?.recovery.recorded, true);
    assert.equal(outcome.capture?.recovery.status, 'complete');
    assert.equal(outcome.capture?.recovery.backfill, undefined, 'grant publication is already atomic');
    const after = await account.ledgerState();
    assert.equal(after.inbox_count, before.inbox_count + 1n);
    assert.deepEqual(after.inbox.lookup(before.inbox_count), entry);
    const held = await account.coinStore();
    assert.ok(!held.coins[fixture.siblingId], 'only the chosen sibling input is retired');
    assert.ok(held.coins[coinId(predicted)], 'verified grant change is adopted');
    assert.equal(Object.keys(held.coins).length, 1);
    assert.equal(coinId(openInboxEntry(Buffer.from(held.encSecretKeyHex!, 'hex'), entry)!), coinId(predicted));
    assert.equal(sends, 2, 'grant issuance and spend need no separate append');
    await account.reconcileChanges(device);
    await account.reconcileChanges(device);
    assert.equal(sends, 2, 'repeated grant reconciliation sends nothing');
    assert.equal((await account.ledgerState()).inbox_count, before.inbox_count + 1n);
    receipt.transactions.push(await confirmTransaction(outcome.txId, true));
    receipt.steps.push({ phase, result: 'PASS', sends, atomicInboxIncrement: 1,
      grantChangeCaptured: true, duplicateAppends: 0, reconciliationSends: 0 });
  }
  receipt.status = phase === 'finish' || phase === 'grant' ? 'PASS' : 'IN_PROGRESS';
  receipt.lastUpdated = new Date().toISOString();
  await writeFile(receiptPath, json(receipt), { mode: 0o600 });
  console.log(`durable-change-localnet ${phase}: PASS`);
}

try { await main(); process.exit(0); }
catch (error) {
  console.error(error);
  receipt.status = 'FAIL'; receipt.failedPhase = phase;
  await writeFile(receiptPath, json(receipt), { mode: 0o600 }).catch(() => undefined);
  process.exit(1);
}
