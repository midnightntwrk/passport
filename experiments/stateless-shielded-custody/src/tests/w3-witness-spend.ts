// W3 — witness spend: the settle-it probe.
//
// Retracts-or-confirms the S5 wall on the current stack: spend a
// contract-held shielded coin whose QSCI comes from the WITNESS (wallet
// local store), not from public ledger state, and see whether the NODE
// accepts. contract-custody-feasibility S5 crashed off-chain in the
// JS↔WASM glue (never reaching the node) and FINDINGS over-read that as a
// protocol wall; OZ's stateless treasury variants assume the opposite but
// are simulator-only. This is the on-chain disambiguator.
//
//   Phase 1 — full-amount spend (no change): deposit 500, spend 500 to the
//     user. Node accept ⇒ witness-QSCI custody is REAL on this node tag.
//   Phase 2 — change chain: deposit 400, spend 150 (change 250 routed back
//     to the contract by sendShielded itself, returned to the caller through
//     the private call result), re-capture the change (candidate mt_index retry over the
//     2-commitment spend tx), spend the change. Proves custody SURVIVES
//     spends without ever touching public state. Change blob appended to
//     the inbox afterwards (append_backup) to keep the recovery channel
//     complete.
//
// Verdict: PASS = both phases; PARTIAL = phase 1 only; FAIL = node
// rejection or glue crash (classified — a glue crash escalates to W4, a
// node rejection is a protocol wall and closes the design).

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, serialiseError, classifySpendError } from './evidence.js';
import { standardSetup, mintToUser, depositAndCapture, userCoinPublicKey } from './flow.js';
import { candidateIndices, encryptCoinBlob } from '../wallet/coinstore.js';
import { bytesToHex } from '../wallet/hex.js';

const COLOR_SEED_1 = '0'.repeat(62) + '31';
const COLOR_SEED_2 = '0'.repeat(62) + '32';

