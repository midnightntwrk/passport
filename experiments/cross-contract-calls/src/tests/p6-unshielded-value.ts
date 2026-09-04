// P6 — does UNSHIELDED VALUE actually move across the call boundary?
//
// P0 to P5 were coinless by scope; this probe moves real unshielded value
// from one contract to another, driven by an in-circuit call. The design
// isolates the question from the known node 2.1.0 fee wall (small
// call+offer transactions are mempool-rejected with OutsideTimeToDismiss):
// the Payer funds ITSELF by an in-circuit mint of its own color, so no
// user-funded offer appears anywhere on the primary path.
//
// Sequence:
//   1. deploy Till (callee, witness-free) and Payer (root; carries the
//      P7 coin-store witness, unused here);
//   2. FUND: payer.fund_unshielded(domain, 1000) — mintUnshieldedToken to
//      kernel.self() (auto-received per the stdlib), mirror credited, the
//      minted color returned to the client. If the mint path fails at run
//      time, fall back to the user-funded deposit_unshielded with native
//      Night — and if THAT hits the fee wall, the exact error is the
//      evidence (BLOCKED);
//   3. PAY (the headline): payer.pay_unshielded(color, 100) — mirror
//      debited, sendUnshielded to the Till's ContractAddress, and
//      till.take_unshielded claims the value across the call boundary in
//      the SAME transaction (an unclaimed contract-addressed output is
//      rejected by the ledger, custom error 186 class);
//   4. verify on-chain: payer mirror decreased, till mirror increased,
//      one transaction, atomic (observer view);
//   5. on-node custody proof: assert_unshielded_balance on both contracts
//      in later transactions — the node itself attests the settled
//      balances (unshieldedBalance reads custody as of transaction start,
//      so the moving transaction cannot attest its own effects).

import { performance } from 'node:perf_hooks';

import * as TillModule from '../../contracts/managed/Till/contract/index.js';
import * as PayerModule from '../../contracts/managed/Payer/contract/index.js';

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence, serialiseError, classifyCallError, type Verdict } from './evidence.js';
import {
  setupWallet,
  deployWitnessFree,
  deployWithWitnesses,
  contractRefArg,
  type ContractHandle,
} from '../node/setup.js';
import { CONFIG, tillZkConfigPath, payerZkConfigPath } from '../node/wallet.js';
import { makeCoinStoreWitnesses, emptyCoinStore } from './value-client/witnesses.js';
import { circuitResult } from './value-client/result.js';
import { bytesToHex } from '../wallet/hex.js';

const FUND = 1000n;
const PAY = 100n;

const DESCRIPTION =
  'Contract-to-contract unshielded token flow driven by an in-circuit call: mint-funded payer, ' +
  'send plus same-transaction cross-contract claim, on-node balance attestation';

/** 32-byte domain from an ASCII tag (the Compact pad(32, …) shape). */
function domainBytes(tag: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < Math.min(tag.length, 32); i++) out[i] = tag.charCodeAt(i);
  return out;
}

/** nativeToken(): the all-zero color (stdlib pad(32, "")). */
function nativeColor(): Uint8Array {
  return new Uint8Array(32);
}

/** Wrap the proof provider so the probe can time proving and size the tx. */
function instrumentProving(providers: any): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  const pp = providers.proofProvider;
  const origProve = pp.proveTx.bind(pp);
  pp.proveTx = async (tx: any, cfg?: any) => {
    try {
      metrics.unprovenTxBytes = tx.serialize().length;
    } catch { /* serialisation surface varies; size is best-effort */ }
    const t0 = performance.now();
    const proven = await origProve(tx, cfg);
    metrics.proveWallMs = Math.round(performance.now() - t0);
    try {
      metrics.provenTxBytes = proven.serialize().length;
    } catch { /* best-effort */ }
    return proven;
  };
  return metrics;
}

