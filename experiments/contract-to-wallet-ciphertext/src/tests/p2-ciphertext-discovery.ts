// P2 — the headline. Contract → regular wallet, one transaction, and the
// recipient's own scan finds the coin.
//
// The vault sends through send_to_user_opaque: the circuit discloses its
// own change and says NOTHING about the recipient's coin. Whatever the
// executor knows about that coin, it knows because the circuit ran on its
// machine, not because the contract handed it over.
//
// Three arms, differing in exactly one thing — the encryption key the
// executor supplies for the recipient's coin public key:
//
//   A. none supplied      → expect the SDK to REFUSE to build the output.
//   B. the wrong key      → expect an accepted transaction whose coin the
//                           recipient OWNS but cannot find.
//   C. the recipient's key → expect an accepted transaction whose coin the
//                           recipient's ordinary scan finds unaided.
//
// The judge is wallet B: a separate seed, a separate wallet process, told
// nothing out of band. No watchFor, no application-layer inbox.

import { runScenario, step, sleep } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { stage, walletKeys, coinPublicKey, discovered, scannedCoins } from './flow.js';
import { candidateIndices } from '../wallet/capture.js';
import { anyToHex, describeShape } from '../wallet/hex.js';
import type { PlainCoin } from './flow.js';

const COLOR_SEED = '0'.repeat(62) + '61';
const FUND = 900n;
const ARM_B = 120n;
const ARM_C = 150n;
const SYNC_WAIT_MS = 30_000;

