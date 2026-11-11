/** Three independent localnet processes exercise current viewing restoration.
 * Public development funding and software/paper guardian fixtures only. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setupWallet, compiledAccountContract, deployFaucet } from '../node/setup.js';
import { CONFIG } from '../node/wallet.js';
import { createFileViewingKeyStore } from '../node/viewing-key-store.js';
import { createFileChangeJournalStore } from '../node/change-journal-store.js';
import { CustodyAccount } from '../wallet/account.js';
import { createSdkChangeAdapter } from '../wallet/sdk-change-adapter.js';
import { createSdkChainRecoveryAdapter } from '../wallet/sdk-chain-recovery.js';
import { JubjubDevice } from '../wallet/signer.js';
import { generateEncKeyPair, sealInboxEntry } from '../wallet/inbox.js';
import { coinId, emptyCoinStore } from '../wallet/witnesses.js';
import { newRecoverySecret, newSessionNonce, newPaperKey, deriveShare } from '../wallet/recovery.js';
import { recoveryKey } from '../wallet/recovery-gate.js';
import { viewingSnapshot, reconstructRecoverySecret, ViewingRecoveryError, type GuardianRecoveryInput } from '../wallet/viewing-recovery.js';
import { mintToUser, userCoinPublicKey } from './flow.js';
import { confirmTransaction } from './instrumentation.js';

const phase = process.argv[2];
const directory = resolve(process.argv[3] ?? '.viewing-recovery-localnet');
const recoveryPath = resolve(directory, 'guardian-recovery-profile.json');
const successorPath = resolve(directory, 'successor-profile.json');
const expectationsPath = resolve(directory, 'private-expectations.json');
const receiptPath = resolve(directory, 'receipt.json');
const publicSeed = '0'.repeat(63) + '1';
const json = (value: unknown) => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
let receipt: any = { scenario: 'viewing-recovery-localnet', steps: [], transactions: [], sources: {} };
const save = (path: string, value: unknown) => writeFile(path, json(value), { mode: 0o600 });

async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(CONFIG.node, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok);
  const body: any = await response.json(); assert.equal(body.error, undefined);
  return body.result;
}
function session(address: Uint8Array) {
  const secret = newRecoverySecret(), sessionNonce = newSessionNonce();
  const shares = Array.from({ length: 3 }, (_, index) => ({ index: index + 1,
    sigma: deriveShare(sessionNonce, address, newPaperKey()) }));
  return { recoverySecret: secret.bytes, sessionNonce, n: 3, t: 1, shares };
}
function quorum(profile: any): GuardianRecoveryInput {
  return { n: profile.n, t: profile.t, shares: profile.shares.map((share: any) => ({ index: share.index, sigma: BigInt(share.sigma) })) };
}
function recoveryAdapter(networkId: string, providers: any) {
  return createSdkChainRecoveryAdapter({ networkId, nodeUrl: CONFIG.node, indexerUrl: CONFIG.indexer,
    indexerWsUrl: CONFIG.indexerWS, proofServerUrl: CONFIG.proofServer, zkConfigProvider: providers.zkConfigProvider });
}
async function durableOptions(networkId: string, key: Uint8Array) {
  const journalStore = await createFileChangeJournalStore({ directory: resolve(directory, 'successor-journal'), encryptionKey: key });
  return { networkId, journalStore, adapter: context => createSdkChangeAdapter({ ...context,
    indexerUrl: CONFIG.indexer, proofServerUrl: CONFIG.proofServer }) };
}
async function record(txId: string) { receipt.transactions.push(await confirmTransaction(txId, true)); }
function trackSubmission(providers: any) {
  let count = 0;
  const original = providers.midnightProvider.submitTx.bind(providers.midnightProvider);
  providers.midnightProvider.submitTx = async (...args: any[]) => { count++; return original(...args); };
  return () => count;
}
const isCode = (code: string) => (error: unknown) => error instanceof ViewingRecoveryError && error.code === code;

async function main() {
  assert.ok(['provision', 'restore', 'finalise-spend'].includes(phase), 'unknown phase');
  assert.equal(CONFIG.networkId, 'undeployed', 'public development network only');
  assert.equal(process.env.WALLET_SEED ?? publicSeed, publicSeed, 'public development funding only');
  for (const endpoint of [CONFIG.node, CONFIG.indexer, CONFIG.indexerWS, CONFIG.proofServer]) {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname), 'loopback services only');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (phase !== 'provision') receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.sources[phase] = Object.fromEntries(await Promise.all([
    'src/tests/viewing-recovery-localnet.ts', 'src/wallet/account.ts', 'src/wallet/viewing-recovery.ts',
    'src/node/viewing-key-store.ts', 'src/wallet/chain-recovery.ts', 'src/wallet/sdk-chain-recovery.ts',
  ].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));

  if (phase === 'provision') {
    const networkId = String(await rpc('chain_getBlockHash', [0])).replace(/^0x/, '').toLowerCase();
    const ctx = await setupWallet(publicSeed), device = new JubjubDevice(7n);
    const enc1 = generateEncKeyPair(), birth = newRecoverySecret();
    const account = await CustodyAccount.deploy(ctx.providers, compiledAccountContract(), device, enc1,
      { recovery: { recoveryPk: recoveryKey(birth.bytes).pk, wrap: new Uint8Array(64), vetoWindowSeconds: 10n } });
    birth.bytes.fill(0);
    const ownerStore = await createFileViewingKeyStore({ directory: resolve(directory, 'owner-vault'), encryptionKey: randomBytes(32) });
    await account.persistViewingKey(enc1.secretKey, { networkId, store: ownerStore });
    const first = session(account.addressBytes);
    const initial = await account.publishViewingRecoverySession(device, first); await record(initial.txId);
    assert.equal(initial.viewingRecovery.wrap, 'verified-current');
    const enc2 = generateEncKeyPair();
    const rotated = await account.rotateEncKey(device, enc2.publicKey); await record(rotated.txId);
    const stale = await account.viewingRecoveryStatus();
    assert.equal(stale.localKey, 'stale'); assert.equal(stale.wrap, 'known-stale');
    await assert.rejects(account.restoreViewingKey(first.recoverySecret, { networkId, store: ownerStore }), isCode('stale-wrap'));
    first.recoverySecret.fill(0); enc1.secretKey.fill(0);
    await account.persistViewingKey(enc2.secretKey, { networkId, store: ownerStore });
    assert.equal((await account.viewingRecoveryStatus()).wrap, 'known-stale');
    const refreshed = session(account.addressBytes);
    await assert.rejects(account.publishViewingRecoverySession(device,
      { ...refreshed, shares: refreshed.shares.slice(0, 2) }), isCode('guardians-unavailable'));
    const published = await account.publishViewingRecoverySession(device, refreshed); await record(published.txId);
    assert.equal(published.viewingRecovery.wrap, 'verified-current');

    const faucet = await deployFaucet(ctx.walletCtx);
    const qualification = createSdkChangeAdapter({ providers: ctx.providers, compiledContract: compiledAccountContract(),
      address: account.address, privateStateId: account.privateStateId, indexerUrl: CONFIG.indexer, proofServerUrl: CONFIG.proofServer });
    const ids: string[] = [];
    for (const value of [600n, 200n]) {
      const coin = await mintToUser(ctx, faucet, '0'.repeat(62) + '62', value);
      const deposit = await account.depositShielded(coin, sealInboxEntry(enc2.publicKey, coin));
      const qualified = await qualification.qualify(coin, [deposit.txId]);
      await account.putCoin({ ...qualified, mtIndex: qualified.mt_index });
      ids.push(coinId(coin)); await record(deposit.txId);
    }
    const vaultKeyHex = randomBytes(32).toString('hex');
    await save(recoveryPath, { address: account.address, networkId, vaultKeyHex, n: refreshed.n, t: refreshed.t,
      shares: [refreshed.shares[0], refreshed.shares[2]] });
    await save(successorPath, { address: account.address, networkId, vaultKeyHex, journalKeyHex: randomBytes(32).toString('hex'), successorScalar: '11' });
    await save(expectationsPath, { originalId: ids[0], siblingId: ids[1], encPublicKeyHex: Buffer.from(enc2.publicKey).toString('hex') });
    refreshed.recoverySecret.fill(0); enc2.secretKey.fill(0);
    receipt.steps.push({ phase, result: 'PASS', staleWrapDetected: true, staleRestorationRefused: true,
      unavailableFullRosterRefused: true, freshSessionPublished: true, guardianProfile: 'indexed paper shares, n=3, t+1=2',
      deposits: 2, expectedValue: '800', originalViewingSecretsAbsentFromRecoveryProfiles: true });
  } else if (phase === 'restore') {
    const profile = JSON.parse(await readFile(recoveryPath, 'utf8'));
    const nextProfile = JSON.parse(await readFile(successorPath, 'utf8'));
    const ctx = await setupWallet(publicSeed), sends = trackSubmission(ctx.providers);
    const account = await CustodyAccount.connect(ctx.providers, compiledAccountContract(), profile.address, emptyCoinStore(),
      { privateStateId: `recover-${randomUUID()}` });
    const store = await createFileViewingKeyStore({ directory: resolve(directory, 'recovered-vault'), encryptionKey: Buffer.from(profile.vaultKeyHex, 'hex') });
    assert.equal((await account.coinStore()).encSecretKeyHex, null);
    assert.equal(Object.keys((await account.coinStore()).coins).length, 0);
    assert.equal(await store.get({ networkId: profile.networkId, address: profile.address }), null);
    const input = quorum(profile);
    await assert.rejects(account.restoreViewingKeyFromGuardians({ ...input, shares: input.shares.slice(0, 1) },
      { networkId: profile.networkId, store }), isCode('guardians-unavailable'));
    const restored = await account.restoreViewingKeyFromGuardians(input, { networkId: profile.networkId, store });
    assert.equal(restored.persisted, true); assert.equal(restored.localKey, 'current'); assert.equal(restored.wrap, 'verified-current');
    const holdings = await account.recoverHoldings(recoveryAdapter(profile.networkId, ctx.providers),
      { networkId: profile.networkId, maxEntries: 4096, maxCoinIndices: 4096, apply: true });
    assert.equal(holdings.coverage.complete, true); assert.equal(holdings.verifiedSubtotal[0].value, 800n);
    assert.equal(holdings.holdings.filter(holding => holding.status === 'live').length, 2);
    assert.equal(sends(), 0, 'restoration and reconstruction submit nothing');
    const snapshot = viewingSnapshot(account.address, await account.ledgerState());
    const secret = reconstructRecoverySecret(snapshot, input), reserved = newRecoverySecret();
    try {
      const submitted = await account.recoverSubmit(secret, new JubjubDevice(BigInt(nextProfile.successorScalar)),
        recoveryKey(reserved.bytes).pk, BigInt(Math.floor(Date.now() / 1000) + 60));
      await record(submitted.txId);
    } finally { secret.fill(0); reserved.bytes.fill(0); }
    assert.equal((await account.viewingRecoveryStatus()).pendingRecovery, true);
    assert.equal(sends(), 1);
    receipt.steps.push({ phase, result: 'PASS', noOriginalInventoryOrViewingSecret: true, insufficientQuorumRefused: true,
      restoredFromGuardianQuorum: true, persistedBeforeSubmission: true, viewingOnlySubmissions: 0, verifiedValue: '800', recoveryPending: true });
  } else {
    // This process never reads the guardian profile or the consumed recovery
    // secret. It starts with empty private state and loads only the durable key.
    const profile = JSON.parse(await readFile(successorPath, 'utf8'));
    const ctx = await setupWallet(publicSeed), successor = new JubjubDevice(BigInt(profile.successorScalar));
    const account = await CustodyAccount.connect(ctx.providers, compiledAccountContract(), profile.address, emptyCoinStore(),
      { privateStateId: `successor-${randomUUID()}`, durableChanges: await durableOptions(profile.networkId, Buffer.from(profile.journalKeyHex, 'hex')) });
    assert.equal((await account.coinStore()).encSecretKeyHex, null);
    const store = await createFileViewingKeyStore({ directory: resolve(directory, 'recovered-vault'), encryptionKey: Buffer.from(profile.vaultKeyHex, 'hex') });
    const loaded = await account.loadViewingKey({ networkId: profile.networkId, store });
    assert.equal(loaded.localKey, 'current'); assert.equal(loaded.persisted, true); assert.equal(loaded.pendingRecovery, true);
    const pending = await account.ledgerState();
    const deadline = Number(pending.pending_not_before) * 1000 + 12_000;
    while (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(deadline - Date.now(), 10_000)));
    const finalised = await account.recoverFinalise(); await record(finalised.txId);
    const status = await account.viewingRecoveryStatus();
    assert.equal(status.localKey, 'current'); assert.equal(status.pendingRecovery, false); assert.equal(status.wrap, 'absent');
    const holdings = await account.recoverHoldings(recoveryAdapter(profile.networkId, ctx.providers),
      { networkId: profile.networkId, maxEntries: 4096, maxCoinIndices: 4096, apply: true });
    assert.equal(holdings.verifiedSubtotal[0].value, 800n);
    const input = holdings.holdings.find(holding => holding.status === 'live' && holding.coin.value === 600n)!;
    assert.ok(input);
    const spent = await account.withdrawShielded(successor, await userCoinPublicKey(ctx), input.coin.color, 100n, input.id);
    assert.equal(spent.change?.value, 500n); assert.equal(spent.capture?.stage, 'complete');
    await record(spent.txId); await record(spent.capture!.recovery.backfill!.transactionIds[0]);
    const after = await account.recoverHoldings(recoveryAdapter(profile.networkId, ctx.providers),
      { networkId: profile.networkId, maxEntries: 4096, maxCoinIndices: 4096, apply: true });
    assert.equal(after.verifiedSubtotal[0].value, 700n);
    const expectations = JSON.parse(await readFile(expectationsPath, 'utf8'));
    assert.equal(after.holdings.find(holding => holding.id === expectations.originalId)?.status, 'spent');
    assert.equal(after.holdings.find(holding => holding.id === expectations.siblingId)?.status, 'live');
    const fresh = session(account.addressBytes);
    const published = await account.publishViewingRecoverySession(successor, fresh); await record(published.txId);
    assert.equal(published.viewingRecovery.wrap, 'verified-current'); fresh.recoverySecret.fill(0);
    receipt.steps.push({ phase, result: 'PASS', keyReloadedWithoutGuardianMaterial: true,
      emptyPrivateStoreReconstructed: true, finalisationPreservedCurrentViewing: true, consumedBackupReportedAbsent: true,
      successorSpentRecoveredCoin: true, durableChangeBackfilled: true, sameColourSiblingPreserved: true,
      verifiedValue: '700', freshSuccessorSessionPublished: true });
  }
  receipt.status = phase === 'finalise-spend' ? 'PASS' : 'IN_PROGRESS';
  delete receipt.failedPhase;
  receipt.lastUpdated = new Date().toISOString();
  await save(receiptPath, receipt);
  console.log(`viewing-recovery-localnet ${phase}: PASS`);
}

try { await main(); process.exit(0); }
catch (error) {
  console.error(error); receipt.status = 'FAIL'; receipt.failedPhase = phase;
  await save(receiptPath, receipt).catch(() => undefined);
  process.exit(1);
}
