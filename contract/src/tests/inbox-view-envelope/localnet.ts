// Experimental inbox transport with real P-256 proofs and accepted shielded
// spends. Signatures use the labelled software ES256 fixture; PRF outputs are
// synthetic. This does not claim browser PRF availability or passkey sync.
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ChargedState, ContractState, LedgerParameters, StateValue } from '@midnightntwrk/ledger-v9';
import { setupWallet, compiledAccountContract, deployFaucet } from '../../node/setup.js';
import { CONFIG } from '../../node/wallet.js';
import { allCircuits, VERIFIER_BYTE_BUDGET } from '../../wallet/wave-deploy.js';
import { CustodyAccount } from '../../wallet/account.js';
import { P256Device } from '../../wallet/signer-p256.js';
import { assertionMaterial } from '../../wallet/webauthn.js';
import { generateEncKeyPair, sealInboxEntry, openInboxEntry } from '../../wallet/inbox.js';
import { inboxWalk } from '../../wallet/discovery.js';
import { emptyCoinStore } from '../../wallet/witnesses.js';
import { enumerateContractActions } from '../../wallet/capture.js';
import { softwarePasskey, TEST_RP, TEST_ORIGIN } from '../p256-fixtures.js';
import { mintToUser, userCoinPublicKey } from '../flow.js';
import { runScenario, step } from '../runner.js';
import { serialiseError, classifySpendError } from '../evidence.js';
import { assertNodeIndexerConsistent, confirmTransaction, installTimedProver } from '../instrumentation.js';
import { LAYOUT, ENVELOPE_SIZE, ENVELOPE_VERSION, random, hex, readerFromPrf, sealViewEnvelope, openViewEnvelope,
  findCurrentEnvelope, type OpenedEnvelope } from './codec.js';
import { freshPrivateState } from './private-state.js';

const file = 'evidence/inbox-view-envelope/localnet.json';
const evidence: any = { verdict: 'RUNNING', startedAt: new Date().toISOString(),
  profile: 'experimental-e1', payloadBytes: ENVELOPE_SIZE, layout: LAYOUT,
  authenticator: 'OpenSSL software ES256 fixture; independent synthetic PRF outputs; no live browser claim',
  measurements: [], proofs: [], submissions: [], restores: [], transactions: [],
  methodology: { state: 'Serialised ledger ContractState including authentication-state changes, not physical database allocation.',
    transaction: 'Full balanced submitted transaction including proof and funding-wallet DUST overhead.',
    proving: 'Single observations including key lookup/load and local HTTP; no cold-cache or repeat-mean claim.',
    fee: 'Ledger model fees in SPECKs against indexed parameters, not a separately observed amount burnt.' } };
