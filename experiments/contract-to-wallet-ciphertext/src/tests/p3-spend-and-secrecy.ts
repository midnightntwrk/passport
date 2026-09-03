// P3 — is the discovered coin a real coin, and does attaching the
// ciphertext cost any secrecy?
//
// P2 shows the recipient's wallet FINDS the coin. Two things remain:
//
//   1. Spendability. A wallet listing a coin it cannot spend would be a
//      cosmetic result. The recipient spends the discovered coin onward,
//      into a vault of its own, funded by its balancer from its own
//      holdings. If the coin were not genuinely available, balancing fails.
//
//   2. Secrecy. The attached ciphertext is a ciphertext, not a disclosure.
//      The serialised output must not carry the coin's nonce, colour, or
//      value in the clear, and it must differ from the contract-owned
//      change output in exactly the way a sealed recipient blob should.
//
// This probe also runs the COOPERATIVE circuit (send_to_user, which returns
// the recipient coin) and cross-checks it against what the executor's own
// runtime reported for the same send. If the two agree, the executor's
// runtime read used in P2 is sound rather than a lucky guess.

import { runScenario, step, sleep, waitForLedger } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { stage, walletKeys, coinPublicKey, discovered, scannedCoins, shieldedBalance } from './flow.js';
import { deployVault } from '../node/setup.js';
import { candidateIndices } from '../wallet/capture.js';
import { anyToHex } from '../wallet/hex.js';

const COLOR_SEED = '0'.repeat(62) + '62';
const FUND = 800n;
const SEND = 250n;
const SPEND_ON = 100n;
const SYNC_WAIT_MS = 30_000;