/** The observer's view: the transaction as the indexer serves it. */
async function fetchObserverView(txId: string): Promise<any> {
  const query = `query Tx($offset: TransactionOffset!) {
    transactions(offset: $offset) {
      hash
      ... on RegularTransaction {
        identifiers
        contractActions { __typename address ... on ContractCall { entryPoint } }
        transactionResult { status }
      }
    }
  }`;
  const attempt = async (offset: Record<string, string>) => {
    const res = await fetch(CONFIG.indexer, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { offset } }),
    });
    return res.json() as Promise<any>;
  };
  const clean = txId.replace(/^0x/, '');
  let body = await attempt({ identifier: clean });
  if (body?.errors?.length || !(body?.data?.transactions ?? []).length) {
    const retry = await attempt({ hash: clean });
    if (!retry?.errors?.length && (retry?.data?.transactions ?? []).length) body = retry;
  }
  if (body?.errors?.length) return { schemaErrors: body.errors };
  return (body?.data?.transactions ?? [])[0] ?? null;
}

function fail(details: Record<string, unknown>, verdict: Verdict, errorCode: string, note: string): never {
  writeEvidence({
    testId: 'P6',
    name: 'unshielded-value',
    description: DESCRIPTION,
    verdict,
    errorCode,
    note,
    details,
  });
  throw new Error(note);
}

