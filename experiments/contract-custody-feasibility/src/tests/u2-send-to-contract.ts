// U2 — sendUnshielded → ContractAddress: contract sends Night to another contract.
//
// Historical context: failed with ledger error 186 on older SDKs. The CTO
// confirmed (2026/04/27) that 186 was fixed roughly a month prior. This
// test verifies the fix end-to-end.
//
// Pre-condition: U1 already deposited Night into the primary contract.
// `run-all.sh` runs U1 before U2 by default, so the primary instance has a
// non-zero Night balance to send.

import { firstValueFrom } from 'rxjs';
import * as fs from 'node:fs';
import { setupContract, runTest } from '../test-helpers.js';
import { hexToBytes32 } from '../common.js';

const TEST_ID = 'U2';

await runTest({
  testId: TEST_ID,
  name: 'send-to-contract',
  description: 'contract A → contract B: sendUnshielded → ContractAddress',
  action: async () => {
    if (!fs.existsSync('deployment-second.json')) {
      return {
        verdict: 'FAIL',
        errorCode: 'missing-secondary-deployment',
        note: 'deployment-second.json not found. Run: npm run deploy-second',
        details: { hint: 'CUSTODY_DEPLOY_SLOT=secondary npx tsx src/deploy.ts' },
      };
    }
    const { contractAddress: secondaryAddress } = JSON.parse(
      fs.readFileSync('deployment-second.json', 'utf-8'),
    );

    const { walletCtx, contract } = await setupContract({ slot: 'primary' });
    const state = await firstValueFrom(walletCtx.wallet.state());

    const heldByContract = Object.entries(state.unshielded.balances as Record<string, bigint>);
    if (heldByContract.length === 0) {
      return {
        verdict: 'FAIL',
        errorCode: 'no-balance-to-send',
        note: 'Wallet has no Night. Run U1 first to seed the contract via deposit.',
        details: {},
      };
    }

    const [color] = heldByContract[0];
    const amount = BigInt(process.env.U2_AMOUNT ?? '100');

    console.log(`Sending ${amount} of ${color} from ${contract.address} → ${secondaryAddress}`);
    // ContractAddress is a struct {bytes: Bytes<32>}, not a raw Uint8Array.
    const recipient = { bytes: hexToBytes32(secondaryAddress.replace(/^0x/, '')) };
    const result = await contract.found.callTx.send_unshielded_to_contract(
      hexToBytes32(color),
      amount,
      recipient,
    );
    const txHash = result?.public?.txId ?? result?.public?.transactionHash;
    await walletCtx.wallet.stop();

    return {
      verdict: txHash ? 'PASS' : 'PARTIAL',
      txHash,
      note: txHash
        ? 'sendUnshielded → ContractAddress accepted by node. Error 186 confirmed fixed.'
        : 'callTx returned without surfacing a tx hash.',
      details: {
        from: contract.address,
        to: secondaryAddress,
        color,
        amount: amount.toString(),
      },
    };
  },
});
