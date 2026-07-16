// P1 — the composition surface, and the un-composed control.
//
// Two questions, both preconditions for P2:
//
//   (a) Does the stack expose a way to BUILD a contract call transaction
//       without submitting it, and to MERGE two of them into one
//       transaction? (midnight-js unproven-call surface; ledger-v8
//       Transaction merge — the atomic-swap primitive of MIP-0006.)
//
//   (b) Control: what exactly happens when A.spend_to_contract(B) is
//       submitted as its OWN transaction, with no B-side claim? Expected:
//       rejection — a shielded output addressed to a contract must be
//       claimed by that contract in the same transaction (MIP-0011 records
//       the wallet-side variant as node error 186). The verbatim failure is
//       the baseline P2 must beat. If this ACCEPTS, that alone rewrites the
//       ledger picture and P2's merge is unnecessary.
//
// Verdict: PASS = a build surface and a merge surface both exist (P2 can
// proceed) and the control's outcome is recorded. FAIL = no composition
// surface exists on this stack.

import * as contractsApi from '@midnight-ntwrk/midnight-js-contracts';
import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';

import { runScenario, step } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { pairSetup, fundA } from './flow.js';

const COLOR_SEED = '0'.repeat(62) + '42';

await runScenario('p1-sdk-composition', async () => {
  const details: Record<string, unknown> = {};

  step('inventory: midnight-js-contracts exports (build-without-submit surface)');
  const contractsSurface = Object.keys(contractsApi).filter((k) =>
    /call|tx|unproven|submit|prove/i.test(k),
  );
  details.contractsSurface = contractsSurface;
  console.log(`  ${contractsSurface.length} candidate export(s): ${contractsSurface.join(', ')}`);
  const buildCandidates = contractsSurface.filter((k) => /unproven|create/i.test(k));
  details.buildCandidates = buildCandidates;

  step('inventory: ledger-v8 Transaction merge surface (the atomic-swap primitive)');
  const Tx: any = (ledgerV8 as any).Transaction;
  const txProto = Tx?.prototype ? Object.getOwnPropertyNames(Tx.prototype) : [];
  const txStatics = Tx ? Object.getOwnPropertyNames(Tx) : [];
  details.transactionProto = txProto;
  details.transactionStatics = txStatics;
  const hasMerge = txProto.includes('merge') || txStatics.includes('merge');
  details.hasMerge = hasMerge;
  console.log(`  Transaction.prototype: ${txProto.join(', ')}`);
  console.log(`  merge surface: ${hasMerge ? 'PRESENT' : 'ABSENT'}`);

  step('control: A.spend_to_contract(B) submitted as its own transaction');
  const s = await pairSetup();
  details.custodyA = s.custodyA.address;
  details.custodyB = s.custodyB.address;
  await fundA(s, COLOR_SEED, 400n);

  const color = (await s.custodyA.coinStore()).coins;
  const colorHex = Object.keys(color)[0];
  details.fundedColor = colorHex;

  let controlOutcome: Record<string, unknown>;
  try {
    const r = await s.custodyA.spendToContract(
      s.custodyB.address,
      Uint8Array.from(Buffer.from(colorHex, 'hex')),
      150n,
    );
    controlOutcome = {
      accepted: true,
      txId: r.txId,
      sent: r.sent ? { value: String(r.sent.value) } : null,
      note: 'UNEXPECTED: the node accepted an output addressed to contract B with no B-side claim. Direct send needs no composition at all — re-read the ledger rules before trusting this.',
    };
    console.log(`  UNEXPECTED ACCEPT — tx ${r.txId}`);
  } catch (e: any) {
    controlOutcome = {
      accepted: false,
      error: serialiseError(e),
      note: 'Expected rejection: the un-composed direct send fails. Stage and error recorded verbatim as the baseline P2 must beat.',
    };
    console.log(`  rejected as expected: ${e?.message?.slice(0, 200)}`);
  }
  details.control = controlOutcome;

  const composable = buildCandidates.length > 0 && hasMerge;
  writeEvidence({
    testId: 'P1',
    name: 'sdk-composition',
    description:
      'Composition surfaces (build-without-submit + Transaction.merge) and the un-composed direct-send control',
    verdict: composable ? 'PASS' : 'FAIL',
    note: composable
      ? `Build candidates: ${buildCandidates.join(', ')}; merge present. Control accepted=${(controlOutcome as any).accepted}.`
      : 'No composition surface on this stack — P2 cannot be attempted through public APIs.',
    details,
  });
});
