/** Independent processes exercise viewing-only recovery and an external spend.
 * The fixture uses public development funding and credentials on loopback only. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setupWallet, compiledAccountContract, deployFaucet } from '../node/setup.js';
import { CONFIG, zkConfigPath } from '../node/wallet.js';
import { createFileChangeJournalStore } from '../node/change-journal-store.js';
import { CustodyAccount } from '../wallet/account.js';
import { createSdkChangeAdapter } from '../wallet/sdk-change-adapter.js';
import { createSdkChainRecoveryAdapter } from '../wallet/sdk-chain-recovery.js';
import { JubjubDevice } from '../wallet/signer.js';
import { generateEncKeyPair, sealInboxEntry } from '../wallet/inbox.js';
import { coinId, emptyCoinStore } from '../wallet/witnesses.js';
import type { CoinSearchCursor } from '../wallet/chain-recovery.js';
import { mintToUser, userCoinPublicKey } from './flow.js';
import { confirmTransaction } from './instrumentation.js';

const phase = process.argv[2];
const directory = resolve(process.argv[3] ?? '.chain-recovery-localnet');
const fixturePath = resolve(directory, 'private-fixture.json');
const profilePath = resolve(directory, 'viewing-profile.json');
const receiptPath = resolve(directory, 'receipt.json');
const publicSeed = '0'.repeat(63) + '1';
const json = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2);
let receipt: any = { scenario: 'chain-recovery-localnet', steps: [], transactions: [], sources: {} };

async function rpc(method: string, params: unknown[]) {
  const response = await fetch(CONFIG.node, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok);
  const body: any = await response.json();
  assert.equal(body.error, undefined);
  return body.result;
}

function recoveryAdapter(networkId: string, zkConfigProvider = new NodeZkConfigProvider(zkConfigPath)) {
  return createSdkChainRecoveryAdapter({ networkId, nodeUrl: CONFIG.node, indexerUrl: CONFIG.indexer,
    indexerWsUrl: CONFIG.indexerWS, proofServerUrl: CONFIG.proofServer, zkConfigProvider });
}

async function durableOptions(networkId: string, key: Uint8Array, suffix: string) {
  const journalStore = await createFileChangeJournalStore({ directory: resolve(directory, suffix), encryptionKey: key });
  return { networkId, journalStore, adapter: context => createSdkChangeAdapter({ ...context,
    indexerUrl: CONFIG.indexer, proofServerUrl: CONFIG.proofServer }) };
}

/** No funding wallet, original signing credential, original private store, or
 * journal is loaded by a viewing-only process. SDK attachment may generate an
 * unused maintenance key locally; no original authority or signature is needed. */
function viewingProviders() {
  const privateStates = new Map<string, unknown>();
  let address = '', writes = 0, signOrSubmitCalls = 0;
  const forbid = () => { signOrSubmitCalls++; throw new Error('viewing-only recovery requested signing or submission'); };
  const providers = {
    privateStateProvider: {
      setContractAddress(value: string) { address = value; },
      async get(id: string) { return structuredClone(privateStates.get(`${address}:${id}`)); },
      async set(id: string, state: unknown) { writes++; privateStates.set(`${address}:${id}`, structuredClone(state)); },
      async getSigningKey() { return undefined; },
      async setSigningKey() { /* An unused SDK attachment key is not account authority. */ },
    },
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider: new NodeZkConfigProvider(zkConfigPath),
    walletProvider: { supportedVersions: ['v9'], getCoinPublicKey: forbid, getEncryptionPublicKey: forbid, balanceTx: forbid },
    proofProvider: { supportedVersions: ['v9'], proveTx: forbid },
    midnightProvider: { supportedVersions: ['v9'], submitTx: forbid },
  };
  return { providers, writes: () => writes, forbiddenCalls: () => signOrSubmitCalls };
}

async function publicStateHash(account: CustodyAccount) {
  const state = await account.providers.publicDataProvider.queryContractState(account.address);
  assert.ok(state);
  return createHash('sha256').update(state.serialize()).digest('hex');
}