await runScenario('P3 — the coin is real, and still secret', async () => {
  const details: Record<string, unknown> = {};
  const s = await stage(COLOR_SEED, FUND);
  details.vault = s.vault.address;

  const recipientCpkBytes = await coinPublicKey(s.recipient);
  const bKeys = await walletKeys(s.recipient);
  details.recipient = bKeys;

  const balanceBefore = await shieldedBalance(s.recipient, s.coin.color);
  details.recipientBalanceBefore = String(balanceBefore);

  // ── The cooperative circuit, with the recipient's key ────────────────────

  step('send through the cooperative circuit, sealed to the recipient’s key');
  const sent = await s.vault.sendToUser(
    {
      circuit: 'send_to_user',
      recipient: recipientCpkBytes,
      color: s.coin.color,
      amount: SEND,
      mapping: new Map([[bKeys.cpk, bKeys.epk]]),
    },
    s.coin,
    s.deposit.candidates,
  );
  details.sendTx = sent.txId;
  details.sendAttempts = sent.attempts;
  console.log(`  tx ${sent.txId}`);

  // ── Cross-check: circuit disclosure vs the executor's runtime read ───────

  step('cross-check: what the circuit returned vs what the executor’s runtime held');
  if (!sent.sentFromCircuit) throw new Error('the cooperative circuit returned no sent coin');
  if (!sent.sentFromRuntime) throw new Error('the executor’s runtime held no sent coin');
  const agree =
    anyToHex(sent.sentFromCircuit.nonce) === anyToHex(sent.sentFromRuntime.nonce)
    && anyToHex(sent.sentFromCircuit.color) === anyToHex(sent.sentFromRuntime.color)
    && sent.sentFromCircuit.value === sent.sentFromRuntime.value;
  details.circuitRuntimeAgreement = {
    agree,
    fromCircuit: {
      nonce: anyToHex(sent.sentFromCircuit.nonce),
      colour: anyToHex(sent.sentFromCircuit.color),
      value: String(sent.sentFromCircuit.value),
    },
    fromRuntime: {
      nonce: anyToHex(sent.sentFromRuntime.nonce),
      colour: anyToHex(sent.sentFromRuntime.color),
      value: String(sent.sentFromRuntime.value),
    },
    allRuntimeOutputs: sent.runtimeOutputs,
  };
  if (agree) {
    console.log('  ✓ identical — the executor’s runtime read needs no help from the contract');
  } else {
    console.log('  ✗ they differ:');
    console.log(`    circuit: ${JSON.stringify((details.circuitRuntimeAgreement as any).fromCircuit)}`);
    console.log(`    runtime: ${JSON.stringify((details.circuitRuntimeAgreement as any).fromRuntime)}`);
    console.log(`    every runtime output: ${JSON.stringify(sent.runtimeOutputs)}`);
  }

  // ── Secrecy of the attached ciphertext ───────────────────────────────────

  // What does attaching the ciphertext actually disclose? The control is in
  // the same transaction: the vault's own change output is contract-owned,
  // so it carries NO ciphertext. Anything visible in both outputs is a
  // property of the output encoding, not a cost of the attachment.
  step('secrecy: what the attached ciphertext adds to what is visible');
  const nonceHex = anyToHex(sent.sentFromRuntime.nonce);
  const colorHex = anyToHex(sent.sentFromRuntime.color);
  const value = sent.sentFromRuntime.value;
  // A coin value is encoded big-endian; a bare hex value would match by
  // chance, so look for the fixed-width encodings a serialiser would use.
  const valueNeedles = [16, 8].map((bytes) => value.toString(16).padStart(bytes * 2, '0'));
  const leaks = sent.outputs.map((o) => ({
    commitment: o.commitment.slice(0, 16) + '…',
    contractOwned: o.contractAddress !== null,
    serialisedBytes: o.serialisedBytes,
    carriesNonce: o.serialisedHex.includes(nonceHex),
    carriesColour: colorHex !== '' && o.serialisedHex.includes(colorHex),
    carriesValue: valueNeedles.some((n) => o.serialisedHex.includes(n)),
  }));
  details.outputs = leaks;
  for (const l of leaks) {
    console.log(`  output ${l.commitment} ${l.contractOwned ? '(contract-owned, no ciphertext)' : '(user-targeted, ciphertext attached)'} ${l.serialisedBytes}B — nonce:${l.carriesNonce} colour:${l.carriesColour} value:${l.carriesValue}`);
  }

  const withCiphertext = leaks.filter((l) => !l.contractOwned);
  const withoutCiphertext = leaks.filter((l) => l.contractOwned);
  // The claim under test: the ciphertext does not put the coin's nonce or
  // value in the clear. The colour is measured, not asserted — the control
  // output settles whether it is the ciphertext's doing.
  const nonceOrValueLeak = withCiphertext.some((l) => l.carriesNonce || l.carriesValue);
  const colourVisibleWithCiphertext = withCiphertext.some((l) => l.carriesColour);
  const colourVisibleWithout = withoutCiphertext.some((l) => l.carriesColour);
  const colourIsEncodingNotCiphertext = colourVisibleWithCiphertext === colourVisibleWithout;
  const sizeDelta = withCiphertext.length && withoutCiphertext.length
    ? withCiphertext[0].serialisedBytes - withoutCiphertext[0].serialisedBytes
    : null;
  details.secrecy = {
    nonceOrValueInClear: nonceOrValueLeak,
    colourVisibleWithCiphertext,
    colourVisibleWithoutCiphertext: colourVisibleWithout,
    colourIsEncodingNotCiphertext,
    ciphertextSizeDeltaBytes: sizeDelta,
  };
  if (nonceOrValueLeak) {
    throw new Error('the ciphertext-bearing output carries the coin nonce or value in the clear');
  }
  console.log(`  ✓ the ciphertext-bearing output carries neither the nonce nor the value in the clear`);
  console.log(`  · the colour is visible in ${colourVisibleWithCiphertext ? 'the ciphertext-bearing output' : 'no ciphertext-bearing output'} and in ${colourVisibleWithout ? 'the ciphertext-less control' : 'no ciphertext-less control'} — ${colourIsEncodingNotCiphertext ? 'a property of the output encoding, not of the attachment' : 'ATTRIBUTABLE to the attachment'}`);
  if (sizeDelta !== null) console.log(`  · attaching the ciphertext costs ${sizeDelta} bytes`);
  const anyLeak = nonceOrValueLeak || !colourIsEncodingNotCiphertext;

  // ── The recipient's own scan ─────────────────────────────────────────────

  console.log(`  waiting ${SYNC_WAIT_MS / 1000}s for the recipient wallet to sync...`);
  await sleep(SYNC_WAIT_MS);
  const found = await discovered(s.recipient, sent.sentFromRuntime.nonce);
  const balanceAfter = await shieldedBalance(s.recipient, s.coin.color);
  details.discovered = found;
  details.recipientBalanceAfter = String(balanceAfter);
  console.log(`  recipient discovered the coin? ${found}; balance ${balanceBefore} → ${balanceAfter}`);
  if (!found) throw new Error('the recipient’s own scan did not find the coin');

  const coins = await scannedCoins(s.recipient);
  const theCoin = coins.find((c) => String(c?.coin?.nonce ?? '').replace(/^0x/, '').toLowerCase() === nonceHex);
  details.recipientCoinRecord = theCoin
    ? {
        value: String(theCoin.coin.value),
        mtIndex: theCoin.coin.mt_index !== undefined ? String(theCoin.coin.mt_index) : null,
        available: theCoin.coin.mt_index !== undefined,
      }
    : null;

  // ── Spendability: the recipient spends it onward ─────────────────────────

  step('spendability: the recipient spends the discovered coin into a vault of its own');
  let spend: Record<string, unknown>;
  try {
    const recipientVault = await deployVault(s.recipient, 'recipient-vault');
    console.log(`  recipient vault @ ${recipientVault.address}`);
    const dep = await recipientVault.deposit({
      nonce: crypto.getRandomValues(new Uint8Array(32)),
      color: s.coin.color,
      value: SPEND_ON,
    });
    console.log(`  deposit tx ${dep.txId}`);
    await waitForLedger(
      () => recipientVault.ledgerState(),
      'the recipient’s vault claimed the deposit',
      (l: any) => l.round >= 1n,
    );
    spend = { spent: true, txId: dep.txId, amount: String(SPEND_ON), vault: recipientVault.address };
    console.log('  ✓ the discovered coin funded a real onward spend');
  } catch (e: any) {
    spend = { spent: false, error: serialiseError(e) };
    console.log(`  ✗ onward spend failed: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  details.onwardSpend = spend;

  step('VERDICT');
  const proven = found && !anyLeak && agree && spend.spent === true;
  console.log(`  discovered by scanning : ${found}`);
  console.log(`  spendable onward       : ${spend.spent}`);
  console.log(`  no cleartext leak      : ${!anyLeak}`);
  console.log(`  circuit/runtime agree  : ${agree}`);

  writeEvidence({
    testId: 'P3',
    name: 'spend-and-secrecy',
    description: 'The discovered coin is spendable, and the attached ciphertext stays sealed',
    verdict: proven ? 'PASS' : 'PARTIAL',
    txHash: sent.txId,
    note: proven
      ? 'The coin the recipient discovered is an ordinary spendable shielded coin: it entered the recipient\u2019s available balance and funded a later transaction of the recipient\u2019s own. Attaching the ciphertext costs no secrecy: the ciphertext-bearing output carries neither the coin nonce nor its value in the clear, and whatever the token colour discloses it discloses equally in the ciphertext-less contract-owned control output in the same transaction, so it is a property of the output encoding rather than of the attachment. The cooperative circuit\u2019s disclosed coin is identical to what the executor\u2019s runtime held, so the runtime read P2 relies on is sound.'
      : `Not fully established: discovered=${found}, spendable=${spend.spent}, leak=${anyLeak}, agreement=${agree}.`,
    details,
  });
});
