// MIP-0012 conformance — test 4: third-party deposit and discovery.
//
// A second, independent wallet deposits against the advertised key; the
// owner discovers and spends using the inbox walk and chain data only
// (INV-4). The ledger forbids ciphertexts on contract-owned Zswap outputs,
// so the inbox is the depositor's only conforming channel (§6.2, R5).
//
//   1. wallet B (depositor) reads enc_key from the contract's public
//      state, mints a note, deposits it with a sealed InboxEntry;
//   2. wallet A (account owner) discovers the deposit purely from chain
//      data — the §6.5 inbox walk for the description, the indexer's
//      contract-address surface for candidate mt_index values — and spends
//      the coin with a device signature.
//
// The contract-address → transactions enumeration is itself under test: it
// is the indexer dependency MIP-0012's Path to Active records, satisfied by
// the contractActions subscription (full per-address history replay). The
// depositor-known txId remains only as a recorded fallback: reaching it
// downgrades the verdict to PARTIAL, not a scaffold bug.

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, classifySpendError } from './evidence.js';
import { standardSetup, mintToUser, userCoinPublicKey } from './flow.js';
import { setupWallet, connectAccount, deployFaucet } from '../node/setup.js';
import { sealInboxEntry } from '../wallet/inbox.js';
import { inboxWalk } from '../wallet/discovery.js';
import { candidateIndices, enumerateContractActions } from '../wallet/capture.js';
import { emptyCoinStore } from '../wallet/witnesses.js';
import { bytesToHex } from '../wallet/hex.js';

const COLOR_SEED = '0'.repeat(62) + '51';
const AMOUNT = 350n;

