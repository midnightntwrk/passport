// D1 — Contract-held Dust balance and self-payment.
//
// Two questions:
//   (a) Does `getDustBalance` (or equivalent) recognise a contract address?
//   (b) Can a contract pay the Dust fee for a transaction it executes,
//       from its own Dust balance, instead of from the originating wallet?
//
// EXPERIMENT-NOTE: D1 is a transaction-construction question, not a
// circuit question. The contract just needs a state-changing circuit to
// invoke (`bump_counter`). The interesting logic is in how the
// transaction's fee branch is funded — by default the wallet pays via
// `balanceUnboundTransaction`. We override that by attempting to
// construct a contract-paid fee branch.
//
// On the latest v1 SDK there may be no public API for this. If so,
// document that in the evidence and mark FAIL with errorCode
// `no-paymaster-api`.

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { setupContract, runTest } from '../test-helpers.js';

const TEST_ID = 'D1';

await runTest({
  testId: TEST_ID,
  name: 'contract-self-payment',
  description: 'contract pays its own tx Dust fee',
  action: async () => {
    const { walletCtx, contract, providers } = await setupContract({ slot: 'primary' });

    // ── (a) Can we observe the contract's Dust balance? ───────────────────
    //
    // If a `getDustBalance(contractAddress)` (or similar) endpoint exists
    // on the indexer / SDK, query it. If not, document the absence.

    let contractDustBalance: string | null = null;
    let dustQueryError: string | null = null;
    try {
      const indexer: any = providers.publicDataProvider;
      if (typeof indexer.getDustBalance === 'function') {
        contractDustBalance = String(await indexer.getDustBalance(contract.address));
      } else {
        dustQueryError = 'publicDataProvider has no getDustBalance method';
      }
    } catch (e: any) {
      dustQueryError = e?.message ?? String(e);
    }

    // ── (b) Try to construct a tx where the contract pays the fee ────────
    //
    // The default wallet provider takes the fee from the wallet. We probe
    // here for a contract-paid alternative. If it doesn't exist we record
    // FAIL with no-paymaster-api.

    // First: invoke a normal `bump_counter` and capture how the SDK
    // structured the fee branch — that gives us a baseline to compare.
    const baselineResult = await contract.found.callTx.bump_counter();
    const baselineTx = baselineResult?.public?.txId ?? baselineResult?.public?.transactionHash;

    // Probe for an explicit contract-fee API. As of the brief, no such
    // public surface is documented. The user is expected to update this
    // probe based on whatever the latest SDK actually exposes.
    let contractPaidTx: string | null = null;
    let probeError: string | null = null;
    try {
      const wallet: any = walletCtx.wallet;
      // EXPERIMENT-NOTE: speculative API surface. If `balanceWithContractFee`
      // exists on the WalletFacade in this SDK version, it would let us
      // build a tx whose fee branch is funded by the contract's Dust
      // balance instead of the wallet's. Capture the actual surface.
      if (typeof wallet?.balanceWithContractFee === 'function') {
        // This path is intentionally not exercised because we don't know
        // the exact signature; we just record that the function exists.
        probeError = `API surface exists: ${typeof wallet.balanceWithContractFee}`;
      } else {
        probeError = 'No contract-fee API exposed by WalletFacade';
      }
    } catch (e: any) {
      probeError = e?.message ?? String(e);
    }

    await walletCtx.wallet.stop();

    const verdict = contractPaidTx
      ? 'PASS'
      : contractDustBalance && contractDustBalance !== '0'
      ? 'PARTIAL' // we could read it but not spend from it
      : 'FAIL';

    return {
      verdict,
      txHash: contractPaidTx ?? baselineTx,
      errorCode: !contractPaidTx ? 'no-paymaster-api' : undefined,
      note:
        verdict === 'PASS'
          ? 'Contract paid its own tx fee from contract-held Dust.'
          : verdict === 'PARTIAL'
          ? `Contract Dust balance is observable (${contractDustBalance}) but no public API to spend from it.`
          : 'No public SDK surface for contract-paid Dust fees on this v1.',
      details: {
        contractDustBalance,
        dustQueryError,
        baselineTx,
        probeError,
        ledgerLibVersion: ledger.LedgerParameters?.initialParameters?.()?.dust ? 'reachable' : 'n/a',
      },
    };
  },
});
