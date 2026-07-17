// MIP-0012 conformance — tests 7 (one-hop payment) and 8 (direct transfer).
//
//   7. A payment between two custody accounts routed per §6.6's one-hop
//      rule: A spends to a user-held key, the recipient deposits into
//      their own account in a separate transaction. No transaction in the
//      flow contains both contract addresses (INV-6).
//   8. The direct-transfer mode: ONE client-composed transaction pairing
//      A's contract-recipient spend with B's deposit claim. The
//      composition follows the validated recipe: build both unproven
//      calls, graft B's intent onto A's transaction (addIntent — a plain
//      merge duplicates the claimed output and fails balancing), prove
//      both circuits, submit. The transaction names both contract
//      addresses (the accepted linking) and no cleartext value, token
//      type, or nonce; the payee's coin is discoverable through its inbox
//      entry and spendable in a later transaction.

import { randomBytes } from 'node:crypto';
import { createUnprovenCallTx, submitTx } from '@midnight-ntwrk/midnight-js-contracts';

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence } from './evidence.js';
import {
  standardSetup,
  mintToUser,
  depositAndCapture,
  captureChange,
  withdrawShieldedWithRetry,
  userCoinPublicKey,
} from './flow.js';
import { deployAccount, compiledAccountContract } from '../node/setup.js';
import { CustodyAccount } from '../wallet/account.js';
import { Device, challenges } from '../wallet/signer.js';
import { generateEncKeyPair, sealInboxEntry } from '../wallet/inbox.js';
import { inboxWalk } from '../wallet/discovery.js';
import { candidateIndices } from '../wallet/capture.js';
import { fetchTxArtefacts, needlesFor, scan, anyHit } from './observer.js';
import { bytesToHex } from '../wallet/hex.js';

const COLOR_SEED = '0'.repeat(62) + '43';
const FUND = 900n;
const ONE_HOP = 200n;
const DIRECT = 150n;