async function main() {
  assert.ok(['provision', 'recover', 'external-spend', 'recover-again'].includes(phase), 'unknown phase');
  assert.equal(CONFIG.networkId, 'undeployed', 'public development network only');
  assert.equal(process.env.WALLET_SEED ?? publicSeed, publicSeed, 'public development funding only');
  for (const endpoint of [CONFIG.node, CONFIG.indexer, CONFIG.indexerWS, CONFIG.proofServer]) {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname), 'loopback services only');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (phase !== 'provision') receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.sources[phase] = Object.fromEntries(await Promise.all([
    'src/tests/chain-recovery-localnet.ts', 'src/wallet/account.ts', 'src/wallet/chain-recovery.ts',
    'src/wallet/sdk-chain-recovery.ts', 'src/wallet/sdk-change-adapter.ts',
  ].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));

  if (phase === 'provision') {
    const networkId = String(await rpc('chain_getBlockHash', [0])).replace(/^0x/, '').toLowerCase();
    const ctx = await setupWallet(publicSeed);
    const compiled = compiledAccountContract(), device = new JubjubDevice(7n);
    const encKeys = generateEncKeyPair(), journalKey = randomBytes(32);
    const account = await CustodyAccount.deploy(ctx.providers, compiled, device, encKeys,
      { durableChanges: await durableOptions(networkId, journalKey, 'owner-journal') });
    const fixture: any = { address: account.address, privateStateId: account.privateStateId,
      journalKeyHex: journalKey.toString('hex'), networkId };
    await writeFile(fixturePath, json(fixture), { mode: 0o600 });
    await writeFile(profilePath, json({ address: account.address, networkId,
      viewingSecretHex: Buffer.from(encKeys.secretKey).toString('hex') }), { mode: 0o600 });
    const faucet = await deployFaucet(ctx.walletCtx);
    const qualification = createSdkChangeAdapter({ providers: ctx.providers, compiledContract: compiled,
      address: account.address, privateStateId: account.privateStateId,
      indexerUrl: CONFIG.indexer, proofServerUrl: CONFIG.proofServer });
    const deposits = [];
    for (const value of [600n, 200n]) {
      const coin = await mintToUser(ctx, faucet, '0'.repeat(62) + '61', value);
      const { txId } = await account.depositShielded(coin, sealInboxEntry(encKeys.publicKey, coin));
      const qualified = await qualification.qualify(coin, [txId]);
      await account.putCoin({ ...qualified, mtIndex: qualified.mt_index });
      deposits.push(coinId(coin));
      receipt.transactions.push(await confirmTransaction(txId, true));
    }
    const first = await account.heldCoin(Buffer.from(deposits[0].split(':')[1], 'hex'), deposits[0]);
    const spent = await account.withdrawShielded(device, await userCoinPublicKey(ctx), first.color, 100n, deposits[0]);
    assert.ok(spent.change); assert.equal(spent.change.value, 500n); assert.equal(spent.capture?.stage, 'complete');
    fixture.originalId = deposits[0]; fixture.siblingId = deposits[1]; fixture.changeId = coinId(spent.change);
    await writeFile(fixturePath, json(fixture), { mode: 0o600 });
    assert.equal((await account.ledgerState()).inbox_count, 3n);
    receipt.transactions.push(await confirmTransaction(spent.txId, true));
    receipt.transactions.push(await confirmTransaction(spent.capture!.recovery.backfill!.transactionIds[0], true));
    receipt.steps.push({ phase, result: 'PASS', deposits: 2, liveCoins: 2, spentCoins: 1, ownerBackfill: true });
  } else if (phase === 'external-spend') {
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    const ctx = await setupWallet(publicSeed), device = new JubjubDevice(7n);
    let sends = 0;
    const submit = ctx.providers.midnightProvider.submitTx.bind(ctx.providers.midnightProvider);
    ctx.providers.midnightProvider.submitTx = async (...args: any[]) => { sends++; return submit(...args); };
    // A new writer profile proves this spend is absent from the original store's
    // local spent markers. Its coin description is reconstructed from the chain.
    const account = await CustodyAccount.connect(ctx.providers, compiledAccountContract(), profile.address,
      emptyCoinStore(Buffer.from(profile.viewingSecretHex, 'hex')), { privateStateId: `external-${randomUUID()}`,
        durableChanges: await durableOptions(profile.networkId, randomBytes(32), 'external-journal') });
    const recovered = await account.recoverHoldings(recoveryAdapter(profile.networkId, ctx.providers.zkConfigProvider),
      { networkId: profile.networkId, maxEntries: 4096, maxCoinIndices: 4096, apply: true });
    const change = recovered.holdings.find(holding => holding.id === fixture.changeId);
    assert.equal(change?.status, 'live'); assert.equal(sends, 0);
    const spent = await account.withdrawShielded(device, await userCoinPublicKey(ctx), change!.coin.color, 500n, fixture.changeId);
    assert.equal(spent.change, null); assert.equal(spent.capture?.stage, 'complete');
    receipt.transactions.push(await confirmTransaction(spent.txId, true));
    const before = await account.ledgerState();
    const bogus = { nonce: new Uint8Array(randomBytes(32)), color: change!.coin.color, value: 900n };
    fixture.bogusId = coinId(bogus);
    const appendedBogus = await account.appendInbox(device, sealInboxEntry(await account.encKey(), bogus));
    const duplicate = await account.appendInbox(device, before.inbox.lookup(1n));
    receipt.transactions.push(await confirmTransaction(appendedBogus.txId, true));
    receipt.transactions.push(await confirmTransaction(duplicate.txId, true));
    await writeFile(fixturePath, json(fixture), { mode: 0o600 });
    assert.equal((await account.ledgerState()).inbox_count, 5n); assert.equal(sends, 3);
    receipt.steps.push({ phase, result: 'PASS', recoveredCoinSpent: true, authenticatedBogusEntries: 1, duplicateEntries: 1, sends });
  } else {
    // The recovery inputs contain only an address, network identity, and viewing
    // capability. Expected private identities are loaded only after scanning.
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    const reader = viewingProviders();
    const account = await CustodyAccount.connect(reader.providers, compiledAccountContract(), profile.address,
      emptyCoinStore(Buffer.from(profile.viewingSecretHex, 'hex')));
    assert.equal(Object.keys((await account.coinStore()).coins).length, 0);
    const before = await publicStateHash(account), initialWrites = reader.writes();
    const adapter = recoveryAdapter(profile.networkId, reader.providers.zkConfigProvider);
    const base = { networkId: profile.networkId, maxEntries: 4096, maxCoinIndices: 4096 };
    const report = await account.recoverHoldings(adapter, base);
    console.log('recovery observations:', json(report.holdings.map(holding => ({
      value: holding.coin.value, status: holding.status, reason: holding.reason,
    }))));
    assert.equal(reader.writes(), initialWrites, 'read-only scan does not alter private inventory');
    assert.equal(reader.forbiddenCalls(), 0, 'viewing recovery signs and submits nothing');
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    const status = (id: string) => report.holdings.find(holding => holding.id === id)?.status;
    assert.equal(status(fixture.originalId), 'spent'); assert.equal(status(fixture.siblingId), 'live');
    assert.equal(status(fixture.changeId), phase === 'recover' ? 'live' : 'spent');
    assert.equal(report.verifiedSubtotal.length, 1);
    assert.equal(report.verifiedSubtotal[0].value, phase === 'recover' ? 700n : 200n);
    const real = report.holdings.find(holding => holding.status === 'live')!;
    assert.ok(real.qualifiedCoin);
    const invented = { ...real.coin, nonce: real.coin.nonce.slice() };
    invented.nonce[0] ^= 1;
    const snapshot = await adapter.openSnapshot({ address: profile.address, blockHash: report.scope.blockHash });
    const wrongDescription = await snapshot.inspect(invented,
      { hints: [real.qualifiedCoin.mt_index], maxIndices: 4096 });
    assert.equal(wrongDescription.status, 'unknown', 'an occupied index cannot qualify an invented coin');
    assert.ok(wrongDescription.status === 'unknown');
    assert.equal(wrongDescription.reason, 'no verified commitment position in completed tree search',
      'a transport failure must not stand in for the occupied-index negative control');
    let searchCursor: CoinSearchCursor | undefined, sawTreeCursor = false, treeContinuationVerified = false;
    for (let attempt = 0; attempt < 4096; attempt++) {
      const bounded = await account.recoverHoldings(adapter, { ...base, maxCandidates: 1, maxCoinIndices: 1,
        cursor: { version: 1, scope: report.scope, nextInboxIndex: report.coverage.inboxCount },
        candidates: [{ coin: real.coin, ...(searchCursor ? { searchCursor } : {}) }] });
      assert.equal(bounded.holdings.length, 1);
      assert.equal(bounded.coverage.openedEntries, 0, 'tree continuation does not rescan the inbox');
      const holding = bounded.holdings[0];
      assert.equal(holding.id, real.id);
      if (holding.status === 'live') {
        assert.equal(holding.qualifiedCoin!.mt_index, real.qualifiedCoin.mt_index);
        treeContinuationVerified = true;
        break;
      }
      assert.equal(holding.status, 'unknown');
      assert.ok(holding.searchCursor, 'unfinished bounded search must retain its continuation');
      searchCursor = holding.searchCursor;
      if (searchCursor.mode === 'tree') sawTreeCursor = true;
    }
    assert.ok(sawTreeCursor, 'the live control must exercise a tree continuation');
    assert.ok(treeContinuationVerified, 'bounded tree recovery must finish within the local fixture limit');
    assert.equal(reader.writes(), initialWrites, 'bounded reconstruction leaves private inventory untouched');
    if (phase === 'recover-again') {
      assert.equal(status(fixture.bogusId), 'unknown');
      assert.equal(report.coverage.complete, false);
      assert.equal(report.coverage.duplicateDescriptions, 1);
      assert.equal(report.holdings.length, 4);
    } else assert.equal(report.coverage.complete, true);
    const wrongKey = await account.recoverHoldings(adapter, { ...base, viewingKeys: [randomBytes(32)] });
    assert.equal(wrongKey.coverage.currentViewingKeyAvailable, false);
    assert.equal(wrongKey.coverage.complete, false); assert.equal(wrongKey.holdings.length, 0);
    const firstPage = await account.recoverHoldings(adapter, { ...base, maxEntries: 1 });
    assert.equal(firstPage.coverage.complete, false); assert.ok(firstPage.cursor);
    const rest = await account.recoverHoldings(adapter, { ...base, cursor: firstPage.cursor! });
    assert.equal(rest.coverage.reachedInboxEnd, true); assert.equal(rest.coverage.complete, false);
    assert.deepEqual([...new Set([...firstPage.holdings, ...rest.holdings].map(h => h.id))].sort(), report.holdings.map(h => h.id).sort());
    const applied = await account.recoverHoldings(adapter, { ...base, apply: true,
      cursor: { version: 1, scope: report.scope, nextInboxIndex: '0' } });
    const restored = await account.coinStore();
    assert.equal(Object.keys(restored.coins).length, phase === 'recover' ? 2 : 1);
    assert.ok(restored.spentCoins[fixture.originalId]); assert.ok(restored.coins[fixture.siblingId]);
    if (phase === 'recover-again') {
      assert.ok(restored.spentCoins[fixture.changeId]); assert.equal(restored.coins[fixture.bogusId], undefined);
    }
    await account.recoverHoldings(adapter, { ...base, apply: true,
      cursor: { version: 1, scope: report.scope, nextInboxIndex: '0' } });
    assert.deepEqual(await account.coinStore(), restored, 'repeated application is idempotent');
    assert.equal(reader.forbiddenCalls(), 0); assert.equal(await publicStateHash(account), before);
    receipt.steps.push({ phase, result: 'PASS', blockHash: report.scope.blockHash, blockHeight: report.scope.blockHeight,
      liveCoins: report.holdings.filter(h => h.status === 'live').length, spentCoins: report.holdings.filter(h => h.status === 'spent').length,
      unknownCoins: report.coverage.unknownCandidates, verifiedValue: report.verifiedSubtotal[0].value,
      completeCandidateCoverage: report.coverage.complete, noOriginalInventoryOrJournal: true, signOrSubmitCalls: reader.forbiddenCalls(),
      occupiedIndexWrongDescriptionRejected: true, treeContinuationVerified,
      wrongKeyIncomplete: true, pageCoverageExplicit: true, idempotentApplication: true,
      importedLive: applied.application!.importedLive, recordedSpent: applied.application!.recordedSpent });
  }
  receipt.status = phase === 'recover-again' ? 'PASS' : 'IN_PROGRESS';
  delete receipt.failedPhase;
  receipt.lastUpdated = new Date().toISOString();
  await writeFile(receiptPath, json(receipt), { mode: 0o600 });
  console.log(`chain-recovery-localnet ${phase}: PASS`);
}

try { await main(); process.exit(0); }
catch (error) {
  console.error(error); receipt.status = 'FAIL'; receipt.failedPhase = phase;
  await writeFile(receiptPath, json(receipt), { mode: 0o600 }).catch(() => undefined);
  process.exit(1);
}