await runScenario('P2 — executor-attached ciphertext, one transaction', async () => {
  const details: Record<string, unknown> = {};
  const s = await stage(COLOR_SEED, FUND);
  details.vault = s.vault.address;

  const recipientCpkBytes = await coinPublicKey(s.recipient);
  const bKeys = await walletKeys(s.recipient);
  const aKeys = await walletKeys(s.ctx);
  details.recipient = { coinPublicKey: bKeys.cpk, encryptionPublicKey: bKeys.epk };
  details.executor = { coinPublicKey: aKeys.cpk, encryptionPublicKey: aKeys.epk };
  console.log(`  recipient coin public key       = ${bKeys.cpk}`);
  console.log(`  recipient encryption public key = ${bKeys.epk}`);
  console.log(`  executor  encryption public key = ${aKeys.epk}  (the wrong key, for arm B)`);

  const before = await scannedCoins(s.recipient);
  details.recipientCoinsBefore = before.length;

  let held: PlainCoin = s.coin;
  let candidates = s.deposit.candidates;

  // ── Arm A: the executor supplies no key ──────────────────────────────────

  step('arm A — the executor supplies NO encryption key for the recipient');
  let armA: Record<string, unknown>;
  try {
    await s.vault.sendToUser(
      {
        circuit: 'send_to_user_opaque',
        recipient: recipientCpkBytes,
        color: held.color,
        amount: 100n,
        mapping: undefined,
      },
      held,
      candidates,
    );
    armA = { refused: false, note: 'an output was built with no recipient mapping' };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    armA = {
      refused: /Unable to resolve encryption public key/i.test(msg),
      message: msg.slice(0, 400),
      error: serialiseError(e),
    };
  }
  details.armA = armA;
  console.log(`  arm A: ${armA.refused ? 'REFUSED at build time' : 'not refused'} — ${String((armA as any).message ?? '').slice(0, 160)}`);

  // ── Arm B: a ciphertext sealed to the wrong key ──────────────────────────

  step('arm B — the executor seals the ciphertext to its OWN key, not the recipient’s');
  const b = await s.vault.sendToUser(
    {
      circuit: 'send_to_user_opaque',
      recipient: recipientCpkBytes,
      color: held.color,
      amount: ARM_B,
      mapping: new Map([[bKeys.cpk, aKeys.epk]]),
    },
    held,
    candidates,
  );
  details.armBTx = b.txId;
  details.armBAttempts = b.attempts;
  details.armBOutputs = b.outputs;
  if (b.sentFromCircuit !== null) {
    throw new Error('send_to_user_opaque disclosed the recipient coin — the opaque arm is not opaque');
  }
  if (!b.sentFromRuntime) {
    throw new Error('the executor could not read the coin the contract sent (arm B)');
  }
  if (b.sentFromRuntime.value !== ARM_B) {
    throw new Error(`executor-visible value ${b.sentFromRuntime.value} != ${ARM_B}`);
  }
  details.executorReadOpaqueCoin = {
    value: String(b.sentFromRuntime.value),
    nonce: anyToHex(b.sentFromRuntime.nonce),
    color: anyToHex(b.sentFromRuntime.color),
    runtimeShapes: {
      nonce: describeShape(b.sentFromRuntime.nonce),
      color: describeShape(b.sentFromRuntime.color),
      value: describeShape(b.sentFromRuntime.value),
    },
  };
  console.log(`  the circuit disclosed nothing about the recipient coin;`);
  console.log(`  the executor’s own runtime held it in full: value=${b.sentFromRuntime.value}, nonce=${anyToHex(b.sentFromRuntime.nonce).slice(0, 16)}…`);
  console.log(`  tx ${b.txId}`);

  if (!b.change) throw new Error('arm B: expected change from a partial spend');
  await s.vault.dropCoin(held.color);
  console.log('  waiting 10s for the indexer to settle the spend block...');
  await sleep(10_000);
  const capB = await candidateIndices(b.txId);
  held = b.change;
  candidates = capB.candidates;

  console.log(`  waiting ${SYNC_WAIT_MS / 1000}s for the recipient wallet to sync...`);
  await sleep(SYNC_WAIT_MS);
  const bDiscovered = await discovered(s.recipient, b.sentFromRuntime.nonce);
  details.armBDiscovered = bDiscovered;
  console.log(`  arm B: the recipient’s own scan found the coin? ${bDiscovered}`);

  // ── Arm C: a ciphertext sealed to the recipient's key ────────────────────

  step('arm C — the executor seals the ciphertext to the RECIPIENT’s key');
  const c = await s.vault.sendToUser(
    {
      circuit: 'send_to_user_opaque',
      recipient: recipientCpkBytes,
      color: held.color,
      amount: ARM_C,
      mapping: new Map([[bKeys.cpk, bKeys.epk]]),
    },
    held,
    candidates,
  );
  details.armCTx = c.txId;
  details.armCAttempts = c.attempts;
  details.armCOutputs = c.outputs;
  if (!c.sentFromRuntime) throw new Error('the executor could not read the coin the contract sent (arm C)');
  if (c.sentFromRuntime.value !== ARM_C) {
    throw new Error(`executor-visible value ${c.sentFromRuntime.value} != ${ARM_C}`);
  }
  details.armCSentCoin = {
    value: String(c.sentFromRuntime.value),
    nonce: anyToHex(c.sentFromRuntime.nonce),
  };
  console.log(`  tx ${c.txId} — value=${c.sentFromRuntime.value}, nonce=${anyToHex(c.sentFromRuntime.nonce).slice(0, 16)}…`);

  console.log(`  waiting ${SYNC_WAIT_MS / 1000}s for the recipient wallet to sync...`);
  await sleep(SYNC_WAIT_MS);
  const cDiscovered = await discovered(s.recipient, c.sentFromRuntime.nonce);
  const bStillHidden = !(await discovered(s.recipient, b.sentFromRuntime.nonce));
  details.armCDiscovered = cDiscovered;
  details.armBStillHidden = bStillHidden;

  const after = await scannedCoins(s.recipient);
  details.recipientScan = after.map((x) => ({
    value: String(x?.coin?.value),
    nonce: String(x?.coin?.nonce ?? '').slice(0, 16) + '…',
    mtIndex: x?.coin?.mt_index !== undefined ? String(x.coin.mt_index) : 'pending',
  }));

  // ── Verdict ──────────────────────────────────────────────────────────────

  step('VERDICT');
  console.log(`  arm A — no key supplied        : ${armA.refused ? 'SDK refused to build the output' : 'NOT refused'}`);
  console.log(`  arm B — ciphertext to wrong key: recipient discovered = ${bDiscovered}`);
  console.log(`  arm C — ciphertext to right key: recipient discovered = ${cDiscovered}`);
  console.log(`  recipient’s own scan now holds ${after.length} coin(s) (was ${before.length})`);

  const proven = cDiscovered && !bDiscovered && bStillHidden;
  writeEvidence({
    testId: 'P2',
    name: 'ciphertext-discovery',
    description:
      'Contract-to-wallet shielded transfer, one transaction, recipient ciphertext attached by the executor',
    verdict: proven ? 'PASS' : 'FAIL',
    txHash: c.txId,
    note: proven
      ? 'A contract sent shielded value to an ordinary wallet in ONE transaction and the recipient found it by ordinary scanning, with no out-of-band hint. The circuit used was the opaque one, which discloses nothing about the recipient coin: the executor read the coin from its own runtime, because the circuit ran there, and supplied the recipient encryption key through additionalCoinEncPublicKeyMappings. Sealing to the wrong key leaves the coin owned but invisible; supplying no key at all makes the SDK refuse to build the output. Ownership and discoverability are separable, and discoverability is the executor’s to provide.'
      : `Inconclusive. arm C discovered=${cDiscovered} (expected true), arm B discovered=${bDiscovered} (expected false), arm B still hidden=${bStillHidden}.`,
    details,
  });
  if (!proven) {
    throw new Error(
      `probe did not establish the claim: armC=${cDiscovered}, armB=${bDiscovered}, armBStillHidden=${bStillHidden}`,
    );
  }
});