await runScenario('custody-payments', async () => {
  const s = await standardSetup();
  const userCpk = await userCoinPublicKey(s.ctx);
  const details: Record<string, unknown> = { accountA: s.account.address };

  step('deploy account B (own device and encryption key)');
  const deviceB = Device.generate();
  const encKeysB = generateEncKeyPair();
  const accountB = await deployAccount(s.ctx, deviceB, encKeysB);
  details.accountB = accountB.address;
  console.log(`  account B @ ${accountB.address}`);

  step('fund A: mint, deposit, capture');
  const coin = await mintToUser(s.ctx, s.faucet, COLOR_SEED, FUND);
  const dep = await depositAndCapture(s.account, s.encKeys, coin);

  // Both contract addresses as scan needles (hex, no 0x).
  const addrA = s.account.address.replace(/^0x/, '').toLowerCase();
  const addrB = accountB.address.replace(/^0x/, '').toLowerCase();
  const containsBoth = (surfaces: Record<string, string>) => {
    const all = Object.values(surfaces).join('').toLowerCase();
    return { a: all.includes(addrA), b: all.includes(addrB) };
  };

  // ── Test 7: one-hop payment (INV-6) ───────────────────────────────────────

  step('test 7 hop 1: A spends 200 to a user-held key');
  const hop1 = await withdrawShieldedWithRetry(
    s.account, s.device, userCpk, coin, ONE_HOP, dep.candidates,
  );
  details.hop1Tx = hop1.txId;
  if (!hop1.change) throw new Error('expected change from the partial spend');
  // Maintain A's store per the change rule.
  await s.account.dropCoin(coin.color);
  const hop1Change = await captureChange(s.account, s.device, s.encKeys, hop1.txId, hop1.change);
  console.log('  waiting 15s for the wallet to index the received coin...');
  await sleep(15_000);

  step('test 7 hop 2: the recipient deposits 200 into account B (separate tx)');
  // The depositor constructs a fresh output funded from the wallet's
  // holdings — the standard wallet-deposit flow.
  const hopCoin = { nonce: new Uint8Array(randomBytes(32)), color: coin.color, value: ONE_HOP };
  const entryB = sealInboxEntry(encKeysB.publicKey, hopCoin);
  const hop2 = await accountB.depositShielded(
    { nonce: hopCoin.nonce, color: hopCoin.color, value: hopCoin.value },
    entryB,
  );
  details.hop2Tx = hop2.txId;
  await waitForLedger(() => accountB.ledgerState(), 'B inbox grew', (l) => l.inbox_count === 1n);

  step('test 7 audit: no transaction in the flow contains both contract addresses');
  const hop1Surfaces = await fetchTxArtefacts(hop1.txId);
  const hop2Surfaces = await fetchTxArtefacts(hop2.txId);
  const hop1Hits = containsBoth(hop1Surfaces.surfaces);
  const hop2Hits = containsBoth(hop2Surfaces.surfaces);
  details.oneHopAudit = { hop1: hop1Hits, hop2: hop2Hits };
  if (hop1Hits.a && hop1Hits.b) throw new Error('hop 1 names both contract addresses (INV-6)');
  if (hop2Hits.a && hop2Hits.b) throw new Error('hop 2 names both contract addresses (INV-6)');
  console.log(`  ✓ hop1 names {A:${hop1Hits.a}, B:${hop1Hits.b}}, hop2 names {A:${hop2Hits.a}, B:${hop2Hits.b}}`);

  // ── Test 8: direct transfer (one composed transaction) ────────────────────

  step('test 8: compose A.withdraw_shielded_to_contract(B, 150) with B’s claim');
  const pointAt = async (address: string) => {
    const p = s.ctx.providers.privateStateProvider;
    if (typeof p.setContractAddress === 'function') await p.setContractAddress(address);
  };

  // A's held coin is hop1's change; its mt_index resolves by candidate
  // retry around the whole compose-and-submit pipeline (a wrong candidate
  // fails at proving inside submitTx, before any transaction exists).
  let composedTxId: string | null = null;
  let sent: any = null;
  let changeA: any = null;
  const composeAttempts: Array<Record<string, string>> = [];
  for (const idx of hop1Change.candidates) {
    await s.account.putCoin({ ...hop1.change, mtIndex: idx });

    const ctxA = await s.account.callContext();
    const authA = s.device.sign(
      challenges.withdrawShieldedToContract(ctxA, s.device.pk, accountB.addressBytes, coin.color, DIRECT),
    );
    await pointAt(s.account.address);
    const callA: any = await (createUnprovenCallTx as any)(s.ctx.providers, {
      compiledContract: compiledAccountContract(),
      circuitId: 'withdraw_shielded_to_contract',
      contractAddress: s.account.address,
      args: [
        { bytes: accountB.addressBytes },
        coin.color,
        DIRECT,
        authA.pk,
        authA.sig_r,
        authA.sig_s,
        authA.grind_nonce,
      ],
      privateStateId: s.account.privateStateId,
    });

    const resultA = callA?.private?.result;
    if (!Array.isArray(resultA) || !resultA[0]?.nonce) {
      throw new Error('[sent, change] not found on the unproven call result');
    }
    sent = resultA[0];
    changeA = resultA[1]?.is_some ? resultA[1].value : null;

    const directEntry = sealInboxEntry(encKeysB.publicKey, {
      nonce: sent.nonce,
      color: sent.color,
      value: sent.value,
    });
    await pointAt(accountB.address);
    const callB: any = await (createUnprovenCallTx as any)(s.ctx.providers, {
      compiledContract: compiledAccountContract(),
      circuitId: 'deposit_shielded',
      contractAddress: accountB.address,
      args: [{ nonce: sent.nonce, color: sent.color, value: sent.value }, directEntry],
      privateStateId: accountB.privateStateId,
    });

    const txA = callA?.private?.unprovenTx;
    const txB = callB?.private?.unprovenTx;
    if (!txA || !txB) throw new Error('unprovenTx missing from UnsubmittedCallTxData.private');
    const intentB = [...(txB.intents as Map<number, any>).values()][0];
    if (!intentB) throw new Error('cannot extract B’s intent');
    // Graft, do NOT merge: a merged transaction duplicates the claimed
    // output (B’s SDK-built call materialises its own funding copy) and
    // fails balancing. addIntent grafts the claim onto A’s balanced offer.
    const composed = txA.addIntent({ tag: 'random' }, intentB) ?? txA;

    try {
      const finalized: any = await (submitTx as any)(s.ctx.providers, {
        unprovenTx: composed,
        circuitId: ['withdraw_shielded_to_contract', 'deposit_shielded'],
      });
      composedTxId = finalized?.txId ?? finalized?.transactionHash;
      composeAttempts.push({ mtIndex: idx.toString(), outcome: `accepted: ${composedTxId}` });
      console.log(`  composed tx: ${composedTxId} (${finalized?.status})`);
      break;
    } catch (e: any) {
      composeAttempts.push({ mtIndex: idx.toString(), outcome: `rejected: ${String(e?.message).slice(0, 80)}` });
    }
  }
  details.composeAttempts = composeAttempts;
  if (!composedTxId) throw new Error(`direct transfer failed for every candidate: ${JSON.stringify(composeAttempts)}`);
  details.composedTxId = composedTxId;
  details.sent = { value: String(sent.value), nonce: bytesToHex(sent.nonce).slice(0, 16) + '…' };
  await sleep(10_000);

  const ledgerB2 = await waitForLedger(
    () => accountB.ledgerState(),
    'B claimed the direct transfer (inbox = 2)',
    (l) => l.inbox_count === 2n,
  );

  // Maintain A's coin store across the composed spend.
  await s.account.dropCoin(coin.color);
  if (changeA) {
    await captureChange(s.account, s.device, s.encKeys, composedTxId, {
      nonce: changeA.nonce,
      color: changeA.color,
      value: changeA.value,
    });
  }

  step('test 8 audit: both addresses present (accepted linking); no coin material');
  const composedSurfaces = await fetchTxArtefacts(composedTxId);
  const linkHits = containsBoth(composedSurfaces.surfaces);
  details.directAudit = { link: linkHits };
  if (!(linkHits.a && linkHits.b)) {
    throw new Error('composed tx does not name both contracts — audit surface incomplete');
  }
  const sentNeedles = needlesFor('direct-sent', { nonce: sent.nonce, color: sent.color, value: sent.value });
  const sentLeaks = Object.fromEntries(
    Object.entries(composedSurfaces.surfaces).map(([k, v]) => [k, scan(v, sentNeedles)]),
  );
  details.directLeaks = sentLeaks;
  if (Object.values(sentLeaks).some(anyHit)) {
    throw new Error('direct transfer leaked coin material');
  }
  console.log('  ✓ both addresses visible (by design); value/color/nonce hidden');

  step('test 8: B discovers through the inbox and spends the received coin in a later tx');
  const walked = inboxWalk(ledgerB2, encKeysB.secretKey);
  const received = walked.find((c) => c.value === DIRECT && bytesToHex(c.nonce) === bytesToHex(sent.nonce));
  if (!received) throw new Error('B’s inbox walk did not recover the direct-transfer coin');
  const { candidates } = await candidateIndices(composedTxId);
  let spendTx: string | null = null;
  for (const idx of candidates) {
    await accountB.putCoin({ nonce: received.nonce, color: received.color, value: received.value, mtIndex: idx });
    try {
      const r = await accountB.withdrawShielded(deviceB, userCpk, received.color, received.value);
      spendTx = r.txId;
      break;
    } catch { /* wrong candidate fails at proving; retry cannot mis-spend (INV-5) */ }
  }
  if (!spendTx) throw new Error('no candidate index produced an accepted onward spend');
  details.onwardSpendTx = spendTx;
  console.log(`  ✓ onward spend accepted — tx ${spendTx}`);

  writeEvidence({
    testId: 'CUST-7-8',
    name: 'custody-payments',
    description: 'MIP-0012 one-hop payment (INV-6) and direct transfer (composed tx)',
    verdict: 'PASS',
    note: 'One-hop: no transaction in the flow names both accounts. Direct: one composed transaction pairs the contract-recipient spend with the payee claim; both addresses visible by design, no coin material; the received coin is discoverable and spendable.',
    details,
  });
});