await runScenario('w3-witness-spend', async () => {
  const s = await standardSetup();
  const userCpk = await userCoinPublicKey(s.ctx);
  const details: Record<string, unknown> = { custodyAddress: s.custody.address };

  // ── Phase 1 — full-amount witness spend ───────────────────────────────────
  step('phase 1: deposit 500, witness-spend 500 (no change)');
  const coin1 = await mintToUser(s.ctx, s.faucet, COLOR_SEED_1, 500n);
  const cap1 = await depositAndCapture(s, coin1);
  details.phase1 = { mintTx: coin1.mintTx, depositTx: cap1.depositTx, mtIndex: cap1.mtIndex };

  let phase1Spend;
  try {
    phase1Spend = await s.custody.spendStateless(userCpk, coin1.color, 500n);
  } catch (e: any) {
    const cls = classifySpendError(e);
    (details.phase1 as any).spendError = serialiseError(e);
    (details.phase1 as any).classification = cls;
    writeEvidence({
      testId: 'W3',
      name: 'witness-spend',
      description: 'node acceptance of witness-QSCI contract spends (S5 settle-it)',
      verdict: 'FAIL',
      errorCode: cls.errorCode,
      note: cls.note,
      details,
    });
    throw e;
  }
  (details.phase1 as any).spendTx = phase1Spend.txId;
  (details.phase1 as any).resultSurfaceProbes = phase1Spend.probes;
  (details.phase1 as any).zswapLocal = phase1Spend.zswapLocal;
  console.log(`  ✓ NODE ACCEPTED the witness-QSCI spend — tx ${phase1Spend.txId}`);
  await s.custody.dropCoin(coin1.color);
  await waitForLedger(() => s.custody.ledgerState(), 'round advanced past phase 1', (l: any) => l.round >= 2n);

  // ── Phase 2 — change chain ────────────────────────────────────────────────
  step('phase 2: deposit 400, spend 150, re-capture change 250, spend the change');
  let phase2: Record<string, unknown> = {};
  details.phase2 = phase2;
  let verdict: 'PASS' | 'PARTIAL' = 'PASS';
  let phase2Note = '';
  try {
    const coin2 = await mintToUser(s.ctx, s.faucet, COLOR_SEED_2, 400n);
    const cap2 = await depositAndCapture(s, coin2);
    phase2.mintTx = coin2.mintTx;
    phase2.depositTx = cap2.depositTx;

    const spend2 = await s.custody.spendStateless(userCpk, coin2.color, 150n);
    phase2.spendTx = spend2.txId;
    phase2.resultSurface = spend2.resultSurface;
    phase2.resultSurfaceProbes = spend2.probes;
    phase2.zswapLocal = spend2.zswapLocal;
    if (!spend2.change) {
      throw new Error(
        'the circuit result did not carry the change coin ' +
        `(probed surfaces: ${spend2.probes.map((p) => `${p.surface}=${p.present}`).join(', ')})`,
      );
    }
    console.log(`  change coin returned via ${spend2.resultSurface}: value=${spend2.change.value}`);
    if (spend2.change.value !== 250n) {
      throw new Error(`unexpected change value ${spend2.change.value}, expected 250`);
    }

    await s.custody.dropCoin(coin2.color);
    console.log('  waiting 10s for the indexer to settle the spend block...');
    await sleep(10_000);

    // The spend tx carries 2 commitments (recipient output + change);
    // candidate-retry the mt_index — a wrong index fails the in-circuit
    // Merkle proof, so mis-capture cannot mis-spend.
    const { candidates, position } = await candidateIndices(spend2.txId);
    phase2.changeCandidates = candidates.map(String);
    phase2.spendTxPosition = position;
    let changeSpendTx: string | null = null;
    const attempts: Array<Record<string, unknown>> = [];
    for (const idx of candidates) {
      await s.custody.putCoin({
        nonce: spend2.change.nonce,
        color: spend2.change.color,
        value: spend2.change.value,
        mtIndex: idx,
      });
      try {
        const r = await s.custody.spendStateless(userCpk, spend2.change.color, spend2.change.value);
        changeSpendTx = r.txId;
        attempts.push({ mtIndex: idx.toString(), outcome: 'accepted', txId: r.txId });
        break;
      } catch (e: any) {
        attempts.push({
          mtIndex: idx.toString(),
          outcome: 'rejected',
          classification: classifySpendError(e),
          error: serialiseError(e),
        });
      }
    }
    phase2.changeSpendAttempts = attempts;
    if (!changeSpendTx) throw new Error('no candidate mt_index produced an accepted change spend');
    phase2.changeSpendTx = changeSpendTx;
    console.log(`  ✓ change spend accepted — tx ${changeSpendTx}`);

    // Complete the recovery channel for the (now-spent) change coin — the
    // pattern a real wallet would follow right after learning the change.
    const backup = await s.custody.appendBackup(encryptCoinBlob(s.encKeys.publicKey, spend2.change));
    phase2.appendBackupTx = backup.txId;
  } catch (e: any) {
    verdict = 'PARTIAL';
    phase2.error = serialiseError(e);
    phase2Note = ` Phase 2 (change chain) failed: ${e?.message}.`;
    console.log(`  ✗ phase 2 failed: ${e?.message}`);
  }

  // ── Phase 3 — control comparator for the change chain ────────────────────
  // Discriminates whether a phase-2 failure is stateless-specific or a
  // generic wall for spending a sendShielded-created change coin: the
  // S6/insertCoin lifecycle verified the change's MAP entry but never
  // SPENT the change. Run the identical chain through the public path.
  step('phase 3 (control): deposit_public 400, spend 150, then spend the 250 change');
  const phase3: Record<string, unknown> = {};
  details.phase3 = phase3;
  try {
    const coin3 = await mintToUser(s.ctx, s.faucet, '0'.repeat(62) + '33', 400n);
    const dep3 = await s.custody.depositPublic(coin3);
    phase3.depositTx = dep3.txId;
    await waitForLedger(() => s.custody.ledgerState(), 'control coin registered', (l: any) =>
      l.public_coins.member(coin3.color),
    );
    const spend3a = await s.custody.spendPublic(userCpk, coin3.color, 150n);
    phase3.firstSpendTx = spend3a.txId;
    const l3 = await waitForLedger(() => s.custody.ledgerState(), 'control change re-registered (250)', (l: any) =>
      l.public_coins.member(coin3.color) && l.public_coins.lookup(coin3.color).value === 250n,
    );
    // The authoritative mt_index insertCoin recorded for the change — the
    // cross-check for the stateless path's candidate-window assumption
    // (is it inside the spend tx's [startIndex, endIndex) at all?).
    const authoritative = (l3 as any).public_coins.lookup(coin3.color);
    phase3.insertCoinMtIndex = authoritative.mt_index?.toString?.() ?? String(authoritative.mt_index);
    try {
      const { candidates, position } = await candidateIndices(spend3a.txId);
      phase3.firstSpendCandidates = candidates.map(String);
      phase3.firstSpendPosition = position;
      phase3.mtIndexInsideWindow = candidates.some((c) => c.toString() === phase3.insertCoinMtIndex);
    } catch (e: any) {
      phase3.windowCheckError = String(e?.message ?? e);
    }
    console.log(`  insertCoin mt_index for change = ${phase3.insertCoinMtIndex}; inside tx window: ${phase3.mtIndexInsideWindow}`);
    const spend3b = await s.custody.spendPublic(userCpk, coin3.color, 250n);
    phase3.changeSpendTx = spend3b.txId;
    phase3.changeSpendOutcome = 'accepted';
    console.log(`  ✓ control change spend accepted — tx ${spend3b.txId}`);
  } catch (e: any) {
    phase3.changeSpendOutcome = 'failed';
    phase3.classification = classifySpendError(e);
    phase3.error = serialiseError(e);
    console.log(`  ✗ control change spend failed: ${(phase3.classification as any).errorCode}`);
  }

  writeEvidence({
    testId: 'W3',
    name: 'witness-spend',
    description: 'node acceptance of witness-QSCI contract spends (S5 settle-it)',
    verdict,
    txHash: String((details.phase1 as any).spendTx),
    note:
      'Node ACCEPTED a contract shielded spend whose QSCI came from the witness — the S5 ' +
      '"structurally impossible" reading is refuted on this stack; stateless custody is live.' +
      phase2Note,
    details,
  });
  await s.ctx.walletCtx.wallet.stop();
  if (verdict === 'PARTIAL') throw new Error('phase 2 incomplete — see evidence');
});
