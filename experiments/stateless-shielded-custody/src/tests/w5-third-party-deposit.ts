// W5 — third-party deposit and owner discovery, chain-data only.
//
// The ledger forbids ciphertexts on contract-owned Zswap outputs
// (MalformedOffer::ContractSentCiphertext), so a third-party depositor
// cannot use the standard encrypted coin-info channel. The stateless
// design's replacement is the app-level inbox: the depositor reads the
// account's advertised encryption key from contract state, encrypts the
// coin info, and passes it as the deposit blob.
//
// This probe proves the full loop with two wallets and NO off-band channel:
//   1. wallet B (depositor) reads enc_key from the contract's public state,
//      mints a note, deposits it with the encrypted blob;
//   2. wallet A (account owner) discovers the deposit purely from chain
//      data — inbox blob (decrypt) + deposit tx (indexer lookup by
//      contract address) for the mt_index — and spends the coin.
//
// The discovery lookup (contract address → deposit tx) is itself under
// test: the runner probes the indexer's contract-action surface and
// records what works. A missing lookup is a real finding (wallet-side
// sync requirement for C17), not a scaffold bug.

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, serialiseError, classifySpendError } from './evidence.js';
import { standardSetup, mintToUser, userCoinPublicKey } from './flow.js';
import { setupWallet, connectCustody, deployFaucet } from '../node/setup.js';
import {
  encryptCoinBlob,
  decryptCoinBlob,
  indexerUrl,
  candidateIndices,
} from '../wallet/coinstore.js';
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

await runScenario('w5-third-party-deposit', async () => {
  const details: Record<string, unknown> = {};

  step('wallet A: deploy custody (owns the encryption secret)');
  const a = await standardSetup();
  details.custodyAddress = a.custody.address;

  step('wallet B: independent wallet, deposits using only public chain data');
  const seedB = process.env.WALLET_SEED_SECONDARY;
  if (!seedB) throw new Error('WALLET_SEED_SECONDARY env var required');
  const b = await setupWallet(seedB);
  const faucetB = await deployFaucet(b.walletCtx);
  const coin = await mintToUser(b, faucetB, COLOR_SEED, AMOUNT);
  details.mintTx = coin.mintTx;

  // B learns the encryption key FROM THE LEDGER — the advertised-key channel.
  const custodyForB = await connectCustody(b, a.custody.address, emptyCoinStore());
  const ledgerSeenByB: any = await custodyForB.ledgerState();
  const advertisedKey: Uint8Array = ledgerSeenByB.enc_key;
  details.advertisedKeyHex = bytesToHex(advertisedKey);
  const blob = encryptCoinBlob(advertisedKey, coin);
  const dep = await custodyForB.depositStateless(
    { nonce: coin.nonce, color: coin.color, value: coin.value },
    blob,
  );
  details.depositTx = dep.txId;
  console.log(`  B deposited ${AMOUNT} — tx ${dep.txId}`);

  step('wallet A: discover the deposit from chain data only');
  const l = await waitForLedger(
    () => a.custody.ledgerState(),
    'inbox_count === 1 (A sees the deposit)',
    (x: any) => x.inbox_count === 1n,
  );
  const seenBlob = (l as any).inbox.lookup(0n);
  const discovered = decryptCoinBlob(a.encKeys.secretKey, seenBlob);
  details.discoveredCoin = {
    colorHex: bytesToHex(discovered.color),
    value: discovered.value,
    matches:
      bytesToHex(discovered.color) === bytesToHex(coin.color) && discovered.value === coin.value,
  };
  if (!(details.discoveredCoin as any).matches) {
    throw new Error('decrypted inbox blob does not match what B deposited');
  }
  console.log('  ✓ A decrypted the inbox blob to the exact coin');

  console.log('  waiting 10s for the indexer to settle...');
  await sleep(10_000);
  const lookup = await findContractTxs(a.custody.address);
  details.contractTxLookup = lookup.probes;

  // Gather candidate tree positions from every tx the indexer attributes to
  // the contract; a wrong candidate fails at the prover (prove-400), so the
  // retry loop cannot mis-spend. Fall back to the depositor's txId only if
  // the lookup yields nothing usable — recorded as a C17 discovery gap.
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
      'fell back to the depositor-known txId (recovery/sync needs an indexer surface or block scan)';
    const { candidates } = await candidateIndices(dep.txId);
    candidateSets.push({ source: 'fallback: depositor-supplied txId', candidates });
  }
  details.candidateSets = candidateSets.map((c) => ({ ...c, candidates: c.candidates.map(String) }));

  step('wallet A: spend the discovered coin (candidate mt_index retry)');
  const aCpk = await userCoinPublicKey(a.ctx);
  const attempts: Array<Record<string, unknown>> = [];
  let spendTx: string | null = null;
  let mtIndexSource = '';
  outer: for (const set of candidateSets) {
    for (const idx of set.candidates) {
      await a.custody.putCoin({ ...discovered, mtIndex: idx });
      try {
        const r = await a.custody.spendStateless(aCpk, discovered.color, discovered.value);
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
    details.spendError = attempts;
    writeEvidence({
      testId: 'W5',
      name: 'third-party-deposit',
      description: 'third-party deposit via advertised key + owner discovery from chain data',
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
    testId: 'W5',
    name: 'third-party-deposit',
    description: 'third-party deposit via advertised key + owner discovery from chain data',
    verdict: cleanDiscovery ? 'PASS' : 'PARTIAL',
    txHash: String(details.spendTx),
    note: cleanDiscovery
      ? 'Full loop with no off-band channel: B deposited against the advertised key; A ' +
        'discovered (inbox decrypt + indexer lookup) and spent the coin.'
      : 'Deposit, decrypt, and spend all worked, but the contract-address → tx indexer ' +
        'lookup is missing — the discovery loop needs an indexer surface or block scan ' +
        '(C17 sync finding). See details.contractTxLookup.',
    details,
  });
  await a.ctx.walletCtx.wallet.stop();
  await b.walletCtx.wallet.stop();
});
