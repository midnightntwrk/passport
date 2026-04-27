// D2 — Contract as paymaster for user transactions.
//
// Question from the brief:
//   "Can a contract sponsor a user's transaction by paying the Dust fee
//    on the user's behalf? Test whether the transaction structure permits
//    a separate fee branch signed by the contract's Dust key, distinct
//    from the user's authorisation branch, and whether the node accepts
//    such a transaction."
//
// EXPERIMENT-NOTE: This is the strongest version of the contract-custody
// vision: a Passport contract pays for the user's onboarding tx so the
// user does not need to bootstrap with Dust. As of 2026/04/27, no public
// SDK surface for "second-signature paymaster" is documented. The
// expected outcome is FAIL with errorCode `no-paymaster-tx-shape` until
// the v1 transaction format gains explicit support.
//
// The probe constructs a normal user-call to `bump_counter`, then looks
// for any wallet-facade API that lets us attach a contract-paid fee
// branch. If nothing exists, the result is recorded as FAIL with the
// reason captured.

import { setupContract, runTest } from '../test-helpers.js';

const TEST_ID = 'D2';

await runTest({
  testId: TEST_ID,
  name: 'contract-paymaster',
  description: 'contract sponsors user transaction Dust fee',
  action: async () => {
    const { walletCtx, contract, providers } = await setupContract({ slot: 'primary' });

    // Baseline: a normal user→contract call, fee paid by the user.
    const baselineResult = await contract.found.callTx.bump_counter();
    const baselineTx = baselineResult?.public?.txId ?? baselineResult?.public?.transactionHash;

    // Probe: look for a paymaster-shaped API on the wallet facade or the
    // contract handle. We try a list of speculative names; if any is
    // present we record it and exit PARTIAL. If none, FAIL.
    const candidates = [
      'balanceWithSponsor',
      'balanceWithPaymaster',
      'attachContractFeeBranch',
      'sponsorTransaction',
    ];
    const found: string[] = [];
    const wallet: any = walletCtx.wallet;
    for (const c of candidates) {
      if (typeof wallet?.[c] === 'function') found.push(`wallet.${c}`);
      if (typeof contract.found?.[c] === 'function') found.push(`contract.${c}`);
    }

    await walletCtx.wallet.stop();

    const verdict = found.length > 0 ? 'PARTIAL' : 'FAIL';

    return {
      verdict,
      txHash: baselineTx,
      errorCode: verdict === 'FAIL' ? 'no-paymaster-tx-shape' : undefined,
      note:
        verdict === 'PARTIAL'
          ? `SDK exposes candidate paymaster APIs: ${found.join(', ')}. Manual exercise required to determine whether the node accepts the resulting transaction.`
          : 'No public SDK surface for contract paymaster on this v1. The transaction format does not (or not yet) permit a separate contract-signed fee branch alongside a user-signed auth branch.',
      details: {
        baselineTx,
        candidatesProbed: candidates,
        candidatesPresent: found,
        indexerHasGetDustBalance: typeof (providers.publicDataProvider as any).getDustBalance === 'function',
      },
    };
  },
});