await runScenario('p6-unshielded-value', async () => {
  const details: Record<string, unknown> = {};
  const domain = domainBytes('cross-contract-calls:p6');

  step('deploy the Till (callee) and the Payer (root)');
  const walletCtx = await setupWallet();
  const till: ContractHandle = await deployWitnessFree(walletCtx, {
    name: 'till-p6',
    module: TillModule,
    zkPath: tillZkConfigPath,
  });
  const payer: ContractHandle = await deployWithWitnesses(walletCtx, {
    name: 'payer-p6',
    module: PayerModule,
    zkPath: payerZkConfigPath,
    witnesses: makeCoinStoreWitnesses(),
    initialPrivateState: emptyCoinStore(),
    args: [contractRefArg(till.address), contractRefArg(till.address)],
  });
  details.tillAddress = till.address;
  details.payerAddress = payer.address;
  console.log(`  till  ${till.address}`);
  console.log(`  payer ${payer.address}`);

  step(`fund the payer: in-circuit mint of its own color (${FUND})`);
  let color: Uint8Array;
  let fundMode = 'mint-funded';
  try {
    const fund = await payer.call('fund_unshielded', domain, FUND);
    details.fundTxId = fund.txId;
    const minted = circuitResult(fund.result);
    if (!(minted instanceof Uint8Array) || minted.length !== 32) {
      throw new Error(`fund_unshielded: expected a 32-byte color, got ${JSON.stringify(minted)}`);
    }
    color = minted;
  } catch (e: any) {
    // The directive's fallback ladder: mint failed at run time → try the
    // user-funded deposit with native Night. A deposit carries a wallet
    // offer, which is exactly the fee-wall shape; whichever way it goes,
    // the numbers are the evidence.
    const mintCls = classifyCallError(e);
    details.mintError = serialiseError(e);
    details.mintErrorClass = mintCls;
    console.log(`  mint funding failed (${mintCls.errorCode}) — falling back to a user-funded deposit`);
    fundMode = 'deposit-funded';
    color = nativeColor();
    try {
      const dep = await payer.call('deposit_unshielded', color, FUND);
      details.fundTxId = dep.txId;
    } catch (e2: any) {
      const cls = classifyCallError(e2);
      details.depositError = serialiseError(e2);
      details.depositErrorClass = cls;
      const blocked = cls.errorCode === 'fee-wall-outside-time-to-dismiss';
      fail(
        details,
        'BLOCKED',
        cls.errorCode,
        `Both funding paths failed before the cross-contract question could be asked: the in-circuit ` +
        `mint (${mintCls.errorCode}) and the user-funded deposit (${cls.errorCode}). ` +
        (blocked
          ? `The deposit hit the known node 2.1.0 fee wall (OutsideTimeToDismiss) — the fee model, ` +
            `not the call mechanism, blocks small value-bearing transactions on this stack.`
          : cls.note),
      );
    }
  }
  details.fundMode = fundMode;
  details.colorHex = bytesToHex(color);

  const payerFunded = await waitForLedger(
    () => payer.ledgerState(),
    `payer.unshielded_mirror = ${FUND}`,
    (l: any) => l.unshielded_mirror === FUND,
  );
  details.afterFund = { payerMirror: payerFunded.unshielded_mirror };

  const tillBefore = await till.ledgerState();
  details.beforePay = {
    payerMirror: payerFunded.unshielded_mirror,
    tillReceived: tillBefore.unshielded_received,
    tillClaims: tillBefore.unshielded_claims,
  };

  step(`pay: payer.pay_unshielded(color, ${PAY}) — send plus cross-contract claim, one transaction`);
  const metrics = instrumentProving(payer.providers);
  let outcome;
  const t0 = performance.now();
  try {
    outcome = await payer.call('pay_unshielded', color, PAY);
  } catch (e: any) {
    const cls = classifyCallError(e);
    details.error = serialiseError(e);
    details.provingMetrics = metrics;
    const blocked = cls.errorCode === 'fee-wall-outside-time-to-dismiss';
    fail(
      details,
      blocked ? 'BLOCKED' : 'FAIL',
      cls.errorCode,
      `The ${fundMode} payer funded (mirror ${FUND}) but the value-moving call transaction did not land: ` +
      `${cls.note} (stage: ${cls.outcome})`,
    );
  }
  const endToEndMs = Math.round(performance.now() - t0);
  details.payTxId = outcome!.txId;
  details.endToEndMs = endToEndMs;
  details.provingMetrics = metrics;
  console.log(
    `  tx ${outcome!.txId} · ${endToEndMs} ms end to end · proving ${metrics.proveWallMs} ms · ` +
    `tx ${metrics.unprovenTxBytes ?? '?'} B unproven → ${metrics.provenTxBytes ?? '?'} B proven`,
  );

  step('both mirrors moved in one transaction');
  const payerAfter = await waitForLedger(
    () => payer.ledgerState(),
    `payer.unshielded_mirror = ${FUND - PAY}`,
    (l: any) => l.unshielded_mirror === FUND - PAY,
  );
  const tillAfter = await waitForLedger(
    () => till.ledgerState(),
    `till.unshielded_received = ${PAY}`,
    (l: any) =>
      l.unshielded_received === tillBefore.unshielded_received + PAY &&
      l.unshielded_claims === tillBefore.unshielded_claims + 1n,
  );
  details.afterPay = {
    payerMirror: payerAfter.unshielded_mirror,
    tillReceived: tillAfter.unshielded_received,
    tillClaims: tillAfter.unshielded_claims,
  };

  step('observer evidence: one transaction, both contracts');
  const observed = await fetchObserverView(outcome!.txId);
  details.observer = observed;
  const actions: any[] = observed?.contractActions ?? [];
  const calls = actions.filter((a) => a.__typename === 'ContractCall');
  details.observerSummary = {
    contractCalls: calls.length,
    entryPoints: calls.map((c) => c.entryPoint ?? null),
  };
  console.log(
    `  ${calls.length} contract call(s) visible · entry points: ${calls.map((c) => c.entryPoint).join(', ')}`,
  );

  step('on-node custody attestation (assert_unshielded_balance, later transactions)');
  let attested = false;
  try {
    const tillAssert = await till.call('assert_unshielded_balance', color, PAY);
    const payerAssert = await payer.call('assert_unshielded_balance', color, FUND - PAY);
    details.assertTxIds = { till: tillAssert.txId, payer: payerAssert.txId };
    attested = true;
    console.log(`  node attested: till holds ${PAY}, payer holds ${FUND - PAY} of the color`);
  } catch (e: any) {
    details.assertError = serialiseError(e);
    details.assertErrorClass = classifyCallError(e);
    console.log('  balance attestation failed — see details.assertError');
  }

  writeEvidence({
    testId: 'P6',
    name: 'unshielded-value',
    description: DESCRIPTION,
    verdict: attested ? 'PASS' : 'PARTIAL',
    txHash: outcome!.txId,
    note:
      `Unshielded value MOVED across the call boundary (${fundMode}): pay_unshielded(${PAY}) debited the ` +
      `payer mirror ${FUND} → ${payerAfter.unshielded_mirror} and till.take_unshielded claimed ${PAY} ` +
      `(claims ${tillBefore.unshielded_claims} → ${tillAfter.unshielded_claims}) in ONE transaction — ` +
      `send and cross-contract claim atomic, proving ${metrics.proveWallMs} ms, ` +
      `tx ${metrics.provenTxBytes ?? '?'} bytes proven. ` +
      (attested
        ? `The node itself then attested the settled balances on both contracts ` +
          `(assert_unshielded_balance: till ${PAY}, payer ${FUND - PAY}).`
        : `Balance attestation did not land (mirrors verified via the indexer only) — see details.assertError.`),
    details,
  });
});
