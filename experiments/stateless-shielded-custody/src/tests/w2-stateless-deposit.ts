// W2 — stateless deposit.
//
// A user deposits a shielded note into the custody contract through
// deposit_stateless: the coin is claimed (receiveShielded) and the ONLY
// thing persisted in public ledger state is the encrypted blob. The client
// captures the QSCI (mt_index from the indexer) into the wallet-local
// store. PASS requires:
//   1. the deposit transaction lands;
//   2. the contract's public state holds no QSCI (public_coins empty) and
//      inbox_count === 1;
//   3. the inbox blob round-trips: decrypting it with the account secret
//      yields exactly the deposited coin (the recovery/discovery channel
//      works);
//   4. mt_index capture from the indexer succeeds.

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { standardSetup, mintToUser, depositAndCapture } from './flow.js';
import { decryptCoinBlob } from '../wallet/coinstore.js';
import { bytesToHex } from '../wallet/hex.js';

const AMOUNT = 500n;
const COLOR_SEED = '0'.repeat(62) + '21';

await runScenario('w2-stateless-deposit', async () => {
  const s = await standardSetup();

  step(`mint ${AMOUNT} shielded to the user`);
  const coin = await mintToUser(s.ctx, s.faucet, COLOR_SEED, AMOUNT);

  step('deposit through the stateless path');
  let capture;
  try {
    capture = await depositAndCapture(s, coin);
  } catch (e: any) {
    writeEvidence({
      testId: 'W2',
      name: 'stateless-deposit',
      description: 'deposit_stateless + encrypted inbox + client-side QSCI capture',
      verdict: 'FAIL',
      errorCode: 'deposit-or-capture-failed',
      note: `Deposit or mt_index capture failed: ${e?.message}`,
      details: { error: serialiseError(e), mintTx: coin.mintTx },
    });
    throw e;
  }

  step('verify the public ledger holds no QSCI');
  const l = await waitForLedger(
    () => s.custody.ledgerState(),
    'inbox_count === 1',
    (l: any) => l.inbox_count === 1n,
  );
  const publicCoinsEmpty = (l as any).public_coins.isEmpty
    ? (l as any).public_coins.isEmpty()
    : ![...(l as any).public_coins].length;
  if (!publicCoinsEmpty) throw new Error('public_coins is not empty on the stateless path');
  console.log('  ✓ public_coins empty — no QSCI in public state');

  step('round-trip the encrypted inbox blob (discovery/recovery channel)');
  const blob = (l as any).inbox.lookup(0n);
  const recovered = decryptCoinBlob(s.encKeys.secretKey, blob);
  const match =
    bytesToHex(recovered.nonce) === bytesToHex(coin.nonce) &&
    bytesToHex(recovered.color) === bytesToHex(coin.color) &&
    recovered.value === coin.value;
  if (!match) throw new Error('decrypted inbox blob does not match the deposited coin');
  console.log('  ✓ inbox blob decrypts to the deposited coin');

  writeEvidence({
    testId: 'W2',
    name: 'stateless-deposit',
    description: 'deposit_stateless + encrypted inbox + client-side QSCI capture',
    verdict: 'PASS',
    txHash: capture.depositTx,
    note:
      'Deposit landed with no QSCI in public ledger state; the encrypted inbox blob round-trips ' +
      'to the exact coin; mt_index recovered from the indexer (startIndex inference).',
    details: {
      mintTx: coin.mintTx,
      depositTx: capture.depositTx,
      mtIndex: capture.mtIndex,
      indexerPosition: capture.position,
      custodyAddress: s.custody.address,
      colorHex: bytesToHex(coin.color),
      amount: AMOUNT,
    },
  });
  await s.ctx.walletCtx.wallet.stop();
});