function save() { mkdirSync('evidence/inbox-view-envelope', { recursive: true });
  writeFileSync(file, JSON.stringify(evidence, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n'); }
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function gitEnvironment() {
  const recorded: { gitHead: string; gitDirty: boolean; gitBase?: string } = {
    gitHead: git('rev-parse', 'HEAD'), gitDirty: git('status', '--porcelain') !== '' };
  // Merge-base with the P-256 branch this experiment builds on, when known locally.
  try { recorded.gitBase = git('merge-base', 'HEAD', 'origin/nicolasdp/p256-webauthn'); } catch { /* ref absent */ }
  return recorded;
}
await runScenario('inbox-view-envelope localnet', async () => {
  let ctx: Awaited<ReturnType<typeof setupWallet>> | undefined;
  try {
    const { block } = await assertNodeIndexerConsistent('height hash ledgerParameters');
    evidence.chain = { height: block.height, hash: block.hash };
    evidence.environment = { ...gitEnvironment(),
      docker: execFileSync('docker', ['info', '--format', '{{.Architecture}} {{.NCPU}} CPUs {{.MemTotal}} memoryBytes'], { encoding: 'utf8' }).trim() };
    const params = LedgerParameters.deserialize(Buffer.from(block.ledgerParameters.replace(/^0x/, ''), 'hex'));
    evidence.ledgerParametersSha256 = createHash('sha256').update(params.serialize()).digest('hex');
    evidence.deployment = { circuitCount: allCircuits().length, verifierByteBudget: VERIFIER_BYTE_BUDGET };
    ctx = await setupWallet();
    let label = 'account deployment';
    await installTimedProver(ctx.providers, sample => { evidence.proofs.push({ label, ...sample }); save(); });
    const submit = ctx.providers.midnightProvider.submitTx.bind(ctx.providers.midnightProvider);
    ctx.providers.midnightProvider.submitTx = async (providerTx: any) => {
      const tx = providerTx.tx; // Midnight JS wraps the ledger transaction with its era.
      const row: any = { label, bytes: tx.serialize().length, sha256: createHash('sha256').update(tx.serialize()).digest('hex') };
      try { row.modelledFeeSpecks = String(tx.fees(params, true)); } catch (e) { row.feeMeasurementError = String(e); }
      evidence.submissions.push(row); save();
      const txId = await submit(providerTx); row.txId = txId; save(); return txId;
    };
    let aAvailable = true;
    const a = softwarePasskey(), b = softwarePasskey();
    const aDevice = new P256Device(a.pk, TEST_RP, TEST_ORIGIN, challenge => {
      assert.ok(aAvailable, 'A must be unavailable during fresh B restore'); return a.assertion(challenge);
    });
    const aPrf = random(), bPrf = random();
    const initialView = generateEncKeyPair();
    const account = await CustodyAccount.deploy(ctx.providers, compiledAccountContract(), aDevice, initialView);
    evidence.account = account.address;
    const context = { network: CONFIG.networkId, account: account.addressBytes, rpId: TEST_RP, origin: TEST_ORIGIN };
    const aReader = readerFromPrf(aPrf, context), bReader = readerFromPrf(bPrf, context);
    // Experiment's trusted enrolment roster: supplied by the two authenticators,
    // NOT reconstructed from arbitrary public inbox advertisements.
    const roster = { a: { readPk: aReader.publicKey, signingPk: a.pk }, b: { readPk: bReader.publicKey, signingPk: b.pk } };
    aReader.secretKey.fill(0); bReader.secretKey.fill(0);
    async function record(name: string, txId: string) {
      evidence.transactions.push({ name, ...(await confirmTransaction(txId, true)) }); save();
    }
    async function stateSize() {
      const state = await ctx!.providers.publicDataProvider.queryContractState(account.address);
      const ledger = await account.ledgerState();
      // Generated account ledger layout: state[0][2] is inbox. Serialise it
      // in a constant blank ContractState frame to exclude rolling device
      // entries and ChargedState usage annotations from the inbox delta.
      const inbox = state.data.state.asArray()[0].asArray()[2];
      assert.equal(inbox.type(), 'map'); assert.equal(BigInt(inbox.asMap().keys().length), ledger.inbox_count);
      const inboxFrame = new ContractState(); inboxFrame.data = new ChargedState(StateValue.decode(inbox.encode()));
      return { contractStateBytes: state.serialize().length, inboxFrameBytes: inboxFrame.serialize().length,
        inboxCount: String(ledger.inbox_count), authNonce: String(ledger.auth_nonce) };
    }
    async function appendEnvelope(name: string, entry: Uint8Array) {
      label = name; const before = await stateSize(), started = performance.now();
      const tx = await account.appendInbox(aDevice, entry); await record(name, tx.txId);
      const after = await stateSize();
      evidence.measurements.push({ name, payloadBytes: entry.length, before, after,
        serializedStateDelta: after.contractStateBytes - before.contractStateBytes,
        serializedInboxFrameDelta: after.inboxFrameBytes - before.inboxFrameBytes,
        wallMilliseconds: performance.now() - started }); save();
    }
    step('same account: provision A and enrol independent ES256 credential B');
    await appendEnvelope('envelope A / generation 0', await sealViewEnvelope(context, roster.a.readPk, initialView.secretKey, roster.a.signingPk));
    label = 'enrol B'; await record(label, (await account.addDevice(aDevice, b.device)).txId);
    await appendEnvelope('envelope B / generation 0', await sealViewEnvelope(context, roster.b.readPk, initialView.secretKey, roster.b.signingPk));
    label = 'faucet deployment';
    const faucet = await deployFaucet(ctx.walletCtx);
    const recipient = await userCoinPublicKey(ctx);
    label = 'mint first coin';
    const coin0 = await mintToUser(ctx, faucet, '0'.repeat(62) + 'a1', 73n);
    label = 'deposit first coin';
    await record(label, (await account.depositShielded(coin0, sealInboxEntry(initialView.publicKey, coin0))).txId);

    async function freshRestoreAndSpend(name: string) {
      aAvailable = false;
      // New providers' private state is genuinely empty and memory-only. They
      // share public network/prover and fee payer, not A's account key/coins.
      const freshProviders = { ...ctx!.providers, privateStateProvider: freshPrivateState(account.address) };
      const fresh = await CustodyAccount.connect(freshProviders, compiledAccountContract(), account.address, emptyCoinStore());
      const empty = await fresh.coinStore();
      assert.equal(empty.encSecretKeyHex, null); assert.equal(Object.keys(empty.coins).length, 0);
      const ledger = await fresh.ledgerState();
      const entries: Uint8Array[] = []; for (let i = 0n; i < ledger.inbox_count; i++) entries.push(ledger.inbox.lookup(i));
      // The only secret bootstrap input supplied is B's synthetic PRF output;
      // B's signing public key is recovered from the on-chain envelope.
      // Selection is newest-first; a decryptable envelope whose signing key
      // does not verify a fresh B assertion is skipped, not fatal.
      const reader = readerFromPrf(bPrf, context);
      const challenge = random();
      let assertion: Awaited<ReturnType<typeof b.assertion>> | undefined;
      const verifiesB = async (candidate: OpenedEnvelope) => {
        assertion ??= await b.assertion(challenge);
        try { assertionMaterial(challenge, b.policy, candidate.signingKey, assertion); return true; } catch { return false; }
      };
      const recovered = await findCurrentEnvelope(context, reader.secretKey, entries, ledger.enc_key, verifiesB);
      reader.secretKey.fill(0);
      const finalChallenge = random();
      assertionMaterial(finalChallenge, b.policy, recovered.signingKey, await b.assertion(finalChallenge));
      const restoredDevice = new P256Device(recovered.signingKey, TEST_RP, TEST_ORIGIN, b.assertion);
      await freshProviders.privateStateProvider.set(fresh.privateStateId, emptyCoinStore(recovered.viewSecret));
      const coins = inboxWalk(ledger, recovered.viewSecret); assert.equal(coins.length, 1);
      const history = await enumerateContractActions(account.address);
      const candidates = [...new Set(history.filter(h => h.entryPoint === 'deposit_shielded')
        .reverse().flatMap(h => Array.from({ length: (h.endIndex ?? 0) - (h.startIndex ?? 0) }, (_, i) => BigInt((h.startIndex ?? 0) + i))))];
      assert.ok(candidates.length, 'account-address enumeration must find commitment candidates');
      const attempts: any[] = [];
      let accepted: string | undefined;
      // Every failed attempt is classified. Only a node rejection (the
      // transaction reached the node) stops the walk; any other failure moves
      // to the next candidate, so this does not depend on prover wording.
      for (const index of candidates) {
        await fresh.putCoin({ ...coins[0], mtIndex: index });
        let tx: Awaited<ReturnType<typeof fresh.withdrawShielded>>;
        try {
          label = name; tx = await fresh.withdrawShielded(restoredDevice, recipient, coins[0].color, coins[0].value);
        } catch (e) {
          const classification = classifySpendError(e);
          attempts.push({ index, ...classification, message: serialiseError(e).message }); save();
          if (classification.outcome === 'node-rejected') throw e;
          continue;
        }
        assert.equal(tx.change, null); await record(name, tx.txId); accepted = tx.txId;
        attempts.push({ index, result: 'accepted' }); break;
      }
      if (!accepted) throw new Error(`no accepted shielded spend after ${attempts.length} candidates: ${JSON.stringify(attempts)}`);
      for (const entry of entries.filter(e => e[0] === ENVELOPE_VERSION)) assert.equal(openInboxEntry(recovered.viewSecret, entry), null);
      evidence.restores.push({ name, initiallyEmpty: true, aUnavailable: !aAvailable, account: fresh.address,
        signingKeyRecoveredFromEnvelope: true, sameEnrolledP256Key: recovered.signingKey.x === b.pk.x && recovered.signingKey.y === b.pk.y,
        decryptedCoins: coins.length, historyActions: history.length, candidateCount: candidates.length, attempts, attemptsBeyondFirst: attempts.length - 1, acceptedTx: accepted });
      recovered.viewSecret.fill(0); await freshProviders.privateStateProvider.clear(); aAvailable = true; save();
    }
    step('B restores from public inbox, empty private state and its own credential; A unavailable');
    await freshRestoreAndSpend('B fresh restore / first shielded spend');

    step('deposit another live coin, then rotate with B offline and re-encrypt its description');
    label = 'mint second coin';
    const coin1 = await mintToUser(ctx, faucet, '0'.repeat(62) + 'a2', 91n);
    label = 'deposit second coin';
    await record(label, (await account.depositShielded(coin1, sealInboxEntry(initialView.publicKey, coin1))).txId);
    const next = generateEncKeyPair();
    const envelopeA1 = await sealViewEnvelope(context, roster.a.readPk, next.secretKey, roster.a.signingPk);
    const envelopeB1 = await sealViewEnvelope(context, roster.b.readPk, next.secretKey, roster.b.signingPk);
    assert.equal(await openViewEnvelope(context, readerFromPrf(bPrf, context).secretKey, envelopeB1, initialView.publicKey), null);
    await appendEnvelope('envelope A / staged generation 1', envelopeA1);
    await appendEnvelope('envelope B / staged generation 1', envelopeB1);
    label = 'activate generation 1'; await record(label, (await account.rotateEncKey(aDevice, next.publicKey)).txId);
    label = 'backfill live coin under generation 1';
    await record(label, (await account.appendInbox(aDevice, sealInboxEntry(next.publicKey, coin1))).txId);
    step('new empty B installation restores the rotated key and spends the pre-rotation live coin');
    await freshRestoreAndSpend('B fresh restore / post-rotation shielded spend');

    step('exclude B from a later viewing generation; signing revocation is a separate operation');
    const last = generateEncKeyPair();
    await appendEnvelope('envelope A only / generation 2', await sealViewEnvelope(context, roster.a.readPk, last.secretKey, roster.a.signingPk));
    label = 'activate generation 2'; await record(label, (await account.rotateEncKey(aDevice, last.publicKey)).txId);
    const final = await account.ledgerState();
    const entries = Array.from({ length: Number(final.inbox_count) }, (_, i) => final.inbox.lookup(BigInt(i)));
    await assert.rejects(() => findCurrentEnvelope(context, readerFromPrf(bPrf, context).secretKey, entries, final.enc_key), /no current/);
    assert.deepEqual((await findCurrentEnvelope(context, readerFromPrf(aPrf, context).secretKey, entries, final.enc_key)).viewSecret, last.secretKey);
    evidence.controls = { excludedReaderCannotOpenNewGeneration: true, legacyCoinReaderSkipsEnvelopes: true,
      stagedKeyNotLive: true, oldKeyNotCurrent: true, independentP256Credentials: true };
    evidence.recovery = 'Default test deployment has no usable recovery wrap. Rotation/recovery continuity is NOT tested or claimed.';
    const envelopeCount = entries.filter(e => e[0] === ENVELOPE_VERSION).length;
    evidence.final = { account: account.address, inboxCount: String(final.inbox_count), encKey: hex(final.enc_key),
      inboxRecords: entries.length, envelopeCount, envelopeBytes: envelopeCount * ENVELOPE_SIZE,
      inboxRecordBytes: entries.length * ENVELOPE_SIZE };
    evidence.artifacts = Object.fromEntries(['account.compact', 'account-p256.compact', 'managed/account/contract/index.js'].map(p => [p,
      createHash('sha256').update(readFileSync(`contracts/${p}`)).digest('hex')]));
    evidence.verdict = 'PASS'; evidence.completedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ verdict: evidence.verdict, account: evidence.account, measurements: evidence.measurements }, null, 2));
  } catch (error) { evidence.verdict = 'FAIL'; evidence.error = serialiseError(error); save(); throw error; }
  finally { await ctx?.walletCtx.wallet.stop(); }
});
