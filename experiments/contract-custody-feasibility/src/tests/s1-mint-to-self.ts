// S1 — mintShieldedToken to kernel.self(): contract mints shielded tokens
// to itself. Known to work on previous SDKs; re-run as a regression check.
//
// EXPERIMENT-NOTE: this test also serves as the pre-condition for S3
// (cross-tx custody). After S1 passes, the contract holds shielded notes
// that S3 will attempt to send in a later block.

import { randomBytes } from 'node:crypto';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'S1';
const SHIELDED_COLOR =
  process.env.S1_COLOR ?? '00'.repeat(31) + '01'; // arbitrary 32-byte token id

await runTest({
  testId: TEST_ID,
  name: 'mint-to-self',
  description: 'contract mints shielded tokens to kernel.self()',
  action: async () => {
    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const amount = BigInt(process.env.S1_AMOUNT ?? '1000');
    const nonce = new Uint8Array(randomBytes(32));

    console.log(`Minting ${amount} shielded of ${SHIELDED_COLOR} to ${contract.address}`);
    const result = await contract.found.callTx.mint_shielded_to_self(
      hexToBytes32(SHIELDED_COLOR),
      amount,
      nonce,
    );
    const txHash = result?.public?.txId ?? result?.public?.transactionHash;
    await walletCtx.wallet.stop();

    return {
      verdict: txHash ? 'PASS' : 'PARTIAL',
      txHash,
      note: txHash
        ? 'mintShieldedToken → kernel.self() landed.'
        : 'callTx returned without surfacing a tx hash.',
      details: {
        contractAddress: contract.address,
        color: SHIELDED_COLOR,
        amount: amount.toString(),
      },
    };
  },
});