await runScenario('custody-discovery', async () => {
  const details: Record<string, unknown> = {};

  step('wallet A: deploy the account (owns the encryption secret and the device)');
  const a = await standardSetup();
  details.account = a.account.address;

  step('wallet B: independent wallet deposits using only public chain data');
  const seedB = process.env.WALLET_SEED_SECONDARY;
  if (!seedB) throw new Error('WALLET_SEED_SECONDARY env var required');
  const b = await setupWallet(seedB);
  const faucetB = await deployFaucet(b.walletCtx);
  const coin = await mintToUser(b, faucetB, COLOR_SEED, AMOUNT);
  details.mintTx = coin.mintTx;

  // B learns the encryption key FROM THE LEDGER — the advertised-key channel.
  const accountForB = await connectAccount(b, a.account.address, emptyCoinStore());
  const ledgerSeenByB = await accountForB.ledgerState();
  const advertisedKey = ledgerSeenByB.enc_key;
  details.advertisedKeyHex = bytesToHex(advertisedKey);
  const entry = sealInboxEntry(advertisedKey, coin);
  const dep = await accountForB.depositShielded(
    { nonce: coin.nonce, color: coin.color, value: coin.value },
    entry,
  );
  details.depositTx = dep.txId;
  console.log(`  B deposited ${AMOUNT} — tx ${dep.txId}`);

  step('wallet A: the inbox walk recovers the coin description (INV-4)');
  const l = await waitForLedger(
    () => a.account.ledgerState(),
    'inbox_count === 1 (A sees the deposit)',
    (x) => x.inbox_count === 1n,
  );
  const walked = inboxWalk(l, a.encKeys.secretKey);
  if (walked.length !== 1) throw new Error(`inbox walk found ${walked.length} coins, expected 1`);
  const discovered = walked[0];
  const matches =
    bytesToHex(discovered.color) === bytesToHex(coin.color) && discovered.value === coin.value;
  details.discoveredCoin = { colorHex: bytesToHex(discovered.color), value: String(discovered.value), matches };
  if (!matches) throw new Error('inbox walk did not recover the deposited coin');
  console.log('  ✓ inbox walk recovered the exact coin');

  step('wallet A: enumerate the contract history from its address alone');
  console.log('  waiting 10s for the indexer to settle...');
  await sleep(10_000);

  const candidateSets: Array<{ source: string; candidates: bigint[] }> = [];
  try {
    const history = await enumerateContractActions(a.account.address);
    details.enumeratedActions = history.map((h) => ({
      kind: h.kind,
      entryPoint: h.entryPoint ?? null,
      txHash: h.txHash,
      identifiers: h.identifiers,
      blockHeight: h.blockHeight,
      window: h.startIndex != null ? `[${h.startIndex}, ${h.endIndex})` : null,
    }));
    console.log(`  contractActions replayed ${history.length} action(s):`);
    for (const h of history)
      console.log(`    block ${h.blockHeight}  ${h.kind}${h.entryPoint ? ' ' + h.entryPoint : ''}`);

    // The conformance point: B's depositing transaction is reachable from
    // the contract address alone, with no off-band channel. The wallet's
    // txId is a transaction identifier, not the hash; RegularTransaction
    // carries all identifiers, so match there.
    const depId = dep.txId.replace(/^0x/, '');
    const depositSeen = history.some((h) => h.identifiers.includes(depId));
    details.depositTxEnumerated = depositSeen;
    if (!depositSeen)
      throw new Error(`the enumerated history does not contain the deposit tx ${dep.txId}`);
    console.log('  ✓ the deposit transaction appears in the enumerated history');

    // Newest first: the deposit is the most recent action, so its position
    // window is tried before the deploy/activation windows (usually empty).
    for (const h of [...history].reverse()) {
      const candidates: bigint[] = [];
      for (let i = h.startIndex ?? 0; i < (h.endIndex ?? 0); i++) candidates.push(BigInt(i));
      if (candidates.length)
        candidateSets.push({
          source: `enumerated ${h.kind}${h.entryPoint ? ' ' + h.entryPoint : ''} @ block ${h.blockHeight}`,
          candidates,
        });
    }
  } catch (e: any) {
    details.enumerationError = e?.message ?? String(e);
  }

  if (!candidateSets.length) {
    details.discoveryGap =
      'contract-address enumeration yielded no usable candidates; ' +
      'fell back to the depositor-known txId (the Path to Active indexer dependency)';
    const { candidates } = await candidateIndices(dep.txId);
    candidateSets.push({ source: 'fallback: depositor-supplied txId', candidates });
  }
  details.candidateSets = candidateSets.map((c) => ({ ...c, candidates: c.candidates.map(String) }));

  step('wallet A: spend the discovered coin (candidate retry cannot mis-spend, INV-5)');
  const aCpk = await userCoinPublicKey(a.ctx);
  const attempts: Array<Record<string, unknown>> = [];
  let spendTx: string | null = null;
  let mtIndexSource = '';
  outer: for (const set of candidateSets) {
    for (const idx of set.candidates) {
      await a.account.putCoin({ nonce: discovered.nonce, color: discovered.color, value: discovered.value, mtIndex: idx });
      try {
        const r = await a.account.withdrawShielded(a.device, aCpk, discovered.color, discovered.value);
        spendTx = r.txId;
        mtIndexSource = `${set.source} @ index ${idx}`;
        attempts.push({ source: set.source, mtIndex: idx.toString(), outcome: 'accepted', txId: r.txId });
        break outer;
      } catch (e: any) {
        attempts.push({
          source: set.source,
          mtIndex: idx.toString(),
          outcome: 'rejected',
          classification: classifySpendError(e),
        });
      }
    }
  }
  details.spendAttempts = attempts;
  details.mtIndexSource = mtIndexSource;
  if (!spendTx) {
    writeEvidence({
      testId: 'CUST-4',
      name: 'custody-discovery',
      description: 'MIP-0012 third-party deposit and discovery (inbox walk + chain data)',
      verdict: 'FAIL',
      errorCode: 'no-candidate-spend',
      note: 'Discovery decrypted the coin but no candidate mt_index produced an accepted spend.',
      details,
    });
    throw new Error('no candidate mt_index produced an accepted spend');
  }
  details.spendTx = spendTx;
  console.log(`  ✓ spend accepted — tx ${spendTx} (${mtIndexSource})`);

  const cleanDiscovery = !details.discoveryGap && details.depositTxEnumerated === true;
  writeEvidence({
    testId: 'CUST-4',
    name: 'custody-discovery',
    description: 'MIP-0012 third-party deposit and discovery (inbox walk + chain data)',
    verdict: cleanDiscovery ? 'PASS' : 'PARTIAL',
    txHash: String(details.spendTx),
    note: cleanDiscovery
      ? 'Full loop with no off-band channel: B deposited against the advertised key; A replayed the contract history from its address alone (contractActions subscription), recovered the coin via the inbox walk, and spent with a device signature.'
      : 'Deposit, inbox walk, and spend all conform, but contract-address enumeration did not yield the depositing transaction; discovery fell back to the depositor-known txId (the Path to Active dependency).',
    details,
  });
});
