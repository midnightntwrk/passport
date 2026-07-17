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
// The contract-address → transactions lookup is itself under test: it is
// the indexer dependency MIP-0012's Path to Active records. A missing
// surface downgrades the verdict to PARTIAL, not a scaffold bug.

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, classifySpendError } from './evidence.js';
import { standardSetup, mintToUser, userCoinPublicKey } from './flow.js';
import { setupWallet, connectAccount, deployFaucet } from '../node/setup.js';
import { sealInboxEntry } from '../wallet/inbox.js';
import { inboxWalk } from '../wallet/discovery.js';
import { indexerUrl, candidateIndices } from '../wallet/capture.js';
import { emptyCoinStore } from '../wallet/witnesses.js';
import { bytesToHex } from '../wallet/hex.js';

const COLOR_SEED = '0'.repeat(62) + '51';
const AMOUNT = 350n;

/** Find transactions touching a contract via the indexer; probe query shapes. */
async function findContractTxs(address: string): Promise<{ txIds: string[]; probes: Array<Record<string, string>> }> {
  const probes: Array<Record<string, string>> = [];
  const shapes: Array<[string, string, Record<string, unknown>]> = [
    [
      'contractAction(address)',
      `query($address: HexEncoded!) {
         contractAction(address: $address) { address ... on ContractCall { transaction { hash id } } }
       }`,
      { address: address.replace(/^0x/, '') },
    ],
    [
      'contractActions(address)',
      `query($address: HexEncoded!) {
         contractActions(address: $address) { address transaction { hash id } }
       }`,
      { address: address.replace(/^0x/, '') },
    ],
  ];
  const txIds: string[] = [];
  for (const [name, query, variables] of shapes) {
    try {
      const res = await fetch(indexerUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const body: any = await res.json();
      if (body?.errors?.length) {
        probes.push({ surface: name, outcome: `GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}` });
        continue;
      }
      const data = body?.data?.contractAction ?? body?.data?.contractActions;
      const actions = Array.isArray(data) ? data : data ? [data] : [];
      const ids = actions
        .map((a: any) => a?.transaction?.id ?? a?.transaction?.hash)
        .filter(Boolean);
      probes.push({ surface: name, outcome: `ok: ${ids.length} tx(s)` });
      txIds.push(...ids);
      if (ids.length) break;
    } catch (e: any) {
      probes.push({ surface: name, outcome: `fetch failed: ${e?.message}` });
    }
  }
  return { txIds: [...new Set(txIds)], probes };
}

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

  console.log('  waiting 10s for the indexer to settle...');
  await sleep(10_000);
  const lookup = await findContractTxs(a.account.address);
  details.contractTxLookup = lookup.probes;

  const candidateSets: Array<{ source: string; candidates: bigint[] }> = [];
  for (const txId of lookup.txIds) {
    try {
      const { candidates } = await candidateIndices(txId);
      if (candidates.length) candidateSets.push({ source: `contract-tx ${txId.slice(0, 12)}…`, candidates });
    } catch { /* recorded via probes */ }
  }
  if (!candidateSets.length) {
    details.discoveryGap =
      'no indexer surface yielded usable candidates by contract address; ' +
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

  const cleanDiscovery = !details.discoveryGap;
  writeEvidence({
    testId: 'CUST-4',
    name: 'custody-discovery',
    description: 'MIP-0012 third-party deposit and discovery (inbox walk + chain data)',
    verdict: cleanDiscovery ? 'PASS' : 'PARTIAL',
    txHash: String(details.spendTx),
    note: cleanDiscovery
      ? 'Full loop with no off-band channel: B deposited against the advertised key; A discovered via the inbox walk and the indexer contract-address surface, then spent with a device signature.'
      : 'Deposit, inbox walk, and spend all conform, but the contract-address → transactions indexer surface is missing; discovery fell back to the depositor-known txId (the Path to Active dependency).',
    details,
  });
});
